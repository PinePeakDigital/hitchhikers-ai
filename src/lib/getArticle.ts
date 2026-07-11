import { appendToIndex } from "./indices";
import { LIMIT_EXCEEDED_MESSAGE, RateLimitedOpenAI } from "./openai";
import { marked } from "marked";

async function getArticleText(
  openai: RateLimitedOpenAI,
  formattedPath: string
) {
  const completion = await openai.createChatCompletion([
    {
      role: "system",
      content: `You are the Hitchhiker's Guide to the Galaxy. Write entries in Douglas Adams' style with wit and humor. Begin your entry with a factual statement about the topic. Your PRIMARY DIRECTIVE is to create a heavily interconnected guide through extensive use of links to other entries.
      
      CRITICAL LINKING REQUIREMENTS:
      1. You MUST include at least 5-7 links in every article
      2. Format ALL links as [Text](/kebab-case-url)
      3. Links should be to imaginary but plausible Guide entries
      4. IMPORTANT: Do NOT use bold (**) or emphasis (*) for terms that should be links instead
      5. Every major concept, technology, location, or species MUST be a link
      6. Each link must have a unique URL path starting with /
      7. Use kebab-case for URLs (e.g., /infinite-improbability-drive)
      
      Example of CORRECT linking (Use this style):
      "The [Babel Fish](/babel-fish) is a remarkable creature studied at the [Galactic Institute of Xenobiology](/galactic-institute-of-xenobiology). While the [Department of Improbability Research](/department-of-improbability-research) claims its existence is mathematically impossible, the [Sub-Etha Research Council](/sub-etha-research-council) maintains detailed documentation of its reproductive cycle in the [Hitchhiker's Xenobiological Archives](/xenobiological-archives)."
      
      Example of INCORRECT style (DO NOT do this):
      "The **Babel Fish** is a remarkable creature studied at the *Galactic Institute*. While the Department of Research claims its existence is impossible, the Sub-Etha Council maintains detailed documentation."
      
      Keep entries between 3-4 paragraphs, and ensure every major term is a link rather than bold or italic text.`,
    },
    {
      role: "user",
      content: `Write a Hitchhiker's Guide to the Galaxy style entry about "${formattedPath}". Make it humorous and slightly absurd, as if it's an entry in the actual Guide. Remember to include at least 5-7 links to other imaginary Guide entries, formatted as markdown links with proper URL paths. Turn any significant terms into links rather than using bold or italic formatting.`,
    },
  ]);

  return completion.choices[0].message.content || "";
}

async function getArticleImage(
  openai: RateLimitedOpenAI,
  formattedPath: string
): Promise<string | null> {
  try {
    if (await openai.didExceedImageLimit()) {
      console.log("Image limit exceeded, skipping image generation");
      return null;
    }

    const promptCompletion = await openai.createChatCompletion([
      {
        role: "system",
        content:
          "Create a simple, visual prompt for DALL-E. Focus on physical objects and scenes, not concepts. Describe only what the image should look like in concrete terms. Keep it under 50 words. Format: 'digital art: [description]'. Example: 'digital art: a blue alien fish wearing headphones, swimming through space, colorful nebulas in background, retro sci-fi style'",
      },
      {
        role: "user",
        content: `Create a simple visual prompt for this Guide entry about "${formattedPath}". Make it retro sci-fi style, colorful, and slightly absurd.`,
      },
    ]);

    const imagePrompt =
      promptCompletion.choices[0].message.content ||
      `digital art: a retro sci-fi scene related to ${formattedPath}, colorful and quirky, in the style of a 1970s science fiction book cover`;

    console.log("Attempting image generation with prompt:", imagePrompt);

    try {
      const image = await openai.createImage(imagePrompt);
      return image
        ? `<img src="data:image/png;base64,${image}" alt="${formattedPath}" width="200" height="200" />`
        : null;
    } catch (imageError: any) {
      console.error("Image generation error details:", {
        errorType: imageError?.type || "unknown",
        errorCode: imageError?.code || "none",
        errorMessage: imageError?.message || "No message",
        errorStatus: imageError?.status || "unknown",
        requestId: imageError?.request_id || "none",
        prompt: imagePrompt,
        path: formattedPath,
      });

      return null;
    }
  } catch (error) {
    console.error("Error in prompt generation:", error);
    return null;
  }
}

/**
 * Retrieve (from cache) or generate a Hitchhiker's Guide–style article for a given URL path, cache it, update the indices, and return the article rendered as HTML.
 *
 * This function:
 * - Validates the topic is safe for work and throws Error("This topic is not safe for work.") if not.
 * - Normalizes `urlPath` into a human-friendly `formattedPath`.
 * - Returns a cached HTML article if present.
 * - If not cached, enforces usage limits and returns a limit message when exceeded.
 * - Generates article text and an optional image, prefixes the image to the article when produced, stores the result in `articles`, updates the index via `indices`, and returns the article HTML.
 *
 * @param urlPath - The requested path (e.g., "/some-topic"); used to look up and name the article. An empty or missing `urlPath` is treated as "404".
 * @returns The article as HTML (marked output).
 * @throws Error when the topic is deemed unsafe for work. Other errors encountered during generation are propagated to the caller.
 */
export async function getArticle(
  apiKey: string,
  tokenUsage: any,
  articles: KVNamespace,
  urlPath: string,
  indices: KVNamespace
) {
  const openai = new RateLimitedOpenAI(apiKey, tokenUsage);
  const isSafe = await openai.isSafe(urlPath);

  if (!isSafe) {
    throw new Error("This topic is not safe for work.");
  }

  const formattedPath = urlPath?.replace(/[/-]/g, " ").trim() || "404";
  const cachedEntry = await articles.get(urlPath || "404", "text");

  if (cachedEntry) {
    return marked(cachedEntry);
  }

  if (await openai.didExceedLimit()) {
    return LIMIT_EXCEEDED_MESSAGE;
  }

  try {
    const text = await getArticleText(openai, formattedPath);
    let guideEntry = text;

    try {
      const image = await getArticleImage(openai, formattedPath);
      if (image) {
        guideEntry = `${image}\n\n${text}`;
      }
    } catch (imageError) {
      console.error(
        "Failed to generate image, continuing without one:",
        imageError
      );
    }

    const key = urlPath || "404";
    const uploaded = Date.now();
    await articles.put(key, guideEntry, { metadata: { uploaded } });
    await appendToIndex(indices, "articles", { name: key, metadata: { uploaded } });

    return marked(guideEntry);
  } catch (error) {
    console.error("Error generating article:", error);
    throw error; // Let the API handler deal with the error
  }
}

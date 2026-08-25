import { appendToIndex } from "./indices";
import { LIMIT_EXCEEDED_MESSAGE, RateLimitedAI } from "./ai";
import { marked } from "marked";

async function getArticleText(ai: RateLimitedAI, formattedPath: string) {
  return ai.createText([
    {
      role: "system",
      content: `You are the Hitchhiker's Guide to the Galaxy. Write entries in Douglas Adams' style with wit and humor. Begin your entry with a factual statement about the topic. Your PRIMARY DIRECTIVE is to create a heavily interconnected guide through extensive use of links to other entries.
      
      CRITICAL LINKING REQUIREMENTS:
      1. You MUST include between 5 and 8 links in every article — no fewer, and no more
      2. Format ALL links as [Text](/kebab-case-url)
      3. Links should be to imaginary but plausible Guide entries
      4. IMPORTANT: Do NOT use bold (**) or emphasis (*) for terms that should be links instead
      5. Every major concept, technology, location, or species MUST be a link
      6. Each link must have a unique URL path starting with /
      7. Use kebab-case for URLs (e.g., /infinite-improbability-drive)
      8. Never link the entry's own title — it is the page the reader is already on
      9. Never nest brackets inside a link's text. [A Good [Towel](/towel)] is malformed.
         Write [A Good Towel](/towel) instead
      10. At most one link per sentence. Prose first, links second — an entry that is
          mostly links reads as a directory, not a Guide entry
      11. A URL is ONE path segment: a single leading slash and no others. /babel-fish is
          valid. /definitions/sanity and /galactic-directory/therapies are NOT — the Guide
          has no sections, and such links lead nowhere
      12. Do NOT open with a heading or the entry's title. The Guide renders the title
          itself; start directly with the first sentence of prose
      
      Example of CORRECT linking (Use this style):
      "The [Babel Fish](/babel-fish) is a remarkable creature studied at the [Galactic Institute of Xenobiology](/galactic-institute-of-xenobiology). While the [Department of Improbability Research](/department-of-improbability-research) claims its existence is mathematically impossible, the [Sub-Etha Research Council](/sub-etha-research-council) maintains detailed documentation of its reproductive cycle in the [Hitchhiker's Xenobiological Archives](/xenobiological-archives)."
      
      Example of INCORRECT style (DO NOT do this):
      "The **Babel Fish** is a remarkable creature studied at the *Galactic Institute*. While the Department of Research claims its existence is impossible, the Sub-Etha Council maintains detailed documentation."
      
      Keep entries between 3-4 paragraphs, and ensure every major term is a link rather than bold or italic text.`,
    },
    {
      role: "user",
      content: `Write a Hitchhiker's Guide to the Galaxy style entry about "${formattedPath}". Make it humorous and slightly absurd, as if it's an entry in the actual Guide. Include 5-8 links to other imaginary Guide entries, each a single-segment kebab-case path like /babel-fish. Turn any significant terms into links rather than using bold or italic formatting. Start with prose, not a heading.`,
    },
  ]);
}

async function getArticleImage(
  ai: RateLimitedAI,
  formattedPath: string
): Promise<string | null> {
  try {
    if (await ai.didExceedImageLimit()) {
      console.log("Image limit exceeded, skipping image generation");
      return null;
    }

    const fallbackPrompt = `digital art: a retro sci-fi scene related to ${formattedPath}, colorful and quirky, in the style of a 1970s science fiction book cover`;

    const promptText = await ai.createText(
      [
        {
          role: "system",
          content:
            "Create a simple, visual prompt for a text-to-image model. Focus on physical objects and scenes, not concepts. Describe only what the image should look like in concrete terms. Keep it under 50 words. Format: 'digital art: [description]'. Example: 'digital art: a blue alien fish wearing headphones, swimming through space, colorful nebulas in background, retro sci-fi style'",
        },
        {
          role: "user",
          content: `Create a simple visual prompt for this Guide entry about "${formattedPath}". Make it retro sci-fi style, colorful, and slightly absurd.`,
        },
      ],
      { maxTokens: 128 }
    );

    // A rate-limited prompt call yields the notice, which would be a nonsense image
    // prompt — fall back to a generic one rather than drawing the error message.
    const imagePrompt =
      promptText === LIMIT_EXCEEDED_MESSAGE ? fallbackPrompt : promptText;

    console.log("Attempting image generation with prompt:", imagePrompt);

    try {
      const image = await ai.createImage(imagePrompt);
      return image
        ? `<img src="data:image/jpeg;base64,${image}" alt="${formattedPath}" width="200" height="200" />`
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
 * Whether a stored ARTICLES value is really an outage notice rather than an article.
 *
 * Before the guard in `getArticle` existed, a rate-limited generation could be written to
 * KV in either of two shapes: the notice alone, or — when the image call happened to
 * succeed while the text call was rate-limited — an `<img>` tag prepended to it as
 * `${image}\n\n${text}`. Both must be recognised, or a poisoned slug gets rendered as a
 * real article and edge-cached for a day.
 */
function isOutageNotice(stored: string): boolean {
  return (
    stored === LIMIT_EXCEEDED_MESSAGE ||
    stored.endsWith(`\n\n${LIMIT_EXCEEDED_MESSAGE}`)
  );
}

/**
 * Retrieve (from cache) or generate a Hitchhiker's Guide–style article for a given URL path, cache it, update the indices, and return the article rendered as HTML.
 *
 * This function:
 * - Normalizes `urlPath` into a human-friendly `formattedPath`.
 * - Returns a cached HTML article if present, without contacting OpenAI.
 * - If not cached, enforces usage limits and returns a limit message when exceeded.
 * - Validates the topic is safe for work and throws Error("This topic is not safe for work.") if not.
 *   If the moderation check itself fails, returns the limit message rather than generating.
 * - Generates article text and an optional image, prefixes the image to the article when produced, stores the result in `articles`, updates the index via `indices`, and returns the article HTML.
 *
 * @param ai - The Workers AI binding.
 * @param gatewayId - Optional AI Gateway id; when set, inference is routed through it.
 * @param urlPath - The requested path (e.g., "/some-topic"); used to look up and name the article. An empty or missing `urlPath` is treated as "404".
 * @returns The article as HTML (marked output) when served from cache or freshly generated; otherwise the
 * plain-text `LIMIT_EXCEEDED_MESSAGE` when the daily usage limit is spent, the moderation check itself
 * fails, or generation is rate-limited upstream. Callers rely on that sentinel being returned by
 * identity to detect a transient failure, so it is deliberately not passed through `marked()`.
 * @throws Error when the topic is deemed unsafe for work. Other errors encountered during generation are propagated to the caller.
 */
export async function getArticle(
  ai: Ai,
  tokenUsage: KVNamespace,
  articles: KVNamespace,
  urlPath: string,
  indices: KVNamespace,
  gatewayId?: string
) {
  const formattedPath = urlPath?.replace(/[/-]/g, " ").trim() || "404";

  // Serve from KV before touching OpenAI at all. Moderating a path we already
  // have an article for is wasted spend, and — more importantly — an OpenAI
  // outage or rate limit used to take down every already-generated article.
  const cachedEntry = await articles.get(urlPath || "404", "text");

  // A slug poisoned by an earlier outage — the notice stored as its article, before
  // the guard further down existed — is treated as a miss rather than rendered. That
  // way it regenerates once the provider recovers instead of serving the notice
  // forever, and marked() can't disguise it from the caller's identity check.
  if (cachedEntry && !isOutageNotice(cachedEntry)) {
    return marked(cachedEntry);
  }

  const client = new RateLimitedAI(ai, tokenUsage, gatewayId);

  if (await client.didExceedLimit()) {
    return LIMIT_EXCEEDED_MESSAGE;
  }

  // Fail closed: if moderation is unavailable we don't generate, but we say so
  // in the Guide's voice rather than throwing a 500 at the reader.
  let isSafe: boolean;
  try {
    isSafe = await client.isSafe(urlPath);
  } catch (error) {
    console.error("Moderation check failed:", error);
    return LIMIT_EXCEEDED_MESSAGE;
  }

  if (!isSafe) {
    throw new Error("This topic is not safe for work.");
  }

  try {
    const text = await getArticleText(client, formattedPath);

    // createChatCompletion swallows a 429 and hands back the limit notice in a
    // normal completion shape, so `text` can be the notice rather than an article.
    // Storing it would poison the slug permanently — ARTICLES entries carry no TTL
    // — and appendToIndex would then surface it in the random recommendations.
    // getSearchResults guards its own KV write the same way.
    if (text === LIMIT_EXCEEDED_MESSAGE) {
      return LIMIT_EXCEEDED_MESSAGE;
    }

    let guideEntry = text;

    try {
      const image = await getArticleImage(client, formattedPath);
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

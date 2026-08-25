import { marked } from "marked";
import { LIMIT_EXCEEDED_MESSAGE, RateLimitedOpenAI } from "./openai";

export async function getSearchResults(
  query: string,
  searches: KVNamespace,
  apiKey: string,
  tokenUsage: KVNamespace
): Promise<string> {
  if (!query) {
    return "No query provided";
  }

  const openai = new RateLimitedOpenAI(apiKey, tokenUsage);
  const cachedResults = await searches.get(query, "text");

  if (cachedResults) {
    return marked(cachedResults);
  }

  // Fail closed: if moderation is unavailable we don't generate, but we say so in
  // the Guide's voice rather than throwing a 500 at the reader. An unguarded call
  // here is what took the article path down during an OpenAI outage.
  let isSafe: boolean;
  try {
    isSafe = await openai.isSafe(query);
  } catch (error) {
    console.error("Moderation check failed:", error);
    return LIMIT_EXCEEDED_MESSAGE;
  }

  if (!isSafe) {
    return "This topic is not safe for work.";
  }

  const completion = await openai.createChatCompletion([
    {
      role: "system",
      content:
        "You are the Hitchhiker's Guide to the Galaxy's search engine. Generate 5-7 search results in markdown format. Each result should be a list item with a made-up but plausible article title as a link, followed by a brief, witty description in Douglas Adams' style. Make the results absurd and humorous while being loosely related to the search query. IMPORTANT: Each link MUST have a proper URL path starting with a forward slash, e.g. '/article-name'. Do NOT use '#' symbols or other invalid URL characters.",
    },
    {
      role: "user",
      content: `Generate Hitchhiker's Guide to the Galaxy style search results for: "${query}". Each result MUST follow this exact format:
    - [Title of the Article](/kebab-case-url-path) - Brief, witty description
    
    Example:
    - [The Infinite Tea Machine](/infinite-tea-machine) - A device that produces an endless stream of tea, much to the annoyance of its inventor who preferred coffee.`,
    },
  ]);

  const content = completion.choices[0].message.content || "";

  // Only cache if it's not a limit exceeded response
  if (content !== LIMIT_EXCEEDED_MESSAGE) {
    await searches.put(query, content);
  }

  return marked(content);
}

import { getArticle } from "../../../lib/getArticle";
import type { APIContext } from "astro";

export const prerender = false;

/**
 * HTTP GET handler that generates article content from storage and returns it as JSON.
 *
 * Reads ARTICLES and INDICES from `locals.runtime.env`, validates their presence, normalizes
 * the incoming `params.path` (joins arrays with `/`, falls back to `"404"` when empty),
 * and calls `getArticle` with the OpenAI API key and token usage flags. On success returns
 * a JSON response `{ content }`. On error returns a 500 JSON response with an `error`
 * message and a user-facing `content` notice.
 *
 * Successful (200) responses are cached at the Cloudflare edge using the Workers Cache API
 * keyed on the request URL, so repeat views skip the ARTICLES KV read entirely.
 *
 * @param params.path - Route path captured by Astro; may be a string or string[] (arrays are joined with `/`)
 * @returns A Response with a JSON body. Success: status 200 and `{ content }`. Failure: status 500 and `{ error, content }`.
 */
export async function GET({ params, locals, request }: APIContext) {
  // `caches.default` is a Cloudflare Workers-specific API not present in the
  // standard `CacheStorage` lib type, so we narrow to the workerd type here.
  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(request.url, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const articles = locals.runtime?.env?.ARTICLES;
    const indices = locals.runtime?.env?.INDICES;

    if (!articles || !indices) {
      throw new Error("Article or index storage not available");
    }

    // Log the incoming path for debugging
    console.log("Incoming path:", params.path);

    // Handle path parameter correctly - it comes as an array
    const articlePath = Array.isArray(params.path)
      ? params.path.join("/")
      : params.path;
    console.log("Processed path:", articlePath);

    const content = await getArticle(
      locals.runtime.env.OPENAI_API_KEY,
      locals.runtime.env.TOKEN_USAGE,
      articles,
      articlePath || "404",
      indices
    );

    if (!content) {
      throw new Error("No content generated");
    }

    const response = new Response(JSON.stringify({ content }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control":
          "public, s-maxage=86400, stale-while-revalidate=86400",
      },
    });

    await cache.put(cacheKey, response.clone());

    return response;
  } catch (error: any) {
    // Log the full error for debugging
    console.error("API Error:", error);
    console.error("Error stack:", error.stack);

    return new Response(
      JSON.stringify({
        error: error.message || "Error generating article",
        content:
          "The Guide seems to be experiencing technical difficulties. Please try again later.",
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
}

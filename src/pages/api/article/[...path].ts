import { getArticle } from "../../../lib/getArticle";
import type { APIContext } from "astro";

export const prerender = false;

/**
 * HTTP GET handler that generates article content from storage and returns it as JSON.
 *
 * Reads ARTICLES (KV) and DB (D1) from `locals.runtime.env`, validates their presence, normalizes
 * the incoming `params.path` (joins arrays with `/`, falls back to `"404"` when empty),
 * and calls `getArticle` with the OpenAI API key and token usage flags. On success returns
 * a JSON response `{ content }`. On error returns a 500 JSON response with an `error`
 * message and a user-facing `content` notice.
 *
 * @param params.path - Route path captured by Astro; may be a string or string[] (arrays are joined with `/`)
 * @returns A Response with a JSON body. Success: status 200 and `{ content }`. Failure: status 500 and `{ error, content }`.
 */
export async function GET({ params, locals }: APIContext) {
  try {
    const articles = locals.runtime?.env?.ARTICLES;
    const db = locals.runtime?.env?.DB;

    if (!articles || !db) {
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
      db
    );

    if (!content) {
      throw new Error("No content generated");
    }

    return new Response(JSON.stringify({ content }), {
      headers: {
        "Content-Type": "application/json",
      },
    });
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

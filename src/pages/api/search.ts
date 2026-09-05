import { env } from "cloudflare:workers";
import { getSearchResults } from "../../lib/getSearchResults";
import type { APIContext } from "astro";

export const prerender = false;

export async function GET({ url }: APIContext) {
  try {
    const query = url.searchParams.get("q") || "";

    if (!query) {
      return new Response(JSON.stringify({ content: "" }), {
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    const content = await getSearchResults(
      query,
      env.SEARCHES,
      env.AI,
      env.TOKEN_USAGE,
      env.AI_GATEWAY_ID
    );

    return new Response(JSON.stringify({ content }), {
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error: any) {
    console.error("Search API Error:", error);

    return new Response(
      JSON.stringify({
        error: error.message || "Error performing search",
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

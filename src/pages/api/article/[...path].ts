import { getArticle } from "../../../lib/getArticle";
import { LIMIT_EXCEEDED_MESSAGE } from "../../../lib/ai";
import type { APIContext } from "astro";

export const prerender = false;

const DENYLISTED_PATHS = new Set([
  "wp-admin",
  "wp-login",
  "wp-content",
  "wp-includes",
  "wp-config",
  "phpmyadmin",
  "admin",
  "administrator",
  "xmlrpc",
  "robots-txt",
  "sitemap-xml",
  "env",
  "git",
  "well-known",
]);

/**
 * Validates that a path looks like a legitimate article slug.
 *
 * Rules:
 *  - Must match kebab-case with 1–10 dash-separated segments of lowercase
 *    letters and digits: `/^[a-z0-9]+(-[a-z0-9]+){0,9}$/`.
 *  - Total length must be ≤ 80 characters.
 *  - Must not match a known scanner/probe slug (e.g. `wp-admin`, `phpmyadmin`).
 *
 * Used to reject random/garbage paths from bots and crawlers before they
 * trigger article generation, KV writes, and index updates.
 */
export function isValidArticlePath(path: string): boolean {
  if (!path || path.length > 80) return false;
  if (DENYLISTED_PATHS.has(path)) return false;
  return /^[a-z0-9]+(-[a-z0-9]+){0,9}$/.test(path);
}

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
 * keyed on the request URL, so repeat views skip the ARTICLES KV read entirely. Rate-limit and
 * outage notices are returned as 200s but sent `no-store` and never cached, so a transient
 * failure can't outlive the condition that produced it (see #25: failures aren't cached).
 *
 * @param params.path - Route path captured by Astro; may be a string or string[] (arrays are joined with `/`)
 * @returns A Response with a JSON body. Success: status 200 and `{ content }`. Failure: status 500 and `{ error, content }`.
 */
export async function GET({ params, locals, request }: APIContext) {
  try {
    // `caches.default` is a Cloudflare Workers-specific API not present in the
    // standard `CacheStorage` lib type, so we narrow to the workerd type here.
    // The whole cache interaction lives inside the try/catch so that a missing
    // runtime (e.g. `astro dev`, tests) or cache hiccup degrades to the KV path
    // and the graceful 500 handler rather than throwing an uncaught error.
    const cache =
      typeof caches !== "undefined"
        ? (caches as unknown as { default: Cache }).default
        : undefined;
    // Key on the URL path only (query string stripped) so extra query params
    // can't fragment the cache or be used to trivially bust it — content
    // depends solely on the validated article path.
    const url = new URL(request.url);
    const cacheKey = new Request(url.origin + url.pathname, { method: "GET" });

    if (cache) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        return cached;
      }
    }

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

    // Reject random/garbage paths from bots/crawlers before they trigger
    // article generation, KV writes, and index updates. See #18.
    if (!articlePath || !isValidArticlePath(articlePath)) {
      return new Response(
        JSON.stringify({
          error: "Not found",
          content: "The Guide has no entry for that path.",
        }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=86400",
          },
        }
      );
    }

    const content = await getArticle(
      locals.runtime.env.AI,
      locals.runtime.env.TOKEN_USAGE,
      articles,
      articlePath,
      indices,
      locals.runtime.env.AI_GATEWAY_ID
    );

    if (!content) {
      throw new Error("No content generated");
    }

    // A limit/outage notice is a temporary condition, not an article. Caching it
    // would outlive the condition that produced it — a moments-long OpenAI blip
    // would be served from the edge for a full day. Keep #25's rule intact:
    // failures aren't cached, whichever side of the 200/500 line they land on.
    const isNotice = content === LIMIT_EXCEEDED_MESSAGE;

    const response = new Response(JSON.stringify({ content }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": isNotice
          ? "no-store"
          : "public, s-maxage=86400, stale-while-revalidate=86400",
      },
    });

    if (cache && !isNotice) {
      await cache.put(cacheKey, response.clone());
    }

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

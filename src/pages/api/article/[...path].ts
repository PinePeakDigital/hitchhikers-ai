import { env } from "cloudflare:workers";
import { getArticle, getCachedArticle } from "../../../lib/getArticle";
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

function json(body: unknown, status: number, cacheControl?: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(cacheControl && { "Cache-Control": cacheControl }),
    },
  });
}

function errorResponse(error: any) {
  console.error("API Error:", error);
  console.error("Error stack:", error?.stack);

  return json(
    {
      error: error?.message || "Error generating article",
      content:
        "The Guide seems to be experiencing technical difficulties. Please try again later.",
    },
    500
  );
}

/**
 * Normalize Astro's `params.path` (a string or string[]) to the article slug, or null
 * when it isn't a slug the Guide would ever write an entry for.
 */
function articlePathFrom(params: APIContext["params"]): string | null {
  const articlePath = Array.isArray(params.path) ? params.path.join("/") : params.path;
  // Reject random/garbage paths from bots/crawlers before they reach KV. See #18.
  return articlePath && isValidArticlePath(articlePath) ? articlePath : null;
}

const NOT_FOUND = {
  error: "Not found",
  content: "The Guide has no entry for that path.",
};

/**
 * Serve an already-written article. Never generates.
 *
 * Generation used to happen here, which let crawlers write the Guide: every entry
 * links to 5-8 slugs that don't exist yet, and headless browsers following those
 * links spent the whole daily inference budget within ~90 minutes of each 00:00 UTC
 * reset, locking readers out for the other ~22 hours. A GET now only reads; writing
 * a new entry takes an explicit POST, which the page sends when a reader clicks.
 *
 * Found articles are edge-cached via the Workers Cache API keyed on the URL path, so
 * repeat views skip the ARTICLES KV read. A missing entry is a 404 `{ missing: true }`
 * sent `no-store`, since it stops being true the moment someone writes it.
 */
export async function GET({ params, request }: APIContext) {
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

    const articlePath = articlePathFrom(params);
    if (!articlePath) {
      return json(NOT_FOUND, 404, "public, max-age=86400");
    }

    const content = await getCachedArticle(env.ARTICLES, articlePath);
    if (!content) {
      return json({ missing: true }, 404, "no-store");
    }

    const response = json(
      { content },
      200,
      "public, s-maxage=86400, stale-while-revalidate=86400"
    );

    if (cache) {
      await cache.put(cacheKey, response.clone());
    }

    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Write the entry for this path (or return it, if someone already has).
 *
 * The only route that spends inference on articles. Link-following crawlers never
 * send it; the page sends it when a reader clicks "write this entry". Returns 200
 * `{ content }`, where `content` may be the limit/outage notice — callers detect it
 * by identity, and it is never cached (see #25: failures aren't cached). POSTs
 * aren't edge-cached anyway; the next GET reads the new entry from KV.
 */
export async function POST({ params }: APIContext) {
  try {
    const articlePath = articlePathFrom(params);
    if (!articlePath) {
      return json(NOT_FOUND, 404);
    }

    console.log("Writing entry:", articlePath);

    const content = await getArticle(
      env.AI,
      env.TOKEN_USAGE,
      env.ARTICLES,
      articlePath,
      env.INDICES,
      env.AI_GATEWAY_ID
    );

    if (!content) {
      throw new Error("No content generated");
    }

    return json({ content }, 200, "no-store");
  } catch (error) {
    return errorResponse(error);
  }
}

const EXPIRATION_TTL = 86400;
const CACHE_MAX_AGE = 3600;

// The DOM lib's `CacheStorage` doesn't expose `.default`, but Cloudflare Workers
// provide a per-colo default cache at runtime. Cast through `unknown` so we get
// the Workers shape regardless of which lib types win.
const workerCaches = caches as unknown as { default: Cache };

function getCacheKey(indexKey: "articles" | "searches"): Request {
  return new Request(`https://cache.local/indices/${indexKey}`);
}

/**
 * Retrieve a cached list of KV keys for the given index, using the `indices` namespace when available.
 *
 * Reads are layered behind Cloudflare's Workers Cache API (`caches.default`) to absorb repeated
 * lookups per-colo. On a cache miss, falls back to the `indices` KV namespace, then to a refresh
 * via `updateIndex` when `kv` is provided. If `indices` is not provided or `kv` is missing when a
 * refresh is required, an empty array is returned.
 *
 * @param indexKey - The index to load; either `"articles"` or `"searches"`.
 * @returns The list of KV keys for the requested index (may be empty).
 */
export async function getIndex<T>(
  kv: KVNamespace | undefined,
  indexKey: "articles" | "searches",
  indices: KVNamespace | undefined
): Promise<KVNamespaceListKey<T>[]> {
  if (!indices) return [];

  const cache = workerCaches.default;
  const cacheKey = getCacheKey(indexKey);
  const cached = await cache.match(cacheKey);
  if (cached) {
    const data = (await cached.json()) as KVNamespaceListKey<T>[] | null;
    if (data) return data;
  }

  const index = await indices.get<KVNamespaceListKey<T>[]>(indexKey, "json");

  if (index) {
    await cache.put(
      cacheKey,
      new Response(JSON.stringify(index), {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${CACHE_MAX_AGE}`,
        },
      })
    );
    return index;
  }
  if (!kv) return [];

  return updateIndex(kv, indexKey, indices);
}

/**
 * Refreshes and caches a list of keys from a KV namespace under a short-lived index.
 *
 * Retrieves all keys from `kv`, stores the JSON-serialized key list in `indices` at `indexKey`
 * with a 24-hour TTL, and returns the keys array. Also invalidates the corresponding entry in
 * Cloudflare's Workers Cache (`caches.default`) so subsequent reads pick up the fresh data.
 * If either `kv` or `indices` is missing, returns an empty array.
 *
 * @param indexKey - Which index to update ("articles" or "searches").
 * @returns The array of keys read from `kv`.
 */
export async function updateIndex<T>(
  kv: KVNamespace | undefined,
  indexKey: "articles" | "searches",
  indices: KVNamespace | undefined
): Promise<KVNamespaceListKey<T>[]> {
  if (!kv || !indices) return [];

  const { keys } = await kv.list<T>();

  await indices.put(indexKey, JSON.stringify(keys), {
    expirationTtl: EXPIRATION_TTL,
  });

  await workerCaches.default.delete(getCacheKey(indexKey));

  return keys;
}

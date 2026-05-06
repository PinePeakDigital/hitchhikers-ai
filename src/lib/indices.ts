const EXPIRATION_TTL = 2592000; // 30 days; index is kept fresh by incremental updates (#9)
/**
 * Retrieve a cached list of KV keys for the given index, using the `indices` namespace when available.
 *
 * If a cached entry exists in `indices` for `indexKey`, that list is returned. If no cache entry
 * exists and a `kv` namespace is provided, the index is refreshed by calling `updateIndex`, which
 * lists keys from `kv` and stores the result in `indices` with a TTL. If `indices` is not provided
 * or `kv` is missing when a refresh is required, an empty array is returned.
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

  const index = await indices.get<KVNamespaceListKey<T>[]>(indexKey, "json");

  if (index) return index;
  if (!kv) return [];

  return updateIndex(kv, indexKey, indices);
}

/**
 * Refreshes and caches a list of keys from a KV namespace under a short-lived index.
 *
 * Retrieves all keys from `kv`, stores the JSON-serialized key list in `indices` at `indexKey`
 * with a 24-hour TTL, and returns the keys array. If either `kv` or `indices` is missing, returns an empty array.
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

  return keys;
}

const EXPIRATION_TTL = 86400;

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

/**
 * Append a single entry to a cached index without re-listing the entire KV namespace.
 *
 * Reads the current index from `indices`, dedupes by `name` (replacing any existing entry
 * with the same name), appends the new entry, and writes the updated list back with the
 * standard 24-hour TTL. If the index has not been cached yet (null/missing), this is a
 * no-op — the next consumer will rebuild it via `getIndex` → `updateIndex`. If `indices`
 * is missing entirely, returns early.
 *
 * @param indexKey - Which index to append to ("articles" or "searches").
 * @param entry - The KV key entry to append (must include `name` and optional `metadata`).
 */
export async function appendToIndex<T>(
  indices: KVNamespace | undefined,
  indexKey: "articles" | "searches",
  entry: KVNamespaceListKey<T>
): Promise<void> {
  if (!indices) return;

  const index = await indices.get<KVNamespaceListKey<T>[]>(indexKey, "json");

  if (!index) return;

  const filtered = index.filter((existing) => existing.name !== entry.name);
  filtered.push(entry);

  await indices.put(indexKey, JSON.stringify(filtered), {
    expirationTtl: EXPIRATION_TTL,
  });
}

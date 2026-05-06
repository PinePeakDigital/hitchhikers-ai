interface Options {
  indexKey: "articles";
  db: D1Database | undefined;
  excludedKeys?: string[];
  count?: number;
}

type ArticleRow = {
  name: string;
  uploaded: number;
};

/**
 * Retrieve a randomized subset of keys from the D1-backed article index.
 *
 * Issues a `SELECT name, uploaded FROM articles [WHERE name NOT IN (?, ?, ...)]
 * ORDER BY RANDOM() LIMIT ?` query and returns the rows in the
 * `KVNamespaceListKey<T>[]` shape callers expect. Returns an empty array if
 * the D1 binding is missing or the query fails.
 *
 * @param indexKey - Index identifier; only `"articles"` is currently supported.
 * @param excludedKeys - Optional list of names to exclude from selection.
 * @param count - Maximum number of keys to return (default: 1).
 */
export async function getRandomKeys<T>({
  indexKey,
  db,
  excludedKeys,
  count = 1,
}: Options): Promise<KVNamespaceListKey<T>[]> {
  if (!db) return [];
  if (indexKey !== "articles") return [];

  const filtered = (excludedKeys ?? []).filter(
    (k): k is string => typeof k === "string" && k.length > 0
  );

  try {
    let stmt: D1PreparedStatement;
    if (filtered.length > 0) {
      const placeholders = filtered.map(() => "?").join(", ");
      stmt = db
        .prepare(
          `SELECT name, uploaded FROM articles WHERE name NOT IN (${placeholders}) ORDER BY RANDOM() LIMIT ?`
        )
        .bind(...filtered, count);
    } else {
      stmt = db
        .prepare(
          "SELECT name, uploaded FROM articles ORDER BY RANDOM() LIMIT ?"
        )
        .bind(count);
    }

    const result = await stmt.all<ArticleRow>();

    return (result.results ?? []).map((row) => ({
      name: row.name,
      metadata: { uploaded: row.uploaded } as unknown as T,
    }));
  } catch (error) {
    console.error("D1 getRandomKeys failed:", error);
    return [];
  }
}

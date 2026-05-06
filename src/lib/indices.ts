/**
 * D1-backed article index helpers.
 *
 * The article index previously lived in the `INDICES` KV namespace and was
 * rebuilt with `kv.list()` calls. KV `list` operations are the most
 * rate-limited op class on Cloudflare's KV plan, so the index has been
 * migrated to a Cloudflare D1 database (binding `DB`). The functions below
 * preserve the original `getIndex` / `updateIndex` names and return the same
 * `KVNamespaceListKey<T>[]` shape (`{ name, metadata: { uploaded } }`) so
 * existing callers continue to work without changes.
 *
 * Article BODIES still live in the `ARTICLES` KV namespace — only the
 * lightweight name + uploaded-timestamp index has moved to D1.
 */

type ArticleRow = {
  name: string;
  uploaded: number;
};

/**
 * Convert a D1 article row into the KV-list-key shape that callers expect.
 */
function rowToKey<T>(row: ArticleRow): KVNamespaceListKey<T> {
  return {
    name: row.name,
    metadata: { uploaded: row.uploaded } as unknown as T,
  };
}

/**
 * Fetch the full article index from D1, ordered most-recently-uploaded first.
 *
 * Returns an empty array if the D1 binding is unavailable or the query fails.
 *
 * @param db - The D1 database binding (typically `locals.runtime.env.DB`).
 * @param indexKey - Index identifier; only `"articles"` is currently supported.
 *                   Other values return an empty array.
 * @returns The index entries in the same shape KV `list()` produced.
 */
export async function getIndex<T>(
  db: D1Database | undefined,
  indexKey: "articles" | "searches"
): Promise<KVNamespaceListKey<T>[]> {
  if (!db) return [];
  if (indexKey !== "articles") return [];

  try {
    const result = await db
      .prepare("SELECT name, uploaded FROM articles ORDER BY uploaded DESC")
      .all<ArticleRow>();

    return (result.results ?? []).map((row) => rowToKey<T>(row));
  } catch (error) {
    console.error("D1 getIndex failed:", error);
    return [];
  }
}

/**
 * Insert (or update) an article entry in the D1 `articles` table.
 *
 * Used when a new article is generated; replaces the old `updateIndex`
 * KV-list-and-cache flow with a single indexed SQL UPSERT.
 *
 * @param db - The D1 database binding.
 * @param name - The article key/path being recorded.
 * @param uploaded - Unix-epoch milliseconds for the upload time. Defaults to `Date.now()`.
 */
export async function updateIndex(
  db: D1Database | undefined,
  name: string,
  uploaded: number = Date.now()
): Promise<void> {
  if (!db) return;

  try {
    await db
      .prepare(
        "INSERT INTO articles (name, uploaded) VALUES (?, ?) " +
          "ON CONFLICT(name) DO UPDATE SET uploaded = excluded.uploaded"
      )
      .bind(name, uploaded)
      .run();
  } catch (error) {
    console.error("D1 updateIndex failed:", error);
  }
}

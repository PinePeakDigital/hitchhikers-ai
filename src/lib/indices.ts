/**
 * D1-backed article index helpers.
 *
 * The article index previously lived in the `INDICES` KV namespace and was
 * rebuilt with `kv.list()` calls. KV `list` operations are the most
 * rate-limited op class on Cloudflare's KV plan, so the index has been
 * migrated to a Cloudflare D1 database (binding `DB`). The function below
 * records each new article with `updateIndex`; reads (count, latest, random)
 * are plain SQL in their callers.
 *
 * Article BODIES still live in the `ARTICLES` KV namespace — only the
 * lightweight name + uploaded-timestamp index has moved to D1.
 */

/**
 * Insert (or update) an article entry in the D1 `articles` table.
 *
 * Used when a new article is generated; replaces the old KV list-and-cache
 * index rebuild with a single indexed SQL UPSERT.
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
    // The article body is already in KV, and a cached article never re-runs this write, so a
    // failure leaves it unindexed until scripts/backfill-d1-index.sh runs. Name it for that.
    console.error(`D1 updateIndex failed for "${name}":`, error);
  }
}

import { marked } from "marked";

/**
 * Retrieves the most recently uploaded article, converts it from Markdown to
 * HTML, and returns its first paragraph and path.
 *
 * The "latest" article is determined by the `uploaded` column on the D1
 * `articles` table (`ORDER BY uploaded DESC LIMIT 1`). The article body is
 * fetched from the `ARTICLES` KV namespace and rendered to HTML; the content
 * of the first `<p>...</p>` is returned as `text` (empty string if no
 * paragraph is found).
 *
 * Returns `null` when `articles` or `db` is missing, the index is empty, or
 * the article body cannot be fetched.
 *
 * @returns `{ text, path }` for the latest article, or `null`.
 */
export async function getLatestArticle(
  articles: KVNamespace | undefined,
  db: D1Database | undefined
): Promise<{ text: string; path: string } | null> {
  if (!articles || !db) return null;

  let latest: { name: string } | null = null;
  try {
    latest = await db
      .prepare("SELECT name FROM articles ORDER BY uploaded DESC LIMIT 1")
      .first<{ name: string }>();
  } catch (error) {
    console.error("D1 getLatestArticle failed:", error);
    return null;
  }

  if (!latest?.name) return null;

  const fullEntry = await articles.get(latest.name, "text");
  if (!fullEntry) return null;

  const parsedHtml = await marked(fullEntry);
  const match = parsedHtml.match(/<p>(.*?)<\/p>/);
  const firstParagraph = match ? match[1] : "";

  return {
    text: firstParagraph,
    path: latest.name,
  };
}

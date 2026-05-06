CREATE TABLE IF NOT EXISTS articles (
  name TEXT PRIMARY KEY,
  uploaded INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_uploaded ON articles(uploaded DESC);

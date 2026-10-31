#!/bin/bash
# Copy every ARTICLES key into the D1 `articles` index. Safe to re-run: existing rows are kept.
# Keys written before metadata.uploaded existed get uploaded = 0.
set -euo pipefail
out="$(mktemp)"
filter='.[] | "INSERT OR IGNORE INTO articles (name, uploaded) VALUES (\u0027" + (.name | gsub("\u0027"; "\u0027\u0027")) + "\u0027, " + ((.metadata.uploaded // 0) | tostring) + ");"'
pnpm wrangler kv key list --binding=ARTICLES --remote | jq -r "$filter" > "$out"
echo "Backfilling $(wc -l < "$out") articles"
pnpm wrangler d1 execute hitchhikers-articles --remote --file="$out"

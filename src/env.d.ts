/// <reference types="astro/client" />
type ENV = {
  TOKEN_USAGE: KVNamespace;
  ARTICLES: KVNamespace;
  SEARCHES: KVNamespace;
  INDICES: KVNamespace;
  DB: D1Database;
  OPENAI_API_KEY: string;
};
type Runtime = import("@astrojs/cloudflare").Runtime<ENV>;
declare namespace App {
  interface Locals extends Runtime {}
}

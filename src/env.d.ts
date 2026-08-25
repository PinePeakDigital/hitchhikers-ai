/// <reference types="astro/client" />
type ENV = {
  TOKEN_USAGE: KVNamespace;
  ARTICLES: KVNamespace;
  SEARCHES: KVNamespace;
  INDICES: KVNamespace;
  AI: Ai;
  /** Optional. When set, Workers AI calls are routed through this AI Gateway. */
  AI_GATEWAY_ID?: string;
};
type Runtime = import("@astrojs/cloudflare").Runtime<ENV>;
declare namespace App {
  interface Locals extends Runtime {}
}

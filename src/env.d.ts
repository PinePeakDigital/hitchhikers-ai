/// <reference types="astro/client" />

// Astro 6+ / @astrojs/cloudflare 14 removed `Astro.locals.runtime.env` in favor
// of importing bindings directly via `import { env } from "cloudflare:workers"`,
// which is typed as `Cloudflare.Env`. `App.Locals` (with its minimal
// `cfContext`-only `Runtime` shape) is now declared by the adapter itself via
// .astro/integrations/_astrojs_cloudflare; this file only needs to extend
// `Cloudflare.Env` (from `wrangler types`) with vars that aren't declared in
// wrangler.jsonc.
declare namespace Cloudflare {
  interface Env {
    /** Optional. When set, Workers AI calls are routed through this AI Gateway. */
    AI_GATEWAY_ID?: string;
  }
}

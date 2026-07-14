import type { Env as PageVaultEnv } from "../src/env.js";

// `env` from `cloudflare:test` is typed off the global `Cloudflare.Env` interface.
// Point it at our hand-written Env so the test suite typechecks against the same
// shape the Worker does — including the secrets, which `wrangler types` cannot know
// about because they are never in wrangler.jsonc.
declare global {
  namespace Cloudflare {
    interface Env extends PageVaultEnv {}
  }
}

export {};
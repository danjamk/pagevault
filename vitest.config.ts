import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// vitest-pool-workers 0.18 (the Vitest 4 line) exposes this as a Vite plugin.
// `defineWorkersConfig` from ".../config" is the Vitest 3 API and is gone.
export default defineConfig({
  plugins: [
    cloudflareTest({
      // Read the real Worker config, so tests run against the same bindings and
      // compatibility date as production. A drifting test config is a test suite
      // that passes while production breaks.
      wrangler: { configPath: "./worker/wrangler.jsonc" },

      miniflare: {
        // Vars are empty in the committed wrangler.jsonc (`pagevault init` fills
        // them in), so tests supply their own. Secrets never come from the config.
        bindings: {
          OWNER_EMAIL: "owner@example.com",
          CF_TEAM_NAME: "testteam",
          PUBLIC_HOST: "share.example.com",
          CF_ACCESS_AUD_DOCS: "aud-docs-test",
          CF_ACCESS_AUD_ADMIN: "aud-admin-test",
          PAGEVAULT_API_TOKEN: "test-token-do-not-use-in-production",
        },
      },

      // Each test file gets its own KV. Tests that depend on another file's writes
      // are tests that fail in a random order six months from now.
      isolatedStorage: true,
    }),
  ],

  test: {
    include: ["worker/test/**/*.test.ts"],
  },
});
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
        // Vars ship blank in the committed wrangler.jsonc (the provisioning script fills
        // them in), so tests supply their own. Secrets never come from the config.
        bindings: {
          OWNER_EMAIL: "owner@example.com",
          CF_TEAM_NAME: "testteam",
          PUBLIC_HOST: "share.example.com",
          CF_ACCESS_AUD_DOCS: "aud-docs-test",
          CF_ACCESS_AUD_ADMIN: "aud-admin-test",
          PAGEVAULT_API_TOKEN: "test-token-do-not-use-in-production",

          // 🔴 Pinned OFF, explicitly.
          //
          // Reading wrangler.jsonc also pulls in worker/.dev.vars — so a developer with
          // AUTH_MODE=none in their local dev config would run the entire security suite
          // against a Worker with authentication DISABLED, and every test would still go
          // green. That is a hole in the harness, which is worse than a hole in the code.
          //
          // worker/test/harness.test.ts asserts this is still off, so if the leak ever
          // reappears it fails loudly instead of silently.
          AUTH_MODE: "",
        },
      },

    }),
  ],

  test: {
    include: ["worker/test/**/*.test.ts"],
    // Wipes KV between tests. 0.18 dropped the `isolatedStorage` pool option; the
    // replacement is an explicit reset(), and it belongs here so no test file can
    // forget it. See worker/test/setup.ts.
    setupFiles: ["./worker/test/setup.ts"],
  },
});
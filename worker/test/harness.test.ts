import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * 🔴 Tests about the tests.
 *
 * The suite reads `worker/wrangler.jsonc` so that it runs against production's real
 * bindings and compatibility date. That is deliberate and good — but Wrangler also loads
 * `worker/.dev.vars` alongside that config, which means **a developer's local dev settings
 * can leak into the test environment.**
 *
 * It happened. A `.dev.vars` containing `AUTH_MODE=none` — entirely reasonable for
 * `wrangler dev`, which has no Cloudflare Access in front of it — silently disabled
 * authentication for the whole suite. The security tests went green against a Worker with
 * auth turned off.
 *
 * A hole in the harness is worse than a hole in the code, because it makes every other
 * guarantee in the repo unfalsifiable. So the harness gets its own tests.
 */

describe("🔴 the test harness itself", () => {
  it("runs with authentication ENFORCED", () => {
    // If this fails, your worker/.dev.vars is leaking into the suite and every security
    // test above it has been meaningless. Do not skip it. Do not "fix" it by deleting it.
    expect(env.AUTH_MODE).not.toBe("none");
  });

  it("has an owner, so canView() has someone to grant", () => {
    expect(env.OWNER_EMAIL).toBeTruthy();
  });

  it("has a bearer token that is not a real one", () => {
    expect(env.PAGEVAULT_API_TOKEN).toBeTruthy();
    expect(env.PAGEVAULT_API_TOKEN).toContain("do-not-use-in-production");
  });

  it("keeps the two Access audiences distinct", () => {
    // A single shared AUD is a privilege escalation, not a config simplification: it would
    // let any portal viewer present their token to the owner console. See ADR-001.
    expect(env.CF_ACCESS_AUD_DOCS).toBeTruthy();
    expect(env.CF_ACCESS_AUD_ADMIN).toBeTruthy();
    expect(env.CF_ACCESS_AUD_DOCS).not.toBe(env.CF_ACCESS_AUD_ADMIN);
  });
});

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Phase 0 (#1). These prove the toolchain, not the product.
 *
 * The KV test earns its place: it is the difference between "vitest runs" and
 * "vitest runs against a real Miniflare KV binding with our real wrangler config".
 * Everything after this depends on that being true.
 */

describe("toolchain", () => {
  it("binds a working KV namespace", async () => {
    await env.PAGEVAULT.put("doc:test", "<h1>hello</h1>");
    expect(await env.PAGEVAULT.get("doc:test")).toBe("<h1>hello</h1>");
  });

  it("returns key metadata inline from list(), with no extra reads", async () => {
    // The whole listing design rests on this. If KV key metadata did not come back
    // on list(), GET /api/docs would need one read per document (#2).
    await env.PAGEVAULT.put("meta:abc", JSON.stringify({ id: "abc" }), {
      metadata: { title: "Q3 Review", visibility: "private" },
    });

    const { keys } = await env.PAGEVAULT.list({ prefix: "meta:" });

    expect(keys).toHaveLength(1);
    expect(keys[0]?.metadata).toEqual({ title: "Q3 Review", visibility: "private" });
  });

  it("reads vars from the test bindings", () => {
    expect(env.OWNER_EMAIL).toBe("owner@example.com");
  });

  it("keeps the two Access AUDs distinct", () => {
    // A single shared AUD is a privilege escalation, not a config simplification.
    // See ADR-001. This test exists so that collapsing them fails loudly.
    expect(env.CF_ACCESS_AUD_DOCS).not.toBe(env.CF_ACCESS_AUD_ADMIN);
  });
});

describe("router", () => {
  it("redirects / to /admin", async () => {
    const res = await SELF.fetch("https://share.example.com/", { redirect: "manual" });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://share.example.com/admin");
  });

  it("404s an unknown path", async () => {
    const res = await SELF.fetch("https://share.example.com/nope");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found", code: "not_found" });
  });

  // /api/* (#2), /render + /p/* (#3), and /v/* (#13) are live and have their own suites.
  // Only the console is still a stub.
  it("routes /admin to a handler (not yet implemented)", async () => {
    const res = await SELF.fetch("https://share.example.com/admin");
    expect(res.status).toBe(501);
  });

  it.each(["/p/nosuchtoken", "/v/nosuchportal"])(
    "404s %s rather than 501ing — the route is live",
    async (path) => {
      const res = await SELF.fetch(`https://share.example.com${path}`);
      expect(res.status).toBe(404);
    },
  );
});
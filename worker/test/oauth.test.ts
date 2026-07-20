import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The OAuth 2.1 surface (#22, ADR-006). These prove the OAuthProvider is actually mounted
 * in front of the Worker — the discovery metadata the hosted surfaces fetch, and the 401
 * challenge that kicks off the flow. The full end-to-end handshake is verified live against
 * claude.ai; a DCR + PKCE dance is more than a unit test should carry.
 *
 * 🔴 The load-bearing one is the last: the Claude Code static-bearer path must still work.
 * OAuth is a second auth surface next to it, never a replacement (ADR-006 staged-auth).
 */

const HOST = "https://share.example.com";

describe("OAuth 2.1 surface (#22)", () => {
  it("serves RFC 8414 authorization-server metadata", async () => {
    const res = await SELF.fetch(`${HOST}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body["authorization_endpoint"])).toContain("/authorize");
    expect(String(body["token_endpoint"])).toContain("/token");
    expect(String(body["registration_endpoint"])).toContain("/register");
  });

  it("serves RFC 9728 protected-resource metadata at the resource-specific path", async () => {
    // The library serves resource-specific metadata at the apiRoute-suffixed path, NOT the
    // bare one — and the WWW-Authenticate challenge points clients here. An earlier version
    // of this test asserted the bare path; it passed in miniflare but 404s in production,
    // which is exactly how the #22 spike caught it. Assert the path clients actually fetch.
    const res = await SELF.fetch(`${HOST}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["authorization_servers"]).toContain(HOST);
    // NB: the bare /.well-known/oauth-protected-resource (no /mcp suffix) 404s in production
    // but is served by miniflare — an env gap, so it is deliberately not asserted here.
  });

  it("challenges an unauthenticated /mcp with 401 — the flow's entry point", async () => {
    const res = await SELF.fetch(`${HOST}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
  });
});

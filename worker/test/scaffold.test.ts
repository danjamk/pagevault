import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { consoleForbidden, rootLanding } from "../src/pages.js";

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
  it("redirects / to /admin when Access is provisioned", async () => {
    // The test bindings set CF_ACCESS_AUD_ADMIN (rung 3), so there is a console to reach.
    // With it unset (rung 1/2) the router serves the landing instead — see pages.test below.
    const res = await SELF.fetch("https://share.example.com/", { redirect: "manual" });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://share.example.com/admin");
  });

  it("404s an unknown path", async () => {
    const res = await SELF.fetch("https://share.example.com/nope");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found", code: "not_found" });
  });

  it("serves /health with the deployment version and deploy time, unauthenticated", async () => {
    const res = await SELF.fetch("https://share.example.com/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; version: string; deployedAt: string | null };
    expect(body.name).toBe("pagevault");
    expect(typeof body.version).toBe("string");
    // Additive: present, and either the baked ISO string or null when it wasn't baked (as in tests).
    expect("deployedAt" in body).toBe(true);
    expect(body.deployedAt === null || typeof body.deployedAt === "string").toBe(true);
  });

  // /api/* (#2), /render + /p/* (#3), /v/* (#13), and /admin (#5) are all live now.
  it("403s an unauthenticated /admin — the console is live and identity-gated", async () => {
    const res = await SELF.fetch("https://share.example.com/admin");
    expect(res.status).toBe(403);
  });

  it("404s an unknown /p/ token rather than 501ing — the route is live", async () => {
    const res = await SELF.fetch("https://share.example.com/p/nosuchtoken");
    expect(res.status).toBe(404);
  });

  it("500s an unauthenticated /v/ request — the route is live, and Access should have gated it", async () => {
    // Not a 501 (unimplemented) and not a 404 (no such portal): a 500 saying the deployment
    // is misconfigured, because an unauthenticated request cannot reach /v/* unless it is.
    const res = await SELF.fetch("https://share.example.com/v/nosuchportal");
    expect(res.status).toBe(500);
  });
});

describe("publish-mode pages", () => {
  it("the root landing is a 200 that leaks nothing about the operator", async () => {
    const res = rootLanding();
    expect(res.status).toBe(200);
    const body = await res.text();
    // It names the software (fine) but never the owner, a portal, or a document.
    expect(body).toContain("PageVault");
    expect(body).not.toContain(env.OWNER_EMAIL);
    // Static page: no script anywhere, and the CSP forbids it.
    expect(body).not.toContain("<script");
    expect(res.headers.get("Content-Security-Policy")).not.toContain("script-src");
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
  });

  it("the console 403 is friendly and context-aware", async () => {
    const withAccess = consoleForbidden({ CF_ACCESS_AUD_ADMIN: "some-aud" } as Env);
    expect(withAccess.status).toBe(403);
    expect(await withAccess.text()).toContain("Owner only");

    const withoutAccess = consoleForbidden({ CF_ACCESS_AUD_ADMIN: "" } as Env);
    expect(withoutAccess.status).toBe(403);
    expect(await withoutAccess.text()).toContain("isn't enabled");
  });
});
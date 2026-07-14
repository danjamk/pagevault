import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { type Portal, putPortal } from "../src/store.js";

const TOKEN = "test-token-do-not-use-in-production";
const HOST = "https://share.example.com";

const auth = (token = TOKEN) => ({ Authorization: `Bearer ${token}` });

async function publish(body: unknown, token = TOKEN) {
  return SELF.fetch(`${HOST}/api/docs`, {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const aDoc = (over: Record<string, unknown> = {}) => ({
  title: "Q3 Review",
  html: "<!doctype html><h1>Q3</h1>",
  ...over,
});

const portal = (slug: string, kind: Portal["kind"] = "restricted"): Portal => ({
  slug,
  name: slug,
  kind,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("auth", () => {
  it("401s with no bearer token", async () => {
    const res = await SELF.fetch(`${HOST}/api/docs`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthorized" });
  });

  it("401s with the wrong bearer token", async () => {
    expect((await publish(aDoc(), "not-the-token")).status).toBe(401);
  });

  it("401s on a token that is a prefix of the real one", async () => {
    expect((await publish(aDoc(), TOKEN.slice(0, -1))).status).toBe(401);
  });

  it("🔴 never accepts the CF_Authorization cookie", async () => {
    // The browser attaches this to /api/* whether we like it or not — it is scoped
    // Path=/ on the hostname, and /api has no Access app to strip it. Honouring it
    // would make every endpoint here CSRF-reachable from an artifact we serve. ADR-004.
    const res = await SELF.fetch(`${HOST}/api/docs`, {
      headers: { Cookie: `CF_Authorization=${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/docs — the simple path, with no portal concept", () => {
  // ADR-005: the quickstart must not contain the word "portal". A tool that demands a
  // taxonomy before it gives you a URL is a tool nobody adopts.

  it("publishes with no portal named, and creates `default` on the way", async () => {
    const res = await publish(aDoc());
    expect(res.status).toBe(201);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body["portal"]).toBe("default");
    expect(body["id"]).toMatch(/^[23456789abcdefghijkmnpqrstuvwxyz]{12}$/);
    expect(body["url"]).toBe(`${HOST}/v/default/${body["id"]}`);
  });

  it("round-trips the source through KV", async () => {
    const html = "<!doctype html><h1>Round trip</h1>";
    const { id } = (await (await publish(aDoc({ html }))).json()) as { id: string };
    expect(await env.PAGEVAULT.get(`doc:${id}`)).toBe(html);
  });

  it("`--emails` grants two people access to one doc, inventing no portal", async () => {
    const res = await publish(aDoc({ emails: ["  CFO@Acme.com ", "cfo@acme.com"] }));
    const body = (await res.json()) as { extraEmails: string[]; portal: string };

    expect(body.portal).toBe("default");
    expect(body.extraEmails).toEqual(["cfo@acme.com"]); // normalized and deduped
  });

  it("`--public` mints a separate /p/ URL", async () => {
    const res = await publish(aDoc({ public: true }));
    const body = (await res.json()) as { id: string; url: string; publicUrl: string };

    expect(body.publicUrl).toMatch(/^https:\/\/share\.example\.com\/p\/[a-z2-9]{22}$/);
    // The two URLs are different things, not variants. /v/ still needs a login.
    expect(body.publicUrl).not.toBe(body.url);

    const token = body.publicUrl.split("/p/")[1]!;
    expect(await env.PAGEVAULT.get(`pub:${token}`)).toBe(body.id);
  });

  it("does not mint a pub: key unless asked — widening is never a side effect", async () => {
    await publish(aDoc());
    const { keys } = await env.PAGEVAULT.list({ prefix: "pub:" });
    expect(keys).toHaveLength(0);
  });

  it("records ownerOnly", async () => {
    const res = await publish(aDoc({ ownerOnly: true }));
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ ownerOnly: true });
  });

  it("writes the portal index entry", async () => {
    const { id } = (await (await publish(aDoc())).json()) as { id: string };
    expect(await env.PAGEVAULT.get(`idx:default:${id}`)).toBe("");
  });
});

describe("POST /api/docs — portal resolution", () => {
  it("uses the single portal that exists, without being asked", async () => {
    await putPortal(env, portal("realplus"));

    const body = (await (await publish(aDoc())).json()) as { portal: string };
    expect(body.portal).toBe("realplus");
  });

  it("⭐ errors and lists them when 2+ portals exist and no default is set", async () => {
    // Never guess. Inferring the portal is exactly how Client A's report lands in
    // Client B's portal.
    await putPortal(env, portal("realplus"));
    await putPortal(env, portal("acme"));

    const res = await publish(aDoc());
    expect(res.status).toBe(400);

    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("portal_ambiguous");
    expect(body.error).toContain("realplus");
    expect(body.error).toContain("acme");
  });

  it("prefers `default` when it exists alongside others", async () => {
    await putPortal(env, portal("default", "private"));
    await putPortal(env, portal("realplus"));

    const body = (await (await publish(aDoc())).json()) as { portal: string };
    expect(body.portal).toBe("default");
  });

  it("uses an explicitly named portal", async () => {
    await putPortal(env, portal("realplus"));
    await putPortal(env, portal("acme"));

    const body = (await (await publish(aDoc({ portal: "acme" }))).json()) as { portal: string };
    expect(body.portal).toBe("acme");
  });

  it("404-equivalents a portal that does not exist", async () => {
    const res = await publish(aDoc({ portal: "nosuchclient" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "no_such_portal" });
  });

  it("🔴 rejects a reserved slug rather than shadowing a route", async () => {
    const res = await publish(aDoc({ portal: "admin" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_slug" });
  });
});

describe("POST /api/docs — validation", () => {
  it.each([
    ["missing title", { html: "<h1>x</h1>" }],
    ["blank title", { title: "   ", html: "<h1>x</h1>" }],
    ["missing html", { title: "x" }],
    ["tags not an array", { title: "x", html: "<h1>x</h1>", tags: "client:acme" }],
    ["email without @", { title: "x", html: "<h1>x</h1>", emails: ["nope"] }],
    ["bad sourceKind", { title: "x", html: "<h1>x</h1>", sourceKind: "pdf" }],
  ])("400s on %s", async (_name, body) => {
    expect((await publish(body)).status).toBe(400);
  });

  it("400s on malformed JSON", async () => {
    const res = await SELF.fetch(`${HOST}/api/docs`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_json" });
  });

  it("413s over the size cap", async () => {
    const res = await publish(aDoc({ html: "x".repeat(10 * 1024 * 1024 + 1) }));
    expect(res.status).toBe(413);
  });

  it("400s rather than corrupting the index when metadata overflows KV's 1KB cap", async () => {
    // KV rejects an oversized metadata write outright. Without this guard the document
    // would publish, the metadata write would fail, and the doc would simply be missing
    // from every listing — a silent hole, not an error.
    const res = await publish(
      aDoc({
        title: "é".repeat(200),
        summary: "é".repeat(300),
        tags: Array.from({ length: 16 }, (_, i) => `${i}`.padEnd(64, "é")),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "metadata_too_large" });
  });
});

describe("deployment misconfiguration", () => {
  // These only ever surfaced by running wrangler dev and curling it: the committed
  // wrangler.jsonc ships blank vars, while the tests inject their own.

  function publishWithEnv(overrides: Partial<typeof env>) {
    const request = new Request(`${HOST}/api/docs`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify(aDoc()),
    });
    return worker.fetch(request, { ...env, ...overrides });
  }

  it("500s rather than publishing a document with no owner", async () => {
    // canView grants the owner first. With a blank OWNER_EMAIL there is no owner, and
    // a private document becomes one nobody can open. Fail at publish, not at read.
    const res = await publishWithEnv({ OWNER_EMAIL: "  " });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "owner_not_configured" });
  });

  it("falls back to the request origin when PUBLIC_HOST is unset", async () => {
    const res = await publishWithEnv({ PUBLIC_HOST: "" });
    const body = (await res.json()) as { url: string };

    expect(res.status).toBe(201);
    expect(body.url).not.toContain("https:///");
    expect(body.url).toMatch(/^https:\/\/share\.example\.com\/v\/default\//);
  });
});

describe("GET /api/docs", () => {
  beforeEach(async () => {
    await putPortal(env, portal("default", "private"));
    await putPortal(env, portal("realplus"));

    await publish(aDoc({ title: "Alpha", portal: "default", tags: ["type:report"] }));
    await publish(aDoc({ title: "Beta", portal: "realplus", tags: ["type:report"] }));
    await publish(aDoc({ title: "Gamma", portal: "realplus", ownerOnly: true }));
  });

  it("lists every document", async () => {
    const res = await SELF.fetch(`${HOST}/api/docs`, { headers: auth() });
    const { docs } = (await res.json()) as { docs: { title: string }[] };

    expect(docs.map((d) => d.title).sort()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("filters by portal", async () => {
    const res = await SELF.fetch(`${HOST}/api/docs?portal=realplus`, { headers: auth() });
    const { docs } = (await res.json()) as { docs: { title: string }[] };

    expect(docs.map((d) => d.title).sort()).toEqual(["Beta", "Gamma"]);
  });

  it("filters by tag", async () => {
    const res = await SELF.fetch(`${HOST}/api/docs?tag=type:report`, { headers: auth() });
    const { docs } = (await res.json()) as { docs: { title: string }[] };

    expect(docs.map((d) => d.title).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("returns metadata only — never document bodies, never allowlists", async () => {
    const res = await SELF.fetch(`${HOST}/api/docs`, { headers: auth() });
    const { docs } = (await res.json()) as { docs: Record<string, unknown>[] };

    for (const doc of docs) {
      expect(doc["html"]).toBeUndefined();
      // Not privacy — capacity. KV caps key metadata at 1024 bytes and an allowlist can
      // blow it, which would break listing for the documents with the most sharing.
      expect(doc["extraEmails"]).toBeUndefined();
      expect(doc).toHaveProperty("portal");
      expect(doc).toHaveProperty("ownerOnly");
    }
  });

  it("⭐ issues exactly one KV list() call and zero reads", async () => {
    // The whole point of the listing design. An N+1 passes every other test in this
    // file and quietly eats the 100k/day read quota in production.
    const list = vi.spyOn(env.PAGEVAULT, "list");
    const get = vi.spyOn(env.PAGEVAULT, "get");

    await SELF.fetch(`${HOST}/api/docs`, { headers: auth() });

    expect(list).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();

    list.mockRestore();
    get.mockRestore();
  });
});

describe("GET /api/docs/{id}", () => {
  it("returns the full DocMeta, including extraEmails", async () => {
    const created = await publish(aDoc({ emails: ["cfo@acme.com"], tags: ["client:acme"] }));
    const { id } = (await created.json()) as { id: string };

    const res = await SELF.fetch(`${HOST}/api/docs/${id}`, { headers: auth() });
    const meta = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(meta).toMatchObject({
      id,
      portal: "default",
      title: "Q3 Review",
      sourceKind: "html",
      ownerOnly: false,
      tags: ["client:acme"],
      extraEmails: ["cfo@acme.com"],
    });
  });

  it("404s on an unknown id", async () => {
    const res = await SELF.fetch(`${HOST}/api/docs/doesnotexist`, { headers: auth() });
    expect(res.status).toBe(404);
  });

  it("405s on an unsupported method", async () => {
    // DELETE lands in #13. Until then it must not silently 404 as if the route were
    // unknown — that would hide a real routing bug.
    const res = await SELF.fetch(`${HOST}/api/docs/whatever`, { method: "DELETE", headers: auth() });
    expect(res.status).toBe(405);
  });
});

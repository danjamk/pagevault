import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";

const TOKEN = "test-token-do-not-use-in-production";
const OWNER = "owner@example.com";
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

describe("auth", () => {
  it("401s with no bearer token", async () => {
    const res = await SELF.fetch(`${HOST}/api/docs`);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthorized" });
  });

  it("401s with the wrong bearer token", async () => {
    const res = await publish(aDoc(), "not-the-token");
    expect(res.status).toBe(401);
  });

  it("401s on a token that is a prefix of the real one", async () => {
    // A non-constant-time compare would still reject this, but a *length-blind* one
    // built on startsWith would not. Cheap test, real bug class.
    const res = await publish(aDoc(), TOKEN.slice(0, -1));
    expect(res.status).toBe(401);
  });

  it("never accepts the CF_Authorization cookie", async () => {
    // The browser attaches this to /api/* whether we like it or not — it is scoped
    // Path=/ on the hostname, and /api has no Access app to strip it. Honouring it
    // would make every endpoint here CSRF-reachable from a document we serve.
    // See ADR-004.
    const res = await SELF.fetch(`${HOST}/api/docs`, {
      headers: { Cookie: `CF_Authorization=${TOKEN}` },
    });

    expect(res.status).toBe(401);
  });
});

describe("POST /api/docs", () => {
  it("publishes and returns a /d/ URL", async () => {
    const res = await publish(aDoc());

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body["id"]).toMatch(/^[23456789abcdefghijkmnpqrstuvwxyz]{12}$/);
    expect(body["url"]).toBe(`${HOST}/d/${body["id"]}`);
    expect(body["visibility"]).toBe("private");
    expect(body["emails"]).toEqual([OWNER]);
    expect(body["publicUrl"]).toBeUndefined();
  });

  it("round-trips: publish, then fetch the body back out of KV", async () => {
    const html = "<!doctype html><h1>Round trip</h1>";
    const res = await publish(aDoc({ html }));
    const { id } = (await res.json()) as { id: string };

    expect(await env.PAGEVAULT.get(`doc:${id}`)).toBe(html);
  });

  it("defaults to private and always includes the owner", async () => {
    const res = await publish(aDoc({ visibility: "restricted", emails: ["client@acme.com"] }));
    const body = (await res.json()) as { emails: string[] };

    expect(body.emails).toContain(OWNER);
    expect(body.emails).toContain("client@acme.com");
  });

  it("normalizes and dedupes emails", async () => {
    const res = await publish(
      aDoc({ visibility: "restricted", emails: ["  Client@Acme.COM ", "client@acme.com"] }),
    );
    const body = (await res.json()) as { emails: string[] };

    expect(body.emails.filter((e) => e === "client@acme.com")).toHaveLength(1);
    expect(body.emails).not.toContain("Client@Acme.COM");
  });

  it("mints a public token and a separate /p/ URL when public", async () => {
    const res = await publish(aDoc({ visibility: "public" }));
    const body = (await res.json()) as { id: string; url: string; publicUrl: string };

    expect(body.publicUrl).toMatch(/^https:\/\/share\.example\.com\/p\/[a-z2-9]{22}$/);
    // The two URLs are different things, not variants. /d/ still needs a login.
    expect(body.publicUrl).not.toBe(body.url);

    const token = body.publicUrl.split("/p/")[1]!;
    expect(await env.PAGEVAULT.get(`pub:${token}`)).toBe(body.id);
  });

  it("does not mint a pub: key for a private document", async () => {
    await publish(aDoc());
    const { keys } = await env.PAGEVAULT.list({ prefix: "pub:" });
    expect(keys).toHaveLength(0);
  });

  it.each([
    ["missing title", { html: "<h1>x</h1>" }],
    ["blank title", { title: "   ", html: "<h1>x</h1>" }],
    ["missing html", { title: "x" }],
    ["bad visibility", { title: "x", html: "<h1>x</h1>", visibility: "secret" }],
    ["restricted with no emails", { title: "x", html: "<h1>x</h1>", visibility: "restricted" }],
    ["email without @", { title: "x", html: "<h1>x</h1>", visibility: "restricted", emails: ["nope"] }],
    ["tags not an array", { title: "x", html: "<h1>x</h1>", tags: "client:acme" }],
  ])("400s on %s", async (_name, body) => {
    const res = await publish(body);
    expect(res.status).toBe(400);
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

  it("413s on a document over the size cap", async () => {
    const res = await publish(aDoc({ html: "x".repeat(10 * 1024 * 1024 + 1) }));

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "too_large" });
  });

  it("400s rather than corrupting the index when title and tags overflow KV metadata", async () => {
    // KV caps key metadata at 1024 bytes and rejects the write outright. Without this
    // guard the document would publish, the metadata write would fail, and the doc
    // would simply be missing from every listing — a silent hole, not an error.
    const res = await publish(
      aDoc({
        title: "é".repeat(200), // 2 bytes each in UTF-8
        tags: Array.from({ length: 16 }, (_, i) => `${i}`.padEnd(64, "é")),
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "metadata_too_large" });
  });
});

describe("deployment misconfiguration", () => {
  // Both of these got past the entire suite above and only surfaced by running
  // `wrangler dev` and curling it. The committed wrangler.jsonc ships empty vars
  // (`pagevault init` fills them in), while the tests supply their own via Miniflare —
  // so the suite never saw a blank var, and the code produced garbage instead of
  // complaining.
  //
  // These call the Worker handler directly rather than through SELF, because that is
  // the only way to hand it an env it did not expect.

  function publishWithEnv(overrides: Partial<typeof env>) {
    const request = new Request(`${HOST}/api/docs`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify(aDoc()),
    });

    return worker.fetch(request, { ...env, ...overrides });
  }

  it("500s rather than publishing an ownerless document when OWNER_EMAIL is unset", async () => {
    // With a blank OWNER_EMAIL, a public doc got `emails: []` — a document that, once
    // #4 gates /d/ on the allowlist, literally nobody can open. Fail at publish time,
    // where the error can say why, rather than at first read.
    const res = await publishWithEnv({ OWNER_EMAIL: "  " });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "owner_not_configured" });
  });

  it("falls back to the request origin when PUBLIC_HOST is unset", async () => {
    // An unset PUBLIC_HOST produced `https:///d/abc` — malformed, and emitted silently.
    // The request already knows the host it arrived on.
    const res = await publishWithEnv({ PUBLIC_HOST: "" });
    const body = (await res.json()) as { url: string };

    expect(res.status).toBe(201);
    expect(body.url).toMatch(/^https:\/\/share\.example\.com\/d\/[a-z2-9]{12}$/);
    expect(body.url).not.toContain("https:///");
  });
});

describe("GET /api/docs", () => {
  beforeEach(async () => {
    await publish(aDoc({ title: "Alpha", tags: ["client:acme"] }));
    await publish(aDoc({ title: "Beta", visibility: "public", tags: ["client:acme", "type:report"] }));
    await publish(aDoc({ title: "Gamma", visibility: "restricted", emails: ["a@b.com"] }));
  });

  it("lists every document", async () => {
    const res = await SELF.fetch(`${HOST}/api/docs`, { headers: auth() });
    const { docs } = (await res.json()) as { docs: { title: string }[] };

    expect(res.status).toBe(200);
    expect(docs.map((d) => d.title).sort()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("returns metadata only — never document bodies", async () => {
    const res = await SELF.fetch(`${HOST}/api/docs`, { headers: auth() });
    const { docs } = (await res.json()) as { docs: Record<string, unknown>[] };

    for (const doc of docs) {
      expect(doc["html"]).toBeUndefined();
      expect(doc).toHaveProperty("title");
      expect(doc).toHaveProperty("bytes");
    }
  });

  it("omits emails from the listing", async () => {
    // Not privacy — capacity. KV caps key metadata at 1024 bytes and an allowlist can
    // blow it. Putting emails here would break listing for exactly the documents with
    // the most sharing. See store.ts / ADR-002.
    const res = await SELF.fetch(`${HOST}/api/docs`, { headers: auth() });
    const { docs } = (await res.json()) as { docs: Record<string, unknown>[] };

    for (const doc of docs) expect(doc["emails"]).toBeUndefined();
  });

  it("issues exactly one KV list() call and zero reads", async () => {
    // The whole point of phase 2. An N+1 implementation passes every other test in
    // this file and quietly eats the 100k/day read quota in production.
    const list = vi.spyOn(env.PAGEVAULT, "list");
    const get = vi.spyOn(env.PAGEVAULT, "get");

    await SELF.fetch(`${HOST}/api/docs`, { headers: auth() });

    expect(list).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();

    list.mockRestore();
    get.mockRestore();
  });

  it("filters by tag", async () => {
    const res = await SELF.fetch(`${HOST}/api/docs?tag=type:report`, { headers: auth() });
    const { docs } = (await res.json()) as { docs: { title: string }[] };

    expect(docs.map((d) => d.title)).toEqual(["Beta"]);
  });

  it("filters by visibility", async () => {
    const res = await SELF.fetch(`${HOST}/api/docs?visibility=public`, { headers: auth() });
    const { docs } = (await res.json()) as { docs: { title: string }[] };

    expect(docs.map((d) => d.title)).toEqual(["Beta"]);
  });
});

describe("GET /api/docs/{id}", () => {
  it("returns the full DocMeta, including emails", async () => {
    const created = await publish(
      aDoc({ visibility: "restricted", emails: ["client@acme.com"], tags: ["client:acme"] }),
    );
    const { id } = (await created.json()) as { id: string };

    const res = await SELF.fetch(`${HOST}/api/docs/${id}`, { headers: auth() });
    const meta = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(meta).toMatchObject({
      id,
      title: "Q3 Review",
      visibility: "restricted",
      tags: ["client:acme"],
    });
    // The CLI's `share` command needs these; the endpoint is bearer-only anyway.
    expect(meta["emails"]).toEqual(expect.arrayContaining([OWNER, "client@acme.com"]));
  });

  it("404s on an unknown id", async () => {
    const res = await SELF.fetch(`${HOST}/api/docs/doesnotexist`, { headers: auth() });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
  });

  it("405s on an unsupported method", async () => {
    const res = await SELF.fetch(`${HOST}/api/docs/whatever`, {
      method: "DELETE",
      headers: auth(),
    });

    // DELETE lands in #3. Until then it must not silently 404 as if the route were
    // unknown — that would hide a real routing bug.
    expect(res.status).toBe(405);
  });
});
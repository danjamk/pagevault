import { SELF, createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeDesiredViewers, publishDocument } from "../src/documents.js";
import { accessEnabled } from "../src/env.js";
import worker from "../src/index.js";
import { mintSession } from "../src/session.js";
import { type Portal, putMembers, putPortal } from "../src/store.js";

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

describe("rung 1 (no Access) — publish defaults to a public link, not a dead /v/ one (#111)", () => {
  // On a no-Access deployment there is no login wall, so a members-only /v/ document is
  // un-openable — a plain publish must come back as a public /p/ link. `publishDocument` is
  // called directly with the Access vars blanked: SELF.fetch always runs against the configured
  // (rung-3) pool env, so the branch only reachable when Access is absent needs a crafted env.
  const noAccessEnv = { ...env, CF_TEAM_NAME: "", CF_ACCESS_AUD_DOCS: "" } as typeof env;

  it("accessEnabled is true only when BOTH team and audience are set", () => {
    expect(accessEnabled(env)).toBe(true);
    expect(accessEnabled(noAccessEnv)).toBe(false);
    expect(accessEnabled({ ...env, CF_TEAM_NAME: "" } as typeof env)).toBe(false);
    expect(accessEnabled({ ...env, CF_ACCESS_AUD_DOCS: "" } as typeof env)).toBe(false);
  });

  it("a plain publish auto-mints a public token", async () => {
    const { meta } = await publishDocument(noAccessEnv, { title: "Rung 1 Report", source: "<h1>hi</h1>" });
    expect(meta.publicToken).toBeTruthy();
  });

  it("an owner-only draft stays private — no public token", async () => {
    const { meta } = await publishDocument(noAccessEnv, {
      title: "Rung 1 Draft",
      source: "<h1>d</h1>",
      ownerOnly: true,
    });
    expect(meta.ownerOnly).toBe(true);
    expect(meta.publicToken).toBeUndefined();
  });

  it("with Access configured, a plain publish is NOT public by default", async () => {
    const { meta } = await publishDocument(env, { title: "Gated Report", source: "<h1>g</h1>" });
    expect(meta.publicToken).toBeUndefined();
  });
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

  it("🔴 403s a request from a sandboxed artifact (Origin: null), before auth is even checked", async () => {
    // An opaque origin sends `Origin: null`. The bearer check would already refuse this
    // — the artifact has no token — but this is the second wall, so an endpoint that
    // gets its auth wrong later is still unreachable from inside an artifact. ADR-007.
    const res = await SELF.fetch(`${HOST}/api/docs`, {
      headers: { ...auth(), Origin: "null" },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden_origin" });
  });

  it("403s a cross-origin browser caller", async () => {
    const res = await SELF.fetch(`${HOST}/api/docs`, {
      headers: { ...auth(), Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("allows a same-origin browser caller — this is the console (#5)", async () => {
    const res = await SELF.fetch(`${HOST}/api/docs`, {
      headers: { ...auth(), Origin: HOST },
    });
    expect(res.status).toBe(200);
  });

  it("allows a caller with no Origin at all — the CLI and the MCP server", async () => {
    // Non-browser callers attach an explicit bearer header and carry no ambient
    // authority, so there is nothing for an Origin check to defend against.
    expect((await SELF.fetch(`${HOST}/api/docs`, { headers: auth() })).status).toBe(200);
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

describe("🔴 /api — console session tokens (ADR-004)", () => {
  it("accepts a valid session token as a second bearer credential", async () => {
    const session = await mintSession(env, "owner@example.com");
    const res = await SELF.fetch(`${HOST}/api/docs`, {
      headers: { Authorization: `Bearer ${session}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects an expired session token", async () => {
    const stale = await mintSession(env, "owner@example.com", Math.floor(Date.now() / 1000) - 1000);
    const res = await SELF.fetch(`${HOST}/api/docs`, {
      headers: { Authorization: `Bearer ${stale}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/docs/{id} — returns a ready-to-open URL (powers `pagevault link`)", () => {
  const get = (id: string) => SELF.fetch(`${HOST}/api/docs/${id}`, { headers: auth() });

  it("includes `url`, and `publicUrl` for a public document", async () => {
    const pub = (await (await publish(aDoc({ title: "Linkable", filename: "linkable.html", public: true }))).json()) as { id: string };
    const got = (await (await get(pub.id)).json()) as { url: string; publicUrl?: string };
    expect(got.url).toMatch(/\/(v|pub)\//);
    expect(got.publicUrl).toMatch(/\/p\//);
  });

  it("a non-public document has `url` but no `publicUrl`", async () => {
    const priv = (await (await publish(aDoc({ title: "Private", filename: "private.html" }))).json()) as { id: string };
    const got = (await (await get(priv.id)).json()) as { url: string; publicUrl?: string };
    expect(got.url).toMatch(/\/v\//);
    expect(got.publicUrl).toBeUndefined();
  });
});

describe("filename identity — (portal, filename) is the update key, not the title (ADR-017, #111)", () => {
  type DocBody = { id: string; name: string; title: string; code?: string };
  const read = (r: Response) => r.json() as Promise<DocBody>;

  it("two files with the same title but different filenames are different documents", async () => {
    const a = await read(await publish(aDoc({ title: "Brain", filename: "readme.md", sourceKind: "markdown", html: "# Brain" })));
    const b = await read(await publish(aDoc({ title: "Brain", filename: "readme2.md", sourceKind: "markdown", html: "# Brain" })));
    expect(a.id).not.toBe(b.id);
    expect(a.name).toBe("readme.md");
    expect(b.name).toBe("readme2.md");
  });

  it("the same filename updates in place, even when the title changes", async () => {
    const first = await read(await publish(aDoc({ title: "Draft", filename: "report.html" })));
    const second = await read(await publish(aDoc({ title: "Final", filename: "report.html", confirm: true })));
    expect(second.id).toBe(first.id);
    expect(second.title).toBe("Final");
    expect(second.name).toBe("report.html");
  });

  it("a same-filename republish without confirm is a 409 carrying the existing id + name", async () => {
    await publish(aDoc({ title: "One", filename: "dup.html" }));
    const res = await publish(aDoc({ title: "Two", filename: "dup.html" }));
    expect(res.status).toBe(409);
    const body = await read(res);
    expect(body.code).toBe("already_exists");
    expect(body.name).toBe("dup.html");
    expect(typeof body.id).toBe("string");
  });

  it("strips any directory — identity is the basename", async () => {
    const a = await read(await publish(aDoc({ title: "X", filename: "/tmp/a/notes.md", sourceKind: "markdown", html: "# X" })));
    expect(a.name).toBe("notes.md");
  });

  it("with no filename, defaults deterministically from the title (the MCP-without-a-file case)", async () => {
    const a = await read(await publish(aDoc({ title: "Weekly Update" })));
    const b = await read(await publish(aDoc({ title: "Weekly Update", confirm: true })));
    expect(a.name).toBe("weekly-update.html");
    expect(b.id).toBe(a.id);
  });
});

describe("deterministic ids — republish is update-in-place, not a duplicate (#74, ADR-013)", () => {
  it("republishing the same title keeps one document with the same id", async () => {
    const first = await publish(aDoc({ title: "CDC on V2", html: "<h1>v1</h1>" }));
    expect(first.status).toBe(201); // created
    const id1 = ((await first.json()) as { id: string }).id;

    // Same title, no confirm → the overwrite guard fires. It used to be a racy findByTitle
    // list() (which forked a duplicate); it's now a direct getMeta on the deterministic id.
    const second = await publish(aDoc({ title: "CDC on V2", html: "<h1>v2</h1>" }));
    expect(second.status).toBe(409);

    // With confirm → overwrites in place: the SAME id (same URL), never a fork.
    const third = await publish(aDoc({ title: "CDC on V2", html: "<h1>v2</h1>", confirm: true }));
    expect(third.status).toBe(200); // updated in place
    expect(((await third.json()) as { id: string }).id).toBe(id1);
  });

  it("case- and whitespace-variant titles resolve to the same document", async () => {
    const a = await publish(aDoc({ title: "Roadmap Q4", html: "<h1>a</h1>" }));
    const idA = ((await a.json()) as { id: string }).id;
    // A cosmetic title variant collides to the same id, so the guard fires without confirm...
    expect((await publish(aDoc({ title: "  roadmap q4 ", html: "<h1>b</h1>" }))).status).toBe(409);
    // ...and confirming overwrites that same document.
    const c = await publish(aDoc({ title: "  roadmap q4 ", html: "<h1>b</h1>", confirm: true }));
    expect(((await c.json()) as { id: string }).id).toBe(idA);
  });
});

describe("GET /api/search — keyword search within a portal (#73)", () => {
  it("finds a document by a term, and requires a portal + query", async () => {
    await putPortal(env, portal("acme"));
    await publish(aDoc({ title: "CDC Migration Plan", portal: "acme" }));

    const res = await SELF.fetch(`${HOST}/api/search?portal=acme&q=migration`, { headers: auth() });
    expect(res.status).toBe(200);
    const { hits } = (await res.json()) as { hits: { doc: { title: string }; matched: string[] }[] };
    expect(hits.some((h) => h.doc.title === "CDC Migration Plan")).toBe(true);

    // Portal is required (cross-client search is how material leaks), and so is a query.
    expect((await SELF.fetch(`${HOST}/api/search?q=x`, { headers: auth() })).status).toBe(400);
    expect((await SELF.fetch(`${HOST}/api/search?portal=acme`, { headers: auth() })).status).toBe(400);
  });
});

describe("GET /api/access/seats — how close to the login-blocking ceiling (#44)", () => {
  it("401s without a bearer token — seat usage is owner-only", async () => {
    expect((await SELF.fetch(`${HOST}/api/access/seats`)).status).toBe(401);
  });

  it("405s on POST — it reads, it never evicts", async () => {
    const res = await SELF.fetch(`${HOST}/api/access/seats`, { method: "POST", headers: auth() });
    expect(res.status).toBe(405);
  });

  it("reports not_configured at Tier 0 rather than a seat count of zero", async () => {
    // The test env has no CF_ACCOUNT_ID/CF_API_TOKEN, which is exactly a Public deployment: no
    // Access, so no seats. Answering `0` here would render in the console as plenty of room.
    const res = await SELF.fetch(`${HOST}/api/access/seats`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "not_configured" });
    expect(body).not.toHaveProperty("used");
  });
});

describe("POST /api/access/sync — reconcile the viewer group (#85)", () => {
  const sync = (qs = "", headers = auth()) =>
    SELF.fetch(`${HOST}/api/access/sync${qs}`, { method: "POST", headers });

  it("401s without a bearer token — reconcile is owner-only", async () => {
    expect((await SELF.fetch(`${HOST}/api/access/sync`, { method: "POST" })).status).toBe(401);
  });

  it("405s on GET", async () => {
    expect((await SELF.fetch(`${HOST}/api/access/sync`, { headers: auth() })).status).toBe(405);
  });

  it("400 not_configured at Tier 0 — the test env has no Access group", async () => {
    // No CF ids in the test env, so there is no group to reconcile. It must say so, not pretend.
    const res = await sync();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "not_configured" });
  });

  it("still 400 not_configured with ?reap=true — reaping nothing is not a success", async () => {
    expect((await sync("?reap=true")).status).toBe(400);
  });

  it("502s when Access is configured but the Cloudflare API call fails", async () => {
    // Give the Worker CF ids so the reconcile actually calls Access, then make that call fail.
    // The desired-set read (KV) succeeds; the group read (fetch) does not → failed → 502.
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: "boom" }] }), { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const req = new Request(`${HOST}/api/access/sync`, { method: "POST", headers: { ...auth(), Origin: HOST } });
      const res = await worker.fetch(
        req,
        { ...env, CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a", CF_ACCESS_GROUP_ID: "g" },
        createExecutionContext(),
      );
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ code: "sync_failed" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("computeDesiredViewers — the set KV says should have Access (#85)", () => {
  it("unions portal members (every portal), per-document extraEmails, and the owner", async () => {
    await putPortal(env, portal("acme"));
    await putMembers(env, "acme", ["cto@acme.com", "cfo@acme.com"]);
    await putPortal(env, portal("beta"));
    await putMembers(env, "beta", ["lead@beta.com"]);
    // A per-document grant (extraEmails) — deliberately off the listing, so this exercises the
    // meta: read that the reconcile depends on to not miss doc-level shares.
    await publish(aDoc({ title: "Memo", portal: "acme", emails: ["board@acme.com"] }));

    const desired = new Set(await computeDesiredViewers(env));

    expect(desired).toContain("cto@acme.com");
    expect(desired).toContain("cfo@acme.com");
    expect(desired).toContain("lead@beta.com");
    expect(desired).toContain("board@acme.com"); // the document-level grant
    expect(desired).toContain("owner@example.com"); // OWNER_EMAIL, always
  });

  it("normalizes and dedups, and never yields an empty string", async () => {
    await putPortal(env, portal("acme"));
    await putMembers(env, "acme", ["cfo@acme.com"]);
    await publish(aDoc({ title: "Memo", portal: "acme", emails: ["  CFO@Acme.com "] }));

    const desired = await computeDesiredViewers(env);

    expect(desired.filter((e) => e === "cfo@acme.com")).toHaveLength(1); // case variant deduped
    expect(desired.every((e) => e.length > 0)).toBe(true);
  });
});

describe("PATCH /api/docs/{id} — the console visibility toggle (#5)", () => {
  async function createDoc(): Promise<string> {
    const res = await publish(aDoc());
    return ((await res.json()) as { id: string }).id;
  }

  const patch = (id: string, body: unknown, headers = auth()) =>
    SELF.fetch(`${HOST}/api/docs/${id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("toggles ownerOnly and reflects it on read", async () => {
    const id = await createDoc();

    const res = await patch(id, { ownerOnly: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ownerOnly: true });

    const after = await SELF.fetch(`${HOST}/api/docs/${id}`, { headers: auth() });
    expect(await after.json()).toMatchObject({ ownerOnly: true });
  });

  it("rejects a non-boolean ownerOnly with 400", async () => {
    const id = await createDoc();
    expect((await patch(id, { ownerOnly: "yes" })).status).toBe(400);
  });

  it("404s on a missing document", async () => {
    expect((await patch("nosuchdoc", { ownerOnly: true })).status).toBe(404);
  });

  it("a console session token can toggle visibility", async () => {
    const id = await createDoc();
    const session = await mintSession(env, "owner@example.com");
    expect((await patch(id, { ownerOnly: true }, { Authorization: `Bearer ${session}` })).status).toBe(200);
  });

  it("mints a public link with makePublic:true and records the pub: key", async () => {
    const id = await createDoc();
    const res = await patch(id, { makePublic: true });
    expect(res.status).toBe(200);

    const meta = (await res.json()) as { publicToken?: string };
    expect(meta.publicToken).toMatch(/^[a-z2-9]{22}$/);
    expect(await env.PAGEVAULT.get(`pub:${meta.publicToken}`)).toBe(id);
  });

  it("minting is idempotent — a second makePublic:true keeps the same token", async () => {
    const id = await createDoc();
    const first = (await (await patch(id, { makePublic: true })).json()) as { publicToken: string };
    const second = (await (await patch(id, { makePublic: true })).json()) as { publicToken: string };
    expect(second.publicToken).toBe(first.publicToken);
  });

  it("revoking with makePublic:false removes the link but keeps the document", async () => {
    const id = await createDoc();
    const minted = (await (await patch(id, { makePublic: true })).json()) as { publicToken: string };

    const res = await patch(id, { makePublic: false });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("publicToken");

    // The pub: key is gone, so the capability URL is dead...
    expect(await env.PAGEVAULT.get(`pub:${minted.publicToken}`)).toBeNull();
    // ...but the document itself survives — revoke is not delete.
    const after = await SELF.fetch(`${HOST}/api/docs/${id}`, { headers: auth() });
    expect(after.status).toBe(200);
    expect((await after.json()) as Record<string, unknown>).toMatchObject({ id });
  });

  it("mint and rotate hand back the /p/ URL so the CLI can print it verbatim (#73)", async () => {
    const id = await createDoc();
    const minted = (await (await patch(id, { makePublic: true })).json()) as { publicToken: string; publicUrl: string };
    expect(minted.publicUrl).toBe(`${HOST}/p/${minted.publicToken}`);
  });

  it("rotatePublic replaces the token with a fresh one — old link dead, new link live (#73)", async () => {
    const id = await createDoc();
    const first = (await (await patch(id, { makePublic: true })).json()) as { publicToken: string };

    const res = await patch(id, { rotatePublic: true });
    expect(res.status).toBe(200);
    const rolled = (await res.json()) as { publicToken: string; publicUrl: string };

    // A genuinely different token...
    expect(rolled.publicToken).not.toBe(first.publicToken);
    expect(rolled.publicUrl).toBe(`${HOST}/p/${rolled.publicToken}`);
    // ...the old capability URL is dead...
    expect(await env.PAGEVAULT.get(`pub:${first.publicToken}`)).toBeNull();
    // ...and the new one resolves to the same document.
    expect(await env.PAGEVAULT.get(`pub:${rolled.publicToken}`)).toBe(id);
  });

  it("rotatePublic on a doc that was never public just mints one", async () => {
    const id = await createDoc();
    const res = await patch(id, { rotatePublic: true });
    expect(res.status).toBe(200);
    const rolled = (await res.json()) as { publicToken: string };
    expect(rolled.publicToken).toMatch(/^[a-z2-9]{22}$/);
    expect(await env.PAGEVAULT.get(`pub:${rolled.publicToken}`)).toBe(id);
  });

  it("rejects a PATCH carrying neither ownerOnly nor makePublic", async () => {
    const id = await createDoc();
    expect((await patch(id, { nope: true })).status).toBe(400);
  });

  it("rejects a non-boolean makePublic with 400", async () => {
    const id = await createDoc();
    expect((await patch(id, { makePublic: "yes" })).status).toBe(400);
  });

  it("rejects a non-boolean rotatePublic with 400", async () => {
    const id = await createDoc();
    expect((await patch(id, { rotatePublic: "yes" })).status).toBe(400);
  });

  it("adds a per-document email grant, normalized, and reports the Access-group sync", async () => {
    const id = await createDoc();
    const res = await patch(id, { addEmails: ["CFO@Acme.com"] });
    expect(res.status).toBe(200);

    const meta = (await res.json()) as { extraEmails?: string[]; sync?: string };
    expect(meta.extraEmails).toEqual(["cfo@acme.com"]);
    // The test environment has no Access group configured, so the grant is recorded in KV
    // but the person is not admitted — and the caller is told, never silently (ADR-002).
    expect(meta.sync).toBe("not_configured");
  });

  it("removes a per-document grant and does NOT sync the removal (the seat is the reconciler's job)", async () => {
    const id = await createDoc();
    await patch(id, { addEmails: ["a@x.com", "b@x.com"] });

    const res = await patch(id, { removeEmails: ["a@x.com"] });
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta["extraEmails"]).toEqual(["b@x.com"]);
    expect(meta).not.toHaveProperty("sync"); // nothing was added, so nothing was synced
  });

  it("dropping the last grant clears extraEmails rather than leaving an empty array", async () => {
    const id = await createDoc();
    await patch(id, { addEmails: ["only@x.com"] });
    const res = await patch(id, { removeEmails: ["only@x.com"] });
    expect(await res.json()).not.toHaveProperty("extraEmails");
  });

  it("404s addEmails on a missing document", async () => {
    expect((await patch("nosuchdoc", { addEmails: ["x@y.com"] })).status).toBe(404);
  });

  it("rejects a non-email in addEmails with 400", async () => {
    const id = await createDoc();
    expect((await patch(id, { addEmails: ["not-an-email"] })).status).toBe(400);
  });
});

describe("PATCH/GET /api/portals/{slug} — member management (#5 console)", () => {
  const members = (body: unknown) => (body as { members: string[] }).members;

  const patchPortal = (slug: string, body: unknown) =>
    SELF.fetch(`${HOST}/api/portals/${slug}`, {
      method: "PATCH",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("GET returns the member list, not just a count", async () => {
    await putPortal(env, portal("realplus"));
    await putMembers(env, "realplus", ["cto@realplus.com"]);

    const body = await (await SELF.fetch(`${HOST}/api/portals/realplus`, { headers: auth() })).json();
    expect(members(body)).toEqual(["cto@realplus.com"]);
    expect((body as { memberCount: number }).memberCount).toBe(1);
  });

  it("adds a member via addMembers", async () => {
    await putPortal(env, portal("realplus"));
    const res = await patchPortal("realplus", { addMembers: ["newhire@realplus.com"] });
    expect(res.status).toBe(200);
    expect(members(await res.json())).toContain("newhire@realplus.com");
  });

  it("removes a member via removeMembers", async () => {
    await putPortal(env, portal("realplus"));
    await putMembers(env, "realplus", ["a@x.com", "b@x.com"]);

    const res = await patchPortal("realplus", { removeMembers: ["a@x.com"] });
    expect(members(await res.json())).toEqual(["b@x.com"]);
  });

  it("stores the member even when the group sync is unavailable (Tier 0)", async () => {
    // No CF ids in the test env -> not_configured, but KV stays authoritative (ADR-002).
    await putPortal(env, portal("realplus"));
    const body = await (await patchPortal("realplus", { addMembers: ["x@x.com"] })).json();
    expect((body as { sync?: string }).sync).toBe("not_configured");
    expect(members(body)).toContain("x@x.com");
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

  it("🔴 #27 publishing with emails admits them to Access — or reports that it cannot", async () => {
    // A grant that lands in KV while Access still blocks the person is the silent
    // half-success ADR-002 forbids. The test env has no Access group, so the publish must
    // report `not_configured`, not pretend the grant is live.
    const res = await publish(aDoc({ emails: ["board@acme.com"] }));
    const body = (await res.json()) as { extraEmails: string[]; sync?: string };

    expect(body.extraEmails).toContain("board@acme.com");
    expect(body.sync).toBe("not_configured");
  });

  it("publishing with no emails does not report a sync at all", async () => {
    const body = (await (await publish(aDoc())).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("sync");
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

  it("⭐ returns a /pub/ URL for a public portal, never a /v/ one", async () => {
    // Handing someone a /v/ link to a public page walks them into a Cloudflare Access login
    // wall and burns one of the 50 free seats — on a page that is public by design.
    await putPortal(env, portal("marketing", "public"));

    const res = await publish(aDoc({ portal: "marketing" }));
    const body = (await res.json()) as { url: string };

    expect(body.url).toMatch(/^https:\/\/share\.example\.com\/pub\/marketing\/[a-z2-9]{12}$/);
    expect(body.url).not.toContain("/v/");
  });

  it("returns a /v/ URL for a restricted portal", async () => {
    await putPortal(env, portal("realplus", "restricted"));

    const res = await publish(aDoc({ portal: "realplus" }));
    const body = (await res.json()) as { url: string };

    expect(body.url).toMatch(/^https:\/\/share\.example\.com\/v\/realplus\/[a-z2-9]{12}$/);
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
    return worker.fetch(request, { ...env, ...overrides }, createExecutionContext());
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

  it("surfaces sourceKind for markdown but omits it for html — the common case costs 0 bytes", async () => {
    await publish(aDoc({ title: "Notes", portal: "default", sourceKind: "markdown" }));

    const { docs } = (await (await SELF.fetch(`${HOST}/api/docs?portal=default`, { headers: auth() })).json()) as {
      docs: Record<string, unknown>[];
    };
    const md = docs.find((d) => d["title"] === "Notes");
    const html = docs.find((d) => d["title"] === "Alpha");

    expect(md?.["sourceKind"]).toBe("markdown");
    expect(html).not.toHaveProperty("sourceKind"); // omitted when html
  });

  it("surfaces a public link as a boolean flag, never the token itself", async () => {
    const { id } = (await (await publish(aDoc({ title: "Shared", portal: "default" }))).json()) as { id: string };
    await SELF.fetch(`${HOST}/api/docs/${id}`, {
      method: "PATCH",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ makePublic: true }),
    });

    const { docs } = (await (await SELF.fetch(`${HOST}/api/docs?portal=default`, { headers: auth() })).json()) as {
      docs: Record<string, unknown>[];
    };
    const shared = docs.find((d) => d["id"] === id);
    const plain = docs.find((d) => d["title"] === "Alpha");

    expect(shared?.["public"]).toBe(true);
    expect(shared).not.toHaveProperty("publicToken"); // the 22-char token stays off the listing
    expect(plain).not.toHaveProperty("public"); // omitted when there is no public link
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

  it("405s on an unsupported method — it must not silently 404 as if the route were unknown", async () => {
    // A 404 here would hide a real routing bug behind what looks like a missing document.
    const res = await SELF.fetch(`${HOST}/api/docs/whatever`, { method: "PUT", headers: auth() });
    expect(res.status).toBe(405);
  });

  it("deletes a document and everything pointing at it", async () => {
    const created = await publish(aDoc({ public: true }));
    const { id } = (await created.json()) as { id: string };

    expect((await SELF.fetch(`${HOST}/api/docs/${id}`, { method: "DELETE", headers: auth() })).status).toBe(200);
    expect(await env.PAGEVAULT.get(`doc:${id}`)).toBeNull();
    expect(await env.PAGEVAULT.get(`meta:${id}`)).toBeNull();
    expect(await env.PAGEVAULT.get(`idx:default:${id}`)).toBeNull();
  });
});

describe("GET /api/docs/{id}/raw — the export body (#35)", () => {
  async function newDoc(over: Record<string, unknown> = {}) {
    const res = await publish(aDoc(over));
    return ((await res.json()) as { id: string }).id;
  }

  it("returns the stored HTML bytes for an html document", async () => {
    const id = await newDoc({ html: "<!doctype html><h1>Q3</h1>" });
    const res = await SELF.fetch(`${HOST}/api/docs/${id}/raw`, { headers: auth() });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toBe("<!doctype html><h1>Q3</h1>");
  });

  it("returns the ORIGINAL markdown source, not the rendered HTML", async () => {
    // The whole point of extension-follows-sourceKind: a `.md` export must be the markdown the
    // author wrote, so it round-trips. getRawSource(id) beats getDoc(id) (the rendered HTML).
    const id = await newDoc({ title: "Notes", html: "# Heading\n\ntext", sourceKind: "markdown" });
    const res = await SELF.fetch(`${HOST}/api/docs/${id}/raw`, { headers: auth() });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toBe("# Heading\n\ntext");
    expect(body).not.toContain("<h1"); // definitely not the rendered form
  });

  it("404s on an unknown id", async () => {
    const res = await SELF.fetch(`${HOST}/api/docs/doesnotexist/raw`, { headers: auth() });
    expect(res.status).toBe(404);
  });

  it("🔴 401s without a bearer token — the body is not a new open door", async () => {
    const id = await newDoc();
    const res = await SELF.fetch(`${HOST}/api/docs/${id}/raw`);
    expect(res.status).toBe(401);
  });

  it("405s on a write method", async () => {
    const id = await newDoc();
    const res = await SELF.fetch(`${HOST}/api/docs/${id}/raw`, { method: "POST", headers: auth() });
    expect(res.status).toBe(405);
  });
});

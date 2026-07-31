import { SELF, env } from "cloudflare:test";
import { SignJWT, type JWK, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetJWKSCache } from "../src/auth.js";
import { NameTaken, editDocument, publishDocument } from "../src/documents.js";
import {
  type DocMeta,
  type Portal,
  type PortalKind,
  docId,
  getDoc,
  getMeta,
  getMovedTarget,
  getPublicTokenTarget,
  getRawSource,
  putDoc,
  putMembers,
  putPortal,
} from "../src/store.js";

/**
 * Editing a published document (#140) — and the one thing that makes it interesting: a
 * document's id hashes its filename (ADR-013's mechanism, ADR-017's key), so renaming MOVES it.
 *
 * Two operations wear one word here, and the tests are organized around the difference:
 * a display edit must never move a document, and a rename must move it without losing the
 * body, the public link, or the URL someone already has.
 */

const TOKEN = "test-token-do-not-use-in-production";
const HOST = "https://share.example.com";
const TEAM = "testteam";
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
const JWKS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const AUD_DOCS = "aud-docs-test";
const KID = "test-key-1";

const OWNER = "owner@example.com";
const CLIENT = "cto@realplus.com";
const STRANGER = "nobody@example.com";

const auth = { Authorization: `Bearer ${TOKEN}` };
const HTML = "<!doctype html><h1>Q3</h1>";

let privateKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKey = keys.privateKey;
  publicJwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: "RS256", use: "sig" };
});

beforeEach(async () => {
  resetJWKSCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === JWKS_URL) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetJWKSCache();
});

async function as(email: string): Promise<Record<string, string>> {
  const jwt = await new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUD_DOCS)
    .setSubject(`sub-${email}`)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { "Cf-Access-Jwt-Assertion": jwt };
}

const portal = (slug: string, kind: PortalKind = "restricted"): Portal => ({
  slug,
  name: slug,
  kind,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/** Publish through the service, so ids are the real deterministic ones. */
async function seed(over: Partial<Parameters<typeof publishDocument>[1]> = {}): Promise<DocMeta> {
  const { meta } = await publishDocument(env, {
    title: "Q3 Review",
    filename: "q3-reveiw.html", // the typo that started #140
    source: HTML,
    portal: "realplus",
    ...over,
  });
  return meta;
}

const patchDoc = (id: string, body: unknown) =>
  SELF.fetch(`${HOST}/api/docs/${id}`, {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  await putPortal(env, portal("realplus"));
  await putMembers(env, "realplus", [CLIENT]);
});

// ---------------------------------------------------------------------------

describe("display edits never move a document", () => {
  it("a new title keeps the id, the URL and the filename", async () => {
    const before = await seed();
    const result = await editDocument(env, before.id, { title: "Q3 Review (final)" });

    expect(result?.meta.id).toBe(before.id);
    expect(result?.movedFrom).toBeUndefined();
    expect(result?.meta.title).toBe("Q3 Review (final)");
    expect(result?.meta.name).toBe(before.name);
    expect(await getMeta(env, before.id)).toMatchObject({ title: "Q3 Review (final)" });
  });

  it("a CASE-only filename change moves nothing — identity is case-insensitive (ADR-017)", async () => {
    const before = await seed({ filename: "Report.html" });
    const result = await editDocument(env, before.id, { name: "report.html" });

    expect(result?.movedFrom).toBeUndefined();
    expect(result?.meta.id).toBe(before.id);
    // The display case still updates, even though identity did not.
    expect(result?.meta.name).toBe("report.html");
  });

  it("summary and tags round-trip, and empty values clear them", async () => {
    const before = await seed({ summary: "one line", tags: ["q3", "review"] });

    const set = await editDocument(env, before.id, { summary: "another line", tags: ["final"] });
    expect(set?.meta.summary).toBe("another line");
    expect(set?.meta.tags).toEqual(["final"]);

    const cleared = await editDocument(env, before.id, { summary: "", tags: [] });
    expect(cleared?.meta.summary).toBeUndefined();
    expect(cleared?.meta.tags).toBeUndefined();
  });

  it("a title edit on a PRE-ADR-017 document keeps its legacy random id", async () => {
    // A document published before identity was the filename has a random id and no stored
    // `name` (getMeta backfills one). Editing its title must not silently re-key it — the
    // rename path is only for an actual filename change.
    const legacy: DocMeta = {
      id: "legacyrandom1",
      portal: "realplus",
      title: "Old Report",
      sourceKind: "html",
      ownerOnly: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      bytes: HTML.length,
    } as unknown as DocMeta;
    await putDoc(env, legacy, HTML);

    const result = await editDocument(env, "legacyrandom1", { title: "Renamed Report" });
    expect(result?.meta.id).toBe("legacyrandom1");
    expect(result?.movedFrom).toBeUndefined();
  });
});

describe("renaming moves the document", () => {
  it("the id becomes the hash of the new filename, and the old keys are gone", async () => {
    const before = await seed();
    const result = await editDocument(env, before.id, { name: "q3-review.html" });

    expect(result?.movedFrom).toBe(before.id);
    expect(result?.meta.id).toBe(await docId("realplus", "q3-review.html"));
    expect(result?.meta.id).not.toBe(before.id);

    expect(await getMeta(env, result!.meta.id)).toMatchObject({ name: "q3-review.html" });
    expect(await getMeta(env, before.id)).toBeNull();
  });

  it("the body comes with it", async () => {
    const before = await seed();
    const result = await editDocument(env, before.id, { name: "q3-review.html" });

    expect(await getDoc(env, result!.meta.id)).toBe(HTML);
    expect(await getDoc(env, before.id)).toBeNull();
  });

  it("a markdown document keeps its ORIGINAL source, not just the rendered HTML", async () => {
    // `doc:` holds rendered HTML for markdown and `raw:` holds the authored .md (#46). A move
    // that carried only `doc:` would silently downgrade read_document and the raw download.
    const md = "# Q3\n\nSome *markdown*.\n";
    const before = await seed({ filename: "q3-reveiw.md", source: md, sourceKind: "markdown" });
    expect(await getRawSource(env, before.id)).toBe(md);

    const result = await editDocument(env, before.id, { name: "q3-review.md" });
    expect(await getRawSource(env, result!.meta.id)).toBe(md);
    expect(await getDoc(env, result!.meta.id)).toContain("<h1>");
    expect(await getRawSource(env, before.id)).toBeNull();
  });

  it("⭐ the public /p/ link survives — same token, repointed at the new id", async () => {
    const before = await seed({ makePublic: true });
    const token = before.publicToken!;
    expect(await getPublicTokenTarget(env, token)).toBe(before.id);

    const result = await editDocument(env, before.id, { name: "q3-review.html" });

    // The token is not a function of the id, so a rename never has to invalidate it. This is
    // what makes "the link you already gave the client keeps working" true.
    expect(result?.meta.publicToken).toBe(token);
    expect(await getPublicTokenTarget(env, token)).toBe(result!.meta.id);

    const res = await SELF.fetch(`${HOST}/p/${token}`);
    expect(res.status).toBe(200);
  });

  it("createdAt is preserved; updatedAt moves", async () => {
    const before = await seed();
    const result = await editDocument(env, before.id, { name: "q3-review.html" });
    expect(result!.meta.createdAt).toBe(before.createdAt);
    expect(result!.meta.updatedAt >= before.updatedAt).toBe(true);
  });

  it("leaves a forwarding address", async () => {
    const before = await seed();
    const result = await editDocument(env, before.id, { name: "q3-review.html" });
    expect(await getMovedTarget(env, before.id)).toBe(result!.meta.id);
  });
});

describe("a rename onto a taken filename is refused", () => {
  it("throws NameTaken and destroys nothing", async () => {
    const a = await seed({ filename: "a.html" });
    const b = await seed({ filename: "b.html" });

    await expect(editDocument(env, a.id, { name: "b.html" })).rejects.toBeInstanceOf(NameTaken);

    // Both documents are still exactly where they were. This is the whole reason there is no
    // `confirm` escape hatch on rename.
    expect(await getMeta(env, a.id)).toMatchObject({ name: "a.html" });
    expect(await getMeta(env, b.id)).toMatchObject({ name: "b.html" });
    expect(await getDoc(env, b.id)).toBe(HTML);
  });

  it("the API answers 409 name_taken, distinct from publish's already_exists", async () => {
    const a = await seed({ filename: "a.html" });
    await seed({ filename: "b.html" });

    const res = await patchDoc(a.id, { name: "b.html" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "name_taken" });
  });

  it("but the SAME filename in a DIFFERENT portal is not a clash", async () => {
    await putPortal(env, portal("acme"));
    const acme = await seed({ portal: "acme", filename: "shared-name.html" });
    const rp = await seed({ filename: "other.html" });

    const result = await editDocument(env, rp.id, { name: "shared-name.html" });
    expect(result?.meta.id).not.toBe(acme.id);
    expect(await getMeta(env, acme.id)).toBeTruthy();
  });
});

describe("the forwarding address, as a URL", () => {
  it("an already-shared /v/ link redirects to the renamed document", async () => {
    const before = await seed();
    const result = await editDocument(env, before.id, { name: "q3-review.html" });

    const res = await SELF.fetch(`${HOST}/v/realplus/${before.id}`, {
      headers: await as(CLIENT),
      redirect: "manual",
    });
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${HOST}/v/realplus/${result!.meta.id}`);
  });

  it("🔴 it does not forward someone who could not see the document anyway", async () => {
    // A forwarding address must never become a way to learn that a document exists. A stranger
    // gets the same bare 404 a miss has always been.
    const before = await seed();
    await editDocument(env, before.id, { name: "q3-review.html" });

    const res = await SELF.fetch(`${HOST}/v/realplus/${before.id}`, {
      headers: await as(STRANGER),
      redirect: "manual",
    });
    expect(res.status).toBe(404);
  });

  it("🔴 it cannot be followed through a portal that does not own the document", async () => {
    await putPortal(env, portal("marketing", "public"));
    const before = await seed();
    await editDocument(env, before.id, { name: "q3-review.html" });

    // The cross-portal leak, in tombstone form: a public portal's URL must not launder a
    // renamed private document.
    const res = await SELF.fetch(`${HOST}/pub/marketing/${before.id}`, { redirect: "manual" });
    expect(res.status).toBe(404);
  });

  it("a tombstone for a deleted document 404s rather than forwarding into nothing", async () => {
    const before = await seed();
    const result = await editDocument(env, before.id, { name: "q3-review.html" });

    await SELF.fetch(`${HOST}/api/docs/${result!.meta.id}`, { method: "DELETE", headers: auth });

    const res = await SELF.fetch(`${HOST}/v/realplus/${before.id}`, {
      headers: await as(CLIENT),
      redirect: "manual",
    });
    expect(res.status).toBe(404);
  });

  it("⭐ a document republished under the reclaimed filename SHADOWS the tombstone", async () => {
    // Self-healing, and the reason the route reads meta: before moved:. Rename away, then
    // publish something new under the old filename: it lands on the very id the tombstone is
    // keyed by, and must serve itself rather than redirect to the document that moved out.
    const before = await seed();
    await editDocument(env, before.id, { name: "q3-review.html" });
    expect(await getMovedTarget(env, before.id)).toBeTruthy();

    const fresh = await seed({ filename: "q3-reveiw.html", title: "A Different Report" });
    expect(fresh.id).toBe(before.id);

    const res = await SELF.fetch(`${HOST}/v/realplus/${before.id}`, {
      headers: await as(CLIENT),
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("A Different Report");
  });
});

describe("PATCH /api/docs/{id} — the edit half", () => {
  it("renames and hands back the new id, the new URL and movedFrom", async () => {
    const before = await seed();
    const res = await patchDoc(before.id, { name: "q3-review.html", title: "Q3 Review" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["movedFrom"]).toBe(before.id);
    expect(body["id"]).not.toBe(before.id);
    expect(body["url"]).toBe(`${HOST}/v/realplus/${body["id"] as string}`);
    expect(body["movedFromUrl"]).toBe(`${HOST}/v/realplus/${before.id}`);
  });

  it("refuses to combine edit fields with reach fields", async () => {
    const before = await seed();
    const res = await patchDoc(before.id, { name: "q3-review.html", makePublic: true });

    expect(res.status).toBe(400);
    // Renaming moves the id, so a combined request could not say which document the reach
    // change applied to. Two calls, unambiguous each.
    expect(await res.text()).toContain("cannot be combined");
  });

  it("still serves the reach fields on their own", async () => {
    const before = await seed();
    const res = await patchDoc(before.id, { makePublic: true });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toHaveProperty("publicUrl");
  });

  it("404s on a document that does not exist", async () => {
    const res = await patchDoc("nosuchdoc123", { title: "x" });
    expect(res.status).toBe(404);
  });

  it("refuses a blank filename — it is the identity", async () => {
    const before = await seed();
    const res = await patchDoc(before.id, { name: "   " });
    expect(res.status).toBe(400);
  });

  it("strips a directory from the filename — identity is the basename (ADR-017)", async () => {
    const before = await seed();
    const res = await patchDoc(before.id, { name: "reports/2026/q3-review.html" });
    expect(((await res.json()) as Record<string, unknown>)["name"]).toBe("q3-review.html");
  });

  it("needs a bearer, like every /api route", async () => {
    const before = await seed();
    const res = await SELF.fetch(`${HOST}/api/docs/${before.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("edit_document — the MCP tool", () => {
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const res = await SELF.fetch(`${HOST}/mcp`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    return await res.text();
  };

  it("renames and tells the model the canonical link changed", async () => {
    const before = await seed();
    const out = await mcp("edit_document", { id: before.id, filename: "q3-review.html" });

    expect(out).toContain("q3-review.html");
    expect(out).toContain("MOVED");
    expect(await getMeta(env, before.id)).toBeNull();
  });

  it("refuses a rename onto a taken filename, and points at publish --confirm instead", async () => {
    const a = await seed({ filename: "a.html" });
    await seed({ filename: "b.html" });

    const out = await mcp("edit_document", { id: a.id, filename: "b.html" });
    expect(out).toContain("already has a document named");
    expect(out).toContain("confirm: true");
    // Nothing moved.
    expect(await getMeta(env, a.id)).toMatchObject({ name: "a.html" });
  });

  it("rejects a call that edits nothing", async () => {
    const before = await seed();
    const out = await mcp("edit_document", { id: before.id });
    expect(out).toContain("Nothing to edit");
  });
});

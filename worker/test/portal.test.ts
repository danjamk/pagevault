import { SELF, env } from "cloudflare:test";
import { SignJWT, type JWK, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetJWKSCache } from "../src/auth.js";
import { type DocMeta, type Portal, type PortalKind, putDoc, putMembers, putPortal } from "../src/store.js";

/**
 * 🔴 The portal routes — where `canView()` stops being a unit test and becomes a URL.
 *
 * The cross-portal isolation tests in access.test.ts prove the *function* is right. These
 * prove the *routing* is: that no URL can hand the function the wrong portal and get a
 * "yes" out of it. That is a different bug, and it is invisible to a unit test.
 */

const TEAM = "testteam";
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
const JWKS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const AUD_DOCS = "aud-docs-test";
const KID = "test-key-1";
const HOST = "https://share.example.com";

const OWNER = "owner@example.com";
const REALPLUS_CTO = "cto@realplus.com";
const ACME_CFO = "cfo@acme.com";
const STRANGER = "nobody@example.com";

const HTML = "<h1>report</h1>";

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

const portal = (slug: string, kind: PortalKind, name = slug): Portal => ({
  slug,
  name,
  kind,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

async function seedDoc(slug: string, id: string, over: Partial<DocMeta> = {}): Promise<DocMeta> {
  const meta: DocMeta = {
    id,
    portal: slug,
    title: `${slug} report ${id}`,
    sourceKind: "html",
    ownerOnly: false,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    bytes: HTML.length,
    ...over,
  };
  await putDoc(env, meta, HTML);
  return meta;
}

/** Two clients. This is the shape the whole product exists to keep apart. */
async function seedTwoClients() {
  await putPortal(env, portal("realplus", "restricted", "RealPlus"));
  await putMembers(env, "realplus", [REALPLUS_CTO]);
  await seedDoc("realplus", "rp1111111111");

  await putPortal(env, portal("acme", "restricted", "Acme"));
  await putMembers(env, "acme", [ACME_CFO]);
  await seedDoc("acme", "ac1111111111");
}

// ---------------------------------------------------------------------------

describe("🔴 cross-portal isolation, as a URL", () => {
  beforeEach(seedTwoClients);

  it("a member of RealPlus gets 404 on Acme's portal index", async () => {
    const res = await SELF.fetch(`${HOST}/v/acme`, { headers: await as(REALPLUS_CTO) });
    expect(res.status).toBe(404);
  });

  it("a member of RealPlus gets 404 on Acme's document", async () => {
    const res = await SELF.fetch(`${HOST}/v/acme/ac1111111111`, { headers: await as(REALPLUS_CTO) });
    expect(res.status).toBe(404);
  });

  it("⭐ a document cannot be opened through a portal it does not belong to", async () => {
    // The leak that a unit test of canView() cannot see. Ask for RealPlus's private
    // document *through Acme's URL* and canView would be handed the WRONG portal.
    //
    // Worse, in the public case below, it would be handed a portal whose kind is
    // `public` — and hand over a private client document to the internet.
    const res = await SELF.fetch(`${HOST}/v/acme/rp1111111111`, { headers: await as(ACME_CFO) });
    expect(res.status).toBe(404);
  });

  it("⭐⭐ a private document cannot be laundered through a PUBLIC portal's URL", async () => {
    await putPortal(env, portal("marketing", "public", "Marketing"));

    // No auth at all. If the route trusted the URL's slug over the document's own portal,
    // this would return a client's private report to an anonymous visitor.
    const res = await SELF.fetch(`${HOST}/v/marketing/rp1111111111`);
    expect(res.status).toBe(404);
  });

  it("each member sees only their own portal", async () => {
    expect((await SELF.fetch(`${HOST}/v/realplus`, { headers: await as(REALPLUS_CTO) })).status).toBe(200);
    expect((await SELF.fetch(`${HOST}/v/acme`, { headers: await as(ACME_CFO) })).status).toBe(200);
  });

  it("the owner sees both", async () => {
    expect((await SELF.fetch(`${HOST}/v/realplus`, { headers: await as(OWNER) })).status).toBe(200);
    expect((await SELF.fetch(`${HOST}/v/acme`, { headers: await as(OWNER) })).status).toBe(200);
  });
});

describe("/v/{slug} — the portal index", () => {
  beforeEach(async () => {
    await putPortal(env, portal("realplus", "restricted", "RealPlus"));
    await putMembers(env, "realplus", [REALPLUS_CTO]);
    await seedDoc("realplus", "aaa111111111", { title: "Architecture Review", summary: "CDC on V2" });
    await seedDoc("realplus", "bbb111111111", { title: "Draft Roadmap", ownerOnly: true });
  });

  it("shows the client their documents", async () => {
    const res = await SELF.fetch(`${HOST}/v/realplus`, { headers: await as(REALPLUS_CTO) });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("Architecture Review");
    expect(body).toContain("CDC on V2");
    expect(body).toContain("RealPlus");
  });

  it("🔴 hides ownerOnly drafts from the client", async () => {
    const body = await (await SELF.fetch(`${HOST}/v/realplus`, { headers: await as(REALPLUS_CTO) })).text();
    expect(body).not.toContain("Draft Roadmap");
  });

  it("shows ownerOnly drafts to the owner, marked as drafts", async () => {
    const body = await (await SELF.fetch(`${HOST}/v/realplus`, { headers: await as(OWNER) })).text();
    expect(body).toContain("Draft Roadmap");
    expect(body).toContain("draft");
  });

  it("404s an authenticated stranger — not 403, which would confirm the portal exists", async () => {
    const res = await SELF.fetch(`${HOST}/v/realplus`, { headers: await as(STRANGER) });
    expect(res.status).toBe(404);
  });

  it("404s an unauthenticated visitor to a restricted portal", async () => {
    expect((await SELF.fetch(`${HOST}/v/realplus`)).status).toBe(404);
  });

  it("404s a portal that does not exist", async () => {
    expect((await SELF.fetch(`${HOST}/v/nosuchclient`, { headers: await as(OWNER) })).status).toBe(404);
  });

  it("⭐ renders with ZERO KV reads — the index runs off key metadata alone", async () => {
    // canViewPortal exists precisely so the index never needs extraEmails, which is the
    // only thing that would force a read per document. Fold it into canView and every
    // portal page load becomes an N+1.
    const get = vi.spyOn(env.PAGEVAULT, "get");
    await SELF.fetch(`${HOST}/v/realplus`, { headers: await as(REALPLUS_CTO) });

    // Two reads: the portal, and the member list. NOT one per document.
    expect(get.mock.calls.filter(([key]) => String(key).startsWith("meta:"))).toHaveLength(0);
    get.mockRestore();
  });

  it("is never indexed or cached — it names a client and lists their deliverables", async () => {
    const res = await SELF.fetch(`${HOST}/v/realplus`, { headers: await as(REALPLUS_CTO) });
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("does not put PageVault above the fold", async () => {
    // The client is looking at your work, not at a SaaS product.
    const body = await (await SELF.fetch(`${HOST}/v/realplus`, { headers: await as(REALPLUS_CTO) })).text();
    const aboveFold = body.slice(0, body.indexOf("<footer"));

    expect(aboveFold).not.toContain("PageVault");
    expect(body).toContain("<footer"); // a modest credit is fine
  });
});

describe("/v/{slug}/{id} — the document", () => {
  beforeEach(async () => {
    await putPortal(env, portal("realplus", "restricted", "RealPlus"));
    await putMembers(env, "realplus", [REALPLUS_CTO]);
    await seedDoc("realplus", "aaa111111111", { title: "Architecture Review" });
    await seedDoc("realplus", "ccc111111111", { title: "Board Memo", extraEmails: [ACME_CFO] });
    await seedDoc("realplus", "ddd111111111", { title: "Secret Draft", ownerOnly: true });
  });

  it("serves the shell to a member", async () => {
    const res = await SELF.fetch(`${HOST}/v/realplus/aaa111111111`, { headers: await as(REALPLUS_CTO) });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("<iframe");
    expect(body).toContain("Architecture Review");
    expect(body).not.toContain(HTML); // the artifact is framed, never inlined
  });

  it("links back to the collection", async () => {
    const body = await (await SELF.fetch(`${HOST}/v/realplus/aaa111111111`, { headers: await as(REALPLUS_CTO) })).text();
    expect(body).toContain('href="/v/realplus"');
    expect(body).toContain("RealPlus");
  });

  it("⭐ an extraEmails grant opens ONE document, and not the portal", async () => {
    // The Spec 01 simple path, surviving in the portal world: `--emails cfo@acme.com`
    // sends someone a report, not a client's whole index.
    const headers = await as(ACME_CFO);

    expect((await SELF.fetch(`${HOST}/v/realplus/ccc111111111`, { headers })).status).toBe(200);
    expect((await SELF.fetch(`${HOST}/v/realplus/aaa111111111`, { headers })).status).toBe(404);
    expect((await SELF.fetch(`${HOST}/v/realplus`, { headers })).status).toBe(404);
  });

  it("🔴 an ownerOnly draft stays invisible to a member", async () => {
    const res = await SELF.fetch(`${HOST}/v/realplus/ddd111111111`, { headers: await as(REALPLUS_CTO) });
    expect(res.status).toBe(404);
  });

  it("404s a stranger", async () => {
    const res = await SELF.fetch(`${HOST}/v/realplus/aaa111111111`, { headers: await as(STRANGER) });
    expect(res.status).toBe(404);
  });

  it("404s an unknown document", async () => {
    const res = await SELF.fetch(`${HOST}/v/realplus/nosuchdoc0000`, { headers: await as(OWNER) });
    expect(res.status).toBe(404);
  });
});

describe("/v/{slug} — public portals", () => {
  beforeEach(async () => {
    await putPortal(env, portal("marketing", "public", "Marketing"));
    await seedDoc("marketing", "pub111111111", { title: "How It Works" });
    await seedDoc("marketing", "pub222222222", { title: "Unfinished", ownerOnly: true });
  });

  it("serves the index with no authentication at all — and burns no Access seat", async () => {
    const res = await SELF.fetch(`${HOST}/v/marketing`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("How It Works");
  });

  it("serves a document with no authentication", async () => {
    expect((await SELF.fetch(`${HOST}/v/marketing/pub111111111`)).status).toBe(200);
  });

  it("🔴 still hides ownerOnly drafts from the entire internet", async () => {
    // ownerOnly is evaluated before the public-portal check. A draft parked in the public
    // marketing portal must not be world-readable.
    expect((await SELF.fetch(`${HOST}/v/marketing/pub222222222`)).status).toBe(404);
    expect(await (await SELF.fetch(`${HOST}/v/marketing`)).text()).not.toContain("Unfinished");
  });
});

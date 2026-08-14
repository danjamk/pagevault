import { SELF, env } from "cloudflare:test";
import { SignJWT, type JWK, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetJWKSCache } from "../src/auth.js";
import { handlePortalRoute, handlePublicPortalRoute } from "../src/portal.js";
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
    name: `${slug}-${id}.html`,
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

describe("rung 1 (no Access) — /v/ is honest, not 'misconfigured' (#111)", () => {
  // On a no-Access deployment /v/ has no login wall and no identity to establish. It must NOT
  // present the rung-3 "misconfigured" page (which would be a lie: nothing is broken). Call
  // handlePortalRoute directly with the Access vars blanked — SELF.fetch runs the configured env.
  const noAccessEnv = { ...env, CF_TEAM_NAME: "", CF_ACCESS_AUD_DOCS: "" } as typeof env;

  it("serves a plain 'public links only' page (404), not the 500 misconfigured page", async () => {
    const res = await handlePortalRoute(new Request(`${HOST}/v/anything`), noAccessEnv, "anything", null);
    const body = await res.text();
    expect(res.status).toBe(404);
    expect(body).not.toContain("misconfigured");
    expect(body).toContain("public links only");
  });

  it("🔴 speaks Public/Secured, never 'rung' — a document recipient reads this page (#149)", async () => {
    // ADR-018 made Public and Secured the user-facing tiers; rungs 1/2/3 are internal. This page
    // said "a rung-3 feature", "running at rung 1" and "choosing rung 3" to someone whose own copy
    // addresses them as a person who was sent a link and has never heard of PageVault.
    const body = await (
      await handlePortalRoute(new Request(`${HOST}/v/anything`), noAccessEnv, "anything", null)
    ).text();
    expect(body).not.toMatch(/\brung\b/i);
    expect(body).toContain("Secured");
    expect(body).toContain("Public");
  });

  it("still shows misconfigured (500) when Access IS configured but no JWT arrives", async () => {
    const res = await handlePortalRoute(new Request(`${HOST}/v/anything`), env, "anything", null);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("misconfigured");
  });

  it("leaks nothing about which portals exist", async () => {
    await putPortal(env, portal("realplus", "restricted", "RealPlus"));
    const res = await handlePortalRoute(new Request(`${HOST}/v/realplus`), noAccessEnv, "realplus", null);
    const body = await res.text();
    expect(body).not.toContain("realplus");
    expect(body).not.toContain("RealPlus");
  });

  it("a PUBLIC portal still redirects to /pub — public portals work without Access", async () => {
    await putPortal(env, portal("marketing", "public", "Marketing"));
    const res = await handlePortalRoute(new Request(`${HOST}/v/marketing`), noAccessEnv, "marketing", null);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/pub/marketing");
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

  it("tidied: filter shows for any non-empty portal, and the retired tan/amber palette is gone (#71)", async () => {
    // The client sees exactly one document here (the draft is hidden) — the old `> 2` gate hid
    // the filter for it. It now appears for any non-empty portal, which also eases testing.
    const body = await (await SELF.fetch(`${HOST}/v/realplus`, { headers: await as(REALPLUS_CTO) })).text();
    expect(body).toContain('class="filter"');
    expect(body).not.toContain("#fbf6ec"); // the retired tan background
    expect(body).not.toContain("854f0b"); // the retired amber draft chip
    expect(body).toContain("prefers-color-scheme: dark"); // dark mode, matching console/viewer
  });

  it("shows ownerOnly drafts to the owner, marked as drafts", async () => {
    const body = await (await SELF.fetch(`${HOST}/v/realplus`, { headers: await as(OWNER) })).text();
    expect(body).toContain("Draft Roadmap");
    expect(body).toContain("draft");
  });

  // ── The client-portal UX tweaks ─────────────────────────────────────────────
  describe("document-row chrome", () => {
    const PUB = "clubidx";
    beforeEach(async () => {
      await putPortal(env, portal(PUB, "public", "Club Index"));
      await seedDoc(PUB, "mdauaaaaaaaa", {
        sourceKind: "markdown",
        title: "Trail Notes",
        summary: "Three days on the loop.",
        tags: ["hiking", "gear"],
      });
      await seedDoc(PUB, "htmlbbbbbbbb", { sourceKind: "html", title: "Rack Build", summary: "A quiet 12U rack.", tags: ["homelab"] });
    });
    const index = async () => (await SELF.fetch(`${HOST}/pub/${PUB}`)).text();

    it("marks a markdown document with a different type icon than an HTML one", async () => {
      const body = await index();
      expect(body).toContain("dicon");
      expect(body).toContain("208 128"); // the Markdown-mark viewBox — the .md rows
      expect(body).toContain("M9 8l-4 4 4 4"); // the </> glyph — the HTML rows
    });

    it("renders the summary and a copy-link (share) control per row", async () => {
      const body = await index();
      expect(body).toContain("Three days on the loop.");
      expect(body).toContain('class="share"');
      expect(body).toContain(`data-share="/pub/${PUB}/mdauaaaaaaaa"`);
    });

    it("renders tags as filter buttons and wires the tag→search-box click", async () => {
      const body = await index();
      expect(body).toContain('<button type="button" class="tag" data-tag="hiking">hiking</button>');
      expect(body).toContain('data-tag="gear"');
      expect(body).toContain('closest(".tag")'); // clicking a tag drops it into the filter box
    });

    it("offers a refresh control to pick up out-of-band publishes (#92)", async () => {
      expect(await index()).toContain('id="refresh"');
    });
  });

  it("404s an authenticated stranger — not 403, which would confirm the portal exists", async () => {
    const res = await SELF.fetch(`${HOST}/v/realplus`, { headers: await as(STRANGER) });
    expect(res.status).toBe(404);
  });

  it("🔴 500s — not 404s — an unauthenticated request, because that means the DEPLOYMENT is broken", async () => {
    // Cloudflare Access sits in front of /v/*. An unauthenticated request cannot reach this
    // route unless something is wrong with the deployment: a bad CF_ACCESS_AUD, a bad
    // CF_TEAM_NAME, a Worker deployed before its Access app existed.
    //
    // The first real deploy hit exactly that (CF_TEAM_NAME carried the full
    // .cloudflareaccess.com domain, so the JWKS URL doubled it) and it presented as a bare
    // "Not found" — indistinguishable from "that portal doesn't exist". An afternoon lost to
    // a 404. Say what is actually wrong.
    const res = await SELF.fetch(`${HOST}/v/realplus`);
    const body = await res.text();

    expect(res.status).toBe(500);
    expect(body).toContain("misconfigured");
    expect(body).toContain("CF_TEAM_NAME");

    // But it must still not confirm whether this client's portal exists.
    expect(body).not.toContain("realplus");
    expect(body).not.toContain("RealPlus");
  });

  it("tells the OWNER a portal does not exist, and how to make one", async () => {
    // A stranger gets a bare 404 — a helpful message would confirm whether a client's portal
    // exists. The owner already knows everything there is to know, so leaving them to guess
    // buys no security and costs them an afternoon.
    const res = await SELF.fetch(`${HOST}/v/nosuchclient`, { headers: await as(OWNER) });
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).toContain("No such portal");
    expect(body).toContain("nosuchclient");
    expect(body).toContain("/api/portals"); // and how to fix it
  });

  it("🔴 gives a STRANGER the SAME 404 whether the portal exists or not", async () => {
    // The page is styled now (#148) rather than bare text — but the property that matters was
    // never the plainness, it is that the answer cannot be used to tell the two cases apart.
    // Asserting byte equality pins that directly: a future "let's make this error more helpful"
    // has to fail this test before it can turn the page back into an oracle.
    const missing = await SELF.fetch(`${HOST}/v/nosuchclient`, { headers: await as(STRANGER) });
    const real = await SELF.fetch(`${HOST}/v/realplus`, { headers: await as(STRANGER) });

    expect(missing.status).toBe(404);
    expect(real.status).toBe(404);

    const [missingBody, realBody] = [await missing.text(), await real.text()];
    expect(missingBody).toBe(realBody);
    expect(missingBody).not.toContain("nosuchclient");
    expect(missingBody).not.toContain("realplus");
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

  it("🔴 a denied document is byte-identical to one that never existed (#148)", async () => {
    // The case that prompted this: a client following a link to an owner-only draft. They are a
    // legitimate member of the portal, so they clear Access — and then must not be able to tell
    // "this draft is not for you" from "no such document". Same page, same bytes, same status.
    //
    // Found by dogfooding: it used to be an unstyled `Not found` string, which was secure and
    // read like a crash. Styling it is only safe while the two cases stay indistinguishable.
    const denied = await SELF.fetch(`${HOST}/v/realplus/ddd111111111`, { headers: await as(REALPLUS_CTO) });
    const absent = await SELF.fetch(`${HOST}/v/realplus/zzz999999999`, { headers: await as(REALPLUS_CTO) });

    expect(denied.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await denied.text()).toBe(await absent.text());
  });

  it("the unavailable page never names what it is hiding", async () => {
    const body = await (
      await SELF.fetch(`${HOST}/v/realplus/ddd111111111`, { headers: await as(REALPLUS_CTO) })
    ).text();
    expect(body).not.toContain("Secret Draft");
    expect(body).not.toContain("ddd111111111");
    // And it says the answer is deliberate, so a legitimate visitor does not conclude the
    // document was deleted when they simply were not given it.
    expect(body).toContain("same answer either way");
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

describe("🔴 /pub/{slug} — the public tier lives OFF the Access path", () => {
  // The bug this suite exists to prevent:
  //
  // Public portals were originally served from /v/*, which Cloudflare Access covers. Every
  // test passed — Miniflare has no Access, so an unauthenticated request reached the Worker
  // and canViewPortal correctly said yes. In production, an anonymous visitor to a public
  // marketing page would have hit an OTP login wall, and completing it would permanently
  // consume one of the 50 free Access seats. For a page that is public by design.
  //
  // The function was right. The deployment topology was wrong. No unit test can see that,
  // so these tests pin the ROUTE instead.

  beforeEach(async () => {
    await putPortal(env, portal("marketing", "public", "Marketing"));
    await seedDoc("marketing", "pub111111111", { title: "How It Works" });
    await seedDoc("marketing", "pub222222222", { title: "Unfinished", ownerOnly: true });
  });

  it("serves the index with no authentication at all — and burns no Access seat", async () => {
    const res = await SELF.fetch(`${HOST}/pub/marketing`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("How It Works");
  });

  it("serves a document with no authentication", async () => {
    const res = await SELF.fetch(`${HOST}/pub/marketing/pub111111111`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<iframe"); // still the shell, still sandboxed
  });

  it("⭐ links WITHIN a public portal point at /pub, never /v", async () => {
    // A /v/ link on a public page walks the reader into a login wall and burns a seat.
    // Every URL we emit has to get this right, so it comes from one helper.
    const body = await (await SELF.fetch(`${HOST}/pub/marketing`)).text();

    expect(body).toContain('href="/pub/marketing/pub111111111"');
    expect(body).not.toContain('href="/v/marketing');
  });

  it("redirects /v/{slug} to /pub/{slug} — one canonical URL", async () => {
    const res = await SELF.fetch(`${HOST}/v/marketing`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${HOST}/pub/marketing`);
  });

  it("🔴 still hides ownerOnly drafts from the entire internet", async () => {
    // ownerOnly is evaluated before the public-portal check. A draft parked in the public
    // marketing portal must not be world-readable.
    expect((await SELF.fetch(`${HOST}/pub/marketing/pub222222222`)).status).toBe(404);
    expect(await (await SELF.fetch(`${HOST}/pub/marketing`)).text()).not.toContain("Unfinished");
  });

  it("🔴 a RESTRICTED portal is a 404 through /pub — not a redirect", async () => {
    // A redirect would confirm that a client's portal exists. And if /pub ever served a
    // restricted portal, the whole Access gate would be bypassable by changing one path
    // segment.
    await putPortal(env, portal("realplus", "restricted", "RealPlus"));
    await putMembers(env, "realplus", [REALPLUS_CTO]);
    await seedDoc("realplus", "rp1111111111");

    expect((await SELF.fetch(`${HOST}/pub/realplus`)).status).toBe(404);
    expect((await SELF.fetch(`${HOST}/pub/realplus/rp1111111111`)).status).toBe(404);
  });

  it("🔴 a PRIVATE portal is a 404 through /pub", async () => {
    await putPortal(env, portal("scratch", "private", "Scratch"));
    await seedDoc("scratch", "sc1111111111");

    expect((await SELF.fetch(`${HOST}/pub/scratch`)).status).toBe(404);
    expect((await SELF.fetch(`${HOST}/pub/scratch/sc1111111111`)).status).toBe(404);
  });
});

/**
 * 🔴 Unfurl tags — what a link preview is allowed to say (#210).
 *
 * `X-Robots-Tag: noindex` binds search indexers. An unfurl bot is not one and ignores it, so
 * "we send noindex" is NOT the thing keeping a summary out of a Slack card — these assertions are.
 * A card renders to everyone in whatever channel the link is pasted into, including people who
 * cannot open the document, so the rule is per-surface and it is tested per-surface.
 */
describe("🔴 unfurl tags — OpenGraph exposure is per-surface (#210)", () => {
  beforeEach(async () => {
    await putPortal(env, { ...portal("marketing", "public", "Marketing"), description: "Things we published." });
    await seedDoc("marketing", "pub111111111", { title: "How It Works", summary: "The short version." });
    await seedDoc("marketing", "pub333333333", { title: "No Summary Here" });
    await seedDoc("marketing", "pub222222222", { title: "Unfinished Draft", ownerOnly: true });

    await putPortal(env, { ...portal("realplus", "restricted", "RealPlus"), description: "Client engagement." });
    await putMembers(env, "realplus", [REALPLUS_CTO]);
    await seedDoc("realplus", "rp1111111111", { title: "Architecture Review", summary: "CDC on V2" });
  });

  it("a /pub/ document emits title AND summary — both are already public on the index", async () => {
    const body = await (await SELF.fetch(`${HOST}/pub/marketing/pub111111111`)).text();
    expect(body).toContain('<meta property="og:title" content="How It Works">');
    expect(body).toContain('<meta property="og:description" content="The short version.">');
    expect(body).toContain('<meta name="twitter:description" content="The short version.">');
    expect(body).toContain('<meta name="twitter:card" content="summary">');
    // Not summary_large_image — there is no image, and claiming the large card renders an empty box.
    expect(body).not.toContain("summary_large_image");
  });

  it("og:url is the canonical /pub/ address, never the /v/ one that would burn a seat", async () => {
    const body = await (await SELF.fetch(`${HOST}/pub/marketing/pub111111111`)).text();
    expect(body).toContain(`<meta property="og:url" content="${HOST}/pub/marketing/pub111111111">`);
    expect(body).not.toContain('og:url" content="https://share.example.com/v/');
  });

  it("a document with no summary emits no description — no scraped fallback", async () => {
    // The artifact is hostile (prime directive 4). Its body has no business being lifted into a
    // card that renders on someone else's servers.
    const body = await (await SELF.fetch(`${HOST}/pub/marketing/pub333333333`)).text();
    expect(body).toContain('<meta property="og:title" content="No Summary Here">');
    expect(body).not.toContain("og:description");
    expect(body).not.toContain("twitter:description");
  });

  it("🔴 an Access-gated /v/ document emits NOTHING — not even a title", async () => {
    const body = await (
      await SELF.fetch(`${HOST}/v/realplus/rp1111111111`, { headers: await as(REALPLUS_CTO) })
    ).text();
    expect(body).toContain("Architecture Review"); // the page itself still renders
    expect(body).not.toContain("og:");
    expect(body).not.toContain("twitter:");
  });

  it("🔴 a restricted portal INDEX emits nothing — a client's document list is not a card", async () => {
    const body = await (await SELF.fetch(`${HOST}/v/realplus`, { headers: await as(REALPLUS_CTO) })).text();
    const head = body.slice(0, body.indexOf("</head>"));
    expect(head).not.toContain("og:");
    expect(head).not.toContain("twitter:");
    // The description still renders in the page body — the member looking at their own portal is
    // supposed to see it. What must not happen is it reaching a card an unfurl bot builds.
    expect(head).not.toContain("Client engagement.");
    expect(body).toContain("Client engagement.");
  });

  it("a public portal index unfurls its OWN name and description", async () => {
    const body = await (await SELF.fetch(`${HOST}/pub/marketing`)).text();
    expect(body).toContain('<meta property="og:title" content="Marketing">');
    expect(body).toContain('<meta property="og:description" content="Things we published.">');
    // An index, not a document.
    expect(body).toContain('<meta property="og:type" content="website">');
    expect(body).toContain(`<meta property="og:url" content="${HOST}/pub/marketing">`);
  });

  it("🔴 the index card is built from the PORTAL, never from a document — a draft cannot leak into it", async () => {
    // The owner sees ownerOnly rows on this page. A card assembled from the listing would hand a
    // draft's existence to everyone in whatever channel the portal link was pasted into.
    const body = await (await SELF.fetch(`${HOST}/pub/marketing`, { headers: await as(OWNER) })).text();
    const head = body.slice(0, body.indexOf("</head>"));
    expect(head).not.toContain("Unfinished Draft");
    expect(head).not.toContain("How It Works");
  });

  it("escapes a title that would otherwise break out of the content attribute", async () => {
    await seedDoc("marketing", "pub444444444", { title: 'Q3 "Review" <script>', summary: "Fine." });
    const body = await (await SELF.fetch(`${HOST}/pub/marketing/pub444444444`)).text();
    expect(body).toContain('content="Q3 &quot;Review&quot; &lt;script&gt;"');
    expect(body).not.toContain('content="Q3 "Review"');
  });
});

/**
 * 🔴 ADR-023, decision 6 — the portal index is a recorded event carrying no identity.
 *
 * analytics.test.ts proves `recordPortalView` cannot write a viewer, because it has no
 * parameter for one. These prove the ROUTES actually reach it, on both surfaces, and only
 * after the authorization gate — a different bug, and invisible to that unit test.
 */
describe("portal index views are recorded, and carry nobody", () => {
  interface Point {
    indexes?: string[];
    blobs?: string[];
  }

  /** An env whose ANALYTICS binding records rather than ships. */
  function watched(over: Partial<typeof env> = {}) {
    const points: Point[] = [];
    return {
      points,
      env: {
        ...env,
        ...over,
        ANALYTICS: { writeDataPoint: (p: Point) => void points.push(p) },
      } as unknown as typeof env,
    };
  }

  beforeEach(seedTwoClients);

  it("🔴 records no viewer on /v/, where Access established one", async () => {
    const { points, env: e } = watched();

    const res = await handlePortalRoute(
      new Request(`${HOST}/v/acme`, { headers: { ...(await as(ACME_CFO)), referer: "https://mail.google.com/mail/u/0/#inbox/x" } }),
      e,
      "acme",
      null,
    );

    expect(res.status).toBe(200);
    expect(points).toHaveLength(1);
    // id, title, surface, viewer, kind, referrer — the viewer slot is empty even though
    // ACME_CFO's address was verified two functions up the stack.
    expect(points[0]!.blobs).toEqual(["", "", "portal", "", "index", "mail.google.com"]);
    expect(points[0]!.indexes).toEqual(["acme"]);
  });

  it("records a public portal landing on /pub/, with no identity to begin with", async () => {
    await putPortal(env, portal("marketing", "public", "Marketing"));
    const { points, env: e } = watched();

    const res = await handlePublicPortalRoute(
      new Request(`${HOST}/pub/marketing`, { headers: { referer: "https://www.linkedin.com/posts/abc?x=1" } }),
      e,
      "marketing",
      null,
    );

    expect(res.status).toBe(200);
    expect(points[0]!.blobs).toEqual(["", "", "public", "", "index", "www.linkedin.com"]);
  });

  it("🔴 records nothing when the index was refused — a page not served is not a view", async () => {
    const { points, env: e } = watched();

    const res = await handlePortalRoute(new Request(`${HOST}/v/acme`, { headers: await as(REALPLUS_CTO) }), e, "acme", null);

    expect(res.status).toBe(404);
    expect(points).toHaveLength(0);
  });

  it("records a direct landing with an empty referrer, not a missing row", async () => {
    const { points, env: e } = watched();

    await handlePortalRoute(new Request(`${HOST}/v/acme`, { headers: await as(ACME_CFO) }), e, "acme", null);

    expect(points).toHaveLength(1);
    expect(points[0]!.blobs?.[5]).toBe("");
  });

  it("a document view through the same route is kind=document, and keeps its viewer", async () => {
    const { points, env: e } = watched();

    await handlePortalRoute(
      new Request(`${HOST}/v/acme/ac1111111111`, { headers: { ...(await as(ACME_CFO)), referer: "https://t.co/xyz" } }),
      e,
      "acme",
      "ac1111111111",
    );

    expect(points).toHaveLength(1);
    expect(points[0]!.blobs).toEqual(["ac1111111111", "acme report ac1111111111", "portal", ACME_CFO, "document", "t.co"]);
  });
});

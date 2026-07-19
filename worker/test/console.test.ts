import { SELF } from "cloudflare:test";
import { type JWK, SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetJWKSCache } from "../src/auth.js";

/**
 * 🔴 The owner console at /admin (ADR-004). Two walls (Access + owner check), a session
 * token that is NOT the API token, and a strict nonced CSP distinct from the artifact
 * sandbox. Driven through real Access JWTs, the admin audience, and a stubbed JWKS — the
 * same harness portal.test.ts uses for /v.
 */

const TEAM = "testteam";
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
const JWKS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const AUD_ADMIN = "aud-admin-test";
const KID = "test-key-1";
const HOST = "https://share.example.com";
const OWNER = "owner@example.com";
const API_TOKEN = "test-token-do-not-use-in-production";

let privateKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKey = keys.privateKey;
  publicJwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: "RS256", use: "sig" };
});

beforeEach(() => {
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

async function adminJwt(email: string): Promise<Record<string, string>> {
  const jwt = await new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUD_ADMIN)
    .setSubject(`sub-${email}`)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { "Cf-Access-Jwt-Assertion": jwt };
}

const getAdmin = (headers: Record<string, string> = {}) => SELF.fetch(`${HOST}/admin`, { headers });

describe("🔴 /admin — owner only", () => {
  it("403s an unauthenticated request", async () => {
    expect((await getAdmin()).status).toBe(403);
  });

  it("403s a valid Access JWT for a non-owner", async () => {
    // The admin Access app already excludes non-owners; this is the Worker's second wall.
    expect((await getAdmin(await adminJwt("intruder@example.com"))).status).toBe(403);
  });

  it("renders the console for the owner", async () => {
    const res = await getAdmin(await adminJwt(OWNER));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("PageVault console");
  });
});

describe("🔴 /admin — session token + strict CSP (ADR-004)", () => {
  it("carries a strict nonced CSP distinct from the artifact sandbox", async () => {
    const csp = (await getAdmin(await adminJwt(OWNER))).headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'"); // console-specific — it fetches /api
    expect(csp).toMatch(/script-src 'nonce-/);
    expect(csp).not.toContain("unsafe-inline");
  });

  it("🔴 carries no inline style attributes — the nonced CSP drops them, so any would break layout", async () => {
    // style-src 'nonce-…' without 'unsafe-inline' blocks inline style="" attributes outright.
    // An inline style is therefore silently dropped in the browser (not in a no-CSP test render),
    // which is exactly how a hidden sprite <svg> once fell back to 300x150 and shoved the page down.
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).not.toMatch(/\sstyle=/i);
  });

  it("embeds a session token, never the long-lived API token", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).not.toContain(API_TOKEN); // ADR-004: the API token must never reach the DOM
    expect(body).toContain("Bearer");
  });

  it("the embedded session token actually authenticates against /api", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    const token = /const T = "([^"]+)"/.exec(body)?.[1];
    expect(token).toBeTruthy();

    const api = await SELF.fetch(`${HOST}/api/portals`, { headers: { Authorization: `Bearer ${token}` } });
    expect(api.status).toBe(200);
  });
});

describe("create-portal control (#43)", () => {
  it("renders the New portal button and a dialog with each kind explained at the point of choice", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).toContain('id="new-portal"');
    expect(body).toContain('id="dlg-portal"');
    // All three kinds are selectable...
    expect(body).toContain('value="private"');
    expect(body).toContain('value="restricted"');
    expect(body).toContain('value="public"');
    // ...and the load-bearing distinction is stated inline: restricted is the only kind whose
    // member list canView() actually reads. Picking the wrong kind is a confidentiality decision.
    expect(body).toMatch(/only kind whose members list actually grants access/i);
    // It posts to the existing endpoint — no new server surface.
    expect(body).toContain("/api/portals");
  });

  it("🔴 keeps behavior in the nonced script — no inline event handlers", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).not.toMatch(/on(click|submit|change|input|load)=/i);
  });

  it("a portal created through the console session token lands and lists", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    const token = /const T = "([^"]+)"/.exec(body)?.[1];
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const created = await SELF.fetch(`${HOST}/api/portals`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ slug: "acme-corp", name: "Acme Corp", kind: "restricted" }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ slug: "acme-corp", kind: "restricted" });

    const { portals } = (await (await SELF.fetch(`${HOST}/api/portals`, { headers: auth })).json()) as {
      portals: Array<{ slug: string }>;
    };
    expect(portals.some((p) => p.slug === "acme-corp")).toBe(true);
  });
});

describe("edit-portal control (#70)", () => {
  it("renders an Edit affordance and a name/description dialog, PATCHing the portal", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).toContain('data-act="edit-portal"');
    expect(body).toContain('id="dlg-edit"');
    expect(body).toContain('id="form-edit"');
    expect(body).toContain('id="ep-name"');
    expect(body).toContain('id="ep-desc"');
    expect(body).toContain("/api/portals/"); // PATCHes the portal endpoint
  });

  it("🔴 offers name + description only — no kind selector, and says why", async () => {
    // Changing a portal's kind flips its access floor; that must not ride along in a settings edit.
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    // The edit dialog carries no radio inputs (only the create dialog does).
    const editDialog = body.slice(body.indexOf('id="dlg-edit"'), body.indexOf('id="dlg-upload"'));
    expect(editDialog).not.toMatch(/type="radio"/i);
    expect(editDialog).toContain("editable here");
  });
});

describe("browser upload control (#6)", () => {
  it("renders the New document button and an upload dialog with file/portal/emails/tags", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).toContain('id="new-doc"');
    expect(body).toContain('id="dlg-upload"');
    expect(body).toContain('type="file"');
    expect(body).toContain('id="up-portal"');
    expect(body).toContain('id="up-emails"');
    expect(body).toContain('id="up-tags"');
    // Accepts markdown as well as HTML, and detects the kind from the extension (#46).
    expect(body).toMatch(/accept="[^"]*\.md/);
    expect(body).toContain("uploadKind");
  });

  it("🔴 carries both warnings in the UI, not just the docs", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    // A public link is a capability URL, not privacy (static markup).
    expect(body).toMatch(/capability URL, not privacy/i);
    // Relative src/href will 404 for the recipient (scanner + message in the script).
    expect(body).toContain("relativeRefs");
    expect(body).toContain("will 404 for the recipient");
  });

  it("publishes an uploaded document through the console session token", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    const token = /const T = "([^"]+)"/.exec(body)?.[1];
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    // The dialog's portal select is populated from live portals, so publishing targets one that
    // exists — create it first (as the console would, via #43).
    await SELF.fetch(`${HOST}/api/portals`, { method: "POST", headers: auth, body: JSON.stringify({ slug: "clientx", kind: "private" }) });
    const res = await SELF.fetch(`${HOST}/api/docs`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: "Uploaded Report", html: "<!doctype html><h1>hi</h1>", portal: "clientx", sourceKind: "html" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ portal: "clientx", url: expect.stringContaining("/") });
  });

  it("an uploaded markdown file publishes as markdown, not html (#46)", async () => {
    const page = await (await getAdmin(await adminJwt(OWNER))).text();
    const token = /const T = "([^"]+)"/.exec(page)?.[1];
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    await SELF.fetch(`${HOST}/api/portals`, { method: "POST", headers: auth, body: JSON.stringify({ slug: "mdclient", kind: "private" }) });
    const res = await SELF.fetch(`${HOST}/api/docs`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: "MD Report", html: "# Heading", portal: "mdclient", sourceKind: "markdown" }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const meta = (await (await SELF.fetch(`${HOST}/api/docs/${id}`, { headers: auth })).json()) as { sourceKind: string };
    expect(meta.sourceKind).toBe("markdown");
  });
});

describe("link-first sharing + public-by-default (#65 / ADR-011)", () => {
  // The panel is built client-side on expand, so these assert the embedded script's copy/logic.
  it("the panel leads with a share link, a contextual reach selector, and the honesty note", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).toContain("Share link"); // the always-present hero link
    expect(body).toContain("Anyone with the link"); // default reach
    expect(body).toContain("A link is a key"); // forwardable-link honesty note
    expect(body).toContain("opens for no one yet"); // explicit draft dormancy
  });

  it("drops the old generate-a-link framing", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).not.toContain("Make public");
    expect(body).not.toContain("Public link</span>"); // the old "Public link: None" row
  });

  it("🔴 upload defaults to public — a keep-internal opt-out, not an opt-in", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).toContain('id="up-internal"');
    expect(body).not.toContain('id="up-public"');
    // Public is the default: body.public is set UNLESS internal is checked.
    expect(body).toContain("upInternal.checked");
    expect(body).toContain("Publish &amp; copy link");
  });
});

describe("shareable portal link on the portal card", () => {
  // The portal card is built client-side, so this asserts the embedded script's logic. The
  // link points at the browsable index route, which already exists and is gated by
  // canViewPortal: public -> /pub/{slug}, restricted -> /v/{slug}, private -> none (it opens
  // only for the owner, so there is nothing to hand out).
  it("copies the portal's index URL for public and team portals, but not private", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).toContain("Copy portal link");
    expect(body).toContain("function portalUrl");
    expect(body).toContain('"/pub/"'); // public portal index
    expect(body).toContain('"/v/"'); // restricted portal index
    // Private returns null — the button is only rendered when portalUrl is non-null.
    expect(body).toMatch(/return null;\s*\n\s*}/);
  });
});

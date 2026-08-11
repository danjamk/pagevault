import { SELF } from "cloudflare:test";
import { type JWK, SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetJWKSCache } from "../src/auth.js";
import {
  MAX_NAME_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_TAG_CHARS,
  MAX_TAGS,
  MAX_TITLE_CHARS,
} from "../src/documents.js";

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

  it("ships the pin controls, and reorders through the whole-order PATCH (#142)", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();

    // The four actions the row can dispatch, and the sprite symbol they draw from. A missing
    // symbol renders an empty <svg> at its intrinsic 300x150 and shoves the row apart — the same
    // failure the inline-style test above exists for, one cause over.
    for (const act of ["pin", "unpin", "pinup", "pindown"]) {
      expect(body).toContain(`data-act="${act}"`);
    }
    expect(body).toContain('id="i-pin"');

    // 🔴 The order is sent whole. If this ever becomes a move/swap endpoint, the API grows four
    // verbs that each need their own concurrency story — and `normalizePinned` stops being the one
    // place the cap and the de-duplication live.
    expect(body).toMatch(/JSON\.stringify\(\{\s*pinned:\s*next\s*\}\)/);

    // The console is served BY the Worker, so a version mismatch should be impossible — but a
    // stale cached page against a rolled-back deployment is not, and a silent no-op reads as a
    // broken button.
    expect(body).toContain("has not been upgraded for pinning");
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

describe("console — UI tweaks", () => {
  it("ships a refresh path that re-fetches while keeping the selected portal (#92)", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).toContain('id="i-refresh"'); // the refresh glyph
    expect(body).toContain("async function refresh("); // the re-fetch that preserves `selected`
    expect(body).toContain('a === "refresh"'); // wired into the action dispatch
  });

  it("keeps the selected portal in the URL fragment, and restores it on boot (#92)", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    // replaceState, not an assignment to location.hash — the latter pushes a history entry per
    // portal click, so Back would walk portals instead of leaving the console.
    expect(body).toContain("history.replaceState");
    expect(body).not.toContain("location.hash =");
    expect(body).toContain("function hashPortal(");
    // Boot precedence: the fragment is consulted ahead of the default-portal fallback.
    expect(body).toContain("const fromHash = hashPortal();");
    expect(body).toContain("(fromHash && PORTALS[fromHash]) ? fromHash");
  });

  it("refreshes the document list on tab-back, bounded so it cannot become a poll (#92)", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).toContain("visibilitychange");
    // The cheap path — one list() for the selected portal, not one per portal.
    expect(body).toContain("async function reselect(");
    // Both guards. The house rule is that the console must not poll the KV list quota, and
    // "refresh on every focus" is a poll wearing a disguise.
    expect(body).toContain("const STALE_MS = 30000");
    expect(body).toContain("const AUTO_MAX = 60");
    // And it says when the list was actually read, rather than letting the operator assume.
    expect(body).toContain("function freshLabel(");
  });

  it("shows Access seat usage, labelled as the free plan's ceiling (#44)", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).toContain('id="seats"');
    expect(body).toContain("/api/access/seats");
    // Hidden until it has a real answer: a seat readout that shows 0 because it could not ask
    // reads as plenty of room at exactly the moment logins are being blocked.
    expect(body).toContain('s.status !== "ok"');
    expect(body).toContain("limit reached, new logins blocked");
    // The ceiling is an assumption (no billing scope in the Worker), so it names the plan.
    expect(body).toContain("free Zero Trust allowance");
    // Fetched independently of load() so a Cloudflare round-trip never delays the document list.
    expect(body).toContain("loadSeats();");
  });

  it("offers an open-portal link and localizes the deploy timestamp", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).toContain('id="i-open"'); // the open glyph
    expect(body).toContain('title="Open the portal page"'); // the portal header Open control
    expect(body).toContain("toLocaleString"); // UTC baked at deploy → shown in the operator's zone
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

describe("edit-document control (#140)", () => {
  it("shows the filename — the identity field the console never displayed", async () => {
    // The bug that started #140: the operator typo'd a filename at upload and could neither
    // see it nor fix it here. A rename affordance is useless if the field stays invisible.
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).toContain("Filename");
    expect(body).toContain('data-act="edit-doc"');
  });

  it("renders a dialog covering filename, title, summary and tags", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).toContain('id="dlg-doc"');
    expect(body).toContain('id="form-doc"');
    for (const field of ["ed-name", "ed-title", "ed-summary", "ed-tags"]) {
      expect(body).toContain(`id="${field}"`);
    }
  });

  it("🔴 warns that renaming moves the URL, and carries no reach controls", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    const dialog = body.slice(body.indexOf('id="dlg-doc"'), body.indexOf('id="dlg-upload"'));
    // Renaming changes the canonical link. Saying so is the difference between a rename the
    // operator understands and a link that mysteriously stopped being canonical (ADR-020).
    expect(dialog).toContain("new URL");
    expect(dialog).toContain("redirects");
    // Reach is the panel's job (ADR-011) — burying it in a modal would undo that.
    expect(dialog).not.toMatch(/type="radio"|type="email"/i);
  });

  it("explains renaming and tags in popovers, opened without an inline handler", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    const dialog = body.slice(body.indexOf('id="dlg-doc"'), body.indexOf('id="dlg-upload"'));

    // Native popover: the toggle is an ATTRIBUTE, so it survives the nonced CSP with no script.
    expect(dialog).toContain('popovertarget="pop-name"');
    expect(dialog).toContain('popovertarget="pop-tags"');
    expect(dialog).toContain('id="pop-name" popover');
    expect(dialog).toContain('id="pop-tags" popover');

    // The filename popover has to carry the consequences, not just the definition.
    const namePop = dialog.slice(dialog.indexOf('id="pop-name"'), dialog.indexOf('id="ed-title"'));
    expect(namePop).toContain("update key");
    expect(namePop).toContain("redirects");
    expect(namePop).toContain("/p/");
    expect(namePop).toMatch(/case/i); // Report.md and report.md are one document

    // Tags were the "not very clear" one — examples, not just a definition.
    const tagPop = dialog.slice(dialog.indexOf('id="pop-tags"'));
    expect(tagPop).toContain("type:report");
    expect(tagPop).toContain("--tag");
    expect(tagPop).toMatch(/never (appear|sees)|not the client/i);
  });

  it("🔴 states the real limits — taken from the server constants, not retyped", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    // A hint that says "max 300" while the server enforces something else gets believed. These
    // assertions fail if documents.ts changes a limit and the console is not rebuilt from it.
    expect(body).toContain(`maxlength="${MAX_TITLE_CHARS}"`);
    expect(body).toContain(`maxlength="${MAX_SUMMARY_CHARS}"`);
    expect(body).toContain(`maxlength="${MAX_NAME_CHARS}"`);
    expect(body).toContain(`Up to ${MAX_TAGS} tags`);
    expect(body).toContain(`${MAX_TAG_CHARS} characters`);
    expect(body).toContain(`tags: ${MAX_TAGS}`); // the client-side LIMITS object
  });

  it("turns the shared metadata budget into an instruction, not just a rejection", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    // Title, summary, tags and filename share one 1024-byte KV index budget, so each can be
    // under its own limit while the combination is not. "Too long to index" alone leaves the
    // operator poking at fields.
    expect(body).toContain("metadata_too_large");
    expect(body).toContain("share one");
    expect(body).toContain("Shorten the summary");
    // And the API error code has to reach the handler at all.
    expect(body).toContain("err.code = code");
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
    // The label is short because it sits in a one-line action cluster beside Open and Edit; the
    // button's title attribute carries the longer explanation.
    expect(body).toContain("Copy link");
    expect(body).toContain("Anyone with this link can browse this portal");
    expect(body).toContain("function portalUrl");
    expect(body).toContain('"/pub/"'); // public portal index
    expect(body).toContain('"/v/"'); // restricted portal index
    // Private returns null — the button is only rendered when portalUrl is non-null.
    expect(body).toMatch(/return null;\s*\n\s*}/);
  });
});

describe("traffic panel (#164)", () => {
  // The panel is built client-side, so these assert the embedded script's copy and its refusals.
  // What matters here is not the chart — it is that the page never claims to be live, and never
  // offers a control it cannot honour.
  it("is reachable from the sidebar and reads the stored summary, not Analytics Engine", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).toContain('id="nav-traffic"');
    expect(body).toContain("/api/views/summary");
    // This panel IS the dashboard: Analytics Engine has none, and is absent from the GraphQL API.
    expect(body).toContain("how much was read");
  });

  it("🔴 shows sync STATUS and a command, never a sync button", async () => {
    // The Worker cannot read Analytics Engine at all (ADR-019 decision 1), so a button here would
    // have nothing to call. The honest surface is the command that works.
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).toContain("pagevault sync-views");
    expect(body).toContain("the Worker cannot read");
    expect(body).not.toContain("Sync now");
  });

  it("🔴 never offers to take a Cloudflare token", async () => {
    // That would put an account-scoped credential in a web page, where any console XSS inherits
    // it — ADR-002's blast-radius argument relocated one hop. Considered and refused.
    //
    // Asserted on the FIELD, not on wording: the inline script ships its own comments to the
    // browser, so a phrase match here passes or fails on prose that explains the refusal rather
    // than on whether the refusal holds. This first cut matched its own comment.
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(body).not.toMatch(/<input[^>]*(cf|cloudflare)[^>]*>/i);
  });

  it("says the numbers are not live, and when they were taken", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).toContain("Not live.");
    expect(body).toContain("As of ");
  });

  it("never-synced and not-recording are their own states, not an empty chart", async () => {
    // An empty panel reads as "nobody visited" — the exact lie the zero-versus-null rule stops.
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).toContain("No history captured yet");
    expect(body).toContain("not recording views");
  });

  it("states that referrers ignore the window", async () => {
    // They carry no date (ADR-023 §5), so a windowed heading over them would be a wrong number.
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).toContain("referrers carry no date");
  });
});

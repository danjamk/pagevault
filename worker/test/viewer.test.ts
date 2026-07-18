import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { mintCapability, originAllowed, resetCapabilityKeyCache, verifyCapability } from "../src/capability.js";
import { type DocMeta, putDoc, putPublicToken } from "../src/store.js";
import { IFRAME_SANDBOX, docCsp, handleRender, renderShell } from "../src/viewer.js";

const HOST = "https://share.example.com";
const HTML = "<!doctype html><h1>Q3</h1><script>console.log(1)</script>";

const doc = (over: Partial<DocMeta> = {}): DocMeta => ({
  id: "k3x9mq2vb7pd",
  portal: "default",
  title: "Q3 Review",
  sourceKind: "html",
  ownerOnly: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  bytes: HTML.length,
  ...over,
});

async function publishPublic(over: Partial<DocMeta> = {}): Promise<DocMeta> {
  const meta = doc({ publicToken: "pubtoken2222222222222", ...over });
  await putDoc(env, meta, HTML);
  if (meta.publicToken) await putPublicToken(env, meta.publicToken, meta.id);
  return meta;
}

beforeEach(() => {
  resetCapabilityKeyCache();
});

// ---------------------------------------------------------------------------

describe("capability tokens", () => {
  it("round-trips", async () => {
    const cap = await mintCapability(env, "doc-a", "cto@realplus.com");
    expect(await verifyCapability(env, cap, "doc-a")).toMatchObject({
      scope: "viewer",
      doc: "doc-a",
      sub: "cto@realplus.com",
    });
  });

  it("🔴 a capability for doc A does not open doc B", async () => {
    // The scope check IS the security property. A verify that only checked the
    // signature would happily accept a valid capability for someone else's document.
    const cap = await mintCapability(env, "doc-a", "cto@realplus.com");
    expect(await verifyCapability(env, cap, "doc-b")).toBeNull();
  });

  it("🔴 rejects an expired capability", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const cap = await mintCapability(env, "doc-a", null, past);
    expect(await verifyCapability(env, cap, "doc-a")).toBeNull();
  });

  it("🔴 rejects a tampered payload", async () => {
    const cap = (await mintCapability(env, "doc-a", null))!;
    const [, sig] = cap.split(".");

    // Re-sign a different document id with the original signature.
    const forged = `${btoa(JSON.stringify({ scope: "viewer", doc: "doc-b", sub: null, exp: 9e9 }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")}.${sig}`;

    expect(await verifyCapability(env, forged, "doc-b")).toBeNull();
  });

  it("🔴 rejects a capability signed with a different API token", async () => {
    // The signing key is derived from PAGEVAULT_API_TOKEN, so rotating it invalidates
    // outstanding capabilities. That is correct, and it costs nothing at a 10min TTL.
    const cap = await mintCapability(env, "doc-a", null);
    resetCapabilityKeyCache();
    const rotated = { ...env, PAGEVAULT_API_TOKEN: "a-completely-different-token" };
    expect(await verifyCapability(rotated, cap, "doc-a")).toBeNull();
  });

  it("🔴 mints nothing when the API token is unset — fails closed", async () => {
    resetCapabilityKeyCache();
    expect(await mintCapability({ ...env, PAGEVAULT_API_TOKEN: "" }, "doc-a", null)).toBeNull();
  });

  it.each([null, "", "garbage", "no-dot", ".", "a.b.c"])("rejects %o", async (token) => {
    expect(await verifyCapability(env, token as string | null, "doc-a")).toBeNull();
  });
});

describe("🔴 originAllowed — the Origin: null check", () => {
  const req = (origin?: string) =>
    new Request(`${HOST}/api/docs`, origin === undefined ? {} : { headers: { Origin: origin } });

  it("REJECTS Origin: null — this is what a sandboxed iframe sends", () => {
    // The single line that stops artifact JS from reaching a privileged endpoint even
    // if it somehow obtained a token. An opaque origin has no host to name.
    expect(originAllowed(req("null"))).toBe(false);
  });

  it("rejects a cross-origin caller", () => {
    expect(originAllowed(req("https://evil.example"))).toBe(false);
  });

  it("allows a same-origin caller", () => {
    expect(originAllowed(req(HOST))).toBe(true);
  });

  it("allows a request with no Origin at all — the CLI and the MCP server", () => {
    // Non-browser callers attach an explicit bearer header and have no ambient
    // authority to abuse, so there is nothing to defend against.
    expect(originAllowed(req())).toBe(true);
  });

  it("rejects a malformed Origin", () => {
    expect(originAllowed(req("not a url"))).toBe(false);
  });
});

describe("/render — artifact bytes", () => {
  it("serves the artifact with a valid capability", async () => {
    const meta = await publishPublic();
    const cap = await mintCapability(env, meta.id, null);

    const res = await SELF.fetch(`${HOST}/render/${meta.id}?cap=${cap}`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(HTML);
  });

  it("🔴 404s with no capability at all", async () => {
    const meta = await publishPublic();
    expect((await SELF.fetch(`${HOST}/render/${meta.id}`)).status).toBe(404);
  });

  it("🔴 404s with a capability minted for a DIFFERENT document", async () => {
    const meta = await publishPublic();
    const wrongCap = await mintCapability(env, "some-other-doc", null);

    const res = await SELF.fetch(`${HOST}/render/${meta.id}?cap=${wrongCap}`);
    expect(res.status).toBe(404);
  });

  it("🔴 404s with a forged capability", async () => {
    const meta = await publishPublic();
    const res = await SELF.fetch(`${HOST}/render/${meta.id}?cap=notarealtoken`);
    expect(res.status).toBe(404);
  });
});

describe("/render?download=1 — raw file download (#49)", () => {
  it("🔴 returns the raw source as an attachment, never inline HTML (ADR-007)", async () => {
    const meta = await publishPublic();
    const cap = await mintCapability(env, meta.id, null);
    const res = await SELF.fetch(`${HOST}/render/${meta.id}?cap=${cap}&download=1`);

    expect(res.status).toBe(200);
    // Read as bytes, not text — the whole point is that this is not served as a text document.
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(HTML);
    // Three independent reasons the hostile artifact cannot render in our origin:
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Type")).not.toContain("text/html");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("names the file from the title with an html extension", async () => {
    const meta = await publishPublic({ title: "Q3 Review" });
    const cap = await mintCapability(env, meta.id, null);
    const cd = (await SELF.fetch(`${HOST}/render/${meta.id}?cap=${cap}&download=1`)).headers.get("Content-Disposition");
    expect(cd).toContain('filename="Q3 Review.html"');
  });

  it("honors sourceKind — a markdown document downloads as .md", async () => {
    const meta = await publishPublic({ sourceKind: "markdown" });
    const cap = await mintCapability(env, meta.id, null);
    const cd = (await SELF.fetch(`${HOST}/render/${meta.id}?cap=${cap}&download=1`)).headers.get("Content-Disposition");
    expect(cd).toContain(".md");
    expect(cd).not.toContain(".html");
  });

  it("🔴 obeys the same capability guard — a forged cap 404s", async () => {
    const meta = await publishPublic();
    expect((await SELF.fetch(`${HOST}/render/${meta.id}?cap=notarealtoken&download=1`)).status).toBe(404);
  });
});

describe("viewer chrome — download + share (#49)", () => {
  it("every shell offers a download control pointing at the guarded raw route", async () => {
    const body = await (await SELF.fetch(`${HOST}/p/${(await publishPublic()).publicToken}`)).text();
    expect(body).toMatch(/href="\/render\/[^"]*download=1"/);
    expect(body).toContain(">Download<");
  });

  it("a /p/ capability link is self-authorizing, so the share control is present", async () => {
    const body = await (await SELF.fetch(`${HOST}/p/${(await publishPublic()).publicToken}`)).text();
    expect(body).toContain('id="share"');
  });

  it("🔴 an Access-gated (non-shareable) shell hides share but keeps download", async () => {
    // A /v/ URL only opens for people already in the portal, so a share affordance there
    // would hand out a link that dead-ends at the Access wall. Download stays.
    const secure = await renderShell(env, doc(), { email: "cto@realplus.com", noindex: true, shareable: false });
    const body = await secure.text();
    expect(body).not.toContain('id="share"');
    expect(body).toContain(">Download<");
  });
});

describe("/render?pdf=1 — single-page PDF export (#50)", () => {
  it("🔴 reuses the capability guard — a forged cap 404s before the browser is ever touched", async () => {
    const meta = await publishPublic();
    expect((await SELF.fetch(`${HOST}/render/${meta.id}?cap=notarealtoken&pdf=1`)).status).toBe(404);
  });

  it("501s when the Browser binding is absent — a deployment without Browser Run degrades off", async () => {
    // The test pool provides a stub BROWSER, so this path is exercised by a direct call with
    // the binding dropped — the same shape a fork that never enabled Browser Run produces.
    const meta = await publishPublic();
    const cap = await mintCapability(env, meta.id, null);
    const req = new Request(`${HOST}/render/${meta.id}?cap=${cap}&pdf=1`);

    // Omit the binding entirely (not set it to undefined) — the shape a fork without Browser
    // Run produces. exactOptionalPropertyTypes forbids the explicit-undefined shortcut.
    const noBrowser = { ...env };
    delete (noBrowser as Partial<typeof env>).BROWSER;

    const res = await handleRender(req, noBrowser, meta.id);
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toMatch(/not enabled/i);
  });
});

describe("viewer chrome — PDF control (#50)", () => {
  it("shows the PDF button and grants connect-src 'self' only when PDF is enabled", async () => {
    const res = await renderShell(env, doc(), { email: null, noindex: true, pdfEnabled: true });
    const body = await res.text();
    expect(body).toContain('id="pdf"');
    expect(res.headers.get("Content-Security-Policy")).toContain("connect-src 'self'");
  });

  it("🔴 hides the PDF button and keeps the tight CSP when PDF is disabled", async () => {
    const res = await renderShell(env, doc(), { email: null, noindex: true, pdfEnabled: false });
    const body = await res.text();
    expect(body).not.toContain('id="pdf"');
    // No fetch means no reason to widen the shell's CSP.
    expect(res.headers.get("Content-Security-Policy")).not.toContain("connect-src");
  });
});

describe("🔴 /render — the response headers ARE the sandbox", () => {
  // These assertions are not decoration. They are what stops someone "cleaning up" a
  // header they don't understand.

  let headers: Headers;

  beforeEach(async () => {
    const meta = await publishPublic();
    const cap = await mintCapability(env, meta.id, null);
    headers = (await SELF.fetch(`${HOST}/render/${meta.id}?cap=${cap}`)).headers;
  });

  it("carries the CSP sandbox directive, so even a direct navigation gets an opaque origin", () => {
    // Belt and braces over the iframe attribute. sharehtml relies on the attribute
    // alone and sends no CSP at all; this is one better, and it costs a header.
    expect(headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");
  });

  it("🔴 NEVER grants the frame our origin", () => {
    expect(headers.get("Content-Security-Policy")).not.toContain("allow-same-origin");
  });

  it("blocks the artifact from phoning home", () => {
    expect(headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
  });

  it("blocks exfiltration by form POST", () => {
    expect(headers.get("Content-Security-Policy")).toContain("form-action 'none'");
  });

  it("lets only our own shell frame it", () => {
    expect(headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
  });

  it("is never cached, sniffed, referred, or indexed", () => {
    expect(headers.get("Cache-Control")).toBe("private, no-store");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("allows a CDN allowlist, because Claude artifacts pull Chart.js from one", () => {
    const csp = docCsp(env);
    expect(csp).toContain("https://cdnjs.cloudflare.com");
    // Every entry is a supply-chain trust decision, so the whole policy is tunable.
    expect(docCsp({ ...env, DOC_CSP: "sandbox" })).toBe("sandbox");
  });
});

describe("/p/{token} — the capability link", () => {
  it("serves the trusted shell, not the artifact", async () => {
    const meta = await publishPublic();
    const res = await SELF.fetch(`${HOST}/p/${meta.publicToken}`);
    const body = await res.text();

    expect(res.status).toBe(200);
    // Our HTML, not theirs. The artifact is behind an iframe.
    expect(body).toContain("<iframe");
    expect(body).toContain(meta.title);
    expect(body).not.toContain("console.log(1)"); // the artifact body is NOT inlined
  });

  it("🔴 frames the artifact with scripts but WITHOUT our origin", async () => {
    const meta = await publishPublic();
    const body = await (await SELF.fetch(`${HOST}/p/${meta.publicToken}`)).text();

    expect(body).toContain(`sandbox="${IFRAME_SANDBOX}"`);
    expect(IFRAME_SANDBOX).toContain("allow-scripts");
    // The whole trick. With scripts enabled, granting the frame our origin lets it
    // reach into the parent and remove the attribute outright — no sandbox at all.
    expect(body).not.toContain("allow-same-origin");
  });

  it("mints a capability scoped to this document and embeds it in the frame src", async () => {
    const meta = await publishPublic();
    const body = await (await SELF.fetch(`${HOST}/p/${meta.publicToken}`)).text();

    const match = /\/render\/([^?]+)\?cap=([^"&]+)/.exec(body);
    expect(match?.[1]).toBe(meta.id);

    const cap = decodeURIComponent(match![2]!);
    expect(await verifyCapability(env, cap, meta.id)).toMatchObject({ doc: meta.id, sub: null });
  });

  it("is never indexed — unguessable is not private", async () => {
    const meta = await publishPublic();
    const res = await SELF.fetch(`${HOST}/p/${meta.publicToken}`);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("gives the shell a strict, nonced CSP of its own", async () => {
    // A different, tighter policy than the artifact sandbox. A bug in artifact serving
    // must not be able to degrade the page holding the capability token.
    const meta = await publishPublic();
    const csp = (await SELF.fetch(`${HOST}/p/${meta.publicToken}`)).headers.get(
      "Content-Security-Policy",
    );

    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'nonce-[0-9a-f-]+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
  });

  it("404s on an unknown token", async () => {
    expect((await SELF.fetch(`${HOST}/p/nosuchtoken`)).status).toBe(404);
  });

  it("🔴 404s on a token the document no longer claims — rotation kills it instantly", async () => {
    const meta = await publishPublic();
    // Simulate a rotation: the doc now claims a different token.
    await putDoc(env, { ...meta, publicToken: "a-new-token-entirely" }, HTML);

    expect((await SELF.fetch(`${HOST}/p/${meta.publicToken}`)).status).toBe(404);
  });

  it("🔴 404s on an ownerOnly draft, even with a live public token", async () => {
    // ownerOnly is the one narrowing rule and it beats every grant — including a link
    // minted before the document was marked as a draft.
    const meta = await publishPublic({ ownerOnly: true });
    expect((await SELF.fetch(`${HOST}/p/${meta.publicToken}`)).status).toBe(404);
  });

  it("escapes the title — an artifact does not get to inject into our shell", async () => {
    const meta = await publishPublic({ title: `</title><script>alert(1)</script>` });
    const body = await (await SELF.fetch(`${HOST}/p/${meta.publicToken}`)).text();

    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });
});

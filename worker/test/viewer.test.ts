import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { mintCapability, originAllowed, resetCapabilityKeyCache, verifyCapability } from "../src/capability.js";
import { type DocMeta, putDoc, putPublicToken } from "../src/store.js";
import { IFRAME_SANDBOX, SHARED_LINK_DESCRIPTION, docCsp, renderShell, serveDocumentAction } from "../src/viewer.js";

const HOST = "https://share.example.com";
const HTML = "<!doctype html><h1>Q3</h1><script>console.log(1)</script>";

const doc = (over: Partial<DocMeta> = {}): DocMeta => ({
  id: "k3x9mq2vb7pd",
  portal: "default",
  name: "q3-review.html",
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

describe("surface actions — ?download=1 (#49, #223)", () => {
  // 🔴 These hang off the DOCUMENT's own address on each surface, not off `/render?cap=`.
  // The capability is ten minutes long and a reader's tab is not, so a control built from it
  // was a live button that silently 404'd for anyone who spent eleven minutes reading (#223).
  const PUB = (meta: DocMeta) => `${HOST}/p/${meta.publicToken}?download=1`;

  it("🔴 returns the raw source as an attachment, never inline HTML (ADR-007)", async () => {
    const res = await SELF.fetch(PUB(await publishPublic()));

    expect(res.status).toBe(200);
    // Read as bytes, not text — the whole point is that this is not served as a text document.
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(HTML);
    // Three independent reasons the hostile artifact cannot render in our origin:
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Type")).not.toContain("text/html");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("🔴 works with no capability anywhere in the request — that is the fix (#223)", async () => {
    // The regression this issue exists for. The old control carried `?cap=`; when it expired the
    // download 404'd and the browser fired no download event at all, so the reader saw a button
    // that did nothing. Authorization now comes from the surface, which does not expire mid-read.
    const res = await SELF.fetch(PUB(await publishPublic()));
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(HTML);
  });

  it("names the file from the title with an html extension", async () => {
    const meta = await publishPublic({ title: "Q3 Review" });
    const cd = (await SELF.fetch(PUB(meta))).headers.get("Content-Disposition");
    expect(cd).toContain('filename="Q3 Review.html"');
  });

  it("honors sourceKind — a markdown document downloads as .md", async () => {
    const meta = await publishPublic({ sourceKind: "markdown" });
    const cd = (await SELF.fetch(PUB(meta))).headers.get("Content-Disposition");
    expect(cd).toContain(".md");
    expect(cd).not.toContain(".html");
  });

  it("🔴 serves the original .md source, not the rendered HTML body (#46)", async () => {
    // A markdown doc stores rendered HTML at doc: and the original at raw:. The download
    // must hand back the original, or the bytes contradict the .md filename.
    const meta = doc({ id: "mdrawdoc123456", publicToken: "pubtoken4444444444444", sourceKind: "markdown" });
    const RENDERED = "<!doctype html><h1>Report</h1>";
    const ORIGINAL = "# Report\n\nBody text.";
    await putDoc(env, meta, RENDERED, ORIGINAL);
    await putPublicToken(env, meta.publicToken!, meta.id);
    const res = await SELF.fetch(PUB(meta));
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(ORIGINAL);
  });

  it("🔴 a revoked /p/ token cannot download — the action obeys the surface's own gate", async () => {
    const meta = await publishPublic();
    // Rotate: the doc keeps a live token, but this one is no longer it.
    await putDoc(env, { ...meta, publicToken: "pubtoken5555555555555" }, HTML);
    expect((await SELF.fetch(PUB(meta))).status).toBe(404);
  });

  it("🔴 an owner-only draft cannot be downloaded through a /p/ link", async () => {
    // ownerOnly is the one narrowing rule and it beats every grant, the action included.
    const meta = await publishPublic({ id: "ownerdraft1234", publicToken: "pubtoken6666666666666", ownerOnly: true });
    expect((await SELF.fetch(PUB(meta))).status).toBe(404);
  });

  it("🔴 /render no longer serves downloads at all — one route, one job (#223)", async () => {
    // Deleting the action from /render is half the fix: leaving two live paths to the same
    // bytes is what ADR-007 warns about. A capability still opens the iframe, and only that.
    const meta = await publishPublic();
    const cap = await mintCapability(env, meta.id, null);
    const res = await SELF.fetch(`${HOST}/render/${meta.id}?cap=${cap}&download=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });
});

describe("viewer chrome — download + share (#49, #223)", () => {
  it("🔴 the download control points at the SURFACE, carrying no capability (#223)", async () => {
    const meta = await publishPublic();
    const body = await (await SELF.fetch(`${HOST}/p/${meta.publicToken}`)).text();
    expect(body).toContain(`href="/p/${meta.publicToken}?download=1"`);
    expect(body).toContain(">Download<");
    // The control must not be built from the render URL — that is the ten-minute token.
    expect(body).not.toMatch(/href="\/render\/[^"]*download=1"/);
  });

  it("🔴 a /v/ shell points at its own /v/ address, not the public one", async () => {
    // Substituting a canonical or public address here would send a portal reader's Download
    // to a link that opens for the wrong audience — or for nobody.
    const body = await (
      await renderShell(env, doc(), {
        email: "cto@realplus.com",
        selfHref: "/v/default/k3x9mq2vb7pd",
        noindex: true,
        shareable: false,
        unfurl: "none",
        surface: "portal",
      })
    ).text();
    expect(body).toContain('href="/v/default/k3x9mq2vb7pd?download=1"');
  });

  it("a /p/ capability link is self-authorizing, so the share control is present", async () => {
    const body = await (await SELF.fetch(`${HOST}/p/${(await publishPublic()).publicToken}`)).text();
    expect(body).toContain('id="share"');
  });

  it("🔴 an Access-gated (non-shareable) shell hides share but keeps download", async () => {
    // A /v/ URL only opens for people already in the portal, so a share affordance there
    // would hand out a link that dead-ends at the Access wall. Download stays.
    const secure = await renderShell(env, doc(), { email: "cto@realplus.com", selfHref: "/v/default/k3x9mq2vb7pd", noindex: true, shareable: false, unfurl: "none", surface: "portal" });
    const body = await secure.text();
    expect(body).not.toContain('id="share"');
    expect(body).toContain(">Download<");
  });
});

describe("🔴 /p/ unfurl — the name, never the summary (#210)", () => {
  // A /p/ link is shared deliberately but PRIVATELY. Pasting one into a channel renders whatever
  // we emit to every member of that channel — including people the document was never shared
  // with — and sends it to the platform doing the unfurling. The title gives the card something
  // to show. The summary is one line the operator wrote for a client index, and it stays here.
  //
  // Promoting this to `full` is a disclosure, not a polish item. See ShellOptions.unfurl.

  it("🔴 emits the document's title, and a description that is NOT its summary", async () => {
    // The property is the summary's ABSENCE, not the tag's. Slack builds no card without an
    // og:description at all (#214), so the tag is present and carries a constant instead.
    const meta = await publishPublic({ title: "Q3 Review", summary: "Repriced after the board pushed back." });
    const body = await (await SELF.fetch(`${HOST}/p/${meta.publicToken}`)).text();

    expect(body).toContain('<meta property="og:title" content="Q3 Review">');
    expect(body).toContain('<meta name="twitter:title" content="Q3 Review">');
    expect(body).toContain(`<meta property="og:description" content="${SHARED_LINK_DESCRIPTION}">`);
    // 🔴 The one that matters. Anywhere in the response, not just in a tag.
    expect(body).not.toContain("Repriced after the board pushed back.");
  });

  it("🔴 the constant is content-independent — two different documents produce the same description", async () => {
    // If this ever fails, someone interpolated a per-document value into the constant and turned it
    // back into a disclosure. That is the whole reason it is a constant.
    const a = await publishPublic({ title: "Alpha", summary: "Secret A" });
    const bodyA = await (await SELF.fetch(`${HOST}/p/${a.publicToken}`)).text();
    const b = await publishPublic({
      id: "zz9zz9zz9zz9",
      publicToken: "pubtoken3333333333333",
      title: "Beta",
      summary: "Secret B",
      tags: ["confidential"],
    });
    const bodyB = await (await SELF.fetch(`${HOST}/p/${b.publicToken}`)).text();

    const description = (body: string) => /<meta property="og:description" content="([^"]*)">/.exec(body)?.[1];
    expect(description(bodyA)).toBe(SHARED_LINK_DESCRIPTION);
    expect(description(bodyB)).toBe(SHARED_LINK_DESCRIPTION);
    expect(bodyA).not.toContain("Secret A");
    expect(bodyB).not.toContain("Secret B");
  });

  it("og:url is the capability URL itself, with no query string carried into it", async () => {
    const meta = await publishPublic();
    const body = await (await SELF.fetch(`${HOST}/p/${meta.publicToken}?utm_source=slack`)).text();
    expect(body).toContain(`<meta property="og:url" content="${HOST}/p/${meta.publicToken}">`);
    expect(body).not.toContain("utm_source");
  });
});

describe("surface actions — ?pdf=1 (#50, ADR-027, #223)", () => {
  it("🔴 obeys the surface's gate — a revoked /p/ token 404s before the browser is touched", async () => {
    const meta = await publishPublic({ id: "pdfrevoked1234", publicToken: "pubtoken7777777777777" });
    await putDoc(env, { ...meta, publicToken: "pubtoken8888888888888" }, HTML);
    expect((await SELF.fetch(`${HOST}/p/${meta.publicToken}?pdf=1`)).status).toBe(404);
  });

  it("501s when the Browser binding is absent — a deployment without Browser Run degrades off", async () => {
    // The test pool provides a stub BROWSER, so this path is exercised by a direct call with
    // the binding dropped — the same shape a fork that never enabled Browser Run produces.
    const meta = await publishPublic({ id: "pdfnobrowser12", publicToken: "pubtoken9999999999999" });
    const req = new Request(`${HOST}/p/${meta.publicToken}?pdf=1`);

    // Omit the binding entirely (not set it to undefined) — the shape a fork without Browser
    // Run produces. exactOptionalPropertyTypes forbids the explicit-undefined shortcut.
    const noBrowser = { ...env };
    delete (noBrowser as Partial<typeof env>).BROWSER;

    const res = await serveDocumentAction(req, noBrowser, meta, "pdf");
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toMatch(/not enabled/i);
  });

  it("🔴 /render no longer renders PDFs — the action lives on the surface now (#223)", async () => {
    const meta = await publishPublic();
    const cap = await mintCapability(env, meta.id, null);
    const res = await SELF.fetch(`${HOST}/render/${meta.id}?cap=${cap}&pdf=1`);
    expect(res.headers.get("Content-Type")).not.toContain("application/pdf");
  });
});

describe("viewer chrome — PDF control (#50)", () => {
  it("shows the PDF button and grants connect-src 'self' only when PDF is enabled", async () => {
    const res = await renderShell(env, doc(), { email: null, selfHref: "/p/pubtoken2222222222222", noindex: true, unfurl: "title", pdfEnabled: true, surface: "link" });
    const body = await res.text();
    expect(body).toContain('id="pdf"');
    expect(res.headers.get("Content-Security-Policy")).toContain("connect-src 'self'");
  });

  it("🔴 hides the PDF button and keeps the tight CSP when PDF is disabled", async () => {
    const res = await renderShell(env, doc(), { email: null, selfHref: "/p/pubtoken2222222222222", noindex: true, unfurl: "title", pdfEnabled: false, surface: "link" });
    const body = await res.text();
    expect(body).not.toContain('id="pdf"');
    // No fetch means no reason to widen the shell's CSP.
    expect(res.headers.get("Content-Security-Policy")).not.toContain("connect-src");
  });
});

describe("viewer chrome — copy-as-rich-text (#93)", () => {
  it("shows the Copy control and grants connect-src 'self' for a markdown document", async () => {
    const res = await renderShell(env, doc({ sourceKind: "markdown" }), { email: null, selfHref: "/p/pubtoken2222222222222", noindex: true, unfurl: "title", pdfEnabled: false, surface: "link" });
    const body = await res.text();
    expect(body).toContain('id="copy"');
    expect(body).toContain(">Copy<");
    // The copy handler fetches both flavors same-origin, so the shell must allow connect-src 'self'
    // even with PDF disabled (#93).
    expect(res.headers.get("Content-Security-Policy")).toContain("connect-src 'self'");
  });

  it("🔴 hides the Copy control for an HTML document — it would paste as a blank rectangle", async () => {
    const res = await renderShell(env, doc({ sourceKind: "html" }), { email: null, selfHref: "/p/pubtoken2222222222222", noindex: true, unfurl: "title", pdfEnabled: false, surface: "link" });
    const body = await res.text();
    expect(body).not.toContain('id="copy"');
    // No copy control and no PDF → nothing fetches, so the CSP stays tight.
    expect(res.headers.get("Content-Security-Policy")).not.toContain("connect-src");
  });

  it("🔴 the copy control never introduces allow-same-origin (ADR-007)", async () => {
    const res = await renderShell(env, doc({ sourceKind: "markdown" }), { email: null, selfHref: "/p/pubtoken2222222222222", noindex: true, unfurl: "title", pdfEnabled: true, surface: "link" });
    expect(await res.text()).not.toContain("allow-same-origin");
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

  it("🔴 ?html=1 on a SURFACE carries the identical sandbox — ADR-007 is not path-scoped (#223)", async () => {
    // The Copy control fetches artifact bytes from `/p/{token}?html=1` rather than `/render`.
    // Those bytes are just as hostile there, and the guarantee is carried by the header, not
    // by the path. If these two responses ever diverge, the surface route is the unsafe one.
    const meta = await publishPublic({ id: "htmlaction1234", publicToken: "pubtokenaaaaaaaaaaaaa" });
    const viaSurface = await SELF.fetch(`${HOST}/p/${meta.publicToken}?html=1`);
    const cap = await mintCapability(env, meta.id, null);
    const viaRender = await SELF.fetch(`${HOST}/render/${meta.id}?cap=${cap}`);

    expect(viaSurface.status).toBe(200);
    for (const header of ["Content-Security-Policy", "Content-Type", "Cache-Control", "X-Content-Type-Options", "Referrer-Policy", "X-Robots-Tag"]) {
      expect(viaSurface.headers.get(header), header).toBe(viaRender.headers.get(header));
    }
    expect(viaSurface.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");
    expect(viaSurface.headers.get("Content-Security-Policy")).not.toContain("allow-same-origin");
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

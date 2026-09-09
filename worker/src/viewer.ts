import { type ViewSurface, recordView } from "./analytics.js";
import { mintCapability, verifyCapability } from "./capability.js";
import type { Env } from "./env.js";
import { fingerprint, log } from "./log.js";
import { type BlockedRequest, classifyRenderFailure, readLimits, renderPdf, retryDelayMs } from "./pdf.js";
import type { DocMeta } from "./store.js";
import { getDoc, getRawSource } from "./store.js";
import { ATTRIBUTION_CSS, THEME, attribution } from "./theme.js";

/**
 * The iframe sandbox.
 *
 * `allow-scripts` WITHOUT same-origin is the entire trick. Scripts run — charts,
 * animations, everything a self-contained artifact does — but the frame gets a unique
 * opaque origin: it cannot read our cookies, cannot touch the shell's DOM, and cannot
 * make credentialed requests back to us.
 *
 * 🔴 Adding the same-origin token to this list is functionally the same as deleting the
 * sandbox: with scripts enabled, the frame can reach into the parent and remove the
 * attribute outright. It is exactly the change made at 11pm because an artifact
 * "needs" it. It doesn't. `make check-sandbox` fails the build if the token ever
 * appears in worker/src, and there are runtime tests asserting it never reaches a
 * response body.
 */
export const IFRAME_SANDBOX = "allow-scripts allow-popups allow-forms allow-downloads";

/**
 * The CSP on artifact bytes.
 *
 * Belt and braces. The iframe attribute above already gives the frame an opaque origin;
 * this repeats the guarantee as a header, so even a *direct top-level navigation* to
 * `/render/{id}` lands in one. sharehtml relies on the attribute alone and sends no CSP
 * at all — this is one better, and it costs a header.
 *
 * - `connect-src 'none'` — the artifact cannot phone home.
 * - `form-action 'none'` — no exfiltration by form POST.
 * - `frame-ancestors 'self'` — only our shell may frame it.
 * - `script-src` allows inline, `eval`, and a small CDN allowlist, because Claude
 *   artifacts routinely pull Chart.js or D3 from one. **Every entry is a supply-chain
 *   trust decision**, which is why the whole policy is an env var: the deployer should
 *   own that call, not us.
 */
const DEFAULT_DOC_CSP = [
  "sandbox allow-scripts allow-popups allow-forms allow-downloads",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com",
  "font-src data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
  "img-src data: blob: https:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
].join("; ");

export const docCsp = (env: Env): string => env.DOC_CSP?.trim() || DEFAULT_DOC_CSP;

/**
 * `/render/{id}?cap={token}` — the artifact bytes for the IFRAME, and nothing else.
 *
 * No Access application in front of it. The capability token IS the authorization: it
 * was minted by a shell that had already been through `canView`, it names this one
 * document, and it expires in minutes.
 *
 * 🔴 This route serves the iframe and nothing but the iframe (#223). It used to carry
 * `?download=1` and `?pdf=1` as well, which meant every control in the shell replayed a
 * ten-minute token for as long as the tab stayed open — and then failed silently, with a bare
 * 404 the reader saw as a download that did nothing. Those actions now hang off the document's
 * own address on each surface (`serveDocumentAction`), where the real authorization re-runs on
 * every click. Do not add a third action back here: the capability exists because an Access
 * redirect inside a sandboxed iframe is a broken experience, and that argument covers the frame
 * only. Everything with a button attached to it has a surface to ask instead.
 */
export async function handleRender(request: Request, env: Env, id: string): Promise<Response> {
  const cap = new URL(request.url).searchParams.get("cap");

  // Scoped verification. A valid capability for a different document is not a
  // capability for this one.
  const capability = await verifyCapability(env, cap, id);
  if (!capability) {
    // The capability is fingerprinted, never logged. `verifyCapability` refuses a token
    // that is valid but names a *different* document (capability.ts) — that token is still
    // live for its own document, and logging it verbatim would make it replayable from the
    // log. The fingerprint still tells you a retry loop is hammering one dead token.
    log("warn", "blocked_render_invalid_capability", {
      request,
      doc: id,
      cap: cap ? await fingerprint(cap) : "absent",
    });
    return new Response("Not found", { status: 404 });
  }

  const source = await getDoc(env, id);
  if (source === null) return new Response("Not found", { status: 404 });

  return artifactBytes(env, source);
}

/**
 * What a surface URL is asking for beyond the page itself (#223).
 *
 * These hang off the DOCUMENT's own address — `/v/{portal}/{id}?download=1`,
 * `/pub/{slug}/{id}?pdf=1`, `/p/{token}?download=1` — so every click re-runs the surface's real
 * authorization instead of replaying a token minted when the page loaded.
 */
export type DocumentAction = "download" | "pdf" | "html";

/** The action this URL asks for, or null for the page itself. */
export function documentAction(url: URL): DocumentAction | null {
  const params = url.searchParams;
  if (params.get("download") === "1") return "download";
  if (params.get("pdf") === "1") return "pdf";
  if (params.get("html") === "1") return "html";
  return null;
}

/**
 * Serve one document action, for a viewer the CALLER has already authorized.
 *
 * 🔴 Two rules, and they are the reason this function takes `meta` rather than an id.
 *
 * 1. **The caller authorizes.** `canView` on `/v/` and `/pub/`, the token checks on `/p/`. There
 *    is no second authorization path in here — this is a dispatch, not a door (ADR-007, prime
 *    directive #5). Calling it before those checks hands out a client's document.
 * 2. **Call it BEFORE `renderShell`, never after.** `renderShell` records a view (ADR-023). A
 *    download is not a read, and a PDF export is not a second read, so an action that fell through
 *    to the shell first would inflate every document's view count by however many times its
 *    reader pressed a button.
 */
export async function serveDocumentAction(
  request: Request,
  env: Env,
  meta: DocMeta,
  action: DocumentAction,
): Promise<Response> {
  const source = await getDoc(env, meta.id);
  if (source === null) return new Response("Not found", { status: 404 });

  if (action === "download") return rawDownload(env, meta, source);
  if (action === "pdf") return pdfExport(request, env, meta, source);
  return artifactBytes(env, source);
}

/**
 * The artifact, as HTML, in a CSP sandbox.
 *
 * 🔴 The `sandbox` directive in `docCsp` is what makes this safe to serve from our own origin: it
 * gives the response an opaque origin even on a direct top-level navigation, so hostile markup
 * never executes in our document context (ADR-007). That property is what lets the same bytes
 * answer both the iframe (`/render?cap=`) and the Copy control's fetch on a surface URL — it is
 * carried by the header, not by the path.
 */
function artifactBytes(env: Env, source: string): Response {
  return new Response(source, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": docCsp(env),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      // Never let the CDN cache an artifact that authorization gated.
      "Cache-Control": "private, no-store",
    },
  });
}

/**
 * The raw source, as a file.
 *
 * 🔴 ADR-007. Serving artifact HTML from our origin with `text/html` and no attachment
 * disposition renders hostile markup in our document context — the exact thing the sandbox
 * exists to prevent. `Content-Disposition: attachment` forces a download; `application/
 * octet-stream` + `nosniff` means that even if a disposition were ever dropped, the browser
 * still will not execute it as HTML here. Three independent reasons it cannot render inline.
 */
async function rawDownload(env: Env, meta: DocMeta, source: string): Promise<Response> {
  // A markdown doc stores rendered HTML at `doc:` but downloads as the original `.md`
  // (#46) — else the bytes would contradict the `.md` filename `rawFilename` produces.
  // `?? source` covers HTML docs and any pre-#46 markdown that has no `raw:` companion.
  const bytes = meta.sourceKind === "markdown" ? ((await getRawSource(env, meta.id)) ?? source) : source;
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": contentDisposition(rawFilename(meta, meta.id)),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "Cache-Control": "private, no-store",
    },
  });
}

/**
 * Single-page PDF (#50). The browser binding is optional: a deployment that did not enable
 * Browser Run answers 501, and the shell hides the button, so nothing half-works.
 */
async function pdfExport(request: Request, env: Env, meta: DocMeta, source: string): Promise<Response> {
  if (!env.BROWSER) {
    return pdfError(501, "PDF export is not enabled on this deployment.");
  }
  try {
    const { pdf, blocked } = await renderPdf(env.BROWSER, source, new URL(request.url).hostname);
    logBlockedAssets(request, meta, blocked);
    return pdfResponse(pdf, blocked, meta);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failure = classifyRenderFailure(await readLimits(env.BROWSER), message);

    // 🔴 Retry the transient case ONCE, before the reader is told anything (#207).
    //
    // `busy` means no browser was free at that instant — three concurrent on Workers Free, or the
    // new-instance rate limit. It clears in about a second. The button is already showing
    // "Generating…" for the cold-launch latency, so the wait is invisible; what was visible was an
    // alert telling a client to come back tomorrow over a one-second queue.
    //
    // Once, not a loop: if a second attempt a beat later still cannot get a browser, the deployment
    // is genuinely saturated and the honest answer is to say so rather than hold the request open.
    if (failure === "busy") {
      const retried = await retryRender(request, env, meta, source);
      if (retried) return retried;
    }

    // Separate events, so the operator can tell "someone double-tapped" from "the deployment is
    // out of budget" from a tail, without opening the Cloudflare dashboard.
    if (failure === "busy") {
      // `warn`, not `error`: a saturated renderer is a capacity fact about the free tier, not a
      // broken deployment. It should not page anyone reading `--status error`.
      log("warn", "pdf_renderer_busy", { request, doc: meta.id, error: message });
      return pdfError(429, "The PDF renderer is busy. Try again in a moment.");
    }

    if (failure === "exhausted") {
      log("warn", "pdf_budget_exhausted", { request, doc: meta.id, error: message });
      return pdfError(429, "This deployment's daily PDF allowance is used up. Try again tomorrow.");
    }

    log("error", "pdf_render_failed", { request, doc: meta.id, error: message });
    return pdfError(502, "Could not generate the PDF for this document.");
  }
}

/**
 * One more attempt at a render that was refused for capacity, after a short pause.
 *
 * Returns the response on success, or null to let the caller report the original failure — a retry
 * that also fails must not replace the diagnosis with its own.
 */
async function retryRender(
  request: Request,
  env: Env,
  meta: DocMeta,
  source: string,
): Promise<Response | null> {
  const browser = env.BROWSER;
  if (!browser) return null;

  const delay = retryDelayMs(await readLimits(browser));
  await new Promise((resolve) => setTimeout(resolve, delay));
  try {
    const { pdf, blocked } = await renderPdf(browser, source, new URL(request.url).hostname);
    log("info", "pdf_retry_succeeded", { request, doc: meta.id });
    // 🔴 The retry reports blocked assets too. A PDF delivered by the second attempt is still a
    // PDF the reader will open, and #147 is about the operator hearing that it came out with
    // holes — a signal that appeared or vanished depending on which attempt succeeded would be
    // worse than none, because its absence would read as "nothing was blocked".
    logBlockedAssets(request, meta, blocked);
    return pdfResponse(pdf, blocked, meta);
  } catch {
    return null;
  }
}

/**
 * Name what the render could not load (#147).
 *
 * In a header the client can read, and in the log, where the operator will actually see it. `warn`
 * because a document silently exporting differently from how it appears is a content problem the
 * operator wants to know about, not an error in the deployment.
 */
function logBlockedAssets(request: Request, meta: DocMeta, blocked: BlockedRequest[]): void {
  if (!blocked.length) return;
  log("warn", "pdf_assets_blocked", {
    request,
    doc: meta.id,
    count: blocked.length,
    assets: blocked.slice(0, 10).map((b) => `${b.reason}: ${b.url}`),
  });
}

/** The rendered PDF, as a download. Shared by the first attempt and the retry. */
function pdfResponse(pdf: Uint8Array, blocked: BlockedRequest[], meta: DocMeta): Response {
  return new Response(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": contentDisposition(`${filenameBase(meta, meta.id)}.pdf`),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "Cache-Control": "private, no-store",
      ...(blocked.length ? { "X-PageVault-Assets-Blocked": String(blocked.length) } : {}),
    },
  });
}

/** The title, made filesystem-safe — no extension. Shared by the raw download and the PDF. */
function filenameBase(meta: DocMeta | null, id: string): string {
  const base = (meta?.title ?? id)
    // Collapse anything that breaks a filename or the header to a single space.
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return base || "document";
}

/**
 * A filename for the raw download: the title with an extension that tells the truth about the
 * bytes (`sourceKind`). Same extension-honesty concern as #35.
 */
function rawFilename(meta: DocMeta | null, id: string): string {
  return `${filenameBase(meta, id)}.${meta?.sourceKind === "markdown" ? "md" : "html"}`;
}

/**
 * A `Content-Disposition` value that survives a Unicode title. The quoted `filename=` is an
 * ASCII fallback for old clients; `filename*=UTF-8''…` (RFC 5987) carries the real name.
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** A JSON error the PDF button's fetch can read and turn into a message. */
function pdfError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
  });
}

/**
 * How much a surface may tell an unfurl bot. See `ShellOptions.unfurl` (#210).
 */
export type UnfurlLevel = "none" | "title" | "full";

/**
 * The description on a card that may not carry the document's own summary (#214).
 *
 * 🔴 CONSTANT, and that is the entire security argument. The same bytes for every document on every
 * deployment, so it carries exactly zero information — identical whether the file is a board deck or
 * a lunch menu. Nothing about the document reaches Slack, or the channel, or anyone reading over a
 * shoulder. Interpolating ANY per-document value here (title, tags, portal, byte count, date) turns
 * a constant into a disclosure and defeats the reason it exists.
 *
 * It exists because a title alone is not enough. Measured against production: Slack renders no card
 * at all from title-only tags, while iMessage renders one from the byte-identical response. Slack
 * needs description text to build an attachment, so #210's honest `/p/` restraint cost the feature
 * outright on the channel that matters most. This gives Slack something to render that says nothing.
 *
 * The wording deliberately does NOT promise privacy. A capability link is unguessable, not private —
 * index.ts is careful about exactly that — and a card claiming otherwise would contradict the
 * product's own language in front of the people least able to check it.
 */
export const SHARED_LINK_DESCRIPTION = "A document shared by link. Open it to read.";

/**
 * The same idea for a public portal index that has no description of its own (`portal.ts`).
 *
 * Separate constant because the sentence has to be true: a portal is a collection, not a document.
 * Same rule applies — it is a constant, and nothing from the portal or its listing may be
 * interpolated into it.
 */
export const SHARED_PORTAL_DESCRIPTION = "A collection of published documents.";

export interface ShellOptions {
  /** The verified viewer, or null for an unauthenticated public view. */
  email: string | null;
  /**
   * Which door this view came through. Passed explicitly rather than inferred from
   * `portal.kind`: `/v` only ever serves non-public portals today (it redirects public ones
   * to `/pub`), so the kind *happens* to identify the surface — but that is a property of a
   * redirect three functions away, and it feeds the one field that decides whether a
   * viewer's email is recorded. See ADR-015, decision 1.
   */
  surface: ViewSurface;
  /**
   * The raw `Referer` header, passed through untouched. It is reduced to a bare host inside
   * `recordView` and never stored otherwise — see `referrerHost` for why the stripping lives
   * there rather than at the call sites (ADR-023, decision 5).
   */
  referer?: string | null;
  /**
   * This document's own address on THIS surface — `/v/{slug}/{id}`, `/pub/{slug}/{id}`, `/p/{token}`.
   * The Download, PDF and Copy controls hang off it (`?download=1`, `?pdf=1`, `?html=1`), so each
   * click re-enters the surface's own authorization (#223).
   *
   * 🔴 Required, with no default, and it must be the address the READER is on rather than any
   * canonical form of it. On `/p/` the token in the path is the authorization: substitute the
   * `/v/` address here and every control on a public link dead-ends at the Access wall.
   *
   * Not folded into `canonicalUrl`, which is absolute, optional, and answers a different question
   * — what an unfurl bot should call this page. A surface may want no `og:url` and still needs
   * working buttons.
   */
  selfHref: string;
  /** Where "back" goes. Absent on a `/p/` capability link — there is no collection. */
  backHref?: string;
  backLabel?: string;
  /** `/p/` and `/pub/` must never be indexed. An unguessable URL is not a private one. */
  noindex: boolean;
  /**
   * How much this surface may tell an unfurl bot — Slack, iMessage, Discord, LinkedIn (#210).
   *
   * 🔴 NOT derivable from `noindex`, and deliberately not a boolean. `X-Robots-Tag: noindex` binds
   * search *indexers*; an unfurl bot is not one and ignores it entirely. The two questions are "may
   * Google list this?" and "may a chat app render its contents into a room?", and they have
   * different blast radii — the second reaches people who cannot open the document at all.
   *
   * - `none` — emit nothing. `/v/` is Access-gated, so a bot gets the login page anyway; saying
   *   nothing means we never depend on that.
   * - `title` — the document's NAME, plus `SHARED_LINK_DESCRIPTION`, which is a constant and says
   *   nothing about the document (#214). Nothing else from `meta`. `/p/` capability links are shared
   *   deliberately but privately, so the card gets something to show while the summary stays on
   *   this deployment. A summary is one line the operator wrote for a client index: "revised after
   *   the board pushed back" is a fine index line and a bad Slack card in the wrong channel.
   * - `full` — title AND the document's own summary. `/pub/` only, where both are already readable
   *   by anyone who loads the public portal index. Nothing new leaves. Falls back to the same
   *   constant when a document has no summary, so the card still renders.
   *
   * Required, with no default: a surface added later must answer this rather than inherit it.
   */
  unfurl: UnfurlLevel;
  /**
   * Absolute URL of this surface, for `og:url`. Built at the call site from `request.url` — the
   * shell never receives the request. Absent → no `og:url`, which unfurls perfectly well; a
   * *wrong* canonical is worse than none, so this is never guessed here.
   */
  canonicalUrl?: string;
  /**
   * Show the share (copy-URL) control. True ONLY where the current URL is self-authorizing —
   * `/p/{token}` and `/pub/{slug}`. On a `/v/` document the URL opens for no one outside the
   * portal, so a share affordance there hands out a link that dead-ends at the Access wall.
   * Deliberately NOT derived from `noindex`: the two overlap today but mean different things,
   * and coupling them invites a future bug (#49).
   */
  shareable?: boolean;
  /**
   * Show the PDF export control. Set from `!!env.BROWSER` at the caller: a deployment without
   * the Browser Run binding hides the button, matching the endpoint's 501 (#50). The button's
   * fetch is why the shell gets `connect-src 'self'` — the one page that talks to our origin.
   */
  pdfEnabled?: boolean;
}

/**
 * The trusted shell: our HTML, our JS, nothing from the artifact.
 *
 * This is where chrome lives — the title, the link back to the collection, and later
 * the PDF button and the read receipt. It is the reason ADR-003 was superseded: a
 * top-level CSP sandbox is equally secure and makes all of that impossible.
 */
export async function renderShell(
  env: Env,
  meta: DocMeta,
  opts: ShellOptions,
): Promise<Response> {
  const cap = await mintCapability(env, meta.id, opts.email);
  if (!cap) {
    return new Response("Server misconfigured: PAGEVAULT_API_TOKEN is not set", { status: 500 });
  }

  // After the mint, not before: a view that could not be served is not a view. This is the
  // one place all three surfaces meet, which is why the hook is here and not on the routes.
  recordView(env, meta, opts.surface, opts.email, opts.referer);

  // The shell's own script/style are nonced. A bug in artifact serving must not be able
  // to degrade the page that holds the capability token.
  const nonce = crypto.randomUUID();
  const src = `/render/${encodeURIComponent(meta.id)}?cap=${encodeURIComponent(cap)}`;
  // 🔴 The controls hang off the SURFACE, not off `src` (#223). The capability above is ten
  // minutes long and a reader's tab is not, so a Download built from `src` was a live button
  // that silently 404'd once the reader had spent eleven minutes with the document — which is
  // most of them. These re-enter `canView` (or the `/p/` token check) on every click instead.
  const downloadHref = `${opts.selfHref}?download=1`;
  const pdfHref = `${opts.selfHref}?pdf=1`;
  const rawHtmlHref = `${opts.selfHref}?html=1`;
  const pdfName = `${filenameBase(meta, meta.id)}.pdf`;

  const back = opts.backHref
    ? `<a class="back" href="${esc(opts.backHref)}">&larr; ${esc(opts.backLabel ?? "Back")}</a>`
    : "";

  const shareBtn = opts.shareable ? `<button class="ctl" id="share" type="button">Share</button>` : "";
  // The share control only copies the current URL — it never mints or widens anything; that is
  // an owner action, and it is why the button appears only where the URL already self-authorizes.
  const shareScript = opts.shareable
    ? `<script nonce="${nonce}">
  (function () {
    var b = document.getElementById("share");
    if (!b) return;
    b.addEventListener("click", function () {
      var url = location.href;
      if (navigator.share) { navigator.share({ title: document.title, url: url }).catch(function () {}); return; }
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () {
          var t = b.textContent; b.textContent = "Copied"; setTimeout(function () { b.textContent = t; }, 1200);
        }, function () { prompt("Copy this link:", url); });
        return;
      }
      prompt("Copy this link:", url);
    });
  })();
</script>`
    : "";

  // Copy-as-rich-text (#93). Markdown only: an HTML artifact with script-drawn charts pastes into
  // a Doc as a blank rectangle — PDF export (#50) covers that case honestly. The shell fetches the
  // bytes same-origin and hands them to the clipboard opaque; it never renders hostile markup in
  // our document context (no same-origin token, no iframe DOM read — ADR-007). The parsing happens
  // in the paste target's sandbox, where scripts are stripped anyway.
  const canCopyRich = meta.sourceKind === "markdown";
  const copyBtn = canCopyRich ? `<button class="ctl" id="copy" type="button">Copy</button>` : "";
  const copyScript = canCopyRich
    ? `<script nonce="${nonce}">
  (function () {
    var b = document.getElementById("copy");
    if (!b) return;
    var htmlUrl = ${JSON.stringify(rawHtmlHref)}, mdUrl = ${JSON.stringify(downloadHref)}, label = b.textContent;
    // Re-type each body into a Blob whose MIME matches the ClipboardItem key: the rendered HTML
    // comes back as text/html, but the raw markdown downloads as octet-stream, and a strict
    // clipboard rejects a mismatch. .text() never renders — it is bytes, not a DOM.
    function flavor(url, mime) {
      return fetch(url).then(function (r) { if (!r.ok) throw new Error("copy"); return r.text(); })
        .then(function (t) { return new Blob([t], { type: mime }); });
    }
    b.addEventListener("click", function () {
      if (b.disabled) return;
      if (!navigator.clipboard || !window.ClipboardItem) {
        b.textContent = "Unsupported"; setTimeout(function () { b.textContent = label; }, 1400); return;
      }
      b.disabled = true; b.textContent = "Copying…";
      // 🔴 Safari: construct the ClipboardItem SYNCHRONOUSLY inside the gesture, with a Promise<Blob>
      // per flavor. Awaiting a fetch before this loses the user-gesture context and the write fails.
      var item = new ClipboardItem({ "text/html": flavor(htmlUrl, "text/html"), "text/plain": flavor(mdUrl, "text/plain") });
      navigator.clipboard.write([item]).then(
        function () { b.textContent = "Copied"; },
        function () { b.textContent = "Copy failed"; }
      ).finally(function () { setTimeout(function () { b.disabled = false; b.textContent = label; }, 1400); });
    });
  })();
</script>`
    : "";

  const pdfBtn = opts.pdfEnabled ? `<button class="ctl" id="pdf" type="button">PDF</button>` : "";
  // The button fetches the PDF (one render — never a plain link that would re-render on retry),
  // shows a generating state for the cold-launch latency, and turns a 429/failure into a
  // readable message rather than downloading an error blob. This fetch is why the shell's CSP
  // carries connect-src 'self' when PDF is enabled (#50).
  const pdfScript = opts.pdfEnabled
    ? `<script nonce="${nonce}">
  (function () {
    var b = document.getElementById("pdf");
    if (!b) return;
    var url = ${JSON.stringify(pdfHref)}, name = ${JSON.stringify(pdfName)}, label = b.textContent;
    b.addEventListener("click", function () {
      if (b.disabled) return;
      b.disabled = true; b.textContent = "Generating…";
      fetch(url).then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (j) {
            throw new Error((j && j.error) || "Could not generate the PDF.");
          });
        }
        return res.blob();
      }).then(function (blob) {
        var href = URL.createObjectURL(blob), a = document.createElement("a");
        a.href = href; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(href); }, 5000);
      }).catch(function (e) {
        alert(e && e.message ? e.message : "Could not generate the PDF.");
      }).finally(function () {
        b.disabled = false; b.textContent = label;
      });
    });
  })();
</script>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title)}</title>
${unfurlTags(meta, opts)}<style nonce="${nonce}">
${THEME}
  *, *::before, *::after { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: var(--ink); background: var(--paper);
  }
  header {
    display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap;
    padding: .75rem 1.25rem; border-bottom: 1px solid var(--border); background: var(--surface);
  }
  h1 { font-size: 1rem; font-weight: 600; margin: 0; }
  .back { color: var(--accent); text-decoration: none; font-size: .875rem; }
  .back:hover { text-decoration: underline; }
  .controls { margin-left: auto; display: flex; align-items: center; gap: .6rem; }
  .meta { color: var(--muted); font-size: .8125rem; }
  .ctl { font: inherit; font-size: .8125rem; color: var(--accent); background: var(--surface); border: 1px solid var(--border); border-radius: 5px; padding: .15rem .55rem; text-decoration: none; cursor: pointer; }
  .ctl:hover { background: var(--hover); border-color: var(--accent); }
  /* The artifact's own canvas stays WHITE in both schemes, deliberately. A document was authored
     against a light background and we do not restyle its insides (ADR-007) — tinting the frame
     dark would leave the author's black-on-white content sitting in a dark well. */
  iframe { flex: 1 1 auto; width: 100%; border: 0; background: #fff; }
${ATTRIBUTION_CSS}
  /* The mark sits last in the control row, after the buttons — never beside the title. On a narrow
     screen the row wraps and it drops away below, which is the right priority: the client's document
     and its controls come first. */
  @media (max-width: 30rem) { .pv-mark { display: none; } }
</style>
</head>
<body>
<header>
  ${back}
  <h1>${esc(meta.title)}</h1>
  <div class="controls">
    <span class="meta">${esc(new Date(meta.updatedAt).toISOString().slice(0, 10))}</span>
    <a class="ctl" href="${esc(downloadHref)}" download>Download</a>
    ${pdfBtn}
    ${copyBtn}
    ${shareBtn}
    ${attribution(env)}
  </div>
</header>
<iframe
  src="${esc(src)}"
  sandbox="${IFRAME_SANDBOX}"
  referrerpolicy="no-referrer"
  title="${esc(meta.title)}"></iframe>
${shareScript}
${pdfScript}
${copyScript}
</body>
</html>`;

  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      "frame-src 'self'",
      // The PDF button (#50) and the markdown Copy control (#93) both fetch from our own origin —
      // the PDF render, and the two clipboard flavors. Added only when one of them is present, and
      // only to 'self': the artifact is in the iframe (opaque origin) and cannot use this.
      ...(opts.pdfEnabled || canCopyRich ? ["connect-src 'self'"] : []),
      "form-action 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store",
  };

  if (opts.noindex) headers["X-Robots-Tag"] = "noindex, nofollow";

  return new Response(html, { headers });
}

/**
 * The OpenGraph / Twitter Card block — or nothing at all (#210).
 *
 * 🔴 The document's own summary appears at exactly ONE level, `full`. It is the only value here a
 * reader of the card might not be entitled to; everything else is the document's name, its own
 * address, and a constant. Sourcing the `title` level's description from `meta` — the summary, the
 * tags, anything per-document — is the change that turns a `/p/` link pasted into a Slack channel
 * into a disclosure. See `ShellOptions.unfurl` and `SHARED_LINK_DESCRIPTION` before you do it.
 *
 * Every level that unfurls at all emits SOME `og:description`, because Slack builds no card without
 * one (#214). What differs between levels is whether that text came from the document.
 *
 * `twitter:card` is `summary`, not `summary_large_image`: there is no image yet, and claiming the
 * large card without one renders an empty box on the platforms that honor it.
 *
 * Every value goes through `esc()`, same as `<title>` — a title containing a quote would otherwise
 * close the `content="…"` attribute and inject markup into our own trusted shell.
 */
function unfurlTags(meta: DocMeta, opts: ShellOptions): string {
  if (opts.unfurl === "none") return "";

  const tags = [`<meta property="og:title" content="${esc(meta.title)}">`];

  // The document's own summary ONLY at `full`; everywhere else the constant, which says nothing
  // (#214). Never a scraped first paragraph as a fallback — the artifact is hostile (prime directive
  // 4) and its body has no business being lifted into a card that renders on someone else's servers.
  //
  // The `??` matters as much as the ternary: a `/pub/` document with no summary would otherwise emit
  // no description and get no Slack card either — the same bug, on the surface that is allowed to
  // say everything. Every unfurling surface ends up with description text; only its CONTENT differs.
  const description = (opts.unfurl === "full" ? meta.summary : undefined) ?? SHARED_LINK_DESCRIPTION;
  tags.push(`<meta property="og:description" content="${esc(description)}">`);

  tags.push(`<meta property="og:type" content="article">`);
  if (opts.canonicalUrl) {
    tags.push(`<meta property="og:url" content="${esc(opts.canonicalUrl)}">`);
  }

  tags.push(`<meta name="twitter:card" content="summary">`);
  tags.push(`<meta name="twitter:title" content="${esc(meta.title)}">`);
  if (description) {
    tags.push(`<meta name="twitter:description" content="${esc(description)}">`);
  }

  return `${tags.join("\n")}\n`;
}

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

import { mintCapability, verifyCapability } from "./capability.js";
import type { Env } from "./env.js";
import { fingerprint, log } from "./log.js";
import { renderPdf } from "./pdf.js";
import type { DocMeta } from "./store.js";
import { getDoc, getMeta, getRawSource } from "./store.js";

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
 * `/render/{id}?cap={token}` — the artifact bytes, and nothing else.
 *
 * No Access application in front of it. The capability token IS the authorization: it
 * was minted by a shell that had already been through `canView`, it names this one
 * document, and it expires in minutes.
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

  // Raw download: the same capability guard, but the bytes come back as a file, not a render.
  //
  // 🔴 ADR-007. Serving artifact HTML from our origin with `text/html` and no attachment
  // disposition renders hostile markup in our document context — the exact thing the sandbox
  // exists to prevent. `Content-Disposition: attachment` forces a download; `application/
  // octet-stream` + `nosniff` means that even if a disposition were ever dropped, the browser
  // still will not execute it as HTML here. Three independent reasons it cannot render inline.
  const params = new URL(request.url).searchParams;

  if (params.get("download") === "1") {
    const meta = await getMeta(env, id);
    // A markdown doc stores rendered HTML at `doc:` but downloads as the original `.md`
    // (#46) — else the bytes would contradict the `.md` filename `rawFilename` produces.
    // `?? source` covers HTML docs and any pre-#46 markdown that has no `raw:` companion.
    const bytes = meta?.sourceKind === "markdown" ? ((await getRawSource(env, id)) ?? source) : source;
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": contentDisposition(rawFilename(meta, id)),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow",
        "Cache-Control": "private, no-store",
      },
    });
  }

  // Single-page PDF (#50). The capability guard above has already run, so no document reaches
  // the renderer without authorization. The browser binding is optional: a deployment that did
  // not enable Browser Run answers 501, and the shell hides the button, so nothing half-works.
  if (params.get("pdf") === "1") {
    if (!env.BROWSER) {
      return pdfError(501, "PDF export is not enabled on this deployment.");
    }
    try {
      const meta = await getMeta(env, id);
      const pdf = await renderPdf(env.BROWSER, source);
      return new Response(pdf, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": contentDisposition(`${filenameBase(meta, id)}.pdf`),
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "X-Robots-Tag": "noindex, nofollow",
          "Cache-Control": "private, no-store",
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "pdf_render_failed", { request, doc: id, error: message });
      // Free tier is 10 minutes of browser time per day; a burst returns 429. Surface that as
      // its own status so the button can say "try again later" rather than a generic failure.
      const rateLimited = /\b429\b|rate.?limit|too many|quota|exceeded/i.test(message);
      return rateLimited
        ? pdfError(429, "Daily PDF limit reached. Try again later.")
        : pdfError(502, "Could not generate the PDF for this document.");
    }
  }

  return new Response(source, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": docCsp(env),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      // Never let the CDN cache an artifact that a capability token gated.
      "Cache-Control": "private, no-store",
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

export interface ShellOptions {
  /** The verified viewer, or null for an unauthenticated public view. */
  email: string | null;
  /** Where "back" goes. Absent on a `/p/` capability link — there is no collection. */
  backHref?: string;
  backLabel?: string;
  /** `/p/` and `/pub/` must never be indexed. An unguessable URL is not a private one. */
  noindex: boolean;
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

  // The shell's own script/style are nonced. A bug in artifact serving must not be able
  // to degrade the page that holds the capability token.
  const nonce = crypto.randomUUID();
  const src = `/render/${encodeURIComponent(meta.id)}?cap=${encodeURIComponent(cap)}`;
  // The download and PDF both reuse the same capability guard — no second auth path (ADR-007).
  const downloadHref = `${src}&download=1`;
  const pdfHref = `${src}&pdf=1`;
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
<style nonce="${nonce}">
  *, *::before, *::after { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #1e1610; background: #fbf6ec;
  }
  header {
    display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap;
    padding: .75rem 1.25rem; border-bottom: 1px solid #d8cdb0; background: #fff;
  }
  h1 { font-size: 1rem; font-weight: 600; margin: 0; }
  .back { color: #34507a; text-decoration: none; font-size: .875rem; }
  .back:hover { text-decoration: underline; }
  .controls { margin-left: auto; display: flex; align-items: center; gap: .6rem; }
  .meta { color: #7d6b52; font-size: .8125rem; }
  .ctl { font: inherit; font-size: .8125rem; color: #34507a; background: #fff; border: 1px solid #d8cdb0; border-radius: 5px; padding: .15rem .55rem; text-decoration: none; cursor: pointer; }
  .ctl:hover { background: #fbf6ec; }
  iframe { flex: 1 1 auto; width: 100%; border: 0; background: #fff; }
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
    ${shareBtn}
  </div>
</header>
<iframe
  src="${esc(src)}"
  sandbox="${IFRAME_SANDBOX}"
  referrerpolicy="no-referrer"
  title="${esc(meta.title)}"></iframe>
${shareScript}
${pdfScript}
</body>
</html>`;

  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      "frame-src 'self'",
      // Only the PDF button needs to reach our origin (to fetch the render). Added just for it,
      // and only to our own origin — the artifact is in the iframe (opaque origin) and cannot
      // use this. See #50.
      ...(opts.pdfEnabled ? ["connect-src 'self'"] : []),
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

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

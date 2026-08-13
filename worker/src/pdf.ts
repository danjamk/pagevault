import { launch } from "@cloudflare/puppeteer";
import type { Env } from "./env.js";

/**
 * What the render is allowed to fetch (ADR-022).
 *
 * Rendering is permitted; conversation is not. A script may run and draw a chart — it may not open
 * a channel that carries a reply back, which is what `fetch`/`xhr`/`websocket`/`eventsource` are.
 * The residual path, a script constructing an `<img>`, moves only what the artifact already
 * contained into a context that holds nothing else: `setContent` gives the page no origin, so there
 * are no cookies, no storage, no bearer, no Access JWT and no viewer identity here.
 *
 * That asymmetry is the whole decision. The blanket abort this replaces made the PDF disagree with
 * the viewer, which runs remote JavaScript by design (ADR-007) — so the Chart.js document the seed
 * corpus ships to PROVE that exported an empty box.
 */
const RENDERABLE = new Set(["image", "font", "stylesheet", "script"]);

/** A runaway document must not turn one export into a thousand fetches. */
const MAX_REQUESTS = 100;

/**
 * May the render fetch this? Pure, so the policy is testable without a browser — which matters,
 * because the Browser binding does not exist under vitest and this is the security-relevant half.
 *
 * `ownHost` is the deployment's own hostname: the render carries no bearer so it would earn a 401,
 * but a document should not be able to aim the renderer at the API it was published through.
 */
export function mayFetch(url: string, resourceType: string, ownHost?: string): boolean {
  if (!RENDERABLE.has(resourceType)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // unparseable is not a reason to be generous
  }
  // https only. http is downgrade-able and file:/blob: have no business here; data: never reaches
  // the network at all, so it is unaffected by any of this.
  if (parsed.protocol !== "https:") return false;
  if (ownHost && parsed.hostname.toLowerCase() === ownHost.toLowerCase()) return false;
  return true;
}

/** A request the render refused, or one that reached the network and never came back. */
export type BlockedRequest = { url: string; type: string; reason: string };

/**
 * The two shapes a PDF can take (ADR-027).
 *
 * `canvas` is the default and the original behavior: one continuous page sized to the content, so
 * an infographic is never cut mid-element. `paper` is what a document gets when it declares
 * `@page` — it has told us it is paper, and we take it at its word.
 */
export type PdfMode = "canvas" | "paper";

/**
 * The `page.pdf()` options for a mode. Pure, so the geometry decision is pinned by tests — the
 * Browser binding does not exist under vitest, so this is the only half that can be.
 *
 * `preferCSSPageSize` is unconditional on purpose. When the document declares no `@page` size it
 * falls back to `width`/`height`, which is measured canvas mode unchanged — verified against a
 * real Chromium, not inferred from the docs.
 *
 * Margins stay at zero in both modes and are NOT read out of the document. Chromium ignores the
 * margin parameters entirely whenever `@page { margin }` is declared — a deliberately absurd 2in
 * override changed nothing — so a declared margin already wins. Where nothing is declared, zero
 * keeps full-bleed reachable; a default margin invented here would break a full-bleed page in a
 * way its author could not undo.
 */
export function pdfOptions(mode: PdfMode, dims: { w: number; h: number }) {
  return {
    // Omitted in paper mode so nothing competes with the declared size. `preferCSSPageSize` would
    // win regardless, but a width the document never asked for has no business in the call.
    ...(mode === "canvas" ? { width: `${dims.w}px`, height: `${dims.h}px` } : {}),
    preferCSSPageSize: true,
    printBackground: true,
    margin: { top: "0", right: "0", bottom: "0", left: "0" },
  };
}

/**
 * Render an HTML artifact to a PDF — one continuous page sized to its content, unless the document
 * declares `@page`, in which case it gets the paper it asked for (ADR-027).
 *
 * 🔴 Prime directive #4: the artifact is hostile. This runs it in a REAL headless browser — not
 * the sandboxed iframe — so the sandbox CSP does not apply. The wall is `mayFetch` above: the
 * render may load what it needs to LOOK right (images, fonts, stylesheets, scripts) and may not
 * open a channel that carries a reply (fetch, xhr, websocket, eventsource). See ADR-022 for why
 * that line, and why the previous blanket abort was the wrong one — it made the PDF disagree with
 * the viewer, which runs remote JavaScript by design.
 *
 * The session is created per render and always torn down in `finally`.
 *
 * Ported from the infographic-export skill's render.mjs, with the Cloudflare/Puppeteer deltas:
 * `emulateMediaType` (not Playwright's `emulateMedia`) and px-string dimensions (a bare number is
 * inches). No `format` in either mode — canvas sizes the paper to the content so nothing paginates
 * mid-element, and paper takes its size from the document's own `@page`.
 */
export async function renderPdf(
  binding: NonNullable<Env["BROWSER"]>,
  html: string,
  ownHost?: string,
): Promise<{ pdf: Uint8Array; blocked: BlockedRequest[] }> {
  const blocked: BlockedRequest[] = [];
  const browser = await launch(binding);
  try {
    const page = await browser.newPage();
    // A desktop viewport, matching the skill this was ported from. Puppeteer's default is 800x600,
    // which lands a responsive document on its tablet breakpoint — the PDF then disagrees with the
    // viewer, which is the divergence ADR-022 exists to close. Paper mode lays out at the page
    // width and ignores this; canvas mode measures against it.
    //
    // One more Cloudflare/Puppeteer delta: `newPage()` takes no options here, so the viewport is
    // set on the page rather than passed at construction the way the Playwright original does.
    await page.setViewport({ width: 1280, height: 900 });

    // Allowlist, not a blanket abort (ADR-022). What is refused is collected so the export can say
    // which host did not load — the original complaint was a PDF with holes and no explanation.
    await page.setRequestInterception(true);
    let requests = 0;
    page.on("request", (req) => {
      const type = typeof req.resourceType === "function" ? req.resourceType() : "other";
      const url = req.url();
      const overBudget = ++requests > MAX_REQUESTS;
      if (!overBudget && mayFetch(url, type, ownHost)) {
        void req.continue().catch(() => {});
        return;
      }
      blocked.push({ url, type, reason: overBudget ? "too many requests" : "not permitted" });
      void req.abort().catch(() => {});
    });
    page.on("requestfailed", (req) => {
      // Reached the network and did not come back — a dead CDN, a timeout, a 404. Distinct from
      // "we refused it", and just as worth naming.
      const url = req.url();
      if (!blocked.some((b) => b.url === url)) blocked.push({ url, type: "", reason: "did not load" });
    });

    await page.setContent(html, { waitUntil: "load" });

    // Does the document declare its own paper? (ADR-027.) The walk RECURSES: an `@page` nested in
    // `@media print` still drives the paper in Chromium, but a flat pass over `sheet.cssRules`
    // finds nothing — which would leave us rendering screen styles onto the document's own paper,
    // the exact hybrid this is meant to avoid. `cssRules` throws on a cross-origin stylesheet, so
    // each sheet is guarded; a missed declaration degrades to canvas, never to an error.
    const declaresPaper = await page
      .evaluate(() => {
        const doc = (globalThis as unknown as { document: { styleSheets: ArrayLike<unknown> } }).document;
        let found = false;
        const walk = (rules: ArrayLike<unknown> | undefined) => {
          for (const rule of Array.from(rules ?? [])) {
            const r = rule as { constructor?: { name?: string }; style?: { getPropertyValue(p: string): string }; cssText?: string; cssRules?: ArrayLike<unknown> };
            if (r.constructor?.name === "CSSPageRule") {
              // `size` is a @page-only property. Chrome does expose it on the rule's style, but
              // cssText is the belt-and-braces read — this cannot be retried on a deploy cycle.
              // Anchored so `font-size:` inside the same rule is not read as a paper declaration —
              // `\bsize` would match it, because the hyphen is a word boundary.
              const size = r.style?.getPropertyValue("size") ?? "";
              if (size !== "" || /(^|[;{\s])size\s*:/.test(r.cssText ?? "")) found = true;
            }
            if (r.cssRules) walk(r.cssRules); // @media, @supports — grouping rules nest
          }
        };
        for (const sheet of Array.from(doc.styleSheets)) {
          try {
            walk((sheet as { cssRules?: ArrayLike<unknown> }).cssRules);
          } catch {
            // cross-origin stylesheet — unreadable, not fatal
          }
        }
        return found;
      })
      .catch(() => false);
    const mode: PdfMode = declaresPaper ? "paper" : "canvas";

    // Canvas keeps screen styles: an artifact's `@media print` rules would otherwise hijack an
    // output it never intended to be paper. A document that declared `@page` DID intend it, and
    // its print rules are how it expects to fit — honoring the paper while suppressing them is a
    // hybrid neither the author nor the viewer asked for.
    await page.emulateMediaType(mode === "paper" ? "print" : "screen");
    // These callbacks run in the browser, not the Worker — the Worker has no DOM lib (by
    // design), so `document` is reached through a cast rather than pulling browser globals in.
    //
    // Settle web fonts and one tick of async layout before measuring, or the height is read
    // mid-layout. Returns undefined (serializable); a throw inside is swallowed.
    await page
      .evaluate(async () => {
        const doc = (globalThis as { document?: { fonts?: { ready?: Promise<unknown> } } }).document;
        try {
          await doc?.fonts?.ready;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 300));
      })
      .catch(() => {});

    const dims = await page.evaluate(() => {
      const el = (
        globalThis as unknown as { document: { documentElement: { scrollWidth: number; scrollHeight: number } } }
      ).document.documentElement;
      return { w: el.scrollWidth, h: el.scrollHeight };
    });

    const pdf = await page.pdf(pdfOptions(mode, dims));
    return { pdf, blocked };
  } finally {
    await browser.close();
  }
}

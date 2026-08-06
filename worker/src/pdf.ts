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
 * Render an HTML artifact to a single continuous-page PDF, sized to its content.
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
 * `emulateMediaType` (not Playwright's `emulateMedia`), px-string dimensions (a bare number is
 * inches), and NO `format` so the custom width/height win — one page, no pagination that would
 * cut a chart or infographic mid-element.
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
    // The artifact's own `@media print` rules must not hijack the output.
    await page.emulateMediaType("screen");
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

    const pdf = await page.pdf({
      width: `${dims.w}px`,
      height: `${dims.h}px`,
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
    return { pdf, blocked };
  } finally {
    await browser.close();
  }
}

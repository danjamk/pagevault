import { launch } from "@cloudflare/puppeteer";
import type { Env } from "./env.js";

/**
 * Render a self-contained HTML artifact to a single continuous-page PDF, sized to its content.
 *
 * 🔴 Prime directive #4: the artifact is hostile. This runs it in a REAL headless browser — not
 * the sandboxed iframe — so the sandbox CSP does not apply here. The one wall between a malicious
 * artifact and the open internet is request interception: every outbound request is aborted, so a
 * self-contained artifact renders and a phone-home (beacon, exfiltration, SSRF probe) cannot leave
 * the browser. The session is created per render and always torn down in `finally`.
 *
 * Ported from the infographic-export skill's render.mjs, with the Cloudflare/Puppeteer deltas:
 * `emulateMediaType` (not Playwright's `emulateMedia`), px-string dimensions (a bare number is
 * inches), and NO `format` so the custom width/height win — one page, no pagination that would
 * cut a chart or infographic mid-element.
 */
export async function renderPdf(binding: NonNullable<Env["BROWSER"]>, html: string): Promise<Uint8Array> {
  const browser = await launch(binding);
  try {
    const page = await browser.newPage();

    // Kill the network. setContent needs none for an inlined artifact; anything the artifact
    // tries to fetch is aborted before it leaves the browser. This is the security property.
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      void req.abort().catch(() => {});
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

    return await page.pdf({
      width: `${dims.w}px`,
      height: `${dims.h}px`,
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
  } finally {
    await browser.close();
  }
}

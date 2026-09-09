import { connect, launch, limits, sessions } from "@cloudflare/puppeteer";
import type { Env } from "./env.js";

/**
 * 🔴 We do NOT hold browsers open between exports, and that is a decision, not an omission (#207).
 *
 * Browser Run meters two different things, and they are scarce in opposite directions here.
 * ACQUIRING a browser is rate-limited — Workers Free allows 3 concurrent and only a few new
 * instances a minute, which is what refused a reader who clicked PDF twice. Browser TIME is
 * capped at 10 minutes a day, and an idle browser spends it at exactly the same rate as a
 * working one.
 *
 * `keep_alive` trades the second for the first, which is backwards for this product. PageVault
 * traffic is sparse — a client opens a document now and then — so a 60s keep-alive on a
 * once-an-hour export costs 63s per PDF and exhausts the day in about nine of them. At ~3s a
 * render and no idling, the same budget covers roughly two hundred. Every 429 recorded on #207
 * happened with most of the day's minutes still unspent.
 *
 * So bursts are absorbed by RETRYING (reconnect to a live session, else a short backoff), never
 * by hoarding. If you are about to add `keep_alive`, work out the cost at this deployment's real
 * export rate first.
 */

/** How long to wait before the one retry, when Browser Run does not tell us. */
const RETRY_BACKOFF_MS = 1_200;

/** Never sleep longer than this on a retry, whatever the API reports. A reader is waiting. */
const MAX_BACKOFF_MS = 5_000;

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
 * Why a render could not start (#207).
 *
 * - `busy` — no browser available *right now*. Concurrency, or the new-instance rate limit.
 *   Clears in about a second, and the reader should be told to try again in a moment.
 * - `exhausted` — the account's daily browser-time allocation is spent. Clears tomorrow.
 * - `failed` — anything else. Not a capacity problem.
 *
 * Telling the first two apart is the whole point. Reporting `busy` as `exhausted` sends a client
 * away for a day over a condition that resolves before they finish reading the sentence.
 */
export type RenderFailure = "busy" | "exhausted" | "failed";

/** What `limits()` tells us, narrowed to the fields that decide the question. */
export interface BrowserLimits {
  activeSessions?: Array<{ id: string }>;
  maxConcurrentSessions?: number;
  allowedBrowserAcquisitions?: number;
  timeUntilNextAllowedBrowserAcquisition?: number;
}

/**
 * Anything longer than this until the next allowed acquisition is a daily budget, not a queue.
 *
 * The concurrency and rate-limit cases clear in seconds. An exhausted daily allocation reports a
 * wait measured in hours, because it is really "tomorrow". Five minutes sits far outside the first
 * and far below the second, so neither has to be recognised by name.
 */
const EXHAUSTED_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Classify a failed render. Pure, so the decision is pinned by tests — the Browser binding does not
 * exist under vitest, and this is the half that decides what a client is told.
 *
 * `limits` is the primary signal because it is structured. The message is a fallback for when
 * `limits()` itself could not be reached: the binding wraps failures as
 * `Unable to create new browser: code: 429: message: …`, and 🔴 nothing here should depend on the
 * wording of that trailing text — it is Cloudflare's to change, and we have never seen both
 * variants of it. Only the status code is relied on, and only when the structured answer is absent.
 */
export function classifyRenderFailure(limits: BrowserLimits | null, message: string): RenderFailure {
  if (limits) {
    const wait = limits.timeUntilNextAllowedBrowserAcquisition ?? 0;
    // A long wait is the daily allocation. Checked first: when the budget is gone, the account is
    // also at zero acquisitions, so the cheaper `busy` test below would match it too.
    if (wait >= EXHAUSTED_THRESHOLD_MS) return "exhausted";

    const active = limits.activeSessions?.length ?? 0;
    const max = limits.maxConcurrentSessions ?? 0;
    if (max > 0 && active >= max) return "busy";
    if ((limits.allowedBrowserAcquisitions ?? 1) <= 0) return "busy";
  }

  // No structured answer. A 429 is a capacity refusal of some kind; without `limits()` we cannot
  // say which, and `busy` is the safer guess — it asks the reader to wait a moment rather than
  // telling them, possibly falsely, that their day is over.
  if (/\bcode:\s*429\b|\b429\b|rate.?limit|too many/i.test(message)) return "busy";

  return "failed";
}

/**
 * How long to wait before the single retry.
 *
 * Browser Run reports when the next acquisition is allowed, so use its number rather than guessing
 * — but cap it: a reader is watching a "Generating…" button, and a wait longer than a few seconds
 * is worse than an honest "busy, try again in a moment". Past the cap the condition is not really
 * transient, and holding the request open only moves the same failure later.
 */
export function retryDelayMs(limits: BrowserLimits | null): number {
  const reported = limits?.timeUntilNextAllowedBrowserAcquisition ?? 0;
  return Math.min(reported > 0 ? reported : RETRY_BACKOFF_MS, MAX_BACKOFF_MS);
}

/** Ask Browser Run what the account's limits are. Null if the call itself fails — never throws. */
export async function readLimits(binding: NonNullable<Env["BROWSER"]>): Promise<BrowserLimits | null> {
  try {
    return (await limits(binding)) as BrowserLimits;
  } catch {
    return null;
  }
}

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
  const { browser, reused } = await acquireBrowser(binding);
  // 🔴 Its OWN browser context, always, and closed before the browser is (#207, ADR-022).
  //
  // On the `reused` path this render shares a browser process with another one already in flight,
  // and ADR-022's argument for tolerating the `<img>` exfiltration path is that `setContent` gives
  // the page no origin, so the render "holds nothing else". A shared default context would make
  // that false — the other document's cookies, cache and storage would be right there. A browser
  // context does not share any of them, which keeps the ADR's premise true whichever path we took.
  //
  // Created unconditionally rather than only when reusing: a render must not behave one way in the
  // common case and another under load, and this is the branch nobody would think to test.
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
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
    // Close our own context first, so this render's storage goes away even on the reused path
    // where the browser itself must survive.
    await context.close().catch(() => {});
    // 🔴 A browser we JOINED is not ours to close — the render that owns it is still using it.
    // `disconnect` drops our devtools connection and leaves it running; `close` would kill a
    // colleague's render mid-page. A browser we launched is ours, and closing it returns the
    // concurrency slot and stops billing browser time immediately (see the keep_alive note above).
    if (reused) {
      await browser.disconnect().catch(() => {});
    } else {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Get a browser to render in, preferring one that is already up.
 *
 * Acquiring is the rate-limited act, so a session that already exists and has no worker attached is
 * free in the sense that matters. `connect()` can lose a race — two renders can see the same idle
 * session and one will be told it is in use — so a failure here is ordinary, not exceptional, and
 * falls through to a launch.
 */
async function acquireBrowser(
  binding: NonNullable<Env["BROWSER"]>,
): Promise<{ browser: Awaited<ReturnType<typeof launch>>; reused: boolean }> {
  try {
    const live = await sessions(binding);
    // No `connectionId` means no worker is driving it. Anything else is somebody's render.
    const free = live.find((s) => !s.connectionId);
    if (free) {
      return { browser: await connect(binding, free.sessionId), reused: true };
    }
  } catch {
    // `sessions()` is an optimisation. If it fails, launch — do not fail the export over it.
  }

  return { browser: await launch(binding), reused: false };
}

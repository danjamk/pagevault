import { describe, expect, it } from "vitest";
import { type BrowserLimits, classifyRenderFailure, mayFetch, pdfOptions, retryDelayMs } from "../src/pdf.js";

/**
 * 🔴 The PDF render's fetch policy (ADR-022).
 *
 * The render itself needs a real browser, which vitest-pool-workers has no binding for — but the
 * security-relevant half is a pure predicate, so it is pinned here. The rule it encodes:
 * **rendering is permitted, conversation is not.**
 */

const OWN = "share.example.com";

describe("what the render may load", () => {
  it("allows what a page needs to LOOK right", () => {
    // The viewer's iframe already runs all of this (ADR-007) — the seed ships a Chart.js document
    // to prove it. A PDF that refused them disagreed with the viewer, which was the bug.
    for (const type of ["image", "font", "stylesheet", "script"]) {
      expect(mayFetch("https://cdn.example.com/a", type, OWN), type).toBe(true);
    }
  });

  it("🔴 refuses every channel that could carry a reply back", () => {
    // This is the line the whole ADR turns on. A script may draw a chart; it may not phone home.
    for (const type of ["xhr", "fetch", "websocket", "eventsource", "media", "manifest", "other", "document"]) {
      expect(mayFetch("https://cdn.example.com/a", type, OWN), type).toBe(false);
    }
  });

  it("🔴 https only", () => {
    // http is downgrade-able; file:/blob: have no business in a render. data: never reaches the
    // network at all, so an inlined image is unaffected by any of this.
    expect(mayFetch("http://cdn.example.com/a.png", "image", OWN)).toBe(false);
    expect(mayFetch("file:///etc/passwd", "image", OWN)).toBe(false);
    expect(mayFetch("blob:https://cdn.example.com/x", "image", OWN)).toBe(false);
  });

  it("🔴 never the deployment's own host", () => {
    // The render carries no bearer, so it would earn a 401 — but a document must not be able to
    // aim the renderer at the API it was published through.
    expect(mayFetch(`https://${OWN}/api/docs`, "image", OWN)).toBe(false);
    expect(mayFetch(`https://${OWN.toUpperCase()}/api/docs`, "image", OWN)).toBe(false);
    expect(mayFetch(`https://${OWN}/v/acme`, "script", OWN)).toBe(false);
    // A different host that merely contains the name is not the same host.
    expect(mayFetch(`https://evil.com/?x=${OWN}`, "image", OWN)).toBe(true);
    expect(mayFetch(`https://not-${OWN}/a.png`, "image", OWN)).toBe(true);
  });

  it("an unparseable URL is refused rather than given the benefit of the doubt", () => {
    expect(mayFetch("not a url", "image", OWN)).toBe(false);
    expect(mayFetch("", "image", OWN)).toBe(false);
  });

  it("works with no own-host supplied", () => {
    // `ownHost` is optional so the predicate stays usable from a context that does not know it;
    // the type gate still applies.
    expect(mayFetch("https://cdn.example.com/a.png", "image")).toBe(true);
    expect(mayFetch("https://cdn.example.com/a", "fetch")).toBe(false);
  });
});

/**
 * The paper geometry (ADR-027, #206).
 *
 * Same constraint as the fetch policy above: no Browser binding under vitest, so the pure decision
 * is what gets pinned. The measured half was verified against a real Chromium — the numbers in
 * these comments are observed output, not intent.
 */
const DIMS = { w: 1280, h: 1500 };

describe("what paper the PDF lands on", () => {
  it("canvas mode keeps the content-sized page", () => {
    // The original behavior and still the default: one continuous page, so an infographic is not
    // paginated mid-element. 1280x1500px came out 960 x 1125.12pt — px x 0.75, no scaling.
    const opts = pdfOptions("canvas", DIMS);
    expect(opts.width).toBe("1280px");
    expect(opts.height).toBe("1500px");
  });

  it("paper mode names no size, so the document's @page is uncontested", () => {
    const opts = pdfOptions("paper", DIMS);
    expect(opts.width).toBeUndefined();
    expect(opts.height).toBeUndefined();
  });

  it("🔴 preferCSSPageSize is set in BOTH modes", () => {
    // Load-bearing: it is what makes paper mode work, and in canvas mode it provably falls back to
    // width/height — a document with no @page measured 1280x1500 still came out 960 x 1125.12pt.
    // If this ever became paper-only, canvas would depend on the detector being perfect instead of
    // on a fallback that cannot miss.
    expect(pdfOptions("paper", DIMS).preferCSSPageSize).toBe(true);
    expect(pdfOptions("canvas", DIMS).preferCSSPageSize).toBe(true);
  });

  it("backgrounds are painted in both modes", () => {
    // A report's tinted panels are the content, not decoration. The seed corpus depends on this.
    expect(pdfOptions("paper", DIMS).printBackground).toBe(true);
    expect(pdfOptions("canvas", DIMS).printBackground).toBe(true);
  });

  it("margins stay at zero and are never read out of the document", () => {
    // Chromium ignores these whenever `@page { margin }` is declared — a deliberate 2in override
    // changed the output not at all — so a declared margin already wins and extracting it would be
    // dead code. Where nothing is declared, zero keeps full-bleed reachable; a default invented
    // here would put a border on a full-bleed page its author could not remove.
    for (const mode of ["paper", "canvas"] as const) {
      expect(pdfOptions(mode, DIMS).margin, mode).toEqual({ top: "0", right: "0", bottom: "0", left: "0" });
    }
  });

  it("never sets `format` — neither mode wants a paper we chose", () => {
    // Letter as a fallback would paginate every infographic, which is what canvas mode exists to
    // prevent. It was the originally proposed fix and it is the wrong one.
    for (const mode of ["paper", "canvas"] as const) {
      expect(pdfOptions(mode, DIMS), mode).not.toHaveProperty("format");
    }
  });
});

/**
 * 🔴 Busy is not exhausted (#207).
 *
 * The whole issue is one message that told a client to come back tomorrow for a condition that
 * clears in about a second. Like `mayFetch`, this is a pure function over data, so the decision a
 * reader actually sees is pinned without a Browser binding.
 */
describe("why a render could not start", () => {
  const limits = (over: Partial<BrowserLimits> = {}): BrowserLimits => ({
    activeSessions: [],
    maxConcurrentSessions: 3,
    allowedBrowserAcquisitions: 3,
    timeUntilNextAllowedBrowserAcquisition: 0,
    ...over,
  });

  const REFUSED = "Unable to create new browser: code: 429: message: too many requests";

  it("🔴 reads the concurrency ceiling as busy, not as an exhausted budget", () => {
    // Workers Free allows 3 concurrent. All three in use is the reported bug: a reader opened two
    // documents, or clicked twice, and was told their day was over.
    const full = limits({ activeSessions: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    expect(classifyRenderFailure(full, REFUSED)).toBe("busy");
  });

  it("reads a spent acquisition allowance as busy", () => {
    expect(classifyRenderFailure(limits({ allowedBrowserAcquisitions: 0 }), REFUSED)).toBe("busy");
  });

  it("🔴 reads a long wait as the daily budget — the one case that really is 'tomorrow'", () => {
    const spent = limits({ allowedBrowserAcquisitions: 0, timeUntilNextAllowedBrowserAcquisition: 6 * 60 * 60 * 1000 });
    expect(classifyRenderFailure(spent, REFUSED)).toBe("exhausted");
  });

  it("🔴 a short wait is busy even at zero acquisitions — both conditions report zero", () => {
    // The ordering that makes the two separable. An exhausted account and a rate-limited one both
    // report no acquisitions left; only the time until the next one tells them apart.
    const queued = limits({ allowedBrowserAcquisitions: 0, timeUntilNextAllowedBrowserAcquisition: 900 });
    expect(classifyRenderFailure(queued, REFUSED)).toBe("busy");
  });

  it("a healthy account with an unrelated failure is neither", () => {
    // A malformed document or a crashed page is not a capacity problem and must not be reported
    // as one — telling a reader to wait would send them round a loop that never resolves.
    expect(classifyRenderFailure(limits(), "Navigation timeout of 30000 ms exceeded")).toBe("failed");
  });

  it("🔴 falls back to busy — never to 'come back tomorrow' — when limits() is unreachable", () => {
    // Without the structured answer we cannot tell the two apart, and the costly mistake runs one
    // way: asking someone to wait a moment is recoverable, writing off their day is not.
    expect(classifyRenderFailure(null, REFUSED)).toBe("busy");
    expect(classifyRenderFailure(null, "Unable to create new browser: code: 429: message: anything")).toBe("busy");
  });

  it("does not invent a capacity problem from an unrecognised message", () => {
    expect(classifyRenderFailure(null, "Protocol error (Page.printToPDF): Target closed")).toBe("failed");
  });

  it("🔴 does not depend on the wording Cloudflare puts after the status code", () => {
    // The trailing text is Cloudflare's to change and we have never seen both variants. Only the
    // code is relied on; if this starts failing, someone has coupled us to prose we do not own.
    for (const text of ["message: too many requests", "message: ", "message: something new"]) {
      expect(classifyRenderFailure(null, `Unable to create new browser: code: 429: ${text}`), text).toBe("busy");
    }
  });
});

describe("how long to wait before the one retry", () => {
  it("uses the time Browser Run reports", () => {
    expect(retryDelayMs({ timeUntilNextAllowedBrowserAcquisition: 900 })).toBe(900);
  });

  it("falls back to a fixed backoff when nothing is reported", () => {
    expect(retryDelayMs(null)).toBeGreaterThan(0);
    expect(retryDelayMs({ timeUntilNextAllowedBrowserAcquisition: 0 })).toBe(retryDelayMs(null));
  });

  it("🔴 caps the wait — a reader is watching a button, not a queue", () => {
    // Without the cap, an exhausted-budget number (hours) would hold the request open until the
    // Worker's own limit killed it, turning a clear message into a hang.
    expect(retryDelayMs({ timeUntilNextAllowedBrowserAcquisition: 6 * 60 * 60 * 1000 })).toBeLessThanOrEqual(5_000);
  });
});

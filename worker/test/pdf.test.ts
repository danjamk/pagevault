import { describe, expect, it } from "vitest";
import { mayFetch, pdfOptions } from "../src/pdf.js";

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

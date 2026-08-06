import { describe, expect, it } from "vitest";
import { mayFetch } from "../src/pdf.js";

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

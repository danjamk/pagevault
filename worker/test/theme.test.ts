import { describe, expect, it } from "vitest";
import { PRODUCT_URL, attribution, showBranding } from "../src/theme.js";

// The attribution mark is the one piece of PageVault that appears on a *client's* screen for
// PageVault's benefit rather than theirs. Two properties have to hold, and neither is obvious from
// reading the call sites: an operator who never touches the setting still shows it, and one who
// turns it off is not partially opted back in by a surface that forgot to check.

describe("showBranding", () => {
  it("defaults to on when the var is unset, blank, or whitespace", () => {
    // Inverted from AUTH_MODE deliberately. There, a missing var had to fail CLOSED. Here the
    // failure that matters is silently stripping attribution from a deployment that never asked to,
    // so anything that isn't an explicit "off" shows the mark.
    expect(showBranding({})).toBe(true);
    expect(showBranding({ PAGEVAULT_BRANDING: "" })).toBe(true);
    expect(showBranding({ PAGEVAULT_BRANDING: "   " })).toBe(true);
  });

  it("is off only for the literal word, in any case or padding", () => {
    for (const off of ["off", "OFF", "Off", " off "]) {
      expect(showBranding({ PAGEVAULT_BRANDING: off })).toBe(false);
    }
  });

  it("treats every other value as on, including ones that look falsy", () => {
    // A forker who guesses at the syntax gets the visible default rather than a silent removal
    // they did not verify. "false" and "0" are the likely guesses, and they are not the API.
    for (const on of ["on", "true", "false", "0", "no", "yes", "1"]) {
      expect(showBranding({ PAGEVAULT_BRANDING: on })).toBe(true);
    }
  });
});

describe("attribution", () => {
  it("points at the product page, opens safely, and asks for no SEO credit", () => {
    const html = attribution({});
    expect(html).toContain(PRODUCT_URL);
    expect(html).toContain("Powered by PageVault");
    // A client portal is not a backlink farm, and a new tab must not hand the opener a window ref.
    expect(html).toContain('rel="noopener nofollow"');
    expect(html).toContain('target="_blank"');
  });

  it("renders nothing at all when branding is off — not a hidden element", () => {
    // An empty string, not a display:none node: an operator who turned it off should not find
    // PageVault's name sitting in the source of a document they hand a client.
    expect(attribution({ PAGEVAULT_BRANDING: "off" })).toBe("");
  });
});

//
// Pinning documents to the top of a portal (#142).
//
// The rules live in three pure functions — `normalizePinned` (what a valid list is),
// `repinRenamed` (how a rename carries a pin), and `partitionPinned` (what the page renders) —
// precisely so they can be pinned down here without a KV round-trip per case. The end-to-end
// behaviour through /api and the rendered page is covered in portal-api.test.ts and portal.test.ts.
//
import { describe, expect, it } from "vitest";
import { MAX_PINNED, normalizePinned, repinRenamed, type DocSummary } from "../src/store.js";
import { partitionPinned } from "../src/portal.js";

/** A DocSummary with only the fields pinning actually reads. */
const doc = (name: string, id = name): DocSummary => ({
  id,
  portal: "acme",
  name,
  title: name.replace(/\.\w+$/, ""),
  ownerOnly: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  bytes: 10,
});

describe("normalizePinned — what a valid pin list is", () => {
  it("keeps the operator's order and never sorts it", () => {
    // The order IS the argument the operator is making. Sorting it would be answering a
    // different question than the one they asked.
    expect(normalizePinned(["c.html", "a.html", "b.html"])).toEqual(["c.html", "a.html", "b.html"]);
  });

  it("caps the list, because a page with twenty featured items features nothing", () => {
    const many = Array.from({ length: MAX_PINNED + 5 }, (_, i) => `d${i}.html`);
    const out = normalizePinned(many);
    expect(out).toHaveLength(MAX_PINNED);
    expect(out[0]).toBe("d0.html");
    expect(out.at(-1)).toBe(`d${MAX_PINNED - 1}.html`);
  });

  it("🔴 de-duplicates case-insensitively, matching how identity hashes", () => {
    // `docId` lowercases the filename (ADR-017), so `Report.html` and `report.html` are ONE
    // document. Storing both would pin it twice and silently spend a slot on nothing.
    expect(normalizePinned(["Report.html", "report.html", "b.html"])).toEqual(["Report.html", "b.html"]);
  });

  it("trims, and drops blanks and non-strings rather than storing them", () => {
    expect(normalizePinned(["  a.html  ", "", "   ", null, 7, "b.html"])).toEqual(["a.html", "b.html"]);
  });

  it("treats anything that is not an array as an empty list", () => {
    for (const bad of [undefined, null, "a.html", 42, {}]) {
      expect(normalizePinned(bad)).toEqual([]);
    }
  });
});

describe("repinRenamed — a pin survives a correction (ADR-020)", () => {
  it("🔴 rewrites the renamed filename in place, keeping its position", () => {
    // Without this the document drops out of the pinned block on a typo fix — silently, because
    // an unknown name is skipped at render by design.
    expect(repinRenamed(["a.html", "typo.html", "c.html"], "typo.html", "fixed.html")).toEqual([
      "a.html",
      "fixed.html",
      "c.html",
    ]);
  });

  it("matches case-insensitively, like identity does", () => {
    expect(repinRenamed(["Typo.html"], "typo.html", "fixed.html")).toEqual(["fixed.html"]);
  });

  it("returns null when there is nothing to do, so the caller skips the write", () => {
    // A rename costs 9–11 writes already. Not spending a twelfth on a portal with no pins, or on
    // a document that was not pinned, is the difference between noise and waste.
    expect(repinRenamed(undefined, "a.html", "b.html")).toBeNull();
    expect(repinRenamed([], "a.html", "b.html")).toBeNull();
    expect(repinRenamed(["other.html"], "a.html", "b.html")).toBeNull();
  });

  it("does not create a duplicate when renaming onto an already-pinned name", () => {
    // Renaming `b.html` → `a.html` where BOTH are pinned. One document now, so one entry.
    expect(repinRenamed(["a.html", "b.html"], "b.html", "a.html")).toEqual(["a.html"]);
  });
});

describe("partitionPinned — what the page actually renders", () => {
  const docs = [doc("c.html"), doc("b.html"), doc("a.html")];

  it("lifts pinned documents out in stored order, leaving the rest alone", () => {
    const { pins, rest } = partitionPinned(docs, ["a.html", "c.html"]);
    expect(pins.map((d) => d.name)).toEqual(["a.html", "c.html"]);
    expect(rest.map((d) => d.name)).toEqual(["b.html"]);
  });

  it("🔴 never renders a document twice", () => {
    const { pins, rest } = partitionPinned(docs, ["a.html"]);
    const all = [...pins, ...rest].map((d) => d.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(docs.length);
  });

  it("🔴 skips a name no document answers to — self-healing, with no cleanup write", () => {
    // A pinned document that was deleted, or renamed without the list being patched. The page must
    // not blank, must not render a dead row, and must not need a write on a READ path to recover.
    const { pins, rest } = partitionPinned(docs, ["gone.html", "b.html", "also-gone.html"]);
    expect(pins.map((d) => d.name)).toEqual(["b.html"]);
    expect(rest.map((d) => d.name)).toEqual(["c.html", "a.html"]);
  });

  it("is the old behaviour exactly when nothing is pinned", () => {
    // The empty state of this feature is the page as it rendered before the feature existed —
    // which is what makes it safe to ship onto live client portals.
    for (const empty of [undefined, []]) {
      const { pins, rest } = partitionPinned(docs, empty);
      expect(pins).toEqual([]);
      expect(rest).toEqual(docs);
    }
  });

  it("matches filenames case-insensitively", () => {
    expect(partitionPinned(docs, ["A.HTML"]).pins.map((d) => d.name)).toEqual(["a.html"]);
  });

  it("🔴 cannot surface a draft to a client, because it never sees one", () => {
    // The `ownerOnly` filter runs BEFORE this. Relying on that ordering rather than re-checking
    // here is deliberate: two rules that both decide who sees a draft is how they come to disagree.
    const clientVisible = docs; // already filtered upstream
    const { pins } = partitionPinned(clientVisible, ["draft.html", "a.html"]);
    expect(pins.map((d) => d.name)).toEqual(["a.html"]);
  });
});

# ADR-027 — A declared `@page` is the document choosing paper

**Status:** Accepted
**Date:** 2026-08-12
**Refines:** ADR-022 (the PDF is a capture of the viewer) for documents that declare print intent
**Closes:** #206

## Context

`renderPdf` measures the document and makes that measurement the paper:

```js
const dims = await page.evaluate(/* scrollWidth, scrollHeight */);
const pdf = await page.pdf({ width: `${dims.w}px`, height: `${dims.h}px`, ... });
```

One continuous page, sized to the content, so a chart or an infographic is never cut mid-element.
For the artifact PageVault was built to publish, that is right, and it is not an accident — it is
the behavior ported from the `infographic-export` skill.

It is wrong for a document that says it is paper. A report declaring

```css
@page { size: letter; margin: 0.5in 0.55in }
```

exported at **600 × 1633.92 pt — a 22.7in sheet, across three pages.** The height is the document's
own scroll height; the width is 800px, Puppeteer's default viewport, converted at 0.75 pt/px. The
content laid out at roughly Letter height and then sat inside a sheet nearly twice that, with dead
bands above and below it on every page. Printing the same file from Chrome locally produced the two
correct Letter pages, which is what made the defect legible: **the document had already said what
it wanted, in the standard way, and the exporter overrode it.**

### What the measurements showed

The geometry was settled against a real Chromium before any Worker code was written, because the
Browser binding does not exist under vitest and the alternative is discovering this on deploy
cycles. Four results shaped the decision:

| Case | Result |
| --- | --- |
| No `@page`, with `preferCSSPageSize: true` | 960 × 1125.12 pt — exactly the measured 1280 × 1500 px. **The fallback holds.** |
| `@page { size: letter; margin: .5in .55in }` | 612 × 792, two pages, margins present |
| A deliberate `margin: 2in` passed alongside a declared CSS margin | **Ignored.** The CSS margin won. |
| `@page` nested inside `@media print` | Honored by Chromium; a flat CSSOM walk finds nothing |

The third result is the one that removed code rather than adding it. Puppeteer always sends explicit
margin parameters to `Page.printToPDF` — an unset `margin` is coerced to zero on all four sides — so
the obvious conclusion is that a declared `@page` margin is unreachable and must be parsed out of the
document and passed back. That conclusion is wrong. Chromium ignores the parameters entirely
whenever the document declares `@page { margin }`. The margin extractor, its shorthand handling and
its test matrix were all planned and are all unnecessary.

The fourth is the one that would have shipped a silent defect. `@page` inside `@media print` still
drives the paper, so a detector that does not recurse would leave such a document in screen media on
paper it chose — the hybrid this decision exists to prevent — and nothing about the output would say
why.

## Decision

**A document that declares an `@page` size has told us it is paper. We take it at its word — all the
way, not halfway.**

Two modes, selected by that one signal:

| | Signal | Behavior |
| --- | --- | --- |
| **Canvas** (default) | no `@page` size declared | unchanged: screen media, one continuous page sized to the content |
| **Paper** | any `CSSPageRule` declares `size` | `preferCSSPageSize: true`, no `width`/`height`, and **`@media print` applies** |

`preferCSSPageSize: true` is set in *both* modes. It is what makes paper mode work, and in canvas
mode it provably falls back to the measured `width`/`height`. Canvas therefore does not depend on the
detector being perfect — it depends on a fallback that cannot miss. A detector false-negative costs a
document its print styles; it never costs it its geometry.

### Why paper mode adopts `@media print` too

ADR-022's sibling line — `emulateMediaType("screen")`, with the comment that "the artifact's own
`@media print` rules must not hijack the output" — is correct for canvas and load-bearing. An
infographic's stray `@media print { display: none }` must not empty its own export.

It inverts for a document that declared `@page`. The report that prompted this carries:

```css
@media print {
  body { font-size: 9.2pt; -webkit-print-color-adjust: exact; print-color-adjust: exact }
  /* pagination tightening: two pages */
}
```

Its print block *is* how it fits on two pages, and it is where the author kept backgrounds alive.
Honoring the paper while suppressing the rules written for that paper produces a document laid out
at screen scale on Letter — a third output, matching neither the viewer nor the author's intent.
There is no coherent halfway position.

### Why margins stay at zero

They are not read out of the document, because they do not need to be: a declared `@page` margin
already beats anything we pass. Where a document declares a size and no margin, zero is deliberate.
A default invented here — Chrome's ~0.4in, say — would put a border on a full-bleed page that its
author could not remove, having declared no margin precisely to avoid one. Zero leaves every outcome
reachable from the author's own CSS, which is the same principle as the decision above.

### The viewport

Fixed at 1280 × 900. Puppeteer's default is 800 × 600, which lands a responsive document on its
tablet breakpoint — the PDF then disagrees with the viewer, which is the divergence ADR-022 exists to
close. The skill this was ported from set 1280 and the port dropped it. Paper mode lays out at the
page width and is unaffected; canvas mode measures against it.

## Consequences

- A document that declares `@page` exports as its author wrote it: correct paper, correct margins,
  its own print stylesheet. The reported case goes from 600 × 1633.92 across three pages to
  612 × 792 across two.
- **Canvas-mode exports get wider.** The viewport change moves them from ~800 px to ~1280 px. Any
  infographic exported before this renders differently after it. That is viewer parity and it is the
  direction ADR-022 already argued for, but it is a visible change to existing output.
- A document with an `@page` size *and* a hostile print stylesheet now honors the hostile one. That
  is the cost of taking a declaration at its word, and it is the author's to fix — in canvas mode the
  same document is untouched.
- `emulateMediaType` is no longer a constant, and ADR-022's comment about print rules hijacking the
  output is now true of one mode rather than of the renderer. The replacement has to stay as legible
  as what it replaces.
- The detector is browser-side and cannot be exercised by vitest. The pure half — which options each
  mode produces — is pinned in `worker/test/pdf.test.ts`; the walk itself was validated against a
  real Chromium across nesting, pseudo-page selectors and the `font-size` false-positive.

## References

- `worker/src/pdf.ts` — `pdfOptions`, the detector, the mode switch
- `worker/test/pdf.test.ts` — the geometry decision, pinned
- ADR-022 — the PDF is a capture of the viewer; this narrows its media rule to canvas mode
- ADR-007 — every artifact is hostile; unchanged, and unaffected by paper geometry
- #206 — reported as non-standard paper, diagnosed as the exporter overriding a declaration

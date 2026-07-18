# Implementation Plan — Single-page PDF export via Browser Run (#50)

A `PDF` control in the viewer chrome that returns the document as one continuous-page PDF,
rendered server-side by Cloudflare Browser Run (Puppeteer). Companion to #49 — it adds one
button to the shell header that #49 already built.

## What "done" looks like

- A reader on a document they can already view can click **PDF** and get a single-page,
  content-sized PDF of the artifact as it renders — no pagination, no charts cut mid-element.
- The PDF request is gated by the same `canView`/capability guard as the raw download; no
  document reaches the renderer without authorization.
- The rendering browser has **no network**: a hostile artifact cannot phone home from it.
- A fork that does not enable Browser Run sees no PDF button and a clean "not enabled"
  response — the binding is optional and its absence breaks nothing.
- The free-tier day cap (429) surfaces as a readable message, not a stack trace.

## Decisions (settled)

- **Take the dependency (prime directive #7).** Add `@cloudflare/puppeteer` (5th runtime
  dep, after `jose` / `agents` / MCP SDK / `zod`) and a `browser` binding. Optional: gated on
  `env.BROWSER` being present.
- **Security posture:** run the artifact in a real headless browser but block all outbound
  network (`setRequestInterception` + abort), ephemeral session per render, auth gate before
  the browser is ever touched. This is a new trust boundary; it is contained by leaving the
  browser no network to abuse.
- **MVP scope:** HTML only, render-on-demand (no cache), one ephemeral session per render.
- **Button UX:** a nonced fetch (not a plain `<a download>`), so the button shows a
  "Generating…" state and turns a 429/failure into a readable message. This requires adding
  `connect-src 'self'` to the shell CSP — scoped to our own origin, and the reason the shell
  is the only page that gets it.

## Design

### 1. Dependency + binding (`package.json`, wrangler config, `env.ts`)

- Add `@cloudflare/puppeteer` to dependencies.
- Add the binding to the base wrangler config: `"browser": { "binding": "BROWSER" }`.
- `Env.BROWSER?: Fetcher` — **optional**. Everything downstream treats `undefined` as "PDF
  disabled".
- Provisioning: enabling Browser Run on the account is a one-time step; document it in the
  setup docs and note the button degrades off without it. (Full `pagevault init` wiring is a
  follow-on; the binding in the committed config is enough for the maintainer deployments.)

### 2. Renderer (`worker/src/pdf.ts`) — Puppeteer isolated here

Ported from the `infographic-export` skill's `render.mjs`, with the issue's Puppeteer deltas:

- `launch(env.BROWSER)` → `newPage()`.
- `page.setRequestInterception(true)`; abort every request. `setContent` needs no network for
  a self-contained artifact; blocking all outbound is the whole security property. (Validate
  the allow-initial-document nuance during the smoke test.)
- `page.setContent(html, { waitUntil: 'load' })` — hand it the source directly, no navigation,
  no self-request.
- `page.emulateMediaType('screen')` — so the artifact's own `@media print` cannot hijack it.
- settle on `document.fonts.ready`, then read `documentElement.scrollWidth/scrollHeight`.
- `page.pdf({ width: `${w}px`, height: `${h}px`, printBackground: true, margin: 0 })` — **px
  strings, no `format`**, so one page sized to content. A bare number would be inches.
- `finally { await browser.close() }` — ephemeral, always torn down.
- Throws are caught by the endpoint and mapped to a clean status (429 passes through).

### 3. Endpoint — `&pdf=1` on `/render/{id}` (`worker/src/viewer.ts`)

- Reuse the existing capability verification at the top of `handleRender` — same guard as
  `&download=1`. A forged/missing/expired cap 404s before anything else.
- If `env.BROWSER` is absent → `501` `{ error: "PDF export is not enabled on this deployment" }`.
- Pull source from KV, call `renderPdf`, return `application/pdf` with
  `Content-Disposition: attachment` and the `sourceKind`-derived filename (reuse #49's helper).
- Never cache (`private, no-store`).

### 4. The button (`worker/src/viewer.ts` shell)

- Render a `PDF` control in `.controls` only when PDF is enabled — pass `pdfEnabled` through
  `ShellOptions`, set from `!!env.BROWSER` at each caller (same pattern as `shareable`).
- Nonced script: on click → `fetch('/render/{id}?cap=…&pdf=1')`, set button text "Generating…"
  and disable it; on 200 → blob → trigger a download; on 429 → "Daily PDF limit reached — try
  again later"; on other errors → a generic readable message; always re-enable.
- Add `connect-src 'self'` to the shell response CSP so the fetch is allowed. No other origin.

## Tests (`worker/test/`)

Structural only — the `browser` binding does not exist in `vitest-pool-workers`, so rendering
itself cannot be unit-tested.

- `&pdf=1` with a forged/missing capability → 404 (the guard is reused, not re-implemented).
- With `BROWSER` unset in the test env → `501`, and the shell omits the PDF button.
- With a stubbed/flagged `pdfEnabled` → the shell includes the PDF button and `connect-src
  'self'`.
- `allow-same-origin` never appears (existing sandbox check still passes).

## Live verification (the part that matters)

On a real deploy with Browser Run enabled:

- A `/pub` and a `/p` document each produce a single-page PDF sized to content; a long
  infographic is not paginated and no chart is cut.
- The rendered PDF of an artifact that *tries* to fetch an external URL still renders (network
  aborted) and makes no outbound request (check logs).
- The button shows "Generating…" and downloads; a forced 429 shows the readable message.

## Out of scope (follow-on)

- **Caching** generated PDFs (Cache API / R2, bust on publish) — render-on-demand for now.
- **Session reuse** (`sessions()` / `connect()`) to amortize cold launch — one session per
  render for now.
- **Markdown** — a `.md` document must be rendered to HTML first (#46); PDF stays HTML-only
  until then.
- Full `pagevault init` provisioning of the binding + account enablement flow.

## Step order

1. Add the dependency, binding, and optional `Env.BROWSER`.
2. `pdf.ts` renderer.
3. `&pdf=1` endpoint branch + `501` when unbound.
4. Shell button + nonced fetch script + `connect-src 'self'`; wire `pdfEnabled` at callers.
5. Structural tests.
6. Deploy to the test account, enable Browser Run, run live verification.

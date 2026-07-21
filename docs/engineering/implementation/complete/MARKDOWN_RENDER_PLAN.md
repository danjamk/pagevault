# Implementation Plan — Render markdown documents (#46)

Markdown is publishable today but renders as literal source. This lands the render
step. Build-this-first: it's the prerequisite for the *markdown* behavior of #49
(raw download) and #50 (PDF), both already shipped for HTML.

## What "done" looks like

- Publishing a `.md` document and opening it shows **rendered HTML**, legibly
  styled — not hashes and asterisks.
- The render / PDF hot path stays a pure byte-server: no parser, no extra KV read.
- #49's raw download of a markdown doc still returns the **original `.md`**, not HTML.
- `read_document` (MCP) returns the **original markdown** — the collection reads
  back as what the author wrote, not as rendered HTML.
- An embedded `<script>` in the markdown reaches the artifact but stays contained
  by the existing sandbox — no new CSP relaxation.

## Decisions (settled)

- **Publish-time conversion.** Convert md→HTML once at `POST /api/docs`. `handleRender`
  never loads `sourceKind`, so keeping conversion off the render path is what lets the
  byte-server stay dumb. `sourceKind: "markdown"` becomes a provenance label.
- **Parser: `markdown-it`** — CommonMark-correct, well-maintained, pure JS (bundles
  clean in the Worker, no node built-ins). New dependency, signed off against directive #7.
  Config: `html: true` (raw HTML/`<script>` passes through — the sandbox contains it,
  and a test asserts exactly that), `linkify: true`, `typographer: true`.
- **Feature coverage: VS Code parity.** Everything below fits the *existing* `docCsp`
  (cdnjs / jsdelivr / unpkg already allowlisted for script + style; `data:`/cdnjs for
  fonts; `https:`/`data:` for img) — **no CSP change, no ADR**. All assets land in the
  *artifact* HTML inside the sandboxed iframe, never the trusted shell (ADR-007 intact).
  - **Bundled, server-side, no view-time JS:**
    - GFM tables + strikethrough (markdown-it default preset)
    - Task lists (read-only, disabled checkboxes) — `markdown-it-task-lists`. No
      persistence, exactly as GitHub/VS Code show them in preview.
    - Footnotes — `markdown-it-footnote`
    - Emoji shortcodes `:tada:` — `markdown-it-emoji` (`full`)
    - **Math** `$…$` / `$$…$$` — `@vscode/markdown-it-katex` + `katex`. This is VS
      Code's exact plugin; renders to HTML at publish time. Required to be server-side:
      markdown-it would otherwise mangle `$a_b$` into `$a<em>b</em>$` before any client
      script sees it. Artifact links one KaTeX CSS from cdnjs (only when math present).
  - **Conditional client-side injection** (zero bundle weight; only injected when the
    trigger is present in the source):
    - **Mermaid** — a ```mermaid fence is rewritten to `<pre class="mermaid">` (custom
      fence rule), and mermaid.js is loaded from jsdelivr with `startOnLoad`. Drawn in
      the sandbox at view-time — same mechanism GitHub uses.
    - **Syntax highlighting** — highlight.js "common" build + github/github-dark themes
      from cdnjs, `highlightAll()` on load. Skips the mermaid blocks (they carry no
      `<code>`).
- **New dependencies (directive #7, all signed off):** `markdown-it`, `katex`,
  `@vscode/markdown-it-katex`, `markdown-it-task-lists`, `markdown-it-footnote`,
  `markdown-it-emoji`. Mermaid + highlight.js are CDN-only — not dependencies.
- **Storage: `doc:{id}` holds rendered HTML; a new `raw:{id}` holds the original `.md`.**
  This keeps the render/PDF path unchanged (it reads `doc:{id}` and gets ready-to-frame
  HTML). Only the read-back paths — which already load `meta` — branch on `sourceKind` to
  fetch the original. HTML docs are unchanged: one key, no `raw:`.

## Design

### 1. Dependency (`package.json`)
Add `markdown-it` (+ `@types/markdown-it` dev). Confirm it bundles under `wrangler deploy`
(not just vitest) — same lesson as `nodejs_compat`.

### 2. Renderer (`worker/src/markdown.ts`) — new, parser + all plugins isolated here
`renderMarkdown(md: string): string` → a complete, self-contained `<!doctype html>`
document: markdown-it (+ plugins above) output wrapped in a minimal, legible default
stylesheet (`prefers-color-scheme`-aware, ~65ch measure, styled headings/code/tables/
blockquotes/task-lists/footnotes). A custom `fence` rule rewrites ```mermaid → `<pre
class="mermaid">`. The `<head>` conditionally links KaTeX CSS (math present) and
highlight.js theme CSS (code present); the `<body>` tail conditionally injects mermaid
and highlight.js loaders. This wrapped HTML is the artifact — it flows through the
existing sandbox + `docCsp` untouched. `style-src`/`script-src` already allow inline +
the three CDNs, so **no CSP change** (task: "confirm docCsp still fits"). This replaces
#30's hand pre-render.

### 3. Publish (`worker/src/documents.ts`, `publishDocument`)
- Validate/limit-check on the **original** source (unchanged).
- If `sourceKind === "markdown"`: `const rendered = renderMarkdown(source)`; store
  `rendered` as the doc body, store `source` as the raw original.
- `meta.bytes` stays the **original** source byte length (what the author published /
  what round-trips), not the rendered size.
- HTML docs: unchanged path.

### 4. Store (`worker/src/store.ts`)
- `rawKey = (id) => raw:${id}`.
- `putDoc` gains an optional original-source arg, or add `putRawSource(env, id, md)`;
  publish writes both for markdown (one extra KV write per markdown publish — the
  documented cost of publish-time + honest round-trip).
- `getRawSource(env, id): Promise<string | null>`.
- `deleteDoc`: also delete `raw:{id}` (no-op for HTML docs — delete is idempotent).

### 5. Read-back paths branch on `sourceKind` (all already hold `meta`)
- **Raw download** (`viewer.ts`, `download=1`): for markdown, serve `getRawSource`,
  not `getDoc`. `rawFilename` already returns `.md` — this makes the bytes match the name.
- **`readDocument`** (`documents.ts`): for markdown, return the original from `raw:{id}`.
- **Search body** (`documents.ts` `searchPortal`): grep the original markdown for
  markdown docs — matches what the author wrote, no HTML-tag noise.
- **PDF** (`viewer.ts`, `pdf=1`): unchanged — it *wants* the styled rendered HTML,
  which is exactly what now sits at `doc:{id}`.

## Tests (`worker/test/`)
- A published markdown doc renders to HTML through `/render` (e.g. `# H1` → `<h1>`),
  carrying `IFRAME_SANDBOX` + `docCsp` on the response.
- An embedded `<script>` in the markdown appears in the output **and** the response
  still carries the sandbox/CSP — contained, not stripped.
- Raw download (`download=1`) of a markdown doc returns the **original `.md`** bytes
  with a `.md` filename (not the rendered HTML).
- `read_document` on a markdown doc returns the original markdown.
- An HTML doc is byte-identical through every path (no regression, no `raw:` key).
- Feature coverage (unit tests on `renderMarkdown`): tables, task lists (disabled
  checkbox), footnotes, math (`class="katex"` + KaTeX CSS linked), a ```mermaid fence
  becomes `<pre class="mermaid">` + loader injected, a ```js fence pulls the highlight.js
  loader — and a plain-prose doc injects **none** of the CDN loaders (conditional).

## Live verification
Publish a real `.md` (README-ish: headings, list, fenced code, table, a link).
Open it → styled and legible. Download → `.md` original. PDF → styled. `read_document`
→ markdown source.

## Known limitation — PDF export of markdown with mermaid/math
The #50 PDF renderer blocks **all** outbound network (`setRequestInterception` → abort)
to contain hostile HTML in the real browser. So a markdown doc's PDF renders prose,
tables, lists and code fine (the base stylesheet is inline, no network), but the
CDN-dependent features degrade *in the PDF only*: a mermaid fence shows its source text,
and math falls back to system-font glyphs (KaTeX CSS/fonts are blocked). The **interactive
view is full-fidelity** — network to the allowlisted CDNs is permitted there. This is a
deliberate consequence of #50's security boundary, not a bug; fixing it would mean inlining
KaTeX fonts + server-side mermaid rendering (a follow-on, not worth it now).

## Out of scope (follow-on)
- Configurable/portal-level markdown themes — one default stylesheet for now.
- Full-fidelity PDF for mermaid/math (see the limitation above) — inline KaTeX fonts +
  pre-render mermaid server-side.
- Containers/admonitions (`:::note`) and definition lists — rare; add when a real doc needs it.
- Companion assets / relative images — the single-file model stands (absolute-`https:`
  or `data:` images only), same as every HTML artifact.
- Backfilling docs published as markdown before this lands (there are none in prod worth
  migrating; a republish fixes any). The read-back paths fall back `raw ?? doc`, so a
  pre-feature markdown doc degrades to serving its stored body rather than 404ing.

## Step order
1. Add `markdown-it`; get a clean `wrangler deploy` dry-run.
2. `markdown.ts` — renderer + default stylesheet.
3. Store: `raw:` key, `getRawSource`, `deleteDoc` cleanup.
4. Publish: convert + dual-write for markdown.
5. Branch the four read-back paths.
6. Tests.
7. Live verify on the test deployment.

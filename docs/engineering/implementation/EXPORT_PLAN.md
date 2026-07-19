# Implementation Plan — `pagevault export` folder tree (#35)

A CLI command that walks a deployment over `/api` and writes a browsable directory: one
folder per portal, each document as a standalone file, plus `_portal.json` per folder, an
`ACCESS.md` at the root, and a linking `index.html`. Unzip, double-click, browse — the "my
stuff is real and I can leave with it" artifact. Intentionally lossy, intentionally **not** a
restore format (that is #34): document ids and public tokens are omitted.

## Why the CLI, not the console (the decision Dan asked to record)

The first instinct was a console button — Worker-side, streaming a zip. Rejected:

- **It is an operator action, not a viewer one.** Export is "give me everything I own so I can
  leave." That is the person holding the API token at a terminal, which is exactly the surface
  `pagevault` already serves. The console is for the phone-and-browser publisher (ADR-006); a
  filesystem tree is not something a browser hands you cleanly anyway.
- **A Worker `/api/export` would hold every document body in memory** to build one archive, on
  a free-tier isolate with hard limits. The CLI streams doc-by-doc to disk and never holds more
  than one body at a time.
- **It keeps the Worker thin (prime directive #2).** The only Worker change is one small read
  route; all assembly, slugifying, and rendering live in the CLI, which is already the tool
  built to talk to `/api` and write files.
- **It honors `canView()` for free (prime directive #5).** Every byte comes through `/api`
  under the bearer token — no second door at the KV layer. The issue's own last task already
  said "hitting `/api`"; this plan just commits to it.

Cost of the CLI path: the export is N+ HTTP round-trips instead of one. For an operator
exporting their own deployment occasionally, that is a non-issue — it is not a hot path.

## What "done" looks like

- `pagevault export ./out` writes a directory you can hand to a client; every `.html` opens
  standalone in a browser with no PageVault, no server.
- The sharing state is correct: a document shared with an extra email, or carrying a public
  link, is reflected in `ACCESS.md` — **read from `meta:{id}`, never from list metadata**
  (`DocSummary` omits `extraEmails`/`publicToken` by design, `store.ts:46-64`).
- Titles with emoji, accents, `CON`, or slashes produce safe, non-colliding filenames on
  macOS, Linux, and Windows.
- Markdown documents round-trip as `.md`; HTML as `.html`.
- `--portal <slug>` scopes to one portal; `--zip` produces a single archive.
- Owner-only drafts are **excluded by default** (client-facing artifact); `--include-drafts`
  opts in.

## Decisions (settled)

- **Assembly is CLI-side** over existing `/api` GETs. See justification above.
- **One new read route: `GET /api/docs/{id}/raw`** returns the document body bytes,
  `getRawSource(id) ?? getDoc(id)` — i.e. the original `.md` for markdown, the stored HTML for
  html. Same auth wall as every other `/api` route (owner bearer / session token). This is the
  only missing primitive: `GET /api/docs/{id}` already returns full `DocMeta` (extraEmails,
  publicToken, sourceKind), so sharing state needs no new endpoint.
- **Extension follows `sourceKind`** (issue task). Markdown exports as `.md` — honest
  round-trip. Trade-off acknowledged: a `.md` linked from `index.html` opens as plain text in a
  browser, not rendered. A future `--rendered` flag could export markdown as HTML via the
  Worker's `getDoc` bytes; out of scope here.
- **Drafts excluded by default**, `--include-drafts` to include. Documented in `ACCESS.md`
  output and `--help`.
- **`--zip` shells out** to the system `zip` (Node has no archive writer and the CLI is
  zero-dependency by charter, prime directive #2). If `zip` is absent, the folder is written
  and a clear note tells the user to zip it themselves. No new dependency.
- **Zero new dependencies, zero new Worker deps.** Node built-ins only in the CLI.

## Design

### 1. Worker — `GET /api/docs/{id}/raw` (`worker/src/api.ts`)

- New route, matched before the single-segment `/docs/{id}` regex can't see it anyway
  (`[^/]+` excludes the slash): `/^\/docs\/([^/]+)\/raw$/`, GET only.
- Handler: `getMeta` for 404 + `sourceKind`; body = `(await getRawSource(env, id)) ?? (await
  getDoc(env, id))`; 404 if still null. Return the bytes as
  `text/markdown` / `text/html; charset=utf-8` by `sourceKind`, `Cache-Control: private,
  no-store`. No new store function — `getDoc`, `getRawSource`, `getMeta` already exist.

### 2. CLI — `export` command (`cli/bin/pagevault.mjs`)

- New `case "export"` → `exportCmd(positional, flags)`. Thin: resolve config, parse
  `outDir` (positional 0, default `./pagevault-export-<date>`), `--portal`, `--zip`,
  `--include-drafts`; delegate to `buildExport`. Human progress → stderr; final path → stdout
  (keeps the stdout-is-the-result contract).
- Add the command to `usage()`.
### 4. Two front doors, one engine

- **`pagevault export` (CLI)** — for pointing at *any* deployment; resolves config from
  `pagevault login` / env. The third-party door.
- **`make export` → `scripts/export.mjs`** — the OPERATOR door. Auto-targets the deployment this
  clone just deployed: URL from `.pagevault.json` (`deployedUrl`), bearer from `.env.local`
  (`PAGEVAULT_API_TOKEN`, which `make deploy` writes) — the same resolution `verify`/`health` use.
  So `make deploy && make export` is the whole ceremony, no login, no flags. **Zips by default**
  (the point is one hand-off file); `NOZIP=1` keeps the folder. `PORTAL=`, `DRAFTS=`, `OUT=` pass
  through.
- Both call `buildExport` in `cli/lib/export.mjs`, so the walk + slugify + rendering exist once.

### 3. CLI — the builder (`cli/lib/export.mjs`, new, one module)

All orchestration + rendering + filesystem in one file (target < 400 lines):

- `buildExport(cfg, opts, io)` — the orchestrator:
  1. `GET /api/portals` → portals (filter to `--portal` if set).
  2. Per portal: `GET /api/portals/{slug}` → members; `GET /api/docs?portal={slug}` → doc ids.
  3. Per doc: `GET /api/docs/{id}` → full meta; skip if `ownerOnly` and not `--include-drafts`;
     `GET /api/docs/{id}/raw` → body bytes.
  4. Assemble an in-memory snapshot, then write the tree, then optionally zip.
- `slugify(title, { taken, id })` — conservative: NFKD-normalize, strip diacritics, lowercase,
  non-`[a-z0-9]` runs → `-`, trim hyphens, cap length (~80). Empty result (emoji-only) →
  `untitled`. Windows reserved (`CON PRN AUX NUL COM1-9 LPT1-9`, case-insensitive) → suffix
  `-doc`. Collision within a `taken` set → append `-{id.slice(0,6)}`. Filename is
  `{createdAt.slice(0,10)}-{slug}.{ext}`.
- `renderPortalJson(portal, members)` → `{ slug, name, kind, description, members, createdAt,
  updatedAt }`.
- `accessSummary(portal, meta)` → one human line: draft / public-link / public-portal /
  restricted-members / owner-only, plus `+ also shared with <emails>` when `extraEmails`.
- `renderAccessMd(snapshot, meta)` → `ACCESS.md`: per portal, kind + member list, then each
  doc with its access summary. States the draft-exclusion default.
- `renderIndexHtml(snapshot)` → `index.html`: no framework, no build; `<h2>` per portal with a
  `<ul>` of `<a href="./{folder}/{file}">title</a>` + date + access label. Escapes all text.
- Writes: `rmSync(outDir, {recursive, force})` guarded behind an existing-dir check (refuse to
  clobber a non-empty dir the tool didn't create unless it looks like a prior export);
  `mkdirSync`; `writeFileSync` per file.
- `--zip`: `spawnSync('zip', ['-r','-q', `${base}.zip`, base], {cwd: parent})`; on ENOENT,
  note the folder path and skip.

## Tests

- `worker/test/api.test.ts` (or the existing api suite): `GET /api/docs/{id}/raw` returns the
  body for html and the `.md` source for markdown; 404 for unknown id; **401 without a bearer**
  (it must not be a new open door).
- `cli/export.test.mjs` (new, pure functions, no network): `slugify` for emoji-only, accents,
  `CON`, over-length, and same-title collision; `accessSummary` for each portal kind ×
  draft/public/extraEmails; `renderIndexHtml`/`renderAccessMd` escape HTML and list the right
  docs; drafts excluded unless opted in.

## Live verification

On the test deployment (`fractional5-labs.com`), against a portal with a mix of html + markdown
docs, an extra-email share, a public link, and a draft:

- `pagevault export ./out` → open `out/index.html`, click into an html doc (renders), a
  markdown doc (`.md`), confirm `ACCESS.md` names the extra-email share and the public link and
  omits the draft.
- `pagevault export ./out --include-drafts` includes the draft and labels it.
- `pagevault export ./out --portal <slug>` scopes correctly; `--zip` yields one archive.

## Out of scope (follow-on)

- `--rendered` (markdown → standalone HTML via `getDoc` bytes).
- Backup/restore fidelity with ids + tokens — that is **#34**.
- Any console/UI export surface.

## Step order

1. `GET /api/docs/{id}/raw` route + handler + tests.
2. `cli/lib/export.mjs` — slugify + renderers first (unit-tested), then orchestration.
3. Wire `export` into `cli/bin/pagevault.mjs` + `usage()`.
4. `cli/export.test.mjs`.
5. `pnpm check`; update `cli/README.md` with the command.
6. Live verification on the test account.

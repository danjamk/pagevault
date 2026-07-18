# Changelog

All notable changes to PageVault are recorded here, following
[Keep a Changelog](https://keepachangelog.com/). Versions follow [SemVer](https://semver.org/)
per [ADR-010](docs/adr/ADR-010-versioning-and-releases.md): a version names released code, and a
deployment reports `<version>+<shortsha>` for exactly what it's running.

## [Unreleased]

## [0.4.0] — 2026-07-18

Markdown documents render.

### Added
- **Markdown rendering** ([#46](https://github.com/danjamk/pagevault/issues/46)) — a document
  published as markdown now renders to styled HTML instead of showing its literal source.
  Conversion happens once at publish (`markdown-it`), so the render path stays a pure byte-server
  with no parser on the hot path and no extra read. Coverage matches a good editor preview: GFM
  tables, task lists, footnotes, emoji, and math (KaTeX, rendered server-side); mermaid diagrams
  and syntax highlighting draw client-side, loaded **only** when a diagram or code fence is
  present — every asset from a CDN the artifact CSP already allows, so the sandbox and CSP are
  unchanged (ADR-007). The original `.md` is retained under a new `raw:{id}` key: the raw download
  serves it, `read_document` returns it (markdown is what an LLM reading back actually wants), and
  body search greps it. This completes the markdown behavior [#49](https://github.com/danjamk/pagevault/issues/49)
  and [#50](https://github.com/danjamk/pagevault/issues/50) deferred. Known limit: a markdown PDF
  degrades mermaid/math because the #50 renderer blocks all network by design — the interactive
  view is full fidelity.
- An **Artemis program overview** example (`examples/artemis-program-overview.md`) exercising the
  full markdown feature set in one self-contained document.

## [0.3.2] — 2026-07-17

Single-page PDF export in the viewer.

### Added
- **Single-page PDF export** ([#50](https://github.com/danjamk/pagevault/issues/50)) — a **PDF**
  control in the viewer chrome renders a document to one continuous-page PDF, sized to content, so
  a long infographic is never paginated mid-chart. It runs on Cloudflare Browser Run
  (`@cloudflare/puppeteer`), reusing the same capability guard as the raw download — no document
  reaches the renderer unauthorized — and **blocks all outbound network during the render**, so a
  hostile artifact cannot phone home from the real headless browser (prime directive #4). Optional
  by construction: a deployment without the Browser binding hides the button and the endpoint
  answers `501`, so a fork that never wants PDF simply leaves it out. HTML today; markdown follows
  [#46](https://github.com/danjamk/pagevault/issues/46). First cut renders on demand — caching and
  session reuse are follow-ons.

## [0.3.1] — 2026-07-17

Reader controls land in the viewer chrome.

### Added
- **Download and share from the viewer** ([#49](https://github.com/danjamk/pagevault/issues/49)) —
  the trusted shell now carries a **Download** control on every document: the original source,
  served through the same capability guard as an attachment (`Content-Disposition: attachment`,
  `application/octet-stream`, `nosniff`) so a hostile artifact is never rendered inline in our
  origin — ADR-007, three ways. The filename honors `sourceKind` (`.html` / `.md`). A **Share**
  control copies the current URL (or uses `navigator.share()`), shown **only** on self-authorizing
  `/p/` and `/pub/` links where the URL actually opens for whoever receives it — never on an
  Access-gated `/v/` document, where it would hand out a dead end. Share only ever copies; minting
  and widening stay owner actions.

## [0.3.0] — 2026-07-17

A readable console, the `pagevault` CLI, and push-button production deploys.

### Added
- **A console you can read at a glance** ([#37](https://github.com/danjamk/pagevault/issues/37)) —
  every document row now leads with a *reach* icon that names how far it can travel: only you,
  the portal team, anyone with the link, or public. Expanding a row opens one sharing panel —
  mint and revoke a public link, add and remove per-document email grants (worded so they can't
  be mistaken for portal members), toggle draft, delete. A left-hand portal nav jumps between
  portals; **Copy link** now hands out the most-open working URL rather than a `/v` route that
  walks a recipient into a login wall; a **Sign out** control ends the Access session; and an
  aperture wordmark sits over the title. A public-link flag and `sourceKind` now ride the listing,
  so a markdown document — or a forgotten public link on a private-portal document — is visible
  without opening each one.
- **The `pagevault` CLI** ([#7](https://github.com/danjamk/pagevault/issues/7)) — a standalone,
  zero-dependency npm package (versioned independently, first cut `0.1.0`) that publishes from the
  terminal: `pagevault publish report.html` → a URL. A thin HTTP client of `/api` that works against
  any deployment. `publish` / `list` / `share` / `rm` / `login`; config from `~/.pagevault/config.json`
  or `PAGEVAULT_URL` + `PAGEVAULT_API_TOKEN`; a read-after-write retry so the URL it hands back
  resolves; and a stdout=URL / stderr=everything-else contract so `publish … | pbcopy` just works.
  (`rotate`, the rung-ladder wrapper, and the MCP bin remain on #7 as follow-ups.)
- **Push-button production deploys** ([#38](https://github.com/danjamk/pagevault/issues/38)) —
  a manual `workflow_dispatch` GitHub Action that ships prod through CI, reusing the existing
  `scripts/` (no forked deploy logic). Maintainer tooling: the environment is simply whichever
  Cloudflare token is active — dev in a clone's `.env.local`, prod only in GitHub Environment
  secrets — so the prod credential is never on a developer's machine. A forker can delete the
  workflow and nothing breaks. See [docs/deploy-prod.md](docs/deploy-prod.md).
- **`make health`** — assert the live `/health` reports the exact `<version>+<sha>` of your
  checkout; the post-deploy gate that fails a CI deploy on a rollout that didn't take.

### Changed
- **Deploy reuses the bearer, never mints a throwaway** — `make deploy` now prefers an
  environment-provided `PAGEVAULT_API_TOKEN` (a CI secret) and fails loud in a non-interactive
  deploy into a fresh Worker, rather than generating a random prod bearer stranded on the runner.
- **CI runs the `scripts/` `node --test` suites** (schema migration, KV backup, bearer policy) —
  `pnpm test` is vitest only, so these had been guarding nothing on GitHub.

### Fixed
- **A per-document email grant now actually reaches the person** ([#27](https://github.com/danjamk/pagevault/issues/27)) —
  publishing or sharing a document to specific emails admits them to the `pagevault-viewers`
  Access group, so Cloudflare Access lets them through the door. Previously the grant landed in
  KV while Access still blocked them — a silent half-success. Removing a grant narrows access
  immediately but leaves the seat for the reconciler (the address may be granted elsewhere; see
  ADR-002), and every publish/patch now reports the group-sync outcome instead of swallowing it.

## [0.2.0] — 2026-07-17

Version identity and release discipline — a deployment can now report exactly what it runs.

### Added
- **Version identity in the deployment** — `<version>+<shortsha>` (with `-dirty` for an
  uncommitted tree), baked into the Worker at deploy and reported by `/health` (unauthenticated,
  machine-readable), the MCP `serverInfo`, the console footer, and `make verify`.
- **A documented release process** ([ADR-010](docs/adr/ADR-010-versioning-and-releases.md)):
  SemVer driven by our conventional commits, the commit as "build number", the version decoupled
  from deployment (the operator chooses when to upgrade), assisted bumps, and releases as a tag +
  GitHub Release + this changelog.
- **`/pr` suggests a version bump** from a branch's conventional commits (in `claude-shared`).

## [0.1.0] — 2026-07-17

The foundation — the whole deploy ladder, working end to end.

### Added
- **The deploy ladder** — `make setup → preflight → deploy → verify`, token-first, across all
  three rungs: publish on `*.workers.dev` (rung 1), your own domain (rung 2), and client portals
  behind Cloudflare Access (rung 3). Climbing a rung is re-running `make setup`; documents carry
  across.
- **Remote MCP server** — publish and search a portal from a chat.
- **Sharing** — public `/pub` portals, single-document `/p/` capability links (zero Access seats),
  and email-secured portals via the `pagevault-viewers` group.
- **The owner console** at `/admin`.
- **`make backup` / `make restore`** — KV snapshot and same-host recovery, metadata-preserving so
  restored documents come back *listed*, not just fetchable.
- **State schema versioning** — `.pagevault.json` carries a `schemaVersion` with an ordered,
  fail-loud migration runner; `make status` and the command headers show the version.
- **The two-token model** — a broad provisioning token (`CLOUDFLARE_API_TOKEN`, on your machine)
  and a narrowly scoped runtime token (`CF_API_TOKEN`, in the Worker) for viewer-group sync only.

### Security
- The Worker verifies the Cloudflare Access JWT itself (ADR-004) — it never trusts a header or the
  `CF_Authorization` cookie.
- Artifacts render in a sandboxed iframe with an opaque origin (ADR-007); `allow-same-origin`
  never appears in the codebase.
- One authorization function, `canView()`, including for the read-side MCP tools.

[Unreleased]: https://github.com/danjamk/pagevault/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/danjamk/pagevault/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/danjamk/pagevault/releases/tag/v0.1.0

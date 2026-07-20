# Changelog

All notable changes to PageVault are recorded here, following
[Keep a Changelog](https://keepachangelog.com/). Versions follow [SemVer](https://semver.org/)
per [ADR-010](docs/adr/ADR-010-versioning-and-releases.md): a version names released code, and a
deployment reports `<version>+<shortsha>` for exactly what it's running.

## [Unreleased]

## [0.10.0] — 2026-07-20

Fixes the publish race that could fork a client's link, plus Markdown publishing and a proper
connector icon.

### Fixed
- **Republishing a document no longer forks its URL (#74).** `publish_document` is
  create-or-update keyed on (portal, title), but the title lookup ran through KV `list()`, which
  is eventually consistent — a republish inside that window missed the existing document, minted a
  new id, and silently created a duplicate with a stale client link. Document ids are now
  **deterministic** in (portal, normalized title)
  ([ADR-013](docs/adr/ADR-013-deterministic-document-ids.md)), so a republish overwrites the same
  keys in place: a duplicate is unrepresentable, not merely rejected.
- **The remote MCP connector shows the PageVault mark, not the parent domain's icon.** The Worker
  now serves `/favicon.ico` and `/favicon.svg` (the leaning-v); a `pagevault.<yourdomain>`
  deployment was otherwise falling back to the parent site's favicon.

### Added
- **Publish Markdown from the CLI and MCP (#63).** `pagevault publish report.md` infers the format
  from the extension (`--source-kind` overrides); MCP `publish_document` gains an optional
  `sourceKind`. The Worker renders Markdown to HTML at publish and keeps the original `.md` as the
  raw source — it could already render Markdown (#46); the publish surfaces just couldn't ask.

## [0.9.0] — 2026-07-20

OAuth 2.1 on the remote MCP server — connect PageVault to claude.ai, Claude Desktop, and mobile,
not just Claude Code — plus live MCP smoke checks so a broken `/mcp` can't ship unnoticed.

### Added
- **OAuth 2.1 for the remote MCP server (#22)** — the hosted Claude surfaces (claude.ai, Desktop,
  mobile) can now connect over OAuth 2.1 (PKCE, RFC 8414/9728 discovery, Dynamic Client
  Registration), alongside the bearer path Claude Code already used. The Worker validates every
  token itself; `canView()` still owns document authorization — OAuth only gates access to the MCP
  server (ADR-006). Built on `@cloudflare/workers-oauth-provider`: stateless, no Durable Objects.
- **Cloudflare Access as the OAuth consent IdP ([ADR-012](docs/adr/ADR-012-oauth-consent-access-idp.md))**
  — consent lives at `/admin/authorize`, behind the existing owner Access app, so at Tier 3 the
  operator logs in as themselves and grants tokenlessly. Tier 0/1 (no Access) keeps a paste-token
  fallback.
- **Live MCP smoke in `verify` and `health` (#75)** — `make verify` now drives `/mcp`
  (`initialize`, `tools/list`, a `publish→read→revoke` round-trip, OAuth discovery) and `make
  health` asserts the MCP surface answers, so a version-correct deploy with a dead `/mcp` fails
  loudly instead of shipping quietly.
- **`OAUTH_KV` provisioning** — `provision` (rung 3) and `tier0` (rung 0/1) create and wire the
  `pagevault-oauth` KV namespace; `destroy` tears it down.

### Changed
- The Worker is now wrapped by the OAuthProvider at every tier (the router became its
  `defaultHandler`), and `OAUTH_KV` is a required binding — created automatically by provisioning,
  so `make deploy` needs no manual step.

## [0.8.0] — 2026-07-19

Portal polish: term-aware search, a tidied index page, and editable portal settings.

### Added
- **Edit a portal's name and description from the console** — an **Edit** control on the portal
  header opens a "Portal settings" dialog that `PATCH`es `/api/portals/{slug}`. A typo in a client
  name no longer means re-creating the portal. **Name and description only** — `kind` is
  deliberately not editable here, because changing a portal's access floor (restricted→public
  exposes every document) is a confidentiality decision, not a settings tweak, and the slug is the
  URL. Stays inside the nonced-CSP + session-token console model (#70).

### Changed
- **`search_portal` matches every term, not just a contiguous phrase** — `searchPortal` did one
  substring match of the whole query, so `"bearer token loop"` missed a document that held all
  three words non-adjacently. It now splits on whitespace and requires every term to appear
  somewhere across title, summary, tags, and body (AND-of-terms). Still zero-machinery — no index,
  no tokenizer — and the KV read budget is unchanged (body read at most once per doc, only when
  metadata doesn't already cover every term). It's keyword search, not semantic; the tool
  description now sets that promise honestly (#19).
- **Tidied the portal index page** — retired the warm tan background and the amber draft chip for
  the neutral white/cool-grey + signal-blue system (#67), added a `prefers-color-scheme` dark
  variant, and now show the on-page filter for any non-empty portal (was >2 documents). Light
  touch: no webfont, no logo — the page stays the client's work above the fold (#71).

## [0.7.0] — 2026-07-19

Walk away with everything: a browsable, human-readable export of a whole deployment.

### Added
- **`pagevault export` / `make export`** — walk away with everything. Writes a browsable folder
  (or a zip): an `index.html` that links it all, an `ACCESS.md` that spells out who can see what,
  and one folder per portal with each document as a standalone file — HTML as `.html`, markdown as
  its original `.md`. `make export` auto-targets the deployment this clone deployed (URL from
  `.pagevault.json`, bearer from `.env.local`) and zips by default, so `make deploy && make export`
  is the whole ceremony; `PORTAL=`, `DRAFTS=1`, `NOZIP=1`, `OUT=` tune it. The `pagevault export`
  CLI does the same against any deployment you hold a token for. It's intentionally lossy — no ids,
  no `/p/` tokens — and **not** a restore format (that's `make backup`). Owner-only drafts are
  excluded unless you ask. A new owner-scoped `GET /api/docs/{id}/raw` returns document bytes
  (#35).

## [0.6.0] — 2026-07-19

The owner console adopts the Claude Design system — a new brand, a dark theme, and a
single-portal layout — alongside a batch of smaller console, provisioning, and docs improvements.

### Added
- **Copy a shareable portal link** — the portal card now offers a **Copy portal link** button for
  public and team portals: `/pub/{slug}` (anyone browses, no login) or `/v/{slug}` (the team
  browses after signing in, not forwardable to outsiders). A private portal opens only for the
  owner, so it gets no button. No new route — the browsable index pages already existed and stay
  gated by `canViewPortal`.
- **Deploy date, in the console and `/health`** — a new `PAGEVAULT_DEPLOYED_AT`, baked at deploy
  alongside the version (ADR-010). The console footer shows it next to the version (which links to
  the changelog), and `/health` now returns `deployedAt` so an operator or CI can read what is
  running and when it shipped without opening the console. `/health` stays deliberately shallow: it
  is public, so probing KV on every hit would hand anyone a way to burn the free-tier read quota.
- **The wordmark on the README** — outlined from Sora so it renders on GitHub with no webfont, on a
  card legible in both light and dark. Brand assets live in `docs/brand/`. Two `examples/` fixtures
  reference a remote image to show how export handles it: the interactive viewer loads it, a PDF
  export does not (the [#50](https://github.com/danjamk/pagevault/issues/50) renderer blocks all
  network by design).

### Changed
- **A console design system** ([#67](https://github.com/danjamk/pagevault/issues/67)) — the owner
  console adopts the Claude Design handoff: a signal-blue accent, a cool-grey ground, and the
  leaning-**v** wordmark that retires the aperture. It gains a **dark theme** with a persisted
  toggle, an access **badge** whose icon is tinted by how far a document can travel (only you /
  team / anyone-with-the-link / public), and a single-selected-portal layout — a sidebar of
  portals, one portal's header card and document list in the main panel. Account details (email,
  sign out) collapse into a profile menu; the entry point to publishing is named **Upload** to
  distinguish it from acting on existing documents. The wordmark's Sora glyphs ship as a ~2.5KB
  inlined woff2 subset (no webfont link, no build step, owner-page only); UI text stays on the
  system stack. Link-first / public-by-default sharing
  ([ADR-011](docs/adr/ADR-011-public-by-default-console.md)) is unchanged — the handoff mockup
  predates that decision and is not followed on it. Per-person sharing now hides once a document
  is open to anyone with the link (it adds nothing there), and "anyone with the link" carries the
  link icon, not the globe. No new dependencies; still one server-rendered page under the strict
  nonced CSP.
- **`make provision` confirms Browser Run** — PDF export ([#50](https://github.com/danjamk/pagevault/issues/50))
  needs the BROWSER binding, and provisioning now reports whether Browser Run looks ready instead of
  leaving it unsaid. It is a printed confirmation, not a live probe: Browser Run is on by default on
  the Workers Free plan (nothing to enable), and there is no clean read-only capability endpoint —
  every quick-action endpoint spends the daily allocation.
- **`make help` reads by group** — targets are grouped (Develop · Test & check · Cloudflare account ·
  Deploy & operate · Data) instead of one flat list.

## [0.5.0] — 2026-07-19

The owner console gets author-side controls and a link-first sharing model.

### Added
- **Create portals from the console** ([#43](https://github.com/danjamk/pagevault/issues/43)) —
  a "New portal" dialog (name, slug, kind, description) posts to the existing `POST /api/portals`.
  Each kind's meaning is stated at the point of choice — Restricted spelled out as the only kind
  whose member list actually grants access — because picking wrong is a confidentiality decision,
  not a preference. Slug validation is surfaced from the server, not reimplemented. Reuses the
  console's short-lived session token, so no new server or auth surface.
- **Browser upload** ([#6](https://github.com/danjamk/pagevault/issues/6)) — drag-drop or pick an
  `.html` or `.md` file and publish from a device with no terminal. The kind is detected from the
  extension, so markdown renders instead of showing as raw source. Two warnings live in the UI, not
  just the docs: relative references will 404 for the recipient (single file, no companion assets),
  and a public link is a capability URL, not privacy.
- **Link-first sharing, public by default** ([#65](https://github.com/danjamk/pagevault/issues/65),
  [ADR-011](docs/adr/ADR-011-public-by-default-console.md)) — the sharing panel now leads with the
  share link, always present and copyable, and reach is one contextual choice that defaults to
  "anyone with the link" (the portal-governed option — your team, or only you — is one click away).
  A draft says plainly that it opens for no one, rather than handing you a live-looking copy on a
  dead link. The browser upload defaults to public too; "keep internal" is the opt-out. `canView()`,
  the capability-token model, and the CLI/MCP defaults are unchanged — this is a console default and
  presentation decision.

### Changed
- Minting a public link from the console no longer asks for confirmation — it is the expected default
  now. Revoking (which removes access someone may already hold) still confirms.

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
  workflow and nothing breaks. See [docs/engineering/deploy-prod.md](docs/engineering/deploy-prod.md).
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

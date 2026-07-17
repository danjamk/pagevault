# Changelog

All notable changes to PageVault are recorded here, following
[Keep a Changelog](https://keepachangelog.com/). Versions follow [SemVer](https://semver.org/)
per [ADR-010](docs/adr/ADR-010-versioning-and-releases.md): a version names released code, and a
deployment reports `<version>+<shortsha>` for exactly what it's running.

## [Unreleased]

### Added
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

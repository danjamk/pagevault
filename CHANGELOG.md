# Changelog

All notable changes to PageVault are recorded here, following
[Keep a Changelog](https://keepachangelog.com/). Versions follow [SemVer](https://semver.org/)
per [ADR-010](docs/adr/ADR-010-versioning-and-releases.md): a version names released code, and a
deployment reports `<version>+<shortsha>` for exactly what it's running.

## [Unreleased]

## [0.1.0] — 2026-07-17

The first tagged version — the whole deploy ladder, working end to end.

### Added
- **The deploy ladder** — `make setup → preflight → deploy → verify`, token-first, across all
  three rungs: publish on `*.workers.dev` (rung 1), your own domain (rung 2), and client portals
  behind Cloudflare Access (rung 3). Climbing a rung is re-running `make setup`; documents carry
  across.
- **Remote MCP server** — publish and search a portal from a chat; `serverInfo` reports the
  deployed version.
- **Sharing** — public `/pub` portals, single-document `/p/` capability links (zero Access seats),
  and email-secured portals via the `pagevault-viewers` group.
- **The owner console** at `/admin`.
- **`make backup` / `make restore`** — KV snapshot and same-host recovery, metadata-preserving so
  restored documents come back *listed*, not just fetchable.
- **State schema versioning** — `.pagevault.json` carries a `schemaVersion` with an ordered,
  fail-loud migration runner.
- **Version identity** — `<version>+<sha>` baked into the Worker, surfaced via `/health`, the MCP
  server, the console footer, `make status`, and `make verify`.
- **The two-token model** — a broad provisioning token (`CLOUDFLARE_API_TOKEN`, on your machine)
  and a narrowly scoped runtime token (`CF_API_TOKEN`, in the Worker) for viewer-group sync only.

### Security
- The Worker verifies the Cloudflare Access JWT itself (ADR-004) — it never trusts a header or the
  `CF_Authorization` cookie.
- Artifacts render in a sandboxed iframe with an opaque origin (ADR-007); `allow-same-origin`
  never appears in the codebase.
- One authorization function, `canView()`, including for the read-side MCP tools.

[Unreleased]: https://github.com/danjamk/pagevault/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/danjamk/pagevault/releases/tag/v0.1.0

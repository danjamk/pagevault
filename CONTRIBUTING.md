# Contributing to PageVault

PageVault is MIT-licensed and meant to be forked — take it, run your own, change whatever you like
in your copy without asking anyone. This page is for changes you want to send *back*.

First, the honest framing: PageVault is a **single-operator** tool by design, maintained by one
person. It is not trying to become a platform. That shapes what gets merged. A fix, a sharp-edged
gotcha, a docs improvement, a well-scoped feature that fits the existing model — welcome. A change
that turns it into a multi-tenant SaaS, or adds a build pipeline, or pulls in a heavy dependency —
probably not, and it's kinder to say so up front than after you've written it.

## Before you start

- Read [`CLAUDE.md`](CLAUDE.md) — the prime directives are the short version of every decision here.
- Read [`docs/architecture.md`](docs/architecture.md).
- If you're changing something contested, read the relevant [ADR](docs/adr/) first. If you're
  overturning one, say so in the PR and make the case.
- For anything larger than a fix, **open an issue first.** A PR that surprises me is a PR that's
  hard to accept. See [`docs/README.md`](docs/README.md) for the lay of the land.

## The rules that don't bend

These are security invariants, not preferences. A change that breaks one doesn't get merged, and
most of them will fail the build if you try:

- **One authorization function.** `canView()` in `worker/src/access.ts` decides *may you see this* —
  and nothing else does, including the read-side MCP tools. Don't add a second path.
- **The Worker verifies the JWT itself.** Never trust `Cf-Access-Authenticated-User-Email` or the
  `CF_Authorization` cookie. See [ADR-004](docs/adr/ADR-004-console-auth.md).
- **`allow-same-origin` never appears in the codebase.** Artifacts are hostile; they stay sandboxed.
  There is a test that fails the build if it shows up. See [ADR-007](docs/adr/ADR-007-viewer-shell.md).
- **The security tests in `worker/test/auth.test.ts` are not optional.** A bug there is an incident,
  not a bug. Don't weaken them to make a change pass — fix the change.

## Dependencies

Prime directive #7: **ask before adding** a database, a frontend framework, a build pipeline, or any
runtime dependency beyond `jose`, the `agents` SDK, the MCP SDK, and `zod`. A dependency a forker has
to install is a cost, and "small enough to read in one sitting" is the whole value proposition. If a
new dependency is genuinely the right call, open an issue and make the argument.

## Working on it

```bash
make setup     # install deps and check your environment (Node 22)
make dev       # run the Worker locally against Miniflare
make test        # vitest + @cloudflare/vitest-pool-workers, and the node --test suites
make test-e2e    # the CLI driven against a real Worker (boots its own wrangler dev)
make check-docs  # fail if a doc describes something the code doesn't do
make help        # every target
```

`check-docs` runs in CI. It compares prose against the thing that defines it — links and anchors,
`make` targets, CLI commands, MCP tools, route names — so a renamed command or a deleted route
fails the build instead of quietly outliving itself in the README. It has no opinion about style.

Tests earn their place — write them where they'd catch a real regression, not for coverage's sake,
and test against real infrastructure rather than mocking everything. Node 22 is required (Wrangler 4
needs it). Never commit secrets: `.dev.vars` is gitignored, `.dev.vars.example` is not.

## Commits and PRs

- Conventional-commit subjects: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`. Imperative mood,
  no trailing period.
- Keep PRs small enough to review in one pass. If it's hard to review, it's too big — split it.
- Say *what* and *why* in the body, not *how*. The diff shows how.

That's it. Fork it, steal it, send back what's worth sharing.

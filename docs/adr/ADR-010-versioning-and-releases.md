# ADR-010 — Versioning and releases

**Status:** Accepted
**Date:** 2026-07-17

## Context

PageVault is meant to be forked and read, so it should *model* good release discipline, not just
have a version somewhere. Nobody is using it yet — so this is discipline for its own sake, and to
make the repo a decent showcase, more than a response to real upgrade pain. But the plumbing it
needs (a version a deployment can report) is also what makes the later upgrade story answerable:
"what am I running, and am I behind upstream?"

Two things called "version" must stay distinct:

- **The state schema version** (`.pagevault.json` `schemaVersion`, ADR/#39) — internal plumbing
  for migrations.
- **The product version** (this ADR) — the semver of the code, user-facing.

A running deployment is *not* a release. Whether prod is on the latest version is the operator's
choice to take an upgrade; the version names the code, not the deployment.

## Decision

**Semantic versioning, `major.minor.patch`, driven by the commit types we already write:**

| Bump | Meaning | Conventional commit |
|---|---|---|
| major | breaking — a forker's upgrade needs manual steps | `feat!:` / `BREAKING CHANGE:` |
| minor | new capability, backward-compatible | `feat:` |
| patch | bug fix, no new surface | `fix:` |

**The "build number" is the commit, not a counter.** A deployment reports
`<version>+<shortsha>` (with `-dirty` when built from an uncommitted tree), e.g.
`0.1.0+3f74894`. In a forked, self-hosted product an incrementing build counter is meaningless
to a stranger; a commit pins a deployment to exact code, which is what a build number is *for*.
Baked into the Worker at deploy (`PAGEVAULT_VERSION`), from `package.json` + git.

**Version is decoupled from deployment.** The version identifies released code. An operator
adopts a version by choosing to `make deploy`; nothing about a deploy is a release.

**Bumps are assisted, not manual and not automated.** Manual gets forgotten; automated gets
resented. Since intent is already in the commit types, `/pr` reads the branch's conventional
commits and *suggests* the bump and drafts release notes; a human confirms or overrides.

**A release is:** the `package.json` bump + a `CHANGELOG.md` entry landing in the feature PR,
then a `vX.Y.Z` tag and a GitHub Release with curated, user-facing notes after merge. Notes are
generated from conventional commits, then edited — never a raw commit dump.

**Pre-1.0 semantics.** At `0.x`, `minor` may carry mild breakage and `patch` is fixes. `1.0.0`
is a deliberate statement — "a stranger can rely on this" — reserved for when the ladder, MCP,
and backup are documented and battle-tested. Starting version: `0.1.0`.

**Surfaced everywhere.** Local: script headers and `make status`. Deployed: `/health` (machine-
readable), MCP `serverInfo.version`, the console footer, and `make verify` (which reads
`/health` back).

## Alternatives considered

- **A literal 4th build counter (`major.minor.patch.build`).** Rejected: meaningless to a
  forker, and the git SHA pins code precisely where a counter only pins a build event.
- **Fully automated releases (release-please and friends).** Rejected for now: more machinery
  than a solo, pre-user repo needs. The `/pr` assist is enough; revisit if CI (#38) wants
  deploy-on-tag.
- **Fully manual bumping.** Rejected: it gets forgotten, which is the whole reason to assist.
- **Coupling the version to a deployment event.** Rejected: it breaks the operator's "I choose
  when to upgrade" model and confuses "what's released" with "what's running."

## Consequences

- `/pr` (in `claude-shared`) gains a step: suggest a bump and draft notes from the branch's
  conventional commits, when the repo maintains a version + `CHANGELOG.md`.
- `CHANGELOG.md` is maintained here, Keep-a-Changelog style.
- The Worker carries `PAGEVAULT_VERSION` (`<version>+<sha>`), baked at deploy by the config
  generators; `/health` exposes it unauthenticated (the source is public — nothing to hide).
- #38 (CI deploy) can compare `/health` against the latest tag to answer "is prod behind?", and
  can deploy-on-tag later.
- `0.1.0` is provisional-no-more: it's the first version, set here.

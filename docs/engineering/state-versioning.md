# State versioning and migrations

PageVault carries **two** versions, and it's worth keeping them straight:

| Version | Where | What it means |
|---|---|---|
| **Product version** | `package.json` `version` (semver) | the version of the *code* you're running — shown in every command header and by `make status` |
| **Schema version** | `.pagevault.json` `schemaVersion` (integer) | the *format* of the state file — internal plumbing for migrations |

This page is about the second one. (The product version and where it's surfaced is [#48](../../issues/48).)

## Why a schema version

`.pagevault.json` holds a clone's intent and discovered state (rung, owner, account, host, KV id,
and — at rung 3 — the team and Access ids). As PageVault evolves, that shape will change. Without
a version, every change means guessing what an old file looks like and patching it by hand — which
is exactly the ad-hoc migration we'd been doing (the legacy `.pagevault-provision.json` merge, the
KV-id self-heal). A version turns those guesses into an **ordered, deterministic pipeline**.

## The policy

- **Forward-only, ordered.** `MIGRATIONS[i]` in `cli/lib/provision/context.mjs` migrates a `v(i+1)` file to
  `v(i+2)`: index 0 is v1 → v2, index 1 is v2 → v3. `loadContext()` applies them in order until the
  file reaches `SCHEMA_VERSION`.
- **No version means v1.** Every file written before this landed (and the current shape) *is* v1, so
  an unstamped file is assumed v1 and migrated forward — no special v0 step.
- **Fail loud on a file from the future.** A file whose `schemaVersion` is *higher* than the code
  understands means you're running an older PageVault than the one that wrote it. That stops with a
  clear message, rather than being silently mangled — `git pull`, or start fresh.
- **Migrate on read, stamp on write.** `loadContext()` returns the migrated shape in memory;
  `saveContext()` stamps the current `schemaVersion`. The on-disk file catches up the next time a
  command saves it.

## Adding a migration (for contributors)

When you change the shape of `.pagevault.json`:

1. Write a pure function `(ctx) => nextCtx` that transforms the old shape into the new one.
2. Append it to `MIGRATIONS` in `cli/lib/provision/context.mjs` and bump `SCHEMA_VERSION`.
3. Add a case to `scripts/migrate.test.mjs`.

The runner is pinned by `scripts/migrate.test.mjs` with synthetic migrations, so the machinery is
proven even while `MIGRATIONS` is empty at v1.

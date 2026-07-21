# ADR-014 — The npm package is the installed product, not a thin client

**Status:** Accepted
**Date:** 2026-07-20

**Supersedes:** the thin-client framing of the `pagevault` CLI, and the parts of
prime directives #2 and #7 (CLAUDE.md) that made "small enough to read in one
sitting" the whole value proposition and forbade a build pipeline. It does **not**
change ADR-006 (the MCP server stays remote, inside the Worker) or the security
directives (#4–#6).

## Context

The original model: the `pagevault` npm package is a **thin HTTP client** of the
Worker's `/api` — it publishes and reads documents against a Worker you deployed
some *other* way. Standing PageVault up was a separate act: clone the repo, run
`make setup && make deploy`. Provisioning (KV, Access group, Access apps, the
Worker deploy) lived in `scripts/*.mjs`, invoked through Make, and never shipped in
the package. Prime directive #2 named "small enough to read in one sitting" as the
entire value proposition.

That makes installing PageVault a **developer workflow**, not an install. "Clone a
git repo and learn a Makefile" is the opposite of the low-friction promise. The
npm package's real purpose — the reason to have one at all — is to be the
**alternative to cloning**: to make a product that happens to run on Cloudflare
feel like traditional software you install and run. A thin client cannot be that,
because it can't stand the product up; you still have to clone to provision.

So the thin-client requirement was in the way of the thing the package exists for.

## Decision

**The `pagevault` npm package is PageVault, installed.** `npm install -g pagevault`
(or `npx pagevault`) is a complete install — document commands *and*
provisioning/deploy — with no repo checkout.

- **The package ships a prebuilt, self-contained Worker bundle.** A publish-time
  `esbuild` step compiles `worker/src` to a single JS file with `jose`, the
  `agents` SDK, and the MCP SDK inlined. The package carries that bundle, the
  `wrangler.jsonc` template, and the provisioning logic.
- **`pagevault init`** provisions Cloudflare (the current `provision.mjs` flow: KV,
  `pagevault-viewers` group, the two Access apps, the generated wrangler config) and
  `npx --yes wrangler@4 deploy`s the bundled Worker. Wrangler is **spawned via npx,
  never a dependency** — a document-only user must not install 80 MB of it.
- **`pagevault upgrade`** redeploys a newer bundle: `npm update -g pagevault` brings
  a new bundle, `pagevault upgrade` ships it, keeping KV and config.
- **`pagevault sync-access [--reap]`** reconciles the viewers group from KV.
- **State moves to `~/.pagevault/`.** `.pagevault.json` and credentials were
  repo-cwd-relative; a global install has no repo cwd, so they live in the home
  directory. The wrangler template resolves package-relative.

The clone + `make` path still exists — it is how the bundle is built and how
contributors work — but it is no longer the story a user is told.

## Alternatives considered

**Keep the thin client; provision via clone + `make` (status quo).** Rejected: it
fails the entire reason the package exists. "Install PageVault" would still mean
"clone a repo," and the npm package would remain a remote control for a Worker the
user had to deploy some harder way first.

**Scaffold-and-deploy (the create-react-app model).** `npx pagevault init` writes a
small project folder (wrangler config + the bundle) that the user then owns and
redeploys. Rejected as the *primary* model: it reintroduces a local project
directory to manage and keep in sync, which is a lighter clone, not an install. The
target is a clean install with no project files and state in `~/.pagevault/`. Worth
revisiting later as an opt-in path for operators who want to customize the Worker.

**Ship the raw Worker source; let wrangler compile on the user's machine.**
Rejected: it drags the Worker's whole dependency tree onto the user's machine and
adds a compile at deploy time. A self-contained prebuilt bundle is smaller, faster,
and needs nothing installed but `npx wrangler`.

**A hosted/central deployment we run.** Rejected: violates prime directive #1
(single-operator). Each operator runs their own PageVault on their own Cloudflare
account; there is no multi-tenant service to host.

## Consequences

- **A publish-time build now exists** (esbuild → the Worker bundle). It is
  maintainer-side, not user-side. It must be wired into the release flow with a
  freshness guard — a bundle stale against `worker/src` would ship old code, the
  same failure class the `wrangler.generated.jsonc` substitution check already
  guards against.
- **The package grows** — it carries the bundle, the wrangler template, and the
  provisioning logic, not just an HTTP client. That is the point: it is the product.
- **Version coupling (ADR-010).** The bundle's version is the package version.
  `pagevault upgrade` deploys the bundle that shipped with the installed package, so
  "upgrade PageVault" is "update the npm package, then `pagevault upgrade`." Document
  this so a stale global install is not mistaken for a stale deployment.
- **Provisioning code must stop assuming a repo cwd.** `context.mjs` /
  `provision.mjs` read `worker/wrangler.jsonc` and `.pagevault.json` relative to the
  working directory today; under an install they resolve the template
  package-relative and state under `~/.pagevault/`. This is the bulk of #42's real
  work, beyond wiring subcommands.
- **#28 (Deploy-to-Cloudflare button) is deferred.** A repo-based one-click deploy
  and an npm installer are two different on-ramps that can undercut each other;
  choosing between (or sequencing) them is deliberate work, and it is pulled out of
  the packaging group until this model is real. A 2026-07-21 review
  ([#28 comment](https://github.com/danjamk/pagevault/issues/28#issuecomment-5033942931))
  settled the technical question — the button now prompts for secrets, so rung-1 via
  button is feasible — but sharpened the model tension this ADR raises: the button
  *clones* (a fork in the visitor's GitHub, redeployed by Workers Builds from source),
  which is exactly the maintenance model this decision walks away from. The proposed
  resolution is to scope the button as a demo/"try it live" on-ramp, never the install
  path, so it serves the tourist while the installed package serves the operator.
- **What does not change:** the MCP server stays remote and inside the Worker
  (ADR-006); `canView()` stays the one authorization function (#5); the Worker still
  verifies its own JWT (#6); the source stays readable — a forker should still be
  able to follow it — it simply is no longer the pitch.

# Packaging lifecycle — the installed product (#42, under ADR-014)

**Branch:** `feature/packaging-lifecycle` · **Three PRs**, one per phase.

[ADR-014](../../../adr/ADR-014-installed-product-not-thin-client.md) reframed the
`pagevault` npm package: it is the **installed product**, not a thin client.
`npm install -g pagevault` stands PageVault up on your own Cloudflare account with
no repo clone. That turns #42 (`init` / `upgrade` / `sync-access`) from "wrap the
scripts" into "give the package everything it needs to provision, deploy, and
operate on its own." The three commands are thin; the **foundation beneath them is
the work**.

## Locked decisions (2026-07-20)

1. **Prebuilt, self-contained Worker bundle.** `esbuild` compiles `worker/src/index.ts`
   to one JS file with `jose`, the `agents` SDK, and the MCP SDK inlined. `init`/`upgrade`
   deploy that bundle via `npx --yes wrangler@4` — **wrangler is never a dependency.**
2. **Bundle is built at pack time, never committed.** `prepack`/`prepublishOnly` runs the
   build; `cli/dist/` is gitignored. Always fresh in the tarball → no staleness guard to keep.
3. **State unifies to `~/.pagevault/` for everyone**, installs and `make` clones alike.
   One model, not two code paths. Existing clones migrate their repo-root
   `.pagevault.json` / `.env.local` once (migrate-on-read, then write to home).
4. **Provisioning code moves into the package.** `provision.mjs` / `deploy.mjs` / `tier0.mjs`
   / `context.mjs` relocate from `scripts/` into `cli/lib/provision/`, refactored from
   run-on-import scripts into exported functions. `make` targets point at the new location.
5. **`sync-access` is server-side.** A new `/api` reconcile route (the CLI calls it over HTTP
   like every other document command); the CLI never holds a CF token or the group id. Keeps
   the reconcile in one authorization context and the command thin.
6. **Three sub-issues, three PRs, in order:** `sync-access` → foundation → `init`/`upgrade`.

## Current state (what exists, per the architecture map)

- `provision.mjs` (327 lines) — rung-3 provisioning: verifies the account, detects Zero Trust
  (deep-link-and-stop if absent), creates KV + `OAUTH_KV`, the OTP IdP, the `pagevault-viewers`
  group, the two Access apps, prompts for the scoped runtime token, writes
  `worker/wrangler.generated.jsonc` from the template. **Runs on import; exports nothing.**
  Standalone from the Worker; reads the template as a text file.
- `deploy.mjs` (204 lines) — verifies account → runs the config generator as a subprocess →
  `npx --yes wrangler@4 deploy --config worker/wrangler.generated.jsonc` → sets the
  `PAGEVAULT_API_TOKEN` + `CF_API_TOKEN` secrets. `chooseBearer` already **skips** when the
  secret exists — reuse-not-rotate, i.e. exactly `upgrade` semantics.
- `context.mjs` (411 lines) — the shared lib: `loadCloudToken` (reads `CLOUDFLARE_API_TOKEN`
  from `.env.local`/env), `cfApi`, `loadContext`/`saveContext` (`.pagevault.json` +
  migration framework), `chooseBearer`. **Repo-cwd-relative paths throughout.**
- `access-group.ts` — `syncGroupMembers(env, emails)` is **additive only**: unions emails in,
  never removes. `updatePortalMembers` drops a member from KV but leaves them in the Access
  group. That drift is exactly what `sync-access --reap` repairs. `listPortals` + `getMembers`
  + `putMembers` already exist server-side to compute the desired set.
- `cli/package.json` — `files: ["bin","lib","README.md"]`, **zero dependencies**, `pagevault`
  0.1.0 (separate from root 0.12.0). `scripts/` is outside the package and does not ship.

## Phase 1 — `sync-access` *(independent; ship first)*

Decoupled from the bundle work entirely — a Worker route plus a thin CLI wrapper.

- [ ] **Server:** a reconcile function that computes the desired viewers set —
  `∪ getMembers(p) for p in listPortals()` plus every doc's `extraEmails`, plus `OWNER_EMAIL`,
  normalized — and PUTs the group's full include list. Generalize the read-modify-write already
  in `syncGroupMembers`. `--reap` also **removes** group members absent from the desired set.
- [ ] **Route:** `POST /api/access/sync` (owner-bearer, `originAllowed`), body `{ reap?: bool }`,
  returns `{ added, removed, kept, groupSize }`. Reports the sync status like every other
  Access-touching path (ADR-002).
- [ ] **CLI:** `pagevault sync-access [--reap] [--json]` — a thin `/api` call, no wrangler, no
  CF token. Prints a summary; `--reap` warns before pruning seats.
- [ ] **Tests:** reconcile logic (drift repaired; reap removes only non-members; owner always
  kept), route auth, CLI dispatch.

Also closes the operational half of #20 (the group-drift bug).

## Phase 2 — the foundation *(the hard part)*

- [ ] **Bundle build:** `esbuild worker/src/index.ts` → `cli/dist/worker.js`, self-contained,
  Workers/`webworker` target. A `make bundle` (and `cli` npm script) that produces it; wired
  into `prepack`. `cli/dist/` gitignored.
- [ ] **wrangler config for the bundle:** the shipped template points `main` at the bundled
  `worker.js` (not `worker/src`), so `wrangler deploy` uploads the prebuilt file without
  re-bundling the TS or needing the Worker's deps installed.
- [ ] **Relocate provisioning:** move `provision.mjs`/`deploy.mjs`/`tier0.mjs`/`context.mjs`
  into `cli/lib/provision/`; refactor run-on-import scripts into exported functions
  (`provision(ctx)`, `deploy(ctx)`, …). Update `Makefile` + any `scripts/*.test.mjs` to the new
  paths. Keep behavior identical — this is a move + wrap, not a rewrite.
- [ ] **De-repo the paths:** template resolves package-relative (`import.meta.url`); state
  (`.pagevault.json`, `.env.local`-style creds) resolves under `~/.pagevault/` with a
  migrate-on-read from a repo-root file if present. A `PAGEVAULT_HOME` env override for tests.
- [ ] **Package:** `cli/package.json` `files` += `dist/`, the wrangler template, `lib/provision/**`.
- [ ] **Smoke (#56 extension):** the pack-install test asserts `dist/worker.js` and the template
  actually ship and are resolvable from the installed location.

## Phase 3 — `init` + `upgrade`

- [ ] **`pagevault init`:** the refactored provision flow (masked token input, prefilled
  scope-URL, Zero-Trust deep-link-and-stop with team-name readback on re-run) → write the
  generated wrangler config → `npx --yes wrangler@4 deploy` the bundle → set the runtime
  secrets. Idempotent: re-running reconciles.
- [ ] **`pagevault upgrade`:** redeploy the bundle from the installed package, keep KV + config
  + secrets (`chooseBearer` "skip" path). This is "`npm update -g pagevault && pagevault
  upgrade`" — surface that in `--help` so a stale global install isn't read as a stale deploy.
- [ ] **Docs:** the connection/onboarding docs gain the `npm install` path as the primary
  on-ramp; `make` becomes the contributor path.
- [ ] **Smoke:** `init --help` / `upgrade --help` run from the installed tarball.

## Open questions (non-blocking)

- **Bundle size / Worker free-tier limit.** The inlined `agents` + MCP SDK bundle must stay
  under the 1 MB (gzipped) Worker script limit. Measure early in Phase 2; if tight, mark deps
  `external` only where the runtime provides them (unlikely on Workers) or tree-shake harder.
- **`make` back-compat during the move.** Phase 2 relocates the scripts; the same PR updates the
  Makefile so `make deploy`/`provision` keep working from a clone. Verify on a clean checkout.
- **`~/.pagevault/` migration messaging.** First run after upgrade should say "moved your config
  to ~/.pagevault/", not silently relocate.

## Definition of done

- `npm install -g pagevault && pagevault init` provisions + deploys a working PageVault on a
  fresh Cloudflare account, no clone. `pagevault upgrade` ships a newer bundle. `pagevault
  sync-access --reap` reconciles the viewers group. All three run from the published tarball,
  guarded by the pack-install smoke.

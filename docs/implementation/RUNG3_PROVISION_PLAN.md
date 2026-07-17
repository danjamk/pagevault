# Rung 3 — Tier-1 provisioning, on the ladder (#9 + #23 + #24)

**Branch:** `feature/9-tier1-provisioning` · **One PR.**

Rungs 1–2 ship (#32). This closes the ladder: rung 3 (Access, Zero Trust, portals)
provisioned through the *same* `setup → preflight → deploy → verify` flow, token-first,
with a scoped runtime token. All of #9 (Parts 1–3) plus #23 and #24 land here.

## Locked decisions

1. **All of #9 in this PR** — the provisioning script (Part 1), `pagevault init`/`upgrade`/
   `sync-access` (Part 2), and create-portal in `/admin` (Part 3).
2. **One context file.** Unify on `.pagevault.json`; retire `.pagevault-provision.json`
   (migrate on read if present, then stop writing it).
3. **Two-token model.** The *provisioning* credential is `CLOUDFLARE_API_TOKEN` (broad,
   `.env.local`, deploy-time). The *runtime* credential stays the Worker binding
   `CF_API_TOKEN` (internal, no wrangler-auth conflict) but becomes a **separate, narrowly
   scoped** value.
4. **Prompt for the scoped runtime token** (don't mint it via API) — prefilled template URL
   + the one scope, same UX as the main token.

## Current state (what exists today)

- `deploy.mjs:81` already routes `rung ≥ 3 → provision.mjs` as the config generator, run with
  `stdio:"inherit"` (so provision can prompt).
- `provision.mjs` (395 lines) is pre-ladder: its own `c`/`ok`/`die`/`ask`/`cf`/`fromEnv`,
  reads `CF_API_TOKEN`, keeps `.pagevault-provision.json`, re-asks host + email, has its own
  account picker. It creates KV, OTP, the `pagevault-viewers` group, the two Access apps
  (ADR-001), and writes the generated config. It does **not** set the runtime `CF_API_TOKEN`
  secret, and it tells the user to set `PAGEVAULT_API_TOKEN` + deploy by hand (both now
  automated in `deploy.mjs`).
- `access-group.ts` reads `env.CF_API_TOKEN` to GET/PUT the viewer group (ADR-002 hot path).
  That token is currently the broad provisioning token — the blast radius #24 narrows.
- `preflight.mjs` already runs the rung-3 Zero-Trust check.

## Target architecture

**The ladder at rung 3, one job per verb (unchanged shape):**
- `setup` — rung 3, owner email, host, token, account → `.pagevault.json`. (setup already
  asks host at rung ≥ 2.) Also prompt for + save the **scoped runtime token** here, or in
  provision — TBD Phase 2.
- `preflight` — token valid + Access scopes, account pinned, KV, zone + DNS, **Zero Trust
  enabled**, OTP present. Read-only.
- `deploy` → `provision.mjs` (generator: Access resources + config) → `wrangler deploy` →
  set **both** secrets over the API (`PAGEVAULT_API_TOKEN` generated, `CF_API_TOKEN` = the
  scoped runtime token from `.env.local`).
- `verify` — the rung-3 smoke test (below).

**Secret-setting lives in `deploy` (post-deploy), not `provision`** — the Worker script must
exist before a secret can be PUT, and `deploy` already does this for `PAGEVAULT_API_TOKEN`.
Provision's job is Access + config + prompting; it saves the scoped token to `.env.local`,
deploy sets it as the secret.

**Naming collision to avoid:** the scoped runtime token in `.env.local` must **not** be named
`CF_API_TOKEN`, or `loadCloudToken()` (which falls back to `CF_API_TOKEN`) would use the
narrow runtime token for wrangler auth. Fix: `loadCloudToken()` reads **`CLOUDFLARE_API_TOKEN`
only** (drop the fallback — #23), and the scoped token gets a distinct `.env.local` name
(proposed: `CF_RUNTIME_TOKEN`) that `deploy` maps onto the `CF_API_TOKEN` Worker secret.

## Phases

### Phase 1 — provision.mjs joins the ladder (Part 1 + #23)  ✅ DONE
- [x] Replace provision's private helpers with `context.mjs` imports. ~80 lines of
      duplication gone; readable palette adopted.
- [x] Token via `loadCloudToken()` (`CLOUDFLARE_API_TOKEN` only, fallback dropped) — closes
      #23's provisioning side and clears the wrangler deprecation warning. `cfApi` reads
      `CLOUDFLARE_API_TOKEN` only too.
- [x] Read `host`, `ownerEmail`, `accountId` from `.pagevault.json`; verify the token reaches
      the pinned account, refuse a mismatch. No re-asking.
- [x] Migrate `.pagevault-provision.json` → `.pagevault.json` on read; write only
      `.pagevault.json` (`+ team, audDocs, audAdmin, groupId`). `destroy` reads either.
- [x] Self-heal KV like `tier0.mjs`.
- [x] Drop the "set the secret and deploy by hand" section — `deploy` owns that. Provision
      ends by handing control back.
- [x] Kept intact: Zero-Trust detect + deep-link, OTP, viewer group, the two Access apps +
      AUD-readback (ADR-001), config substitution + fail-loud verification.

### Phase 2 — the scoped runtime token (#24)  ✅ DONE
- [x] Minimum scope confirmed from `access-group.ts` (GET/PUT `/access/groups/{id}`): one
      permission, *Access: Organizations, Identity Providers, and Groups — Edit* (account).
      Nothing narrower exists in Cloudflare's token model.
- [x] Provision prompts for a **dedicated** runtime token (template URL + that one scope),
      paste-or-skip, saved to `.env.local` as `CF_RUNTIME_TOKEN`. Skipping is non-fatal (owner
      still works; email-grant sync stays off with a clear pointer).
- [x] `deploy` sets the Worker secret `CF_API_TOKEN` = `CF_RUNTIME_TOKEN` over the API,
      post-deploy, alongside `PAGEVAULT_API_TOKEN`.
- [x] Two-token model documented in `env.ts` (`CF_API_TOKEN` = scoped runtime, distinct from
      the broad `CLOUDFLARE_API_TOKEN`). Fuller prose in prerequisites/README lands in Phase 5.

### Phase 3 — `pagevault init` / `upgrade` / `sync-access` (Part 2)  ⏭️ DEFERRED → #7
Split out of this PR (Option A). The provisioning flow works through `make`; the CLI wrapper
is Layer-1 polish that overlaps #7, so it moves there rather than growing this branch.
- [ ] `pagevault init` — thin wrapper over provision; masked token input, prefilled scope URL.
- [ ] `pagevault upgrade` — redeploy the bundled Worker, keep KV + config.
- [ ] `pagevault sync-access [--reap]` — recompute the viewer group from KV, PUT the full list.

### Phase 4 — create-portal in `/admin` (Part 3)  ⏭️ DEFERRED → own issue
Split out of this PR (Option A). It's the console's first mutation (CSP + session-token care),
independent of the deploy story.
- [ ] Create-portal control (slug, name, kind, description) → existing `POST /api/portals`.
- [ ] State each `kind`'s meaning inline; surface `isValidSlug` errors; hide at Tier 0.

### Phase 5 — verify, docs, credit  ✅ DONE
- [x] `verify.mjs` rung-3 path already coded: `/` → 302 `/admin` at rung 3; publish→read
      round-trips via a **public** `/p/` doc that bypasses Access.
- [x] README: **credit `jonesphillip/sharehtml`** — already present (Credits: the Access
      provisioning script, the capability-token model, the sandboxed iframe).
- [x] README: removed the stale "rung 3 not wired to the shared config" note; Status now
      reflects the full ladder. Two-token model captured in the README token section.
- [~] `docs/setup/prerequisites.md` two-token prose → deferred to the docs-refactor pass (the
      README covers it for now; env.ts documents the model).

### Phase 6 — live validation  ✅ CORE DONE
- [x] Clean(ish) Zero-Trust account → `setup(rung 3)` → `preflight` → `deploy` → owner OTP
      login reached. Rung 2 → 3 climb carried documents across.
- [ ] Still to confirm before/after merge: a non-invited email is refused (seat-bounding), and
      member-sync works with the runtime token set. `make destroy` teardown.

## Files

- **Rewrite:** `scripts/provision.mjs` (adopt context.mjs, `.pagevault.json`, drop manual steps).
- **Edit:** `scripts/context.mjs` (`loadCloudToken` → `CLOUDFLARE_API_TOKEN` only; maybe a
  scoped-token helper), `scripts/deploy.mjs` (set `CF_API_TOKEN` secret from `CF_RUNTIME_TOKEN`),
  `scripts/setup.mjs` / `preflight.mjs` (rung-3 polish, scope checks), `scripts/destroy.mjs`
  (already ladder-aware — verify), `cli/` (`init`/`upgrade`/`sync-access`), `worker/src/console.ts`
  (create-portal), `worker/src/env.ts` (two-token comment), `README.md`,
  `docs/setup/prerequisites.md`.
- **Maybe:** an ADR note on the two-token model.

## Risks & open questions

- **`.pagevault-provision.json` migration** — the production deployment (`~/yukon/pagevault`)
  has one. Migrate-on-read must be lossless (host/email/account/kv/team/auds/group).
- **Scoped-token UX** — a second token is more onboarding friction. Mitigate with a precise
  template URL and clear copy; accept it as the security cost ADR-002 names.
- **Console mutation** — first write-path in `/admin`; keep it inside the existing session +
  CSP model, don't widen it.
- **`verify` at rung 3** — can't smoke-test the Access-gated `/v` without a JWT; assert the
  redirect-to-login instead, and round-trip via a public doc.
- **Part 2 ↔ #7 overlap** — `pagevault init` substantially is #7's init surface; note it so #7
  narrows to whatever's left.

## Testing

- Worker unit tests stay green (`vitest run`), `tsc --noEmit` clean.
- Provision/CLI validated live on the Zero-Trust test account (Phase 6) — the real bar, per
  #9: "validated when a stranger deploys it," not when the author does.

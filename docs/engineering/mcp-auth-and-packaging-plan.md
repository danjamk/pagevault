# Implementation plan — MCP auth double-down + full-lifecycle packaging

**Drafted:** 2026-07-19 · **Start:** 2026-07-20 · **Owner:** Dan

Two objectives that are really one npm package finishing its job. The MCP-auth
half is now **validated** — active work is hardening it for prod (Phase 2) and the
packaging track. Kept below in resolved form so the reasoning trail survives.

---

## RESOLVED (2026-07-20): #22 OAuth works end-to-end on claude.ai web

**It was never a code bug or a platform regression. It was a deployment gap:
prod (`danjamkuhn.com`) runs `main`, which is bearer-only — the OAuth server lives
on the unmerged `feature/22-oauth-spike` branch. Every "custom-connector OAuth is
broken" test was hitting a prod endpoint that has no OAuth.**

Proven by deploying the spike to the **test** env (`pagevault.fractional5-labs.com`)
and driving it from a fresh claude.ai **web** custom connector:

- OAuth discovery 200, protected-resource metadata correct, **DCR `POST /register` → 201**
  (the exact step that 404'd on prod and produced the "Couldn't register" error).
- All read/write tools executed: `list_portals`, `list_documents`, `read_document`,
  `search_portal`, `publish_document`, `revoke_document`.
- The Claude Code **bearer** path still works alongside OAuth (`POST /mcp` init → 200).

**How the earlier theories died** (each was an artifact of testing against no-OAuth prod):

| Theory (chronological) | Verdict |
|---|---|
| "It's us — RealPlus (custom connector) works, ours doesn't" | Moot. Ours was never deployed with OAuth. |
| "Anthropic custom-connector regression, host-agnostic" ([#430](https://github.com/anthropics/claude-ai-mcp/issues/430)/[#476](https://github.com/anthropics/claude-ai-mcp/issues/476)) | Not our failure. Cloudflare's own + directory connectors work on web. |
| "Our stateless transport hangs the `GET /mcp` SSE stream" | Red herring — that 10-min keepalive'd GET is *normal* Streamable-HTTP behavior. |
| **"Prod has no OAuth server deployed"** | **Correct.** `/register`, `/.well-known/oauth-*` all 404 on prod; 200/201 on the spike. |

**Two real defects surfaced during validation** (tracked, not blocking):
- **#74** — `publish_document` overwrite guard fails on KV eventual consistency
  (`findByTitle` → `list()` reads a stale index → silent duplicate + stale link).
- **`/health` 404 on the spike** — wrapping the router in `OAuthProvider` regressed it
  (works on prod/main). Folded into Phase 2; check other non-OAuth routes too.

**Test env now runs the spike** (not `main`). Revert with `make deploy` from the main
checkout. Left in place for continued testing: worktree `~/yukon/pagevault-oauth-spike`,
and a new `OAUTH_KV` namespace (`7a8fca83…`) in the test account.

---

## Phase 0 & 1 — RESOLVED, superseded by the deployment finding

Phases 0 (RealPlus diff experiment) and 1 (diff-and-fix against a working reference)
were built on the premise that the failure was our *implementation*. It wasn't — it
was *deployment*. Both are moot; skip to Phase 2. Original text kept below for the
record.

<details><summary>Original Phase 0 / Phase 1 (obsolete)</summary>

## Phase 0 — Ground truth (the decisive experiment)

**Goal:** answer one question — *is a freshly-added custom OAuth connector able to
surface tools to the model on Dan's claude.ai today?* Everything downstream forks
on the answer. ~1–2 hrs, mostly clicking, no PageVault code changes.

- [ ] **Re-add RealPlus clean.** Disable/remove the RealPlus connector, re-add it
      as a *new* custom connector (Dan has the code locally, can run it). Confirm
      whether tools surface **to the model in a conversation** — not just "Connected"
      in Settings (#476's whole point is Settings lies). This tells us if the
      regression is live *at all* for Dan's account right now.
- [ ] **Classify the RealPlus connector.** Personal custom vs org/enterprise-managed.
      Note the transport (Streamable HTTP vs SSE), stateless vs stateful, and JSON
      vs SSE responses. This is the reference profile.
- [ ] **Re-drive the PageVault spike** (`feature/22-oauth-spike`) against a *fresh*
      claude.ai connector. Capture edge logs for the full sequence:
      `/register → /authorize → /token → initialize → notifications/initialized →
      tools/list → tools/call`. The failure signature from the spike was: handshake
      succeeds, then tokenless `initialize` probes 401 and the UI reverts. Confirm
      whether that still reproduces.

**Decision gate:**
- **RealPlus works + PageVault fails** → it's us. Go to Phase 1 (diff & fix). *This
  is the expected and most actionable outcome.*
- **Both fail** → regression still live for personal connectors; check if RealPlus
  is enterprise-managed (explains its success). Fall back: ship #21 (Desktop) now,
  park OAuth, re-test on a cadence.
- **Both work** → the regression cleared. Skip straight to Phase 2 (harden & ship
  #22). Best case.

---

## Phase 1 — Diff PageVault against the working reference, and fix

**Only if Phase 0 shows RealPlus works where PageVault fails.** Reference-driven
debugging: make PageVault's wire behavior match the connector that works.

Capture both flows at the HTTP level (edge logs / a proxy) and diff, in priority
order of what #430 flagged as *observed client behavior*:

- [ ] **Token-endpoint routing.** #430 noted claude.ai POSTs `/token` at **host root**,
      ignoring the metadata-advertised `token_endpoint`. Confirm PageVault's
      `workers-oauth-provider` routes advertise a root-consistent `/token`, or that a
      root `/token` is handled. A mismatch here strands the token exchange.
- [ ] **RFC 8707 `resource` parameter.** #430: claude.ai adds `resource` on `/token`
      (post 2026-06-10) but not `/authorize`. Verify PageVault accepts/validates the
      `resource` claim exactly as the working connector does; over-strict `aud`/
      `resource` checking is a prime suspect for the post-handshake drop.
- [ ] **`WWW-Authenticate` + RFC 9728 protected-resource metadata.** Diff the exact
      `WWW-Authenticate` challenge and `/.well-known/oauth-protected-resource` +
      `/.well-known/oauth-authorization-server` documents against RealPlus's. The
      tokenless-probe → 401 → revert loop can be triggered by a metadata field claude.ai
      keys off.
- [ ] **Consent redirect status.** Spike already fixed `302 → 303` and removed a
      `form-action` CSP that silently ate the redirect. Confirm the working RealPlus
      flow uses the same, and that no other CSP/header on PageVault's consent page
      blocks the cross-origin callback to `claude.ai/api/mcp/auth_callback`.
- [ ] **Token lifetime / refresh.** #430 says working connectors coast on
      `refresh_token` grants every 20–60 min. Confirm PageVault issues a refresh
      token and honors the refresh grant; a missing/short refresh path looks exactly
      like "drops seconds later."
- [ ] **Fix the one delta, re-test live.** Change PageVault to match the working
      reference on whichever of the above differs, redeploy the spike branch, re-drive
      the connector. Iterate until `tools/call` fires from a claude.ai conversation.

**Exit:** a PageVault tool call executes from a claude.ai web conversation.

</details>

---

## Phase 2 — Harden #22 to production ← **ACTIVE PATH**

The flow is **validated** (see RESOLVED, above). This is now the whole MCP job:
turn the proven spike into shippable code and get it onto prod. Ordered roughly
cheapest → riskiest.

- [ ] **Fix the `/health` 404 regression.** Wrapping the router in `OAuthProvider`
      (spike `worker/src/index.ts`) made `/health` return 404 (works on `main`).
      Confirmed on the test deploy. Check other non-OAuth routes (`/admin`, `/api`,
      `/`, `/v`, `/p`, `/render`) for the same — the wrapping changed the entry point,
      so nothing routed through `defaultHandler` is guaranteed until tested. The
      durable regression test for this lives in **#76** (non-OAuth-route audit).
- [ ] **Cloudflare Access as the upstream IdP.** Replace the spike's paste-the-
      `PAGEVAULT_API_TOKEN` consent screen (`worker/src/oauth.ts` `consentPage`) with
      real operator login. OAuth authenticates the **operator** to *their own* MCP
      server; `canView()` still owns document authorization (prime directives #5/#6).
      This is the one "do not ship as-is" item from the spike.
- [ ] **`OAUTH_KV` in provisioning — this is a real pipeline gap, now confirmed.**
      The deploy path (`context.mjs` generator + `scripts/deploy.mjs`) substitutes only
      the `PAGEVAULT` KV id; the spike's `OAUTH_KV` binding stays a
      `REPLACE_WITH_OAUTH_KV_ID` placeholder, so `make deploy` from the spike would fail
      or mis-bind. For the test deploy this was wired by hand (namespace `7a8fca83…`).
      Fix: teach `provision.mjs` to create `OAUTH_KV` and the generator to substitute
      its id (mirror the `PAGEVAULT` path). Store the id in `.pagevault.json`. (Ties #42.)
- [ ] **Preserve the Claude Code bearer path.** The entry point shortcuts
      `/mcp` + valid `PAGEVAULT_API_TOKEN` before OAuth sees it. Verified still 200 on
      the test deploy — keep it, and add a regression test.
- [ ] **Make it provably solid — the MCP robustness pair (why tonight slipped
      through: `verify`/`health` never touch `/mcp`):**
  - [ ] **#75 — live MCP smoke in `verify` + `health`.** Drive `initialize` /
        `tools/list`, a guarded `publish→read→revoke` round-trip, and OAuth discovery
        (`/.well-known/*`, `/register`) against the live deploy. Makes `make verify`
        mean "MCP actually works," and would have caught the `/health` 404. Highest ROI
        — land it early in Phase 2 so every subsequent deploy is guarded.
  - [ ] **#76 — comprehensive MCP test coverage** at the `auth.test.ts` incident tier:
        per-tool happy/error paths, **cross-portal isolation** (prime directive #5),
        the OAuth flow (302→303, CSP), the non-OAuth-route audit, and the #74 / #63
        regressions. Wire into `make check` (pre-PR gate).
- [ ] **Watch `static_headers` GA.** If it lands, a ~50-line static-bearer endpoint
      deletes most of this. Don't gold-plate the OAuth code.
- [ ] **Deploy to prod** (`danjamkuhn.com`) once Access-login + provisioning + tests
      land: merge `feature/22-oauth-spike` → `main`, create prod's `OAUTH_KV`, deploy.
      Then re-run the live claude.ai connector test against prod.
- [ ] **Revert the test env** to `main` when done validating (test currently runs the
      spike), and tear down the throwaway worktree.

**Note:** #74 (overwrite-guard KV race) surfaced during this validation but is a
`track: core` bug, not #22 hardening — fix on its own track.

**Exit:** #22 merged to `main` and live on prod; claude.ai / Desktop / mobile reach
the operator's own PageVault with real Access login; **#75 verify-smoke and #76
test suite green** so the surface is provably solid, not just working-once.

---

## Phase 3 — Desktop reach now, regardless of Phase 0 (#21)

**Independent of the OAuth outcome — do it in parallel.** The stdio shim reaches
**Claude Desktop today** with zero Anthropic dependency, and it's fully in our
control. ADR-006 sanctions it as a *proxy to `/mcp`*, not a reimplementation.

- [ ] Create the `mcp/` package: stdio MCP server (MCP SDK stdio transport) that
      proxies `initialize` / `tools/list` / `tools/call` to remote `/mcp`, injecting
      `Authorization: Bearer <token>`.
- [ ] Config from env/args: `PAGEVAULT_URL` + `PAGEVAULT_API_TOKEN`. No baked token.
- [ ] Forward verbatim — do **not** duplicate tool defs from `worker/src/mcp.ts`.
- [ ] README: the Claude Desktop config snippet (command/args/env).
- [ ] Document the ~150k-char Desktop tool-result cap so `read_document` on a large
      report degrades predictably.
- [ ] Ship as a **second bin** in the `pagevault` npm package — guarded by #56 (below).

**Exit:** Claude Desktop publishes/reads via PageVault. This alone answers "we can't
authenticate" for the terminal-adjacent surfaces.

---

## Parallel track — packaging the full lifecycle

Not blocked by MCP auth. The `pagevault` npm package is already live (0.1.0) and
covers **operate** (`publish/list/share/rm/export/login`). The gap is that
**deploy** lives only in `make` + `scripts/`, so a new user has two acquisition
modes (clone-to-deploy, npm-to-operate). Close the seam.

- [ ] **#56 — pack-and-install smoke test. DO THIS FIRST.** `npm pack` → install
      tarball into a temp dir → run `pagevault --version` / `help`. Wire as
      `prepublishOnly`. You're already published unguarded; npm versions are permanent.
      This also guards the new #21 bin.
- [ ] **#63 — markdown publish from CLI + MCP.** Small, and **verified still broken
      2026-07-19**: MCP `publish_document` has only an `html` param (passes
      `source: args.html`); CLI `publish` reads the file straight into `html` with no
      extension detection. CLI infers `sourceKind` from extension (`--source-kind`
      override); MCP `publish_document` gets an optional `sourceKind`. The Worker
      already accepts it (`parseSourceKind`). Bit us live (showcase doc needed raw
      `curl`). **Pin to the near-term cluster (with #56/#21).**
- [ ] **#73 — CLI ↔ MCP surface parity (filed 2026-07-19: full parity).**

      > **Design principle (Dan, 2026-07-19):** the **CLI and MCP server are the
      > maximum feature set**. If any surface falls short of parity, it must be the
      > **console/portal app** — never the CLI or MCP. Artifacts get made in
      > conversations and terminals; the console is the occasional GUI. This governs
      > every future "where does this feature live?" decision, not just this issue.

      Bring the terminal up to the MCP tool surface. Add four commands:
      - `pagevault read <id>` — mirror `read_document` (rendered or `--source`).
      - `pagevault search <portal> <query>` — mirror `search_portal`.
      - `pagevault revoke <id>` — mirror `revoke_document` (kill a leaked link).
      - `pagevault rotate <id>` — revoke + re-mint the public link (the `rotate` from
        #7 that never shipped); print only the new URL to stdout so it pipes.
      - **`/api` gap (verified 2026-07-19) — this is NOT a pure thin-client change:**
        - `read` → ✅ `GET /api/docs/{id}` exists (`getDocHandler`, + raw variant). CLI-only.
        - `search` → ❌ no `/api` route; `search_portal` calls the Worker directly.
          **Needs a new `/api` search endpoint** + `worker/src/api.ts` handler.
        - `revoke`/`rotate` → ⚠️ `DELETE /api/docs/{id}` is *delete the doc* (= `rm`),
          **not** public-token revoke. Link mint/revoke needs new endpoints or an
          extension of the existing `PATCH /api/docs/{id}` (`patchDocHandler`). Check
          what `mint_public_link` / `revoke_document` call in `mcp.ts` and mirror it.
      - So scope = CLI commands **+** Worker `/api` (search + public-link lifecycle).
        Bigger than #63; file as its own GHI on the Roadmap board (`track: packaging`,
        reference #7). `read` can ship first (no Worker change) if you want a quick win.
- [ ] **#42 — provisioning commands in the binary** (`init` / `upgrade` /
      `sync-access`). The keystone: makes `pagevault` the single deploy+operate
      surface. Shell out to `npx --yes wrangler@4` — no wrangler dependency. Keep
      provisioning logic separate from #7's thin `/api` client. Depends on `provision.mjs`
      (done) — and now also carries the `OAUTH_KV` creation from Phase 2.
- [ ] **#28 — Deploy to Cloudflare button.** Zero-terminal Tier-0 on-ramp. **Verify
      the open question first:** can the button prompt for a *secret* (`PAGEVAULT_API_TOKEN`)
      or only a plaintext var? If only a var, button deploys secret-unset + README
      directs a one-line `wrangler secret put`.
- [ ] **#33 — LLM-legible agent runbook.** Follows #42/#28 (it *drives* them). The
      on-brand "ask Claude to set this up" path.

---

## Recommended sequencing

Phases 0 & 1 are **resolved** (OAuth validated — it was a deployment gap). The
sequence is now Phase 2 + the packaging track.

**MCP track — Phase 2 (harden #22 → prod):**
1. **#75** live MCP smoke in `verify`/`health` (land early — guards every deploy below).
2. `/health` 404 fix + non-OAuth route audit.
3. `OAUTH_KV` in `provision.mjs` + the config generator (the confirmed pipeline gap).
4. Cloudflare Access as the real IdP (replaces the paste-token consent screen).
5. **#76** comprehensive MCP tests + OAuth flow + cross-portal isolation → into `make check`.
6. Merge → prod deploy → live claude.ai retest against prod → revert test env.

**Packaging track (parallel, unblocked by MCP):**
- **#56** (pack-and-install test) first, then **#21** (Desktop shim), **#63**
  (markdown), **#73's `read` slice** (no Worker change — the quick parity win).
- Then **#42** (provisioning-in-the-binary, folds in `OAUTH_KV` creation), **#28**
  (deploy button), **#73's Worker-touching slice** (`/api` search + link lifecycle,
  then the `search`/`revoke`/`rotate` CLI commands), **#33** (agent runbook).

**Also on its own track:** **#74** (overwrite-guard KV race) — `track: core`, a
correctness bug in the shared publish path; fix independent of the above.

---

## Definition of done

- A PageVault MCP tool call executes from a **claude.ai web conversation** (the
  differentiator ADR-006 stakes the project on), **or** a documented, evidenced
  reason it's blocked platform-side with a re-test cadence.
- **Claude Desktop** works via the #21 shim.
- `pagevault` npm package is a single install for **deploy + operate + Desktop MCP**,
  guarded by a pack-and-install test so a broken tarball can't publish.

## Key files & references

- OAuth spike: `feature/22-oauth-spike` — `worker/src/oauth.ts` (uses
  `@cloudflare/workers-oauth-provider@0.8.1`), `worker/src/index.ts`,
  `worker/wrangler.jsonc` (`OAUTH_KV`), `worker/test/oauth.test.ts`.
- Remote server: `worker/src/mcp.ts` (9 tools). Bearer auth: `worker/src/auth.ts`
  (`isAuthorized`, the Claude Code path to preserve).
- CLI: `cli/` (published `pagevault` 0.1.0). Provisioning: `scripts/provision.mjs`,
  `Makefile`.
- ADR-006 (`docs/adr/ADR-006-remote-mcp.md`) — remote, staged auth.
- Reference implementation: **RealPlus** MCP server (Dan's machine) — the working
  custom OAuth connector to diff against.
- Issues: #22 (OAuth), #21 (stdio shim), #63 (markdown), #56 (pack test), #42
  (provisioning CLI), #28 (deploy button), #33 (agent runbook).
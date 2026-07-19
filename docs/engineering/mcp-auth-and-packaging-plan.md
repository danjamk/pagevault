# Implementation plan — MCP auth double-down + full-lifecycle packaging

**Drafted:** 2026-07-19 · **Start:** 2026-07-20 · **Owner:** Dan

Two objectives that are really one npm package finishing its job. The near-term
bet is **MCP OAuth on claude.ai**, reframed by a new asset: a *working* custom
remote MCP OAuth connector on Dan's own account (**RealPlus**) to diff against.

---

## The bet (read this first)

The 2026-07-16 spike (#22) proved PageVault's OAuth 2.1 flow completes end-to-end
against claude.ai, then concluded the failure was **Anthropic's** connector
regression ([claude-ai-mcp #430](https://github.com/anthropics/claude-ai-mcp/issues/430),
[#476](https://github.com/anthropics/claude-ai-mcp/issues/476)) and recommended
**hold**.

That conclusion no longer fits the evidence:

| Fact | Date | Implication |
|---|---|---|
| Regression window (last-working bind → first failures) | 2026-05-25 → 2026-06-08 | Real bug existed |
| #430 filed, closed *not planned* | 2026-06-11 | Anthropic won't fix the old report |
| #476 still open | as of 2026-07-19 | Some connectors still fail |
| **RealPlus custom OAuth connector built + connected** | ~2026-07-12 | **A custom connector CAN work post-regression** |
| **PageVault spike failed** | 2026-07-16 | On the same account, same week RealPlus worked |

**If a custom remote MCP OAuth connector works on Dan's claude.ai (RealPlus) but
PageVault's doesn't, the difference is our implementation, not the platform.**
The spike attributed the token-binding drop to Anthropic via a control experiment
against *its own* endpoint. RealPlus is a stronger control: a *different, working*
endpoint on the *same* account. Prove the delta is ours, fix it, ship it.

**Unknowns to close before assuming it's us (Phase 0 does this):**
- Was RealPlus added as a *personal custom connector*, or an *org/enterprise-managed*
  one? Enterprise-managed connectors may route differently and dodge the regression.
- Exact add-date of RealPlus (before vs after 2026-05-25 changes the story).
- Does re-adding RealPlus *today* still bind, or did it bind once and coast on
  refresh tokens?

---

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

---

## Phase 2 — Harden #22 to production

Once the flow works (via Phase 1 fix, or because the regression cleared). Turns the
spike into shippable code. These are the spike's own documented carry-overs.

- [ ] **Cloudflare Access as the upstream IdP.** Replace the spike's paste-the-
      `PAGEVAULT_API_TOKEN` consent screen (`worker/src/oauth.ts` `consentPage`) with
      real operator login. OAuth authenticates the **operator** to *their own* MCP
      server; `canView()` still owns document authorization (prime directives #5/#6).
- [ ] **`OAUTH_KV` in provisioning.** `worker/src/wrangler.jsonc` gains the `OAUTH_KV`
      binding on the spike; `scripts/provision.mjs` must create that namespace or a
      future `make provision` wipes the binding. (Ties into #42.)
- [ ] **Preserve the Claude Code bearer path.** The entry point shortcuts
      `/mcp` + valid `PAGEVAULT_API_TOKEN` before OAuth sees it. Keep that; it's the
      one surface that works today. Regression-test it.
- [ ] **Tests over the real OAuth flow**, in the spirit of `worker/test/auth.test.ts`
      (extend `worker/test/oauth.test.ts`). The 302→303 and CSP bugs were invisible to
      unit tests — add flow-level coverage where feasible.
- [ ] **Watch `static_headers` GA.** If it lands, a ~50-line static-bearer endpoint
      deletes most of this. Don't gold-plate the OAuth code.

**Exit:** #22 merged to `main`; claude.ai / Desktop / mobile reach the operator's
own PageVault with real login.

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

**Tomorrow, in order:**
1. **Phase 0** — the decisive experiment (RealPlus re-add + PageVault spike re-drive). ~2 hrs.
2. Branch on the gate. Expected path: **Phase 1** (diff & fix).
3. In parallel from the start, whoever/whenever: **#56**, then **#21** (Phase 3),
   then **#63**, then **#73's `read` slice** (mirrors `read_document`, no Worker
   change — the quick parity win). These don't wait on OAuth.

**After OAuth reaches claude.ai (Phase 1/2 done):**
4. **Phase 2** harden + merge #22.
5. **#42** (folds in `OAUTH_KV` provisioning), **#28**, **#33**.
6. **#73's Worker-touching slice** — the new `/api` search + public-link
   lifecycle endpoints, then the `search` / `revoke` / `rotate` CLI commands.
   Group with #42 (both touch the Worker) rather than the pure-CLI cluster.

**If Phase 0 says the regression is still live for personal connectors:**
- Ship #21 + the packaging track. Park #22 on the spike branch. Re-run Phase 0 on a
  cadence (the spike is the ready-made test rig). Don't build more OAuth into an
  inert surface.

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
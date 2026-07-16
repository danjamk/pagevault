# PageVault — Onboarding Experience Design

**Status:** Draft · 2026-07-16
**Relates to:** ADR-008 (progressive provisioning), #7 (CLI), #9 (provisioning),
#10 (README), #28 (Deploy button)

The setup path is the entire product for anyone who isn't me. If it doesn't work
start to finish for a stranger, nothing else in this repo matters. This document
designs that path before we build more of it — so each piece (`#7/#9/#28/#10`)
gets built against one map instead of in isolation.

---

## The principle: frictionless start, opt-in power

Nobody should have to learn what a portal is to publish their first link. The
first run gets you a working, shareable URL with the least possible ceremony;
every heavier capability (a client collection, email-secured access) is something
you turn on later, deliberately, when you have a reason. This is prime directive
#3 and ADR-008, applied to the whole journey and not just the vocabulary.

---

## One hub, two axes

Every entry point — a Medium article, the public showcase, the GitHub repo —
funnels to **the repo as the canonical documentation hub.** Medium and the
showcase make the argument and link here; the repo is where setup actually
happens. So the repo's docs carry the entire onboarding load, and their quality
*is* the onboarding quality.

At the hub, two independent choices:

```
Medium ┐
Show-  ├──→  THE REPO  ──→  TIER?   Tier 0  publish public links   (no domain / ZT / card)
case   │     (docs)         │       Tier 1  client portals         (domain + ZT + Access)
repo   ┘                    │
                            └──→  PATH?   1. Clone      developer, full control  ◀ FOCUS
                                          2. Deploy button (#28)  one-click, Tier-0 only
                                          3. npm (#7)   npx, no clone
                                          4. LLM-guided  rides on top of any above  ◀ FOCUS
```

- **The tier axis is the honest gate.** Tier 0 is genuinely free and instant.
  Tier 1 costs a domain and a credit card on file (Cloudflare requires one to
  enable Zero Trust, even on the free plan — confirmed 2026-07). We state that
  cost plainly rather than burying it.
- **The path axis is just "how much terminal do you want to touch."** The paths
  share ~80% — same prerequisites, same provisioning core, same verification,
  same teardown. They differ in the wrapper and the first sixty seconds.

---

## The upgrade ladder

The two tiers are really **three rungs**, and the middle one is the unlock: you
can put your own domain on a Tier-0 deployment *without* Access, Zero Trust, or a
credit card. "Use my domain" and "turn on portals" are separate upgrades, and only
the last one crosses into Tier 1.

| Rung | What you get | What it adds | New prerequisite | Reversible? |
|---|---|---|---|---|
| **1 · Publish** *(Tier 0)* | Deploy to `*.workers.dev`, publish HTML, share `/p/` links, read/search via MCP | — | CF account (**no card**), Node 22, `wrangler login` | n/a |
| **2 · Your domain** *(Tier 0)* | The same, served on `pagevault.you.com` | a custom-domain route | a domain **in the account** | yes — drop the route, redeploy |
| **3 · Portals** *(Tier 1)* | Client collections, the owner console, email-secured `/v` | two Access apps, viewer group, One-Time PIN | Zero Trust (**needs a card**), a scoped API token | Access is reversible; **Zero Trust is the one-way door** |

Two things make the ladder work:

- **Every rung is additive.** The KV namespace, portals, and documents carry
  across untouched — you never rebuild, you only add. Climb a rung when you have a
  reason, not before.
- **Only rung 3 is a commitment.** Rungs 1 and 2 cost nothing and undo cleanly.
  Zero Trust is the single step that can't be automated away or cleanly reversed,
  so it comes last, and only when portals are actually wanted.

Notes that don't fit the table: a custom domain is *required* for rung 3 because
Cloudflare Access cannot protect a `*.workers.dev` host. Seats (one per distinct
viewer, 50 free) are consumed only at rung 3, on login — rungs 1–2 authenticate
nobody. This ladder is what makes "one-click install, then upgrade when you need
to" a real promise rather than a slogan.

---

## The four paths

1. **Clone** *(focus)* — `git clone`, then the scripts. Full control, the
   reference implementation, what every other path is a convenience over.
2. **Deploy button** (#28) — one click clones the repo into the visitor's
   Cloudflare account and deploys. Reaches **Tier 0 only** — it cannot do the
   Access provisioning, so it hands off to the script for Tier 1.
3. **npm** (#7) — `npx pagevault` / `npm i -g pagevault`. Clone-without-cloning
   for people who don't want the repo checked out. Wraps the same core.
4. **LLM-guided** *(focus)* — not a separate build. It's a quality bar on the docs
   and tools that lets an agent drive paths 1–3 (see below).

---

## Focus 1 — the clone path at Tier 0 (the reference journey)

Ground zero to a shared link, no domain, no Zero Trust, no card:

1. **Prerequisites** — a Cloudflare account, Node 22, git. Nothing bought.
2. `git clone …` and `pnpm install`.
3. `wrangler login` — OAuth into their Cloudflare account.
4. **Verify** — `node scripts/preflight.mjs` in a Tier-0 mode confirms the account
   and token before anything is created. (Preflight exists; a Tier-0 profile of it
   is a gap — see Core.)
5. **Create KV** — `wrangler kv namespace create PAGEVAULT`.
6. **Minimal config** — KV id + owner email. No Access AUDs, no team name, no
   custom domain. `workers.dev` enabled. (Today's `wrangler.jsonc` is Tier-1
   shaped: `workers_dev: false` and Access vars required. A Tier-0 config profile
   is a gap.)
7. **Set the secret** — `wrangler secret put PAGEVAULT_API_TOKEN`.
8. **Deploy** — `wrangler deploy`.
9. **Publish** — connect the MCP with the token (or the CLI), publish a document,
   get a `/p/` link.
10. **Open the link** — it renders, no login. Tier 0 done.

The routes that need Access (`/v`, `/admin`) fail closed at Tier 0, which is
correct — you aren't using them yet. When you want them, you level up.

### Make is the interface

The clone path's front door is the Makefile, not a pile of remembered commands.
`make help` lists everything, and the manual workflow is packaged as targets a
person runs and an LLM can run identically:

- `make setup` — install dependencies, scaffold config, and stop early if the
  environment is wrong (Node version, missing `.dev.vars`).
- `make preflight` — **before** deploy: `preflight.mjs` (account / token / config
  readiness) plus local checks (deps present, config filled, secret set), report
  gaps. Read-only, safe anytime.
- `make deploy` — deploy.
- `make verify` — **after** deploy: a smoke test that also checks the
  infrastructure — hit the live Worker, confirm KV is bound, confirm a
  publish→read round-trips. The "did the deploy actually work" gate.
- `make test` · `make destroy` — as today.
- `make upgrade` — climb a rung (see #7).

The pairing matters: `preflight` catches a broken *environment* before you spend a
deploy; `verify` catches a broken *deployment* after. Two payoffs beyond that: a
person gets a short, legible workflow instead of a runbook, and an agent gets a
**stable, named surface to drive** — "run `make preflight`, read the output, fix
what it names" is something an LLM does well. The action targets mostly exist;
`setup`, `preflight`, and `verify` (as Make targets) don't yet.

---

## Focus 2 — the LLM overlay

This is the most on-brand path, because it *is* the thesis: someone is in a Claude
conversation, finds PageVault, and asks *"how do I set this up?"* For that to
work, our presence has to be **legible to an agent**, not just to a human reader.

That means two things, and neither is a fourth codebase:

1. **An agent-facing runbook** — the same content the human README carries, but
   structured as an executable decision tree: which tier, which path, the exact
   commands, the named prerequisites, and what each failure means. An LLM reading
   it can *walk a user through*, or *do it*. Candidate home: an `llms.txt` at the
   repo root and/or `docs/setup/AGENT.md`.
2. **Agent-drivable tools** — `preflight`, `provision`, and `destroy` already
   behave like something an agent can operate: clear steps, named failures, exit
   codes, idempotent re-runs. Sharpening that (stable output, a `--json` mode) is
   cheap and pays off here.

The endgame: *"clone the repo, open it in Claude Code, say 'set up PageVault Tier
0.'"* The agent runs preflight, creates the KV, deploys, and hands back a URL.
Cloudflare's own CLI and MCP server are tools it can reach for. The operator is a
person with an LLM at the wheel — riding the clone path, not a new one.

---

## The common core (shared by every path)

| Piece | State |
|---|---|
| **Prerequisites doc** — CF account, Node, (Tier 1: domain, card) | gap — needs writing (#10) |
| **`preflight.mjs`** — read-only account verification | exists; needs a Tier-0 profile |
| **Tier-0 deploy** — minimal config + `wrangler deploy`, no Access | **gap** — no helper today |
| **`provision.mjs`** — Tier-1: KV, group, two Access apps, OTP, config | exists; hardening in #9 |
| **`destroy.mjs`** — teardown / reset loop | exists |
| **Agent runbook** — `llms.txt` / `AGENT.md` | gap |

The paths are wrappers over this core. Build the core well and clone/button/npm
are mostly packaging.

---

## What we build first

**Clone path + LLM-legible docs + Tier 0.** Rationale:

- It's what already works and what I use, so it's the least speculative.
- It's the substrate the others optimize: npm is clone-without-cloning; the button
  is a clone-less Tier-0 deploy. Design clone well and they get easier.
- It's what makes the LLM path real — the LLM path is the clone path with good
  docs and drivable tools.
- Tier 0 is testable **today**, on the clean account, with nothing purchased.

Sequence: (1) a Tier-0 config profile + deploy path, (2) the prerequisites doc and
the clone runbook, written LLM-legibly, (3) the agent runbook, (4) then the button
(#28) and npm (#7) as packaging over the proven core, (5) Tier-1 hardening (#9) as
the deliberate level-up.

---

## Open questions

- **Tier-0 config**: a second committed config profile, a flag on `provision`, or a
  documented hand-edit? A profile is cleanest; decide before building.
- **`llms.txt` vs `AGENT.md` vs both** — and how much the agent should *do* versus
  *guide*. Probably: guide by default, do on request.
- **Where the button lands a stranger** — Tier 0 only, with an explicit "here's how
  to level up" pointer to the script. Confirm the button can prompt for the secret
  (open question on #28).

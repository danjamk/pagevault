# PageVault — Onboarding Experience Design

**Status:** Original onboarding design (2026-07-16), since largely realized.
**Relates to:** [ADR-008](../adr/ADR-008-progressive-provisioning.md) (progressive provisioning).

> **This is a design record, not the current how-to.** It uses the **original three-tier naming**
> (1 · sharing something, 2 · sharing privately, 3 · running a practice). That naming is
> **retired**: [ADR-018](../adr/ADR-018-public-and-secured-tiers.md) replaced it with two
> user-facing tiers, **Public** and **Secured**, over three internal rungs a user never sees.
> Tiers 1 and 2-without-Access are today's **Public**; tier 2-with-Access and tier 3 are
> **Secured**, where portals are a data model rather than a level. Read the shape below, not the
> labels — the reasoning holds and only the vocabulary moved.
>
> The operational specifics further down (the manual step-by-step, the "gaps," the
> "what we build first" order) are the *original plan* — since realized as the CLI (`pagevault init`),
> the [agent runbook](../setup/ai-guided-setup.md), and the [prerequisites doc](../setup/prerequisites.md),
> or dropped (the one-click Deploy button, #28). For the **current** setup path, start at the
> [README](../../README.md#is-this-for-you) and [`docs/setup/`](../setup/).

The setup path is the entire product for anyone who isn't me. If it doesn't work start to finish for
a stranger, nothing else in this repo matters. This document designed that path before it was built.

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
Show-  ├──→  THE REPO  ──→  TIER?   1  Sharing something   public /p/ links         (no domain / ZT / card)
case   │     (docs)         │       2  Sharing privately   your domain, email-gated  (Zero Trust, card on file)
repo   ┘                    │       3  Running a practice  per-client portals
                            │
                            └──→  PATH?   1. npm         `pagevault init`, no clone    ◀ default
                                          2. clone       developer, full control
                                          3. LLM-guided  rides on top of either
```

- **The tier axis is the honest gate.** Tier 1 is genuinely free and instant. The real jump is
  1 → 2: Cloudflare wants a credit card on file before it will enable Zero Trust, even on the free
  plan (confirmed 2026-07). We state that cost plainly rather than burying it. Tier 3 (portals) is a
  data model on top of tier 2 — no new cost.
- **The path axis is just "how much terminal do you want to touch."** The paths share ~80% — same
  prerequisites, same provisioning core, same verification, same teardown. They differ in the wrapper
  and the first sixty seconds. (The one-click Deploy button once considered here was dropped — it
  couldn't set the runtime secret or do Access, so it dead-ended at an unusable tier 1.)

---

## The upgrade ladder

Three tiers, and the middle one splits into two half-steps: you can put your own domain on a tier-1
deployment *without* Access, Zero Trust, or a card. "Use my domain" and "gate it to named people" are
separate upgrades, and only the second crosses the card-on-file line.

| Tier | What you get | What it adds | New prerequisite | Reversible? |
|---|---|---|---|---|
| **1 · Sharing something** | Deploy to `*.workers.dev`, publish HTML/Markdown, share `/p/` links, read/search via MCP | — | CF account (**no card**), Node 22 | n/a |
| **2 · Sharing it privately** | The same on `pagevault.you.com`, gated to named emails (One-Time PIN), the owner console | a custom-domain route, then two Access apps + a viewer group | a domain **in the account**; Zero Trust (**a card on file**), a scoped API token | the domain/route is reversible; **Zero Trust is the one-way door** |
| **3 · Running a practice** | Per-client portals — permissions on the client, not the document | the portal data model on top of tier 2 | same as tier 2 | yes — portals are just data |

Two things make the ladder work:

- **Every tier is additive.** The KV namespace, portals, and documents carry across untouched — you
  never rebuild, you only add. Climb when you have a reason, not before.
- **The real commitment is turning on Zero Trust — the 1 → 2 jump.** Publishing on your own domain
  without gating is reversible; Zero Trust is the single step that can't be automated away or cleanly
  reversed, so it comes only when private access is actually wanted. Tier 3 (portals) adds no cost or
  irreversible step over tier 2 — it's a data model.

Notes that don't fit the table: a custom domain is *required* before you can gate anything, because
Cloudflare Access cannot protect a `*.workers.dev` host. Seats (one per distinct viewer, 50 free) are
consumed only from tier 2, on login — tier 1 authenticates nobody. This ladder is what makes
"install, then upgrade when you need to" a real promise rather than a slogan.

---

## The paths (as shipped)

1. **npm** *(default)* — `npm i -g pagevault && pagevault init`. Provisions and deploys with no repo
   checkout; the package carries a prebuilt Worker. The on-ramp most people take.
2. **clone** — `git clone`, then `make`. Full control, the reference implementation, for reading or
   changing the code. Every other path is a convenience over the same core.
3. **LLM-guided** — not a separate build. It's a quality bar on the docs and tools that lets an agent
   drive the npm or clone path (see below), realized as [`ai-guided-setup.md`](../setup/ai-guided-setup.md).

*(The one-click Deploy button (#28) explored in the original design was dropped — it couldn't set the
runtime secret or do Access provisioning, so it dead-ended at an unusable tier 1.)*

---

## Focus 1 — the clone path at tier 1 (the reference journey)

Ground zero to a shared link, no domain, no Zero Trust, no card:

1. **Prerequisites** — a Cloudflare account, Node 22, git. Nothing bought.
2. `git clone …` and `pnpm install`.
3. `wrangler login` — OAuth into their Cloudflare account.
4. **Verify** — `node scripts/preflight.mjs` in a tier 1 mode confirms the account
   and token before anything is created. (Preflight exists; a tier 1 profile of it
   is a gap — see Core.)
5. **Create KV** — `wrangler kv namespace create PAGEVAULT`.
6. **Minimal config** — KV id + owner email. No Access AUDs, no team name, no
   custom domain. `workers.dev` enabled. (Today's `wrangler.jsonc` is tier 2
   shaped: `workers_dev: false` and Access vars required. A tier 1 config profile
   is a gap.)
7. **Set the secret** — `wrangler secret put PAGEVAULT_API_TOKEN`.
8. **Deploy** — `wrangler deploy`.
9. **Publish** — connect the MCP with the token (or the CLI), publish a document,
   get a `/p/` link.
10. **Open the link** — it renders, no login. tier 1 done.

The routes that need Access (`/v`, `/admin`) fail closed at tier 1, which is
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
- climbing a tier — re-run `make deploy` (or `pagevault init`); it reads the tier from
  `.pagevault.json` and provisions only what the new tier adds.

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
| **Prerequisites doc** — CF account, Node, (tier 2: domain, card) | gap — needs writing (#10) |
| **`preflight.mjs`** — read-only account verification | exists; needs a tier 1 profile |
| **tier 1 deploy** — minimal config + `wrangler deploy`, no Access | **gap** — no helper today |
| **`provision.mjs`** — tier 2: KV, group, two Access apps, OTP, config | exists; hardening in #9 |
| **`destroy.mjs`** — teardown / reset loop | exists |
| **Agent runbook** — `llms.txt` / `AGENT.md` | gap |

The paths are wrappers over this core. Build the core well and clone/button/npm
are mostly packaging.

---

## What we build first

**Clone path + LLM-legible docs + tier 1.** Rationale:

- It's what already works and what I use, so it's the least speculative.
- It's the substrate the others optimize: npm is clone-without-cloning; the button
  is a clone-less tier 1 deploy. Design clone well and they get easier.
- It's what makes the LLM path real — the LLM path is the clone path with good
  docs and drivable tools.
- tier 1 is testable **today**, on the clean account, with nothing purchased.

Sequence: (1) a tier 1 config profile + deploy path, (2) the prerequisites doc and
the clone runbook, written LLM-legibly, (3) the agent runbook, (4) then the button
(#28) and npm (#7) as packaging over the proven core, (5) tier 2 hardening (#9) as
the deliberate level-up.

---

## Open questions

- **tier 1 config**: a second committed config profile, a flag on `provision`, or a
  documented hand-edit? A profile is cleanest; decide before building.
- **`llms.txt` vs `AGENT.md` vs both** — and how much the agent should *do* versus
  *guide*. Probably: guide by default, do on request.
- **Where the button lands a stranger** — tier 1 only, with an explicit "here's how
  to level up" pointer to the script. Confirm the button can prompt for the secret
  (open question on #28).

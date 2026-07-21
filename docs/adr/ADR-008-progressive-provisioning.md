# ADR-008 — Progressive provisioning: a Publish tier before a Portals tier

**Status:** Proposed
**Date:** 2026-07-15

## Context

The operator's first-run experience is a stated differentiator. The positioning is
blunt about it: *"A tool that demands a taxonomy before it gives you a URL is a tool
nobody adopts."* Prime directive #3 says the same thing from the product side —
portals are invisible until needed, and `pagevault publish report.html` must work
without the user learning what a portal is.

Today it does not. `cli/lib/provision/provision.mjs` does everything at once — KV namespace,
One-time-PIN IdP, the `pagevault-viewers` group, the `/v` and `/admin` Access
applications, and a custom domain — before the operator can share a single document.

Two facts make that all-at-once step unnecessary for a new operator:

- **Only `/v/` and `/admin` sit behind Cloudflare Access.** `index.ts` is explicit:
  `/render`, `/p/*`, `/api/*`, and `/mcp` have no Access application in front of
  them — they gate on capability tokens or the bearer API token. Publishing via
  CLI/MCP and sharing a `/p/` public link involve Access **not at all**. We proved
  this on the live deployment: the `/mcp` bearer flow worked with Access uninvolved.
- **The heaviest setup step exists only for Access.** Tier 1 needs a Cloudflare API
  token carrying *Access: Apps and Policies — Edit* and *Access: Organizations,
  Identity Providers, and Groups — Edit* (ADR-002 warns the second is easy to miss).
  An operator who only shares public links never needs that token, or a group, or an
  IdP, or a custom domain.

And the **"disable `workers.dev`"** gotcha in `CLAUDE.md` exists precisely because a
`workers.dev` subdomain routes around Cloudflare Access. With no Access in front of
anything, there is nothing to route around — so `workers.dev` is a legitimate
zero-config hostname, not a hole, *until Access is introduced.*

So the all-at-once flow front-loads the most painful configuration in the entire
product onto the person with the least invested. That is the adoption failure the
positioning explicitly warns against.

## Decision

Provisioning becomes **two tiers, entered in order.**

### Tier 0 — Publish (the default; zero Access)

- Credential: `wrangler login` (browser OAuth). Nothing else.
- Deploy creates the KV namespace, generates and sets `PAGEVAULT_API_TOKEN`, and
  deploys — to a `workers.dev` subdomain by default, or a custom domain if the
  operator brings one.
- The operator publishes via CLI/MCP (bearer auth) and shares `/p/` public links.
- No IdP, no group, no Access application, no custom domain required.

This is "install → share a document" with no concept to learn and no Access token to
mint. It is the literal form of prime directive #3.

### Tier 1 — Portals (opt-in: `pagevault enable-portals` / `make provision`)

- Credential: a Cloudflare API token with Access edit rights (as today).
- Provisions the OTP IdP, the `pagevault-viewers` group, the `/v` and `/admin`
  Access applications, and moves to a custom domain.
- Unlocks email-secured viewing, portals, clients (Viewers), and the owner console.
- **Disables the `workers.dev` subdomain and Preview URLs as part of the
  transition** — non-negotiable and tested. A live `workers.dev` route after Access
  goes up is the documented bypass hole.

### The three onboarding paths express the same two tiers

- **Package (`npx pagevault init`)** — an interactive wizard: Tier 0 by default,
  `enable-portals` when the operator wants clients.
- **Cloned repo** — `make deploy` performs Tier 0; `make provision` becomes the
  Tier-1 `enable-portals` step. `provision.mjs` splits along this seam.
- **LLM-driven (e.g. Claude Code)** — an agent-executable runbook drives `wrangler`
  and, optionally, the Cloudflare MCP server through Tier 0, stopping only for the
  one browser-OAuth click (`wrangler login`) that cannot be delegated.

## Alternatives considered

**All-at-once provisioning (status quo).** One command, fully configured; the
simplest mental model. Rejected as the default: it front-loads the
API-token-with-Access-permissions step and a custom domain onto someone who just
wants a URL — the exact "demands a taxonomy before it gives you a URL" failure — and
it makes a fast path impossible. Retained as what Tier 1 does, just gated behind an
explicit opt-in.

**Always require a custom domain (skip `workers.dev` entirely).** Cleaner: no
throwaway URLs and no migration that breaks `/p/` links. Rejected as the default
because it forces DNS work before the first share. Kept as an explicit
recommendation for anyone past validation — see the migration consequence below.

**A console without Access in Tier 0 (token-exchange login).** Would give the
zero-Access operator a browser console, not just CLI/MCP. Deferred, not rejected:
ADR-004 deliberately gates the `/admin` render behind Access, and adding a second
first-factor (exchange the API token for a session) is a real auth surface to design
carefully. Left as an open question; Tier 0 is CLI/MCP-only for now.

**A public tier on `workers.dev` with Access still enabled.** A non-starter:
`workers.dev` routes around Access by definition. The mutual exclusivity is the
point — Tier 0 (no Access) may use `workers.dev`; Tier 1 (Access) must disable it.

## Consequences

- `provision.mjs` splits into a Tier-0 deploy (no CF API token, no Access) and a
  Tier-1 `enable-portals` reconciler. Issue #9 is re-scoped around this seam.
- ADR-002's Access group and seat-bounding become **Tier-1 concerns.** In Tier 0
  there are no seats to bound because nobody authenticates. This cross-references
  ADR-002; it does not contradict it.
- **The Tier 0 → Tier 1 migration changes the hostname** (`workers.dev` → custom
  domain), which invalidates outstanding `/p/` public links. Acceptable for a
  validation phase; must be documented; operators who care bring a domain first.
- **`enable-portals` MUST disable `workers.dev` and Preview URLs.** Safety-critical,
  and it gets a test — a live `workers.dev` route after Access is up is the bypass
  hole `CLAUDE.md` warns about.
- **Tier 0 has no browser console** (ADR-004 gates `/admin` behind Access). CLI/MCP
  only, pending the open question above.
- **Testing requires a clean-room Cloudflare surface.** A partially-provisioned
  account cannot validate a first-run experience: the whole value being tested is
  what a *brand-new* operator hits, and stale KV, apps, IdP, or routes silently mask
  first-run bugs — as they did on the first real deploy this session. We need a
  repeatable path to a pristine state: a dedicated test Cloudflare account, a
  separate zero-state domain, or a `destroy` that returns the account to truly fresh
  (today's `destroy.mjs` deliberately leaves the Zero Trust org and seats alone).
  This is a prerequisite for trusting any onboarding test, not a nice-to-have, and
  it is tracked as its own work item when we reach implementation.
- The token-workflow automation discussed earlier (mint on provision, sync on
  deploy, connect for MCP) is **subsumed by this ADR**: it is simply how Tier 0's
  deploy behaves.
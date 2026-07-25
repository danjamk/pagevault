# ADR-018 — Two user-facing tiers: Public and Secured

**Status:** Accepted
**Date:** 2026-07-24
**Revises the presentation of:** ADR-008 (progressive provisioning)

## Context

ADR-008 set out **two** tiers — Publish (zero Access) and Portals (Cloudflare Access). The
implementation shipped **three rungs**: 1 = `workers.dev` public, 2 = your own domain (still
public), 3 = Access + portals. Splitting "public" into two rungs (with/without a domain) was
reasonable for the *deploy machinery* — a custom domain is a distinct provisioning step — but it
leaked into the *user's* mental model, and the README kept ADR-008's two-tier story on top of it.

Dogfooding (2026-07-24) exposed the cost: the CLI's `init` offers rungs "1 · 2 · 3" where **2 = a
domain, still public**, while the README's comparison table calls **Tier 2 = private, named people,
Zero Trust, a card**. Same number, two different things. An operator picked "2," got a public
domain deploy, then read "Tier 2 = named people" and reasonably asked *"wait, do I need Zero
Trust?"* The security boundary — **named-people / email-gating requires Cloudflare Zero Trust** — is
real and correct in the docs; the **numbering** is what misled.

The underlying truth: there are three *deployment* states but only **two that matter to a user** —
is there a login wall, or not. A domain is an enhancement, not a security level.

## Decision

Present **two tiers** to the user, everywhere the user looks (`init`, `status`, `verify`, README):

### Public
Public `/p/` links that anyone with the link can open. **Optionally on your own domain** — a
prompt *inside* Public, not a separate level. No Cloudflare Access, no card, no admin console, no
portals. This is "install → share a URL," prime directive #3.

### Secured
Requires a domain **and Cloudflare Zero Trust (a card on file)**. Adds the owner console, portals,
and documents gated to named email addresses. The `workers.dev` subdomain is disabled as part of
turning Access on (ADR-008, unchanged).

### The rung stays — as an implementation detail

`.pagevault.json` keeps `rung` (1/2/3) and the deploy/provision/verify machinery keeps keying on
it, **untouched and tested**. The mapping is internal and one-way:

| User picks | Domain? | Internal rung |
|---|---|---|
| Public | no | 1 (`workers.dev`) |
| Public | yes | 2 (custom domain) |
| Secured | (required) | 3 (Access + portals) |

The user never sees "rung." A maintainer sees a documented tier↔rung mapping and nothing else
moves. This is deliberately the *low-risk* half of Option B: reframe the surface, leave the
plumbing. Collapsing the internal model to `{secured, domain}` was considered and rejected —
schema churn and every `rung >=` check rewritten, for zero user benefit.

## Consequences

- **The confusion is gone**: the number/word a user picks in `init` means exactly what the README
  says, because there is one model on every surface.
- The `init` flow asks "Public or Secured?", then — for Public — "serve on your own domain?"
  (optional), suggesting the account's zones. Secured requires a domain and proceeds to Zero Trust.
- `--rung 1|2|3` remains accepted as the non-interactive escape hatch (and back-compat); a new
  `--tier public|secured` is the preferred flag. Both resolve to the same stored `rung`.
- The README's three `§` sections collapse to two (Public / Secured); "running a practice" becomes
  a *use* of Secured (portals), not a third numbered tier.
- ADR-008's decision (a public tier before an Access tier) stands; this only fixes how the ladder
  is **named and counted** for the user. No security boundary moves — named-people still requires
  Zero Trust.

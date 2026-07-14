# ADR-005 — Portals are the data model, from the start

**Status:** Accepted
**Date:** 2026-07-14

## Context

The original design published one document and returned one link. Permissions were an
`emails[]` array on the document.

Competitive research killed that as a *product*. The publish primitive is table
stakes: Anthropic's Publish button does it free, six vendors sell the gated version,
and [`jonesphillip/sharehtml`](https://github.com/jonesphillip/sharehtml) — Apache-2.0,
122★, written by a Cloudflare Group PM — does the self-hosted Cloudflare version with
*more* features than we had planned. We verified this by reading their source, not
their README.

**None of them solve the collection.** Every one treats the link as the unit. The
actual shape of the work is:

> Over a nine-month engagement, fourteen artifacts for one client. Fourteen links,
> fourteen emails, and a client digging through Gmail in March for the architecture
> doc from January.

**The link is not the unit. The client is.**

A flat model cannot express this. sharehtml's `owner_email` is a column on the
document: fourteen documents for one client means fourteen separate share calls, and
a client adding a person means editing fourteen records.

## Decision

Three entities. Permissions live on the **Portal**, not the Document.

```
Portal 1 ── * Document
   └── * Member (email)
```

Adding a person to a client's team is **one write, not fourteen**. That is the whole
idea.

Every document belongs to exactly one portal. `init` creates a `default` private
portal, so the user does not have to know what a portal is to publish their first
document — `--portal` is required **only when ambiguous** (2+ portals, no default).
The quickstart does not contain the word "portal."

Two escape hatches let a document be *more* visible than its portal, both explicit
owner acts, never inheritance:

- **`extraEmails`** — an additive per-document grant. This is what keeps
  `pagevault publish report.html --emails cfo@acme.com` working without inventing a
  portal for two people. Additive only: it can grant a viewer, never revoke one.
- **`publicToken`** — a capability link on a separate route that does not consult
  `canView` at all. Keeping widening physically separate from inheritance means a bug
  in one cannot become a bug in the other.

`ownerOnly` is the only narrowing rule, and it beats every grant.

Build it now, at issue #3 of 10, rather than after.

## Alternatives considered

**Keep the flat model; add portals later.** Genuinely tempting: the store, the bearer
auth, and the listing are already written and tested. Rejected on timing, not on
principle. Right now there are **zero users and zero data** — the "migration" is
deleting a KV namespace nobody has written to. After the console, the CLI, and the
MCP server are built against a flat model, it is a rewrite of every call site plus a
real migration plus a compatibility shim that never dies. The cost curve is steep and
we are standing at the bottom of it.

**A `client` tag instead of a portal entity.** Cheapest possible version: keep
documents flat, filter by `tag:client:acme`. Rejected because permissions are the
point. A tag cannot hold a member list, so adding a person to a client's team is
still fourteen writes — which is the exact problem. It would give us the *view* of a
collection with none of the mechanics.

**Portal required on every publish.** The first draft of the portal spec did this,
and it was wrong. It taxes the person who just has an HTML file with a concept they
do not need yet, on a tool whose entire pitch is *one command, get a link*. A tool
that demands a taxonomy before it gives you a URL is a tool nobody adopts. Ambiguity
is the trigger for requiring `--portal`, not existence.

**Full multi-tenancy (multiple owners, teams, roles).** Rejected outright. Single
operator is prime directive #1. A portal has one owner and N viewers.

## Consequences

- `DocMeta` gains `portal`, `ownerOnly`, `extraEmails`, `summary`, `sourceKind`. The
  `emails[]` from the flat model maps to `extraEmails`. No data migration is needed
  because there is no data.
- Authorization moves into one function, `canView()`, with an exhaustive matrix
  (ADR-004 and `docs/architecture.md` §5). The row that matters is **member of a
  *different* portal** — cross-portal leakage is the failure that ends a consulting
  business rather than losing a feature.
- The ordering of `ownerOnly` before `extraEmails` is load-bearing and non-obvious.
  Reversed, it silently leaks drafts while every other test still passes. It gets its
  own test.
- `extraEmails` is the crack through which per-document permission sprawl could creep
  back. The console nudges toward a portal when 3+ documents share the same extra
  emails — turning the sprawl into the upgrade path rather than a mess.
- Portal slugs need validation (`^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$`) and a reserved
  word list (`api`, `pub`, `p`, `v`, `admin`, `render`, `mcp`), enforced in **one**
  place, or a slug shadows a route.
- **This is a bet, and it is not proven.** The client-portal incumbents' own guidance
  says do not adopt a portal below ~10 active engagements, because onboarding
  overhead per client exceeds the benefit. We have ~1.5. The bet rests on two claims:
  that our onboarding cost is zero (no account, no invite — email OTP, one click), and
  that the collection is useful to the *owner* at n=1 because an agent can read it
  back. If both are false, the honest move is to keep the tool and drop the product.
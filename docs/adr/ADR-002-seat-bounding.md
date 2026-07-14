# ADR-002 — Bound Access seats with a synced group, not `Include: Everyone`

**Status:** Accepted
**Date:** 2026-07-13

## Context

The elegant version of this design uses one Access policy with **Include:
Everyone** and One-time PIN login. Access proves you own an email address; the
Worker then checks that address against the document's allowlist. Authorization is
handled entirely in KV, so publishing a document never touches Access config.

The authorization logic is sound. The problem is seats.

- A seat is consumed by **any successful Access authentication event**, by any
  unique email, regardless of what they were then allowed to see.
- The Zero Trust free plan is **50 seats**.
- Inactive users are **not** reaped by default. Cloudflare's built-in seat
  expiration has a **one-month minimum**, so it is a slow background process, not
  a control.
- **When the seats are full, further logins are blocked.**

So: anyone who knows the hostname — a client you sent a report to, or anyone who
reads this repo and guesses — can authenticate 50 throwaway addresses in a loop
and lock out the people who are actually supposed to read your documents. The
Worker still refuses to *show* them anything. It just can't stop them from taking
a seat on the way in.

Cloudflare lists `Include: Everyone` and unrestricted One-time PIN under
**"Common Cloudflare Access misconfigurations."** They are right, though not for
the reason people usually assume.

This is an availability problem, not an authorization problem, and it does not
show up in testing. It shows up months later when a client can't open a report.

## Decision

The `/d` policy includes a **single Cloudflare Access group**,
`pagevault-viewers`, containing the union of every document's allowlist (plus the
owner). Strangers cannot authenticate at all, so they cannot consume seats.

Maintaining it:

- **On publish / patch** — read the group, union in the new emails, `PUT`.
  Additive, cheap, idempotent, one API call.
- **On `pagevault sync-access`** — recompute the union from KV, `PUT` the whole
  list. Access group `PUT` is a **full replacement**, so this is exact. It repairs
  drift and any lost update from the hot-path read-modify-write. With `--reap` it
  also removes seats for emails no longer on any allowlist.

Seats are now bounded by people you deliberately invited, and it is *N unique
humans*, not *N documents* — a client on six reports is one seat.

**Public documents cost zero seats**, because `/p/*` has no Access application in
front of it and nobody ever authenticates.

If `CF_API_TOKEN` is unset, PageVault falls back to the `Include: Everyone` policy
and warns loudly at startup. The simple path stays open for someone who just wants
to try it and doesn't care.

## Alternatives considered

**`Include: Everyone` + document the risk + ship `reap` early.** The original
plan. Simplest setup, no CF API token needed. Rejected as the default: the failure
mode is your clients being locked out by a stranger, it is silent until it isn't,
and "we documented it" is not a mitigation. Kept as the fallback when no API token
is configured.

**One Access application per document, with the allowlist as the policy.** The
naive design. Access does both identity and authorization; no KV allowlist needed.
Rejected: it means an Access API call on every publish, an unbounded number of
applications, and it throws away the entire reason this architecture is nice. It
also doesn't fix seats — invited users still consume them; it only stops
strangers.

**Restrict the Include rule to specific email domains.** Cheap, no API token. Works
if you only ever share with `@bigcorp.com`. Useless for the actual use case, which
is sending a report to one person at an arbitrary company.

**Drop Access entirely; self-host email OTP (e.g. Resend).** Removes the seat cap
permanently and the Cloudflare Zero Trust dependency with it. This is genuinely the
right long-term answer and it is in the v2 backlog. Rejected for v1: it means
owning session management, OTP delivery, rate limiting, and replay protection —
a much bigger surface, and every part of it is a place to get authentication wrong.
Access is free and Cloudflare has already gotten it right.

## Consequences

- Setup now requires a Cloudflare API token with Access edit rights
  (*Access: Apps and Policies* — Edit, and *Access: Organizations, Identity
  Providers, and Groups* — Edit; the group permission is under the second one,
  which is easy to miss). `pagevault init` needs this token anyway to create the
  Access apps, so the marginal cost is zero.
- Access becomes a second source of truth alongside KV. They can drift.
  `sync-access` is the reconciler, and because group `PUT` is a full replacement,
  it is exact rather than best-effort.
- The hot-path group update is a read-modify-write against the Cloudflare API and
  has a lost-update race under concurrent publishes. For single-operator
  infrastructure this is acceptable, and `sync-access` repairs it. It is not
  acceptable to pretend it isn't there.
- Removing someone from every document does **not** free their seat until
  `sync-access --reap` runs. Seat hygiene is a deliberate operation, not an
  automatic one.
- `pagevault reap` was in the v2 backlog. It arrives in v1, essentially for free,
  as a flag on the reconciler.

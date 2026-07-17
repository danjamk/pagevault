# ADR-001 — Access topology: two path-scoped apps, no bypass policies

**Status:** Accepted
**Date:** 2026-07-13

## Context

PageVault serves five surfaces on one hostname with three different auth needs:

- `/d/{id}` — authenticated humans, per-document allowlist
- `/admin` — owner only
- `/p/{token}` — nobody authenticates; a capability URL
- `/api/*` — machines, bearer token
- `/` — a redirect

Cloudflare Access has to protect the first two and stay out of the way for the
rest. The original design proposed one Access application covering the whole host,
with an Allow policy for `/d` and `/` and a **Bypass policy scoped to `/p/*` and
`/api/*`**.

That design does not work, for two reasons found while verifying it:

1. **Paths are a property of the application, not the policy.** Access policies
   have four building blocks — action, rule types, selectors, values. There is no
   path field. A bypass "scoped to a path" is not expressible. Cloudflare's own
   documentation uses *"create a second Access application at that path and attach
   the Bypass policy"* as the canonical pattern for this exact situation.

2. **A path-less application covers the entire host.** So an app at `/` swallows
   `/p/*` and `/api/*` too. There is no way to protect exactly `/` and nothing
   else. Overlapping apps resolve most-specific-path-wins, and the specific app
   **overrides** rather than merges — it inherits nothing from the parent.

## Decision

Move the console to `/admin` (upload at `/admin/upload`) and make `/` an
unauthenticated 302 to it. Then:

| App | Path | Policy |
|---|---|---|
| **A** | `host/d` | Allow · Include: Group `pagevault-viewers` · Login: OTP |
| **B** | `host/admin` | Allow · Include: Emails: `OWNER_EMAIL` |

`/`, `/p/*`, and `/api/*` have **no Access application**. They reach the Worker
unauthenticated. Zero bypass policies exist.

`CF_ACCESS_AUD` is a list — one AUD per app — and **each route accepts only its own
app's AUD**. `/d` does not accept App B's token and `/admin` does not accept App
A's. Accepting either token on either route would let any member of
`pagevault-viewers` reach the owner console.

## Alternatives considered

**Three apps: root app with Allow, plus bypass apps at `/p` and `/api`.** This is
the closest legal expression of the original design. It works. It was rejected
because it needs three applications instead of two, and because a bypass policy is
a thing that can be misconfigured whereas "no application" cannot. Fewer moving
parts on the surface that faces the public internet.

**One app on the whole host, Worker distinguishes routes.** Rejected: this puts
Access in front of `/api/*`, which breaks the CLI and MCP server — they have no
browser to complete an OTP flow. Service tokens could solve it, but that means
every user provisioning a service token during setup, for no gain.

**Keep the console at `/` as originally specified.** Not possible. An Access app
at `/` covers the whole host. The `/admin` move is forced, not chosen — but it is
also strictly better, because it makes `/` a free, unauthenticated redirect rather
than a protected route.

## Consequences

- Setup creates two Access apps rather than one. Both are created by
  `pagevault init` via the API, and the app-create response returns the AUD tag
  directly, so nothing is hand-copied.
- The Worker must know which AUD belongs to which route. A single
  `CF_ACCESS_AUD` string would be a latent privilege-escalation bug; it is a
  structured pair.
- `/p/*` and `/api/*` are protected by the Worker alone. That is correct and
  intended, and it is why the Worker verifies the JWT itself rather than trusting
  Access to have run (see ADR-004). It is also why the `workers.dev` subdomain must
  be disabled — it is another unprotected path to the same Worker.
- The public URL is `/admin`, not `/`. Slightly less elegant. Worth it.
- `/` stays unauthenticated with no Access app, as decided here — but what the Worker
  *serves* there became rung-aware once the ladder (ADR-008) landed. With Access provisioned
  (`CF_ACCESS_AUD_ADMIN` set) it 302s to `/admin` as above; below that there is no console to
  reach, so a redirect would dump visitors on a dead `Forbidden`. Instead `/` serves a quiet
  landing that reveals nothing about portals, documents, or the owner. The topology is
  unchanged; only the publish-mode response is new. See `worker/src/pages.ts`.

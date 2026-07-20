# ADR-012 — OAuth consent uses Cloudflare Access as the IdP, at `/admin/authorize`

**Status:** Accepted
**Date:** 2026-07-20

## Context

#22 added OAuth 2.1 to the remote MCP server so the hosted Claude surfaces
(claude.ai, Desktop, mobile) can connect. In that flow the operator must prove they
are the operator before the provider mints a token for a client — otherwise anyone
who reaches `/authorize` could authorize a connector to your MCP server.

The spike proved the whole handshake with a placeholder consent: paste the
`PAGEVAULT_API_TOKEN` into a form. That was enough to validate the flow, but it is
not a production login. A consent form that accepts a secret is a phishing target,
puts the operator in the business of copy-pasting a bearer token into a browser, and
is the opposite of "log in as yourself." The spike said so in its own comments: *do
not ship this consent screen as-is.*

We do not need to invent an operator login — the Worker already has one. Cloudflare
Access authenticates the owner, the Worker verifies the Access JWT itself (ADR-004),
and `/admin` already sits behind the `pagevault-owner` Access app (ADR-001). The
owner is exactly who may authorize the MCP server. The identity we need already
exists; the only question is how to put it in front of the consent step.

One constraint shapes the answer. `/mcp` can **never** sit behind Access (ADR-006):
Anthropic's connectors call it from their cloud, with no browser and no way to
complete a login. But `/authorize` is different in kind — it is driven by the
**operator's browser** during the OAuth redirect. A browser can complete an Access
login. So `/authorize` is the one OAuth endpoint that *can* be Access-covered, and
the only one that needs to be.

## Decision

**Serve the OAuth consent at `/admin/authorize`, gated by the existing admin Access
app, with the verified Access identity as the grant's owner.**

- The OAuthProvider's `authorizeEndpoint` is `/admin/authorize`. Discovery metadata
  advertises it, so claude.ai redirects the operator's browser there.
- `/admin/authorize` is already covered by the `pagevault-owner` Access app — Access
  apps prefix-match, so anything under `/admin` is gated with **zero new
  provisioning**. The operator logs in as themselves; Access injects the JWT.
- The handler verifies that JWT with `identify(request, env, "admin")` (the same
  path `/admin` uses), confirms the email is `OWNER_EMAIL`, and completes the
  authorization with `props.email` from the verified identity. **No token is ever
  typed into a form.**

**Reuse the admin app; do not create a dedicated `/authorize` app.** `/authorize` is
owner-only, which is precisely the `pagevault-owner` policy — the *same* identity
gate, not a different one. A third Access app would add an `aud`, an env var, an
`Audience` type, and provisioning/teardown surface, and grow ADR-001's load-bearing
route-to-Access map from two apps to three — to buy a separation of concerns that is
aesthetic here, not functional.

**Tier 0/1 keeps the paste-token fallback.** Those deployments have no Access at all,
so `/admin` is a dead Forbidden and there is no login to gate consent with. There the
handler falls back to the spike-grade paste-token form. That is acceptable: Tier 0/1
is the single-operator quickstart, and the pasted token is the operator's own secret,
entered on their own deployment. Production runs Tier 3, so production uses the real
Access login — which is what this ADR is for.

## Alternatives considered

**A dedicated `/authorize` Access app.** Cleaner on paper — OAuth consent gets its own
application instead of borrowing the console's. Rejected: it costs a new app, a new
`CF_ACCESS_AUD_AUTHORIZE`, a new `Audience` variant, and changes to `provision.mjs`
and `destroy.mjs`, all to enforce the identical `pagevault-owner` policy. The only
reason to prefer it is if `/authorize` might someday need a *different* policy than the
console — and it will not; both are "the owner, and only the owner."

**Keep the paste-token consent everywhere.** Simplest. Rejected as the production
path: a form that accepts a secret is a standing phishing and secret-handling
liability, and it is not authentication — it proves possession of a token, not
identity. Retained only as the Tier 0/1 fallback, where there is no Access to do
better and the operator is the only user.

**Put `/mcp` behind Access instead.** Impossible (ADR-006) — the connector call has no
browser to complete a login. Access can only ever front the browser-driven
`/authorize`, never the machine-driven `/mcp`.

## Consequences

- The OAuth authorize endpoint lives in the `/admin` namespace, which will make a
  reader pause — this ADR is the answer to "why is consent under `/admin`?" The router
  special-cases `/admin/authorize` → `handleAuthorize` **before** the general
  `/admin/*` → console.
- Production OAuth consent is exactly as strong as the admin Access app, and no
  stronger. That is the point: one identity model (ADR-004), not a second auth surface
  invented for OAuth.
- Access-IdP consent requires Tier 3. An operator who wants hosted-surface reach must
  be provisioned — which they are, if they have portals. The paste-token fallback keeps
  OAuth technically usable at Tier 0/1, at spike-grade.
- Nothing changes for `/mcp`: the static bearer (Claude Code) and OAuth-issued tokens
  (hosted surfaces) are both still validated by the Worker itself. And `canView()`
  still owns document authorization — this is operator *authentication* for the MCP
  server, never a document-authorization path (prime directives #5/#6).

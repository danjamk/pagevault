# ADR-004 — Console auth: short-lived session token, never the cookie

**Status:** Accepted
**Date:** 2026-07-13

## Context

The owner console at `/admin` is a server-rendered page that calls `/api/*` with
`fetch()`. Those API calls need to authenticate.

`/api/*` already accepts `Authorization: Bearer $PAGEVAULT_API_TOKEN` — that is how
the CLI and the MCP server talk to it. The console cannot use that token, because
embedding a long-lived, full-privilege API token in page HTML puts it in the DOM,
in the browser cache, and in any screenshot of the page.

The obvious alternative is to let `/api/*` accept the caller's Cloudflare Access
identity. But `/api/*` has **no Access application** in front of it (ADR-001), so
Cloudflare does not inject a `Cf-Access-Jwt-Assertion` header there.

It does, however, send the cookie. The `CF_Authorization` cookie is scoped
`Path=/` on the hostname by default, so the browser attaches it to `/api/*`
regardless. The Worker could read that cookie and verify it as a JWT — same
signature, same JWKS, same AUD check. It would work.

It would also be wrong.

## Decision

The Worker mints a **short-lived HMAC session token** when it renders `/admin`:
signed over `{email, exp}` with a server-side secret, ~15 minute TTL, embedded in
the page. The console sends it as `Authorization: Bearer <session>`.

`/api/*` accepts two bearer credentials and **no cookies, ever**:

1. `PAGEVAULT_API_TOKEN` — long-lived, full privilege, for CLI and MCP.
2. A valid, unexpired session token — for the console.

The `CF_Authorization` cookie is ignored on every route. `/d` and `/admin` read
identity from the `Cf-Access-Jwt-Assertion` **header**, which Cloudflare injects
only on authenticated paths and strips from external requests. Cloudflare's own
guidance says to prefer the header, since the cookie is not guaranteed to be
present.

## Alternatives considered

**Accept the `CF_Authorization` cookie as an auth method on `/api/*`.** Zero new
code, no token to mint or expire. Rejected: cookie auth on a state-changing API is
**ambient authority**. Any page in the browser can cause an authenticated request
to be sent, which is the definition of CSRF. It would need an `Origin` check plus a
custom-header requirement plus `SameSite` reasoning to be safe, and each of those
is a thing to get subtly wrong. A bearer header is immune by construction: nothing
attaches it automatically.

This is not theoretical here. PageVault serves attacker-controlled HTML on the same
origin (ADR-003). Cookie auth on `/api/*` plus a hostile document is a full account
takeover — the script calls `DELETE /api/docs/{id}` with your cookie riding along.
ADR-003's sandbox already prevents this, but relying on the sandbox as the *only*
thing standing between a document and your delete endpoint is one CSP typo away
from catastrophe. Two independent defenses, not one.

**Embed `PAGEVAULT_API_TOKEN` in the console page.** Rejected, and the original
spec already said not to. Long-lived, full-privilege, and it leaks via the DOM, the
page cache, and screenshots.

**Give the console its own long-lived, reduced-privilege API token.** Better than
embedding the main one, but it still lives in page HTML indefinitely and there is
no meaningful privilege reduction available — the console does everything.

**Put an Access app in front of `/api/*` and use service tokens for the CLI.**
Consistent, and Cloudflare-native. Rejected: it forces every user to provision a
service token during setup, and it means the CLI now has two credentials to manage
instead of one. The setup runbook is the product for anyone who isn't me; every
step in it has a cost.

## Consequences

- One new secret: the HMAC signing key for session tokens. It can be derived from
  `PAGEVAULT_API_TOKEN` rather than being a separate secret to manage — one fewer
  thing in the runbook.
- Session tokens expire in ~15 minutes. A console tab left open overnight will get
  401s. The page must handle this by re-fetching itself (a plain reload
  re-authenticates through Access transparently and mints a fresh token), not by
  silently failing.
- Session tokens are bearer credentials embedded in HTML, so they are only as safe
  as the page they are in. That is why the console gets a strict, nonced CSP —
  distinct from the document sandbox — and why documents are never served on that
  path.
- `/api/*` has exactly one auth mechanism (a bearer header) with two accepted token
  types. There is no second code path reading cookies, which means there is no
  second code path to audit.

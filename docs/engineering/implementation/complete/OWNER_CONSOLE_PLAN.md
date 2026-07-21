# Implementation Plan — Minimal owner console at /admin (#5)

A deliberately minimal, server-rendered console so the operator can see what they
published and fix mistakes while running a real engagement. The full console is not
MVP. Implements ADR-004.

## What "done" looks like

- Visiting `/admin` (as the owner, through Cloudflare Access) renders one page listing
  portals → documents → members, with controls to add/remove members, toggle
  visibility / `ownerOnly`, and delete a document with an explicit "no undo".
- The page authenticates to `/api/*` with a short-lived **session token**, never the
  `PAGEVAULT_API_TOKEN`, never a cookie.
- A non-owner with a valid Access JWT gets 403. An expired session gets 401. A session
  token does not work on `/mcp`, and a viewer capability token does not work as a session.

## Decisions (settled)

- **Separate derived key per scope.** The session token shares the HMAC mint/verify
  *implementation* with the viewer capability (#3) but derives a **distinct** signing key
  (`KEY_INFO = "pagevault:session:v1"` vs `"pagevault:capability:v1"`). A viewer token
  then cannot verify as a session even if a scope check regressed — cryptographic domain
  separation, not just a payload field.
- **One page.** Server-rendered, vanilla JS, no client routing, no framework, no build.
- Session grants **full** `/api` access (short-lived + owner-bound); ADR-004 rejected
  privilege reduction as meaningless. On 401 the page **reloads** to re-auth through
  Access transparently.

## Design

### 1. Session token — reuse the HMAC core, separate key

Extract the generic HMAC-token core from `capability.ts` (sign `{payload}.{sig}`,
verify with `timingSafeEqual`, derive key from `PAGEVAULT_API_TOKEN` + a `KEY_INFO`)
into a shared helper both scopes use. Then:

- `mintSession(env, email): Promise<string>` — payload `{ scope: "console", sub: email,
  exp }`, ~15 min TTL, session key.
- `verifySession(env, token): Promise<{ email: string } | null>` — recompute the
  signature with the session key, constant-time compare, reject if expired or
  `scope !== "console"`. Distinct key means a viewer capability fails at the signature.

If extracting the core proves invasive to #3's tested code, fall back to a sibling
`session.ts` that mirrors `capability.ts` with its own `KEY_INFO` — same outcome, a
little duplication. Prefer the shared core.

### 2. `/api/*` accepts session tokens; `/mcp` does not

- `/api/*`: authorize if the bearer is the `PAGEVAULT_API_TOKEN` **or** a valid session
  token. All console ops are owner-scoped, so a boolean is enough — no need to thread the
  email through. `isAuthorized` (sync, API-token) stays; add an async wrapper for `/api`
  that also tries `verifySession`.
- `/mcp`: **unchanged** — API token only. A session token must never authenticate an MCP
  request. This gets a test.

### 3. Audit `/api` mutation coverage, add what's missing

The console mutates through `/api/*`. Confirm each control has an endpoint; add the
missing ones (with tests):

- Members add/remove — `PATCH /api/portals/{slug}` (exists — verify shape).
- Delete document — `DELETE /api/docs/{id}` (exists).
- **Visibility / `ownerOnly` toggle — likely missing.** `/api/docs` has POST/GET/DELETE
  but no meta-patch. Add `PATCH /api/docs/{id}` for `ownerOnly` (and visibility), routed
  through the same `publishDocument`/store path, owner-authorized.

### 4. `/admin` render (`console.ts`)

`handleConsole(request, env)`:

- `identify(request, env, "admin")` → the owner. If null or not `OWNER_EMAIL` → **403**
  (defense in depth: the admin Access app already includes only the owner).
- Mint a session token for the owner; embed it in the page.
- Serve HTML with a **strict, nonced CSP** — distinct from and tighter than the artifact
  sandbox (ADR-004): `default-src 'none'`, `script-src 'nonce-{n}'`, `style-src
  'nonce-{n}'`, `connect-src 'self'` (for the `/api` fetches), `base-uri 'none'`,
  `form-action 'none'`. No `unsafe-inline`. A bug in artifact serving must not bleed into
  the page holding the session token.
- Wire `/admin` in `index.ts` (replaces the 501).

### 5. The console page (HTML + vanilla JS)

One server-rendered page. Inline `<script nonce>` fetches `/api/portals`, then per portal
its documents and members, and renders. Controls call `/api/*` with the session bearer:
member add/remove, visibility + `ownerOnly` toggle, delete-with-`confirm()` that states
there is no undo. Plain `fetch`, no dependencies. On any 401, `location.reload()`.

## Tests

Server-side (unit + integration), the client JS is verified by driving it locally:

- 🔴 non-owner with a valid Access JWT → `/admin` returns 403.
- 🔴 `/api/*` accepts a valid session token; an **expired** one → 401.
- 🔴 a session token with a tampered `sub` fails verification (cannot be replayed as
  another email).
- 🔴 a session token does **not** authenticate `/mcp` (surface isolation).
- 🔴 a viewer **capability** token does **not** verify as a session (key separation).
- `/admin` for the owner → 200, contains the session token, and the response carries the
  strict nonced CSP (not the artifact CSP).
- `PATCH /api/docs/{id}` toggles `ownerOnly`; owner-authorized only.
- Mutation-verify the load-bearing ones (break the key separation or the scope/exp check →
  a test fails).

## Manual verification

`make dev` (AUTH_MODE=none gives the owner locally) → open `/admin` → confirm the page
lists real seeded data, member/visibility/delete controls work against `/api`, and an
expired-session reload behaves. This is the "green isn't a build" step for the client JS.

## Already done / out of scope

- **`make logs`** — already in the Makefile. Task complete.
- **Out of scope (Layer 1):** `/admin/upload` (#6), portal branding, the 3+-docs-sharing-
  an-email nudge toward a portal.

## Step order

1. Session token (shared HMAC core + `mintSession`/`verifySession`) + tests.
2. `/api` accepts session tokens; `/mcp` stays API-token-only + tests.
3. Audit `/api`; add `PATCH /api/docs/{id}` (+ any other gaps) + tests.
4. `console.ts` render + nonced CSP + `/admin` wiring + tests.
5. The console page HTML/JS (one page).
6. Full `make check` + local `make dev` drive.

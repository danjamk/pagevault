# PageVault — Architecture

The design, and why it is the way it is. Every Cloudflare behavior asserted here
was verified against current Cloudflare documentation; the load-bearing ones are
cited inline. The four contested decisions have their own ADRs in `docs/adr/`.

---

## 1. The idea

Cloudflare Access answers **"who are you?"**. The Worker answers **"are you
allowed to see this specific document?"**.

That split is the whole design. It means Access is configured **once**, and
per-document sharing lives in KV where it belongs — instead of one Access
application per published document, which is where every naive version of this
ends up.

```
                    ┌──────────────────────┐
                    │  Cloudflare Access   │  ← identity only
                    │  (One-time PIN /     │     "prove you own this email"
                    │   Google / GitHub)   │
                    └──────────┬───────────┘
                               │  Cf-Access-Jwt-Assertion
   /d/*  /admin/*  ────────────┤
                               ▼
        /p/*  ─── no Access ─▶ ┌──────────────────────┐
                               │      Worker          │  ← authorization
        /api/* ── bearer ────▶ │  (verify JWT,        │     "is this email on
                               │   check allowlist)   │      THIS doc's list?"
                               └──────────┬───────────┘
                                          ▼
                                     Workers KV
```

## 2. Stack

| Concern | Choice | Why |
|---|---|---|
| Compute | Cloudflare Workers | Free: 100k req/day, 10ms CPU, 128MB |
| Storage | Workers KV | Free: 100k reads, 1k writes, 1k lists/day, 1GB |
| Identity | Cloudflare Access | Free for 50 seats. Email OTP + SSO, so we don't build it. |
| Deploy | Wrangler 4 (Node 22+) | `wrangler deploy`, no CI needed |

Cost: **$0**, plus a domain you already own. See §9 for the one honest asterisk.

## 3. Routes

| Route | Access app | Worker behavior |
|---|---|---|
| `/` | none | 302 → `/admin` |
| `/d/{id}` | **App A** (`host/d`) — Allow, Include: Group `pagevault-viewers` | Verify JWT (aud = App A) → email → load `meta:{id}` → **404** unless email ∈ allowlist → serve `doc:{id}`, sandboxed |
| `/p/{token}` | none | `pub:{token}` → id → serve `doc:{id}`, sandboxed. No auth. |
| `/api/*` | none | `Authorization: Bearer` — API token or console session token |
| `/admin`, `/admin/upload` | **App B** (`host/admin`) — Allow, Include: Emails: `OWNER_EMAIL` | Verify JWT (aud = App B) → 403 unless owner → render console |

Two Access applications. **Zero bypass policies.**

Three things make this work, and each was a correction to the original design:

**Paths belong to the application, not the policy.** There is no path field on an
Access policy. You cannot "add a bypass policy scoped to `/api/*`" — Cloudflare's
own documentation uses "create a second application at that path" as the canonical
pattern for exactly this.

**A path-less app covers the entire host.** So `/` cannot be protected in
isolation; an Access app at `/` swallows everything. That is why the console lives
at `/admin` and `/` is a redirect. Overlap resolves most-specific-path-wins, and
it **overrides rather than merges** — App A's policies fully replace anything a
parent app would have applied.

**Paths with no Access app reach the Worker unauthenticated.** `/p/*` and `/api/*`
simply have no app in front of them. This is better than a bypass policy: fewer
moving parts, and nothing to misconfigure.

`CF_ACCESS_AUD` is therefore a **list** — one AUD per app — and each route accepts
only its own app's AUD. Accepting either token on either route would let any
`pagevault-viewers` member reach the console. See ADR-001.

## 4. Data model (Workers KV)

Single namespace, `PAGEVAULT`.

```
doc:{id}      → string (raw HTML body)
meta:{id}     → JSON DocMeta   [+ KV key metadata]
pub:{token}   → string (the doc id)   [only when visibility=public]
```

```ts
type Visibility = "private" | "restricted" | "public";

interface DocMeta {
  id: string;              // 12-char, crypto.getRandomValues
  title: string;
  visibility: Visibility;
  emails: string[];        // lowercased. Always includes OWNER_EMAIL.
  publicToken?: string;    // 22-char random, only when visibility=public
  tags?: string[];         // free-form, e.g. ["client:acme"]
  createdAt: string;       // ISO8601
  updatedAt: string;
  bytes: number;
}
```

### Listing: KV key metadata, not a hand-maintained index

**Do not build an `index:owner` array of doc ids.** It is a read-modify-write on
every publish and it will corrupt itself the first time two publishes race.

Use KV's per-key metadata (≤1024 bytes, returned inline by `list()` with no extra
reads):

```ts
await env.PAGEVAULT.put(`meta:${id}`, JSON.stringify(meta), {
  metadata: { title, visibility, createdAt, updatedAt, tags, bytes },
});
```

The console and `GET /api/docs` render off a single `list({ prefix: "meta:" })`.
No N+1 reads, no write contention, no index to keep in sync.

`emails` deliberately stays **out** of key metadata — an allowlist can blow the
1KB cap. The union needed for the Access group is computed by reading `meta:` keys
during reconcile, never on the hot path.

Notes:
- `private` is just `restricted` with `emails: [OWNER_EMAIL]`. Keep the distinct
  label — it is clearer at the call site and in the UI.
- Rotating a public link: mint a new `publicToken`, delete the old `pub:` key.
- Revoking: delete `doc:`, `meta:`, and any `pub:` key.
- `list()` caps at 1000 keys/call. Paginate with `cursor` if it ever exceeds that,
  which it won't.

### Consistency

KV is eventually consistent — up to 60 seconds globally. There is **no documented
read-after-write guarantee, not even at the same edge**. A freshly published doc
may 404 briefly at a distant edge. The CLI retries before printing the URL. Do not
build anything that depends on read-after-write.

## 5. Identity and authorization

### Three token types. Never a cookie.

| Token | Where | Verified how |
|---|---|---|
| Access JWT | `Cf-Access-Jwt-Assertion` header, on `/d` and `/admin` only | JWKS, `kid`-matched, `iss` + `aud` checked |
| `PAGEVAULT_API_TOKEN` | `Authorization: Bearer`, from CLI/MCP | Constant-time compare |
| Console session token | `Authorization: Bearer`, minted into the `/admin` page | HMAC, ~15min TTL |

Access sets a `CF_Authorization` cookie scoped `Path=/` on the hostname. The
browser therefore sends it to `/api/*` and `/p/*` **even though those paths have
no Access app**. We ignore it everywhere. Cookie auth on a state-changing API is
ambient authority and a CSRF surface; a bearer header is neither. See ADR-004.

### JWT validation — do not skip this

Cloudflare strips these headers from external requests, but a misconfigured route,
an enabled `workers.dev` subdomain, or a future bypass turns a trusted-header
design into a full authentication bypass. **Verify the signature.** Never trust
`Cf-Access-Authenticated-User-Email` on its own.

```ts
import { jwtVerify, createRemoteJWKSet } from "jose";

const TEAM_DOMAIN = `https://${env.CF_TEAM_NAME}.cloudflareaccess.com`;
const JWKS = createRemoteJWKSet(new URL(`${TEAM_DOMAIN}/cdn-cgi/access/certs`));

async function identify(request: Request, env: Env, aud: string) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: TEAM_DOMAIN,
      audience: aud,          // the AUD of THIS route's app, not any app
    });
    return String(payload.email ?? "").toLowerCase() || null;
  } catch {
    return null;
  }
}
```

Access signs with **RS256** and rotates its signing key roughly **every 6 weeks**
(old keys stay valid 7 days). `createRemoteJWKSet` caches and refreshes the key
set. Never pin a key; never read `public_cert`.

### Seats: bounded by a synced Access group

A seat is consumed by any successful Access authentication, seats are not
auto-reaped, and **once the 50 free seats are full, further logins are blocked**.
An `Include: Everyone` + One-time PIN policy — which Cloudflare's docs explicitly
list under "Common Cloudflare Access misconfigurations" — means any stranger who
knows the hostname can exhaust your seats and lock out your actual clients.

So the `/d` policy includes a **single Access group**, `pagevault-viewers`,
holding the union of every document's allowlist. Only people you invited can
authenticate at all.

- **On publish/patch:** read the group, union in the new emails, `PUT`. Additive,
  cheap, idempotent.
- **On `pagevault sync-access`:** recompute the union from KV and `PUT` the whole
  list. Access group `PUT` is a **full replacement**, so this is exact — it fixes
  both drift and the read-modify-write race on the hot path. With `--reap` it also
  removes seats for emails on no current allowlist.

This needs a Cloudflare API token with Access edit rights. If `CF_API_TOKEN` is
unset, PageVault falls back to the `Include: Everyone` policy and warns loudly —
the simple setup path stays open for people who just want to try it.

**Public pages cost zero seats.** `/p/*` has no Access app, so no one ever
authenticates. See ADR-002.

## 6. Serving documents

Every document is treated as hostile. The HTML is LLM-generated, it runs
JavaScript, and it may have been produced from content the model didn't control.
On the same origin as the console and the API, that is a real attack path.

`/d/*` and `/p/*`:

```
Content-Security-Policy: sandbox allow-scripts allow-popups allow-forms allow-downloads
Content-Type: text/html; charset=utf-8
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: private, no-store        # /d
Cache-Control: public, max-age=300      # /p
```

Omitting `allow-same-origin` gives the document an **opaque origin**. Its
JavaScript cannot read `document.cookie`, cannot touch `localStorage` or
IndexedDB, and cannot make credentialed same-origin requests to our API. Scripts,
charts, and animations still work — which is everything a self-contained artifact
actually needs. Supported everywhere since 2016.

The `sandbox` directive is **header-only** — it is ignored in a `<meta>` tag and
in report-only mode. Tunable via `DOC_CSP` for anyone who forks this and
disagrees. See ADR-003.

The console gets a **separate, strict CSP with a per-request nonce**, so a bug in
document serving cannot bleed into the surface that holds the session token.

## 7. API

All under `/api`, all requiring `Authorization: Bearer`.

- `POST /api/docs` → `{ id, url, visibility, emails }` (201)
- `GET /api/docs` — list; `?tag=` and `?visibility=` filters. Metadata only, no
  bodies. Served off `list()` + key metadata.
- `GET /api/docs/{id}` → `DocMeta`
- `PATCH /api/docs/{id}` — `title`, `visibility`, `emails`, `tags`. May include
  `html` to replace content in place, same URL. Visibility → `public` mints a
  token; away from `public` deletes it.
- `POST /api/docs/{id}/rotate` — new public token, old link dies immediately.
- `DELETE /api/docs/{id}` — hard delete.

Errors: JSON `{ error, code }`, correct status codes. Upload size capped ~10MB
(KV's hard limit is 25MiB, but the body is JSON-wrapped).

`/d/{id}` returns **404, not 403**, for an unauthorized viewer — a 403 confirms
the document exists.

Rate limiting: free-tier WAF gives exactly one rule, IP + path only, fixed 10s
window — effectively useless here. Use the Workers rate-limit binding, or skip it
in v1 and say so.

## 8. Console (`/admin`) and upload (`/admin/upload`)

Both Access-gated to `OWNER_EMAIL`, and both re-check ownership in the Worker.
This is the only management path that works from a phone or tablet, where there is
no terminal and no Claude Desktop. Build it properly.

**`/admin`** — table of all docs (title, visibility, allowlist, tags, created,
size); per-row copy link, change visibility, add/remove emails, rotate token,
preview, delete; filter by tag and visibility; confirm-before-delete, and say that
there is no undo.

**`/admin/upload`** — drop or pick a `.html`, set title, pick visibility, enter
emails, add tags; returns the link with a copy button; warns on relative
`src`/`href` (this is single-file only, and a relative path will 404).

One server-rendered page, vanilla JS, `fetch()` against `/api/*`. No framework, no
build step, no bundler. Every dependency added here is one a forker has to install.

The page is rendered with a fresh HMAC session token embedded in it. The token is
not `PAGEVAULT_API_TOKEN` and never leaves the header. Do not embed the API token
in page HTML.

## 9. Setup

Automatable with one Cloudflare API token: KV namespace, Worker deploy, custom
domain + DNS, Access apps, policies, the viewer group, seat settings, seat removal.
The Access app-create response **returns the AUD tag directly**, so nothing has to
be copied out of a dashboard.

Two steps genuinely require a human:

1. **Enable Zero Trust once.** The org-creation API has no plan-selection field,
   and Cloudflare's onboarding docs still say you must pick a plan and enter
   payment details — *"If you chose the Zero Trust Free plan, this step is still
   needed but you will not be charged."* `init` detects this, deep-links the
   dashboard, and on re-run reads the team name back from the API.
2. **Create the API token.** There is no bootstrap API to mint a token without a
   token. `init` hands over a prefilled template URL and the exact permissions.

> **Unverified:** whether a credit card is *actually* enforced on the free Zero
> Trust plan today. The docs say yes; some 2026 community sources say no. Confirm
> against a clean account before the README makes a promise about it.

So:

```
1. Enable Zero Trust in the dashboard (once, ~60s)
2. Create an API token (prefilled link)
3. npx pagevault init          ← everything else
```

**Disable the `workers.dev` subdomain and Preview URLs.** They route around Access
entirely. The Worker fails closed without a valid JWT, so this is not an open
door — but it is a required step, not a footnote.

## 10. Clients

**CLI** (`pagevault`) — thin. Config from `~/.pagevault/config.json` or
`PAGEVAULT_URL` / `PAGEVAULT_API_TOKEN`. Prints the URL and nothing else on
success, so it pipes to `pbcopy`.

```bash
pagevault publish report.html --title "Q3 Review" --private
pagevault publish report.html --emails alice@x.com,bob@y.com
pagevault publish report.html --public
pagevault list --tag client:acme
pagevault share <id> --add carol@z.com
pagevault rotate <id>
pagevault rm <id>
pagevault sync-access [--reap]
```

**MCP server** (`pagevault-mcp`) — stdio. `publish_document`, `list_documents`,
`update_document_sharing`, `revoke_document`. This is the payoff: Claude writes the
report, calls `publish_document`, hands back a link. No file shuffling.

Both are HTTP clients of `/api`. No duplicated logic, no direct KV access. They
must work identically pointed at anyone's deployment.

## 11. Non-goals (v1)

Not a CMS — no in-place editing, no WYSIWYG, no version history. Not multi-tenant.
No comments, analytics, or collaboration. No multi-file sites: **single-file HTML
only**.

## 12. v2 backlog

R2 + multi-file bundles · self-hosted email OTP via Resend (removes the Access
dependency and the seat cap entirely) · expiring links · view log (who opened it,
when — trivially available from the JWT, and genuinely useful when you've sent a
report to a client) · password-protected public links · remote MCP served by the
Worker itself, so there is nothing to npm-install at all.

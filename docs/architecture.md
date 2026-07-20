# PageVault — Architecture

The design, and why it is the way it is. Every Cloudflare and MCP behavior asserted
here was verified against current documentation. The contested decisions have their
own ADRs in `docs/adr/`; read the relevant one before overturning it.

> **Revised 2026-07-14.** The original design published one document and returned one
> link. That primitive is table stakes — six commercial products and
> [`jonesphillip/sharehtml`](https://github.com/jonesphillip/sharehtml) (Apache-2.0,
> a Cloudflare PM's project) already do it, several of them better. **The collection
> is the product.** See ADR-005.
>
> PageVault owes sharehtml three ideas: the Access-provisioning setup script, the
> capability-token model, and the sandboxed iframe. They are credited in the README
> because they got there first and pretending otherwise would be both wrong and easy
> to catch.

---

## 1. The idea

**Cloudflare Access answers "who are you?". The Worker answers "may you see this?".**

That split is the architecture, and the Worker's half lives in **exactly one
function** — `canView()`. One Access application per surface, configured once.
Permissions live in KV, on the **portal**, not scattered across documents.

The unit is not the link. The unit is the client.

> Over a nine-month engagement you produce fourteen artifacts for one client.
> Fourteen links, fourteen emails, and a client digging through Gmail in March for
> the architecture doc you sent in January.

One durable URL per client. Every artifact lands there — tagged, dated, gated to
their people. Add someone to the client's team: **one write, not fourteen.**

And the collection reads back. The MCP server exposes `read_document` and
`search_portal`, so six months in, *"what did we decide about CDC on V2?"* is
answerable from the portal. **Publishing and remembering become the same act.** That
is what makes a portal worth having at one client, which is the number that exists
today.

## 2. Simplicity first — portals are invisible until needed

Non-negotiable. The quickstart does not contain the word "portal":

```bash
pagevault publish report.html                    # private, just you
pagevault publish report.html --emails a@x.com   # email-gated, this doc only
pagevault publish report.html --public           # unguessable link
```

`init` creates a `default` private portal. Every document has one; the user does not
have to know that yet. `--portal` is required **only when ambiguous** — two or more
portals exist and no default is set. Portals appear later, in a section called *"when
you have the same audience over and over."*

**Every publish prints where it landed.** That is the actual safeguard against
misfiling a client report, not a required flag:

```
→ https://share.example.com/v/realplus/k3x9mq2vb7pd
  portal: realplus · visible to: 3 members
```

## 3. Routes and Access topology

| Route | Access app | Worker does |
|---|---|---|
| `/` | none | 302 → `/admin` |
| `/v/{slug}` | **App A** (`host/v`) | Portal index. `canView` per doc. |
| `/v/{slug}/{id}` | **App A** | Viewer shell. `canView`, then mint a capability token. |
| `/render/{id}?cap=` | none | **Artifact bytes.** Capability token only. Framed, never navigated. |
| `/p/{token}` | none | Capability link → shell. No auth, no seat burned. |
| `/pub/{slug}`, `/pub/{slug}/{id}` | none | Public portal → shell. No auth, no seat burned. |
| `/api/*` | none | Bearer token. |
| `/mcp` | none | **Remote MCP**, Streamable HTTP. Bearer token. See ADR-006. |
| `/admin`, `/admin/*` | **App B** (`host/admin`) | Owner console. |

**Two Access applications. Zero bypass policies.** Paths belong to the *application*,
not the policy — a bypass policy scoped to `/api/*` is not expressible, and a
path-less app swallows the whole host. Uncovered paths reach the Worker with no JWT
at all, which is better than a bypass policy: fewer knobs, nothing to misconfigure.
See ADR-001.

`CF_ACCESS_AUD` is **two vars, not one**. `/v` accepts only App A's audience;
`/admin` only App B's. A shared AUD would let any portal member present their token
to the owner console — a privilege escalation that looks like a config
simplification.

> 🔴 **`/mcp` must never sit behind Access.** Anthropic's connector infrastructure
> calls it from their cloud (`160.79.104.0/21`) — no browser, no cookie, no way to
> complete an OTP login. Access would hard-block it. The Worker does its own auth
> there, which is what it does everywhere.

## 4. Data model (Workers KV)

```
portal:{slug}     → JSON Portal        [+ KV key metadata]
members:{slug}    → JSON string[]      (normalized, lowercase)
idx:{slug}:{id}   → ""                 (existence = membership; no RMW race)
doc:{id}          → string (the served bytes: HTML, or markdown rendered to HTML)
raw:{id}          → string (markdown only: the original .md, for download + read-back)
meta:{id}         → JSON DocMeta       [+ KV key metadata]
pub:{token}       → string (doc id)
```

**The prefixes are disjoint on purpose.** The obvious layout — `portal:{slug}:members` —
collides with `list({ prefix: "portal:" })`: the member list comes back looking like a
portal. Members and the index get their own namespaces instead. There is a test for it.

```ts
type PortalKind = "private" | "restricted" | "public";
type SourceKind = "html" | "markdown";   // markdown is rendered to HTML at publish time; raw kept in raw:{id}

interface Portal {
  slug: string;          // ^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$, reserved words rejected
  name: string;
  kind: PortalKind;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

interface DocMeta {
  id: string;
  portal: string;        // always set; defaults to "default"
  title: string;
  summary?: string;      // one line, shown in the portal index
  sourceKind: SourceKind;
  ownerOnly: boolean;    // a draft the client cannot see. Beats every grant below.
  extraEmails?: string[];// ADDITIVE grant, this doc only. Never subtractive.
  publicToken?: string;  // explicit widening, separate route
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  bytes: number;
}
```

**Listing** is `list({ prefix: "idx:portal:{slug}:" })` for membership, and
`list({ prefix: "meta:" })` with **KV key metadata** for titles and dates. Never a
read per document — an N+1 passes every functional test and silently eats the
100k/day read quota. There is a test asserting one `list()` and zero `get()`s.

`emails` stay **out** of key metadata: KV caps it at 1024 bytes and an allowlist can
blow it, which would break listing for exactly the documents with the most sharing.

**No index array.** It is a read-modify-write on every publish and it corrupts itself
the first time two publishes race.

**KV is eventually consistent** (~60s), with no read-after-write guarantee even at
the same edge. The CLI retries before printing a URL. Nothing may depend on one.

## 5. Authorization — one function, no exceptions

Pure by design — no `env`, no KV, no I/O. Everything it needs is an argument, so the
whole matrix is exercised without a Worker, and routes come after it rather than
alongside it.

```ts
export function canView(
  doc: DocMeta, portal: Portal, members: string[],
  email: string | null, ownerEmail: string,
): boolean {
  if (emailsMatch(email, ownerEmail)) return true;

  // ownerOnly beats EVERY grant below. Evaluated first, deliberately.
  if (doc.ownerOnly) return false;

  if (portal.kind === "public") return true;
  if (email === null) return false;

  // Additive per-document grant. Can only ever ADD a viewer — never remove one.
  if (doc.extraEmails?.includes(email)) return true;

  if (portal.kind === "restricted") return members.includes(email);
  return false;   // private portal, and we already know they are not the owner
}
```

Invariants, each of which is a test:

1. A document **never** inherits more visibility than its portal. It widens only by
   two explicit owner acts: `extraEmails`, or a minted `publicToken` on a separate
   route that does not consult `canView` at all.
2. `extraEmails` is **additive, never subtractive** — visible in the shape of the
   code as an early `return true`, never a `return false`.
3. **`ownerOnly` beats everything**, evaluated before any grant. A draft with an
   email grant on it stays invisible. Check `extraEmails` first and you silently leak
   drafts while every other test still passes.
4. **Cross-portal isolation is absolute.** Membership in portal A confers nothing in
   portal B. This is the threat that ends a consulting business, not a feature. Write
   that test first.
5. `email === null` can only ever reach `public` portals and valid `/p/` tokens.

**`canViewPortal()` is a separate function, and that is what keeps the index free.**
`extraEmails` is a *document* grant, not a portal grant — someone you sent one report to
can open that report and has no business seeing the client's whole index. So the index
never consults `extraEmails`, which means it renders from KV key metadata with **zero
reads**. Fold the two together for elegance and every portal page load becomes an N+1.

Read-side MCP tools go through the **same function**. A token scoped to portal A must
not be able to `search_portal("clientB")` — that is the same threat wearing a
read-only disguise, and it is the version most likely to be gotten wrong because it
feels like a convenience feature.

## 6. Identity — verify, never trust

Access injects `Cf-Access-Jwt-Assertion` and strips it from external requests. That
is a *deployment* property, not a *code* property. One misrouted Worker, one
`workers.dev` subdomain left enabled, and a trusted-header design is a full
authentication bypass with no error and no log.

- Verify the signature with `jose` + `createRemoteJWKSet`. RS256. Access rotates
  signing keys ~every 6 weeks; match on `kid`, never pin.
- Pin **both** `issuer` and `audience`. Either alone is insufficient.
- Missing config → **deny**. Fail closed.
- Never read `Cf-Access-Authenticated-User-Email`.
- **Normalize every email at every boundary.** A case-mismatched email failing an
  allowlist check is a confidentiality bug that looks like a UI bug.

The dev bypass is `AUTH_MODE === "none"` — **exact string equality**, never a
truthiness test, and additionally refused unless the request host is localhost. A
truthiness check here is an authentication bypass one typo away.

## 7. Hostile artifact JS

The premise of this product is *hosting untrusted code on a trusted origin*. The HTML
is LLM-generated, it runs JavaScript, and it may have been built from content the
model did not control. On the same origin as the console and the API, with the
viewer's `CF_Authorization` cookie riding along automatically, that is an open door.

**The artifact never renders in our origin's document context.**

1. `/v/{slug}/{id}` returns a **trusted shell** — our HTML, our JS, nothing from the
   artifact.
2. The shell frames the artifact: `<iframe sandbox="allow-scripts">`, **no
   `allow-same-origin`**. That combination gives the frame a unique opaque origin:
   scripts run, but it cannot read our cookies, cannot touch our DOM, and cannot make
   credentialed same-origin requests.
3. The shell holds a **short-lived HMAC capability token** scoped to that one
   document. The iframe never receives one and cannot forge one.
4. Privileged browser endpoints require the capability **and** an `Origin` check that
   **rejects `Origin: null`** — which is precisely what a sandboxed iframe's origin
   is.

`/render/{id}` serves artifact bytes with a strict CSP *and* the `sandbox` directive,
so even a direct top-level navigation lands in an opaque origin. That is one better
than sharehtml, which relies on the iframe attribute alone.

> ⚠️ `sandbox="allow-scripts allow-same-origin"` is **functionally no sandbox at
> all** — the frame can reach back into the parent and strip the attribute. It is
> exactly the mistake made at 11pm because an artifact "needs" it. It doesn't. There
> is a lint-level test asserting the string `allow-same-origin` appears **nowhere** in
> the codebase.

**Public does not mean unsandboxed.** `/p/*` and `/pub/*` go through the same shell.
A public artifact is *more* exposed, not less. `X-Robots-Tag: noindex, nofollow` on
both.

## 8. Credentials

| Credential | Where | Verified how |
|---|---|---|
| Access JWT | `Cf-Access-Jwt-Assertion`, on `/v` and `/admin` only | JWKS, `kid`, `iss` + `aud` |
| `PAGEVAULT_API_TOKEN` | bearer, on `/api/*` and `/mcp` | constant-time compare |
| Capability token | header, from the shell to privileged endpoints | HMAC, ~10 min, scoped to one doc |
| Console session token | bearer, minted into `/admin` | HMAC, ~15 min |

**No cookie is ever trusted, anywhere.** The browser attaches `CF_Authorization` to
`/api/*` whether we want it or not — it is scoped `Path=/` on the hostname — and
honouring it would make every state-changing endpoint CSRF-reachable from a document
we serve. See ADR-004.

**The API token never touches the browser.** Not in the page, not in `localStorage`,
not in a data attribute.

## 9. Deploying — what is true, verified on a real account

`make provision` does the Cloudflare work: KV namespace, One-time PIN, the
`pagevault-viewers` group, and the two Access applications. It reads the AUD tags out of
the app-create responses, so nothing is copied out of a dashboard. It is idempotent.
`make destroy` is its mirror — a setup path you cannot undo is a setup path you cannot
test.

**Two steps genuinely need a human**, and pretending otherwise would just move the
surprise later:

1. **Enable Zero Trust once.** The org-creation API has no plan-selection field. The
   script detects this, deep-links the dashboard, stops, and on re-run reads the team name
   back automatically so you never type it.
2. **Create the API token.** There is no bootstrap API to mint a token without a token.

> ⚠️ **Cloudflare's free Zero Trust plan requires payment details on file.** Confirmed on
> a real account, not inferred from the docs. You are not charged. The README must say so
> — "$0, no card" would be a lie people discover at step three and resent.

### The things a passing test suite will not tell you

Every one of these got past a green suite and was only found by deploying:

- **`nodejs_compat`.** The `agents` SDK reaches for `node:path` through transitive deps.
  Vitest does not care. Wrangler refuses to build. **Green tests are not a build.**
- **`CF_TEAM_NAME` is the *slug*, not the domain.** Cloudflare's API returns `auth_domain`
  as `acme.cloudflareaccess.com`. Passing that through doubles it in the JWKS URL, every
  verification fails, and it surfaces as an opaque 404. `auth.ts` now accepts either form.
- **🔴 One-time PIN is not enabled by default.** A fresh Zero Trust org ships with "Sign in
  with Cloudflare" — a *password* login against a Cloudflare account — as its only method.
  **No client will ever have one.** Asking them to make one is precisely the client-side
  onboarding step this product's premise says must not exist. The apps, the group, and the
  policies can all be correct while the product is broken in the only way that matters: the
  client cannot get in. `make provision` enables OTP rather than leaving it to be found.
- **Disable `workers.dev` and Preview URLs.** They route around Access entirely. The Worker
  fails closed without a valid JWT, so this is not an open door — but it is a required step.

### Error messages are part of the security model

`/v/*` sits behind Access, so **an unauthenticated request there cannot happen unless the
deployment is broken.** It returns a 500 naming the likely knob, not a 404 — because a bare
404 is indistinguishable from "no such portal", which is exactly how the `CF_TEAM_NAME` bug
above cost an afternoon.

The owner is told a portal does not exist and how to create one. **A stranger still gets a
bare 404**, because a helpful message would confirm whether a client's portal exists.

## 10. Seats — and the rule that follows from them

**"50 free users" means 50 distinct people who have *ever* logged in.** Not fifty
concurrent. A seat is consumed on first authentication and **held forever**: Cloudflare
does not auto-reap, and the built-in expiration has a **one-month minimum** inactivity
window. Someone who opened one report in March is still holding a seat in December.

When the seats run out, **further logins are blocked**. It fails closed — no surprise
invoice, but your actual client cannot get in.

Past 50: **$7/user/month, self-serve, monthly, no sales call** (the plan is now called
Pay-as-you-go). But the free 50 is a property of the *free plan*, not a discount carried
into the paid one — so the 51st person plausibly costs $7 × 51, not $7. **Confirm in the
dashboard before the README claims anything about it.**

### The rule

> **Gate the people who come back. Link the people who read once.**

`/p/{token}` and `/pub/{slug}` sit on paths with **no Access application**. Nobody
authenticates, so **zero seats are burned** — Cloudflare documents bypass paths as
exactly this escape hatch. The client's CTO who lives in the portal for nine months is
worth a seat. The client's board, who open one artifact one time, get a capability link
and cost nothing, forever.

This is an economic property of the route topology, not an afterthought. sharehtml burns
a seat on **every** viewer — even link-shared ones — because their "link" mode still
sits behind Access.

### And the `Include: Everyone` trap

An `Include: Everyone` policy lets any stranger who knows the hostname consume seats and
lock out your clients. Cloudflare lists that config under "common misconfigurations."

So the `/v` policy includes **one Access group**, `pagevault-viewers`, holding the
union of every portal's members plus every `extraEmails` grant. Strangers cannot
authenticate at all. `pagevault sync-access --reap` recomputes the union from KV and
`PUT`s it (Access group `PUT` is a full replace, so this is exact, not best-effort).

**Public portals and `/p/` links cost zero seats** — those paths have no Access app,
so nobody ever authenticates. That is an economic property, not just an architectural
one. sharehtml burns a seat on every viewer, even link-shared ones, because their
"link" mode still sits behind Access.

See ADR-002.

## 11. MCP — remote, not stdio

**This is the reason the project exists.** sharehtml has no MCP server; it ships a
skill that shells out to its CLI, which only works where there is a terminal. The
person who needs a client portal is very often the person *not* in a terminal.

But a stdio MCP server has the same limitation: it cannot run in a browser or on a
phone, because there is no subprocess to spawn. **Only a remote MCP server reaches
Claude Desktop, claude.ai, mobile, Cowork, *and* Claude Code.**

`/mcp` on the Worker, **Streamable HTTP** (not SSE — deprecated), via
`createMcpHandler` from the `agents` SDK. No Durable Objects, free plan. The MCP
server instance is created **per request** — sharing one across requests leaks
cross-client response data.

**Write:** `publish_document`, `create_portal`, `update_portal_members`,
`mint_public_link` (widening — the tool description must say so), `revoke_public_link`,
`rotate_public_link` (widening), `revoke_document` (deletes the document — the mirror of
the CLI's `rm`, not a link-only revoke).

**Read — the differentiator:** `list_portals`, `list_documents`, `read_document`,
`search_portal`.

Two rules the tools must enforce:

- **An agent must not be able to clobber a client deliverable in one tool call.**
  Publishing over an existing `(portal, title)` returns a diff summary and requires
  an explicit `confirm: true`.
- **The model must not infer the portal from conversation.** With one portal, resolve
  silently. With two or more and no default, **error and list them** — inferring
  "this is probably the RealPlus one" from chat is exactly the failure that leaks
  Client A's report into Client B's portal.

Auth: bearer token today, which works in Claude Code. OAuth 2.1 is required for the
hosted surfaces (claude.ai, Desktop, mobile) and is a **pre-launch** task, not a
pre-validation one. See ADR-006.

## 12. Explicit non-goals

No comments, reactions, or presence — sharehtml's lane, a Durable Objects project,
and a client reading a report does not want to leave threaded replies on it. No
multi-owner teams. No client upload — the moment clients can upload we need virus
scanning, quotas, and a permissions model twice as complicated. No invoicing, no
contracts, no CRM, no tasks.

**The whole competitive claim is "we are not an all-in-one."** Every feature past that
line weakens it.
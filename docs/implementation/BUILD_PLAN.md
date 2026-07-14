# PageVault — Build Plan

> **Rewritten 2026-07-14** after competitive research moved the product from *"publish
> a link"* to *"the collection."* See ADR-005, ADR-006, ADR-007. The original ten-phase
> plan is in git history; phases 0–2 shipped and survive intact.

Read `docs/architecture.md` first. The ADRs in `docs/adr/` explain the decisions that
are not obvious — read the relevant one before overturning it.

---

## The organizing question

**What is the smallest thing that answers the kill criterion?**

> Build v1 → use it on a real client engagement for a month → does the collection
> actually change anything, or is one URL per client a solution to a problem only I
> have? If yes, build the portal properly and launch. If no, keep the tool, kill the
> marketing, laugh, move on.

Everything in the MVP serves that. Everything that does not is a layer.

The sharpest thing the research surfaced: the client-portal incumbents' own guidance
says do not adopt a portal below **10+ active engagements**. We have ~1.5, and are
unlikely ever to have more than ten. The bet is that the collection is useful **to the
owner at n=1** — because an agent can read it back — before it is ever useful to the
audience.

**So the MVP is the agent loop, not the client-facing page.** The portal page must be
functional and unembarrassing. It does not have to be beautiful until a client
actually looks at it.

### The two claims that are NOT bets

These are craft, not market risk. They do not need validating, they need protecting:

1. **Deploying this is easy.** Differentiating, and a product requirement. The
   provisioning script is in the MVP (M6) because any deployment needs it; the
   friendly `init` wrapper is Layer 1, because it is only *validated* when a stranger
   uses it.
2. **Onboarding a client costs the client nothing.** No account, no invitation, no
   password — a link, a six-digit code, done. This falls out of Cloudflare Access for
   free. **There is nothing to build here, only something to protect:** anything that
   adds a step on the client's side is a bug, and it is the thing the whole n=1.5
   argument rests on.

---

## Done

**#1 — Scaffold.** Worker, Vitest + Miniflare, Makefile, CI. Merged.

**#2 — KV store and publish/fetch API.** Merged, and it survives the pivot: the store,
the bearer auth, the N+1-safe listing, and the validation are all reused. `DocMeta`
grows `portal`, `ownerOnly`, `extraEmails`, `summary`, `sourceKind`. There is **no data
to migrate** — which is the entire reason the portal model lands now rather than later.

---

## MVP — "can I run a real engagement out of this for a month?"

Build in this order. Do not reorder — pure functions first, routes last, deliberately.

### M1 — Portal model, `identify()`, and `canView()` ⚠️  *(#4)*

**No routes.** Pure functions and exhaustive tests. This is the only part of the system
where a bug is a security incident rather than a bug.

- Portal + member KV layer. Slug validation and the reserved-word list, in **one** place.
- `identify()` — JWT verify via JWKS, match on `kid`, pin **both** `iss` and `aud`.
  Fail-closed tests **before** happy-path tests.
- `canView(doc, portal, members, email, env)` — one function, the full matrix in
  `docs/architecture.md` §5.

The two cells that carry all the risk:

- **Member of a *different* portal.** Cross-portal leakage ends a consulting business,
  it doesn't lose a feature. Write that row first.
- **`ownerOnly` + `extraEmails`.** If `extraEmails` is checked before `ownerOnly`, this
  silently leaks drafts and every other test still passes.

### M2 — Viewer shell, sandboxed iframe, capability tokens  *(#3 — implements ADR-007)*

- Capability token: HMAC over `{scope, email, docId, exp}`, ~10 min. The same primitive
  as the console session token — one implementation, two scopes.
- Trusted shell + `<iframe sandbox="allow-scripts">`. **Never `allow-same-origin`.**
- `/render/{id}?cap=` — bytes only. Strict CSP *including* the `sandbox` directive and
  `frame-ancestors 'self'`, so even a direct navigation lands in an opaque origin.
- Cookie-auth → require capability + an `Origin` check that rejects `Origin: null`.
  Header-auth → skip it.
- **Commit a hostile-artifact fixture** that tries to `fetch('/api/portals')`, read
  `document.cookie`, and POST offsite. All three must fail.
- **A lint-level test asserting `allow-same-origin` appears nowhere in the repo.**

### M3 — Portal routes  *(#13)*

`/v/{slug}` · `/v/{slug}/{id}` · `/p/{token}` · `/` → `/admin`. Portal and member API.
`noindex` on public routes.

The portal page: name, description, documents newest-first grouped by month, each with
title, summary, date, tags. Client-side filter. **No PageVault branding above the
fold** — the client is looking at your work, not at a SaaS product.

### M4 — Remote MCP at `/mcp` ⭐  *(#8 — implements ADR-006)*

**The reason the project exists.** `createMcpHandler`, Streamable HTTP, stateless, a new
server instance per request, bearer auth, no Access app in front of it.

Write: `publish_document`, `create_portal`, `update_portal_members`, `mint_public_link`,
`revoke_document`.

Read — **the differentiator**: `list_portals`, `list_documents`, `read_document`,
`search_portal`.

Two rules:

- **An agent must not clobber a client deliverable in one tool call.** Publishing over an
  existing `(portal, title)` returns a diff and requires `confirm: true`.
- **The model must not infer the portal from conversation.** One portal → resolve
  silently. Two or more with no default → error and list them. Inferring "this is
  probably the RealPlus one" from chat is exactly the failure that leaks Client A's
  report into Client B's portal.

Read tools go through the **same `canView()`** — the cross-portal threat wearing a
read-only disguise.

Plus a thin stdio bin that **proxies to `/mcp`**, so Claude Desktop works before OAuth.

### M5 — Minimal owner console  *(#5)*

Enough not to fly blind: portals, documents, membership, visibility, delete with
confirmation. Session token minted into the page, never the API token. Strict nonced
CSP — a different, tighter policy than the artifact sandbox.

### M6 — Provision Access with a script, deploy, then stop and use it  *(#9, part 1)*

**Easy deploy is a differentiating characteristic of this product, not launch
plumbing.** But it cannot be validated by the author deploying once — it gets
validated when a stranger deploys it. So it splits:

**In the MVP:** the Cloudflare provisioning **script**. Two Access apps, the
`pagevault-viewers` group, the policies, the KV namespace — created via the CF API,
because that work has to happen for *any* deployment to exist, including this one.
Steal the pattern from sharehtml's `setup.ts` (Apache-2.0, ~900 lines, zero deps
beyond node builtins). Credit it.

**In Layer 1:** `pagevault init` — the prompts, the token-scope walkthrough, the
Zero-Trust-not-enabled deep link, `upgrade`. A thin wrapper around a script that has
already been run for real, once, by the person who wrote it. That is the opposite of
the usual failure mode, which is shipping an untested provisioning flow against a
clean account you do not have.

Then: one portal, real artifacts, **stop building for a month.**

> **n=0 or 1 is enough to start.** Dogfood on yourself — publish your own artifacts
> into your own portal and query them back through MCP. The agent-memory loop is
> testable on day one; it does not wait for a client to need a report.

---

## Layer 1 — launch-ready *(only if the MVP validates)*

Do not build this before the thesis validates. That inverts the original plan on
purpose.

- **`pagevault init`** *(#9, part 2)* — prompts, `upgrade`, the clean-account path,
  wrapped around the M6 provisioning script.
- **MCP OAuth 2.1** — the price of claude.ai, Desktop, and mobile, and the largest
  single piece of work in the plan. **If Anthropic grants `static_headers` beta access,
  delete it entirely** and ship a bearer token. Ask before building.
- **Public portals** `/pub/{slug}` — which *are* the marketing site. Every example
  served by the thing itself.
- **CLI** *(#7)* · **`/admin/upload`** *(#6)* · **README** *(#10)* with the honest
  comparison table, including the rows where competitors win.

## Layer 2 — loop closers

Email on publish (without it, *"you never send a link again"* is false) · read receipts
— disclosed on the portal page, off by default, never on public routes · PDF export and
a print stylesheet · engagement timeline · scoped API tokens · expiry · portal branding
· markdown rendering.

---

## Make targets

| Target | Lands in | Does |
|---|---|---|
| `help` `install` `dev` `test` `check` `deploy` | #1 ✅ | shipped |
| `test-security` | M1 | Just the `canView` + JWT suite. Fast enough to run on save. |
| `logs` | M5 | `wrangler tail` |
| `release` | Layer 1 | `npm publish` with preflight |
| `smoke` | Layer 1 | Post-deploy check against the live host |

One target per task, not per variant. Node 22 is not the system default here; every
target selects it.

---

## Open questions

- **`static_headers` beta.** If Anthropic grants it, ADR-006's OAuth work evaporates —
  a ~50-line endpoint instead of an authorization server. Worth knowing before Layer 1.
- **Markdown rendering.** `DocMeta.sourceKind` exists from M1 so it drops in with no
  migration, but the renderer is deferred — it is a dependency, and directive #6 says ask.
- **npm release convention.** No precedent anywhere in `~/yukon`. Layer 1. If it has
  real choices in it, write an ADR.
- **The n=1.5 problem.** Unresolved by construction. That is what the month of real use
  is for.
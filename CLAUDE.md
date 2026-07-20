# pagevault

Self-hosted, single-file HTML publishing with per-document access control, on
Cloudflare's free tier. Publish an LLM-generated report and get back a URL that
only the right people can open.

This file is public and ships with the repo. Personal/workspace conventions live
in `CLAUDE.local.md` (gitignored).

## Project context

**The link is not the unit. The client is.**

Over a nine-month engagement you produce fourteen artifacts for one client.
Fourteen links, fourteen emails, and a client digging through Gmail in March for
the architecture doc you sent in January.

PageVault is one Cloudflare Worker bound to one hostname. Cloudflare Access
answers *"who are you?"*. The Worker answers *"may you see this?"* — in exactly
one function, `canView()`. Permissions live on the **portal**, not the document,
so adding a person to a client's team is one write, not fourteen.

The collection reads back. The MCP server exposes `read_document` and
`search_portal`, so six months in, *"what did we decide about CDC on V2?"* is
answerable from the portal. Publishing and remembering become the same act. That
is what makes a portal worth having at one client.

Read `docs/architecture.md` before changing anything. The contested decisions are
ADRs in `docs/adr/`; read the relevant one before overturning it.

PageVault owes [`jonesphillip/sharehtml`](https://github.com/jonesphillip/sharehtml)
(Apache-2.0) three ideas: the Access-provisioning setup script, the capability-token
model, and the sandboxed iframe. Credit them in the README.

## Prime directives

1. **Single-operator infrastructure.** Not a SaaS, not multi-tenant. If someone
   wants that, they fork it.
2. **Small enough to read in one sitting.** That is the entire value proposition.
   A dependency someone forking this repo has to install is a cost.
3. **Portals are invisible until needed.** `pagevault publish report.html` must
   work without the user learning what a portal is. If the quickstart needs the
   word "portal," it is built wrong. See ADR-005.
4. **Every artifact is hostile.** It is LLM-generated, it runs JS, and it may come
   from content the model didn't control. It renders in a sandboxed iframe inside
   a trusted shell, never in our origin's document context. `allow-same-origin`
   must never appear in this codebase — there is a test for that. See ADR-007.
5. **One authorization function.** `canView()`. No exceptions, including for
   read-side MCP tools. Cross-portal leakage ends a consulting business.
6. **The Worker verifies the JWT itself.** Never trust
   `Cf-Access-Authenticated-User-Email`, never trust the `CF_Authorization`
   cookie, anywhere. See ADR-004.
7. **Ask before adding** a database, a frontend framework, a build pipeline, or
   any dependency beyond `jose`, the `agents` SDK, and the MCP SDK.

## Layout

```
worker/          the Worker — the whole product
  src/index.ts     router
  src/auth.ts      JWT verify, capability + session tokens, bearer auth
  src/access.ts    canView() — the one authorization function
  src/store.ts     KV access (portals, members, docs)
  src/api.ts       /api handlers
  src/mcp.ts       /mcp — remote MCP, Streamable HTTP
  src/viewer.ts    the trusted shell, /render
  src/console.ts   /admin
cli/             `pagevault` — thin HTTP client of /api  (Layer 1)
docs/
  README.md            the docs map — start here
  architecture.md      the design
  adr/                 decision records
  design/              UX + onboarding design notes
  setup/               run-it-yourself: prerequisites, backup/restore
  engineering/         how it's built and shipped: build plans, versioning, prod CI
```

**The MCP server is remote, not stdio** — it lives in the Worker. A stdio server
cannot run in a browser or on a phone, which is where artifacts actually get made,
and reaching those surfaces is the entire differentiator. See ADR-006.

## Conventions

- TypeScript throughout. `vitest` + `@cloudflare/vitest-pool-workers`.
- Node 22 (Wrangler 4 requires it).
- Tests earn their place. The security tests in `worker/test/auth.test.ts` are
  not optional — a bug there is an incident, not a bug.
- No secrets committed. `.dev.vars` is gitignored; `.dev.vars.example` is not.
- `make help` lists everything. Make is the entry point.

## Gotchas that will bite you

- **KV is eventually consistent** (~60s). There is no read-after-write guarantee,
  not even at the same edge. Never build anything that depends on one.
- **KV write quota is 1000/day free.** A publish costs 2–3 writes. `list()` has a
  separate 1000/day quota — do not poll it from the console.
- **Access rotates signing keys ~every 6 weeks.** Use JWKS, match on `kid`, never
  pin a key.
- **Disable the `workers.dev` subdomain and Preview URLs.** They route around
  Access entirely. The Worker fails closed without a JWT, so this is not a hole —
  but it is a required setup step, not a footnote.

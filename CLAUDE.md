# pagevault

Self-hosted, single-file HTML publishing with per-document access control, on
Cloudflare's free tier. Publish an LLM-generated report and get back a URL that
only the right people can open.

This file is public and ships with the repo. Personal/workspace conventions live
in `CLAUDE.local.md` (gitignored).

## Project context

The problem: you generate a beautiful self-contained HTML artifact and discover
there is no good way to hand it to another human. Drive won't render it. Gists
are public. Netlify and Vercel paywall password protection. GitHub Pages is
public-only. So you email a `.html` attachment like it's 2004.

PageVault is one Cloudflare Worker bound to one hostname. Cloudflare Access
answers *"who are you?"*. The Worker answers *"are you allowed to see this
specific document?"*. Per-document sharing lives in KV, so there is **one** Access
application per surface — not one per document.

Read `docs/architecture.md` before changing anything. The four contested design
decisions are recorded as ADRs in `docs/adr/`; read the relevant one before
overturning it.

## Prime directives

1. **Single-operator infrastructure.** Not a SaaS, not multi-tenant. If someone
   wants that, they fork it.
2. **Small enough to read in one sitting.** That is the entire value proposition.
   A dependency someone forking this repo has to install is a cost.
3. **Single-file HTML only.** Inlined CSS/JS, base64 images. No asset pipeline.
4. **`/d/*` and `/p/*` serve untrusted HTML.** Every document is assumed hostile.
   See ADR-003. Do not weaken the sandbox to make a demo work.
5. **The Worker verifies the JWT itself.** Never trust
   `Cf-Access-Authenticated-User-Email` or the `CF_Authorization` cookie. See
   ADR-004.
6. **Ask before adding** a database, a frontend framework, a build pipeline, or
   any dependency beyond `jose` and the MCP SDK.

## Layout

```
worker/          the Worker — the whole product
  src/index.ts     router
  src/auth.ts      JWT verify, session tokens, bearer auth
  src/store.ts     KV access
  src/api.ts       /api handlers
  src/console.ts   /admin and /admin/upload
cli/             `pagevault` — thin HTTP client of /api
mcp/             `pagevault-mcp` — stdio MCP server, also a thin client
docs/
  architecture.md      the design
  access-setup.md      Zero Trust config walkthrough
  adr/                 decision records
  implementation/      build plans
```

CLI and MCP ship as one npm package (`pagevault`) with two bins. Neither talks to
KV directly — both are HTTP clients of the API, so they work identically pointed
at anyone's deployment.

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

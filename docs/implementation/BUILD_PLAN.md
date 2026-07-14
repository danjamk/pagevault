# PageVault — Build Plan

Nine phases, each a branch and a PR. Read `docs/architecture.md` first; the ADRs in
`docs/adr/` explain the four decisions that are not obvious.

**Phases 0–7 need no Cloudflare account.** Everything is testable locally with
Miniflare KV and hand-minted JWTs. Cloudflare state is required only at phase 8.
That is deliberate — it means the security-critical work is done and tested before
anything is exposed.

Definition of done for every phase: tests pass, `make check` is clean, the PR
describes what changed and why.

---

## Phase 0 — Scaffold

Worker skeleton, no logic. Prove the toolchain works end to end before writing
anything worth debugging.

- `worker/` with `wrangler.jsonc`, strict `tsconfig.json`, `.dev.vars.example`
- `vitest` + `@cloudflare/vitest-pool-workers` (requires Vitest 4.x), one trivial
  test hitting a KV binding, to prove Miniflare is wired
- `Makefile` — `help`, `dev`, `test`, `check`, `deploy`. Start with ~8 targets, not
  30.
- `.github/workflows/ci.yml` — on PR to main: install, typecheck, test. Crib the
  shape from `djk-website`.
- pnpm, lockfile committed, `.nvmrc` = 22

**Exit:** `make test` passes on a clean clone. CI green.

**Note:** this repo introduces the first TypeScript test setup in the family and
the first npm-publish flow. Both are new conventions; if the npm release process
turns out to have real choices in it, write ADR-005 rather than inventing it in a
`package.json` script.

---

## Phase 1 — Store + publish/fetch API

The core loop, with no auth beyond a bearer token. Prove publish → fetch works.

- `store.ts` — `doc:`, `meta:`, `pub:` keys. Key metadata on `meta:` writes per
  architecture §4. **No index array.**
- `POST /api/docs`, `GET /api/docs`, `GET /api/docs/{id}`
- `GET /api/docs` renders off a single `list({ prefix: "meta:" })` — assert this in
  a test, because the N+1 version also passes a functional test
- Bearer check against `PAGEVAULT_API_TOKEN`, constant-time compare
- 12-char id from `crypto.getRandomValues`. No `nanoid`.
- Size cap ~10MB with a clear error

**Tests:** publish → fetch round-trip. List returns metadata, not bodies. Missing
bearer → 401. Wrong bearer → 401. Oversize → 413.

**Exit:** curl can publish and read back a document.

---

## Phase 2 — Public documents + the sandbox

- `/p/{token}` — `pub:` lookup → serve. No auth.
- `PATCH /api/docs/{id}`, `POST /api/docs/{id}/rotate`, `DELETE /api/docs/{id}`
- Visibility transitions: → `public` mints a token; away from `public` deletes the
  `pub:` key. Rotate deletes the old one. **Order matters** — delete the old `pub:`
  key before writing the new one, or a crash between the two leaves a live orphan
  link.
- Response headers per architecture §6, including the `sandbox` CSP (ADR-003)

**Tests:** public token resolves. Rotated token 404s immediately. Deleted doc 404s
on all three key types. Visibility transitions leave no orphan `pub:` keys. The
`sandbox` CSP header is present on both `/d` and `/p` — assert the exact string;
this is the kind of thing that gets "cleaned up" later by someone who doesn't know
what it does.

---

## Phase 3 — JWT verification and the allowlist ⚠️

**This is the phase where a bug is a security incident rather than a bug.** Treat
it accordingly. Do not rush it, do not merge it without the tests below, and do not
let a later phase relax anything in it.

- `auth.ts` — `jose`, `createRemoteJWKSet`, `kid` matching. Verify `iss` and
  `aud`. RS256.
- **Per-route AUD.** `/d` accepts only App A's AUD; `/admin` accepts only App B's.
  A single shared `CF_ACCESS_AUD` here is a privilege-escalation bug (ADR-001).
- `/d/{id}` — verify → email → load meta → **404** (not 403) unless email is on the
  allowlist
- Never read `Cf-Access-Authenticated-User-Email`. Never read the
  `CF_Authorization` cookie. (ADR-004)

**Tests — all of these, no exceptions:**

- Valid JWT, email on allowlist → 200
- Valid JWT, email **not** on allowlist → 404
- No JWT → 404
- **Invalid signature** → 404
- **Expired** JWT → 404
- **Wrong `aud`** (App B's token presented to `/d`) → 404
- **Wrong `iss`** → 404
- `Cf-Access-Authenticated-User-Email` header set, no JWT → 404 (the header is
  never trusted)
- `CF_Authorization` cookie set with a valid JWT, no header → 404 on `/api/*` (the
  cookie is never trusted)
- Email comparison is case-insensitive and normalized

**Exit:** every test above passes, and someone has read the diff specifically
looking for a way around it.

---

## Phase 4 — Owner console (`/admin`)

- Server-rendered, vanilla JS, `fetch()` against `/api/*`. No framework, no build
  step, no bundler.
- HMAC session token minted into the page, ~15min TTL, sent as a bearer header
  (ADR-004). Derive the signing key from `PAGEVAULT_API_TOKEN` — no new secret.
- `/api/*` accepts session tokens as a second bearer type. **No cookie path.**
- Strict CSP with a per-request nonce. Not the document sandbox — a different,
  tighter policy.
- Table: title, visibility, allowlist, tags, created, size. Per-row: copy link,
  change visibility, add/remove emails, rotate, preview, delete. Filter by tag and
  visibility. Confirm before delete, and say there is no undo.
- `/` → 302 `/admin`
- Expired session → reload the page (which silently re-auths through Access), not a
  silent failure

**Tests:** non-owner with a valid JWT → 403. Session token accepted on `/api/*`.
Expired session token → 401. Session token minted for one email cannot be replayed
as another.

---

## Phase 5 — Browser upload (`/admin/upload`)

- Drop or pick a `.html`, set title, visibility, emails, tags
- Returns the link with a copy button
- Warn on relative `src`/`href` — this is single-file only and a relative path will
  404 for the recipient
- Warn explicitly when publishing public: an unguessable URL is a capability URL,
  not privacy. Say so in the UI, not just the docs.

This is the only management path that works from a phone. It is not decoration.

---

## Phase 6 — CLI

- One npm package, `pagevault`, two bins. Thin HTTP client of `/api`. No KV access,
  no duplicated logic — it must work pointed at anyone's deployment.
- `publish`, `list`, `share`, `rotate`, `rm`
- Config from `~/.pagevault/config.json` or `PAGEVAULT_URL` / `PAGEVAULT_API_TOKEN`
- **Retry on read-back before printing the URL.** KV has no read-after-write
  guarantee (architecture §4). Publishing and immediately printing a URL that 404s
  is the first thing a new user will experience if this is skipped.
- Print the URL and nothing else on success, so it pipes to `pbcopy`
- Public publish prints the capability-URL warning to stderr, so it doesn't
  pollute the pipe

---

## Phase 7 — MCP server

- `pagevault-mcp`, stdio, second bin of the same package
- `publish_document`, `list_documents`, `update_document_sharing`,
  `revoke_document`
- Thin HTTP client of the same API. Same rule: no duplicated logic.
- `mcp/README.md` with the `claude_desktop_config.json` snippet and the Claude Code
  `mcp add` command

**Exit:** Claude writes a report, calls `publish_document`, hands back a link. This
is the payoff. If it isn't smooth, fix it here rather than shipping it.

---

## Phase 8 — `pagevault init` and the Access group

The first phase that needs a real Cloudflare account.

- `init` — verify token → list accounts → detect Zero Trust → create KV namespace →
  generate `wrangler.jsonc` → deploy → create Access group + two apps + policies →
  **read AUDs from the create responses** → set vars → redeploy → print URL and API
  token
- If Zero Trust is not enabled, deep-link the dashboard and stop. On re-run, read
  the team name back from the API rather than asking for it.
- `upgrade` — redeploy the bundled Worker, keep KV and config
- Shell out to `npx --yes wrangler@4`. Do **not** take Wrangler as a dependency —
  someone who only wants the MCP server should not install 80MB to get it.
- Access group sync on publish/patch: read → union → `PUT`
- `pagevault sync-access [--reap]` — recompute the union from KV, `PUT` the full
  list, optionally remove seats for emails on no allowlist (ADR-002)
- Fall back to `Include: Everyone` with a loud warning if `CF_API_TOKEN` is unset

**Verify empirically, before the README makes promises:**

1. Does the free Zero Trust plan actually require a credit card today? The docs say
   yes; some 2026 sources say no. This changes what the README is allowed to claim.
2. Does a Workers-Routes-only token 403 on custom-domain creation, or is DNS: Edit
   also needed?
3. Confirm that a path with no Access app really does reach the Worker with no JWT
   header. The docs imply it unambiguously but never state it in one sentence.

---

## Phase 9 — README and the launch

- README per architecture, structured like `slack-aws-cost-guardian`: one-line
  pitch → ≤3 badges → Features → **How It Compares** → Quick Start → How It Works →
  docs links
- The comparison table includes the rows where the alternatives win. It is the most
  useful part of the page and it gets reused in the write-up.
- The gotchas, stated loudly: seats, `workers.dev`, KV eventual consistency,
  single-file only, capability URLs, and the Zero Trust onboarding click-through
- `docs/access-setup.md` — the Zero Trust walkthrough with screenshots
- Walk the runbook on a clean Cloudflare account. The setup path is the entire
  product for anyone who isn't me; if it doesn't work start to finish on a fresh
  account, nothing else here matters.

---

## Open questions

- **npm release convention.** No precedent exists in `~/yukon`. Decide, and if it
  has real choices in it, write it down as an ADR.
- **Logo.** Whether PageVault sits inside the CTO/4 brand (technical → blue
  `#34507A`) or stands alone as its own product identity like `solobooks`.
- **Rate limiting.** Free-tier WAF gives one rule, IP + path, fixed 10s window —
  effectively useless. Either use the Workers rate-limit binding or ship without and
  say so. Do not claim rate limiting that does not exist.

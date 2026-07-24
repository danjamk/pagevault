# Changelog

All notable changes to PageVault are recorded here, following
[Keep a Changelog](https://keepachangelog.com/). Versions follow [SemVer](https://semver.org/)
per [ADR-010](docs/adr/ADR-010-versioning-and-releases.md): a version names released code, and a
deployment reports `<version>+<shortsha>` for exactly what it's running.

## [Unreleased]

## [0.20.0] — 2026-07-24

### Changed
- **A document's identity is now its filename, not its title (ADR-017).** Publishing keyed identity
  on the title, which is derived from content (`<title>` / `# H1`) — so two files with the same
  heading collided into one document, and copying a file to a new name to fork it failed. Identity is
  now `(portal, filename)`: the CLI sources it from the file's basename (`--name` overrides), and the
  MCP `publish_document` tool takes a `filename` param it manufactures. `title` is display-only, so
  two documents may share one. ADR-013's deterministic-id mechanism is unchanged (the #74 fork race
  stays fixed); only the hashed key moved.

  **Breaking:** document ids — and their `/p/` and `/v/` URLs — now derive from the filename, so a
  new publish of an existing document lands at a new URL. Old documents keep their URLs and stay
  readable (a name is synthesized on read), but re-publishing them forks rather than updates in place
  until re-published under the new scheme. No data migration (nothing shared yet — ADR-017).

### Added
- **`pagevault publish --name <filename>`** overrides the identity / update key (default: the file's
  basename). The `list` table gains a `FILE` column and `read` a `file` line, so the update key is
  always visible.
- **Collision handling.** A same-filename publish without `--confirm` now prints the three ways
  forward — replace in place, publish as a distinct document (`--name`), or change only the link
  (`mint <id>`) — with the existing id. The MCP `Conflict` message says the same.

### Fixed
- **Rung-1 publish handed back an un-openable link (#111).** On a no-Access deployment,
  `pagevault publish` defaulted to a members-only `/v/` document nothing could open, and the viewer
  showed a false "Cloudflare Access misconfigured" page. Publishing on a no-Access deployment now
  defaults to a public `/p/` link, and `/v/` there serves an honest "public links only" page instead
  of the rung-3 error.
- **The installed CLI told you to run `make` (#111).** `init`'s sign-off and the provisioning error
  messages referenced `make deploy` / `make provision` / `make setup` / `make preflight`, which an
  installed user doesn't have. They now show the `pagevault` equivalent from an install and keep
  `make` from a repo checkout.
- **Pre-ADR-017 documents read gracefully.** `getMeta` / `listDocs` synthesize a filename for
  documents that predate the change, so an in-place upgrade keeps listing and reading them.

## [0.19.2] — 2026-07-23

### Fixed
- **`pagevault login` now falls back to `PAGEVAULT_URL` / `PAGEVAULT_API_TOKEN`** when its flags are
  omitted, so `pagevault login` alone persists an already-exported environment to `config.json`
  instead of demanding you re-type values every other command already reads. It errors only when
  neither a flag nor the environment supplies a value. A zero-config-parity scan confirmed `login`
  was the only command that demanded input it could infer — the rest already resolve their connection
  from env/`config.json` or auto-target the deployment from `~/.pagevault/`.

### Docs
- **Documentation audit.** Fixed two broken "Get it running" CTAs on the product page and a stale
  anchor in the docs map (the README section is now "Install — pick a path"); repaired two issue
  links with the wrong relative depth; removed a dead placeholder link in the README; updated the
  `CLAUDE.md` layout to list the operator commands and `cli/lib/ops/`; and reconciled the onboarding
  design doc to the shipped **tier 1/2/3** model (it was on the pre-build "Tier 0 / rung" vocabulary),
  reframing it as a historical design record that points at the current setup docs.

## [0.19.1] — 2026-07-23

### Added
- **Install-path guidance and an agent runbook (#103).** The README now presents the three ways to
  stand PageVault up — npm, `git clone`, or hand the runbook to your LLM. `docs/setup/cli-reference.md`
  documents every command, flag, and environment variable. `docs/setup/ai-guided-setup.md` is a setup
  runbook written *for an assistant* to walk a non-expert through deployment — a stable URL you paste
  to your LLM; it picks npm or clone and guides from there.

### Fixed
- **`PAGEVAULT_HOME` now isolates the login config too.** `config.json` follows `PAGEVAULT_HOME` the
  way `.pagevault.json` and `.env.local` already did, so one machine can hold several deployments
  without them colliding over `~/.pagevault/config.json`.

### Changed
- **Overhauled the npm package page**, which still described the pre-ADR-014 product ("a thin HTTP
  client… no local state") the package no longer is. Rewrote `cli/README.md` to the installed product
  — `init`, portals, the remote MCP server, the operator commands — and the package metadata with it:
  a `description` and `keywords` that surface the MCP surface, `homepage` pointed at the product page,
  an `author` field, and the **`LICENSE` now shipped inside the tarball** (`build-bundle.mjs` copies
  the repo-root license into the package at pack time).

## [0.19.0] — 2026-07-23

The installed CLI reaches parity with `make` for operating a deployment (#102): an install can now
diagnose and tear itself down, not just publish. One engine, two front doors — the command logic
lives in `cli/lib/ops/` and both the CLI and `make` call it, so there's no forked script layer.

### Added
- **`pagevault status`** — what this install is configured for (rung, account, host, versions).
  Local only, no network. `--json` for a machine-readable object.
- **`pagevault verify`** — the post-deploy smoke test (Worker liveness, the `/mcp`
  publish→read→revoke round-trip, OAuth discovery, a sample publish). `--json` emits a verdict with
  per-check results; the same exit codes drive an agent.
- **`pagevault health`** — assert the live `/health` reports the exact build you shipped, and that
  `/mcp` answers. `--json` for the verdict. This is what prod CI runs.
- **`pagevault destroy [--keep-data]`** — tear the deployment down. Same account-guard and
  type-the-target confirmation as before; now available to an install, not just a repo checkout.

### Changed
- **`pagevault init` writes the CLI login config** (`~/.pagevault/config.json`) for the deployment
  it just stood up — so `pagevault publish` works immediately, with no separate `pagevault login`
  step. `login` remains, for a second machine or someone else's deployment. (`init` and `login` now
  share one writer.)
- **`make status`/`verify`/`health`/`destroy` now run the CLI** (`pagevault <cmd>`) instead of
  parallel `scripts/*.mjs`. The four scripts are removed; the logic moved to `cli/lib/ops/` (shipped
  with the package). Prod CI's build check runs `pagevault health`. No behavior change to `make`.

## [0.18.0] — 2026-07-23

Viewer and console UX, most of it found by using the portals on real work.

### Added
- **Copy-as-rich-text for markdown documents (#93).** The viewer offers a Copy control for
  markdown docs that writes two clipboard flavors at once — the rendered HTML (paste into Google
  Docs and headings, lists, tables and bold come through) and the original `.md` (paste into a
  markdown editor). The shell fetches the bytes same-origin and hands them to the clipboard
  opaque; it never renders the artifact in our document context (no `allow-same-origin`, no iframe
  DOM read — ADR-007). HTML documents don't get it — they paste as a blank rectangle, and PDF
  export (#50) covers that case.
- **Client portal document rows** now show a document-type icon (Markdown vs HTML), a per-row
  copy-link button, and clickable tags — clicking a tag filters the list by it. Tags moved onto
  the meta line beside the date, under the summary.
- **Refresh controls** on both the client portal and the admin console, to pick up documents
  published out-of-band (from the CLI or an agent) since the page opened. In the console, refresh
  keeps the selected portal rather than dropping back to the default (#92).
- **Open the portal page** from the console portal header, the way a document row already opens
  (public and restricted portals — a private portal has no browsable page).

### Changed
- The console footer's deploy timestamp renders in the operator's local time; the UTC value stays
  as the no-JS fallback and in the title attribute.

MCP polish, both items found by using the server on claude.ai rather than reading the code.

### Added
- **`server_info` MCP tool (#98).** Reports the running deployment — `version`, `releaseVersion`
  (the clean semver, split from the `+sha`), `host`, `deployedAt`, `releasesUrl` — so from inside
  a chat you can confirm *which* deployment you're connected to (test vs. prod) and whether it's
  current. The version was always on the wire at `initialize`, but that is protocol metadata a
  model can't report; only a tool result reaches it. The description doubles the tool as a
  check-for-updates: compare against the latest release, offer to summarize what changed, and
  point at `npm update -g pagevault && pagevault upgrade`. The Worker makes no outbound call — the
  model does the lookup, so the Worker stays dependency-free.

### Changed
- **`publish_document` guards against a truncated publish (#99).** A "publish this doc" request
  stored a placeholder and needed a `read_document` round-trip to catch it — three tool calls for
  a one-call job. The `html` description now forbids a stub verbatim, and the result reports the
  stored `bytes` (prose and `structuredContent`), so a placeholder is obvious from the publish
  call itself. No read-back required.

## [0.16.1] — 2026-07-23

A same-day fix for 0.16.0. The Origin block it shipped broke the claude.ai web connector.

### Fixed
- **`/mcp` no longer refuses a foreign `Origin` with 403 — it logs it and lets the auth gate
  decide.** 0.16.0 added the 403 to satisfy the MCP 2025-11-25 DNS-rebinding rule; a live
  claude.ai connect proved it wrong within the hour, because the web app calls `/mcp` from the
  browser with `Origin: https://claude.ai` and the block read as "server unavailable." That rule
  is written for localhost-bound servers that grant access by network position. On a remote,
  token-authenticated server it defends a door that does not exist: a rebound page steals ambient
  authority, and `/mcp` grants none (no cookie, ever — [ADR-004](docs/adr/ADR-004-console-auth.md)),
  so an attacker's page can only make unauthenticated requests that 401 regardless of `Origin`.
  A foreign origin is now recorded as an `mcp_foreign_origin` log event, not blocked.

## [0.16.0] — 2026-07-23

MCP hardening. The remote server closes the last three gaps between "good" and
"reference-quality": it refuses a foreign `Origin`, it returns machine-readable results
so an agent stops re-parsing IDs out of prose, and documents are now addressable as
Resources — the user-attachable half of *the collection reads back*. Governed by
[ADR-016](docs/adr/ADR-016-documents-as-mcp-resources.md).

### Added
- **Structured tool output (#81).** The five chain tools — `list_portals`, `list_documents`,
  `read_document`, `search_portal`, `publish_document` — declare an `outputSchema` and return
  `structuredContent` (the id and a ready-to-open `url` as fields) beside their unchanged prose.
  The `url` respects the portal kind (`/pub/` vs `/v/`) so an agent never hands out a link that
  would burn an Access seat on a public document. Emitted as JSON Schema 2020-12 (SEP-1613).
- **Documents as MCP Resources (#82, ADR-016).** Every document is addressable at
  `pagevault://<portal>/<id>` through a resource template; the read reuses the same read path the
  tools do, and `list_documents`/`search_portal` return `resource_link` handles into the space. A
  URI whose portal does not match where the document lives is refused. Shipping is gated on
  verifying a non-Desktop host renders the primitive — the code is present and tested; the
  per-surface claim waits on the live check (#95).

### Fixed
- **Foreign `Origin` on `/mcp` is refused with 403 (DNS-rebinding, MCP 2025-11-25 MUST).** The
  check runs ahead of authentication, so a rebound browser holding a real credential is still
  refused; a request with no `Origin` (Claude Code, the connector infrastructure) is allowed, as
  it must be. Not exploitable today — nothing on `/mcp` authenticates by cookie (ADR-004) — but a
  spec MUST and defense in depth.

## [0.15.0] — 2026-07-22

The Worker stops keeping secrets from its operator. Fifteen named events replace four, every
authorization refusal is now visible, and Analytics Engine records which documents a client
actually opened — governed by
[ADR-015](docs/adr/ADR-015-what-a-view-record-contains.md), which decides once what either
stream may contain rather than deciding it twice.

### Added
- **Authorization and failure logging (#41).** The Worker emitted four events; it now emits
  fifteen. Every `canView`/`canViewPortal` denial, all four `/p/{token}` refusals, MCP tool
  failures, and JWT rejections are named events with a level — `error` means the deployment is
  broken, `warn` means a visitor did something ordinary. `worker/src/log.ts` is the only writer.
- **JWT failures are classified by blast radius.** A JWKS fetch failure or key-rotation miss is
  a total lockout and logs as an error; an expired token is one user and logs as a warning. Both
  used to be the same silence.
- **View tracking (#91).** Analytics Engine records which documents each client opens, read back
  with `make views` or `pagevault views [--days] [--portal] [--doc] [--json]`. Optional — no
  binding, no recording. Identity is recorded only on the Access-gated surface; `/pub/` and
  `/p/` views record no viewer, no IP and no User-Agent, because those routes never had an
  identity to withhold ([ADR-015](docs/adr/ADR-015-what-a-view-record-contains.md)).
- **`docs/architecture.md` §12, Operations (#45)** — the event table, what is never logged, the
  Workers Logs boundary, log retention and sampling, the free-tier quotas that actually bind, why
  an invocation is not a view, and why fail-open cannot serve an unauthorized document. Plus the
  fact that Cloudflare sends **zero** Workers notifications at any tier, so every guardrail here
  is one you build.
- **`make logs` takes filters** — `ERRORS=1`, `SEARCH=<text>`, `JSON=1`. A bare tail was mostly
  request lines; there are fifteen named events to narrow to now.

### Fixed
- 🔴 **Capability tokens no longer reach the log.** `logBlocked` wrote `request.url`, and
  `/render` takes its capability from `?cap=`. The fix removes the URL entirely rather than
  sanitizing it: on `/p/{token}` the path *is* the credential, so a "safe path" would have been
  the same bug. Tokens now appear as an 8-hex fingerprint.
- **A deploy no longer fails on an account without Analytics Engine.** The binding is conditional
  on a stored answer, so `pagevault init` on a fresh account cannot die on `error 10089` at the
  last step. `make provision ANALYTICS=on|off`.

### Notes
- Cloudflare attaches the request URL to every log event itself, so `/p/` URLs still reach
  Workers Logs through platform metadata regardless of what the Worker writes. Bounded by the
  account. Enabling Logpush changes that, and should be treated as a decision.
- Analytics Engine retains three months. View data is a rolling window, not a history.

## [0.14.0] — 2026-07-21

The npm package becomes the installed product ([ADR-014](docs/adr/ADR-014-installed-product-not-thin-client.md)):
`npm install -g pagevault && pagevault init` stands PageVault up on your own Cloudflare account with
no clone. Published as `pagevault@0.2.0` on npm.

### Added
- **`pagevault init` / `pagevault upgrade` (#87).** `init` walks you through the Cloudflare token,
  tier, owner, and account, then provisions and deploys the Worker; `upgrade` redeploys after
  `npm update -g pagevault`, keeping KV, config, and secrets. No repo checkout.
- **A prebuilt, self-contained Worker bundle the package ships (#86).** `build-bundle` compiles
  `worker/src` to a single ~792 KiB-gzipped `cli/dist/worker.js` (jose/agents/MCP inlined) at pack
  time and stamps the product version; `init`/`upgrade` deploy it verbatim with `no_bundle`, so a
  user's machine needs no source, no Worker dependencies, and no TypeScript build. `make
  deploy-bundle` validates the same path from a checkout.
- **The provisioning code and wrangler template now ship in the package.** `provision`, `deploy`,
  `tier0`, `setup`, and `context` moved to `cli/lib/provision/` as importable functions; operator
  state resolves to `~/.pagevault/` when installed, the repo cwd when run from source
  (`PAGEVAULT_HOME` overrides).
- **The owner console footer shows the deploy time to the minute** (UTC), not just the date.

### Changed
- The README leads with the installed product; `git clone && make` is now the from-source /
  contributor path. Prime directives #2 and #7 and the CLI's framing updated for ADR-014.

### Notes
- The `pagevault` npm package version (`0.2.0`) is independent of this product version by design;
  the product version is stamped into the deployed Worker and reported at `/health`.

## [0.13.0] — 2026-07-20

Adds the Access-group reconciler — the first slice of the packaging lifecycle (#42, ADR-014).

### Added
- **`pagevault sync-access [--reap]` (#85).** Rebuilds the `pagevault-viewers` Access group to
  match KV: portal members, per-document grants, and the owner. Additive by default (never
  revokes); `--reap` prunes members KV no longer authorizes, reclaiming their Cloudflare Access
  seats. A thin `/api` call — the reconcile runs server-side (`POST /api/access/sync`), so the
  CLI never holds a Cloudflare token. The owner is always kept, so a reap can't lock you out.

### Fixed
- **Removed portal members no longer linger in Access (#20, operational half).** Membership
  removal narrows `canView()` immediately but left the person in the Access group holding a seat;
  `sync-access --reap` is the reconciler that reclaims it (ADR-002).

## [0.12.0] — 2026-07-20

Polishes the remote MCP server to the annotation + instructions bar, and documents how to
connect Claude to it.

### Added
- **Tool annotations on every MCP tool (#80).** All eleven tools moved to `registerTool` and now
  carry `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` plus a human `title`.
  A host can auto-run the four read tools and knows to confirm before `revoke_document`,
  `revoke_public_link`, `rotate_public_link`, or a `publish_document` overwrite. Hints are
  advisory — the Worker still authorizes every call; they never substitute for `canView()`.
- **Server `instructions` (#80).** The three cross-cutting rules — the portal is a client
  boundary and must never be guessed (prime directive #5), public links are capability URLs, and
  publishing over a title replaces in place — are stated once at `initialize` instead of
  copy-pasted across tool descriptions.
- **MCP connection guide (`docs/setup/connect-mcp.md`).** How to point Claude at the server: the
  claude.ai account connector for web and Desktop (#22 OAuth), a bearer-token setup for Claude
  Code, and the Tier-0 `npx mcp-remote` fallback — plus the ~150k-character Claude Desktop
  tool-result cap that can truncate `read_document`.

## [0.11.0] — 2026-07-20

Brings the terminal up to the MCP tool surface and closes a real gap in the public-link
lifecycle on both — plus a hard net against shipping a broken CLI package.

### Added
- **CLI ↔ MCP surface parity (#73).** The `pagevault` CLI gains `read`, `search`, `mint`,
  `revoke`, and `rotate`, mirroring the MCP tools so the terminal is never a lesser surface
  than an agent. `read <id> [--source]` reads a document back (metadata, or the stored body
  for redirect-free export); `search <portal> <query…>` is keyword search scoped to one
  client; `mint`/`revoke`/`rotate` manage a document's public `/p/` link.
- **Public-link lifecycle on the MCP server (#73).** New `revoke_public_link` (kill the link,
  keep the document) and `rotate_public_link` (replace a leaked link with a fresh one). These
  existed on neither surface before; `revoke_document` still deletes the document (the mirror
  of the CLI's `rm`), which is why the link-only operations needed their own verbs.
- **Pack-and-install smoke test for the CLI (#56).** `cli/smoke.mjs` packs the tarball,
  installs it into a throwaway directory, and runs the binary — exercising the `files`
  allowlist, `bin` path, and shebang that in-repo tests never touch. Wired as
  `prepublishOnly` (a broken package can't publish), a CI step, and `make publish-cli`.
- **MCP best-practices doctrine (`docs/engineering/mcp-best-practices.md`).** The standard the
  remote MCP server is held to, with an honest conformance scorecard.

### Fixed
- **Rotating a public link is now a single atomic write.** Replacing a link as a client-side
  revoke-then-mint pair raced KV's eventual consistency — the second call could read the
  pre-revoke metadata at another edge and mint nothing, handing back the token it just
  revoked. A `rotatePublic` field on the document patch does the swap in one write.

## [0.10.0] — 2026-07-20

Fixes the publish race that could fork a client's link, plus Markdown publishing and a proper
connector icon.

### Fixed
- **Republishing a document no longer forks its URL (#74).** `publish_document` is
  create-or-update keyed on (portal, title), but the title lookup ran through KV `list()`, which
  is eventually consistent — a republish inside that window missed the existing document, minted a
  new id, and silently created a duplicate with a stale client link. Document ids are now
  **deterministic** in (portal, normalized title)
  ([ADR-013](docs/adr/ADR-013-deterministic-document-ids.md)), so a republish overwrites the same
  keys in place: a duplicate is unrepresentable, not merely rejected.
- **The remote MCP connector shows the PageVault mark, not the parent domain's icon.** The Worker
  now serves `/favicon.ico` and `/favicon.svg` (the leaning-v); a `pagevault.<yourdomain>`
  deployment was otherwise falling back to the parent site's favicon.

### Added
- **Publish Markdown from the CLI and MCP (#63).** `pagevault publish report.md` infers the format
  from the extension (`--source-kind` overrides); MCP `publish_document` gains an optional
  `sourceKind`. The Worker renders Markdown to HTML at publish and keeps the original `.md` as the
  raw source — it could already render Markdown (#46); the publish surfaces just couldn't ask.

## [0.9.0] — 2026-07-20

OAuth 2.1 on the remote MCP server — connect PageVault to claude.ai, Claude Desktop, and mobile,
not just Claude Code — plus live MCP smoke checks so a broken `/mcp` can't ship unnoticed.

### Added
- **OAuth 2.1 for the remote MCP server (#22)** — the hosted Claude surfaces (claude.ai, Desktop,
  mobile) can now connect over OAuth 2.1 (PKCE, RFC 8414/9728 discovery, Dynamic Client
  Registration), alongside the bearer path Claude Code already used. The Worker validates every
  token itself; `canView()` still owns document authorization — OAuth only gates access to the MCP
  server (ADR-006). Built on `@cloudflare/workers-oauth-provider`: stateless, no Durable Objects.
- **Cloudflare Access as the OAuth consent IdP ([ADR-012](docs/adr/ADR-012-oauth-consent-access-idp.md))**
  — consent lives at `/admin/authorize`, behind the existing owner Access app, so at Tier 3 the
  operator logs in as themselves and grants tokenlessly. Tier 0/1 (no Access) keeps a paste-token
  fallback.
- **Live MCP smoke in `verify` and `health` (#75)** — `make verify` now drives `/mcp`
  (`initialize`, `tools/list`, a `publish→read→revoke` round-trip, OAuth discovery) and `make
  health` asserts the MCP surface answers, so a version-correct deploy with a dead `/mcp` fails
  loudly instead of shipping quietly.
- **`OAUTH_KV` provisioning** — `provision` (rung 3) and `tier0` (rung 0/1) create and wire the
  `pagevault-oauth` KV namespace; `destroy` tears it down.

### Changed
- The Worker is now wrapped by the OAuthProvider at every tier (the router became its
  `defaultHandler`), and `OAUTH_KV` is a required binding — created automatically by provisioning,
  so `make deploy` needs no manual step.

## [0.8.0] — 2026-07-19

Portal polish: term-aware search, a tidied index page, and editable portal settings.

### Added
- **Edit a portal's name and description from the console** — an **Edit** control on the portal
  header opens a "Portal settings" dialog that `PATCH`es `/api/portals/{slug}`. A typo in a client
  name no longer means re-creating the portal. **Name and description only** — `kind` is
  deliberately not editable here, because changing a portal's access floor (restricted→public
  exposes every document) is a confidentiality decision, not a settings tweak, and the slug is the
  URL. Stays inside the nonced-CSP + session-token console model (#70).

### Changed
- **`search_portal` matches every term, not just a contiguous phrase** — `searchPortal` did one
  substring match of the whole query, so `"bearer token loop"` missed a document that held all
  three words non-adjacently. It now splits on whitespace and requires every term to appear
  somewhere across title, summary, tags, and body (AND-of-terms). Still zero-machinery — no index,
  no tokenizer — and the KV read budget is unchanged (body read at most once per doc, only when
  metadata doesn't already cover every term). It's keyword search, not semantic; the tool
  description now sets that promise honestly (#19).
- **Tidied the portal index page** — retired the warm tan background and the amber draft chip for
  the neutral white/cool-grey + signal-blue system (#67), added a `prefers-color-scheme` dark
  variant, and now show the on-page filter for any non-empty portal (was >2 documents). Light
  touch: no webfont, no logo — the page stays the client's work above the fold (#71).

## [0.7.0] — 2026-07-19

Walk away with everything: a browsable, human-readable export of a whole deployment.

### Added
- **`pagevault export` / `make export`** — walk away with everything. Writes a browsable folder
  (or a zip): an `index.html` that links it all, an `ACCESS.md` that spells out who can see what,
  and one folder per portal with each document as a standalone file — HTML as `.html`, markdown as
  its original `.md`. `make export` auto-targets the deployment this clone deployed (URL from
  `.pagevault.json`, bearer from `.env.local`) and zips by default, so `make deploy && make export`
  is the whole ceremony; `PORTAL=`, `DRAFTS=1`, `NOZIP=1`, `OUT=` tune it. The `pagevault export`
  CLI does the same against any deployment you hold a token for. It's intentionally lossy — no ids,
  no `/p/` tokens — and **not** a restore format (that's `make backup`). Owner-only drafts are
  excluded unless you ask. A new owner-scoped `GET /api/docs/{id}/raw` returns document bytes
  (#35).

## [0.6.0] — 2026-07-19

The owner console adopts the Claude Design system — a new brand, a dark theme, and a
single-portal layout — alongside a batch of smaller console, provisioning, and docs improvements.

### Added
- **Copy a shareable portal link** — the portal card now offers a **Copy portal link** button for
  public and team portals: `/pub/{slug}` (anyone browses, no login) or `/v/{slug}` (the team
  browses after signing in, not forwardable to outsiders). A private portal opens only for the
  owner, so it gets no button. No new route — the browsable index pages already existed and stay
  gated by `canViewPortal`.
- **Deploy date, in the console and `/health`** — a new `PAGEVAULT_DEPLOYED_AT`, baked at deploy
  alongside the version (ADR-010). The console footer shows it next to the version (which links to
  the changelog), and `/health` now returns `deployedAt` so an operator or CI can read what is
  running and when it shipped without opening the console. `/health` stays deliberately shallow: it
  is public, so probing KV on every hit would hand anyone a way to burn the free-tier read quota.
- **The wordmark on the README** — outlined from Sora so it renders on GitHub with no webfont, on a
  card legible in both light and dark. Brand assets live in `docs/brand/`. Two `examples/` fixtures
  reference a remote image to show how export handles it: the interactive viewer loads it, a PDF
  export does not (the [#50](https://github.com/danjamk/pagevault/issues/50) renderer blocks all
  network by design).

### Changed
- **A console design system** ([#67](https://github.com/danjamk/pagevault/issues/67)) — the owner
  console adopts the Claude Design handoff: a signal-blue accent, a cool-grey ground, and the
  leaning-**v** wordmark that retires the aperture. It gains a **dark theme** with a persisted
  toggle, an access **badge** whose icon is tinted by how far a document can travel (only you /
  team / anyone-with-the-link / public), and a single-selected-portal layout — a sidebar of
  portals, one portal's header card and document list in the main panel. Account details (email,
  sign out) collapse into a profile menu; the entry point to publishing is named **Upload** to
  distinguish it from acting on existing documents. The wordmark's Sora glyphs ship as a ~2.5KB
  inlined woff2 subset (no webfont link, no build step, owner-page only); UI text stays on the
  system stack. Link-first / public-by-default sharing
  ([ADR-011](docs/adr/ADR-011-public-by-default-console.md)) is unchanged — the handoff mockup
  predates that decision and is not followed on it. Per-person sharing now hides once a document
  is open to anyone with the link (it adds nothing there), and "anyone with the link" carries the
  link icon, not the globe. No new dependencies; still one server-rendered page under the strict
  nonced CSP.
- **`make provision` confirms Browser Run** — PDF export ([#50](https://github.com/danjamk/pagevault/issues/50))
  needs the BROWSER binding, and provisioning now reports whether Browser Run looks ready instead of
  leaving it unsaid. It is a printed confirmation, not a live probe: Browser Run is on by default on
  the Workers Free plan (nothing to enable), and there is no clean read-only capability endpoint —
  every quick-action endpoint spends the daily allocation.
- **`make help` reads by group** — targets are grouped (Develop · Test & check · Cloudflare account ·
  Deploy & operate · Data) instead of one flat list.

## [0.5.0] — 2026-07-19

The owner console gets author-side controls and a link-first sharing model.

### Added
- **Create portals from the console** ([#43](https://github.com/danjamk/pagevault/issues/43)) —
  a "New portal" dialog (name, slug, kind, description) posts to the existing `POST /api/portals`.
  Each kind's meaning is stated at the point of choice — Restricted spelled out as the only kind
  whose member list actually grants access — because picking wrong is a confidentiality decision,
  not a preference. Slug validation is surfaced from the server, not reimplemented. Reuses the
  console's short-lived session token, so no new server or auth surface.
- **Browser upload** ([#6](https://github.com/danjamk/pagevault/issues/6)) — drag-drop or pick an
  `.html` or `.md` file and publish from a device with no terminal. The kind is detected from the
  extension, so markdown renders instead of showing as raw source. Two warnings live in the UI, not
  just the docs: relative references will 404 for the recipient (single file, no companion assets),
  and a public link is a capability URL, not privacy.
- **Link-first sharing, public by default** ([#65](https://github.com/danjamk/pagevault/issues/65),
  [ADR-011](docs/adr/ADR-011-public-by-default-console.md)) — the sharing panel now leads with the
  share link, always present and copyable, and reach is one contextual choice that defaults to
  "anyone with the link" (the portal-governed option — your team, or only you — is one click away).
  A draft says plainly that it opens for no one, rather than handing you a live-looking copy on a
  dead link. The browser upload defaults to public too; "keep internal" is the opt-out. `canView()`,
  the capability-token model, and the CLI/MCP defaults are unchanged — this is a console default and
  presentation decision.

### Changed
- Minting a public link from the console no longer asks for confirmation — it is the expected default
  now. Revoking (which removes access someone may already hold) still confirms.

## [0.4.0] — 2026-07-18

Markdown documents render.

### Added
- **Markdown rendering** ([#46](https://github.com/danjamk/pagevault/issues/46)) — a document
  published as markdown now renders to styled HTML instead of showing its literal source.
  Conversion happens once at publish (`markdown-it`), so the render path stays a pure byte-server
  with no parser on the hot path and no extra read. Coverage matches a good editor preview: GFM
  tables, task lists, footnotes, emoji, and math (KaTeX, rendered server-side); mermaid diagrams
  and syntax highlighting draw client-side, loaded **only** when a diagram or code fence is
  present — every asset from a CDN the artifact CSP already allows, so the sandbox and CSP are
  unchanged (ADR-007). The original `.md` is retained under a new `raw:{id}` key: the raw download
  serves it, `read_document` returns it (markdown is what an LLM reading back actually wants), and
  body search greps it. This completes the markdown behavior [#49](https://github.com/danjamk/pagevault/issues/49)
  and [#50](https://github.com/danjamk/pagevault/issues/50) deferred. Known limit: a markdown PDF
  degrades mermaid/math because the #50 renderer blocks all network by design — the interactive
  view is full fidelity.
- An **Artemis program overview** example (`examples/artemis-program-overview.md`) exercising the
  full markdown feature set in one self-contained document.

## [0.3.2] — 2026-07-17

Single-page PDF export in the viewer.

### Added
- **Single-page PDF export** ([#50](https://github.com/danjamk/pagevault/issues/50)) — a **PDF**
  control in the viewer chrome renders a document to one continuous-page PDF, sized to content, so
  a long infographic is never paginated mid-chart. It runs on Cloudflare Browser Run
  (`@cloudflare/puppeteer`), reusing the same capability guard as the raw download — no document
  reaches the renderer unauthorized — and **blocks all outbound network during the render**, so a
  hostile artifact cannot phone home from the real headless browser (prime directive #4). Optional
  by construction: a deployment without the Browser binding hides the button and the endpoint
  answers `501`, so a fork that never wants PDF simply leaves it out. HTML today; markdown follows
  [#46](https://github.com/danjamk/pagevault/issues/46). First cut renders on demand — caching and
  session reuse are follow-ons.

## [0.3.1] — 2026-07-17

Reader controls land in the viewer chrome.

### Added
- **Download and share from the viewer** ([#49](https://github.com/danjamk/pagevault/issues/49)) —
  the trusted shell now carries a **Download** control on every document: the original source,
  served through the same capability guard as an attachment (`Content-Disposition: attachment`,
  `application/octet-stream`, `nosniff`) so a hostile artifact is never rendered inline in our
  origin — ADR-007, three ways. The filename honors `sourceKind` (`.html` / `.md`). A **Share**
  control copies the current URL (or uses `navigator.share()`), shown **only** on self-authorizing
  `/p/` and `/pub/` links where the URL actually opens for whoever receives it — never on an
  Access-gated `/v/` document, where it would hand out a dead end. Share only ever copies; minting
  and widening stay owner actions.

## [0.3.0] — 2026-07-17

A readable console, the `pagevault` CLI, and push-button production deploys.

### Added
- **A console you can read at a glance** ([#37](https://github.com/danjamk/pagevault/issues/37)) —
  every document row now leads with a *reach* icon that names how far it can travel: only you,
  the portal team, anyone with the link, or public. Expanding a row opens one sharing panel —
  mint and revoke a public link, add and remove per-document email grants (worded so they can't
  be mistaken for portal members), toggle draft, delete. A left-hand portal nav jumps between
  portals; **Copy link** now hands out the most-open working URL rather than a `/v` route that
  walks a recipient into a login wall; a **Sign out** control ends the Access session; and an
  aperture wordmark sits over the title. A public-link flag and `sourceKind` now ride the listing,
  so a markdown document — or a forgotten public link on a private-portal document — is visible
  without opening each one.
- **The `pagevault` CLI** ([#7](https://github.com/danjamk/pagevault/issues/7)) — a standalone,
  zero-dependency npm package (versioned independently, first cut `0.1.0`) that publishes from the
  terminal: `pagevault publish report.html` → a URL. A thin HTTP client of `/api` that works against
  any deployment. `publish` / `list` / `share` / `rm` / `login`; config from `~/.pagevault/config.json`
  or `PAGEVAULT_URL` + `PAGEVAULT_API_TOKEN`; a read-after-write retry so the URL it hands back
  resolves; and a stdout=URL / stderr=everything-else contract so `publish … | pbcopy` just works.
  (`rotate`, the rung-ladder wrapper, and the MCP bin remain on #7 as follow-ups.)
- **Push-button production deploys** ([#38](https://github.com/danjamk/pagevault/issues/38)) —
  a manual `workflow_dispatch` GitHub Action that ships prod through CI, reusing the existing
  `scripts/` (no forked deploy logic). Maintainer tooling: the environment is simply whichever
  Cloudflare token is active — dev in a clone's `.env.local`, prod only in GitHub Environment
  secrets — so the prod credential is never on a developer's machine. A forker can delete the
  workflow and nothing breaks. See [docs/engineering/deploy-prod.md](docs/engineering/deploy-prod.md).
- **`make health`** — assert the live `/health` reports the exact `<version>+<sha>` of your
  checkout; the post-deploy gate that fails a CI deploy on a rollout that didn't take.

### Changed
- **Deploy reuses the bearer, never mints a throwaway** — `make deploy` now prefers an
  environment-provided `PAGEVAULT_API_TOKEN` (a CI secret) and fails loud in a non-interactive
  deploy into a fresh Worker, rather than generating a random prod bearer stranded on the runner.
- **CI runs the `scripts/` `node --test` suites** (schema migration, KV backup, bearer policy) —
  `pnpm test` is vitest only, so these had been guarding nothing on GitHub.

### Fixed
- **A per-document email grant now actually reaches the person** ([#27](https://github.com/danjamk/pagevault/issues/27)) —
  publishing or sharing a document to specific emails admits them to the `pagevault-viewers`
  Access group, so Cloudflare Access lets them through the door. Previously the grant landed in
  KV while Access still blocked them — a silent half-success. Removing a grant narrows access
  immediately but leaves the seat for the reconciler (the address may be granted elsewhere; see
  ADR-002), and every publish/patch now reports the group-sync outcome instead of swallowing it.

## [0.2.0] — 2026-07-17

Version identity and release discipline — a deployment can now report exactly what it runs.

### Added
- **Version identity in the deployment** — `<version>+<shortsha>` (with `-dirty` for an
  uncommitted tree), baked into the Worker at deploy and reported by `/health` (unauthenticated,
  machine-readable), the MCP `serverInfo`, the console footer, and `make verify`.
- **A documented release process** ([ADR-010](docs/adr/ADR-010-versioning-and-releases.md)):
  SemVer driven by our conventional commits, the commit as "build number", the version decoupled
  from deployment (the operator chooses when to upgrade), assisted bumps, and releases as a tag +
  GitHub Release + this changelog.
- **`/pr` suggests a version bump** from a branch's conventional commits (in `claude-shared`).

## [0.1.0] — 2026-07-17

The foundation — the whole deploy ladder, working end to end.

### Added
- **The deploy ladder** — `make setup → preflight → deploy → verify`, token-first, across all
  three rungs: publish on `*.workers.dev` (rung 1), your own domain (rung 2), and client portals
  behind Cloudflare Access (rung 3). Climbing a rung is re-running `make setup`; documents carry
  across.
- **Remote MCP server** — publish and search a portal from a chat.
- **Sharing** — public `/pub` portals, single-document `/p/` capability links (zero Access seats),
  and email-secured portals via the `pagevault-viewers` group.
- **The owner console** at `/admin`.
- **`make backup` / `make restore`** — KV snapshot and same-host recovery, metadata-preserving so
  restored documents come back *listed*, not just fetchable.
- **State schema versioning** — `.pagevault.json` carries a `schemaVersion` with an ordered,
  fail-loud migration runner; `make status` and the command headers show the version.
- **The two-token model** — a broad provisioning token (`CLOUDFLARE_API_TOKEN`, on your machine)
  and a narrowly scoped runtime token (`CF_API_TOKEN`, in the Worker) for viewer-group sync only.

### Security
- The Worker verifies the Cloudflare Access JWT itself (ADR-004) — it never trusts a header or the
  `CF_Authorization` cookie.
- Artifacts render in a sandboxed iframe with an opaque origin (ADR-007); `allow-same-origin`
  never appears in the codebase.
- One authorization function, `canView()`, including for the read-side MCP tools.

[Unreleased]: https://github.com/danjamk/pagevault/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/danjamk/pagevault/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/danjamk/pagevault/releases/tag/v0.1.0

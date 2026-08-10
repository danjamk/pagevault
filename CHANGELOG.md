# Changelog

All notable changes to PageVault are recorded here, following
[Keep a Changelog](https://keepachangelog.com/). Versions follow [SemVer](https://semver.org/)
per [ADR-010](docs/adr/ADR-010-versioning-and-releases.md): a version names released code, and a
deployment reports `<version>+<shortsha>` for exactly what it's running.

## [Unreleased]

### Fixed
- **`--no-analytics` now sticks at the Public tiers.** It was honoured for one deploy and then
  forgotten: rungs 1–2 deliberately recorded nothing, so a `declared` value set months earlier by a
  Secured provision outranked it forever. An operator who said `--no-analytics`, saw `off`, and
  deployed again next week found view tracking back on with no memory of asking. An explicit flag —
  or `PAGEVAULT_ANALYTICS` — is now recorded; a bare default still is not, which is what keeps the
  question live for the day you climb to Secured and get asked directly. Every deploy says which of
  the two just happened. ([#194](../../issues/194))
- **`protected` reaches `upgrade`** — the one command that replaces the code a deployment is
  running, and the only destructive one the flag could not see. Not an omission in a list: the
  document commands resolve their target through the registry, where `protected` lives, and
  `upgrade` resolved through the build record and never read the registry at all, so the gate could
  not fire even in principle. It now refuses without an explicit `--yes`, before anything is built or
  contacted. Unprotected deployments are unchanged. ([#176](../../issues/176))

### Added
- **The deploy banner names the deployment.** ADR-021 gave deployments names so the operator
  confirms identity before acting, and the vocabulary stopped at the door of the most consequential
  command — the y/N block showed an account id and a URL, which name a machine rather than the thing
  the operator calls "prod". Printed when the deployment is registered, silent on a first deploy.
  ([#176](../../issues/176))
- **[`docs/setup/scheduling-the-sync.md`](docs/setup/scheduling-the-sync.md)** — working snippets for
  launchd, a systemd timer, cron and a scheduled GitHub Action, with a sentence on choosing between
  them. "Schedule it" was easy to say and left every operator to work out the wiring; production had
  a worked example and nobody else did. Linked from `sync-views --help` and the CLI reference, which
  is where the question gets asked. ([#166](../../issues/166))
- **The gotcha that actually breaks these jobs, named up front.** `pagevault` starts
  `#!/usr/bin/env node`, so under cron's minimal environment even the *full path* to it fails with
  `env: node: No such file or directory`. Every snippet sets `PATH` accordingly. Found by running it,
  and it is the difference between a schedule that works and one that silently never runs.

## [0.36.0] — 2026-08-10

Your own traffic, readable from anywhere — and in the conversation you are already having.

### Added
- **`pagevault views` needs no Cloudflare credential.** It reads the summary stored in your own
  deployment, over `/api`, with the bearer every other command already uses — so it works from a
  machine that did not provision the deployment, which is the ordinary case for a production
  instance deployed by CI. It also reaches further back than it could before: Analytics Engine keeps
  ~90 days, the accumulated summary keeps everything ever synced into it. ([#168](../../issues/168))
- **`GET /api/views/summary`** — owner-scoped, returning totals and breakdowns by document, portal,
  day and referrer for a requested window, alongside coverage, the sync time and the staleness
  verdict. `?raw=true` returns the stored summary verbatim, for backup. The route was POST-only.
- **`worker/src/rollup.ts`** — one aggregation, computed in the Worker and shared by every surface
  that reports traffic. The CLI asks for it over HTTP; the console and MCP will call it in-process.
  A client-side rollup would be a second implementation of the same arithmetic over a versioned wire
  shape, and the copy nobody watches is the one that drifts.
- **`--live` and `--who` on `views`.** `--live` keeps the Analytics Engine query — what has happened
  since the last sync, and who opened it. `--who` implies it: the summary has never held an identity
  (ADR-019 §4), so there is nowhere else to get one.
- **`views --by doc|portal|day|referrer`.** The old shape grouped by
  `(portal, doc, title, surface, viewer)`, so one document was many rows, `VIEWS` was a per-row
  number, and there was no time axis anywhere. Now a document is one row with one number, portals
  and days total properly, and `--by day` draws the shape rather than making you read it out of a
  column of numbers. ([#162](../../issues/162))
- **`make sync-views`.** The write half was reachable from the CLI and not from `make`, so one front
  door could not reach half the feature. ([#166](../../issues/166))
- **A `traffic` MCP tool.** Metrics reached agents only as fields riding along inside
  `list_documents` and `read_document`, so an agent could answer *did they open this document* and
  nothing else — not how much traffic last week, which portal is busiest, whether a referrer is
  producing anything, or what the trend is. That is the question most worth asking in the place it
  could not be asked: while you are already in a conversation about that client. Same rollup,
  called in-process. Counts and surfaces, never identities. The staleness stamp is in the prose as
  well as `structuredContent`, so a host that renders only text still sees "as of".
  ([#163](../../issues/163))
- **A traffic panel in the console.** Deployment total, a daily sparkline, per-portal bars and top
  referrers, from the same rollup — read through the owner session the console already holds, so no
  Cloudflare credential reaches the page. This panel *is* the dashboard: Analytics Engine has no
  console of its own, is absent from the GraphQL API, and so cannot feed Cloudflare's Custom
  Dashboards either. Sync **status**, never a sync button — the Worker cannot read Analytics Engine,
  so a button would have nothing to call; it shows when the summary was taken, how much history is
  at risk, and the command that fixes it. ([#164](../../issues/164))

### Removed
- **`scripts/views.mjs`** — a second implementation of `views` that queried Analytics Engine
  directly. `make views` now calls the CLI, so both front doors reach one engine and a flag added to
  either reaches both. It stays zero-config: the CLI resolves this checkout's deployment from the
  marker beside the Makefile. ([#166](../../issues/166))

### Changed
- **The Worker still cannot read Analytics Engine, and gains no capability here.** ADR-019 decision
  1 is unchanged by ADR-025 — this serves a KV value the operator synced in.
- **A CLI newer than its deployment says so.** Asking an older Worker for view history returned a
  raw `405 method_not_allowed`, which reads as a broken deployment rather than an out-of-date one.
  Since the package ships on npm independently of any deploy (ADR-010), that is the ordinary state
  after `npm update -g pagevault`, not an edge case.

## [0.35.4] — 2026-08-09

A successful install stops being followed by a command that cannot authenticate.

### Fixed
- **The bearer `init` just set is one the CLI can actually use.** `init` reported
  `PAGEVAULT_API_TOKEN set` and the very next `pagevault list` reported `No bearer` — four lines
  apart, same words, reading as a flat contradiction on the one run where the operator has no
  context to resolve it. Both were true of different stores: the Worker's secret, and this machine's
  copy in `.env.local`. The document commands were the only caller not reading that second one —
  `verify` and `health` resolve the identical target and have always read it — so a successful first
  install left the CLI unable to talk to what it had just built. ([#195](../../issues/195))
- **A deploy no longer guesses whether the next command will work.** It asked a different question
  than the document commands do, which is how it could report both things at once. It now computes
  the answer with the same resolver they use, and names *which* store the bearer came from —
  `PAGEVAULT_API_TOKEN` meaning two things is what made the pair unreadable.
- **A printed `login` command can be pasted.** It carried `<name>` for the operator to invent and
  `$PAGEVAULT_API_TOKEN` for them to dig out of a gitignored file. The name is now suggested from the
  hostname, and the token is `$PAGEVAULT_API_TOKEN` only when the shell can actually expand it.

### Changed
- **The state bearer is paired to its build record.** `.env.local` belongs to the `.pagevault.json`
  beside it, so it is sent only when that record describes the deployment being acted on.
  `verify --url <other>` from inside a checkout previously took that checkout's token — [#155](../../issues/155)'s
  shape, one file over. Nothing that worked stops working; the case that was wrong now refuses.
- **`No bearer for <url>` says where it looked.** Refusing is right; refusing without accounting for
  the token sitting on the machine reads as a bug in the tool.
- **A deploy that holds the bearer plaintext writes it to `.env.local`.** So a token supplied by an
  exported environment variable survives into the next shell. Skipped in CI, where the runner is
  about to disappear and the value is already a secret.
- **[ADR-021](docs/adr/ADR-021-a-deployment-is-a-named-thing.md) corrects a claim it never held to.**
  It said no bearer is ever written into a repository working tree; a checkout's gitignored
  `.env.local` has always held one. The correction is visible in the ADR rather than quietly edited —
  a sentence saying the document commands shouldn't read that file is part of why they didn't.

## [0.35.3] — 2026-08-09

A first deploy on a fresh account stops failing on a feature nobody asked for.

### Fixed
- **A first deploy no longer binds a capability nobody chose.** Rungs 1 and 2 wrote their Worker
  config from the committed template and never touched the Analytics Engine block, so every
  publish-only deploy bound `ANALYTICS` whether or not the account had Analytics Engine enabled.
  Wrangler refuses the *whole* deploy with error 10089 when the binding is present and the product
  is off — and rung 1 is the fork's on-ramp, so `pagevault init` on a fresh account is exactly where
  that landed. All three rungs now resolve view tracking through one function and strip the binding
  through one more. ([#190](../../issues/190))
- **The 10089 hint names a command that exists at the rung you are on.** It pointed at
  `provision ANALYTICS=off` / `init`, which is rung 3 only — so where the error actually fired there
  was nothing to run. It now names `deploy ANALYTICS=off` / `upgrade --no-analytics`, which reach
  every rung.
- **Turning view tracking off worked on Windows.** The strip is matched on newlines and the pattern
  assumed `\n`; Windows checks out the config template as CRLF, so it matched nothing, left the
  binding in place, and failed the provision on its own assertion. Found by the Windows CI job the
  first time a test exercised the strip directly.

### Added
- **`--analytics` / `--no-analytics` reach rungs 1 and 2.** They previously warned that the answer
  had nowhere to go and bound it regardless. `PAGEVAULT_ANALYTICS` and `ANALYTICS=on|off` reach them
  too, so a publish-only deployment can turn view tracking on without climbing to rung 3.
- **ADR-024's protection extends to every rung.** A rung 1–2 deployment that already binds
  `ANALYTICS` keeps it across a re-deploy that says nothing, and an unreadable deployment can never
  strip it. The refusal on a genuine contradiction is the same one, shared rather than copied.

## [0.35.2] — 2026-08-09

A deploy asks the deployment what it already has, instead of deciding from silence.

### Fixed
- **A re-deploy no longer turns off a capability the deployment had.** View tracking resolved from a
  flag, then `.pagevault.json`, then — non-interactively — `false`. Production rebuilds its intent
  file in CI from a secret that never mentioned analytics, so every deploy re-decided "off" from
  silence — it was never on, and no deploy would ever have turned it on. What
  the **live Worker actually binds** is now in the precedence chain, so a deployment that has already
  answered the question keeps its answer. The one case that cannot be resolved by guessing — the
  intent file says off while the Worker says on — refuses and names both options rather than picking
  one. An unreadable deployment (a first deploy, a narrow token, a network blip) can never strip a
  binding. ([#187](../../issues/187))

### Added
- **`--analytics` / `--no-analytics` on `pagevault upgrade`**, and `PAGEVAULT_ANALYTICS=on|off` for
  runs with nobody to prompt. Turning view tracking on for a CI-deployed production previously meant
  hand-editing a base64'd secret, which in practice meant nobody ever did.
- **An `analytics` input on the production deploy workflow** — `unchanged`, `on`, or `off`.
  `unchanged` sets nothing and lets the fallback work, so flipping it to `on` once is permanent.

### Changed
- **Every deploy says where its view-tracking answer came from** — a flag, the intent file, the live
  Worker, or a default with nothing to go on. `off` printed with no provenance reads as a decision
  when it was a silence, which is what made the production incident invisible.

## [0.35.1] — 2026-08-09

A deployment that records nothing stops pretending it measured nothing.

### Fixed
- **A deployment that records nothing stops reporting zeros.** With no Analytics Engine binding, the
  Worker records no views — but every surface reported as though it had measured and found none:
  `views: 0` on every document, a successful sync of nothing, and zero days of history at risk. A
  deployment that *cannot* measure looked identical to one nobody had visited, and the staleness
  alarm called it healthy. `statsFor` already refused to collapse "no sync yet", "published since
  the sync" and "measured, never opened"; it was missing the fourth answer. ([#185](../../issues/185))
- **`pagevault health` says when view tracking is off**, and names what turns it on. Previously the
  only place it appeared was one line of a deploy log.
- **Stored history survives the binding being removed.** Turning tracking off does not make what was
  already measured untrue — it stops it accruing.

### Changed
- **The scheduled view sync runs in its own `ops` environment**, not `production`. `production`
  carries a required-reviewer gate — right for deploys, fatal for a nightly job that would sit
  waiting for an approval nobody is awake to give. It also lets the sync hold a strictly narrower
  credential: a Cloudflare token scoped to `Account Analytics · Read` and nothing else, under its own
  secret name so it can never be confused with the deploy token. ([#186](../../issues/186))

## [0.35.0] — 2026-08-08

The sync becomes its own command, and production finally has somewhere to run it.

### Added
- **`pagevault sync-views`** — the write half of `views`, promoted from a flag to its own command.
  They do different kinds of thing: `views` looks at a 90-day window, `sync-views` rescues that
  window before it ages out permanently. As `views --sync` the consequential act looked like an
  option on the harmless one, and it did not read correctly in a crontab — which matters now that a
  schedule is what keeps history alive. Symmetric with `sync-access`. ([#166](../../issues/166))
- **A scheduled GitHub Action that syncs production daily.** Production is deployed by CI and its
  Cloudflare credential is deliberately not on a laptop (#38), so there was nowhere the sync could
  correctly run — the cross-deployment guard refuses it from a checkout naming a different
  deployment. Maintainer tooling; a fork can delete it and nothing breaks.

### Changed
- **`views --sync` still works** and prints a note pointing at the new name. Kept rather than cut:
  it is in the docs, in muscle memory and possibly in a crontab, and a scheduled sync that starts
  failing silently is the exact failure ADR-023 §9 exists to prevent.

### Fixed
- **`views --sync` stops advising against the thing 0.34.0 tells you to do.** The help text said
  *"there is no cron, deliberately"*, which reads as advice against scheduling. It was describing
  why the **Worker** cannot self-sync — its Analytics Engine binding is write-only, so it cannot
  read its own metrics at any cadence — which is a fact about the Worker, not a recommendation. An
  operator-side schedule is encouraged, and since 0.33.0 it is what keeps history from ageing out
  uncovered. Left as it was, `pagevault health` warned you to sync while `views --help` implied you
  should not bother. Corrected in the help text, the CLI reference and the architecture doc.
  ([#166](../../issues/166))

## [0.34.0] — 2026-08-07

The quiet way to lose view history now says something first.

### Added
- **`pagevault health` says when view history is about to become unrecoverable.** Views reach
  Analytics Engine on their own, but only a sync makes them durable — and Analytics Engine is a
  90-day conveyor belt that nothing but the operator takes boxes off. Missing that window used to
  be silent: nothing errored, nothing looked wrong, and the data was simply never there later.
  ([#165](../../issues/165), [ADR-023](docs/adr/ADR-023-the-summary-is-the-history.md) §9)
- It alarms on **risk, not age**. "Synced 40 days ago" is a fact about the past that leaves you to
  do the arithmetic; *"71 days of view history become unrecoverable in 20 days"* is the one that
  tells you whether to act today. A deployment that has never synced says so, rather than reporting
  zero days at risk — which would read as "up to date" at the moment it is least true.
- The warning is loud but **never fatal**: prod CI gates deploys on `health`'s exit code, and a
  deployment that is up with an unsynced summary is still up.
- `views --sync` now closes by naming the invariant it just satisfied, so the next miss is a lapse
  rather than a surprise.

## [0.33.0] — 2026-08-07

View counts stop going down. The summary is the history now, not a snapshot of a window.

### Changed
- **View counts stop going down.** The stored summary was re-derived from a rolling 90-day query on
  every sync, so a document opened 43 times in January reported `views: 3` by June — and
  `viewsSyncedAt` moved forward, making the number look *fresher* at the moment it became less true.
  The summary is now the durable history and Analytics Engine is a 90-day feed into it: each sync
  adds the window it could see and never removes what an earlier one contributed.
  ([#161](../../issues/161), [ADR-023](docs/adr/ADR-023-the-summary-is-the-history.md) §1–4, §7)
- **Views are stored per day, sparsely.** A day with no views is absent rather than zero, and so is
  a surface. Days past 90 compact to monthly. That is what makes a trend possible without a
  database, and it bounds the one KV value the whole feature lives in.
- **The Worker merges; the CLI no longer replaces.** `POST /api/views/summary` is read-modify-write.
  The payload declares the window it covers, that window is authoritative deployment-wide, and
  buckets outside it are untouched — so a `--sync --days 7` from a second machine cannot clobber
  three months it never measured.
- **A document's history outlives the document.** Revoking one no longer erases its traffic. Ids the
  deployment never created are still skipped, because the dataset is account-level (#129).
- **Your own views are counted apart from the client's**, computed on your machine from an address
  that never reaches the Worker — and left absent rather than guessed where that address is unknown.

### Added
- **`pagevault views --sync --reset`** — discard the stored history and rebuild from the current
  window. The one destructive path, and it asks for the deployment URL first. Append-only with no
  way out is how a bad history becomes permanent.

### Upgrade notes
- A summary stored by an earlier version is **discarded on first read** rather than migrated: it
  held lifetime totals with no dates, and there is no honest place to put those on a timeline. Run
  `pagevault views --sync` once and the last 90 days come back correctly dated.
- `viewsWindowDays` in `/api/docs` is replaced by `viewsCoverage: { from, to }`. The counts are no
  longer "the last N days", so a day count could only mislead about what they include.

## [0.32.2] — 2026-08-07

The end of a recovery names a command you can actually type.

### Fixed
- **`upgrade` no longer ends a recovery by naming a command an installed operator cannot run.** With
  a backup file in the directory, it printed `Next: make restore FILE=…` — but an `npm install -g`
  has no Makefile, so the one instruction offered at the end of the flow was the one that could not
  be followed. It now says `pagevault restore <file>`, which is also the CLI's real calling
  convention: the file is positional, and `FILE=` is make's. The line directly above it had switched
  correctly on the same condition all along. ([#178](../../issues/178))

## [0.32.1] — 2026-08-07

The deployment listing stops disagreeing with `status` about the same deployment.

### Fixed
- **`pagevault deployments` reports `PROVISIONED` correctly, and reports it the same from every
  directory.** It read `no` for a deployment whose build record was sitting in a checkout on this
  machine — while `status`, from that same checkout, correctly reported the tier, account and host.
  Two commands disagreeing about one deployment is the split ADR-021 exists to remove. The registry
  entry now records **where** its build record is and the check follows that path, reading `rung`
  and `accountId` fresh rather than copying them. Delete or move the checkout, or point it at a
  different deployment, and the answer returns to `no` — which is by then the true one.
  ([#170](../../issues/170))
- **A build record in the current directory that no deployment has recorded now says so**, and names
  the command that records it. That was the confusing half of the bug: provisioning commands worked
  from a directory the listing said they could not.

## [0.32.0] — 2026-08-07

Views can now answer where the traffic came from, and portal landings stop being invisible.

### Added
- **`views` answers where the traffic came from, not just who opened what.** A view now records the
  **host** that linked to it — `linkedin.com`, `mail.google.com`, or `direct` — and `pagevault views`
  reports them under the table. Only the host is ever written: the path, query and fragment are
  discarded before the record exists, because a linking page's path is someone else's private
  context and a query string carrying a token is free to collect and permanent to regret.
  ([#160](../../issues/160), [ADR-023](docs/adr/ADR-023-the-summary-is-the-history.md) §5)
- **Portal landings are counted.** Someone opening a collection page and reading nothing used to be
  invisible — `/pub/{slug}` and `/v/{slug}` were the one route that recorded nothing at all. They
  now appear as `(portal index)` rows, totalled separately from document views so they cannot
  inflate "did the client open the report". They record **no viewer on any surface**, including
  `/v/` where Access has established one. (§6)
- **Automated previews are counted, and the CLI says so.** A LinkedIn preview, a Slack unfurl and a
  mail-client preload all fetch the page. Public numbers read high as a result — named now rather
  than discovered later as a bug report.

### Changed
- **[ADR-023](docs/adr/ADR-023-the-summary-is-the-history.md) is Accepted.** It supersedes ADR-015
  §5: view data stops being a rolling window that a nine-month engagement outlives. This release
  builds §5, §6 and §8; the durable summary itself lands in [#161](../../issues/161).

## [0.31.2] — 2026-08-07

The command that tells you which deployment you are on now does so from both directions.

### Fixed
- **`status` names the deployment on both of its branches.** It branches on whether this machine
  holds the build record, and only the not-provisioned half ever said which deployment it was
  looking at — so the deployment we know *most* about, the one whose `.pagevault.json` is sitting
  right there, was the one that never named itself. Both halves now lead with the deployment and how
  it resolved, and `protected` is stated there too rather than only at the moment it refuses a
  command. A single-deployment install is unchanged. ([#170](../../issues/170))

## [0.31.1] — 2026-08-06

Deploying one deployment stopped moving another one's credential. Found by using 0.31.0, an hour
after shipping it.

### Fixed
- **An installed `pagevault upgrade` overwrote the login config with the deployment it just
  deployed.** Upgrading a test deployment repointed `~/.pagevault/config.json` at it, even though
  the operator's default was production. Correct when one machine held one deployment; wrong the
  moment 0.31.0 let it hold two — and where production's bearer lived only in that file, the
  credential was destroyed rather than shadowed.

  The rule that should have applied already existed in `login --as`: claim the default only when
  nothing else has, and never take it from a login describing a different deployment. It is now
  shared by both. When the registry already knows the deployment, its bearer is refreshed on **its**
  entry and the global default is not touched at all; when the deployment is unknown and something
  else holds the default, the deploy says so rather than moving it silently.

  A single-deployment install is unchanged, including with no registry: you deploy the deployment
  you are logged into, the URLs match, the default is claimed exactly as before.
  ([#171](../../issues/171))

- **`wrangler.generated.jsonc` could be committed.** In the repo it lands under `worker/` and is
  ignored; an installed `upgrade` run from inside a checkout writes it to the state dir, which is
  the checkout root, where that rule does not reach. It carries account and namespace ids. Now
  ignored by bare name. ([#171](../../issues/171))

### Changed
- **CI can be triggered by hand.** The Actions incident of 2026-08-06 throttled webhooks to ~15%, so
  a PR and its merge to main both landed with no run created and no way to ask for one. `ci.yml`
  now takes `workflow_dispatch` with an optional ref, the way `deploy-prod.yml` always has.

## [0.31.0] — 2026-08-06

One machine, several deployments — and a command can no longer act on one while telling you it
acted on another.

### Added
- **Named deployments — one machine can hold several, and each carries its own bearer.**
  `~/.pagevault/deployments.json` (mode 600) records a url + bearer per name.
  `pagevault login --as <name>` registers one, `pagevault deployments` lists everything this
  machine can reach, and `pagevault use <name>` picks the default. Any command takes
  `--deployment <name>`, and `PAGEVAULT_DEPLOYMENT` works for direnv and CI.

  Standing in a checkout still selects that checkout's deployment, the way `git` and `npm` find
  theirs — so the guardrail costs no discipline. Every command prints which one it chose and why,
  on stderr, so `pagevault publish report.html | pbcopy` still carries only the URL.

  `CLOUDFLARE_API_TOKEN` is deliberately **not** in the registry: it stays in per-clone
  `.env.local`, because that placement is what keeps the credential that can destroy
  infrastructure off the laptop entirely. ([#159](../../issues/159), ADR-021 phase 3)

- **A deployment can be marked protected**, with `pagevault login --as prod --protected`
  (`--no-protected` clears it). On one, `rm`, `revoke` and `rotate` require an explicit `--yes`.
  Publishing, editing and sharing are untouched — a confirmation on the operation you perform most
  gets answered reflexively within a day. A refusal rather than a prompt, so it means the same
  thing in a terminal and in a script. Re-running `login --as` on a deployment already registered
  amends that entry, so a flag can be flipped without retyping a bearer.
  ([#159](../../issues/159))

- **ADR-023 — the summary is the history.** Design work for the view-tracking model: the stored
  summary accumulates rather than being replaced from a rolling 90-day query, so a document's count
  can no longer go *down* between syncs while its timestamp looks fresher. Proposed; no code yet.
  ([#150](../../issues/150))

### Fixed
- **Document commands acted on a different deployment than `status` reported.** Standing in a
  checkout, `status` named the deployment that checkout provisioned while `list`, `publish` and
  `rm` went to whatever `pagevault login` last saved — production, on the machine this was found
  on. Same directory, same invocation, two deployments.

  The resolver added in 0.29.x was correct; the document commands never consulted it, because
  `config.json` holds exactly one url + token pair and a second deployment's bearer had nowhere to
  live. They now resolve the deployment and its credential together, from one place.

  A checkout's `.pagevault.json` is matched into the registry **by URL**, so nothing in a working
  tree is rewritten and the `.pagevault.json` CI restores from a secret keeps working untouched.
  Where no entry matches, the refusal from 0.29.1 stands — the registry supplies a correct
  credential, it never loosens the rule against sending the wrong one. ([#159](../../issues/159))

- **`deploy` no longer claims the CLI points somewhere else when it doesn't.** After a deploy from
  a checkout it warned that "document commands still point at a different deployment", comparing
  against `config.json` alone. They resolve the nearest marker first, so they point at what was
  just built — the claim was false. What is actually missing is the bearer, and that is now what it
  says, with `login --as` as the fix. ([#159](../../issues/159))

- **`deploy` recognizes a machine whose logins live only in the registry.** It told such a machine
  to run `init` — which would provision production from a laptop, the hazard
  [#144](../../issues/144) was filed for. It now looks for any reachable deployment, named or not.
  ([#159](../../issues/159))

## [0.30.0] — 2026-08-06

The first five minutes of a Windows install, fixed. Found by running one.

### Fixed
- **The "save your Cloudflare token" instruction named a file the CLI does not read.** It said
  ``echo 'CLOUDFLARE_API_TOKEN=<paste>' > .env.local`` — a path relative to wherever the operator
  was standing — while the loader read `stateDir()/.env.local`, which on an install is
  `~/.pagevault/.env.local`. Those match only by luck. Follow the instruction from any other
  directory and the token is written somewhere nothing reads, `init` reports no token, and the
  message repeats the instruction that just failed. Nothing named a directory, so there was no
  thread to pull.

  It now prints the resolved path. From a repo checkout that is still the bare `.env.local` it has
  always been, because there the state dir *is* the cwd. ([#157](../../issues/157))

- **On Windows the same line wrote a file that could not be read back.** `>` in Windows PowerShell
  5.1 — the default shell on a stock Windows box — redirects as UTF-16LE, which the env parser
  cannot parse. The token was saved, looked perfect in Notepad, and produced "no token". Windows now
  gets `Set-Content … -Encoding ascii`, which is correct on both 5.1 and 7. Found standing up 0.29.1
  on a clean Windows 11 machine. ([#157](../../issues/157))

### Added
- **`pagevault init --cf-token <token>`** — hand the Cloudflare credential straight to `init`, for
  a machine where pasting into the terminal is awkward or there is no TTY at all. It is persisted
  like a pasted one, so the commands after `init` do not each need it repeated.

  Named `--cf-token`, not `--token`: `login --token` already means the PageVault *bearer*, and one
  flag name for two different credentials on adjacent commands is how a broad provisioning token
  ends up saved in a login config. ([#157](../../issues/157))

- **`init` reports which credential it is using** — `--cf-token`, the environment, or the path to
  the `.env.local` it read. An exported `CLOUDFLARE_API_TOKEN` silently beats a `.env.local`, and
  the two can name different accounts; the loser used to be invisible. ([#157](../../issues/157))

## [0.29.1] — 2026-08-06

A credential could reach a deployment it did not belong to. It cannot now.

### Fixed
- **The state directory follows the deployment, so a credential can no longer be sent to the wrong
  one.** ADR-021 phase 2 gave every operator command one rule for *which URL* it targets and left
  `stateDir()` reading `~/.pagevault` regardless of where the operator stood — so half the answer
  moved and half did not. `verify` took the URL from a checkout's `.pagevault.json` and the bearer
  from `~/.pagevault/config.json`, and **sent production's token to the test deployment**. The 401 it
  came back with was luck: had the two shared a bearer it would have authenticated against the wrong
  deployment and run a write round-trip there.

  `stateDir()` now resolves from the same marker that resolves the URL, so `.env.local`,
  `.pagevault.json` and the bearer all describe one deployment. A login's token is refused outright
  when the login describes a different deployment than the one resolved — no bearer is a better
  answer than the wrong bearer. `PAGEVAULT_HOME` still wins outright; it is what isolates the test
  suites. ([#155](../../issues/155))

- **`status` and `health` no longer disagree about the same deployment.** From one directory,
  `health` said "expecting <build> — matches the shipped build" while `status` said "not provisioned
  from this machine": health branched on the resolver, status on `loadContext()`. Both now branch on
  the resolver. ([#155](../../issues/155))

- **`health` finds a bearer it already has.** It read only `.env.local` and reported "No
  PAGEVAULT_API_TOKEN — skipped the /mcp reachability check" while a usable bearer sat in the login
  config — the one `verify` picked up seconds later against the same deployment.
  ([#155](../../issues/155))

- **`upgrade` and `deploy` stop telling a client-only install to run `init`.** On a machine whose
  production is deployed by CI, that is the one command that would deploy production from a laptop.
  It now says the install holds a login rather than a build record, and points at the checkout that
  owns the deployment. ([#144](../../issues/144), [#155](../../issues/155))

## [0.29.0] — 2026-08-06

The deployment you are acting on, said out loud — and a PDF that matches the page.

### Fixed
- **PDF export renders what the viewer renders.** The renderer aborted every network request, so a
  document using a remote image, a webfont, a CDN stylesheet or CDN JavaScript looked right in the
  viewer and exported with holes — including the seed corpus's Chart.js document, which exists to
  prove remote JavaScript runs (ADR-007) and exported an empty box. Reported as a missing image;
  it was the PDF and the viewer disagreeing about the same document.

  Interception is now an allowlist: `image`, `font`, `stylesheet` and `script` may load; `xhr`,
  `fetch`, `websocket` and `eventsource` may not. **Rendering is permitted, conversation is not** —
  a script can draw a chart, it cannot open a channel that carries a reply. https only, never the
  deployment's own host, and a hard request cap. Anything refused or failed is named in a
  `pdf_assets_blocked` log line and counted in an `X-PageVault-Assets-Blocked` header, because a
  PDF with holes and no explanation was the actual complaint.
  ([ADR-022](docs/adr/ADR-022-the-pdf-is-a-capture-of-the-viewer.md), [#147](../../issues/147))

- **A link that does not resolve now serves a real page instead of the word "Not found".** A client
  following a link to an owner-only draft — or to a revoked document, a rotated `/p/` token, or a
  renamed URL past its forwarding year — got unstyled plain text. The 404 itself was correct and
  stays: a 403 for "exists but not yours" would let anyone map a deployment one guessed URL at a
  time. What changes is that the page now looks like the rest of the product **and says the answer
  is deliberately the same either way**, so a legitimate visitor does not conclude the document was
  deleted when they were simply never given it. Pinned by tests asserting the responses are
  byte-identical, because "make this error more helpful" is precisely the instinct that would turn
  the page back into an oracle. ([#148](../../issues/148))

- **The Public-tier `/v/` page stopped talking about "rungs".** It told document recipients that
  portals are "a rung-3 feature" and that "this deployment is running at rung 1" — internal
  vocabulary, on a page whose own copy addresses someone who was sent a link and has never heard of
  PageVault. It now says Public and Secured, which is what ADR-018 made the user-facing tiers, and a
  test fails the build if the word returns. ([#149](../../issues/149))

### Changed
- **Every operator command resolves the same way, and says which deployment it chose.**
  `--url` → `PAGEVAULT_URL` → the nearest `.pagevault.json` walking up from the working directory →
  the login config. Standing anywhere in a checkout acts on what that checkout provisioned;
  standing anywhere else acts on the login. `make` and `pagevault` now agree, which they did not:
  `RUNNING_FROM_REPO` keys on where the *code* lives, so a globally installed `pagevault` run inside
  a checkout targeted production while `node cli/bin/pagevault.mjs` in the same directory targeted
  test. `PAGEVAULT_HOME` still overrides everything, exclusively — it is what isolates the test
  suites. ([ADR-021](docs/adr/ADR-021-a-deployment-is-a-named-thing.md), [#144](../../issues/144))

### Fixed
- **A client-only install is a state, not an error.** An install with a login and no build record —
  what an operator has when production is deployed by CI — reported itself broken and pointed at
  `pagevault init`, the one command that would deploy production from a laptop. Now: `status` names
  the deployment and says it was not provisioned here; `health` reports the running version instead
  of failing because it does not match this install's; `verify` runs, and **infers the tier from the
  deployment** rather than defaulting to Public — which previously turned a perfectly healthy
  Secured deployment into a false failure, because root 302s to `/admin` and the check expected 200.
  ([#144](../../issues/144))

- **`pagevault views` named the wrong door and hid the right one.** Its error said
  "run `make setup` (or `pagevault init`)" — `make` does not exist in an installed package, and
  `init` is actively wrong for a deployment someone else deploys. `--account` has always existed and
  appeared in no help text, which left that case with no answer at all. Both fixed.
  ([#144](../../issues/144))

- **`VERSION` was read relative to the working directory.** `readFileSync("package.json")` assumed
  cwd was the repo root — true when everything ran from `make` at the top level, false from `worker/`
  or `cli/`, where it silently became `0.0.0` and `health` then asserted `0.0.0+<sha>` against the
  deployment and failed for a reason that had nothing to do with the deployment. Now resolved from
  the module. Latent before; running from a subdirectory is normal under ADR-021.
- **A cross-deployment sync is refused instead of silently performed.** `sync-access` and
  `views --sync` are the only commands that read `.pagevault.json` and write through
  `config.json`, so they are the only two that can act across deployments — and on a machine that
  operates a CI-deployed production instance from a repo checkout, those two files routinely name
  different deployments. `views --sync` in that position queried one deployment's Analytics Engine
  and wrote the summary to another, where no document id matches: a near-empty summary that makes
  every document report a **measured zero** views over MCP. That is the same lie `syncViews`
  already refuses when it rejects `--portal`. Both commands now stop and name both deployments.
  ([#145](../../issues/145))

- **`pagevault verify` no longer prints a green verdict over failed checks.** "✓ Deployment
  verified." was emitted mid-run, before the MCP and publish sections had executed — so a run whose
  root 404'd and whose `tools/list` returned nothing printed it anyway, then failed. The exit code
  and `--json` were correct throughout; only the sentence a human reads was wrong, which is the one
  that gets believed. The verdict is now computed inside `finish()`, from the same value that sets
  the exit code, and printed last. Counted failures render `✗` rather than sharing `!` with
  advisory notes. ([#146](../../issues/146))

### Documentation
- **[ADR-021](docs/adr/ADR-021-a-deployment-is-a-named-thing.md) — a deployment is a named thing,
  selected by where you stand.** Two files describe a deployment and both independently answered
  "which one am I acting on", so four commands gave four different answers. The #38 credential
  model — the prod Cloudflare token never lives on your laptop — still holds for everything needing
  Cloudflare access, but it never covered the *bearer*, and the bearer is what the document surface
  uses. The ADR makes a deployment a named record, selected by an explicit flag, the environment,
  the nearest project marker, or the current default. The guard above is explicitly interim: the
  ADR removes the ambiguity rather than detecting it.

## [0.28.0] — 2026-08-04

The npm package is the product, and it did not install on Windows.

### Fixed
- **`pagevault init` failed on every Windows machine.** The prebuilt Worker's absolute path is
  written into the generated wrangler config, and it was spliced in as a raw string. On Windows
  that path is `C:\Users\…\npm\node_modules\…`, where `\U` is an invalid JSON escape and `\n` is a
  newline — so the config did not parse, and the error named neither Windows nor the path. The path
  is now escaped as a JSON string literal. ([#139](../../issues/139))

- **A space anywhere in the home path broke the deploy.** The `--config` argument was interpolated
  into a shell command unquoted, so `C:\Users\First Last\…` reached wrangler as
  `--config C:\Users\First`. Not Windows-only: a macOS home under `~/My Drive/…` failed identically. The
  command is now built by `deployCommand()`, which quotes it — and which exists as a separate
  function so the quoting is asserted by a test instead of a live deploy. ([#139](../../issues/139))

- **`pagevault verify` gave WSL users advice that clears the wrong cache.** WSL looks like Linux,
  but it resolves through the Windows host — so a stale `NXDOMAIN` is cached on the Windows side and
  `resolvectl flush-caches` inside the distro does nothing. Verify now detects WSL and says
  `ipconfig.exe /flushdns`, with a line explaining why. This is the destroy → rebuild path, which is
  where `verify` earns its keep. ([#123](../../issues/123), [#139](../../issues/139))

### Changed
- **Color is dropped when nothing is watching.** ANSI escapes were emitted unconditionally, which
  littered redirected output and rendered as raw garbage in legacy Windows conhost. Color is now off
  when neither stdout nor stderr is a terminal, `NO_COLOR` forces it off, and `FORCE_COLOR` forces it
  on. It keys on *either* stream because `pagevault publish report.html | pbcopy` pipes stdout while
  a human still reads stderr. ([#139](../../issues/139))

- **CI runs on Windows.** A `windows-latest` job runs the CLI test suites and the pack-and-install
  smoke test. It deliberately does not run the Worker suite — that would test Cloudflare's workerd
  port, not this package — and it cannot cover provisioning, which needs a real Cloudflare account.
  That gap is closed by hand: [`docs/engineering/windows-smoke-test.md`](docs/engineering/windows-smoke-test.md).

### Documentation
- **Which operating systems are supported is now written down.** It appeared nowhere before. Added
  to [prerequisites](docs/setup/prerequisites.md#which-operating-system), the README's "You need"
  line, the [CLI reference](docs/setup/cli-reference.md), and the
  [AI-guided setup](docs/setup/ai-guided-setup.md) — including the PowerShell 5.1 trap, where
  `echo … > .env.local` writes UTF-16, PageVault reads UTF-8, and the token is invisible while the
  file looks correct.
- `export --zip` is documented as leaving the folder uncompressed on Windows, which is what it has
  always done — there is no `zip` command there. It degrades on purpose; now it says so in advance.

## [0.27.0] — 2026-07-30

You could publish a document. You could not fix its name.

### Added
- **Edit a published document** — filename, title, summary and tags — from the console, the CLI
  (`pagevault edit <id>`), and MCP (`edit_document`). Found by dogfooding: a document was uploaded
  through the console with a typo in its filename, and there was no way to correct it anywhere.
  The console did not even *display* the filename, so the identity field was invisible as well as
  uncorrectable. ([#140](../../issues/140))

  A document's id is derived from its filename (ADR-017), so **renaming moves the document to a
  new URL** — that is not a choice, it is the same fact stated twice. So a rename now leaves a
  forwarding address: the old URL redirects for a year, and any `/p/` public link keeps working
  completely unchanged, because its token was never derived from the id. Changing only the title,
  summary, tags — or only the *case* of a filename — moves nothing.
  ([ADR-020](docs/adr/ADR-020-rename-leaves-a-forwarding-address.md))

  Renaming onto a filename another document already holds is refused outright, with no override.
  Publish has `--confirm` for replacing a document; rename deliberately does not, because
  finishing a correction by destroying a different client deliverable is never what was meant.

- **The console explains the fields instead of just exposing them.** Info popovers on Filename and
  Tags — native `popover`, so the toggle is an attribute and there is no script for the nonced CSP
  to block. The filename panel covers what "identity" actually costs you: renaming moves the URL,
  the old one redirects, the `/p/` link is unaffected, case does not count but the extension does.
  The tags panel leads with *tags are for you, not the client* and gives conventions worth copying
  (`type:report`, `phase:discovery`, `q3`).

  Field limits are shown, and they are **interpolated from the server constants** rather than
  retyped — a hint saying "max 300" while the server enforces something else gets believed. Counters
  stay silent until a field is 75% used. Tag count and tag length are checked before the request so
  the answer is specific; and when the shared 1024-byte KV index budget blows, the dialog now says
  which field to shorten and stays open, instead of forwarding "too long to index" and leaving you
  to poke at boxes.

- **The console shows a document's summary and tags at all,** in a details block alongside the
  filename. None of the three were displayed before.

- **`pagevault verify` now exercises the rename live.** Its MCP round-trip is
  `publish → rename → read → revoke`, and the rename leg asserts the document's id actually
  *moved* — a same-id "rename" would mean the move silently degraded to a metadata write, which is
  the one failure the rest of the round-trip passes straight through. Both filenames are unique per
  run: `edit_document` refuses a name already in use, so a stable rename target would let one
  crashed run block every future verify with `name_taken`.

### Changed
- **The portal header is one row, not a right-hand column.** Base access, Open, Copy link and Edit
  stacked vertically, which set the card's height and left a band of empty space beside the portal
  name.

### Notes
- **Stable Google-Drive-style GUIDs were considered and rejected**, and ADR-020 records why so it
  does not get re-litigated. Decoupling the id from the filename requires a `filename → id` lookup
  at publish time; KV caches *misses* at the edge, so a second publish of the same filename inside
  the window would likely hit a cached miss and fork the document — #74 verbatim, the exact bug
  deterministic ids exist to prevent. Drive can do this because it sits on a strongly consistent
  metadata store; PageVault runs on KV on purpose.

## [0.26.0] — 2026-07-29

The portal could always tell you what you sent. Now it can tell you what got opened.

### Added
- **View metrics over MCP.** "Which of the fourteen things I sent Acme did they actually open?"
  now has an answer in the place you are already talking about that client. `list_documents` and
  `read_document` report `views`, `lastViewedAt`, and which door readers came through — so an
  agent can say *they never opened the migration plan* while you are drafting the call agenda,
  instead of you remembering to check a terminal. ([#127](../../issues/127))

  The Worker still cannot read Analytics Engine, and that has not been softened. Reading it needs
  an account-scoped `Account Analytics Read` token — one that can read analytics for **every**
  Worker on the account, not just this one — and ADR-015 decision 6 keeps it off the Worker.
  Instead `pagevault views --sync` runs the query on your machine, aggregates it, and pushes a
  summary into one KV key. The Worker gains data, never the capability to compute it
  ([ADR-019](docs/adr/ADR-019-view-metrics-reach-mcp-by-sync.md)).

- **`pagevault views --sync`.** One KV write, whole-deployment, 90-day window by default — the
  table still defaults to 30, but "have they *ever* opened it" is a lifetime question and
  Analytics Engine keeps about three months. Documents that no longer exist are dropped and
  counted; the dataset outlives the deployment that wrote it, so a rebuild leaves rows pointing at
  ids that no longer resolve.

  `--portal` and `--doc` are **refused** with `--sync`. A summary covering one client would claim
  to cover the deployment, and every document outside it would then report a *measured* zero — a
  lie in the one direction that matters.

  No cron, deliberately: coupling a publish to an analytics query means an Analytics Engine outage
  makes publishing hang.

  The same fields ride through `pagevault list --json` and `read --json`, so the terminal is not a
  lesser surface than an agent. The human table is unchanged — `pagevault views` already reports
  this in more detail, with identities.

### Notes
- **Counts and surfaces reach an agent; identities never do.** The underlying records carry viewer
  emails for Access-authenticated reads. The summary carries none. "Opened four times through the
  public link, never by a signed-in member" is useful and identifies nobody; putting *who* within
  reach of an LLM is a decision to make on its own merits, not one to inherit from a metrics
  feature.
- **Absent is not zero.** No sync, or a document published since the last one, omits the fields
  entirely. A present `views: 0` means the document was in the measured window and nobody opened
  it — which is the whole value. Every response carries `viewsSyncedAt`, and both tool
  descriptions say the numbers come from the last sync, so a model reports "as of Tuesday" rather
  than implying it just looked.
- `views` stops being a whole-command exception to CLI/MCP parity and becomes a difference in
  *kind*: the CLI keeps identities and arbitrary windows, MCP gets counts as of the last sync.

## [0.25.0] — 2026-07-28

Two things the console could see and did not say.

### Added
- **Access seat usage in the console.** At the free plan's 50 seats Cloudflare **blocks new
  logins** — silently, with no seat-limit notification at any tier, so the first sign is a client
  saying your report will not open. The sidebar now carries `Access seats N of 50`, muted until it
  reaches the ceiling and red once it does. No cron, no webhook, no alert: PageVault is
  single-operator, so the person who would get the alert is the person already looking at the
  console when something breaks. ([#44](../../issues/44))

  It needed no new credential. The count reads from `access_seat: true` on Cloudflare's Access
  users endpoint, which the Worker's *existing* narrow runtime token can already see — verified
  against the live API before it was written. Had it needed an account-wide token it would have
  gone in the CLI instead, next to `views` (ADR-015).

  The ceiling is an **assumption**, and says so: reading your real plan needs billing scope the
  Worker deliberately does not hold, so 50 is always labelled as the free plan's allowance. And if
  the count cannot be read, the console shows nothing rather than zero — a seat readout saying `0`
  because it could not ask would read as plenty of room at exactly the moment logins are blocked.

### Fixed
- **The console forgot which portal you were on.** The selection lived only in a JS variable, so
  every reload dropped you back on the default portal and a portal view could not be bookmarked or
  linked. It is now in the URL fragment, restored on boot ahead of the default fallback, and
  written with `replaceState` so Back still leaves the console rather than walking backwards
  through portals. ([#92](../../issues/92))
- **The console went stale after a publish made anywhere else.** A document published from the CLI,
  from an agent, or in another tab left an open console showing the old list indefinitely. Coming
  back to the tab now re-reads the current portal.

  Bounded deliberately, because "refresh whenever the tab is focused" is a poll wearing a disguise
  and the house rule is that the console must not poll the KV list quota: a 30-second staleness
  window so rapid tab-switching is free, a per-page-load ceiling so a pathological day still cannot
  spend the quota, and the cheap single-portal read rather than the full portal tree. The document
  header also now says when the list was last read, instead of leaving you to assume.

### Tooling
- **`make check-console`** — a new build check, in CI, for a blind spot in the type checker. The
  Worker builds its UI as HTML inside TypeScript template literals, so roughly 45KB of browser
  JavaScript is *string content* to `tsc`: a stray backtick, a bad escape, or an unbalanced brace
  type-checks clean and ships a blank page. It extracts every inline `<script>` the Worker emits —
  the console, the viewer shell, the portal page — evaluates the template, and parses the result.

  Written after a backtick inside a comment inside `page()` silently terminated the template. The
  gap is measured, not assumed: an unbalanced brace introduced into the console passes `pnpm
  typecheck` with exit 0 and all 25 console tests, and this catches it. It also refuses to pass on
  an implausibly small extraction, because an earlier version of it reported success having parsed
  279 characters of the wrong script.

## [0.24.0] — 2026-07-28

Three places where the CLI knew something and did not say it. Backup and restore existed but only
behind `make`, so the operator most likely to need them — the one who installed PageVault and holds
real client documents — could not reach them. `<command> --help` printed the whole manual and left
you to find your command in it. And `status` reported saved intent in the voice of observed fact.

### Added
- **`pagevault backup` and `pagevault restore`.** Same-host disaster recovery is now part of the
  installed product, not a repo convenience. `backup` snapshots the whole KV namespace — documents,
  portals, members, public-link tokens — to one JSON file; `restore` replays it, keys preserved
  byte-for-byte, so document ids and every `/p/` link you have already shared survive. The engine
  moved from `scripts/` into `cli/lib/ops/`, alongside `status`/`verify`/`health`/`destroy`, and
  `make backup` / `make restore` now run that same code through the other front door.
  ([#133](../../issues/133))
- **`pagevault <command> --help`** prints that command's own flags and what the non-obvious ones do
  — `--name` is the update key, `--confirm` replaces in place, `--yes` makes `init` non-interactive
  and therefore requires a bearer to already exist. `pagevault help <command>` is the same thing.
  Reaching for `<cmd> --help` is the first thing anyone does when a command misbehaves, and it is
  the moment they are least able to skim a wall of text. ([#126](../../issues/126))

### Changed
- **`pagevault status` no longer reads like a report from the deployment.** It describes
  `.pagevault.json` — the answers you gave `init` — and nothing in it asks the Worker whether they
  are still true. During a fresh-machine run a Worker was accidentally redeployed with Access
  unconfigured and `status` went on printing `Tier Secured` throughout; the same blind spot printed
  a KV namespace and a URL that a teardown had already removed. It now says what it is, and points
  at `health` for what is actually running. `--json` carries `"source": "local"`, because an agent
  consuming it has no tone to read. ([#130](../../issues/130), [#118](../../issues/118))
- A command's usage line and its `--help` are now one constant, so the guard cannot drift from the
  documentation of the thing it is guarding.

### Notes
- **`status --check` was considered and rejected.** `pagevault health` already fetches `/health` and
  compares it to the build you shipped; a second front door onto the same question is how the two
  start disagreeing. `status` stays local, instant, and offline — it just stops implying otherwise.

## [0.23.2] — 2026-07-28

Three things that were true about PageVault and that nothing in PageVault said out loud. All three
concern what survives a teardown or a rotation — the moments when an operator most needs the tool to
be complete about what it did and did not do.

### Fixed
- **`destroy` did not disclose that view records survive it.** It prints a "left alone,
  deliberately" list — Zero Trust, Access seats — and omitted the one item holding a third party's
  personal data. Analytics Engine keeps three months of view records, and for anything read through
  Cloudflare Access those records name the **viewer's email**. Someone winding down a client
  engagement reads that list and reasonably concludes the rest is gone; for three months they are
  wrong. Cloudflare documents a three-month retention and **no way to delete a dataset**, so waiting
  out the window is the whole of the honest answer, and `destroy` now says so.
  ([#128](../../issues/128))
- **That disclosure block only printed on Secured deployments.** A Public deployment printed nothing
  at all, while still recording a view for every `/p/` and `/pub/` read. It now prints at every
  tier, with the Zero Trust items still conditional.
- **`destroy` now says it only deletes what local state names.** A KV namespace left by an older
  PageVault under a different title is orphaned, not removed.

### Changed
- **`pagevault views` says that its dataset outlives the deployment.** The dataset is account-level
  and no record names the deployment that wrote it, so after a teardown and rebuild `views` shows
  history the current deployment never created. A one-line footer says so and points at
  `pagevault list` to tell them apart. Deliberately unconditional: the tempting version — warn only
  when the queried window predates the deployment — fires on every routine `upgrade`, because
  `upgrade` redeploys. ([#129](../../issues/129))

### Documentation
- **A runbook for rotating `PAGEVAULT_API_TOKEN`**, in `docs/engineering/deploy-prod.md`. The bearer
  is static — no session, no expiry, no refresh — so rotating it breaks every client holding the old
  one at once, with no error that says "rotated". It reads exactly like a session that will not
  renew, which is how it was misdiagnosed once. The runbook names the step people forget: the
  claude.ai web connector, which holds a token you cannot grep for. It also states the wider blast
  radius, which was not previously written down anywhere: the console session key and the viewer
  capability key both derive from that token, so open console sessions and in-flight `?cap=` render
  tokens are invalidated too. `/p/` links and OAuth-connected MCP clients survive.
  ([#64](../../issues/64))
- The same disclosures reached `docs/setup/backup-and-restore.md` (a new "what leaving does not
  remove"), `docs/setup/cli-reference.md`, `docs/architecture.md` §12, and two new entries under
  CLAUDE.md's gotchas.

## [0.23.1] — 2026-07-28

Two checks in this release could not fail, and both were believed because of it. `restore` refused
on "is the namespace empty?" — a question whose answer says nothing about what a restore would
destroy — and `verify` asserted nine MCP tools against a Worker that registers twelve. The docs had
drifted the same way, so the checks that catch it are now a build step rather than an audit.

### Fixed
- **`restore` asked the wrong question.** It probed ten keys and refused if any came back, so a
  namespace holding one throwaway sample document got the same flat "not empty" as one holding a
  live client portal — with `--force` as the only visible way out, offered at the exact moment an
  operator is least able to reason about overwrite semantics. A restore is a bulk PUT that deletes
  nothing, so the keys that matter are the ones the backup does *not* replace: those survive and
  mix into the restored deployment. It now computes that set and names it by document title. Three
  outcomes replace the old two — nothing surviving runs with no flag at all, a lone `verify` sample
  is identified as such, and anything else is listed before you decide. The refusal also spelled
  the flag `--force` while `make restore` takes `FORCE=1`. ([#125](../../issues/125))
- **`verify` checked nine MCP tools while the Worker registered twelve.** `EXPECTED_MCP_TOOLS` had
  drifted, so a deployment missing `revoke_public_link`, `rotate_public_link` or `server_info`
  verified clean. A check that cannot fail is worse than no check, because it gets believed. The
  constant now matches, and a test reads `worker/src/mcp.ts` to keep the two from drifting again.

### Changed
- **The deploy suggests a restore when it finds a backup beside it.** `verify` publishes a sample
  document, which is what turned the documented recovery order into a refusal; it now says so
  before it writes, and `docs/setup/backup-and-restore.md` gained a recovery runbook ordered so it
  works when followed literally.

### Documentation
- **Corrected the launch surfaces to what actually shipped.** The README's "Not yet" list still
  disowned PDF export, raw download, browser upload and export/backup/restore; the published field
  guide scored PageVault 40 on accountability and said it had "no per-view receipts" months after
  view records shipped; the feature tour advertised a Deploy-to-Cloudflare button and a seat-count
  alert, neither of which exists. Both showcase documents were republished.
- **`architecture.md` caught up with the tier reframe.** It gained the two-tier model
  ([ADR-018](docs/adr/ADR-018-public-and-secured-tiers.md)), `DocMeta.name` as document identity
  ([ADR-017](docs/adr/ADR-017-document-identity-is-the-filename.md)), MCP Resources
  ([ADR-016](docs/adr/ADR-016-documents-as-mcp-resources.md)), and `/health`. It had described
  OAuth 2.1 as a pre-launch task long after it shipped, claimed publishing returns a diff (it
  names the document and refuses), and given the wrong KV listing prefix.

## [0.23.0] — 2026-07-28

0.22.0 was the first release to be installed from npm on a machine that had never seen PageVault, and
driven through a full lifecycle by hand. The install path is the product ([ADR-014](docs/adr/ADR-014-installed-product-not-thin-client.md)),
and it turned out to be the least-exercised code in the repo. Everything below is what that found.

### Fixed
- **`init --yes` left a live, unusable deployment.** The bearer decision ran *after* the deploy, so a
  non-interactive first install — which is what `--yes` is on a fresh machine — put a Worker on the
  internet and then refused to finish it. Without `PAGEVAULT_API_TOKEN` every `/api` call 401s and
  `list` reports "Not configured", and the advice offered was to re-run the command that had just
  failed. The question is now asked before anything is built, so the answer is identical and nothing
  is created; the message says so and gives the escape it previously buried in an error.
- **`verify` reported success it had not earned.** Two ways. It passed while skipping the MCP surface,
  the write path, and authentication entirely — and it read the bearer only from `.env.local`, never
  the CLI's login config, so the documented install path always skipped. Separately, a check could
  record a failure, print a warning, and still let the run finish green, which is how a Secured
  deployment quietly serving a Tier-0 config went unnoticed. The verdict is now derived from what was
  actually recorded, and an absent bearer fails rather than passes.
- **The tier prompt was ambiguous and unconfirmed.** `Public or Secured? [public]` gave no syntax to
  copy; it is numbered now, with both tiers described where you choose between them. Setup then says
  back what it understood — on the one decision that turns Zero Trust, and a card, on.
- **`not_configured` on an Access-group sync said nothing useful.** On Public it is expected; on
  Secured it means the grant landed in KV and the person still cannot open anything. It now says
  which, and points at `verify`.

### Added
- **A "Powered by PageVault" mark** on client-facing pages — the viewer's control row and the portal
  footer, pointing at the product page. Never above the fold, never beside your client's own title.
  `"branding": false` in `.pagevault.json` removes it entirely.
- **`make test-e2e` covers `verify`** for the first time, against a real Worker. Six tests, including
  the tier-drift case that had shipped twice.

### Changed
- **The setup docs were wrong, not merely stale.** The agent runbook still taught the three tiers
  [ADR-018](docs/adr/ADR-018-public-and-secured-tiers.md) retired, and told the reader that tier 2
  meant "only named people should open it." That tier is *Public on your own domain* — no access
  control at all. Anyone following it would have assured someone their client documents were gated
  while they were readable by whoever held the URL. Rewritten, with the failure mode named: a domain
  changes the address, not who can read.
- The CLI reference regained the commands it had lost track of — `link`, `portals`, `portal-create`,
  `share --remove`, `init`'s flags, and `CF_RUNTIME_TOKEN`. Coverage is verified rather than
  eyeballed: every command has an entry, and no entry names a command that does not exist.
- [**ADR-019**](docs/adr/ADR-019-view-metrics-reach-mcp-by-sync.md) records how view metrics can reach
  MCP without handing the Worker an account-scoped analytics token, which
  [ADR-015](docs/adr/ADR-015-what-a-view-record-contains.md) refuses for good reason.

## [0.22.0] — 2026-07-26

Everything here came out of one exercise: building an end-to-end test for the CLI, then running the
full install lifecycle — Public → Public+domain → Secured, from a teardown — against a real
Cloudflare account. The harness is the addition; the rest is what it caught.

### Added
- **Portal commands for the CLI.** `pagevault portals [--json]` lists them, `pagevault portal-create
  <slug> [--name] [--kind] [--description]` opens one, and `pagevault share <portal> --remove a@b`
  revokes. The MCP server could already do all three, so a terminal-only operator was stuck on the
  default portal and — worse — could grant a client access to every document in a portal with no way
  to take it back. Revocation names its own limit: KV stops authorizing immediately, but Cloudflare
  Access keeps admitting the person, and charging a seat, until `sync-access --reap` reconciles
  (ADR-002).
- **`make test-e2e`** — the CLI driven against a real Worker (`wrangler dev` + Miniflare KV), on a
  free port with throwaway state, so it cannot reach a deployment. It covers the seam the unit tests
  never could: HTTP shapes, the stdout/stderr split, and exit codes. What it deliberately cannot
  catch is written into the file — Miniflare's KV is strongly consistent and production's is not.
- **`make seed`** publishes a realistic document set to a live deployment *through the CLI*, so
  populating a deployment is itself coverage of the binary you are about to ship.

### Changed
- **One palette, one place.** The Worker's remaining HTML surfaces — the root landing, the console
  403, the honest 404 and misconfigured pages, the viewer chrome, and the OAuth consent screen a
  claude.ai user sees when connecting to the MCP server — moved to the console's neutral +
  signal-blue system. They had kept the retired amber identity, and three had no dark mode at all.
  The landing page was the clearest symptom: the browser tab drew the current blue mark while the
  page body drew the retired amber aperture, on one page load. Tokens now live in
  `worker/src/theme.ts`, and `make check-palette` keeps them there.
- **Setup says what a tier climb actually changes.** Documents carry across untouched, which was
  already true and is now verified — but the hostname moves, so links already shared stop resolving,
  and documents published while Public keep their public links once Access is on. Both are correct;
  neither was said out loud. Setup warns before a host move, and a Secured deploy reports what still
  opens with no login. Nothing is revoked automatically: killing a URL a client already holds is the
  mirror image of the widening ADR-002 forbids.

### Fixed
- **`destroy` pointed at the wrong rebuild command.** At rung 3 it suggested `make provision`, which
  creates the KV namespaces, Access apps and group, then stops — leaving Access apps in front of no
  Worker and no secrets. It now says `make deploy`, which is rung-aware and complete at every rung.
- **`destroy` left dead state behind at rung 3.** The cleanup was guarded on `tier < 3` and deferred
  to a file current provisioning no longer writes, so on a Secured deployment it did nothing:
  `.pagevault.json` went on naming a deleted KV namespace, a dead URL, two dead Access audiences and
  a deleted group, and `status` reported a deployment that no longer existed. The strip is now
  unconditional and keeps only the operator's intent, so a rebuild still works from what is left.
- **`verify` blamed TLS provisioning for a stale DNS cache.** Tearing down and rebuilding the same
  hostname leaves the local resolver holding the old answer, which looks identical to a route that
  has not come up — and waiting, the advice given, never fixes it. `verify` now resolves through both
  the system resolver and a public one, and names the difference with the flush command. It also
  recognises a deployment that was torn down rather than one still provisioning.
- **`init` from a repo checkout could leave the CLI pointed at a previous deployment.** A login
  config left by an earlier install silently won, so `pagevault publish` would write somewhere else
  entirely. It now names both when they differ.

## [0.21.0] — 2026-07-24

### Changed
- **Two user-facing tiers — Public and Secured ([ADR-018](docs/adr/ADR-018-public-and-secured-tiers.md)).**
  `init` asks "Public or Secured?" instead of "rung 1 · 2 · 3": Public offers an optional domain
  (suggesting the account's zones), Secured requires a domain and Zero Trust. The internal `rung`
  (1/2/3) is retained as an implementation detail — the deploy/provision machinery is unchanged.
  `status`, the deploy/provision banners, and `verify` all speak tiers now; `--tier public|secured`
  is the preferred flag, `--rung 1|2|3` stays as the non-interactive escape. The README and product
  page are reframed to match (three tier-card images dropped for a feature table; "running a
  practice" becomes a use of Secured, not a third tier).

### Added
- **`pagevault link <id>`** — print a document's shareable URL to stdout, pipeable (`| pbcopy`).
  `GET /api/docs/{id}` now returns `url` (the viewer URL, built with the portal's kind) and
  `publicUrl` (the `/p/` link when the document has one); `read` gains a `link` line.
- **`init` suggests the account's domains** at the hostname prompt — the sole domain as a default,
  or a numbered pick when there are several.

### Fixed
- **`verify`'s "route isn't serving" message is tier-aware.** On a custom domain it now blames
  edge-certificate provisioning (a few minutes on a fresh hostname) rather than workers.dev
  propagation, so a just-deployed domain no longer reads as a broken deploy.

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

[Unreleased]: https://github.com/danjamk/pagevault/compare/v0.36.0...HEAD
[0.36.0]: https://github.com/danjamk/pagevault/compare/v0.35.4...v0.36.0
[0.35.4]: https://github.com/danjamk/pagevault/compare/v0.35.3...v0.35.4
[0.35.3]: https://github.com/danjamk/pagevault/compare/v0.35.2...v0.35.3
[0.35.2]: https://github.com/danjamk/pagevault/compare/v0.35.1...v0.35.2
[0.35.1]: https://github.com/danjamk/pagevault/compare/v0.35.0...v0.35.1
[0.35.0]: https://github.com/danjamk/pagevault/compare/v0.34.0...v0.35.0
[0.34.0]: https://github.com/danjamk/pagevault/compare/v0.33.0...v0.34.0
[0.33.0]: https://github.com/danjamk/pagevault/compare/v0.32.2...v0.33.0
[0.32.2]: https://github.com/danjamk/pagevault/compare/v0.32.1...v0.32.2
[0.32.1]: https://github.com/danjamk/pagevault/compare/v0.32.0...v0.32.1
[0.32.0]: https://github.com/danjamk/pagevault/compare/v0.31.2...v0.32.0
[0.31.2]: https://github.com/danjamk/pagevault/compare/v0.31.1...v0.31.2
[0.31.1]: https://github.com/danjamk/pagevault/compare/v0.31.0...v0.31.1
[0.31.0]: https://github.com/danjamk/pagevault/compare/v0.30.0...v0.31.0
[0.30.0]: https://github.com/danjamk/pagevault/compare/v0.29.1...v0.30.0
[0.29.1]: https://github.com/danjamk/pagevault/compare/v0.29.0...v0.29.1
[0.29.0]: https://github.com/danjamk/pagevault/compare/v0.28.0...v0.29.0
[0.28.0]: https://github.com/danjamk/pagevault/compare/v0.27.0...v0.28.0
[0.27.0]: https://github.com/danjamk/pagevault/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/danjamk/pagevault/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/danjamk/pagevault/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/danjamk/pagevault/compare/v0.23.2...v0.24.0
[0.23.2]: https://github.com/danjamk/pagevault/compare/v0.23.1...v0.23.2
[0.23.1]: https://github.com/danjamk/pagevault/compare/v0.23.0...v0.23.1
[0.23.0]: https://github.com/danjamk/pagevault/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/danjamk/pagevault/compare/v0.21.0...v0.22.0
[0.2.0]: https://github.com/danjamk/pagevault/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/danjamk/pagevault/releases/tag/v0.1.0

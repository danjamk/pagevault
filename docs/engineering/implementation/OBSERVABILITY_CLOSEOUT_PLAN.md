# Observability close-out plan

Status: proposed · 2026-08-09 · targets 0.36.x

Closes the view-tracking arc: #190, #168, #162, #164, #163, #166, #173. Ends with
one aggregation engine, three surfaces reading it, and a deployment that can be
scheduled to keep its own history.

## Where this starts

The data layer is done. #160 instrumented the view record, #161 gave the summary
day buckets and a Worker-side merge, #165 added the staleness warning, and
#185/#186/#187 fixed what a year of not-quite-right recording had hidden.
ADR-019, ADR-023 and ADR-024 hold the decisions.

So `views:summary` in KV now carries, per document, sparse daily buckets with a
surface split, an owner/member split, and a last-view time — plus a coverage
window and referrer hosts per portal.

What remains is presentation and plumbing, not measurement.

## The decision that shapes the rest

**The summary is the default read. Analytics Engine is the opt-in.**

Everything the three presentation issues want to answer — by document, by portal,
by day, by referrer, totals, surface splits — is already in the summary. A live
Analytics Engine query adds exactly two things: viewer identities, and freshness
since the last sync.

Today that is inverted. `views` queries Analytics Engine, which needs a
Cloudflare `Account Analytics Read` credential and an account id, so the common
case pays for the rare one. An operator running a deployment they did not
provision has no such credential and gets nothing, even though the data they want
is sitting in a KV namespace their bearer token already reads.

Inverting it:

```
pagevault views                # the summary. no Cloudflare credential
pagevault views --by day       # a daily series
pagevault views --live --who   # Analytics Engine. identities, current to the second
pagevault sync-views           # the write that rescues history before it ages out
```

`--who` implies `--live`, because identities exist nowhere else (ADR-019
decision 4).

**And `--sync` splits out.** #150 opened on the observation that `views` and
`views --sync` "read as one command with a flag; they behave like two different
things with different prerequisites." ADR-023 sharpened it: `views` is a
read, `views --sync` is the write that rescues data before Analytics Engine's
90-day retention takes it permanently. A flag makes the consequential act look
optional. `sync-access` is the precedent — an operator command that reconciles
against an external system on a schedule — and `pagevault sync-views` reads
correctly in a crontab, which is where it belongs after ADR-023.

The cost is a user-facing break on an installed command. It gets its own issue
and its own deprecation window; it is not absorbed into #166.

This wants an ADR — call it ADR-025, *the summary is the default read* — written
before the code, because it decides #162, #166 and #168 together.

### What `--live` keeps

`--live` keeps today's output: one row per document, surface, viewer and kind,
plus the referrer query. The new `--by` breakdowns land on the summary path only.
That is a scope boundary, not an oversight — `--live` answers *did this person
open it*, the summary answers *how much traffic, from where, and is it going up*.
`queryBuckets` already exists, so `--live --by day` is available later if anyone
wants it.

## Phase 0 — fix the first run, settle the shape

Independent of everything below. Ships on its own.

- [ ] **#190 — rung 1 and 2 bind Analytics Engine unconditionally.** Confirm the
      premise against a real fresh account first; whether Analytics Engine is off
      by default is what makes this a broken first deploy rather than untidiness.
      Then `writeTier0Config` resolves view tracking the way rung 3 does, and the
      10089 hint names a command that exists at the rung the operator is on.
      This is a stranger's `pagevault init`, so it outranks presentation work.
- [ ] **ADR-025** — the decision above.
- [ ] **A new issue for the command split** — `views --sync` → `sync-views`, with
      the deprecation path. Blocks the `--sync` half of #166.

## Phase 1 — one rollup, three surfaces

### The rollup

A new `worker/src/rollup.ts`: pure functions over a `ViewSummary`, no Worker
dependencies, returning totals, `byDoc`, `byPortal`, `byDay` and `byReferrer` for
a requested window, alongside `coverage`, `syncedAt` and the `syncRisk` verdict.
`worker/src/views.ts` is already past 600 lines and this is a separate concern.

**The API computes the rollup; it does not ship the raw summary for clients to
aggregate themselves.** The CLI is `.mjs` with no build step and cannot import
the Worker's TypeScript, so a client-side rollup would be a second implementation
of the same aggregation against a versioned shape — the exact drift the blob-position
comment in `cli/lib/views.mjs` exists to warn about. Instead the console and MCP
call `rollup()` in-process, the CLI asks the API for the same shape over HTTP, and
`cli/lib/views.mjs` stays a formatter.

- [ ] `rollup.ts` with unit tests over a fixture summary, including the cases
      `statsFor` already distinguishes: never synced, published since the sync,
      measured and never opened, and not recording at all.

### The surfaces

- [ ] **#168 — the credential-free read.** `GET /api/views/summary`, owner-scoped
      like the rest of `/api`, taking the breakdown and window as query
      parameters. The route is POST-only today and 405s on anything else. Include
      a raw form for backup, kept distinct from the rolled-up form.
- [ ] **#162 — `pagevault views` reports traffic.** `--by doc|portal|day|referrer`
      defaulting to `doc`; identity out of the default grouping so a document is
      one row with one number; real per-portal and deployment totals; portal-index
      traffic as its own line; the account-level-dataset caveat stays in the
      footer. `make views` reaches the same flags.
- [ ] **#164 — the console traffic panel.** Deployment total, by portal, a daily
      sparkline, top referrers. Reads `views:summary` through the owner session —
      no Cloudflare credential reaches the console and the Worker still never
      reads Analytics Engine (ADR-019 decision 1). Sync *status*, not a sync
      button: the console cannot perform a sync, so it shows when the summary
      last synced, how much history is at risk, and the exact command, copyable.
      No "paste your Cloudflare token" flow — considered and refused in the issue,
      and the ADR-025 work does not change that.
- [ ] **#163 — the MCP traffic tool.** A window, an optional portal or document,
      a breakdown by day, surface or referrer. `canView()` gates it like
      everything else, with no exception for "just metadata" (prime directive 5).
      Counts and surfaces, never identities. Staleness in the prose as well as
      `structuredContent`, following the existing `viewLine` / `syncedAtOf`
      pattern, so a host that renders only text still sees "as of".

Order: #168 and the rollup first, then #162, then #164, then #163. The console
goes before MCP because it has no alternative — Analytics Engine has no dashboard,
is absent from the GraphQL API, and therefore cannot feed Cloudflare's Custom
Dashboards either. MCP's questions are answerable from the CLI in the meantime.

## Phase 2 — the operating model

- [ ] **#166**, minus the command-shape decision now settled above and minus the
      rename now living in its own issue. What is left: `make views` parity with
      the CLI flags; rewriting the "there is no cron, deliberately" wording, which
      reads as advice against scheduling when it actually describes why the
      *Worker* cannot sync itself; documenting the cadence and the 90-day
      invariant; and a short scheduling page in `docs/setup/` covering launchd,
      cron/systemd, and a scheduled GitHub Action with one working snippet each.

## Phase 3 — the landing page

- [ ] **#173 — measure traffic to the public landing page.** Unrelated machinery:
      a Cloudflare Web Analytics beacon on `docs/index.html`, served by GitHub
      Pages. Shares nothing with `pagevault views` but the vendor name, and the
      docs should say which dashboard answers which question so nobody looks for
      landing-page numbers in `pagevault views`. Also settles the Pages build
      reporting `errored` while serving correctly.

## Neighbouring issues this moves

- **#167** shrinks. Its analytics half is #168; what remains is the capability
  boundary — which commands need which credential — as a table in `docs/setup/`.
  Re-scope it after phase 1 rather than treating it as full size.
- **#31** returns to Backlog. It has been In progress with nothing in flight, and
  a lane that does not mean anything is worse than an empty one.

## After this track

Safety and parity gaps, in order:

1. **#176** — `protected` cannot reach `upgrade`, because document commands
   resolve the deployment through the registry and `upgrade` resolves it through
   the build record. The one command that replaces running code cannot see the
   flag that says be careful with this deployment. Latent only while production
   is CI-deployed.
2. **#180** — no surface can delete a portal, though `DELETE /api/portals/{slug}`
   is implemented and tested. Carries one real decision: whether MCP gets it at
   all, given it deletes a client boundary and, with cascade, everything in it.

Then #142 (pin documents), #138 (subdomain docs plus the multi-label-TLD zone
lookup bug), #95 (live MCP acceptance), #31.
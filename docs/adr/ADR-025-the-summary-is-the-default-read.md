# ADR-025 — The summary is the default read; Analytics Engine is the opt-in

**Status:** Proposed
**Date:** 2026-08-09
**Extends:** ADR-023 (the summary is the history) · ADR-019 decisions 1, 4 (the Worker never reads Analytics Engine; counts and surfaces, never identities)
**Governs:** #168, #162, #164, #163

## Context

ADR-023 made `views:summary` the durable history: each `sync-views` adds the window it could see,
and what it added stays. The summary now carries, per document, sparse daily buckets with a surface
split, an owner/member split and a last-view time, plus a coverage window and referrer hosts per
portal.

It is read by almost nothing.

`pagevault views` still queries Analytics Engine live on every invocation. The summary is written by
`sync-views`, read by `list_documents` and `read_document` for a per-document ride-along, and
otherwise ignored. So the richest thing the deployment holds about its own traffic is the one thing
no surface presents.

Three open issues want to present it — #162 (CLI breakdowns), #164 (console panel), #163 (MCP tool)
— and a fourth, #168, exists only because the live query needs a credential the summary does not.
Before any of them is built, one question decides all four: **what does `views` read?**

### What each source can actually answer

| | Summary | Analytics Engine, live |
|---|---|---|
| Per-document, per-portal, deployment totals | yes | yes |
| Daily series, trend | yes | yes (`queryBuckets` exists) |
| Referrer hosts | yes, per portal | yes |
| Surface split, owner vs member | yes | yes |
| **Viewer identities** | **never** (ADR-019 §4) | yes |
| **Views since the last sync** | **no** | yes |
| History older than 90 days | yes (ADR-023) | **no** |
| Credential needed | the deployment bearer | Cloudflare `Account Analytics Read` + account id |

The summary wins on every row but two, and loses decisively on nothing — it is the *only* source
for history past 90 days.

### Why the current default is the wrong way round

**It charges the common case for the rare one.** Every `views` invocation demands an account-scoped
Cloudflare credential so that the two columns only Analytics Engine can fill are always available,
whether or not anyone wanted them.

**It locks out the operator who did not provision the deployment.** Production is deployed by CI and
operated from a client-only install; that machine holds a deployment bearer and no Cloudflare token.
It gets no analytics at all — while the data sits in a KV namespace the bearer already reads on
every other command. #168 was filed to add `--cached` for exactly this, which is the same
observation arriving as a workaround instead of a default.

**It would force the rollup to be written twice.** #162, #163 and #164 all want by-doc, by-portal,
by-day and by-referrer. Answered from the summary that is one aggregation over one shape. Answered
from live rows for the CLI and the summary for the other two, it is two — over a versioned structure,
in two languages, in a codebase whose own comment warns that the blob positions have no schema
registry and nothing stops the two copies drifting.

**And it misreports what the numbers are.** A live query returns the last 90 days and calls it the
answer. Since ADR-023 the honest answer for "how much traffic has this had" is the accumulated
history, which is longer. The default source is the one that structurally cannot give it.

## Decision

**1. `pagevault views` reads the stored summary by default.**

No Cloudflare credential, no account id, no `Account Analytics Read` permission. The deployment
bearer that every other document command uses is enough, because the summary is a KV value that
bearer already reaches.

This makes #168's `--cached` unnecessary as a flag: it becomes the behaviour. #168 reduces to its
other half — `GET /api/views/summary`, which is POST-only today and 405s on anything else.

**2. `--live` is the opt-in, and it is the narrow path.**

`pagevault views --live` queries Analytics Engine as today, and needs the credential as today. It
answers the two questions the summary cannot: who opened it, and what happened since the last sync.

`--who` implies `--live`, because identities exist nowhere else (ADR-019 §4). Asking for identities
from the summary is not a degraded answer, it is an impossible one, and the flag combination should
say so rather than print an empty column.

`--live` and `--cached`-style flags are not both offered. There is one default and one opt-in.

**3. `--live` keeps today's output. The new breakdowns are summary-only.**

`--live` stays the one-row-per-(document, surface, viewer, kind) table plus the referrer query.
`--by doc|portal|day|referrer` lands on the summary path only.

That is a boundary, not an omission: `--live` answers *did this person open it*, the summary answers
*how much traffic, from where, and is it going up*. `queryBuckets` already exists, so `--live --by
day` is available later if anyone asks. Nobody has.

**4. The rollup is computed in the Worker, once, and every surface reads that one.**

A pure `rollup()` over a `ViewSummary` returning totals, `byDoc`, `byPortal`, `byDay`, `byReferrer`
for a requested window, alongside `coverage`, `syncedAt` and the `syncRisk` verdict.

The console and MCP call it in-process. The CLI asks `GET /api/views/summary` for the same shape
over HTTP. The CLI is zero-dependency `.mjs` with no build step and cannot import the Worker's
TypeScript, so a client-side rollup would be a second implementation of the same aggregation over a
versioned structure — which is decision 3's argument again, one layer down.

`cli/lib/views.mjs` stays a formatter and a live-query client. It does not grow an aggregation
engine.

**5. Every surface states which source it read and how stale it is.**

The summary path prints the coverage window and `syncedAt`; `--live` says it is current and says it
is 90 days. A number whose provenance is unstated is the failure mode ADR-024 was written about, one
domain over.

**6. The Worker still never reads Analytics Engine.**

ADR-019 decision 1 is untouched and this ADR does not narrow the distance to it. The Worker reads a
KV value the operator put there. Nothing here gives the Worker, the console or MCP a Cloudflare
analytics credential, and decision 4 does not become an argument for one later — the console panel
in #164 already refuses that on its own terms.

## Alternatives considered

**Keep the live query as the default; add `--cached` as a flag (#168 as written).** No user-facing
change, which is its whole appeal. Rejected because it leaves the two-shape problem in place: the
CLI reports from live rows, the console and MCP from the summary, and the same four breakdowns get
implemented against both. It also leaves the credential-less operator on a flag they have to know
exists, to reach the data that should have been the default answer.

**Query live and fall back to the summary when no credential is present.** Rejected as the worst of
both. The same command would return different numbers on different machines with no user-visible
cause — one reading 90 days, one reading accumulated history — and the fallback would fire on a
network blip too. A default that silently changes source is not a default, it is a race.

**Merge the two: summary as the base, live for the tail since the last sync.** Genuinely tempting,
and correct in principle. Rejected for now on cost and honesty: it needs a credential to be useful,
so it cannot be the default; and reconciling a partially-counted day against a stored whole-day
bucket is exactly the mid-day-boundary problem ADR-023 solved by aligning the sync's query to
midnight. Re-opening it for a live overlay would put the bug back. Available later as `--live` on
top of the summary if the staleness gap ever hurts.

**Make MCP and the console query the summary while `views` stays live.** That is today, and it is
the thing being fixed. It puts the operator's own tool on the poorer source.

## Consequences

- **`views` works with no Cloudflare credential.** The client-only install operating a CI-deployed
  production gets analytics, which is #167's read half.
- **`views` becomes a portal-aware read of the deployment**, so it obeys the same bearer and the same
  `/api` surface as everything else. One less credential in the common path.
- **The default numbers get longer, not shorter.** Post-ADR-023 history exceeds 90 days, and the
  default answer starts including it. The footer's account-level-dataset caveat still holds and
  still belongs.
- **`views` on a deployment that has never synced shows nothing**, and must say *"no history captured
  yet — run `pagevault sync-views`"* rather than an empty table, which reads as "nobody opened
  anything". `statsFor` already distinguishes the four states; the CLI has to as well.
- **The identity column leaves the default output.** It is behind `--who`, which implies `--live`.
  That is a visible change for an operator used to seeing addresses, and the help has to name it.
- **A stale summary now degrades the operator's own view, not just MCP's.** The staleness warning
  (#165) stops being an MCP concern and becomes a first-class part of `views` output.
- **One rollup, four consumers.** #162, #163, #164 and #168 stop being four presentations of two
  shapes and become four presentations of one.

## References

- [ADR-019](ADR-019-view-metrics-reach-mcp-by-sync.md) — decisions 1 and 4, which this leaves intact
- [ADR-023](ADR-023-the-summary-is-the-history.md) — the summary this now reads by default
- [ADR-024](ADR-024-the-deployment-is-authoritative-about-what-it-has.md) — stating provenance
- `worker/src/views.ts` — `ViewSummary`, `statsFor`, `syncRisk`
- `worker/src/api.ts` — the POST-only `/api/views/summary`
- `cli/lib/views.mjs` — `queryViews`, `queryBuckets`, `formatViews`
- #162, #163, #164, #167, #168
- `docs/engineering/implementation/OBSERVABILITY_CLOSEOUT_PLAN.md`

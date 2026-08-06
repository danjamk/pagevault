# ADR-023 — The summary is the history; Analytics Engine is only the last 90 days

**Status:** Proposed
**Date:** 2026-08-06
**Supersedes:** ADR-015 decision 5 (analytics is a rolling window, not a history)
**Extends:** ADR-015 decisions 1, 4, 7 (what a view record contains) · ADR-019 decision 3 (one key, one write)
**Closes:** #150

## Context

View tracking was built to answer one question, and it answers it: *did the client open the
migration plan before the call?* ADR-019 carried that answer to MCP without giving the Worker an
analytics token.

The product is being asked a second question that the same records could answer and the same
machinery cannot: **how much traffic, where from, and is it going up?** Three kinds of document
live in one deployment — published to be found, delivered to a named client, and one-off shares —
and two of those three generate traffic questions rather than did-they-read-it questions.

Four things are missing, and one of them is a defect rather than a gap.

### The gaps

- **There is no time dimension anywhere.** Not in the SQL, not in the table, not in the stored
  summary. For "did they open it," one lifetime count is enough. For traffic, the shape over time
  *is* the datum. The current output structurally cannot express it.
- **There is no rollup.** The query groups by `(portal, doc, title, surface, viewer)`, so one
  document is many rows and `VIEWS` is a per-row number. Per-portal and deployment totals have to
  be assembled by hand.
- **The referrer is never read.** ADR-015 decision 4 bans IP and User-Agent. It is silent on the
  referrer, because nobody asked.
- **Portal index pages are not instrumented.** `portalIndex()` never calls `recordView`. Someone
  landing on a public portal and browsing it is invisible unless they open a document.

### The defect

`putViewSummary` replaces the key outright:

```ts
export const putViewSummary = (env: Env, summary: ViewSummary): Promise<void> =>
  env.PAGEVAULT.put(SUMMARY_KEY, JSON.stringify(summary));
```

Every sync re-derives from a rolling 90-day query. So the stored number is *"views in the last 90
days, as of Tuesday"* — and MCP presents it as a property of the document:

> `views: 43 (link 3, public 40) · last 2026-01-18, as of 2026-01-20`

Sync in January against a document opened 43 times; sync again in June, after those rows aged out
of Analytics Engine, and the same document reports `views: 3`. The count went **down**. Worse,
`viewsSyncedAt` moved forward, so the number looks *fresher* at the exact moment it became *less
true*.

Nobody made a mistake here. ADR-015 decision 5 was correct for a CLI table with "last 30 days" in
the footer — a window that announces itself. ADR-019 then stored the number and gave it to an agent
as a document field. The two decisions were right separately and wrong together, and the seam is
where the operator noticed it (#150).

Widening the query is not a repair. Analytics Engine retains about three months; that is the wall,
and no window setting gets past it.

## Decision

**1. The summary is the durable history. Analytics Engine is a 90-day feed into it.**

ADR-015 decision 5 said view data is a rolling window and a nine-month engagement outlives it. That
stops being true. `views:summary` accumulates: each sync contributes the window it could see, and
what it contributed stays. Analytics Engine becomes the *source* of recent history rather than the
*definition* of all history.

The direction of ADR-019 is unchanged — the operator reads, the Worker never gains the credential.
What changes is that the result the operator hands over is added to, not swapped for.

**2. Buckets, sparse, daily then monthly.**

The summary stores per-document counts bucketed by day, keyed by date, **sparse** — a day with no
views is absent, not a zero. Buckets older than 90 days are compacted to monthly on sync. Still one
KV key, still one write per sync (ADR-019 decision 3 holds).

Sparseness is what makes this fit. A dense 90-day series per document would be ~2.3 KB × every
document; in practice a document is opened on a handful of days and stores a handful of buckets.
The 1 MB ceiling and the refuse-rather-than-truncate behaviour in `parseViewSummary` stay exactly as
they are, and matter more now than they did.

**3. The Worker merges. A sync may add history; it may not remove it.**

`POST /api/views/summary` becomes read-modify-write inside the Worker. The payload declares the
window it covers, and that window is authoritative for the whole deployment:

> Drop every stored bucket whose date falls inside the posted coverage window, across all
> documents. Then merge in the payload's buckets. Buckets outside the window are untouched.

That rule is idempotent, correct under overlapping syncs, and correct whether or not a given
document appears in the payload. Two syncs from two machines with different windows are each
authoritative only for their own, and neither erases the other's.

The merge is in the Worker rather than the CLI because it makes history append-only *by
construction*. If the CLI merged, then a CLI at an old version, or a `--sync --days 7` from a second
machine, would clobber everything it did not measure. Trusting the client here is the posture
`parseViewSummary` already refuses to take — "it came from our own CLI" is not a validation
strategy, and an owner bearer is exactly what a leaked token is.

Read-modify-write on eventually-consistent KV is acceptable here for a specific reason, not by
oversight. Two syncs inside the ~60 s consistency window could both read the pre-merge value and the
second would win, losing the first's contribution. The next sync repairs it, because a 90-day query
re-derives every recent bucket from scratch. The operation is self-healing, which is the property
that makes it safe; nothing here depends on read-after-write.

There is one escape hatch, and it is named as destructive: `views --sync --reset` clears the key
before writing. Append-only with no way out is how a bad history becomes permanent.

**4. A document's history outlives the document.**

Today the sync drops rows for any id not in `/docs`, so revoking a document erases its traffic. That
reverses: **an entry already in the history is never deleted by a sync** — it is marked as no longer
published. Ids the deployment has never seen are still skipped, because the dataset is account-level
and outlives deployments (#129). The history lives in KV, which a teardown destroys, so a rebuilt
deployment cannot inherit the old one's documents by this path.

**5. The referrer host, never the referrer URL.**

A view records the host of the `Referer` header — `linkedin.com`, `mail.google.com`, `t.co`, or
empty for direct. The path, query and fragment are discarded before anything is written.

A linking page's *path* is someone else's private context: an internal wiki, a shared document, a
query string carrying a token. Writing it down permanently is the same failure ADR-015 decision 2
prevents for our own URLs, pointed at a third party instead. The host answers "where is traffic
coming from" and identifies nobody.

This costs less than it sounds: browsers default to `strict-origin-when-cross-origin`, so a
cross-origin navigation already sends the origin alone. Taking the host mostly normalizes what
arrives rather than discarding what does.

Referrers are aggregated at **portal** granularity, not per document per day. Host cardinality
multiplied by document multiplied by day is how one KV value stops fitting in one KV value.

**6. The portal index is a recorded event, and it carries no identity.**

`/pub/{slug}` and `/v/{slug}` landing views are recorded, so portal traffic is measurable without
inferring it from document opens.

These events record **no viewer on any surface** — including `/v/`, where Access has established
one. That is narrower than decision 1 of ADR-015 permits, deliberately. The question an index view
answers is *how much traffic*; "who landed on the portal page and did not open anything" is not a
question worth a permanent record of a person.

**7. Owner views are counted apart, and still never identified.**

Your own opens are noise in "did the client read it" and signal in "how much traffic." The sync
already sees the viewer address on `/v/` rows and drops it; it can bucket the row as owner or member
before dropping it. The address never reaches the Worker, so ADR-019 decision 4 is unchanged in
substance: counts and surfaces, never identities.

The split is computed where the identity already is — on the operator's machine. Where the owner's
address is not known there, the split is **absent, never guessed**. A wrong attribution is worse
than a missing one.

**8. The record schema is append-only.**

There is no schema registry. Analytics Engine will return whatever sits in `blob3` under whatever
name the query asks for, so blob positions are a contract between `recordView` and the CLI's
`SELECT` list and nothing enforces it. New fields therefore take **new positions**. Positions are
never reused, never reordered, and never repurposed. Rows written before a field existed read as
empty, and every reader must treat empty as "not recorded then" rather than as a value.

**9. A sync that has not run says so, before the loss and not after.**

Capture is automatic; promotion is not. Every view reaches Analytics Engine unprompted, but only a
sync moves it into the durable summary — so the operating invariant is **sync at least once every 90
days or lose the tail that aged out uncovered.** That is a quieter failure than the one this ADR
repairs: nothing errors, nothing looks wrong, and the data is simply never there later.

So staleness is surfaced wherever the summary is read — `status`, the console panel, and the MCP
tool — as a function of the retention horizon rather than a fixed threshold. Days old is a fact;
*days of history at risk* is the thing worth alarming on, and it is computable from `syncedAt`
alone.

This extends ADR-019 decision 6 from "say when the numbers are from" to "say when the numbers are
about to stop existing."

## Alternatives considered

**Keep the rolling window; fix only the presentation.** Say "views in the last 90 days" on every
surface and accept the horizon. Rejected. It makes *"has this ever been opened"* permanently
unanswerable, which is the question the feature was built for — and the presentation fix is itself a
downgrade, since MCP would report a shrinking number with an honest label and no explanation.

**Query further back.** Not available. Three months is Analytics Engine's retention, and no window
argument reaches past it. This is the constraint that forces a durable store somewhere.

**Per-document KV keys, or a counter incremented on the read path.** Rejected again, for the reasons
ADR-015 and ADR-019 decision 3 already gave: a hundred documents is a hundred writes, a document
that is read is a document that is written, and popularity would consume the budget publishing
needs. Nothing about this ADR changes that arithmetic.

**D1, or a Durable Object, for a real time series.** The honest right tool, and still rejected under
prime directive #7: a new binding and a new dependency for one feature. The trigger that reopens it
is specific — the summary no longer fitting in one KV value, or metrics needing to be live rather
than synced. Either is a new decision with a cost stated, not a config change.

**A Worker cron that syncs itself.** Still impossible, and the reason is worth restating because the
current help text obscures it: the Worker cannot read Analytics Engine at all, at any schedule. That
is decision 1 of ADR-019 and it is not what "there is no cron, deliberately" should have been read to
mean. **An operator-side schedule is encouraged**, daily is the sensible cadence, and one KV write a
day is nothing. Where that schedule lives is an operational question (#150), not a design one.

**Cloudflare Web Analytics.** It would give a real dashboard in the Cloudflare console with
referrers, paths and countries, for free. Rejected: it is a third-party beacon inside the trusted
shell, it needs holes in a CSP that exists to keep the shell clean (ADR-007), and it would report
`/p/{token}` capability URLs into a zone-level analytics product. The console panel PageVault serves
from `views:summary` costs no new credential and no new script.

**Record the full referrer URL, or IP, country, or User-Agent for traffic shape.** Rejected under
decision 5 and under ADR-015 decision 4, which is unchanged. Free at the point of collection,
permanent at the point of regret.

**Flag bot and unfurl traffic at write time.** Considered and **deferred**, not refused. A LinkedIn
preview, a Slack unfurl and a mail-client preload are all recorded as views today and will continue
to be. The detection would use the User-Agent to set a boolean without storing the User-Agent, which
stays inside decision 4 — the objection is scope, not privacy. Named here so the inflated public
numbers are a known property rather than a future bug report.

## Consequences

- **Public and capability-link counts read high**, because automated previews are counted. That is
  accepted for now, and it is the first thing to suspect when a public number looks implausible.
- **`views:summary` becomes the only durable record of traffic.** It lives in KV, so `backup` carries
  it and `destroy` ends it. A backup is now the difference between keeping and losing history, which
  is a change in what a backup is worth and needs saying in `docs/setup/`.
- **Restoring a backup is safe against the merge.** Restored buckets outside the next sync's window
  survive; buckets inside it are re-derived from Analytics Engine. A restore can resurrect old
  history without corrupting recent history.
- **A missed sync costs only the tail past 90 days**, not the whole picture. Cadence becomes a
  preference rather than a hazard, which is most of what made the current model uncomfortable to
  operate.
- **The summary grows over time.** Sparse buckets plus monthly compaction bound it, and the 1 MB
  refusal is the backstop. If a deployment ever hits it, that is the trigger to reconsider D1 — not
  a reason to start truncating.
- **ADR-019's parity exception narrows again.** MCP gains trend, portal rollups and referrers; the
  CLI keeps viewer identities and arbitrary windows. The difference stays one of kind.
- **`docs/architecture.md` is wrong until updated.** The analytics section describes a rolling window
  and a summary of totals; both change here.
- **The blob contract becomes load-bearing.** Decision 8 has to be honoured by anything that touches
  `recordView` or the CLI's `SELECT`, and there is no test that can catch a silent reorder — only a
  reviewer who knows the rule exists.

## References

- `worker/src/analytics.ts` — `recordView`, the write path
- `worker/src/views.ts` — `ViewSummary`, `statsFor`, `parseViewSummary`, `putViewSummary`
- `worker/src/viewer.ts` — `renderShell`, the one place all three surfaces meet
- `worker/src/portal.ts` — `portalIndex`, the uninstrumented landing page
- `cli/lib/views.mjs` — the SQL, `summarizeViews`, the table
- ADR-015 — what a view record contains; decision 5 is superseded here, 1/2/4/7 stand
- ADR-019 — metrics reach MCP by sync; decision 3 extended, 1/4/5/6 stand
- ADR-002 — blast radius; why the Worker still holds no analytics token
- #150 — raised as "the views model is not clear in use", which it was not
- #129 — the dataset outlives the deployment

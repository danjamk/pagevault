# ADR-019 — View metrics reach MCP by sync, not by a read token

**Status:** Accepted
**Date:** 2026-07-27
**Extends:** ADR-015 (what a view record contains), ADR-002 (seat bounding / blast radius)

## Context

The portal is memory, not an outbox. That is the argument for the whole product: six months into an
engagement, *"what did we decide about CDC on V2?"* is answerable from the portal over MCP, because
publishing and remembering are the same act (ADR-006).

There is a question of the same shape that the portal cannot currently answer:

> Which of the fourteen things I sent Acme did they actually open?

For a consultant that is not a vanity metric. It is *"they never opened the migration plan, so I
should walk them through it on the call"* — the kind of thing you want surfaced while you are already
in a conversation with an agent about that client, not in a terminal you have to remember to check.

`pagevault views` already answers it, and it is the one documented exception to CLI/MCP parity: the
CLI is a superset, and only for this. The obvious repair — an MCP tool that runs the same query —
requires the Worker to read Analytics Engine, and **ADR-015 decision 6 forbids exactly that**:

> The Analytics Engine binding is dataset-scoped and write-only. The SQL API needs an account-scoped
> `Account Analytics Read` token, which is a strictly wider credential than the Access-group-scoped
> `CF_API_TOKEN` the Worker holds today. Putting it in the Worker is the exact blast-radius widening
> ADR-002 exists to prevent.

That reasoning holds and this ADR does not weaken it. It is worth restating why, because the
difference is easy to wave away: `CF_API_TOKEN` can edit **one Access group**. `Account Analytics
Read` can read analytics for **the entire Cloudflare account** — every Worker on it, not only
PageVault. A compromised Worker would go from "can admit someone to a viewer group" to "can read all
of the operator's traffic data." The tokens are not comparable, and "the Worker already holds a
Cloudflare credential" is not an argument for handing it a wider one.

So the question is not *may the Worker read analytics* — it may not — but *how does the answer reach
MCP anyway*.

## Decision

**1. The Worker still never reads Analytics Engine.**

No `Account Analytics Read` token is added to the Worker, at any tier, for any feature. ADR-015
decision 6 stands unamended. If a future change appears to need it, that is a new decision with this
ADR to argue against, not a configuration detail.

**2. The operator's machine reads, and pushes a summary back.**

`pagevault views --sync` runs the query it already runs — from the operator's machine, with the
deployment token that legitimately holds `Account Analytics Read` — aggregates the result, and writes
it to KV through the existing bearer API. The direction of travel is unchanged from ADR-015: the
operator reads analytics, the Worker does not. The only new thing is that the operator hands the
Worker a *result*, which is ordinary data, rather than the *capability* to compute it.

**3. One key, one write.**

The summary is a single KV key (`views:summary`), so a sync costs one write against the 1000/day
budget. Per-document keys are not used: a hundred documents would be a hundred writes, which puts
metrics in competition with publishing — the same reason ADR-015 rejected KV counters on the read
path.

**4. Counts and surfaces, never identities.**

The summary carries, per document: a view count, a last-viewed timestamp, and a breakdown by
*surface* (`link`, `public`, `portal`). It does **not** carry viewer email addresses, even though the
underlying records have them for Access-authenticated views.

"Opened four times through the public link, never by a signed-in member" is useful and identifies
nobody. "cfo@acme.com opened it on Tuesday at 11pm" is a different kind of fact, and putting it
within reach of an LLM — and whatever that LLM is connected to — is a decision that should be made on
its own merits, not inherited by default from a metrics feature. The CLI keeps identities: an
operator reading their own dashboard on their own machine is a different act from an agent
summarizing it.

**5. `canView()` gates it, like everything else.**

Metrics are served only for documents the caller may already see, through the one authorization
function, with no exception for being "just metadata." A view count for a document you cannot read
is still information about a client you have no business hearing about (prime directive #5).

**6. Staleness is stated, not hidden.**

Every response carries `syncedAt`. A number that is three days old and says so is useful; a number
that is three days old and looks live is a liability. Tool descriptions say plainly that metrics come
from the last sync, so a model reports "as of Tuesday" rather than implying it just looked.

## Alternatives considered

- **Give the Worker an `Account Analytics Read` token.** The direct route, and the one this ADR
  exists to refuse. It trades a permanent, account-wide widening of the Worker's compromise surface
  for the convenience of not running a sync.
- **Count views in KV on the read path.** Already rejected by ADR-015 and by the write quota: a
  document that is read is a document that is written, so popularity would consume the same 1000/day
  budget that publishing needs. A viral public link could lock the operator out of their own product.
- **A D1 table or a Durable Object for counters.** Both are readable by the Worker without a wider
  token, and both are a new binding and a new dependency for one feature (prime directive #7). If
  metrics ever need to be live rather than synced, this is the direction to reconsider — as its own
  decision, with the cost stated.
- **Leave it CLI-only.** The status quo, and defensible: the data is one command away. Rejected
  because the question is *most* useful in the place it currently cannot be asked. An agent that can
  read the portal but cannot see that a document was never opened will confidently summarize a
  decision the client has not actually read.
- **Sync automatically after every publish.** Rejected as a default: it couples publishing to an
  analytics query, so an AE outage or an expired token would make publishing fail or hang. The sync
  is a separate act, and a cron is the operator's choice.

## Consequences

- Metrics in MCP are as fresh as the last sync, and never fresher. That is the price of decision 1,
  and it is the right price.
- `pagevault views` remains the richer surface — it has identities and arbitrary time windows — so
  the CLI/MCP parity exception narrows rather than closes. That is now a deliberate, documented
  difference in *kind* rather than an accident of tokens.
- The summary is a derived artifact. A restore from backup carries it, and it may be stale or absent
  after one; both are fine, and a missing summary means "no metrics yet," never an error.
- If view data matters more than three months back, that is still ADR-015's open question, and this
  ADR does not change it: the sync summarizes whatever window Analytics Engine still has.

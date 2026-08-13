# Feature candidates

**Status:** thinking, not planned. Nothing here is a commitment, and nothing here is filed as an
issue. When one of these becomes real it gets an issue, and the contested ones get an ADR first.

Written against 0.38.1. Every code reference was checked against the tree, not recalled.

## The frame

The useful question is not "what does a document-sharing product have that PageVault doesn't."
Measured that way the list is long and most of it is deliberately refused — see
[the README's *use something else if…* table](../../README.md#use-something-else-if).

The useful question is where this sentence is only half true:

> The collection reads back. Publishing and remembering become the same act.

Every candidate below is ranked against that, not against a competitor's feature grid.

---

## The three I'd build

Ranked. The order matters — each is a precondition for the next one's value being legible.

### 1. Document version history

Publishing over a filename replaces it in place, and nothing retains the prior body. So *"what did
we decide about CDC on V2?"* is answerable, but *"what did the January architecture doc say, before
we changed our minds?"* is not.

Over a nine-month engagement the diff between January and June **is** the decision record. Right
now that history is destroyed by the act the product is named for.

The instinct already exists in the codebase: [ADR-020](../adr/ADR-020-rename-leaves-a-forwarding-address.md)
kept a forwarding address for a rename rather than pretending the old URL never existed. This is
the same idea applied to content rather than to the key.

There is a second reason it ranks first. A reader who retrieves the January position has no way to
know June overturned it, and will act on it with complete confidence. A confidently stale answer
costs more than a missing one.

- Cost: roughly one extra KV write per publish, against a 1000/day quota.
- Wants an ADR before code — it changes what a document *is*.

### 2. Expiring public links

`publicToken` is a stored random string with no expiry (`worker/src/documents.ts:233`). A `/p/` link
works forever until it is revoked, and a capability URL is precisely the thing that gets forwarded.

Render capabilities already carry an `exp` claim. The public token does not.

An optional `--expires 30d` on `mint` and `publish` closes the gap without adding a concept: an
expiring capability is still just a capability. This is table stakes in every adjacent product and
it is the cheapest real risk reduction on this page.

### 3. A "who opened what" digest, on the job that already runs

The most-used feature in every document-sharing product is *your client just opened it*. The
real-time version needs the Worker to make outbound calls, which is a new capability and worth
thinking twice about.

Real-time is not the requirement. `.github/workflows/sync-views-prod.yml` already runs on a schedule
and already posts to Slack (`SLACK_HEARTBEAT_WEBHOOK`). A daily digest costs no new Worker
capability, no new dependency, and no new job.

The valuable half is the second sentence: **"Globex hasn't opened anything in three weeks"** is
information you currently have to go looking for.

---

## Second tier

**Cross-portal search, for the operator only.** `searchPortal` is portal-scoped, correctly, for
viewers. But the operator searching their own vault — *which client did I write the CDC thing for?*
— is legitimate and cheap, and it extends the reads-back promise from one client to the practice.
Needs care to stay inside `canView()`; the operator already sees everything, so the risk is
implementation slip rather than policy.

**Let the client walk away with the collection.** `pagevault export` exists for the operator. The
client has nothing. At the close of an engagement, *here is everything, in a folder that opens* is a
good last impression, and it makes the no-lock-in claim concrete rather than rhetorical.

---

## The structural question

**A document is a single file.** An LLM-generated report with a separate chart image or a data file
cannot be published as a unit. [ADR-022](../adr/ADR-022-the-pdf-is-a-capture-of-the-viewer.md) made
remote assets *render*, but there is nowhere to host one.

Not a recommendation. It changes the data model, and "single-file HTML" is in the first sentence of
the README. But it is the limitation most likely to bite in real use, and it deserves a deliberate
decision rather than a discovery.

---

## Keep saying no

The README's *use something else if…* table is right and I would not touch it.

| Not this | Why it stays out |
|---|---|
| Comments, presence, live collaboration | Already disclaimed, and it is `sharehtml`'s ground. Adding it blurs the one-sentence pitch. |
| Watermarks, NDA gate, legal audit trail | A deal-room product. Three months of view records is useful; it is not evidence, and saying so is the honest position. |
| CRM, invoicing, e-sign | A far larger product. Directive #1 says a fork is the answer for anyone who wants it. |
| **Email capture before viewing** | Not currently disclaimed — I would add it. It is Papermark's core move, it is lead generation, and it would make a client deliverable feel like a funnel. |

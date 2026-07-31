# ADR-020 — A rename moves the document and leaves a forwarding address

**Status:** Accepted
**Date:** 2026-07-30
**Completes:** ADR-013 (which deferred rename explicitly), ADR-017 (identity is the filename)

## Context

Dogfooding, 2026-07-30: a document was uploaded through the console with a typo in its
filename. There was no way to correct it. Not in the console — which does not display the
filename at all — and not on any other surface. The workaround was three MCP calls
(`read_document` → `publish_document` under the right filename → `revoke_document`), which
costs about six KV writes and briefly leaves two copies of a client deliverable.

ADR-013 saw this coming and punted:

> A true rename would be a separate operation; it is not in scope here.

The reason it is not trivial is that a document's id is **derived from its filename**:

```
id = base32(sha256(slug + "\0" + normalize(filename)))[:12]
```

So renaming necessarily changes the id, and therefore the `/v/` and `/pub/` URL. There is no
version of "keep the filename identity scheme and keep the URL" — they are the same fact.

That prompted the real question: **should the id be decoupled from the filename entirely?**
Google Drive gives a document a stable id that survives renaming and moving, and the mental
model that produces ("the link is permanent, the name is a label") is a good one.

## Decision

**Keep filename identity. Make a rename a key move, and leave a tombstone.**

1. **`renameDocument`/`editDocument` is one service function** (`worker/src/documents.ts`) that
   every surface calls — console, `/api`, CLI, MCP. It covers filename, title, summary and tags.

2. **Display edits do not move anything.** Changing the title, summary or tags is a single
   `putMeta` at the same id. So is changing only the *case* of a filename, since identity
   normalizes case (`Report.md` and `report.md` are one document). The move path is entered only
   when the normalized filename actually differs.

3. **A filename change moves the document**, writing the complete new document before touching
   the old one — the same ordering rule `putDoc`/`deleteDoc` already follow, so a crash anywhere
   in the sequence leaves *both* documents readable, never neither.

4. **`moved:{oldId}` → newId is the forwarding address.** `/v/` and `/pub/` resolve `meta:{id}`
   **first** and consult the tombstone only on a miss. That ordering is what makes it
   self-healing: publish a new document under the reclaimed filename and it lands on exactly the
   id the tombstone is keyed by, shadowing it — no cleanup write on the publish path. Tombstones
   carry a one-year TTL, so a week of drafting does not accumulate them forever.

5. **The `/p/` capability link survives a rename untouched.** Its token was never a function of
   the id, so the move just repoints `pub:{token}`. The link an operator has already given a
   client keeps working, unchanged.

6. **The redirect is issued only after the target passes the checks the document itself would
   have faced** — same portal, and `canView`. A forwarding address must never become a way to
   learn that a document exists. Everything else is the same bare 404 a miss has always been.

7. **Renaming onto a filename another document already holds is refused outright — 409
   `name_taken`, no override.** Publish has `confirm: true` for replacing a document; rename
   deliberately does not. A rename is a correction, and completing one by destroying a different
   client deliverable is never what was meant.

8. **The console displays the filename.** It is the document's identity and it was the one field
   the admin UI never showed, which is why the typo was invisible as well as uncorrectable.

## Alternatives considered

**Stable GUIDs, decoupled from the filename (the Google Drive model).** Rejected, and this is
the decision the rest follows from.

With a GUID, publish must answer "does `report.md` already exist in this portal?" — which needs
a lookup key, `alias:{portal}:{filename}` → guid. **ADR-013 already considered and rejected
exactly that** (its "a `title→id` index key" alternative): KV gives no read-after-write guarantee
on a `get` either, so it shrinks the race rather than closing it.

It is worse than shrinking it. KV caches *misses* at the edge, not only hits. So:

1. `publish report.md` → the alias read correctly misses → mint guid1, write the alias. **That
   miss is now cached at that colo.**
2. `publish report.md` again a few seconds later, same machine, same colo → the alias read hits
   the **cached miss** → mints guid2.
3. Two documents, same filename, one portal, and the client's link silently goes stale.

That is #74 verbatim — the fork race found dogfooding through the claude.ai web connector, and
the bug ADR-013 exists to kill. With `id = hash(portal, filename)` the write lands on the same
key whether or not the read was stale, so a duplicate is not *rejected*, it is **unrepresentable**.
That property is the entire payoff and it is not worth trading for a stable id.

The comparison to Drive does not carry: Google can decouple id from name because Drive sits on a
strongly consistent metadata store. PageVault deliberately runs on KV — ADR-013 rejected D1 and
Durable Objects under prime directive #7, and ADR-006 keeps the Worker stateless. Copying the id
scheme without the substrate that makes it work copies the shape, not the property.

The code cost of switching would have been small (`docId` has one production call site, and
existing documents could keep their ids by seeding aliases from them). The cost was never the
refactor; it was the reintroduced race.

**Rename without a tombstone, just warn loudly.** Rejected as needlessly lossy. The tombstone is
one small key on a rare operation and it makes the honest answer ("the URL changed") survivable
instead of a broken link.

**Redirect by re-rendering at the old URL instead of a 301.** Rejected: it would leave two live
URLs for one document indefinitely. A redirect updates the reader's address bar, so the canonical
link propagates.

**Let a rename move a document between portals.** Out of scope, deliberately. Moving a deliverable
from one client's portal to another is a confidentiality decision, not a settings tweak, and it
belongs in its own issue with its own confirmation.

## Consequences

- Renaming is one operation on every surface: console Edit dialog, `PATCH /api/docs/{id}`,
  `pagevault edit`, and the `edit_document` MCP tool.
- **A rename changes the canonical URL.** Old links redirect for a year and `/p/` links are
  unaffected, but the change is real and every surface says so rather than swapping the link
  silently.
- `deleteDoc` is split: `deleteDocKeys` removes the document's own keys, and `deleteDoc` adds the
  public-token delete. The move path uses the former, because the token has already been
  repointed and must survive.
- `PATCH /api/docs/{id}` refuses to combine edit fields with reach fields. A rename moves the id,
  so a combined request could not say which document the reach change applied to.
- A pre-ADR-017 document (random id, no stored `name`) keeps its id on a title edit and adopts a
  deterministic one only if it is actually renamed — with a tombstone, so its old URL still works.
- Tombstones are the fourth thing in KV keyed by a document id (`meta:`, `doc:`, `raw:`, `moved:`).
  They are tiny, TTL'd, and read only on a miss, so they cost nothing on the hot path.
- **A rename is the most expensive operation in the product**, and worth stating plainly against
  the 1000/day free write quota: 4 reads, and 9–11 write-class operations (5–7 puts — body, `raw:`
  for markdown, `meta:`, `idx:`, `pub:` if public, `moved:` — plus 4 deletes, which Cloudflare
  counts as writes). A publish is 2–3. That is fine for a correction you make a handful of times,
  and it would not be fine as a routine workflow. A display-only edit is **one** write, which is
  the other reason the two paths are separated rather than collapsed into "save".
- ADR-013's deferred "separate operation" now exists; its deterministic-id reasoning is
  reaffirmed, not weakened.

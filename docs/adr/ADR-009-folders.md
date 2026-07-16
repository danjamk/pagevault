# ADR-009 — Folders: deferred, and constrained if ever built

**Status:** Proposed
**Date:** 2026-07-16

## Context

The question arrives from the operator's side, not the engineer's: *"where are my
files?"* People model published content the way Drive and Dropbox taught them to —
folders, nesting, drag to reorganize. PageVault has none of that, and the honest answer
today is that everything is one flat Workers KV namespace.

The structure is exactly two levels, and it is fixed:

```
Portal (slug)  →  Document (id)
```

`DocMeta.portal` is a single slug — no parent, no path, no nesting. `Portal` has no
parent field. There is no move operation anywhere in the codebase. `DocMeta.tags` is the
only other grouping: flat, cross-cutting, and not currently a browse axis.

The property people actually want from folders is **stable references under
reorganization** — move a file in Drive and its link still works. Drive achieves that
for one reason: the file id does not encode the path. The address and the filing are
separate things.

PageVault has that property on half its routes and not the other half:

| Route | Encodes the portal? | Survives a move? |
|---|---|---|
| `/v/{slug}/{id}` | yes | **no** |
| `/p/{token}` | no — `pub:{token}` → id | yes |
| `/render/{id}` | no | yes |

`portal.ts` enforces the coupling deliberately:

```ts
if (meta.portal !== portal.slug) return notFound();
```

That guard is load-bearing — without it, `/v/public-marketing/{private-doc-id}` would
evaluate `canView` against the *public* portal and hand over a client's private
document. So the authenticated document URL is portal-coupled by design, and a
cross-portal move would 404 every link already sent.

This is latent rather than live: portal assignment happens at publish and never changes.

There is no demand for folders. No user has asked. Building the schema now, with no
consumer, is the speculative generality the shared conventions call out by name.

But two things make it worth writing this down rather than shrugging:

1. **The metadata budget is a shared, finite resource** that a future folder field must
   fit inside, and decisions made between now and then can quietly spend it.
2. **Folders exert a pull toward folder-level permissions** that does not show up in any
   schema review. It shows up eighteen months later as a reasonable-sounding feature
   request, and by then the argument against it has to be reconstructed from memory.

## Decision

**Two decisions, not one.**

### 1. Defer

No folder concept is built now. No `folder` field, no folder entity, no move operation.
`tags` plus `search_portal` already answer *"find the thing"* for a portal holding ten to
thirty documents, which is the actual shape of the problem today.

### 2. If folders are ever built, they take exactly one shape

This is the durable half. *Not now* is not an argument against *now* — the constraint is.

- **A folder is display metadata, scoped inside a single portal.** `DocMeta.folder?:
  string`, a path-like value such as `"2026-q1/discovery"`.

- **🔴 The address is `slug + id`. A folder never appears in a URL.** This is the
  entire reason a folder move can be free: the reference does not encode the filing, so
  reorganizing cannot break a link. The moment a folder enters an address, this ADR is
  void and links break on every move.

- **🔴 `canView()` never takes a folder argument.** Its signature stays
  `(doc, portal, members, email, ownerEmail)`. A folder is not consulted, cannot be
  consulted, and has no authority. Prime directive #5 is not negotiable here.

- **🔴 Folder-level permissions are refused.** If a subset of documents needs different
  access, that subset is a **portal**, or it is `extraEmails`. Folders are filing.
  Portals are permission. A folder that carries authority is a second authorization
  axis, which is the exact thing `canView()` exists to prevent — and it would force the
  folder back into the address, breaking the property above. **This is the line. It is
  the reason this ADR exists.**

- **The folder must fit `DocKeyMetadata`'s 1024 bytes.** `listDocs()` builds its result
  from `list()` key metadata; reading `meta:{id}` per document to discover its folder is
  precisely the N+1 that `store.ts` was shaped to avoid. So `folder` is counted in
  `keyMetadataBytes()`, guarded by the existing `metadataFits()`, and the path length is
  capped. Note the budget is already contested — `extraEmails` was evicted from it for
  this reason.

- **Cross-portal moves stay out of scope.** Moving a document between portals is not a
  filing change; it is an authorization change — it revokes one client's team and grants
  another's, `canView()` takes `portal` and `members` as arguments. It would arrive
  wearing a drag-and-drop UI, which is the most dangerous mutation in the product
  wearing the most casual affordance in software. If it is ever built, it requires a
  confirmation that names who gains and who loses access.

## Alternatives considered

- **Folder entities** — `folder:{id}` → `{name, parent}`, the Drive model proper. Buys
  O(1) rename, empty folders, and per-folder metadata (description, ordering). Costs
  another key prefix, a join on the listing path, and a real tree to validate: cycles,
  orphans, depth limits. For a portal holding ten to thirty documents, that is a lot of
  machinery to avoid roughly thirty writes on a rename nobody has asked for. Revisit only
  if rename cost or empty folders actually bite.

- **Nested portals** — rejected outright. A portal is the permission boundary; nesting
  them means inherited permissions, which is the failure mode ADR-005 was written to
  avoid. Cross-portal leakage ends a consulting business.

- **Tags as the grouping axis** — already exists, already flat, already cross-cutting,
  already in the metadata budget. Not currently a browse axis, and making it one is
  strictly cheaper than folders. If the real need turns out to be *"find things"* rather
  than *"file things,"* this answers it and folders never happen.

- **`/d/{id}` as the canonical document URL** — looking up `meta.portal` rather than
  reading it from the path. The slug in `/v/{slug}/{id}` is redundant data, derivable
  from `meta.portal`, and that redundancy is what creates the mismatch the guard defends
  against; `/d/{id}` makes the leak class stop existing rather than be defended. Costs a
  human-readable link and a lookup for the breadcrumb. **Independent of folders** — it
  neither requires nor is required by them — and noted here only because it shares the
  neighborhood. Not decided by this ADR.

## Consequences

- **Nothing is built, and the foundation already holds.** The address is already
  `slug + id`. `metadataFits()` is already the right guard in the right place. Adding
  folders later is an afternoon — and stays an afternoon *because* the constraints above
  are written down rather than rediscovered.

- **The metadata budget is now partially spoken for.** Roughly 64–128 of the 1024 bytes
  are reserved in principle for a future `folder`. Anything that wants to spend that
  budget between now and then should read this first.

- **The export (#35) is forward-compatible.** Its tree gains a level —
  `acme-corp/2026-q1/report.html` — and the conservative slugifier it already needs is
  the same work. No rework.

- **Accepted cost of the string-path shape, if built:** no empty folders (a folder exists
  iff a document references it), no per-folder metadata, and rename is O(N) writes and
  non-atomic. A partial rename leaves documents split across two folder names — ugly, not
  dangerous, since it is display only, and a re-run repairs it.

- **Accepted risk:** the pull toward folder-level permissions is social, not technical.
  No test catches it. This ADR is the answer when it arrives.

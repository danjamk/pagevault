# ADR-013 — Deterministic document IDs, derived from portal + title

**Status:** Accepted — **superseded in part by [ADR-017](ADR-017-document-identity-is-the-filename.md)**
**Date:** 2026-07-20

> **Update (ADR-017, 2026-07-24):** the deterministic-id *mechanism* below stands unchanged.
> Only the identity *key* moved — from the title to the **filename** — because a
> content-derived title was invisible and collided surprisingly. Read `(portal, title)` as
> `(portal, filename)` throughout; `title` is now display-only.

## Context

`publishDocument` is create-or-update, keyed on `(portal, title)`: iterating a
report updates the same URL instead of forking a new one. That is the load-bearing
half of "the link is the unit" — the client's link stays current, and the graveyard
of stale links this project set out to kill never forms.

But the update path resolved the title through a **scan**: `findByTitle` →
`listDocs` → `env.PAGEVAULT.list({ prefix: "idx:{slug}:" })`. KV `list()` is
**eventually consistent** — ~60s, no read-after-write guarantee, not even at the
same edge (CLAUDE.md). A republish inside that window reads a **stale index**, misses
the document it just wrote, mints a fresh random id, and **forks the URL**: two docs,
same title, one portal, and a client-facing link that silently goes stale. This is
#74 — found dogfooding through a claude.ai web connector, and it is exactly the KV
gotcha the project already knew about, biting the exact flow it was built to solve.

A `title→id` index *key* (a `get` instead of a `list`) shrinks the window but does
not close it: KV gives no read-after-write on a plain `get` either. Half a fix.

## Decision

**Derive the document id deterministically from `(portal slug, normalized title)`.**

```
id = base32(sha256(slug + "\0" + title.trim().toLowerCase()))[:12]
```

over the existing 32-char alphabet (first 12 bytes of the digest, each `% 32` — 256
is divisible by 32, so no modulo bias; ~60 bits, negligible collision for one
operator's document count).

- Same `(portal, title)` → same id → same `meta:`/`doc:`/`idx:` keys → **overwrite in
  place, same URL.** Dedup holds **by construction**: there is exactly one key for a
  given portal+title, so a duplicate is not *rejected*, it is *unrepresentable*. No
  scan, no race.
- The `confirm` guard becomes a direct `getMeta(id)` — a single-key `get`. That read
  is still eventually consistent, but the failure mode degrades from "silent duplicate
  + stale link" to "overwrote without prompting," and only on a rapid same-operator
  republish. That is the correct direction for "the link is the unit."
- `findByTitle` is deleted.

**Title normalization defines identity.** Two titles differing only in case or
surrounding whitespace are the same document — the same rule `findByTitle` already
used. Retitling a document produces a new id (and URL), i.e. a new document — which is
also how the old scheme behaved (a `findByTitle` on the new title never matched the
old doc). A true rename would be a separate operation; it is not in scope here.

**No migration (option A).** Existing documents use random ids. Per ADR-010 nobody is
using PageVault yet, and nothing references a real document URL (only a *fake*
`share.example.com` example in the docs), so there is nothing to protect. Deterministic
ids apply to all publishes going forward; an existing test document is superseded by a
fresh deterministic-id document on its next republish, and any orphan is trivially
reaped. Writing a re-key migration to avoid orphans we don't have is cost without
benefit.

## Alternatives considered

**A `title→id` index key.** A `get` on `title:{slug}:{normTitle}` instead of a
`list`. Rejected: KV has no read-after-write on `get` either, so it shrinks the race
without closing it — and it keeps a second key in sync forever. Deterministic ids
remove the lookup entirely.

**Migrate existing docs to deterministic ids.** Re-key every document up front (which
changes their URLs — fine pre-launch). Rejected as unnecessary: there are no
real URLs to preserve yet, so this is migration code for a problem that doesn't exist.
Revisit only if the scheme ever changes *after* launch.

**A strongly-consistent store (D1 / a Durable Object).** Would give real
read-after-write. Rejected: it adds a dependency and a stateful component the product
deliberately does without (prime directive #7, ADR-006's stateless stance). KV is the
chosen substrate; the fix should live within it, and deterministic ids do.

## Consequences

- Duplicate documents by title, within a portal, become impossible — not policed,
  structurally absent.
- The `confirm` overwrite guard is best-effort (an eventually-consistent `get`), but
  its worst case is overwrite-in-place, never a fork. The MCP tool description's
  "replaces in place, same URL" promise is now true.
- Existing random-id documents (pre-launch test data) are not migrated; they are
  superseded on next republish. A small reaper can clear orphans if it ever matters.
- Title normalization is now identity-bearing: case/whitespace-equal titles collide to
  one document (intended), and retitling forks (unchanged from before).
- No new dependency; storage stays KV. `mintPublicToken` (capability links) keeps its
  random 22-char form — only *document* ids become deterministic.

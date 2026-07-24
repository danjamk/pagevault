# ADR-017 — Document identity is the filename, not the title

**Status:** Accepted
**Date:** 2026-07-24
**Supersedes, in part:** ADR-013 (the identity *key* only — its deterministic-id mechanism stands)

## Context

ADR-013 made a document's id deterministic from `(portal, normalized title)` to kill the
#74 fork race: a republish inside KV's ~60s eventual-consistency window used to miss the
doc it just wrote and mint a duplicate. That mechanism was right and it stays.

But ADR-013 made the identity *key* the **title**, and the title is derived from
**content** — the `<title>` tag, or the first `# heading` — not from anything the user
names. Dogfooding a fresh rung-1 install (2026-07-24) exposed the cost:

- `pagevault publish README.md` created a document titled **"Brain"** (from its `# Brain`
  heading). Re-running it, and then publishing a *copied* `README2.md`, both failed with
  `409 already_exists — a document titled "Brain" already exists`. Two distinct files
  collapsed into one document, and copying the file to a new name to fork it **didn't
  work, because the name was never the key.** The operator never chose "Brain"; the file's
  heading did, invisibly.

The mental model people already hold is the **filename**. "Save As `report-v2.md`" makes a
new document; editing `report.md` in place updates it; Google Drive overwrites on a
same-name upload. Naming a new version with a new filename while keeping the same title is
a standard human workflow — and the title-as-identity scheme actively fights it.

The one wrinkle: the MCP surface has no file. `publish_document` takes content + title in
memory, so "filename" there is a string the caller supplies, not something read off disk.

## Decision

1. **Identity = `(portal, filename)`.** The deterministic id (ADR-013) now hashes the
   normalized filename instead of the title. The anti-race mechanism is unchanged; only its
   input changes:

   ```
   id = base32(sha256(slug + "\0" + normalize(filename)))[:12]
   ```

2. **`title` is display only.** Sourced exactly as before (content `<title>`/`# heading`,
   or `--title`), shown in the portal index and to the client. It no longer bears identity,
   so two documents in a portal **may share a title**.

3. **`filename` is the update key on both surfaces:**
   - **CLI** — defaults to the basename of the published file, extension included
     (`report.md`). `--name <filename>` overrides it.
   - **MCP** — a `filename` tool parameter. Its description instructs the model to
     **manufacture a stable filename** (e.g. `q3-review.md`) and reuse it to update in
     place. Optional: when omitted it defaults to `slug(title) + ext(sourceKind)`, so an
     assistant that only passes a title behaves as it does today.

4. **The extension is part of identity.** `report.md` and `report.html` are different
   documents. This is faithful to "it's a filename," and a format change is a new artifact.

5. **Normalization:** trim + lowercase the filename (so `README.md` == `readme.md`),
   matching ADR-013's title rule. Directory components are stripped — identity is the
   basename, never the path.

6. **Collision handling is first-class on both surfaces.** A same-filename republish
   without `confirm` returns the existing **filename + id** and the three paths:
   `--confirm` to replace in place, `--name` to fork a distinct document, `mint <id>` to
   change only the link. The MCP `Conflict.summary()` says the same in model terms.

7. **Publish echoes the resolved filename and title,** so identity is never invisible
   again.

## Alternatives considered

**Keep title as identity, just make it visible** (echo it, richer 409). Rejected: treats
the symptom. The key is still content-derived and still fights the new-filename-same-title
workflow.

**A separate abstract `name`/`slug`, distinct from "filename."** Rejected as needless
vocabulary: on the CLI it *is* the filename; on MCP the model manufactures one. Calling it
`filename` everywhere is one concept, and the tool description carries the "manufacture if
needed" note.

**Filename identity on the CLI, title identity on MCP.** Rejected: split-brain identity
breaks cross-surface updates and violates surface parity. One key — `filename` — defaulted
differently per surface.

**Drop the extension from identity.** Rejected (weakly): keeping it is more
filename-faithful and cleanly separates a `.md` from a `.html` of the same base. Revisit if
it proves annoying in practice.

## Consequences

- **Breaking: ids and URLs change.** Every `/p/` and `/v/` URL derives from the id, which
  now hashes the filename. Nothing has been shared with anyone yet (operator-confirmed,
  2026-07-24), so — as in ADR-013 — **no migration**: the change applies going forward and
  stale test documents are reaped.
- Two documents may share a title within a portal; the portal index may show two "Brain"
  rows with different filenames. Honest and acceptable.
- Title normalization is no longer identity-bearing; filename normalization is. **Retitling
  a document no longer forks it** (an improvement); renaming its file does (intended).
- The #74 fork race stays fixed — same deterministic mechanism, different input.
- `sourceKind` and the extension can disagree if a caller lies (a `.md` name with html
  source): the extension governs identity, `sourceKind` governs rendering. Documented, not
  policed.
- ADR-013 is superseded on the identity-key point only; its deterministic-id reasoning is
  reaffirmed.

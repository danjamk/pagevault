# ADR-011 — Public by default in the console

**Status:** Accepted
**Date:** 2026-07-18

## Context

PageVault's core loop is *publish → hand someone a link*. But the console's sharing panel
treated a public link as something to **generate**: it showed a "Public link: None —
[Make public]" row, which both hid the always-present document link and framed sharing as
an opt-in chore. The friction landed squarely on the common case — share a report with a
client who has no login — while the rare case, locking a document down, was free. And on a
**draft** the panel still offered a live-looking **Copy** on a link that opens for no one.

Two distinct "links" were the source of the confusion:

- **The document's own portal URL** (`/v/{slug}/{id}` or `/pub/…`) — always exists, gated
  by `canView()`.
- **The public capability link** (`/p/{token}`) — unguessable, no login, forwardable, burns
  no Access seat. The sharehtml model (ADR-007, #3).

## Decision

**The console defaults a newly published document to "Anyone with the link"** — it mints the
capability link on publish, and the sharing UI leads with that link. Narrowing to team-only
or owner-only becomes the deliberate choice, not the default.

This is a **console default and presentation** decision. It deliberately does *not* change:

- **`canView()`** — untouched. A capability link is still self-authorizing on its own route
  and is never consulted by `canView` (ADR-005 invariant 4).
- **The token model** — the same `publicToken` mint/revoke that already existed.
- **CLI / MCP / API defaults** — these still require an explicit `public: true`.
  `pagevault publish report.html` stays private by default. Only the browser console flips
  the default, because the console is the surface where a human is actively deciding to share.

Reach is presented as a per-document toggle — capability link **on** (default) or **off**.
When off, the portal governs and the label adapts: **"My team"** in a restricted portal,
**"Only me"** in a private one. A draft is a separate state that beats every grant.

## Consequences

- The common path is zero-decision: publish → copy link → send.
- A default public link is **forwardable** — anyone it reaches can open it. The UI says so, in
  one line ("a link is a key"), and that note is deliberately not hidden: it is the accepted
  trade for no-login sharing.
- A draft (`ownerOnly`) still opens for no one, including through the default link — the panel
  shows the link as **dormant** rather than pretending it works.
- Defaults now diverge by surface: public in the console, private in CLI/MCP. This is
  deliberate — a human clicking **Publish** in a browser is expressing intent to share; a
  scripted `publish` is not. If it proves confusing, unifying is a later decision (see #63).

## Alternatives considered

- **Invert the default everywhere (backend / `canView`).** Rejected: a far larger blast radius
  — it changes CLI/MCP semantics and the security model to fix a UX problem that lives in the
  console.
- **Keep private-by-default, just relabel "Make public".** Rejected: relabeling does not remove
  the common-case friction. The point is that sharing should be the thing that *just happens*.

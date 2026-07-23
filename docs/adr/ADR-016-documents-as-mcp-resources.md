# ADR-016 — Documents as MCP Resources

**Status:** Accepted — design settled; built in the MCP-hardening batch, shipping gated on a live host check
**Date:** 2026-07-23

## Context

The pitch is that the collection reads back: six months into an engagement, *"what
did we decide about CDC on V2?"* is answerable from the portal. Today that works
through two tools — `search_portal` and `read_document` — and both are
*model-initiated*. The value only fires when the model decides to go looking.

MCP has a second primitive for exactly the other half. Tools are model-controlled
actions; **Resources** are user/app-controlled addressable data: `resources/list`,
`resources/read`, URI templates for parameterized lookup, optional
`subscribe`/`listChanged`. The rule of thumb is: if the model decides when to fetch,
it's a tool; if the user picks it from a list, it's a Resource. Resources are how a
user *attaches* the January architecture doc as context deterministically instead of
hoping the agent finds it. Of everything in `mcp-best-practices.md`, this is the item
that makes the server distinctive rather than merely correct (§5).

The SDK supports it: `registerResource` + `ResourceTemplate` are present in
`@modelcontextprotocol/sdk` 1.29. The read logic already exists — `readDocument()` in
`documents.ts` is the whole implementation, and a resource read is the same read.

Two frictions are why this is ADR-gated rather than a quick win.

### 1. Host support for the *Resources primitive* is unconfirmed, and that is the crux

"The host supports MCP" is not the same claim as "the host renders Resources." Every
host supports tools; support for the Resources primitive — a picker, an `@`-mention,
an attach affordance — is uneven and, for our actual targets, unverified. Claude
Desktop and Claude Code surface resources. Whether claude.ai web and the mobile
connector render them *usefully* is the open question, and it is the one that decides
whether this is worth building, because ADR-006 says the browser and the phone are the
entire differentiator. A Resource surface that only works in Desktop is a Desktop
feature, and Desktop is the surface that least needs it — it already has a terminal.

I could not confirm the web/mobile support state from documentation. That uncertainty
is a fact to design around, not one to assume away.

### 2. The authorization story, stated honestly

Prime directive #5 says `canView()` is the one authorization function, "including for
the read-side MCP tools." Mechanically that is not what happens, and the ADR has to be
precise or it will mislead the next change.

`read_document` → `readDocument()` does **not** call `canView()`. The MCP surface is
gated as a whole by operator identity (`isAuthorized`, or an OAuth token the provider
issued). The single operator is the owner, and the owner passes `canView()` on its
first check every time — so a per-document call on the MCP read path would be a no-op
that always returns true. The real protections on the read side are two: **you must be
the operator to reach the surface at all**, and **`search_portal` requires a portal**
so a cross-client grep is not one tool call away.

This matters for Resources because it tells us what "authorize identically" actually
means here, and it is not "call `canView` per resource."

## Decision

Split the decision in two: the **design** is settled now; the **build** is gated.

### The design (accepted)

**1. URI scheme: `pagevault://<portal>/<id>`.** The portal is the client boundary and
belongs in the address, so a resource names a document unambiguously and carries its
client scope in the URI itself. A `ResourceTemplate` of `pagevault://{portal}/{id}`
with a `list` callback that enumerates documents.

**2. A resource read reuses `readDocument()`.** One read implementation, behind one
operator gate. This is how prime directive #5 is honored in practice: not by a second
`canView` call bolted onto a new path, but by there being exactly one path, so a future
per-viewer check added to `readDocument()` is inherited by tools and resources at once.
The portal is in the URI, so the read path has no cross-portal ambiguity to guard the
way `search_portal` does — there is nothing to infer.

**3. Read-only, and these non-goals are explicit:**

- **No `subscribe`, no `listChanged`.** Single operator, low churn, and a change-feed
  is machinery the problem does not have yet. Revisit only if a host makes live
  attachment meaningfully better.
- **No resource-level mutation.** Publishing stays a tool. A resource is a way to
  *read* the collection, never to write it.
- **No pagination initially.** The corpus is dozens of documents (ADR-005's whole
  premise); `resources/list` returns them all, same as the tool lists do.

**4. The read tools MAY return `resource_link`s** pointing into the resource space, so
a `search_portal` hit can hand back an attachable handle rather than only prose. This
is additive and lands with the implementation, not before it.

**5. `resources/list` shows the operator every document across every portal.** That is
correct — the operator owns all of it — but it means the attachment picker is not
client-scoped. Noted as a UX property, not a leak: there is one operator, and the
cross-portal boundary protects *clients from each other*, never the operator from their
own collection.

### The build (done in this batch; shipping gated)

The implementation landed in the MCP-hardening batch: a `registerResource` template at
`pagevault://{portal}/{id}`, a `list` callback over `listDocs`, a read that reuses
`readDocument()`, and `resource_link`s returned from `list_documents` and `search_portal`.
Covered by nine tests in `mcp.test.ts` — capability advertisement, template listing, read,
markdown round-trip, the portal-mismatch refusal, and the tool links.

**But the surface is not verified against a real host yet, and that gate stands.** Building
it was cheap and reuses the one read path; *shipping it as a working feature* still depends on
a target host — claude.ai first, because reach is the differentiator — actually rendering the
Resources primitive usefully. The natural place for that check is #95's live acceptance
protocol, which exercises the MCP surface over real OAuth against the deployed bundle.

So: the code is merged and tested, but #82 is not *closed*, and the release notes do not claim
Resources work on a given surface, until the live check passes there. If it fails on every
non-Desktop host, the finding gets recorded here and the feature is described honestly as
Desktop-only — the code does not get ripped out, because it is correct and cheap, but the claim
gets scoped to what a host actually delivers.

## Alternatives considered

**Build it now, unconditionally.** Rejected. The value is entirely contingent on a host
affordance I could not confirm exists on the surfaces that matter. Shipping it blind
risks a feature that only works where it is least needed, plus the ongoing cost of
testing a surface no one reaches.

**Never build it — tools are enough.** Rejected. The tools deliver the read-back, but
only model-initiated. Deterministic *attach* is a real capability the tools cannot
express, and it is the most on-thesis upgrade available. "Not yet" is right; "no" is
not.

**`resource_link`s from tools, without a Resource space.** Considered, and partially
kept (design point 4). But links that point nowhere are worse than no links: a
`resource_link` is only meaningful if `resources/read` resolves it. It rides with the
Resource implementation, not instead of it.

**Per-resource `canView()` to satisfy prime directive #5 literally.** Rejected as
theater. It would be a no-op that always returns true for the sole operator, and
dressing the read path in a check that cannot fail would misrepresent where the
authorization actually is (operator-gated surface, single read path). The directive is
honored by the shared `readDocument()` path, not by a decorative call.

## Consequences

- The MCP read authorization model is now written down honestly: operator-gated
  surface, one read path, `canView()` trivially true for the owner. The comment at
  `access.ts:62` ("including the read-side MCP tools") describes the threat framing, not
  a literal call, and slightly overclaims; tightening it is a small follow-up, tracked
  with #82.
- `#82`'s "done" is redefined: implementation plus a passing live host check, not
  implementation alone. The issue's acceptance criteria and #95 get an explicit
  cross-link.
- If Resources ship, the attachment picker shows all portals to the operator. Any future
  multi-operator fantasy (explicitly out of scope, prime directive #1) would have to
  revisit design point 5 before it did anything else.
- Choosing `pagevault://<portal>/<id>` commits the portal slug to the public URI. A
  portal rename would break saved resource handles — acceptable, because slugs are
  already load-bearing in `/v/` and `/pub/` URLs and are not casually renamed.
- The non-goals (no subscribe/listChanged/pagination) are recorded so their later
  addition is a decision with a reason, not a default someone reaches for.

# ADR-015 — What PageVault records about a view

**Status:** Accepted
**Date:** 2026-07-21

## Context

PageVault is about to grow two observation streams at once: structured logs that say
who was denied and why (#41), and an Analytics Engine dataset that says which documents
were opened (#91). They are different mechanisms answering different questions, but they
ask the operator the same thing — *what is it acceptable to write down about a request?*
— and answering it twice, in two issues, is how the two streams end up with two different
answers.

Today the answer is "almost nothing, by omission." One `console.log` in the Worker,
wrapped in `logBlocked` (`viewer.ts:376`), reached from four call sites. Every `canView()`
denial, every successful view, and every MCP tool call is invisible. There is no
denominator, so a rejection *rate* cannot be computed, and "did the client open the
migration plan before the call" is unanswerable.

The omission is not neutral. `logBlocked` writes `url: request.url`, and `handleRender`
carries the capability in `?cap=` (`viewer.ts:64`) — so rejected render capabilities land
in the log whole. That is minor today: `TTL_SECONDS = 10 * 60` (`capability.ts:28`), and
only the wrong-document branch rejects a token that is still live. The forward risk is
not minor. `handlePublicToken` has four rejection branches (`index.ts:172,175,180,184`),
all bare `notFound()`, none logged. Public tokens are 22 chars of entropy and live until
rotated. Closing that gap the obvious way — calling `logBlocked(..., request)` like every
existing call site does — would write **permanent capability URLs** into the logs. The
gap has to be closed *after* the rule is written, not before.

### Identity is not uniformly available

The product has four surfaces that render a document, and they differ in what the Worker
actually knows:

| Route | Access app | Identity available |
|---|---|---|
| `/v/{slug}/{id}` | yes | a verified-JWT email (`portal.ts:37-53`) |
| `/pub/{slug}/{id}` | **no**, deliberately | none |
| `/p/{token}` | **no**, deliberately | none |
| `/render/{id}?cap=` | no — the iframe | inherited from the shell that minted the capability |

The two anonymous surfaces are anonymous *by construction*, not by policy: they have no
Access application in front of them precisely so an anonymous reader never hits a login
wall and never burns one of the 50 free seats. There is no identity to withhold there,
because there was never any to collect.

## Decision

One rule governs both streams.

**1. Record identity where Access established it. Nowhere else.**

`/v/*` views record the verified email. `/pub/*` and `/p/*` views record the portal and
document and no subject at all — not an IP, not a User-Agent, not a fingerprint.

The email is not a new category of data. Portal membership is already a list of client
emails in KV; recording that one of those members opened a document adds no subject the
system did not already hold. And it is the only form that answers the question the
feature exists for. A hash gives cardinality — *someone* opened it four times — while
destroying the one fact worth having.

**2. Never record a credential.**

No capability token, session token, bearer token, or `CF_Authorization` cookie is
written to either stream, in any form that could be replayed. In practice this means
`request.url` is never logged on a token-bearing route. Log the path, and where a token
must be correlated across events, a short prefix of its SHA-256 — enough to tell two
rejections apart, not enough to reconstruct the token.

This applies to the log stream regardless of how harmless a given token looks. The rule
has to be structural, because the next route added will not remember that `/p/` tokens
are permanent.

**3. Deny events record the decision, not the subject's secrets.**

A denial records what was asked for (portal, document), which rule refused it, and the
identity *if Access had established one*. The four `/p/` rejection branches become four
distinguishable events — unknown token, missing document, superseded token, owner-only —
because "the link doesn't work" is a support question and today all four look identical.

**4. No IP addresses, no User-Agent strings, in either stream.**

Recording an IP on `/p/` and `/pub/` views would reconstruct, by proxy, exactly the
identity decision 1 declined to collect. Anonymous surfaces stay anonymous. This also
keeps the anonymous rows genuinely non-personal, which is the thing that makes the
public tier safe to point at a client's marketing page.

**5. Analytics is a rolling window, not a history.**

Analytics Engine retains three months. A nine-month engagement outlives its own view
data. The dataset answers "recent activity," and every surface that displays it — CLI
output, docs, any future console panel — says so plainly rather than implying a durable
"has this ever been opened." A durable last-opened timestamp would cost a KV write
against the 1000/day budget shared with publishing; it is out of scope here, and #91
carries the open question.

**6. The Worker writes; the operator reads.**

The Analytics Engine binding is dataset-scoped and write-only. The SQL API needs an
account-scoped `Account Analytics Read` token, which is a strictly wider credential than
the Access-group-scoped `CF_API_TOKEN` the Worker holds today. Putting it in the Worker
is the exact blast-radius widening ADR-002 exists to prevent, so it does not go there:
`pagevault views` queries the SQL API from the operator's machine with the deployment
token. The Worker never gains the ability to read its own analytics.

**7. Portal slug is the index.**

One index per data point, 96 bytes, and more than one is *silently dropped*. The portal
slug is the client boundary, which makes it the correct partition key. Aggregate with
`sum(_sample_interval)`, never `count()`.

## Alternatives considered

**Hash the viewer email.** Salted SHA-256 in place of the address, so the dataset holds
no plaintext. Rejected: it defeats the purpose. The question is "did *this client* read
it," which requires resolving the hash back to a person — so the operator would keep a
rainbow table of their own members, and the hash would be plaintext with extra steps. It
protects against a threat (someone reading the operator's own analytics for their own
clients) that is not the threat model of a single-operator tool.

**Record no identity anywhere — portal and document only.** Simplest and most private.
Rejected: it makes the feature not worth building. "Fourteen artifacts and no idea which
ones the client opened" is the stated motivation; portal-level counts do not move it.

**Record everything Cloudflare hands us** — IP, User-Agent, ASN, country. Rejected under
decision 4. It is free at the point of collection and permanent at the point of regret,
and it would silently de-anonymize the surfaces the product deliberately leaves
anonymous.

**Settle it separately in #41 and #91.** Rejected: two issues, two authors-in-time, two
answers. The log stream and the analytics stream would drift on whether an email is
recordable, and the drift would show up as a privacy inconsistency rather than a bug.

## Consequences

- `logBlocked` must be fixed *before* logging coverage expands. Moving it out of
  `viewer.ts`, making `level` a real parameter, and dropping `url` are prerequisites for
  #41's coverage work, not cleanup that can follow it.
- Analytics rows are heterogeneous by design: `/v/*` rows carry a subject, `/pub/*` and
  `/p/*` rows do not. Any query that groups by viewer has to treat the null case as
  "anonymous surface," not "missing data."
- PageVault structurally cannot answer "who opened this public link." That is a real
  capability gap and it is the correct one — it follows from the routing topology, not
  from a setting someone could flip.
- The operator holds an account-scoped analytics read token on their own machine. That
  credential is broader than anything the Worker has, and it stays outside the Worker's
  compromise surface.
- View data older than three months is gone. If the longer horizon turns out to matter,
  it is a new decision with a KV-write cost attached, not an adjustment to this one.

# How I built this

PageVault is small on purpose — one Worker you can read in a sitting. This page is about the
*process* that kept it that way, because the process is most of the reason the code is worth
reading at all. I built it with an agent (Claude Code) doing the typing, but the interesting part
isn't that an agent wrote it. It's the guardrails that made an agent-written codebase something I'd
put my own clients behind.

## Decisions are written down before the code

Every contested call is an ADR in [`../adr/`](../adr/) — access topology, why the Worker verifies
the JWT itself, why the MCP server is remote instead of stdio, why permissions live on the portal
and not the document. The rule is simple: if a decision was hard, the reasoning outlives the
argument. When I revisit a choice six weeks later — or an agent proposes overturning one — the
record is right there, and re-litigating it means reading the ADR first.

This also keeps the agent honest. A model is happy to rewrite an authorization boundary on a whim;
an ADR that says *why the boundary is where it is* turns that into a conversation instead of a
silent regression.

## Plans before code, phase by phase

The build ran off written plans in [`implementation/`](implementation/) — each feature scoped,
sequenced, and pressure-tested on paper before a line was written. The plans are still here, not
deleted after the fact, because they show the shape of the work: what order things had to happen
in, what was deferred, and what turned out to be wrong. A plan that got revised mid-build is more
honest than one that pretends the path was straight.

## The agent typed; the rules did the thinking

Day to day, the work runs through Claude Code against a set of standing rules — a project
`CLAUDE.md` that encodes the prime directives (single-operator, small enough to read, ask before
adding a dependency, one authorization function) and a handful of skills I lean on constantly: a
commit skill that enforces message conventions, a PR-prep and review pass, a planning-and-ADR
workflow, and a "pressure-test this idea" skill for when something smells wrong. The skills aren't
magic; they're the checklist I'd otherwise forget, made repeatable. The value is that the same bar
gets applied every time, not just when I remember to care.

## Every provisioning step has an undo

Setup climbs a ladder — public links, then your own domain, then gated portals — and each rung has
a matching teardown. Nothing gets created that can't be cleanly removed, which is the only reason
the setup is safe to *test*: I can provision a rung, verify it, tear it down, and do it again from a
clean account. Idempotent provisioning with a real undo is unglamorous and it's most of what makes
the deploy story trustworthy. See [ADR-008](../adr/ADR-008-progressive-provisioning.md).

## Security isn't a phase

Three things are load-bearing and none of them were bolted on at the end:

- **One authorization function.** `canView()` answers *may you see this* and nothing else does.
  A single, pure, testable function is easy to reason about and impossible to accidentally route
  around. Cross-portal leakage would end a consulting business, so there are no exceptions —
  including for the read-side MCP tools.
- **Two tokens, not one.** A broad deployment token stays on my machine; the Worker holds a narrow
  runtime token that can edit exactly one Access group and nothing else. A compromised Worker can't
  reach my KV or my other Workers. See [ADR-002](../adr/ADR-002-seat-bounding.md).
- **A test that fails the build.** Every artifact is treated as hostile — it renders in a sandboxed
  iframe, and `allow-same-origin` is banned from the codebase by a test, not a convention. The
  guardrail that matters is the one a machine enforces. See
  [ADR-007](../adr/ADR-007-viewer-shell.md).

## It runs on itself

The public showcase — including the competitive comparison and the feature walkthrough — is served
*through PageVault*, into the same sandbox every other document gets. The documentation is also the
demo. If a claim on the site were false, the site would be the thing that broke.

## What this repo is trying to show

Two things, really. One: you can build a genuinely small, auditable product with an agent, if you
put the discipline in the repo instead of in your head. Two: the honest version of a thing —
including the plans that changed and the comparison rows where the alternatives win — reads as
confidence, not weakness. That's the whole approach, and it's all here to copy.

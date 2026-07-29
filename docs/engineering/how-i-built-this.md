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
honest than one that pretends the path was straight. Plans whose work has shipped move down into
[`implementation/complete/`](implementation/complete/), so what's left at the top is what's still
open — which, as of the 1.0 run-up, is nothing. Every plan in there has landed.

## The issue tracker is the working memory

Almost nothing gets built straight from a conversation. Work becomes a GitHub issue first —
background, tasks, references — and the issue is what survives the session that produced it. That
matters more with an agent than without one: a chat has no memory I can rely on next week, and an
issue does.

Issues carry a `track:` label — `core`, `mcp`, `packaging`, `ops`, `admin`, `docs`, `design`,
`showcase` — so the backlog can be read by area rather than as one undifferentiated pile. There is
also a `dogfood` label, which is the one I'd steal: it marks anything found by *using* PageVault on
real work rather than by testing it. Those issues are consistently the sharpest ones in the tracker,
because a bug you hit while trying to get something else done comes with the context that makes it
worth fixing.

Sizing rule: an issue should be a day or two. Anything bigger gets broken up, because a large issue
is where scope goes to hide.

## The agent typed; the rules did the thinking

Day to day, the work runs through Claude Code against a set of standing rules — a project
`CLAUDE.md` that encodes the prime directives (single-operator, small enough to read, ask before
adding a dependency, one authorization function) and a handful of skills I lean on constantly: a
commit skill that enforces message conventions, a PR-prep and review pass, a planning-and-ADR
workflow, and a "pressure-test this idea" skill for when something smells wrong. The skills aren't
magic; they're the checklist I'd otherwise forget, made repeatable. The value is that the same bar
gets applied every time, not just when I remember to care.

## A skill that runs the acceptance test I'd never run by hand

The most useful thing I wrote isn't code. [`.claude/skills/lifecycle/`](../../.claude/skills/lifecycle/)
is a skill that drives the entire install path against a **real Cloudflare account** — provision on
`workers.dev`, verify, add a custom domain, verify again, turn on Zero Trust and portals, verify a
third time, then tear the whole thing down. It publishes a realistic corpus at each step and checks
what it can automatically.

Three things make it worth having:

- **It stops where a machine can't help.** The skill is explicit that about half the value is checks
  only a human with a browser can make — does the login wall actually appear, does the client see
  five documents and not six, does the chart render inside the sandbox. It prints those as numbered
  checkpoints and waits. A test that pretends to cover them would be worse than one that admits it
  can't.
- **It knows what it must never do.** Rule one is that it never runs `destroy` — that is the command
  that deletes documents, and it belongs to a human. Encoding that in the skill means I'm not
  relying on an agent's judgement at the moment it matters.
- **It runs on a machine that has never seen the project.** There's a
  [standalone prompt](../../.claude/skills/lifecycle/fresh-machine-prompt.md) I can paste into
  Claude Code on a clean laptop, where the only input is `npm install -g pagevault`. That is the
  install path as a stranger meets it, and it is the single highest-yield test in the repo — the
  release it first ran against turned up a bug that left a live, unusable deployment.

Underneath it, `make test-e2e` boots a real Worker with `wrangler dev` and drives the actual CLI
binary as a subprocess against it. Not mocks: a real KV, real HTTP, the real argument parsing.

## The lesson that cost me the most

**A check that cannot fail is worse than no check, because it gets believed.**

I hit that three times. `verify` once printed a warning for a failed check and still exited zero, so
two releases shipped believing a green run meant something. The constant listing the MCP tools
`verify` asserts had drifted to nine while the Worker registered twelve, so a deployment missing
three tools verified clean. And `restore` refused on "is this namespace empty?" — a question whose
answer says nothing about what a restore would actually destroy.

Same failure each time: a guard that could only ever pass. So the habit now is to **break the thing
on purpose and confirm the test goes red.** When I added the MCP-tool guard I deleted a tool from
the list and watched it fail, then added one that doesn't exist and watched it fail again. When I
tightened the restore logic, mutation-testing the decision function killed two of three mutants —
and the survivor exposed a real hole I'd have shipped otherwise.

Four checks fail the build outright rather than warn: `check-sandbox` (the string
`allow-same-origin` must appear nowhere), `check-palette` (a retired colour must not creep back),
`check-docs` (the docs must not describe a route, command or MCP tool the code doesn't have), and
`check-console` (the browser JavaScript the Worker emits must actually parse). All four are plain
greps or small scripts. The guardrail that matters is the one a machine enforces.

The last one exists because the type checker has a structural blind spot here: the Worker builds
its UI as HTML inside template literals, so roughly 45KB of browser JavaScript is *string content*
to `tsc`. I proved the gap rather than assuming it — an unbalanced brace dropped into the console
passes `tsc` with exit 0 and all 25 console tests, and would have shipped an admin page that renders
nothing. Every one of these checks earned its place by catching something; none was added
speculatively.

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

## Shipping it: three pipelines, and none of them are clever

[`.github/workflows/`](../../.github/workflows/) holds exactly three, and the split is deliberate.

**CI** runs on every PR and every push to `main`: the sandbox and docs invariants first — they're
the cheapest and the most absolute — then typecheck, the Worker suite under
`@cloudflare/vitest-pool-workers`, the `node --test` suites for the CLI and setup scripts, and a
pack-and-install smoke that exercises the *published tarball* rather than the working tree. That
last one catches a broken `files` allowlist or a missing shebang at PR time instead of at a publish
that can't be taken back.

**Deploy to production** is `workflow_dispatch` only — I press the button. It **backs up the
production KV namespace and uploads the snapshot as an artifact before it deploys anything**, then
deploys, then verifies the deployment reports the build it just shipped. Backup, deploy, verify, in
that order. A deploy pipeline that can't prove what it deployed is a deploy pipeline you'll be
debugging by hand at the worst moment.

**Publish to npm** fires when a GitHub Release is published, and is covered below.

## Versions name code, not deployments

[ADR-010](../adr/ADR-010-versioning-and-releases.md) settles a distinction that gets muddled
constantly: the version identifies **released code**, and a deployment separately reports what it is
running. `/health` returns `<version>+<shortsha>` — so "which version are you on" and "is that
actually what's deployed" are two different, answerable questions. There's a third version too, the
`.pagevault.json` schema, with ordered migrations so an old config on someone's laptop upgrades
itself instead of erroring.

Bumps are **assisted, not automatic**. The PR workflow reads the branch's conventional-commit types,
proposes a bump with its evidence — *"two `feat` and a `fix`, so minor"* — and I decide. Manual
gets forgotten; fully automatic decides things it shouldn't. The version bump and the CHANGELOG
entry land **in the feature PR**, not in a separate release commit, so the change and its
description are reviewed together.

A release is then just: tag, publish a GitHub Release, and let CI do the rest.

## The npm package publishes itself, and proves it

The npm package *is* the product — `npm install -g pagevault` stands PageVault up on your own
Cloudflare account with no clone ([ADR-014](../adr/ADR-014-installed-product-not-thin-client.md)).
That raises an honest problem: the package asks for a Cloudflare API token and ships a **prebuilt
Worker bundle nobody is going to read**. "Trust me" is not good enough.

So the publish is arranged to be checkable by someone who has never met me:

- **OIDC trusted publishing.** No npm credential exists in this repo. npm exchanges a short-lived
  identity token with GitHub at publish time, so there is no long-lived secret to leak or rotate.
  The token-based fallback is written down in the workflow's header and deliberately not used.
- **Build provenance** (`npm publish --provenance`). Every published version carries a signed
  attestation tying the tarball to the exact workflow run and commit that produced it. That's the
  verified badge on the npm page, and it is the closest thing to "you don't have to trust me, check
  it yourself."
- **A guard against publishing the wrong thing.** The workflow refuses if the release tag and
  `cli/package.json` disagree — the failure mode that publishes a version number that can never be
  reused, since npm won't let you re-publish one.
- **`prepublishOnly` runs the tests and the pack-and-install smoke again.** A broken package cannot
  ship even if I've done something careless with a tag.

The Worker bundle itself is built during `prepack` from source, so the thing in the tarball is
compiled from the code in the repo at that commit — which is exactly what the provenance
attestation asserts.

## It runs on itself

The [public showcase](https://pagevault.danjamkuhn.com/pub/showcase) — including the
[competitive comparison](https://pagevault.danjamkuhn.com/pub/showcase/72i8672763d7) and the
[feature walkthrough](https://pagevault.danjamkuhn.com/pub/showcase/wbhjcerqb8vc) — is served
*through PageVault*, into the same sandbox every other document gets. The documentation is also the
demo. If a claim on the site were false, the site would be the thing that broke.

## What this repo is trying to show

Two things, really. One: you can build a genuinely small, auditable product with an agent, if you
put the discipline in the repo instead of in your head. Every practice above is a file someone else
can read — the ADRs, the plans, the issue labels, the lifecycle skill, the three workflows, the
checks that fail the build. None of it lives in my memory or in a chat log, which is the only reason
it survived the sessions that produced it.

Two: the honest version of a thing — including the plans that changed, the comparison rows where the
alternatives win, and the checks that turned out to be lying — reads as confidence, not weakness.
That's the whole approach, and it's all here to copy.

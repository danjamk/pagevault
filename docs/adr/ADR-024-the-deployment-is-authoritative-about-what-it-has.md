# ADR-024 — The deployment is authoritative about what it has

**Status:** Accepted
**Date:** 2026-08-09
**Extends:** [ADR-021](ADR-021-a-deployment-is-a-named-thing.md), which made a deployment a named
thing commands resolve; this says the named thing also answers questions about itself
**Closes:** #187

## Context

`.pagevault.json` is the **build record** — rung, host, account, KV ids, AUDs, group id. ADR-021
established that it names which deployment you are acting on. Provisioning also treated it as the
authority on *what that deployment has*, and those are not the same claim.

View tracking resolved like this:

```js
let analytics = opts.analytics ?? ctx.analytics;
if (analytics === undefined) analytics = isInteractive() ? ask() : false;
```

Every step is defensible. A flag beats a file; a file beats a guess; a guess that fails open beats a
deploy that dies on an optional feature nobody asked for. The composition is still wrong, because it
answers an unasked question with a default and then **acts on it destructively**.

Production is deployed by CI, which reconstructs `.pagevault.json` from a base64'd secret. That
secret was captured before view tracking existed, so it carried no `analytics` field. Every prod
deploy therefore read silence as "off", stripped the Analytics Engine binding from the generated
config, and shipped a Worker structurally incapable of recording anything. It was never on. No deploy
would ever have turned it on. The only evidence was one line — `✓ View tracking: off` — in a deploy
log nobody reads.

What made it survive is that **everything downstream agreed**. `views` reported zero for every
document. `sync-views` succeeded, synced nothing, and said so cheerfully. The staleness alarm
reported zero days of history at risk, because zero days had been recorded. [#185](../../issues/185)
fixed the reporting half — a deployment that cannot measure now says so rather than returning a
measured-looking zero. This ADR is about the cause.

### The generalisation

Nothing here is specific to analytics. Every optional binding has the same shape:

- `BROWSER` (PDF export, [ADR-022](ADR-022-the-pdf-is-a-capture-of-the-viewer.md))
- `ANALYTICS` (view tracking, [ADR-015](ADR-015-what-a-view-record-contains.md))
- `CF_API_TOKEN` + group id (email-secured sharing, [ADR-002](ADR-002-seat-bounding.md))

Each is optional by design and each degrades off silently and correctly at runtime — which is exactly
what makes losing one invisible. A deploy that drops a capability produces no error, no warning, and
no behavioural difference until someone asks a question the missing data would have answered.

## Decision

**Declared intent is not authoritative about capabilities. The running deployment is.**

Three parts.

### 1. The live binding sits in the precedence chain

```
flag on this run  →  declared intent (.pagevault.json)  →  what the deployed Worker binds  →  prompt / default
```

`deployedBindings(accountId)` reads the Worker's actual bindings over the Cloudflare API, using the
credential provisioning already holds. A deployment that has already answered the question keeps its
answer — in CI, on a rebuilt config, with nobody re-stating it and no secret to edit.

This is the part that actually fixes #187. A refusal alone would have sat in the path of every
production deploy and still required a human to resolve it, every time, forever.

### 2. Unknown is a third value, and it never destroys anything

`deployedBindings` returns `null`, not `false`, when it cannot find out — a first-ever deploy with no
script, a token that can deploy but not read script settings, a network blip. Unknown falls back to
the previous behaviour and can never strip a binding.

Collapsing unknown into "has nothing" would strip capabilities on a bad connection. That is a worse
bug than the one being fixed, and it is the same error in a different coat: treating an absence of
information as information.

### 3. Turning a capability off requires saying so on this run

With the live reading in the chain, exactly one contradiction remains: something here says off while
the Worker says on. That cannot be settled by guessing — honour the file and days of history stop
existing; honour the Worker and an explicit instruction is ignored — so it stops and names both
options.

The override is a flag on *this* run (`--no-analytics`, `PAGEVAULT_ANALYTICS=off`), not a value in a
file. A file can be stale, restored, or reconstructed from a secret written months ago. An argument
typed today cannot be any of those things.

### And every deploy says where its answer came from

`off` printed with no provenance reads as a decision when it was a silence. The line now names its
source: a flag, the intent file, the live Worker, or a default with nothing to go on.

## Consequences

- Rung-3 provisioning makes one additional read-only Cloudflare API call per deploy.
- Provisioning now depends on the deploy credential being able to read script settings. It degrades
  to `null` if not, so this is a soft dependency — but a deployment behind a very narrow token loses
  the protection without being told, which is the residual weakness of this design.
- **A capability can still be dropped by deleting the binding from the committed template.** This
  covers the generated-config path, not a fork editing `wrangler.jsonc`. That is correct — a fork
  deleting a block is a decision, not an omission.
- Rung 1–2 is not covered: `tier0.mjs` writes its config without consulting any of this and binds
  Analytics Engine unconditionally ([#190](../../issues/190)). The same rule should reach it.

## Alternatives considered

**Detect and refuse, without changing precedence** — what #187 originally asked for. Rejected as the
primary mechanism: it turns every prod deploy into a prompt for a question the deployment can already
answer, and a gate that fires on every run is a gate that gets scripted around. Kept as the backstop
for the genuine contradiction, where there is nothing to infer from.

**Make the live binding authoritative outright**, above declared intent. Rejected: it makes turning a
capability *off* impossible through the intent file, and inverts the relationship for the one
direction — enabling something for the first time — where the file is the only source.

**Write the resolved answer back into the CI secret.** Rejected: a deploy job that rewrites its own
credentials is a considerably worse idea than the bug.

**Warn loudly instead of refusing.** Rejected for the contradiction case only. A warning in a CI log
is exactly the signal that failed here — `✓ View tracking: off` was, in effect, that warning.

## References

- [#187](../../issues/187) — the cause; [#185](../../issues/185) — the reporting half
- [#190](../../issues/190) — the rung 1–2 gap this does not close
- `cli/lib/provision/provision.mjs` — `resolveAnalytics`, the policy in one pure function
- `cli/lib/provision/context.mjs` — `deployedBindings`, `analyticsChoice`
- `docs/engineering/deploy-prod.md` — turning view tracking on or off from CI

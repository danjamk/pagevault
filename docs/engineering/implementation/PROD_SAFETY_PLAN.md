# Operating production safely from this machine

Status: proposed · 2026-08-10 · targets 0.38.x

Makes `test` a sandbox you can act in without thinking, and `prod` something you can
operate from the same laptop without being one wrong directory away from an accident.

## Why now

PageVault is about to change what it is used for. Development work is nearly done;
the next year is mostly *operating* a production deployment holding real client
deliverables. The guardrails were designed while the risk was "a broken deploy" and
are being asked to carry "a destroyed engagement record."

Two things forced this:

**The prod write, 2026-08-10.** Running `pagevault verify` from `/tmp` — to prove a
cwd-independence fix — published a document to production. Nothing malfunctioned:

```
"deployment":       "https://pagevault.danjamkuhn.com",
"deploymentName":   "prod",
"deploymentSource": "current",      ← the registry's default
"provisioned":      false
```

`prod` is registered *and* is this machine's default. Outside a checkout there is no
marker to override it, so `current` won. ADR-021 worked exactly as designed. The
failure was that **`verify` writes and nothing anywhere treats it as a write** — it
sits beside `status` and `health` in the help, the docs, `lib/ops/`, and the
permission allowlist. Four signals, all independently reasonable, together making a
publish look like a ping.

**Disaster recovery is unreachable.** `backupCmd` takes its account from
`ctx.accountId` only — the local build record. There is a `--kv` flag and **no
`--account` flag**. This machine's build record describes `test`; prod is a different
Cloudflare account. So there is no flag combination that backs up or restores
production from here. That is not a deliberate safety choice; it is a missing
parameter.

## The shape of the answer

Three layers, because no single one of them is sufficient:

| Layer | Controls | Fails if |
|---|---|---|
| **Addressing** | which deployment a command resolves to | a default silently points at prod |
| **Confirmation** | whether a destructive act proceeds | the token that satisfies it is one an agent emits by habit |
| **Harness** | what an LLM can invoke at all, in any directory | the rules are project-scoped |

The current design has only the middle layer, and it covers 5 of ~14 write commands.

## Decision 1 — a protected deployment is never the ambient default

**The core change.** Today `registry.current = "prod"` means every directory that is
not the repo resolves to production. That is fail-open.

A `protected` deployment may be reached only by **naming it**:

| How it was reached | Allowed |
|---|---|
| `--deployment prod` | yes |
| `PAGEVAULT_DEPLOYMENT=prod` | yes |
| standing in a checkout whose build record is prod | yes |
| resolved via `current` | **refused** |
| resolved via the login config | **refused** |

Refusal names the command to type. One check, in `commandTarget()`.

**Why this rather than more confirmations.** It kills a class instead of a list.
From `/tmp` every command refuses — `verify`, `publish`, `edit`, and the ones not
written yet. The `verify` incident happened precisely because the dangerous command
was not on anybody's list of dangerous commands, and no list maintained by hand will
be complete on the day it matters.

It also produces the working model we actually want: **inside the repo, zero friction
against test; production costs eight characters, from anywhere, always.**

**Scope caveat.** Applied unconditionally this punishes the single-deployment
operator who marks their only deployment protected — they would name it on every
command for no benefit, since there is nothing else it could have meant. Gate the
rule on `protected AND the registry holds more than one deployment`. Revisit if that
proves too clever.

### Explicitly rejected: direnv

Considered and dropped. CWD-ascent already is the context indicator — standing in the
repo resolves to test through the build record, which is the fact direnv would
restate. And `PAGEVAULT_DEPLOYMENT` outranks `marker` in the resolver, so a stale
`.envrc` would silently beat the build record: a new way to be wrong in the one place
currently right.

The decisive objection is that direnv only acts where a `.envrc` exists. The danger
is everywhere it does not — `~`, `/tmp`, a client folder. **You cannot make the
absence of a file safe by adding a file.**

## Decision 2 — `--yes` and "I mean production" become different words

`--yes` currently carries two meanings that have merged: *do not prompt* (CI, cron)
and *I accept the protected gate*. That merge is why a scripted `pagevault upgrade
--yes` passes a guard it never considered.

- **`--yes`** stays, and means non-interactive only. It **stops satisfying
  `protected`.**
- **`--confirm <name>`** is the protected acknowledgement — type the deployment's
  name. Not muscle memory, not a blanket `-y`, and a model must produce the *right*
  string rather than a generic affirmative.

**Rejected: removing `--yes`.** It would break production's CI deploy and the
`sync-views` schedule, both of which are legitimately non-interactive.

**Rejected: temporarily setting `protected: false`.** It leaves *persistent weakened
state*. The flag gets flipped, the work happens, and the flip-back is forgotten —
silently, with no error at any point. `--confirm` is per-invocation and self-healing.

### The tiers, after this

| Tier | Commands | Gate |
|---|---|---|
| free | `list` `read` `search` `link` `portals` `status` `health` `views` `export` | none |
| ordinary write | `publish` `edit` `share` `mint` `portal-create` `sync-access` `sync-views` | addressing only |
| destructive | `rm` `revoke` `rotate` `portal-delete` `upgrade` | `--confirm <name>` |
| severe | `destroy` `restore` | interactive only, type the hostname, **no** non-interactive path |

Publishing stays out of the confirmation tiers on purpose. Publishing to production is
the *normal* case (ADR-021 §6) and a prompt answered daily is answered by reflex.
Addressing is what protects it.

## Decision 3 — `verify` gates its publish, not itself

`verify` does not join the destructive tier. Its read-only checks are exactly what you
want to run against production freely and often.

Only the sample publish becomes opt-in on a protected deployment: it is skipped unless
`--publish` is passed, and it says so. Today's incident dies; the diagnostic survives.

## Decision 4 — the harness rules move to user level

🔴 **The current setup is backwards, right now.** `.claude/settings.json` is
project-scoped, so every gate added on 2026-08-10 — `destroy`, `restore`,
`sync-views` → ask — applies **only inside `~/yukon/pagevault`**.
`~/.claude/settings.json` holds no PageVault entries at all.

An agent working in any other directory therefore has *fewer* restrictions on
production than one working in the repo.

In `~/.claude/settings.json`, using `deny` (which beats both `ask` and `allow`):

- `deny` on `pagevault destroy` · `restore` · `rm` · `portal-delete` · `upgrade` · `init`
- 🔴 **`deny` on Write/Edit to `~/.pagevault/**`**

The second is load-bearing. If a model can edit `deployments.json` it can clear
`protected` itself, and every guard above becomes theatre. It is also why "flip the
config flag" was rejected as the escape hatch in Decision 2 — an escape hatch that
lives in a file the agent can write is not one.

## Decision 5 — `backup` and `restore` gain `--account`

The blocker is a missing parameter, not a policy. With it:

- **`backup`** needs only `Account · Workers KV Storage · Read` — narrow,
  non-destructive, and safe to hold on the laptop. This is what makes local disaster
  recovery possible without CI.
- **`restore`** needs Edit, and joins the severe tier: interactive only, type the
  hostname.

**Rejected: running backup/restore from CI.** It was the safer answer while this
machine held no production credential, but it makes recovery depend on GitHub being
up during an incident and removes the ability to snapshot before a risky change. The
operator asked for local operation; a KV-read-only token is a proportionate way to
give it.

## Work, in order

**P0 — closes the class of bug that occurred**

1. Protected ⇒ never the ambient default (`commandTarget`), with the
   more-than-one-deployment scope caveat. Tests: reached via `current` refuses;
   reached by name succeeds; a marker for that deployment succeeds; single-deployment
   installs unaffected.
2. `verify`'s sample publish becomes opt-in on a protected deployment.
3. User-level `deny` rules, including `~/.pagevault/**` writes. *(Outside the repo —
   Dan applies this; it is not a repo change.)*

**P1 — unblocks production operations**

4. `--account` on `backup` and `restore`.
5. `--confirm <name>`; `--yes` stops satisfying `protected`. Migration note in the
   CHANGELOG — this breaks any script relying on `--yes` against a protected
   deployment.
6. `restore` moves to the severe tier.

**P2**

7. An ADR. This is a coherent model with several rejected alternatives, and without a
   record the rejections get re-litigated — particularly direnv and "just remove
   `--yes`".

## Open questions

- **Does the addressing rule apply to reads?** Written above as all-commands, which is
  simplest and most defensible. A softer variant lets reads resolve through `current`
  and only writes require naming. Simpler is better here until it hurts.
- **Should `mint` be in the destructive tier?** It widens access rather than
  destroying, and MCP already warns about it. Probably not, but it is the closest call
  in the table.
- **Duplicate identity, unverified.** `verify` published with `confirm: true`, which
  should update in place, and instead created a second document at the same
  `(portal, filename)` on production. That is #74's shape. Reproduce on test before
  filing — the pre-existing record dates to 2026-07-17 and may be a legacy row whose
  key metadata never carried `name`.

## References

- ADR-021 §6 — `protected` gates destruction, not writing; and why a per-write prompt
  was rejected
- ADR-002 / #38 — the prod credential is deliberately not on this machine; the
  property that kept the 2026-08-10 incident to one document
- ADR-026 — MCP creates and shares, it does not destroy; the same asymmetry one
  surface over
- #144 / #155 — the client-only install, and why `init` is the wrong advice on it

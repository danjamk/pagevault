# ADR-021 — A deployment is a named thing, selected by where you stand

**Status:** Accepted
**Date:** 2026-08-05
**Extends:** the #38 credential model (`docs/engineering/deploy-prod.md`), which this does not
replace so much as finish
**Closes:** #144, #145, and the targeting half of #150

## Context

PageVault has two files that describe a deployment, and they answer different questions:

| File | Written by | Records |
| --- | --- | --- |
| `.pagevault.json` | `init`, `setup`, `deploy` | the **build record** — rung, host, accountId, kvId, oauthKvId, both Access AUDs, groupId, deployedUrl |
| `config.json` | `login`, `init` | the **client credential** — url, bearer |

Keeping those distinct is right. You can hold a login for a deployment you did not build, and that
is a legitimate configuration rather than a degraded one — it is what an operator has when
production deploys from CI.

The mistake is not two kinds of data. It is that **there is no first-class concept of a
deployment**, so both files independently answer *"which deployment am I acting on?"* and every
command picked whichever file happened to hold the field it needed:

- `verify` takes the **URL** from `.pagevault.json` and the **bearer** from `config.json` —
  straddling both, inconsistently, inside one function.
- `views --sync` takes the **account** from `.pagevault.json` and **POSTs** through `config.json`,
  so it can read one deployment's analytics and write the summary to another.
- `sync-access` is presented as an operator command but reads **only** `config.json`.
- `status` reads **only** `.pagevault.json` and reports a working install as "not configured".

Four commands, four different answers to one question. Nobody decided that; it accreted.

### Why the existing model stopped covering us

The #38 model is credential-scoped safety, and on its own terms it works:

> The prod credential is **never on your laptop**. A wrong-clone `make deploy` can't touch prod
> because the machine simply doesn't hold the prod token.

That protects every command that needs a **Cloudflare** token — `deploy`, `destroy`, `backup`,
`restore`. It says nothing about the **bearer**, which is what `publish`, `rm`, `revoke`,
`sync-access` and `views --sync` use.

The moment a laptop holds a production bearer — which is the correct setup for operating a
CI-deployed deployment, and which `pagevault login` exists to create — the #38 guarantee stops
covering the surface an operator touches every day. The model was not wrong. It was written when
one machine held one deployment, and it was never extended when that stopped being true.

This is not hypothetical. During the 0.28.0 lifecycle run, `sync-access` was pointed at production
from a checkout working against test. It happened to be read-only that time. `views --sync` in the
same position would have written a near-empty summary and zeroed production's view counts, making
every document report a *measured* zero over MCP — the exact lie `syncViews` refuses to permit
twelve lines earlier when it rejects `--portal`.

## Decision

### 1. A deployment is a named record

Credentials and build state live together, in one place, outside any repo:

```jsonc
// ~/.pagevault/deployments.json   (0600)
{
  "current": "prod",
  "deployments": {
    "prod": { "url": "https://pagevault.example.com", "token": "…", "protected": true },
    "test": { "url": "https://pagevault.test.example", "token": "…",
              "accountId": "…", "rung": 3, "host": "…", "kvId": "…" }
  }
}
```

Provisioning fields are **optional fields on a deployment**, not a separate file. A deployment you
did not provision simply has no `accountId` — a fact about it, not an error state. That is what
dissolves #144: `status` can say *"prod · connected · not provisioned from this machine"* because
the model can finally express it.

#### The Cloudflare credential does not move

One exception, and it is not negotiable. `CLOUDFLARE_API_TOKEN` and `CF_RUNTIME_TOKEN` stay in
`.env.local`, **per clone**, because that placement *is* the #38 safety property:

> The prod credential is never on your laptop. A wrong-clone `make deploy` can't touch prod because
> the machine simply doesn't hold the prod token.

A global registry holding production's Cloudflare token would put it back on the laptop and undo
the one guarantee that has been working. So the registry holds **url, bearer, and build metadata**;
the credential that can create and destroy infrastructure stays where a wrong clone cannot reach
it.

That the bearer *does* move is the point of this ADR: the bearer was never covered by #38, and
that gap is the bug.

### 2. Selection is by where you stand

Resolution order, identical for every command and every front door:

```
--deployment <name>          explicit, wins always
PAGEVAULT_DEPLOYMENT         environment (direnv, CI, a one-off export)
nearest project marker       walking up from CWD
current                      the global default
```

The **project marker** is a `deployment` key in `.pagevault.json`, found by walking up from the
working directory the way `git`, `npm` and `direnv` locate theirs. Standing anywhere inside the
PageVault checkout selects `test`; standing anywhere else selects `prod`. No flags, no discipline,
no memory required.

This deliberately replaces `RUNNING_FROM_REPO` as the *targeting* signal. That constant keys on
where the **code** lives (under `node_modules` or not), which is why a globally installed
`pagevault` run from inside the repo folder targets production today while `node cli/bin/pagevault.mjs`
in the same directory targets test. Keying on where the **user** is standing makes `make` and
`pagevault` agree, which is the property that makes the guardrail trustworthy.

`RUNNING_FROM_REPO` keeps its other jobs — choosing `make` versus `pagevault` in hints, and
locating the Worker template.

### 3. The marker names a deployment; it never holds a credential

`.pagevault.json` in a checkout becomes a pointer:

```json
{ "deployment": "test" }
```

Credentials stay in `~/.pagevault/deployments.json` at mode 0600, outside every repo, one copy.
No bearer is ever written into a repository working tree — not even a gitignored one, because a
gitignore is one `git add -f` or one careless archive away from being wrong.

#### The reader discriminates on content, and keeps accepting the old shape

`.pagevault.json` is not only written by humans. `deploy-prod.yml` **reconstructs it from a
base64 GitHub secret** on every production deploy:

```yaml
- name: Restore .pagevault.json (prod intent)
  run: printf '%s' "$PAGEVAULT_PROD_CONFIG" | base64 -d > .pagevault.json
```

So the file's build-record shape is baked into a secret and a workflow, and a reader that assumed
the pointer shape would break production deploys with no local reproduction. The reader therefore
discriminates on **content**:

| The file contains             | Read as                                                               |
| ----------------------------- | --------------------------------------------------------------------- |
| `deployment: "<name>"`        | a pointer into the registry                                           |
| `rung` / `accountId` / `host` | a build record — an implicit deployment, scoped to where it was found |

CI needs no change, the secret stays valid, and an operator who never migrates keeps working
indefinitely. Support for the build-record shape is permanent, not a deprecation window.

This has a large consequence: because a build record found by CWD-ascent *is* a deployment, the
selection rule in (2) works with **no new file and no migration**. Standing in a checkout resolves
to what that checkout provisioned; standing anywhere else resolves to the global login. The
registry becomes a convenience for a third deployment rather than a prerequisite for correct
targeting.

### 4. Every command states its target, on stderr

Before acting, every command prints the deployment it resolved and why:

```
→ test (project: ~/yukon/pagevault)
```

On **stderr**, never stdout. `publish`, `link`, `mint` and `rotate` print only a URL to stdout so
`pagevault publish report.html | pbcopy` does the obvious thing; that contract is not weakened to
carry a status line.

### 5. No per-write confirmation prompt

Determinism replaces the guard. A prompt exists to resolve ambiguity, and after (2) there is no
ambiguity left to resolve: the deployment is a function of where you are standing, and it was
printed before the command ran.

A prompt would also be actively harmful here. Publishing to production is the *normal* case, so a
confirmation on every write would be answered reflexively within a day — and it would break
non-interactive use from CI, scripts and MCP, where there is nobody to ask.

### 6. `protected: true` gates destruction, not writing

A deployment may be marked `protected`. On a protected deployment, the commands that **destroy**
— `rm`, `revoke`, `rotate`, `destroy` — require an explicit `--yes`. Publishing, editing and
sharing are unaffected.

This is the narrow, declarative version of the guardrail: it is set once on production, it costs
nothing on test, and it does not train anyone to hit `y` without reading.

## Rollout

The registry is the end state, not the first step. Because a build record found by CWD-ascent is
already a deployment, correct targeting arrives before any file changes shape:

| Phase | Contents                                                                                                              | Risk     |
| ----- | --------------------------------------------------------------------------------------------------------------------- | -------- |
| **1** | A reader that understands both shapes, CWD-ascent, one `resolveTarget()`. No file rewritten, no command changed.      | low      |
| **2** | Commands use the resolver; each states its target on stderr; the interim #145 guard is deleted; `protected` lands.    | low      |
| **3** | `deployments.json`, `pagevault use` / `deployments`, and an **opt-in** `migrate`. Only needed for a third deployment. | deferred |

### Migrating, when it is finally run

**Never merge diverging sources.** When `.pagevault.json` and `config.json` name different
deployments — the normal state on a machine operating a CI-deployed production instance from a
checkout — combining them produces a record holding production's url and bearer beside test's
`kvId` and Access AUDs. `publish` would reach production while `destroy` targeted test's KV. So
divergence produces **two** deployments and a message saying so, never one.

**Names come from the hostname**, lowercased and verbatim. No label parsing: the registrable-domain
problem is already open as #138, and a migration is the wrong place to meet it. `migrate` prints the
`rename` commands so `test` and `prod` are one step away.

**Write order matters, because `.pagevault.json` is the only copy of `kvId`, both AUDs and
`groupId`** — lose it and a deployment can still serve but can no longer be torn down cleanly:

1. copy `.pagevault.json` to `.pagevault.json.pre-adr021`, never removed automatically
2. write `deployments.json`, fsync, and **read it back to verify**
3. only then rewrite the marker

A crash at any point leaves a working system: before (3) the original file is still authoritative,
and the backup survives regardless.

**Explicit, never automatic.** The `MIGRATIONS` machinery in `context.mjs` has never run in anger —
`SCHEMA_VERSION` is still 1 and the array is empty. Its debut should not be silently rewriting the
file that knows how to destroy infrastructure.

## Consequences

**#144 dissolves.** There is no fallback chain and no "configured: false" on a working install.
A deployment with a login and no build record is a normal deployment with fewer fields.

**#145 becomes unrepresentable.** A command resolves one deployment and reads every field from it,
so no command can read an account from one and write to another. There is no collision to guard
and no `--url` override to remember.

**The lifecycle incident could not recur.** The command would have printed `→ prod` before acting.

**`PAGEVAULT_HOME` generalizes.** Its comment already says it exists so that "one machine [can]
hold several deployments cleanly" — the same idea, expressed with directories instead of names.
It stays as an escape hatch, and remains what the test suite uses for isolation.

**Migration.** Existing installs collapse to a single deployment named `default`, composed from the
current `config.json` and `.pagevault.json`. The `.pagevault.json` schema-version machinery in
`cli/lib/provision/context.mjs` exists for exactly this. Repo checkouts keep working: an existing
`.pagevault.json` with build state and no `deployment` key registers itself as a named deployment
on first run and is rewritten as a pointer.

**`docs/engineering/deploy-prod.md` needs revising.** "PageVault has no 'environment' concept baked
into the product" stops being true. The credential split it describes stays exactly as it is —
prod's Cloudflare token still lives only in CI — but the claim that environment is *only* an
artifact of the active token was already false the day a laptop held a prod bearer.

**One deployment per Cloudflare account remains true.** This ADR is about one operator addressing
several deployments, not about multi-tenancy. Prime directive #1 is untouched.

## Alternatives considered

**A precedence table plus collision guards** — keep both files, define which wins, and refuse to
write when they disagree. This was the first proposal and it is a bandage: it institutionalizes two
files pretending to be one, and every future command has to remember to consult the guard. It
treats ambiguity as a thing to detect rather than a thing to remove.

**direnv only.** `PAGEVAULT_DEPLOYMENT` is supported precisely so direnv works for anyone who wants
it, but it cannot be the mechanism. It is an external dependency, it is per-machine setup, and a
guardrail that has to be installed separately is not a guardrail — it is a suggestion.

**A confirmation prompt on every write.** Rejected in (5): wrong layer, breaks automation, and
prompt-blindness sets in fast on the operation you perform most.

**Putting credentials in the project marker.** Rejected in (3). Symmetry with `.env.local` is
tempting, but a bearer in a working tree is one `git add -f` from a public repository.

## References

- #144, #145, #150 — the symptoms this is drawn from
- #38, `docs/engineering/deploy-prod.md` — the credential model this extends
- ADR-014 — installed, not cloned: the installed package is the product, so its ergonomics are
  the product's ergonomics
- `cli/lib/provision/context.mjs` — `stateDir()`, `RUNNING_FROM_REPO`, the schema migrations
- `cli/lib/client.mjs` — `CONFIG_PATH`, `loadConfig`, `requireConfig`

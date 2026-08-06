# How I ship my production (an example, not the deploy story)

> **This page is how *I* run PageVault's own production.** It is one operator's rig, written down
> so it's reproducible — not something you need to copy. `make setup && make deploy` already deploys
> to whichever Cloudflare account your `.env.local` token points at; that's the entire deployment
> story for a fork.
>
> What this page adds is a *separate* production account shipped through CI, so the prod credential
> never lives on my laptop. `.github/workflows/deploy-prod.yml` is that machinery. Delete it in a
> fork and nothing breaks. Read on if you want a pattern for the same split; otherwise skip it.

## The model: two credentials, and one of them never lands on your laptop

There's one Worker, one hostname, one KV namespace per deployment. What separates dev from prod is
**which Cloudflare account the active token targets**:

| | Credential lives in | Who can deploy |
|---|---|---|
| **Dev** | `.env.local` in a working clone | you, locally — every `make deploy` hits dev |
| **Prod** | a GitHub Environment secret | only this CI job |

The point is the split: the prod credential is **never on your laptop**. A wrong-clone `make
deploy` can't touch prod because the machine simply doesn't hold the prod token. One account per
environment — never two PageVault deployments in one account.

### What this covers, and what it does not

This protects every command that needs a **Cloudflare** token — `deploy`, `destroy`, `backup`,
`restore`. It says nothing about the **bearer**, which is what `publish`, `rm`, `revoke`,
`sync-access` and `views --sync` use. The moment a laptop holds a production bearer — which is the
correct setup for operating a CI-deployed deployment, and what `pagevault login` exists to create —
this split stops covering the surface you touch every day.

That gap is what [ADR-021](../adr/ADR-021-a-deployment-is-a-named-thing.md) closes, so the product
now *does* have a deployment concept: `~/.pagevault/deployments.json` holds a **named** deployment
per url + bearer, and every command resolves exactly one of them — by `--deployment`, by
`PAGEVAULT_DEPLOYMENT`, by the checkout you are standing in, or by the default `pagevault use` set.
See [the CLI reference](../setup/cli-reference.md#several-deployments-on-one-machine).

**The Cloudflare credential does not move.** `CLOUDFLARE_API_TOKEN` and `CF_RUNTIME_TOKEN` stay in
per-clone `.env.local`, deliberately, because that placement *is* the guarantee above. A global
registry holding production's Cloudflare token would put it back on the laptop and undo the one
thing that has been working. The registry holds url, bearer and build metadata — never the
credential that can create or destroy infrastructure.

## One-time: bootstrap prod, then hand the keys to CI

CI reconstructs prod's `.pagevault.json` from a secret, so prod has to be **provisioned once**
before CI can redeploy it. Do that in a throwaway checkout, capture the state, then remove the
prod token from your machine:

1. In a scratch clone, put the **prod** account's token in `.env.local`
   (`CLOUDFLARE_API_TOKEN=…`), plus `CF_RUNTIME_TOKEN=…` for the scoped runtime secret.
2. `make setup` → walk it up to rung 3, then `make deploy`. This creates prod's KV namespace,
   Access apps, and viewer group, and writes a complete `.pagevault.json`.
3. Capture that file as the config secret (below), and set the three GitHub secrets.
4. **Delete the scratch clone** (or at least remove the prod token from its `.env.local`). From
   here on, prod is CI's job.

## The three GitHub Environment secrets

Settings → Environments → **`production`** → add:

| Secret | What it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the prod account's provisioning token (broad — deploy-time) |
| `CF_RUNTIME_TOKEN` | the scoped runtime token → becomes the Worker's `CF_API_TOKEN` (ADR-002 group sync) |
| `PAGEVAULT_API_TOKEN` | the prod bearer for CLI/MCP. Used only to *set* the secret on a first-ever prod deploy; once the Worker has it, deploys reuse it and never rotate |
| `PAGEVAULT_PROD_CONFIG` | prod's `.pagevault.json`, base64'd (see below) |

Scoping them to the `production` environment — not the repo — keeps them out of reach of `ci.yml`
and any other workflow. On a **public** repo, environment secrets and the required-reviewer gate
are both free; no paid plan needed.

Capture the config secret from your bootstrapped clone:

```bash
base64 -i .pagevault.json | pbcopy   # macOS — paste as PAGEVAULT_PROD_CONFIG
```

## Deploying

Actions → **Deploy to production** → **Run workflow**. That's the only trigger — manual, on
purpose. Tagging a release does **not** ship prod; version is decoupled from deployment
(ADR-010). If you added yourself as a required reviewer on the environment, you'll approve the run
before it proceeds (a deliberate *are-you-sure*, not real four-eyes on a single-operator repo).

What the job does, in order:

1. **Reconstructs `.pagevault.json`** from `PAGEVAULT_PROD_CONFIG`.
2. **Backs up prod KV** (`pagevault backup`, the same command `make backup` runs) and uploads it
   as the `prod-kv-backup` artifact — your restore point, kept 30 days.
3. **Deploys** via `cli/lib/provision/deploy.mjs` — the same script `make deploy` runs, no forked logic. Its
   prompts auto-skip when stdin isn't a TTY. The bearer is reused from the Worker; only a
   first-ever prod deploy sets it from the secret.
4. **Verifies the build** (`pagevault health`, the same command `make health` runs): asserts `/health` reports the exact
   `<version>+<sha>` this commit produced. A stuck or partial rollout fails the run instead of
   going green.

## If a deploy goes wrong

Download the `prod-kv-backup` artifact from the run, then restore it into prod's namespace from
your bootstrap clone:

```bash
pagevault restore pagevault-backup-prod.json --force
# from a clone: make restore FILE=pagevault-backup-prod.json FORCE=1
```

Redeploy an older commit the same way you deploy any commit: check it out and run the workflow
from that ref (or locally against prod if you still hold the token). `make health` — the same
check CI runs — tells you at any time whether the live deployment matches your checkout.

## Rotating `PAGEVAULT_API_TOKEN`

`/api` and `/mcp` authenticate with a **static bearer** — no session, no expiry, no refresh
([ADR-006](../adr/ADR-006-remote-mcp.md)). Nothing renews it, which means **rotating it breaks every
client that holds the old one, silently and all at once.** There is no error that says "rotated";
the client just starts getting 401s, which reads exactly like an expired session that won't
renew — and that is how it was misdiagnosed once already.

Rotating also reaches further than the bearer itself. The console session key and the viewer
capability key are both **derived one-way from `PAGEVAULT_API_TOKEN`** (`worker/src/token.ts`), so
the blast radius is:

| | After a rotation |
|---|---|
| MCP/CLI clients holding the **bearer** | **Broken** until re-set by hand — one at a time |
| MCP clients connected over **OAuth** | Unaffected. Their tokens live in `OAUTH_KV`, not derived from this one |
| Open **console** sessions | Invalidated. ~15-minute TTL anyway; re-opening `/admin` re-mints |
| In-flight **`?cap=`** render tokens | Invalidated. ~10-minute TTL; a page reload fixes an open tab |
| Existing **`/p/` public links** | **Survive.** The token is a KV key, not derived from the bearer |

### The runbook

1. **Set the new value on the Worker.** `wrangler secret put PAGEVAULT_API_TOKEN` against prod, or
   re-run the deploy workflow after updating the `production` environment secret. Note that a
   routine deploy will *not* rotate it — the workflow only sets the bearer on a first-ever deploy
   and reuses it afterwards, which is deliberate.
2. **Update the `production` environment secret** if you set it with wrangler, so the two do not
   drift.
3. **Re-set it in every client that held the old one.** This is the step with no shortcut:
   - **the claude.ai web connector** — the one that actually bit us, and the easiest to forget
     because it is not on your machine and shows no configuration you can grep;
   - **Claude Desktop** — its MCP config file;
   - **Claude Code** — `claude mcp remove` / `add` with the new header, or the stored config;
   - **the CLI** — `pagevault login --token <new>`, plus any `.env.local` that carries it;
   - anything bridged through `mcp-remote`, which passes the bearer as a header.
4. **Verify.** `pagevault health` from a machine you just updated, then open a chat surface and
   call one MCP tool. A green `health` with a still-failing connector means the connector, not the
   server — check the client before the deployment.

**A stale connector looks identical to a broken server.** If exactly one surface is failing, it is
the surface. Confirm by running the same call from a second client that you know holds the current
token, before touching prod.

> **On making the 401 self-explaining** — considered and declined. The Worker cannot tell a rotated
> token from a wrong one or a missing one, so a "may have been rotated" hint would be right
> sometimes and misleading the rest of the time. MCP clients surface the `WWW-Authenticate`
> challenge rather than the body anyway. The fix for this failure mode is this runbook existing,
> not a guess in an error response. ([#64](https://github.com/danjamk/pagevault/issues/64))

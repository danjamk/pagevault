# Shipping production through CI

> **Forking PageVault? You can ignore this whole page.** `make setup && make deploy` deploys to
> whichever Cloudflare account your `.env.local` token points at — that's the entire deployment
> story. This page and `.github/workflows/deploy-prod.yml` are maintainer tooling for running a
> *separate* production account behind CI. Delete the workflow file in a fork and nothing breaks.

## The model: environment is whichever token is active

PageVault has no "environment" concept baked into the product. There's one Worker, one hostname,
one KV namespace. "Dev" and "prod" are just **which Cloudflare account the active token targets**:

| | Credential lives in | Who can deploy |
|---|---|---|
| **Dev** | `.env.local` in a working clone | you, locally — every `make deploy` hits dev |
| **Prod** | a GitHub Environment secret | only this CI job |

The point is the split: the prod credential is **never on your laptop**. A wrong-clone `make
deploy` can't touch prod because the machine simply doesn't hold the prod token. One account per
environment — never two PageVault deployments in one account.

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
2. **Backs up prod KV** (`scripts/kv-backup.mjs`) and uploads it as the `prod-kv-backup`
   artifact — your restore point, kept 30 days.
3. **Deploys** via `scripts/deploy.mjs` — the same script `make deploy` runs, no forked logic. Its
   prompts auto-skip when stdin isn't a TTY. The bearer is reused from the Worker; only a
   first-ever prod deploy sets it from the secret.
4. **Verifies the build** (`scripts/health-check.mjs`): asserts `/health` reports the exact
   `<version>+<sha>` this commit produced. A stuck or partial rollout fails the run instead of
   going green.

## If a deploy goes wrong

Download the `prod-kv-backup` artifact from the run, then restore it into prod's namespace from
your bootstrap clone:

```bash
make restore FILE=pagevault-backup-prod.json FORCE=1
```

Redeploy an older commit the same way you deploy any commit: check it out and run the workflow
from that ref (or locally against prod if you still hold the token). `make health` — the same
check CI runs — tells you at any time whether the live deployment matches your checkout.

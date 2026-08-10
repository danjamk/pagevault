# Operating a deployment you did not provision

Someone else stood this deployment up — CI, or another machine, or you six months ago on a laptop
you no longer have. You want to publish to it, read from it, and see whether anyone opened anything.

**Most of that works with one credential and no setup.** The part that doesn't is narrow, and this
page is mostly about saying which part.

This is a normal shape, not a degraded one. PageVault's own production is deployed by GitHub Actions
and operated from a laptop that has never deployed it.

---

## The one thing to get right first

⚠️ **Do not run `pagevault init` to "connect" to an existing deployment.** It is the setup command,
and it would provision *this* deployment *from this machine* — deploying your production Worker from
a laptop, over the one CI deploys. It reads like the connect command and it is the opposite of one.

The connect command is `login`:

```bash
pagevault login --as prod \
  --url https://share.example.com \
  --token <PAGEVAULT_API_TOKEN>
```

`--as` gives it a name, so this machine can hold several deployments at once and each command says
which one it acted on. The token is the deployment's **bearer** — the `PAGEVAULT_API_TOKEN` the
Worker holds as a secret. A Worker secret cannot be read back, so you need it from whoever set it:
the CI environment secret, or the machine that ran `init`.

Then confirm you are pointed at the right thing:

```bash
pagevault deployments     # everything this machine can reach; * is the default
pagevault status          # what this machine knows
pagevault health          # what the deployment says about itself
```

`status` will say **"Connected, but not provisioned from this machine."** That sentence is the whole
subject of this page, and it is correct.

---

## What works, and what needs more

| Command | Credential | Works without provisioning? |
|---|---|---|
| `publish` · `list` · `read` · `search` · `edit` · `rm` | the deployment bearer | **yes** |
| `link` · `revoke` · `rotate` · `portals` · `share` | the deployment bearer | **yes** |
| `status` · `health` · `verify` · `export` | the deployment bearer | **yes** |
| `views` — the default read | the deployment bearer | **yes** |
| MCP (`/mcp`, every tool) | the deployment bearer, or OAuth | **yes** |
| `views --live` · `views --who` | + a Cloudflare token · `Account Analytics · Read` | only if you add one |
| `sync-views` | + a Cloudflare token · `Account Analytics · Read` | only if you add one |
| `backup` · `restore` | + a wider Cloudflare token · `Workers KV Storage` | **no**, by design |
| `init` · `upgrade` · `destroy` | the provisioning token | **no**, and should not be |

The line those last rows are on: **anything that talks to your deployment goes through the bearer;
anything that talks to Cloudflare *about* your account needs a Cloudflare credential.** The bearer
reaches one Worker. A Cloudflare token reaches an account.

`init` / `upgrade` / `destroy` refuse here rather than failing halfway. That refusal is a feature —
see [ADR-021](../adr/ADR-021-a-deployment-is-a-named-thing.md).

---

## View history, without a Cloudflare credential

`pagevault views` reads a summary stored **inside your own deployment**, over `/api`, with the bearer
you already have. It works from here on day one.

```bash
pagevault views
pagevault views --by day
pagevault views --portal acme
```

**You see this data even though you never run the sync.** Whoever does run it — CI, in PageVault's
own case — writes the summary into the deployment you share, and you read it back out. Publishing
and remembering are the same act, and so are syncing and reading.

What you do *not* get from here:

- **`--live`** — what has happened since the last sync. That queries Analytics Engine directly.
- **`--who`** — the email addresses. The stored summary has never held an identity, deliberately
  ([ADR-019 §4](../adr/ADR-019-view-metrics-reach-mcp-by-sync.md)), so there is nowhere else to get
  one.

If neither matters, stop here. You are done.

### Adding the analytics credential

Only if you want `--live`, `--who`, or to run the sync yourself.

**You do:**

1. [Cloudflare → API Tokens](https://dash.cloudflare.com/profile/api-tokens) → *Create Custom Token*
2. Name it `pagevault-analytics`
3. One permission: **Account · Account Analytics · Read**
4. Scope it to the account the deployment lives in

That token is **strictly narrower than the deploy token**. It cannot deploy, cannot destroy, cannot
read KV, and cannot touch Access. It reads query results and nothing else.

Then name the account, because this machine has no build record to read it from:

```bash
export CLOUDFLARE_API_TOKEN=<the analytics token>
pagevault views --live --account <account-id>
```

The account id is on any page of the Cloudflare dashboard, in the URL and in the right-hand sidebar.

> **The Worker never gets this credential**, on any deployment. Its Analytics Engine binding is
> write-only, which is why no MCP tool can answer this and why the query runs on your machine
> ([ADR-015](../adr/ADR-015-what-a-view-record-contains.md) §6).

---

## If you are also the one who should be syncing

Someone has to run `pagevault sync-views` or the history stops accumulating, and Analytics Engine
forgets everything older than ~90 days with no error and no backfill.

If the deployment is deployed by CI, the sync belongs in CI — the credential is already there and
deliberately not on your laptop. If nobody is running it, that is a real gap:
[`scheduling-the-sync.md`](scheduling-the-sync.md) has working launchd, systemd, cron and GitHub
Actions setups.

`pagevault health` tells you where you stand, including how much runway is left.

---

## Backup and restore

These talk to Cloudflare's KV API directly, not to your deployment — KV key metadata is what listings
render from, and no PageVault endpoint exposes it. So they need a Cloudflare token with
`Workers KV Storage`, which is a genuinely wider credential than anything else on this page.

**Run them from the machine or the workflow that provisions the deployment.** That is where the
credential belongs. See [`backup-and-restore.md`](backup-and-restore.md).

---

## See also

- [`cli-reference.md`](cli-reference.md) — every command and flag.
- [`connect-mcp.md`](connect-mcp.md) — pointing Claude at the deployment; the bearer is all it needs.
- [ADR-021](../adr/ADR-021-a-deployment-is-a-named-thing.md) — why deployments have names.
- [ADR-025](../adr/ADR-025-the-summary-is-the-default-read.md) — why `views` needs no Cloudflare
  credential.

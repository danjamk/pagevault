# CLI reference

Every `pagevault` command. This is the canonical list — the [README](../../README.md) shows the
few you need to get started, and the [agent runbook](ai-guided-setup.md) drives these same commands;
both defer here for the full surface.

`pagevault` is the installed product. `npm install -g pagevault` stands PageVault up on your own
Cloudflare account and gives you every command below. Running from a repo checkout? The same verbs
exist as `make` targets (`make deploy`, `make verify`, …) — one engine, two front doors.

- **Node 22+** for the commands that build or deploy (`init`, `upgrade`) — they bundle the Worker.
  The document commands (`publish`, `list`, …) run on Node 18+.
- On success, `publish`/`mint`/`rotate` print **only the URL** to stdout; every status line, prompt,
  and warning goes to stderr, so `pagevault publish report.html | pbcopy` does the obvious thing.
- `--json` is available on the read and diagnostic commands, for scripting and for an agent to consume.

---

## Set up & deploy

### `pagevault init [--yes]`
Stand PageVault up on your own Cloudflare account — no repo clone. Walks you through the Cloudflare
API token, the tier, the owner email, and the account, writes state to `~/.pagevault/`, deploys the
bundled Worker, and **writes the login config for you** so `publish` works immediately (no separate
`login`). Re-run it to climb a tier (it shows your current choices and asks only for what's new).
`--yes` runs non-interactively (flags/env supply the answers).

### `pagevault upgrade [--yes]`
Redeploy the Worker bundle that shipped with your installed package — after `npm update -g pagevault`.
Keeps your KV, config, and secrets.

### `pagevault login --url <url> --token <token>`
Point the CLI at a deployment: writes `~/.pagevault/config.json` (mode `600` — it holds a bearer) and
verifies the connection. `init` already does this for the deployment it stood up; reach for `login`
only for a **second machine**, or **someone else's** deployment.

---

## Publish & manage documents

### `pagevault publish <file.html|.md> [flags]`
Upload a file and print its URL. The title comes from the HTML `<title>` (or a markdown `# H1`, or the
filename) unless you pass `--title`.

| Flag | Effect |
|---|---|
| `--portal <slug>` | publish into a client portal (default portal otherwise) |
| `--title <t>` · `--summary <s>` · `--tags a,b` | metadata |
| `--emails a@b,c@d` | grant these people (email-gated) — additive, never revokes |
| `--public` | also mint a no-login `/p/` link and print *that* (zero Access seats) |
| `--owner-only` | a draft only you can see |
| `--source-kind html\|markdown` | override the extension-based guess |
| `--confirm` | required to replace an existing document with the same title in place |

### `pagevault list [--portal s] [--tag t] [--json]`
Your documents, newest first.

### `pagevault mint <id>` · `revoke <id>` · `rotate <id>`
The public-link lifecycle. `mint` creates a `/p/` capability link; `revoke` kills it (keeps the
document); `rotate` replaces it with a fresh one (the old link dies). Minting and rotating are
**widening** actions — anyone with the link can open the document, no login.

### `pagevault share <portal> <email> [email …]`
Grant people access to a whole portal — one write covers every document in it.

### `pagevault rm <id> [--yes]`
Delete a document. There is no undo. Interactive confirm unless `--yes`.

### `pagevault export [dir] [--portal s] [--include-drafts] [--zip]`
Write everything you own to a browsable folder — `index.html`, an `ACCESS.md` naming who can see what,
one folder per portal. A walk-away copy, not a backup (ids and public tokens are omitted). The final
path prints to stdout.

### `pagevault read <id> [--source] [--json]`
Read a document's metadata. `--source` prints the stored body (the original `.md` or HTML) to stdout,
byte-for-byte — `pagevault read <id> --source > report.md` round-trips.

### `pagevault search <portal> <query …> [--limit N] [--json]`
Search one portal's documents. The portal is required on purpose: a cross-client search is how one
client's material ends up in another's answer.

---

## Operate your deployment

These auto-target *your* deployment from `~/.pagevault/` — no arguments, no login.

### `pagevault status [--json]`
What this install is configured for — tier, account, host, versions. Local only, no network.

### `pagevault verify [--json]`
The post-deploy smoke test: the Worker is live and ours, the root behaves for the tier, the `/mcp`
surface answers a real `publish → read → revoke` round-trip, OAuth discovery, and a sample publish
that hands back an openable link. `--json` emits a per-check verdict; the exit code (0/1) drives an
agent.

### `pagevault health [--json]`
Assert the live `/health` reports the exact build you shipped (`<version>+<sha>`) and that `/mcp`
answers. Non-zero exit on a mismatch or an unreachable deployment — this is what production CI runs.

### `pagevault sync-access [--reap] [--yes] [--json]`
Reconcile the Cloudflare Access viewer group with what KV authorizes. `--reap` also removes people KV
no longer authorizes (reclaiming seats) — it confirms first.

### `pagevault views [--days 30] [--portal s] [--doc id] [--json]`
Which documents your clients actually opened. The one command that reads from Cloudflare directly
(Analytics Engine), so it needs a Cloudflare token in the environment.

### `pagevault destroy [--keep-data]`
Tear the deployment down — Worker, DNS, Access apps, group, and KV data. Irreversible, and it asks:
it verifies the token reaches the pinned account, then makes you type the target hostname to confirm.
`--keep-data` leaves the KV namespace and its documents.

---

## Configuration & environment

| Variable | What it does |
|---|---|
| `PAGEVAULT_URL` / `PAGEVAULT_API_TOKEN` | the publish target; **override** `config.json` per command |
| `CLOUDFLARE_API_TOKEN` | the provisioning credential (`init`/`upgrade`/`destroy`/`views`) |
| `PAGEVAULT_HOME` | relocate **all** state — `config.json`, `.pagevault.json`, `.env.local` — so one machine can hold several deployments |

State lives in `~/.pagevault/` for an install (or the repo directory when running from source). To
target several deployments from one machine, give each its own `PAGEVAULT_HOME`, or pass
`PAGEVAULT_URL`/`PAGEVAULT_API_TOKEN` per command.

`pagevault help` prints the short version of all of this.

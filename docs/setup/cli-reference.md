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
- **`pagevault <command> --help`** prints that command's own flags and what they do — the same text
  its usage guard throws, so the two cannot drift. `pagevault help` alone is the one-line summary.

---

## Set up & deploy

### `pagevault init [--yes]`
Stand PageVault up on your own Cloudflare account — no repo clone. Walks you through the Cloudflare
API token, the tier, the owner email, and the account, writes state to `~/.pagevault/`, deploys the
bundled Worker, and **writes the login config for you** so `publish` works immediately (no separate
`login`). Re-run it to climb a tier: it shows your current choices and asks only for what's new, and
your documents carry across keeping their ids and filenames.

| Flag | Effect |
|---|---|
| `--tier public\|secured` | the tier, unasked. Public = links anyone can open; Secured = named people, via Cloudflare Access |
| `--host pagevault.you.com` | the hostname. Required for Secured; optional (but implied) for Public |
| `--email you@example.com` | the owner — the identity that can always see everything |
| `--rung 1\|2\|3` | the escape hatch: 1 = Public on `workers.dev`, 2 = Public on your domain, 3 = Secured |
| `--yes` | never prompt. Flags and environment supply every answer |

⚠️ **`--yes` on a *first* deployment also needs a bearer.** Non-interactively there is nobody to show
a freshly minted `PAGEVAULT_API_TOKEN` to, so `init` refuses rather than deploying a Worker you have
no way to authenticate to — before it creates anything. Either run it interactively once (it mints
and saves one), or provide your own:

```bash
export PAGEVAULT_API_TOKEN=$(openssl rand -hex 32)
pagevault init --yes --tier public --email you@example.com
```

Re-running `--yes` against a deployment that already has a bearer is fine — it reuses it, and never
rotates a live one.

### `pagevault upgrade [--yes]`
Redeploy the Worker bundle that shipped with your installed package — after `npm update -g pagevault`.
Keeps your KV, config, and secrets.

### `pagevault login [--url <url>] [--token <token>]`
Point the CLI at a deployment: writes `~/.pagevault/config.json` (mode `600` — it holds a bearer) and
verifies the connection. The flags are optional — it falls back to `PAGEVAULT_URL` /
`PAGEVAULT_API_TOKEN` from the environment, so `pagevault login` alone persists the config you already
have exported. `init` already does this for the deployment it stood up; reach for `login` only for a
**second machine**, or **someone else's** deployment.

---

## Publish & manage documents

### `pagevault publish <file.html|.md> [flags]`
Upload a file and print its URL. **A document's identity is its filename** (ADR-017): re-publishing
the same file updates it in place at the same URL; a differently-named file is a new document, even
with the same title. The display title comes from the HTML `<title>` (or a markdown `# H1`, or the
filename) unless you pass `--title`.

| Flag | Effect |
|---|---|
| `--portal <slug>` | publish into a client portal (default portal otherwise) |
| `--name <filename>` | override the identity/update key (default: the file's basename) |
| `--title <t>` · `--summary <s>` · `--tags a,b` | metadata (`--title` is display only, not the key) |
| `--emails a@b,c@d` | grant these people (email-gated) — additive, never revokes |
| `--public` | also mint a no-login `/p/` link and print *that* (zero Access seats) |
| `--owner-only` | a draft only you can see |
| `--source-kind html\|markdown` | override the extension-based guess |
| `--confirm` | required to replace an existing document with the same filename in place |

### `pagevault list [--portal s] [--tag t] [--json]`
Your documents, newest first.

### `pagevault edit <id> [--name f] [--title t] [--summary s] [--tags a,b]`
Fix a published document's filename, title, summary or tags. Not its contents — republish the file
for those. Only the flags you pass change; `--summary ""` and `--tags ""` clear those fields.

`--name` is the document's **identity** (ADR-017), so renaming **moves the document to a new URL**.
The old URL redirects for a year, and any `/p/` public link keeps working unchanged — its token was
never derived from the id. Changing only the title (or only the *case* of the filename) moves
nothing. See [ADR-020](../adr/ADR-020-rename-leaves-a-forwarding-address.md).

Renaming onto a filename another document already uses is refused outright — there is no
`--confirm` here, because finishing a rename by destroying a different deliverable is never what
was meant. To replace a document deliberately, use `publish <file> --name <that-filename> --confirm`.

The new URL is printed to stdout, so `pagevault edit <id> --name q3.md | pbcopy` hands back the
link that now works.

### `pagevault link <id>`
Print a document's shareable URL to stdout, and nothing else — so `pagevault link <id> | pbcopy`
just works. A public document hands back its `/p/` capability link; otherwise the portal viewer URL,
which requires a login. Warns on stderr if the document is an owner-only draft, since that link
opens for nobody yet.

### `pagevault mint <id>` · `revoke <id>` · `rotate <id>`
The public-link lifecycle. `mint` creates a `/p/` capability link; `revoke` kills it (keeps the
document); `rotate` replaces it with a fresh one (the old link dies). Minting and rotating are
**widening** actions — anyone with the link can open the document, no login.

### `pagevault portals [--json]`
Your portals: slug, kind, name, created. One API call — document counts are deliberately not
fetched, because that is a KV `list()` per portal against a separate 1000/day quota. Use
`pagevault list --portal <slug>` when you want the documents.

### `pagevault portal-create <slug> [flags]`
Open a new client boundary. The slug is the URL segment and the handle every other command takes.

| Flag | Effect |
|---|---|
| `--name "Acme Corp"` | display name (defaults to the slug) |
| `--kind restricted` | a client portal — its members see everything in it |
| `--kind private` | yours only (the default) |
| `--kind public` | anyone with the link, no login, and it burns no Access seat |
| `--description "…"` | shown at the top of the portal index |

Prints the slug to stdout, so it pipes into a publish.

### `pagevault share <portal> <email> [email …]` · `--remove a@b,c@d`
Grant or revoke access to a whole portal — one write covers every document in it. Permissions live
on the portal, not the document, so adding someone to a client's team is one call, not fourteen.

`--remove` stops KV authorizing them immediately, but Cloudflare Access keeps admitting them — and
keeps charging a seat — until [`sync-access --reap`](#pagevault-sync-access---reap---yes---json)
reconciles. The command says so; it is not a silent half-revocation.

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

⚠️ **It reports your saved answers, not the running deployment.** `.pagevault.json` records the
intent you gave `init`; nothing in `status` asks the Worker whether that is still true. It will
happily print `Tier Secured` for a deployment that was redeployed without Access, or name a host and
a KV namespace that a `destroy` removed. `--json` carries `"source": "local"` so an agent can tell.
To confirm the deployment agrees, run [`pagevault health`](#pagevault-health---json).

### `pagevault verify [--json]`
The post-deploy smoke test: the Worker is live and ours, the root behaves for the tier, the `/mcp`
surface answers a real `publish → rename → read → revoke` round-trip (the rename leg asserts the
document's id actually *moved*, which is what a rename means &mdash; ADR-020), OAuth discovery, and a sample publish
that hands back an openable link. `--json` emits a per-check verdict; the exit code (0/1) drives an
agent.

### `pagevault health [--json]`
Assert the live `/health` reports the exact build you shipped (`<version>+<sha>`) and that `/mcp`
answers. Non-zero exit on a mismatch or an unreachable deployment — this is what production CI runs.

### `pagevault sync-access [--reap] [--yes] [--json]`
Reconcile the Cloudflare Access viewer group with what KV authorizes. `--reap` also removes people KV
no longer authorizes (reclaiming seats) — it confirms first.

### `pagevault views [--days 30] [--portal s] [--doc id] [--json]`
Which documents your clients actually opened. Reads Analytics Engine directly rather than going
through `/api`, so it needs a Cloudflare token in the environment — as `backup` and `restore` do,
and for the same reason: the Worker deliberately holds no credential that wide.

⚠️ **The dataset is account-level, and it outlives any single deployment.** A view record names the
portal and document but not the deployment that wrote it, so after a teardown and rebuild — or on an
account that once ran a different PageVault — `views` blends the old with the new and presents all of
it as current. Rows may name documents and portals that no longer exist. Cross-check against
`pagevault list` when it matters.

Records are kept for **three months** and then age out on their own; `destroy` cannot clear them,
because the Worker deliberately holds no credential that can read or delete analytics
([ADR-015](../adr/ADR-015-what-a-view-record-contains.md) §5–6).

### `pagevault views --sync`
Push a summary of those counts into your deployment so an **agent** can see them. `read_document`
and `list_documents` then report `views`, `lastViewedAt`, and which door readers came through —
as of the sync, never live.

The query still runs here, on your machine, with your Cloudflare token; only the aggregate
travels ([ADR-019](../adr/ADR-019-view-metrics-reach-mcp-by-sync.md)). **Counts and surfaces
only — viewer emails never leave this machine.**

- **Whole-deployment by design.** `--portal` and `--doc` are refused: a summary covering one
  client would make every document outside it report a *measured* zero — "they never opened it"
  about documents nobody measured.
- **90-day window by default**, where the table defaults to 30. "Have they ever opened it" is a
  lifetime question, and Analytics Engine retains about three months.
- **Documents that no longer exist are dropped**, and the count of them is reported — the dataset
  outlives the deployment, so a rebuild leaves rows pointing at ids that no longer resolve.
- **Costs one KV write.** Re-run it whenever you want the numbers refreshed. There is no cron on
  purpose: a publish that waited on an analytics query would hang when Analytics Engine did.

An agent sees nothing at all until the first sync, and nothing for a document published since the
last one. That is deliberate — absent means "not measured", and only a real zero means nobody
opened it.

### `pagevault backup [--out <file.json>]` · `restore <file.json> [--force]`
Same-host disaster recovery. `backup` snapshots the whole KV namespace — documents, portals,
members, public-link tokens — to one JSON file; `restore` replays it. Keys are preserved
byte-for-byte, so **document ids and every `/p/` link you have already shared survive**.

Both talk to Cloudflare directly with your provisioning token rather than to `/api`, because
listings render from KV *key metadata* and no PageVault endpoint exposes it.

A restore is a bulk write, **never** a wipe: it puts back every key in the backup and deletes
nothing. So it asks what is in the namespace that the backup will *not* replace — those keys survive
and mix in with the restored data — and stops to name them. `--force` proceeds anyway; it suppresses
the refusal, not the facts, and still lists what is being kept.

`--kv <id>` targets a namespace other than the one this install deployed. The full story, including
why the format carries key metadata and what a restore does *not* bring back, is in
[Backup & restore](backup-and-restore.md).

### `pagevault destroy [--keep-data]`
Tear the deployment down — Worker, DNS, Access apps, group, and KV data. Irreversible, and it asks:
it verifies the token reaches the pinned account, then makes you type the target hostname to confirm.
`--keep-data` leaves the KV namespace and its documents.

---

## Configuration & environment

| Variable | What it does |
|---|---|
| `PAGEVAULT_URL` / `PAGEVAULT_API_TOKEN` | the publish target; **override** `config.json` per command |
| `CLOUDFLARE_API_TOKEN` | the provisioning credential (`init`/`upgrade`/`destroy`/`views`/`backup`/`restore`) |
| `CF_RUNTIME_TOKEN` | Secured only. The **narrowly scoped** token `init` puts in the Worker as `CF_API_TOKEN`, so it can keep the Access viewer group in step with portal membership ([ADR-002](../adr/ADR-002-seat-bounding.md)). Absent, the deploy warns and email grants stop reaching Access |
| `PAGEVAULT_HOME` | relocate **all** state — `config.json`, `.pagevault.json`, `.env.local` — so one machine can hold several deployments |

State lives in `~/.pagevault/` for an install (or the repo directory when running from source). To
target several deployments from one machine, give each its own `PAGEVAULT_HOME`, or pass
`PAGEVAULT_URL`/`PAGEVAULT_API_TOKEN` per command.

### Turning off the attribution

Client-facing pages carry a muted **Powered by PageVault** mark — in the viewer's control row, after
the Download/PDF/Share buttons, and in the portal index footer. Never above the fold, never beside
your client's own title.

To remove it, add `"branding": false` to `.pagevault.json` and redeploy:

```bash
pagevault upgrade      # or: make deploy
```

It is on by default because PageVault is free and spreads by being seen. It is one flag rather than
a patch you maintain, because it is MIT and a deployment is yours — [ADR-002](../adr/ADR-002-seat-bounding.md)'s
posture applied to a smaller question. The mark is removed entirely, not hidden with CSS: nothing is
left in the page source of a document you hand a client.

`pagevault help` prints the short version of all of this.

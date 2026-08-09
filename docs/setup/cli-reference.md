# CLI reference

Every `pagevault` command. This is the canonical list — the [README](../../README.md) shows the
few you need to get started, and the [agent runbook](ai-guided-setup.md) drives these same commands;
both defer here for the full surface.

`pagevault` is the installed product. `npm install -g pagevault` stands PageVault up on your own
Cloudflare account and gives you every command below. Running from a repo checkout? The same verbs
exist as `make` targets (`make deploy`, `make verify`, …) — one engine, two front doors.

- **Node 22+** for the commands that build or deploy (`init`, `upgrade`) — they bundle the Worker.
  The document commands (`publish`, `list`, …) run on Node 18+.
- **macOS, Linux, or Windows.** Linux is covered by CI; Windows is verified by hand. The one
  behavioral difference is noted under `export` below. See
  [prerequisites](prerequisites.md#which-operating-system).
- Color is dropped automatically when output is not a terminal, so redirected and piped output is
  clean. `NO_COLOR` forces it off, `FORCE_COLOR` forces it on.
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

### `pagevault upgrade [--yes] [--analytics|--no-analytics]`
Redeploy the Worker bundle that shipped with your installed package — after `npm update -g pagevault`.
Keeps your KV, config, and secrets.

`--analytics` / `--no-analytics` turn view tracking on or off. Neither is the normal case: left
alone, an upgrade keeps view tracking exactly as the deployment already has it, so a redeploy can
never quietly drop it. `--no-analytics` is the only way off, because doing that by accident costs
data nothing can recover — Analytics Engine keeps about 90 days and there is no backfill.
`PAGEVAULT_ANALYTICS=on|off` does the same thing for a non-interactive run.

### `pagevault login [--url <url>] [--token <token>] [--as <name>]`
Point the CLI at a deployment: writes `~/.pagevault/config.json` (mode `600` — it holds a bearer) and
verifies the connection. The flags are optional — it falls back to `PAGEVAULT_URL` /
`PAGEVAULT_API_TOKEN` from the environment, so `pagevault login` alone persists the config you already
have exported. `init` already does this for the deployment it stood up; reach for `login` only for a
**second machine**, or **someone else's** deployment.

`--as <name>` registers the deployment by name in `~/.pagevault/deployments.json` instead, so one
machine can hold several. Without it, nothing changes: one deployment, one `config.json`.

---

## Several deployments on one machine

One operator, more than one deployment — a production instance deployed by CI and a test one you
deploy from a checkout. Each named deployment carries **its own bearer**, so a command can never pair
one deployment's URL with another's credential.

`CLOUDFLARE_API_TOKEN` is deliberately **not** in the registry. It stays in per-clone `.env.local`,
because that placement is what keeps the production credential off your laptop entirely — a
wrong-clone `make deploy` cannot touch production by construction rather than by discipline.

### `pagevault deployments [--json]`
Everything this machine can reach, with `*` marking the default. The login config is listed too, as
the implicit deployment it has always been.

`PROVISIONED` means the build record is on **this** machine, so `upgrade`, `destroy` and `backup` can
run. Its absence is the normal state for a CI-deployed instance — a fact about the deployment, not a
fault.

The answer comes from a path the entry recorded, so it is the same wherever you run it from — a
listing that said `no` in your home directory and `yes` in a checkout would be describing your
`cd` history rather than your deployments. It is read fresh each time rather than cached, so a
checkout you delete, move, or re-provision against something else goes back to `no`, which is then
the true answer.

If a build record is sitting in the directory you are standing in and no deployment has recorded it,
the listing says so and names the command that fixes it — `pagevault login --as <name>`, which
amends the entry without asking you to retype the URL or token.

### `pagevault use <name>`
Make a registered deployment the default. Writes the registry and nothing else; no file in a working
tree is touched, and no bearer is ever written into a repository.

### Which deployment a command acts on

| Rung | Source |
|---|---|
| 1 | `--deployment <name>` |
| 2 | `PAGEVAULT_DEPLOYMENT` (direnv, CI, a one-off export) |
| 3 | the checkout you are standing in — `.pagevault.json`, found by walking up |
| 4 | the default, `*` in `deployments`, set by `use` |
| 5 | the login config |

Rung 3 is the guardrail: inside a checkout you get that checkout's deployment whether or not you
remember to say so, the same way `git` and `npm` find theirs. Every command prints which one it chose
and why — on stderr, so `pagevault publish report.html | pbcopy` still carries only the URL.

### And which bearer it authenticates with

Resolved separately, and **paired to the deployment above** — a credential is not interchangeable
with a URL. Every command uses the same four sources, in this order:

| Rung | Source | Sent only when |
|---|---|---|
| 1 | `PAGEVAULT_API_TOKEN` in the environment | always — naming it is how you deliberately override |
| 2 | the registry entry for this deployment | it was stored against this exact deployment |
| 3 | `.env.local` beside the build record | that record describes the deployment being acted on |
| 4 | the login config | the login describes the deployment being acted on |

Rungs 3 and 4 carry a condition because a token that belongs to another deployment is never sent —
not to fail safe in the abstract, but because a bearer shared between two deployments would
authenticate against the wrong one and write there. When nothing qualifies, the command says
`No bearer for <url>` and lists where it looked, rather than trying the nearest token it can find.

Rung 3 is why `pagevault list` works the moment `init` finishes. The Worker holds the bearer as a
**secret**, which cannot be read back; `.env.local` is this machine's own copy of the same value, and
it sits beside `.pagevault.json` so the two are paired by construction.

### Protecting one

```bash
pagevault login --as prod --protected     # amends an entry already registered
```

On a protected deployment the destructive document commands — `rm`, `revoke`, `rotate` — require an
explicit `--yes`. Publishing, editing and sharing are unaffected: a confirmation on the operation you
perform most gets answered reflexively within a day. It is a refusal rather than a prompt, so it
means the same thing in a terminal and in a script. `--no-protected` clears it.

Re-running `login --as <name>` on a deployment already registered amends that entry, so credentials
need not be retyped to change a flag.

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

`--zip` shells out to `zip`, which **Windows does not have**. There it writes the folder, prints a
note saying it could not compress, and exits cleanly — you get the export either way, just not
zipped. Compress it yourself with `Compress-Archive` if you want a single file.

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

It leads with the deployment it would act on and what chose it, whether or not this machine
provisioned it, and says so when that deployment is `protected`. Below that, a deployment provisioned
from here reports its build record; one deployed elsewhere says so instead of reporting fields it
does not have.

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

It also reports **how much view history is about to become unrecoverable**. Views reach Analytics
Engine on their own, but only `pagevault sync-views` makes them durable, and Analytics Engine keeps
about 90 days — so a window that ages out uncovered is gone, silently. This is the thing that says so
before the loss instead of after:

```
! 71 days of view history become unrecoverable in 20 days.
  Captured through 2026-05-28. Fix it with pagevault sync-views.
```

It reports **risk, not age** — "synced 40 days ago" leaves you to do the arithmetic. The warning is
loud but **never changes the exit code**: a deployment that is up with an unsynced summary is still
up, and failing a production deploy over it would punish the wrong thing.

This lives here rather than in `status` because [`status`](#pagevault-status---json) is deliberately
offline — it prints your saved answers and says so. It is not on the `/health` endpoint itself
because that endpoint is unauthenticated, and when you last synced is a fact about how you work.

### `pagevault sync-access [--reap] [--yes] [--json]`
Reconcile the Cloudflare Access viewer group with what KV authorizes. `--reap` also removes people KV
no longer authorizes (reclaiming seats) — it confirms first.

### `pagevault views [--days 30] [--portal s] [--doc id] [--live] [--who] [--json]`
How much your documents were read. Reads the summary stored in your deployment through `/api`, so
it needs only your PageVault bearer — **no Cloudflare token and no account id**
([ADR-025](../adr/ADR-025-the-summary-is-the-default-read.md)). That is what makes it work from a
machine that did not provision the deployment, which is the ordinary case for a production instance
deployed by CI.

The summary accumulates, so it reaches further back than a live query can: Analytics Engine keeps
~90 days, the summary keeps everything ever synced into it. It is only as current as your last
`pagevault sync-views`, and the output states that time every time it prints.

`--live` asks Analytics Engine instead — what has happened since the last sync, and **who** opened
it. That path needs a Cloudflare token with `Account Analytics: Read` and sees only 90 days.
`--who` implies it, because the summary has never held an identity
([ADR-019](../adr/ADR-019-view-metrics-reach-mcp-by-sync.md) §4) and there is nowhere else to get
one. Portal-index landings are stored nowhere but Analytics Engine, so they appear only under
`--live` too.

Below the table, a **traffic sources** block: the hosts that linked to your documents, or `direct`
where the browser sent no referrer. Only the linking host is ever recorded — never the page it
linked from, which is someone else's private context
([ADR-023](../adr/ADR-023-the-summary-is-the-history.md) §5). It is skipped under `--doc`, because
sources are aggregated per portal and printing a portal's traffic under one document's filter
would be a wrong answer rather than a narrower one.

A `(portal index)` row is someone landing on a collection page without opening anything. Those are
counted on their own line rather than folded into document views, and they record **no viewer on
any surface** — including `/v/`, where Access knows exactly who it was (§6).

⚠️ **Automated previews are counted.** A LinkedIn preview, a Slack unfurl and a mail-client preload
all fetch the page. Public and capability-link numbers therefore read high, and that is the first
thing to suspect when one looks implausible.

⚠️ **The dataset is account-level, and it outlives any single deployment.** A view record names the
portal and document but not the deployment that wrote it, so after a teardown and rebuild — or on an
account that once ran a different PageVault — `views` blends the old with the new and presents all of
it as current. Rows may name documents and portals that no longer exist. Cross-check against
`pagevault list` when it matters.

Records are kept for **three months** and then age out on their own; `destroy` cannot clear them,
because the Worker deliberately holds no credential that can read or delete analytics
([ADR-015](../adr/ADR-015-what-a-view-record-contains.md) §5–6).

### `pagevault sync-views [--days 90] [--account id] [--reset] [--yes]`
Move view counts out of Analytics Engine and into your deployment, where they last — and where an **agent** can see them.

It is a separate command rather than a flag on `views` because it does a different kind of thing:
`views` looks at a 90-day window, `sync-views` rescues that window before it ages out permanently. As
`views --sync` the consequential act looked like an option on the harmless one. **`views --sync`
still works** and prints a note pointing here — it is in docs, muscle memory and possibly a crontab,
and a scheduled sync that starts failing silently is exactly what ADR-023 §9 exists to prevent. `read_document`
and `list_documents` then report `views`, `lastViewedAt`, and which door readers came through —
as of the sync, never live.

The stored summary **accumulates**. Each sync adds the window it could see and never removes what an
earlier one contributed, so your history outlives Analytics Engine's three-month retention
([ADR-023](../adr/ADR-023-the-summary-is-the-history.md) §1). Before this, every sync re-derived from
a rolling 90-day query — so a document opened 43 times in January reported `views: 3` by June, with a
*newer* `viewsSyncedAt` making it look fresher at the moment it became less true.

⚠️ **Sync at least once every 90 days.** That is the other side of the bargain: views only reach the
durable summary when a sync runs, so a window that ages out of Analytics Engine uncovered is gone.
Nothing errors — the data is simply never there later. A daily schedule is the sensible cadence and
costs one KV write.

Your own views are counted apart from the client's, where the deployment can tell — the split is
computed on your machine from an address that never leaves it. Where this machine does not hold the
deployment's build record the split is **absent rather than guessed**.

`--reset` throws the stored history away and rebuilds from the current window alone. It is the one
destructive option here, and it asks for the deployment URL before doing it: anything older than 90
days is not in Analytics Engine any more and does not come back.

**Backups matter more than they did.** The summary lives in KV, so `backup` carries it and `destroy`
ends it. A backup is now the difference between keeping and losing history.

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
- **Costs one KV write, so schedule it.** Daily is the sensible cadence. **The Worker cannot run
  this for you** — its Analytics Engine binding is write-only, so it cannot read its own metrics at
  any schedule ([ADR-019](../adr/ADR-019-view-metrics-reach-mcp-by-sync.md) §1). That is a fact
  about the Worker rather than advice against scheduling: an operator-side schedule is exactly what
  keeps history from ageing out uncovered, and `pagevault health` tells you how long you have.

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

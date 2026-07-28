# Where your data lives, and how to back it up

All of PageVault's state is **one Workers KV namespace** — the one named `pagevault` in your
Cloudflare account. There is no database to browse and no bucket of files; documents,
portals, members, and public-link tokens are all keys in that namespace.

This page is about **disaster recovery** — snapshotting that namespace and restoring it on the
same host. It is deliberately *not* a human-readable export — that's [`make
export`](#walking-away-a-human-readable-export) at the bottom of this page. A restore is
Cloudflare → Cloudflare, and it keeps keys byte-for-byte, so **document ids and every `/p/` link
you've already shared survive**.

## What's in the namespace

Six key prefixes, all disjoint:

| Prefix | Holds | Notes |
|---|---|---|
| `doc:{id}` | a document's HTML body | the artifact itself |
| `meta:{id}` | a document's listing data | **stored in the key's metadata**, not the value |
| `idx:{slug}:{id}` | a portal → document index entry | |
| `portal:{slug}` | a portal | its listing data is also **in key metadata** |
| `members:{slug}` | a portal's member list | who `canView()` admits |
| `pub:{token}` | a public capability token → document id | powers `/p/` links |

You can browse these in the dashboard: **Cloudflare → Storage & Databases → KV → `pagevault`
→ View**. Values are visible; key *metadata* is not shown there, which is exactly the catch
below.

## Back up

```bash
make backup                 # writes pagevault-backup-<timestamp>.json
make backup OUT=snap.json   # or name it yourself
```

It lists every key (with metadata), fetches every value, and writes a single JSON file in the
shape a restore replays. The file carries key metadata but **no secrets** — your bearer and
Cloudflare tokens live in `.env.local` and the Worker, never in KV. Keep the file gitignored
anyway.

## Restore

```bash
make restore FILE=pagevault-backup-<timestamp>.json
```

A restore is a bulk write, **not** a wipe-and-replace: it puts back every key in the backup and
never deletes anything. So the question it actually asks before running is *"what is in here that
the backup will not replace?"* — because those keys survive and mix in with the restored data.

- **Nothing survives** (empty namespace, or every key is in the backup) → it just runs.
- **Something survives** → it stops, **names what** would remain, and asks you to pass `FORCE=1`.

It prints the write cost first — one write per key against Cloudflare's free **1000 writes/day** —
and asks before spending it.

> **KV is eventually consistent (~60s).** Right after a restore, listings and portal indexes
> may briefly lag. This is normal; it settles.

## Recovering a lost deployment

Follow this in order. **Restore before you verify** — that is the one step people get backwards,
and it is the reason `restore` used to refuse for no visible reason.

```bash
# 1. Rebuild the deployment. This creates a fresh, empty KV namespace.
pagevault init            # or: make deploy

# 2. Restore into it, while nothing has written to it yet.
make restore FILE=pagevault-backup-<timestamp>.json

# 3. Now smoke-test. This publishes a sample document, which is why it comes last.
make verify

# 4. Secured only — re-populate the Access group from the restored member lists.
pagevault sync-access
```

Why the order matters: `verify` publishes `examples/welcome.html` so you have something to open.
That is useful on a first install and unhelpful during a recovery — the sample's keys are not in
your backup, so at step 2 the restore would stop and make you decide about them. Nothing is lost
either way, and `FORCE=1` is the correct answer if you have already run `verify`. Restoring first
just means never having to think about it.

If a `pagevault-backup-*.json` file is sitting in the directory, the deploy notices and suggests
the restore itself rather than pointing you at `verify`.

**What comes back:** document ids, so every `/p/` link you already shared still opens; key
metadata, so portal indexes render; and member lists, which is what step 4 replays into Cloudflare
Access. **What does not:** the Access group itself (step 4 rebuilds it), your `.env.local` tokens,
and view records — those live in Analytics Engine, not KV, and are never in a backup.

## Why the format looks the way it does

The obvious recipe is silently lossy, and it's worth knowing why. `meta:` and `portal:` keys
keep their listing data in **key metadata**, not in the value — that's what lets a portal index
render from a single `list()` with no per-document read. A values-only dump (what
`wrangler kv bulk get` gives you) throws that metadata away. Restore such a dump and the
documents are still fetchable by id, but `listDocs()` skips any metadata-less `meta:` key
(`worker/src/store.ts`), so **every document goes invisible to listings and portals**.

So `make backup` joins each value to its key's metadata by key name and writes them together;
`make restore` replays both. The round-trip is pinned by `scripts/kv-backup.test.mjs`, which
fails on the naive no-metadata path.

## Walking away — a human-readable export

`make backup` is Cloudflare → Cloudflare. When you want the *content* — to hand a client their
documents, or to leave PageVault entirely — `make export` writes a browsable folder instead:

```bash
make export                     # → pagevault-export-<date>.zip (everything)
make export PORTAL=acme-corp    # just one client
make export NOZIP=1             # leave the folder unzipped
make export DRAFTS=1            # include owner-only drafts (excluded by default)
```

Inside: an `index.html` that links everything, an `ACCESS.md` that spells out who could see what,
and one folder per portal with each document as a standalone file — HTML as `.html`, markdown as
its original `.md`. Every file opens on its own, with no PageVault and no server. `make export`
auto-targets the deployment this clone deployed (URL from `.pagevault.json`, bearer from
`.env.local`), so no login is needed.

It is intentionally **lossy and not a restore format**: document ids and `/p/` tokens are left
out — if you're leaving, your URLs are changing anyway, and if you're recovering, that's `make
backup` above. (The `pagevault export` CLI does the same against any deployment you hold a token
for; `make export` is the shortcut for your own.)

# pagevault

Publish self-contained HTML to your own [PageVault](https://github.com/danjamk/pagevault)
deployment from the terminal. A thin HTTP client of the `/api` surface — no Cloudflare access,
no local state, zero dependencies. It works against any deployment you hold a token for.

```bash
npx pagevault publish report.html
# → https://share.example.com/p/u3qph25exs92   (prints only the URL, so it pipes)
```

## Install

```bash
npm install -g pagevault      # or just use `npx pagevault …`
```

Requires Node 18+.

## Configure

Point it at your deployment once:

```bash
pagevault login --url https://share.example.com --token <PAGEVAULT_API_TOKEN>
```

This writes `~/.pagevault/config.json` (mode `600` — it holds your bearer token) and verifies the
connection. Alternatively, set `PAGEVAULT_URL` and `PAGEVAULT_API_TOKEN` per command — the
environment overrides the saved config, so a one-off against another deployment needs no re-login.

## Commands

```
pagevault publish <file.html> [--portal s] [--title t] [--summary s]
                              [--tags a,b] [--emails a@b,c@d]
                              [--public] [--owner-only] [--confirm]
pagevault list [--portal s] [--tag t] [--json]
pagevault share <portal> <email> [email …]
pagevault rm <id> [--yes]
pagevault export [dir] [--portal s] [--include-drafts] [--zip]
```

- **`publish`** uploads the file and prints its URL. The title comes from the HTML's `<title>`
  (or the filename) unless you pass `--title`. `--public` also mints a no-login `/p/` link and
  prints *that*; the "anyone with the link can open it" warning goes to stderr. Re-publishing the
  same title in a portal replaces it in place — that needs `--confirm`.
- **`list`** shows your documents, newest first. `--json` for scripting.
- **`share`** grants a client access to a whole portal by email — one write, every document in it.
- **`rm`** deletes a document. Interactive confirm unless `--yes`.
- **`export`** writes everything you own to a browsable folder — `index.html`, an `ACCESS.md`
  that spells out who can see what, and one folder per portal with each document as a standalone
  file. Unzip, double-click, browse. It's a walk-away copy, not a backup: document ids and public
  tokens are omitted. Owner-only drafts are excluded unless you pass `--include-drafts`; `--zip`
  bundles the folder (needs the system `zip`). The final path is printed to stdout.

```bash
pagevault export ./client-handoff --portal acme-corp --zip
```

## The stdout contract

On success, `publish` and `list --json` write **only** their result to stdout; every status line,
warning, and prompt goes to stderr. So this does the obvious thing:

```bash
pagevault publish report.html | pbcopy
```

## Read-after-write

Cloudflare KV is eventually consistent — a just-published URL can 404 for a second. `publish`
polls until the document is readable before printing the link, so what it hands you works.

MIT. Part of [PageVault](https://github.com/danjamk/pagevault) — fork it, steal it.
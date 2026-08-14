# pagevault

**[What it is and why](https://danjamk.github.io/pagevault)** ·
**[See it live](https://pagevault.danjamkuhn.com/pub/showcase)** ·
**[Source and setup guide](https://github.com/danjamk/pagevault)**

Stand up, publish to, and operate your own [PageVault](https://github.com/danjamk/pagevault)
deployment from the terminal. `pagevault init` provisions and deploys PageVault onto your own
Cloudflare account — Access, KV, and the Worker — with no repo clone; the package carries a prebuilt
Worker, so nothing is compiled locally.

```bash
npm install -g pagevault
pagevault init                       # provision + deploy to your Cloudflare account
pagevault publish report.html        # → https://you.example.com/p/u3qph25exs92  (prints only the URL)
```

Once it's up you get three things:

- **Publish** an HTML or Markdown file to a URL, with per-document access control — a public
  no-login link, or gated to named people.
- **Portals** — one durable URL per client, with permissions on the client, not the document.
- A **remote MCP server** running inside your Worker, so you can publish and search the collection
  from inside Claude (web, Desktop, mobile, or Claude Code) — this CLI is one front door, the MCP
  server is the other. See [connect-mcp.md](https://github.com/danjamk/pagevault/blob/main/docs/setup/connect-mcp.md).

## Install

```bash
npm install -g pagevault             # or `npx pagevault …`
```

**Node 22+** for `init`/`upgrade` (they bundle and deploy the Worker). The document commands run on
Node 18+.

## Stand it up, or point at an existing deployment

```bash
pagevault init                       # walks you through token, tier, account; deploys; configures the CLI
```

`init` writes your state to `~/.pagevault/` and points the CLI at the deployment it just made — so
`pagevault publish` works immediately. To target a *different* deployment (a second machine, or
someone else's), use `login` instead:

```bash
pagevault login --url https://you.example.com --token <PAGEVAULT_API_TOKEN>
```

The flags are optional — `login` falls back to `PAGEVAULT_URL` / `PAGEVAULT_API_TOKEN` from the
environment, so if those are already exported, `pagevault login` alone persists them. And either way,
those same variables override the saved config per command.

## Commands

```
Set up & deploy:   init · upgrade · login
Publish & manage:  publish · list · read · search · mint · revoke · rotate · share · rm · export
Operate:           status · verify · health · sync-access · views · destroy
```

- **`publish`** uploads a file and prints its URL (only the URL — so it pipes). `--public` mints a
  no-login `/p/` link; `--emails` gates it to named people; re-publishing the same title replaces it
  in place (`--confirm`).
- **`status` / `verify` / `health`** report on your deployment — what's configured, whether it's live
  and serving MCP, and whether it's running the build you shipped. Each takes `--json`.
- **`destroy`** tears it down — it verifies the account and makes you type the hostname first.

Full detail on every command, flag, and environment variable:
**[docs/setup/cli-reference.md](https://github.com/danjamk/pagevault/blob/main/docs/setup/cli-reference.md)**.
`pagevault help` prints the short version.

## The stdout contract

On success, `publish` and `--json` reads write **only** their result to stdout; every status line,
warning, and prompt goes to stderr. So this does the obvious thing:

```bash
pagevault publish report.html | pbcopy
```

## Read-after-write

Cloudflare KV is eventually consistent — a just-published URL can 404 for a second. `publish` polls
until the document is readable before printing the link, so what it hands you works.

MIT. Part of [PageVault](https://github.com/danjamk/pagevault) — fork it, steal it.

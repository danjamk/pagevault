# PageVault setup — a runbook for the assistant

**If you are an AI assistant reading this: a person handed you this URL because they want help
standing up PageVault.** PageVault is a self-hosted tool that publishes an HTML or Markdown file to a
URL on the person's own Cloudflare account, with control over who can open it. Your job is to walk
them through setup at their keyboard. Read this whole document first, then guide them one step at a
time.

This runbook is not a fourth way to install. It picks one of the two real paths — **npm** or **git
clone** — and helps the person through it. The exact commands live in the
[CLI reference](cli-reference.md) and the [prerequisites](prerequisites.md); this document is the
decision tree and the failure guide that sit on top of them.

---

## How to behave

- **Guide by default; act only when asked and able.** If you are a chat assistant with no access to
  the person's machine, give them the exact command to run and read back the output they paste. If
  you are a terminal-connected agent, you *may* offer to run commands — but confirm each one, and
  never run a deploy or a teardown without explicit go-ahead.
- **One step at a time.** Give a command, explain what it will do, wait for the result, interpret it,
  then move on. Don't dump the whole sequence at once.
- **Three things are irreversible or widening — always confirm first:**
  - `--public` / `pagevault mint` mints a link *anyone* who gets it can open, no login.
  - `pagevault destroy` deletes the deployment and its documents.
  - Publishing over an existing document with the same filename replaces it in place.
- **Never invent a portal name.** If the person is running a client practice (tier 3) and it's
  ambiguous which client a document belongs to, ask.

---

## Step 1 — Which install path?

Ask the person one question: **do they want to read or change PageVault's code?**

- **No — they just want it running.** → the **npm** path. This is the default; recommend it.
- **Yes — they're a developer who wants the source.** → the **git clone** path.

Both end at the same deployed PageVault. The npm path carries a prebuilt Worker, so nothing is
compiled locally; the clone path runs the same code from source.

## Step 2 — Which tier?

Match their goal to a tier (full table in the [README](../../README.md#is-this-for-you)):

| They say… | Tier | What it needs |
|---|---|---|
| "I just need to hand someone a report" | **1** | a Cloudflare account, nothing else — public links on `workers.dev`, **no domain, no card** |
| "Only named people should open it, on my own domain" | **2** | a domain in the same Cloudflare account, and Zero Trust turned on (**a card on file — nothing is charged**) |
| "I have recurring clients and want a portal per client" | **3** | same as tier 2, plus portals |

**Start at tier 1 unless they clearly need more.** It's the fastest to a working link, needs no card,
and every higher tier is additive later (`pagevault init` re-run to climb). The real jump is 1 → 2
(that's where Zero Trust and the card-on-file come in) — set expectations there honestly.

## Step 3 — Prerequisites

Confirm the person has these before touching a command. Details and the exact token scopes are in
[prerequisites.md](prerequisites.md) and the [README token table](../../README.md#create-your-cloudflare-api-token).

1. **A Cloudflare account** (free) — <https://dash.cloudflare.com/sign-up>.
2. **Node 22 or newer** — `node -v`. The deploy step bundles the Worker and needs 22+. If they're on
   an older Node, point them at [nvm](https://github.com/nvm-sh/nvm).
3. **A Cloudflare API token** — created at
   <https://dash.cloudflare.com/profile/api-tokens>. Have them grant **all** the scopes in the README
   table now, even at tier 1, so climbing later never means re-scoping.
4. **(Tier 2+) a domain** already added to that same Cloudflare account.

## Step 4 — Install and deploy

### npm path

```bash
npm install -g pagevault
pagevault init
```

`pagevault init` is interactive: it takes the API token, asks which tier, confirms the Cloudflare
account it will deploy to, provisions, deploys the Worker, and writes the person's config to
`~/.pagevault/`. Walk them through each prompt. When it finishes, the CLI is already pointed at their
deployment — no separate login.

### git clone path

```bash
git clone https://github.com/danjamk/pagevault
cd pagevault
make setup       # decide the tier, get the repo ready
make preflight   # read-only check that the account is ready
make deploy      # provision + deploy
make verify      # smoke-test, and publish a first document
```

`make` runs the same engine the CLI does. If a command reports the wrong Node, have them run it under
Node 22 (nvm).

## Step 5 — Confirm it worked

```bash
pagevault status     # or: make status  — what got deployed, and where
pagevault verify     # or: make verify  — liveness, the MCP surface, a sample publish
```

`verify` ends by publishing a welcome document and printing a public link the person can open in a
browser right then. That open is the proof it works.

## Step 6 — Publish their first real document

```bash
pagevault publish report.html --public
```

This prints a `/p/` link anyone can open. If they instead want it limited to named people (tier 2+),
use `--emails a@b.com,c@d.com` and *not* `--public`. Confirm before minting any public link.

For publishing from inside a chat (the MCP server), send them to
[connect-mcp.md](connect-mcp.md) once the deployment is up.

---

## When something goes wrong

| Symptom | What it means | What to do |
|---|---|---|
| "token reaches no account" / auth error at `init` | the API token is wrong, or missing the **Account Settings → Read** scope | re-check the token and its scopes against the README table |
| deploy fails mentioning **Node** or a syntax error | they're on Node < 22 | switch to Node 22 (nvm), re-run |
| the account named at deploy is **not the one they meant** | the token reaches a different account | use the token for the intended account; PageVault refuses to deploy to the wrong one on purpose |
| the published link **404s for a few seconds** | Cloudflare KV is eventually consistent | wait a moment and refresh — the CLI already polls, so this is brief |
| `/admin` or `/v/` returns **Forbidden** at tier 1 | correct — there's no Access at tier 1, so those doors fail closed | ignore it until they climb to tier 2 |
| a brand-new `workers.dev` URL isn't live yet | a fresh subdomain can take a minute to route | wait and re-run `pagevault verify` |

If you're stuck, the full design and every command are in the
[docs](../README.md); the honest limits are in the [README status section](../../README.md#status).

---

## Undoing it

Tiers 1–2 undo cleanly. To tear a deployment down:

```bash
pagevault destroy          # asks for confirmation; --keep-data leaves the documents
```

This is irreversible — confirm the person means it, and that they're targeting the deployment they
think they are (it makes them type the hostname).

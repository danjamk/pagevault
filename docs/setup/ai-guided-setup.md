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
- **Never invent a portal name.** If the person is running a client practice (Secured, with portals) and it's
  ambiguous which client a document belongs to, ask.

---

## Step 1 — Which install path?

Ask the person one question: **do they want to read or change PageVault's code?**

- **No — they just want it running.** → the **npm** path. This is the default; recommend it.
- **Yes — they're a developer who wants the source.** → the **git clone** path.

Both end at the same deployed PageVault. The npm path carries a prebuilt Worker, so nothing is
compiled locally; the clone path runs the same code from source.

## Step 2 — Public or Secured?

There are **two tiers**, and `init` asks for them by name — `1` for Public, `2` for Secured
([ADR-018](../adr/ADR-018-public-and-secured-tiers.md)). Match their goal:

| They say… | Tier | What it needs |
|---|---|---|
| "I just need to hand someone a report" | **Public** | a Cloudflare account, nothing else — links anyone with the URL can open, on `workers.dev`, **no domain, no card** |
| "…and I want it on my own domain" | **Public** | the same, plus a domain already in that Cloudflare account. Still public — a domain changes the address, not who can read it |
| "Only named people should be able to open it" | **Secured** | a domain, **and** Zero Trust turned on (**a card on file — nothing is charged**) |
| "I have recurring clients and want a portal per client" | **Secured** | the same. Portals are how Secured organizes clients, not a separate tier |

🔴 **Be precise about this, because it is the one place a mistake is silent.** A domain does **not**
make documents private. Public with a custom domain still means anyone holding the URL can read the
document. Access control starts at Secured, and nowhere earlier. If the person says "only my client
should see this", they need **Secured** — do not let a domain stand in for it.

**Start at Public unless they clearly need named-people access.** It reaches a working link fastest,
needs no card, and Secured is additive later — re-run `pagevault init` to climb, and every document
carries across keeping its name and its place. The real jump is Public → Secured: that is where Zero
Trust and the card-on-file come in, so set expectations there honestly.

One thing to say out loud when they climb: **the links they already shared will stop working.** The
hostname moves, so a URL handed out under the old address no longer resolves. Their documents survive
untouched; the links do not. Documents published while Public also keep their public links after the
climb — correct, but worth naming, and `pagevault list --json` shows which ones (`"public": true`).

## Step 3 — Prerequisites

Confirm the person has these before touching a command. Details and the exact token scopes are in
[prerequisites.md](prerequisites.md) and the [README token table](../../README.md#create-your-cloudflare-api-token).

1. **A Cloudflare account** (free) — <https://dash.cloudflare.com/sign-up>.
2. **Node 22 or newer** — `node -v`. The deploy step bundles the Worker and needs 22+. If they're on
   an older Node, point them at [nvm](https://github.com/nvm-sh/nvm).
3. **A Cloudflare API token** — created at
   <https://dash.cloudflare.com/profile/api-tokens>. Have them grant **all** the scopes in the README
   table now, even for Public, so climbing later never means re-scoping.
4. **(a domain, for Secured or for Public-on-your-own-domain)** already added to that same
   Cloudflare account.
5. **(Secured only) Zero Trust enabled** on the account — this is the step that asks for a card,
   and the one that cannot be automated.

## Step 4 — Install and deploy

### npm path

```bash
npm install -g pagevault
pagevault init
```

`pagevault init` is interactive: it takes the API token, asks Public or Secured, confirms the Cloudflare
account it will deploy to, provisions, deploys the Worker, and writes the person's config to
`~/.pagevault/`. Walk them through each prompt. When it finishes, the CLI is already pointed at their
deployment — no separate login.

### git clone path

```bash
git clone https://github.com/danjamk/pagevault
cd pagevault
make setup       # Public or Secured, and get the repo ready
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

This prints a `/p/` link anyone can open. To limit a document to named people they need **Secured** —
then publish without `--public`, and either put the person in the portal
(`pagevault share <portal> <email>`) or grant them the one document with
`--emails a@b.com,c@d.com`. On a Public deployment there is nobody to check a name against, so a
plain publish is public by nature. Confirm before minting any public link.

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
| `/admin` or `/v/` is refused on a **Public** deployment | correct — there is no Access there, so those doors fail closed | ignore it unless they climb to Secured |
| a brand-new `workers.dev` URL isn't live yet | a fresh subdomain can take a minute to route | wait and re-run `pagevault verify` |

If you're stuck, the full design and every command are in the
[docs](../README.md); the honest limits — including when to use something else — are in the
[README comparison](../../README.md#how-it-compares).

---

## Undoing it

Public undoes cleanly; Secured leaves Zero Trust itself and any consumed Access seats behind
(deliberately — they are account-wide). To tear a deployment down:

```bash
pagevault destroy          # asks for confirmation; --keep-data leaves the documents
```

This is irreversible — confirm the person means it, and that they're targeting the deployment they
think they are (it makes them type the hostname).

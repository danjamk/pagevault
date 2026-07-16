# Prerequisites

What you need depends on how far up [the ladder](../design/onboarding-experience.md)
you climb. Most people start at **rung 1** — publish public links — which needs
very little and costs nothing.

`make preflight` checks all of this for you and names anything missing, so you don't
have to work through this list by hand. This page is the human reference: what each
prerequisite is, how to check it yourself, and where to get it.

Each item below has a **Check** (a command you can run) and a **Get it** (where to go
if you don't have it).

---

## Rung 1 — publish public links

Everything here is free, and none of it needs a credit card.

### A Cloudflare account

The Worker, the KV store, and your links all live on Cloudflare's free tier.

- **Check:** you can sign in at <https://dash.cloudflare.com>.
- **Get it:** sign up at <https://dash.cloudflare.com/sign-up>. The free plan is
  enough for rungs 1 and 2. No card required at this rung.

### Node.js 22 or newer

The Worker's tooling (Wrangler 4) requires Node 22.

- **Check:** `node --version` → should print `v22.` or higher.
- **Get it:** <https://nodejs.org> (the LTS build). If you juggle Node versions,
  [`nvm`](https://github.com/nvm-sh/nvm) is worth it: `nvm install 22 && nvm use 22`.

### git

To clone the repo.

- **Check:** `git --version` → prints a version.
- **Get it:** <https://git-scm.com/downloads> (macOS/Linux usually have it already).

### pnpm

The repo's package manager.

- **Check:** `pnpm --version` → prints a version.
- **Get it:** the simplest path is Corepack, which ships with Node:
  `corepack enable`. Otherwise <https://pnpm.io/installation>. (`make setup` will
  guide you if it's missing.)

### Wrangler, signed in to your account

Wrangler is Cloudflare's CLI. You don't install it separately — the repo runs it for
you — but it does need to be **signed in** so it can deploy.

- **Check:** `make preflight` names the account it will use (or "not signed in").
- **Get it:** `make login` opens a browser to authorize. Use `make login` (not a bare
  `wrangler login`) — it runs wrangler under Node 22, which wrangler requires.

---

## Targeting a specific Cloudflare account

`wrangler` deploys to whatever account it is signed into machine-wide — a problem if
you have more than one (a personal account and a client's, or a throwaway test
account). `make preflight` **names the account** it will use; if that is not the one
you want, point the tooling at the right account with an API token.

**1. Create a token** in the *target* account's dashboard →
[API Tokens](https://dash.cloudflare.com/profile/api-tokens) → *Create Custom Token*.
For rung 1 (publish) it needs three scopes:

- `Workers Scripts` — Edit
- `Workers KV Storage` — Edit
- `Account Settings` — Read

(Rung 3 needs the fuller set below.)

**2. Put it in `.env.local`** at the repo root — gitignored, never committed:

```
CLOUDFLARE_API_TOKEN=your-token-here
```

The tooling loads it into the environment before every `wrangler` call, so wrangler
targets *that* account. **Each clone keeps its own `.env.local`** — which is exactly
how you run multiple accounts from one machine: one clone per account, each pinned to
its own. (A shell `export CLOUDFLARE_API_TOKEN=…` works too, for one terminal.)

**3. Re-run `make preflight`** — it should now name the account the token belongs to.
If it still shows the wrong one, the token isn't being read: check the file is
`.env.local` at the repo root and the variable is spelled `CLOUDFLARE_API_TOKEN`.

---

## Rung 2 — put it on your domain

One more thing on top of rung 1.

### A domain, in the same Cloudflare account

A custom domain replaces the `*.workers.dev` URL with your own. It must be a **zone
in the same Cloudflare account** as the Worker — Cloudflare can't use a domain that
lives in a different account.

- **Check:** the domain appears under **Websites** in your Cloudflare dashboard,
  status *Active*.
- **Get it:** register one through **Cloudflare Registrar** (it lands in your account
  automatically), or add a domain you already own by pointing its nameservers at
  Cloudflare. A cheap throwaway domain is fine for testing.

> Have the domain in a *different* Cloudflare account? It can't be used across
> accounts — register or move one into the account running PageVault.

---

## Rung 3 — client portals (email-secured)

This is the rung that turns on Cloudflare Access, and the only one with a real cost
of entry.

### Cloudflare Zero Trust, enabled

Access (the login wall for `/v`) is part of Cloudflare Zero Trust. Enabling it is a
one-time, roughly one-minute step in the dashboard — but **Cloudflare requires a
credit card on file to enable it, even on the free plan** (you are not charged on the
free tier). This is the operator's card, once; your clients never see it and never
need one of their own.

- **Check:** `preflight` reports Zero Trust as enabled; or you can reach
  <https://one.dash.cloudflare.com>.
- **Get it:** open <https://one.dash.cloudflare.com>, choose a team name, pick the
  **Free** plan, and add the card. Enable it *last* — it's the one step that can't be
  cleanly undone.

### A Cloudflare API token

Provisioning the Access apps and the viewer group needs an API token with these
scopes (the provisioning script lists them too):

**Account** — `Access: Apps and Policies` (Edit) · `Access: Organizations, Identity
Providers, and Groups` (Edit — *this is where groups live, and it's easy to miss*) ·
`Workers KV Storage` (Edit) · `Workers Scripts` (Edit) · `Account Settings` (Read)
**Zone** (your domain) — `Workers Routes` (Edit)

- **Check:** `preflight` verifies the token and names any missing scope.
- **Get it:** create it at <https://dash.cloudflare.com/profile/api-tokens>, then
  hand it to the tooling via the environment (`export CF_API_TOKEN=…`) or `.env.local`
  (which is gitignored). Never commit it.

---

## The 30-second self-check

If you'd rather eyeball it before running anything:

```bash
node --version        # v22+ ?
git --version         # present ?
pnpm --version        # present ?
```

(For Cloudflare, let `make preflight` name your account rather than a bare
`wrangler whoami` — wrangler needs Node 22, which the `make` targets select for you.)

Then let the tooling do the rest: `make setup` gets the repo ready, and
`make preflight` verifies your Cloudflare account and token before you spend a
deploy. If either names something missing, the fix is on this page.

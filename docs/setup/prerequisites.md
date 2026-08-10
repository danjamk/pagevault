# Prerequisites

What you need depends on which tier you choose. Most people start at **Public** —
links anyone with the URL can open — which needs very little and costs nothing.
**Secured** adds named-people access control, and with it a domain and Zero Trust.

`make preflight` checks all of this for you and names anything missing, so you don't
have to work through this list by hand. This page is the human reference: what each
prerequisite is, how to check it yourself, and where to get it.

Each item below has a **Check** (a command you can run) and a **Get it** (where to go
if you don't have it).

---

## Which operating system

Only the person running PageVault needs any of this. People you send links to open a URL in
a browser, on anything, including a phone.

| | Status |
| --- | --- |
| **macOS** | What I develop on. |
| **Linux** | Tested on every commit — CI runs the full suite on Ubuntu. |
| **Windows** | The document commands are plain Node and portable. `init` deploys natively. Two path-handling defects were fixed in 0.28.0; before that, `init` failed on Windows. Tested by hand rather than in CI, because provisioning needs a real Cloudflare account. |
| **WSL2** | Identical to Linux, because it *is* Linux. The safe fallback if native Windows gives you trouble. |

Two things to know if you are on Windows:

- **Do not write your API token with `echo … > .env.local`.** Windows PowerShell 5.1 writes that
  file as UTF-16, PageVault reads UTF-8, and the result is a token that is invisible to the tool
  while looking perfectly correct in Notepad. Run `pagevault init` and **paste the token at its
  prompt** instead — it writes the file through Node and gets the encoding right.
- **`pagevault export --zip` does not zip on Windows.** There is no `zip` command; the export
  folder is written and left in place, with a note saying so. Nothing is lost.

WSL is a genuine fallback, not a requirement — but be aware that `~/.pagevault` inside a WSL
distro is a *different* config from the Windows one. Run `init` in WSL and then `pagevault` from
PowerShell, and you get a second, empty install with no hint why.

---

## Public — links anyone with the URL can open

Everything here is free, and none of it needs a credit card.

### A Cloudflare account

The Worker, the KV store, and your links all live on Cloudflare's free tier.

- **Check:** you can sign in at <https://dash.cloudflare.com>.
- **Get it:** sign up at <https://dash.cloudflare.com/sign-up>. The free plan is
  enough for Public, with or without your own domain. No card required.

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

### A Cloudflare API token

This is how PageVault reaches your account — at **both** tiers. A token is explicit and
lives per-clone in `.env.local`, so a deploy can never drift to the wrong account the way
a machine-wide login can. It also lets the tooling do everything over the API: create the
KV, register your workers.dev subdomain, set your bearer secret — no interactive prompts.

Create it at [API Tokens](https://dash.cloudflare.com/profile/api-tokens) → *Create Custom
Token*. Public needs three scopes; grant the whole set once so climbing never means
re-scoping:

**Account** — `Workers Scripts` (Edit) · `Workers KV Storage` (Edit) · `Account Settings`
(Read)  ← *Public*
plus for a domain and for Secured: `Workers Routes` (Edit) · `DNS` (Edit) · `Access: Apps and Policies` (Edit) ·
`Access: Organizations, Identity Providers, and Groups` (Edit — *groups hide here, easy to miss*)

- **Save it:** `echo 'CLOUDFLARE_API_TOKEN=…' > .env.local`  (gitignored, never committed)
- **Check:** `make preflight` verifies the token, names the account, and flags any missing scope.

---

## Targeting a specific Cloudflare account

`wrangler` deploys to whatever account it is signed into machine-wide — a problem if
you have more than one (a personal account and a client's, or a throwaway test
account). `make preflight` **names the account** it will use; if that is not the one
you want, point the tooling at the right account with an API token.

**1. Create a token** in the *target* account's dashboard →
[API Tokens](https://dash.cloudflare.com/profile/api-tokens) → *Create Custom Token*.
For Public it needs three scopes:

- `Workers Scripts` — Edit
- `Workers KV Storage` — Edit
- `Account Settings` — Read

(Secured needs the fuller set below.)

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

## Public, on your own domain

One more thing on top of the above. Note this changes the *address*, not who can read a
document — a Public deployment on your own domain is still public. Access control starts
at Secured.

### A domain, in the same Cloudflare account

A custom domain replaces the `*.workers.dev` URL with your own. PageVault serves a
**subdomain** — `pagevault.example.com`, `reports.example.com` — so your existing website
at `example.com` is untouched.

What Cloudflare needs is the **apex domain's DNS**. Not the registration, not the website,
not the email — the nameservers. Which of two situations you are in decides everything:

| Your situation | Can you do this? |
|---|---|
| The domain's DNS **can move** to Cloudflare (or is already there) | **Yes** — free, ~15 minutes plus propagation |
| The domain's DNS **must stay** where it is, and you want only a subdomain delegated | **No** — Enterprise-only |

⚠️ **The second row is a hard limit, not a difficulty.** Cloudflare's
[subdomain setup](https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/) —
adding `reports.example.com` as a zone of its own while the apex stays elsewhere — is
available on **Enterprise plans only**. Free, Pro and Business can do full setup and nothing
else. If your DNS genuinely cannot move, use a different domain, or stay on `*.workers.dev`.

- **Check:** the domain appears under **Websites** in your Cloudflare dashboard, status
  *Active*. `make preflight` checks the same thing and names what is wrong.
- **Already on Cloudflare?** Nothing to do. Skip to the install.

#### Moving a domain's DNS to Cloudflare

The part that sounds alarming and is not: **your registration does not move**, you do not
transfer the domain, and your existing website and email keep working. You are changing
which nameservers answer for the domain.

1. **Add the site.** Cloudflare dashboard → *Add a site* → the **apex** domain
   (`example.com`, never `reports.example.com`) → **Free** plan.
2. **Check what it imported.** Cloudflare scans your current DNS and copies what it finds.
   This is the step that matters — go through the record list against your current provider
   before continuing. **`MX` records are the ones to verify**: a missing `MX` is silently
   broken email, and you will find out from a client rather than from an error.
3. **Change the nameservers at your registrar** — GoDaddy, Namecheap, Squarespace, Google
   Domains, wherever the domain is registered. Cloudflare gives you two to paste in.
4. **Wait for *Active*.** Usually minutes, occasionally up to 24 hours. Cloudflare emails you.
5. **Then run the install** with `pagevault.example.com` as the host.

> Have the domain in a *different* Cloudflare account? It can't be used across accounts —
> register or move one into the account running PageVault.

> No domain at all, and you don't mind buying one? **Cloudflare Registrar** is the shortcut —
> a domain registered there lands in your account already Active, and steps 1–4 do not happen.
> A cheap throwaway domain is fine for testing.

---

## Secured — named people, and client portals

This is the tier that turns on Cloudflare Access, and the only one with a real cost
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

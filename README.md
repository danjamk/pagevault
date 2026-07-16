# PageVault

Self-hosted, single-file HTML publishing with per-document access control, on
Cloudflare's free tier. Publish a report you made in a chat and get back a URL —
open to anyone you send it to, or locked to specific people. Whoever opens it
installs nothing.

![License: MIT](https://img.shields.io/badge/License-MIT-34507A) &nbsp;
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-34507A)

> **Draft.** This README is being written alongside the build. The status section
> is honest about what works today and what doesn't yet.

## The link is not the unit. The client is.

Most tools that share an artifact treat the link as the unit: one document, one
URL, one email. Over a nine-month engagement with one client that becomes fourteen
links in fourteen emails — and the client digging through Gmail in March for the
architecture doc you sent in January.

PageVault makes the **client** the unit. Documents are grouped into a portal, and
permissions live on the portal, not each document — so adding someone to a client's
team is one change, not fourteen. And the collection reads back: six months in,
*"what did we decide about the migration?"* is a question the portal can answer,
over the same MCP server you published through. Publishing and remembering become
the same act.

And portals stay invisible until you want them. Your first publish is a public
link with no account, no domain, and no Cloudflare Access — you add your domain, and
then clients, only when you have a reason to.

## Features

- **Publish from a chat.** A remote MCP server runs inside the Worker, so you
  publish from the conversation where you made the artifact — not a terminal.
  (Claude Code today; Desktop, web, and mobile as their auth support lands.)
- **Start free, climb when you need to.** Publish public links with nothing bought;
  add your own domain, then email-secured client portals, as separate opt-in steps.
  See the ladder below.
- **Two ways to share, per document.** A public capability link — an unguessable
  URL, no login, no account — or a link locked to named email addresses, who prove
  they own their email with a one-time code. No account to create either way.
- **One authorization function.** Cloudflare Access answers *"who are you?"*; the
  Worker answers *"may you see this?"* in exactly one function, `canView()`. That
  is the whole authorization surface.
- **Every artifact is treated as hostile.** It is LLM-generated and it runs
  JavaScript, so it renders inside a sandboxed iframe with no access to the trusted
  page around it, behind a strict CSP.
- **The collection reads back.** `read_document` and `search_portal` over MCP make
  the portal memory, not just an outbox.

## How it compares

Honest version, including the rows where the other tools win.

| | PageVault | [`jonesphillip/sharehtml`](https://github.com/jonesphillip/sharehtml) | Client-portal SaaS | Vercel / Netlify password |
|---|---|---|---|---|
| Cost | Free (CF free tier) | Free (self-host) | $19–$479 / mo | $150 / mo · ~$19 / mo |
| Self-hosted, your domain | ✅ | ✅ | ❌ | ❌ |
| Publish from a chat (MCP) | ✅ remote MCP | ❌ CLI-only skill | ❌ | ❌ |
| Per-document access control | ✅ | ❌ link is public | ✅ | ❌ whole-site only |
| Per-client collection | ✅ | ❌ the link is the unit | ✅ (+ CRM / billing) | ❌ |
| Comments · reactions · presence | ❌ | ✅ | ✅ | ❌ |
| Markdown / code render · diff · pull | ❌ | ✅ | — | — |
| Invoicing · contracts · e-sign · CRM | ❌ by design | ❌ | ✅ | ❌ |
| Maturity | new | more established | mature | mature |

Where the others win, plainly: if you want threaded comments and live presence on a
document, `jonesphillip/sharehtml` already does that well and PageVault does not. If
you need invoicing, contracts, and a CRM around your client work, a client-portal
SaaS is a different and much larger product. PageVault is deliberately none of that —
it does access-controlled publishing and the collection, and stops there.

## The ladder

Three rungs. Climb only as far as you need — each one is additive, and your
documents carry across untouched.

| Rung | You get | It needs |
|---|---|---|
| **1 · Publish** | Deploy, publish HTML, share public `/p/` links | a Cloudflare account (**no card**), Node, `wrangler login` |
| **2 · Your domain** | The same, on `pagevault.you.com` | a domain in that Cloudflare account |
| **3 · Portals** | Client collections, email-secured access, the owner console | Cloudflare Zero Trust (**needs a card on file**) |

Rungs 1 and 2 cost nothing and undo cleanly. Only rung 3 is a commitment, and it's
the only rung a client ever authenticates against (with a six-digit email code — no
account, no password).

## Quick start

Full prerequisites, and where to get each, are in
[`docs/setup/prerequisites.md`](docs/setup/prerequisites.md). `make preflight`
checks them for you before you deploy.

**Rung 1 — publish public links** (no domain, no card):

```bash
git clone https://github.com/danjamk/pagevault && cd pagevault
make setup        # install deps, scaffold config, check your environment
make preflight    # verify your Cloudflare account + token before deploying
make deploy       # deploy to a *.workers.dev URL
make verify       # smoke-test the live deployment
```

Then publish from a chat over MCP (or the CLI), and share the `/p/` link — anyone
opens it, no login. Locally, `make dev` runs the Worker against Miniflare and
`make demo` seeds a sample engagement.

**Climbing the ladder:** to add your domain (rung 2) or turn on portals (rung 3),
re-run `make setup`, pick the higher rung, then `make preflight` and `make deploy`
again. Your documents carry across. `make help` lists every target.

> Rung 3 (portals) provisioning works, but is not yet wired to the shared config
> file — it prompts you through the details itself for now
> ([#9](../../issues/9)).

## Status

- **Works today:** publishing over MCP (Claude Code), public-link sharing,
  email-secured sharing, portals, and the owner console — end to end on a live
  deployment.
- **In progress:** the one-command ladder above ([#32](../../issues/32),
  [#9](../../issues/9)) and its docs.
- **Parked:** OAuth for the hosted surfaces (claude.ai / Desktop / mobile) is built
  and proven end to end, but blocked upstream by a current claude.ai-side connector
  regression that drops token binding for newly added connectors
  ([#22](../../issues/22)).

## How it works

- **The Worker is the whole product.** A router, `canView()`, the KV store, the
  `/api` handlers, the remote MCP server, and the viewer shell — small enough to
  read in one sitting.
- **The Worker verifies the JWT itself.** It never trusts a Cloudflare header or the
  `CF_Authorization` cookie. Access proves identity; the Worker decides access.
- **The MCP server is remote, not stdio.** A stdio server can't run in a browser or
  on a phone, which is where artifacts actually get made.

Design and decisions:

- [`docs/design/onboarding-experience.md`](docs/design/onboarding-experience.md) — the setup ladder, in full
- [`docs/architecture.md`](docs/architecture.md) — the design
- [`docs/adr/`](docs/adr/) — the decision records, including the contested ones

## Credits

PageVault owes [`jonesphillip/sharehtml`](https://github.com/jonesphillip/sharehtml)
(Apache-2.0) three ideas: the Cloudflare Access provisioning script, the
capability-token model, and the sandboxed iframe.

## License

MIT. Fork it, steal it, run your own.

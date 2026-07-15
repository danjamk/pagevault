# PageVault

Self-hosted, single-file HTML publishing with per-document access control, on
Cloudflare's free tier. Publish a report you made in a chat and get back a URL —
open to anyone you send it to, or locked to specific people. Whoever opens it
installs nothing.

![License: MIT](https://img.shields.io/badge/License-MIT-34507A) &nbsp;
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-34507A)

> **Draft.** This README is being written alongside the build. The comparison and
> status sections are honest about what works today and what doesn't yet.

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

Portals stay invisible until you want them. `publish report.html` works without you
ever learning what a portal is.

## Features

- **Publish from a chat.** A remote MCP server runs inside the Worker, so you
  publish from the conversation where you made the artifact — not a terminal.
  (Claude Code today; Desktop, web, and mobile as their auth support lands.)
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
- **Free tier, your domain.** One Cloudflare Worker, Workers KV, your own hostname.
  Public links cost zero Cloudflare Access seats.

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

## Status

- **Works today:** publishing over MCP, and public-link sharing end to end.
- **In progress:** email-secured sharing ([#20](../../issues/20)) and one-command
  setup ([#9](../../issues/9)).

## Quick start

> Two tiers. Tier 0 gets you sharing public links with no Cloudflare Access and no
> API token. Tier 1 adds email-secured viewing and portals when you want clients.
> (Tier 0 as a single command is [#9](../../issues/9); today it is the steps below.)

```bash
git clone https://github.com/danjamk/pagevault && cd pagevault
make install
make dev          # run the Worker locally against Miniflare
make demo         # seed it with a sample engagement, then open the printed URL
```

Deploying to your own Cloudflare account:

```bash
make provision    # create KV, the Access apps, and the viewer group
make deploy       # deploy the Worker to your domain
```

`make help` lists every target.

## How it works

- **The Worker is the whole product.** A router, `canView()`, the KV store, the
  `/api` handlers, the remote MCP server, and the viewer shell — small enough to
  read in one sitting.
- **The Worker verifies the JWT itself.** It never trusts a Cloudflare header or the
  `CF_Authorization` cookie. Access proves identity; the Worker decides access.
- **The MCP server is remote, not stdio.** A stdio server can't run in a browser or
  on a phone, which is where artifacts actually get made.

Design and decisions:

- [`docs/architecture.md`](docs/architecture.md) — the design
- [`docs/adr/`](docs/adr/) — the decision records, including the contested ones

## Credits

PageVault owes [`jonesphillip/sharehtml`](https://github.com/jonesphillip/sharehtml)
(Apache-2.0) three ideas: the Cloudflare Access provisioning script, the
capability-token model, and the sandboxed iframe.

## License

MIT. Fork it, steal it, run your own.
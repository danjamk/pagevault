# Connect Claude to your PageVault MCP server

PageVault's MCP server is **remote** — it lives in your Worker at `https://share.<yourdomain>/mcp`,
not on your laptop (ADR-006). That is the whole point: it reaches claude.ai, Claude Desktop,
mobile, and Claude Code, none of which can spawn a local process. This page is how you point each
of them at it.

There are two ways to authenticate, and which one you use decides which path below you follow:

- **OAuth (the account connector).** If your deployment has the OAuth server enabled (it does by
  default from 0.9.0), Claude logs in through Cloudflare Access and you never paste a token. This
  is the path for **claude.ai and Claude Desktop**.
- **A bearer token** (`PAGEVAULT_API_TOKEN`). The long-lived operator token the CLI already uses.
  This is the path for **Claude Code**, and the fallback on a **Public** deployment, which has no
  Cloudflare Access for OAuth to log you in against.

You do not need both. Pick the row that matches your client.

---

## claude.ai and Claude Desktop — the account connector

This is the normal path, and it is the same on the web and the desktop app because both use your
Claude account's connectors.

1. Open **Settings → Connectors** (the menu label moves around; look for "Connectors" or "Custom
   connectors").
2. **Add a custom connector** and give it your server URL:
   ```
   https://share.<yourdomain>/mcp
   ```
3. Claude discovers the OAuth server and sends you through **Cloudflare Access** — the same login
   wall that guards your documents. Complete it with an operator identity.
4. Approve the consent screen. The PageVault tools now appear in that Claude surface.

That's it — no token, no config file. The connector is tied to your account, so once it's added on
the web it is available in Desktop too (and vice versa).

> **Nothing appears / it won't connect?** The Worker fails closed without a valid token, so a
> connector that never completed the Access login simply won't list tools. Re-run the connect flow
> and make sure you finish the Cloudflare Access step.

---

## Claude Code — remote MCP with a bearer token

Claude Code authenticates with the operator token directly (the static-bearer path the Worker keeps
alongside OAuth, so Code keeps working — ADR-006):

```bash
claude mcp add --transport http pagevault https://share.<yourdomain>/mcp \
  --header "Authorization: Bearer $PAGEVAULT_API_TOKEN"
```

Then `claude mcp list` should show `pagevault` connected. This is the same token the CLI stores via
`pagevault login`; keep it out of your shell history (the `$PAGEVAULT_API_TOKEN` env var above does
that).

---

## Public deployments — the `mcp-remote` bridge

On a **Public** deployment there is no Cloudflare Access, so OAuth has no identity provider to send
you to and the connector's discovery finds nothing. If you want that deployment in a client that
only speaks the account connector or a stdio config file, bridge it with the community
`mcp-remote` tool and the bearer token — no PageVault code required:

```bash
npx mcp-remote https://share.<yourdomain>/mcp --header "Authorization: Bearer <PAGEVAULT_API_TOKEN>"
```

Point your client's stdio MCP config at that command. We deliberately do **not** ship our own stdio
shim for this — the generic bridge already does it, and a remote server is the architecture we
committed to ([#21](https://github.com/danjamk/pagevault/issues/21) was closed for exactly this reason).

---

## One limit worth knowing

**Claude Desktop truncates a large tool result** (roughly the first ~150k characters). A
`read_document` on a very large deliverable can come back cut off in Desktop. If you need the whole
thing, read it from the CLI instead:

```bash
pagevault read <id> --source > document.html
```

claude.ai and Claude Code do not share that ceiling.

---

## What you get once connected

Fifteen tools, split into a write side (`publish_document`, `edit_document`, `create_portal`,
`update_portal_members`, `pin_documents`, the public-link lifecycle — `mint_public_link`,
`rotate_public_link`, `revoke_public_link` — and `revoke_document`) and the read side that makes the
portal *memory* rather than an outbox (`list_portals`, `list_documents`, `read_document`,
`search_portal`, plus `traffic` and `server_info`). The full surface and its rules are in
[`../architecture.md`](../architecture.md); the standard it's held to is
[`../engineering/mcp-best-practices.md`](../engineering/mcp-best-practices.md).

`traffic` is the one that answers *volume* — how much was read last week, which client is busiest,
whether a referrer is producing anything. Ask it in the conversation you are already having about
that client. It reports counts and surfaces and never who read something: the stored history has
never held an identity. Its numbers come from the operator's last `pagevault sync-views`, and it
says so in its own output, so a model reports "as of Tuesday" rather than implying it just looked.

`pagevault verify` checks this count against the live deployment, so if the number here and the
number it prints ever disagree, this file is the one that is wrong.

---

## A second server worth having — Cloudflare's own

PageVault's MCP server knows about your *documents*. It knows nothing about the infrastructure
underneath them: it cannot read the Worker's logs, list your KV namespaces, or tell you why a deploy
failed. That is deliberate — the Worker holds the narrowest credential that does its job (ADR-002),
and a Worker that could read its own account would be a wider blast radius for no gain to publishing.

Cloudflare publishes [its own MCP servers](https://github.com/cloudflare/mcp-server-cloudflare),
and two of them pair well with running PageVault:

| Server | What it answers |
|---|---|
| **Observability** | *"Why did that publish 500?"* — queries your Worker's logs directly |
| **Developer Platform** | *"Which KV namespaces exist, and is the binding pointing at the right one?"* |

Both also search Cloudflare's documentation, which is worth more than it sounds during a first
Zero Trust setup. Connected alongside PageVault's server, one conversation can go from *"the client
says the link is broken"* to reading the actual error in the Worker log, without leaving the chat.

**The trade, stated plainly:** these servers authenticate to your **whole Cloudflare account** — every
Worker, every namespace, every zone. That is a broader grant than anything PageVault itself holds,
and broader than the account-scoped analytics token that [ADR-015](../adr/ADR-015-what-a-view-record-contains.md)
specifically refuses to put in the Worker.

Those two things are not in tension, but the difference is worth naming: PageVault's refusal is about
a *permanent server-side credential living in an internet-facing Worker*, where a compromise is
silent and continuous. A Cloudflare MCP connection is a *local client you authorize, watch, and can
revoke in one click*. Different shape of risk — but a real grant either way, so make it on purpose
rather than because a setup guide told you to. Neither PageVault nor this guide requires it.

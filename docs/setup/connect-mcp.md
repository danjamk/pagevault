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
  This is the path for **Claude Code**, and the fallback for a Tier-0 deployment that has no OAuth.

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

## Tier-0 / bearer-only fallback — `mcp-remote`

If you're running a **Tier-0 deployment with no OAuth** (no Cloudflare Access, just the bearer
token) and you want it in a client that only speaks the account connector or a stdio config file,
there is nothing for the connector's OAuth discovery to find. Bridge it with the community
`mcp-remote` tool — no PageVault code required:

```bash
npx mcp-remote https://share.<yourdomain>/mcp --header "Authorization: Bearer <PAGEVAULT_API_TOKEN>"
```

Point your client's stdio MCP config at that command. We deliberately do **not** ship our own stdio
shim for this — the generic bridge already does it, and a remote server is the architecture we
committed to ([#21](../../../issues/21) was closed for exactly this reason).

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

Eleven tools, split into a write side (`publish_document`, `create_portal`,
`update_portal_members`, the public-link lifecycle, `revoke_document`) and the read side that makes
the portal *memory* rather than an outbox (`list_portals`, `list_documents`, `read_document`,
`search_portal`). The full surface and its rules are in [`../architecture.md`](../architecture.md);
the standard it's held to is [`../engineering/mcp-best-practices.md`](../engineering/mcp-best-practices.md).

# ADR-006 — The MCP server is remote, not stdio

**Status:** Accepted
**Date:** 2026-07-14

## Context

MCP is the reason this project exists. `sharehtml` — the closest competitor — has no
MCP server; we read their tree to confirm it. They ship a *skill* that shells out to
their CLI, which works only where there is a terminal: Claude Code, Codex, OpenCode.

The stated differentiator is that PageVault works where artifacts actually get made:
**Claude Desktop, claude.ai, mobile, Cowork, and Claude Code.** You do not ask Claude
Code to write a client report. You write it in a conversation, and then you are
holding an artifact with no terminal in sight.

The original plan was a **stdio** MCP server — an npm package Claude spawns as a
subprocess.

**A stdio server cannot run in a browser or on a phone.** There is no subprocess to
spawn. It covers Claude Code and Claude Desktop — precisely the two surfaces where
you already have a terminal — and nothing else.

So the design as planned delivered exactly the surface sharehtml already covers, and
missed the one the entire strategy claims as open ground. The differentiator was
architecturally unmet.

## Decision

**`/mcp` on the Worker. Streamable HTTP. Remote.**

- `createMcpHandler` from the `agents` SDK. **No Durable Objects**, works on the
  Workers free plan.
- **Streamable HTTP, not SSE.** SSE is the legacy transport and is deprecated; the
  MCP spec defines only stdio and Streamable HTTP.
- **Stateless.** The MCP spec is actively moving this way — the next release removes
  protocol-level sessions and the `initialize` handshake entirely. Do not build
  session state we do not need.
- **A new `McpServer` instance per request.** Sharing one across requests leaks
  cross-client response data — the SDK added a guard against exactly this. Given what
  this product stores, that is an incident, not a bug.
- `/mcp` has **no Access application in front of it** and never can. Anthropic's
  connector infrastructure calls it from their cloud (`160.79.104.0/21`) — no browser,
  no cookie, no way to complete an OTP login. Access would hard-block it. The Worker
  authenticates it, which is what the Worker does everywhere (ADR-004).

**Auth is staged, deliberately:**

| Stage | Auth | Reaches |
|---|---|---|
| **Now (validation)** | Bearer token | Claude Code. Plus Claude Desktop via a thin stdio bin that proxies to `/mcp`. |
| **Pre-launch** | OAuth 2.1 | claude.ai, Desktop, mobile, Cowork — the actual differentiator |

Because on the hosted surfaces, the only **generally available** auth is OAuth 2.1
(PKCE, RFC 9728 protected resource metadata, DCR or CIMD). Static bearer headers —
the thing that would take fifty lines — exist as `static_headers` but are **beta and
gated behind contacting Anthropic**. You cannot ship a public repo whose setup
instructions begin "first, email Anthropic for beta access."

## Alternatives considered

**stdio, as originally planned.** Simple, no auth story, works today in Desktop and
Claude Code. Rejected: it does not reach the browser or the phone, which is the entire
claimed differentiator. Retained only as a thin proxy shim to the remote endpoint, so
Claude Desktop works before OAuth lands.

**Remote with full OAuth 2.1 now.** Reaches every surface today.
`@cloudflare/workers-oauth-provider` collapses much of the surface area, and it is
arguably in the same category as `jose` — a security primitive you should not
hand-roll. Rejected **for the MVP only**, on sequencing: OAuth is not small enough to
read in one sitting (prime directive #2), it is a real dependency (directive #6), and
**it is not needed to validate the thesis.** The kill criterion is "use it on a real
client engagement for a month" — that is one operator, in Claude Code and Desktop,
where a bearer token is enough. OAuth buys reach, and reach is a launch concern. It
is a pre-launch requirement, not a pre-validation one.

**Wait for `static_headers` to reach GA.** If Anthropic grants it, static bearer
tokens work on every surface and the OAuth work **evaporates** — a ~50-line endpoint
instead of an authorization server. This is worth an email before committing to
OAuth, and it costs nothing to ask. It is not a plan on its own, because it depends on
someone else's roadmap.

**`.mcpb` bundle for Claude Desktop.** Solves "my user has to install Node and
hand-edit JSON." Rejected: Desktop-only, Team/Enterprise-only, and it is a build
pipeline — which directive #2 counts as a cost. It buys nothing on web or mobile,
which is the problem we are actually solving.

## Consequences

- The MCP server is **not** a separate npm package that talks to the API over HTTP. It
  is part of the Worker, calling the same internal handlers. Less code, one auth
  model, nothing to version-skew.
- A thin stdio bin still ships, but it is a **proxy to `/mcp`**, not a reimplementation.
  It exists so Claude Desktop works before OAuth, and it should get smaller over time,
  not larger.
- `/mcp` is a second, independent auth surface next to Access-protected `/v` and
  `/admin`. That is deliberate and it should be designed as such, not treated as an
  exception.
- **OAuth 2.1 is now on the critical path to launch**, and it is the single largest
  piece of work in the plan. If `static_headers` lands first, delete it.
- Read-side MCP tools (`read_document`, `search_portal`) must go through the same
  `canView()` as everything else. A token scoped to portal A must not be able to
  search portal B. This is the cross-portal threat wearing a read-only disguise, and
  it is the version most likely to be gotten wrong, because it feels like a
  convenience feature.
- Tool results are capped (~150k chars on claude.ai/Desktop, 25k tokens in Claude
  Code). `read_document` on a 200KB report will blow a context window. Cap and
  truncate deliberately.
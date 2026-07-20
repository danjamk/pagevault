# MCP server — best practices and our conformance

**What this is.** The standard I hold PageVault's remote MCP server to, the reasoning
behind each rule, and an honest scorecard of where the server meets it today. It is
doctrine, not a plan: when the open items below close, this page stays as the bar the
next change gets measured against.

**Why it exists.** The MCP server is the reason this project exists (ADR-006). "Best
practice" for it is not a vibe — the spec is prescriptive, and Anthropic has published
concrete guidance on writing tools agents actually use well. This collects both, filtered
to what applies to a single-operator, remote, Cloudflare-Worker MCP server, so a future
change has one place to check against.

**Spec baseline.** Latest stable is **MCP 2025-11-25** (it supersedes 2025-06-18). A
**2026-07-28** release candidate is locked; it hardens OAuth and adds an experimental
async Tasks API, and it aligns with the direction below rather than reversing it. When a
rule below cites a spec revision, it is the one that introduced or last changed the rule.
Full reference list at the bottom.

---

## The short version

The server is already above the median on the parts people usually get wrong — request
isolation, auth posture, errors-as-results, and description quality. Two of the four gaps
between "good" and "reference-quality" are now closed (#80, 0.12.0); two remain, in
leverage order:

1. ~~**Tool annotations** — we ship none.~~ ✅ **Done (#80).** All tools carry
   `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` + a human `title`.
2. ~~**Server `instructions`** — unset.~~ ✅ **Done (#80).** The three cross-cutting rules
   (portal boundary, capability links, publish-overwrite) are stated once at `initialize`
   and de-duplicated out of the per-tool descriptions.
3. **Structured tool output** — everything is prose; the read→publish chain re-parses IDs.
4. **Resources** — documents are addressable content we expose only through tools.

The sequenced work that closes the remaining two is at the end.

---

## Where we already meet the bar

Credit the parts that are done right, because they are the parts that are usually done
wrong and they are load-bearing here:

- **A fresh `McpServer` per request** (`worker/src/mcp.ts`). Sharing a server or transport
  across requests can leak one client's response data into another's — the SDK added a
  guard against exactly this. For a product that stores one client's confidential
  deliverables next to another's, this is not hygiene, it is the whole ballgame. Done, and
  documented in place.
- **Errors returned as `isError` tool results, not thrown exceptions.** MCP 2025-11-25
  (SEP-1303) sharpened this and added that *input-validation* errors belong here too —
  anything the model can self-correct from is a result, not a protocol error. Our
  `toolError` / `BadRequest` path already does this.
- **Auth posture matches the security spec.** The Worker verifies the JWT itself, pins the
  audience, and never passes a client token through to a downstream API (ADR-004, ADR-012).
  The spec's RFC 8707 audience-binding and no-token-passthrough requirements are our prime
  directives #5 and #6 almost verbatim.
- **Tool descriptions are written to the "onboarding a new hire" bar** Anthropic asks for —
  portal-selection rules, capability-URL warnings, the update-in-place semantics. Most
  servers ship one-line descriptions; ours teach. Keep this bar for every new tool.

## The rules, and where we stand

### 1. Tool design — fewer, well-shaped tools; high-signal returns

**The rule.** Don't wrap every endpoint one-to-one. Build tools that match how an agent
works, return human-readable values over opaque IDs, and make descriptions explicit about
formats and relationships. Namespacing (a common prefix) both groups related tools and
defends against name collisions with other connected servers. Spec naming rules (2025-11-25,
SEP-986): 1–128 chars, `A–Z a–z 0–9 _ - .`, unique within a server.

**Where we stand.** Good. Eleven tools, `verb_noun`, consistent, each narrowly scoped. Two
standing calls worth recording so they don't get re-litigated:

- **We do not consolidate the public-link trio** (`mint` / `revoke` / `rotate`). Anthropic
  favors fewer tools, and normally that wins — but merging three distinct
  *widening/destructive* actions behind one `mode` enum would bury the safety semantics the
  descriptions work to surface. They stay separate, on purpose.
- **We keep the read-side surface even though it lengthens the list.** `list_portals`,
  `list_documents`, `read_document`, `search_portal` are the differentiator (the collection
  reads back). They earn their place.

Open question for any future growth: the tool names are currently unprefixed. If cross-server
collisions ever bite (another connected server also exposing `search`), a `pagevault_` prefix
is the fix — not needed today, noted for later.

### 2. Tool annotations — the untrusted-but-useful behavior hints

**The rule.** Set `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, and a
human `title` on every tool. Hosts (Claude, VS Code) use them for UX — `readOnlyHint` drives
auto-approve vs. confirm, `destructiveHint` gates retry warnings. **The spec states twice that
clients MUST treat annotations as untrusted hints, never a security control.** So we set them
honestly for good client behavior; we never rely on another server's being honest, and they
never substitute for `canView()`.

**Where we stand.** ✅ **Done (#80, 0.12.0).** Every tool is on `registerTool` and carries the
annotation table below; `revoke_document` now says `destructiveHint` on the wire. `mcp.test.ts`
asserts the read tools are `readOnlyHint` and the four destructive tools are flagged.

| Tool | readOnly | destructive | idempotent | title |
|---|:---:|:---:|:---:|---|
| `list_portals` / `list_documents` / `read_document` / `search_portal` | ✅ | — | ✅ | "List portals", … |
| `create_portal` | — | — | — | "Create portal" |
| `publish_document` | — | ⚠️ overwrites in place | — | "Publish document" |
| `update_portal_members` | — | — | ✅ | "Update portal members" |
| `mint_public_link` | — | — | ✅ (returns existing) | "Mint public link" |
| `rotate_public_link` | — | ✅ kills old URL | — | "Rotate public link" |
| `revoke_public_link` | — | ✅ | ✅ | "Revoke public link" |
| `revoke_document` | — | ✅ **no undo** | ✅ | "Delete document" |

### 3. Server instructions — the server-level system prompt

**The rule.** The `instructions` string returned at `initialize` is where you tell the model
what the server is for and how to use it. Best-in-class servers write it deliberately.

**Where we stand.** ✅ **Done (#80, 0.12.0).** The three cross-cutting rules — portal = client
boundary and never guess (prime directive #5), public links are capability URLs, and
publish-overwrites-in-place — are stated once in `instructions` (the `INSTRUCTIONS` constant in
`worker/src/mcp.ts`) and returned at `initialize`. The per-tool descriptions were trimmed to
their specifics, but the security-critical rule stays *named* in the tools that enforce it
(`publish_document`, `search_portal`) so trimming never silently drops a guardrail.

### 4. Tool output — structured content alongside prose

**The rule.** If a tool declares an `outputSchema`, it MUST return `structuredContent`
conforming to it, and SHOULD *also* serialize a readable `text` block for backward compat and
for the model to reason over. Use structured output when something downstream parses fields;
use prose when the result is just for the model to read. Best-in-class does both.

**Where we stand.** ⚠️ Everything is hand-formatted prose. That is fine for a human-in-the-loop
read, but `list_documents` → `search_portal` → `read_document` → `publish_document` is a chain
an agent runs programmatically, and prose forces it to re-parse IDs out of text at each hop.
Add `outputSchema` + `structuredContent` to the four read tools and `publish_document` (so the
returned id/URL is machine-readable), and **keep the existing prose text block** — the point is
to add the structured payload, not replace the readable rendering we already have.

### 5. Resources — addressable content, not just model-invoked tools

**The rule.** Tools are model-controlled *actions*. Resources are user/app-controlled
*addressable data* (`resources/list` + `resources/read`, URI templates for parameterized
lookups, optional `subscribe`/`listChanged`). Rule of thumb: if the model decides when to
fetch, it's a tool; if the user or app picks it from a list, it's a Resource. A server can do
both, and tools can return `resource_link`s that point into the Resource space.

**Where we stand.** ⚠️ We expose documents only through tools. This is the most on-thesis
upgrade available and deserves its own ADR before any code. The project's pitch is *the
collection reads back — publishing and remembering are the same act*. Today that only works
when the model chooses to call `search_portal`/`read_document`. Resources are the other half:
exposing documents at `pagevault://<portal>/<id>` with a template lets a user **attach** the
January architecture doc as context deterministically instead of hoping the agent finds it.

The trade-off is real and is why this is ADR-gated, not a quick win: Resources are less
universally supported across hosts than tools, and it is genuine new surface. But of everything
here it is the item that makes our MCP server *distinctive* rather than merely correct, and it
is squarely inside the #73 surface-parity conversation.

### 6. Auth — OAuth 2.1 resource server

**The rule.** A remote MCP server doing HTTP auth is an OAuth 2.1 resource server. It MUST
serve **RFC 9728 protected-resource metadata** (`/.well-known/oauth-protected-resource`) and
answer an unauthenticated request with **401 + `WWW-Authenticate`** pointing at it (2025-11-25,
SEP-985, softened the header to optional with a `.well-known` fallback). It MUST validate that
every token's **audience is this server** (RFC 8707) and MUST NOT pass tokens downstream. DCR
(RFC 7591) is SHOULD, not MUST; 2025-11-25 adds Client ID Metadata Documents (SEP-991) and
incremental scope consent (SEP-835) as alternatives.

**Where we stand.** ✅ Shipped (v0.9.0, ADR-012): OAuth 2.1 via `@cloudflare/workers-oauth-provider`
with Cloudflare Access as the upstream IdP, DCR, and the bearer path preserved for Claude Code.
Three things to *verify* against 2025-11-25 rather than assume (likely fine, but they are MUSTs):

- The `.well-known/oauth-protected-resource` document is actually served and the 401 discovery
  path resolves to it. Our bearer path already returns `WWW-Authenticate: Bearer`; confirm the
  OAuth path advertises the metadata clients probe for.
- **403 on invalid `Origin`** for Streamable HTTP (new MUST). Confirm `createMcpHandler`
  enforces it or add it.
- **JSON Schema 2020-12** is now the default dialect (SEP-1613). Confirm the `inputSchema` our
  zod-4 shapes emit is sane under it.

These belong in #76's comprehensive-coverage scope.

### 7. Security — the named risks

**The rule.** The MCP security doc names them: **confused deputy** (per-client consent stored
and checked before forwarding upstream), **token passthrough** (never accept a token not issued
for us, never forward the client's token), **session hijacking** (never authenticate via
session; verify every request's token; bind session state to the verified user identity),
**SSRF** (HTTPS-only, block private/reserved ranges), **scope minimization**. "Tool poisoning"
— hostile instructions hidden in tool descriptions or results — is the same threat as our own
prime directive #4, *every artifact is hostile*.

**Where we stand.** ✅ Strong by construction. We never trust `Cf-Access-Authenticated-User-Email`
or the `CF_Authorization` cookie (ADR-004), so the confused-deputy surface largely does not
exist for us; we verify every request rather than trusting a session; we do not pass tokens
downstream. Keep it that way — this is the part that, if it regresses, is an incident, not a bug.

### 8. What we deliberately skip

Recording these so they are decisions, not oversights:

- **Cursor pagination** on list operations. Spec-correct, pointless at single-operator scale
  (dozens of docs). Our lists are already metadata-only and `read_document` truncates at 100KB.
- **Prompts** (server-provided templates) and **elicitation** (mid-call input requests). No
  canonical repeatable workflow demands a prompt template yet, and host support for elicitation
  is uneven. Parked, not rejected — revisit if a clear workflow emerges. Note the hard spec
  rule for whenever we do: elicitation **form mode MUST NOT request secrets**; those go through
  URL mode.
- **The experimental Tasks API** (SEP-1686) for long-running work. Watch it; don't depend on it
  while it is experimental.

---

## Conformance at a glance

| Area | Status | Action |
|---|---|---|
| Request isolation (server-per-request) | ✅ Meets | — |
| Errors as `isError` results | ✅ Meets | — |
| Auth posture (verify JWT, audience, no passthrough) | ✅ Meets | verify 3 spec MUSTs in #76 |
| Description quality | ✅ Meets | hold the bar |
| Security (confused-deputy, passthrough, session) | ✅ Meets | don't regress |
| Tool design / naming | ✅ Meets | prefix only if collisions appear |
| **Tool annotations** | ✅ Meets (#80) | done in 0.12.0 |
| **Server `instructions`** | ✅ Meets (#80) | done in 0.12.0 |
| **Structured tool output** | ⚠️ Prose-only | **P3** |
| **Resources** | ⚠️ Tools-only | **P4 (ADR-gated)** |
| Pagination / prompts / elicitation / Tasks | ⏭️ Skipped | recorded above |

## Sequenced work

P1 and P2 shipped in #80 (0.12.0) — `registerTool`, annotations, and server `instructions`, all
in `worker/src/mcp.ts`. Two remain, in leverage order:

1. ✅ **MCP polish — annotations + server instructions (P1 + P2).** Done (#80): migrated to
   `registerTool`, set the annotation table above, added `instructions`, de-duplicated the
   cross-cutting rules out of the tool descriptions.
2. **Structured tool output (P3).** `outputSchema` + `structuredContent` on the four read tools
   and `publish_document`, keeping the existing prose blocks.
3. **Documents as MCP Resources (P4).** ADR first (the trade-off is real), then implement
   `pagevault://<portal>/<id>` + a resource template. On-thesis; part of the #73 parity story.

`#76` (comprehensive MCP tests) trails all three: it should assert the annotations, validate the
structured schemas, and cover the three auth MUSTs flagged in §6.

---

## References

Primary sources, current as of this writing:

- MCP spec — tools: <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>
- MCP spec — changelog (2025-11-25): <https://modelcontextprotocol.io/specification/2025-11-25/changelog>
- MCP spec — elicitation: <https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation>
- MCP spec — authorization: <https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization>
- MCP spec — security best practices: <https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices>
- Anthropic — Writing effective tools for agents: <https://www.anthropic.com/engineering/writing-tools-for-agents>
- Anthropic — Code execution with MCP (tool-call efficiency): <https://www.anthropic.com/engineering/code-execution-with-mcp>
- Cloudflare — Model Context Protocol / Agents: <https://developers.cloudflare.com/agents/model-context-protocol/>
- MCP — 2026-07-28 release candidate: <https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/>

Internal: ADR-004 (console auth), ADR-006 (remote MCP), ADR-012 (OAuth consent / Access IdP),
`docs/engineering/mcp-auth-and-packaging-plan.md`, prime directives #4–#6 in `CLAUDE.md`.

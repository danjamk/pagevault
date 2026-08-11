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
isolation, auth posture, errors-as-results, and description quality. All four gaps between
"good" and "reference-quality" are now closed in code (#80, 0.12.0; #81; #82) — the last,
Resources, ships gated on a live host check (ADR-016):

1. ~~**Tool annotations** — we ship none.~~ ✅ **Done (#80).** All tools carry
   `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` + a human `title`.
2. ~~**Server `instructions`** — unset.~~ ✅ **Done (#80).** The three cross-cutting rules
   (portal boundary, capability links, publish-overwrite) are stated once at `initialize`
   and de-duplicated out of the per-tool descriptions.
3. ~~**Structured tool output** — everything is prose; the read→publish chain re-parses IDs.~~
   ✅ **Done (#81).** The five chain tools return `structuredContent` (id + opening `url` as
   fields) beside the unchanged prose.
4. ~~**Resources** — documents are addressable content we expose only through tools.~~
   ✅ **Built (#82, ADR-016).** Documents are addressable at `pagevault://<portal>/<id>`; the
   read reuses `readDocument()`, and the discovery tools return `resource_link`s. Shipping is
   gated on verifying a non-Desktop host renders the primitive usefully — see §5.

All four are closed in code. The Resources host-verification gate is the only open thread.

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

**Where we stand.** Good. Fifteen tools, `verb_noun`, consistent, each narrowly scoped
(`server_info` was added in #98 as the in-chat "what am I connected to, and is it current?"
check; `traffic` in #163 as the volume question, distinct from the per-document counts that ride
along on `list_documents`). `traffic` is the one bare noun — it names a subject rather than an
action because it only reads, and `get_traffic` would add a verb that carries no information.
Two standing calls worth recording so they don't get re-litigated:

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
| `edit_document` | — | — (a rename MOVES the URL) | ✅ | "Edit document" |
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

**Where we stand.** ✅ **Done (#81).** The four read tools and `publish_document` declare an
`outputSchema` and return `structuredContent` beside the prose — the id and a ready-to-open
`url` as fields, so the chain no longer re-parses IDs out of text. The prose block is unchanged.
Three things worth recording so they are not re-litigated:

- **The empty-result paths return structured content too.** The SDK makes a non-error success
  that omits `structuredContent` a *protocol* error (`validateToolOutput`) — exactly the failure
  §"errors as results" avoids. So `No documents found.` / `No matches…` return an empty array,
  not bare prose. `mcp.test.ts` pins each. Error paths stay `isError` and are exempt.
- **`url` respects the portal kind** — `/pub/` for a public portal, `/v/` otherwise — so an agent
  never hands out a `/v/` link that would burn an Access seat on a deliberately public document.
  `read_document` and `list_documents` resolve kind with one extra read (never per-document).
- **`read_document` reports `bytes` (true size) alongside a possibly-truncated `source`**, so
  `truncated: true` + `bytes` together tell an agent the payload is partial.
- **View metrics are optional fields whose *absence* is meaningful** (#127). `views`,
  `lastViewedAt` and `surfaces` appear only for documents that were actually measured; a
  document published since the last sync, or a deployment that has never synced, carries none of
  them. A present `views: 0` therefore means "measured, nobody opened it" — the answer worth
  having — and an absent one never gets read as that. The staleness stamp `viewsSyncedAt` rides
  alongside, and both tool descriptions say the numbers come from the last sync, so a model
  reports "as of Tuesday" rather than implying it just looked (ADR-019 decision 6). One extra KV
  read per call for the whole listing, never per-document.

### 5. Resources — addressable content, not just model-invoked tools

**The rule.** Tools are model-controlled *actions*. Resources are user/app-controlled
*addressable data* (`resources/list` + `resources/read`, URI templates for parameterized
lookups, optional `subscribe`/`listChanged`). Rule of thumb: if the model decides when to
fetch, it's a tool; if the user or app picks it from a list, it's a Resource. A server can do
both, and tools can return `resource_link`s that point into the Resource space.

**Where we stand.** ✅ **Built (#82, ADR-016), shipping gated.** Documents are addressable at
`pagevault://<portal>/<id>` through a `registerResource` template; the `list` callback enumerates
the collection, the read reuses `readDocument()` — one read path behind one operator gate — and
`list_documents`/`search_portal` return `resource_link`s into the space. This is the other half
of *the collection reads back*: instead of hoping the model calls `search_portal`, the operator
**attaches** the January architecture doc deterministically.

Two things the ADR nails down and this page inherits:

- **Authorization, honestly.** There is no per-resource `canView()` — the whole `/mcp` surface is
  operator-gated, and the sole operator passes `canView()` trivially. Prime directive #5 is
  honored by the single shared `readDocument()` path, not by a decorative check that cannot fail.
  A URI whose portal does not match where the document lives is refused, so a handle cannot lie
  about its client.
- **The gate that remains.** Host support for the Resources *primitive* (as opposed to tools) is
  uneven and, for claude.ai web and mobile, unverified — and those are the surfaces that matter,
  because reach is the differentiator (ADR-006). The code is merged and tested; #82 does not close,
  and the release notes make no per-surface claim, until #95's live protocol proves a non-Desktop
  host renders it. Non-goals recorded in ADR-016: no `subscribe`/`listChanged`, no pagination, no
  resource-level mutation.

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
Three MUSTs against 2025-11-25. The Origin one we tried, shipped, and reverted — the story is
worth keeping; two remain to verify:

- ⚠️ **`Origin` validation for Streamable HTTP — deliberately NOT enforced as a block.** 0.16.0
  shipped a 403 on any foreign `Origin` (`createMcpHandler` does not do it — its only `Origin`
  references are CORS headers). A live claude.ai connect proved that wrong within the hour: the
  web app POSTs to `/mcp` from the browser with `Origin: https://claude.ai`, so the block 403'd
  the tool-list refresh and read as "server unavailable." The rule is written for **localhost-bound**
  servers that grant access by network position; on a **remote, token-authenticated** server it
  defends a door that does not exist — a rebound page steals *ambient authority*, and `/mcp` grants
  none (no cookie, ever; ADR-004), so the attacker's page can only make unauthenticated requests
  that 401 anyway. `noteMcpOrigin` now *logs* a foreign origin (`mcp_foreign_origin`) and lets
  `isAuthorized` do the real work. If the log turns to noise, drop it — it carries no security
  weight. This is the honest read of the MUST for our topology, not a gap to close.
- The `.well-known/oauth-protected-resource` document is actually served and the 401 discovery
  path resolves to it. Our bearer path already returns `WWW-Authenticate: Bearer`; confirm the
  OAuth path advertises the metadata clients probe for.
- **JSON Schema 2020-12** is now the default dialect (SEP-1613). Confirm the `inputSchema` our
  zod-4 shapes emit is sane under it.

The two `verify` items belong in #76's comprehensive-coverage scope.

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
| Auth posture (verify JWT, audience, no passthrough) | ✅ Meets | Origin logged not blocked (remote topology); 2 to verify in #76 |
| Description quality | ✅ Meets | hold the bar |
| Security (confused-deputy, passthrough, session) | ✅ Meets | don't regress |
| Tool design / naming | ✅ Meets | prefix only if collisions appear |
| **Tool annotations** | ✅ Meets (#80) | done in 0.12.0 |
| **Server `instructions`** | ✅ Meets (#80) | done in 0.12.0 |
| **Structured tool output** | ✅ Meets (#81) | done |
| **Resources** | ✅ Built (#82) | ships gated on a live host check (ADR-016) |
| Pagination / prompts / elicitation / Tasks | ⏭️ Skipped | recorded above |

## Sequenced work

All four (P1–P4) are shipped in code (#80 in 0.12.0, #81, #82):

1. ✅ **MCP polish — annotations + server instructions (P1 + P2).** Done (#80): migrated to
   `registerTool`, set the annotation table above, added `instructions`, de-duplicated the
   cross-cutting rules out of the tool descriptions.
2. ✅ **Structured tool output (P3).** Done (#81): `outputSchema` + `structuredContent` on the
   four read tools and `publish_document`, prose blocks unchanged, empty-result paths pinned.
3. ✅ **Documents as MCP Resources (P4).** Built (#82, ADR-016): `pagevault://<portal>/<id>`
   template, read reusing `readDocument()`, `resource_link`s from the discovery tools. Shipping
   is gated on a live host check — see §5.

Two threads remain, both about verification rather than new features:

- `#76` (comprehensive MCP tests) — assert the annotations, validate the structured schemas,
  and cover the two remaining auth MUSTs flagged in §6 (Origin is now closed).
- `#95` (live acceptance protocol) — the deployed-surface companion. It exercises the tools over
  real OAuth against the shipped bundle, and it is where the Resources host-verification gate is
  discharged.

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
`docs/engineering/implementation/complete/mcp-auth-and-packaging-plan.md`, prime directives #4–#6 in `CLAUDE.md`.

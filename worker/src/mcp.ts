import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import type { GroupSyncResult } from "./access-group.js";
import { isAuthorized } from "./auth.js";
import {
  BadRequest,
  Conflict,
  Misconfigured,
  documentPath,
  patchDocument,
  publishDocument,
  readDocument,
  resolvePortal,
  searchPortal,
  updatePortalMembers,
} from "./documents.js";
import type { Env } from "./env.js";
import { log } from "./log.js";
import {
  type DocMeta,
  type Portal,
  deleteDoc,
  deletePublicToken,
  getMeta,
  getPortal,
  isValidSlug,
  listDocs,
  listPortals,
  mintPublicToken,
  putMeta,
  putPortal,
  putPublicToken,
} from "./store.js";

/**
 * The remote MCP server. This is the reason the project exists.
 *
 * `sharehtml` — the closest competitor — has no MCP server; it ships a skill that shells
 * out to its CLI, which only works where there is a terminal. But a *stdio* MCP server has
 * the same limitation: it cannot run in a browser or on a phone, because there is no
 * subprocess to spawn.
 *
 * You do not ask Claude Code to write a client report. You write it in a conversation, and
 * then you are holding an artifact with no terminal in sight. Only a **remote** MCP server
 * reaches Claude Desktop, claude.ai, mobile, Cowork, *and* Claude Code. See ADR-006.
 *
 * 🔴 `/mcp` can never sit behind Cloudflare Access. Anthropic's connector infrastructure
 * calls it from their cloud — no browser, no cookie, no way to complete an OTP login.
 * Access would hard-block it. The Worker authenticates it, as the Worker does everywhere.
 */
export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!isAuthorized(request, env)) {
    // MCP clients expect a 401 to mean "authenticate", not "go away".
    return new Response(JSON.stringify({ error: "Unauthorized", code: "unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="pagevault"',
      },
    });
  }

  // 🔴 A NEW server instance per request, never a module-scoped one.
  //
  // The MCP SDK added a guard against exactly this: sharing a server or transport across
  // requests can leak one client's response data to another. Given what this product
  // stores — one client's confidential deliverables, next to another's — that is an
  // incident, not a bug.
  // The host this request arrived on — so a Tier-0 deploy with no PUBLIC_HOST set still
  // produces working links (see baseUrl). At Tier 1, PUBLIC_HOST overrides it.
  const origin = new URL(request.url).origin;
  const server = buildServer(env, origin);

  return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
}

/**
 * 🔴 Origin validation for `/mcp` — a Streamable HTTP MUST (MCP 2025-11-25).
 *
 * The threat is **DNS rebinding**: an attacker's page resolves its own hostname to our IP, so
 * the browser sends requests to our Worker while the page keeps the *attacker's* origin. That
 * is the whole reason comparing `Origin` against our own host is the defense — a rebound page
 * cannot forge an origin it does not control.
 *
 * Honest severity: not exploitable here today. Rebinding buys an attacker ambient authority,
 * and PageVault has none to steal — `/mcp` takes a bearer or an OAuth token, never a cookie,
 * and ADR-004 says the Worker never accepts one anywhere. A rebound page has no credential to
 * ride. This is defense in depth against the day something *does* authenticate by cookie, and
 * it is a spec MUST regardless. See mcp-best-practices.md §6.
 *
 * **A missing `Origin` is the normal case, not a suspicious one.** Claude Code and Anthropic's
 * connector infrastructure are not browsers and never send it; the header is a browser's own
 * self-declaration, and the browser is the only attacker this rule defends against. Requiring
 * one would 403 every real client — the fastest way to turn a hardening measure into an outage.
 */
export function rejectForeignOrigin(request: Request, env: Env): Response | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;

  // Both, because the two disagree in real deployments: at rung 1 the request arrives on
  // *.workers.dev with no PUBLIC_HOST set, and behind a proxy the declared host is the only
  // one a browser would ever have used. A literal "null" origin (sandboxed frame) matches
  // neither and is refused, which is correct.
  const arrivedOn = new URL(request.url).origin;
  const declared = env.PUBLIC_HOST?.trim();
  if (origin === arrivedOn || (declared && origin === `https://${declared}`)) return null;

  // 403, not 401: this is not a "you need to authenticate" — a credential would not help, and
  // pointing a rebinding attempt at the auth flow is the wrong advice. The Origin itself is
  // already carried by requestFields (log.ts); it is a header, not a credential.
  log("warn", "blocked_mcp_origin", { request });
  return new Response(JSON.stringify({ error: "Forbidden", code: "forbidden_origin" }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The OAuth-authenticated MCP path (ADR-006 / #22).
 *
 * Identical to `handleMcp` except it does NOT check the bearer itself: the OAuthProvider has
 * already validated an issued token before routing here, and the request carries the granted
 * operator identity on `ctx.props`. The static-bearer path stays in `handleMcp` so Claude Code
 * keeps working — this is the second, independent auth surface ADR-006 says `/mcp` should have,
 * not a replacement for the first.
 */
export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Reached only after the OAuthProvider validated an issued token; the operator identity
    // rides on ctx.props. A fresh server per request, same as handleMcp (ADR-006).
    const origin = new URL(request.url).origin;
    const server = buildServer(env, origin);
    return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
};

/**
 * Server-level `instructions` — the rules that cut across every tool, stated once (#80).
 *
 * These are guidance to the model for the whole server, not enforcement: the Worker still
 * authorizes every call and the portal boundary is enforced in `canView()` / `resolvePortal`.
 * Keeping them here (instead of copy-pasted into each tool description) is the de-duplication
 * §3 of mcp-best-practices.md asks for — but the security-critical rules also stay named in the
 * tools that act on them, so trimming a description never silently drops a guardrail.
 */
const INSTRUCTIONS = [
  "PageVault holds one operator's confidential client deliverables. Three rules cut across every tool:",
  "",
  "1. A portal is a client boundary. If exactly one portal exists it is used automatically; if",
  "   several exist and none is the default, the publish and search tools error and list them —",
  "   ASK THE USER which client this is for. Never infer the portal from conversation. Guessing is",
  "   how one client's report lands in another client's portal.",
  "",
  "2. A public /p/ link is a capability URL: anyone who receives, forwards, or finds it can open",
  "   the document with no login. Minting or rotating one is a WIDENING action — confirm with the",
  "   user first and tell them what it means. Public links cost no Cloudflare Access seats.",
  "",
  "3. Publishing over an existing document with the same title REPLACES it in place at the same",
  "   URL. That needs confirm: true, and you must show the user what is being replaced first.",
].join("\n");

function buildServer(env: Env, origin: string): McpServer {
  // The version a client sees in serverInfo is the deployed build, not a hardcoded string —
  // baked at deploy (ADR-010).
  //
  // Server `instructions` carry the rules that cut across every tool, stated ONCE here instead
  // of copy-pasted into each tool description (#80). A host surfaces these to the model as
  // standing context for the whole server. The tools still name the rule they act on — the
  // security-critical "never guess the portal" (#5) stays operative where it is enforced — but
  // the shared rationale lives here.
  const server = new McpServer(
    { name: "pagevault", version: env.PAGEVAULT_VERSION || "0.0.0" },
    { instructions: INSTRUCTIONS },
  );

  // -------------------------------------------------------------------------
  // Write
  //
  // Annotations (MCP 2025-11-25) tell a host how to gate a call: `readOnlyHint` for
  // auto-approve, `destructiveHint` for a confirm prompt. They are HINTS, not enforcement —
  // the Worker still authorizes every call. Every write tool here is a closed-world operation
  // against our own KV, so `openWorldHint` is false throughout. See mcp-best-practices.md §2.
  // -------------------------------------------------------------------------

  server.registerTool(
    "publish_document",
    {
      title: "Publish document",
      // Overwrites an existing deliverable in place when the title matches (with confirm), so a
      // host should confirm rather than auto-run. Not idempotent: each call can change content.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      description: [
        "Publish a self-contained HTML or Markdown document to a PageVault portal and return its URL.",
        "",
        "Portal selection (see server instructions — never guess): one portal → used automatically;",
        "several with no default → this tool errors and lists them, so ASK THE USER which client it is for.",
        "",
        "Publishing over an existing document with the same title REPLACES it in place at the same URL;",
        "that requires confirm: true, and you must show the user what is being replaced first.",
      ].join("\n"),
      inputSchema: {
        title: z.string().describe("Human-readable title. Also the update key within a portal."),
        html: z
          .string()
          .describe(
            "The complete, self-contained document body (HTML, or Markdown if sourceKind is markdown). Inline all CSS and JS, and embed " +
              "images as data: URIs — PageVault stores only this one HTML blob and hosts no " +
              "separate assets. An external https:// image loads, but it adds a live dependency " +
              "and phones home: for a private document the third-party host learns who opened it " +
              "and when. Embed to stay self-contained. Ceiling is ~25 MiB per document.",
          ),
        portal: z.string().optional().describe("Portal slug. Omit to use the only/default portal."),
        summary: z.string().optional().describe("One line, shown in the portal index."),
        tags: z.array(z.string()).optional(),
        ownerOnly: z.boolean().optional().describe("A draft. Invisible to the client, even with a link."),
        emails: z
          .array(z.string())
          .optional()
          .describe("Grant these people access to THIS document only. Additive; never removes access."),
        confirm: z
          .boolean()
          .optional()
          .describe("Required to overwrite an existing document with the same title."),
        sourceKind: z
          .enum(["html", "markdown"])
          .optional()
          .describe(
            "Format of the document body (default html). Set markdown to publish a Markdown " +
              "document — it is rendered to HTML at publish. Same single-file rule: images must be " +
              "absolute https:// or data: URIs; there are no separate assets.",
          ),
      },
    },
    async (args) => {
      try {
        const { meta, created, portal, sync } = await publishDocument(env, {
          title: args.title,
          source: args.html,
          portal: args.portal,
          summary: args.summary,
          tags: args.tags,
          ownerOnly: args.ownerOnly,
          extraEmails: args.emails,
          confirm: args.confirm,
          sourceKind: args.sourceKind,
        });

        // publishDocument admits any newly granted emails to the viewer group itself (#27) —
        // Access blocks them at the door before canView() ever runs otherwise (ADR-002 hot
        // path). We only report what it did; a re-publish that granted nothing new syncs
        // nothing and says nothing.
        const syncNote = sync ? groupSyncNote(sync) : [];

        const base = baseUrl(env, origin);
        return text(
          [
            `${created ? "Published" : "Updated in place"}: ${meta.title}`,
            `URL:    ${base}${documentPath(portal, meta.id)}`,
            `Portal: ${meta.portal}`,
            ...(meta.ownerOnly ? ["Draft:  owner-only. The client cannot see this."] : []),
            ...(meta.extraEmails ? [`Shared: ${meta.extraEmails.join(", ")}`] : []),
            ...(created ? [] : ["", "Anyone holding the existing link now sees the new version."]),
            ...syncNote,
          ].join("\n"),
        );
      } catch (err) {
        // ⭐ The overwrite guard. An agent must not clobber a client deliverable in one
        // tool call — it has to come back and ask a human first.
        if (err instanceof Conflict) return text(err.summary(), true);
        return toolError(err, "publish_document");
      }
    },
  );

  server.registerTool(
    "create_portal",
    {
      title: "Create portal",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: [
        "Create a portal — a durable, per-client collection with its own URL and audience.",
        "",
        "restricted: the client portal. Members (by email) see everything in it.",
        "private:    yours only. The default bucket.",
        "public:     anyone with the link, no login, and it burns no Access seats.",
      ].join("\n"),
      inputSchema: {
        slug: z.string().describe("URL-safe: lowercase letters, digits, hyphens. e.g. 'realplus'"),
        name: z.string().describe("Display name, e.g. 'RealPlus'"),
        kind: z.enum(["private", "restricted", "public"]),
        description: z.string().optional(),
      },
    },
    async (args) => {
      try {
        if (!isValidSlug(args.slug)) {
          throw new BadRequest("invalid_slug", `"${args.slug}" is not a valid portal slug`);
        }
        if (await getPortal(env, args.slug)) {
          throw new BadRequest("portal_exists", `Portal "${args.slug}" already exists`);
        }

        const now = new Date().toISOString();
        const portal: Portal = {
          slug: args.slug,
          name: args.name,
          kind: args.kind,
          createdAt: now,
          updatedAt: now,
        };
        if (args.description) portal.description = args.description;

        await putPortal(env, portal);
        return text(`Created portal "${portal.name}" (${portal.slug}, ${portal.kind}).`);
      } catch (err) {
        return toolError(err, "create_portal");
      }
    },
  );

  server.registerTool(
    "update_portal_members",
    {
      title: "Update portal members",
      // Membership edits are reversible (re-add restores access) and reach the same end state on
      // repeat, so not destructive and idempotent.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: [
        "Add or remove people from a portal's audience.",
        "",
        "One call grants or revokes access to EVERY document that client has ever received.",
        "Permissions live on the portal, not the document.",
      ].join("\n"),
      inputSchema: {
        portal: z.string(),
        add: z.array(z.string()).optional(),
        remove: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      try {
        const portal = await resolvePortal(env, args.portal);
        // Shared with the console's /api endpoint, so the Access group sync (#20) is done the
        // same way on both paths. Removal is not synced here — freeing a seat is the
        // reconciler's job (ADR-002).
        const result = await updatePortalMembers(env, portal.slug, args.add ?? [], args.remove ?? []);

        const syncNote = result.added.length > 0 ? groupSyncNote(result.sync) : [];
        const removeNote =
          result.removed.length > 0
            ? ["", "Note: removed members keep Access admission (and their seat) until 'sync-access' reconciles."]
            : [];

        return text(
          [
            result.members.length === 0
              ? `Portal "${portal.slug}" now has no members.`
              : `Portal "${portal.slug}" members (${result.members.length}):\n${result.members.map((m) => `  ${m}`).join("\n")}`,
            ...syncNote,
            ...removeNote,
          ].join("\n"),
        );
      } catch (err) {
        return toolError(err, "update_portal_members");
      }
    },
  );

  server.registerTool(
    "mint_public_link",
    {
      title: "Mint public link",
      // Widening, not destructive — no data is lost. Idempotent: a second call on an
      // already-public document returns the existing link.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: [
        "⚠️ WIDENING. Mint an unguessable public /p/ URL for a document — a capability link anyone",
        "it reaches can open with no login (see server instructions). Confirm with the user first.",
        "",
        "Public links cost no Cloudflare Access seats — the right choice for one-time readers like a",
        "client's board. Idempotent: if the document is already public, returns the existing link.",
      ].join("\n"),
      inputSchema: { id: z.string() },
    },
    async (args) => {
      try {
        const meta = await getMeta(env, args.id);
        if (!meta) throw new BadRequest("not_found", `No such document: ${args.id}`);

        if (meta.publicToken) {
          return text(`Already public: ${baseUrl(env, origin)}/p/${meta.publicToken}`);
        }

        const token = mintPublicToken();
        await putPublicToken(env, token, meta.id);
        await putMeta(env, { ...meta, publicToken: token, updatedAt: new Date().toISOString() });

        return text(
          [
            `Public link for "${meta.title}":`,
            `  ${baseUrl(env, origin)}/p/${token}`,
            ``,
            `This is a capability URL. Anyone it is forwarded to can open it.`,
          ].join("\n"),
        );
      } catch (err) {
        return toolError(err, "mint_public_link");
      }
    },
  );

  server.registerTool(
    "revoke_public_link",
    {
      title: "Revoke public link",
      // Destructive: the /p/ URL dies permanently. Idempotent: revoking an already-private
      // document is a no-op. Not to be confused with revoke_document (which deletes the doc).
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description: [
        "Kill a document's public link. The document itself is kept — only the unguessable",
        "/p/ URL stops working, immediately and permanently.",
        "",
        "This is the move when a public link leaked or was forwarded further than intended.",
        "To hand out a working link again afterwards, mint a new one (it will be a different",
        "URL) or use rotate_public_link to do both in one step.",
      ].join("\n"),
      inputSchema: { id: z.string() },
    },
    async (args) => {
      try {
        const result = await patchDocument(env, args.id, { makePublic: false });
        if (!result) throw new BadRequest("not_found", `No such document: ${args.id}`);
        if (result.meta.publicToken) {
          // patchDocument only revokes when a token exists; a lingering token here is impossible.
          return text(`Could not revoke the link for "${result.meta.title}".`, true);
        }
        return text(`Public link revoked for "${result.meta.title}". The old /p/ URL is now dead.`);
      } catch (err) {
        return toolError(err, "revoke_public_link");
      }
    },
  );

  server.registerTool(
    "rotate_public_link",
    {
      title: "Rotate public link",
      // Both destructive (old URL dies) and widening (new capability URL). NOT idempotent: each
      // call mints a different token.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      description: [
        "⚠️ WIDENING. Replace a document's public link with a fresh one in a single step: the",
        "old /p/ URL dies and a new unguessable capability URL is minted, whether or not a link existed.",
        "",
        "Use it to invalidate a link that spread too far while keeping the document publicly reachable",
        "at a new URL. Confirm with the user (see server instructions on capability links).",
      ].join("\n"),
      inputSchema: { id: z.string() },
    },
    async (args) => {
      try {
        const result = await patchDocument(env, args.id, { rotatePublic: true });
        if (!result?.meta.publicToken) throw new BadRequest("not_found", `No such document: ${args.id}`);
        return text(
          [
            `Rotated public link for "${result.meta.title}". Any previous /p/ URL is now dead.`,
            `  ${baseUrl(env, origin)}/p/${result.meta.publicToken}`,
            ``,
            `This is a capability URL. Anyone it is forwarded to can open it.`,
          ].join("\n"),
        );
      } catch (err) {
        return toolError(err, "rotate_public_link");
      }
    },
  );

  server.registerTool(
    "revoke_document",
    {
      title: "Delete document",
      // The most destructive tool: irreversible deletion of a client deliverable. Idempotent in
      // the HTTP-DELETE sense — the end state of a repeat call is the same (gone), so a host may
      // safely retry a call whose response was lost.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description:
        "Permanently delete a document and any public link to it. There is no undo. " +
        "To un-publish a link but keep the document, use revoke_public_link instead.",
      inputSchema: { id: z.string() },
    },
    async (args) => {
      try {
        const meta = await getMeta(env, args.id);
        if (!meta) throw new BadRequest("not_found", `No such document: ${args.id}`);

        await deleteDoc(env, meta);
        if (meta.publicToken) await deletePublicToken(env, meta.publicToken);

        return text(`Deleted "${meta.title}" from portal "${meta.portal}". This cannot be undone.`);
      } catch (err) {
        return toolError(err, "revoke_document");
      }
    },
  );

  // -------------------------------------------------------------------------
  // Read — the differentiator
  //
  // Every competitor in both categories is an OUTBOX: things go out, nothing comes back.
  // These four tools turn the portal into durable, per-client, searchable memory that an
  // agent can read. Publishing a report and remembering it become the same act — which is
  // what makes a portal worth having at ONE client. See spec-05 §1.
  //
  // All four carry readOnlyHint: true, so a host can auto-run them without a confirm prompt.
  // -------------------------------------------------------------------------

  server.registerTool(
    "list_portals",
    {
      title: "List portals",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: "List the client portals. Use this when you need to know which clients exist.",
    },
    async () => {
      try {
        const portals = await listPortals(env);
        if (portals.length === 0) return text("No portals yet.");

        const lines = await Promise.all(
          portals.map(async (p) => {
            const docs = await listDocs(env, p.slug);
            return `  ${p.slug.padEnd(16)} ${p.kind.padEnd(11)} ${docs.length} document(s)  ${p.name}`;
          }),
        );
        return text(`Portals:\n${lines.join("\n")}`);
      } catch (err) {
        return toolError(err, "list_portals");
      }
    },
  );

  server.registerTool(
    "list_documents",
    {
      title: "List documents",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: "List documents, newest first. Metadata only — use read_document for the contents.",
      inputSchema: {
        portal: z.string().optional().describe("Omit to list across all portals."),
        tag: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const docs = (await listDocs(env, args.portal))
          .filter((d) => !args.tag || d.tags?.includes(args.tag))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

        if (docs.length === 0) return text("No documents found.");
        return text(docs.map(describe).join("\n\n"));
      } catch (err) {
        return toolError(err, "list_documents");
      }
    },
  );

  server.registerTool(
    "read_document",
    {
      title: "Read document",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: [
        "Read a document's source back.",
        "",
        "This is what makes the portal memory rather than an outbox: six months into an",
        "engagement you can ask what was decided, and the answer is in here.",
      ].join("\n"),
      inputSchema: { id: z.string() },
    },
    async (args) => {
      try {
        const result = await readDocument(env, args.id);
        if (!result) throw new BadRequest("not_found", `No such document: ${args.id}`);

        const { meta, source, truncated } = result;
        return text(
          [
            `# ${meta.title}`,
            `portal: ${meta.portal} · published: ${meta.createdAt.slice(0, 10)} · updated: ${meta.updatedAt.slice(0, 10)}`,
            ...(meta.summary ? [`summary: ${meta.summary}`] : []),
            ...(truncated ? [``, `[TRUNCATED — showing the first 100KB of ${meta.bytes} bytes]`] : []),
            ``,
            source,
          ].join("\n"),
        );
      } catch (err) {
        return toolError(err, "read_document");
      }
    },
  );

  server.registerTool(
    "search_portal",
    {
      title: "Search portal",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: [
        "Search one client's documents by keyword — title, summary, tags, and body.",
        "",
        "Every word in the query must appear somewhere in a document (in any order), so",
        "'CDC V2 decision' finds the March architecture doc. It is keyword matching, not",
        "semantic: search distinctive words, not a full natural-language question — 'what",
        "did we decide about...' would require every one of those words to be present.",
        "",
        "The portal is REQUIRED (see server instructions on the client boundary): searching",
        "across every client at once is how one client's material ends up in another's report.",
      ].join("\n"),
      inputSchema: {
        portal: z.string().describe("Which client. Required — ask the user if you are unsure."),
        query: z.string(),
      },
    },
    async (args) => {
      try {
        const portal = await resolvePortal(env, args.portal);
        const hits = await searchPortal(env, portal.slug, args.query);

        if (hits.length === 0) {
          return text(`No matches for "${args.query}" in portal "${portal.slug}".`);
        }

        return text(
          [
            `${hits.length} match(es) for "${args.query}" in "${portal.slug}":`,
            ``,
            ...hits.map((hit) => `${describe(hit.doc)}\n  matched: ${hit.matched.join(", ")}`),
            ``,
            `Use read_document to read one.`,
          ].join("\n"),
        );
      } catch (err) {
        return toolError(err, "search_portal");
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------

const describe = (doc: {
  id: string;
  title: string;
  summary?: string | undefined;
  portal: string;
  createdAt: string;
  ownerOnly: boolean;
  tags?: string[] | undefined;
}): string =>
  [
    `${doc.title}${doc.ownerOnly ? "  [draft]" : ""}`,
    `  id: ${doc.id} · portal: ${doc.portal} · ${doc.createdAt.slice(0, 10)}`,
    ...(doc.summary ? [`  ${doc.summary}`] : []),
    ...(doc.tags?.length ? [`  tags: ${doc.tags.join(", ")}`] : []),
  ].join("\n");

const baseUrl = (env: Env, origin: string): string => {
  const host = env.PUBLIC_HOST?.trim();
  // Fall back to the host the MCP request arrived on, not localhost — so a Tier-0 deploy
  // with no PUBLIC_HOST set still hands out working *.workers.dev links. Mirrors the
  // fallback in api.ts's baseUrl. See #32.
  return host ? `https://${host}` : origin;
};

const text = (body: string, isError = false) => ({
  content: [{ type: "text" as const, text: body }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Errors come back as tool results, not exceptions.
 *
 * A thrown exception reaches the model as an opaque protocol failure it cannot act on. A
 * text result saying "several portals exist, ask the user which" is something it can.
 */
function toolError(err: unknown, tool: string) {
  // The model gets the text; without this the operator gets nothing. Every failure funnels
  // through here, so the tool name is threaded in from the call site rather than guessed.
  //
  // The level split is the useful part. A BadRequest is the model asking for something that
  // does not exist or naming an ambiguous portal — expected traffic, and the tool
  // description is supposed to steer it. The other two are the operator's problem: a
  // Misconfigured means the deployment is broken, and an unexpected error means a bug.
  if (err instanceof BadRequest) {
    log("warn", "mcp_tool_rejected", { tool, code: err.code, error: err.message });
    return text(`Error (${err.code}): ${err.message}`, true);
  }
  if (err instanceof Misconfigured) {
    log("error", "mcp_tool_misconfigured", { tool, code: err.code, error: err.message });
    return text(`Deployment error (${err.code}): ${err.message}`, true);
  }
  const message = err instanceof Error ? err.message : String(err);
  log("error", "mcp_tool_failed", { tool, error: message });
  return text(`Unexpected error: ${message}`, true);
}

/**
 * Turn an Access-group sync into status lines for the tool response. The grant is already
 * in KV; this says whether Cloudflare Access will actually admit the person — so a Tier-0
 * or failed sync is never quietly presented as success (ADR-002).
 *
 * `synced`/`noop` add nothing: the tool's own "Shared:" / member-list lines already say who
 * has access, and Access will admit them. Only the cases that DON'T work get loud.
 */
function groupSyncNote(result: GroupSyncResult): string[] {
  switch (result.status) {
    case "synced":
    case "noop":
      return [];
    case "not_configured":
      return [
        "",
        "⚠️ Email-secured access is not enabled (no portals tier). The people above are",
        "recorded, but Cloudflare Access will not admit them yet. Enable portals, or share a",
        "public link instead.",
      ];
    case "failed":
      return [
        "",
        `⚠️ Recorded, but admitting them to Access failed: ${result.error}`,
        "They cannot open it until this is retried or reconciled.",
      ];
  }
}

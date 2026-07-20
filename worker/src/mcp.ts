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
  publishDocument,
  readDocument,
  resolvePortal,
  searchPortal,
  updatePortalMembers,
} from "./documents.js";
import type { Env } from "./env.js";
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

function buildServer(env: Env, origin: string): McpServer {
  // The version a client sees in serverInfo is the deployed build, not a hardcoded string —
  // baked at deploy (ADR-010).
  const server = new McpServer({ name: "pagevault", version: env.PAGEVAULT_VERSION || "0.0.0" });

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  server.tool(
    "publish_document",
    [
      "Publish a self-contained HTML document to a PageVault portal and return its URL.",
      "",
      "Portals are per-client collections. If the user has exactly one portal, it is used",
      "automatically — do not ask. If several exist and none is the default, this tool will",
      "error and list them: ASK THE USER which client this is for. Never infer the portal",
      "from conversation; guessing is how one client's report lands in another's portal.",
      "",
      "Publishing over an existing document with the same title REPLACES it in place,",
      "keeping the same URL. That requires confirm: true, and you must show the user what",
      "is being replaced before you set it.",
    ].join("\n"),
    {
      title: z.string().describe("Human-readable title. Also the update key within a portal."),
      html: z
        .string()
        .describe(
          "The complete, self-contained HTML document. Inline all CSS and JS, and embed " +
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
        return toolError(err);
      }
    },
  );

  server.tool(
    "create_portal",
    [
      "Create a portal — a durable, per-client collection with its own URL and audience.",
      "",
      "restricted: the client portal. Members (by email) see everything in it.",
      "private:    yours only. The default bucket.",
      "public:     anyone with the link, no login, and it burns no Access seats.",
    ].join("\n"),
    {
      slug: z.string().describe("URL-safe: lowercase letters, digits, hyphens. e.g. 'realplus'"),
      name: z.string().describe("Display name, e.g. 'RealPlus'"),
      kind: z.enum(["private", "restricted", "public"]),
      description: z.string().optional(),
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
        return toolError(err);
      }
    },
  );

  server.tool(
    "update_portal_members",
    [
      "Add or remove people from a portal's audience.",
      "",
      "One call grants or revokes access to EVERY document that client has ever received.",
      "Permissions live on the portal, not the document.",
    ].join("\n"),
    {
      portal: z.string(),
      add: z.array(z.string()).optional(),
      remove: z.array(z.string()).optional(),
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
        return toolError(err);
      }
    },
  );

  server.tool(
    "mint_public_link",
    [
      "⚠️ WIDENING. Mint an unguessable public URL for a document.",
      "",
      "Anyone who receives, forwards, or finds this link can open the document with no",
      "login. Unguessable is NOT private — it is a capability URL. Confirm with the user",
      "before calling this, and tell them what it means.",
      "",
      "Upside: public links cost no Cloudflare Access seats, so they are the right choice",
      "for one-time readers like a client's board.",
    ].join("\n"),
    { id: z.string() },
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
        return toolError(err);
      }
    },
  );

  server.tool(
    "revoke_document",
    "Permanently delete a document and any public link to it. There is no undo.",
    { id: z.string() },
    async (args) => {
      try {
        const meta = await getMeta(env, args.id);
        if (!meta) throw new BadRequest("not_found", `No such document: ${args.id}`);

        await deleteDoc(env, meta);
        if (meta.publicToken) await deletePublicToken(env, meta.publicToken);

        return text(`Deleted "${meta.title}" from portal "${meta.portal}". This cannot be undone.`);
      } catch (err) {
        return toolError(err);
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
  // -------------------------------------------------------------------------

  server.tool(
    "list_portals",
    "List the client portals. Use this when you need to know which clients exist.",
    {},
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
        return toolError(err);
      }
    },
  );

  server.tool(
    "list_documents",
    "List documents, newest first. Metadata only — use read_document for the contents.",
    {
      portal: z.string().optional().describe("Omit to list across all portals."),
      tag: z.string().optional(),
    },
    async (args) => {
      try {
        const docs = (await listDocs(env, args.portal))
          .filter((d) => !args.tag || d.tags?.includes(args.tag))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

        if (docs.length === 0) return text("No documents found.");
        return text(docs.map(describe).join("\n\n"));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "read_document",
    [
      "Read a document's source back.",
      "",
      "This is what makes the portal memory rather than an outbox: six months into an",
      "engagement you can ask what was decided, and the answer is in here.",
    ].join("\n"),
    { id: z.string() },
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
        return toolError(err);
      }
    },
  );

  server.tool(
    "search_portal",
    [
      "Search one client's documents by keyword — title, summary, tags, and body.",
      "",
      "Every word in the query must appear somewhere in a document (in any order), so",
      "'CDC V2 decision' finds the March architecture doc. It is keyword matching, not",
      "semantic: search distinctive words, not a full natural-language question — 'what",
      "did we decide about...' would require every one of those words to be present.",
      "",
      "The portal is REQUIRED. Searching across every client at once is how one client's",
      "material ends up in another client's report.",
    ].join("\n"),
    {
      portal: z.string().describe("Which client. Required — ask the user if you are unsure."),
      query: z.string(),
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
        return toolError(err);
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
function toolError(err: unknown) {
  if (err instanceof BadRequest) return text(`Error (${err.code}): ${err.message}`, true);
  if (err instanceof Misconfigured) return text(`Deployment error (${err.code}): ${err.message}`, true);
  return text(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`, true);
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

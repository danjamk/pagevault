import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import type { GroupSyncResult } from "./access-group.js";
import { isAuthorized } from "./auth.js";
import {
  BadRequest,
  Conflict,
  type DocEdit,
  Misconfigured,
  NameTaken,
  documentPath,
  editDocument,
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
  type DocSummary,
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
import { type ViewStats, type ViewSummary, getViewSummary, statsFor } from "./views.js";

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
 * Note the `Origin` on an `/mcp` request. Observational only — it never blocks.
 *
 * 🔴 This started life as a 403 on any foreign `Origin`, to satisfy the MCP 2025-11-25
 * DNS-rebinding rule. That rule is written for **localhost-bound** servers that grant access by
 * network position, and it is actively wrong for a **remote, token-authenticated** one. The
 * claude.ai web app calls `/mcp` from the browser carrying `Origin: https://claude.ai`, so the
 * block took the hosted connector down — the browser-side tool refresh 403'd, and the surface
 * that is the entire differentiator (ADR-006) stopped working. Only a live host revealed it;
 * curl never sends a real client's origin.
 *
 * Dropping the block loses nothing, because a rebound page gains nothing here. Rebinding steals
 * **ambient authority**, and `/mcp` grants none: it takes a bearer or an OAuth token and trusts
 * no cookie, ever (ADR-004). An attacker's page can only make *unauthenticated* requests, which
 * `isAuthorized` 401s regardless of `Origin`. The auth gate was always the real defense; the
 * Origin check was defending a door that does not exist.
 *
 * So it logs and lets the request through. The log is useful *right now* — it shows exactly what
 * `Origin` each host sends while the surfaces are being tested. If it turns out to be pure noise
 * (claude.ai fires it on every request), drop it; it carries no security weight. A missing
 * `Origin` (Claude Code, the connector infrastructure — not browsers) is the ordinary case and
 * is not logged.
 */
export function noteMcpOrigin(request: Request, env: Env): void {
  const origin = request.headers.get("Origin");
  if (!origin) return;

  const arrivedOn = new URL(request.url).origin;
  const declared = env.PUBLIC_HOST?.trim();
  if (origin === arrivedOn || (declared && origin === `https://${declared}`)) return;

  // Observation, not an alarm: a foreign Origin is expected from a browser client. The origin
  // itself rides in via requestFields (log.ts).
  log("info", "mcp_foreign_origin", { request });
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
  "3. Publishing over an existing document with the same filename REPLACES it in place at the same",
  "   URL. That needs confirm: true, and you must show the user what is being replaced first.",
].join("\n");

/**
 * Structured tool output (#81, mcp-best-practices.md §4).
 *
 * `list_documents → search_portal → read_document → publish_document` is a chain an agent runs
 * programmatically. Prose forces it to re-parse an id out of text at each hop, so these five
 * tools declare an `outputSchema` and return `structuredContent` beside the prose — the id and
 * a ready-to-open `url` as fields, not something to scrape. The prose block stays exactly as it
 * was: this ADDS a machine payload, it does not replace the readable one.
 *
 * 🔴 The SDK trap this must never spring: when a tool declares `outputSchema`, any NON-error
 * success return that omits `structuredContent` becomes a *protocol* error (validateToolOutput
 * in the SDK) — the very failure §"errors as results" exists to prevent. So every success path
 * of these five, including the empty ones (`No documents found.`, `No matches…`), returns
 * `structured(...)`. Error paths still use `text(..., true)`: `isError` results are exempt.
 *
 * The schemas are plain zod-4 shapes; the SDK emits them as JSON Schema 2020-12 (SEP-1613), the
 * same path the input schemas already take. `mcp.test.ts` validates the emitted shape.
 */
const PORTAL_KIND = z.enum(["private", "restricted", "public"]);
const SOURCE_KIND = z.enum(["html", "markdown"]);

/**
 * Where releases are published for the canonical `pagevault` npm package (#98). Hardcoded to
 * upstream on purpose: the update check compares against the package an operator installs, not
 * against whatever repo a given deployment was built from. A fork that republishes under its own
 * npm name would point this at its own releases — one constant to change, in keeping with
 * single-operator infra you fork rather than configure.
 */
const RELEASES_URL = "https://github.com/danjamk/pagevault/releases/latest";

/**
 * View metrics as an agent sees them (#127). Every field is OPTIONAL, and their absence is the
 * load-bearing part: absent means "not measured" (no sync has run, or the document was published
 * after the last one), while a present `views: 0` means "measured, and nobody opened it" — which
 * is the answer worth having. See `statsFor` in views.ts.
 */
const VIEW_OUT_SHAPE = {
  views: z.number().optional(),
  lastViewedAt: z.string().nullable().optional(),
  surfaces: z.object({ link: z.number(), public: z.number(), portal: z.number() }).optional(),
};

/** When the metrics above were last synced from Analytics Engine. Absent when never. */
const VIEWS_SYNCED_AT = z.string().optional();

/**
 * Stated in the tool descriptions themselves, not only in the server instructions.
 *
 * ADR-019 decision 6: a number that is three days old and says so is useful; one that is three
 * days old and looks live is a liability. A model will report what it is handed as current unless
 * told otherwise, and the sentence has to sit next to the field for that to hold.
 */
const METRICS_NOTE = [
  "`views`, `lastViewedAt` and `surfaces` come from the last `pagevault views --sync`, not from",
  "live traffic — `viewsSyncedAt` says when it ran. Report them as of that time. When they are",
  "absent nothing has been measured yet: say so rather than reporting zero views.",
].join("\n");

/** One document, as an agent-consumable record. `url` opens it; `id` joins to read_document. */
const DOC_OUT_SHAPE = {
  id: z.string(),
  portal: z.string(),
  name: z.string(),
  title: z.string(),
  summary: z.string().optional(),
  url: z.string(),
  ownerOnly: z.boolean(),
  public: z.boolean(),
  sourceKind: SOURCE_KIND,
  tags: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  bytes: z.number(),
  ...VIEW_OUT_SHAPE,
};

const PORTAL_OUT_SHAPE = {
  slug: z.string(),
  name: z.string(),
  kind: PORTAL_KIND,
  documentCount: z.number(),
};

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
      // Overwrites an existing deliverable in place when the filename matches (with confirm), so a
      // host should confirm rather than auto-run. Not idempotent: each call can change content.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      description: [
        "Publish a self-contained HTML or Markdown document to a PageVault portal and return its URL.",
        "",
        "Portal selection (see server instructions — never guess): one portal → used automatically;",
        "several with no default → this tool errors and lists them, so ASK THE USER which client it is for.",
        "",
        "Identity is the FILENAME, not the title (ADR-017). Publishing over an existing document with the",
        "same filename REPLACES it in place at the same URL; that requires confirm: true, and you must show",
        "the user what is being replaced first. Use a different filename to publish a distinct document.",
      ].join("\n"),
      inputSchema: {
        title: z.string().describe("Human-readable display title, shown in the portal index. NOT the update key."),
        filename: z
          .string()
          .optional()
          .describe(
            "The document's filename — its IDENTITY and update key within the portal (e.g. 'q3-review.md'). " +
              "You have no file on disk, so MANUFACTURE a stable, descriptive filename with an extension and " +
              "REUSE it to update the same document in place. Same (portal, filename) = the same document; a " +
              "different filename = a different document. Omit to derive one from the title.",
          ),
        html: z
          .string()
          .describe(
            "Pass the document VERBATIM and in full — never a placeholder, an ellipsis, a summary, " +
              "or a '[content continues]' stub. PageVault stores exactly these bytes and serves them " +
              "unchanged; a stub publishes a stub. The result reports the stored byte count — confirm " +
              "it matches the document you sent. " +
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
          .describe("Required to overwrite an existing document with the same filename."),
        sourceKind: z
          .enum(["html", "markdown"])
          .optional()
          .describe(
            "Format of the document body (default html). Set markdown to publish a Markdown " +
              "document — it is rendered to HTML at publish. Same single-file rule: images must be " +
              "absolute https:// or data: URIs; there are no separate assets.",
          ),
      },
      // The id + url the next step needs, machine-readable (#81). `created` false = replaced in place.
      // `bytes` is the stored size, so the model can confirm a full doc landed — not a stub (#99).
      outputSchema: {
        id: z.string(),
        portal: z.string(),
        name: z.string(),
        title: z.string(),
        url: z.string(),
        created: z.boolean(),
        bytes: z.number(),
        ownerOnly: z.boolean(),
        public: z.boolean(),
        sharedWith: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      try {
        const { meta, created, portal, sync } = await publishDocument(env, {
          title: args.title,
          filename: args.filename,
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
        const url = `${base}${documentPath(portal, meta.id)}`;
        return structured(
          [
            `${created ? "Published" : "Updated in place"}: ${meta.title}`,
            `Name:   ${meta.name}`,
            `URL:    ${url}`,
            `Portal: ${meta.portal}`,
            // The stored size, so a stub is obvious at a glance — no read_document round-trip (#99).
            `Bytes:  ${meta.bytes}`,
            ...(meta.ownerOnly ? ["Draft:  owner-only. The client cannot see this."] : []),
            ...(meta.extraEmails ? [`Shared: ${meta.extraEmails.join(", ")}`] : []),
            ...(created ? [] : ["", "Anyone holding the existing link now sees the new version."]),
            ...syncNote,
          ].join("\n"),
          {
            id: meta.id,
            portal: meta.portal,
            name: meta.name,
            title: meta.title,
            url,
            created,
            bytes: meta.bytes,
            ownerOnly: meta.ownerOnly,
            public: !!meta.publicToken,
            ...(meta.extraEmails ? { sharedWith: meta.extraEmails } : {}),
          },
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

  server.registerTool(
    "edit_document",
    {
      title: "Edit document",
      // Not destructive: nothing is lost, and re-sending the same edit reaches the same state.
      // A rename does move the document's URL, which the description says plainly.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: [
        "Rename a document, or fix its title, summary or tags. Does NOT touch the contents —",
        "use publish_document with confirm: true to replace those.",
        "",
        "filename is the document's IDENTITY. Changing it moves the document to a new URL; the",
        "old URL redirects for a year, and any public /p/ link keeps working unchanged. Changing",
        "only the title, summary or tags moves nothing.",
        "",
        "Use this to correct a mistake — a typo'd filename, a wrong title. To publish a NEW",
        "version of a document, use publish_document.",
      ].join("\n"),
      inputSchema: {
        id: z.string(),
        filename: z
          .string()
          .optional()
          .describe("The new filename, e.g. 'q3-review.md'. Moves the document to a new URL."),
        title: z.string().optional().describe("Display title. Never affects identity or the URL."),
        summary: z.string().optional().describe("One line for the portal index. Empty string clears it."),
        tags: z.array(z.string()).optional().describe("Replaces the existing tags. Empty array clears them."),
      },
    },
    async (args) => {
      try {
        const edit: DocEdit = {};
        if (args.filename !== undefined) edit.name = args.filename;
        if (args.title !== undefined) edit.title = args.title;
        if (args.summary !== undefined) edit.summary = args.summary;
        if (args.tags !== undefined) edit.tags = args.tags;
        if (Object.keys(edit).length === 0) {
          throw new BadRequest("invalid_field", "Nothing to edit — pass at least one of: filename, title, summary, tags");
        }

        const result = await editDocument(env, args.id, edit);
        if (!result) throw new BadRequest("not_found", `No such document: ${args.id}`);

        const { meta, movedFrom } = result;
        const portal = await getPortal(env, meta.portal);
        const url = `${baseUrl(env, origin)}${portal ? documentPath(portal, meta.id) : `/v/${meta.portal}/${meta.id}`}`;

        return text(
          [
            `Updated: ${meta.title}`,
            `Name:   ${meta.name}`,
            `URL:    ${url}`,
            `Portal: ${meta.portal}`,
            ...(movedFrom
              ? [
                  "",
                  `Renamed, so the document MOVED: its id changed from ${movedFrom} to ${meta.id}.`,
                  `The old URL redirects here for a year.${meta.publicToken ? " The public /p/ link is unchanged and still works." : ""}`,
                  `Tell the user the canonical link changed.`,
                ]
              : []),
          ].join("\n"),
        );
      } catch (err) {
        // The requested filename belongs to another document. Deliberately NOT overridable —
        // say what is in the way and let the human decide (#140).
        if (err instanceof NameTaken) {
          return text(
            [
              err.message,
              "",
              `  id:    ${err.existing.id}`,
              `  title: ${err.existing.title}`,
              "",
              "Renaming onto it would need to destroy it, so this is refused outright. Pick a",
              "different filename, or — if replacing that document is genuinely the intent —",
              "ask the user, then use publish_document with confirm: true.",
            ].join("\n"),
            true,
          );
        }
        return toolError(err, "edit_document");
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
      outputSchema: { portals: z.array(z.object(PORTAL_OUT_SHAPE)) },
    },
    async () => {
      try {
        const portals = await listPortals(env);
        if (portals.length === 0) return structured("No portals yet.", { portals: [] });

        const rows = await Promise.all(
          portals.map(async (p) => ({ p, count: (await listDocs(env, p.slug)).length })),
        );
        const lines = rows.map(
          ({ p, count }) => `  ${p.slug.padEnd(16)} ${p.kind.padEnd(11)} ${count} document(s)  ${p.name}`,
        );
        return structured(`Portals:\n${lines.join("\n")}`, {
          portals: rows.map(({ p, count }) => ({
            slug: p.slug,
            name: p.name,
            kind: p.kind,
            documentCount: count,
          })),
        });
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
      description: [
        "List documents, newest first. Metadata only — use read_document for the contents.",
        "",
        METRICS_NOTE,
      ].join("\n"),
      inputSchema: {
        portal: z.string().optional().describe("Omit to list across all portals."),
        tag: z.string().optional(),
      },
      outputSchema: { documents: z.array(z.object(DOC_OUT_SHAPE)), viewsSyncedAt: VIEWS_SYNCED_AT },
    },
    async (args) => {
      try {
        const docs = (await listDocs(env, args.portal))
          .filter((d) => !args.tag || d.tags?.includes(args.tag))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

        if (docs.length === 0) return structured("No documents found.", { documents: [] });

        // One list() to resolve each document's portal kind for its URL — a document can span any
        // portal here. It is a single call per invocation, never per-document, so it stays clear of
        // the KV list quota (1000/day). See store.ts on why kind is not on the DocSummary.
        const base = baseUrl(env, origin);
        const byslug = new Map((await listPortals(env)).map((p) => [p.slug, p]));
        // One KV read for the whole listing, never one per document (#127).
        const summary = await getViewSummary(env);
        const prose = docs.map((d) => describe(d, statsFor(summary, d))).join("\n\n");
        return structured(
          // The staleness stamp goes once at the foot rather than onto every line — but it does
          // have to be in the PROSE. `viewsSyncedAt` in structuredContent is invisible to a host
          // that renders only text, and a column of view counts with no "as of" reads as live.
          summary ? `${prose}\n\nView counts are as of the last sync, ${summary.syncedAt.slice(0, 10)} — not live.` : prose,
          {
            documents: docs.map((d) =>
              docOut(d, docUrl(base, d.portal, d.id, byslug.get(d.portal) ?? null), statsFor(summary, d)),
            ),
            ...syncedAtOf(summary),
          },
          docs.map((d) => resourceLink(d.portal, d.id, d.title, d.sourceKind)),
        );
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
        "",
        METRICS_NOTE,
      ].join("\n"),
      inputSchema: { id: z.string() },
      // `source` is what the prose shows — truncated when the doc is large; `bytes` is the true
      // size, so `truncated: true` + `bytes` together tell an agent the payload is partial (#81).
      outputSchema: {
        id: z.string(),
        portal: z.string(),
        title: z.string(),
        summary: z.string().optional(),
        sourceKind: SOURCE_KIND,
        url: z.string(),
        source: z.string(),
        truncated: z.boolean(),
        bytes: z.number(),
        createdAt: z.string(),
        updatedAt: z.string(),
        ...VIEW_OUT_SHAPE,
        viewsSyncedAt: VIEWS_SYNCED_AT,
      },
    },
    async (args) => {
      try {
        const result = await readDocument(env, args.id);
        if (!result) throw new BadRequest("not_found", `No such document: ${args.id}`);

        const { meta, source, truncated } = result;
        const url = docUrl(baseUrl(env, origin), meta.portal, meta.id, await getPortal(env, meta.portal));
        const summary = await getViewSummary(env);
        const stats = statsFor(summary, meta);
        return structured(
          [
            `# ${meta.title}`,
            `portal: ${meta.portal} · published: ${meta.createdAt.slice(0, 10)} · updated: ${meta.updatedAt.slice(0, 10)}`,
            ...(meta.summary ? [`summary: ${meta.summary}`] : []),
            ...(stats ? [viewLine(stats, summary)] : []),
            ...(truncated ? [``, `[TRUNCATED — showing the first 100KB of ${meta.bytes} bytes]`] : []),
            ``,
            source,
          ].join("\n"),
          {
            id: meta.id,
            portal: meta.portal,
            title: meta.title,
            ...(meta.summary ? { summary: meta.summary } : {}),
            sourceKind: meta.sourceKind,
            url,
            source,
            truncated,
            bytes: meta.bytes,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            ...(stats ?? {}),
            ...(stats ? syncedAtOf(summary) : {}),
          },
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
      // Every hit carries where it matched — the same signal the prose surfaces, so an agent can
      // rank or explain a result without re-reading the doc (#81).
      outputSchema: {
        portal: z.string(),
        query: z.string(),
        matches: z.array(
          z.object({
            ...DOC_OUT_SHAPE,
            matched: z.array(z.enum(["title", "summary", "tag", "body"])),
          }),
        ),
      },
    },
    async (args) => {
      try {
        const portal = await resolvePortal(env, args.portal);
        const hits = await searchPortal(env, portal.slug, args.query);

        if (hits.length === 0) {
          return structured(`No matches for "${args.query}" in portal "${portal.slug}".`, {
            portal: portal.slug,
            query: args.query,
            matches: [],
          });
        }

        // All hits are in this one resolved portal, so its kind builds every URL — no per-hit read.
        const base = baseUrl(env, origin);
        return structured(
          [
            `${hits.length} match(es) for "${args.query}" in "${portal.slug}":`,
            ``,
            ...hits.map((hit) => `${describe(hit.doc)}\n  matched: ${hit.matched.join(", ")}`),
            ``,
            `Use read_document to read one.`,
          ].join("\n"),
          {
            portal: portal.slug,
            query: args.query,
            matches: hits.map((hit) => ({
              ...docOut(hit.doc, `${base}${documentPath(portal, hit.doc.id)}`),
              matched: hit.matched,
            })),
          },
          hits.map((hit) => resourceLink(portal.slug, hit.doc.id, hit.doc.title, hit.doc.sourceKind)),
        );
      } catch (err) {
        return toolError(err, "search_portal");
      }
    },
  );

  // -------------------------------------------------------------------------
  // Diagnostics
  //
  // "What am I connected to, and is it current?" The version is on the wire at initialize
  // (serverInfo.version), but that is protocol metadata the model cannot report — only a tool
  // RESULT reaches it. So an operator running a test connector and a prod connector side by side
  // cannot tell them apart from inside a chat without leaving to curl /health. This surfaces the
  // same values /health already serves (public, unauthenticated — zero new disclosure), and
  // doubles as a lightweight check-for-updates the model drives. See #98. Read-only.
  // -------------------------------------------------------------------------
  server.registerTool(
    "server_info",
    {
      title: "Server info",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: [
        "Report the running PageVault deployment: its version, host, and when it was deployed.",
        "",
        "Use this to confirm WHICH deployment you are connected to (test vs. prod) and whether it is",
        "current. To check for updates, compare `releaseVersion` against the latest release at",
        "`releasesUrl`. If the deployment is behind, tell the operator their version vs. the latest,",
        "offer to summarize what changed (from the release notes), and mention the update path:",
        "`npm update -g pagevault && pagevault upgrade`. If you cannot fetch the latest release, say",
        "so rather than guessing — do not assume it is up to date, and do not assume it is behind.",
      ].join("\n"),
      outputSchema: {
        version: z.string(),
        releaseVersion: z.string(),
        host: z.string(),
        deployedAt: z.string().nullable(),
        releasesUrl: z.string(),
      },
    },
    async () => {
      try {
        // Mirrors /health (index.ts): one source of truth, baked at deploy (ADR-010).
        const version = env.PAGEVAULT_VERSION || "unknown";
        // `<version>+<shortsha>` → the clean semver, so a client compares versions without parsing
        // build metadata (which, per semver, does not affect precedence anyway).
        const releaseVersion = version.split("+")[0] || "unknown";
        const host = baseUrl(env, origin);
        const deployedAt = env.PAGEVAULT_DEPLOYED_AT || null;

        return structured(
          [
            `PageVault ${version}`,
            `Host:     ${host}`,
            `Deployed: ${deployedAt ?? "unknown"}`,
            `Releases: ${RELEASES_URL}`,
          ].join("\n"),
          { version, releaseVersion, host, deployedAt, releasesUrl: RELEASES_URL },
        );
      } catch (err) {
        return toolError(err, "server_info");
      }
    },
  );

  // -------------------------------------------------------------------------
  // Resources — the user-addressable half (ADR-016, #82)
  //
  // Tools are model-initiated; a Resource is how the operator ATTACHES a specific document as
  // context deterministically — the other half of "the collection reads back." Read-only, one
  // URI per document, and the read reuses the same readDocument() the tools do: one read path
  // behind one operator gate. The whole /mcp surface is operator-authenticated before buildServer
  // ever runs, so there is no per-resource canView — the sole operator passes it trivially, and
  // dressing this path in a check that cannot fail would misstate where the authorization is
  // (prime directive #5; ADR-016, "authorization, stated honestly").
  // -------------------------------------------------------------------------
  server.registerResource(
    "document",
    new ResourceTemplate("pagevault://{portal}/{id}", {
      // Every document, across every portal — the operator owns all of it, so the picker is not
      // client-scoped (ADR-016, design point 5). Metadata-only, one list() call, no per-doc read.
      list: async () => {
        const docs = await listDocs(env);
        return {
          resources: docs.map((d) => ({
            uri: resourceUri(d.portal, d.id),
            name: d.title,
            ...(d.summary ? { description: d.summary } : {}),
            mimeType: mimeFor(d.sourceKind),
            size: d.bytes,
          })),
        };
      },
    }),
    {
      title: "Client documents",
      description:
        "Every published document, addressable as pagevault://<portal>/<id> to attach as context. Read-only.",
    },
    async (uri, variables) => {
      const id = Array.isArray(variables.id) ? variables.id[0] : variables.id;
      const portal = Array.isArray(variables.portal) ? variables.portal[0] : variables.portal;
      if (!id) throw new BadRequest("invalid_resource", `Malformed resource URI: ${uri.href}`);

      const result = await readDocument(env, id);
      // The URI names a portal. Refuse to serve a document under a portal it does not live in, so
      // a handle can never quietly lie about which client it belongs to — even though, for the
      // sole operator, the bytes would be identical either way.
      if (!result || result.meta.portal !== portal) {
        throw new BadRequest("not_found", `No such document: ${uri.href}`);
      }

      // The source the author wrote (markdown stays markdown), same as read_document returns.
      return {
        contents: [{ uri: uri.href, mimeType: mimeFor(result.meta.sourceKind), text: result.source }],
      };
    },
  );

  return server;
}

// ---------------------------------------------------------------------------

const describe = (
  doc: {
    id: string;
    name: string;
    title: string;
    summary?: string | undefined;
    portal: string;
    createdAt: string;
    ownerOnly: boolean;
    tags?: string[] | undefined;
  },
  stats: ViewStats | null = null,
): string =>
  [
    `${doc.title}${doc.ownerOnly ? "  [draft]" : ""}`,
    `  file: ${doc.name} · id: ${doc.id} · portal: ${doc.portal} · ${doc.createdAt.slice(0, 10)}`,
    ...(doc.summary ? [`  ${doc.summary}`] : []),
    ...(doc.tags?.length ? [`  tags: ${doc.tags.join(", ")}`] : []),
    ...(stats ? [`  ${viewLine(stats)}`] : []),
  ].join("\n");

/**
 * The prose half of the metrics. "not opened yet" rather than "0 views": the count is the datum,
 * but the sentence an operator actually wants out of an agent is whether the client read it.
 */
function viewLine(stats: ViewStats, summary: ViewSummary | null = null): string {
  const asOf = summary ? `, as of ${summary.syncedAt.slice(0, 10)}` : "";
  if (stats.views === 0) return `views: not opened yet${asOf}`;
  const doors = (["portal", "link", "public"] as const)
    .filter((s) => stats.surfaces[s] > 0)
    .map((s) => `${s} ${stats.surfaces[s]}`)
    .join(", ");
  const last = stats.lastViewedAt ? ` · last ${stats.lastViewedAt.slice(0, 10)}` : "";
  return `views: ${stats.views} (${doors})${last}${asOf}`;
}

/** The top-level staleness stamp, present exactly when a summary is. */
const syncedAtOf = (summary: ViewSummary | null) => (summary ? { viewsSyncedAt: summary.syncedAt } : {});

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
 * A `resource_link` content block (ADR-016, design point 4): an attachable handle into the
 * Resource space, so a discovery tool can hand back `pagevault://…` alongside its prose. A host
 * that does not render resource_links ignores it; the text and structuredContent stand alone.
 */
interface ResourceLink {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
}

const resourceLink = (portal: string, id: string, name: string, sourceKind?: string): ResourceLink => ({
  type: "resource_link",
  uri: resourceUri(portal, id),
  name,
  mimeType: mimeFor(sourceKind),
});

/**
 * A success result carrying BOTH the prose block and the machine payload (#81), plus any
 * `resource_link`s (#82).
 *
 * The prose is unchanged from what the tool returned before; `structuredContent` is the new
 * half. There is no `isError` variant on purpose — an error is `text(msg, true)`, and error
 * results are exempt from output-schema validation, so they must not carry structuredContent.
 */
const structured = (body: string, structuredContent: Record<string, unknown>, links: ResourceLink[] = []) => ({
  content: [{ type: "text" as const, text: body }, ...links],
  structuredContent,
});

/**
 * A `DocSummary` as a structured-output record. `public`/`sourceKind` are normalized to always
 * present (the listing omits them at their common value to save KV metadata bytes; an agent
 * reading the field should not have to know that), while `summary`/`tags` stay optional — absent
 * means none, which is information, not a default worth inventing.
 */
const docOut = (doc: DocSummary, url: string, stats: ViewStats | null = null): Record<string, unknown> => ({
  id: doc.id,
  portal: doc.portal,
  name: doc.name,
  title: doc.title,
  ...(doc.summary ? { summary: doc.summary } : {}),
  url,
  ownerOnly: doc.ownerOnly,
  public: doc.public ?? false,
  sourceKind: doc.sourceKind ?? "html",
  ...(doc.tags?.length ? { tags: doc.tags } : {}),
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
  bytes: doc.bytes,
  // Spread whole or not at all — a document measured at zero carries `views: 0`, one that was
  // never measured carries no view fields. See statsFor in views.ts.
  ...(stats ?? {}),
});

/**
 * The `/v/` or `/pub/` URL for a document whose portal we may or may not have resolved. Prefer
 * the real `Portal` (its `kind` decides the route); fall back to the private-style `/v/` path
 * only when the portal record is unexpectedly missing, so a URL is always produced.
 */
const docUrl = (base: string, portalSlug: string, id: string, portal: Portal | null): string =>
  portal
    ? `${base}${documentPath(portal, id)}`
    : `${base}/v/${encodeURIComponent(portalSlug)}/${encodeURIComponent(id)}`;

/**
 * The `pagevault://<portal>/<id>` handle a document is addressable by as an MCP Resource
 * (ADR-016). Distinct from the `/v/` or `/pub/` *browser* URL (`docUrl`): this one is an
 * attach-in-host identifier, not a link a person opens.
 */
const resourceUri = (portal: string, id: string): string => `pagevault://${portal}/${id}`;

/** `text/markdown` for a markdown source, `text/html` otherwise — the listing omits it for HTML. */
const mimeFor = (sourceKind: string | undefined): string =>
  sourceKind === "markdown" ? "text/markdown" : "text/html";

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

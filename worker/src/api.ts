import { bearerToken, isAuthorized } from "./auth.js";
import { originAllowed } from "./capability.js";
import { verifySession } from "./session.js";
import {
  BadRequest,
  Conflict,
  type DocPatch,
  Misconfigured,
  documentPath,
  parseEmails,
  parseSourceKind,
  parseSummary,
  parseTags,
  parseTitle,
  patchDocument,
  publishDocument,
  reconcileAccessGroup,
  requireString,
  searchPortal,
  updatePortalMembers,
} from "./documents.js";
import type { Env } from "./env.js";
import {
  type DocMeta,
  type Portal,
  type PortalKind,
  deleteDoc,
  deletePortal,
  getDoc,
  getMembers,
  getMeta,
  getPortal,
  getRawSource,
  isValidSlug,
  listDocs,
  listPortals,
  putMembers,
  putPortal,
} from "./store.js";
import { log } from "./log.js";

/**
 * `/api/*` — the HTTP surface.
 *
 * A thin shell over `documents.ts`. The MCP server (`mcp.ts`) calls the same service, so
 * the portal-resolution ladder and the overwrite guard live in exactly one place. Two
 * publish paths would be two places for those rules to drift, and both drift quietly.
 */

/** Reject on Content-Length before buffering 25MB of JSON into a 128MB isolate. */
const MAX_BODY_BYTES = 12 * 1024 * 1024;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}

const fail = (status: number, code: string, error: string, extra?: Record<string, unknown>) =>
  json({ error, code, ...extra }, status);

export async function handleApi(request: Request, env: Env): Promise<Response> {
  // Defense in depth, ahead of the bearer check.
  //
  // A sandboxed artifact has an opaque origin, so anything it fetches arrives with
  // `Origin: null`. It has no bearer token either, so the check below would already refuse
  // it — but this is the cheapest possible second wall, and it means a future endpoint that
  // gets its auth wrong is still not reachable from inside an artifact. See ADR-007.
  if (!originAllowed(request)) {
    // The path is passed explicitly because `/api/*` carries no secret in the URL — the
    // bearer credential is a header (ADR-004). Knowing which endpoint was probed is the
    // whole value of this event.
    log("warn", "blocked_api_request_invalid_origin", { request, path: new URL(request.url).pathname });
    return fail(403, "forbidden_origin", "Cross-origin request refused");
  }

  // Two accepted bearer credentials, no cookies (ADR-004): the long-lived PAGEVAULT_API_TOKEN
  // (CLI, MCP) or a short-lived console session token. Both are owner-scoped, so a boolean is
  // all we need — the console does everything the token does. /mcp accepts ONLY the API token.
  const authorized = isAuthorized(request, env) || (await verifySession(env, bearerToken(request))) !== null;
  if (!authorized) {
    return fail(401, "unauthorized", "Missing or invalid bearer token");
  }

  const { pathname } = new URL(request.url);
  const rest = pathname.slice("/api".length);

  try {
    if (rest === "/docs") {
      if (request.method === "POST") return await createDoc(request, env);
      if (request.method === "GET") return await listDocsHandler(request, env);
      return fail(405, "method_not_allowed", `${request.method} not allowed on /api/docs`);
    }

    const rawDoc = /^\/docs\/([^/]+)\/raw$/.exec(rest);
    if (rawDoc?.[1]) {
      if (request.method === "GET") return await getDocRawHandler(env, rawDoc[1]);
      return fail(405, "method_not_allowed", `${request.method} not allowed on ${pathname}`);
    }

    const doc = /^\/docs\/([^/]+)$/.exec(rest);
    if (doc?.[1]) {
      if (request.method === "GET") return await getDocHandler(request, env, doc[1]);
      if (request.method === "PATCH") return await patchDocHandler(request, env, doc[1]);
      if (request.method === "DELETE") return await deleteDocHandler(env, doc[1]);
      return fail(405, "method_not_allowed", `${request.method} not allowed on ${pathname}`);
    }

    if (rest === "/search") {
      if (request.method === "GET") return await searchHandler(request, env);
      return fail(405, "method_not_allowed", `${request.method} not allowed on /api/search`);
    }

    if (rest === "/access/sync") {
      if (request.method === "POST") return await accessSyncHandler(request, env);
      return fail(405, "method_not_allowed", `${request.method} not allowed on /api/access/sync`);
    }

    if (rest === "/portals") {
      if (request.method === "POST") return await createPortal(request, env);
      if (request.method === "GET") return json({ portals: await listPortals(env) });
      return fail(405, "method_not_allowed", `${request.method} not allowed on /api/portals`);
    }

    const members = /^\/portals\/([^/]+)\/members$/.exec(rest);
    if (members?.[1]) return await membersHandler(request, env, members[1]);

    const portal = /^\/portals\/([^/]+)$/.exec(rest);
    if (portal?.[1]) return await portalHandler(request, env, portal[1]);

    return fail(404, "not_found", `No such endpoint: ${pathname}`);
  } catch (err) {
    if (err instanceof Conflict) {
      // Surface the existing id + name so the CLI can offer the real next steps (--confirm to
      // replace, --name to fork, mint to change only the link). The message stays generic; the
      // CLI-specific guidance is the CLI's to build. See ADR-017.
      return fail(409, "already_exists", err.message, {
        id: err.existing.id,
        name: err.existing.name,
        portal: err.existing.portal,
      });
    }
    if (err instanceof BadRequest) {
      const status = err.code === "too_large" ? 413 : 400;
      return fail(status, err.code, err.message);
    }
    if (err instanceof Misconfigured) return fail(500, err.code, err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * `GET /api/search?portal={slug}&q={query}[&limit=N]` — keyword search within one client's
 * documents (#73). Mirrors the `search_portal` MCP tool over the same `searchPortal` service. The
 * portal is REQUIRED: searching across every client at once is how one client's material ends up
 * in another's report (prime directive #5). A blank/whitespace query throws BadRequest → 400.
 */
async function searchHandler(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const portal = params.get("portal");
  const q = params.get("q") ?? params.get("query");
  if (!portal) return fail(400, "invalid_field", `"portal" is required`);
  if (!q) return fail(400, "invalid_field", `"q" is required`);
  const limit = Math.max(1, Math.min(50, Number(params.get("limit")) || 10));
  return json({ hits: await searchPortal(env, portal, q, limit) });
}

/**
 * `POST /api/access/sync[?reap=true]` — reconcile the `pagevault-viewers` Access group to match
 * KV (#85). Recomputes the desired set (portal members ∪ document `extraEmails` ∪ owner) and
 * rebuilds the group; `?reap=true` also prunes members KV no longer authorizes, reclaiming their
 * Access seats (ADR-002). Owner-bearer only, like every `/api` route.
 *
 * Tier 0 (no Access configured) is a `400 not_configured`, not a lie about success. A Cloudflare
 * API failure is a `502` — the reconcile is a downstream call that can genuinely fail.
 */
async function accessSyncHandler(request: Request, env: Env): Promise<Response> {
  const reap = new URL(request.url).searchParams.get("reap") === "true";
  const result = await reconcileAccessGroup(env, reap);

  if (result.status === "not_configured") {
    return fail(400, "not_configured", "Email-secured access is not enabled (Tier 0) — no group to reconcile.");
  }
  if (result.status === "failed") {
    return fail(502, "sync_failed", `Access group reconcile failed: ${result.error}`);
  }
  return json({
    added: result.added,
    removed: result.removed,
    kept: result.kept,
    groupSize: result.groupSize,
    reaped: reap,
  });
}

async function createDoc(request: Request, env: Env): Promise<Response> {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return fail(413, "too_large", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
  }

  const body = await readJson(request);

  const { meta, created, portal, sync } = await publishDocument(env, {
    title: parseTitle(body["title"]),
    filename: typeof body["filename"] === "string" ? body["filename"] : undefined,
    source: requireString(body["html"] ?? body["source"], "html"),
    portal: typeof body["portal"] === "string" ? body["portal"] : undefined,
    summary: parseSummary(body["summary"]),
    tags: parseTags(body["tags"]),
    ownerOnly: body["ownerOnly"] === true,
    extraEmails: parseEmails(body["emails"] ?? body["extraEmails"], "emails"),
    makePublic: body["public"] === true,
    sourceKind: parseSourceKind(body["sourceKind"]),
    confirm: body["confirm"] === true,
  });

  const result = publishResult(meta, portal, baseUrl(request, env));
  // #27: tell the caller whether a per-document email grant was actually admitted to Access.
  if (sync) result["sync"] = sync.status;
  return json(result, created ? 201 : 200);
}

async function listDocsHandler(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const portal = params.get("portal") ?? undefined;
  const tag = params.get("tag");

  const docs = (await listDocs(env, portal)).filter((doc) => !tag || doc.tags?.includes(tag));
  docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return json({ docs });
}

async function getDocHandler(request: Request, env: Env, id: string): Promise<Response> {
  const meta = await getMeta(env, id);
  if (!meta) return fail(404, "not_found", `No such document: ${id}`);
  // Include the ready-to-open URL(s), built server-side the way publish does — the portal's kind
  // decides /v vs /pub, which a caller can't know from meta alone. Lets `pagevault link` / `read`
  // (and any /api client) hand back a URL without a second round-trip.
  const portal = await getPortal(env, meta.portal);
  const base = baseUrl(request, env);
  const body: Record<string, unknown> = {
    ...meta,
    url: portal ? `${base}${documentPath(portal, id)}` : `${base}/v/${encodeURIComponent(meta.portal)}/${id}`,
  };
  if (meta.publicToken) body["publicUrl"] = `${base}/p/${meta.publicToken}`;
  return json(body);
}

/**
 * The document body, as bytes — what `pagevault export` (#35) writes to a file. Returns the
 * ORIGINAL source: the `.md` for a markdown document, the stored HTML for an html one
 * (`getRawSource ?? getDoc`), so the extension the CLI picks from `sourceKind` round-trips
 * honestly. Owner-scoped like every `/api` route; `canView` is not consulted because the
 * bearer already IS the owner, who sees everything. No KV write, but never cached — the body
 * is the private artifact.
 */
async function getDocRawHandler(env: Env, id: string): Promise<Response> {
  const meta = await getMeta(env, id);
  if (!meta) return fail(404, "not_found", `No such document: ${id}`);

  const body = (await getRawSource(env, id)) ?? (await getDoc(env, id));
  if (body === null) return fail(404, "not_found", `No stored body for document: ${id}`);

  const contentType = meta.sourceKind === "markdown" ? "text/markdown" : "text/html";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": `${contentType}; charset=utf-8`, "Cache-Control": "private, no-store" },
  });
}

async function deleteDocHandler(env: Env, id: string): Promise<Response> {
  const meta = await getMeta(env, id);
  if (!meta) return fail(404, "not_found", `No such document: ${id}`);

  await deleteDoc(env, meta);
  return json({ ok: true });
}

/**
 * The console's per-document controls: the `ownerOnly` (draft) toggle, public-link
 * mint/revoke, and per-document email grants. A thin shell over `patchDocument`, which owns
 * the single write and the Access-group sync — the same service the MCP tools reach for, so
 * the sync cannot be present on one path and forgotten on another.
 *
 * Title and body are NOT patchable here — they go through publish (create-or-update).
 */
async function patchDocHandler(request: Request, env: Env, id: string): Promise<Response> {
  const body = await readJson(request);

  const patch: DocPatch = {};
  let any = false;
  if ("ownerOnly" in body) {
    if (typeof body["ownerOnly"] !== "boolean") return fail(400, "invalid_field", `"ownerOnly" must be a boolean`);
    patch.ownerOnly = body["ownerOnly"];
    any = true;
  }
  if ("makePublic" in body) {
    if (typeof body["makePublic"] !== "boolean") return fail(400, "invalid_field", `"makePublic" must be a boolean`);
    patch.makePublic = body["makePublic"];
    any = true;
  }
  if ("rotatePublic" in body) {
    if (typeof body["rotatePublic"] !== "boolean") return fail(400, "invalid_field", `"rotatePublic" must be a boolean`);
    patch.rotatePublic = body["rotatePublic"];
    any = true;
  }
  if ("addEmails" in body) {
    patch.addEmails = parseEmails(body["addEmails"], "addEmails") ?? [];
    any = true;
  }
  if ("removeEmails" in body) {
    patch.removeEmails = parseEmails(body["removeEmails"], "removeEmails") ?? [];
    any = true;
  }
  if (!any) {
    return fail(400, "invalid_field", `PATCH expects one of: ownerOnly, makePublic, rotatePublic, addEmails, removeEmails`);
  }

  const result = await patchDocument(env, id, patch);
  if (!result) return fail(404, "not_found", `No such document: ${id}`);

  // The public link is a different URL, not a meta field the caller can build reliably — the
  // host comes from PUBLIC_HOST, which only the Worker knows. Hand back the /p/ URL whenever a
  // token is present so `pagevault mint`/`rotate` can print it verbatim, matching publish.
  const out: Record<string, unknown> = { ...result.meta };
  if (result.meta.publicToken) out["publicUrl"] = `${baseUrl(request, env)}/p/${result.meta.publicToken}`;
  // Surface the group-sync outcome so a grant that landed in KV but that Access still blocks
  // is never silent (ADR-002). Absent when the patch granted no new email.
  if (result.sync) out["sync"] = result.sync.status;
  return json(out);
}

// ---------------------------------------------------------------------------
// Portals
// ---------------------------------------------------------------------------

async function createPortal(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);

  // Validated as given, NOT lowercased first. Silently turning "Has-Caps" into "has-caps"
  // means the caller later references the name they typed and gets a 404.
  const slug = requireString(body["slug"], "slug").trim();
  if (!isValidSlug(slug)) {
    throw new BadRequest(
      "invalid_slug",
      `"${slug}" is not a valid portal slug: lowercase letters, digits and hyphens, 2-40 chars, and not a reserved word`,
    );
  }
  if (await getPortal(env, slug)) {
    throw new BadRequest("portal_exists", `Portal "${slug}" already exists`);
  }

  const now = new Date().toISOString();
  const portal: Portal = {
    slug,
    name: parseTitle(body["name"] ?? slug),
    kind: parsePortalKind(body["kind"]),
    createdAt: now,
    updatedAt: now,
  };
  const description = parseSummary(body["description"]);
  if (description) portal.description = description;

  await putPortal(env, portal);
  return json(portal, 201);
}

async function portalHandler(request: Request, env: Env, slug: string): Promise<Response> {
  const portal = await getPortal(env, slug);
  if (!portal) return fail(404, "no_such_portal", `No such portal: ${slug}`);

  if (request.method === "GET") {
    const [docs, members] = await Promise.all([listDocs(env, slug), getMembers(env, slug)]);
    // The console needs the member list to show and remove them, not just a count.
    return json({ ...portal, docCount: docs.length, memberCount: members.length, members });
  }

  if (request.method === "PATCH") {
    const body = await readJson(request);

    // Membership goes through the shared service so the Access group stays in sync (#20) —
    // the same code the MCP tool uses.
    const add = parseEmails(body["addMembers"], "addMembers") ?? [];
    const remove = parseEmails(body["removeMembers"], "removeMembers") ?? [];
    const memberChange = add.length > 0 || remove.length > 0;
    const memberResult = memberChange ? await updatePortalMembers(env, slug, add, remove) : null;

    // Portal metadata (optional, independent of membership).
    let updated: Portal = portal;
    if (body["name"] !== undefined || body["kind"] !== undefined || body["description"] !== undefined) {
      updated = { ...portal, updatedAt: new Date().toISOString() };
      if (body["name"] !== undefined) updated.name = parseTitle(body["name"]);
      if (body["kind"] !== undefined) updated.kind = parsePortalKind(body["kind"]);
      if (body["description"] !== undefined) {
        const description = parseSummary(body["description"]);
        if (description) updated.description = description;
        else delete updated.description;
      }
      await putPortal(env, updated);
    }

    const members = memberResult ? memberResult.members : await getMembers(env, slug);
    return json({ ...updated, members, ...(memberResult ? { sync: memberResult.sync.status } : {}) });
  }

  if (request.method === "DELETE") return await deletePortalHandler(request, env, portal);

  return fail(405, "method_not_allowed", `${request.method} not allowed on /api/portals/${slug}`);
}

/**
 * Deleting a portal deletes a client's entire history. Make that impossible to do by
 * accident: it refuses on a non-empty portal unless the caller says `?cascade=true`, and
 * the error names how many documents it is about to destroy.
 */
async function deletePortalHandler(request: Request, env: Env, portal: Portal): Promise<Response> {
  const cascade = new URL(request.url).searchParams.get("cascade") === "true";
  const docs = await listDocs(env, portal.slug);

  if (docs.length > 0 && !cascade) {
    return fail(
      409,
      "portal_not_empty",
      `Portal "${portal.slug}" holds ${docs.length} document(s). Deleting it deletes them too. Re-send with ?cascade=true.`,
    );
  }

  for (const summary of docs) {
    const meta = await getMeta(env, summary.id);
    if (meta) await deleteDoc(env, meta);
  }
  await deletePortal(env, portal.slug);

  return json({ ok: true, deleted: docs.length });
}

// ---------------------------------------------------------------------------
// Members — the payoff of the whole data model
// ---------------------------------------------------------------------------

async function membersHandler(request: Request, env: Env, slug: string): Promise<Response> {
  const portal = await getPortal(env, slug);
  if (!portal) return fail(404, "no_such_portal", `No such portal: ${slug}`);

  if (request.method === "GET") return json({ members: await getMembers(env, slug) });

  // ⭐ One call adds a person to every document this client has ever received. That is the
  // entire reason permissions live on the portal rather than on the document.
  if (request.method === "PUT") {
    const body = await readJson(request);
    await putMembers(env, slug, parseEmails(body["emails"], "emails") ?? []);
    return json({ members: await getMembers(env, slug) });
  }

  if (request.method === "POST") {
    const body = await readJson(request);
    const add = parseEmails(body["add"], "add") ?? [];
    const remove = new Set(parseEmails(body["remove"], "remove") ?? []);

    const current = await getMembers(env, slug);
    const next = [...new Set([...current, ...add])].filter((email) => !remove.has(email));

    await putMembers(env, slug, next);
    return json({ members: await getMembers(env, slug) });
  }

  return fail(405, "method_not_allowed", `${request.method} not allowed on this endpoint`);
}

// ---------------------------------------------------------------------------

async function readJson(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BadRequest("invalid_json", "Request body is not valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequest("invalid_body", "Request body must be an object");
  }
  return body as Record<string, unknown>;
}

const PORTAL_KINDS: readonly PortalKind[] = ["private", "restricted", "public"];

function parsePortalKind(value: unknown): PortalKind {
  if (value === undefined) return "private";
  if (typeof value !== "string" || !PORTAL_KINDS.includes(value as PortalKind)) {
    throw new BadRequest("invalid_field", `"kind" must be one of: ${PORTAL_KINDS.join(", ")}`);
  }
  return value as PortalKind;
}

/**
 * Share links come from `PUBLIC_HOST`, falling back to the host the request arrived on —
 * which is nearly always right, and means an unset var degrades to correct rather than to
 * `https:///v/abc`.
 */
function baseUrl(request: Request, env: Env): string {
  const configured = env.PUBLIC_HOST?.trim();
  return configured ? `https://${configured}` : new URL(request.url).origin;
}

function publishResult(meta: DocMeta, portal: Portal, base: string) {
  const result: Record<string, unknown> = {
    id: meta.id,
    portal: meta.portal,
    name: meta.name,
    title: meta.title,
    // Always print where it landed. This — not a required --portal flag — is what catches a
    // client report filed into the wrong client's portal. See ADR-005.
    //
    // A public portal's URL is /pub/, not /v/: handing someone a /v/ link to a public page
    // walks them into an Access login wall and burns a seat.
    url: `${base}${documentPath(portal, meta.id)}`,
    ownerOnly: meta.ownerOnly,
  };
  if (meta.extraEmails) result["extraEmails"] = meta.extraEmails;
  // The public link is a *different* URL, not a variant: /v/ still requires a login.
  if (meta.publicToken) result["publicUrl"] = `${base}/p/${meta.publicToken}`;
  return result;
}

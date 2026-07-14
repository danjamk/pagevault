import { isAuthorized } from "./auth.js";
import { originAllowed } from "./capability.js";
import {
  BadRequest,
  Conflict,
  Misconfigured,
  documentPath,
  parseEmails,
  parseSourceKind,
  parseSummary,
  parseTags,
  parseTitle,
  publishDocument,
  requireString,
} from "./documents.js";
import type { Env } from "./env.js";
import {
  type DocMeta,
  type Portal,
  type PortalKind,
  deleteDoc,
  deletePortal,
  getMembers,
  getMeta,
  getPortal,
  isValidSlug,
  listDocs,
  listPortals,
  putMembers,
  putPortal,
} from "./store.js";
import { logBlocked } from "./viewer.js";

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

const fail = (status: number, code: string, error: string) => json({ error, code }, status);

export async function handleApi(request: Request, env: Env): Promise<Response> {
  // Defense in depth, ahead of the bearer check.
  //
  // A sandboxed artifact has an opaque origin, so anything it fetches arrives with
  // `Origin: null`. It has no bearer token either, so the check below would already refuse
  // it — but this is the cheapest possible second wall, and it means a future endpoint that
  // gets its auth wrong is still not reachable from inside an artifact. See ADR-007.
  if (!originAllowed(request)) {
    logBlocked("blocked_api_request_invalid_origin", request);
    return fail(403, "forbidden_origin", "Cross-origin request refused");
  }

  if (!isAuthorized(request, env)) {
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

    const doc = /^\/docs\/([^/]+)$/.exec(rest);
    if (doc?.[1]) {
      if (request.method === "GET") return await getDocHandler(env, doc[1]);
      if (request.method === "DELETE") return await deleteDocHandler(env, doc[1]);
      return fail(405, "method_not_allowed", `${request.method} not allowed on ${pathname}`);
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
    if (err instanceof Conflict) return fail(409, "already_exists", err.message);
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

async function createDoc(request: Request, env: Env): Promise<Response> {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return fail(413, "too_large", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
  }

  const body = await readJson(request);

  const { meta, created, portal } = await publishDocument(env, {
    title: parseTitle(body["title"]),
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

  return json(publishResult(meta, portal, baseUrl(request, env)), created ? 201 : 200);
}

async function listDocsHandler(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const portal = params.get("portal") ?? undefined;
  const tag = params.get("tag");

  const docs = (await listDocs(env, portal)).filter((doc) => !tag || doc.tags?.includes(tag));
  docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return json({ docs });
}

async function getDocHandler(env: Env, id: string): Promise<Response> {
  const meta = await getMeta(env, id);
  if (!meta) return fail(404, "not_found", `No such document: ${id}`);
  return json(meta);
}

async function deleteDocHandler(env: Env, id: string): Promise<Response> {
  const meta = await getMeta(env, id);
  if (!meta) return fail(404, "not_found", `No such document: ${id}`);

  await deleteDoc(env, meta);
  return json({ ok: true });
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
    return json({ ...portal, docCount: docs.length, memberCount: members.length });
  }

  if (request.method === "PATCH") {
    const body = await readJson(request);
    const updated: Portal = { ...portal, updatedAt: new Date().toISOString() };

    if (body["name"] !== undefined) updated.name = parseTitle(body["name"]);
    if (body["kind"] !== undefined) updated.kind = parsePortalKind(body["kind"]);
    if (body["description"] !== undefined) {
      const description = parseSummary(body["description"]);
      if (description) updated.description = description;
      else delete updated.description;
    }

    await putPortal(env, updated);
    return json(updated);
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

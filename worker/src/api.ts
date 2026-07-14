import { isAuthorized } from "./auth.js";
import { originAllowed } from "./capability.js";
import type { Env } from "./env.js";
import { logBlocked } from "./viewer.js";
import {
  DEFAULT_PORTAL,
  type DocMeta,
  type Portal,
  type PortalKind,
  type SourceKind,
  deleteDoc,
  deletePortal,
  getMembers,
  getMeta,
  getPortal,
  isValidSlug,
  listDocs,
  listPortals,
  metadataFits,
  mintId,
  mintPublicToken,
  normalizeEmail,
  putDoc,
  putMembers,
  putPortal,
  putPublicToken,
} from "./store.js";

/** KV's hard cap is 25MiB. The body is JSON-wrapped, so stay well under it. */
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
/** Reject on Content-Length before buffering 25MB of JSON into a 128MB isolate. */
const MAX_BODY_BYTES = 12 * 1024 * 1024;

const MAX_TITLE_CHARS = 200;
const MAX_SUMMARY_CHARS = 300;
const MAX_TAGS = 16;
const MAX_TAG_CHARS = 64;
/** Same DoS bound as a portal member list. */
const MAX_EXTRA_EMAILS = 100;

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

/** The caller sent something wrong. */
class BadRequest extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The *deployment* is wrong. A 500, not a 400 — the caller did nothing wrong, and a
 * 400 would send them hunting through their own request.
 */
class Misconfigured extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  // Defense in depth, ahead of the bearer check.
  //
  // A sandboxed artifact has an opaque origin, so anything it fetches arrives with
  // `Origin: null`. It has no bearer token either, so the check below would already
  // refuse it — but this is the cheapest possible second wall, and it means a future
  // endpoint that gets its auth wrong is still not reachable from inside an artifact.
  // The console (#5) sends a real Origin; the CLI and MCP server send none. See ADR-007.
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
    if (err instanceof BadRequest) return fail(400, err.code, err.message);
    if (err instanceof Misconfigured) return fail(500, err.code, err.message);
    throw err;
  }
}

async function createDoc(request: Request, env: Env): Promise<Response> {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return fail(413, "too_large", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "invalid_json", "Request body is not valid JSON");
  }
  if (!isRecord(body)) return fail(400, "invalid_body", "Request body must be an object");

  requireOwner(env); // fail fast on a deployment with no owner

  const source = requireString(body["html"] ?? body["source"], "html");
  const bytes = new TextEncoder().encode(source).byteLength;
  if (bytes > MAX_SOURCE_BYTES) {
    return fail(413, "too_large", `Document is ${bytes} bytes; the limit is ${MAX_SOURCE_BYTES}`);
  }

  const portal = await resolvePortal(env, body["portal"]);

  const now = new Date().toISOString();
  const meta: DocMeta = {
    id: mintId(),
    portal: portal.slug,
    title: parseTitle(body["title"]),
    sourceKind: parseSourceKind(body["sourceKind"]),
    ownerOnly: body["ownerOnly"] === true,
    createdAt: now,
    updatedAt: now,
    bytes,
  };

  const summary = parseSummary(body["summary"]);
  if (summary) meta.summary = summary;

  const tags = parseTags(body["tags"]);
  if (tags) meta.tags = tags;

  // The Spec 01 simple path, preserved: `--emails cfo@acme.com` grants those two people
  // access to THIS document, without making the user invent a portal for them.
  // Additive, never subtractive. See ADR-005.
  const extraEmails = parseExtraEmails(body["emails"] ?? body["extraEmails"]);
  if (extraEmails) meta.extraEmails = extraEmails;

  // Widening is explicit and never a side effect of publishing.
  if (body["public"] === true) meta.publicToken = mintPublicToken();

  // Check before writing: KV rejects an oversized metadata write, and that failure
  // would surface as a document missing from every listing rather than a bad request.
  if (!metadataFits(meta)) {
    return fail(400, "metadata_too_large", "Title, summary and tags are too long to index");
  }

  await putDoc(env, meta, source);
  if (meta.publicToken) await putPublicToken(env, meta.publicToken, meta.id);

  return json(publishResult(meta, baseUrl(request, env)), 201);
}

async function listDocsHandler(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const portal = params.get("portal") ?? undefined;
  const tag = params.get("tag");

  const docs = (await listDocs(env, portal)).filter((doc) => !tag || doc.tags?.includes(tag));

  // Newest first. Both the console and the CLI want it this way, and sorting fewer than
  // 1000 summaries in the Worker is cheaper than any alternative.
  docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return json({ docs });
}

async function getDocHandler(env: Env, id: string): Promise<Response> {
  const meta = await getMeta(env, id);
  if (!meta) return fail(404, "not_found", `No such document: ${id}`);
  return json(meta);
}

// ---------------------------------------------------------------------------
// Portals
// ---------------------------------------------------------------------------

async function createPortal(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);

  // Validated as given, NOT lowercased first. Silently turning "Has-Caps" into
  // "has-caps" means the caller later references the name they typed and gets a 404.
  // Reject and say why.
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

  const kind = parsePortalKind(body["kind"]);
  const now = new Date().toISOString();

  const portal: Portal = {
    slug,
    name: parseTitle(body["name"] ?? slug),
    kind,
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

  if (request.method === "DELETE") {
    return await deletePortalHandler(request, env, portal);
  }

  return fail(405, "method_not_allowed", `${request.method} not allowed on /api/portals/${slug}`);
}

/**
 * Deleting a portal deletes a client's entire history. Make that impossible to do by
 * accident: it refuses on a non-empty portal unless the caller says `?cascade=true`, and
 * the error says exactly how many documents it is about to destroy.
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

  if (request.method === "GET") {
    return json({ members: await getMembers(env, slug) });
  }

  // ⭐ One call adds a person to every document this client has ever received. That is
  // the entire reason permissions live on the portal rather than the document.
  if (request.method === "PUT") {
    const body = await readJson(request);
    const emails = parseEmailList(body["emails"], "emails");
    await putMembers(env, slug, emails ?? []);
    return json({ members: await getMembers(env, slug) });
  }

  if (request.method === "POST") {
    const body = await readJson(request);
    const add = parseEmailList(body["add"], "add") ?? [];
    const remove = new Set(parseEmailList(body["remove"], "remove") ?? []);

    const current = await getMembers(env, slug);
    const next = [...new Set([...current, ...add])].filter((email) => !remove.has(email));

    await putMembers(env, slug, next);
    return json({ members: await getMembers(env, slug) });
  }

  return fail(405, "method_not_allowed", `${request.method} not allowed on this endpoint`);
}

// ---------------------------------------------------------------------------

/**
 * Which portal does this document go in?
 *
 * The resolution ladder exists so that the word "portal" never appears in the
 * quickstart. A tool that demands a taxonomy before it gives you a URL is a tool
 * nobody adopts (ADR-005).
 *
 *   1. Explicit `portal` → use it.
 *   2. No portals at all → create `default` and use it.
 *   3. Exactly one portal → use it. With one portal you cannot misfile, so there is
 *      nothing to protect against, and asking would be a concept tax.
 *   4. `default` exists → use it.
 *   5. Otherwise → **error and list them.** Never guess. Guessing is exactly how
 *      Client A's report lands in Client B's portal.
 */
async function resolvePortal(env: Env, requested: unknown): Promise<Portal> {
  if (typeof requested === "string" && requested.length > 0) {
    if (!isValidSlug(requested)) {
      throw new BadRequest("invalid_slug", `"${requested}" is not a valid portal slug`);
    }
    const portal = await getPortal(env, requested);
    if (!portal) throw new BadRequest("no_such_portal", `No such portal: ${requested}`);
    return portal;
  }

  const portals = await listPortals(env);

  if (portals.length === 0) return ensureDefaultPortal(env);
  if (portals.length === 1) return portals[0]!;

  const fallback = portals.find((p) => p.slug === DEFAULT_PORTAL);
  if (fallback) return fallback;

  throw new BadRequest(
    "portal_ambiguous",
    `Multiple portals exist and no default is set. Specify one: ${portals
      .map((p) => p.slug)
      .join(", ")}`,
  );
}

async function ensureDefaultPortal(env: Env): Promise<Portal> {
  const existing = await getPortal(env, DEFAULT_PORTAL);
  if (existing) return existing;

  const now = new Date().toISOString();
  const portal: Portal = {
    slug: DEFAULT_PORTAL,
    name: "Default",
    kind: "private",
    createdAt: now,
    updatedAt: now,
  };
  await putPortal(env, portal);
  return portal;
}

/**
 * The origin for share links.
 *
 * Prefers `PUBLIC_HOST`, falling back to the host the request arrived on — which is
 * nearly always right, and means an unset var degrades to correct rather than to
 * `https:///v/abc`.
 */
function baseUrl(request: Request, env: Env): string {
  const configured = env.PUBLIC_HOST?.trim();
  return configured ? `https://${configured}` : new URL(request.url).origin;
}

function publishResult(meta: DocMeta, base: string) {
  const result: Record<string, unknown> = {
    id: meta.id,
    portal: meta.portal,
    // Always print where it landed. This — not a required --portal flag — is what
    // catches a client report filed into the wrong client's portal. See ADR-005.
    url: `${base}/v/${meta.portal}/${meta.id}`,
    ownerOnly: meta.ownerOnly,
  };
  if (meta.extraEmails) result["extraEmails"] = meta.extraEmails;
  // The public link is a *different* URL, not a variant of the same one: /v/ still
  // requires an allowlisted login, /p/ requires nothing at all.
  if (meta.publicToken) result["publicUrl"] = `${base}/p/${meta.publicToken}`;
  return result;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

async function readJson(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BadRequest("invalid_json", "Request body is not valid JSON");
  }
  if (!isRecord(body)) throw new BadRequest("invalid_body", "Request body must be an object");
  return body;
}

const PORTAL_KINDS: readonly PortalKind[] = ["private", "restricted", "public"];

function parsePortalKind(value: unknown): PortalKind {
  if (value === undefined) return "private";
  if (typeof value !== "string" || !PORTAL_KINDS.includes(value as PortalKind)) {
    throw new BadRequest("invalid_field", `"kind" must be one of: ${PORTAL_KINDS.join(", ")}`);
  }
  return value as PortalKind;
}

/** Same 100-email DoS bound as an extraEmails list. */
function parseEmailList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new BadRequest("invalid_field", `"${field}" must be an array`);
  if (value.length > MAX_EXTRA_EMAILS) {
    throw new BadRequest("invalid_field", `"${field}" exceeds ${MAX_EXTRA_EMAILS} entries`);
  }

  const emails = value.map((email) => {
    if (typeof email !== "string") {
      throw new BadRequest("invalid_field", `"${field}" must be strings`);
    }
    const normalized = normalizeEmail(email);
    if (!normalized.includes("@")) {
      throw new BadRequest("invalid_field", `"${email}" is not an email address`);
    }
    return normalized;
  });

  return [...new Set(emails)];
}

/**
 * Every document carries the owner. A blank `OWNER_EMAIL` would publish documents
 * nobody can open — `canView` grants the owner first, and there would be no owner.
 * Fail at publish, where the error can say why.
 */
function requireOwner(env: Env): string {
  const owner = normalizeEmail(env.OWNER_EMAIL ?? "");
  if (!owner) {
    throw new Misconfigured("owner_not_configured", "OWNER_EMAIL is not set on this deployment");
  }
  return owner;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BadRequest("invalid_field", `"${field}" is required and must be a non-empty string`);
  }
  return value;
}

function parseTitle(value: unknown): string {
  const title = requireString(value, "title").trim();
  if (title.length === 0) throw new BadRequest("invalid_field", `"title" cannot be blank`);
  if (title.length > MAX_TITLE_CHARS) {
    throw new BadRequest("invalid_field", `"title" exceeds ${MAX_TITLE_CHARS} characters`);
  }
  return title;
}

function parseSummary(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const summary = requireString(value, "summary").trim();
  if (summary.length > MAX_SUMMARY_CHARS) {
    throw new BadRequest("invalid_field", `"summary" exceeds ${MAX_SUMMARY_CHARS} characters`);
  }
  return summary || undefined;
}

function parseSourceKind(value: unknown): SourceKind {
  if (value === undefined) return "html";
  if (value !== "html" && value !== "markdown") {
    throw new BadRequest("invalid_field", `"sourceKind" must be "html" or "markdown"`);
  }
  return value;
}

function parseTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new BadRequest("invalid_field", `"tags" must be an array`);
  if (value.length > MAX_TAGS) {
    throw new BadRequest("invalid_field", `"tags" exceeds ${MAX_TAGS} entries`);
  }

  const tags = value.map((tag) => {
    if (typeof tag !== "string") throw new BadRequest("invalid_field", `"tags" must be strings`);
    const trimmed = tag.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TAG_CHARS) {
      throw new BadRequest("invalid_field", `each tag must be 1-${MAX_TAG_CHARS} characters`);
    }
    return trimmed;
  });

  return tags.length > 0 ? [...new Set(tags)] : undefined;
}

function parseExtraEmails(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new BadRequest("invalid_field", `"emails" must be an array`);
  if (value.length > MAX_EXTRA_EMAILS) {
    throw new BadRequest("invalid_field", `"emails" exceeds ${MAX_EXTRA_EMAILS} entries`);
  }

  const emails = value.map((email) => {
    if (typeof email !== "string") throw new BadRequest("invalid_field", `"emails" must be strings`);
    const normalized = normalizeEmail(email);
    if (!normalized.includes("@")) {
      throw new BadRequest("invalid_field", `"${email}" is not an email address`);
    }
    return normalized;
  });

  return emails.length > 0 ? [...new Set(emails)] : undefined;
}

import { isAuthorized } from "./auth.js";
import type { Env } from "./env.js";
import {
  type DocMeta,
  type Visibility,
  getMeta,
  listDocs,
  metadataFits,
  mintId,
  mintPublicToken,
  putDoc,
  putPublicToken,
} from "./store.js";

/** KV's hard cap is 25MiB. The body is JSON-wrapped, so stay well under it. */
const MAX_HTML_BYTES = 10 * 1024 * 1024;
/** Reject on Content-Length before buffering 25MB of JSON into a 128MB isolate. */
const MAX_BODY_BYTES = 12 * 1024 * 1024;

const MAX_TITLE_CHARS = 200;
const MAX_TAGS = 16;
const MAX_TAG_CHARS = 64;
const MAX_EMAILS = 100;

const VISIBILITIES: readonly Visibility[] = ["private", "restricted", "public"];

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
 * The *deployment* is wrong. Surfaces as a 500, not a 400 — the caller did nothing
 * wrong, and a 400 would send them hunting through their own request.
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

    const match = /^\/docs\/([^/]+)$/.exec(rest);
    if (match?.[1]) {
      if (request.method === "GET") return await getDocHandler(env, match[1]);
      return fail(405, "method_not_allowed", `${request.method} not allowed on ${pathname}`);
    }

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

  const html = requireString(body["html"], "html");
  const bytes = new TextEncoder().encode(html).byteLength;
  if (bytes > MAX_HTML_BYTES) {
    return fail(413, "too_large", `Document is ${bytes} bytes; the limit is ${MAX_HTML_BYTES}`);
  }

  const title = parseTitle(body["title"]);
  const visibility = parseVisibility(body["visibility"]);
  const tags = parseTags(body["tags"]);
  const emails = parseEmails(body["emails"], visibility, requireOwner(env));

  const now = new Date().toISOString();
  const meta: DocMeta = {
    id: mintId(),
    title,
    visibility,
    emails,
    createdAt: now,
    updatedAt: now,
    bytes,
  };
  if (tags) meta.tags = tags;
  if (visibility === "public") meta.publicToken = mintPublicToken();

  // Check before writing. KV rejects an oversized metadata write, and that failure
  // would surface as a document missing from every listing rather than a bad request.
  if (!metadataFits(meta)) {
    return fail(400, "metadata_too_large", "Title and tags are too long to index; shorten them");
  }

  await putDoc(env, meta, html);
  if (meta.publicToken) await putPublicToken(env, meta.publicToken, meta.id);

  return json(publishResult(meta, baseUrl(request, env)), 201);
}

async function listDocsHandler(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const tag = params.get("tag");
  const visibility = params.get("visibility");

  const docs = await listDocs(env);
  const filtered = docs.filter(
    (doc) => (!tag || doc.tags?.includes(tag)) && (!visibility || doc.visibility === visibility),
  );

  // Newest first. Both the console and the CLI want it this way, and sorting fewer
  // than 1000 summaries in the Worker is cheaper than any alternative.
  filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return json({ docs: filtered });
}

async function getDocHandler(env: Env, id: string): Promise<Response> {
  const meta = await getMeta(env, id);
  if (!meta) return fail(404, "not_found", `No such document: ${id}`);
  return json(meta);
}

/**
 * The origin to build share links on.
 *
 * Prefers `PUBLIC_HOST`, but falls back to the host the request actually arrived on —
 * which is nearly always right, since the CLI and console both talk to the deployment
 * by its real hostname. The fallback is what makes `wrangler dev` work with no config,
 * and it means an unset `PUBLIC_HOST` degrades to correct rather than to `https:///d/abc`.
 */
function baseUrl(request: Request, env: Env): string {
  const configured = env.PUBLIC_HOST?.trim();
  return configured ? `https://${configured}` : new URL(request.url).origin;
}

function publishResult(meta: DocMeta, base: string) {
  const result: Record<string, unknown> = {
    id: meta.id,
    url: `${base}/d/${meta.id}`,
    visibility: meta.visibility,
    emails: meta.emails,
  };
  // The public link is a *different* URL, not a variant of the same one. Returning
  // both keeps the caller honest about which they are handing to a human: /d/ still
  // requires an allowlisted login, /p/ requires nothing at all.
  if (meta.publicToken) result["publicUrl"] = `${base}/p/${meta.publicToken}`;
  return result;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The owner. Never optional.
 *
 * Every document carries the owner on its allowlist, so revoking public access still
 * leaves a document its owner can open. A blank `OWNER_EMAIL` would silently publish
 * ownerless documents — readable by nobody once #4 gates `/d/` on the allowlist. Fail
 * at the first publish instead, where the error can say why.
 */
function requireOwner(env: Env): string {
  const owner = env.OWNER_EMAIL?.trim().toLowerCase();
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

function parseVisibility(value: unknown): Visibility {
  if (value === undefined) return "private";
  if (typeof value !== "string" || !VISIBILITIES.includes(value as Visibility)) {
    throw new BadRequest("invalid_field", `"visibility" must be one of: ${VISIBILITIES.join(", ")}`);
  }
  return value as Visibility;
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

/**
 * `private` is `restricted` with only the owner on it. The distinct label exists
 * because it is clearer at the call site and in the UI, not because it is a different
 * mechanism.
 */
function parseEmails(value: unknown, visibility: Visibility, owner: string): string[] {
  if (visibility !== "restricted") return [owner];

  if (!Array.isArray(value)) {
    throw new BadRequest("invalid_field", `"emails" is required when visibility is "restricted"`);
  }
  if (value.length > MAX_EMAILS) {
    throw new BadRequest("invalid_field", `"emails" exceeds ${MAX_EMAILS} entries`);
  }

  const emails = value.map((email) => {
    if (typeof email !== "string") throw new BadRequest("invalid_field", `"emails" must be strings`);
    const normalized = email.trim().toLowerCase();
    if (!normalized.includes("@")) {
      throw new BadRequest("invalid_field", `"${email}" is not an email address`);
    }
    return normalized;
  });

  return [...new Set([...emails, owner])];
}
import { type GroupSyncResult, syncGroupMembers } from "./access-group.js";
import type { Env } from "./env.js";
import {
  DEFAULT_PORTAL,
  type DocMeta,
  type DocSummary,
  type Portal,
  type SourceKind,
  getDoc,
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

/**
 * The document service.
 *
 * Both the HTTP API and the MCP server call these. Neither reimplements them — a second
 * publish path is a second place for the portal-resolution rules and the overwrite guard
 * to drift, and both of those are the kind of thing that goes wrong quietly. See ADR-006.
 */

/** KV's hard cap is 25MiB. The body is JSON-wrapped, so stay well under it. */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

export const MAX_TITLE_CHARS = 200;
export const MAX_SUMMARY_CHARS = 300;
export const MAX_TAGS = 16;
export const MAX_TAG_CHARS = 64;
/** Same DoS bound as a portal member list. */
export const MAX_EMAILS = 100;

/** The caller sent something wrong. */
export class BadRequest extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The *deployment* is wrong. Surfaces as a 500, not a 400 — the caller did nothing wrong,
 * and a 400 would send them hunting through their own request.
 */
export class Misconfigured extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * ⭐ An agent must not be able to clobber a client deliverable in one tool call.
 *
 * Publishing over an existing `(portal, title)` refuses unless the caller explicitly says
 * `confirm: true`, and the refusal carries enough detail for a human to decide. The model
 * has to come back and ask.
 */
export class Conflict extends Error {
  constructor(
    readonly existing: DocMeta,
    readonly incomingBytes: number,
  ) {
    super(`A document titled "${existing.title}" already exists in portal "${existing.portal}"`);
  }

  /** What the model should show the user before it asks. */
  summary(): string {
    const delta = this.incomingBytes - this.existing.bytes;
    const sign = delta >= 0 ? "+" : "";
    return [
      `"${this.existing.title}" already exists in portal "${this.existing.portal}".`,
      ``,
      `  id:       ${this.existing.id}`,
      `  updated:  ${this.existing.updatedAt}`,
      `  size:     ${this.existing.bytes} bytes → ${this.incomingBytes} bytes (${sign}${delta})`,
      ``,
      `Publishing again REPLACES it in place, keeping the same URL — so anyone holding the`,
      `link sees the new version. The old content is not recoverable.`,
      ``,
      `Ask the user, then call publish_document again with confirm: true.`,
    ].join("\n");
  }
}

export interface PublishInput {
  title: string;
  source: string;
  portal?: string | undefined;
  summary?: string | undefined;
  tags?: string[] | undefined;
  ownerOnly?: boolean | undefined;
  extraEmails?: string[] | undefined;
  makePublic?: boolean | undefined;
  sourceKind?: SourceKind | undefined;
  /** Required to overwrite an existing (portal, title). */
  confirm?: boolean | undefined;
}

export interface PublishResult {
  meta: DocMeta;
  /** False when an existing document was replaced in place. */
  created: boolean;
  /**
   * The resolved portal — not just its slug.
   *
   * Callers need `kind` to build the right URL: a document in a **public** portal lives at
   * `/pub/{slug}/{id}`, which Cloudflare Access never sees. Handing someone the `/v/` URL
   * instead would force them through a login wall and burn one of the 50 free Access
   * seats — for a page that is deliberately public.
   */
  portal: Portal;
}

export async function publishDocument(env: Env, input: PublishInput): Promise<PublishResult> {
  requireOwner(env);

  const source = requireString(input.source, "html");
  const bytes = new TextEncoder().encode(source).byteLength;
  if (bytes > MAX_SOURCE_BYTES) {
    throw new BadRequest("too_large", `Document is ${bytes} bytes; the limit is ${MAX_SOURCE_BYTES}`);
  }

  const portal = await resolvePortal(env, input.portal);
  const title = parseTitle(input.title);

  // Create-or-update, keyed on (portal, title). This is what makes "the link stays
  // current" true: iterating on a report updates the same URL instead of producing a
  // graveyard of stale links — which is, with some irony, the exact problem this project
  // set out to solve.
  const existing = await findByTitle(env, portal.slug, title);
  if (existing && input.confirm !== true) throw new Conflict(existing, bytes);

  const now = new Date().toISOString();
  const meta: DocMeta = {
    id: existing?.id ?? mintId(),
    portal: portal.slug,
    title,
    sourceKind: input.sourceKind ?? "html",
    ownerOnly: input.ownerOnly ?? existing?.ownerOnly ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    bytes,
  };

  const summary = parseSummary(input.summary) ?? existing?.summary;
  if (summary) meta.summary = summary;

  const tags = parseTags(input.tags) ?? existing?.tags;
  if (tags) meta.tags = tags;

  const extraEmails = parseEmails(input.extraEmails, "emails") ?? existing?.extraEmails;
  if (extraEmails) meta.extraEmails = extraEmails;

  // Widening is never a side effect. An existing public link survives an update — that is
  // the point of updating in place — but publishing does not mint a new one unless asked.
  if (existing?.publicToken) meta.publicToken = existing.publicToken;
  else if (input.makePublic === true) meta.publicToken = mintPublicToken();

  // Check before writing: KV rejects an oversized metadata write, and that failure would
  // surface as a document missing from every listing rather than as a bad request.
  if (!metadataFits(meta)) {
    throw new BadRequest("metadata_too_large", "Title, summary and tags are too long to index");
  }

  await putDoc(env, meta, source);
  if (meta.publicToken && !existing?.publicToken) {
    await putPublicToken(env, meta.publicToken, meta.id);
  }

  return { meta, created: existing === null, portal };
}

/**
 * Where does this document live, publicly?
 *
 * A document in a **public** portal is served from `/pub/*`, which has no Access
 * application in front of it. A document anywhere else is served from `/v/*`, which does.
 *
 * This is not cosmetic. Handing someone a `/v/` link to a public page walks them into a
 * Cloudflare Access login wall and — if they complete it — permanently consumes one of the
 * 50 free seats. Every URL we generate has to get this right, so it is computed in one
 * place. See ADR-001 and ADR-002.
 */
export const documentPath = (portal: Portal, id: string): string =>
  portal.kind === "public"
    ? `/pub/${encodeURIComponent(portal.slug)}/${encodeURIComponent(id)}`
    : `/v/${encodeURIComponent(portal.slug)}/${encodeURIComponent(id)}`;

export const portalPath = (portal: Portal): string =>
  portal.kind === "public"
    ? `/pub/${encodeURIComponent(portal.slug)}`
    : `/v/${encodeURIComponent(portal.slug)}`;

/** Case-insensitive: "Q3 Review" and "q3 review" are the same deliverable. */
async function findByTitle(env: Env, portal: string, title: string): Promise<DocMeta | null> {
  const wanted = title.trim().toLowerCase();
  const match = (await listDocs(env, portal)).find((d) => d.title.trim().toLowerCase() === wanted);
  return match ? getMeta(env, match.id) : null;
}

/**
 * Which portal does this document go in?
 *
 * The ladder exists so the word "portal" never appears in the quickstart (ADR-005):
 *
 *   1. Named explicitly → use it.
 *   2. No portals at all → create `default`.
 *   3. Exactly one portal → use it. You cannot misfile with one portal, so asking would
 *      be a concept tax with only one possible answer.
 *   4. `default` exists → use it.
 *   5. Otherwise → **error and list them. Never guess.**
 *
 * Step 5 matters most for the MCP server. Inferring "this is probably the RealPlus one"
 * from conversational context is exactly the failure that files Client A's report into
 * Client B's portal.
 */
export async function resolvePortal(env: Env, requested: string | undefined): Promise<Portal> {
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
    `Multiple portals exist and no default is set. Ask the user which one, then pass it explicitly. Available: ${portals
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

// ---------------------------------------------------------------------------
// Read side — the differentiator
// ---------------------------------------------------------------------------

/** A 200KB report will eat a context window. Truncate, and say that you did. */
export const MAX_READ_BYTES = 100 * 1024;

export interface ReadResult {
  meta: DocMeta;
  source: string;
  truncated: boolean;
}

export async function readDocument(env: Env, id: string): Promise<ReadResult | null> {
  const meta = await getMeta(env, id);
  if (!meta) return null;

  const source = await getDoc(env, id);
  if (source === null) return null;

  const truncated = source.length > MAX_READ_BYTES;
  return { meta, source: truncated ? source.slice(0, MAX_READ_BYTES) : source, truncated };
}

export interface SearchHit {
  doc: DocSummary;
  /** Where the query matched, so the model can tell the user why this came back. */
  matched: ("title" | "summary" | "tag" | "body")[];
}

/**
 * Substring search across a portal.
 *
 * Deliberately dumb. The corpus is fourteen documents over nine months, not fourteen
 * thousand — an index, an embedding store, or a full-text engine would all be more
 * machinery than the problem has. Metadata is matched from the listing (zero reads); the
 * body is only read for documents that did not already match, and only up to a cap.
 */
export async function searchPortal(
  env: Env,
  portal: string,
  query: string,
  limit = 10,
): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase();
  if (!q) throw new BadRequest("invalid_field", `"query" cannot be blank`);

  const docs = await listDocs(env, portal);
  const hits: SearchHit[] = [];

  for (const doc of docs) {
    const matched: SearchHit["matched"] = [];

    if (doc.title.toLowerCase().includes(q)) matched.push("title");
    if (doc.summary?.toLowerCase().includes(q)) matched.push("summary");
    if (doc.tags?.some((tag) => tag.toLowerCase().includes(q))) matched.push("tag");

    if (matched.length === 0) {
      const source = await getDoc(env, doc.id);
      if (source?.toLowerCase().includes(q)) matched.push("body");
    }

    if (matched.length > 0) hits.push({ doc, matched });
    if (hits.length >= limit) break;
  }

  return hits;
}

export interface MemberUpdate {
  /** The portal's membership after the change. */
  members: string[];
  /** Emails that were not already members (the ones synced to the Access group). */
  added: string[];
  /** Emails that were members and are now removed. */
  removed: string[];
  /** Whether the added emails reached the Access group. */
  sync: GroupSyncResult;
}

/**
 * Add and/or remove portal members, and admit the added ones to the Access group.
 *
 * The single place membership changes: both the MCP `update_portal_members` tool and the
 * console's `/api` endpoint call this, so the group sync (#20) cannot be forgotten on one
 * path and present on the other. Removal is deliberately not synced — the hot path is
 * additive; freeing a seat is the reconciler's job (ADR-002).
 */
export async function updatePortalMembers(
  env: Env,
  slug: string,
  add: string[],
  remove: string[],
): Promise<MemberUpdate> {
  const current = await getMembers(env, slug);
  const addNorm = add.map(normalizeEmail).filter(Boolean);
  const removeSet = new Set(remove.map(normalizeEmail).filter(Boolean));

  const next = [...new Set([...current, ...addNorm])].filter((email) => !removeSet.has(email));
  await putMembers(env, slug, next);

  const added = addNorm.filter((email) => !current.includes(email));
  const removed = current.filter((email) => removeSet.has(email));
  const sync = added.length > 0 ? await syncGroupMembers(env, added) : { status: "noop" as const };

  return { members: next, added, removed, sync };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Every document carries the owner. `canView` grants the owner first, so a blank
 * OWNER_EMAIL means a private document nobody can open. Fail at publish, where the error
 * can say why.
 */
export function requireOwner(env: Env): string {
  const owner = normalizeEmail(env.OWNER_EMAIL ?? "");
  if (!owner) {
    throw new Misconfigured("owner_not_configured", "OWNER_EMAIL is not set on this deployment");
  }
  return owner;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BadRequest("invalid_field", `"${field}" is required and must be a non-empty string`);
  }
  return value;
}

export function parseTitle(value: unknown): string {
  const title = requireString(value, "title").trim();
  if (title.length === 0) throw new BadRequest("invalid_field", `"title" cannot be blank`);
  if (title.length > MAX_TITLE_CHARS) {
    throw new BadRequest("invalid_field", `"title" exceeds ${MAX_TITLE_CHARS} characters`);
  }
  return title;
}

export function parseSummary(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const summary = requireString(value, "summary").trim();
  if (summary.length > MAX_SUMMARY_CHARS) {
    throw new BadRequest("invalid_field", `"summary" exceeds ${MAX_SUMMARY_CHARS} characters`);
  }
  return summary || undefined;
}

export function parseSourceKind(value: unknown): SourceKind {
  if (value === undefined) return "html";
  if (value !== "html" && value !== "markdown") {
    throw new BadRequest("invalid_field", `"sourceKind" must be "html" or "markdown"`);
  }
  return value;
}

export function parseTags(value: unknown): string[] | undefined {
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

export function parseEmails(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new BadRequest("invalid_field", `"${field}" must be an array`);
  if (value.length > MAX_EMAILS) {
    throw new BadRequest("invalid_field", `"${field}" exceeds ${MAX_EMAILS} entries`);
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

  return emails.length > 0 ? [...new Set(emails)] : undefined;
}

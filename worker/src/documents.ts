import { type GroupSyncResult, syncGroupMembers } from "./access-group.js";
import type { Env } from "./env.js";
import { renderMarkdown } from "./markdown.js";
import {
  DEFAULT_PORTAL,
  type DocMeta,
  type DocSummary,
  type Portal,
  type SourceKind,
  deletePublicToken,
  getDoc,
  getMembers,
  getMeta,
  getPortal,
  getRawSource,
  isValidSlug,
  listDocs,
  listPortals,
  metadataFits,
  mintId,
  mintPublicToken,
  normalizeEmail,
  putDoc,
  putMembers,
  putMeta,
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
  /**
   * Present when this publish granted new `extraEmails`: the outcome of admitting them to
   * the Access group. A grant that lands in KV while Access still blocks the person is the
   * silent half-success ADR-002 forbids, so callers surface this. Absent when no email was
   * newly granted. See #27.
   */
  sync?: GroupSyncResult;
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

  const sourceKind: SourceKind = input.sourceKind ?? "html";

  const now = new Date().toISOString();
  const meta: DocMeta = {
    id: existing?.id ?? mintId(),
    portal: portal.slug,
    title,
    sourceKind,
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

  // Publish-time markdown→HTML (#46). The render path never loads `sourceKind`, so the
  // body stored under `doc:` must already be presentable HTML. The original `.md` rides
  // along to `raw:` so the raw download and `read_document` still read back the source
  // the author wrote. HTML documents are stored verbatim, with no `raw:` companion.
  const storedBody = sourceKind === "markdown" ? renderMarkdown(source) : source;
  await putDoc(env, meta, storedBody, sourceKind === "markdown" ? source : undefined);
  if (meta.publicToken && !existing?.publicToken) {
    await putPublicToken(env, meta.publicToken, meta.id);
  }

  // #27: a per-document email grant is useless until Access will admit the person — the
  // grant lands in KV here, but Cloudflare Access stops them at the door until they are in
  // the viewer group. Admit the newly-granted addresses, the same way member-add does.
  // Removal is not synced (the seat is the reconciler's job, ADR-002); a publish can only
  // add extraEmails, never subtract, so there is nothing to unsync.
  const priorEmails = existing?.extraEmails ?? [];
  const addedEmails = (meta.extraEmails ?? []).filter((email) => !priorEmails.includes(email));
  const result: PublishResult = { meta, created: existing === null, portal };
  if (addedEmails.length > 0) result.sync = await syncGroupMembers(env, addedEmails);
  return result;
}

export interface DocPatch {
  /** The draft toggle. `true` hides the document from everyone but the owner. */
  ownerOnly?: boolean | undefined;
  /** `true` mints a public capability link (if absent); `false` revokes it. */
  makePublic?: boolean | undefined;
  /** Per-document email grants to add / remove (extraEmails). */
  addEmails?: string[] | undefined;
  removeEmails?: string[] | undefined;
}

export interface DocPatchResult {
  meta: DocMeta;
  /** Present when the patch admitted newly-granted emails to the Access group. */
  sync?: GroupSyncResult;
}

/**
 * Apply the console's per-document controls in one write: the draft toggle, public-link
 * mint/revoke, and per-document email grants. The one service path `/api` PATCH calls, so
 * the group sync (below) cannot be present on one mutation path and forgotten on another.
 *
 * Returns `null` when the document does not exist, so the caller answers 404 rather than
 * this throwing a BadRequest that would surface as a 400.
 *
 * Group sync mirrors publish and member-add: newly granted emails are admitted to the
 * viewer group; a removed grant narrows `canView()` immediately but the seat is NOT freed
 * here — the same address may still be granted by another document or a portal team, so
 * reclaiming the seat is the reconciler's job. ADR-002.
 */
export async function patchDocument(env: Env, id: string, patch: DocPatch): Promise<DocPatchResult | null> {
  const meta = await getMeta(env, id);
  if (!meta) return null;

  const next: DocMeta = { ...meta };

  if (patch.ownerOnly !== undefined) next.ownerOnly = patch.ownerOnly;

  // Public-link mint/revoke — resolve the token state on the object BEFORE any KV write, so
  // the budget check sees the final shape and a would-be-oversized write leaves no dangling
  // pub: key. Mint mirrors mint_public_link; revoke removes only the link, never the doc.
  let mintedToken: string | null = null;
  let revokedToken: string | null = null;
  if (patch.makePublic === true && !next.publicToken) {
    mintedToken = mintPublicToken();
    next.publicToken = mintedToken;
  } else if (patch.makePublic === false && next.publicToken) {
    revokedToken = next.publicToken;
    delete next.publicToken;
  }

  // Per-document email grants. Additive add (synced), immediate remove (not synced).
  const current = meta.extraEmails ?? [];
  const addNorm = (patch.addEmails ?? []).map(normalizeEmail).filter(Boolean);
  const removeSet = new Set((patch.removeEmails ?? []).map(normalizeEmail).filter(Boolean));
  const added = addNorm.filter((email) => !current.includes(email) && !removeSet.has(email));
  if (addNorm.length > 0 || removeSet.size > 0) {
    const nextEmails = [...new Set([...current, ...addNorm])].filter((email) => !removeSet.has(email));
    if (nextEmails.length > MAX_EMAILS) {
      throw new BadRequest("invalid_field", `A document can be shared with at most ${MAX_EMAILS} people`);
    }
    if (nextEmails.length > 0) next.extraEmails = nextEmails;
    else delete next.extraEmails;
  }

  next.updatedAt = new Date().toISOString();
  if (!metadataFits(next)) {
    throw new BadRequest("metadata_too_large", "Title, summary and tags are too long to index");
  }

  if (mintedToken) await putPublicToken(env, mintedToken, next.id);
  if (revokedToken) await deletePublicToken(env, revokedToken);
  await putMeta(env, next);

  const result: DocPatchResult = { meta: next };
  if (added.length > 0) result.sync = await syncGroupMembers(env, added);
  return result;
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

  // The collection reads back as what the author wrote. For markdown that is the original
  // `.md`, not the HTML we rendered for the browser — markdown is what an LLM six months
  // later actually wants. `?? getDoc` covers HTML docs and any pre-#46 markdown.
  const source =
    meta.sourceKind === "markdown" ? ((await getRawSource(env, id)) ?? (await getDoc(env, id))) : await getDoc(env, id);
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

  // AND-of-terms, not phrase-contiguous (#19). "bearer token loop" must match a document that
  // contains all three words anywhere, in any order — not only one holding that exact substring.
  // Split on whitespace and require EVERY term to appear somewhere in the searchable text. Still
  // zero-machinery: substring matching, whitespace split, no index, no tokenizer (directive #2).
  // This is keyword search, not semantic — the tool description sets that promise honestly.
  const terms = q.split(/\s+/).filter(Boolean);
  const docs = await listDocs(env, portal);
  const hits: SearchHit[] = [];

  for (const doc of docs) {
    const fields = new Set<SearchHit["matched"][number]>();
    const title = doc.title.toLowerCase();
    const summary = doc.summary?.toLowerCase() ?? "";
    const tags = doc.tags?.join(" ").toLowerCase() ?? "";

    // Which terms does the metadata already satisfy? Track where each was found.
    const unmet = terms.filter((term) => {
      let found = false;
      if (title.includes(term)) (fields.add("title"), (found = true));
      if (summary.includes(term)) (fields.add("summary"), (found = true));
      if (tags.includes(term)) (fields.add("tag"), (found = true));
      return !found;
    });

    // Read the body ONLY when metadata alone didn't cover every term — at most one body read per
    // doc, and none when metadata already matches, so the KV read budget is unchanged from before.
    if (unmet.length > 0) {
      // Search the authored source for markdown, not the rendered HTML — a query for "summary"
      // should match prose, not stumble over generated tag soup.
      const source =
        doc.sourceKind === "markdown"
          ? ((await getRawSource(env, doc.id)) ?? (await getDoc(env, doc.id)))
          : await getDoc(env, doc.id);
      const body = source?.toLowerCase() ?? "";
      if (unmet.every((term) => body.includes(term))) fields.add("body");
      else continue; // a term appears in neither metadata nor body → not a hit
    }

    hits.push({ doc, matched: [...fields] });
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

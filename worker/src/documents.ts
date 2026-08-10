import {
  type GroupSyncResult,
  type ReconcileResult,
  reconcileGroupMembers,
  syncGroupMembers,
} from "./access-group.js";
import { accessEnabled, type Env } from "./env.js";
import { renderMarkdown } from "./markdown.js";
import {
  DEFAULT_PORTAL,
  type DocMeta,
  type DocSummary,
  type Portal,
  type SourceKind,
  deleteDocKeys,
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
  docId,
  defaultDocName,
  mintPublicToken,
  normalizeEmail,
  normalizeName,
  putDoc,
  putMembers,
  repinRenamed,
  putMeta,
  putMoved,
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
export const MAX_NAME_CHARS = 200;
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
 * Publishing over an existing `(portal, filename)` refuses unless the caller explicitly says
 * `confirm: true`, and the refusal carries enough detail for a human to decide. The model
 * has to come back and ask.
 */
export class Conflict extends Error {
  constructor(
    readonly existing: DocMeta,
    readonly incomingBytes: number,
  ) {
    super(`A document named "${existing.name}" already exists in portal "${existing.portal}"`);
  }

  /** What the model should show the user before it asks. */
  summary(): string {
    const delta = this.incomingBytes - this.existing.bytes;
    const sign = delta >= 0 ? "+" : "";
    return [
      `A document named "${this.existing.name}" already exists in portal "${this.existing.portal}".`,
      ``,
      `  id:       ${this.existing.id}`,
      `  title:    ${this.existing.title}`,
      `  updated:  ${this.existing.updatedAt}`,
      `  size:     ${this.existing.bytes} bytes → ${this.incomingBytes} bytes (${sign}${delta})`,
      ``,
      `Re-publishing with the same filename REPLACES it in place, keeping the same URL — so anyone`,
      `holding the link sees the new version. The old content is not recoverable.`,
      ``,
      `Ask the user. To replace it, call publish_document again with confirm: true. To keep both,`,
      `publish under a different filename.`,
    ].join("\n");
  }
}

/**
 * The requested filename is already another document's identity in this portal.
 *
 * Distinct from `Conflict`, which publish throws and `confirm: true` overrides. There is no
 * override here on purpose: a rename is a correction, and completing one by destroying a
 * different client deliverable is never what was meant. Replacing a document is `publish`
 * with `confirm`, an operation that says so out loud.
 */
export class NameTaken extends Error {
  constructor(readonly existing: DocMeta) {
    super(`Portal "${existing.portal}" already has a document named "${existing.name}"`);
  }
}

export interface PublishInput {
  title: string;
  /**
   * The document's filename — the IDENTITY key within the portal (ADR-017). Optional: when
   * omitted (the MCP-without-a-file case) it defaults to a slug of the title plus the source
   * extension, so a caller that only passes a title still gets a stable, deterministic id.
   */
  filename?: string | undefined;
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
  const sourceKind: SourceKind = input.sourceKind ?? "html";
  // Identity is the FILENAME (ADR-017), not the title: the CLI passes the file's basename, MCP
  // the `filename` param, and a caller with neither falls back to a slug of the title plus the
  // source extension. Two files with the same heading but different names are different docs.
  const name = parseFilename(input.filename) ?? deriveDefaultFilename(title, sourceKind);

  // Create-or-update, keyed on (portal, name) via a DETERMINISTIC id (ADR-013 mechanism, ADR-017
  // key): the id hashes (portal, normalized filename), so re-publishing the same filename
  // overwrites the same keys in place — the link stays current — and a duplicate is
  // unrepresentable, not merely rejected. No `list()`, so none of KV's eventual-consistency race
  // (#74). The `getMeta` is only the confirm guard; even a stale read overwrites in place.
  const id = await docId(portal.slug, name);
  const existing = await getMeta(env, id);
  if (existing && input.confirm !== true) throw new Conflict(existing, bytes);

  const now = new Date().toISOString();
  const meta: DocMeta = {
    id,
    portal: portal.slug,
    name,
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

  // On a no-Access deployment (rung 1: workers.dev, no Zero Trust) there is no login wall and
  // no way to identify a viewer, so a members-only `/v/` document is un-openable — the only
  // meaningful published states are "public link" or "owner-only draft". A plain publish there
  // is public by nature, so default it to public rather than hand back a dead link (#111, PD-3).
  // This is NOT the widening the note below guards against: on rung 1 there is no narrower
  // openable state to widen FROM, and the `/p/` link is the whole point of the tier.
  const defaultPublic = !accessEnabled(env) && meta.ownerOnly !== true;

  // Widening is never a side effect. An existing public link survives an update — that is
  // the point of updating in place — but publishing does not mint a new one unless asked.
  if (existing?.publicToken) meta.publicToken = existing.publicToken;
  else if (input.makePublic === true || defaultPublic) meta.publicToken = mintPublicToken();

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

export interface DocEdit {
  /**
   * The filename — the document's IDENTITY (ADR-017). Changing it MOVES the document to a new
   * id, and therefore to a new `/v/` or `/pub/` URL. Case-only changes (`Report.md` →
   * `report.md`) normalize to the same identity and move nothing.
   */
  name?: string | undefined;
  /** Display only. Editing it never moves the document. */
  title?: string | undefined;
  /** `""` clears it. */
  summary?: string | undefined;
  /** `[]` clears them. */
  tags?: string[] | undefined;
}

export interface DocEditResult {
  meta: DocMeta;
  /**
   * The id this document had before, present only when a filename change actually moved it.
   * Callers surface it: the URL changed, and saying so is the difference between a rename the
   * operator understands and a link that mysteriously stopped being canonical.
   */
  movedFrom?: string;
}

/**
 * Edit a published document's identity and display metadata — the one service the console,
 * `/api`, the CLI and MCP all call.
 *
 * ⭐ Two operations wear one word here, and the difference is the whole design:
 *
 * - **Retitling** (or editing summary/tags, or changing only the CASE of the filename) is a
 *   single metadata write. Same id, same URL, nothing moves.
 * - **Renaming the file** moves the document, because the id hashes the filename (ADR-013's
 *   mechanism, ADR-017's key). There is no way to keep the URL and change the filename; the
 *   alternative — an id decoupled from the name — needs a `filename → id` lookup at publish
 *   time, which is the #74 fork race ADR-013 exists to kill.
 *
 * So a rename leaves a forwarding address instead. `moved:{oldId}` → newId keeps every link
 * anyone already holds alive, and the `/p/` capability link survives untouched because its
 * token was never a function of the id.
 *
 * Returns `null` when the document does not exist, so the caller answers 404 rather than this
 * throwing a BadRequest that would surface as a 400.
 */
export async function editDocument(env: Env, id: string, edit: DocEdit): Promise<DocEditResult | null> {
  const meta = await getMeta(env, id);
  if (!meta) return null;

  const next: DocMeta = { ...meta };

  if (edit.title !== undefined) next.title = parseTitle(edit.title);

  // `""` and `[]` mean "clear this", which is why they are checked before the parsers — both
  // treat an empty value as "absent" and would otherwise make a field unclearable.
  if (edit.summary !== undefined) {
    const summary = parseSummary(edit.summary === "" ? undefined : edit.summary);
    if (summary) next.summary = summary;
    else delete next.summary;
  }
  if (edit.tags !== undefined) {
    const tags = parseTags(edit.tags);
    if (tags?.length) next.tags = tags;
    else delete next.tags;
  }

  if (edit.name !== undefined) {
    const name = parseFilename(edit.name);
    if (!name) throw new BadRequest("invalid_field", `"name" cannot be blank — it is the document's identity`);
    next.name = name;
  }

  next.updatedAt = new Date().toISOString();
  if (!metadataFits(next)) {
    throw new BadRequest("metadata_too_large", "Title, summary and tags are too long to index");
  }

  // Identity is case-insensitive, so compare NORMALIZED names: this is what decides whether we
  // write one key or move a document. A pre-ADR-017 document (random id, backfilled `name`)
  // therefore keeps its id on a title edit and only adopts a deterministic one if actually
  // renamed — a title edit must never silently re-key a document.
  if (normalizeName(next.name) === normalizeName(meta.name)) {
    await putMeta(env, next);
    return { meta: next };
  }

  const newId = await docId(meta.portal, next.name);
  // Belt-and-braces: a 60-bit hash landing back on the same id is not going to happen, but if
  // it did, the move below would delete the document it had just written.
  if (newId === id) {
    await putMeta(env, next);
    return { meta: next };
  }

  const clash = await getMeta(env, newId);
  if (clash) throw new NameTaken(clash);

  const body = await getDoc(env, id);
  if (body === null) {
    // The metadata outlived its body — a torn write or a half-finished delete. Refuse rather
    // than "move" a document into an empty one; there is nothing here to carry across.
    throw new BadRequest("not_found", `No stored body for document: ${id}`);
  }
  const raw = await getRawSource(env, id);

  next.id = newId;

  // Ordering, as everywhere else in this file: write the whole new document BEFORE touching
  // the old one, so a crash anywhere in here leaves both readable — never neither. The public
  // token is repointed before the old keys go, so the /p/ link is on a live document
  // throughout. The tombstone is last before the delete, for the same reason.
  await putDoc(env, next, body, raw ?? undefined);
  if (next.publicToken) await putPublicToken(env, next.publicToken, newId);
  await putMoved(env, id, newId);
  await deleteDocKeys(env, meta);

  // 🔴 Carry the pin across the rename (#142). Pins name FILENAMES (ADR-017), so a rename that
  // did not patch the list would drop the document out of the pinned block — silently, because
  // `partitionPinned` skips an unknown name by design, and that skip is what makes a *deletion*
  // self-healing. Correcting a typo would quietly unpin the thing you had chosen to feature.
  //
  // Last, and non-fatal by placement rather than by a catch: the document has already moved
  // correctly at this point, and a failure to re-pin must not turn a completed rename into an
  // error the caller reports as a failed one. Costs one write on top of a rename's 9–11.
  const portal = await getPortal(env, meta.portal);
  const repinned = repinRenamed(portal?.pinned, meta.name, next.name);
  if (portal && repinned) await putPortal(env, { ...portal, pinned: repinned, updatedAt: next.updatedAt });

  return { meta: next, movedFrom: id };
}

export interface DocPatch {
  /** The draft toggle. `true` hides the document from everyone but the owner. */
  ownerOnly?: boolean | undefined;
  /** `true` mints a public capability link (if absent); `false` revokes it. */
  makePublic?: boolean | undefined;
  /**
   * `true` replaces the public link with a fresh one in a single write: the old token is
   * deleted and a new one minted, whether or not a link already existed. One atomic PATCH,
   * never a revoke-then-mint pair — two sequential PATCHes race KV's eventual consistency
   * (the second can read the pre-revoke meta at another edge and mint nothing).
   */
  rotatePublic?: boolean | undefined;
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
  if (patch.rotatePublic === true) {
    // Replace: drop whatever token exists (if any) and always mint a fresh one, in this one
    // write. This is why rotate is a single field, not a false-then-true pair from the client.
    if (next.publicToken) revokedToken = next.publicToken;
    mintedToken = mintPublicToken();
    next.publicToken = mintedToken;
  } else if (patch.makePublic === true && !next.publicToken) {
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

/**
 * The set of emails that SHOULD have Access, computed from KV alone (#85). This is the truth the
 * viewer group is reconciled against: portal members (every portal), per-document `extraEmails`,
 * and the owner.
 *
 * `extraEmails` is off the document listing (see `DocSummary`) to keep key metadata under KV's
 * 1KB cap, so this reads a `meta:` key per document. That is N reads — fine for an occasional
 * reconcile, never a hot path — exactly the cost `DocSummary`'s comment anticipates.
 */
export async function computeDesiredViewers(env: Env): Promise<string[]> {
  const emails = new Set<string>([normalizeEmail(env.OWNER_EMAIL ?? "")]);

  for (const portal of await listPortals(env)) {
    for (const email of await getMembers(env, portal.slug)) emails.add(normalizeEmail(email));
  }
  for (const doc of await listDocs(env)) {
    const meta = await getMeta(env, doc.id);
    for (const email of meta?.extraEmails ?? []) emails.add(normalizeEmail(email));
  }

  return [...emails].filter(Boolean);
}

/**
 * Reconcile the Access viewer group to match KV (#85). Gathers the desired set and rebuilds the
 * group; with `reap`, prunes members KV no longer authorizes, reclaiming seats (ADR-002).
 */
export async function reconcileAccessGroup(env: Env, reap: boolean): Promise<ReconcileResult> {
  return reconcileGroupMembers(env, await computeDesiredViewers(env), reap);
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

/**
 * The document's filename — its identity key (ADR-017). Strips any directory, trims, and
 * bounds the length. Returns `undefined` when absent or blank, so `publishDocument` can fall
 * back to a title-derived default. Case is preserved for display; `docId` lowercases for the
 * hash, so `README.md` and `readme.md` are the same document.
 */
export function parseFilename(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  // Basename only — identity is the filename, never the path it happened to live at.
  const name = requireString(value, "filename").trim().split(/[/\\]/).pop()?.trim() ?? "";
  if (name.length === 0) return undefined;
  if (name.length > MAX_NAME_CHARS) {
    throw new BadRequest("invalid_field", `"filename" exceeds ${MAX_NAME_CHARS} characters`);
  }
  return name;
}

/**
 * The fallback filename when a caller gives none (MCP with no file on disk): a slug of the
 * title plus the source extension. Deterministic, so an assistant that only ever passes a
 * title still updates the same document in place on re-publish — today's behavior, preserved.
 */
export function deriveDefaultFilename(title: string, sourceKind: SourceKind): string {
  return defaultDocName(title, sourceKind);
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

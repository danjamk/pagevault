import type { Env } from "./env.js";

export type PortalKind = "private" | "restricted" | "public";

/** `markdown` is stored but not rendered yet — the renderer is a later layer. */
export type SourceKind = "html" | "markdown";

export interface Portal {
  slug: string;
  name: string;
  kind: PortalKind;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocMeta {
  id: string;
  /** Always set. Defaults to `default`. A document is never portal-less. */
  portal: string;
  title: string;
  /** One line, shown in the portal index. */
  summary?: string;
  sourceKind: SourceKind;
  /**
   * A draft the client cannot see. The ONLY narrowing rule, and it beats every
   * grant — see `canView` in access.ts.
   */
  ownerOnly: boolean;
  /**
   * ADDITIVE grant on this document only. Never subtractive: it can add a viewer,
   * it can never revoke one the portal already permits.
   *
   * This is what keeps the simple case working — `publish report.html --emails
   * cfo@acme.com` — without inventing a portal for two people.
   */
  extraEmails?: string[];
  /** Explicit widening. Served on a separate route that never consults canView. */
  publicToken?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  bytes: number;
}

/**
 * What `list()` hands back inline, with no extra reads.
 *
 * `extraEmails` is deliberately absent: KV caps key metadata at 1024 bytes and an
 * allowlist can blow it — which would break listing for exactly the documents with
 * the most sharing. The union needed for the Access group (ADR-002) is recomputed by
 * reading `meta:` keys during reconcile, never on a hot path.
 */
export interface DocSummary {
  id: string;
  portal: string;
  title: string;
  summary?: string;
  ownerOnly: boolean;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  bytes: number;
}

type DocKeyMetadata = Omit<DocSummary, "id">;
type PortalKeyMetadata = Omit<Portal, "slug">;

/** KV's hard cap on key metadata. Exceeding it fails the write outright. */
const MAX_KEY_METADATA_BYTES = 1024;

// Prefixes are deliberately disjoint. `portal:{slug}:members` would collide with
// list({prefix: "portal:"}) — it would come back as if it were a portal — so members
// and the portal index get their own namespaces rather than nesting under portal:.
const portalKey = (slug: string) => `portal:${slug}`;
const membersKey = (slug: string) => `members:${slug}`;
const indexKey = (slug: string, id: string) => `idx:${slug}:${id}`;
const docKey = (id: string) => `doc:${id}`;
const metaKey = (id: string) => `meta:${id}`;
const pubKey = (token: string) => `pub:${token}`;

export const DEFAULT_PORTAL = "default";

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/**
 * Anything that could shadow a route. Validated in ONE place — a slug that shadows
 * a route is a routing bug that looks like a permissions bug.
 */
const RESERVED_SLUGS = new Set([
  "api",
  "mcp",
  "admin",
  "render",
  "p",
  "pub",
  "v",
  "static",
  "assets",
  "favicon.ico",
  "robots.txt",
  "well-known",
]);

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);
}

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------

/**
 * Normalize at every boundary. A case-mismatched email silently failing an allowlist
 * check is a confidentiality bug that looks like a UI bug.
 */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

// ---------------------------------------------------------------------------
// Ids and tokens
// ---------------------------------------------------------------------------

/** Unambiguous alphabet — no 0/O, no 1/l/I. These get read aloud and typed by hand. */
const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

function randomString(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  // ALPHABET.length is 32, so a byte maps onto it with no modulo bias.
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/** 12 chars over a 32-char alphabet — 60 bits. */
export const mintId = () => randomString(12);

/**
 * 22 chars — 110 bits. A capability URL is the only thing protecting a public
 * document, so it gets more entropy than an id does.
 */
export const mintPublicToken = () => randomString(22);

// ---------------------------------------------------------------------------
// Portals
// ---------------------------------------------------------------------------

export const getPortal = (env: Env, slug: string): Promise<Portal | null> =>
  env.PAGEVAULT.get<Portal>(portalKey(slug), "json");

export async function putPortal(env: Env, portal: Portal): Promise<void> {
  const metadata: PortalKeyMetadata = {
    name: portal.name,
    kind: portal.kind,
    createdAt: portal.createdAt,
    updatedAt: portal.updatedAt,
  };
  if (portal.description) metadata.description = portal.description;

  await env.PAGEVAULT.put(portalKey(portal.slug), JSON.stringify(portal), { metadata });
}

/** Every portal, from one `list()`. Metadata comes back inline — no read per portal. */
export async function listPortals(env: Env): Promise<Portal[]> {
  const portals: Portal[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = await env.PAGEVAULT.list<PortalKeyMetadata>(
      cursor ? { prefix: "portal:", cursor } : { prefix: "portal:" },
    );
    for (const key of page.keys) {
      if (!key.metadata) continue;
      portals.push({ slug: key.name.slice("portal:".length), ...key.metadata });
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }

  return portals;
}

/**
 * Delete a portal. Callers must refuse to do this on a non-empty portal without an
 * explicit cascade — deleting a portal deletes a client's entire history.
 */
export async function deletePortal(env: Env, slug: string): Promise<void> {
  await env.PAGEVAULT.delete(membersKey(slug));
  await env.PAGEVAULT.delete(portalKey(slug));
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export async function getMembers(env: Env, slug: string): Promise<string[]> {
  const members = await env.PAGEVAULT.get<string[]>(membersKey(slug), "json");
  return members ?? [];
}

/**
 * Replace a portal's membership.
 *
 * ⭐ This is the payoff of the whole data model: one write adds a person to every
 * document a client has ever received.
 */
export async function putMembers(env: Env, slug: string, emails: string[]): Promise<void> {
  const normalized = [...new Set(emails.map(normalizeEmail))].filter(Boolean);
  await env.PAGEVAULT.put(membersKey(slug), JSON.stringify(normalized));
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function toDocKeyMetadata(meta: DocMeta): DocKeyMetadata {
  const km: DocKeyMetadata = {
    portal: meta.portal,
    title: meta.title,
    ownerOnly: meta.ownerOnly,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    bytes: meta.bytes,
  };
  if (meta.summary) km.summary = meta.summary;
  if (meta.tags?.length) km.tags = meta.tags;
  return km;
}

/**
 * Bytes the metadata will occupy in KV. Callers check this BEFORE writing: KV rejects
 * an oversized metadata write, and that failure would surface as a document missing
 * from every listing rather than as a bad request.
 */
export const keyMetadataBytes = (meta: DocMeta): number =>
  new TextEncoder().encode(JSON.stringify(toDocKeyMetadata(meta))).byteLength;

export const metadataFits = (meta: DocMeta): boolean =>
  keyMetadataBytes(meta) <= MAX_KEY_METADATA_BYTES;

/**
 * Write the body, then the metadata, then the index.
 *
 * KV has no transactions, so ordering is the only safety we get. Metadata is written
 * after the body and the index after the metadata: a crash partway through leaves a
 * document that is simply not published, rather than an index entry pointing at
 * nothing.
 */
export async function putDoc(env: Env, meta: DocMeta, source: string): Promise<void> {
  await env.PAGEVAULT.put(docKey(meta.id), source);
  await putMeta(env, meta);
  await env.PAGEVAULT.put(indexKey(meta.portal, meta.id), "");
}

export async function putMeta(env: Env, meta: DocMeta): Promise<void> {
  await env.PAGEVAULT.put(metaKey(meta.id), JSON.stringify(meta), {
    metadata: toDocKeyMetadata(meta),
  });
}

export const getDoc = (env: Env, id: string): Promise<string | null> =>
  env.PAGEVAULT.get(docKey(id));

export const getMeta = (env: Env, id: string): Promise<DocMeta | null> =>
  env.PAGEVAULT.get<DocMeta>(metaKey(id), "json");

/**
 * Every document, from a single `list()`.
 *
 * This is the entire reason metadata lives on the key. Reading `meta:{id}` per key
 * would be an N+1 that works perfectly in tests and quietly eats the 100k/day read
 * quota in production. `list()` is metered separately (1000/day), so this costs one
 * list operation regardless of how many documents come back.
 */
export async function listDocs(env: Env, portal?: string): Promise<DocSummary[]> {
  const docs: DocSummary[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = await env.PAGEVAULT.list<DocKeyMetadata>(
      cursor ? { prefix: "meta:", cursor } : { prefix: "meta:" },
    );

    for (const key of page.keys) {
      // A key with no metadata is a partial write. Skip it rather than issuing a read
      // and reintroducing the N+1 this whole design exists to avoid.
      if (!key.metadata) continue;
      if (portal && key.metadata.portal !== portal) continue;
      docs.push({ id: key.name.slice("meta:".length), ...key.metadata });
    }

    if (page.list_complete) break;
    cursor = page.cursor;
  }

  return docs;
}

/** Document ids in a portal, from the index. Existence is membership — no RMW race. */
export async function listPortalDocIds(env: Env, slug: string): Promise<string[]> {
  const prefix = `idx:${slug}:`;
  const ids: string[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = await env.PAGEVAULT.list(cursor ? { prefix, cursor } : { prefix });
    for (const key of page.keys) ids.push(key.name.slice(prefix.length));
    if (page.list_complete) break;
    cursor = page.cursor;
  }

  return ids;
}

// ---------------------------------------------------------------------------
// Public tokens
// ---------------------------------------------------------------------------

export const getPublicTokenTarget = (env: Env, token: string): Promise<string | null> =>
  env.PAGEVAULT.get(pubKey(token));

export const putPublicToken = (env: Env, token: string, id: string): Promise<void> =>
  env.PAGEVAULT.put(pubKey(token), id);

export const deletePublicToken = (env: Env, token: string): Promise<void> =>
  env.PAGEVAULT.delete(pubKey(token));

/**
 * Delete a document and everything pointing at it.
 *
 * The `pub:` key goes first. A crash partway through then leaves a document nobody
 * can reach by its public link — rather than a live public link pointing at a
 * document that no longer exists, or at an id later reissued to something else.
 */
export async function deleteDoc(env: Env, meta: DocMeta): Promise<void> {
  if (meta.publicToken) await deletePublicToken(env, meta.publicToken);
  await env.PAGEVAULT.delete(indexKey(meta.portal, meta.id));
  await env.PAGEVAULT.delete(metaKey(meta.id));
  await env.PAGEVAULT.delete(docKey(meta.id));
}
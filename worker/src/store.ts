import type { Env } from "./env.js";

export type Visibility = "private" | "restricted" | "public";

export interface DocMeta {
  id: string;
  title: string;
  visibility: Visibility;
  /** Lowercased, deduped. Always contains OWNER_EMAIL. */
  emails: string[];
  publicToken?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  /** Byte length of the HTML body. */
  bytes: number;
}

/**
 * What `list()` hands back inline, with no extra reads.
 *
 * `emails` is deliberately absent: KV caps key metadata at 1024 bytes and an
 * allowlist can blow that. The union needed for the Access group (ADR-002) is
 * recomputed by reading `meta:` keys during reconcile, never on a hot path.
 */
export interface DocSummary {
  id: string;
  title: string;
  visibility: Visibility;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  bytes: number;
}

type KeyMetadata = Omit<DocSummary, "id">;

/** KV's hard cap on key metadata. Exceeding it fails the write. */
const MAX_KEY_METADATA_BYTES = 1024;

const docKey = (id: string) => `doc:${id}`;
const metaKey = (id: string) => `meta:${id}`;
const pubKey = (token: string) => `pub:${token}`;

/**
 * Unambiguous alphabet — no 0/O, no 1/l/I. These ids get read aloud and typed by
 * hand often enough to be worth it.
 */
const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

function randomString(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const byte of bytes) {
    // ALPHABET.length is 32, so a byte maps to it with no modulo bias.
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}

/** 12 chars over a 32-char alphabet — 60 bits. */
export const mintId = () => randomString(12);

/** 22 chars — 110 bits. This is a capability URL; it is the only thing protecting a
 * public document, so it gets more entropy than an id does. */
export const mintPublicToken = () => randomString(22);

/**
 * Byte length of the metadata KV will store. Callers validate against
 * MAX_KEY_METADATA_BYTES *before* writing, because KV rejects the write otherwise
 * and the failure would surface as a broken listing rather than a bad request.
 */
export function keyMetadataBytes(meta: DocMeta): number {
  return new TextEncoder().encode(JSON.stringify(toKeyMetadata(meta))).byteLength;
}

export const metadataFits = (meta: DocMeta): boolean =>
  keyMetadataBytes(meta) <= MAX_KEY_METADATA_BYTES;

function toKeyMetadata(meta: DocMeta): KeyMetadata {
  const km: KeyMetadata = {
    title: meta.title,
    visibility: meta.visibility,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    bytes: meta.bytes,
  };
  if (meta.tags?.length) km.tags = meta.tags;
  return km;
}

/**
 * Write the document body and its metadata.
 *
 * Two writes, not one. KV has no transactions, so a crash between them leaves a
 * `doc:` with no `meta:` — an orphan that is invisible to every read path and to
 * the listing. That is the safe direction to fail: metadata is written last, so a
 * half-published document is simply not published.
 */
export async function putDoc(env: Env, meta: DocMeta, html: string): Promise<void> {
  await env.PAGEVAULT.put(docKey(meta.id), html);
  await putMeta(env, meta);
}

export async function putMeta(env: Env, meta: DocMeta): Promise<void> {
  await env.PAGEVAULT.put(metaKey(meta.id), JSON.stringify(meta), {
    metadata: toKeyMetadata(meta),
  });
}

export const getDoc = (env: Env, id: string): Promise<string | null> =>
  env.PAGEVAULT.get(docKey(id));

export async function getMeta(env: Env, id: string): Promise<DocMeta | null> {
  return env.PAGEVAULT.get<DocMeta>(metaKey(id), "json");
}

/**
 * Every document, from a single `list()` call.
 *
 * This is the whole reason metadata lives on the key. Reading `meta:{id}` per key
 * would be an N+1 that works perfectly in tests and quietly eats the 100k/day read
 * quota in production. `list()` is metered separately (1000/day), so this costs one
 * list op regardless of how many documents come back.
 *
 * Paginates only because `list()` caps at 1000 keys. It will not get there.
 */
export async function listDocs(env: Env): Promise<DocSummary[]> {
  const docs: DocSummary[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = await env.PAGEVAULT.list<KeyMetadata>(
      cursor ? { prefix: "meta:", cursor } : { prefix: "meta:" },
    );

    for (const key of page.keys) {
      // A key with no metadata is a write that landed before this code did, or a
      // partial write. Skip it rather than issuing a read and reintroducing the N+1.
      if (!key.metadata) continue;
      docs.push({ id: key.name.slice("meta:".length), ...key.metadata });
    }

    if (page.list_complete) break;
    cursor = page.cursor;
  }

  return docs;
}

export const getPublicTokenTarget = (env: Env, token: string): Promise<string | null> =>
  env.PAGEVAULT.get(pubKey(token));

export const putPublicToken = (env: Env, token: string, id: string): Promise<void> =>
  env.PAGEVAULT.put(pubKey(token), id);

export const deletePublicToken = (env: Env, token: string): Promise<void> =>
  env.PAGEVAULT.delete(pubKey(token));

/**
 * Delete a document and everything pointing at it.
 *
 * The `pub:` key goes first. If this dies partway through, the surviving state is a
 * document nobody can reach by its public link — rather than a live public link
 * pointing at a document that no longer exists, or worse, at an id later reissued to
 * something else.
 */
export async function deleteDoc(env: Env, meta: DocMeta): Promise<void> {
  if (meta.publicToken) await deletePublicToken(env, meta.publicToken);
  await env.PAGEVAULT.delete(metaKey(meta.id));
  await env.PAGEVAULT.delete(docKey(meta.id));
}
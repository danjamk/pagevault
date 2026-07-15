import type { Env } from "./env.js";
import { resetTokenKeyCache, signPayload, verifyPayload } from "./token.js";

/**
 * A capability token: proof that the bearer was authorized to view ONE document,
 * recently.
 *
 * It exists because `/render/{id}` — the route that serves artifact bytes — has no
 * Cloudflare Access application in front of it. It cannot: an Access login redirect
 * inside a sandboxed iframe is a broken experience, and the frame has an opaque origin
 * anyway. So the shell, which *has* been through `canView`, mints one of these and
 * hands it to the iframe as a URL parameter.
 *
 * Scoped to one document and minutes long, so a leaked token is worth almost nothing.
 */
export interface Capability {
  /** Room to grow. Today there is one scope; a token for one is not a token for another. */
  scope: "viewer";
  /** The document id. A capability for doc A must never open doc B. */
  doc: string;
  /** The viewer's verified email, or null for an unauthenticated public view. */
  sub: string | null;
  /** Epoch seconds. */
  exp: number;
}

/** Minutes, not hours. The shell re-mints on reload; nothing depends on a long life. */
const TTL_SECONDS = 10 * 60;

/** Its own derived key (see token.ts) — a viewer token is not a console session. */
const KEY_INFO = "pagevault:capability:v1";

/** Test seam — clears the shared derived-key cache. */
export function resetCapabilityKeyCache(): void {
  resetTokenKeyCache();
}

/** `{payload}.{signature}`, both base64url. */
export async function mintCapability(
  env: Env,
  doc: string,
  sub: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const cap: Capability = { scope: "viewer", doc, sub, exp: nowSeconds + TTL_SECONDS };
  return signPayload(env, KEY_INFO, cap);
}

/**
 * Verify a capability against the document it is being used to open.
 *
 * `expectedDoc` is not optional. A verify that only checks the signature would happily
 * accept a valid capability for someone else's document — the scope check *is* the
 * security property, and making the caller pass the document makes it impossible to
 * forget.
 */
export async function verifyCapability(
  env: Env,
  token: string | null,
  expectedDoc: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<Capability | null> {
  const cap = await verifyPayload<Capability>(env, KEY_INFO, token);
  if (!cap) return null;

  if (cap.scope !== "viewer") return null;
  if (cap.doc !== expectedDoc) return null; // a capability for doc A does not open doc B
  if (typeof cap.exp !== "number" || cap.exp <= nowSeconds) return null;

  return cap;
}

/**
 * Reject `Origin: null` and any cross-origin caller.
 *
 * `Origin: null` is *precisely* what a sandboxed iframe sends — an opaque origin has no
 * host to name. So this single check is what stops artifact JS from reaching a
 * privileged endpoint even if it somehow obtained a token.
 *
 * Requests with no `Origin` at all are allowed: that is a non-browser caller (the CLI,
 * the MCP server), which authenticates with an explicit bearer header and therefore has
 * no ambient authority to abuse. See ADR-007.
 */
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin === null) return true; // not a browser request

  if (origin === "null") return false; // a sandboxed iframe. This is the check.

  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

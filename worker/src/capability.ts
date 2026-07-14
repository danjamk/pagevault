import type { Env } from "./env.js";
import { timingSafeEqual } from "./auth.js";

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

/**
 * Derived from `PAGEVAULT_API_TOKEN` rather than being a secret of its own.
 *
 * One fewer thing in the runbook, and no security loss: the derivation is one-way, so
 * a leaked capability token cannot be walked back to the API token. Rotating the API
 * token invalidates outstanding capabilities, which is correct and costs nothing given
 * the ten-minute lifetime.
 */
const KEY_INFO = "pagevault:capability:v1";

let keyCache: { token: string; key: CryptoKey } | null = null;

async function signingKey(env: Env): Promise<CryptoKey | null> {
  const token = env.PAGEVAULT_API_TOKEN;
  if (!token) return null; // no token, no capabilities. Fail closed.

  if (keyCache?.token === token) return keyCache.key;

  const encoder = new TextEncoder();
  const base = await crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign("HMAC", base, encoder.encode(KEY_INFO));

  const key = await crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  keyCache = { token, key };
  return key;
}

/** Test seam — the derived key is cached against the token that produced it. */
export function resetCapabilityKeyCache(): void {
  keyCache = null;
}

const b64urlEncode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const b64urlDecode = (value: string): Uint8Array => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

/** `{payload}.{signature}`, both base64url. */
export async function mintCapability(
  env: Env,
  doc: string,
  sub: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const key = await signingKey(env);
  if (!key) return null;

  const cap: Capability = { scope: "viewer", doc, sub, exp: nowSeconds + TTL_SECONDS };

  const encoder = new TextEncoder();
  const payload = b64urlEncode(encoder.encode(JSON.stringify(cap)));
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

  return `${payload}.${b64urlEncode(new Uint8Array(signature))}`;
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
  if (!token) return null;

  const key = await signingKey(env);
  if (!key) return null;

  const dot = token.indexOf(".");
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const encoder = new TextEncoder();
  const expected = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

  // Constant-time. A byte-by-byte compare here leaks the signature one character at a
  // time to anyone willing to time the responses.
  if (!timingSafeEqual(signature, b64urlEncode(new Uint8Array(expected)))) return null;

  let cap: Capability;
  try {
    cap = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as Capability;
  } catch {
    return null;
  }

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

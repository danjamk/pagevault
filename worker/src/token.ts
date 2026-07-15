import { timingSafeEqual } from "./auth.js";
import type { Env } from "./env.js";

/**
 * The shared HMAC-token core behind two scopes: the viewer capability (#3, `capability.ts`)
 * and the console session (#5, `session.ts`). Same mint/verify, a DIFFERENT derived key per
 * scope — a token for one scope cannot even be verified against the other's key, so scope
 * confusion is impossible by construction, not just by a checked field.
 *
 * Keys are derived one-way from `PAGEVAULT_API_TOKEN`, so there is no separate secret to
 * manage. A leaked token cannot be walked back to the API token, and rotating the API token
 * invalidates every outstanding token — correct, and free given the minutes-long lifetimes.
 */

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

// One derived key per scope (keyed by its `keyInfo`), invalidated when the API token changes.
const keyCache = new Map<string, { token: string; key: CryptoKey }>();

async function deriveKey(env: Env, keyInfo: string): Promise<CryptoKey | null> {
  const token = env.PAGEVAULT_API_TOKEN;
  if (!token) return null; // no API token, no derived keys. Fail closed.

  const cached = keyCache.get(keyInfo);
  if (cached?.token === token) return cached.key;

  const encoder = new TextEncoder();
  const base = await crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign("HMAC", base, encoder.encode(keyInfo));
  const key = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

  keyCache.set(keyInfo, { token, key });
  return key;
}

/** Test seam — derived keys are cached against the token that produced them. */
export function resetTokenKeyCache(): void {
  keyCache.clear();
}

/** Sign a payload object into `{base64url(json)}.{base64url(sig)}`. Null if there is no key. */
export async function signPayload(env: Env, keyInfo: string, payload: unknown): Promise<string | null> {
  const key = await deriveKey(env, keyInfo);
  if (!key) return null;

  const encoder = new TextEncoder();
  const body = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(signature))}`;
}

/**
 * Verify the signature (against THIS scope's key) and parse the payload. Returns the payload
 * object, or null if the token is malformed or the signature does not match. The domain rules
 * — scope, expiry, the bound document — are the caller's job; this proves only authenticity
 * and integrity.
 */
export async function verifyPayload<T>(env: Env, keyInfo: string, token: string | null): Promise<T | null> {
  if (!token) return null;

  const key = await deriveKey(env, keyInfo);
  if (!key) return null;

  const dot = token.indexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const encoder = new TextEncoder();
  const expected = await crypto.subtle.sign("HMAC", key, encoder.encode(body));

  // Constant-time. A byte-by-byte compare leaks the signature one character at a time to
  // anyone willing to time the responses.
  if (!timingSafeEqual(signature, b64urlEncode(new Uint8Array(expected)))) return null;

  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as T;
  } catch {
    return null;
  }
}

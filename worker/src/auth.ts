import type { Env } from "./env.js";

/**
 * Bearer auth for `/api/*`.
 *
 * `/api/*` has no Cloudflare Access application in front of it (ADR-001), so this is
 * the only thing standing in front of the API. It accepts exactly one credential
 * today; #5 adds the console's short-lived session token as a second bearer type.
 *
 * It will never accept a cookie. The browser attaches `CF_Authorization` to this
 * path whether we want it or not — the cookie is scoped `Path=/` on the hostname —
 * and honouring it would turn every state-changing endpoint into a CSRF target
 * reachable from any document we serve. See ADR-004.
 */
export function isAuthorized(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;

  return timingSafeEqual(header.slice("Bearer ".length), env.PAGEVAULT_API_TOKEN);
}

/**
 * Constant-time string comparison.
 *
 * `a === b` short-circuits on the first differing byte, which leaks the token one
 * character at a time to anyone willing to time the responses. Workers exposes
 * `crypto.subtle.timingSafeEqual`, but it throws on a length mismatch, so the length
 * check has to come first. Length is not secret; the bytes are.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);

  if (left.byteLength !== right.byteLength) return false;
  if (left.byteLength === 0) return false; // an unset token must never authorize

  return crypto.subtle.timingSafeEqual(left, right);
}
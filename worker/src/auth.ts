import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env.js";
import { normalizeEmail } from "./store.js";

export interface Identity {
  email: string;
  sub: string;
}

/** Which Access application's audience a route accepts. They are not interchangeable. */
export type Audience = "docs" | "admin";

// ---------------------------------------------------------------------------
// Bearer — /api/* and /mcp
// ---------------------------------------------------------------------------

/**
 * `/api/*` and `/mcp` have no Cloudflare Access application in front of them
 * (ADR-001, ADR-006), so this is the only thing guarding them.
 *
 * It will never accept a cookie. The browser attaches `CF_Authorization` to these
 * paths whether we want it or not — the cookie is scoped `Path=/` on the hostname —
 * and honouring it would turn every state-changing endpoint into a CSRF target
 * reachable from any artifact we serve. See ADR-004.
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
 * `crypto.subtle.timingSafeEqual`, which throws on a length mismatch — so the length
 * check comes first. Length is not secret; the bytes are.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);

  if (left.byteLength !== right.byteLength) return false;
  if (left.byteLength === 0) return false; // an unset token must never authorize

  return crypto.subtle.timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// Cloudflare Access JWT — /v/* and /admin
// ---------------------------------------------------------------------------

/**
 * JWKS is cached per team. Access rotates its signing key roughly every 6 weeks (old
 * keys stay valid 7 days), so we match on `kid` against a live key set and never pin a
 * key. `createRemoteJWKSet` handles the caching and refresh.
 */
let jwksCache: { team: string; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

function getJWKS(team: string) {
  if (!jwksCache || jwksCache.team !== team) {
    jwksCache = {
      team,
      jwks: createRemoteJWKSet(
        new URL(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`),
      ),
    };
  }
  return jwksCache.jwks;
}

/** Test seam. Access rotating a key mid-suite is not a thing we want to simulate. */
export function resetJWKSCache(): void {
  jwksCache = null;
}

/**
 * Accept the team either way — `"acme"` or `"acme.cloudflareaccess.com"`.
 *
 * Cloudflare's API returns `auth_domain` as the full domain, which is the natural thing to
 * paste into a config. Concatenating `.cloudflareaccess.com` onto it produces a JWKS URL
 * that does not exist, every JWT verification fails, and the whole thing surfaces as an
 * opaque 404 with no hint about the cause. Normalize here so it cannot happen.
 */
export const teamSlug = (value: string | undefined): string =>
  (value ?? "").trim().replace(/\.cloudflareaccess\.com$/i, "");

/**
 * Who is this?
 *
 * Cloudflare Access injects `Cf-Access-Jwt-Assertion` on protected paths and strips it
 * from external requests. That is a *deployment* property, not a *code* property — one
 * misrouted Worker, one `workers.dev` subdomain left enabled, and a trusted-header
 * design becomes a full authentication bypass with no error and no log. So we verify
 * the signature ourselves, always.
 *
 * We never read `Cf-Access-Authenticated-User-Email`, and we never read the
 * `CF_Authorization` cookie — not even here, where sharehtml does. We do not need to:
 * `/v/*` and `/admin` are Access-covered, so the header is always present, and
 * `/render` is gated by a capability token instead. Never taking the cookie means the
 * confused-deputy surface simply does not exist for us.
 *
 * Returns `null` on every failure. Fails closed, including on missing config.
 */
export async function identify(
  request: Request,
  env: Env,
  audience: Audience,
): Promise<Identity | null> {
  if (isDevBypass(request, env)) {
    const email = normalizeEmail(env.OWNER_EMAIL ?? "");
    return email ? { email, sub: "dev" } : null;
  }

  const team = teamSlug(env.CF_TEAM_NAME);
  const aud = (audience === "docs" ? env.CF_ACCESS_AUD_DOCS : env.CF_ACCESS_AUD_ADMIN)?.trim();

  // Missing config → DENY. Never skip. An unconfigured deployment is a closed one.
  if (!team || !aud) return null;

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getJWKS(team), {
      // Pin BOTH. Either alone is insufficient: the issuer without the audience
      // accepts a token minted for a different application on the same team — which
      // is exactly how a portal viewer would reach the owner console.
      issuer: `https://${team}.cloudflareaccess.com`,
      audience: aud,
    });

    const email = typeof payload.email === "string" ? normalizeEmail(payload.email) : "";
    if (!payload.sub || !email) return null;

    return { email, sub: String(payload.sub) };
  } catch {
    return null;
  }
}

/**
 * The local-development bypass.
 *
 * Two independent guards, because this is an authentication bypass and one typo away
 * from being a production one:
 *
 *   1. `AUTH_MODE === "none"` — **exact string equality**. A truthiness check here
 *      (`if (!env.AUTH_MODE)`) would disable auth on every deployment that simply
 *      forgot to set the var. That is the bug this shape exists to make impossible.
 *   2. The request must have arrived on localhost. A deployed Worker on a custom
 *      domain never sees a localhost Host header, so even a leaked `AUTH_MODE=none`
 *      in production cannot open the door.
 */
function isDevBypass(request: Request, env: Env): boolean {
  if (env.AUTH_MODE !== "none") return false;

  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

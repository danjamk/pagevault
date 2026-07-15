import type { Env } from "./env.js";
import { signPayload, verifyPayload } from "./token.js";

/**
 * A console session token: proof that the owner passed Cloudflare Access at `/admin`,
 * recently. The server-rendered console embeds it and sends it as a bearer to `/api/*`,
 * so the page never carries the long-lived `PAGEVAULT_API_TOKEN` (which would leak via the
 * DOM, the page cache, and screenshots) and never relies on a cookie (ambient authority,
 * a CSRF surface). See ADR-004.
 *
 * It shares the HMAC implementation with the viewer capability (#3) but derives a DISTINCT
 * key (see token.ts). A viewer capability therefore cannot be verified as a session even if
 * the scope check below regressed — the separation is cryptographic, not just a field.
 */
export interface Session {
  scope: "console";
  /** The owner's verified email. */
  sub: string;
  /** Epoch seconds. */
  exp: number;
}

/** Minutes. The console reloads to re-mint through Access; nothing depends on a long life. */
const TTL_SECONDS = 15 * 60;

/** Its own derived key (see token.ts) — a console session is not a viewer token. */
const KEY_INFO = "pagevault:session:v1";

/** `{payload}.{signature}`, both base64url. Null if there is no signing key. */
export async function mintSession(
  env: Env,
  email: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const session: Session = { scope: "console", sub: email, exp: nowSeconds + TTL_SECONDS };
  return signPayload(env, KEY_INFO, session);
}

/**
 * Verify a console session. Returns the owner's email, or null if the token is forged,
 * expired, or not console-scoped. The distinct key means a viewer capability fails at the
 * signature; the scope check is belt-and-suspenders on top of that.
 */
export async function verifySession(
  env: Env,
  token: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ email: string } | null> {
  const session = await verifyPayload<Session>(env, KEY_INFO, token);
  if (!session) return null;

  if (session.scope !== "console") return null;
  if (typeof session.sub !== "string" || session.sub.length === 0) return null;
  if (typeof session.exp !== "number" || session.exp <= nowSeconds) return null;

  return { email: session.sub };
}

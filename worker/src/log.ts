/**
 * Structured logging.
 *
 * One event per line, JSON, stable event names — it parses cleanly into Cloudflare's
 * pipeline and it is cheap. The first time something goes wrong you will be glad it is
 * here.
 *
 * This lives in its own module rather than in `viewer.ts` for a boring reason with a real
 * consequence: `api.ts` and `portal.ts` were both importing a logging primitive from the
 * HTML-rendering module, which is almost certainly why logging never spread past four call
 * sites. A logger that is awkward to import is a logger nobody reaches for.
 *
 * 🔴 What may be logged is governed by [ADR-015](../../docs/adr/ADR-015-what-a-view-record-contains.md).
 * The rule that shapes this file: **never record a credential in replayable form.** That is
 * why `log()` accepts a `Request` and destructures it here instead of letting call sites
 * pick fields off it — the loggable subset is decided in exactly one place, so a new route
 * cannot leak a token by copying the shape of an old one.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields extends Record<string, unknown> {
  /**
   * The request, expanded to its safe subset by `log()`. It never survives into the
   * output as an object, and the fields it contributes are chosen here — not by the
   * caller.
   */
  request?: Request;
}

/**
 * A short, non-reversible handle for a secret, so two rejections of the *same* token are
 * recognizable as the same token without the token itself ever reaching the log.
 *
 * 32 bits of SHA-256. That is ample to correlate events in a single operator's traffic and
 * useless for recovering the input: a `/p/` token is 110 bits, so ~2^78 candidates survive
 * knowing this. See ADR-015, decision 2.
 */
export async function fingerprint(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest).slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Emit one structured event.
 *
 * `error` goes to `console.error` so `wrangler tail --status error` actually surfaces it;
 * everything else goes to `console.log`. The previous helper hardcoded `level: "warn"` and
 * always used `console.log`, so nothing the Worker considered an error was reachable that
 * way.
 */
export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  const { request, ...extra } = fields;

  const line = JSON.stringify({
    level,
    event,
    timestamp: new Date().toISOString(),
    ...(request ? requestFields(request) : {}),
    ...extra,
  });

  if (level === "error") console.error(line);
  else console.log(line);
}

/**
 * The subset of a request that reaches the log.
 *
 * 🔴 **Nothing is derived from the URL. Not the full URL, not the path.** Capability
 * tokens ride in the query string on `/render?cap=`, and on `/p/{token}` the token *is*
 * the path — so a logged path is a logged credential just as surely as a logged URL is.
 * `/p/` tokens have no expiry; they live until rotated. See ADR-015, decision 2.
 *
 * This is why the leak is fixed here rather than at the call sites. A route that wants
 * path detail must pass it explicitly as a field, having decided that route carries no
 * secret — so leaking one takes a deliberate act, not merely copying an older call site.
 * The event name already identifies the route better than a path would.
 */
function requestFields(request: Request): Record<string, unknown> {
  return {
    method: request.method,
    origin: request.headers.get("Origin"),
  };
}

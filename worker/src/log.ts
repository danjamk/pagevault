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
 * 🔴 `url` is a known leak and is removed in the next commit — capability tokens ride in
 * the query string (`?cap=` on `/render`) and in the path itself on `/p/{token}`, so a
 * logged URL is a logged credential. It is preserved verbatim here only so that extracting
 * this module is a provable no-op. See ADR-015, decision 2.
 */
function requestFields(request: Request): Record<string, unknown> {
  return {
    method: request.method,
    url: request.url,
    origin: request.headers.get("Origin"),
  };
}

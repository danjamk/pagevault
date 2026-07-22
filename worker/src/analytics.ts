import type { Env } from "./env.js";
import type { DocMeta } from "./store.js";

/**
 * View tracking (#91).
 *
 * "Fourteen artifacts over nine months and no idea which ones the client opened" is the
 * question this answers, and it is worth answering: *did they read the migration plan
 * before the call* is a thing you want to know before the call.
 *
 * It lives in Analytics Engine rather than KV because KV would make the read path compete
 * with the write path — 1000 writes/day, of which a publish already spends two or three,
 * and no atomic increment so concurrent views would silently lose updates. Analytics Engine
 * has its own 100k/day budget, does not block the response, and is not a subrequest.
 *
 * 🔴 What a view record may contain is [ADR-015](../../docs/adr/ADR-015-what-a-view-record-contains.md).
 * Two rules are enforced here rather than asked of callers, because a rule that depends on
 * every future call site getting it right is not a rule.
 */

/**
 * Which door the reader came through. These are not interchangeable: exactly one of them
 * has an authenticated identity behind it, and that is the whole basis of the privacy rule
 * below.
 */
export type ViewSurface =
  /** `/v/{slug}/{id}` — behind Cloudflare Access. A verified email exists. */
  | "portal"
  /** `/pub/{slug}/{id}` — the public tier. No Access application, by design. */
  | "public"
  /** `/p/{token}` — a capability link. No Access application, by design. */
  | "link";

/**
 * Record one document view. Fire-and-forget: `writeDataPoint` does not block the response
 * and does not throw into the request path.
 *
 * Called from `renderShell`, which is the single point all three surfaces pass through —
 * deliberately not from `/render`, which fires once per iframe load and would count a page
 * refresh, a PDF export, and a raw download as three more views of the same document.
 */
export function recordView(
  env: Env,
  meta: DocMeta,
  surface: ViewSurface,
  email: string | null,
): void {
  // Absent binding = this deployment opted out. Nothing else changes.
  if (!env.ANALYTICS) return;

  // 🔴 Identity is recorded where Access established it, and nowhere else (ADR-015,
  // decision 1). The public and capability surfaces have no Access application in front of
  // them, so there is no identity to record — and the check is on the *surface*, not on
  // whether `email` happens to be null, so a caller that passes one anyway cannot write it.
  const viewer = surface === "portal" ? (email ?? "") : "";

  env.ANALYTICS.writeDataPoint({
    // One index only. More than one is SILENTLY DROPPED — not an error, just missing data.
    // The portal slug is the client boundary, which makes it the right partition key. Slugs
    // are validated short (isValidSlug), well inside the 96-byte cap.
    indexes: [meta.portal],

    // 20 blobs allowed, 16KB total. Nowhere near either.
    blobs: [meta.id, meta.title, surface, viewer],

    // 🔴 No `1` here, deliberately. A stored count invites `sum(double1)`, which is wrong
    // under sampling — Analytics Engine samples at volume, and the correct aggregate is
    // always `sum(_sample_interval)`. Not storing a count means the wrong query cannot be
    // written by accident.
    doubles: [],
  });
}

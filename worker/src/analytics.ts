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
 * 🔴 What a view record may contain is [ADR-015](../../docs/adr/ADR-015-what-a-view-record-contains.md)
 * and [ADR-023](../../docs/adr/ADR-023-the-summary-is-the-history.md).
 * Three rules are enforced here rather than asked of callers, because a rule that depends on
 * every future call site getting it right is not a rule: identity only where Access established
 * it, no identity at all on an index event, and the referrer reduced to a bare host.
 */

/**
 * 🔴 The blob contract (ADR-023, decision 8).
 *
 * There is no schema registry. Analytics Engine returns whatever sits in `blob5` under whatever
 * name a query asks for, so these positions are a contract between this file and the CLI's
 * `SELECT` list in `cli/lib/views.mjs` — and nothing enforces it but a reviewer who knows.
 *
 *   blob1  document id      empty on an index event
 *   blob2  document title   empty on an index event
 *   blob3  surface          portal | public | link
 *   blob4  viewer email     only on `portal`, and never on an index event
 *   blob5  event kind       document | index — empty on rows written before 0.32.0
 *   blob6  referrer host    bare host, or empty for direct/unparseable
 *
 * Positions are never reused, never reordered, never repurposed. A field added later takes
 * position 7. Rows written before a field existed return empty for it, and every reader treats
 * empty as "not recorded then" rather than as a value.
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
 * What the row is about. `document` is someone opening an artifact; `index` is someone landing
 * on a portal's collection page. They answer different questions and mix badly in one total,
 * which is why the distinction is written down rather than inferred from an empty document id.
 */
export type ViewKind = "document" | "index";

/**
 * The host that linked here — `linkedin.com`, `mail.google.com`, `t.co` — or empty.
 *
 * 🔴 The path, query and fragment are discarded HERE, before anything is written, and that
 * placement is the point (ADR-023, decision 5). A linking page's path is someone else's private
 * context: an internal wiki, a shared document, a query string carrying a token. `URL` does the
 * reduction structurally — hostname drops userinfo, port, path, query and fragment in one step,
 * so there is no partial-strip bug to write.
 *
 * Non-HTTP schemes (`android-app://`, `file://`) return empty: their authority is an app id or
 * nothing at all, and neither is a traffic source.
 */
export function referrerHost(referer: string | null | undefined): string {
  if (!referer) return "";
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    // A malformed or relative `Referer`. The header is a header — it is whatever the client
    // felt like sending, so failing to parse is a normal case, not an error.
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  return url.hostname.toLowerCase();
}

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
  referer?: string | null,
): void {
  // 🔴 Identity is recorded where Access established it, and nowhere else (ADR-015,
  // decision 1). The public and capability surfaces have no Access application in front of
  // them, so there is no identity to record — and the check is on the *surface*, not on
  // whether `email` happens to be null, so a caller that passes one anyway cannot write it.
  const viewer = surface === "portal" ? (email ?? "") : "";

  write(env, meta.portal, [meta.id, meta.title, surface, viewer, "document", referrerHost(referer)]);
}

/**
 * Record a landing on a portal's collection page — `/v/{slug}` or `/pub/{slug}`.
 *
 * 🔴 There is no `email` parameter, and that is deliberate rather than an oversight (ADR-023,
 * decision 6). An index event records no viewer **on any surface**, including `/v/`, where Access
 * has established one. That is narrower than ADR-015 decision 1 permits: the question an index
 * view answers is *how much traffic*, and "who landed on the portal page and did not open
 * anything" is not worth a permanent record of a person. Taking no email means no future caller
 * can pass one.
 *
 * Called from `portalIndex` after `canViewPortal`, for the same reason `recordView` sits after the
 * capability mint: a view that could not be served is not a view.
 */
export function recordPortalView(
  env: Env,
  slug: string,
  surface: ViewSurface,
  referer?: string | null,
): void {
  write(env, slug, ["", "", surface, "", "index", referrerHost(referer)]);
}

/** The single writer. Both events are the same row shape, and only this function knows it. */
function write(env: Env, portal: string, blobs: string[]): void {
  // Absent binding = this deployment opted out. Nothing else changes.
  if (!env.ANALYTICS) return;

  env.ANALYTICS.writeDataPoint({
    // One index only. More than one is SILENTLY DROPPED — not an error, just missing data.
    // The portal slug is the client boundary, which makes it the right partition key. Slugs
    // are validated short (isValidSlug), well inside the 96-byte cap.
    indexes: [portal],

    // 20 blobs allowed, 16KB total. Nowhere near either. Order is the contract above.
    blobs,

    // 🔴 No `1` here, deliberately. A stored count invites `sum(double1)`, which is wrong
    // under sampling — Analytics Engine samples at volume, and the correct aggregate is
    // always `sum(_sample_interval)`. Not storing a count means the wrong query cannot be
    // written by accident.
    doubles: [],
  });
}

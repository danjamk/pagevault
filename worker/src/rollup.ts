//
// One aggregation over the stored view summary, for every surface that reports traffic (#168).
//
// ADR-025 makes the stored summary the default read: `pagevault views` asks the API for this shape,
// the console and MCP call `rollup()` in-process. One function, four consumers, one set of numbers.
//
// 🔴 Computed in the Worker rather than shipped raw for clients to aggregate. The CLI is
// zero-dependency `.mjs` with no build step and cannot import this file, so a client-side rollup
// would be a SECOND implementation of the same arithmetic over a versioned structure — and the
// structure has already had one version bump. Two implementations of a wire format drift, and the
// one that drifts is the one nobody is looking at.
//
// Pure, and deliberately free of Worker types: no `Env`, no KV, no `fetch`. The caller loads the
// summary and the document index and hands both over, which is what lets the whole of this file be
// tested against a fixture with no Miniflare in the loop.
//
import type { Bucket, Coverage, DocHistory, SyncRisk, ViewSummary } from "./views.js";

/**
 * 🔴 A document's portal is NOT in the summary.
 *
 * `ViewSummary.docs` is keyed by document id, and `ViewSummary.portals` holds referrer hosts — so
 * nothing in the stored shape can answer "which portal did these views belong to". The caller
 * already holds the document index for every other reason, so it supplies it here rather than the
 * summary growing a mapping it would then have to keep in step with renames (ADR-017: identity is
 * `(portal, filename)`, and a document can move).
 *
 * `createdAt` carries the same weight it does in `statsFor`: a document published after the last
 * sync was never in the measured window, and must not appear as a measured zero.
 */
export interface DocIndexEntry {
  id: string;
  portal: string;
  title?: string | undefined;
  name?: string | undefined;
  createdAt: string;
}

/** Inclusive `YYYY-MM-DD` bounds. */
export interface Window {
  from: string;
  to: string;
}

export interface SurfaceCounts {
  link: number;
  public: number;
  portal: number;
}

export interface DocRollup {
  id: string;
  portal: string;
  title: string;
  views: number;
  surfaces: SurfaceCounts;
  /**
   * Views by the operator, out of `surfaces.portal` — or `null` when no bucket in the window
   * recorded the split. Absent means unknown, never zero (see `Bucket.owner`), and collapsing the
   * two would report "the client read it" about traffic that was the operator.
   */
  owner: number | null;
  /** ISO-8601, or null when nothing in the window was opened. */
  lastViewedAt: string | null;
}

export interface PortalRollup {
  portal: string;
  views: number;
  surfaces: SurfaceCounts;
  /** Documents in this portal with at least one view in the window. */
  docs: number;
}

export interface DayRollup {
  /** `YYYY-MM-DD`, or `YYYY-MM` once the bucket has been compacted past 90 days. */
  key: string;
  granularity: "day" | "month";
  views: number;
}

export interface ReferrerRollup {
  /** The linking host. `""` is direct — kept as the empty string; naming it is the formatter's job. */
  host: string;
  views: number;
}

export interface Rollup {
  window: Window;
  /** When the summary was last synced, or null when no sync has ever run. */
  syncedAt: string | null;
  /** The window the summary itself covers — not the requested one. */
  coverage: Coverage | null;
  risk: SyncRisk;
  /** Whether the deployment binds Analytics Engine. False means these numbers stopped growing. */
  recording: boolean;
  /**
   * The four states `statsFor` distinguishes, hoisted to the whole report so a formatter never has
   * to infer "no history" from an empty table — which reads as "nobody visited", the exact lie
   * ADR-015's zero-versus-null rule exists to prevent.
   *
   * `never-synced` — no summary · `not-recording` — binding absent, whatever history exists is
   * final · `empty` — measured, and nothing in this window was opened · `ok`.
   */
  state: "never-synced" | "not-recording" | "empty" | "ok";
  total: { views: number; surfaces: SurfaceCounts; owner: number | null };
  byDoc: DocRollup[];
  byPortal: PortalRollup[];
  byDay: DayRollup[];
  byReferrer: ReferrerRollup[];
  /**
   * What the numbers above cannot honour, stated rather than implied. A report whose provenance is
   * unstated is the ADR-024 failure mode one domain over.
   */
  scope: {
    /**
     * 🔴 Referrers are stored per portal, all-time — NOT per day (ADR-023 §5, which chose that so a
     * referrer host can never be correlated with a specific reader on a specific day). So
     * `byReferrer` ignores the window, and every caller must say so. Filtering by `portal` still
     * works; filtering by date does not.
     */
     referrers: "all-time";
    /** Buckets in the window that are monthly, so their views cannot be attributed to a day. */
    monthlyBuckets: number;
    /**
     * Portal-index landings are absent by construction: the sync drops them (`kind === "index"`) so
     * they never inflate a document's count, and the summary has nowhere else to put them. They are
     * available only on the live Analytics Engine query.
     */
    portalIndex: "not-stored";
  };
}

export interface RollupOptions {
  /** Inclusive `YYYY-MM-DD`. Both required — the caller decides the default window, not this file. */
  from: string;
  to: string;
  /** Restrict to one portal. */
  portal?: string | undefined;
  /** Restrict to one document. */
  doc?: string | undefined;
  /** Does the deployment bind Analytics Engine? Required, for the reason `statsFor` gives. */
  recording: boolean;
  /** The sync-risk verdict, computed by the caller against the same summary. */
  risk: SyncRisk;
}

/** Sum a bucket's three surfaces. */
const bucketViews = (b: Bucket): number => (b.link ?? 0) + (b.pub ?? 0) + (b.portal ?? 0);

/**
 * Does a bucket key fall inside the window?
 *
 * A daily key (`YYYY-MM-DD`) compares directly — ISO dates sort lexicographically. A monthly key
 * (`YYYY-MM`) is a whole month, so it counts when the month INTERSECTS the window rather than when
 * it is contained by it. Requiring containment would silently drop the oldest history from every
 * window that starts mid-month, which is most of them.
 */
function inWindow(key: string, from: string, to: string): boolean {
  if (key.length === 7) return key <= to.slice(0, 7) && key >= from.slice(0, 7);
  return key >= from && key <= to;
}

/**
 * Rebuild an ISO timestamp from a bucket key and its time-of-day.
 *
 * Same rule as `lastViewed` in views.ts, and deliberately the same answer: a compacted bucket
 * reports the first of the month at midnight, the earliest instant consistent with what is still
 * known. Duplicated rather than exported across, because this file is pure over the wire shape and
 * importing a private helper for four lines would couple the two modules for no gain — but if it
 * ever gains a fifth line, move it.
 */
function lastViewed(key: string, time: string): string | null {
  if (!key) return null;
  if (key.length === 7) return `${key}-01T00:00:00.000Z`;
  return `${key}T${time || "00:00:00"}.000Z`;
}

const emptySurfaces = (): SurfaceCounts => ({ link: 0, public: 0, portal: 0 });

const addSurfaces = (into: SurfaceCounts, b: Bucket): void => {
  into.link += b.link ?? 0;
  into.public += b.pub ?? 0;
  into.portal += b.portal ?? 0;
};

/** One document's buckets, folded over the window. Returns null when nothing landed in it. */
function foldHistory(history: DocHistory, from: string, to: string) {
  const surfaces = emptySurfaces();
  const byDay = new Map<string, { granularity: "day" | "month"; views: number }>();
  let owner: number | null = null;
  let monthly = 0;
  let lastKey = "";
  let lastTime = "";
  let any = false;

  for (const [key, bucket] of Object.entries(history)) {
    if (!inWindow(key, from, to)) continue;
    any = true;
    addSurfaces(surfaces, bucket);
    // Absent means unknown. A window where SOME buckets carry the split and others do not reports
    // the partial sum, which is the honest floor — never a zero standing in for "we didn't ask".
    if (bucket.owner !== undefined) owner = (owner ?? 0) + bucket.owner;
    const granularity = key.length === 7 ? "month" : "day";
    if (granularity === "month") monthly += 1;
    const views = bucketViews(bucket);
    const seen = byDay.get(key);
    if (seen) seen.views += views;
    else byDay.set(key, { granularity, views });
    if (key > lastKey) {
      lastKey = key;
      lastTime = bucket.t ?? "";
    }
  }

  if (!any) return null;
  return {
    surfaces,
    owner,
    byDay,
    monthlyBuckets: monthly,
    views: surfaces.link + surfaces.public + surfaces.portal,
    lastViewedAt: lastViewed(lastKey, lastTime),
  };
}

/**
 * Roll the stored summary up for one window.
 *
 * Documents published since the last sync are omitted rather than reported at zero, matching
 * `statsFor`: they were not in the measured window, so "nobody opened it" is not a thing we know.
 * A document that WAS measured and had no views in this window is included at zero — that is the
 * useful answer, and the whole point of the feature.
 */
export function rollup(
  summary: ViewSummary | null,
  docs: readonly DocIndexEntry[],
  opts: RollupOptions,
): Rollup {
  const { from, to, recording, risk } = opts;
  const window: Window = { from, to };
  const scope = { referrers: "all-time", monthlyBuckets: 0, portalIndex: "not-stored" } as const;

  if (!summary) {
    return {
      window,
      syncedAt: null,
      coverage: null,
      risk,
      recording,
      state: "never-synced",
      total: { views: 0, surfaces: emptySurfaces(), owner: null },
      byDoc: [],
      byPortal: [],
      byDay: [],
      byReferrer: [],
      scope: { ...scope },
    };
  }

  const syncedAtMs = Date.parse(summary.syncedAt);
  const wanted = docs.filter(
    (d) =>
      (!opts.portal || d.portal === opts.portal) &&
      (!opts.doc || d.id === opts.doc) &&
      // Parsed, not string-compared: both are ISO-8601, but `…:00.000Z` and `…:00Z` sort in the
      // wrong order lexicographically for the same instant.
      Date.parse(d.createdAt) <= syncedAtMs,
  );

  const byDoc: DocRollup[] = [];
  const portals = new Map<string, PortalRollup>();
  const days = new Map<string, { granularity: "day" | "month"; views: number }>();
  const total = { views: 0, surfaces: emptySurfaces(), owner: null as number | null };
  let monthlyBuckets = 0;

  for (const doc of wanted) {
    const history = summary.docs[doc.id];
    const folded = history ? foldHistory(history, from, to) : null;

    const surfaces = folded?.surfaces ?? emptySurfaces();
    const views = folded?.views ?? 0;

    byDoc.push({
      id: doc.id,
      portal: doc.portal,
      title: doc.title || doc.name || doc.id,
      views,
      surfaces,
      owner: folded?.owner ?? null,
      lastViewedAt: folded?.lastViewedAt ?? null,
    });

    const bucket = portals.get(doc.portal) ?? { portal: doc.portal, views: 0, surfaces: emptySurfaces(), docs: 0 };
    bucket.views += views;
    bucket.surfaces.link += surfaces.link;
    bucket.surfaces.public += surfaces.public;
    bucket.surfaces.portal += surfaces.portal;
    if (views > 0) bucket.docs += 1;
    portals.set(doc.portal, bucket);

    total.views += views;
    total.surfaces.link += surfaces.link;
    total.surfaces.public += surfaces.public;
    total.surfaces.portal += surfaces.portal;
    if (folded?.owner !== undefined && folded?.owner !== null) total.owner = (total.owner ?? 0) + folded.owner;

    if (folded) {
      monthlyBuckets += folded.monthlyBuckets;
      for (const [key, entry] of folded.byDay) {
        const seen = days.get(key);
        if (seen) seen.views += entry.views;
        else days.set(key, { ...entry });
      }
    }
  }

  // Referrers are per portal and all-time — the window cannot narrow them, only `--portal` can.
  const referrers = new Map<string, number>();
  for (const [portal, hosts] of Object.entries(summary.portals)) {
    if (opts.portal && portal !== opts.portal) continue;
    // A document filter cannot narrow a portal-level aggregate. Reporting the portal's referrers
    // beside one document's numbers would read as that document's, so there is nothing to report.
    if (opts.doc) continue;
    for (const [host, views] of Object.entries(hosts)) {
      referrers.set(host, (referrers.get(host) ?? 0) + views);
    }
  }

  return {
    window,
    syncedAt: summary.syncedAt,
    coverage: summary.coverage,
    risk,
    recording,
    state: !recording ? "not-recording" : total.views === 0 ? "empty" : "ok",
    total,
    byDoc: byDoc.sort((a, b) => b.views - a.views || a.title.localeCompare(b.title)),
    byPortal: [...portals.values()].sort((a, b) => b.views - a.views || a.portal.localeCompare(b.portal)),
    // Chronological, not by size: this one is a series, and a sparkline sorted by magnitude is a bar
    // chart with the x-axis thrown away.
    byDay: [...days.entries()]
      .map(([key, v]) => ({ key, granularity: v.granularity, views: v.views }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    byReferrer: [...referrers.entries()]
      .map(([host, views]) => ({ host, views }))
      .sort((a, b) => b.views - a.views || a.host.localeCompare(b.host)),
    scope: { ...scope, monthlyBuckets },
  };
}

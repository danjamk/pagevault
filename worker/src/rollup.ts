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

/** One document's contribution to a single bucket. See `DayRollup.topDocs`. */
export interface DayDocRollup {
  id: string;
  title: string;
  views: number;
}

/**
 * How many documents a bucket names. Three, because this feeds a tooltip: the question it answers
 * is "what drove that spike", and the fourth-busiest document has never been the answer to it. It
 * also bounds the payload — this rides on every bucket in the window.
 */
export const MAX_DAY_DOCS = 3;

/**
 * How buckets are grouped for reporting.
 *
 * 🔴 `week` and `day` are only ever available inside the daily-retention horizon. Past it the stored
 * buckets ARE months (`compact()`, ADR-023 decision 2) and the day detail is gone, not hidden — so a
 * window reaching back that far cannot be grouped finer than the data it is made of. See
 * `Rollup.grouping` for what happens when a caller asks anyway.
 */
export type Grouping = "day" | "week" | "month";

export interface DayRollup {
  /**
   * `YYYY-MM-DD` for a day, `YYYY-MM` for a month, and the **Monday** of the week (as `YYYY-MM-DD`)
   * for a week. Monday rather than an ISO `YYYY-Www` label because it still sorts lexicographically
   * and a reader can tell what it means without knowing ISO 8601 week numbering.
   */
  key: string;
  granularity: Grouping;
  views: number;
  /**
   * The surface split for THIS bucket.
   *
   * Unlike `byReferrer`, this genuinely carries a date: surfaces are stored per document per day
   * (`Bucket`), so narrowing them to a bucket is a real answer rather than an all-time total wearing
   * a day's label. It is the honest substitute for the referrer breakdown a per-day view cannot have
   * — see `Rollup.scope.referrers`.
   */
  surfaces: SurfaceCounts;
  /** The busiest documents in this bucket, largest first, capped at `MAX_DAY_DOCS`. */
  topDocs: DayDocRollup[];
  /**
   * The busiest LINKING SITES for this bucket, largest first, capped at `MAX_DAY_REFERRERS`.
   *
   * Direct is excluded here and reported separately as `direct` — for a `/p/` link pasted into
   * Slack or an email, direct is usually the majority, and letting it take a slot would crowd out
   * the only rows that answer "did the LinkedIn post work".
   *
   * Empty on a deployment whose summary predates the dated series (`ViewSummary.refs`), which is
   * not the same as "nothing linked here" — see `Rollup.scope.referrers`.
   */
  topReferrers: ReferrerRollup[];
  /** Views in this bucket with no referrer at all. Absent from `topReferrers` by design. */
  direct: number;
}

/** How many linking sites a bucket names. Tooltip-sized, for the same reason as `MAX_DAY_DOCS`. */
export const MAX_DAY_REFERRERS = 3;

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
  /**
   * What grouping was asked for, and what `byDay` is actually in.
   *
   * 🔴 They differ when the window reaches past the daily-retention horizon and the caller asked for
   * `day` or `week`. Those buckets are already months and cannot be split back, so honouring the
   * request literally would return a chart that is daily at one end and monthly at the other — 30
   * days of traffic sitting in one column beside single days, at the same visual weight. That is a
   * misleading picture, not a narrow one.
   *
   * So the whole window degrades to `month` and says so here. Every caller must surface the
   * difference: silently returning something other than what was asked for is the ADR-024 failure
   * mode, and a formatter that ignores this field reintroduces it.
   */
  grouping: { requested: Grouping; effective: Grouping };
  byReferrer: ReferrerRollup[];
  /**
   * What the numbers above cannot honour, stated rather than implied. A report whose provenance is
   * unstated is the ADR-024 failure mode one domain over.
   */
  scope: {
    /**
     * Where the referrer numbers came from, because the two answer different questions.
     *
     * `windowed` — from the dated series, narrowed to this window like everything else.
     * `undated` — this deployment has not synced a dated series yet, so `byReferrer` comes from the
     *   legacy per-portal map and **ignores the window**. That map is also not all-time: each sync
     *   replaces it wholesale from its own window, so it holds the last sync's window and has
     *   silently dropped anything older. Every caller must say which of these it is showing.
     *
     * 🔴 ADR-023 §5 rules out per-DOCUMENT-per-day referrers on size grounds. Per-portal-per-day is
     * a different and much smaller thing, and is what the dated series stores. The older claim that
     * dates were withheld for correlation reasons was never in the ADR.
     */
    referrers: "windowed" | "undated";
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
  /** How to group `byDay`. Defaults to `day` — the finest the stored data can offer. */
  group?: Grouping | undefined;
  /** Does the deployment bind Analytics Engine? Required, for the reason `statsFor` gives. */
  recording: boolean;
  /** The sync-risk verdict, computed by the caller against the same summary. */
  risk: SyncRisk;
}

/** Sum a bucket's three surfaces. */
const bucketViews = (b: Bucket): number => (b.link ?? 0) + (b.pub ?? 0) + (b.portal ?? 0);

/**
 * The Monday of the week a `YYYY-MM-DD` key falls in, as `YYYY-MM-DD`.
 *
 * All UTC. The stored keys were produced in UTC (`dayKey`), so doing the arithmetic in local time
 * would shift a view across a week boundary for anyone west of Greenwich — a silent off-by-one that
 * only appears for some readers, which is the worst kind.
 */
function weekStart(key: string): string {
  const ms = Date.parse(`${key}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return key;
  const dow = new Date(ms).getUTCDay(); // 0 = Sunday
  // ISO weeks start Monday, so Sunday is 6 days into its week, not 0.
  const backToMonday = (dow + 6) % 7;
  return new Date(ms - backToMonday * 86_400_000).toISOString().slice(0, 10);
}

/** Which grouped bucket a stored key belongs to, and what that bucket is. */
function groupKey(key: string, granularity: Grouping, group: Grouping): { key: string; granularity: Grouping } {
  // Already a month: it cannot be split back into anything finer, whatever was asked for.
  if (granularity === "month") return { key, granularity: "month" };
  if (group === "month") return { key: key.slice(0, 7), granularity: "month" };
  if (group === "week") return { key: weekStart(key), granularity: "week" };
  return { key, granularity: "day" };
}

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
  const byDay = new Map<string, { granularity: "day" | "month"; views: number; surfaces: SurfaceCounts }>();
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
    if (seen) {
      seen.views += views;
      addSurfaces(seen.surfaces, bucket);
    } else {
      const daySurfaces = emptySurfaces();
      addSurfaces(daySurfaces, bucket);
      byDay.set(key, { granularity, views, surfaces: daySurfaces });
    }
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
  const scope = { referrers: "undated", monthlyBuckets: 0, portalIndex: "not-stored" } as const;

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
      // Nothing was measured, so nothing was degraded — report the request honoured rather than a
      // default, or a never-synced deployment shows a "grouped by month instead" note about an
      // empty chart.
      grouping: { requested: opts.group ?? "day", effective: opts.group ?? "day" },
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
  // `docs` is per bucket, keyed by document id so a document contributes once per bucket. It is
  // dropped on the way out — only the top few survive into `topDocs`.
  const days = new Map<
    string,
    { granularity: "day" | "month"; views: number; surfaces: SurfaceCounts; docs: Map<string, DayDocRollup> }
  >();
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
      const title = doc.title || doc.name || doc.id;
      for (const [key, entry] of folded.byDay) {
        let seen = days.get(key);
        if (!seen) {
          seen = { granularity: entry.granularity, views: 0, surfaces: emptySurfaces(), docs: new Map() };
          days.set(key, seen);
        }
        seen.views += entry.views;
        seen.surfaces.link += entry.surfaces.link;
        seen.surfaces.public += entry.surfaces.public;
        seen.surfaces.portal += entry.surfaces.portal;
        // Zero-view buckets do not exist (`mergeBuckets` drops them), but a document that only
        // appears at zero has nothing to say about what drove the day either way.
        if (entry.views > 0) seen.docs.set(doc.id, { id: doc.id, title, views: entry.views });
      }
    }
  }

  // Referrers. The dated series is narrowed to the window like everything else; a deployment that
  // has not synced one yet falls back to the undated map, which ignores the window and says so.
  //
  // 🔴 A document filter still suppresses them entirely, dated or not. Referrers aggregate at
  // PORTAL granularity, so reporting a portal's linking sites beside one document's numbers would
  // read as that document's — a wrong answer rather than a coarse one.
  const referrers = new Map<string, number>();
  const refsByBucket = new Map<string, Map<string, number>>();
  const dated = summary.refs && Object.keys(summary.refs).length > 0;
  const referrerScope: "windowed" | "undated" = dated ? "windowed" : "undated";

  if (!opts.doc) {
    if (dated) {
      for (const [portal, byDay] of Object.entries(summary.refs ?? {})) {
        if (opts.portal && portal !== opts.portal) continue;
        for (const [key, hosts] of Object.entries(byDay)) {
          if (!inWindow(key, from, to)) continue;
          const bucket = refsByBucket.get(key) ?? new Map<string, number>();
          for (const [host, views] of Object.entries(hosts)) {
            referrers.set(host, (referrers.get(host) ?? 0) + views);
            bucket.set(host, (bucket.get(host) ?? 0) + views);
          }
          refsByBucket.set(key, bucket);
        }
      }
    } else {
      for (const [portal, hosts] of Object.entries(summary.portals)) {
        if (opts.portal && portal !== opts.portal) continue;
        for (const [host, views] of Object.entries(hosts)) {
          referrers.set(host, (referrers.get(host) ?? 0) + views);
        }
      }
    }
  }

  // Grouping, decided from the DATA rather than the calendar. The daily-retention horizon moves
  // with every sync, so "does this window already contain a month bucket" is the only reliable
  // question — a fixed 90-days-ago cutoff would disagree with the summary the moment a sync ran
  // late. Asking for day or week across one of those degrades the whole window; `Rollup.grouping`
  // carries the reason.
  const requested: Grouping = opts.group ?? "day";
  const hasMonthly = [...days.values()].some((d) => d.granularity === "month");
  const effective: Grouping = requested !== "month" && hasMonthly ? "month" : requested;

  const grouped = new Map<
    string,
    {
      granularity: Grouping;
      views: number;
      surfaces: SurfaceCounts;
      docs: Map<string, DayDocRollup>;
      refs: Map<string, number>;
    }
  >();
  const emptyGroup = (granularity: Grouping) => ({
    granularity,
    views: 0,
    surfaces: emptySurfaces(),
    docs: new Map<string, DayDocRollup>(),
    refs: new Map<string, number>(),
  });
  for (const [key, v] of days) {
    const g = groupKey(key, v.granularity, effective);
    let into = grouped.get(g.key);
    if (!into) {
      into = emptyGroup(g.granularity);
      grouped.set(g.key, into);
    }
    into.views += v.views;
    into.surfaces.link += v.surfaces.link;
    into.surfaces.public += v.surfaces.public;
    into.surfaces.portal += v.surfaces.portal;
    // A document can appear in several source buckets that merge into one — sum, never replace.
    for (const [id, d] of v.docs) {
      const seen = into.docs.get(id);
      if (seen) seen.views += d.views;
      else into.docs.set(id, { ...d });
    }
  }

  // Referrer buckets ride the SAME regrouping, so a weekly column names the sites that drove that
  // week. Keyed independently of `days` because a portal-index landing produces a referrer with no
  // document view behind it — folding these through `days` would silently drop those dates.
  for (const [key, hosts] of refsByBucket) {
    const g = groupKey(key, key.length === 7 ? "month" : "day", effective);
    let into = grouped.get(g.key);
    if (!into) {
      into = emptyGroup(g.granularity);
      grouped.set(g.key, into);
    }
    for (const [host, n] of hosts) into.refs.set(host, (into.refs.get(host) ?? 0) + n);
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
    grouping: { requested, effective },
    byDay: [...grouped.entries()]
      .map(([key, v]) => ({
        key,
        granularity: v.granularity,
        views: v.views,
        surfaces: v.surfaces,
        topDocs: [...v.docs.values()]
          .sort((a, b) => b.views - a.views || a.title.localeCompare(b.title))
          .slice(0, MAX_DAY_DOCS),
        // Direct is pulled out rather than ranked: for a link pasted into a chat or an email it is
        // usually the largest single "source", and it is not a site anyone can act on.
        topReferrers: [...v.refs.entries()]
          .filter(([host]) => host !== "")
          .map(([host, views]) => ({ host, views }))
          .sort((a, b) => b.views - a.views || a.host.localeCompare(b.host))
          .slice(0, MAX_DAY_REFERRERS),
        direct: v.refs.get("") ?? 0,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    byReferrer: [...referrers.entries()]
      .map(([host, views]) => ({ host, views }))
      .sort((a, b) => b.views - a.views || a.host.localeCompare(b.host)),
    scope: { ...scope, referrers: referrerScope, monthlyBuckets },
  };
}

import { BadRequest } from "./documents.js";
import type { Env } from "./env.js";

/**
 * View metrics, as MCP sees them (#127) — and, since [ADR-023](../../docs/adr/ADR-023-the-summary-is-the-history.md),
 * the durable history rather than a snapshot of a rolling window (#161).
 *
 * 🔴 The Worker still never reads Analytics Engine. Reading it needs an account-scoped
 * `Account Analytics Read` token — strictly wider than the Access-group-scoped `CF_API_TOKEN` the
 * Worker holds, and enough to read analytics for every Worker on the account — so ADR-015
 * decision 6 keeps it off the Worker and ADR-019 does not weaken that.
 *
 * Instead `pagevault views --sync` reads from the operator's machine, aggregates, and hands the
 * Worker a *result*. This module stores that result and joins it onto documents. The Worker gains
 * data, never the capability to compute it.
 *
 * What ADR-023 changes: the result is **added to**, not swapped for. Analytics Engine retains about
 * three months, so a summary that mirrored it inherited that horizon — a document opened 43 times in
 * January reported `views: 3` by June, and `viewsSyncedAt` moved forward, so the number looked
 * *fresher* at the moment it became *less true*. The summary now accumulates: each sync contributes
 * the window it could see, and what it contributed stays.
 *
 * There is no `canView()` call here, and that is deliberate rather than an oversight: `/mcp` and
 * `/api` are gated as a whole by operator identity, so a per-document check on this path could not
 * fail (ADR-016, and the note on `canView` itself). Metrics ride along inside `list_documents` /
 * `read_document` and inherit whatever gate that read path has — a decorative check bolted on here
 * would be worse than none, because it would get believed.
 */

/**
 * 🔴 The stored shape (v2). Sparse at BOTH levels, which is the whole reason it fits in one KV
 * value:
 *
 * ```jsonc
 * {
 *   "v": 2,
 *   "syncedAt": "2026-08-07T12:00:00.000Z",
 *   "coverage": { "from": "2026-05-09", "to": "2026-08-07" },  // what the last sync could see
 *   "docs": {
 *     "k3x9mq2vb7pd": {
 *       "2026-08-05": { "portal": 2, "owner": 1, "t": "14:02:07" },
 *       "2026-08-07": { "pub": 3, "link": 1, "t": "09:11:40" }
 *     }
 *   },
 *   "portals": { "acme": { "linkedin.com": 12, "": 4 } }   // "" is direct
 * }
 * ```
 *
 * - A day with no views is **absent**, not zero. A surface with no views is absent too.
 * - The bucket key is the date, so `t` carries only the time of the latest view within it.
 * - Keys are dates (`YYYY-MM-DD`) while daily, months (`YYYY-MM`) once compacted past 90 days.
 * - Totals are never stored. `link + pub + portal` IS the total, so there is no second number to
 *   drift out of agreement with the first.
 *
 * Sizing, measured rather than assumed: ~137 KB at 100 documents each opened on 30 distinct days.
 * `MAX_SUMMARY_BYTES` is not reached until roughly 250 documents each opened on 90 *distinct* days,
 * which is a corpus nobody has. Past that the answer is D1, not truncation — see ADR-023's
 * alternatives, which names that trigger explicitly.
 */
export const SUMMARY_VERSION = 2;

/** Which door readers came through. Mirrors `ViewSurface` in analytics.ts. */
const SURFACES = ["link", "public", "portal"] as const;
type Surface = (typeof SURFACES)[number];

/** Stored per-surface keys. `public` is `pub` in the wire shape — it is the most frequent key. */
const SURFACE_KEY: Record<Surface, string> = { link: "link", public: "pub", portal: "portal" };

/**
 * One day (or, after compaction, one month) of one document's views.
 *
 * Every field is optional because every field is omitted at zero. An empty bucket cannot exist —
 * `mergeBuckets` drops one that sums to nothing rather than storing a day that says "no views",
 * which is what "sparse" has to mean to be worth anything.
 */
export interface Bucket {
  link?: number;
  pub?: number;
  portal?: number;
  /**
   * Views by the operator, out of `portal`. Your own opens are noise in "did the client read it"
   * and signal in "how much traffic", so they are counted apart (ADR-023 decision 7).
   *
   * A **subset of `portal`**, because that is the only surface with an identity behind it —
   * `/pub/` and `/p/` have no Access application, so a view through them is neither owner nor
   * client, it is unattributed. Member views are `portal - owner` and are not stored twice.
   *
   * **Absent means unknown, never zero** — except where `portal` is absent, which makes it zero by
   * construction. The split is computed on the operator's machine, where the address already is; a
   * machine that does not know the owner's address omits it rather than guessing, because a wrong
   * attribution is worse than a missing one.
   */
  owner?: number;
  /** Time of the latest view in this bucket, `HH:MM:SS`. The date is the key. */
  t?: string;
}

/** A document's history: sparse buckets keyed by date. Never deleted by a sync. */
export type DocHistory = Record<string, Bucket>;

export interface Coverage {
  /** Inclusive, `YYYY-MM-DD`. */
  from: string;
  to: string;
}

export interface ViewSummary {
  v: number;
  syncedAt: string;
  /** The window the last sync could see. Every sync declares its own; see `mergeSummary`. */
  coverage: Coverage;
  docs: Record<string, DocHistory>;
  /** Referrer hosts per portal. `""` is direct. Not per document per day — see ADR-023 §5. */
  portals: Record<string, Record<string, number>>;
}

/** The shape MCP and `/api` report, derived from buckets. Unchanged by v2, deliberately. */
export interface ViewStats {
  views: number;
  /** ISO-8601, or null when the document has been measured and never opened. */
  lastViewedAt: string | null;
  surfaces: { link: number; public: number; portal: number };
}

/** One key, so a sync costs one write against the 1000/day budget (ADR-019 decision 3). */
const SUMMARY_KEY = "views:summary";

/**
 * Well under KV's 25MB value cap. The point is not the ceiling but that hitting it is an error
 * rather than a truncation.
 */
export const MAX_SUMMARY_BYTES = 1024 * 1024;

/** Buckets older than this are compacted from daily to monthly on write (ADR-023 decision 2). */
export const DAILY_RETENTION_DAYS = 90;

/**
 * How long Analytics Engine keeps a row. Cloudflare documents "about three months"; 90 days is the
 * conservative reading, and being early about a warning is the harmless direction to be wrong in.
 */
export const ANALYTICS_RETENTION_DAYS = 90;

/**
 * When to start saying something, as fractions of the retention horizon rather than fixed day
 * counts — so the thresholds move with the horizon instead of quietly meaning something different
 * if it ever changes.
 */
const WARN_AT = ANALYTICS_RETENTION_DAYS / 3; // 30 days of runway left
const URGENT_AT = ANALYTICS_RETENTION_DAYS / 9; // 10

export interface SyncRisk {
  /**
   * `off` — this deployment records nothing, so there is no history and never will be ·
   * `never` — no sync has run · `ok` — plenty of runway · `warn`, `urgent` — the oldest uncaptured
   * day is approaching the horizon · `losing` — history has already gone and is still going.
   */
  state: "off" | "never" | "ok" | "warn" | "urgent" | "losing";
  /** The last day the summary has captured, or null when nothing has. */
  capturedThrough: string | null;
  /** Days of views sitting in Analytics Engine that no sync has promoted yet. */
  uncapturedDays: number;
  /** Days until the oldest uncaptured day falls out of retention. Null when nothing is pending. */
  daysUntilLoss: number | null;
  /** Days of history that are already unrecoverable. Nothing can bring these back. */
  lostDays: number;
}

/**
 * How much history is at risk, and how long there is to act (ADR-023 decision 9).
 *
 * Capture is automatic; promotion is not. Every view reaches Analytics Engine unprompted, but only
 * `views --sync` moves it into the durable summary — Analytics Engine is a 90-day conveyor belt and
 * the summary is the warehouse, and nothing takes boxes off the belt but the operator. So the
 * operating invariant is **sync at least once every 90 days**, and missing it is a quiet failure:
 * nothing errors, nothing looks wrong, and the data is simply never there later.
 *
 * 🔴 This alarms on **risk, not on age**, and the difference is the whole point. "Synced 40 days
 * ago" is a fact about the past that the reader has to do arithmetic on. "12 days of history become
 * unrecoverable in 3 weeks" is a fact about the future that tells them whether to act today. The
 * first is a status line; only the second is worth interrupting someone for.
 *
 * It cannot be automated away. The Worker cannot read Analytics Engine at all, at any schedule
 * (ADR-019 decision 1) — a Worker cron is structurally impossible here, not merely unwired. Making
 * the miss loud is the only move available.
 */
export function syncRisk(summary: ViewSummary | null, now: string, recording: boolean): SyncRisk {
  const today = dayKey(Date.parse(now));

  // 🔴 Not recording is its own answer, and it outranks every other one (#185).
  //
  // Without this the arithmetic below reports `ok` with zero days at risk — which is *technically*
  // true and completely misleading: there is no history at risk because there is no history, and
  // there will not be. A deployment with the binding absent reported twenty documents at `views: 0`,
  // a successful sync of nothing, and a green alarm. Every surface agreed, which is what made it
  // convincing. `capturedThrough` still comes from the summary: a deployment that recorded before
  // and was later turned off has real history, and that history is not in question.
  if (!recording) {
    return {
      state: "off",
      capturedThrough: summary?.coverage?.to ?? null,
      uncapturedDays: 0,
      daysUntilLoss: null,
      lostDays: 0,
    };
  }

  // Never synced is its own answer, not zero days at risk. Zero would read as "you are up to
  // date", which is the opposite of true — everything is uncaptured, and none of it is safe.
  if (!summary?.coverage?.to || !today) {
    return { state: "never", capturedThrough: null, uncapturedDays: 0, daysUntilLoss: null, lostDays: 0 };
  }

  const capturedThrough = summary.coverage.to;
  const oldestUncaptured = addDays(capturedThrough, 1);

  // Captured through today or later: nothing is waiting on the belt.
  if (!oldestUncaptured || oldestUncaptured > today) {
    return { state: "ok", capturedThrough, uncapturedDays: 0, daysUntilLoss: null, lostDays: 0 };
  }

  const uncapturedDays = daysBetween(oldestUncaptured, today) + 1;
  // The oldest uncaptured day falls out of retention once today passes it by the horizon.
  const daysUntilLoss = ANALYTICS_RETENTION_DAYS - daysBetween(oldestUncaptured, today);
  const lostDays = Math.max(0, -daysUntilLoss);

  const state: SyncRisk["state"] =
    lostDays > 0 ? "losing" : daysUntilLoss <= URGENT_AT ? "urgent" : daysUntilLoss <= WARN_AT ? "warn" : "ok";

  return { state, capturedThrough, uncapturedDays, daysUntilLoss, lostDays };
}

const MS_PER_DAY = 86_400_000;

/** Whole days from `a` to `b`, both `YYYY-MM-DD`. Negative when `b` is earlier. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_PER_DAY);
}

/** `YYYY-MM-DD` shifted by n days, or "" when the input was not a date. */
function addDays(key: string, n: number): string {
  const ms = Date.parse(`${key}T00:00:00Z`);
  return Number.isFinite(ms) ? dayKey(ms + n * MS_PER_DAY) : "";
}

/**
 * Read the stored summary.
 *
 * A v1 summary is **discarded rather than migrated** — it holds only lifetime totals, so there is no
 * honest way to place them on a timeline, and inventing bucket dates for them would manufacture
 * history that never existed. Analytics Engine still holds 90 days, so one sync restores everything
 * a v1 summary knew and dates it correctly. Until that sync runs, metrics read as "never measured",
 * which is the honest answer rather than a wrong one.
 */
export async function getViewSummary(env: Env): Promise<ViewSummary | null> {
  const raw = await env.PAGEVAULT.get<ViewSummary>(SUMMARY_KEY, "json");
  if (!raw || raw.v !== SUMMARY_VERSION) return null;
  return raw;
}

export const putViewSummary = (env: Env, summary: ViewSummary): Promise<void> =>
  env.PAGEVAULT.put(SUMMARY_KEY, JSON.stringify(summary));

// ---------------------------------------------------------------------------
// The merge — ADR-023 decision 3
// ---------------------------------------------------------------------------

/**
 * Fold a posted summary into the stored one. **A sync may add history; it may not remove it.**
 *
 * The payload declares the window it covers, and that window is authoritative *deployment-wide*:
 *
 * > Drop every stored bucket whose date falls inside the posted coverage window, across all
 * > documents. Then merge in the payload's buckets. Buckets outside the window are untouched.
 *
 * Deployment-wide is what makes it correct rather than merely plausible. A document with no views in
 * the window does not appear in the payload at all — so a rule that only touched documents the
 * payload mentions could never clear a bucket, and a view deleted from Analytics Engine, or double
 * counted by an earlier bug, would be permanent. Clearing by window instead means the payload is the
 * whole truth about its own window and says nothing about any other.
 *
 * That rule is idempotent (the same payload twice is the same summary), correct under overlapping
 * windows (each is authoritative only for its own), and correct whether or not a given document
 * appears.
 *
 * 🔴 The caller does read-modify-write on eventually-consistent KV, and that is deliberate. Two
 * syncs inside the ~60s window could both read the pre-merge value, and the second would win —
 * losing the first's contribution. The next sync repairs it, because a 90-day query re-derives every
 * recent bucket from scratch. The operation is self-healing, which is the property that makes it
 * safe. Nothing here depends on read-after-write, and nothing should be built on top of it that does.
 */
export function mergeSummary(stored: ViewSummary | null, incoming: ViewSummary): ViewSummary {
  const base = stored && stored.v === SUMMARY_VERSION ? stored : null;
  const { from, to } = incoming.coverage;

  const docs: Record<string, DocHistory> = Object.create(null);

  for (const [id, history] of Object.entries(base?.docs ?? {})) {
    // Keep only what this payload does not claim to know about. A monthly bucket overlapping the
    // window is kept: the payload speaks in days, so it cannot restate a month it only partly
    // covers, and dropping one would lose the days outside the window that it also holds.
    const kept: DocHistory = Object.create(null);
    for (const [key, bucket] of Object.entries(history)) {
      if (!coveredByWindow(key, from, to)) kept[key] = bucket;
    }
    if (Object.keys(kept).length > 0) docs[id] = kept;
  }

  for (const [id, history] of Object.entries(incoming.docs)) {
    const target = docs[id] ?? (docs[id] = Object.create(null));
    for (const [key, bucket] of Object.entries(history)) {
      target[key] = target[key] ? mergeBucket(target[key], bucket) : bucket;
    }
    // A document whose every incoming bucket was empty, and which had no surviving history.
    if (Object.keys(target).length === 0) delete docs[id];
  }

  return compact(
    {
      v: SUMMARY_VERSION,
      syncedAt: incoming.syncedAt,
      coverage: widen(base?.coverage, incoming.coverage),
      docs,
      // Referrers are a rollup with no time dimension, so there is no window to clear by. The
      // payload's view of a portal replaces the stored one; a portal it does not mention keeps
      // what it had. Per ADR-023 §5 these answer "where is traffic coming from", not "when".
      portals: { ...(base?.portals ?? {}), ...incoming.portals },
    },
    incoming.syncedAt,
  );
}

/**
 * Is this bucket's date inside the posted window?
 *
 * Daily keys (`YYYY-MM-DD`) compare as strings, which is why ISO dates are the storage format.
 * Monthly keys (`YYYY-MM`) are never covered: a payload measured in days cannot restate a month it
 * only partly overlaps, and treating it as covered would delete the days outside the window that
 * the same bucket also holds.
 */
function coveredByWindow(key: string, from: string, to: string): boolean {
  if (key.length !== 10) return false;
  return key >= from && key <= to;
}

/** Sum two buckets for the same day. Surfaces add; `t` takes the later; `owner` stays unknown if either is. */
function mergeBucket(a: Bucket, b: Bucket): Bucket {
  const out: Bucket = {};
  for (const key of ["link", "pub", "portal"] as const) {
    const n = (a[key] ?? 0) + (b[key] ?? 0);
    if (n > 0) out[key] = n;
  }
  // Absent means "not measured", so a known count plus an unknown one is still unknown. Adding them
  // as if the unknown were zero would under-report owner views and silently inflate client ones.
  if (a.owner !== undefined && b.owner !== undefined) out.owner = a.owner + b.owner;
  const t = later(a.t, b.t);
  if (t) out.t = t;
  return out;
}

const later = (a?: string, b?: string): string | undefined => (!a ? b : !b ? a : a > b ? a : b);

/** The union of two windows, so `coverage` describes everything the summary has ever measured. */
function widen(stored: Coverage | undefined, incoming: Coverage): Coverage {
  if (!stored?.from || !stored?.to) return incoming;
  return {
    from: stored.from < incoming.from ? stored.from : incoming.from,
    to: stored.to > incoming.to ? stored.to : incoming.to,
  };
}

// ---------------------------------------------------------------------------
// Compaction — ADR-023 decision 2
// ---------------------------------------------------------------------------

/**
 * Roll daily buckets older than 90 days into monthly ones.
 *
 * Counts are preserved exactly; only granularity is lost, and only where Analytics Engine can no
 * longer restate it anyway. This is what bounds growth: without it a three-year engagement stores a
 * thousand daily buckets per document, and the 1 MB refusal arrives as a wall rather than a warning.
 *
 * The boundary is measured from the sync's own timestamp rather than the Worker's clock, so the
 * result is a pure function of its inputs — the same payload merged twice produces byte-identical
 * output, which is the property the idempotence test actually checks.
 */
export function compact(summary: ViewSummary, now: string): ViewSummary {
  const cutoff = dayKey(Date.parse(now) - DAILY_RETENTION_DAYS * 86_400_000);
  if (!cutoff) return summary;

  const docs: Record<string, DocHistory> = Object.create(null);

  for (const [id, history] of Object.entries(summary.docs)) {
    const next: DocHistory = Object.create(null);
    for (const [key, bucket] of Object.entries(history)) {
      // Already monthly, or still inside the daily window.
      if (key.length !== 10 || key >= cutoff) {
        next[key] = next[key] ? mergeBucket(next[key], bucket) : bucket;
        continue;
      }
      const month = key.slice(0, 7);
      // `t` is a time-of-day and means nothing once the key stops naming a day. Dropping it here is
      // why `lastViewedAt` degrades to date precision for views older than 90 days — which is the
      // same horizon past which Analytics Engine could not tell us the time either.
      const { t: _dropped, ...rest } = bucket;
      next[month] = next[month] ? mergeBucket(next[month], rest) : rest;
    }
    if (Object.keys(next).length > 0) docs[id] = next;
  }

  return { ...summary, docs };
}

/** `YYYY-MM-DD` for an epoch-ms instant, or "" when the input was not a date. */
function dayKey(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Reading — the shape MCP has always seen
// ---------------------------------------------------------------------------

/**
 * The metrics to report for one document, or `null` when there is nothing honest to say.
 *
 * Four answers, and collapsing any two of them is the bug this function exists to prevent:
 *
 * - **Not recording at all** → `null`. The deployment has no Analytics Engine binding, so it cannot
 *   have measured anything. This one was missing until #185, and its absence was expensive: a
 *   production deployment reported `views: 0` on twenty documents while recording nothing, and the
 *   staleness alarm called it healthy. A document that DOES have stored history still reports it —
 *   that data was measured when the binding was there, and it is still true.
 * - **No summary at all** → `null`. No sync has ever run.
 * - **Published since the sync** → `null`. The document was not in the measured window, so it was
 *   never counted. Reporting `0` here would say "the client never opened it" about a document
 *   that did not exist when we last looked.
 * - **Measured, no rows** → zeros. This is the *useful* answer, and the whole point of the
 *   feature: they had the chance and never opened it.
 *
 * A `0` that means "not measured" fails the same way a seat count of `0` that means "could not
 * ask" does — it reads as fact at precisely the moment it is not one.
 *
 * `recording` is required rather than defaulted, so adding a call site is a decision instead of an
 * omission — a default of `true` would reintroduce exactly this bug the next time someone adds a
 * reader.
 *
 * v2 changed where the numbers come from, not what they say: totals are summed over the buckets
 * rather than stored. The trend the buckets now hold reaches its readers in #162 and #163, and this
 * function deliberately keeps returning what it always did until then.
 */
export function statsFor(
  summary: ViewSummary | null,
  doc: { id: string; createdAt: string },
  recording: boolean,
): ViewStats | null {
  if (!summary) return null;
  // Parsed rather than compared as strings: both are ISO-8601, but `…:00.000Z` and `…:00Z` sort
  // in the wrong order lexicographically for the same instant.
  if (Date.parse(doc.createdAt) > Date.parse(summary.syncedAt)) return null;

  const history = summary.docs[doc.id];
  // The zeros are a measurement — "they had the chance and never opened it" — and a deployment that
  // records nothing has not measured anything. Stored history is different: it was measured, and it
  // is reported below whether or not the binding is there now.
  if (!history) {
    return recording ? { views: 0, lastViewedAt: null, surfaces: { link: 0, public: 0, portal: 0 } } : null;
  }

  const surfaces = { link: 0, public: 0, portal: 0 };
  let lastKey = "";
  let lastTime = "";

  for (const [key, bucket] of Object.entries(history)) {
    surfaces.link += bucket.link ?? 0;
    surfaces.public += bucket.pub ?? 0;
    surfaces.portal += bucket.portal ?? 0;
    if (key > lastKey) {
      lastKey = key;
      lastTime = bucket.t ?? "";
    }
  }

  return {
    views: surfaces.link + surfaces.public + surfaces.portal,
    lastViewedAt: lastViewed(lastKey, lastTime),
    surfaces,
  };
}

/**
 * Rebuild an ISO timestamp from a bucket key and its time-of-day.
 *
 * A compacted (monthly) bucket has no time and no day, so it reports the first of the month at
 * midnight — the earliest instant consistent with what is still known. Reporting the *last* moment
 * of the month would be the same size of guess pointed the other way, and this one cannot claim a
 * document was read more recently than it was.
 */
function lastViewed(key: string, time: string): string | null {
  if (!key) return null;
  if (key.length === 7) return `${key}-01T00:00:00.000Z`;
  return `${key}T${time || "00:00:00"}.000Z`;
}

/** A document record with its metrics folded in, or handed back untouched when none apply. */
export function withStats<T extends { id: string; createdAt: string }>(
  doc: T,
  summary: ViewSummary | null,
  recording: boolean,
): T | (T & ViewStats) {
  const stats = statsFor(summary, doc, recording);
  return stats ? { ...doc, ...stats } : doc;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a posted summary and rebuild it field by field.
 *
 * Rebuilt, never spread: this is data that ends up inside an MCP response, and "it came from our
 * own CLI" is not a validation strategy — the endpoint takes an owner bearer, and an owner bearer
 * is exactly what a leaked token is. That posture matters more under v2 than it did before, because
 * the payload now instructs the Worker to *delete* stored buckets by declaring a window.
 *
 * Throws `BadRequest`, which `/api`'s handler maps to 400 (or 413 for `too_large`).
 */
export function parseViewSummary(body: unknown): ViewSummary {
  if (!isRecord(body)) throw new BadRequest("invalid_field", "Body must be a JSON object");

  const syncedAt = body["syncedAt"];
  if (typeof syncedAt !== "string" || !Number.isFinite(Date.parse(syncedAt))) {
    throw new BadRequest("invalid_field", `"syncedAt" must be an ISO-8601 timestamp`);
  }

  const coverage = parseCoverage(body["coverage"]);

  const rawDocs = body["docs"];
  if (!isRecord(rawDocs)) {
    throw new BadRequest("invalid_field", `"docs" must be an object keyed by document id`);
  }

  // Null-prototype: `docs` is keyed by strings that arrived over the wire, and `__proto__` on a
  // normal object literal sets the prototype instead of a key.
  const docs: Record<string, DocHistory> = Object.create(null);

  for (const [id, value] of Object.entries(rawDocs)) {
    if (!isRecord(value)) throw new BadRequest("invalid_field", `docs["${id}"] must be an object`);

    const history: DocHistory = Object.create(null);
    for (const [key, raw] of Object.entries(value)) {
      if (!isBucketKey(key)) {
        throw new BadRequest("invalid_field", `docs["${id}"] key "${key}" must be YYYY-MM-DD or YYYY-MM`);
      }
      if (!isRecord(raw)) throw new BadRequest("invalid_field", `docs["${id}"]["${key}"] must be an object`);

      const bucket: Bucket = {};
      for (const surface of ["link", "pub", "portal"] as const) {
        const n = count(raw[surface] ?? 0, `docs["${id}"]["${key}"].${surface}`);
        if (n > 0) bucket[surface] = n;
      }
      // Only when present. `undefined` is the load-bearing value — it means "this machine did not
      // know the owner's address", and coercing it to 0 would assert that none of these were yours.
      if (raw["owner"] !== undefined) {
        bucket.owner = count(raw["owner"], `docs["${id}"]["${key}"].owner`);
      }
      const t = raw["t"];
      if (t !== undefined) {
        if (typeof t !== "string" || !/^\d{2}:\d{2}:\d{2}$/.test(t)) {
          throw new BadRequest("invalid_field", `docs["${id}"]["${key}"].t must be HH:MM:SS`);
        }
        bucket.t = t;
      }

      // Sparse means sparse: a bucket recording nothing is not stored. Keeping it would grow the
      // value with rows that say "no views on this day", which is what absence already says.
      if (bucket.link || bucket.pub || bucket.portal) history[key] = bucket;
    }
    if (Object.keys(history).length > 0) docs[id] = history;
  }

  const portals = parsePortals(body["portals"]);

  const summary: ViewSummary = { v: SUMMARY_VERSION, syncedAt, coverage, docs, portals };

  // Measured on the REBUILT object — the number that matters is what we would write, not what
  // arrived. Refusing beats storing a truncation: a summary quietly missing half a portal reports
  // "never opened" for documents that were.
  //
  // Checked on the payload before the merge as well as after it (see the handler), because a
  // payload that could never fit should be refused before it deletes anything.
  assertFits(summary);

  return summary;
}

/** The merged result can exceed the cap even when the payload did not. Same refusal, same reason. */
export function assertFits(summary: ViewSummary): void {
  const bytes = new TextEncoder().encode(JSON.stringify(summary)).byteLength;
  if (bytes > MAX_SUMMARY_BYTES) {
    throw new BadRequest(
      "too_large",
      `View summary is ${bytes} bytes, over the ${MAX_SUMMARY_BYTES}-byte limit. ` +
        `Narrow the window with --days, or start a fresh history with --sync --reset.`,
    );
  }
}

function parseCoverage(raw: unknown): Coverage {
  if (!isRecord(raw)) {
    throw new BadRequest("invalid_field", `"coverage" must be { from, to } as YYYY-MM-DD dates`);
  }
  const from = raw["from"];
  const to = raw["to"];
  for (const [name, value] of [["from", from], ["to", to]] as const) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequest("invalid_field", `"coverage.${name}" must be a YYYY-MM-DD date`);
    }
  }
  if ((from as string) > (to as string)) {
    throw new BadRequest("invalid_field", `"coverage.from" must not be after "coverage.to"`);
  }
  return { from: from as string, to: to as string };
}

function parsePortals(raw: unknown): Record<string, Record<string, number>> {
  const portals: Record<string, Record<string, number>> = Object.create(null);
  if (raw === undefined || raw === null) return portals;
  if (!isRecord(raw)) throw new BadRequest("invalid_field", `"portals" must be an object keyed by portal slug`);

  for (const [slug, hosts] of Object.entries(raw)) {
    if (!isRecord(hosts)) throw new BadRequest("invalid_field", `portals["${slug}"] must be an object`);
    const out: Record<string, number> = Object.create(null);
    for (const [host, value] of Object.entries(hosts)) {
      const n = count(value, `portals["${slug}"]["${host}"]`);
      if (n > 0) out[host] = n;
    }
    if (Object.keys(out).length > 0) portals[slug] = out;
  }
  return portals;
}

/** `YYYY-MM-DD` while daily, `YYYY-MM` once compacted. Nothing else is a bucket. */
const isBucketKey = (key: string) => /^\d{4}-\d{2}(-\d{2})?$/.test(key);

function count(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new BadRequest("invalid_field", `${field} must be a non-negative number`);
  return n;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

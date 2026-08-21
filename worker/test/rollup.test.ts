import { describe, expect, it } from "vitest";
import { type DocIndexEntry, MAX_DAY_DOCS, rollup } from "../src/rollup.js";
import { SUMMARY_VERSION, type SyncRisk, type ViewSummary } from "../src/views.js";

//
// The rollup (#168) — the one aggregation every traffic surface reads (ADR-025).
//
// Pure over a fixture, with no Miniflare in the loop: that is the point of keeping `rollup.ts` free
// of Worker types. What is worth pinning here is not the arithmetic but the four states `statsFor`
// distinguishes, because collapsing any two of them reports a measured zero for something that was
// never measured — which reads as "the client never opened it" and is the failure ADR-015's
// zero-versus-null rule exists to prevent.
//

const OK_RISK: SyncRisk = {
  state: "ok",
  capturedThrough: "2026-08-09",
  uncapturedDays: 0,
  daysUntilLoss: null,
  lostDays: 0,
};

/** Two portals, four documents, daily and monthly buckets, an owner split on exactly one day. */
const SUMMARY: ViewSummary = {
  v: SUMMARY_VERSION,
  syncedAt: "2026-08-09T12:00:00.000Z",
  coverage: { from: "2026-05-11", to: "2026-08-09" },
  docs: {
    "acme-roadmap": {
      "2026-08-07": { portal: 4, owner: 1, t: "09:15:00" },
      "2026-08-08": { link: 2, pub: 1, t: "14:02:00" },
    },
    "acme-primer": {
      "2026-08-08": { pub: 5, t: "23:59:00" },
      // Compacted past 90 days: a month, no time-of-day.
      "2026-04": { pub: 30 },
    },
    // Measured and never opened — present in the index, absent from `docs`.
    "acme-quiet": {},
    "globex-brief": {
      "2026-08-09": { portal: 3, t: "08:00:00" },
    },
  },
  portals: {
    acme: { "": 6, "news.ycombinator.com": 4, "linkedin.com": 1 },
    globex: { "": 2 },
  },
};

/**
 * The same summary with the DATED referrer series (#221) — per portal, per day.
 *
 * 08-08 and 08-09 deliberately have different linking sites, so a per-bucket list that wrongly
 * returned the window's total would show identical rows under both and fail loudly.
 */
const DATED: ViewSummary = {
  ...SUMMARY,
  refs: {
    acme: {
      "2026-08-08": { "linkedin.com": 5, "news.ycombinator.com": 2, "": 3 },
      "2026-08-09": { "t.co": 4 },
      // Outside WINDOW — proves the window actually narrows the dated series.
      "2026-05-02": { "linkedin.com": 99 },
    },
    globex: { "2026-08-09": { "": 2 } },
  },
};

const DOCS: DocIndexEntry[] = [
  { id: "acme-roadmap", portal: "acme", title: "2027 Platform Roadmap", createdAt: "2026-03-01T00:00:00.000Z" },
  { id: "acme-primer", portal: "acme", title: "Technical Primer", createdAt: "2026-03-01T00:00:00.000Z" },
  { id: "acme-quiet", portal: "acme", title: "Never Opened", createdAt: "2026-03-01T00:00:00.000Z" },
  { id: "globex-brief", portal: "globex", title: "Globex Brief", createdAt: "2026-03-01T00:00:00.000Z" },
];

const WINDOW = { from: "2026-08-01", to: "2026-08-09" };
const roll = (over = SUMMARY, docs = DOCS, opts = {}) =>
  rollup(over, docs, { ...WINDOW, recording: true, risk: OK_RISK, ...opts });

describe("the four states, kept apart", () => {
  it("never synced is not zero views — it is no history", () => {
    const r = rollup(null, DOCS, { ...WINDOW, recording: true, risk: OK_RISK });
    expect(r.state).toBe("never-synced");
    expect(r.syncedAt).toBeNull();
    expect(r.coverage).toBeNull();
    // Emphatically NOT an empty table with a zero total, which reads as "nobody visited".
    expect(r.byDoc).toEqual([]);
    expect(r.byPortal).toEqual([]);
  });

  it("not recording outranks the arithmetic, even with stored history", () => {
    // A deployment that recorded before and was later turned off has real history, and that history
    // is still true — but the report must not imply the numbers are still growing (#185).
    const r = roll(SUMMARY, DOCS, { recording: false });
    expect(r.state).toBe("not-recording");
    expect(r.total.views).toBeGreaterThan(0);
  });

  it("measured with nothing in the window is `empty`, not `never-synced`", () => {
    const r = roll(SUMMARY, DOCS, { from: "2026-06-01", to: "2026-06-30" });
    expect(r.state).toBe("empty");
    expect(r.total.views).toBe(0);
    // Every measured document is still listed at zero — that IS the answer: they had the chance.
    expect(r.byDoc).toHaveLength(4);
  });

  it("🔴 a document published since the sync is omitted, never reported at zero", () => {
    const fresh: DocIndexEntry = {
      id: "acme-new",
      portal: "acme",
      title: "Published Today",
      createdAt: "2026-08-09T18:00:00.000Z", // after syncedAt
    };
    const r = roll(SUMMARY, [...DOCS, fresh]);
    expect(r.byDoc.map((d) => d.id)).not.toContain("acme-new");
    // A measured zero here would say "the client never opened it" about a document that did not
    // exist when we last looked.
    expect(r.byDoc).toHaveLength(4);
  });
});

describe("totals and breakdowns", () => {
  it("sums surfaces per document and orders by traffic", () => {
    const r = roll();
    const roadmap = r.byDoc.find((d) => d.id === "acme-roadmap")!;
    expect(roadmap.views).toBe(7); // 4 portal + 2 link + 1 pub
    expect(roadmap.surfaces).toEqual({ link: 2, public: 1, portal: 4 });
    expect(roadmap.lastViewedAt).toBe("2026-08-08T14:02:00.000Z");
    expect(r.byDoc[0]!.views).toBeGreaterThanOrEqual(r.byDoc[1]!.views);
  });

  it("a document with no buckets at all is a measured zero, not a gap", () => {
    const quiet = roll().byDoc.find((d) => d.id === "acme-quiet")!;
    expect(quiet.views).toBe(0);
    expect(quiet.lastViewedAt).toBeNull();
    expect(quiet.owner).toBeNull();
  });

  it("rolls up by portal, counting only documents that were actually opened", () => {
    const r = roll();
    const acme = r.byPortal.find((p) => p.portal === "acme")!;
    expect(acme.views).toBe(12); // roadmap 7 + primer 5
    expect(acme.docs).toBe(2); // `acme-quiet` had none, so it is not a document with traffic
    expect(r.byPortal.find((p) => p.portal === "globex")!.views).toBe(3);
    expect(r.total.views).toBe(15);
  });

  it("the daily series is chronological, because it is a series", () => {
    // Sorted by magnitude it would be a bar chart with the x-axis thrown away.
    const r = roll();
    expect(r.byDay.map((d) => d.key)).toEqual(["2026-08-07", "2026-08-08", "2026-08-09"]);
    expect(r.byDay.find((d) => d.key === "2026-08-08")!.views).toBe(8); // 3 roadmap + 5 primer
  });
});

describe("what a single bucket says about itself", () => {
  // These feed the console's day tooltip. They are per-bucket answers to "what drove this column",
  // and they exist because the obvious answer — referrers — provably cannot be one (see below).

  it("carries the surface split for that bucket, not the window's", () => {
    const d = roll().byDay.find((x) => x.key === "2026-08-08")!;
    // roadmap {link:2, pub:1} + primer {pub:5} on this day alone.
    expect(d.surfaces).toEqual({ link: 2, public: 6, portal: 0 });
    // The window total is larger — 08-07 is 4 portal views and 08-09 is 3, neither of which
    // belongs to this bucket.
    expect(roll().total.surfaces.portal).toBe(7);
    expect(d.surfaces.portal).toBe(0);
  });

  it("names the documents that drove it, largest first", () => {
    const d = roll().byDay.find((x) => x.key === "2026-08-08")!;
    expect(d.topDocs.map((t) => [t.title, t.views])).toEqual([
      ["Technical Primer", 5],
      ["2027 Platform Roadmap", 3],
    ]);
  });

  it("🔴 a document with no views that day is not named in it", () => {
    // "Never Opened" is measured and present in the index, and belongs in byDoc at zero. A "top
    // pages" list that includes it is answering a different question than the one asked.
    const d = roll().byDay.find((x) => x.key === "2026-08-09")!;
    expect(d.topDocs.map((t) => t.title)).toEqual(["Globex Brief"]);
    expect(roll().byDoc.some((x) => x.title === "Never Opened" && x.views === 0)).toBe(true);
  });

  it("caps how many documents a bucket names", () => {
    const busy: ViewSummary = {
      ...SUMMARY,
      docs: Object.fromEntries(
        ["a", "b", "c", "d", "e"].map((k, i) => [`doc-${k}`, { "2026-08-08": { pub: 10 - i } }]),
      ),
    };
    const docs: DocIndexEntry[] = ["a", "b", "c", "d", "e"].map((k) => ({
      id: `doc-${k}`,
      portal: "acme",
      title: `Doc ${k.toUpperCase()}`,
      createdAt: "2026-03-01T00:00:00.000Z",
    }));
    const d = roll(busy, docs).byDay.find((x) => x.key === "2026-08-08")!;
    expect(d.topDocs).toHaveLength(MAX_DAY_DOCS);
    expect(d.topDocs.map((t) => t.title)).toEqual(["Doc A", "Doc B", "Doc C"]);
  });

  it("names the linking sites for that bucket, direct excluded and reported apart", () => {
    const d = roll(DATED).byDay.find((x) => x.key === "2026-08-08")!;
    expect(d.topReferrers.map((x) => [x.host, x.views])).toEqual([
      ["linkedin.com", 5],
      ["news.ycombinator.com", 2],
    ]);
    // Direct is a real measurement and usually the largest single source — but it is not a site,
    // so it gets its own field rather than a slot in the ranking.
    expect(d.direct).toBe(3);
    expect(d.topReferrers.some((x) => x.host === "")).toBe(false);
  });

  it("🔴 a bucket's referrers are its own, not the window's", () => {
    // The whole point of the dated series. 08-09 has a different linking site from 08-08, and a
    // per-bucket list that returned the window's total would show the same rows under every column.
    const r = roll(DATED);
    const a = r.byDay.find((x) => x.key === "2026-08-08")!;
    const b = r.byDay.find((x) => x.key === "2026-08-09")!;
    expect(a.topReferrers.map((x) => x.host)).toEqual(["linkedin.com", "news.ycombinator.com"]);
    expect(b.topReferrers.map((x) => x.host)).toEqual(["t.co"]);
  });
});

describe("grouping — and what the 90-day wall does to it (#218)", () => {
  // The window here is inside the daily-retention horizon, so every stored bucket is a day and any
  // grouping is available. 08-07 (4), 08-08 (8), 08-09 (3) — all in the same ISO week, which starts
  // Monday 2026-08-03.

  it("defaults to day, one bucket per stored key", () => {
    const r = roll();
    expect(r.grouping).toEqual({ requested: "day", effective: "day" });
    expect(r.byDay.map((d) => d.key)).toEqual(["2026-08-07", "2026-08-08", "2026-08-09"]);
  });

  it("groups into weeks, keyed by the Monday", () => {
    const r = roll(SUMMARY, DOCS, { group: "week" });
    expect(r.grouping).toEqual({ requested: "week", effective: "week" });
    expect(r.byDay).toHaveLength(1);
    expect(r.byDay[0]!.key).toBe("2026-08-03");
    expect(r.byDay[0]!.granularity).toBe("week");
    expect(r.byDay[0]!.views).toBe(15);
  });

  it("merges the surface split and the top documents across the merged buckets", () => {
    const r = roll(SUMMARY, DOCS, { group: "week" });
    const w = r.byDay[0]!;
    // 08-07 portal:4 · 08-08 link:2 pub:1 + pub:5 · 08-09 portal:3
    expect(w.surfaces).toEqual({ link: 2, public: 6, portal: 7 });
    // The roadmap appears in TWO source buckets (4 on 08-07, 3 on 08-08) and must be summed, not
    // replaced — 7 total, which makes it the busiest of the week.
    expect(w.topDocs.map((t) => [t.title, t.views])).toEqual([
      ["2027 Platform Roadmap", 7],
      ["Technical Primer", 5],
      ["Globex Brief", 3],
    ]);
  });

  it("groups into months", () => {
    const r = roll(SUMMARY, DOCS, { group: "month" });
    expect(r.byDay.map((d) => [d.key, d.views])).toEqual([["2026-08", 15]]);
    expect(r.byDay[0]!.granularity).toBe("month");
  });

  it("🔴 a window containing a compacted month degrades day and week to month, and says so", () => {
    // 2026-04 is a month bucket — the day detail is gone, not hidden. Honouring `day` literally
    // would put 30 days of April in one column beside single days at the same visual weight.
    const wide = { from: "2026-04-01", to: "2026-08-09" };
    const r = roll(SUMMARY, DOCS, { ...wide, group: "day" });

    expect(r.grouping).toEqual({ requested: "day", effective: "month" });
    expect(r.byDay.map((d) => d.key)).toEqual(["2026-04", "2026-08"]);
    expect(r.byDay.every((d) => d.granularity === "month")).toBe(true);

    const asWeek = roll(SUMMARY, DOCS, { ...wide, group: "week" });
    expect(asWeek.grouping).toEqual({ requested: "week", effective: "month" });
  });

  it("asking for month over that same window is not a degradation", () => {
    const r = roll(SUMMARY, DOCS, { from: "2026-04-01", to: "2026-08-09", group: "month" });
    expect(r.grouping).toEqual({ requested: "month", effective: "month" });
  });

  it("🔴 grouping never changes the totals — only how they are bucketed", () => {
    const day = roll(SUMMARY, DOCS, { group: "day" });
    const week = roll(SUMMARY, DOCS, { group: "week" });
    const month = roll(SUMMARY, DOCS, { group: "month" });
    const sum = (r: typeof day) => r.byDay.reduce((n, d) => n + d.views, 0);

    expect(sum(day)).toBe(day.total.views);
    expect(sum(week)).toBe(day.total.views);
    expect(sum(month)).toBe(day.total.views);
    expect(week.total).toEqual(day.total);
  });

  it("a never-synced deployment reports the grouping it was asked for, not a degradation", () => {
    // Otherwise an empty chart carries a "shown by month instead" note about nothing at all.
    const r = rollup(null, DOCS, { ...WINDOW, group: "week", recording: true, risk: OK_RISK });
    expect(r.grouping).toEqual({ requested: "week", effective: "week" });
  });
});

describe("dated referrers narrow to the window (#221)", () => {
  it("reports the window's linking sites, and says the numbers are windowed", () => {
    const r = roll(DATED);
    expect(r.scope.referrers).toBe("windowed");
    // Views descending, ties by host. Direct ("") is 3 from acme + 2 from globex, and it stays in
    // this list — Sources is where an operator wants to see how much traffic arrived with no
    // referrer at all. It is only excluded from the per-bucket `topReferrers` ranking.
    expect(r.byReferrer.map((x) => [x.host, x.views])).toEqual([
      ["", 5],
      ["linkedin.com", 5],
      ["t.co", 4],
      ["news.ycombinator.com", 2],
    ]);
  });

  it("🔴 excludes a bucket outside the window — the thing the undated map could not do", () => {
    // 2026-05-02 carries 99 linkedin views. If the window were ignored, linkedin would dominate.
    const r = roll(DATED);
    expect(r.byReferrer.find((x) => x.host === "linkedin.com")!.views).toBe(5);

    const wide = roll(DATED, DOCS, { from: "2026-04-01", to: "2026-08-09" });
    expect(wide.byReferrer.find((x) => x.host === "linkedin.com")!.views).toBe(104);
  });

  it("narrows by portal as well as by date", () => {
    const r = roll(DATED, DOCS, { portal: "globex" });
    expect(r.byReferrer.map((x) => x.host)).toEqual([""]);
  });

  it("🔴 a document filter suppresses referrers entirely, dated or not", () => {
    // They aggregate at portal granularity. Printing a portal's linking sites beside one document's
    // numbers would read as that document's — a wrong answer rather than a coarse one.
    const r = roll(DATED, DOCS, { doc: "acme-roadmap" });
    expect(r.byReferrer).toEqual([]);
  });

  it("weekly grouping merges each bucket's referrers", () => {
    const w = roll(DATED, DOCS, { group: "week" }).byDay[0]!;
    expect(w.key).toBe("2026-08-03");
    expect(w.topReferrers.map((x) => [x.host, x.views])).toEqual([
      ["linkedin.com", 5],
      ["t.co", 4],
      ["news.ycombinator.com", 2],
    ]);
    expect(w.direct).toBe(5);
  });

  it("a summary with no dated series still reports, and flags itself as undated", () => {
    const r = roll(SUMMARY);
    expect(r.scope.referrers).toBe("undated");
    expect(r.byReferrer.length).toBeGreaterThan(0);
    expect(r.byDay.every((d) => d.topReferrers.length === 0 && d.direct === 0)).toBe(true);
  });
});

describe("what the shape cannot honour, stated rather than implied", () => {
  it("🔴 owner is null when unknown and a number when known — never zero for unknown", () => {
    const r = roll();
    // Only 2026-08-07 carried the split, so the sum is a floor, not a claim about the rest.
    expect(r.byDoc.find((d) => d.id === "acme-roadmap")!.owner).toBe(1);
    // No bucket for this document ever carried it. Zero would assert the operator read none of it.
    expect(r.byDoc.find((d) => d.id === "acme-primer")!.owner).toBeNull();
  });

  it("a monthly bucket intersecting the window counts, and says it cannot be a day", () => {
    // Containment would silently drop the oldest history from every window starting mid-month.
    const r = roll(SUMMARY, DOCS, { from: "2026-04-15", to: "2026-08-09" });
    const primer = r.byDoc.find((d) => d.id === "acme-primer")!;
    expect(primer.views).toBe(35); // 5 daily + 30 monthly
    expect(r.scope.monthlyBuckets).toBe(1);
    expect(r.byDay.find((d) => d.key === "2026-04")!.granularity).toBe("month");
  });

  it("a compacted bucket dates to the first of the month — the earliest instant still known", () => {
    const r = roll({ ...SUMMARY, docs: { "acme-primer": { "2026-04": { pub: 30 } } } }, DOCS, {
      from: "2026-04-01",
      to: "2026-04-30",
    });
    expect(r.byDoc.find((d) => d.id === "acme-primer")!.lastViewedAt).toBe("2026-04-01T00:00:00.000Z");
  });

  it("🔴 an undated summary's referrers ignore the window, and the report says so", () => {
    // A summary written before the dated series exists has only the legacy per-portal map, which
    // has no date to filter on. The report must SAY that rather than let a caller label it with the
    // window — the mislabel this scope field exists to prevent.
    const narrow = roll(SUMMARY, DOCS, { from: "2026-08-09", to: "2026-08-09" });
    expect(narrow.scope.referrers).toBe("undated");
    expect(narrow.byReferrer.find((x) => x.host === "news.ycombinator.com")!.views).toBe(4);
    expect(narrow.byReferrer[0]!.host).toBe(""); // direct leads, 6 + 2
    expect(narrow.byReferrer[0]!.views).toBe(8);
  });

  it("portal index landings are absent by construction, and named as such", () => {
    // The sync drops `kind === "index"` so landings never inflate a document's count, and the
    // summary has nowhere else to put them. Only the live query has this.
    expect(roll().scope.portalIndex).toBe("not-stored");
  });
});

describe("filters", () => {
  it("--portal narrows documents and referrers together", () => {
    const r = roll(SUMMARY, DOCS, { portal: "globex" });
    expect(r.byDoc.map((d) => d.id)).toEqual(["globex-brief"]);
    expect(r.byPortal).toHaveLength(1);
    expect(r.byReferrer).toEqual([{ host: "", views: 2 }]);
  });

  it("🔴 --doc reports no referrers rather than the portal's", () => {
    // Referrers are a portal-level aggregate. Printed beside one document's numbers they would read
    // as that document's — a wrong answer rather than a narrower one.
    const r = roll(SUMMARY, DOCS, { doc: "acme-roadmap" });
    expect(r.byDoc.map((d) => d.id)).toEqual(["acme-roadmap"]);
    expect(r.byReferrer).toEqual([]);
  });
});

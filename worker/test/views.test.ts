import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { publishDocument } from "../src/documents.js";
import {
  type Bucket,
  MAX_SUMMARY_BYTES,
  SUMMARY_VERSION,
  type ViewSummary,
  compact,
  mergeSummary,
  parseViewSummary,
  statsFor,
  syncRisk,
} from "../src/views.js";

/**
 * View metrics over MCP (#127, ADR-019) and the durable history that replaced the snapshot
 * (#161, ADR-023).
 *
 * Two failures this suite exists to prevent.
 *
 * The first is a **measured-looking zero**. "0 views" is the most valuable thing this feature says
 * — *the client never opened it* — which is exactly why it must never be produced by a document
 * that was not in the measured window, or by no sync at all.
 *
 * The second is **a sync that removes history**. Analytics Engine keeps about three months; the
 * summary keeps everything. A merge that dropped a bucket the payload could not see would put the
 * horizon back, and it would do it silently — the symptom is a count going *down* between syncs
 * while `syncedAt` moves forward, so the number looks fresher at the moment it became less true.
 */

const TOKEN = "test-token-do-not-use-in-production";
const HOST = "https://share.example.com";

const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

const SYNCED = "2026-07-29T12:00:00.000Z";
const COVERAGE = { from: "2026-05-01", to: "2026-07-29" };

const bucket = (over: Bucket = {}): Bucket => ({ link: 2, portal: 1, t: "09:00:00", ...over });

/** A payload covering COVERAGE, with one document opened on one day inside it. */
const payload = (id: string, history: Record<string, Bucket> = { "2026-07-28": bucket() }, over = {}) => ({
  v: SUMMARY_VERSION,
  syncedAt: SYNCED,
  coverage: COVERAGE,
  docs: { [id]: history },
  portals: {},
  ...over,
});

const postSummary = (body: unknown, query = "") =>
  SELF.fetch(`${HOST}/api/views/summary${query}`, { method: "POST", headers: auth, body: JSON.stringify(body) });

const getDoc = async (id: string) =>
  (await (await SELF.fetch(`${HOST}/api/docs/${id}`, { headers: auth })).json()) as Record<string, unknown>;

const listDocs = async () =>
  (await (await SELF.fetch(`${HOST}/api/docs`, { headers: auth })).json()) as {
    docs: Record<string, unknown>[];
    viewsSyncedAt?: string;
    viewsCoverage?: { from: string; to: string };
  };

const stored = async () => (await env.PAGEVAULT.get<ViewSummary>("views:summary", "json"))!;

/** Publish, and force `createdAt` older than the sync so the document counts as measured. */
async function publishOld(title: string, createdAt = "2026-01-01T00:00:00.000Z") {
  const { meta } = await publishDocument(env, { title, source: `<h1>${title}</h1>` });
  const { putMeta } = await import("../src/store.js");
  await putMeta(env, { ...meta, createdAt });
  return meta.id;
}

/** Wipe the summary between tests — the KV namespace is shared across the file. */
beforeEach(async () => {
  await env.PAGEVAULT.delete("views:summary");
});

// ---------------------------------------------------------------------------

describe("statsFor — the three answers that must not collapse into each other", () => {
  const doc = { id: "abc", createdAt: "2026-01-01T00:00:00.000Z" };
  const summary = parseViewSummary(payload("abc", { "2026-07-28": { link: 4, t: "09:00:00" } }));

  it("reports the counts for a measured document, summed over its buckets", () => {
    expect(statsFor(summary, doc)).toMatchObject({ views: 4, surfaces: { link: 4, public: 0, portal: 0 } });
  });

  it("reports null — never zero — when no sync has ever run", () => {
    expect(statsFor(null, doc)).toBeNull();
  });

  it("reports null — never zero — for a document published since the last sync", () => {
    // The costly bug: a document published this morning is not in a summary taken yesterday, so
    // a `0` here would tell the operator the client ignored something that did not yet exist.
    expect(statsFor(summary, { id: "new", createdAt: "2026-07-30T00:00:00.000Z" })).toBeNull();
  });

  it("reports zero for a measured document nobody opened — the answer worth having", () => {
    expect(statsFor(summary, { id: "quiet", createdAt: "2026-01-01T00:00:00.000Z" })).toEqual({
      views: 0,
      lastViewedAt: null,
      surfaces: { link: 0, public: 0, portal: 0 },
    });
  });

  it("does not mistake sub-second ISO formatting for a later publish", () => {
    // `2026-07-29T12:00:00.000Z` vs `2026-07-29T12:00:00Z` — the same instant, but "." < "Z", so
    // a raw string compare puts the millisecond form first and would drop the document's metrics.
    expect(statsFor({ ...summary, syncedAt: "2026-07-29T12:00:00Z" }, { id: "abc", createdAt: SYNCED })).not.toBeNull();
  });

  it("rebuilds lastViewedAt from the newest bucket's date and time", () => {
    const s = parseViewSummary(
      payload("abc", { "2026-06-01": { link: 1, t: "23:59:59" }, "2026-07-28": { link: 1, t: "09:11:40" } }),
    );
    expect(statsFor(s, doc)?.lastViewedAt).toBe("2026-07-28T09:11:40.000Z");
  });

  it("degrades a compacted bucket to the start of its month rather than guessing a day", () => {
    // A monthly bucket knows neither the day nor the time. Reporting the END of the month would be
    // the same size of guess pointed the other way — and that one claims a document was read more
    // recently than it was.
    const s = parseViewSummary(payload("abc", { "2026-03": { link: 5 } }));
    expect(statsFor(s, doc)?.lastViewedAt).toBe("2026-03-01T00:00:00.000Z");
  });

  it("🔴 discards a v1 summary rather than reading its totals as a timeline", async () => {
    // v1 held lifetime totals with no dates. There is no honest place to put them on a timeline,
    // and inventing one would manufacture history. One sync restores everything v1 knew, dated.
    await env.PAGEVAULT.put(
      "views:summary",
      JSON.stringify({ syncedAt: SYNCED, windowDays: 90, docs: { abc: { views: 43, surfaces: {} } } }),
    );
    const id = await publishOld("Was Synced Under v1");
    expect((await getDoc(id))["views"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("🔴 mergeSummary — a sync may add history; it may not remove it", () => {
  const may = { from: "2026-05-01", to: "2026-05-31" };
  const june = { from: "2026-06-01", to: "2026-06-30" };

  const summaryOf = (coverage: { from: string; to: string }, docs: Record<string, Record<string, Bucket>>) =>
    parseViewSummary({ v: SUMMARY_VERSION, syncedAt: SYNCED, coverage, docs, portals: {} });

  it("is idempotent — the same payload twice is the same summary", () => {
    const p = summaryOf(may, { a: { "2026-05-04": { link: 3, t: "10:00:00" } } });
    const once = mergeSummary(null, p);
    const twice = mergeSummary(once, p);
    expect(JSON.stringify(twice.docs)).toBe(JSON.stringify(once.docs));
  });

  it("🔴 two syncs with disjoint windows both survive", () => {
    const first = mergeSummary(null, summaryOf(may, { a: { "2026-05-04": { link: 3 } } }));
    const second = mergeSummary(first, summaryOf(june, { a: { "2026-06-09": { pub: 5 } } }));

    expect(Object.keys(second.docs["a"]!).sort()).toEqual(["2026-05-04", "2026-06-09"]);
    expect(statsFor(second, { id: "a", createdAt: "2026-01-01T00:00:00.000Z" })?.views).toBe(8);
  });

  it("🔴 a wider window does not erase a narrower one's tail outside it", () => {
    // May and June measured separately, then a June-only re-sync. May is untouched, because the
    // payload said nothing about May and the merge only clears what the payload claims to know.
    let s = mergeSummary(null, summaryOf(may, { a: { "2026-05-04": { link: 3 } } }));
    s = mergeSummary(s, summaryOf(june, { a: { "2026-06-09": { pub: 5 } } }));
    s = mergeSummary(s, summaryOf(june, { a: { "2026-06-09": { pub: 9 } } }));

    expect(s.docs["a"]!["2026-05-04"]).toEqual({ link: 3 });
    // Restated, not doubled — 9, not 14.
    expect(s.docs["a"]!["2026-06-09"]).toEqual({ pub: 9 });
  });

  it("🔴 restates rather than accumulates inside the window — a re-sync is not a double count", () => {
    // The reason the window clears first. Without it, syncing twice over the same days would add
    // the same views again and the count would climb every time anyone ran a sync.
    let s = mergeSummary(null, summaryOf(may, { a: { "2026-05-04": { link: 3 } } }));
    s = mergeSummary(s, summaryOf(may, { a: { "2026-05-04": { link: 3 } } }));
    expect(s.docs["a"]!["2026-05-04"]).toEqual({ link: 3 });
  });

  it("🔴 a document absent from the payload loses its in-window buckets, not its history", () => {
    // The deployment-wide rule. A document with no views in the window does not appear in the
    // payload at all, so a merge that only touched documents the payload mentions could never
    // clear a bucket — and a view deleted upstream, or double-counted by an earlier bug, would be
    // permanent.
    let s = mergeSummary(null, summaryOf(may, { a: { "2026-05-04": { link: 3 } } }));
    s = mergeSummary(s, summaryOf(june, { a: { "2026-06-09": { link: 1 } } }));

    // Re-sync May with the document gone from the payload: its May bucket clears, June survives.
    s = mergeSummary(s, summaryOf(may, {}));
    expect(s.docs["a"]!["2026-05-04"]).toBeUndefined();
    expect(s.docs["a"]!["2026-06-09"]).toEqual({ link: 1 });
  });

  it("🔴 a revoked document keeps every bucket outside the window", () => {
    // ADR-023 §4. Revoking a document used to erase its traffic, because the sync dropped rows for
    // any id not in /docs. History outlives the document it describes.
    let s = mergeSummary(null, summaryOf(may, { gone: { "2026-05-04": { link: 7 } } }));
    s = mergeSummary(s, summaryOf(june, {}));
    expect(s.docs["gone"]!["2026-05-04"]).toEqual({ link: 7 });
  });

  it("sums two payloads that both describe the same day", () => {
    // Overlapping coverage is not the same as an overlapping bucket: the second payload's window
    // clears the day, so this can only happen within a single merge. Kept because mergeBucket is
    // also the compaction path, where same-key collisions are the normal case.
    const merged = mergeSummary(null, summaryOf(may, { a: { "2026-05-04": { link: 1, pub: 2, t: "08:00:00" } } }));
    const again = mergeSummary({ ...merged, coverage: june }, summaryOf(june, { a: {} }));
    expect(again.docs["a"]!["2026-05-04"]).toEqual({ link: 1, pub: 2, t: "08:00:00" });
  });

  it("widens coverage to everything ever measured, so the reader knows what the totals include", () => {
    let s = mergeSummary(null, summaryOf(june, { a: { "2026-06-09": { link: 1 } } }));
    s = mergeSummary(s, summaryOf(may, { a: { "2026-05-04": { link: 1 } } }));
    expect(s.coverage).toEqual({ from: "2026-05-01", to: "2026-06-30" });
  });

  it("🔴 a monthly bucket overlapping the window is kept, not cleared", () => {
    // A payload measured in days cannot restate a month it only partly covers. Clearing it would
    // lose the days outside the window that the same bucket also holds.
    const s = mergeSummary(
      { v: SUMMARY_VERSION, syncedAt: SYNCED, coverage: may, docs: { a: { "2026-05": { link: 40 } } }, portals: {} },
      summaryOf(may, { a: { "2026-05-04": { link: 1 } } }),
    );
    expect(s.docs["a"]!["2026-05"]).toEqual({ link: 40 });
  });

  it("keeps the owner split unknown when either side does not know it", () => {
    // Absent means "this machine did not know the owner's address", so a known count plus an
    // unknown one is still unknown. Treating absent as 0 would under-report owner views and
    // silently inflate the client's.
    const merged = compact(
      {
        v: SUMMARY_VERSION,
        syncedAt: SYNCED,
        coverage: may,
        docs: { a: { "2026-01-04": { link: 1, owner: 1 }, "2026-01-05": { link: 1 } } },
        portals: {},
      },
      SYNCED,
    );
    expect(merged.docs["a"]!["2026-01"]!.owner).toBeUndefined();
  });

  it("replaces a portal's referrers and leaves portals the payload did not mention", () => {
    // Referrers are a rollup with no time dimension, so there is no window to clear by.
    const first = mergeSummary(null, {
      ...summaryOf(may, {}),
      portals: { acme: { "linkedin.com": 4 }, other: { "t.co": 1 } },
    });
    const second = mergeSummary(first, { ...summaryOf(june, {}), portals: { acme: { "linkedin.com": 9 } } });
    expect(second.portals).toEqual({ acme: { "linkedin.com": 9 }, other: { "t.co": 1 } });
  });
});

// ---------------------------------------------------------------------------

describe("compact — daily past 90 days becomes monthly", () => {
  const now = "2026-08-07T12:00:00.000Z";
  const summary = (docs: Record<string, Record<string, Bucket>>): ViewSummary => ({
    v: SUMMARY_VERSION,
    syncedAt: now,
    coverage: COVERAGE,
    docs,
    portals: {},
  });

  it("leaves buckets inside the daily window alone", () => {
    const out = compact(summary({ a: { "2026-07-28": { link: 1, t: "09:00:00" } } }), now);
    expect(out.docs["a"]).toEqual({ "2026-07-28": { link: 1, t: "09:00:00" } });
  });

  it("rolls older days into their month, preserving counts exactly", () => {
    const out = compact(
      summary({ a: { "2026-01-04": { link: 2, pub: 1 }, "2026-01-19": { link: 3 }, "2026-02-02": { portal: 5 } } }),
      now,
    );
    expect(out.docs["a"]).toEqual({ "2026-01": { link: 5, pub: 1 }, "2026-02": { portal: 5 } });
  });

  it("drops the time of day, because the key no longer names a day", () => {
    const out = compact(summary({ a: { "2026-01-04": { link: 1, t: "14:02:07" } } }), now);
    expect(out.docs["a"]!["2026-01"]!.t).toBeUndefined();
  });

  it("merges into a month that already exists rather than replacing it", () => {
    const out = compact(summary({ a: { "2026-01": { link: 10 }, "2026-01-04": { link: 1 } } }), now);
    expect(out.docs["a"]).toEqual({ "2026-01": { link: 11 } });
  });

  it("🔴 the boundary is the sync's own timestamp, so merging twice is byte-identical", () => {
    // Compacting against the Worker's clock would make the same payload produce different output
    // depending on when it landed, and the idempotence guarantee would hold only within a day.
    const s = summary({ a: { "2026-01-04": { link: 1 } } });
    expect(JSON.stringify(compact(s, now))).toBe(JSON.stringify(compact(compact(s, now), now)));
  });

  it("keeps totals identical across the boundary", () => {
    const doc = { id: "a", createdAt: "2020-01-01T00:00:00.000Z" };
    const s = summary({ a: { "2026-01-04": { link: 2 }, "2026-07-28": { link: 3 } } });
    expect(statsFor(compact(s, now), doc)?.views).toBe(statsFor(s, doc)?.views);
  });
});

// ---------------------------------------------------------------------------

describe("parseViewSummary — the payload is rebuilt, never trusted", () => {
  it("accepts a well-formed summary", () => {
    expect(parseViewSummary(payload("abc"))).toMatchObject({ v: SUMMARY_VERSION, syncedAt: SYNCED });
  });

  it("drops fields it did not validate rather than passing them through", () => {
    // This lands inside an MCP response. An owner bearer is exactly what a leaked token is, so
    // "our own CLI sent it" is not a validation strategy. It matters more under v2 than v1: the
    // payload now instructs the Worker to DELETE stored buckets by declaring a window.
    const parsed = parseViewSummary(
      payload("abc", { "2026-07-28": { link: 1, viewer: "cfo@acme.com", nested: { x: 1 } } as Bucket }),
    );
    expect(JSON.stringify(parsed)).not.toContain("cfo@acme.com");
    expect(Object.keys(parsed.docs["abc"]!["2026-07-28"]!)).toEqual(["link"]);
  });

  it.each([
    ["a non-object body", "nope"],
    ["a missing syncedAt", { coverage: COVERAGE, docs: {} }],
    ["an unparseable syncedAt", { syncedAt: "last Tuesday", coverage: COVERAGE, docs: {} }],
    ["a missing coverage", { syncedAt: SYNCED, docs: {} }],
    ["a coverage that is not dates", { syncedAt: SYNCED, coverage: { from: 1, to: 2 }, docs: {} }],
    ["a backwards coverage", { syncedAt: SYNCED, coverage: { from: "2026-07-01", to: "2026-06-01" }, docs: {} }],
    ["a missing docs map", { syncedAt: SYNCED, coverage: COVERAGE }],
    ["docs as an array", { syncedAt: SYNCED, coverage: COVERAGE, docs: [] }],
    ["a bucket key that is not a date", payload("a", { yesterday: { link: 1 } } as never)],
    ["a negative count", payload("a", { "2026-07-28": { link: -1 } })],
    ["a non-numeric count", payload("a", { "2026-07-28": { link: "many" } as never })],
    ["a malformed time", payload("a", { "2026-07-28": { link: 1, t: "9am" } })],
  ])("refuses %s", (_label, body) => {
    expect(() => parseViewSummary(body)).toThrow();
  });

  it("🔴 keeps an absent owner split absent rather than coercing it to zero", () => {
    const parsed = parseViewSummary(payload("a", { "2026-07-28": { link: 1 } }));
    expect("owner" in parsed.docs["a"]!["2026-07-28"]!).toBe(false);
    // Present-and-zero is a different statement and must survive as one.
    const known = parseViewSummary(payload("a", { "2026-07-28": { link: 1, owner: 0 } }));
    expect(known.docs["a"]!["2026-07-28"]!.owner).toBe(0);
  });

  it("does not store a bucket that records nothing", () => {
    // Sparse means sparse. A row saying "no views on this day" is what absence already says, and
    // storing it is how a sparse structure quietly becomes a dense one.
    const parsed = parseViewSummary(payload("a", { "2026-07-28": { t: "09:00:00" } }));
    expect(parsed.docs["a"]).toBeUndefined();
  });

  it("refuses an oversized summary rather than storing a truncation", () => {
    const docs: Record<string, unknown> = {};
    for (let i = 0; i < 4000; i++) {
      docs[`doc${i}`] = Object.fromEntries(
        Array.from({ length: 90 }, (_, d) => [`2026-${((d % 12) + 1).toString().padStart(2, "0")}-${((d % 28) + 1).toString().padStart(2, "0")}`, { link: 3, t: "09:00:00" }]),
      );
    }
    expect(() => parseViewSummary({ v: SUMMARY_VERSION, syncedAt: SYNCED, coverage: COVERAGE, docs, portals: {} })).toThrow(/too|bytes/i);
  });

  it("stays well under its ceiling for a realistic corpus", () => {
    // 100 documents each opened on 30 distinct days — measured, not assumed. The ceiling is not
    // reached until roughly 250 documents each opened on 90 DISTINCT days.
    const docs: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      docs[`k3x9mq2vb7p${i}`] = Object.fromEntries(
        Array.from({ length: 30 }, (_, d) => [`2026-07-${(d + 1).toString().padStart(2, "0")}`, { portal: 3, t: "09:00:00" }]),
      );
    }
    const parsed = parseViewSummary({ v: SUMMARY_VERSION, syncedAt: SYNCED, coverage: COVERAGE, docs, portals: {} });
    expect(new TextEncoder().encode(JSON.stringify(parsed)).byteLength).toBeLessThan(MAX_SUMMARY_BYTES / 2);
  });
});

// ---------------------------------------------------------------------------

describe("POST /api/views/summary", () => {
  it("stores a summary and reports what it took", async () => {
    const id = await publishOld("Sync Target");
    const res = await postSummary(payload(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, syncedAt: SYNCED, coverage: COVERAGE, documents: 1 });
  });

  it("🔴 merges across requests rather than replacing the key", async () => {
    const id = await publishOld("Accumulates");
    await postSummary(payload(id, { "2026-05-04": { link: 3 } }, { coverage: { from: "2026-05-01", to: "2026-05-31" } }));
    await postSummary(payload(id, { "2026-06-09": { pub: 5 } }, { coverage: { from: "2026-06-01", to: "2026-06-30" } }));

    expect((await getDoc(id))["views"]).toBe(8);
  });

  it("🔴 ?reset=true clears the history first — the one named escape hatch", async () => {
    // Append-only with no way out is how a bad history becomes permanent.
    const id = await publishOld("Reset Me");
    await postSummary(payload(id, { "2026-05-04": { link: 3 } }, { coverage: { from: "2026-05-01", to: "2026-05-31" } }));
    const res = await postSummary(payload(id, { "2026-06-09": { pub: 5 } }, { coverage: { from: "2026-06-01", to: "2026-06-30" } }), "?reset=true");

    expect(await res.json()).toMatchObject({ reset: true });
    expect((await getDoc(id))["views"]).toBe(5);
    expect((await stored()).docs[id]!["2026-05-04"]).toBeUndefined();
  });

  it("refuses an unauthenticated write", async () => {
    // The metrics are client-behaviour data about a consulting engagement. The endpoint is
    // owner-bearer only, like every /api route.
    const res = await SELF.fetch(`${HOST}/api/views/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload("abc")),
    });
    expect(res.status).toBe(401);
  });

  it("answers 400 on a malformed payload, with the field named", async () => {
    const res = await postSummary({ syncedAt: SYNCED, docs: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_field" });
  });

  it("answers 413 when the summary would not fit, and stores nothing", async () => {
    const id = await publishOld("Still Here");
    await postSummary(payload(id));

    const docs: Record<string, unknown> = {};
    for (let i = 0; i < 4000; i++) {
      docs[`doc${i}`] = Object.fromEntries(
        Array.from({ length: 90 }, (_, d) => [`2026-${((d % 12) + 1).toString().padStart(2, "0")}-${((d % 28) + 1).toString().padStart(2, "0")}`, { link: 3, t: "09:00:00" }]),
      );
    }
    const res = await postSummary({ v: SUMMARY_VERSION, syncedAt: SYNCED, coverage: COVERAGE, docs, portals: {} });
    expect(res.status).toBe(413);
    // A refusal must not have eaten the history on its way out.
    expect((await getDoc(id))["views"]).toBe(3);
  });

  it("is write-only — there is no GET that hands the metrics back on their own", async () => {
    const res = await SELF.fetch(`${HOST}/api/views/summary`, { headers: auth });
    expect(res.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------

describe("the API joins metrics onto documents", () => {
  it("omits the fields entirely before any sync", async () => {
    const id = await publishOld("Never Synced");
    const doc = await getDoc(id);
    expect(doc["views"]).toBeUndefined();
    expect(doc["viewsSyncedAt"]).toBeUndefined();

    const list = await listDocs();
    expect(list.viewsSyncedAt).toBeUndefined();
    expect(list.docs.every((d) => d["views"] === undefined)).toBe(true);
  });

  it("carries counts, surfaces and the staleness stamp once synced", async () => {
    const id = await publishOld("Synced Doc");
    await postSummary(payload(id));

    expect(await getDoc(id)).toMatchObject({
      views: 3,
      lastViewedAt: "2026-07-28T09:00:00.000Z",
      surfaces: { link: 2, public: 0, portal: 1 },
      viewsSyncedAt: SYNCED,
    });

    const list = await listDocs();
    expect(list.viewsSyncedAt).toBe(SYNCED);
    // Coverage replaces windowDays: the counts are everything measured since the first sync, so a
    // day count could only mislead about what they include.
    expect(list.viewsCoverage).toEqual(COVERAGE);
    expect(list.docs.find((d) => d["id"] === id)).toMatchObject({ views: 3 });
  });

  it("reports a measured zero for a document the summary does not mention", async () => {
    const quiet = await publishOld("Nobody Opened This");
    const other = await publishOld("Something Else");
    await postSummary(payload(other));

    expect(await getDoc(quiet)).toMatchObject({ views: 0, surfaces: { link: 0, public: 0, portal: 0 } });
  });

  it("says nothing about a document published since the sync", async () => {
    // Not zero. It was not in the window, so there is no honest number to give.
    const { meta } = await publishDocument(env, { title: "Published After", source: "<h1>after</h1>" });
    await postSummary({ v: SUMMARY_VERSION, syncedAt: "2020-01-01T00:00:00.000Z", coverage: { from: "2019-10-01", to: "2020-01-01" }, docs: {}, portals: {} });

    expect((await getDoc(meta.id))["views"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("🔴 syncRisk — alarm on risk, not on age (ADR-023 §9)", () => {
  const NOW = "2026-08-07T12:00:00.000Z";
  const at = (to: string) =>
    ({ v: SUMMARY_VERSION, syncedAt: NOW, coverage: { from: "2026-01-01", to }, docs: {}, portals: {} }) as ViewSummary;

  it("says nothing has been captured, not that nothing is at risk", () => {
    // "0 days at risk" reads as "you are up to date", which is the opposite of true: everything is
    // uncaptured and none of it is safe.
    expect(syncRisk(null, NOW)).toMatchObject({ state: "never", capturedThrough: null, daysUntilLoss: null });
  });

  it("is quiet when captured through today", () => {
    expect(syncRisk(at("2026-08-07"), NOW)).toMatchObject({ state: "ok", uncapturedDays: 0, daysUntilLoss: null });
  });

  it("counts the uncaptured days and the runway on the oldest of them", () => {
    // Captured through the 1st: the 2nd through the 7th are waiting — six days — and the 2nd is
    // the one with the least runway.
    expect(syncRisk(at("2026-08-01"), NOW)).toMatchObject({ state: "ok", uncapturedDays: 6, daysUntilLoss: 85, lostDays: 0 });
  });

  it("warns with a month of runway left, and escalates inside ten days", () => {
    // 90/3 and 90/9 — fractions of the horizon rather than fixed counts, so the thresholds move
    // with it instead of quietly meaning something different if retention ever changes.
    expect(syncRisk(at("2026-05-28"), NOW)).toMatchObject({ state: "warn", daysUntilLoss: 20 });
    expect(syncRisk(at("2026-05-13"), NOW)).toMatchObject({ state: "urgent", daysUntilLoss: 5 });
  });

  it("🔴 reports what is already gone, and that it is still going", () => {
    // Captured through 2026-04-01, so 2026-04-02 is the oldest uncaptured day — 127 days before
    // today, 37 days past the horizon. Those 37 days are not coming back.
    const risk = syncRisk(at("2026-04-01"), NOW);
    expect(risk.state).toBe("losing");
    expect(risk.lostDays).toBe(37);
    expect(risk.daysUntilLoss).toBe(-37);
  });

  it("treats the horizon itself as the last safe day, not the first lost one", () => {
    // Exactly 90 days of runway remaining is still zero days lost.
    const risk = syncRisk(at("2026-05-08"), NOW);
    expect(risk.lostDays).toBe(0);
    expect(risk.daysUntilLoss).toBe(0);
    expect(risk.state).toBe("urgent");
  });

  it("rides along on the listing, so every reader gets the same answer", async () => {
    // Computed in the Worker rather than by each reader: the CLI, the console panel and the MCP
    // tool need one horizon calculation, not three that can disagree about when history goes.
    const list = await listDocs();
    expect((list as unknown as { viewsRisk: { state: string } }).viewsRisk.state).toBe("never");
  });
});

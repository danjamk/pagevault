import assert from "node:assert/strict";
import test from "node:test";
import { formatReferrers, formatRollup, formatViews, summarizeReferrers, summarizeViews } from "./lib/views.mjs";

/**
 * The rendering half of `views`. The query half needs the network and is exercised by running
 * the command; these cover the parts that rot silently — the anonymous-surface rendering, and
 * the empty case that must not read as "nobody opened anything".
 */

const row = (over = {}) => ({
  portal: "acme",
  doc: "k3x9mq2vb7pd",
  title: "Q3 Review",
  surface: "portal",
  viewer: "cfo@acme.com",
  views: 3,
  lastView: "2026-07-22T21:14:05Z",
  ...over,
});

test("renders a viewer on the Access-gated surface", () => {
  const out = formatViews({ days: 30, rows: [row()] }, null);
  assert.match(out, /cfo@acme\.com/);
  assert.match(out, /Q3 Review/);
});

test("renders a dash, not 'anonymous', where there was never an identity", () => {
  // Nothing was withheld on /pub and /p — there is no Access app in front of them, so no
  // identity ever existed. "anonymous" would imply we dropped something we had.
  const out = formatViews({ days: 30, rows: [row({ surface: "public", viewer: null })] }, null);
  assert.match(out, /—/);
  assert.doesNotMatch(out, /anonymous/i);
});

test("totals views rather than counting rows", () => {
  const out = formatViews(
    { days: 7, rows: [row({ views: 5 }), row({ doc: "other", views: 2 })] },
    null,
  );
  assert.match(out, /7 views across 2 documents/);
});

test("says nothing was recorded, and why that might be", () => {
  const out = formatViews({ days: 30, rows: [] }, null);
  assert.match(out, /No views recorded in the last 30 days/);
  // An empty table would read as "your clients ignored you". Say the retention window instead.
  assert.match(out, /3 months/);
});

test("singularises every count, in both the empty and populated summaries", () => {
  assert.match(formatViews({ days: 1, rows: [] }, null), /last 1 day\./);
  // The populated summary is a second, separately-built sentence — it read "last 1 days"
  // until the day count went through the same helper as the others.
  assert.match(formatViews({ days: 1, rows: [row({ views: 1 })] }, null), /1 view across 1 document, last 1 day\./);
  assert.match(formatViews({ days: 30, rows: [row({ views: 2 })] }, null), /2 views across 1 document, last 30 days\./);
});

test("warns that the dataset outlives the deployment, every time it shows rows", () => {
  // #129: the dataset is account-level, so after a teardown and rebuild these rows can name
  // documents the current deployment never created. The note exists because someone hit exactly
  // that and reasonably read the output as current. Unpinned, it is one tidy-up away from gone.
  const out = formatViews({ days: 30, rows: [row()] }, null);
  assert.match(out, /outlives any single deployment/);
  assert.match(out, /pagevault list/);
  // Unconditional on purpose — `upgrade` redeploys, so a "predates this deployment" test would
  // fire on nearly every run and train the reader to skip it.
  assert.match(formatViews({ days: 1, rows: [row({ views: 1 })] }, null), /outlives any single deployment/);
});

// ---------------------------------------------------------------------------
// summarizeViews — the day buckets the Worker merges (#161, ADR-023)
// ---------------------------------------------------------------------------

const SYNCED = "2026-07-29T12:00:00.000Z";
const COVERAGE = { from: "2026-05-01", to: "2026-07-29" };

const brow = (over = {}) => ({
  portal: "acme",
  doc: "k3x9mq2vb7pd",
  surface: "portal",
  viewer: "cfo@acme.com",
  kind: "document",
  day: "2026-07-28",
  views: 3,
  lastView: "2026-07-28T21:14:05Z",
  ...over,
});

const sum = (rows, opts = {}) =>
  summarizeViews({ coverage: COVERAGE, rows }, { syncedAt: SYNCED, ...opts });

test("buckets a document's views by day, keyed by the stored surface names", () => {
  const { summary } = sum([
    brow({ views: 2, surface: "portal" }),
    brow({ views: 4, surface: "link", viewer: null }),
    brow({ day: "2026-07-29", views: 1, surface: "public", viewer: null }),
  ]);

  assert.deepEqual(Object.keys(summary.docs["k3x9mq2vb7pd"]).sort(), ["2026-07-28", "2026-07-29"]);
  assert.equal(summary.docs["k3x9mq2vb7pd"]["2026-07-28"].portal, 2);
  assert.equal(summary.docs["k3x9mq2vb7pd"]["2026-07-28"].link, 4);
  // `pub`, not `public` — the stored key differs from the query's surface name.
  assert.equal(summary.docs["k3x9mq2vb7pd"]["2026-07-29"].pub, 1);
});

test("stamps v2 and carries the coverage window the Worker clears by", () => {
  const { summary } = sum([brow()]);
  assert.equal(summary.v, 2);
  assert.deepEqual(summary.coverage, COVERAGE);
  assert.equal(summary.syncedAt, SYNCED);
});

test("keeps only the time of day — the date is already the key", () => {
  const { summary } = sum([brow({ lastView: "2026-07-28T21:14:05Z" }), brow({ lastView: "2026-07-28 09:00:00" })]);
  assert.equal(summary.docs["k3x9mq2vb7pd"]["2026-07-28"].t, "21:14:05");
});

test("normalizes Analytics Engine's DateTime before comparing times", () => {
  // AE returns ClickHouse DateTime ("2026-07-28 09:00:00"). Left unnormalized the slice would cut
  // in the wrong place and the later view would lose.
  const { summary } = sum([brow({ lastView: "2026-07-28 23:00:00" }), brow({ lastView: "2026-07-28T09:00:00Z" })]);
  assert.equal(summary.docs["k3x9mq2vb7pd"]["2026-07-28"].t, "23:00:00");
});

test("carries no viewer identity into the summary, on any surface", () => {
  // ADR-019 decision 4. The rows have emails; what MCP serves must not.
  const { summary } = sum([brow(), brow({ doc: "b", viewer: "ceo@acme.com" })], { ownerEmail: "me@example.com" });
  assert.doesNotMatch(JSON.stringify(summary), /@acme\.com/);
});

test("🔴 splits owner views out of portal views, where an identity exists", () => {
  const { summary } = sum(
    [
      brow({ views: 2, surface: "portal", viewer: "me@example.com" }),
      brow({ views: 5, surface: "portal", viewer: "cfo@acme.com" }),
    ],
    { ownerEmail: "Me@Example.com" },
  );
  const b = summary.docs["k3x9mq2vb7pd"]["2026-07-28"];
  assert.equal(b.portal, 7, "the surface total still counts every portal view");
  assert.equal(b.owner, 2, "and the owner's share is named, case-insensitively");
});

test("🔴 leaves the owner split ABSENT when this machine does not know the address", () => {
  // ADR-023 §7: absent, never guessed. A wrong attribution is worse than a missing one, and the
  // Worker reads absent as "not measured" rather than as zero.
  const { summary } = sum([brow({ surface: "portal" })], { ownerEmail: "" });
  assert.equal("owner" in summary.docs["k3x9mq2vb7pd"]["2026-07-28"], false);
});

test("records a known zero as zero — nobody but the client opened it", () => {
  // Present-and-zero is a real statement and must survive as one.
  const { summary } = sum([brow({ surface: "portal", viewer: "cfo@acme.com" })], { ownerEmail: "me@example.com" });
  assert.equal(summary.docs["k3x9mq2vb7pd"]["2026-07-28"].owner, 0);
});

test("never attributes an anonymous surface to the owner", () => {
  // /pub and /p have no Access application, so a view through them is neither owner nor client.
  // Claiming otherwise would be exactly the guess decision 7 rules out.
  const { summary } = sum([brow({ surface: "link", viewer: null })], { ownerEmail: "me@example.com" });
  assert.equal("owner" in summary.docs["k3x9mq2vb7pd"]["2026-07-28"], false);
});

test("🔴 portal landings never enter a document's history", () => {
  const { summary } = sum([brow({ views: 3 }), brow({ doc: "", kind: "index", views: 40 })]);
  assert.deepEqual(Object.keys(summary.docs), ["k3x9mq2vb7pd"]);
  assert.equal(summary.docs["k3x9mq2vb7pd"]["2026-07-28"].portal, 3);
});

test("skips ids this deployment never created, and names how many", () => {
  const { summary, skipped } = sum([brow(), brow({ doc: "ghostdoc1234" }), brow({ doc: "ghostdoc1234", day: "2026-07-27" })], {
    knownIds: new Set(["k3x9mq2vb7pd"]),
  });
  assert.deepEqual(Object.keys(summary.docs), ["k3x9mq2vb7pd"]);
  // Deduped by document, not per row — two days of one dead document is one document.
  assert.deepEqual(skipped, ["ghostdoc1234"]);
});

test("keeps every document when no id set is supplied", () => {
  const { summary, skipped } = sum([brow(), brow({ doc: "ghostdoc1234" })]);
  assert.equal(Object.keys(summary.docs).length, 2);
  assert.deepEqual(skipped, []);
});

test("🔴 emits nothing for a day that recorded no surface", () => {
  // Sparse has to be BUILT, not merely validated. Shipping an empty bucket for the Worker to drop
  // means the wire payload is dense even when the stored value is not.
  const { summary } = sum([brow({ surface: "carrier-pigeon" })]);
  assert.deepEqual(JSON.parse(JSON.stringify(summary.docs)), {});
});

test("an empty result is a valid summary, not a failure", () => {
  const { summary } = sum([]);
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), { v: 2, syncedAt: SYNCED, coverage: COVERAGE, docs: {}, portals: {} });
});

// ---------------------------------------------------------------------------
// summarizeReferrers — the per-portal rollup
// ---------------------------------------------------------------------------

test("rolls referrers up per portal, with direct kept as its own host", () => {
  const portals = summarizeReferrers({
    sources: [
      { portal: "acme", referrer: "linkedin.com", views: 4 },
      { portal: "acme", referrer: null, views: 2 },
      { portal: "marketing", referrer: "linkedin.com", views: 9 },
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(portals)), { acme: { "linkedin.com": 4, "": 2 }, marketing: { "linkedin.com": 9 } });
});

test("an empty source list is an empty rollup, not a crash", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(summarizeReferrers({}))), {});
  assert.deepEqual(JSON.parse(JSON.stringify(summarizeReferrers({ sources: [] }))), {});
});

test("columns line up even when a cell carries ANSI", () => {
  const colour = { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => s };
  const out = formatViews({ days: 30, rows: [row({ viewer: null }), row({ doc: "b", title: "A much longer title" })] }, colour);
  const [head, first, second] = out.split("\n");
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  // The dimmed dash must not widen its column — width is measured on visible characters.
  assert.equal(strip(first).indexOf("acme"), strip(head).indexOf("PORTAL"));
  assert.equal(strip(second).indexOf("acme"), strip(head).indexOf("PORTAL"));
});

// ---------------------------------------------------------------------------
// The new blob positions (ADR-023, decisions 5, 6 and 8)
// ---------------------------------------------------------------------------

const index = (over = {}) => row({ doc: "", title: "", viewer: null, kind: "index", ...over });

test("an index row is skipped on its kind, not on its empty document id", () => {
  // Belt and braces: an index event that somehow carried an id must still not become a document.
  const { summary } = sum([index({ doc: "k3x9mq2vb7pd", views: 9 })]);
  assert.deepEqual(Object.keys(summary.docs), []);
});

test("names the portal index instead of rendering an empty document cell", () => {
  const out = formatViews({ days: 30, rows: [index({ views: 4 })] }, null);
  assert.match(out, /\(portal index\)/);
});

test("counts landings apart from document views, in both directions", () => {
  const out = formatViews({ days: 30, rows: [row({ views: 3 }), index({ views: 40 })] }, null);
  // 43 across 2 documents would be wrong twice: one of them is not a document, and 40 of the
  // views are of a collection page.
  assert.match(out, /3 views across 1 document, last 30 days\./);
  assert.match(out, /40 portal landings/);
  assert.doesNotMatch(out, /43 views/);
});

test("says nothing about landings when there were none", () => {
  const out = formatViews({ days: 30, rows: [row()] }, null);
  assert.doesNotMatch(out, /portal landing/);
});

test("singularises a lone landing", () => {
  const out = formatViews({ days: 30, rows: [index({ views: 1 })] }, null);
  assert.match(out, /1 portal landing —/);
});

// ---------------------------------------------------------------------------
// formatReferrers — where the traffic came from
// ---------------------------------------------------------------------------

const src = (over = {}) => ({ portal: "acme", referrer: "linkedin.com", views: 12, ...over });

test("renders hosts with their counts", () => {
  const out = formatReferrers({ days: 30, sources: [src(), src({ referrer: "t.co", views: 4 })] }, null);
  assert.match(out, /linkedin\.com/);
  assert.match(out, /t\.co/);
  assert.match(out, /12/);
});

test("labels an absent referrer 'direct' — a measurement, not a gap", () => {
  // queryReferrers only returns rows written after the field existed, so a blank referrer means
  // the browser sent none. That is a fact about the visit, not a hole in the data.
  const out = formatReferrers({ days: 30, sources: [src({ referrer: null, views: 7 })] }, null);
  assert.match(out, /direct/);
});

test("returns nothing at all when there are no sources, so the caller can drop the block", () => {
  assert.equal(formatReferrers({ days: 30, sources: [] }, null), "");
  assert.equal(formatReferrers({ days: 30, sources: undefined }, null), "");
});

test("🔴 says the host is all there is, and that previews inflate it", () => {
  // Both notes are load-bearing. The first is the privacy promise (decision 5) stated where an
  // operator reads the data; the second stops "why does this public page have 400 views" from
  // being filed as a bug.
  const out = formatReferrers({ days: 7, sources: [src()] }, null);
  assert.match(out, /never the page it linked from/);
  assert.match(out, /previews and unfurls are counted/i);
  assert.match(out, /last 7 days/);
});

test("columns line up in the sources table when a cell carries ANSI", () => {
  const colour = { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => s };
  const out = formatReferrers({ days: 30, sources: [src({ referrer: null }), src({ referrer: "mail.google.com" })] }, colour);
  const [head, first, second] = out.split("\n");
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(strip(first).indexOf("acme"), strip(head).indexOf("PORTAL"));
  assert.equal(strip(second).indexOf("acme"), strip(head).indexOf("PORTAL"));
});

// ---------------------------------------------------------------------------
// The stored-summary rollup — the DEFAULT read since ADR-025 (#168, #162)
// ---------------------------------------------------------------------------
//
// A formatter over a shape the Worker computes, so what is worth pinning here is what the shape
// CANNOT honour. Each of these is a number that would be wrong if rendered without its caveat, and
// wrong in the direction that reads as fact.

const OK_RISK = { state: "ok", capturedThrough: "2026-08-09", uncapturedDays: 0, daysUntilLoss: null, lostDays: 0 };

const rollupFixture = (over = {}) => ({
  window: { from: "2026-08-01", to: "2026-08-09" },
  syncedAt: "2026-08-09T12:00:00.000Z",
  coverage: { from: "2026-05-11", to: "2026-08-09" },
  risk: OK_RISK,
  recording: true,
  state: "ok",
  total: { views: 12, surfaces: { link: 8, public: 1, portal: 3 }, owner: 1 },
  byDoc: [
    { id: "a", portal: "acme", title: "Q3 Review", views: 9, surfaces: { link: 8, public: 1, portal: 0 }, owner: null, lastViewedAt: "2026-08-08T14:02:00.000Z" },
    { id: "b", portal: "globex", title: "Brief", views: 3, surfaces: { link: 0, public: 0, portal: 3 }, owner: 1, lastViewedAt: "2026-08-09T08:00:00.000Z" },
    { id: "c", portal: "acme", title: "Never Opened", views: 0, surfaces: { link: 0, public: 0, portal: 0 }, owner: null, lastViewedAt: null },
  ],
  byPortal: [
    { portal: "acme", views: 9, surfaces: { link: 8, public: 1, portal: 0 }, docs: 1 },
    { portal: "globex", views: 3, surfaces: { link: 0, public: 0, portal: 3 }, docs: 1 },
  ],
  byDay: [
    { key: "2026-04", granularity: "month", views: 30 },
    { key: "2026-08-08", granularity: "day", views: 9 },
    { key: "2026-08-09", granularity: "day", views: 3 },
  ],
  byReferrer: [{ host: "", views: 6 }, { host: "news.ycombinator.com", views: 4 }],
  scope: { referrers: "undated", monthlyBuckets: 1, portalIndex: "not-stored" },
  ...over,
});

test("🔴 never-synced says no history captured, never an empty table", () => {
  // An empty table reads as "nobody visited". Nothing has been measured at all.
  const out = formatRollup(rollupFixture({ state: "never-synced", syncedAt: null, byDoc: [], byPortal: [], byDay: [], byReferrer: [] }), null);
  assert.match(out, /No history captured yet/);
  assert.match(out, /pagevault sync-views/);
  assert.doesNotMatch(out, /VIEWS/, "no table at all — there is nothing to tabulate");
});

test("🔴 not recording is not zero views — and stored history stays true", () => {
  const out = formatRollup(rollupFixture({ state: "not-recording" }), null);
  assert.match(out, /not recording views/);
  assert.match(out, /measured before it was turned off/);
  assert.match(out, /upgrade --analytics/);
});

test("every breakdown states the source and when it was synced", () => {
  // A number whose provenance is unstated reads as current at exactly the moment it is not.
  for (const by of ["doc", "portal", "day", "referrer"]) {
    const out = formatRollup(rollupFixture(), null, { by });
    assert.match(out, /Source: the stored summary, synced 2026-08-09 12:00/, `--by ${by}`);
    assert.match(out, /Not live/, `--by ${by}`);
  }
});

test("--by doc is one row per document, with a measured zero kept visible", () => {
  const out = formatRollup(rollupFixture(), null, { by: "doc" });
  assert.match(out, /9 +Q3 Review +acme/);
  // "They had the chance and never opened it" is the useful answer, not a row to hide.
  assert.match(out, /0 +Never Opened/);
});

test("--by portal totals the client, not the document", () => {
  const out = formatRollup(rollupFixture(), null, { by: "portal" });
  assert.match(out, /^VIEWS +PORTAL +DOCS/m);
  assert.match(out, /9 +acme +1/);
  assert.doesNotMatch(out, /Q3 Review/, "the document table is a different question");
});

test("--by day draws the shape, and labels a compacted bucket as a month", () => {
  const out = formatRollup(rollupFixture(), null, { by: "day" });
  assert.match(out, /2026-08-08 +9 +▇/);
  // A monthly bucket cannot be attributed to a day, and must not silently look like one.
  assert.match(out, /2026-04 .*\(month\)/);
  // Scaled to the busiest bar, so the biggest day is the longest.
  const bars = out.split("\n").filter((l) => l.includes("▇")).map((l) => (l.match(/▇/g) ?? []).length);
  assert.equal(Math.max(...bars), bars[0], "the month at 30 views is the peak");
});

test("🔴 --by referrer refuses to imply the window applies to an UNDATED series", () => {
  // A summary with no dated referrer series has nothing to filter on, so a windowed heading over it
  // would be a wrong number rather than a narrow one — the breakdown where that is easiest to do.
  const out = formatRollup(rollupFixture(), null, { by: "referrer" });
  assert.match(out, /IGNORE it/);
  assert.doesNotMatch(out, /2026-08-01 to 2026-08-09\./, "no windowed total beside undated sources");
  assert.match(out, /6 +direct/, "an absent referrer is 'direct' — measured, not missing");
});

test("🔴 --by referrer drops the warning once the series IS dated", () => {
  // Conditional, not decoration. Printing it unconditionally is how the old ALL-TIME claim stayed
  // wrong about its own data for so long (#221).
  const r = rollupFixture();
  r.scope.referrers = "windowed";
  const out = formatRollup(r, null, { by: "referrer" });
  assert.doesNotMatch(out, /IGNORE it/);
  assert.match(out, /cover the same window/);
});

test("the sources block rides along under --by doc only", () => {
  assert.match(formatRollup(rollupFixture(), null, { by: "doc" }), /SOURCES/);
  assert.doesNotMatch(formatRollup(rollupFixture(), null, { by: "portal" }), /SOURCES/);
});

test("monthly buckets are declared, so a missing day is not read as a gap", () => {
  assert.match(formatRollup(rollupFixture(), null), /1 bucket older than 90 days are monthly/);
});

test("a sync-risk verdict is surfaced with the command that fixes it", () => {
  const risk = { state: "urgent", capturedThrough: "2026-05-01", uncapturedDays: 12, daysUntilLoss: 3, lostDays: 0 };
  const out = formatRollup(rollupFixture({ risk }), null);
  assert.match(out, /12 days of history becomes unrecoverable in 3 days/);
  assert.match(out, /pagevault sync-views/);
});

test("an empty breakdown says which one was empty, in its own words", () => {
  const bare = rollupFixture({ state: "empty", total: { views: 0, surfaces: { link: 0, public: 0, portal: 0 }, owner: null }, byDoc: [], byPortal: [], byDay: [], byReferrer: [] });
  assert.match(formatRollup(bare, null, { by: "day" }), /No day between .* recorded a view/);
  assert.match(formatRollup(bare, null, { by: "referrer" }), /No referrers recorded/);
});

test("--by surface names the door, not just the key", () => {
  // "link 50" is meaningless until you know a link is a /p/ capability URL that opens with no
  // login. That distinction is the one an operator most needs when reading their own numbers, so
  // the column carries it rather than assuming the reader remembers the vocabulary.
  const out = formatRollup(rollupFixture(), null, { by: "surface" });
  assert.match(out, /8 +link +a \/p\/ capability URL/);
  assert.match(out, /3 +portal +signed in/);
  assert.match(out, /1 +public +a listed public portal page/);
  // Surfaces are a total, not a per-document list — the document table is a different question.
  assert.doesNotMatch(out, /Q3 Review/);
});

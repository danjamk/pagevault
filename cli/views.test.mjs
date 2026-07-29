import assert from "node:assert/strict";
import test from "node:test";
import { formatViews, summarizeViews } from "./lib/views.mjs";

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
// summarizeViews — the aggregation MCP serves (#127, ADR-019)
// ---------------------------------------------------------------------------

const SYNCED = "2026-07-29T12:00:00.000Z";
const sum = (rows, opts = {}) => summarizeViews({ days: 90, rows }, { syncedAt: SYNCED, ...opts });

test("totals a document's views across every surface and viewer", () => {
  // One document, three rows: the same person through the portal twice, a stranger through the
  // public link. The rows are grouped per (doc, surface, viewer), so summing rows is the job.
  const { summary } = sum([
    row({ views: 2, surface: "portal", viewer: "cfo@acme.com" }),
    row({ views: 1, surface: "portal", viewer: "cto@acme.com" }),
    row({ views: 4, surface: "link", viewer: null }),
  ]);

  assert.deepEqual(summary.docs["k3x9mq2vb7pd"], {
    views: 7,
    lastViewedAt: "2026-07-22T21:14:05Z",
    surfaces: { link: 4, public: 0, portal: 3 },
  });
});

test("carries no viewer identity into the summary, on any surface", () => {
  // ADR-019 decision 4. The rows have emails; what MCP serves must not. This is the assertion
  // that would catch a well-meaning "it'd be handy to know who" refactor.
  const { summary } = sum([row({ viewer: "cfo@acme.com" }), row({ doc: "b", viewer: "ceo@acme.com" })]);
  assert.doesNotMatch(JSON.stringify(summary), /@acme\.com/);
});

test("keeps the latest view, not the last row seen", () => {
  const { summary } = sum([
    row({ lastView: "2026-07-22T21:14:05Z" }),
    row({ lastView: "2026-07-28T09:00:00Z", surface: "link" }),
    row({ lastView: "2026-07-01T09:00:00Z", surface: "public" }),
  ]);
  assert.equal(summary.docs["k3x9mq2vb7pd"].lastViewedAt, "2026-07-28T09:00:00Z");
});

test("normalizes Analytics Engine's DateTime to ISO before comparing", () => {
  // AE returns ClickHouse DateTime ("2026-07-28 09:00:00"), and "2026-07-28 09:00:00" sorts
  // BELOW "2026-07-22T21:14:05Z" as a raw string — the space is 0x20, the T is 0x54. Left
  // unnormalized, the newer view loses and lastViewedAt silently reports the older one.
  const { summary } = sum([
    row({ lastView: "2026-07-22T21:14:05Z" }),
    row({ lastView: "2026-07-28 09:00:00", surface: "link" }),
  ]);
  assert.equal(summary.docs["k3x9mq2vb7pd"].lastViewedAt, "2026-07-28T09:00:00Z");
});

test("drops rows for documents that no longer exist, and names how many", () => {
  // The dataset is account-level and outlives the deployment (#129), so a rebuild leaves rows
  // pointing at ids that `list_documents` will never return.
  const { summary, skipped } = sum(
    [row(), row({ doc: "ghostdoc1234" }), row({ doc: "ghostdoc1234", surface: "link" })],
    { knownIds: new Set(["k3x9mq2vb7pd"]) },
  );

  assert.deepEqual(Object.keys(summary.docs), ["k3x9mq2vb7pd"]);
  // Deduped by document, not counted per row — two rows for one dead document is one document.
  assert.deepEqual(skipped, ["ghostdoc1234"]);
});

test("keeps every document when no id set is supplied", () => {
  const { summary, skipped } = sum([row(), row({ doc: "ghostdoc1234" })]);
  assert.equal(Object.keys(summary.docs).length, 2);
  assert.deepEqual(skipped, []);
});

test("an empty result is a valid summary, not a failure", () => {
  // A deployment nobody has opened yet must still sync. The Worker distinguishes "no summary"
  // from "a summary with no rows" — the second is the honest "measured, nothing opened".
  const { summary } = sum([]);
  // Compared after a JSON round-trip, which is what actually goes over the wire: `docs` is a
  // null-prototype object (so a document id of `__proto__` is a key, not a prototype swap), and
  // deepEqual treats that as unequal to a plain `{}`.
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), { syncedAt: SYNCED, windowDays: 90, docs: {} });
});

test("stamps the window it measured, so the reader knows what zero means", () => {
  const { summary } = summarizeViews({ days: 7, rows: [row()] }, { syncedAt: SYNCED });
  assert.equal(summary.windowDays, 7);
  assert.equal(summary.syncedAt, SYNCED);
});

test("ignores a surface it does not recognise rather than inventing a key", () => {
  // Defensive: surfaces come from the Worker's own writeDataPoint, but the summary shape is a
  // contract with the MCP output schema and must not grow keys from remote data.
  const { summary } = sum([row({ surface: "carrier-pigeon", views: 3 })]);
  assert.deepEqual(summary.docs["k3x9mq2vb7pd"].surfaces, { link: 0, public: 0, portal: 0 });
  // The view still counts — it happened, we just cannot attribute the door.
  assert.equal(summary.docs["k3x9mq2vb7pd"].views, 3);
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

import assert from "node:assert/strict";
import test from "node:test";
import { formatViews } from "./lib/views.mjs";

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

test("columns line up even when a cell carries ANSI", () => {
  const colour = { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => s };
  const out = formatViews({ days: 30, rows: [row({ viewer: null }), row({ doc: "b", title: "A much longer title" })] }, colour);
  const [head, first, second] = out.split("\n");
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  // The dimmed dash must not widen its column — width is measured on visible characters.
  assert.equal(strip(first).indexOf("acme"), strip(head).indexOf("PORTAL"));
  assert.equal(strip(second).indexOf("acme"), strip(head).indexOf("PORTAL"));
});

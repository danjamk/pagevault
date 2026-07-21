//
// The bundle-mode config switch (#86, ADR-014). `applyBundleMode` is the one new piece of deploy
// logic that isn't exercised by a live Cloudflare call — it rewrites a generated wrangler config to
// deploy the prebuilt Worker instead of bundling from src. A silent miss here would deploy a Worker
// that tries to bundle a `src` the installed package doesn't ship, so it's pinned. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyBundleMode, BUNDLE_PATH } from "./context.mjs";

const TEMPLATE = `{
  "name": "pagevault",
  "main": "src/index.ts",
  "no_bundle": false,
  "compatibility_date": "2026-07-01"
}`;

test("bundle mode repoints main at the absolute bundle path and turns no_bundle on", () => {
  const out = applyBundleMode(TEMPLATE, "/abs/cli/dist/worker.js");
  assert.match(out, /"main": "\/abs\/cli\/dist\/worker\.js"/);
  assert.match(out, /"no_bundle": true/);
  assert.doesNotMatch(out, /src\/index\.ts/);
  assert.doesNotMatch(out, /"no_bundle": false/);
});

test("it throws rather than silently ship a src-bundling config if the template drifted", () => {
  // No `main: src/index.ts` to replace → the switch can't take effect → loud failure, not a bad deploy.
  assert.throws(() => applyBundleMode(`{ "no_bundle": false }`, "/abs/worker.js"), /bundle mode/i);
  // No `no_bundle: false` either.
  assert.throws(() => applyBundleMode(`{ "main": "src/index.ts" }`, "/abs/worker.js"), /bundle mode/i);
});

test("BUNDLE_PATH is absolute and points at the shipped worker bundle", () => {
  assert.ok(BUNDLE_PATH.startsWith("/"), "must be absolute — wrangler resolves main relative to the config dir");
  assert.match(BUNDLE_PATH, /cli\/dist\/worker\.js$/);
});

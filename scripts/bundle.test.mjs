//
// The bundle-mode config switch (#86, ADR-014). `applyBundleMode` is the one new piece of deploy
// logic that isn't exercised by a live Cloudflare call — it rewrites a generated wrangler config to
// deploy the prebuilt Worker instead of bundling from src. A silent miss here would deploy a Worker
// that tries to bundle a `src` the installed package doesn't ship, so it's pinned. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute, sep } from "node:path";
import { applyBundleMode, BUNDLE_PATH } from "../cli/lib/provision/context.mjs";

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
  // `isAbsolute`, not `startsWith("/")`: an absolute Windows path begins `C:\`, so the old check
  // failed on the very platform this suite is meant to protect. Same for the trailing-path match —
  // compare with the platform separator, not a hardcoded `/`.
  assert.ok(isAbsolute(BUNDLE_PATH), "must be absolute — wrangler resolves main relative to the config dir");
  assert.ok(BUNDLE_PATH.endsWith(["cli", "dist", "worker.js"].join(sep)), `unexpected bundle path: ${BUNDLE_PATH}`);
});

test("a Windows bundle path survives as valid JSON", () => {
  // The defect: an absolute Windows path is spliced into a JSON document. Raw, `\U` is an invalid
  // escape and `\n` (from `\npm`, `\node_modules`) is a literal newline — so `pagevault init` fails
  // on EVERY Windows machine with a parse error that names neither Windows nor the path.
  const winPath = String.raw`C:\Users\First Last\AppData\Roaming\npm\node_modules\pagevault\dist\worker.js`;
  const out = applyBundleMode(TEMPLATE, winPath);

  const parsed = JSON.parse(out); // the whole point — this threw before the fix
  assert.equal(parsed.main, winPath, "the path must survive the round-trip byte for byte");
  assert.equal(parsed.no_bundle, true);
});

test("a POSIX bundle path is unchanged by the escaping", () => {
  // Guards against fixing Windows by mangling the platform that already worked.
  const out = applyBundleMode(TEMPLATE, "/Users/me/My Drive/cli/dist/worker.js");
  assert.equal(JSON.parse(out).main, "/Users/me/My Drive/cli/dist/worker.js");
  assert.match(out, /"main": "\/Users\/me\/My Drive\/cli\/dist\/worker\.js"/);
});

test("a `$` in the path is inserted literally, not read as a replacement pattern", () => {
  // String.replace treats `$&` in a STRING replacement as "the matched text". With `main` as a
  // literal, `$&` would expand to `"main": "src/index.ts"` and corrupt the config.
  const out = applyBundleMode(TEMPLATE, "/opt/$&/dist/worker.js");
  assert.equal(JSON.parse(out).main, "/opt/$&/dist/worker.js");
});

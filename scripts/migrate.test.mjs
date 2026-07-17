//
// The migration runner (#39): every future .pagevault.json schema change is a registered,
// ordered step, applied deterministically — not ad-hoc patching. These pin that contract with
// synthetic migrations, so the machinery is proven before there's a real v2. Run with
// `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate, SCHEMA_VERSION } from "./context.mjs";

test("a file with no schemaVersion is assumed v1 and stamped to current", () => {
  const out = migrate({ rung: 1, ownerEmail: "a@b.com" });
  assert.equal(out.schemaVersion, SCHEMA_VERSION);
  assert.equal(out.rung, 1); // content preserved
  assert.equal(out.ownerEmail, "a@b.com");
});

test("migrations run in order to reach the target, preserving unrelated fields", () => {
  const migrations = [
    (c) => ({ ...c, one: true }), // v1 -> v2
    (c) => ({ ...c, two: true }), // v2 -> v3
  ];
  const out = migrate({ schemaVersion: 1, keep: "x" }, migrations, 3);
  assert.equal(out.schemaVersion, 3);
  assert.equal(out.one, true);
  assert.equal(out.two, true);
  assert.equal(out.keep, "x");
});

test("a partial file migrates from ITS version forward, not from v1", () => {
  const migrations = [(c) => ({ ...c, v2: true }), (c) => ({ ...c, v3: true })];
  const out = migrate({ schemaVersion: 2 }, migrations, 3);
  assert.equal(out.v2, undefined); // v1 -> v2 skipped, already v2
  assert.equal(out.v3, true); // only v2 -> v3 ran
  assert.equal(out.schemaVersion, 3);
});

test("an already-current file is stamped but untouched", () => {
  const out = migrate({ schemaVersion: 2, a: 1 }, [(c) => ({ ...c, x: 1 })], 2);
  assert.equal(out.schemaVersion, 2);
  assert.equal(out.x, undefined); // no migration applied
  assert.equal(out.a, 1);
});

test("a file from the future fails loud — you're running older code than wrote it", () => {
  assert.throws(() => migrate({ schemaVersion: 99 }, [], 1), /understands only up to/);
});

test("a missing migration step throws rather than silently skipping", () => {
  assert.throws(() => migrate({ schemaVersion: 1 }, [], 2), /No migration registered/);
});

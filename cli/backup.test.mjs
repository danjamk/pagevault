//
// The backup format's one job: preserve KEY METADATA. PageVault's `meta:` and `portal:` keys
// (moved here from scripts/ with the engine in #133 — one code path, both front doors.)
// carry their listing data in metadata, and `store.ts` listDocs()/listPortals() SKIP a
// metadata-less key — so a values-only dump restores documents that are invisible to every
// listing and portal index (spike, 2026-07-16). These tests pin `toEntry` against exactly that
// regression. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { toEntry, defaultOutName } from "./lib/ops/backup.mjs";

test("toEntry preserves key metadata — the listing data lives here", () => {
  const key = { name: "meta:abc", metadata: { title: "Q3 Review", portal: "acme", visibility: "restricted" } };
  const entry = toEntry(key, "<h1>hi</h1>");
  assert.equal(entry.key, "meta:abc");
  assert.equal(entry.value, "<h1>hi</h1>");
  assert.deepEqual(entry.metadata, key.metadata);
});

test("the metadata-less entry is the regression that hides documents — toEntry must not produce it", () => {
  // What a naive values-only dump yields: no metadata. Restore this and store.ts skips the
  // meta: key, so the document lists nowhere. The real toEntry must differ when metadata exists.
  const key = { name: "meta:abc", metadata: { title: "Q3 Review", portal: "acme" } };
  const naive = { key: key.name, value: "<h1>hi</h1>" };
  assert.equal(naive.metadata, undefined);
  assert.notDeepEqual(toEntry(key, "<h1>hi</h1>"), naive);
  assert.ok(toEntry(key, "<h1>hi</h1>").metadata, "metadata must be present");
});

test("toEntry omits metadata for keys that legitimately have none (doc:/pub:)", () => {
  const entry = toEntry({ name: "doc:abc" }, "<h1>body</h1>");
  assert.equal(entry.key, "doc:abc");
  assert.equal("metadata" in entry, false);
});

test("expiration is carried through when present (pub: tokens can expire)", () => {
  const entry = toEntry({ name: "pub:tok", expiration: 1893456000 }, "docid");
  assert.equal(entry.expiration, 1893456000);
});

test("the default filename is the one the restore hint tells you to type", () => {
  // A backup names itself, and then prints `pagevault restore <that name>`. If the name ever grew
  // a character a shell would eat — a colon, a space — the hint would stop being copy-pasteable.
  const name = defaultOutName(new Date("2026-07-24T18:09:31.512Z"));
  assert.equal(name, "pagevault-backup-2026-07-24T18-09-31.json");
  assert.match(name, /^[\w.-]+\.json$/);
});

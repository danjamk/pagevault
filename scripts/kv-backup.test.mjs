//
// The backup format's one job: preserve KEY METADATA. PageVault's `meta:` and `portal:` keys
// carry their listing data in metadata, and `store.ts` listDocs()/listPortals() SKIP a
// metadata-less key — so a values-only dump restores documents that are invisible to every
// listing and portal index (spike, 2026-07-16). These tests pin `toEntry` against exactly that
// regression. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { toEntry } from "./kv-backup.mjs";

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

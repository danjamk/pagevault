//
// The restore decision (#125).
//
// These assert one property above all: `isSampleOnly` must never call real data disposable. A
// false positive here tells an operator mid-disaster that their client's deliverable is a
// throwaway sample — the exact moment they are least able to second-guess the tool.
//
// Run with `node --test cli/restore-plan.test.mjs`, or via `make test-cli`.
//
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SAMPLE_TITLE, onlySampleDocuments, planRestore, summarize } from "./lib/ops/restore-plan.mjs";

/** The keys one published document produces, in the shape the KV list API returns. */
const doc = (id, title, { portal = "default", pub = null } = {}) => [
  { name: `doc:${id}` },
  { name: `raw:${id}` },
  { name: `meta:${id}`, metadata: { title } },
  { name: `idx:${portal}:${id}` },
  ...(pub ? [{ name: `pub:${pub}` }] : []),
];

const SAMPLE = doc("w3lc0m3", SAMPLE_TITLE, { pub: "tok1" });
const REAL = doc("h7d9x2", "Q3 Engineering Review", { portal: "acme" });

describe("planRestore", () => {
  it("finds nothing surviving when the backup covers every live key", () => {
    // The provably-safe case: restore replaces all of it, so no --force should be demanded.
    const plan = planRestore(SAMPLE, SAMPLE.map((k) => k.name));
    assert.equal(plan.surviving.length, 0);
    assert.equal(plan.overwritten, SAMPLE.length);
    assert.equal(plan.isSampleOnly, false, "an empty remainder is not 'a sample'");
  });

  it("separates what is overwritten from what survives", () => {
    const live = [...SAMPLE, ...REAL];
    const plan = planRestore(live, REAL.map((k) => k.name));
    assert.equal(plan.overwritten, REAL.length);
    assert.deepEqual(
      plan.surviving.map((k) => k.name).sort(),
      SAMPLE.map((k) => k.name).sort(),
    );
  });

  it("treats an empty namespace as nothing to decide about", () => {
    const plan = planRestore([], ["doc:anything"]);
    assert.deepEqual(plan.surviving, []);
    assert.equal(plan.overwritten, 0);
    assert.equal(plan.isSampleOnly, false);
  });

  it("accepts the backup keys as a Set or an array", () => {
    const asArray = planRestore(SAMPLE, SAMPLE.map((k) => k.name));
    const asSet = planRestore(SAMPLE, new Set(SAMPLE.map((k) => k.name)));
    assert.deepEqual(asSet, asArray);
  });
});

describe("onlySampleDocuments", () => {
  it("recognises verify's sample, with the portal and link keys that ride along", () => {
    assert.equal(onlySampleDocuments([...SAMPLE, { name: "portal:default" }, { name: "members:default" }]), true);
  });

  it("refuses to call a real document disposable", () => {
    // The failure that matters. Everything else here is a variation on it.
    assert.equal(onlySampleDocuments(REAL), false);
  });

  it("refuses when a real document sits alongside the sample", () => {
    assert.equal(onlySampleDocuments([...SAMPLE, ...REAL]), false);
  });

  it("keys on the exact title, not a lookalike", () => {
    for (const title of ["Welcome to PageVault!", "welcome to pagevault", "Welcome", ""]) {
      assert.equal(onlySampleDocuments(doc("x1", title)), false, `"${title}" must not pass`);
    }
  });

  it("refuses when the title metadata is missing entirely", () => {
    // A meta: key with no metadata is a document we know nothing about — never disposable.
    assert.equal(onlySampleDocuments([{ name: "doc:x1" }, { name: "meta:x1" }]), false);
  });

  it("refuses when an unrelated document's keys are mixed in without a meta: key", () => {
    // Only `meta:` keys are counted as documents, so a stray doc:/idx: from something else must
    // still block — otherwise a partially-listed document reads as "nothing but the sample".
    assert.equal(onlySampleDocuments([...SAMPLE, { name: "doc:other" }]), false);
    assert.equal(onlySampleDocuments([...SAMPLE, { name: "idx:acme:other" }]), false);
  });

  it("refuses when more public links exist than the sample could have minted", () => {
    // A `pub:` token is opaque — it names no document. One is the sample's own; a second belongs
    // to something we cannot see, so the set is no longer provably disposable.
    assert.equal(onlySampleDocuments([...SAMPLE, { name: "pub:someoneelse" }]), false);
    assert.equal(onlySampleDocuments(SAMPLE), true, "the sample's own single link is fine");
  });

  it("is false for an empty key list", () => {
    assert.equal(onlySampleDocuments([]), false);
  });
});

describe("summarize", () => {
  it("names documents by title and counts everything else", () => {
    const out = summarize([...REAL, { name: "portal:acme" }, { name: "pub:tok9" }]);
    assert.deepEqual(out.filter((e) => e.type === "document"), [
      { type: "document", id: "h7d9x2", title: "Q3 Engineering Review" },
    ]);
    assert.deepEqual(out.find((e) => e.type === "portal"), { type: "portal", count: 1 });
    assert.deepEqual(out.find((e) => e.type === "link"), { type: "link", count: 1 });
  });

  it("accounts for every key — nothing is silently dropped", () => {
    // The operator is being asked to make a call about these keys. A key missing from the
    // summary is a key they judged without seeing, which is the bug this whole file guards.
    const keys = [...REAL, { name: "portal:acme" }, { name: "members:acme" }, { name: "pub:t" }, { name: "weird:thing" }];
    const counted = summarize(keys).reduce(
      (n, e) => n + (e.type === "document" ? 0 : e.count),
      0,
    );
    const docKeys = keys.filter((k) => /^(?:doc|raw|meta|idx):/.test(k.name)).length;
    assert.equal(counted + docKeys, keys.length);
  });

  it("reports an untitled document rather than hiding it", () => {
    const out = summarize([{ name: "doc:z9" }, { name: "meta:z9" }]);
    assert.deepEqual(out, [{ type: "document", id: "z9", title: null }]);
  });

  it("collapses a document's several keys into one entry", () => {
    assert.equal(summarize(REAL).filter((e) => e.type === "document").length, 1);
  });
});

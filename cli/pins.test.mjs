//
// Pin-order arithmetic (#142). The cases a hand-test never reaches: "up" at the top, "down" at the
// bottom, and moving something that was not pinned yet. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPin, applyUnpin, indexOfPin } from "./lib/pins.mjs";

const L = ["a.html", "b.html", "c.html"];

test("pinning a new document puts it first, because that is why you pinned it", () => {
  assert.deepEqual(applyPin(L, "new.html"), ["new.html", "a.html", "b.html", "c.html"]);
  assert.deepEqual(applyPin([], "only.html"), ["only.html"]);
  assert.deepEqual(applyPin(undefined, "only.html"), ["only.html"], "no pins yet is not an error");
});

test("re-pinning an already-pinned document moves it rather than duplicating it", () => {
  assert.deepEqual(applyPin(L, "c.html"), ["c.html", "a.html", "b.html"]);
  assert.equal(applyPin(L, "c.html").length, L.length, "the list does not grow");
});

test("to-top and to-bottom", () => {
  assert.deepEqual(applyPin(L, "c.html", "top"), ["c.html", "a.html", "b.html"]);
  assert.deepEqual(applyPin(L, "a.html", "bottom"), ["b.html", "c.html", "a.html"]);
});

test("🔴 up at the top and down at the bottom are no-ops, not errors or wrap-arounds", () => {
  // The two cases nobody tests by hand, and the two where a wrap-around would be baffling: you
  // press "up" on the first item and it jumps to last.
  assert.deepEqual(applyPin(L, "a.html", "up"), L);
  assert.deepEqual(applyPin(L, "c.html", "down"), L);
});

test("up and down move exactly one place", () => {
  assert.deepEqual(applyPin(L, "b.html", "up"), ["b.html", "a.html", "c.html"]);
  assert.deepEqual(applyPin(L, "b.html", "down"), ["a.html", "c.html", "b.html"]);
});

test("an explicit position is 1-based and clamps rather than refusing", () => {
  assert.deepEqual(applyPin(L, "c.html", 1), ["c.html", "a.html", "b.html"]);
  assert.deepEqual(applyPin(L, "a.html", 2), ["b.html", "a.html", "c.html"]);
  // "position 99" plainly means last; "position 0" plainly means first. Refusing would be pedantry.
  assert.deepEqual(applyPin(L, "a.html", 99), ["b.html", "c.html", "a.html"]);
  assert.deepEqual(applyPin(L, "c.html", 0), ["c.html", "a.html", "b.html"]);
});

test("a relative move on an unpinned document pins it — the intent is plain", () => {
  assert.deepEqual(applyPin(L, "new.html", "up"), ["a.html", "b.html", "new.html", "c.html"]);
  assert.deepEqual(applyPin(L, "new.html", "bottom"), [...L, "new.html"]);
});

test("names match case-insensitively, like document identity", () => {
  assert.equal(indexOfPin(L, "B.HTML"), 1);
  assert.deepEqual(applyPin(L, "C.html", "top"), ["c.html", "a.html", "b.html"], "and the stored spelling is kept");
  assert.deepEqual(applyUnpin(L, "A.HTML"), ["b.html", "c.html"]);
});

test("unpinning something that was not pinned changes nothing", () => {
  assert.deepEqual(applyUnpin(L, "nope.html"), L);
  assert.deepEqual(applyUnpin([], "nope.html"), []);
});

test("an unknown op is a thrown error, not a silent no-op", () => {
  // A typo'd position that quietly did nothing would look exactly like a successful pin.
  assert.throws(() => applyPin(L, "a.html", "sideways"), /Unknown pin position/);
});

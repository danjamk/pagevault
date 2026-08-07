//
// The bearer-selection policy (#38): how `make deploy` decides where PAGEVAULT_API_TOKEN comes
// from. This is the difference between a safe CI prod deploy and one that mints a throwaway bearer
// on a runner that's about to vanish — stranding it from every CLI/MCP client. Pinned here because
// the live path shells out to Cloudflare and can't be exercised in a unit test. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseBearer, restoreHint } from "../cli/lib/provision/context.mjs";

test("a bearer already on the Worker is reused, never rotated — beats everything", () => {
  // Even with a provided value AND an interactive session, a live bearer wins: rotating it would
  // break every CLI and MCP client mid-flight.
  assert.deepEqual(chooseBearer({ hasSecret: true, provided: "abc", interactive: true }), { action: "skip" });
  assert.deepEqual(chooseBearer({ hasSecret: true, provided: undefined, interactive: false }), { action: "skip" });
});

test("no Worker secret but a provided value → set that exact value", () => {
  // The CI case: a GitHub Environment secret (or .env.local). Set what was provided, so the
  // operator's existing clients keep working — no new random token.
  assert.deepEqual(chooseBearer({ hasSecret: false, provided: "prod-bearer", interactive: false }), {
    action: "set",
    value: "prod-bearer",
  });
});

test("nothing anywhere but interactive → mint one", () => {
  assert.deepEqual(chooseBearer({ hasSecret: false, provided: undefined, interactive: true }), { action: "generate" });
});

test("nothing anywhere and non-interactive → fail loud rather than mint a throwaway", () => {
  // The guardrail: a CI deploy into a fresh Worker with no provided bearer must refuse, not
  // generate a prod token that only ever lives on the runner.
  assert.deepEqual(chooseBearer({ hasSecret: false, provided: undefined, interactive: false }), { action: "fail" });
});

test("an empty-string provided value is treated as absent, not a bearer", () => {
  // A secret set to "" (or an unset ${{ secrets.X }}) must not become the bearer.
  assert.deepEqual(chooseBearer({ hasSecret: false, provided: "", interactive: false }), { action: "fail" });
});

// --- the next-step hint an installed operator can actually type (#178) --------------------------

test("🔴 an installed operator is never told to run a make target they do not have", () => {
  // `pagevault upgrade` on a machine with a backup file sitting in the directory printed
  // "Next: make restore FILE=…". There is no Makefile in an npm install, so the one instruction
  // offered at the end of a recovery was the one instruction that could not be followed.
  const hint = restoreHint("pagevault-backup-2026-08-07.json", false);
  assert.equal(hint, "pagevault restore pagevault-backup-2026-08-07.json");
  assert.doesNotMatch(hint, /make /);
  // The CLI takes the file positionally; FILE= is make's calling convention and means nothing here.
  assert.doesNotMatch(hint, /FILE=/);
});

test("from a checkout it still names the make target, with make's calling convention", () => {
  assert.equal(restoreHint("snap.json", true), "make restore FILE=snap.json");
});

test("the two forms differ in more than their prefix, which is why this is not runHint", () => {
  // Stated as an assertion so a future tidy-up that folds this into runHint fails here rather than
  // silently shipping `pagevault restore FILE=x`, which the CLI would read as a filename.
  const [repo, installed] = [restoreHint("f.json", true), restoreHint("f.json", false)];
  assert.notEqual(repo.replace("make ", ""), installed.replace("pagevault ", ""));
});

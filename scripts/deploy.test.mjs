//
// The bearer-selection policy (#38): how `make deploy` decides where PAGEVAULT_API_TOKEN comes
// from. This is the difference between a safe CI prod deploy and one that mints a throwaway bearer
// on a runner that's about to vanish — stranding it from every CLI/MCP client. Pinned here because
// the live path shells out to Cloudflare and can't be exercised in a unit test. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseBearer } from "./context.mjs";

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

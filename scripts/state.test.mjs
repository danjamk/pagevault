//
// Where operator state lives (#86, ADR-014). The repo path must stay byte-identical (so `make
// deploy` and prod CI are unchanged); the installed path moves to ~/.pagevault/, overridable by
// PAGEVAULT_HOME. A bug here strands credentials, so the resolver is pinned. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateDir, generatedConfigPath, saveContext, loadContext } from "../cli/lib/provision/context.mjs";

// These tests run from the source tree (not under node_modules), so RUNNING_FROM_REPO is true and
// the default is the cwd — exactly what `make` sees.

test("repo mode (default): state is the cwd, config stays under worker/", () => {
  delete process.env.PAGEVAULT_HOME;
  assert.equal(stateDir(), process.cwd());
  assert.equal(generatedConfigPath(), "worker/wrangler.generated.jsonc");
});

test("PAGEVAULT_HOME overrides the state dir", () => {
  const prev = process.env.PAGEVAULT_HOME;
  const dir = mkdtempSync(join(tmpdir(), "pv-home-"));
  try {
    process.env.PAGEVAULT_HOME = dir;
    assert.equal(stateDir(), dir);
    // …and context round-trips through the override, creating the dir as needed.
    saveContext({ rung: 3, ownerEmail: "x@y.com" });
    assert.match(readFileSync(join(dir, ".pagevault.json"), "utf8"), /"ownerEmail": "x@y.com"/);
    assert.equal(loadContext().rung, 3);
  } finally {
    if (prev === undefined) delete process.env.PAGEVAULT_HOME;
    else process.env.PAGEVAULT_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("🔴 stateDir follows the marker, so the bearer and the URL describe one deployment (#155)", () => {
  // Phase 2 moved which URL a command targets and left this reading ~/.pagevault, so `verify` took
  // the URL from a checkout and the bearer from the login config — and sent one deployment's
  // credential to another. Standing anywhere under a checkout must resolve that checkout's state.
  const root = mkdtempSync(join(tmpdir(), "pv-marker-"));
  const deep = join(root, "worker", "src");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(root, ".pagevault.json"), JSON.stringify({ rung: 3, host: "x.example.com" }));

  const cwd = process.cwd();
  const home = process.env.PAGEVAULT_HOME;
  try {
    delete process.env.PAGEVAULT_HOME;
    process.chdir(deep);
    assert.equal(stateDir(), realpathSync(root), "a subdirectory resolves the checkout, not itself");
  } finally {
    process.chdir(cwd);
    if (home !== undefined) process.env.PAGEVAULT_HOME = home;
  }
});

test("PAGEVAULT_HOME still beats the marker — it is what isolates the test suites", () => {
  // Every suite sets HOME/PAGEVAULT_HOME to a temp dir while running from the repo root. If ascent
  // could win here, the e2e suite would find the real checkout's state and drive a live deployment.
  const scratch = mkdtempSync(join(tmpdir(), "pv-pinned-"));
  const prev = process.env.PAGEVAULT_HOME;
  try {
    process.env.PAGEVAULT_HOME = scratch;
    assert.equal(stateDir(), scratch);
  } finally {
    if (prev === undefined) delete process.env.PAGEVAULT_HOME;
    else process.env.PAGEVAULT_HOME = prev;
  }
});

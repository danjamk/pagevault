//
// Where operator state lives (#86, ADR-014). The repo path must stay byte-identical (so `make
// deploy` and prod CI are unchanged); the installed path moves to ~/.pagevault/, overridable by
// PAGEVAULT_HOME. A bug here strands credentials, so the resolver is pinned. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

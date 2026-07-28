//
// EXPECTED_MCP_TOOLS must match what the Worker actually registers.
//
// `verify` and `health` assert the live `/mcp` surface against EXPECTED_MCP_TOOLS, so that constant
// IS the check. It silently drifted to nine entries while `worker/src/mcp.ts` registered twelve,
// which meant a deployment missing `revoke_public_link`, `rotate_public_link` and `server_info`
// verified clean. A check that cannot fail is worse than no check, because it gets believed.
//
// This reads the Worker source rather than a hand-kept second list — a hardcoded copy here would
// be the same bug in a new place.
//
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EXPECTED_MCP_TOOLS } from "./lib/provision/context.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Tool names as `worker/src/mcp.ts` registers them. */
function registeredTools() {
  const src = readFileSync(join(REPO, "worker/src/mcp.ts"), "utf8");
  return [...src.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
}

describe("EXPECTED_MCP_TOOLS", () => {
  it("finds the Worker's tool registrations at all", () => {
    // Guards the guard: if `registerTool(` is ever renamed, the regex silently returns [] and
    // every assertion below passes vacuously.
    assert.ok(registeredTools().length >= 10, "expected to parse at least 10 registerTool calls");
  });

  it("lists every tool the Worker registers", () => {
    const missing = registeredTools().filter((t) => !EXPECTED_MCP_TOOLS.includes(t));
    assert.deepEqual(missing, [], `verify would not notice these going missing: ${missing.join(", ")}`);
  });

  it("lists no tool the Worker does not register", () => {
    const registered = registeredTools();
    const extra = EXPECTED_MCP_TOOLS.filter((t) => !registered.includes(t));
    assert.deepEqual(extra, [], `verify would fail forever on these: ${extra.join(", ")}`);
  });

  it("has no duplicates", () => {
    assert.equal(new Set(EXPECTED_MCP_TOOLS).size, EXPECTED_MCP_TOOLS.length);
  });
});

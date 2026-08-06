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
import {
  stateDir, generatedConfigPath, saveContext, loadContext,
  printTokenSetup, saveTokenCommand, displayPath, fromEnvFile,
} from "../cli/lib/provision/context.mjs";

/** Run a printer and return everything it wrote, with colour stripped. */
function capture(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = real;
  }
  // eslint-disable-next-line no-control-regex
  return lines.join("\n").replace(/\[[0-9;]*m/g, "");
}

/** The `.env.local` path out of whichever save command was printed — `echo …` or `Set-Content …`. */
const tokenPathFrom = (out) => out.match(/'([^']*\.env\.local)'/)?.[1];

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

test("🔴 the token instruction names the file the loader actually reads (#157)", () => {
  // The instruction said `> .env.local`, relative to wherever the operator was standing; the loader
  // read stateDir()/.env.local. On an install those are the same directory only by luck, so the
  // token was written somewhere nothing reads, `init` said "no token", and the message repeated the
  // instruction that had just failed. Nothing named a directory, so there was no thread to pull.
  //
  // This asserts the two halves against each other rather than against a literal, because a literal
  // is what let them drift.
  const scratch = mkdtempSync(join(tmpdir(), "pv-token-"));
  const prev = process.env.PAGEVAULT_HOME;
  const cwd = process.cwd();
  try {
    process.env.PAGEVAULT_HOME = scratch;
    process.chdir(tmpdir()); // stand somewhere that is NOT the state dir — the install case

    // Do what the operator did on Windows: read step 4, save the token exactly where it says.
    const shown = tokenPathFrom(capture(printTokenSetup));
    assert.ok(shown, "step 4 must name a file to save the token to");
    writeFileSync(shown, "CLOUDFLARE_API_TOKEN=sentinel-157\n");

    // …and the loader must find it there. That is the entire bug, in one assertion.
    assert.equal(fromEnvFile("CLOUDFLARE_API_TOKEN"), "sentinel-157", "printed a path the loader does not read");
  } finally {
    process.chdir(cwd);
    if (prev === undefined) delete process.env.PAGEVAULT_HOME;
    else process.env.PAGEVAULT_HOME = prev;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the repo keeps printing the bare .env.local it always has", () => {
  // `make setup` from a checkout writes to the cwd, so the absolute path above would be noise. The
  // fix must not make the repo path uglier than it was.
  const prev = process.env.PAGEVAULT_HOME;
  try {
    delete process.env.PAGEVAULT_HOME;
    assert.equal(displayPath(join(process.cwd(), ".env.local")), ".env.local");
  } finally {
    if (prev !== undefined) process.env.PAGEVAULT_HOME = prev;
  }
});

test("🔴 Windows gets a command whose output we can read back", () => {
  // Windows PowerShell 5.1 redirects as UTF-16LE, which readFileSync(…, "utf8") cannot parse: the
  // token is written and then silently unreadable. Never suggest `>` there.
  const win = saveTokenCommand("C:\\Users\\x\\.pagevault\\.env.local", "win32");
  assert.match(win, /^Set-Content /);
  assert.match(win, /-Encoding ascii$/, "5.1's -Encoding utf8 means utf8-WITH-BOM");
  assert.ok(!/\s>\s/.test(win), "redirection is the bug — `<paste>` has an angle bracket, that is fine");
  assert.match(saveTokenCommand("/home/x/.env.local", "darwin"), /^echo '\S+=<paste>' > '\/home\/x\/\.env\.local'$/);
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

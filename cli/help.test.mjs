//
// Per-command help (#126) — pinned to the dispatch table.
//
// The failure mode this exists for is silent: someone adds a command arm, ships it, and
// `pagevault <newcmd> --help` quietly prints the top-level wall as though that were the answer.
// Nothing goes red. So the source of truth is `cli/bin/pagevault.mjs` itself — the `case "x":`
// arms are parsed out of it, exactly the way `mcp-tools.test.mjs` parses `registerTool` calls
// rather than keeping a second hand-written list that can drift.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HELP, helpText, usageError } from "./lib/help.mjs";

const BIN = fileURLToPath(new URL("./bin/pagevault.mjs", import.meta.url));

/** Every command the CLI dispatches, read from the switch it dispatches with. */
function dispatched() {
  const src = readFileSync(BIN, "utf8");
  return [...src.matchAll(/^\s+case "([a-z-]+)":$/gm)].map((m) => m[1]);
}

// Run with state redirected to an empty throwaway dir, so nothing here can read the developer's
// ~/.pagevault or this clone's .pagevault.json — let alone reach a real deployment. Help must never
// need one, and the argument guards below must fail before any network call either way.
const HOME_DIR = mkdtempSync(join(tmpdir(), "pv-help-"));
const run = (...args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, PAGEVAULT_URL: "", PAGEVAULT_API_TOKEN: "", CLOUDFLARE_API_TOKEN: "", PAGEVAULT_HOME: HOME_DIR, HOME: HOME_DIR },
  });
  return { status: r.status, text: `${r.stdout}${r.stderr}` };
};

test("the parser finds the dispatch table — this check must be able to fail", () => {
  const cmds = dispatched();
  assert.ok(cmds.length >= 20, `parsed only ${cmds.length} commands from the switch — the regex has gone blind`);
  assert.ok(cmds.includes("publish") && cmds.includes("destroy"));
});

test("every dispatched command has a help entry", () => {
  const missing = dispatched().filter((cmd) => !HELP[cmd]);
  assert.deepEqual(missing, [], `no help for: ${missing.join(", ")}`);
});

test("no help entry describes a command the CLI does not dispatch", () => {
  const live = new Set(dispatched());
  const orphans = Object.keys(HELP).filter((cmd) => !live.has(cmd));
  assert.deepEqual(orphans, [], `help for a command that no longer exists: ${orphans.join(", ")}`);
});

test("each entry opens with its own invocation line", () => {
  // Prefix-matched on the whole token, not a \b — `mint` must not be satisfied by a usage line
  // that says `mint-link`, which is exactly the drift a rename would leave behind.
  for (const cmd of Object.keys(HELP)) {
    const first = helpText(cmd).split("\n")[0];
    const head = `Usage: pagevault ${cmd}`;
    assert.ok(first === head || first.startsWith(`${head} `), `${cmd}'s help opens with "${first}"`);
  }
});

test("the guard message and --help are the same constant", () => {
  // The whole point of #126: a command's usage line cannot drift from its help, because there is
  // one string. The guard adds a pointer to the rest; everything before it must match verbatim.
  for (const cmd of Object.keys(HELP)) {
    const thrown = usageError(cmd).replace(`\nFull help: pagevault ${cmd} --help`, "");
    assert.ok(helpText(cmd).startsWith(thrown), `${cmd}: the thrown usage is not the head of its help`);
  }
});

test("`<cmd> --help` prints that command's help, not the top-level wall", () => {
  const r = run("publish", "--help");
  assert.equal(r.status, 0);
  assert.match(r.text, /^Usage: pagevault publish/);
  assert.match(r.text, /--name <filename>/, "the flags are the reason to ask for help");
  assert.doesNotMatch(r.text, /Set up & deploy:/, "the top-level summary is what this replaces");
});

test("`help <cmd>` is the same thing", () => {
  assert.equal(run("help", "mint").text, run("mint", "--help").text);
});

test("bare help, and help for something we don't dispatch, fall back to the summary", () => {
  for (const args of [["help"], ["--help"], [], ["help", "nonsense"]]) {
    const r = run(...args);
    assert.equal(r.status, 0, `\`pagevault ${args.join(" ")}\` should exit 0`);
    assert.match(r.text, /Set up & deploy:/);
  }
});

test("the lifecycle commands' --help exits 0 without provisioning — cli/smoke.mjs depends on it", () => {
  for (const cmd of ["init", "upgrade"]) {
    const r = run(cmd, "--help");
    assert.equal(r.status, 0);
    assert.match(r.text, new RegExp(`^Usage: pagevault ${cmd}`));
    // setup/deploy each open with their own banner. Seeing one means help fell through into the
    // provisioning flow — which on a real machine would start touching Cloudflare.
    assert.doesNotMatch(r.text, /PageVault — (setup|deploy)/, "help must not enter the provisioning flow");
  }
});

test("a missing argument still prints one usage line, plus where the rest is", () => {
  const r = run("mint");
  assert.equal(r.status, 1);
  assert.match(r.text, /Usage: pagevault mint <id>/);
  assert.match(r.text, /pagevault mint --help/);
});

test("share's guard keeps naming both forms — grant and revoke", () => {
  const r = run("share", "acme");
  assert.equal(r.status, 1);
  assert.match(r.text, /Usage: pagevault share <portal> <email>/);
  assert.match(r.text, /--remove/);
});

test("restore refuses with its usage when handed no file", () => {
  const r = run("restore");
  assert.equal(r.status, 1);
  assert.match(r.text, /Usage: pagevault restore <file\.json>/);
});

test("restore finds the file even when a valueless flag swallowed it", () => {
  // parseArgs can't know --force takes no value, so `restore --force snap.json` binds the filename
  // to the flag. Getting a usage line for correct-looking input, in the command you reach for
  // mid-recovery, is the failure this guards. It must get past the argument guard and on to the
  // real one — no such file.
  for (const args of [["restore", "--force", "nope.json"], ["restore", "--yes", "nope.json"], ["restore", "nope.json", "--force"]]) {
    const r = run(...args);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.text, /Usage: pagevault restore/, `\`${args.join(" ")}\` should not print usage`);
  }
});

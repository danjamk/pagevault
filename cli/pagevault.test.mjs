//
// Unit tests for the CLI's pure helpers — argv parsing, list splitting, title derivation, config
// precedence. These are the bits with logic worth pinning; the commands themselves are thin HTTP
// calls exercised against a live deployment. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, splitList, deriveTitle, sourceKindFor, truncate, table } from "./lib/format.mjs";
import { loadConfig } from "./lib/client.mjs";

const BIN = fileURLToPath(new URL("./bin/pagevault.mjs", import.meta.url));

// Run the binary as a real process with no deployment configured. Each command guards its
// required arguments BEFORE it touches config or the network, so a missing-arg invocation must
// fail fast with its usage line — never a config error, never a fetch. help prints to stderr.
const run = (...args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, PAGEVAULT_URL: "", PAGEVAULT_API_TOKEN: "" },
  });
  return { status: r.status, text: `${r.stdout}${r.stderr}` };
};

test("parseArgs separates positionals, value flags, and boolean flags", () => {
  const { positional, flags } = parseArgs(["report.html", "--portal", "acme", "--public", "--title", "Q3"]);
  assert.deepEqual(positional, ["report.html"]);
  assert.equal(flags.portal, "acme");
  assert.equal(flags.title, "Q3");
  assert.equal(flags.public, true);
});

test("parseArgs treats a --flag followed by another --flag as boolean", () => {
  const { flags } = parseArgs(["--public", "--confirm"]);
  assert.equal(flags.public, true);
  assert.equal(flags.confirm, true);
});

test("splitList trims and drops empties; non-strings are undefined", () => {
  assert.deepEqual(splitList("a, b ,,c"), ["a", "b", "c"]);
  assert.equal(splitList(true), undefined);
  assert.equal(splitList(", ,"), undefined);
});

test("deriveTitle prefers the HTML <title>, else the filename stem", () => {
  assert.equal(deriveTitle("<html><head><title> Q3 Review </title></head>", "x.html"), "Q3 Review");
  assert.equal(deriveTitle("<html>no title here</html>", "reports/2026-q3.html"), "2026-q3");
  assert.equal(deriveTitle("<title></title>", "plain.html"), "plain"); // empty title falls through
});

test("deriveTitle uses a markdown H1 when there is no <title>", () => {
  assert.equal(deriveTitle("# Q3 Review\n\nbody", "notes.md"), "Q3 Review");
  assert.equal(deriveTitle("no heading here", "reports/plan.md"), "plan"); // falls back to the stem
});

test("sourceKindFor infers from the extension; an explicit override wins", () => {
  assert.equal(sourceKindFor("report.md", undefined), "markdown");
  assert.equal(sourceKindFor("report.markdown", undefined), "markdown");
  assert.equal(sourceKindFor("report.html", undefined), "html");
  assert.equal(sourceKindFor("report.txt", undefined), "html"); // default is html
  assert.equal(sourceKindFor("report.md", "html"), "html"); // override beats the extension
  assert.equal(sourceKindFor("report.html", "markdown"), "markdown");
});

test("truncate adds an ellipsis only past the limit", () => {
  assert.equal(truncate("short", 10), "short");
  assert.equal(truncate("a very long title indeed", 10), "a very lo…");
});

test("table pads columns to content width", () => {
  const t = table(["ID", "TITLE"], [["abc", "Hi"], ["longid", "A longer title"]]);
  const lines = t.split("\n");
  assert.equal(lines.length, 3);
  // 'longid' is 6 wide → ID column pads to 6 (4 spaces), then the 2-space separator = 6 spaces.
  assert.match(lines[0], /^ID {6}TITLE$/);
});

test("the parity commands are dispatched and print their usage when a required arg is missing", () => {
  // Guards fire before config/network: the exit is 1 and the message is the command's own usage,
  // not "Not configured". This is what proves each new verb is actually wired into the switch.
  for (const [args, needle] of [
    [["read"], "pagevault read <id>"],
    [["search"], "pagevault search <portal>"],
    [["search", "acme"], "pagevault search <portal>"], // portal given, query missing
    [["mint"], "pagevault mint <id>"],
    [["revoke"], "pagevault revoke <id>"],
    [["rotate"], "pagevault rotate <id>"],
  ]) {
    const { status, text } = run(...args);
    assert.equal(status, 1, `${args.join(" ")} should exit 1`);
    assert.match(text, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(text, /Not configured/, `${args.join(" ")} must guard args before config`);
  }
});

test("an unknown command exits 1 and points at help", () => {
  const { status, text } = run("frobnicate");
  assert.equal(status, 1);
  assert.match(text, /Unknown command/);
});

test("loadConfig: environment wins over the config file, and trims a trailing slash", () => {
  const cfg = loadConfig({ PAGEVAULT_URL: "https://share.example.com/", PAGEVAULT_API_TOKEN: "tok" });
  assert.equal(cfg.url, "https://share.example.com");
  assert.equal(cfg.token, "tok");
});
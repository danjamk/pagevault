//
// Unit tests for the CLI's pure helpers — argv parsing, list splitting, title derivation, config
// precedence. These are the bits with logic worth pinning; the commands themselves are thin HTTP
// calls exercised against a live deployment. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, splitList, deriveTitle, truncate, table } from "./lib/format.mjs";
import { loadConfig } from "./lib/client.mjs";

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

test("loadConfig: environment wins over the config file, and trims a trailing slash", () => {
  const cfg = loadConfig({ PAGEVAULT_URL: "https://share.example.com/", PAGEVAULT_API_TOKEN: "tok" });
  assert.equal(cfg.url, "https://share.example.com");
  assert.equal(cfg.token, "tok");
});
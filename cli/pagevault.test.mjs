//
// Unit tests for the CLI's pure helpers — argv parsing, list splitting, title derivation, config
// precedence. These are the bits with logic worth pinning; the commands themselves are thin HTTP
// calls exercised against a live deployment. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, splitList, deriveTitle, sourceKindFor, truncate, table } from "./lib/format.mjs";
import { loadConfig } from "./lib/client.mjs";

const BIN = fileURLToPath(new URL("./bin/pagevault.mjs", import.meta.url));

// Run the binary with state isolated to a throwaway dir — PAGEVAULT_HOME redirects context/.env.local
// and HOME redirects ~/.pagevault/config.json — so operator commands read an EMPTY deployment and
// can never touch the real one or hit the network. This is what lets us assert verify/health/destroy
// fail closed on "nothing configured" rather than accidentally driving a live host.
const runIn = (home, ...args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, PAGEVAULT_URL: "", PAGEVAULT_API_TOKEN: "", PAGEVAULT_HOME: home, HOME: home },
  });
  return { status: r.status, stdout: r.stdout, text: `${r.stdout}${r.stderr}` };
};

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

test("sync-access is dispatched, and --reap refuses non-interactively without --yes", () => {
  // --reap guards before config, so a non-TTY run without --yes fails on the guard, not the network.
  const reaped = run("sync-access", "--reap");
  assert.equal(reaped.status, 1);
  assert.match(reaped.text, /Refusing to --reap/);
  assert.doesNotMatch(reaped.text, /Unknown command/);

  // Plain sync-access reaches the command (config error), proving it's wired into the switch.
  const plain = run("sync-access");
  assert.equal(plain.status, 1);
  assert.doesNotMatch(plain.text, /Unknown command/);
});

test("loadConfig: environment wins over the config file, and trims a trailing slash", () => {
  const cfg = loadConfig({ PAGEVAULT_URL: "https://share.example.com/", PAGEVAULT_API_TOKEN: "tok" });
  assert.equal(cfg.url, "https://share.example.com");
  assert.equal(cfg.token, "tok");
});

test("operator commands are dispatched and fail closed with no deployment configured", () => {
  const home = mkdtempSync(join(tmpdir(), "pv-ops-"));

  // status: not an error, just reports it isn't set up — and never says "Unknown command".
  const st = runIn(home, "status");
  assert.equal(st.status, 0);
  assert.match(st.text, /Not configured/);
  assert.doesNotMatch(st.text, /Unknown command/);

  // --json is the drivable surface (#33): valid JSON, configured:false, a version string.
  const sj = runIn(home, "status", "--json");
  assert.equal(sj.status, 0);
  const parsed = JSON.parse(sj.stdout);
  assert.equal(parsed.configured, false);
  assert.equal(typeof parsed.version, "string");

  // verify/health need a deployed URL; with none they die BEFORE any network call.
  for (const cmd of ["verify", "health"]) {
    const r = runIn(home, cmd);
    assert.equal(r.status, 1, `${cmd} should exit 1`);
    assert.match(r.text, /No deployed URL/);
    assert.doesNotMatch(r.text, /Unknown command/);
  }

  // destroy: nothing to tear down — the safe default, exit 1, no prompt reached.
  const d = runIn(home, "destroy");
  assert.equal(d.status, 1);
  assert.match(d.text, /Nothing to tear down/);
  assert.doesNotMatch(d.text, /Unknown command/);
});

test("saveLoginConfig round-trips through loadConfig and writes 0600", () => {
  // Isolate HOME so this never clobbers the operator's real ~/.pagevault/config.json. Exercised in a
  // subprocess because CONFIG_PATH is resolved from homedir() at import time.
  const home = mkdtempSync(join(tmpdir(), "pv-login-"));
  const clientHref = new URL("./lib/client.mjs", import.meta.url).href;
  const script = `
    const { saveLoginConfig, loadConfig } = await import(${JSON.stringify(clientHref)});
    const p = saveLoginConfig({ url: "https://share.example.com/", token: "tok123" });
    process.stdout.write(JSON.stringify({ p, cfg: loadConfig({}) }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PAGEVAULT_HOME: home, PAGEVAULT_URL: "", PAGEVAULT_API_TOKEN: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  const { p, cfg } = JSON.parse(r.stdout);
  assert.equal(cfg.url, "https://share.example.com"); // trailing slash trimmed
  assert.equal(cfg.token, "tok123");
  assert.equal(statSync(p).mode & 0o777, 0o600); // it holds a bearer
});
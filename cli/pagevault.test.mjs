//
// Unit tests for the CLI's pure helpers — argv parsing, list splitting, title derivation, config
// precedence. These are the bits with logic worth pinning; the commands themselves are thin HTTP
// calls exercised against a live deployment. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
    [["portal-create"], "pagevault portal-create <slug>"],
    [["share"], "pagevault share"],
    [["share", "acme"], "pagevault share"], // portal given, neither a grant nor a revocation
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
  // Isolate HOME/PAGEVAULT_HOME: `run` alone would leak the operator's real ~/.pagevault/config.json,
  // so a machine that has run `login` would let plain sync-access reach a live deployment and exit 0.
  const home = mkdtempSync(join(tmpdir(), "pv-sync-"));

  // --reap guards before config, so a non-TTY run without --yes fails on the guard, not the network.
  const reaped = runIn(home, "sync-access", "--reap");
  assert.equal(reaped.status, 1);
  assert.match(reaped.text, /Refusing to --reap/);
  assert.doesNotMatch(reaped.text, /Unknown command/);

  // Plain sync-access reaches the command (config error), proving it's wired into the switch.
  const plain = runIn(home, "sync-access");
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
  // #130: status reports saved intent, never observed state. An agent reading --json has no tone
  // to read, so the provenance has to be a field it can branch on.
  assert.equal(parsed.source, "local");

  // verify/health need a deployment to talk to; with none they die BEFORE any network call.
  for (const cmd of ["verify", "health"]) {
    const r = runIn(home, cmd);
    assert.equal(r.status, 1, `${cmd} should exit 1`);
    assert.match(r.text, /No deployment|No deployed URL/);
    assert.doesNotMatch(r.text, /Unknown command/);
  }

  // backup/restore need a Cloudflare token and a namespace; with neither they die before any
  // Cloudflare call. They ship as CLI commands (#133) — `make` is no longer the only door.
  for (const cmd of [["backup"], ["restore", "nope.json"]]) {
    const r = runIn(home, ...cmd);
    assert.equal(r.status, 1, `${cmd[0]} should exit 1`);
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
  // The 0600 is a POSIX guarantee only. NTFS has no mode bits, so Windows reports 0666 here no
  // matter what we ask for — the file is protected by the profile ACL instead (see client.mjs).
  // Asserting it there would be asserting a fact about Windows, not about this code.
  if (process.platform !== "win32") assert.equal(statSync(p).mode & 0o777, 0o600); // it holds a bearer
});

test("login falls back to PAGEVAULT_URL / PAGEVAULT_API_TOKEN when the flags are omitted", () => {
  const home = mkdtempSync(join(tmpdir(), "pv-login-env-"));
  // No flags — url + token come from the environment. Point at a refused port so the post-save
  // connection check fails fast and offline; the save is what we're asserting, and it happens first.
  const r = spawnSync(process.execPath, [BIN, "login"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PAGEVAULT_HOME: home, PAGEVAULT_URL: "http://127.0.0.1:1", PAGEVAULT_API_TOKEN: "envtok" },
  });
  assert.equal(r.status, 0, r.stderr); // a failed verify is non-fatal; login still persisted the config
  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(cfg.url, "http://127.0.0.1:1");
  assert.equal(cfg.token, "envtok");
});

test("login with neither flags nor env errors with its usage", () => {
  const home = mkdtempSync(join(tmpdir(), "pv-login-none-"));
  const r = spawnSync(process.execPath, [BIN, "login"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PAGEVAULT_HOME: home, PAGEVAULT_URL: "", PAGEVAULT_API_TOKEN: "" },
  });
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /Usage: pagevault login/);
});

test("tierFromAnswer: numbers, words, the default, and a refusal", async () => {
  const { tierFromAnswer } = await import("./lib/provision/setup.mjs");

  // The prompt is numbered because `Public or Secured? [public]` — capitalised words against a
  // lowercase default — left people unsure what to type. Numbers are the documented answer; words
  // keep working for anyone who types what they can see.
  assert.equal(tierFromAnswer("1", "public"), "public");
  assert.equal(tierFromAnswer("2", "public"), "secured");

  // Enter keeps the default, whichever way it points — this is what makes a re-run an edit.
  assert.equal(tierFromAnswer("", "public"), "public");
  assert.equal(tierFromAnswer("", "secured"), "secured");
  assert.equal(tierFromAnswer("   ", "secured"), "secured");

  // Words, any prefix, any case, with stray whitespace.
  for (const yes of ["s", "sec", "secured", "SECURED", " Secured "]) {
    assert.equal(tierFromAnswer(yes, "public"), "secured", `${JSON.stringify(yes)} should mean Secured`);
  }
  for (const no of ["p", "pub", "public", "PUBLIC"]) {
    assert.equal(tierFromAnswer(no, "secured"), "public", `${JSON.stringify(no)} should mean Public`);
  }

  // Anything else is null, so the caller can say what to type instead of guessing a tier. Getting
  // this wrong provisions Zero Trust — or fails to — against the operator's intent.
  for (const bad of ["x", "3", "0", "yes", "priv"]) {
    assert.equal(tierFromAnswer(bad, "public"), null, `${JSON.stringify(bad)} should be refused`);
  }
});

test("stripDiscoveredState drops every id destroy deleted, and keeps the operator's intent", async () => {
  const { stripDiscoveredState } = await import("./lib/ops/destroy.mjs");

  // A real rung-3 context, as written by provisioning. Everything in the first group names a
  // Cloudflare object that a teardown deletes; everything in the second is intent, and a rebuild
  // needs all of it. The shipped version guarded on `tier < 3`, so a Secured teardown kept the lot
  // and `status` went on reporting a deployment that no longer existed (#118).
  const stripped = stripDiscoveredState({
    kvId: "kv1", oauthKvId: "kv2", deployedUrl: "https://x.example.com",
    audDocs: "aud1", audAdmin: "aud2", groupId: "grp1",
    rung: 3, ownerEmail: "you@example.com", host: "x.example.com",
    accountId: "acc1", accountName: "Acct", analytics: true, team: "some-team", schemaVersion: 1,
  });

  for (const dead of ["kvId", "oauthKvId", "deployedUrl", "audDocs", "audAdmin", "groupId"]) {
    assert.ok(!(dead in stripped), `${dead} names a deleted object and must not survive`);
  }
  assert.deepEqual(stripped, {
    rung: 3, ownerEmail: "you@example.com", host: "x.example.com",
    accountId: "acc1", accountName: "Acct", analytics: true, team: "some-team", schemaVersion: 1,
  });

  // `team` stays on purpose: destroy leaves Zero Trust itself alone, so the name is still true.
  assert.equal(stripped.team, "some-team");
  // Pure — the caller's object is untouched.
  const original = { kvId: "kv1", rung: 1 };
  stripDiscoveredState(original);
  assert.equal(original.kvId, "kv1");
});

test("PAGEVAULT_HOME isolates the login config from HOME", () => {
  // The whole point of PAGEVAULT_HOME is holding several deployments on one machine: config.json must
  // follow it, not HOME, or two PAGEVAULT_HOME dirs would fight over ~/.pagevault/config.json.
  const home = mkdtempSync(join(tmpdir(), "pv-home-"));
  const pvHome = mkdtempSync(join(tmpdir(), "pv-isolate-"));
  const clientHref = new URL("./lib/client.mjs", import.meta.url).href;
  const script = `
    const { saveLoginConfig, CONFIG_PATH } = await import(${JSON.stringify(clientHref)});
    saveLoginConfig({ url: "https://a.example.com", token: "tokA" });
    process.stdout.write(CONFIG_PATH);
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PAGEVAULT_HOME: pvHome, PAGEVAULT_URL: "", PAGEVAULT_API_TOKEN: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, join(pvHome, "config.json")); // under PAGEVAULT_HOME, not HOME
  assert.ok(statSync(join(pvHome, "config.json")).isFile());
});
test("a client-only install is a state, not an error (#144)", () => {
  // The shape an operator has when production is deployed by CI: a login, and no build record
  // because nothing was ever provisioned from this machine. `status` used to call that "not
  // configured" and point at `init` — which, on that machine, would deploy production from a
  // laptop. Having a login and no build record is a shape, not a failure.
  const home = mkdtempSync(join(tmpdir(), "pv-clientonly-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: "https://prod.example.com", token: "tok" }));

  const st = runIn(home, "status");
  assert.equal(st.status, 0);
  assert.match(st.text, /prod\.example\.com/, "it must name the deployment it would act on");
  assert.match(st.text, /not provisioned from this machine/i);
  assert.doesNotMatch(st.text, /Not configured yet/, "a working install must not be called unconfigured");
  assert.doesNotMatch(st.text, /pagevault init|make setup/, "must never point a client-only install at init");

  // The same distinction has to survive into --json, where there is no tone to read.
  const sj = JSON.parse(runIn(home, "status", "--json").stdout);
  assert.equal(sj.deployment, "https://prod.example.com");
  assert.equal(sj.deploymentSource, "config");
  assert.equal(sj.provisioned, false);
  assert.equal(sj.configured, false, "`configured` still means provisioned-from-here");
});

//
// Unit tests for the CLI's pure helpers — argv parsing, list splitting, title derivation, config
// precedence. These are the bits with logic worth pinning; the commands themselves are thin HTTP
// calls exercised against a live deployment. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, splitList, deriveTitle, sourceKindFor, truncate, table } from "./lib/format.mjs";
import { loadConfig } from "./lib/client.mjs";
// Still imported from provision.mjs though it now lives in context.mjs (#190) — the re-export is
// part of that module's surface, so this pins it too.
import { resolveAnalytics } from "./lib/provision/provision.mjs";
import { analyticsChoice, stripAnalyticsBinding, bindsAnalytics } from "./lib/provision/context.mjs";

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

// --- the named deployment registry (ADR-021 phase 3, #159) -------------------------------------

/** A throwaway home holding a registry with a protected `prod` and a plain `test`. */
function registryHome() {
  const home = mkdtempSync(join(tmpdir(), "pv-registry-"));

  // A checkout somewhere else on this machine, holding `test`'s build record. Deliberately NOT at
  // `$PAGEVAULT_HOME/.pagevault.json`, so nothing here is found by locateMarker() — `test` reads as
  // provisioned only because its entry records where to look (#170).
  const checkout = join(home, "checkout");
  mkdirSync(checkout, { recursive: true });
  writeFileSync(
    join(checkout, ".pagevault.json"),
    JSON.stringify({ rung: 3, accountId: "acct", host: "test.invalid", deployedUrl: "https://test.invalid" }),
  );

  writeFileSync(
    join(home, "deployments.json"),
    JSON.stringify({
      current: "prod",
      deployments: {
        prod: { url: "https://prod.invalid", token: "prod-bearer", protected: true },
        test: { url: "https://test.invalid", token: "test-bearer", markerPath: join(checkout, ".pagevault.json") },
      },
    }),
  );
  return home;
}

test("with no registry, nothing about the CLI changes", () => {
  // The additive property. An operator who never types `login --as` must see exactly what they saw
  // before this feature existed — including no target line on every command.
  const home = mkdtempSync(join(tmpdir(), "pv-noreg-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: "https://prod.example.com", token: "tok" }));

  // The login config is listed as the implicit deployment it has always been — leaving it out would
  // show an operator a registry of none beside a `publish` that works, which they cannot account for.
  const d = runIn(home, "deployments");
  assert.equal(d.status, 0);
  assert.match(d.text, /\(login config\)\s+https:\/\/prod\.example\.com/);
  assert.match(d.text, /^\*/m, "and it is the default, because nothing else claims to be");

  const u = runIn(home, "use", "prod");
  assert.notEqual(u.status, 0);
  assert.match(u.text, /None are registered/);

  // No registry and the ordinary fallback: no target line, because there was never a second answer.
  assert.doesNotMatch(runIn(home, "list").text, /→ https/);
});

test("a truly empty install says how to start, not how it failed", () => {
  const empty = mkdtempSync(join(tmpdir(), "pv-empty-"));
  const d = runIn(empty, "deployments");
  assert.equal(d.status, 0);
  assert.match(d.text, /No deployments/);
  assert.match(d.text, /pagevault login --as/);
});

test("`deployments` lists what is reachable and which one is default", () => {
  const r = runIn(registryHome(), "deployments");
  assert.equal(r.status, 0);
  assert.match(r.text, /\*\s+prod\s+https:\/\/prod\.invalid/, "* marks the default");
  assert.match(r.text, /test\s+https:\/\/test\.invalid/);
  // "Provisioned from this machine" is a fact about the deployment, not a fault (#144).
  assert.match(r.text, /PROVISIONED/);
});

test("🔴 PROVISIONED follows the recorded build record, not the current directory (#170)", () => {
  const home = registryHome();
  const r = runIn(home, "deployments");

  // `test`'s record lives in a checkout nowhere near cwd or PAGEVAULT_HOME, and it still reads yes.
  assert.match(r.text, /test\s+https:\/\/test\.invalid\s+yes/);
  // `prod` is deployed by CI, holds no record here, and must keep saying no (#144).
  assert.match(r.text, /prod\s+https:\/\/prod\.invalid\s+no/);
  // Nothing is provisioned from where we are standing, so there is nothing to offer to record.
  assert.doesNotMatch(r.text, /does not say so/);
});

test("a checkout that was deleted degrades to no rather than to a wrong yes", () => {
  const home = registryHome();
  rmSync(join(home, "checkout"), { recursive: true, force: true });

  assert.match(runIn(home, "deployments").text, /test\s+https:\/\/test\.invalid\s+no/);
});

test("🔴 a checkout re-provisioned elsewhere stops claiming this deployment", () => {
  const home = registryHome();
  // Same path, now describing a different deployment. Without the URL re-check the entry would go
  // on asserting that `upgrade` and `destroy` work against a deployment it no longer describes.
  writeFileSync(
    join(home, "checkout", ".pagevault.json"),
    JSON.stringify({ rung: 3, deployedUrl: "https://somewhere-else.invalid" }),
  );

  assert.match(runIn(home, "deployments").text, /test\s+https:\/\/test\.invalid\s+no/);
});

test("a build record sitting right here, unrecorded, says how to record it", () => {
  const home = registryHome();
  // The confusing case the column produced before this: provisioning commands work from here, and
  // the listing says they cannot. The nearest marker is fair game for a HINT — it describes where
  // you are standing, not the deployment.
  writeFileSync(join(home, ".pagevault.json"), JSON.stringify({ rung: 3, deployedUrl: "https://prod.invalid" }));

  const r = runIn(home, "deployments");
  assert.match(r.text, /prod is provisioned from this directory but does not say so/);
  assert.match(r.text, /pagevault login --as prod/);
  // A hint, never a silent write — the file on disk is untouched until the operator asks.
  assert.equal(JSON.parse(readFileSync(join(home, "deployments.json"), "utf8")).deployments.prod.markerPath, undefined);
});

test("login --as records where the build record is, without being told", () => {
  const home = registryHome();
  const marker = join(home, ".pagevault.json");
  writeFileSync(marker, JSON.stringify({ rung: 3, deployedUrl: "https://prod.invalid" }));

  // No --url, no --token: amending an existing entry must not require retyping credentials, which
  // is what makes this a usable migration for a registry written before markerPath existed.
  const r = runIn(home, "login", "--as", "prod");
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(readFileSync(join(home, "deployments.json"), "utf8")).deployments.prod.markerPath, marker);
  assert.match(runIn(home, "deployments").text, /prod\s+https:\/\/prod\.invalid\s+yes/);
});

test("login --as records nothing when the marker describes a different deployment", () => {
  const home = registryHome();
  writeFileSync(join(home, ".pagevault.json"), JSON.stringify({ rung: 3, deployedUrl: "https://prod.invalid" }));

  // Registering `test` while standing in prod's checkout must not hand test prod's build record.
  runIn(home, "login", "--as", "test");
  const saved = JSON.parse(readFileSync(join(home, "deployments.json"), "utf8")).deployments.test;
  assert.notEqual(saved.markerPath, join(home, ".pagevault.json"));
});

test("`use` selects the default and it survives into the next command", () => {
  const home = registryHome();
  const u = runIn(home, "use", "test");
  assert.equal(u.status, 0);
  assert.match(u.text, /test\s+https:\/\/test\.invalid/);
  assert.equal(JSON.parse(readFileSync(join(home, "deployments.json"), "utf8")).current, "test");

  // The next command targets it without being told.
  assert.match(runIn(home, "list").text, /→ test {2}https:\/\/test\.invalid/);
});

test("🔴 a name that names nothing is refused, never quietly downgraded", () => {
  // Falling through to the next rung means acting on a DIFFERENT deployment while the operator
  // believes they named one — the failure this whole ADR is about.
  const r = runIn(registryHome(), "list", "--deployment", "staging");
  assert.notEqual(r.status, 0);
  assert.match(r.text, /No deployment named "staging"/);
  assert.match(r.text, /Known: prod, test/);
  assert.doesNotMatch(r.text, /prod\.invalid/, "it must not have fallen through to the default");
});

test("every command says which deployment it chose, and why", () => {
  const home = registryHome();
  assert.match(runIn(home, "list").text, /→ prod {2}https:\/\/prod\.invalid {2}\(from the current deployment\)/);
  assert.match(runIn(home, "list", "--deployment", "test").text, /→ test {2}https:\/\/test\.invalid {2}\(from --deployment\)/);
});

test("🔴 a protected deployment requires --yes to destroy, and only to destroy", () => {
  // ADR-021 section 6. Set once on production, costs nothing on test, and does not train anyone to
  // hit `y` without reading — which is why it is a refusal rather than a prompt, and why publishing
  // is deliberately untouched.
  const home = registryHome();

  for (const cmd of [["rm", "abc123"], ["revoke", "abc123"], ["rotate", "abc123"]]) {
    const r = runIn(home, ...cmd);
    assert.notEqual(r.status, 0, `${cmd[0]} must refuse on a protected deployment`);
    assert.match(r.text, /prod is a protected deployment/);
    assert.match(r.text, /--yes/);
  }

  // Publishing, editing and sharing are unaffected: this one gets as far as the network.
  const p = runIn(home, "portals");
  assert.doesNotMatch(p.text, /protected deployment/, "a read must never be gated by `protected`");

  // And an unprotected deployment is not gated at all — it reaches the network instead.
  const t = runIn(home, "rm", "abc123", "--deployment", "test", "--yes");
  assert.doesNotMatch(t.text, /protected deployment/);
});

test("🔴 a build record gets its bearer from the registry, by URL (#159)", () => {
  // The bug: standing in a checkout, `status` reported the test deployment (from the marker) while
  // `list` and `publish` hit production, because the only bearer on the machine was the login
  // config's. The marker here stays a BUILD RECORD — no `deployment` key — which is what CI writes.
  const home = mkdtempSync(join(tmpdir(), "pv-byurl-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: "https://prod.invalid", token: "prod-bearer" }));
  writeFileSync(join(home, ".pagevault.json"), JSON.stringify({ rung: 3, accountId: "acct", host: "test.invalid" }));
  writeFileSync(
    join(home, "deployments.json"),
    JSON.stringify({ current: null, deployments: { test: { url: "https://test.invalid", token: "test-bearer" } } }),
  );

  const r = runIn(home, "list");
  assert.match(r.text, /→ test {2}https:\/\/test\.invalid/, "the checkout's deployment, named");
  assert.doesNotMatch(r.text, /No bearer/, "and its own bearer, so the command can actually run");
  assert.doesNotMatch(r.text, /prod\.invalid/, "production must not be touched from here");
});

test("without a matching entry the #155 refusal still stands", () => {
  // The registry adds a correct credential; it never loosens the rule about sending the wrong one.
  const home = mkdtempSync(join(tmpdir(), "pv-nobearer-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: "https://prod.invalid", token: "prod-bearer" }));
  writeFileSync(join(home, ".pagevault.json"), JSON.stringify({ rung: 3, accountId: "acct", host: "test.invalid" }));

  const r = runIn(home, "list");
  assert.notEqual(r.status, 0);
  assert.match(r.text, /No bearer for https:\/\/test\.invalid/);
  assert.match(r.text, /pagevault login --as/, "it must say how to fix it, not just that it refused");
  // Refusing is right; refusing without saying where it looked reads as a bug on a machine that
  // plainly holds a token (#195).
  assert.match(r.text, /looked in/);
});

test("🔴 the bearer `init` left in .env.local is one the document commands can find (#195)", () => {
  // The first thirty seconds after a successful first install. `init` sets the bearer as the Worker's
  // secret and writes this machine's copy to `.env.local` beside the build record — and `list` then
  // said there was no bearer, because `commandTarget` never looked there while `verify` and `health`,
  // resolving the identical target, did.
  const home = mkdtempSync(join(tmpdir(), "pv-statebearer-"));
  writeFileSync(join(home, ".pagevault.json"), JSON.stringify({ rung: 1, accountId: "acct", deployedUrl: "https://test.invalid" }));
  writeFileSync(join(home, ".env.local"), "CLOUDFLARE_API_TOKEN=cf\nPAGEVAULT_API_TOKEN=state-bearer\n");

  const r = runIn(home, "list");
  assert.doesNotMatch(r.text, /No bearer/, "it must get as far as the network, not refuse on this machine");
  assert.match(r.text, /Could not reach https:\/\/test\.invalid/, "and .invalid is where it tried");
});

test("🔴 a state bearer is not sent to a deployment its marker does not describe", () => {
  // The other half. `.env.local` belongs to the build record beside it, so naming a different
  // deployment must not pick it up — #155, one file over.
  const home = mkdtempSync(join(tmpdir(), "pv-statecross-"));
  writeFileSync(join(home, ".pagevault.json"), JSON.stringify({ rung: 1, accountId: "acct", deployedUrl: "https://test.invalid" }));
  writeFileSync(join(home, ".env.local"), "PAGEVAULT_API_TOKEN=test-bearer\n");

  const r = runIn(home, "list", "--url", "https://other.invalid");
  assert.notEqual(r.status, 0);
  assert.match(r.text, /No bearer for https:\/\/other\.invalid/);
});

test("--protected is a flag, in both directions, without retyping credentials", () => {
  // Hand-editing deployments.json was the only way to set this, which is a thin door for the
  // guardrail. Re-running `login --as` on a registered deployment amends it, so flipping a flag
  // does not mean re-supplying a bearer.
  const home = registryHome();
  const read = () => JSON.parse(readFileSync(join(home, "deployments.json"), "utf8")).deployments;

  runIn(home, "login", "--as", "test", "--protected");
  assert.equal(read().test.protected, true);
  assert.equal(read().test.token, "test-bearer", "credentials survive an amend");
  assert.equal(read().test.url, "https://test.invalid");
  assert.match(runIn(home, "rm", "abc", "--deployment", "test").text, /protected deployment/);

  runIn(home, "login", "--as", "test", "--no-protected");
  assert.equal(read().test.protected, false);
  assert.doesNotMatch(runIn(home, "rm", "abc", "--deployment", "test").text, /protected deployment/);
});

test("--protected without --as says where it belongs rather than dropping it", () => {
  // Protection is a property of a registry entry. Writing a config.json and silently discarding the
  // flag would leave an operator believing production was guarded.
  const home = mkdtempSync(join(tmpdir(), "pv-protnoas-"));
  const r = runIn(home, "login", "--url", "https://x.invalid", "--token", "t", "--protected");
  assert.notEqual(r.status, 0);
  assert.match(r.text, /--protected applies to a named deployment/);
  assert.ok(!existsSync(join(home, "config.json")), "and it must not have written the login it refused");
});

test("🔴 status names the deployment on BOTH branches (#170)", () => {
  // The name reached only the not-provisioned branch, so the deployment we know MOST about — the one
  // whose build record is on this machine — was the one that never said which deployment it was.
  // Standing in a checkout is exactly where the answer differs from your default, so it is where the
  // answer matters most.
  const home = mkdtempSync(join(tmpdir(), "pv-statusname-"));
  writeFileSync(join(home, ".pagevault.json"), JSON.stringify({ rung: 3, accountId: "acct", host: "test.invalid" }));
  writeFileSync(
    join(home, "deployments.json"),
    JSON.stringify({
      current: "prod",
      deployments: {
        prod: { url: "https://prod.invalid", token: "p", protected: true },
        test: { url: "https://test.invalid", token: "t" },
      },
    }),
  );

  // Provisioned here: the build record decides, and the name must still be stated.
  const provisioned = runIn(home, "status");
  assert.equal(provisioned.status, 0);
  assert.match(provisioned.text, /Deployment\s+test\s+https:\/\/test\.invalid/);
  assert.match(provisioned.text, /Resolved by/);
  assert.match(provisioned.text, /Tier/, "and it is still the build-record branch, not the other one");

  // The URL is not printed twice: `Deployed` only appears when it disagrees with what was resolved.
  assert.doesNotMatch(provisioned.text, /Deployed/);

  // --json carries the same answer, where there is no tone to read.
  const j = JSON.parse(runIn(home, "status", "--json").stdout);
  assert.equal(j.deploymentName, "test");
  assert.equal(j.provisioned, true);
});

test("a protected deployment says so in status", () => {
  const home = mkdtempSync(join(tmpdir(), "pv-statusprot-"));
  writeFileSync(
    join(home, "deployments.json"),
    JSON.stringify({ current: "prod", deployments: { prod: { url: "https://prod.invalid", token: "p", protected: true } } }),
  );
  assert.match(runIn(home, "status").text, /Protected\s+rm, revoke and rotate require --yes/);
});

test("a single-deployment install sees no name row it cannot use", () => {
  // No registry: there is no second answer to distinguish from, so the identity block shows the URL
  // and nothing invented. Same rule the document commands' target line follows.
  const home = mkdtempSync(join(tmpdir(), "pv-statusplain-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: "https://only.invalid", token: "t" }));
  const r = runIn(home, "status");
  assert.match(r.text, /Deployment\s+https:\/\/only\.invalid/);
  assert.doesNotMatch(r.text, /Protected/);
});

test("sync-views is dispatched, and refuses a filtered sync before touching the network", () => {
  // Whole-deployment by design: a partial summary reports a MEASURED zero for every document it
  // left out, which is the lie that matters ("the client never opened it").
  const r = runIn(registryHome(), "sync-views", "--portal", "acme");
  assert.notEqual(r.status, 0);
  assert.match(r.text, /--portal cannot be combined with sync-views/);
});

test("🔴 `views --sync` still works, and says where it moved", () => {
  // Kept rather than cut: it is in the docs, in muscle memory, and quite possibly in a crontab —
  // and a scheduled sync that starts failing silently is the exact failure ADR-023 §9 exists to
  // prevent. The note goes to stderr so a --json pipe is unaffected.
  const r = runIn(registryHome(), "views", "--sync", "--portal", "acme");
  assert.match(r.text, /is now `pagevault sync-views`/);
  assert.match(r.text, /--portal cannot be combined with sync-views/, "it still reached the real command");
});

test("both forms are reachable from help, and views no longer advertises the flag", () => {
  assert.match(runIn(registryHome(), "help", "sync-views").text, /Move view counts out of Analytics Engine/);
  // `views` is now described as read-only, and points at the command that makes numbers durable.
  const views = runIn(registryHome(), "help", "views").text;
  assert.match(views, /A read-only look/);
  assert.match(views, /pagevault sync-views/);
});

// --- View tracking across a re-deploy (#187) --------------------------------
//
// The bug: `opts.analytics ?? ctx.analytics`, falling back to false when non-interactive. Production
// rebuilds .pagevault.json in CI from a secret that never mentioned analytics, so every deploy
// re-decided "off" from silence — and the Worker recorded nothing for eight releases while every
// surface reported healthy zeros.
//
// What these pin is the precedence, in both directions. The live Worker is IN the chain, not merely
// asserted against: a deployment that already answered the question keeps its answer for free.

test("🔴 a re-deploy that asks for nothing keeps what the deployment already has (#187)", () => {
  // The production case exactly: no flag, an intent file that never mentions analytics, and a
  // Worker that binds ANALYTICS. Before the fix this resolved to false, silently.
  assert.deepEqual(resolveAnalytics({ flag: undefined, declared: undefined, live: true }), {
    value: true,
    source: "live",
    downgrade: false,
  });
});

test("never having had view tracking is not a downgrade — it stays off, quietly", () => {
  assert.deepEqual(resolveAnalytics({ flag: undefined, declared: undefined, live: false }), {
    value: false,
    source: "live",
    downgrade: false,
  });
});

test("🔴 a contradiction refuses rather than picking a side", () => {
  // Declared off, deployed on. Guessing either way loses something: honour the file and days of
  // history stop existing; honour the Worker and an explicit instruction is ignored.
  const r = resolveAnalytics({ flag: undefined, declared: false, live: true });
  assert.equal(r.value, false);
  assert.equal(r.source, "declared");
  assert.equal(r.downgrade, true);
});

test("--no-analytics is the override, and the only way off", () => {
  // Said out loud on THIS run, so it is a decision rather than an omission — no refusal.
  for (const declared of [undefined, true, false]) {
    const r = resolveAnalytics({ flag: false, declared, live: true });
    assert.equal(r.value, false, `declared=${declared}`);
    assert.equal(r.source, "flag");
    assert.equal(r.downgrade, false, "an explicit off is never a downgrade");
  }
});

test("--analytics turns it on where the deployment does not have it", () => {
  // The CI first-enable path: one dispatch with analytics=on, and from then on `live` carries it.
  const r = resolveAnalytics({ flag: true, declared: false, live: false });
  assert.equal(r.value, true);
  assert.equal(r.source, "flag");
});

test("🔴 an unreadable deployment can never strip a capability", () => {
  // live=null is a first-ever deploy, a token that cannot read script settings, or a network blip.
  // Every one of those must degrade to the old behaviour — undefined, for the caller to prompt or
  // default — and none of them may produce a downgrade, which would strip the binding on a bad
  // connection. That is a worse bug than the one being fixed.
  for (const declared of [undefined, true, false]) {
    const r = resolveAnalytics({ flag: undefined, declared, live: null });
    assert.equal(r.downgrade, false, `declared=${declared}`);
    assert.equal(r.value, declared, "falls back to declared intent, or to nothing");
  }
  assert.equal(resolveAnalytics({ flag: undefined, declared: undefined, live: null }).source, "unset");
});

test("declared intent still beats the live binding", () => {
  // Intent on, Worker without it — a deployment being turned on for the first time. Nothing to
  // refuse: adding a capability is not the direction that loses data.
  const r = resolveAnalytics({ flag: undefined, declared: true, live: false });
  assert.equal(r.value, true);
  assert.equal(r.source, "declared");
  assert.equal(r.downgrade, false);
});

// --- The binding at rung 1 and 2 (#190) -------------------------------------
//
// Rung 3 stripped the Analytics Engine block when view tracking was off; rungs 1 and 2 filled the
// template in and never touched it. So every rung 1–2 deploy bound ANALYTICS whether or not the
// account had Analytics Engine — and wrangler refuses the whole deploy with error 10089 when the
// binding is present and the product is off. Rung 1 is the fork's on-ramp, which made that a fresh
// account's very first `pagevault init`.
//
// The fix is one strip function shared by both writers, so these pin the shared piece rather than
// each caller: two copies of that regex is exactly how the gap appeared.

test("🔴 rung 1–2 and rung 3 agree on the Analytics Engine binding (#190)", () => {
  const template = readFileSync(new URL("../worker/wrangler.jsonc", import.meta.url), "utf8");

  // The template ships WITH the binding — that is what made an unconditional fill-in bind it.
  assert.equal(bindsAnalytics(template), true, "the template declares the block");

  // Both writers call this one function, so "the two rungs agree" is a property of the strip, not
  // of two code paths that happen to match today.
  const stripped = stripAnalyticsBinding(template);
  assert.equal(bindsAnalytics(stripped), false, "off strips the block");
  assert.ok(!stripped.includes("ANALYTICS"), "and the binding name goes with it");
  assert.ok(!stripped.includes("pagevault_views"), "and the dataset name too");

  // Nothing else may go. The block sits between the browser binding and vars; a greedy match would
  // take them with it, and the deploy would fail far away from here.
  assert.ok(stripped.includes('"binding": "BROWSER"'), "the browser binding survives");
  assert.ok(stripped.includes('"PAGEVAULT_VERSION"'), "vars survive");
  assert.ok(stripped.includes("REPLACE_WITH_KV_NAMESPACE_ID"), "the KV placeholder survives");

  // Idempotent: a config that never had the block is not corrupted by stripping it again.
  assert.equal(stripAnalyticsBinding(stripped), stripped);

  // Rung 2 inserts a `routes` line above "observability", which today sits well below the block.
  // Pin that the strip is order-independent rather than trusting the two edits to stay apart —
  // "these substitutions happen not to collide" is not a property anyone will re-check.
  const rung2 = template.replace(
    /"observability": \{/,
    `"routes": [{ "pattern": "x.example.com", "custom_domain": true }],\n\n  "observability": {`,
  );
  const rung2Stripped = stripAnalyticsBinding(rung2);
  assert.equal(bindsAnalytics(rung2Stripped), false, "off strips the block at rung 2 too");
  assert.ok(rung2Stripped.includes('"pattern": "x.example.com"'), "and the rung-2 route survives");

  // 🔴 CRLF. Windows checks out the template with `\r\n`, and the block is matched on newlines — so
  // an `\n`-only pattern matched nothing there and the strip silently did nothing. Rung 3 with view
  // tracking off was broken on Windows for as long as the regex existed; the Windows CI job caught
  // it the first time a test touched this function. Keep this case.
  const crlf = template.replace(/\r?\n/g, "\r\n");
  const crlfStripped = stripAnalyticsBinding(crlf);
  assert.equal(bindsAnalytics(crlfStripped), false, "a CRLF config strips too");
  assert.ok(!/[^\r]\n/.test(crlfStripped), "and no lone LF is introduced into a CRLF file");
});

test("🔴 rung 1–2 defaults view tracking OFF when nothing has an opinion (#190)", () => {
  // The fresh-account first deploy: no flag, no .pagevault.json answer, no Worker to read. Rung 3
  // interviews the operator here; rungs 1–2 have no interview, so `undefined` has to become `false`
  // rather than binding a product the account may not have enabled.
  const r = resolveAnalytics({ flag: undefined, declared: undefined, live: null });
  assert.equal(r.value, undefined, "resolution itself stays honest about knowing nothing");
  assert.equal(r.downgrade, false, "and a first deploy is never a downgrade");

  // What rung 1–2 does with that, mirrored from tier0.mjs.
  assert.equal(r.value ?? false, false);

  // And the default stays a default: rung 1–2 does not write it to .pagevault.json, so climbing to
  // rung 3 still reaches the interview instead of inheriting a `declared: false` nobody chose.
  const tier0 = readFileSync(new URL("./lib/provision/tier0.mjs", import.meta.url), "utf8");
  assert.ok(!/saveContext\(\{[^}]*\banalytics\b/.test(tier0), "tier0 must not persist the analytics default");
});

test("rung 1–2 keeps a binding the live Worker already has (#190, ADR-024)", () => {
  // The same protection rung 3 got in #187: a rung-1 deployment recording views does not lose them
  // because a later deploy said nothing. `live` is in the chain at every rung now.
  assert.equal(resolveAnalytics({ flag: undefined, declared: undefined, live: true }).value, true);
  // And an explicit flag still reaches rung 1–2, which is the other half of the issue: the flag used
  // to warn that it had nowhere to go.
  assert.equal(resolveAnalytics({ flag: true, declared: undefined, live: null }).value, true);
  assert.equal(resolveAnalytics({ flag: false, declared: undefined, live: true }).downgrade, false);
});

test("view tracking can be set by flag or by environment, and the flag wins", () => {
  assert.equal(analyticsChoice({ analytics: true }, {}), true);
  assert.equal(analyticsChoice({ "no-analytics": true }, {}), false);
  // `--analytics off` too: parseArgs takes the next token as a value, so both spellings arrive.
  assert.equal(analyticsChoice({ analytics: "off" }, {}), false);
  assert.equal(analyticsChoice({ analytics: "ON" }, {}), true);

  // The environment is what a CI-deployed production has — there is no prompt to answer there.
  assert.equal(analyticsChoice({}, { PAGEVAULT_ANALYTICS: "on" }), true);
  assert.equal(analyticsChoice({}, { PAGEVAULT_ANALYTICS: "off" }), false);
  assert.equal(analyticsChoice({ "no-analytics": true }, { PAGEVAULT_ANALYTICS: "on" }), false);

  // "Didn't say" has to survive the round trip: the workflow emits an empty string on `unchanged`.
  assert.equal(analyticsChoice({}, {}), undefined);
  assert.equal(analyticsChoice({}, { PAGEVAULT_ANALYTICS: "" }), undefined);
  assert.equal(analyticsChoice({}, { PAGEVAULT_ANALYTICS: "  " }), undefined);
});

test("🔴 a typo'd view-tracking value is fatal, not ignored", () => {
  // Silently reading as "didn't say" is the same failure the whole issue is about: a setting that
  // reads as applied and isn't. Run out-of-process because the real path calls die().
  // A file:// URL, not a path. On Windows `C:\…` is not a valid ESM specifier — Node reads the
  // drive letter as a URL scheme and throws ERR_UNSUPPORTED_ESM_URL_SCHEME, which still exits
  // non-zero and so still looked like a pass on the exit code alone.
  const mod = new URL("./lib/provision/context.mjs", import.meta.url).href;
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import {analyticsChoice} from ${JSON.stringify(mod)}; analyticsChoice({}, {PAGEVAULT_ANALYTICS: "yes-please"})`],
    { encoding: "utf8" },
  );
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /Unrecognised PAGEVAULT_ANALYTICS value: yes-please/);
});

test("upgrade documents both directions, and says which one is the accident", () => {
  const help = run("help", "upgrade").text;
  assert.match(help, /--analytics/);
  assert.match(help, /--no-analytics/);
  assert.match(help, /keeps view tracking exactly as the/);
});

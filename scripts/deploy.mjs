#!/usr/bin/env node
//
// make deploy — generate the config for your rung, deploy the Worker, remember the URL.
//
// Rung 1–2 write a Tier-0 config (tier0.mjs); rung 3 provisions Access (provision.mjs).
// You never pass the tier — it's a fact in .pagevault.json, set by `make setup`.
//
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { c, ok, info, warn, die, loadContext, saveContext, loadCloudToken, isInteractive, wranglerAccount } from "./context.mjs";

const CONFIG_OUT = "worker/wrangler.generated.jsonc";

loadCloudToken(); // .env.local token → environment, so wrangler targets the right account
const ctx = loadContext();
if (!ctx.rung || !ctx.ownerEmail) die("No .pagevault.json yet.", "Run `make setup` first.");

console.log(`\n${c.bold("PageVault — deploy")} ${c.dim(`(rung ${ctx.rung})`)}\n`);

// --- 0. 🔴 WHERE are we deploying? Name it, verify it, confirm it. ----------
//
// The guard that stops a wrong-account clobber (#32): preflight pins the account; here we
// refuse if the live wrangler auth can't reach it, and state the target before mutating.

const acct = wranglerAccount();
if (!acct.ok) die("Not signed in to wrangler.", "make login, or put a token in .env.local");
if (!ctx.accountId) die("No account pinned yet.", "Run `make preflight` first — it names and pins the account.");
const target = acct.accounts.find((a) => a.id === ctx.accountId);
if (!target) {
  die(
    `You're signed in as ${acct.email}, which can't reach the pinned account ${ctx.accountId}.`,
    "Switch accounts (export CLOUDFLARE_API_TOKEN=<that account's token>), or re-pin with `make preflight`.",
  );
}

console.log(`  Target: ${c.bold(target.name)} ${c.dim(target.id)}  ${c.dim(`· ${acct.email ?? ""}`)}\n`);
if (isInteractive()) {
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question(`  Deploy "pagevault" to ${c.bold(target.name)}? [y/N] `)).trim().toLowerCase();
  rl.close();
  if (ans !== "y") die("Cancelled — nothing was deployed.");
}

// --- 1. Generate the tier-appropriate config -------------------------------

const generator = ctx.rung >= 3 ? "scripts/provision.mjs" : "scripts/tier0.mjs";
info(ctx.rung >= 3 ? "Provisioning Access (rung 3)…" : "Writing the Tier-0 config…");
try {
  execSync(`node ${generator}`, { stdio: "inherit" });
} catch {
  die("Config generation failed — see the output above.");
}

// --- 2. Deploy -------------------------------------------------------------

info("Deploying the Worker…");
let out = "";
try {
  out = execSync(`npx --yes wrangler@4 deploy --config ${CONFIG_OUT}`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(out);
} catch (err) {
  process.stdout.write(err.stdout ?? "");
  process.stderr.write(err.stderr ?? "");
  die("Deploy failed — see wrangler's output above.");
}

// --- 3. Remember where it landed, so `make verify` knows what to test -------

const url =
  out.match(/https:\/\/[^\s]+\.workers\.dev[^\s]*/)?.[0] ??
  (ctx.host ? `https://${ctx.host}` : undefined);
if (url) {
  saveContext({ ...loadContext(), deployedUrl: url });
  ok(`Live at ${c.bold(url)}`);
} else {
  warn("Deployed, but couldn't read the URL from wrangler's output — check above.");
}

// --- 4. Is the API token secret set? ---------------------------------------

let hasSecret = false;
try {
  const secrets = JSON.parse(
    execSync(`npx --yes wrangler@4 secret list --config ${CONFIG_OUT}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  hasSecret = Array.isArray(secrets) && secrets.some((s) => s.name === "PAGEVAULT_API_TOKEN");
} catch {
  // Non-fatal — just means we can't confirm; fall through to the reminder.
}

console.log();
if (!hasSecret) {
  warn("PAGEVAULT_API_TOKEN is not set — the CLI and MCP server can't authenticate yet.");
  console.log(`  ${c.bold(`npx wrangler secret put PAGEVAULT_API_TOKEN --config ${CONFIG_OUT}`)}\n`);
}
console.log(`${c.bold("Next:")} ${c.bold("make verify")} ${c.dim("— smoke-test the live deployment.")}`);
console.log(`  ${c.dim("Then publish a document over MCP and open its /p/ link.")}\n`);

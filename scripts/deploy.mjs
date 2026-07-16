#!/usr/bin/env node
//
// make deploy — generate the config for your rung, deploy the Worker, remember the URL.
//
// Rung 1–2 write a Tier-0 config (tier0.mjs); rung 3 provisions Access (provision.mjs).
// You never pass the tier — it's a fact in .pagevault.json, set by `make setup`.
//
import { execSync } from "node:child_process";
import { c, ok, info, warn, die, loadContext, saveContext } from "./context.mjs";

const CONFIG_OUT = "worker/wrangler.generated.jsonc";

const ctx = loadContext();
if (!ctx.rung || !ctx.ownerEmail) die("No .pagevault.json yet.", "Run `make setup` first.");

console.log(`\n${c.bold("PageVault — deploy")} ${c.dim(`(rung ${ctx.rung})`)}\n`);

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

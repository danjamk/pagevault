#!/usr/bin/env node
//
// make deploy — verify the account, ensure a workers.dev subdomain, deploy, set the bearer
// secret, remember the URL. Rung 1–2 write a Tier-0 config (tier0.mjs); rung 3 provisions
// Access (provision.mjs). You never pass the tier — it's a fact in .pagevault.json. Auth is
// the .env.local token, which is what lets us do the subdomain and the secret over the API.
//
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { stdin, stdout } from "node:process";
import {
  c, ok, info, warn, die, loadContext, saveContext, loadCloudToken, isInteractive, cfApi, cfAccounts, cfErr, slug,
  writeEnvLocalVar, acct, shortId,
} from "./context.mjs";

const CONFIG_OUT = "worker/wrangler.generated.jsonc";

loadCloudToken();
const ctx = loadContext();
if (!ctx.rung || !ctx.ownerEmail) die("No .pagevault.json yet.", "Run `make setup` first.");

console.log(`\n${c.head("PageVault — deploy")} ${c.dim(`(rung ${ctx.rung} → ${shortId(ctx.accountId)})`)}\n`);

// --- 0. WHERE? Verify the pinned account, name it once, confirm it ---------

const accounts = await cfAccounts();
if (accounts.length === 0) die("No Cloudflare token, or it reaches no account.", "Run `make preflight` — it names the problem.");
if (!ctx.accountId) die("No account pinned yet.", "Run `make setup` first — it pins the account.");
const target = accounts.find((a) => a.id === ctx.accountId);
if (!target) {
  die(`Your token reaches ${accounts.map((a) => shortId(a.id)).join(", ")}, not the pinned ${shortId(ctx.accountId)}.`,
    "Use the token for the pinned account, or re-pin with `make setup`.");
}

const targetUrl = ctx.rung >= 2 && ctx.host ? `https://${ctx.host}` : "*.workers.dev";
const row = (label, val) => console.log(`  ${c.cyan(label.padStart(12))}  ${val}`);
row("Deploying to", acct(target));
row("Owner", ctx.ownerEmail);
row("URL", c.bold(targetUrl));
console.log();
if (isInteractive()) {
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question(`  Continue? [y/N] `)).trim().toLowerCase();
  rl.close();
  if (ans !== "y") die("Cancelled — nothing was deployed.");
}

// --- 0b. rung 1: a fresh account has no workers.dev subdomain. Register one. -

if (ctx.rung < 2) {
  const sub = await cfApi(`/accounts/${target.id}/workers/subdomain`);
  if (sub.result?.subdomain) {
    ok(`workers.dev subdomain: ${c.dim(sub.result.subdomain)}`);
  } else {
    let name = slug(ctx.ownerEmail.split("@")[0]);
    if (isInteractive()) {
      const rl = createInterface({ input: stdin, output: stdout });
      const ans = (
        await rl.question(
          `\n  This account has no workers.dev subdomain yet.\n` +
            `  Register ${c.bold(`${name}.workers.dev`)}?  [Enter to accept · type another name · "n" to cancel] `,
        )
      ).trim();
      rl.close();
      if (/^n(o)?$/i.test(ans)) die("A workers.dev subdomain is required for rung 1.");
      if (ans && !/^y(es)?$/i.test(ans)) name = slug(ans);
    }
    info(`Registering ${name}.workers.dev…`);
    const put = await cfApi(`/accounts/${target.id}/workers/subdomain`, {
      method: "PUT",
      body: JSON.stringify({ subdomain: name }),
    });
    if (!put.ok) die(`Couldn't register "${name}.workers.dev" (${cfErr(put.errors)}).`, "That name may be taken — re-run and pick another.");
    ok(`Registered ${c.bold(`${name}.workers.dev`)}`);
  }
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
  out = execSync(`npx --yes wrangler@4 deploy --config ${CONFIG_OUT}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  process.stdout.write(out);
} catch (err) {
  const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  process.stdout.write(err.stdout ?? "");
  process.stderr.write(err.stderr ?? "");
  if (/workers\.dev subdomain/i.test(output)) {
    die("This account still has no workers.dev subdomain.",
      "Odd — the step above should have registered one. Re-run `make deploy`.");
  }
  die("Deploy failed — see wrangler's output above.");
}

// --- 3. Remember where it landed, so `make verify` knows what to test -------

// At rung 2+ the canonical URL is the custom domain (workers.dev is off there); at rung 1 it's
// the workers.dev URL wrangler printed. Getting this right is what points verify and the /p/
// links at the domain, not a stray workers.dev address.
const url =
  ctx.rung >= 2 && ctx.host
    ? `https://${ctx.host}`
    : (out.match(/https:\/\/[^\s]+\.workers\.dev[^\s]*/)?.[0] ?? (ctx.host ? `https://${ctx.host}` : undefined));
if (url) {
  saveContext({ ...loadContext(), deployedUrl: url });
  ok(`Live at ${c.bold(url)}`);
} else {
  warn("Deployed, but couldn't read the URL from wrangler's output — check above.");
}

// --- 4. The bearer secret — generate and set it over the API ---------------
//
// PAGEVAULT_API_TOKEN is what the CLI and MCP server authenticate with (a different token
// from the Cloudflare one). The token model lets us set it via the API, so there is no
// `wrangler secret put` step to run by hand in a wrong-Node shell.

const existing = await cfApi(`/accounts/${target.id}/workers/scripts/pagevault/secrets`);
const hasSecret = existing.ok && (existing.result ?? []).some((s) => s.name === "PAGEVAULT_API_TOKEN");

console.log();
if (hasSecret) {
  ok("PAGEVAULT_API_TOKEN is already set.");
} else {
  const value = randomBytes(32).toString("hex");
  const put = await cfApi(`/accounts/${target.id}/workers/scripts/pagevault/secrets`, {
    method: "PUT",
    body: JSON.stringify({ name: "PAGEVAULT_API_TOKEN", text: value, type: "secret_text" }),
  });
  if (put.ok) {
    // Save it locally too: the Worker now has this secret, but so must the CLI, the MCP
    // bearer, and `make verify` (which publishes the welcome doc). .env.local is gitignored.
    writeEnvLocalVar("PAGEVAULT_API_TOKEN", value);
    ok("PAGEVAULT_API_TOKEN set on the Worker and saved to .env.local (your CLI / MCP bearer):");
    console.log(`     ${c.bold(value)}`);
    console.log(`     ${c.dim("Same token the Worker uses — verify will publish your first document with it.")}`);
  } else {
    warn(`Couldn't set PAGEVAULT_API_TOKEN automatically (${cfErr(put.errors)}).`);
    console.log(`  Set it by hand under Node 22: ${c.bold(`npx wrangler secret put PAGEVAULT_API_TOKEN --config ${CONFIG_OUT}`)}`);
  }
}

console.log(`\n${c.bold("Next:")} ${c.bold("make verify")} ${c.dim("— smoke-test the deployment and publish your first document.")}`);
console.log(`  ${c.dim("It hands back a public /p/ link you can open immediately — no login, no Access.")}\n`);

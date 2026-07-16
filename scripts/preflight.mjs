#!/usr/bin/env node
//
// make preflight — before deploy: is your Cloudflare account ready for the rung you chose?
// Read-only, mutates NOTHING. Reads the rung from .pagevault.json and checks only what that
// rung needs — no domain or Zero-Trust nagging at rung 1.
//
// Auth is the API token in .env.local: explicit and per-clone, so there is no ambient login
// to guess at (which is how a wrong-account deploy once clobbered production). Collects every
// gap in one pass and names the fix.
//
import { versions } from "node:process";
import { c, die, loadContext, saveContext, loadCloudToken, argValue, cfApi, cfErr } from "./context.mjs";

const ctx = loadContext();
const rung = ctx.rung ?? 1;
const host = ctx.host ?? "";
const token = loadCloudToken();

console.log(`\n${c.bold("PageVault — preflight")} ${c.dim(`(read-only · rung ${rung})`)}\n`);

const findings = [];
const pass = (label, detail) => findings.push({ level: "pass", label, detail });
const warn = (label, detail, fix) => findings.push({ level: "warn", label, detail, fix });
const fail = (label, detail, fix) => findings.push({ level: "fail", label, detail, fix });

function report() {
  const icon = { pass: c.green("✓"), warn: c.yellow("!"), fail: c.red("✗") };
  console.log();
  for (const f of findings) {
    console.log(`  ${icon[f.level]} ${c.bold(f.label)} — ${f.detail}`);
    if (f.fix) console.log(`      ${c.dim("→ " + f.fix)}`);
  }
  const fails = findings.filter((f) => f.level === "fail").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  console.log();
  if (fails) {
    console.log(`  ${c.red(`${fails} blocker(s)`)}${warns ? `, ${warns} note(s)` : ""}. Fix, then re-run.\n`);
    process.exit(1);
  }
  console.log(`  ${c.green("Ready for rung " + rung + ".")}${warns ? ` ${warns} note(s) above.` : ""}  Next: ${c.bold("make deploy")}\n`);
  process.exit(0);
}

// --- 1. Node ---------------------------------------------------------------

Number(versions.node.split(".")[0]) >= 22
  ? pass("Node", versions.node)
  : fail("Node", `${versions.node} — Wrangler 4 needs 22+`, "nvm install 22 && nvm use 22, or https://nodejs.org");

// --- 2. The token — required at every rung ---------------------------------

if (!token) {
  fail("Cloudflare token", "no API token — nothing can deploy", [
    "Create one at https://dash.cloudflare.com/profile/api-tokens (scopes in docs/setup/prerequisites.md),",
    "then save it:  echo 'CLOUDFLARE_API_TOKEN=…' > .env.local",
  ].join(" "));
  report();
}

const verify = await cfApi("/user/tokens/verify");
if (!verify.ok) {
  fail("Cloudflare token", `rejected (HTTP ${verify.status}) ${cfErr(verify.errors)}`,
    "Recreate it at https://dash.cloudflare.com/profile/api-tokens with the right scopes.");
  report();
}
pass("Cloudflare token", "valid");

// --- 3. The account — name it, pin it, refuse a mismatch -------------------

const accts = await cfApi("/accounts");
const accounts = accts.ok ? accts.result ?? [] : [];
if (accounts.length === 0) {
  fail("Cloudflare account", `token is valid but reaches no accounts ${cfErr(accts.errors)}`, "Add 'Account Settings — Read' to the token.");
  report();
}

let account;
const pinned = ctx.accountId;
const match = pinned ? accounts.find((a) => a.id === pinned) : undefined;
if (pinned && !match) {
  fail("Cloudflare account", `pinned to ${pinned}, but this token reaches ${accounts.map((a) => a.id).join(", ")}`,
    "Use the token for the pinned account, or re-pin by editing .pagevault.json.");
  report();
} else if (match) {
  account = match;
  pass("Cloudflare account", `${account.name} ${c.dim(account.id)} ${c.green("(pinned)")}`);
} else if (accounts.length === 1) {
  account = accounts[0];
  saveContext({ ...ctx, accountId: account.id, accountName: account.name });
  pass("Cloudflare account", `${account.name} ${c.dim(account.id)} ${c.dim("— pinned to .pagevault.json")}`);
} else {
  const pick = argValue("--account");
  account = accounts.find((a) => a.id === pick || a.name === pick);
  if (account) {
    saveContext({ ...ctx, accountId: account.id, accountName: account.name });
    pass("Cloudflare account", `${account.name} ${c.dim(account.id)} ${c.dim("— pinned")}`);
  } else {
    fail("Cloudflare account", `token reaches ${accounts.length} accounts — you must pick one`,
      `Run \`node scripts/preflight.mjs --account <id>\`. Accounts: ${accounts.map((a) => `${a.name} (${a.id})`).join(" · ")}`);
    report();
  }
}

// --- 4. Workers KV reachable ----------------------------------------------

const kv = await cfApi(`/accounts/${account.id}/storage/kv/namespaces?per_page=100`);
kv.ok
  ? pass("Workers KV", "reachable")
  : fail("Workers KV", `not reachable ${cfErr(kv.errors)}`, "Add 'Workers KV Storage — Edit' to the token.");

// --- 5. rung 2: the domain must be a zone in this account ------------------

if (rung >= 2 && host) {
  const zoneName = host.split(".").slice(-2).join(".");
  const z = await cfApi(`/zones?name=${encodeURIComponent(zoneName)}`);
  const zone = z.ok ? z.result?.[0] : null;
  if (!zone) fail("Domain zone", `"${zoneName}" is not a zone on this account`, "Add it via Cloudflare Registrar, or move it in.");
  else if (zone.account?.id !== account.id) fail("Domain zone", `"${zoneName}" is in a different account`, "Move it into this account.");
  else if (zone.status !== "active") warn("Domain zone", `"${zoneName}" is "${zone.status}" — nameservers may not be live yet`);
  else pass("Domain zone", `${zone.name} active`);
}

// --- 6. rung 3: Zero Trust enabled (detect only — never enable) -----------

if (rung >= 3) {
  const org = await cfApi(`/accounts/${account.id}/access/organizations`);
  org.ok && org.result?.auth_domain
    ? pass("Zero Trust", `enabled (${org.result.auth_domain.replace(/\.cloudflareaccess\.com$/, "")})`)
    : fail("Zero Trust", "not enabled", "Enable at https://one.dash.cloudflare.com (Free plan; needs a card). Do this last.");
}

report();

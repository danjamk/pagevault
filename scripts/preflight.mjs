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
import { createInterface } from "node:readline/promises";
import { stdin, stdout, versions } from "node:process";
import { c, loadContext, saveContext, loadCloudToken, argValue, cfApi, cfErr, tokenSetupFlow, isInteractive, slug } from "./context.mjs";

const ctx = loadContext();
const rung = ctx.rung ?? 1;
const host = ctx.host ?? "";
let token = loadCloudToken();

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
  console.log(`  ${c.red("✗")} ${c.bold("Cloudflare token")} — none set; nothing can deploy.\n`);
  const saved = await tokenSetupFlow();
  if (!saved) {
    console.log(`\n  ${c.bold("Next:")} save the token, then re-run ${c.bold("make preflight")}.\n`);
    process.exit(1);
  }
  token = loadCloudToken(); // pick up what we just wrote — and keep going, no second run needed
  console.log(`\n  ${c.green("✓")} Token saved — continuing preflight.\n`);
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
  else {
    pass("Domain zone", `${zone.name} active`);
    // 🔴 A Worker custom domain creates its OWN DNS record for the hostname, and Cloudflare
    // refuses if one already exists. Catch the conflict here, not at deploy.
    const dns = await cfApi(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}`);
    if (!dns.ok) {
      warn("DNS record", `couldn't check for an existing "${host}" record (${cfErr(dns.errors)})`,
        "Add 'DNS — Read' to the token, or just watch for a conflict at deploy.");
    } else if ((dns.result ?? []).length) {
      fail("DNS record", `"${host}" already has a ${dns.result[0].type} record — a custom domain can't be created over it`,
        `Delete the "${host}" record in Cloudflare DNS, or pick another hostname (make setup).`);
    } else {
      pass("DNS record", `"${host}" is free`);
    }
  }
}

// --- 6. rung 3: Zero Trust enabled (detect only — never enable) -----------

if (rung >= 3) {
  const org = await cfApi(`/accounts/${account.id}/access/organizations`);
  org.ok && org.result?.auth_domain
    ? pass("Zero Trust", `enabled (${org.result.auth_domain.replace(/\.cloudflareaccess\.com$/, "")})`)
    : fail("Zero Trust", "not enabled", "Enable at https://one.dash.cloudflare.com (Free plan; needs a card). Do this last.");
}

// --- 7. The plan — what deploy will do, and a domain you could use instead --
//
// Preflight is the last stop before a mutation, so it doubles as a preview: name the
// account and the exact URL, and — at rung 1 — offer a domain you already own, so you
// don't have to know up front that rung 2 exists.

if (!findings.some((f) => f.level === "fail")) {
  const sub = await cfApi(`/accounts/${account.id}/workers/subdomain`);
  const subName = sub.result?.subdomain ?? slug(ctx.ownerEmail?.split("@")[0] ?? "pagevault");
  const workersUrl = `https://pagevault.${subName}.workers.dev`;

  console.log();
  console.log(`  ${c.bold("Plan")} ${c.dim(`(rung ${rung})`)}`);
  console.log(`     Account:  ${account.name} ${c.dim(account.id)}`);
  console.log(
    rung >= 2 && host
      ? `     URL:      ${c.bold(`https://${host}`)}  ${c.dim("(your domain)")}`
      : `     URL:      ${c.bold(workersUrl)}  ${sub.result?.subdomain ? "" : c.dim(`(subdomain "${subName}" created at deploy)`)}`,
  );
  console.log(`     Creates:  a KV namespace${rung >= 3 ? ", Access apps + viewer group" : ""}, and your bearer secret`);

  // At rung 1, if you already own a domain in this account, offer it — no need to know
  // rung 2 exists to find it.
  if (rung < 2 && isInteractive()) {
    const z = await cfApi("/zones?per_page=50");
    const zones = (z.ok ? z.result ?? [] : []).filter((x) => x.account?.id === account.id && x.status === "active");
    if (zones.length) {
      console.log();
      console.log(`  You own ${zones.length === 1 ? "a domain" : "domains"} here: ${c.bold(zones.map((x) => x.name).join(", "))}`);
      const rl = createInterface({ input: stdin, output: stdout });
      const yes = (await rl.question(`  Serve PageVault on your domain instead of workers.dev? [y/N] `)).trim().toLowerCase();
      if (yes === "y" || yes === "yes") {
        const suggested = `pagevault.${zones[0].name}`;
        const h = (await rl.question(`  Hostname? [${suggested}] `)).trim() || suggested;
        rl.close();
        saveContext({ ...loadContext(), rung: 2, host: h });
        console.log(`\n  ${c.green("Switched to rung 2")} — ${c.bold(h)}. Re-run ${c.bold("make preflight")} to verify it, then ${c.bold("make deploy")}.\n`);
        process.exit(0);
      }
      rl.close();
    }
  }
}

report();

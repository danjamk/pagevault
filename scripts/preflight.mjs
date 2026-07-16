#!/usr/bin/env node
//
// make preflight — before deploy: is your Cloudflare account ready for the rung you chose?
// Read-only, mutates NOTHING, and it reads what rung you want from .pagevault.json so it
// only checks what that rung needs — no domain or Zero Trust nagging at rung 1.
//
// It collects every gap in one pass and names the fix, rather than dying on the first.
//
import { versions } from "node:process";
import { c, ok, die, loadContext, saveContext, fromEnv, argValue, wranglerAccount } from "./context.mjs";

const API = "https://api.cloudflare.com/client/v4";

const ctx = loadContext();
const rung = ctx.rung ?? 1;
const host = ctx.host ?? "";

console.log(`\n${c.bold("PageVault — preflight")} ${c.dim(`(read-only · rung ${rung})`)}\n`);

const findings = [];
const pass = (label, detail) => findings.push({ level: "pass", label, detail });
const warn = (label, detail, fix) => findings.push({ level: "warn", label, detail, fix });
const fail = (label, detail, fix) => findings.push({ level: "fail", label, detail, fix });

async function api(token, path) {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const body = await res.json().catch(() => null);
    return { ok: res.ok && body?.success, status: res.status, result: body?.result, errors: body?.errors ?? [] };
  } catch (err) {
    return { ok: false, status: 0, result: null, errors: [{ code: 0, message: String(err) }] };
  }
}
const errText = (e) => e.map((x) => `[${x.code}] ${x.message}`).join("; ");

// --- 1. Node --------------------------------------------------------------

Number(versions.node.split(".")[0]) >= 22
  ? pass("Node", versions.node)
  : fail("Node", `${versions.node} — Wrangler 4 needs 22+`, "nvm install 22 && nvm use 22, or https://nodejs.org");

// --- 2. WHICH Cloudflare account? -----------------------------------------
//
// 🔴 The one that clobbered a production Worker. wrangler uses an ambient login, and
// "signed in" says nothing about WHERE it deploys. Name the account, pin it into the
// context, and once pinned, refuse to proceed against a different one.

const acct = wranglerAccount();
if (!acct.ok) {
  fail("Wrangler auth", `not signed in (${acct.error})`, "npx wrangler login, or export CLOUDFLARE_API_TOKEN=…");
} else if (acct.accounts.length === 0) {
  fail("Cloudflare account", `signed in as ${acct.email ?? "?"}, but wrangler reports no accounts`);
} else {
  const pinned = ctx.accountId;
  const match = pinned ? acct.accounts.find((a) => a.id === pinned) : undefined;
  if (pinned && !match) {
    fail("Cloudflare account",
      `pinned to ${pinned}, but you're signed in as ${acct.email} — which can only reach ${acct.accounts.map((a) => a.id).join(", ")}`,
      "Switch accounts (export CLOUDFLARE_API_TOKEN=<that account's token>), or re-pin by editing .pagevault.json.");
  } else if (match) {
    pass("Cloudflare account", `${match.name} ${c.dim(match.id)} ${c.green("(pinned)")}`);
  } else if (acct.accounts.length === 1) {
    const a = acct.accounts[0];
    saveContext({ ...ctx, accountId: a.id, accountName: a.name });
    pass("Cloudflare account", `${a.name} ${c.dim(a.id)} ${c.dim("— pinned to .pagevault.json")}`);
  } else {
    const pick = argValue("--account");
    const a = acct.accounts.find((x) => x.id === pick || x.name === pick);
    if (a) {
      saveContext({ ...ctx, accountId: a.id, accountName: a.name });
      pass("Cloudflare account", `${a.name} ${c.dim(a.id)} ${c.dim("— pinned")}`);
    } else {
      fail("Cloudflare account",
        `signed in as ${acct.email} with ${acct.accounts.length} accounts — you must pick one`,
        `Run \`node scripts/preflight.mjs --account <id>\`, or narrow to one with export CLOUDFLARE_API_TOKEN=<token>. ` +
          `Accounts: ${acct.accounts.map((x) => `${x.name} (${x.id})`).join(" · ")}`);
    }
  }
}

// --- 3. API token — required at rung 3, optional (but useful) below --------

const token = fromEnv("CF_API_TOKEN");

if (!token) {
  if (rung >= 3) {
    fail("API token", "rung 3 needs CF_API_TOKEN to provision Access",
      "Create one (scopes in scripts/provision.mjs), then export CF_API_TOKEN=…");
  } else {
    warn("API token", "none set — fine for rungs 1–2 (wrangler login is enough); can't deep-check the account");
  }
} else {
  const verify = await api(token, "/user/tokens/verify");
  if (!verify.ok) {
    fail("API token", `rejected (HTTP ${verify.status}) ${errText(verify.errors)}`,
      "Recreate it at https://dash.cloudflare.com/profile/api-tokens");
  } else {
    pass("API token", "valid");

    const accounts = await api(token, "/accounts");
    const account = accounts.ok ? accounts.result?.[0] : null;
    account ? pass("Account", `${account.name} ${c.dim(account.id)}`)
            : fail("Account", `can't list accounts ${errText(accounts.errors)}`, "Add 'Account Settings — Read'.");

    if (account) {
      const kv = await api(token, `/accounts/${account.id}/storage/kv/namespaces?per_page=100`);
      kv.ok ? pass("Workers KV", "reachable")
            : fail("Workers KV", `not reachable ${errText(kv.errors)}`, "Add 'Workers KV Storage — Edit'.");

      // Rung 2+: the host must be a zone in THIS account.
      if (rung >= 2 && host) {
        const zoneName = host.split(".").slice(-2).join(".");
        const zones = await api(token, `/zones?name=${encodeURIComponent(zoneName)}`);
        const zone = zones.ok ? zones.result?.[0] : null;
        if (!zone) fail("Domain zone", `"${zoneName}" is not a zone on this account`, "Add it via Cloudflare Registrar or move it in.");
        else if (zone.account?.id !== account.id) fail("Domain zone", `"${zoneName}" is in a different account`, "Move it into the account running PageVault.");
        else if (zone.status !== "active") warn("Domain zone", `"${zoneName}" is "${zone.status}" — nameservers may not be live`);
        else pass("Domain zone", `${zone.name} active`);
      }

      // Rung 3: Zero Trust must be enabled (detect only — never enable it here).
      if (rung >= 3) {
        const org = await api(token, `/accounts/${account.id}/access/organizations`);
        org.ok && org.result?.auth_domain
          ? pass("Zero Trust", `enabled (${org.result.auth_domain.replace(/\.cloudflareaccess\.com$/, "")})`)
          : fail("Zero Trust", "not enabled", "Enable it at https://one.dash.cloudflare.com (Free plan; needs a card). Do this last.");
      }
    }
  }
}

// --- report ---------------------------------------------------------------

const icon = { pass: c.green("✓"), warn: c.yellow("!"), fail: c.red("✗") };
console.log();
for (const f of findings) {
  console.log(`  ${icon[f.level]} ${c.bold(f.label)} — ${f.detail}`);
  if (f.fix) console.log(`      ${c.dim("→ " + f.fix)}`);
}
const fails = findings.filter((f) => f.level === "fail").length;
const warns = findings.filter((f) => f.level === "warn").length;
console.log();
if (fails) { console.log(`  ${c.red(`${fails} blocker(s)`)}${warns ? `, ${warns} note(s)` : ""}. Fix, then re-run.\n`); process.exit(1); }
console.log(`  ${c.green("Ready for rung " + rung + ".")}${warns ? ` ${warns} note(s) above.` : ""}  Next: ${c.bold("make deploy")}\n`);

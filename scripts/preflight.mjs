#!/usr/bin/env node
//
// make preflight — before deploy: is your Cloudflare account ready for the rung you chose?
//
// Read-only AND non-interactive: it mutates nothing and asks nothing. That keeps it honestly
// "read-only" (deciding intent — the rung, the domain — is setup's job, not preflight's) and
// it makes preflight scriptable, which the LLM runbook leans on. It collects every gap in one
// pass, shows the checks first, then previews the plan.
//
// Auth is the token-first CLOUDFLARE_API_TOKEN. Capturing a missing one is setup's job, so
// preflight just points there.
//
import { versions } from "node:process";
import { c, loadContext, saveContext, loadCloudToken, argValue, cfApi, cfErr, acct, shortId, slug, banner } from "../cli/lib/provision/context.mjs";

const ctx = loadContext();
const rung = ctx.rung ?? 1;
const host = ctx.host ?? "";
const token = loadCloudToken();

console.log(banner("preflight", `(read-only · rung ${rung})`));

const findings = [];
const pass = (label, detail) => findings.push({ level: "pass", label, detail });
const warn = (label, detail, fix) => findings.push({ level: "warn", label, detail, fix });
const fail = (label, detail, fix) => findings.push({ level: "fail", label, detail, fix });

// --- 1. Node ---------------------------------------------------------------

Number(versions.node.split(".")[0]) >= 22
  ? pass("Node", versions.node)
  : fail("Node", `${versions.node} — Wrangler 4 needs 22+`, "nvm install 22 && nvm use 22, or https://nodejs.org");

// --- 2. Token → 3. Account → 4. KV & rung checks ---------------------------
//
// Each depends on the one before, so they nest: no token means no account to check, no
// account means nothing to check KV against. A missing token is setup's job to capture.

let account = null;

if (!token) {
  fail("Cloudflare token", "none set", "Run `make setup` — it walks you through creating one and saving it.");
} else {
  const verify = await cfApi("/user/tokens/verify");
  if (!verify.ok) {
    fail("Cloudflare token", `rejected (HTTP ${verify.status}) ${cfErr(verify.errors)}`,
      "Recreate it at https://dash.cloudflare.com/profile/api-tokens with the right scopes.");
  } else {
    pass("Cloudflare token", "valid");

    const accts = await cfApi("/accounts");
    const accounts = accts.ok ? accts.result ?? [] : [];
    const pinned = ctx.accountId;
    const match = pinned ? accounts.find((a) => a.id === pinned) : undefined;

    if (accounts.length === 0) {
      fail("Cloudflare account", `token is valid but reaches no accounts ${cfErr(accts.errors)}`, "Add 'Account Settings — Read' to the token.");
    } else if (pinned && !match) {
      fail("Cloudflare account", `pinned to ${shortId(pinned)}, but this token reaches ${accounts.map((a) => shortId(a.id)).join(", ")}`,
        "Use the token for the pinned account, or re-pin by running `make setup`.");
    } else if (match) {
      account = match;
      pass("Cloudflare account", `${acct(account)} ${c.dim("(pinned)")}`);
    } else if (accounts.length === 1) {
      account = accounts[0];
      saveContext({ ...ctx, accountId: account.id, accountName: account.name });
      pass("Cloudflare account", `${acct(account)} ${c.dim("— pinned")}`);
    } else {
      const pick = argValue("--account");
      account = accounts.find((a) => a.id === pick || a.name === pick) ?? null;
      if (account) {
        saveContext({ ...ctx, accountId: account.id, accountName: account.name });
        pass("Cloudflare account", `${acct(account)} ${c.dim("— pinned")}`);
      } else {
        fail("Cloudflare account", `token reaches ${accounts.length} accounts — none pinned`,
          `Run \`make setup\` to pick one (or pass --account <id>). Accounts: ${accounts.map((a) => acct(a)).join(" · ")}`);
      }
    }
  }
}

if (account) {
  const kv = await cfApi(`/accounts/${account.id}/storage/kv/namespaces?per_page=100`);
  kv.ok
    ? pass("Workers KV", "reachable")
    : fail("Workers KV", `not reachable ${cfErr(kv.errors)}`, "Add 'Workers KV Storage — Edit' to the token.");

  // rung 2: the domain must be a zone in this account, and its hostname record must be free —
  // a Worker custom domain creates its OWN record and Cloudflare refuses over an existing one.
  if (rung >= 2 && host) {
    const zoneName = host.split(".").slice(-2).join(".");
    const z = await cfApi(`/zones?name=${encodeURIComponent(zoneName)}`);
    const zone = z.ok ? z.result?.[0] : null;
    if (!zone) fail("Domain zone", `"${zoneName}" is not a zone on this account`, "Add it via Cloudflare Registrar, or move it in.");
    else if (zone.account?.id !== account.id) fail("Domain zone", `"${zoneName}" is in a different account`, "Move it into this account.");
    else if (zone.status !== "active") warn("Domain zone", `"${zoneName}" is "${zone.status}" — nameservers may not be live yet`);
    else {
      pass("Domain zone", `${zone.name} active`);

      // A Worker custom domain for this host is NOT a conflict — redeploying the same custom
      // domain to the same Worker is idempotent. Check the Workers custom-domains API first: a
      // Worker custom domain shows in DNS as a locked AAAA record, so a naive "any record here
      // = conflict" reads our OWN binding as a blocker. Only a foreign record, or a different
      // Worker's domain, actually blocks.
      const wd = await cfApi(`/accounts/${account.id}/workers/domains?zone_id=${zone.id}&hostname=${encodeURIComponent(host)}`);
      const bound = (wd.ok ? wd.result ?? [] : []).find((d) => d.hostname === host);
      if (bound) {
        bound.service === "pagevault"
          ? pass("Custom domain", `${host} already bound to this Worker ${c.dim("— idempotent redeploy")}`)
          : fail("Custom domain", `${host} is bound to a different Worker ("${bound.service}")`,
              "Pick another hostname (make setup), or remove that binding in the dashboard.");
      } else {
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
  }

  // rung 3: Zero Trust must be enabled (detect only — never enable).
  if (rung >= 3) {
    const org = await cfApi(`/accounts/${account.id}/access/organizations`);
    if (org.ok && org.result?.auth_domain) {
      pass("Zero Trust", `enabled (${org.result.auth_domain.replace(/\.cloudflareaccess\.com$/, "")})`);
    } else if (!org.ok) {
      // Can't READ the Access org — almost always a token missing the rung-3 Access scopes,
      // not Zero Trust being off. Say that, instead of a misleading "not enabled".
      fail("Zero Trust", `couldn't check — ${cfErr(org.errors)}`,
        "The token can't read Access. Add the rung-3 scopes: 'Access: Apps and Policies' (Edit) and 'Access: Organizations, Identity Providers, and Groups' (Edit).");
    } else {
      fail("Zero Trust", "not enabled",
        "Enable at https://one.dash.cloudflare.com (Free plan; needs a card). Do this last.");
    }
  }
}

// --- Report: the checks first, then the plan, then the next step -----------

const icon = { pass: c.green("✓"), warn: c.yellow("!"), fail: c.red("✗") };
console.log();
for (const f of findings) {
  console.log(`  ${icon[f.level]} ${c.bold(f.label)} ${c.dim("—")} ${f.detail}`);
  if (f.fix && f.level !== "pass") console.log(`      ${c.dim("→ " + f.fix)}`);
}

const fails = findings.filter((f) => f.level === "fail").length;
const warns = findings.filter((f) => f.level === "warn").length;

// If any check couldn't run because the token was refused (auth error), it's almost always a
// missing SCOPE, not a missing resource — and a scattered set of per-check errors reads as
// several unrelated problems. Name the real one, once. (Edit scopes can't be probed without
// mutating, so this is a heuristic, not a guarantee — the deploy is the final word.)
const authErr = findings.some((f) => /\b(10000|9109)\b|authentication error/i.test(f.detail ?? ""));
if (authErr) {
  console.log(`\n  ${c.yellow("!")} ${c.dim(`Auth errors above usually mean the token is missing scopes for rung ${rung} — grant the full set from the README token table.`)}`);
}
console.log();

if (fails || !account) {
  console.log(`  ${c.red(`${fails} blocker(s)`)}${warns ? `, ${warns} note(s)` : ""}. Fix, then re-run.\n`);
  process.exit(1);
}

// Passed — preview what deploy will do. A preview, not a prompt.
const sub = await cfApi(`/accounts/${account.id}/workers/subdomain`);
const subName = sub.result?.subdomain ?? slug(ctx.ownerEmail?.split("@")[0] ?? "pagevault");
const url = rung >= 2 && host ? `https://${host}` : `https://pagevault.${subName}.workers.dev`;

console.log(`  ${c.cyan("Plan")}  ${c.bold(url)}`);
console.log(`        ${c.dim(`creates a KV namespace${rung >= 3 ? ", Access apps + a viewer group" : ""}, and your bearer secret`)}`);
if (rung < 2 && !sub.result?.subdomain) console.log(`        ${c.dim(`registers the "${subName}" workers.dev subdomain`)}`);
if (rung >= 3) console.log(`        ${c.dim("deploy will prompt for a scoped runtime token — skippable (see the README)")}`);
console.log();
console.log(`  ${c.green(`Ready for rung ${rung}.`)}${warns ? ` ${warns} note(s) above.` : ""}  Next: ${c.bold("make deploy")}\n`);
process.exit(0);

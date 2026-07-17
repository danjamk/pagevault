#!/usr/bin/env node
//
// Provision Cloudflare for a rung-3 (Tier-1) PageVault deployment:
//
//   KV namespace · One-time PIN · the pagevault-viewers Access group · two Access apps ·
//   the generated Worker config
//
// This is the rung-3 config generator: `make deploy` runs it (deploy.mjs:81) before
// `wrangler deploy`, then deploy sets the secrets. It reads intent from .pagevault.json
// (setup wrote it) and creates everything over the Cloudflare API with the token-first
// CLOUDFLARE_API_TOKEN. Idempotent — re-running finds what exists rather than duplicating.
//
// Zero dependencies beyond context.mjs and Node builtins. The pattern is lifted from
// jonesphillip/sharehtml's setup.ts (Apache-2.0), which solved this first. Credited in the README.
//
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  c, ok, info, warn, die, loadCloudToken, loadContext, saveContext, cfApi, cfErr, acct, shortId,
  fromEnv, writeEnvLocalVar, isInteractive,
} from "./context.mjs";

const CONFIG_IN = "worker/wrangler.jsonc";
const CONFIG_OUT = "worker/wrangler.generated.jsonc";
const LEGACY_STATE = ".pagevault-provision.json";
const GROUP_NAME = "pagevault-viewers";

console.log(`\n${c.head("PageVault — provision Access")} ${c.dim("(rung 3)")}\n`);

// --- Context: one file, migrating the legacy provision state in once -------

let ctx = loadContext();
if (existsSync(LEGACY_STATE)) {
  // ctx (.pagevault.json) wins; the legacy file only fills gaps (team, auds, groupId from an
  // older provision). Then stop depending on it — deploy/destroy read .pagevault.json.
  const legacy = JSON.parse(readFileSync(LEGACY_STATE, "utf8"));
  ctx = { ...legacy, ...ctx, rung: ctx.rung ?? 3 };
  saveContext(ctx);
  info(`Migrated ${LEGACY_STATE} into .pagevault.json`);
}

const token = loadCloudToken();
if (!token) die("No Cloudflare token.", "Run `make setup` first — it captures and saves one.");

const { host, ownerEmail } = ctx;
if (!host || !host.includes(".")) die("Rung 3 needs a hostname.", "Run `make setup` and choose rung 3 with a host.");
if (!ownerEmail || !ownerEmail.includes("@")) die("Rung 3 needs an owner email.", "Run `make setup`.");

// --- Account: verify the token reaches the account setup pinned ------------

const accts = await cfApi("/accounts");
const accounts = accts.ok ? accts.result ?? [] : [];
const account = ctx.accountId ? accounts.find((a) => a.id === ctx.accountId) : accounts[0];
if (!account) {
  die(
    ctx.accountId ? "This token doesn't reach the pinned account." : "This token reaches no account.",
    "Re-run `make setup` (it pins the account), or check the token.",
  );
}
ok(`Account: ${acct(account)}`);

// --- Zero Trust: detect, deep-link, stop -----------------------------------
//
// The one step that genuinely can't be automated — the org-creation API has no plan-selection
// field, and Cloudflare requires picking a plan (and a card, even on free). So: detect and
// point.

const org = await cfApi(`/accounts/${account.id}/access/organizations`);
if (!org.ok || !org.result?.auth_domain) {
  die("Cloudflare Zero Trust is not set up on this account.", [
    "This is the one step that has to be done by hand — the API can't pick a plan. ~1 minute:",
    "",
    `  1. Open  ${c.bold(`https://one.dash.cloudflare.com/${account.id}`)}`,
    "  2. Choose a team name (becomes <team>.cloudflareaccess.com)",
    "  3. Select the FREE plan",
    "  4. Re-run `make deploy` — it reads the team name back automatically",
  ]);
}
// auth_domain comes back as the FULL domain ("acme.cloudflareaccess.com"). The Worker builds
// the JWKS URL from the team slug, so strip the suffix here (auth.ts tolerates either form).
const team = org.result.auth_domain.replace(/\.cloudflareaccess\.com$/, "");
ok(`Zero Trust team: ${team} ${c.dim(`(${team}.cloudflareaccess.com)`)}`);

// --- Zone: the host must be a Cloudflare zone ------------------------------

const zoneName = host.split(".").slice(-2).join(".");
const zres = await cfApi(`/zones?name=${encodeURIComponent(zoneName)}`);
const zone = zres.ok ? zres.result?.[0] : null;
if (!zone) die(`No Cloudflare zone found for "${zoneName}".`, "The domain must already be on Cloudflare DNS.");
ok(`Zone: ${zone.name} ${c.dim(shortId(zone.id))}`);

// --- KV: self-healing, same reconcile as tier0 -----------------------------

let kvId = ctx.kvId;
{
  const res = await cfApi(`/accounts/${account.id}/storage/kv/namespaces?per_page=100`);
  const namespaces = res.ok ? res.result ?? [] : [];
  const live = kvId ? namespaces.find((n) => n.id === kvId) : null;
  const byTitle = namespaces.find((n) => n.title === "pagevault");
  if (live) {
    ok(`KV namespace ${c.dim(kvId)}`);
  } else {
    if (kvId) warn(`Saved KV namespace ${c.dim(kvId)} no longer exists — reconciling.`);
    if (byTitle) {
      kvId = byTitle.id;
      ok(`KV namespace ${c.dim(kvId)} ${c.dim('(reusing the existing "pagevault")')}`);
    } else {
      const created = await cfApi(`/accounts/${account.id}/storage/kv/namespaces`, {
        method: "POST",
        body: JSON.stringify({ title: "pagevault" }),
      });
      if (!created.ok) die(`Couldn't create the KV namespace (${cfErr(created.errors)}).`, "Check 'Workers KV Storage — Edit'.");
      kvId = created.result.id;
      ok(`KV namespace created ${c.dim(kvId)}`);
    }
  }
}

// --- One-time PIN: the zero-onboarding mechanism ---------------------------
//
// 🔴 A fresh Zero Trust org ships with "Sign in with Cloudflare" as its only login method,
// which needs a Cloudflare account + password — which a client never has. One-time PIN is what
// makes "a link, a six-digit code, done" true. Provisioned, not left to be discovered.

const idpsRes = await cfApi(`/accounts/${account.id}/access/identity_providers`);
const idps = idpsRes.ok ? idpsRes.result ?? [] : [];
if (idps.some((p) => p.type === "onetimepin")) {
  ok("One-time PIN is enabled");
} else {
  const r = await cfApi(`/accounts/${account.id}/access/identity_providers`, {
    method: "POST",
    body: JSON.stringify({ type: "onetimepin", name: "One-time PIN", config: {} }),
  });
  if (!r.ok) die(`Couldn't enable One-time PIN (${cfErr(r.errors)}).`);
  ok("One-time PIN enabled");
  info("  A client gets a six-digit code by email. No account, no password, no invitation.");
}
if (idps.some((p) => p.type === "cloudflare")) {
  warn('"Sign in with Cloudflare" is also enabled as a login method.');
  console.log(`  ${c.dim("Harmless — the policy still restricts WHO may log in, but it needs a Cloudflare")}`);
  console.log(`  ${c.dim("account with a password, which no client has. Remove it in Zero Trust → Settings →")}`);
  console.log(`  ${c.dim("Authentication to show only the option a client can use.")}`);
}

// --- The viewer group (ADR-002): what bounds seat consumption --------------

const groupsRes = await cfApi(`/accounts/${account.id}/access/groups`);
let group = (groupsRes.ok ? groupsRes.result ?? [] : []).find((g) => g.name === GROUP_NAME);
if (group) {
  ok(`Access group exists: ${GROUP_NAME} ${c.dim(shortId(group.id))}`);
} else {
  const r = await cfApi(`/accounts/${account.id}/access/groups`, {
    method: "POST",
    body: JSON.stringify({ name: GROUP_NAME, include: [{ email: { email: ownerEmail } }] }),
  });
  if (!r.ok) {
    die(`Couldn't create the viewer group (${cfErr(r.errors)}).`, "Check 'Access: Organizations, Identity Providers, and Groups — Edit' (groups live here).");
  }
  group = r.result;
  ok(`Access group created: ${GROUP_NAME} ${c.dim(shortId(group.id))}`);
  info(`  Seeded with ${ownerEmail}. 'pagevault sync-access' keeps it in step with KV.`);
}

// --- The two Access apps (ADR-001): path-scoped, per-audience --------------

async function ensureApp({ label, domain, policyName, include }) {
  const apps = (await cfApi(`/accounts/${account.id}/access/apps`)).result ?? [];
  const existing = apps.find((a) => a.domain === domain);
  if (existing) {
    ok(`Access app exists: ${label} ${c.dim(domain)}`);
    return existing.aud;
  }
  const r = await cfApi(`/accounts/${account.id}/access/apps`, {
    method: "POST",
    body: JSON.stringify({
      name: `PageVault — ${label}`,
      type: "self_hosted",
      domain,
      session_duration: "24h",
      // The AUD comes back on this response, so nothing is copied out of a dashboard.
      policies: [{ name: policyName, decision: "allow", include, precedence: 1 }],
    }),
  });
  if (!r.ok) die(`Couldn't create the "${label}" Access app (${cfErr(r.errors)}).`);
  ok(`Access app created: ${label} ${c.dim(domain)}`);
  return r.result.aud;
}

const audDocs = await ensureApp({
  label: "documents",
  domain: `${host}/v`,
  policyName: "pagevault-viewers",
  include: [{ group: { id: group.id } }],
});
const audAdmin = await ensureApp({
  label: "console",
  domain: `${host}/admin`,
  policyName: "pagevault-owner",
  include: [{ email: { email: ownerEmail } }],
});

// --- The scoped runtime token (#24) ----------------------------------------
//
// access-group.ts keeps the viewer group in sync via a Worker secret (CF_API_TOKEN). That is a
// STANDING credential inside the Worker, so it must be a DEDICATED, narrowly scoped token — one
// permission, "Access: Organizations, Identity Providers, and Groups — Edit" — not the broad
// provisioning credential. If the Worker is ever compromised, the blast radius is one Access
// group. Provision only CAPTURES it (to .env.local as CF_RUNTIME_TOKEN); deploy sets it as the
// secret after the Worker exists.

let runtimeToken = fromEnv("CF_RUNTIME_TOKEN");
if (runtimeToken) {
  ok("Scoped runtime token present (CF_RUNTIME_TOKEN) — deploy will set it as the Worker secret.");
} else {
  console.log(`\n  ${c.cyan("Scoped runtime token")} ${c.dim("— lets the Worker keep the viewer group in sync (ADR-002)")}`);
  console.log(`  ${c.dim("A separate, narrow token — not the provisioning one — so a compromised Worker can")}`);
  console.log(`  ${c.dim("edit one Access group and nothing else.")}\n`);
  console.log(`  1. Open  ${c.bold("https://dash.cloudflare.com/profile/api-tokens")}  → Create Custom Token`);
  console.log(`  2. Name it  ${c.bold("pagevault-runtime")}`);
  console.log(`  3. One permission — ${c.dim("Account")} ${c.bold("Access: Organizations, Identity Providers, and Groups")} ${c.dim("(Edit)")}`);
  console.log(`  4. Scope it to ${c.bold(account.name)} and create it.`);
  if (isInteractive()) {
    const rl = createInterface({ input: stdin, output: stdout });
    const pasted = (await rl.question(`\n  Paste it to save to .env.local — or press Enter to skip: `)).trim();
    rl.close();
    if (pasted) {
      writeEnvLocalVar("CF_RUNTIME_TOKEN", pasted);
      runtimeToken = pasted;
      ok("Saved CF_RUNTIME_TOKEN to .env.local — deploy will set it as the Worker secret.");
    }
  }
  if (!runtimeToken) {
    warn("No scoped runtime token yet — adding a client to a portal won't grant Access until it's set.");
    console.log(`  ${c.dim("Add it anytime:")} ${c.bold("echo 'CF_RUNTIME_TOKEN=…' >> .env.local")} ${c.dim("then re-run")} ${c.bold("make deploy")}.`);
  }
}

// --- The generated Worker config -------------------------------------------
//
// Not a rewrite of the committed wrangler.jsonc — this is a public repo, and your email,
// team, AUDs and KV id would land on GitHub. The committed config keeps its placeholders and
// stays what the tests run against. workers_dev stays false (the template default): at rung 3
// an open workers.dev would route around Access.

const template = readFileSync(CONFIG_IN, "utf8");
const generated = template
  .replace(/"id": "REPLACE_WITH_KV_NAMESPACE_ID"/, `"id": "${kvId}"`)
  .replace(/"OWNER_EMAIL": ""/, `"OWNER_EMAIL": "${ownerEmail}"`)
  .replace(/"CF_TEAM_NAME": ""/, `"CF_TEAM_NAME": "${team}"`)
  .replace(/"PUBLIC_HOST": ""/, `"PUBLIC_HOST": "${host}"`)
  .replace(/"CF_ACCESS_AUD_DOCS": ""/, `"CF_ACCESS_AUD_DOCS": "${audDocs}"`)
  .replace(/"CF_ACCESS_AUD_ADMIN": ""/, `"CF_ACCESS_AUD_ADMIN": "${audAdmin}"`)
  .replace(/"CF_ACCOUNT_ID": ""/, `"CF_ACCOUNT_ID": "${account.id}"`)
  .replace(/"CF_ACCESS_GROUP_ID": ""/, `"CF_ACCESS_GROUP_ID": "${group.id}"`)
  .replace(
    /"observability": \{/,
    `"routes": [{ "pattern": "${host}", "custom_domain": true }],\n\n  "observability": {`,
  );

// A silent substitution miss would deploy a Worker with no KV and no audiences, surfacing as
// "nothing works" rather than an error. Fail loud instead.
for (const [key, value] of Object.entries({ kv: kvId, team, host, audDocs, audAdmin, accountId: account.id, groupId: group.id })) {
  if (!generated.includes(value)) die(`Failed to write ${key} into ${CONFIG_OUT}. Did the template change?`);
}
writeFileSync(CONFIG_OUT, generated);
ok(`Wrote ${CONFIG_OUT} ${c.dim("(rung 3, gitignored)")}`);

saveContext({ ...loadContext(), host, ownerEmail, accountId: account.id, kvId, team, audDocs, audAdmin, groupId: group.id });

// Provision's job ends here. deploy runs `wrangler deploy` and sets the secrets — the bearer
// (PAGEVAULT_API_TOKEN) and, next phase, the scoped runtime CF_API_TOKEN. No manual steps.
console.log();
warn("After deploy: disable the workers.dev subdomain and Preview URLs in the dashboard.");
console.log(`  ${c.dim("They route around Access entirely. The Worker fails closed without a valid JWT, so")}`);
console.log(`  ${c.dim("it's not an open door — but it's a required step, not a footnote.")}`);

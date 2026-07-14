#!/usr/bin/env node
//
// Provision Cloudflare for a PageVault deployment.
//
//   KV namespace · Access group · two Access applications · the generated Worker config
//
// Idempotent: re-running finds what already exists rather than duplicating it.
//
// Zero dependencies beyond Node built-ins, on purpose — this is the first thing a person
// who forks this repo runs, and it should not require an install to work.
//
// The pattern is lifted from jonesphillip/sharehtml's setup.ts (Apache-2.0), which solved
// this before we did. Credited in the README.
//
//   node scripts/provision.mjs
//
// Needs a Cloudflare API token in CF_API_TOKEN (or .env.local) with, on the account:
//   Access: Apps and Policies                              — Edit
//   Access: Organizations, Identity Providers, and Groups  — Edit   ← groups live here
//   Workers KV Storage                                     — Edit
//   Workers Scripts                                        — Edit
//   Account Settings                                       — Read
// and, on the zone:
//   Workers Routes                                         — Edit

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const API = "https://api.cloudflare.com/client/v4";
const CONFIG_IN = "worker/wrangler.jsonc";
const CONFIG_OUT = "worker/wrangler.generated.jsonc";
const STATE = ".pagevault-provision.json";

const GROUP_NAME = "pagevault-viewers";

// ---------------------------------------------------------------------------

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[36m${s}\x1b[0m`,
};

const ok = (s) => console.log(`${c.green("✓")} ${s}`);
const info = (s) => console.log(`${c.blue("→")} ${s}`);
const warn = (s) => console.log(`${c.yellow("!")} ${s}`);

function die(message, hint) {
  console.error(`\n${c.red("✗")} ${message}`);
  if (hint) console.error(`\n${hint}\n`);
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (question, fallback) => {
  const answer = (await rl.question(`  ${question}${fallback ? c.dim(` [${fallback}]`) : ""}: `)).trim();
  return answer || fallback || "";
};

/** Every Cloudflare API response has the same envelope. Unwrap it once, here. */
async function cf(token, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  let body;
  try {
    body = await res.json();
  } catch {
    die(`Cloudflare returned a non-JSON response from ${path} (HTTP ${res.status})`);
  }

  if (!body.success) {
    const errors = (body.errors ?? []).map((e) => `  [${e.code}] ${e.message}`).join("\n");
    die(`Cloudflare API error on ${init.method ?? "GET"} ${path}\n${errors}`, hintFor(body.errors));
  }

  return body.result;
}

/** Turn Cloudflare's error codes into something actionable. */
function hintFor(errors = []) {
  const codes = errors.map((e) => e.code);

  if (codes.includes(9109) || codes.includes(10000)) {
    return [
      "That usually means the API token is missing a permission.",
      "",
      "PageVault needs, on the ACCOUNT:",
      "  Access: Apps and Policies                              — Edit",
      "  Access: Organizations, Identity Providers, and Groups  — Edit   ← groups live here,",
      "                                                                     and it is easy to miss",
      "  Workers KV Storage                                     — Edit",
      "  Workers Scripts                                        — Edit",
      "  Account Settings                                       — Read",
      "and on the ZONE:",
      "  Workers Routes                                         — Edit",
      "",
      "Create one at: https://dash.cloudflare.com/profile/api-tokens",
    ].join("\n");
  }
  return null;
}

/** Read a value from the environment, or from .env.local, which is gitignored. */
function fromEnv(key) {
  if (process.env[key]) return process.env[key];
  if (!existsSync(".env.local")) return null;

  const line = readFileSync(".env.local", "utf8")
    .split("\n")
    .find((l) => l.trim().startsWith(`${key}=`));

  return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : null;
}

const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const saveState = (state) => writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);

// ---------------------------------------------------------------------------

console.log(`\n${c.bold("PageVault — Cloudflare provisioning")}\n`);

const state = loadState();

// --- 1. Token -------------------------------------------------------------

const token = fromEnv("CF_API_TOKEN") ?? (await ask("Cloudflare API token"));
if (!token) {
  die("No API token.", [
    "Create one at https://dash.cloudflare.com/profile/api-tokens with the permissions",
    "listed at the top of scripts/provision.mjs, then either:",
    "",
    "  echo 'CF_API_TOKEN=...' >> .env.local     (gitignored)",
    "  export CF_API_TOKEN=...",
  ].join("\n"));
}

await cf(token, "/user/tokens/verify");
ok("API token is valid");

// --- 2. Account -----------------------------------------------------------

const accounts = await cf(token, "/accounts");
if (accounts.length === 0) die("This token can't see any Cloudflare accounts.");

let account = accounts[0];
if (accounts.length > 1) {
  console.log("\n  Accounts:");
  accounts.forEach((a, i) => console.log(`    ${i + 1}. ${a.name} ${c.dim(a.id)}`));
  const pick = Number(await ask("\n  Which account? (number)", "1"));
  account = accounts[pick - 1] ?? accounts[0];
}
ok(`Account: ${account.name} ${c.dim(account.id)}`);

// --- 3. Zero Trust --------------------------------------------------------
//
// The one step that genuinely cannot be automated. The org-creation API has no
// plan-selection field, and Cloudflare's onboarding requires picking a plan (and, per
// their docs, entering payment details — even on the free tier, where you are not
// charged). So: detect, deep-link, and stop.

let org;
try {
  org = await cf(token, `/accounts/${account.id}/access/organizations`);
} catch {
  org = null;
}

if (!org?.auth_domain) {
  die("Cloudflare Zero Trust is not set up on this account.", [
    "This is the one step that has to be done by hand — the API has no way to pick a plan.",
    "It takes about a minute:",
    "",
    `  1. Open  ${c.bold(`https://one.dash.cloudflare.com/${account.id}`)}`,
    "  2. Choose a team name (any short slug — it becomes <team>.cloudflareaccess.com)",
    "  3. Select the FREE plan",
    "  4. Re-run this script — it will read the team name back automatically",
  ].join("\n"));
}

// Cloudflare returns auth_domain as the FULL domain ("acme.cloudflareaccess.com"), not the
// team slug. The Worker builds the JWKS URL as `https://{team}.cloudflareaccess.com/...`,
// so passing it through unchanged produces
// "acme.cloudflareaccess.com.cloudflareaccess.com" — every JWT verification fails,
// nobody can log in, and it surfaces as an opaque 404. Strip it here, and auth.ts tolerates
// either form for anyone editing the config by hand.
const team = org.auth_domain.replace(/\.cloudflareaccess\.com$/, "");
ok(`Zero Trust team: ${team} ${c.dim(`(${team}.cloudflareaccess.com)`)}`);

// --- 4. What are we deploying? -------------------------------------------

console.log();
const host = await ask("Hostname to serve PageVault on", state.host);
if (!host || !host.includes(".")) die("A hostname is required, e.g. pagevault.example.com");

const ownerEmail = (await ask("Your email (the owner)", state.ownerEmail)).toLowerCase();
if (!ownerEmail.includes("@")) die("A valid owner email is required.");

const zoneName = host.split(".").slice(-2).join(".");
const zones = await cf(token, `/zones?name=${encodeURIComponent(zoneName)}`);
if (zones.length === 0) {
  die(`No Cloudflare zone found for "${zoneName}".`, "The domain must already be on Cloudflare DNS.");
}
ok(`Zone: ${zones[0].name} ${c.dim(zones[0].id)}`);

// --- 5. KV ----------------------------------------------------------------

const namespaces = await cf(token, `/accounts/${account.id}/storage/kv/namespaces?per_page=100`);
let kv = namespaces.find((n) => n.title === "pagevault" || n.id === state.kvId);

if (kv) {
  ok(`KV namespace exists: ${kv.title} ${c.dim(kv.id)}`);
} else {
  kv = await cf(token, `/accounts/${account.id}/storage/kv/namespaces`, {
    method: "POST",
    body: JSON.stringify({ title: "pagevault" }),
  });
  ok(`KV namespace created ${c.dim(kv.id)}`);
}

// --- 6. One-time PIN ------------------------------------------------------
//
// 🔴 The zero-onboarding claim lives or dies here.
//
// A fresh Zero Trust org ships with "Sign in with Cloudflare" as its only login method —
// which authenticates against a Cloudflare account, with a password. A client will never
// have one, and asking them to create one is exactly the client-side onboarding step that
// this product's entire premise says must not exist.
//
// One-time PIN is the mechanism that makes "no account, no invitation, no password — a
// link, a six-digit code, done" true. Without it there is no product, only a worse
// SuiteDash. So it is provisioned, not left to be discovered.

const idps = await cf(token, `/accounts/${account.id}/access/identity_providers`);
const otp = idps.find((p) => p.type === "onetimepin");

if (otp) {
  ok("One-time PIN is enabled");
} else {
  await cf(token, `/accounts/${account.id}/access/identity_providers`, {
    method: "POST",
    body: JSON.stringify({ type: "onetimepin", name: "One-time PIN", config: {} }),
  });
  ok("One-time PIN enabled");
  info("  A client gets a six-digit code by email. No account, no password, no invitation.");
}

if (idps.some((p) => p.type === "cloudflare")) {
  warn('"Sign in with Cloudflare" is also enabled as a login method.');
  console.log(`  ${c.dim("Harmless — the policy still restricts WHO may log in. But it authenticates")}`);
  console.log(`  ${c.dim("against a Cloudflare account with a password, which no client will have.")}`);
  console.log(`  ${c.dim("Remove it in Zero Trust → Settings → Authentication if you want the login")}`);
  console.log(`  ${c.dim("screen to show only the one option a client can actually use.")}`);
}

// --- 7. The viewer group --------------------------------------------------
//
// ADR-002. This is what bounds seat consumption. With `Include: Everyone`, any stranger
// who knows the hostname can authenticate, burn one of the 50 free Zero Trust seats, and —
// once they are gone — lock out your actual clients. Cloudflare lists that config under
// "common misconfigurations". The group holds the union of every portal's members, so only
// people you invited can even reach the login screen.

const groups = await cf(token, `/accounts/${account.id}/access/groups`);
let group = groups.find((g) => g.name === GROUP_NAME);

if (group) {
  ok(`Access group exists: ${GROUP_NAME} ${c.dim(group.id)}`);
} else {
  group = await cf(token, `/accounts/${account.id}/access/groups`, {
    method: "POST",
    body: JSON.stringify({
      name: GROUP_NAME,
      include: [{ email: { email: ownerEmail } }],
    }),
  });
  ok(`Access group created: ${GROUP_NAME} ${c.dim(group.id)}`);
  info(`  Seeded with ${ownerEmail}. 'pagevault sync-access' keeps it in step with KV.`);
}

// --- 8. The two Access applications ---------------------------------------
//
// ADR-001. Paths belong to the APPLICATION, not the policy — there is no path field on a
// policy, so "a bypass policy scoped to /api" is not expressible. And a path-less app
// swallows the entire host, which is why the console lives at /admin and `/` is a redirect.
//
// Two apps, two audiences. They are NOT interchangeable: /v accepts only the docs app's
// token and /admin only the console app's. A single shared AUD would let any portal viewer
// present their token to the owner console.
//
// Everything else — /p, /pub, /render, /api, /mcp — has NO Access application, which is
// better than a bypass policy: fewer knobs, and nothing to misconfigure.

async function ensureApp({ label, domain, policyName, include }) {
  const apps = await cf(token, `/accounts/${account.id}/access/apps`);
  const existing = apps.find((a) => a.domain === domain);

  if (existing) {
    ok(`Access app exists: ${label} ${c.dim(domain)}`);
    return existing.aud;
  }

  const app = await cf(token, `/accounts/${account.id}/access/apps`, {
    method: "POST",
    body: JSON.stringify({
      name: `PageVault — ${label}`,
      type: "self_hosted",
      domain,
      session_duration: "24h",
      // The AUD comes back on this response, so nothing has to be copied out of a dashboard.
      policies: [{ name: policyName, decision: "allow", include, precedence: 1 }],
    }),
  });

  ok(`Access app created: ${label} ${c.dim(domain)}`);
  return app.aud;
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

// --- 9. The generated Worker config ---------------------------------------
//
// Deliberately NOT a rewrite of the committed wrangler.jsonc. This is a public repo: your
// email, team name, AUD tags and KV id would end up on GitHub the moment you committed.
// The committed config keeps its placeholders and stays what the tests run against.

const template = readFileSync(CONFIG_IN, "utf8");

const generated = template
  .replace(/"id": "REPLACE_WITH_KV_NAMESPACE_ID"/, `"id": "${kv.id}"`)
  .replace(/"OWNER_EMAIL": ""/, `"OWNER_EMAIL": "${ownerEmail}"`)
  .replace(/"CF_TEAM_NAME": ""/, `"CF_TEAM_NAME": "${team}"`)
  .replace(/"PUBLIC_HOST": ""/, `"PUBLIC_HOST": "${host}"`)
  .replace(/"CF_ACCESS_AUD_DOCS": ""/, `"CF_ACCESS_AUD_DOCS": "${audDocs}"`)
  .replace(/"CF_ACCESS_AUD_ADMIN": ""/, `"CF_ACCESS_AUD_ADMIN": "${audAdmin}"`)
  .replace(
    /"observability": \{/,
    `"routes": [{ "pattern": "${host}", "custom_domain": true }],\n\n  "observability": {`,
  );

// A generated file that silently failed to substitute would deploy a Worker with no KV and
// no audiences, and the failure would surface as "nothing works" rather than as an error.
for (const [key, value] of Object.entries({ kv: kv.id, team, host, audDocs, audAdmin })) {
  if (!generated.includes(value)) die(`Failed to write ${key} into ${CONFIG_OUT}. Did the template change?`);
}

writeFileSync(CONFIG_OUT, generated);
ok(`Wrote ${CONFIG_OUT} ${c.dim("(gitignored)")}`);

saveState({ ...state, host, ownerEmail, accountId: account.id, kvId: kv.id, team, audDocs, audAdmin });

// --- 10. What's left ------------------------------------------------------

const apiToken = randomBytes(32).toString("hex");

console.log(`\n${c.bold("Provisioned.")} Two things left, both yours to run:\n`);
console.log(`  ${c.bold("1. Set the API token")} — the CLI and the MCP server authenticate with it.`);
console.log(`     It also derives the capability-token signing key, so there is no second secret.\n`);
console.log(`     ${c.dim("A fresh one, if you want it:")}`);
console.log(`     ${c.bold(apiToken)}\n`);
console.log(`     npx wrangler secret put PAGEVAULT_API_TOKEN --config ${CONFIG_OUT}\n`);
console.log(`  ${c.bold("2. Deploy")}\n`);
console.log(`     make deploy\n`);
console.log(`  Then open ${c.bold(`https://${host}/v/default`)} in a private window.`);
console.log(`  You should get a Cloudflare Access login. That is the client experience.\n`);
warn("Disable the workers.dev subdomain and Preview URLs in the Cloudflare dashboard.");
console.log(`  ${c.dim("They route around Access entirely. The Worker fails closed without a valid")}`);
console.log(`  ${c.dim("JWT, so it is not an open door — but it is a required step, not a footnote.")}\n`);

rl.close();

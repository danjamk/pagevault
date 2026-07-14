#!/usr/bin/env node
//
// Tear down a PageVault deployment on Cloudflare.
//
//   Worker · DNS record · Access applications · Access group · KV namespace (and its data)
//
// The mirror image of provision.mjs, and it exists for the same reason: the setup path is
// the product for anyone who isn't you, and you cannot test a setup path you cannot undo.
// Without this, every rehearsal of the fork experience leaves debris behind and the next
// one is not a clean surface.
//
//   node scripts/destroy.mjs                 # asks before each step
//   node scripts/destroy.mjs --keep-data      # leave the KV namespace and its documents
//
// This deletes documents. It asks. Twice.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const API = "https://api.cloudflare.com/client/v4";
const CONFIG_OUT = "worker/wrangler.generated.jsonc";
const STATE = ".pagevault-provision.json";
const GROUP_NAME = "pagevault-viewers";
const WORKER_NAME = "pagevault";

const KEEP_DATA = process.argv.includes("--keep-data");

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

const ok = (s) => console.log(`${c.green("✓")} ${s}`);
const skip = (s) => console.log(`${c.dim(`· ${s}`)}`);
const warn = (s) => console.log(`${c.yellow("!")} ${s}`);

function die(message) {
  console.error(`\n${c.red("✗")} ${message}\n`);
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q) => (await rl.question(`  ${q} `)).trim();

async function cf(token, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });

  // A 404 on a delete means it is already gone, which is success for our purposes.
  if (res.status === 404) return null;

  const body = await res.json().catch(() => null);
  if (!body?.success) {
    const errors = (body?.errors ?? []).map((e) => `  [${e.code}] ${e.message}`).join("\n");
    warn(`Cloudflare API error on ${init.method ?? "GET"} ${path}\n${errors}`);
    return null;
  }
  return body.result;
}

function fromEnv(key) {
  if (process.env[key]) return process.env[key];
  if (!existsSync(".env.local")) return null;
  const line = readFileSync(".env.local", "utf8").split("\n").find((l) => l.trim().startsWith(`${key}=`));
  return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : null;
}

// ---------------------------------------------------------------------------

console.log(`\n${c.bold("PageVault — tear down")}\n`);

if (!existsSync(STATE)) {
  die(`No ${STATE}. Nothing to tear down — or this was provisioned from somewhere else.`);
}

const state = JSON.parse(readFileSync(STATE, "utf8"));
const token = fromEnv("CF_API_TOKEN");
if (!token) die("No CF_API_TOKEN in the environment or .env.local.");

const { accountId, host, kvId } = state;

console.log(`  This will destroy, on ${c.bold(host)}:\n`);
console.log(`    · the Worker "${WORKER_NAME}" and its DNS record`);
console.log(`    · both Access applications (${host}/v and ${host}/admin)`);
console.log(`    · the "${GROUP_NAME}" Access group`);
console.log(
  KEEP_DATA
    ? `    ${c.dim(`· KV namespace KEPT (--keep-data)`)}`
    : `    · ${c.red("the KV namespace — every portal and every document in it")}`,
);
console.log();

if ((await ask(`Type the hostname to confirm:`)) !== host) die("Did not match. Nothing was touched.");
if (!KEEP_DATA && (await ask(`This deletes all documents. Type ${c.bold("destroy")}:`)) !== "destroy") {
  die("Nothing was touched.");
}
console.log();

// --- The Worker (and, with it, the custom domain) --------------------------
//
// Deleting the script removes the Custom Domain binding and the DNS record Cloudflare
// created for it. That is why this goes first: with the Worker gone, nothing is serving on
// the hostname while the rest is torn down.

const worker = await cf(token, `/accounts/${accountId}/workers/scripts/${WORKER_NAME}`, {
  method: "DELETE",
});
if (worker !== null) ok(`Worker "${WORKER_NAME}" deleted (and its DNS record)`);
else skip(`Worker "${WORKER_NAME}" was already gone`);

// --- Access applications --------------------------------------------------

const apps = (await cf(token, `/accounts/${accountId}/access/apps`)) ?? [];
const ours = apps.filter((a) => a.domain === `${host}/v` || a.domain === `${host}/admin`);

for (const app of ours) {
  await cf(token, `/accounts/${accountId}/access/apps/${app.id}`, { method: "DELETE" });
  ok(`Access app deleted: ${app.domain}`);
}
if (ours.length === 0) skip("No Access apps to delete");

// --- The viewer group -----------------------------------------------------

const groups = (await cf(token, `/accounts/${accountId}/access/groups`)) ?? [];
const group = groups.find((g) => g.name === GROUP_NAME);

if (group) {
  await cf(token, `/accounts/${accountId}/access/groups/${group.id}`, { method: "DELETE" });
  ok(`Access group deleted: ${GROUP_NAME}`);
} else {
  skip(`No "${GROUP_NAME}" group to delete`);
}

// --- KV -------------------------------------------------------------------

if (KEEP_DATA) {
  skip(`KV namespace kept ${c.dim(kvId)}`);
} else if (kvId) {
  await cf(token, `/accounts/${accountId}/storage/kv/namespaces/${kvId}`, { method: "DELETE" });
  ok(`KV namespace deleted ${c.dim(kvId)} — every document with it`);
}

// --- Local artifacts ------------------------------------------------------

for (const file of [CONFIG_OUT, ...(KEEP_DATA ? [] : [STATE])]) {
  if (existsSync(file)) {
    unlinkSync(file);
    ok(`Removed ${file}`);
  }
}

// --- What we deliberately do NOT touch -------------------------------------

console.log(`\n${c.bold("Left alone, deliberately:")}\n`);
console.log(`  · ${c.bold("Zero Trust itself")} — the org, the team name, the login methods.`);
console.log(`    ${c.dim("Account-wide. Tearing it down would affect anything else using Access,")}`);
console.log(`    ${c.dim("and re-enabling it is the one step that cannot be automated.")}`);
console.log();
console.log(`  · ${c.bold("Access seats")} — anyone who logged in still holds one.`);
console.log(`    ${c.dim("Zero Trust → Team & Resources → Users → Remove, if you want them back.")}`);
console.log(`    ${c.dim("Worth knowing: this is the number that runs out at 50, and deleting the")}`);
console.log(`    ${c.dim("apps does not give them back.")}`);
console.log();
console.log(`  · ${c.bold("PAGEVAULT_API_TOKEN")} — the secret died with the Worker.`);
console.log();
console.log(`${c.bold("Clean.")} 'make provision' will build it again from nothing.\n`);

rl.close();

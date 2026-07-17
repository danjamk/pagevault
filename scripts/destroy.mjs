#!/usr/bin/env node
//
// make destroy — tear a PageVault deployment down. Irreversible. It asks.
//
//   node scripts/destroy.mjs               # tear it all down
//   node scripts/destroy.mjs --keep-data   # leave the KV namespace and its documents
//
// Ladder-aware. A rung-3 deployment has Access applications, a viewer group, and a
// custom-domain DNS record; a rung-1/2 deployment is just a Worker and a KV namespace. This
// reads the state files to learn which, and only deletes what actually exists.
//
// 🔴 SAFETY — this is the one command that deletes client data, so it refuses to act on the
// wrong account. It reads the account the deployment is pinned to, checks the token in THIS
// clone's .env.local actually reaches that account, and dies on a mismatch — automatically,
// before any prompt. "Which account" is the mistake a hostname prompt alone does not catch:
// you can type the right hostname into the wrong account. The token is the token-first
// CLOUDFLARE_API_TOKEN, the same one every other command uses.
//
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { c, ok, warn, die, loadCloudToken, cfApi, cfAccounts, isInteractive, printTokenSetup } from "./context.mjs";

const WORKER_NAME = "pagevault";
const GROUP_NAME = "pagevault-viewers";
const CONFIG_OUT = "worker/wrangler.generated.jsonc";
const PROVISION_STATE = ".pagevault-provision.json";
const CONTEXT_FILE = ".pagevault.json";
const KEEP_DATA = process.argv.includes("--keep-data");

const skip = (s) => console.log(`${c.dim(`· ${s}`)}`);
const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q) => (await rl.question(`  ${q} `)).trim();

console.log(`\n${c.head("PageVault — tear down")}\n`);

// --- Resolve the deployment: rung 3 (provision) or rung 1/2 (context) ------

let tier, host, kvId, accountId, state;
if (existsSync(PROVISION_STATE)) {
  state = JSON.parse(readFileSync(PROVISION_STATE, "utf8"));
  tier = 3;
  ({ host, kvId, accountId } = state);
} else if (existsSync(CONTEXT_FILE)) {
  state = JSON.parse(readFileSync(CONTEXT_FILE, "utf8"));
  tier = (state.rung ?? 1) >= 3 ? 3 : state.rung ?? 1;
  kvId = state.kvId;
  accountId = state.accountId;
  host = state.host || (state.deployedUrl ? new URL(state.deployedUrl).host : "");
} else {
  die("Nothing to tear down — no .pagevault.json or .pagevault-provision.json in this clone.");
}
if (!accountId) die("State names no account, so a target can't be verified.", "Nothing was touched.");

// --- The token, token-first ------------------------------------------------

const token = loadCloudToken();
if (!token) {
  console.log(`  ${c.red("✗")} No Cloudflare token — nothing can be deleted, which is the safe default.\n`);
  printTokenSetup();
  console.log();
  die("Set CLOUDFLARE_API_TOKEN in .env.local, then re-run.");
}

// --- 🔴 The account guard — refuse a wrong-clone teardown automatically -----

const accounts = await cfAccounts();
if (accounts.length === 0) {
  die("The token reaches no accounts.", "Check it, and its 'Account Settings — Read' scope.");
}
const account = accounts.find((a) => a.id === accountId);
if (!account) {
  die(
    "This token does not reach the account this deployment is on — wrong clone, or wrong token.",
    [
      `  Deployment is on: ${c.bold(accountId)}`,
      `  Token reaches:    ${accounts.map((a) => `${a.name} (${a.id})`).join(", ")}`,
      "",
      "  Nothing was touched.",
    ],
  );
}

// --- The plan --------------------------------------------------------------

const target = host || `${WORKER_NAME}.workers.dev`;
console.log(`  Account:  ${c.bold(account.name)} ${c.dim(account.id)}`);
console.log(`  Target:   ${c.bold(target)} ${c.dim(`· rung ${tier}`)}\n`);
console.log(`  This will delete:\n`);
console.log(`    · the Worker "${WORKER_NAME}"${tier >= 2 ? " and its custom-domain DNS record" : ""}`);
if (tier >= 3) {
  console.log(`    · both Access applications (${host}/v and ${host}/admin)`);
  console.log(`    · the "${GROUP_NAME}" Access group`);
}
console.log(
  KEEP_DATA
    ? `    ${c.dim("· KV namespace KEPT (--keep-data)")}`
    : `    · ${c.red("the KV namespace — every document in it")}`,
);
console.log();

// --- Confirm intent --------------------------------------------------------

if (!isInteractive()) die("Refusing to destroy non-interactively.", "Run it in a terminal so it can confirm.");
if ((await ask(`Type the target to confirm (${c.bold(target)}):`)) !== target) {
  die("Did not match. Nothing was touched.");
}
if (!KEEP_DATA && (await ask(`This deletes all documents. Type ${c.bold("destroy")}:`)) !== "destroy") {
  die("Nothing was touched.");
}
console.log();

// --- Delete. A 404 means it is already gone, which is success for us. -------

const del = async (path) => {
  const r = await cfApi(path, { method: "DELETE" });
  return r.ok || r.status === 404;
};

// The Worker first: deleting the script removes the custom-domain binding and the DNS record
// Cloudflare created for it (rung 2+), so nothing serves the hostname while the rest goes.
(await del(`/accounts/${accountId}/workers/scripts/${WORKER_NAME}`))
  ? ok(`Worker "${WORKER_NAME}" deleted${tier >= 2 ? " (and its DNS record)" : ""}`)
  : warn(`Worker "${WORKER_NAME}" may not have been deleted — check the dashboard.`);

if (tier >= 3) {
  const apps = (await cfApi(`/accounts/${accountId}/access/apps`)).result ?? [];
  const ours = apps.filter((a) => a.domain === `${host}/v` || a.domain === `${host}/admin`);
  for (const app of ours) {
    await del(`/accounts/${accountId}/access/apps/${app.id}`);
    ok(`Access app deleted: ${app.domain}`);
  }
  if (!ours.length) skip("No Access apps to delete");

  const groups = (await cfApi(`/accounts/${accountId}/access/groups`)).result ?? [];
  const group = groups.find((g) => g.name === GROUP_NAME);
  if (group) {
    await del(`/accounts/${accountId}/access/groups/${group.id}`);
    ok(`Access group deleted: ${GROUP_NAME}`);
  } else {
    skip(`No "${GROUP_NAME}" group to delete`);
  }
}

if (KEEP_DATA) {
  skip(`KV namespace kept ${c.dim(kvId ?? "")}`);
} else if (kvId) {
  (await del(`/accounts/${accountId}/storage/kv/namespaces/${kvId}`))
    ? ok(`KV namespace deleted ${c.dim(kvId)} — every document with it`)
    : warn(`KV namespace ${kvId} may not have been deleted — check the dashboard.`);
} else {
  skip("No KV namespace id in state");
}

// --- Local artifacts -------------------------------------------------------

if (existsSync(CONFIG_OUT)) {
  unlinkSync(CONFIG_OUT);
  ok(`Removed ${CONFIG_OUT}`);
}
if (tier >= 3 && !KEEP_DATA && existsSync(PROVISION_STATE)) {
  unlinkSync(PROVISION_STATE);
  ok(`Removed ${PROVISION_STATE}`);
}
// Rung 1/2: keep .pagevault.json — it's your intent (rung, email, host) and re-runnable — but
// strip the now-dead discovered state, so a later `make deploy` builds fresh rather than
// reusing a KV id that no longer exists.
if (tier < 3 && !KEEP_DATA && existsSync(CONTEXT_FILE)) {
  const ctx = JSON.parse(readFileSync(CONTEXT_FILE, "utf8"));
  delete ctx.kvId;
  delete ctx.deployedUrl;
  writeFileSync(CONTEXT_FILE, `${JSON.stringify(ctx, null, 2)}\n`);
  ok(`Cleared the stale KV id and URL from ${CONTEXT_FILE} ${c.dim("(kept your rung, email, host)")}`);
}

// --- What we deliberately do NOT touch -------------------------------------

if (tier >= 3) {
  console.log(`\n${c.bold("Left alone, deliberately:")}\n`);
  console.log(`  · ${c.bold("Zero Trust itself")} — the org, the team name, the login methods.`);
  console.log(`    ${c.dim("Account-wide; tearing it down would affect anything else using Access,")}`);
  console.log(`    ${c.dim("and re-enabling it is the one step that cannot be automated.")}`);
  console.log();
  console.log(`  · ${c.bold("Access seats")} — anyone who logged in still holds one.`);
  console.log(`    ${c.dim("Zero Trust → Team & Resources → Users → Remove, if you want them back.")}`);
}
console.log(
  `\n${c.bold("Clean.")} ${tier >= 3 ? "'make provision'" : "'make deploy'"} will build it again from what's left.\n`,
);

rl.close();

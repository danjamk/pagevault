//
// `pagevault destroy` (and `make destroy`) — tear a PageVault deployment down. Irreversible. It asks.
//
//   pagevault destroy               # tear it all down
//   pagevault destroy --keep-data   # leave the KV namespace and its documents
//
// Ladder-aware. A rung-3 deployment has Access applications, a viewer group, and a custom-domain
// DNS record; a rung-1/2 deployment is just a Worker and a KV namespace. This reads the state files
// to learn which, and only deletes what actually exists. State resolves through stateDir(), so it
// works both from the repo (cwd) and an install (~/.pagevault/) — one engine, two front doors.
//
// 🔴 SAFETY — the one command that deletes client data, so it refuses to act on the wrong account.
// It reads the account the deployment is pinned to, checks the token in THIS clone's .env.local
// actually reaches that account, and dies on a mismatch — automatically, before any prompt. "Which
// account" is the mistake a hostname prompt alone does not catch: you can type the right hostname
// into the wrong account. The token is the token-first CLOUDFLARE_API_TOKEN every command uses.
//
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  c, ok, warn, die, loadCloudToken, cfApi, cfAccounts, isInteractive, printTokenSetup, banner,
  stateDir, generatedConfigPath, CONTEXT_FILE, RUNNING_FROM_REPO,
} from "../provision/context.mjs";

const WORKER_NAME = "pagevault";
const GROUP_NAME = "pagevault-viewers";
const PROVISION_STATE = ".pagevault-provision.json";

/**
 * The keys in `.pagevault.json` that name a Cloudflare object this teardown just deleted. Every
 * one of them is DISCOVERED state — read back from the API while building — as opposed to the
 * operator's INTENT (rung, ownerEmail, host, accountId, analytics), which is what makes a rebuild
 * re-runnable and must survive.
 *
 * `team` is deliberately absent: Zero Trust itself is left alone, so the team name stays true.
 */
const DISCOVERED_KEYS = ["kvId", "oauthKvId", "deployedUrl", "audDocs", "audAdmin", "groupId"];

/**
 * Drop the state that named things we just deleted, keeping the operator's intent.
 *
 * Pure, and exported, because the version of this that shipped was guarded by `tier < 3` — so a
 * Secured teardown left `.pagevault.json` naming a deleted KV namespace, a dead URL, two dead
 * Access AUDs and a dead group, and `status` reported a deployment that no longer existed. The
 * rung-3 branch it relied on cleaned `.pagevault-provision.json`, a file current provisioning does
 * not even write, so it was a no-op on every modern deployment. See #118.
 */
export function stripDiscoveredState(ctx) {
  const out = { ...ctx };
  for (const key of DISCOVERED_KEYS) delete out[key];
  return out;
}

/** @param {{ keepData?: boolean }} [opts] */
export async function destroyCmd({ keepData = false } = {}) {
  const KEEP_DATA = keepData;
  const CONFIG_OUT = generatedConfigPath();
  const provisionStatePath = join(stateDir(), PROVISION_STATE);
  const contextPath = join(stateDir(), CONTEXT_FILE);

  const skip = (s) => console.log(`${c.dim(`· ${s}`)}`);
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q) => (await rl.question(`  ${q} `)).trim();

  console.log(banner("tear down"));

  // --- Resolve the deployment: rung 3 (provision) or rung 1/2 (context) ------
  let tier, host, kvId, oauthKvId, accountId, state;
  if (existsSync(provisionStatePath)) {
    state = JSON.parse(readFileSync(provisionStatePath, "utf8"));
    tier = 3;
    ({ host, kvId, accountId } = state);
    oauthKvId = state.oauthKvId;
  } else if (existsSync(contextPath)) {
    state = JSON.parse(readFileSync(contextPath, "utf8"));
    tier = (state.rung ?? 1) >= 3 ? 3 : state.rung ?? 1;
    kvId = state.kvId;
    oauthKvId = state.oauthKvId;
    accountId = state.accountId;
    host = state.host || (state.deployedUrl ? new URL(state.deployedUrl).host : "");
  } else {
    die("Nothing to tear down — no .pagevault.json or .pagevault-provision.json.");
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
    die("This token does not reach the account this deployment is on — wrong clone, or wrong token.", [
      `  Deployment is on: ${c.bold(accountId)}`,
      `  Token reaches:    ${accounts.map((a) => `${a.name} (${a.id})`).join(", ")}`,
      "",
      "  Nothing was touched.",
    ]);
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
  console.log(KEEP_DATA ? `    ${c.dim("· KV namespace KEPT (--keep-data)")}` : `    · ${c.red("the KV namespace — every document in it")}`);
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

  // The OAuth provider's KV (#22) — issued tokens and client registrations, not documents.
  // --keep-data spares it too, for the same "don't delete what the operator kept" reason.
  if (KEEP_DATA) {
    if (oauthKvId) skip(`OAuth KV namespace kept ${c.dim(oauthKvId)}`);
  } else if (oauthKvId) {
    (await del(`/accounts/${accountId}/storage/kv/namespaces/${oauthKvId}`))
      ? ok(`OAuth KV namespace deleted ${c.dim(oauthKvId)}`)
      : warn(`OAuth KV namespace ${oauthKvId} may not have been deleted — check the dashboard.`);
  } else {
    skip("No OAuth KV namespace id in state");
  }

  // --- Local artifacts -------------------------------------------------------
  if (existsSync(CONFIG_OUT)) {
    unlinkSync(CONFIG_OUT);
    ok(`Removed ${CONFIG_OUT}`);
  }
  // Legacy state file. Current provisioning writes everything into .pagevault.json, so this only
  // fires for a deployment built by an older PageVault — which is exactly why it must not be the
  // thing that gates the cleanup below.
  if (!KEEP_DATA && existsSync(provisionStatePath)) {
    unlinkSync(provisionStatePath);
    ok(`Removed ${PROVISION_STATE}`);
  }
  // Keep .pagevault.json — it's your intent (rung, email, host) and re-runnable — but strip the
  // state that named what we just deleted, so a later deploy builds fresh and `status` doesn't
  // report a deployment that is gone. Every rung, not just 1 and 2 (#118).
  if (!KEEP_DATA && existsSync(contextPath)) {
    const ctx = JSON.parse(readFileSync(contextPath, "utf8"));
    writeFileSync(contextPath, `${JSON.stringify(stripDiscoveredState(ctx), null, 2)}\n`);
    ok(`Cleared the dead ids and URL from ${CONTEXT_FILE} ${c.dim("(kept your rung, email, host, account)")}`);
  }

  // --- What we deliberately do NOT touch -------------------------------------
  // Deliberately NOT rung-3-only any more (#128). View records are written from renderShell for
  // /p/ and /pub/ too, so they outlive a teardown at every tier — and a teardown that lists what
  // survives, while omitting the one thing holding a third party's email, is worse than one that
  // lists nothing. Zero Trust and seats stay conditional; they only exist at rung 3.
  console.log(`\n${c.bold("Left alone, deliberately:")}\n`);

  if (tier >= 3) {
    console.log(`  · ${c.bold("Zero Trust itself")} — the org, the team name, the login methods.`);
    console.log(`    ${c.dim("Account-wide; tearing it down would affect anything else using Access,")}`);
    console.log(`    ${c.dim("and re-enabling it is the one step that cannot be automated.")}`);
    console.log();
    console.log(`  · ${c.bold("Access seats")} — anyone who logged in still holds one.`);
    console.log(`    ${c.dim("Zero Trust → Team & Resources → Users → Remove, if you want them back.")}`);
    console.log();
  }

  // Deliberately a statement, not a count (#128). Counting would mean querying Analytics Engine,
  // which needs an account-scoped `Account Analytics Read` token — wider than anything destroy
  // holds, and the exact credential ADR-015 §6 keeps out of this codepath. Even with the token it
  // would be a network call in the middle of a destructive flow: a slow or failed count would
  // either stall the teardown or print nothing, and "nothing" reads as "no records". A flat
  // statement that records exist is accurate without asking, and cannot fail open.
  console.log(`  · ${c.bold("View records")} — up to ${c.bold("three months")} of them, in Analytics Engine, not KV.`);
  console.log(`    ${c.dim("Which documents were opened and when — and for anything read through Access,")}`);
  console.log(`    ${c.dim("the viewer's email address. Cloudflare documents no way to delete a dataset,")}`);
  console.log(`    ${c.dim("so waiting out the window is the only mechanism. If a client ever asks you to")}`);
  console.log(`    ${c.dim("erase their data, that is the honest answer — and `pagevault views` still reads")}`);
  console.log(`    ${c.dim("them after this deployment is gone.")}`);
  console.log();
  console.log(`  · ${c.bold("Anything this deployment's state never named.")} Teardown deletes what`);
  console.log(`    ${c.dim(".pagevault.json points at. A KV namespace left by an older PageVault under a")}`);
  console.log(`    ${c.dim("different title is orphaned, not removed — check Storage & Databases → KV.")}`);
  // `make deploy` at EVERY rung, not `make provision` at rung 3: provision writes the config and
  // creates the Access apps, then stops without deploying the Worker or setting the secrets. Deploy
  // is rung-aware and calls provisionAccess() itself, so it is the complete answer. See #119.
  const rebuild = RUNNING_FROM_REPO ? "'make deploy'" : "'pagevault init'";
  console.log(`\n${c.bold("Clean.")} ${rebuild} will build it again from what's left.\n`);

  rl.close();
}

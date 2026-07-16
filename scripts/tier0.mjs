#!/usr/bin/env node
//
// The Tier-0 config writer — rungs 1 and 2 (publish, and publish-on-your-domain). Reads
// intent from .pagevault.json (set by `make setup`) and writes worker/wrangler.generated.jsonc:
// no Cloudflare Access, no Zero Trust, no card. `deploy.mjs` calls this; you rarely run it
// directly.
//
// The symmetric, minimal sibling of provision.mjs — same generated file, a fraction of it.
// Climbing to rung 3 is `deploy` running provision.mjs instead, which overwrites the file
// with Access. Auth here is your `wrangler login` session; NO API token is needed.
//
//   node scripts/tier0.mjs            # act on .pagevault.json
//   node scripts/tier0.mjs --kv <id>  # skip KV creation, use this one
//
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { c, ok, info, die, loadContext, saveContext, loadCloudToken, argValue } from "./context.mjs";

const CONFIG_IN = "worker/wrangler.jsonc";
const CONFIG_OUT = "worker/wrangler.generated.jsonc";

const findKvId = (text) => text.match(/"id":\s*"([0-9a-f]{32})"/)?.[1];

// ---------------------------------------------------------------------------

if (!existsSync(CONFIG_IN)) die(`Can't find ${CONFIG_IN}. Run this from the repo root.`);

loadCloudToken(); // .env.local token → environment, so `wrangler kv namespace create` targets the right account
const ctx = loadContext();
if (!ctx.ownerEmail) die("No .pagevault.json yet.", "Run `make setup` first.");

const { ownerEmail } = ctx;
const host = ctx.rung >= 2 ? ctx.host : ""; // rung 1 publishes on workers.dev; rung 2 on the host

// --- The KV namespace ------------------------------------------------------
//
// Precedence: an explicit --kv, then the id already in the context (idempotent re-run),
// then create one via wrangler using your login session (no API token). If wrangler isn't
// available, say exactly what to run rather than failing opaquely.

let kvId = argValue("--kv") ?? ctx.kvId;
if (kvId) ok(`KV namespace ${c.dim(kvId)}`);
else {
  info("Creating a KV namespace via wrangler…");
  try {
    const out = execSync("npx --yes wrangler@4 kv namespace create PAGEVAULT", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    kvId = findKvId(out);
    if (!kvId) throw new Error("could not read the namespace id from wrangler's output");
    ok(`KV namespace created ${c.dim(kvId)}`);
  } catch (err) {
    die("Couldn't create the KV namespace automatically.", [
      c.dim(String(err.message ?? err).split("\n")[0]),
      "",
      "This needs Node 22 and a signed-in wrangler. Either run `make deploy` (which uses the",
      "right Node), or do it by hand and re-run:",
      "",
      `  ${c.bold("npx wrangler login")}`,
      `  ${c.bold("npx wrangler kv namespace create PAGEVAULT")}`,
      `  ${c.bold("node scripts/tier0.mjs --kv <id>")}`,
    ]);
  }
  saveContext({ ...ctx, kvId }); // remember it so a re-run doesn't make a second namespace
}

// --- Write the config ------------------------------------------------------
//
// The committed wrangler.jsonc is the Tier-1-shaped template; fill only what Tier 0 needs
// and flip workers_dev on. Access AUDs and the team name stay empty — /v and /admin fail
// closed, which is correct until rung 3.

const template = readFileSync(CONFIG_IN, "utf8");

let generated = template
  .replace(/"id": "REPLACE_WITH_KV_NAMESPACE_ID"/, `"id": "${kvId}"`)
  .replace(/"OWNER_EMAIL": ""/, `"OWNER_EMAIL": "${ownerEmail}"`)
  // 🔴 Tier 0 has no Access, so workers.dev is the whole point, not a hole. provision.mjs
  // flips this back off at rung 3, where workers.dev WOULD route around Access.
  .replace(/"workers_dev": false/, `"workers_dev": true`);

// 🔴 Pin the deploy to the account preflight verified. Without this, wrangler falls back to
// an ambient login and can deploy to the wrong account (it once clobbered production). See #32.
if (ctx.accountId) {
  generated = generated.replace(/"name": "pagevault",/, `"name": "pagevault",\n  "account_id": "${ctx.accountId}",`);
  if (!generated.includes(`"account_id": "${ctx.accountId}"`)) die("Failed to pin account_id into the config.");
}

if (host) {
  // Rung 2: serve on the custom domain, and generate links to it. Still no Access.
  generated = generated
    .replace(/"PUBLIC_HOST": ""/, `"PUBLIC_HOST": "${host}"`)
    .replace(
      /"observability": \{/,
      `"routes": [{ "pattern": "${host}", "custom_domain": true }],\n\n  "observability": {`,
    );
}

if (!generated.includes(kvId) || !generated.includes(ownerEmail) || !generated.includes(`"workers_dev": true`)) {
  die(`Failed to write ${CONFIG_OUT}. Did the template change?`);
}
if (host && !generated.includes(`"pattern": "${host}"`)) die(`Failed to write the ${host} route.`);

writeFileSync(CONFIG_OUT, generated);
ok(`Wrote ${CONFIG_OUT} ${c.dim(`(rung ${ctx.rung}, gitignored)`)}`);

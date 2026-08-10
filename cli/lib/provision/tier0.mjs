#!/usr/bin/env node
//
// The Tier-0 config writer — rungs 1 and 2 (publish, and publish-on-your-domain). Reads
// intent from .pagevault.json (set by `make setup`) and writes worker/wrangler.generated.jsonc:
// no Cloudflare Access, no Zero Trust, no card. `deploy.mjs` calls this; you rarely run it
// directly.
//
// The symmetric, minimal sibling of provision.mjs — same generated file, a fraction of it.
// Climbing to rung 3 is `deploy` running provision.mjs instead. Auth is the .env.local token,
// and the KV is created over the Cloudflare API — no wrangler subprocess to go wrong.
//
//   node cli/lib/provision/tier0.mjs            # act on .pagevault.json
//   node cli/lib/provision/tier0.mjs --kv <id>  # skip KV creation, use this one
//
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { c, ok, info, warn, die, loadContext, saveContext, loadCloudToken, argValue, cfApi, cfErr, releaseTag, BUNDLE_PATH, applyBundleMode, generatedConfigPath, templatePath, runHint, RUNNING_FROM_REPO, deployedBindings, resolveAnalytics, stripAnalyticsBinding, bindsAnalytics, analyticsBecause, analyticsPatch, refuseAnalyticsDowngrade, analyticsDashboard, CONTEXT_FILE } from "./context.mjs";

const CONFIG_IN = templatePath();
const CONFIG_OUT = generatedConfigPath();

export async function writeTier0Config(opts = {}) {
  if (!existsSync(CONFIG_IN)) die(`Can't find ${CONFIG_IN}. Run this from the repo root.`);

  loadCloudToken();
  const ctx = loadContext();
  if (!ctx.ownerEmail) die("No .pagevault.json yet.", `Run \`${runHint("setup", "init")}\` first.`);

  const { ownerEmail } = ctx;
  const host = ctx.rung >= 2 ? ctx.host : ""; // rung 1 publishes on workers.dev; rung 2 on the host

  // --- The KV namespace ------------------------------------------------------
  //
  // Precedence: an explicit --kv wins. Otherwise reconcile against what is ACTUALLY on the
  // account, rather than trusting the id saved in context — because a kvId can go stale. Delete
  // the namespace in the dashboard and .pagevault.json still names it; wrangler then fails the
  // deploy with "KV namespace not found" (code 10041). So: trust the saved id only if it still
  // exists, then fall back to an existing "pagevault" by title, then create. The by-title step
  // also stops a lost kvId (re-clone, deleted context) from spawning a duplicate namespace.

  let kvId = argValue("--kv");
  if (kvId) {
    ok(`KV namespace ${c.dim(kvId)} ${c.dim("(--kv)")}`);
  } else {
    if (!ctx.accountId) die("No account pinned.", `Run \`${runHint("preflight", "init")}\` first — it pins the account.`);
    const res = await cfApi(`/accounts/${ctx.accountId}/storage/kv/namespaces?per_page=100`);
    const namespaces = res.ok ? res.result ?? [] : [];
    const live = ctx.kvId ? namespaces.find((n) => n.id === ctx.kvId) : null;
    const byTitle = namespaces.find((n) => n.title === "pagevault");

    if (live) {
      kvId = live.id;
      ok(`KV namespace ${c.dim(kvId)}`);
    } else {
      if (ctx.kvId) warn(`Saved KV namespace ${c.dim(ctx.kvId)} no longer exists (deleted?) — reconciling.`);
      if (byTitle) {
        kvId = byTitle.id;
        ok(`KV namespace ${c.dim(kvId)} ${c.dim('(reusing the existing "pagevault")')}`);
      } else {
        info("Creating a KV namespace…");
        const created = await cfApi(`/accounts/${ctx.accountId}/storage/kv/namespaces`, {
          method: "POST",
          body: JSON.stringify({ title: "pagevault" }),
        });
        if (!created.ok) {
          die(`Couldn't create the KV namespace (${cfErr(created.errors)}).`, "Check the token has 'Workers KV Storage — Edit'.");
        }
        kvId = created.result.id;
        ok(`KV namespace created ${c.dim(kvId)}`);
      }
    }
    saveContext({ ...ctx, kvId }); // remember the reconciled id
  }

  // --- The OAuth provider's KV (ADR-006 / #22) -------------------------------
  //
  // The OAuthProvider wraps the Worker at every tier, so OAUTH_KV must be bound even at Tier 0,
  // or the deploy fails on the placeholder. Same reconcile as PAGEVAULT, under its own title.

  let oauthKvId = ctx.oauthKvId;
  {
    if (!ctx.accountId) die("No account pinned.", `Run \`${runHint("preflight", "init")}\` first — it pins the account.`);
    const res = await cfApi(`/accounts/${ctx.accountId}/storage/kv/namespaces?per_page=100`);
    const namespaces = res.ok ? res.result ?? [] : [];
    const live = oauthKvId ? namespaces.find((n) => n.id === oauthKvId) : null;
    const byTitle = namespaces.find((n) => n.title === "pagevault-oauth");
    if (live) {
      ok(`OAuth KV namespace ${c.dim(oauthKvId)}`);
    } else {
      if (oauthKvId) warn(`Saved OAuth KV namespace ${c.dim(oauthKvId)} no longer exists — reconciling.`);
      if (byTitle) {
        oauthKvId = byTitle.id;
        ok(`OAuth KV namespace ${c.dim(oauthKvId)} ${c.dim('(reusing the existing "pagevault-oauth")')}`);
      } else {
        info("Creating the OAuth KV namespace…");
        const created = await cfApi(`/accounts/${ctx.accountId}/storage/kv/namespaces`, {
          method: "POST",
          body: JSON.stringify({ title: "pagevault-oauth" }),
        });
        if (!created.ok) die(`Couldn't create the OAuth KV namespace (${cfErr(created.errors)}).`, "Check the token has 'Workers KV Storage — Edit'.");
        oauthKvId = created.result.id;
        ok(`OAuth KV namespace created ${c.dim(oauthKvId)}`);
      }
    }
    saveContext({ ...loadContext(), oauthKvId }); // remember the reconciled id (merge, kvId already saved)
  }

  // --- View tracking: rung 3's question, without the interview (#190) --------
  //
  // 🔴 Rungs 1 and 2 used to bind ANALYTICS unconditionally — this writer filled the template in
  // and never touched the block. Wrangler refuses the WHOLE deploy with error 10089 when the
  // binding is present and Analytics Engine is off on the account, and rung 1 is the fork's
  // on-ramp, so `pagevault init` on a fresh account is exactly where that landed.
  //
  // The resolution is rung 3's, function for function, because a capability a deployment already
  // has must survive a re-deploy that says nothing (ADR-024): a flag, then .pagevault.json, then
  // what the live Worker actually binds. An unreadable deployment reads as unknown, never as off.
  //
  // Only the fallback differs. Rung 3 interviews the operator; here nothing-said means OFF and
  // there is no prompt — the point of the lower rungs is that publishing works without a
  // conversation about Analytics Engine, and a deploy that works beats a deploy that dies on an
  // optional feature nobody asked for. `--analytics` / `PAGEVAULT_ANALYTICS` / `ANALYTICS=on`
  // turns it on without the conversation too.
  const live = await deployedBindings(ctx.accountId);
  let { value: analytics, source, downgrade } = resolveAnalytics({
    flag: opts.analytics,
    declared: ctx.analytics,
    live: live === null ? null : live.includes("ANALYTICS"),
  });
  if (downgrade) refuseAnalyticsDowngrade(source);
  if (analytics === undefined) {
    analytics = false;
    source = "default";
  }

  if (analytics) {
    ok(`View tracking: on (Analytics Engine) ${c.dim(`— ${analyticsBecause(source)}`)}`);
    info(`  If the deploy fails with error 10089, it is not enabled yet — ${analyticsDashboard(ctx.accountId)}`);
  } else {
    ok(`View tracking: off — no Analytics Engine binding ${c.dim(`— ${analyticsBecause(source)}`)}`);
    info(`  Turn it on later: enable it at ${c.dim(analyticsDashboard(ctx.accountId))}, then \`${runHint("deploy ANALYTICS=on", "upgrade --analytics")}\`.`);
  }

  // Save an answer; never save a silence. See `analyticsPatch` for why the two differ only here.
  //
  // Saying which of the two just happened is the other half of #194: `--no-analytics` used to print
  // "off — you asked for it on this run" and then be forgotten by the next deploy, and nothing in
  // that line was false. The operator has no way to tell a recorded decision from a per-run one
  // unless the run says so.
  if ("analytics" in analyticsPatch(analytics, source)) {
    saveContext({ ...loadContext(), ...analyticsPatch(analytics, source) });
    info(`  ${c.dim(`Recorded in ${CONTEXT_FILE} — later deploys keep this until you say otherwise.`)}`);
  } else if (source === "default") {
    info(`  ${c.dim(`Not recorded — nothing asked. Climbing to Secured will ask you directly.`)}`);
  }

  // --- Write the config ------------------------------------------------------
  //
  // The committed wrangler.jsonc is the Tier-1-shaped template; fill only what Tier 0 needs
  // and flip workers_dev on. Access AUDs and the team name stay empty — /v and /admin fail
  // closed, which is correct until rung 3.

  const template = readFileSync(CONFIG_IN, "utf8");

  // Rung 1 lives on workers.dev, so it's on. Rung 2+ serves on the custom domain, so workers.dev
  // goes OFF — otherwise the worker answers on two URLs and the domain isn't really "the"
  // location (and at rung 3 an open workers.dev would route around Access entirely).
  const workersDev = host ? "false" : "true";

  const version = releaseTag();
  let generated = template
    .replace(/"id": "REPLACE_WITH_KV_NAMESPACE_ID"/, `"id": "${kvId}"`)
    .replace(/"id": "REPLACE_WITH_OAUTH_KV_ID"/, `"id": "${oauthKvId}"`)
    .replace(/"OWNER_EMAIL": ""/, `"OWNER_EMAIL": "${ownerEmail}"`)
    .replace(/"PAGEVAULT_VERSION": ""/, `"PAGEVAULT_VERSION": "${version}"`)
    .replace(/"PAGEVAULT_DEPLOYED_AT": ""/, `"PAGEVAULT_DEPLOYED_AT": "${new Date().toISOString()}"`)
    // Attribution is on unless the operator set `branding: false`. Only the "off" value is written,
    // so an untouched config leaves the blank default — which shows the mark.
    .replace(/"PAGEVAULT_BRANDING": ""/, `"PAGEVAULT_BRANDING": "${ctx.branding === false ? "off" : ""}"`)
    .replace(/"workers_dev": false/, `"workers_dev": ${workersDev}`);

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

  // Same strip, same assertion, same helper as rung 3 — see the note on ANALYTICS_BLOCK. Two copies
  // of this is how #190 happened.
  if (!analytics) generated = stripAnalyticsBinding(generated);
  if (bindsAnalytics(generated) !== analytics) {
    die(
      `Failed to ${analytics ? "keep" : "strip"} the Analytics Engine binding in ${CONFIG_OUT}.`,
      "The template's view-tracking block changed shape — see context.mjs.",
    );
  }

  if (!generated.includes(kvId) || !generated.includes(oauthKvId) || !generated.includes(ownerEmail) || !generated.includes(`"workers_dev": ${workersDev}`)) {
    die(`Failed to write ${CONFIG_OUT}. Did the template change?`);
  }
  if (host && !generated.includes(`"pattern": "${host}"`)) die(`Failed to write the ${host} route.`);

  // Bundle mode (ADR-014): deploy the shipped prebuilt Worker instead of bundling from src.
  if (opts.bundle) {
    if (!existsSync(BUNDLE_PATH))
      die(
        "Bundle mode needs the prebuilt Worker.",
        RUNNING_FROM_REPO ? "Run `make bundle` first." : "Reinstall pagevault — the Worker bundle ships with the package.",
      );
    generated = applyBundleMode(generated, BUNDLE_PATH);
    ok(`Bundle mode: deploying ${c.dim(BUNDLE_PATH)}`);
  }

  writeFileSync(CONFIG_OUT, generated);
  ok(`Wrote ${CONFIG_OUT} ${c.dim(`(rung ${ctx.rung}, gitignored)`)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeTier0Config();
}

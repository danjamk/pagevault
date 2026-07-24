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
import { pathToFileURL } from "node:url";
import {
  c, ok, info, warn, die, loadCloudToken, loadContext, saveContext, cfApi, cfErr, acct, shortId,
  fromEnv, writeEnvLocalVar, isInteractive, banner, releaseTag, BUNDLE_PATH, applyBundleMode,
  generatedConfigPath, templatePath, runHint, RUNNING_FROM_REPO,
} from "./context.mjs";

const CONFIG_IN = templatePath();
const CONFIG_OUT = generatedConfigPath();
const LEGACY_STATE = ".pagevault-provision.json";
const GROUP_NAME = "pagevault-viewers";

export async function provisionAccess(opts = {}) {
  console.log(banner("provision Access", "(Secured)"));

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
  if (!token) die("No Cloudflare token.", `Run \`${runHint("setup", "init")}\` first — it captures and saves one.`);

  const { host, ownerEmail } = ctx;
  if (!host || !host.includes(".")) die("Rung 3 needs a hostname.", `Run \`${runHint("setup", "init")}\` and choose rung 3 with a host.`);
  if (!ownerEmail || !ownerEmail.includes("@")) die("Rung 3 needs an owner email.", `Run \`${runHint("setup", "init")}\`.`);

  // --- Account: verify the token reaches the account setup pinned ------------

  const accts = await cfApi("/accounts");
  const accounts = accts.ok ? accts.result ?? [] : [];
  const account = ctx.accountId ? accounts.find((a) => a.id === ctx.accountId) : accounts[0];
  if (!account) {
    die(
      ctx.accountId ? "This token doesn't reach the pinned account." : "This token reaches no account.",
      `Re-run \`${runHint("setup", "init")}\` (it pins the account), or check the token.`,
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
      `  4. Re-run \`${runHint("deploy", "upgrade")}\` — it reads the team name back automatically`,
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

  // --- OAUTH_KV: the OAuth provider's own KV (ADR-006 / #22) ------------------
  //
  // The OAuthProvider is mounted in front of the Worker at every tier, so its KV binding must
  // exist even before anyone connects a hosted surface — an unbound OAUTH_KV fails the deploy.
  // Same self-healing reconcile as PAGEVAULT, under its own title so the two never collide.

  let oauthKvId = ctx.oauthKvId;
  {
    const res = await cfApi(`/accounts/${account.id}/storage/kv/namespaces?per_page=100`);
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
        const created = await cfApi(`/accounts/${account.id}/storage/kv/namespaces`, {
          method: "POST",
          body: JSON.stringify({ title: "pagevault-oauth" }),
        });
        if (!created.ok) die(`Couldn't create the OAuth KV namespace (${cfErr(created.errors)}).`, "Check 'Workers KV Storage — Edit'.");
        oauthKvId = created.result.id;
        ok(`OAuth KV namespace created ${c.dim(oauthKvId)}`);
      }
    }
  }

  // --- Browser Run: confirm, don't probe (PDF export, #50) -------------------
  //
  // PDF export (#50) needs the BROWSER binding (Browser Run / Puppeteer). Two facts make this a
  // printed confirmation, not a live check. There is nothing to enable — Browser Run is on by
  // default on the Workers Free plan. And there is no clean read-only probe: the only capability
  // signal is the binding's limits() at runtime (post-deploy, not from here), while every REST
  // quick-action launches a browser and spends the daily allocation, so poking one from a setup
  // script would be the wrong thing. So I confirm and point, and never fail — PDF is optional and
  // degrades off cleanly (env.ts), so a missing allocation is a warning at worst, not a stop.
  ok("Browser Run: on by default (Workers Free) — PDF export needs no setup step");
  info("  The daily free allocation (~10 min) is the only limit; past it /pdf returns 429 and the");
  console.log(`  ${c.dim("viewer's PDF button degrades off until it resets — https://developers.cloudflare.com/browser-rendering/platform/limits/")}`);

  // --- Analytics Engine: ask once, remember, never hard-fail (#91) -----------
  //
  // 🔴 Unlike Browser Run, this one is NOT on by default, and unlike KV it cannot be created
  // over the API — enabling it is a dashboard action on the account. Wrangler refuses the whole
  // deploy if the binding is present and the product is off (error 10089), which lands at the
  // very last step, after every Access app has been created. That is the worst place to fail,
  // and a fork running `pagevault init` on a fresh account would hit it every time.
  //
  // So the binding is conditional and the answer is remembered. Off means the block is stripped
  // from the generated config, ANALYTICS is absent, and `recordView` no-ops (env.ts, analytics.ts).
  // View tracking is genuinely optional rather than nominally optional.
  //
  // There is no probe. The SQL API is the only available signal and its 403 is ambiguous: it is
  // what you get when Analytics Engine is off, and equally what you get when the token simply
  // lacks `Account Analytics Read`. Deploy-token scopes vary between accounts and forks, so
  // reading 403 as "off" would silently strip view tracking from a deployment where it works.
  // An answer we store beats a signal we cannot disambiguate.
  const analyticsUrl = `https://dash.cloudflare.com/${account.id}/workers/analytics-engine`;
  let analytics = opts.analytics ?? ctx.analytics;

  if (analytics === undefined) {
    if (isInteractive()) {
      console.log();
      info("View tracking (optional) records which documents each client opens.");
      console.log(`  ${c.dim("Free — a separate quota from KV, so it never competes with publishing. Retention")}`);
      console.log(`  ${c.dim("is 3 months, so it answers \"recently\", never \"ever\".")}`);
      console.log();
      console.log(`  ${c.dim("It must be enabled once on the account, in the dashboard:")}`);
      console.log(`  ${c.bold(analyticsUrl)}`);
      console.log();
      // The dashboard flow is genuinely confusing: it opens on "Create Dataset", the only choice
      // is "Create Blank Dataset", and then it asks for a name and a binding as if they were
      // yours to invent. They are not — they have to match what the Worker config already
      // declares. Creating the dataset is really just how the UI switches the product on.
      console.log(`  ${c.dim("It opens on \"Create Dataset\" — choose Create Blank Dataset, then enter EXACTLY:")}`);
      console.log(`      Dataset Name     ${c.bold("pagevault_views")}`);
      console.log(`      Dataset Binding  ${c.bold("ANALYTICS")}`);
      console.log(`  ${c.dim("Those must match what worker/wrangler.jsonc already declares. Ignore the wrangler")}`);
      console.log(`  ${c.dim("snippet it offers afterward — yours is committed. Creating the dataset is just how")}`);
      console.log(`  ${c.dim("the dashboard turns the product on.")}`);
      console.log();
      const rl = createInterface({ input: stdin, output: stdout });
      const answer = (await rl.question(`  ${c.bold("Done that, and want view tracking? [y/N] ")}`)).trim().toLowerCase();
      rl.close();
      analytics = answer === "y" || answer === "yes";
    } else {
      // Non-interactive (CI, `--yes`) defaults OFF. A deploy that works beats a deploy that
      // dies on an optional feature nobody asked for.
      analytics = false;
    }
  }

  if (analytics) {
    ok("View tracking: on (Analytics Engine)");
    info(`  If the deploy fails with error 10089, it is not enabled yet — ${analyticsUrl}`);
  } else {
    ok("View tracking: off — no Analytics Engine binding");
    info(`  Turn it on later: enable it at ${c.dim(analyticsUrl)}, then \`${runHint("provision ANALYTICS=on", "init")}\`.`);
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
    console.log(`\n  ${c.cyan("Scoped runtime token")} ${c.dim("— a SECOND token, separate from your CLOUDFLARE_API_TOKEN")}`);
    console.log(`  ${c.dim("This one lives INSIDE the Worker (as the CF_API_TOKEN secret) and keeps the viewer")}`);
    console.log(`  ${c.dim("group in sync as portal members change (ADR-002). It's deliberately narrow — one")}`);
    console.log(`  ${c.dim("permission — because your provisioning token is too broad to sit in a Worker.")}\n`);
    console.log(`  1. Open  ${c.bold("https://dash.cloudflare.com/profile/api-tokens")}  → Create Custom Token`);
    console.log(`  2. Name it  ${c.bold("pagevault-runtime")}`);
    console.log(`  3. One permission — ${c.dim("Account")} ${c.bold("Access: Organizations, Identity Providers, and Groups")} ${c.dim("(Edit)")}`);
    console.log(`  4. Scope it to ${c.bold(account.name)}, create it, copy the value.`);
    if (isInteractive()) {
      const rl = createInterface({ input: stdin, output: stdout });
      const pasted = (await rl.question(
        `\n  Paste it to save as ${c.bold("CF_RUNTIME_TOKEN")} in .env.local — or Enter to skip ${c.dim("(owner still works; sync off)")}: `,
      )).trim();
      rl.close();
      if (pasted) {
        writeEnvLocalVar("CF_RUNTIME_TOKEN", pasted);
        runtimeToken = pasted;
        ok("Saved CF_RUNTIME_TOKEN to .env.local — deploy will set it as the Worker secret.");
      }
    }
    if (!runtimeToken) {
      warn("No scoped runtime token yet — adding a client to a portal won't grant Access until it's set.");
      console.log(`  ${c.dim("Add it anytime:")} ${c.bold("echo 'CF_RUNTIME_TOKEN=…' >> .env.local")} ${c.dim("then re-run")} ${c.bold(runHint("deploy", "upgrade"))}.`);
    }
  }

  // --- The generated Worker config -------------------------------------------
  //
  // Not a rewrite of the committed wrangler.jsonc — this is a public repo, and your email,
  // team, AUDs and KV id would land on GitHub. The committed config keeps its placeholders and
  // stays what the tests run against. workers_dev stays false (the template default): at rung 3
  // an open workers.dev would route around Access.

  const template = readFileSync(CONFIG_IN, "utf8");
  let generated = template
    .replace(/"id": "REPLACE_WITH_KV_NAMESPACE_ID"/, `"id": "${kvId}"`)
    .replace(/"id": "REPLACE_WITH_OAUTH_KV_ID"/, `"id": "${oauthKvId}"`)
    .replace(/"PAGEVAULT_VERSION": ""/, `"PAGEVAULT_VERSION": "${releaseTag()}"`)
    .replace(/"PAGEVAULT_DEPLOYED_AT": ""/, `"PAGEVAULT_DEPLOYED_AT": "${new Date().toISOString()}"`)
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

  // View tracking off → drop the binding entirely, so wrangler never asks the account for a
  // product it does not have. Matches the "a fork can delete this block" comment in the
  // template; this just does it for you.
  if (!analytics) {
    generated = generated.replace(
      /\n *\/\/ View tracking \(#91\)[\s\S]*?"analytics_engine_datasets": \[[\s\S]*?\n *\],\n/,
      "\n",
    );
  }
  if (generated.includes("analytics_engine_datasets") !== !!analytics) {
    die(
      `Failed to ${analytics ? "keep" : "strip"} the Analytics Engine binding in ${CONFIG_OUT}.`,
      "The template's view-tracking block changed shape — see provision.mjs.",
    );
  }

  // A silent substitution miss would deploy a Worker with no KV and no audiences, surfacing as
  // "nothing works" rather than an error. Fail loud instead.
  for (const [key, value] of Object.entries({ kv: kvId, oauthKv: oauthKvId, team, host, audDocs, audAdmin, accountId: account.id, groupId: group.id })) {
    if (!generated.includes(value)) die(`Failed to write ${key} into ${CONFIG_OUT}. Did the template change?`);
  }

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
  ok(`Wrote ${CONFIG_OUT} ${c.dim("(rung 3, gitignored)")}`);

  saveContext({ ...loadContext(), host, ownerEmail, accountId: account.id, kvId, oauthKvId, team, audDocs, audAdmin, groupId: group.id, analytics });

  // Provision's job ends here. deploy runs `wrangler deploy` and sets the secrets — the bearer
  // (PAGEVAULT_API_TOKEN) and, next phase, the scoped runtime CF_API_TOKEN. No manual steps.
  console.log();
  warn("After deploy: disable the workers.dev subdomain and Preview URLs in the dashboard.");
  console.log(`  ${c.dim("They route around Access entirely. The Worker fails closed without a valid JWT, so")}`);
  console.log(`  ${c.dim("it's not an open door — but it's a required step, not a footnote.")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The stored answer is sticky, so these are how you change your mind about view tracking
  // without hand-editing .pagevault.json.
  const argv = process.argv.slice(2);
  const analytics = argv.includes("--analytics") ? true : argv.includes("--no-analytics") ? false : undefined;
  await provisionAccess(analytics === undefined ? {} : { analytics });
}

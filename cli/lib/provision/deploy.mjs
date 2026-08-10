#!/usr/bin/env node
//
// make deploy — verify the account, ensure a workers.dev subdomain, deploy, set the bearer
// secret, remember the URL. Rung 1–2 write a Tier-0 config (tier0.mjs); rung 3 provisions
// Access (provision.mjs). You never pass the tier — it's a fact in .pagevault.json. Auth is
// the .env.local token, which is what lets us do the subdomain and the secret over the API.
//
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import {
  c, ok, info, warn, die, loadContext, saveContext, loadCloudToken, isInteractive, cfApi, cfAccounts, cfErr, slug,
  writeEnvLocalVar, fromEnv, fromEnvFile, acct, shortId, banner, chooseBearer, generatedConfigPath, RUNNING_FROM_REPO, runHint,
  statePath, CONTEXT_FILE, restoreHint, analyticsChoice, analyticsDashboard,
} from "./context.mjs";
import { parseArgs } from "../format.mjs";
import { provisionAccess } from "./provision.mjs";
import { writeTier0Config } from "./tier0.mjs";
import { saveLoginConfig, loadConfig, sameDeployment } from "../client.mjs";
import { findByUrl, loadRegistry, saveRegistry, shouldAdoptCurrent, upsert } from "../registry.mjs";
import { resolveBearerSource, resolveTarget, stateToken } from "../target.mjs";

const CONFIG_OUT = generatedConfigPath();

/**
 * The wrangler deploy command line. Extracted so a test can assert the QUOTING without spawning
 * wrangler — the live call can't be unit-tested, but the string handed to the shell can.
 *
 * The config path is absolute and operator-controlled, and it routinely contains a space: installed,
 * it is `%USERPROFILE%\.pagevault\…`, and a Windows account named "First Last" puts one right in the
 * middle. Unquoted, the shell splits there and wrangler gets `--config C:\Users\First` — an error
 * that never names the cause. macOS and Linux hit the same thing from any home path with a space.
 * `scripts/build-bundle.mjs` has always quoted this same interpolation; this matches it.
 */
export function deployCommand(configPath) {
  return `npx --yes wrangler@4 deploy --config "${configPath}"`;
}

/**
 * Which deployment is this build record about to overwrite?
 *
 * 🔴 Deliberately NOT `resolveTarget()`, which #176 proposed. That resolver answers *"which
 * deployment do the document commands act on"* — the registry's selection, the login config, the
 * marker you are standing in. Deploy asks a different question: the build record decides where the
 * code goes, and the selected deployment may be something else entirely. Gating on the resolver
 * would put production's `protected` flag in front of a test deploy, and — far worse — leave a
 * protected production ungated whenever `use` pointed somewhere else.
 *
 * Rung 2+ serves on the custom domain, which is known before the deploy. Rung 1 lands on
 * workers.dev, whose URL wrangler only prints afterwards — so a re-deploy is identified by the one
 * it landed on last time, and a genuinely first deploy resolves to nothing, correctly: there is no
 * deployment yet to have agreed anything about.
 */
export const deployTargetUrl = (ctx = {}) =>
  ctx.rung >= 2 && ctx.host ? `https://${ctx.host}` : ctx.deployedUrl || "";

/**
 * Does `protected` stop this deploy? (ADR-021 section 6, extended by #176.)
 *
 * `protected` used to cover `rm`, `revoke` and `rotate` — the document commands, which resolve
 * through the registry where the flag lives. `upgrade` resolves through the build record and never
 * read the registry at all, so the one command that REPLACES THE RUNNING CODE was the one that
 * could not see the flag saying be careful with this deployment. Not an omission in a list: the two
 * paths asked different stores.
 *
 * A refusal, not a prompt, matching `requireYesOnProtected` — `protected` must mean the same thing
 * in a terminal and in a script.
 */
export const refusesProtectedDeploy = (known, flags = {}) =>
  Boolean(known?.entry?.protected) && flags.yes !== true;

export async function deploy(opts = {}) {
  loadCloudToken();
  const ctx = loadContext();
  if (!ctx.rung || !ctx.ownerEmail) {
    // "Run `init` first" is the right hint for a machine that has never provisioned anything, and
    // the WRONG one for a machine holding a login to a deployment someone else deploys — there,
    // `init` would provision production from a laptop (#144, #155). Distinguish the two by whether
    // this machine can reach ANY deployment.
    //
    // "Any" now includes a named one: since ADR-021 phase 3 a machine can hold its logins entirely
    // in the registry and never write config.json, and reading only config.json there would send an
    // operator who is plainly not new straight at `init` (#159). The registry's default is the
    // deployment to name, falling back to whichever is registered when none is selected.
    const registry = loadRegistry();
    const named = registry?.deployments?.[registry?.current] ?? Object.values(registry?.deployments ?? {})[0];
    const url = loadConfig({}).url || named?.url || "";
    if (url) {
      die(`Nothing to deploy from here — this install did not provision ${url}.`, [
        "It has a login, not a build record, which is what an operator has when the deployment is",
        "deployed elsewhere (CI, or another machine).",
        "",
        `  ${c.bold("Stand in the checkout that provisioned it")}, and re-run this there.`,
        `  ${c.dim("Or, if this machine really should own it:")} ${c.bold(runHint("setup", "init"))}`,
        `  ${c.dim("— which will provision and deploy it from here. That is rarely what you want for")}`,
        `  ${c.dim("a deployment that already exists.")}`,
      ]);
    }
    die("No .pagevault.json yet.", `Run \`${runHint("setup", "init")}\` first.`);
  }

  console.log(banner("deploy", `(${ctx.rung >= 3 ? "Secured" : "Public"} → ${shortId(ctx.accountId)})`));

  // --- 0. WHICH one? The registry entry, and the flag that lives on it -------
  //
  // ADR-021 gave deployments names so the operator confirms identity before acting, and the
  // vocabulary stopped at the door of the most consequential command (#176). Read before the
  // account check so a protected deployment costs nothing to refuse — nothing has been built,
  // nothing contacted, no config generated.
  const registry = loadRegistry();
  const known = findByUrl(registry, deployTargetUrl(ctx));

  if (refusesProtectedDeploy(known, opts.flags ?? {})) {
    die(`${known.name} is a protected deployment — replacing its running code needs an explicit --yes.`, [
      `  ${c.bold(known.name)}  ${known.entry.url}`,
      "",
      "  This deploy would replace the Worker that deployment is running. That is not reversible by",
      "  re-running anything: the code it was serving a minute ago is not on this machine unless the",
      "  package that built it still is.",
      "",
      `    ${c.bold(runHint("deploy YES=1", "upgrade --yes"))}   do it anyway, deliberately`,
      "",
      `  ${c.dim(`Unset it by removing "protected" from ${known.name} in ~/.pagevault/deployments.json.`)}`,
    ]);
  }

  // --- 0a. WHERE? Verify the pinned account, name it once, confirm it --------

  const accounts = await cfAccounts();
  if (accounts.length === 0) die("No Cloudflare token, or it reaches no account.", `Run \`${runHint("preflight", "init")}\` — it names the problem.`);
  if (!ctx.accountId) die("No account pinned yet.", `Run \`${runHint("setup", "init")}\` first — it pins the account.`);
  const target = accounts.find((a) => a.id === ctx.accountId);
  if (!target) {
    die(`Your token reaches ${accounts.map((a) => shortId(a.id)).join(", ")}, not the pinned ${shortId(ctx.accountId)}.`,
      `Use the token for the pinned account, or re-pin with \`${runHint("setup", "init")}\`.`);
  }

  const targetUrl = ctx.rung >= 2 && ctx.host ? `https://${ctx.host}` : "*.workers.dev";
  const row = (label, val) => console.log(`  ${c.cyan(label.padStart(12))}  ${val}`);
  row("Deploying to", acct(target));
  // The name, when there is one. ADR-021 section 4 asks every command to say what it is acting on,
  // and this is the block the operator answers y/N to — an account id and a URL name a machine, not
  // the thing the operator calls "prod". Silent on a first deploy, where there is nothing true to
  // say yet, matching `announceTarget`: a name is printed when one exists, never invented.
  if (known) row("Deployment", `${c.bold(known.name)}${known.entry.protected ? c.dim(" · protected") : ""}`);
  row("Owner", ctx.ownerEmail);
  // The tier belongs in the block you are saying y/N to. It was only in the banner above, which is
  // easy to scroll past — and it is the line that decides whether strangers can open your documents.
  row("Tier", ctx.rung >= 3 ? `${c.bold("Secured")} ${c.dim("— named people only, via Cloudflare Access")}` : `${c.bold("Public")} ${c.dim("— anyone with the link")}`);
  row("URL", c.bold(targetUrl));
  console.log();
  if (isInteractive()) {
    const rl = createInterface({ input: stdin, output: stdout });
    const ans = (await rl.question(`  Continue? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (ans !== "y") die("Cancelled — nothing was deployed.");
  }

  // --- 0b. rung 1: a fresh account has no workers.dev subdomain. Register one. -

  if (ctx.rung < 2) {
    const sub = await cfApi(`/accounts/${target.id}/workers/subdomain`);
    if (sub.result?.subdomain) {
      ok(`workers.dev subdomain: ${c.dim(sub.result.subdomain)}`);
    } else {
      let name = slug(ctx.ownerEmail.split("@")[0]);
      if (isInteractive()) {
        const rl = createInterface({ input: stdin, output: stdout });
        const ans = (
          await rl.question(
            `\n  This account has no workers.dev subdomain yet.\n` +
              `  Register ${c.bold(`${name}.workers.dev`)}?  [Enter to accept · type another name · "n" to cancel] `,
          )
        ).trim();
        rl.close();
        if (/^n(o)?$/i.test(ans)) die("A workers.dev subdomain is required for rung 1.");
        if (ans && !/^y(es)?$/i.test(ans)) name = slug(ans);
      }
      info(`Registering ${name}.workers.dev…`);
      const put = await cfApi(`/accounts/${target.id}/workers/subdomain`, {
        method: "PUT",
        body: JSON.stringify({ subdomain: name }),
      });
      if (!put.ok) die(`Couldn't register "${name}.workers.dev" (${cfErr(put.errors)}).`, "That name may be taken — re-run and pick another.");
      ok(`Registered ${c.bold(`${name}.workers.dev`)}`);
    }
  }

  // --- 0c. 🔴 The bearer question, asked BEFORE anything is built ------------
  //
  // PAGEVAULT_API_TOKEN is what the CLI and MCP server authenticate with. Without it a deployed
  // Worker is live and unusable: every /api call 401s, `list` says "Not configured", and there is
  // no way in.
  //
  // This check used to sit AFTER the deploy, so a non-interactive run with no bearer — which is
  // exactly what `pagevault init --yes` is on a fresh machine — deployed a Worker, went live, and
  // then died. It left a half-provisioned deployment and told the operator to "run init once
  // locally", which is what they had just run. Refusing before the deploy costs nothing and leaves
  // the account untouched.
  //
  // Asking now is safe: a Worker that does not exist yet has no secrets, so the lookup fails and
  // hasSecret is correctly false.
  const existing = await cfApi(`/accounts/${target.id}/workers/scripts/pagevault/secrets`);
  const hasSecret = existing.ok && (existing.result ?? []).some((s) => s.name === "PAGEVAULT_API_TOKEN");
  const bearer = chooseBearer({ hasSecret, provided: fromEnv("PAGEVAULT_API_TOKEN"), interactive: isInteractive() });

  if (bearer.action === "fail") {
    die("No PAGEVAULT_API_TOKEN on the Worker, and none provided, in a non-interactive deploy.", [
      "  Nothing was deployed — a Worker without this bearer is live and unusable, so this stops here.",
      "",
      "  This is a fresh deployment with no way to authenticate to it yet. Give it one:",
      `    • run \`${runHint("deploy", "init")}\` WITHOUT --yes, and it mints and saves the bearer for you, or`,
      "    • provide one yourself:",
      "        export PAGEVAULT_API_TOKEN=$(openssl rand -hex 32)",
      `        ${runHint("deploy", "init --yes")}`,
      "      (in CI, set it as a GitHub Environment secret instead)",
    ]);
  }

  // --- 1. Generate the tier-appropriate config -------------------------------

  // Bundle mode (ADR-014): deploy the prebuilt cli/dist/worker.js instead of bundling from src.
  // The installed `pagevault init`/`upgrade` pass `{ bundle: true }`; from the repo, opt in with
  // `PAGEVAULT_BUNDLE=1` (that's what `make deploy-bundle` sets). Default — `make deploy`, prod CI —
  // bundles from src, unchanged.
  const bundle = opts.bundle ?? process.env.PAGEVAULT_BUNDLE === "1";

  // View tracking as asked for on this run — a flag, or PAGEVAULT_ANALYTICS, which is the one a
  // CI-deployed production can set (#187). Undefined means "didn't say", and provisioning falls back
  // to the declared intent and then to what the live Worker already has.
  //
  // Resolved OUTSIDE the try below on purpose: a typo'd value dies with its own message, and the
  // catch there rewrites everything into "Config generation failed", which would bury it.
  const analytics = analyticsChoice(opts.flags ?? {});

  info(ctx.rung >= 3 ? "Provisioning Access (rung 3)…" : "Writing the Tier-0 config…");
  if (bundle) info("Bundle mode: deploying the prebuilt Worker (no_bundle).");
  try {
    // In-process (was `execSync node scripts/{provision,tier0}.mjs`): same cwd and same
    // process.env — CLOUDFLARE_API_TOKEN is already loaded — so the generated config is identical.
    // Every rung takes the answer now: rung 1–2 used to bind ANALYTICS regardless and warn that
    // the flag had nowhere to go, which made a fresh account's first deploy fail (#190).
    if (ctx.rung >= 3) await provisionAccess({ bundle, analytics });
    else await writeTier0Config({ bundle, analytics });
  } catch (err) {
    die("Config generation failed — see the output above.");
  }

  // --- 2. Deploy -------------------------------------------------------------

  info("Deploying the Worker…");
  let out = "";
  try {
    out = execSync(deployCommand(CONFIG_OUT), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    process.stdout.write(out);
  } catch (err) {
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    process.stdout.write(err.stdout ?? "");
    process.stderr.write(err.stderr ?? "");
    if (/workers\.dev subdomain/i.test(output)) {
      die("This account still has no workers.dev subdomain.",
        `Odd — the step above should have registered one. Re-run \`${runHint("deploy", "upgrade")}\`.`);
    }
    // 10089 — the ANALYTICS binding is in the config but Analytics Engine is off on the account.
    // Every rung now asks before adding the binding, so reaching here means the answer was on and
    // the product is not, or the config was hand-edited. Either way the fix is two options, not a
    // Cloudflare error code.
    //
    // 🔴 The hint must name a command that exists at the rung the operator is on. It used to say
    // `provision ANALYTICS=off` / `init`, which is rung 3 only — so at rung 1–2, where this fired
    // most (#190), it pointed at nothing runnable. `deploy` / `upgrade` reach every rung.
    if (/10089/.test(output) || /enable Analytics Engine/i.test(output)) {
      die(
        "Analytics Engine is not enabled on this account, but the Worker config binds it.",
        `Enable it at ${analyticsDashboard(ctx.accountId)} and re-run, or drop view tracking with \`${runHint("deploy ANALYTICS=off", "upgrade --no-analytics")}\`.`,
      );
    }
    die("Deploy failed — see wrangler's output above.");
  }

  // --- 3. Remember where it landed, so `make verify` knows what to test -------

  // At rung 2+ the canonical URL is the custom domain (workers.dev is off there); at rung 1 it's
  // the workers.dev URL wrangler printed. Getting this right is what points verify and the /p/
  // links at the domain, not a stray workers.dev address.
  const url =
    ctx.rung >= 2 && ctx.host
      ? `https://${ctx.host}`
      : (out.match(/https:\/\/[^\s]+\.workers\.dev[^\s]*/)?.[0] ?? (ctx.host ? `https://${ctx.host}` : undefined));
  if (url) {
    saveContext({ ...loadContext(), deployedUrl: url });
    ok(`Live at ${c.bold(url)}`);
  } else {
    warn("Deployed, but couldn't read the URL from wrangler's output — check above.");
  }

  // --- 4. The bearer secret — set it over the API ----------------------------
  //
  // PAGEVAULT_API_TOKEN is what the CLI and MCP server authenticate with (a different token from
  // the Cloudflare one). The token model lets us set it via the API, so there is no `wrangler
  // secret put` step to run by hand in a wrong-Node shell. Which value to use was decided in 0c,
  // before the deploy — reuse what the Worker has (never rotate a live bearer), else the provided
  // value (a GitHub Environment secret in CI), else mint one interactively. The `fail` case never
  // reaches here: it stops the run before anything is built.

  const setBearer = (value) =>
    cfApi(`/accounts/${target.id}/workers/scripts/pagevault/secrets`, {
      method: "PUT",
      body: JSON.stringify({ name: "PAGEVAULT_API_TOKEN", text: value, type: "secret_text" }),
    });

  console.log();

  // The bearer we end up with in plaintext, if any — used just below to write the installed CLI's
  // login config. Set only on a known-good state (the secret is live and this value is it).
  let bearerValue;

  if (bearer.action === "skip") {
    ok("PAGEVAULT_API_TOKEN is already the Worker's secret — reused, not rotated.");
    // Worker already has it; the plaintext isn't on the Worker (secrets are write-only), but a
    // re-deploy from the same install has it in .env.local — enough to (re)write the login config.
    bearerValue = fromEnv("PAGEVAULT_API_TOKEN");
  } else if (bearer.action === "set") {
    const put = await setBearer(bearer.value);
    if (put.ok) {
      ok("PAGEVAULT_API_TOKEN set as the Worker's secret — the value from your environment, unchanged.");
      bearerValue = bearer.value;
    } else {
      warn(`Couldn't set PAGEVAULT_API_TOKEN (${cfErr(put.errors)}).`);
    }
  } else {
    const value = randomBytes(32).toString("hex");
    const put = await setBearer(value);
    if (put.ok) {
      // Save it locally too: the Worker now has this secret, but so must the CLI, the MCP
      // bearer, and `make verify` (which publishes the welcome doc). .env.local is gitignored.
      writeEnvLocalVar("PAGEVAULT_API_TOKEN", value);
      bearerValue = value;
      ok("PAGEVAULT_API_TOKEN set as the Worker's secret and saved to .env.local (your CLI / MCP bearer):");
      console.log(`     ${c.bold(value)}`);
      console.log(`     ${c.dim("Same token the Worker uses — verify will publish your first document with it.")}`);
    } else {
      warn(`Couldn't set PAGEVAULT_API_TOKEN automatically (${cfErr(put.errors)}).`);
      console.log(`  Set it by hand under Node 22: ${c.bold(`npx wrangler secret put PAGEVAULT_API_TOKEN --config ${CONFIG_OUT}`)}`);
    }
  }

  // 🔴 A Worker secret is write-only, so the machine that just set it needs its own copy or the very
  // next document command has nothing to send (#195). `.env.local` is the copy that TRAVELS WITH the
  // build record — same directory — which is what lets `target.mjs` pair the two without anyone
  // naming a deployment. Written whenever we hold the plaintext and the file disagrees, so a bearer
  // supplied by an exported env var is still on disk in the next shell.
  //
  // Not in CI: the runner is about to disappear, the value is already an environment secret, and a
  // deploy job has no next command to help.
  if (url && bearerValue && !process.env.CI && fromEnvFile("PAGEVAULT_API_TOKEN") !== bearerValue) {
    writeEnvLocalVar("PAGEVAULT_API_TOKEN", bearerValue);
  }

  // Installed (ADR-014): leave the operator ready to publish with no second `login`. We know the URL
  // we deployed to and the bearer we just set, so record it now. A repo run uses .env.local + make and
  // shouldn't have its login silently repointed at its last deploy, so this is installed-only. Skipped
  // when the bearer plaintext isn't in hand (a `skip` on a machine that never held it — e.g.
  // redeploying someone else's Worker); `pagevault login` covers that.
  //
  // 🔴 This used to write config.json unconditionally, which was right when one machine held one
  // deployment and wrong the moment it could hold two: `pagevault upgrade` on test overwrote a login
  // describing production (#171). Where production's bearer lived only in that file, the credential
  // was destroyed rather than shadowed.
  if (!RUNNING_FROM_REPO && url && bearerValue) {
    // Re-resolved against the URL wrangler actually printed, not the one predicted in 0 — at rung 1
    // a genuinely first deploy had no URL to predict from, and this is where it becomes knowable.
    // Nothing has written the registry in between, so the read above is still current.
    const landed = findByUrl(registry, url);

    if (landed) {
      // A deployment we already know by name. Its bearer belongs on ITS entry — never in the global
      // slot, which may be describing something else entirely.
      //
      // `markerPath` rides along because this is the moment it becomes true: we just wrote that
      // build record, so we know both that it exists and which deployment it describes. A path, not
      // a copy — `deployments` reads the record fresh through it, so nothing here can go stale
      // (#170).
      const patch = { url, token: bearerValue, markerPath: statePath(CONTEXT_FILE) };
      const file = saveRegistry(upsert(registry, landed.name, patch), process.env);
      ok(`Updated ${c.bold(landed.name)} in ${file} — the bearer travels with the deployment.`);
      if (registry.current && registry.current !== landed.name) {
        console.log(`  ${c.dim(`Still defaulting to ${registry.current} elsewhere. Switch with:`)} ${c.bold(`pagevault use ${landed.name}`)}`);
      }
    } else if (shouldAdoptCurrent(registry, url, loadConfig({}).url)) {
      // Nothing else claims the default, or the login already describes this deployment. This is the
      // ordinary single-deployment install, and it behaves exactly as it always has.
      const path = saveLoginConfig({ url, token: bearerValue });
      ok(`Saved ${path} — this deployment is now the CLI default.`);
    } else {
      // Something else is the default and this deployment is not it. Refuse to move it silently; say
      // what would make this deployment addressable BY NAME from anywhere. Standing here already
      // selects it — `reportReach` below says so — so this is about the global default, nothing more.
      //
      // The default lives in one of two places and `registry` may be null outright, so read it the
      // way `shouldAdoptCurrent` decided it: the registry's selection, else the login config.
      const current = registry?.current || loadConfig({}).url;
      console.log();
      warn(`${c.bold(current)} stays this machine's default deployment.`);
      console.log(`  ${c.dim("just deployed")}  ${c.bold(url)}`);
      console.log(`  ${c.dim("default      ")}  ${current}`);
      console.log(`\n  ${c.dim("Not repointing it for you — that is how a deploy loses another deployment's bearer.")}`);
      console.log(`  ${c.dim("Name this one to reach it from anywhere:")}`);
      console.log(`     ${c.bold(`pagevault login --as ${suggestName(url)} --url ${url} --token ${tokenArg()}`)}`);
    }
  }

  // Whatever the two blocks above did or declined to do, ONE line settles what the operator is about
  // to hit — computed, not inferred. See reportReach.
  if (url) reportReach(url);

  // What is readable without a login? On a Secured deployment that is worth saying out loud, because
  // a document published while the deployment was Public keeps its /p/ capability link forever — and
  // rightly so: revoking it silently would break a URL already sitting in a client's inbox. But the
  // operator should not have to discover that themselves after turning security on. See #121.
  if (ctx.rung >= 3 && url) await reportPublicDocuments(url, bearerValue ?? fromEnv("PAGEVAULT_API_TOKEN"));

  // --- 5. rung 3: the scoped runtime secret (CF_API_TOKEN) -------------------
  //
  // access-group.ts uses a Worker secret, CF_API_TOKEN, to keep the pagevault-viewers group in
  // step as portal members change (ADR-002). It's the SCOPED runtime token the operator created
  // (CF_RUNTIME_TOKEN in .env.local) — deliberately NOT the broad provisioning credential, so a
  // compromised Worker can touch one Access group and nothing else. Set post-deploy, like the
  // bearer, because the Worker script must exist first. Absent = email-grant sync stays off, but
  // the owner can still log in — degraded, not broken.

  if (ctx.rung >= 3) {
    console.log();
    const runtime = fromEnv("CF_RUNTIME_TOKEN");
    const hasRuntime = existing.ok && (existing.result ?? []).some((s) => s.name === "CF_API_TOKEN");
    if (runtime) {
      const put = await cfApi(`/accounts/${target.id}/workers/scripts/pagevault/secrets`, {
        method: "PUT",
        body: JSON.stringify({ name: "CF_API_TOKEN", text: runtime, type: "secret_text" }),
      });
      put.ok
        ? ok("CF_API_TOKEN (scoped runtime secret) set — the Worker can sync the viewer group.")
        : warn(`Couldn't set CF_API_TOKEN (${cfErr(put.errors)}). Check the token, or set it with wrangler.`);
    } else if (hasRuntime) {
      ok("CF_API_TOKEN (scoped runtime secret) is already set.");
    } else {
      warn("No CF_RUNTIME_TOKEN in .env.local — email-grant sync is off until CF_API_TOKEN is set.");
      console.log(`  ${c.dim(`Provision printed how to create it. Add it, then re-run \`${runHint("deploy", "upgrade")}\`.`)}`);
    }
  }

  const verifyCmd = RUNNING_FROM_REPO ? "make verify" : "pagevault verify";

  // If a backup is sitting right here, this is probably a recovery, not a first run — and the
  // order matters. `verify` publishes a sample document, which leaves keys the backup won't
  // replace and turns the next `restore` into a refusal (#125). Restore first, then verify.
  const backup = findBackupFile();
  if (backup) {
    // Same switch as `verifyCmd` above, and for the same reason: an installed operator has no
    // Makefile, so `make restore` is a command they cannot run.
    console.log(`\n${c.bold("Next:")} ${c.bold(restoreHint(backup))} ${c.dim("— a backup file is sitting in this directory.")}`);
    console.log(`  ${c.dim(`Restore BEFORE ${verifyCmd}: verify publishes a sample document, and restoring is cleanest into a namespace nothing has written to yet.`)}`);
    console.log(`  ${c.dim(`Not recovering? Skip it and run ${verifyCmd}.`)}\n`);
    return;
  }

  console.log(`\n${c.bold("Next:")} ${c.bold(verifyCmd)} ${c.dim("— smoke-test the deployment and publish your first document.")}`);
  console.log(`  ${c.dim("It hands back a public /p/ link you can open immediately — no login, no Access.")}\n`);
}

/**
 * A deployment name worth suggesting, from its hostname.
 *
 * A suggestion, not a decision — the operator types it or types something else. But a printed
 * command with `<name>` still in it is a command nobody can paste, and on a first run the values it
 * asks for are exactly the ones the operator does not have yet (#195).
 *
 * On workers.dev the first label is always our Worker's name and says nothing; the one before
 * `workers.dev` is the operator's own subdomain, which is the distinguishing part.
 */
export function suggestName(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return "pagevault";
  }
  const labels = host.split(".");
  return slug(host.endsWith(".workers.dev") ? (labels.at(-3) ?? host) : labels[0]);
}

/**
 * The `--token` argument for a printed `login` command, in a form that works when pasted.
 *
 * `$PAGEVAULT_API_TOKEN` when the shell can expand it, a placeholder otherwise. Never the literal
 * value: this path is reached when the machine could NOT find the bearer, and printing a live
 * credential into scrollback to solve a message-clarity problem is a poor trade. The mint path
 * prints its value because there is genuinely nowhere else to read it from.
 */
const tokenArg = () => (process.env.PAGEVAULT_API_TOKEN ? "$PAGEVAULT_API_TOKEN" : "<PAGEVAULT_API_TOKEN>");

/**
 * 🔴 Will the next `pagevault list` reach what we just deployed?
 *
 * Answered by the same resolver the document commands use, rather than inferred from a nearby fact.
 * The two messages this replaces each guessed — one from `!process.env.PAGEVAULT_API_TOKEN`, one
 * from a registry lookup — and neither was asking `commandTarget()`'s question. So a deploy could
 * report PAGEVAULT_API_TOKEN set and, four lines later, report no bearer at all: both true, of
 * different stores, and unreadable as anything but a contradiction on a first run (#195).
 *
 * Naming the store is the other half. "The Worker's secret" and "this machine's copy" are two
 * things wearing one name, and until the output distinguishes them the operator has to.
 */
export function reportReach(url) {
  const config = loadConfig({}); // file only — an env var is per-command and not this machine's state
  const target = resolveTarget({ config, registry: loadRegistry() });
  const { token, from } = resolveBearerSource(target, {
    env: process.env.PAGEVAULT_API_TOKEN || "",
    state: stateToken(target),
    config: config.token,
  });

  console.log();
  if (token && sameDeployment(target.url, url)) {
    ok(`${c.bold("pagevault")}'s document commands act on this deployment from here.`);
    console.log(`  ${c.dim(`bearer: ${from} — the Worker holds the same value as its secret.`)}`);
    return;
  }

  warn(`Deployed, but ${c.bold("pagevault")}'s document commands cannot authenticate to it yet.`);
  console.log(`  ${c.dim("just deployed")}  ${c.bold(url)}`);
  // Only when they differ. Printing two identical URLs invites a hunt for a mismatch that is not
  // the problem — the problem is the credential, and the line above already named the deployment.
  if (!sameDeployment(target.url, url)) console.log(`  ${c.dim("they resolve ")}  ${target.url || c.dim("nothing")}`);
  console.log(`\n  ${c.dim("The Worker holds the bearer as a secret, and a secret cannot be read back — so this")}`);
  console.log(`  ${c.dim("machine needs its own copy. Register the deployment and it travels with it:")}`);
  console.log(`     ${c.bold(`pagevault login --as ${suggestName(url)} --url ${url} --token ${tokenArg()}`)}`);
  if (!process.env.PAGEVAULT_API_TOKEN) {
    console.log(`  ${c.dim("The token is the one this deploy used — from your environment, or whatever you set as")}`);
    console.log(`  ${c.dim(`the Worker's PAGEVAULT_API_TOKEN secret. Nothing on this machine has a copy to fill in.`)}`);
  }
}

/**
 * The newest `pagevault-backup-*.json` in the working directory, if any.
 *
 * A weak signal on purpose: it only ever changes which command gets suggested, never what runs.
 * `make backup` writes these here by default, so their presence after a deploy into a fresh KV
 * is a good guess that someone is rebuilding rather than starting.
 */
function findBackupFile() {
  try {
    return readdirSync(process.cwd())
      .filter((f) => /^pagevault-backup-.*\.json$/.test(f))
      .sort()
      .pop();
  } catch {
    return undefined;
  }
}

/**
 * On a Secured deployment, name the documents that still open with no login.
 *
 * Advisory only: it never fails a deploy, and it stays quiet when there is nothing to say. The
 * point is the Public → Secured climb, where documents published under the old tier keep the
 * `/p/` links they were given (worker/src/documents.ts) — correct behaviour that is nonetheless
 * invisible at exactly the moment the operator believes they have just secured everything.
 */
async function reportPublicDocuments(url, bearer) {
  if (!bearer) return;
  let docs;
  try {
    const res = await fetch(`${url}/api/docs`, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return; // the route may still be coming up; this is advisory, not a gate
    ({ docs } = await res.json());
  } catch {
    return;
  }

  const open = (docs ?? []).filter((d) => d.public);
  if (!open.length) return;

  console.log();
  warn(`${c.bold(String(open.length))} document${open.length === 1 ? "" : "s"} on this deployment still open with ${c.bold("no login")}:`);
  for (const d of open.slice(0, 8)) console.log(`     ${c.dim("·")} ${d.name ?? d.title} ${c.dim(`(${d.portal})`)}`);
  if (open.length > 8) console.log(`     ${c.dim(`… and ${open.length - 8} more`)}`);
  console.log(`\n  ${c.dim("Public links survive a tier change on purpose — revoking one would break a URL you")}`);
  console.log(`  ${c.dim("have already sent. Close the ones you don't want open:")}`);
  console.log(`     ${c.bold("pagevault list --json")} ${c.dim("to see them all, then")} ${c.bold("pagevault revoke <id>")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // `make deploy` lands here. Flags are parsed rather than ignored so `ANALYTICS=on|off` on the
  // make target has somewhere to go, and so prod CI can pass the same thing as an env var.
  await deploy({ flags: parseArgs(process.argv.slice(2)).flags });
}

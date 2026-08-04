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
  writeEnvLocalVar, fromEnv, acct, shortId, banner, chooseBearer, generatedConfigPath, RUNNING_FROM_REPO, runHint,
} from "./context.mjs";
import { provisionAccess } from "./provision.mjs";
import { writeTier0Config } from "./tier0.mjs";
import { saveLoginConfig, loadConfig, CONFIG_PATH } from "../client.mjs";

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

export async function deploy(opts = {}) {
  loadCloudToken();
  const ctx = loadContext();
  if (!ctx.rung || !ctx.ownerEmail) die("No .pagevault.json yet.", `Run \`${runHint("setup", "init")}\` first.`);

  console.log(banner("deploy", `(${ctx.rung >= 3 ? "Secured" : "Public"} → ${shortId(ctx.accountId)})`));

  // --- 0. WHERE? Verify the pinned account, name it once, confirm it ---------

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

  info(ctx.rung >= 3 ? "Provisioning Access (rung 3)…" : "Writing the Tier-0 config…");
  if (bundle) info("Bundle mode: deploying the prebuilt Worker (no_bundle).");
  try {
    // In-process (was `execSync node scripts/{provision,tier0}.mjs`): same cwd and same
    // process.env — CLOUDFLARE_API_TOKEN is already loaded — so the generated config is identical.
    if (ctx.rung >= 3) await provisionAccess({ bundle });
    else await writeTier0Config({ bundle });
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
    // 10089 — the ANALYTICS binding is in the config but Analytics Engine is off on the
    // account. Provisioning asks before adding the binding, so reaching here means it was
    // turned back off, or the config was hand-edited. Either way the fix is two options, not
    // a Cloudflare error code.
    if (/10089/.test(output) || /enable Analytics Engine/i.test(output)) {
      die(
        "Analytics Engine is not enabled on this account, but the Worker config binds it.",
        `Enable it at https://dash.cloudflare.com/${ctx.accountId ?? ""}/workers/analytics-engine and re-run, or drop view tracking with \`${runHint("provision ANALYTICS=off", "init")}\`.`,
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
    ok("PAGEVAULT_API_TOKEN is already set — reused, not rotated.");
    // Worker already has it; the plaintext isn't on the Worker (secrets are write-only), but a
    // re-deploy from the same install has it in .env.local — enough to (re)write the login config.
    bearerValue = fromEnv("PAGEVAULT_API_TOKEN");
  } else if (bearer.action === "set") {
    const put = await setBearer(bearer.value);
    if (put.ok) {
      ok("PAGEVAULT_API_TOKEN set from the environment — your existing CLI / MCP bearer, unchanged.");
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
      ok("PAGEVAULT_API_TOKEN set on the Worker and saved to .env.local (your CLI / MCP bearer):");
      console.log(`     ${c.bold(value)}`);
      console.log(`     ${c.dim("Same token the Worker uses — verify will publish your first document with it.")}`);
    } else {
      warn(`Couldn't set PAGEVAULT_API_TOKEN automatically (${cfErr(put.errors)}).`);
      console.log(`  Set it by hand under Node 22: ${c.bold(`npx wrangler secret put PAGEVAULT_API_TOKEN --config ${CONFIG_OUT}`)}`);
    }
  }

  // Installed (ADR-014): leave the operator ready to publish with no second `login`. We know the URL
  // we deployed to and the bearer we just set, so write the CLI's login config (~/.pagevault/config.json)
  // now. A repo run uses .env.local + make and shouldn't have that file silently repointed at its last
  // deploy, so this is installed-only. Skipped when the bearer plaintext isn't in hand (a `skip` on a
  // machine that never held it — e.g. redeploying someone else's Worker); `pagevault login` covers that.
  if (!RUNNING_FROM_REPO && url && bearerValue) {
    const path = saveLoginConfig({ url, token: bearerValue });
    ok(`Saved ${path} — ${c.bold("pagevault publish")} is ready, no ${c.bold("login")} step needed.`);
  } else if (RUNNING_FROM_REPO && url) {
    // We deliberately do NOT repoint a repo run's login config (see above) — but a config left by
    // an earlier install silently WINS over the deployment we just built, so `pagevault publish`
    // from this checkout would write somewhere else entirely. That is a wrong-deployment write, and
    // it is worth a loud line rather than a confusing "Could not reach <host you never mentioned>"
    // at first publish. See #120.
    const configured = loadConfig({}).url; // file only — env is per-command and not ours to judge
    if (configured && configured !== url) {
      console.log();
      warn(`${c.bold("pagevault")}'s document commands still point at a different deployment.`);
      console.log(`  ${c.dim("just deployed")}  ${c.bold(url)}`);
      console.log(`  ${c.dim("config.json  ")}  ${configured} ${c.dim(`(${CONFIG_PATH})`)}`);
      console.log(`\n  ${c.dim("From a repo, deploy leaves that file alone on purpose. To point the CLI here:")}`);
      console.log(`     ${c.bold(`pagevault login --url ${url} --token $PAGEVAULT_API_TOKEN`)}`);
      console.log(`  ${c.dim("or set PAGEVAULT_URL / PAGEVAULT_API_TOKEN per command.")}`);
    }
  }

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
    console.log(`\n${c.bold("Next:")} ${c.bold(`make restore FILE=${backup}`)} ${c.dim("— a backup file is sitting in this directory.")}`);
    console.log(`  ${c.dim(`Restore BEFORE ${verifyCmd}: verify publishes a sample document, and restoring is cleanest into a namespace nothing has written to yet.`)}`);
    console.log(`  ${c.dim(`Not recovering? Skip it and run ${verifyCmd}.`)}\n`);
    return;
  }

  console.log(`\n${c.bold("Next:")} ${c.bold(verifyCmd)} ${c.dim("— smoke-test the deployment and publish your first document.")}`);
  console.log(`  ${c.dim("It hands back a public /p/ link you can open immediately — no login, no Access.")}\n`);
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
  await deploy();
}

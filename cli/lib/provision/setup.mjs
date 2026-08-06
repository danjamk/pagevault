#!/usr/bin/env node
//
// The interactive setup — decide what you want, written into .pagevault.json. Local only: no
// Cloudflare calls beyond a read to pin the account, nothing created. Re-run it anytime to change
// your mind or climb a rung — it shows your current choices and lets you edit them.
//
//   node cli/lib/provision/setup.mjs
//   node cli/lib/provision/setup.mjs --rung 1 --email you@example.com      # non-interactive
//   node cli/lib/provision/setup.mjs --rung 2 --host pagevault.you.com
//
// Exported as `setup()` so `pagevault init` can run it in-process, then deploy. It RETURNS a
// status ({ ready }) instead of exiting, so a caller that wants to continue (init → deploy) can;
// the run-if-main shim at the bottom preserves the standalone `make setup` behavior.
//
import { createInterface } from "node:readline/promises";
import { stdin, stdout, versions } from "node:process";
import { pathToFileURL } from "node:url";
import { c, ok, info, warn, die, loadContext, saveContext, resolve, isInteractive, loadCloudToken, cloudTokenSource, writeEnvLocalVar, cfApi, cfAccounts, acct, tokenSetupFlow, banner, runHint, argValue, fromEnv } from "./context.mjs";

/**
 * The active zones (domains) the pinned account owns — so the rung-2 hostname prompt can suggest
 * them instead of demanding you remember and type a full hostname. Only visible when a cloud token
 * is already saved (a re-run, which is exactly when you climb to rung 2); a true first run has no
 * token yet and this returns [], falling back to the free-text prompt.
 */
async function accountZones(ctx) {
  if (!isInteractive() || !loadCloudToken()) return [];
  try {
    const z = await cfApi("/zones?per_page=50");
    if (!z.ok) return [];
    return (z.result ?? [])
      .filter((x) => x.status === "active" && (!ctx.accountId || x.account?.id === ctx.accountId))
      .map((x) => x.name);
  } catch {
    return [];
  }
}

/**
 * Resolve the rung-2+ hostname: `--host` / env win outright; otherwise suggest the account's
 * domains — the sole one as a default (`pagevault.<zone>`), or a numbered pick when there are
 * several. Falls back to a plain prompt when no domain is visible (first run, no token yet).
 */
async function resolveHost({ ctx, rl }) {
  const forced = argValue("--host") ?? fromEnv("HOST");
  if (forced) return forced;

  const zones = await accountZones(ctx);
  if (zones.length && isInteractive()) {
    if (zones.length === 1) {
      const suggested = ctx.host || `pagevault.${zones[0]}`;
      const ans = (await rl.question(`  Hostname to serve on? ${c.dim(`[${suggested}]`)}: `)).trim();
      return ans || suggested;
    }
    console.log(`  Domains in this account — pick one, or type a full hostname:`);
    zones.forEach((z, i) => console.log(`    ${c.bold(String(i + 1))}  pagevault.${z}`));
    const ans = (await rl.question(`  Which? ${c.dim("[1]")} `)).trim() || "1";
    const n = Number(ans);
    return Number.isInteger(n) && zones[n - 1] ? `pagevault.${zones[n - 1]}` : ans;
  }

  // No domain visible yet — the plain prompt (keeps any saved host as the default).
  return resolve({
    flag: "--host",
    ctxValue: ctx.host,
    promptText: "Hostname to serve on (e.g. pagevault.you.com)",
    rl,
    fallback: ctx.host,
  });
}

/**
 * The tier the user is choosing between (ADR-018): "public" or "secured". `--tier` wins; otherwise
 * prompt, defaulting from the saved rung (3 → secured, else public). `--rung` is handled by the
 * caller as a direct escape and never reaches here.
 *
 * Numbered, not free-text. This used to read `Which tier — Public or Secured? [public]` — capitalised
 * words against a lowercase default — which left people unsure whether the answer was case-sensitive
 * and what exactly to type. A number cannot be mistyped into meaning the other thing. Words still
 * work for anyone who types them out of habit, and this is also where the two tiers are described,
 * so the choice and its consequences are on screen together rather than several lines apart.
 */
export function tierFromAnswer(answer, def) {
  const ans = String(answer ?? "").trim().toLowerCase();
  if (!ans) return def;
  if (ans === "1") return "public";
  if (ans === "2") return "secured";
  // Words still accepted — "s", "sec", "secured", "p", "pub", "public" — for anyone who types the
  // thing they can see rather than the number beside it.
  if ("secured".startsWith(ans)) return "secured";
  if ("public".startsWith(ans)) return "public";
  return null; // caller decides how to complain
}

async function resolveTier({ ctx, rl }) {
  const flag = (argValue("--tier") || "").toLowerCase();
  if (flag.startsWith("pub")) return "public";
  if (flag.startsWith("sec")) return "secured";
  const def = (ctx.rung ?? 1) >= 3 ? "secured" : "public";
  if (!isInteractive() || !rl) return def;

  const defNum = def === "secured" ? "2" : "1";
  console.log(`  ${c.bold("1")}  ${c.bold("Public")}   ${c.dim("public links anyone with the URL can open")}   ${c.dim("free · no card")}`);
  console.log(`            ${c.dim("optionally on your own domain")}`);
  console.log(`  ${c.bold("2")}  ${c.bold("Secured")}  ${c.dim("private — named people, client portals")}      ${c.dim("a domain + Zero Trust (a card)")}`);
  console.log();

  const answer = await rl.question(`  Which? ${c.dim(`[${defNum}]`)} `);
  const tier = tierFromAnswer(answer, def);
  if (!tier) die(`"${answer.trim()}" — type ${c.bold("1")} for Public or ${c.bold("2")} for Secured.`);
  return tier;
}

/**
 * Within Public, a domain is optional (ADR-018): `--host`/env means yes; a saved host defaults to
 * yes; otherwise ask. Non-interactive falls back to whether a host is already saved.
 */
async function wantsDomain({ ctx, rl }) {
  if (argValue("--host") || fromEnv("HOST")) return true;
  const def = ctx.host ? "y" : "n";
  if (!isInteractive() || !rl) return def === "y";
  const ans = (await rl.question(`  Serve on your own domain? ${c.dim(`(optional) [${def === "y" ? "Y/n" : "y/N"}]`)} `)).trim().toLowerCase();
  if (!ans) return def === "y";
  return ans === "y" || ans === "yes";
}

/**
 * Configure this deployment (rung, owner, host, pinned account) into `.pagevault.json`.
 *
 * Returns `{ ready: true }` when the config is complete enough to deploy — rung, owner, and a
 * pinned account are set. Returns `{ ready: false }` when it stopped early (no token saved, the
 * token reaches no account, or it switched you to rung 2 and wants a fresh pass): the caller
 * should not deploy. Human "what next" guidance is printed inline for the standalone path.
 */
export async function setup(opts = {}) {
  console.log(banner("setup", "(configuring — nothing deployed yet)"));

  // --- Sanity: the most basic thing, checked plainly -------------------------

  const major = Number(versions.node.split(".")[0]);
  if (major < 22) {
    warn(`Node ${versions.node} — Wrangler 4 needs Node 22+. Deploy will fail until you upgrade.`);
    console.log(`  ${c.dim("Get it at https://nodejs.org, or `nvm install 22 && nvm use 22`.")}\n`);
  } else {
    ok(`Node ${versions.node}`);
  }

  const ctx = loadContext();
  const firstRun = ctx.rung === undefined;

  // --- Teach, on the first run only ------------------------------------------

  if (firstRun) {
    // "your documents carry across untouched" was true and still is — but it was heard as "your
    // links keep working", which is false the moment the hostname changes. Say what carries. (#121)
    // The tiers themselves are described at the prompt that asks you to pick one (resolveTier), so
    // this is the framing only — the same two paragraphs twice, five lines apart, read as a stutter.
    console.log(`\n${c.bold("Two tiers")} — start Public, add security when you need it. Not a one-way`);
    console.log(`door; every document carries across, keeping its name and its place.\n`);
    console.log(`  ${c.dim("Most people start Public. Re-run this anytime to add a domain or turn on security.")}\n`);
  } else {
    const tierName = (ctx.rung ?? 1) >= 3 ? "Secured" : "Public";
    info(`Current: ${c.bold(tierName)}${ctx.host ? ` · ${ctx.host}` : ""}${ctx.ownerEmail ? ` · ${ctx.ownerEmail}` : ""}`);
    console.log(`  ${c.dim("Press enter to keep a value, or type a new one to change it.")}\n`);
  }

  const rl = createInterface({ input: stdin, output: stdout });

  // --- Resolve the intent (flag → env → current → prompt) --------------------

  const ownerEmail = (
    await resolve({
      flag: "--email",
      envKey: "OWNER_EMAIL",
      ctxValue: ctx.ownerEmail,
      promptText: "Your email (the owner)",
      rl,
      fallback: ctx.ownerEmail,
    })
  )?.toLowerCase();
  if (!ownerEmail || !ownerEmail.includes("@")) die("A valid owner email is required.");

  // Tier + domain → internal rung (ADR-018). Public is rung 1 (workers.dev) or 2 (with a domain);
  // Secured is rung 3 (Zero Trust + portals). `--rung 1|2|3` stays as the non-interactive escape.
  let host = ctx.host ?? "";
  let rung;
  const rungFlag = Number(argValue("--rung"));
  if ([1, 2, 3].includes(rungFlag)) {
    rung = rungFlag;
    if (rung >= 2) {
      host = await resolveHost({ ctx, rl });
      if (!host || !host.includes(".")) die("A domain is required, e.g. pagevault.you.com");
    } else host = "";
  } else if ((await resolveTier({ ctx, rl })) === "secured") {
    host = await resolveHost({ ctx, rl });
    if (!host || !host.includes(".")) die("Secured needs a domain, e.g. pagevault.you.com");
    rung = 3;
  } else if (await wantsDomain({ ctx, rl })) {
    host = await resolveHost({ ctx, rl });
    rung = host && host.includes(".") ? 2 : 1;
  } else {
    if (host) info(`Public without a domain — publishing on *.workers.dev (saved host ${host} ignored).`);
    host = "";
    rung = 1;
  }

  rl.close();

  // --- Save ------------------------------------------------------------------

  // Say back what was understood, before anything acts on it. The prompts above are terse by design,
  // so without this the only confirmation of a tier choice was the deploy banner — well past the
  // point where you would want to correct a mis-keyed answer, and on the one decision that turns
  // Zero Trust (and a card) on. Name the tier, and what it means for who can open a document.
  const secured = rung >= 3;
  console.log();
  ok(
    `${c.bold(secured ? "Secured" : "Public")} — ` +
      (secured
        ? `only people you name can open a document, on ${c.bold(host)}`
        : `anyone with the link can open a document, on ${c.bold(host || "*.workers.dev")}`),
  );
  if (secured) {
    console.log(`  ${c.dim("Cloudflare Access will gate /v and /admin. Zero Trust must be on for this account.")}`);
  }

  saveContext({ ...ctx, rung, ownerEmail, host });
  ok(`Saved to ${c.bold(".pagevault.json")}`);

  // Moving hostname retires every URL you have already handed out. The documents survive — same
  // ids, same names — but the links do not, and nothing used to say so before the deploy. This is
  // the moment to mention it, while it is still a decision rather than a surprise. See #121.
  const previousHost = ctx.deployedUrl ? new URL(ctx.deployedUrl).host : ctx.host;
  if (previousHost && previousHost !== (host || previousHost)) {
    console.log();
    warn(`This moves PageVault from ${c.bold(previousHost)} to ${c.bold(host)}.`);
    console.log(`  ${c.dim("Your documents carry across untouched — but every link you have already shared")}`);
    console.log(`  ${c.dim(`points at ${previousHost} and will stop resolving. Re-send the new ones after deploy:`)}`);
    console.log(`     ${c.bold("pagevault list")} ${c.dim("then")} ${c.bold("pagevault link <id>")}`);
  }

  // --- The token: WHERE it deploys -------------------------------------------
  //
  // The only cloud-touching part of setup, and it only READS — to pin the account now, so the
  // difference between "who you are" (the email above) and "where it deploys" (the account) is
  // concrete before anything is built. Its own labeled step, so the two never blur.

  let token = loadCloudToken();
  console.log();
  if (!token) {
    console.log(`${c.cyan("The token")} — this is ${c.bold("where")} PageVault deploys.\n`);
    const saved = await tokenSetupFlow();
    if (!saved) {
      console.log(`\n${c.bold("Next:")} save the token, then run ${c.bold(opts.next ?? runHint("setup", "init"))} again.\n`);
      return { ready: false };
    }
    token = loadCloudToken(); // pick up what we just wrote to .env.local
    console.log();
  }

  // A token handed in on the command line is persisted, so the commands AFTER init — deploy,
  // verify, destroy — do not each need it repeated. Same file the paste prompt writes, so both
  // routes leave the install in one state.
  if (argValue("--cf-token")) writeEnvLocalVar("CLOUDFLARE_API_TOKEN", token);

  // Say which credential is in play. `.env.local` and an exported CLOUDFLARE_API_TOKEN can hold
  // different tokens for different accounts, and the loser is silent — the operator finds out by
  // reading the account name below and, if it looks right, never finds out at all.
  info(`Token from ${c.bold(cloudTokenSource())}.`);

  const accounts = await cfAccounts();
  if (accounts.length === 0) {
    warn("The token is set, but Cloudflare returns no account for it — check the token and its scopes.");
    console.log(`\n${c.bold("Next:")} ${c.bold(opts.next ?? "make preflight")} ${c.dim("— fix the token, then re-run.")}\n`);
    return { ready: false };
  }

  // One account → pin and show it; there is no other option to confirm. Several → pick one, and
  // preflight will hold the deploy to it.
  let account;
  if (accounts.length === 1) {
    account = accounts[0];
  } else if (isInteractive()) {
    console.log(`The token reaches ${accounts.length} accounts:`);
    accounts.forEach((a, i) => console.log(`  ${c.bold(String(i + 1))}  ${acct(a)}`));
    const rl2 = createInterface({ input: stdin, output: stdout });
    const pick = (await rl2.question(`Which one? [1] `)).trim() || "1";
    rl2.close();
    account = accounts[Number(pick) - 1] ?? accounts[0];
  } else {
    account = accounts[0];
    warn(`Token reaches ${accounts.length} accounts; using the first. Pass --account to be explicit.`);
  }
  saveContext({ ...loadContext(), accountId: account.id, accountName: account.name });
  ok(`Deploys to: ${acct(account)}`);

  // The domain decision now lives in the Public prompt above (ADR-018 — a domain is an option
  // inside Public, asked with the account's zones suggested), so there is no post-pin upsell.

  return { ready: true };
}

// Standalone (`make setup` / `node …/setup.mjs`): run it, then print the ladder's next step. In
// the in-process init path, `pagevault init` calls setup() directly and drives its own guidance.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ready } = await setup();
  if (ready) console.log(`\n${c.bold("Next:")} ${c.bold("make preflight")}\n`);
}

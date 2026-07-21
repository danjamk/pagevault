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
import { c, ok, info, warn, die, loadContext, saveContext, resolve, isInteractive, loadCloudToken, cfApi, cfAccounts, acct, tokenSetupFlow, banner } from "./context.mjs";

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
    console.log(`\n${c.bold("The ladder")} — start low, climb anytime. This is not a one-way door;`);
    console.log(`your documents carry across every rung.\n`);
    console.log(`  ${c.bold("1")}  Publish    public links on *.workers.dev      ${c.dim("free · nothing to buy")}`);
    console.log(`  ${c.bold("2")}  + domain   the same, on your own hostname     ${c.dim("a domain in your CF account")}`);
    console.log(`  ${c.bold("3")}  Portals    client collections, email-secured  ${c.dim("a domain + Zero Trust (a card)")}`);
    console.log(`\n  ${c.dim("Most people start at 1. You can run this again to move up whenever you like.")}\n`);
  } else {
    info(`Current: rung ${c.bold(ctx.rung)}${ctx.host ? ` · ${ctx.host}` : ""}${ctx.ownerEmail ? ` · ${ctx.ownerEmail}` : ""}`);
    console.log(`  ${c.dim("Press enter to keep a value, or type a new one to change it.")}\n`);
  }

  const rl = createInterface({ input: stdin, output: stdout });

  // --- Resolve the intent (flag → env → current → prompt) --------------------

  const rung = Number(
    await resolve({
      flag: "--rung",
      ctxValue: ctx.rung,
      promptText: "Start at which rung? (1 publish · 2 domain · 3 portals)",
      rl,
      fallback: ctx.rung ?? 1,
    }),
  );
  if (![1, 2, 3].includes(rung)) die(`"${rung}" is not a rung. Choose 1, 2, or 3.`);

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

  let host = ctx.host ?? "";
  if (rung >= 2) {
    host = await resolve({
      flag: "--host",
      ctxValue: ctx.host,
      promptText: "Hostname to serve on (e.g. pagevault.you.com)",
      rl,
      fallback: ctx.host,
    });
    if (!host || !host.includes(".")) die("Rung 2+ needs a hostname, e.g. pagevault.you.com");
  } else if (host) {
    info(`Rung 1 ignores the saved host (${host}) — you'll publish on *.workers.dev.`);
  }

  rl.close();

  // --- Save ------------------------------------------------------------------

  saveContext({ ...ctx, rung, ownerEmail, host });
  ok(`Saved to ${c.bold(".pagevault.json")}`);

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
      console.log(`\n${c.bold("Next:")} save the token, then run ${c.bold(opts.next ?? "make setup")} again.\n`);
      return { ready: false };
    }
    token = loadCloudToken(); // pick up what we just wrote to .env.local
    console.log();
  }

  const accounts = await cfAccounts();
  if (accounts.length === 0) {
    warn("The token is set, but Cloudflare returns no account for it — check the token and its scopes.");
    console.log(`\n${c.bold("Next:")} ${c.bold("make preflight")} ${c.dim("— it names the exact problem.")}\n`);
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

  // --- Own a domain here? Offer the rung-2 bump ------------------------------
  //
  // Changing your mind about the rung is an INTENT decision, so it lives in setup — not in
  // preflight, whose one job is to verify the rung you chose. Rung 1 only; 2 and 3 already
  // picked a host.
  if (rung < 2 && isInteractive()) {
    const z = await cfApi("/zones?per_page=50");
    const zones = (z.ok ? z.result ?? [] : []).filter((x) => x.account?.id === account.id && x.status === "active");
    if (zones.length) {
      console.log();
      console.log(`You own ${zones.length === 1 ? "a domain" : "domains"} here: ${c.bold(zones.map((x) => x.name).join(", "))}`);
      const rl3 = createInterface({ input: stdin, output: stdout });
      const yes = (await rl3.question(`Publish on it instead of *.workers.dev? (rung 2) [y/N] `)).trim().toLowerCase();
      if (yes === "y" || yes === "yes") {
        const suggested = `pagevault.${zones[0].name}`;
        const h = (await rl3.question(`Hostname? [${suggested}] `)).trim() || suggested;
        rl3.close();
        saveContext({ ...loadContext(), rung: 2, host: h });
        ok(`Switched to rung 2 — ${c.bold(h)}`);
        console.log(`\n${c.bold("Next:")} ${c.bold(opts.next ?? "make preflight")}\n`);
        return { ready: false };
      }
      rl3.close();
    }
  }

  return { ready: true };
}

// Standalone (`make setup` / `node …/setup.mjs`): run it, then print the ladder's next step. In
// the in-process init path, `pagevault init` calls setup() directly and drives its own guidance.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ready } = await setup();
  if (ready) console.log(`\n${c.bold("Next:")} ${c.bold("make preflight")}\n`);
}

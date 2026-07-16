#!/usr/bin/env node
//
// make setup — decide what you want, written into .pagevault.json. Local only: no
// Cloudflare calls, no auth, nothing created. Re-run it anytime to change your mind or
// climb a rung — it shows your current choices and lets you edit them.
//
//   node scripts/setup.mjs
//   node scripts/setup.mjs --rung 1 --email you@example.com      # non-interactive
//   node scripts/setup.mjs --rung 2 --host pagevault.you.com
//
import { createInterface } from "node:readline/promises";
import { stdin, stdout, versions } from "node:process";
import { c, ok, info, warn, die, loadContext, saveContext, resolve, isInteractive } from "./context.mjs";

console.log(`\n${c.bold("PageVault — setup")} ${c.dim("(local; nothing is created)")}\n`);

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

console.log(`\n${c.bold("Next:")} ${c.bold("make preflight")} ${c.dim("— check your Cloudflare account is ready for rung " + rung + ".")}\n`);

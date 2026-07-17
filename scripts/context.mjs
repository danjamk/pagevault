//
// Shared context for the setup workflow.
//
// One gitignored file, `.pagevault.json`, holds the operator's intent and the state
// discovered while acting on it — the tier, the owner email, the host, the KV id. Every
// command (setup, preflight, deploy, verify, provision) reads it, so none of them re-asks
// what another already knows. Climbing the ladder is editing this file and redeploying.
//
// Zero dependencies beyond Node built-ins, on purpose — this is what a stranger runs.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export const CONTEXT_FILE = ".pagevault.json";

// Terminal styling. The muted tier is a real gray (90m), NOT the "dim" attribute (2m):
// many dark-mode terminals render 2m as near-invisible, which collapses a bold/normal/dim
// hierarchy into mush. So structure is carried by hue — cyan for headers and labels — and
// readability never leans on three shades of white. Kept moderate: no bright fills.
export const c = {
  dim: (s) => `\x1b[38;5;245m${s}\x1b[0m`, // a fixed mid-gray (256-color) — readable on dark
  bold: (s) => `\x1b[1m${s}\x1b[0m`, // one key value on a line
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`, // labels, in-progress →
  blue: (s) => `\x1b[36m${s}\x1b[0m`, // alias for existing callers
  head: (s) => `\x1b[1m\x1b[36m${s}\x1b[0m`, // bold cyan — the top line of a command
};

export const ok = (s) => console.log(`${c.green("✓")} ${s}`);
export const info = (s) => console.log(`${c.cyan("→")} ${s}`);
export const warn = (s) => console.log(`${c.yellow("!")} ${s}`);

/** First 8 chars of a Cloudflare id — enough to recognize, short enough to repeat. */
export const shortId = (id) => String(id ?? "").slice(0, 8);

/** A one-line account label: Name (shortid). The canonical way to name WHERE it deploys. */
export const acct = (a) => `${a.name} ${c.dim(`(${shortId(a.id)})`)}`;

export function die(message, hint) {
  console.error(`\n${c.red("✗")} ${message}`);
  if (hint) console.error(`\n${Array.isArray(hint) ? hint.join("\n") : hint}\n`);
  process.exit(1);
}

/** The context, or an empty object if there is none yet. */
export const loadContext = () =>
  existsSync(CONTEXT_FILE) ? JSON.parse(readFileSync(CONTEXT_FILE, "utf8")) : {};

export const saveContext = (ctx) =>
  writeFileSync(CONTEXT_FILE, `${JSON.stringify(ctx, null, 2)}\n`);

/**
 * Put a Cloudflare API token from .env.local (or the environment) where wrangler will see
 * it. Our own code reads .env.local, but the `wrangler` subprocesses we spawn only read the
 * real environment — so a token sitting in .env.local would be silently ignored, and
 * wrangler would fall back to its machine-wide login (the wrong account). Call this before
 * anything shells out to wrangler. Returns the token, or undefined.
 *
 * This is also the "multiple accounts on one machine" answer: each clone keeps its own
 * .env.local with its own account's token, and every command in that clone targets it.
 */
export function loadCloudToken() {
  // CLOUDFLARE_API_TOKEN only — no CF_API_TOKEN fallback. `CF_API_TOKEN` is now reserved for
  // the Worker's *runtime* secret (a separate, narrowly scoped token, #24); reading it here
  // would let that narrow token stand in for the broad provisioning credential and target
  // wrangler at the wrong scope. Using CLOUDFLARE_API_TOKEN also clears wrangler's deprecation
  // warning about CF_API_TOKEN (#23).
  const token = fromEnv("CLOUDFLARE_API_TOKEN");
  if (token) process.env.CLOUDFLARE_API_TOKEN = token; // what wrangler and cfApi both read
  return token;
}

/**
 * A Cloudflare API call with the loaded token. Read-only or not — the caller decides via
 * `init`. Never throws; returns { ok, status, result, errors }. The token is the auth model
 * now (a per-clone .env.local token, explicit — no ambient wrangler login to guess at).
 */
export async function cfApi(path, init = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return { ok: false, status: 0, result: null, errors: [{ code: 0, message: "no CF token loaded" }] };
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const body = await res.json().catch(() => null);
    return { ok: res.ok && Boolean(body?.success), status: res.status, result: body?.result, errors: body?.errors ?? [] };
  } catch (err) {
    return { ok: false, status: 0, result: null, errors: [{ code: 0, message: String(err) }] };
  }
}

/** The accounts this token can reach — [{ name, id }]. Empty if the token is bad or absent. */
export async function cfAccounts() {
  const r = await cfApi("/accounts");
  return r.ok ? (r.result ?? []).map((a) => ({ name: a.name, id: a.id })) : [];
}

/** Cloudflare's error list, flattened to a line. */
export const cfErr = (errors = []) => errors.map((e) => `[${e.code}] ${e.message}`).join("; ");

/** A Cloudflare-safe slug: lowercase, alphanumerics and single hyphens. */
export const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 54) || "pagevault";

/**
 * The full "create a Cloudflare API token" instructions. Shared by setup and preflight so
 * the link, the name, and the exact scopes live in ONE place — and match the README table.
 */
export function printTokenSetup() {
  const scopes = [
    ["Account", "Workers Scripts", "Edit", "rung 1 · deploy"],
    ["Account", "Workers KV Storage", "Edit", "rung 1 · documents"],
    ["Account", "Account Settings", "Read", "rung 1 · identify the account"],
    ["Zone", "Workers Routes", "Edit", "rung 2 · custom domain"],
    ["Zone", "DNS", "Edit", "rung 2 · custom-domain record"],
    ["Account", "Access: Apps and Policies", "Edit", "rung 3 · portals"],
    ["Account", "Access: Organizations, Identity Providers, and Groups", "Edit", "rung 3 · the viewer group lives here"],
  ];
  console.log(`  ${c.bold("Create a Cloudflare API token")} ${c.dim("— how PageVault reaches your account (one per clone)")}`);
  console.log();
  console.log(`  1. Open  ${c.bold("https://dash.cloudflare.com/profile/api-tokens")}  → Create Custom Token`);
  console.log(`  2. Name it  ${c.bold("pagevault")}`);
  console.log(`  3. Add these permissions ${c.dim("(grant all now, so climbing never means editing the token)")}:`);
  console.log();
  for (const [type, perm, access, forr] of scopes) {
    console.log(`       ${c.dim(type.padEnd(7))} ${c.bold(perm)} ${c.dim(`(${access})`)}  ${c.dim("— " + forr)}`);
  }
  console.log();
  console.log(`  4. Create it, copy the value, and save it ${c.dim("(gitignored)")}:`);
  console.log(`       ${c.bold("echo 'CLOUDFLARE_API_TOKEN=<paste>' > .env.local")}`);
}

/** Update-or-append `KEY=value` in .env.local, leaving any other lines intact. */
export function writeEnvLocalVar(key, value) {
  const path = ".env.local";
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "") : [];
  const kept = lines.filter((l) => !l.trim().startsWith(`${key}=`));
  kept.push(`${key}=${value}`);
  writeFileSync(path, `${kept.join("\n")}\n`);
}

/** Update-or-append CLOUDFLARE_API_TOKEN in .env.local, leaving any other lines intact. */
const writeEnvLocalToken = (token) => writeEnvLocalVar("CLOUDFLARE_API_TOKEN", token);

/**
 * Print the token instructions, then offer to take it right here: paste it and we write
 * .env.local, or press Enter to save it yourself (with the command). Returns true if a token
 * was written. Shared by setup and preflight so the "no token" moment is handled identically.
 */
export async function tokenSetupFlow() {
  printTokenSetup();
  if (!isInteractive()) return false;
  const rl = createInterface({ input: stdin, output: stdout });
  const pasted = (await rl.question(`\n  Paste your token to save it to .env.local now — or press Enter to save it yourself: `)).trim();
  rl.close();
  if (!pasted) {
    console.log(`  ${c.dim("Fine —")} ${c.bold("echo 'CLOUDFLARE_API_TOKEN=<paste>' > .env.local")}`);
    return false;
  }
  writeEnvLocalToken(pasted);
  console.log(`  ${c.green("✓")} Saved to .env.local.`);
  return true;
}

/** A value from the environment, or from gitignored .env.local. */
export function fromEnv(key) {
  if (process.env[key]) return process.env[key];
  if (!existsSync(".env.local")) return undefined;
  const line = readFileSync(".env.local", "utf8")
    .split("\n")
    .find((l) => l.trim().startsWith(`${key}=`));
  return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : undefined;
}

/** `--name value` or `--name=value` from argv. */
export function argValue(name) {
  const argv = process.argv;
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** True when we can actually prompt — a real terminal, and not asked to stay quiet. */
export const isInteractive = () => stdin.isTTY && !process.argv.includes("--yes");

/**
 * 🔴 WHO wrangler will act as — the signed-in email and the accounts it can reach.
 *
 * wrangler auth is ambient (a machine-wide login, or CLOUDFLARE_API_TOKEN). The single
 * worst failure in this workflow is deploying to an account you didn't mean to, because
 * "signed in" told you nothing about WHERE. Everything that mutates Cloudflare calls this
 * first, names the account, and refuses a mismatch. Returns { ok, email, accounts:[{name,id}] }.
 */
export function wranglerAccount() {
  let out;
  try {
    out = execSync("npx --yes wrangler@4 whoami", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err).split("\n")[0] };
  }
  const email = out.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0];
  const accounts = [];
  for (const line of out.split("\n")) {
    const m = line.match(/│\s*([^│]+?)\s*│\s*([0-9a-f]{32})\s*│/);
    if (m) accounts.push({ name: m[1].trim(), id: m[2] });
  }
  return { ok: true, email, accounts };
}

/**
 * Resolve one value by precedence: flag → env → context → prompt (if interactive) →
 * undefined. The precedence is the whole design: a person gets asked, an LLM or CI passes
 * flags and is never asked. Pass `rl` (a readline interface) to allow the prompt.
 */
export async function resolve({ flag, envKey, ctxValue, promptText, rl, fallback }) {
  let v = (flag && argValue(flag)) ?? (envKey && fromEnv(envKey)) ?? ctxValue;
  if ((v === undefined || v === "") && rl && isInteractive() && promptText) {
    const answer = (await rl.question(`  ${promptText}${fallback ? c.dim(` [${fallback}]`) : ""}: `)).trim();
    v = answer || fallback;
  }
  return v === undefined ? fallback : v;
}

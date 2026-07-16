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
import { stdin, stdout } from "node:process";

export const CONTEXT_FILE = ".pagevault.json";

export const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[36m${s}\x1b[0m`,
};

export const ok = (s) => console.log(`${c.green("✓")} ${s}`);
export const info = (s) => console.log(`${c.blue("→")} ${s}`);
export const warn = (s) => console.log(`${c.yellow("!")} ${s}`);

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

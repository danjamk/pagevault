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
import { fileURLToPath } from "node:url";

export const CONTEXT_FILE = ".pagevault.json";

// The absolute path to the prebuilt Worker bundle the npm package ships (ADR-014, #86). Resolved
// from THIS module's location, not the cwd, so it is correct whether run from the repo or an
// installed package — and absolute, because a generated config points `main` at it and wrangler
// resolves `main` relative to the config file's directory, not the cwd.
export const BUNDLE_PATH = fileURLToPath(new URL("../cli/dist/worker.js", import.meta.url));

/**
 * Switch a generated wrangler config to deploy the PREBUILT bundle: point `main` at the absolute
 * bundle path and turn `no_bundle` on, so wrangler uploads that file verbatim instead of
 * re-bundling `src`. The template ships `"main": "src/index.ts"` + `"no_bundle": false` (the repo /
 * `make deploy` / prod-CI path); this is applied only in bundle mode. Throws if the template's
 * `main`/`no_bundle` shape drifted, so a silent miss can't ship a Worker that bundles from a `src`
 * the installed package doesn't have.
 */
export function applyBundleMode(config, bundlePath) {
  const out = config
    .replace(/"main": "src\/index\.ts"/, `"main": "${bundlePath}"`)
    .replace(/"no_bundle": false/, '"no_bundle": true');
  if (!out.includes(`"main": "${bundlePath}"`) || !out.includes('"no_bundle": true')) {
    throw new Error("Failed to switch the config to bundle mode — did the template's main/no_bundle change?");
  }
  return out;
}

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

/** A command header with the product version: "PageVault — <verb>  v<x>  <note>". */
export const banner = (verb, note = "") =>
  `\n${c.head(`PageVault — ${verb}`)}  ${c.dim(`v${VERSION}`)}${note ? `  ${c.dim(note)}` : ""}\n`;

export function die(message, hint) {
  console.error(`\n${c.red("✗")} ${message}`);
  if (hint) console.error(`\n${Array.isArray(hint) ? hint.join("\n") : hint}\n`);
  process.exit(1);
}

// --- Versioning -------------------------------------------------------------
//
// Two versions, deliberately distinct. PRODUCT version (below) is the semver of the code you're
// running, read from package.json and surfaced to a human. SCHEMA_VERSION is the internal format
// version of .pagevault.json — plumbing, so migrations are ordered and deterministic instead of
// the ad-hoc patching we'd been doing.

/** The PageVault product version (semver), from package.json. Shown in command headers. */
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync("package.json", "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/**
 * The exact code a deploy is built from: `<version>+<shortsha>`, with `-dirty` when the tree has
 * uncommitted changes. This is the "build number" (ADR-010) — a commit pins a deployment to code
 * far more usefully than a counter. Baked into the Worker at deploy so it can report itself.
 * Falls back to the bare version outside a git checkout (e.g. a tarball).
 */
export function releaseTag() {
  try {
    const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() ? "-dirty" : "";
    return sha ? `${VERSION}+${sha}${dirty}` : VERSION;
  } catch {
    return VERSION;
  }
}

/** The current .pagevault.json schema version. Bump when the file's shape changes. */
export const SCHEMA_VERSION = 1;

/**
 * Ordered migrations for .pagevault.json. `MIGRATIONS[i]` migrates a v(i+1) file to v(i+2):
 * index 0 is v1 → v2, index 1 is v2 → v3, and so on. Empty at v1 — v1 IS the current shape.
 * Every future schema change lands here as one pure function, so an old operator's file upgrades
 * the same way every time.
 */
export const MIGRATIONS = [];

/**
 * Bring a context object up to `target` schema version by applying registered migrations in
 * order. A file with no `schemaVersion` is assumed v1 (its shape is v1 — see #39). A file NEWER
 * than the code fails loud rather than being silently mishandled — that means you're running an
 * older PageVault than the one that wrote the state. Pure; exported for testing with synthetic
 * migrations.
 */
export function migrate(ctx, migrations = MIGRATIONS, target = SCHEMA_VERSION) {
  let version = ctx.schemaVersion ?? 1;
  if (version > target) {
    throw new Error(
      `.pagevault.json is schema v${version}, but this PageVault understands only up to v${target} — ` +
        "you're running an older PageVault than the one that wrote this state.",
    );
  }
  let out = { ...ctx };
  while (version < target) {
    const step = migrations[version - 1]; // migrations[0] : v1 → v2
    if (typeof step !== "function") throw new Error(`No migration registered for schema v${version} → v${version + 1}.`);
    out = step(out);
    version += 1;
  }
  out.schemaVersion = target;
  return out;
}

/** The context — migrated to the current schema — or an empty object if there is none yet. */
export function loadContext() {
  if (!existsSync(CONTEXT_FILE)) return {};
  try {
    return migrate(JSON.parse(readFileSync(CONTEXT_FILE, "utf8")));
  } catch (err) {
    die(err.message, "`git pull` to update the code, or delete .pagevault.json and re-run `make setup`.");
  }
}

/** Persist the context, stamped with the current schema version. */
export const saveContext = (ctx) =>
  writeFileSync(CONTEXT_FILE, `${JSON.stringify({ ...ctx, schemaVersion: SCHEMA_VERSION }, null, 2)}\n`);

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
 * `init`. Never throws; returns { ok, status, result, result_info, errors }. `result_info`
 * carries the pagination cursor for list endpoints (e.g. KV keys). The token is the auth model
 * now (a per-clone .env.local token, explicit — no ambient wrangler login to guess at).
 */
export async function cfApi(path, init = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return { ok: false, status: 0, result: null, result_info: null, errors: [{ code: 0, message: "no CF token loaded" }] };
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const body = await res.json().catch(() => null);
    return {
      ok: res.ok && Boolean(body?.success),
      status: res.status,
      result: body?.result,
      result_info: body?.result_info ?? null,
      errors: body?.errors ?? [],
    };
  } catch (err) {
    return { ok: false, status: 0, result: null, result_info: null, errors: [{ code: 0, message: String(err) }] };
  }
}

/** The accounts this token can reach — [{ name, id }]. Empty if the token is bad or absent. */
export async function cfAccounts() {
  const r = await cfApi("/accounts");
  return r.ok ? (r.result ?? []).map((a) => ({ name: a.name, id: a.id })) : [];
}

/** Cloudflare's error list, flattened to a line. */
export const cfErr = (errors = []) => errors.map((e) => `[${e.code}] ${e.message}`).join("; ");

// --- MCP smoke helpers ------------------------------------------------------
//
// `verify` and `health` both drive the live `/mcp` endpoint, so the one JSON-RPC
// caller lives here. The MCP server is the reason the project exists (ADR-006) — a
// deploy that serves docs but not `/mcp` is broken, and nothing used to catch that.

/** The tools `/mcp` must expose. A missing one means a registration regression (#75). */
export const EXPECTED_MCP_TOOLS = [
  "publish_document",
  "read_document",
  "list_documents",
  "list_portals",
  "search_portal",
  "create_portal",
  "update_portal_members",
  "mint_public_link",
  "revoke_document",
];

/**
 * Streamable HTTP answers a POST as either a single JSON body or an SSE stream of
 * `data:` frames (the transport's choice). Read whichever we got and return the
 * JSON-RPC message carrying a `result`/`error`.
 */
function parseJsonRpc(text) {
  const t = (text ?? "").trim();
  if (!t) return null;
  if (t.startsWith("{")) {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }
  for (const line of t.split("\n").reverse()) {
    const m = line.match(/^data:\s*(.*)$/);
    if (!m) continue;
    try {
      const o = JSON.parse(m[1]);
      if (o && (o.result !== undefined || o.error !== undefined)) return o;
    } catch {
      /* not this frame */
    }
  }
  return null;
}

/**
 * One JSON-RPC call to the remote MCP server over the bearer. Never throws;
 * returns { ok, status, result, error }. `ok` is true only on a 2xx that carried a
 * `result` and no JSON-RPC `error`. The server is stateless (ADR-006), so each call
 * stands alone — no session id to thread.
 */
export async function mcpCall(base, bearer, method, params = {}, id = 1) {
  try {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const msg = parseJsonRpc(await res.text());
    return { ok: res.ok && Boolean(msg) && msg.error === undefined, status: res.status, result: msg?.result, error: msg?.error };
  } catch (err) {
    return { ok: false, status: 0, result: undefined, error: { message: String(err) } };
  }
}

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
 * Decide how a deploy should obtain the PAGEVAULT_API_TOKEN bearer, given what the Worker already
 * has and what the environment provides. Pure, so the policy is tested without a live deploy.
 *
 *   skip     — the Worker already has it. Never rotate a live bearer: it would break every CLI and
 *              MCP client mid-flight. This beats everything else, including a provided value.
 *   set      — nothing on the Worker, but a value was provided (a GitHub Environment secret in CI,
 *              or .env.local locally). Set THAT exact value, so the operator's clients keep working.
 *   generate — nothing on the Worker, nothing provided, and we can prompt: mint one and save it.
 *   fail     — nothing on the Worker, nothing provided, and non-interactive (CI). Refuse, rather than
 *              mint a throwaway prod bearer that lives only on a runner that is about to disappear.
 */
export function chooseBearer({ hasSecret, provided, interactive }) {
  if (hasSecret) return { action: "skip" };
  if (provided) return { action: "set", value: provided };
  if (interactive) return { action: "generate" };
  return { action: "fail" };
}

/**
 * Resolve one value. A flag or env var is authoritative and never prompts — that is the
 * whole design: an LLM or CI passes flags and is never asked. Otherwise, an interactive run
 * PROMPTS, defaulting to the saved context value (enter keeps, type changes). That default is
 * what makes a re-run an EDIT rather than a silent replay of `.pagevault.json` — without it,
 * you could never change a value once saved (e.g. climb rung 2 → 3). Non-interactive with no
 * flag falls back to context, then `fallback`. Pass `rl` to allow the prompt.
 */
export async function resolve({ flag, envKey, ctxValue, promptText, rl, fallback }) {
  const forced = (flag && argValue(flag)) ?? (envKey && fromEnv(envKey));
  if (forced === undefined && rl && isInteractive() && promptText) {
    const def = ctxValue ?? fallback;
    const shown = def !== undefined && def !== "" ? c.dim(` [${def}]`) : "";
    const answer = (await rl.question(`  ${promptText}${shown}: `)).trim();
    return answer || def;
  }
  return forced ?? ctxValue ?? fallback;
}

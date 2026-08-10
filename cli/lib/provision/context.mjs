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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { locateMarker, readEnvVar } from "../target.mjs";

export const CONTEXT_FILE = ".pagevault.json";

// Where operator state lives — `.pagevault.json`, `.env.local`, the generated wrangler config.
//
// From the repo (running the source tree) that's the cwd, exactly as it has always been, so
// `make deploy`, `make setup`, and prod CI are byte-for-byte unchanged. From an installed npm
// package (ADR-014, #86) there is no repo cwd, so state lives in `~/.pagevault/`. `PAGEVAULT_HOME`
// overrides both (tests; an operator who wants state elsewhere).
//
// "Installed" = this module lives under node_modules. That signal survives the later move of these
// scripts into the package (#87) and is never true when running from source — so no existing user's
// repo-root state is stranded, and no migration is needed: a clone keeps using its cwd files.
export const RUNNING_FROM_REPO = !fileURLToPath(import.meta.url).includes(`${sep}node_modules${sep}`);

/**
 * Show the right incantation for the reader's install (ADR-014): `make <makeCmd>` from a repo
 * checkout, `pagevault <cliCmd>` from an installed package. So a message never tells an installed
 * user to run a `make` target they don't have. Mirrors the switch in `destroy.mjs`/`verify.mjs`.
 */
export const runHint = (makeCmd, cliCmd) => (RUNNING_FROM_REPO ? `make ${makeCmd}` : `pagevault ${cliCmd}`);

/**
 * How to restore `file`, in the form the operator can actually type.
 *
 * Its own function rather than `runHint` because the two forms differ in more than the leading
 * word: `make` passes the file as `FILE=…`, the CLI takes it positionally. A `runHint("restore
 * FILE=x", "restore x")` call would work and would also hide that asymmetry in an argument list,
 * which is roughly how the bug this fixes got written.
 *
 * `fromRepo` is injectable so the rule can be tested without a second module loaded from a
 * different path — the live caller shells out to Cloudflare and cannot be exercised directly.
 */
export const restoreHint = (file, fromRepo = RUNNING_FROM_REPO) =>
  fromRepo ? `make restore FILE=${file}` : `pagevault restore ${file}`;

/**
 * The directory holding operator state. See the note above.
 *
 * 🔴 It follows the marker (#155). ADR-021 phase 2 gave every operator command one rule for which
 * URL it targets and left this reading `~/.pagevault` regardless of where the operator stood — so
 * half the answer moved and half did not. `verify` took the URL from a checkout's `.pagevault.json`
 * and the bearer from `~/.pagevault/config.json`, and sent PRODUCTION's token to the test
 * deployment. A 401 was the lucky outcome.
 *
 * Resolving the state dir from the same marker that resolved the URL means `.env.local`,
 * `.pagevault.json` and the bearer all describe one deployment.
 *
 * `PAGEVAULT_HOME` still wins outright: it is what isolates the test suites, which run from the
 * repo root while pointing HOME and PAGEVAULT_HOME at a temp dir. If ascent could beat it, the e2e
 * suite would find the real checkout's state and drive a live deployment.
 */
export function stateDir() {
  if (process.env.PAGEVAULT_HOME) return process.env.PAGEVAULT_HOME;
  const marker = locateMarker();
  if (marker) return dirname(marker);
  // Nothing provisioned yet — where `init` will write. Unchanged.
  return RUNNING_FROM_REPO ? process.cwd() : join(homedir(), ".pagevault");
}

/** A path inside the state dir. Creates the dir when it isn't the cwd (which always exists). */
export function statePath(name) {
  const dir = stateDir();
  if (dir !== process.cwd()) mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

/**
 * Where the generated wrangler config is written and deployed from. In the repo it stays
 * `worker/wrangler.generated.jsonc` (gitignored, as today); installed, it lives in the state dir
 * — there is no `worker/` tree to write into.
 */
export function generatedConfigPath() {
  return RUNNING_FROM_REPO ? "worker/wrangler.generated.jsonc" : statePath("wrangler.generated.jsonc");
}

/**
 * The wrangler template the generated config is built from. In the repo it's the committed
 * `worker/wrangler.jsonc` (what tests and `make deploy` read). Installed, there is no `worker/`
 * tree, so it's the copy shipped in the package — built into `cli/dist/` at pack time by
 * `scripts/build-bundle.mjs`, resolved package-relative from this module.
 */
export function templatePath() {
  return RUNNING_FROM_REPO ? "worker/wrangler.jsonc" : fileURLToPath(new URL("../../dist/wrangler.template.jsonc", import.meta.url));
}

// The absolute path to the prebuilt Worker bundle the npm package ships (ADR-014, #86). Resolved
// from THIS module's location, not the cwd, so it is correct whether run from the repo or an
// installed package — and absolute, because a generated config points `main` at it and wrangler
// resolves `main` relative to the config file's directory, not the cwd.
export const BUNDLE_PATH = fileURLToPath(new URL("../../dist/worker.js", import.meta.url));

/**
 * Switch a generated wrangler config to deploy the PREBUILT bundle: point `main` at the absolute
 * bundle path and turn `no_bundle` on, so wrangler uploads that file verbatim instead of
 * re-bundling `src`. The template ships `"main": "src/index.ts"` + `"no_bundle": false` (the repo /
 * `make deploy` / prod-CI path); this is applied only in bundle mode. Throws if the template's
 * `main`/`no_bundle` shape drifted, so a silent miss can't ship a Worker that bundles from a `src`
 * the installed package doesn't have.
 */
export function applyBundleMode(config, bundlePath) {
  // JSON.stringify, not raw interpolation. The path is ABSOLUTE, so on Windows it is
  // `C:\Users\…\npm\node_modules\pagevault\dist\worker.js` — and spliced into JSON raw, `\U` is an
  // invalid escape and `\n` is a newline. The generated config then fails to parse and `init` dies
  // naming neither Windows nor the path. That is every Windows install, not an edge case.
  // stringify emits the surrounding quotes too, so this replaces `"main": "…"` whole.
  //
  // The replacements are FUNCTIONS because String.replace interprets `$&`/`$'`/`$1` in a string
  // replacement — a `$` in a path would otherwise be silently rewritten.
  const main = `"main": ${JSON.stringify(bundlePath)}`;
  const out = config
    .replace(/"main": "src\/index\.ts"/, () => main)
    .replace(/"no_bundle": false/, () => '"no_bundle": true');
  if (!out.includes(main) || !out.includes('"no_bundle": true')) {
    throw new Error("Failed to switch the config to bundle mode — did the template's main/no_bundle change?");
  }
  return out;
}

// Terminal styling. The muted tier is a real gray (90m), NOT the "dim" attribute (2m):
// many dark-mode terminals render 2m as near-invisible, which collapses a bold/normal/dim
// hierarchy into mush. So structure is carried by hue — cyan for headers and labels — and
// readability never leans on three shades of white. Kept moderate: no bright fills.
/**
 * Should we emit ANSI at all? Pure, so it can be tested without faking a terminal.
 *
 * Precedence: FORCE_COLOR (keep color through a pager or a CI that renders it) → NO_COLOR (the
 * informal cross-tool standard: set to ANYTHING, including empty, means off) → is a human watching.
 *
 * "A human watching" is EITHER stream being a TTY, not just stdout. The CLI splits its channels —
 * `publish` prints the URL to stdout and everything human to stderr, so `pagevault publish r.html |
 * pbcopy` is a documented flow where stdout is a pipe and the person is still reading stderr.
 * Keying on stdout alone would drain the color out of exactly that session.
 *
 * The payoff is wider than Windows: clean CI logs, clean `> file`, and no escape-sequence litter in
 * legacy conhost, which prints raw ANSI as garbage instead of interpreting it.
 */
export function shouldUseColor({ env = process.env, stdoutTTY = false, stderrTTY = false } = {}) {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return env.FORCE_COLOR !== "0";
  if (env.NO_COLOR !== undefined) return false;
  return Boolean(stdoutTTY || stderrTTY);
}

const USE_COLOR = shouldUseColor({
  env: process.env,
  stdoutTTY: process.stdout?.isTTY,
  stderrTTY: process.stderr?.isTTY,
});

// Wrap in an escape only when color is on; otherwise hand back the text untouched. The GLYPHS
// (✓ → ! ✗) are deliberately NOT stripped here — they carry meaning, they are valid UTF-8, and
// modern Windows Terminal renders them correctly. If legacy conhost turns out to mangle them,
// that is a separate call made on evidence, not a guess.
const paint = (codes) => (s) => (USE_COLOR ? `\x1b[${codes}m${s}\x1b[0m` : String(s));

export const c = {
  dim: paint("38;5;245"), // a fixed mid-gray (256-color) — readable on dark
  bold: paint("1"), // one key value on a line
  green: paint("32"),
  red: paint("31"),
  yellow: paint("33"),
  cyan: paint("36"), // labels, in-progress →
  blue: paint("36"), // alias for existing callers
  head: paint("1;36"), // bold cyan — the top line of a command
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

/** The PageVault product version (semver). Shown in command headers, baked into the deploy. */
export const VERSION = (() => {
  try {
    // Repo: the root package.json, resolved from THIS MODULE rather than from cwd. It used to be a
    // bare `readFileSync("package.json")`, which assumed cwd was the repo root — true when every
    // invocation came from `make` at the top level, false the moment you run from `worker/` or
    // `cli/`, where it silently fell through to "0.0.0". `health` then asserts `0.0.0+<sha>`
    // against the deployment and fails for a reason that has nothing to do with the deployment.
    // ADR-021 makes running from a subdirectory normal, so this cannot stay cwd-relative.
    //
    // Installed: there is no root package.json, so read the version stamped into the shipped bundle
    // dir by build-bundle.mjs at pack time — the product version, not the npm package's own (#87).
    if (RUNNING_FROM_REPO) {
      return JSON.parse(readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8")).version ?? "0.0.0";
    }
    return readFileSync(fileURLToPath(new URL("../../dist/version.txt", import.meta.url)), "utf8").trim() || "0.0.0";
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
  const file = statePath(CONTEXT_FILE);
  if (!existsSync(file)) return {};
  try {
    return migrate(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    die(
      err.message,
      RUNNING_FROM_REPO
        ? "`git pull` to update the code, or delete .pagevault.json and re-run `make setup`."
        : "`npm update -g pagevault` to update, then re-run `pagevault init`.",
    );
  }
}

/** Persist the context, stamped with the current schema version. */
export const saveContext = (ctx) =>
  writeFileSync(statePath(CONTEXT_FILE), `${JSON.stringify({ ...ctx, schemaVersion: SCHEMA_VERSION }, null, 2)}\n`);

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
// Where `loadCloudToken` found the provisioning credential, for the line that reports it. An
// operator with an exported CLOUDFLARE_API_TOKEN and a stale `.env.local` is otherwise guessing
// which account they are about to deploy to.
let cloudTokenOrigin;
export const cloudTokenSource = () => cloudTokenOrigin;

export function loadCloudToken() {
  // CLOUDFLARE_API_TOKEN only — no CF_API_TOKEN fallback. `CF_API_TOKEN` is now reserved for
  // the Worker's *runtime* secret (a separate, narrowly scoped token, #24); reading it here
  // would let that narrow token stand in for the broad provisioning credential and target
  // wrangler at the wrong scope. Using CLOUDFLARE_API_TOKEN also clears wrangler's deprecation
  // warning about CF_API_TOKEN (#23).
  //
  // `--cf-token`, not `--token`: `pagevault login --token` already means the PageVault BEARER.
  // One flag name for two different credentials on adjacent commands is how a broad provisioning
  // token ends up saved in a login config.
  const flag = argValue("--cf-token");
  const shell = process.env.CLOUDFLARE_API_TOKEN;
  const file = fromEnvFile("CLOUDFLARE_API_TOKEN");
  const token = flag || shell || file;

  // Resolve the origin on the FIRST call that finds something — the same call that exports it
  // below. Ask again afterwards and the answer is always "the environment", because we put it
  // there. `??=` keeps a fruitless early call from pinning `undefined` forever.
  if (token) cloudTokenOrigin ??= flag ? "--cf-token" : shell ? "the environment" : displayPath(envLocalPath());

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

/**
 * Why a command that needs YOUR Cloudflare credential cannot run here, and what to do instead.
 *
 * 🔴 Deliberately does NOT say "run init". `backup` and `restore` are operator commands an installed
 * operator can reach (#133), and an operator whose production is deployed by CI has a login and no
 * build record — `init` there would provision production from their laptop. That is #144 exactly,
 * one command over, and it was still the advice these two printed (#167).
 *
 * Both situations are named because the message cannot tell them apart and guessing wrong is the
 * failure being fixed. The escape hatch comes first; `init` appears only as the thing not to do.
 */
export const cloudCredentialHint = (what, scope) => [
  `  ${what} talks to Cloudflare directly, not through your deployment — KV key metadata is what`,
  "  listings render from, and no PageVault endpoint exposes it. So the deployment bearer is not",
  "  enough here, by design.",
  "",
  `  ${c.bold("If this machine provisioned the deployment")} — its token is missing. Put it in the`,
  `  environment as ${c.bold("CLOUDFLARE_API_TOKEN")}, or re-run \`${runHint("setup", "init")}\`, which captures one.`,
  "",
  `  ${c.bold("If it did not")} — production deployed by CI, or from another machine — run this there`,
  `  instead. ${c.bold("Do not run init here:")} it would provision this deployment from this machine.`,
  "",
  `  ${c.dim(`Token scope: ${scope}`)}`,
];

// --- Zones ------------------------------------------------------------------

/**
 * 🔴 The Cloudflare zone that serves `host`, chosen from the zones that actually exist.
 *
 * This used to be `host.split(".").slice(-2).join(".")` — take the last two labels and call that the
 * domain. That is not what a domain is. `pv.acme.co.uk` derives `co.uk`, no zone by that name is
 * found, and provisioning dies with "No Cloudflare zone found for co.uk" on a setup that is
 * perfectly valid. Everyone on `.co.uk`, `.com.au`, `.co.nz`, `.co.jp` — and every other multi-label
 * TLD — hit it, and the error named a domain they had never typed (#138).
 *
 * There is no rule that recovers the registrable domain from a hostname; the public suffix list is
 * data, not an algorithm, and shipping a copy of it to answer one question would be absurd. So stop
 * deriving and start matching: the account's own zone list is the authority on where its zones split,
 * and it is one API call we can afford.
 *
 * **Longest match wins**, which matters in the one case where two candidates are both real: an
 * account holding both `acme.co.uk` and a delegated `eu.acme.co.uk` should serve `pv.eu.acme.co.uk`
 * from the more specific of the two. A host that IS a zone matches itself.
 *
 * Pure, so the rule is testable without an account — which is the half that was wrong.
 */
export function pickZone(zones, host) {
  const h = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!h) return null;
  const matches = (zones ?? []).filter((z) => {
    const n = String(z?.name ?? "").trim().toLowerCase();
    return n !== "" && (h === n || h.endsWith(`.${n}`));
  });
  // Ties are impossible — two zones cannot share a name — so length alone is a total order here.
  return matches.sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}

/**
 * Every zone this token can see, across pages.
 *
 * Deliberately NOT filtered to the pinned account. `preflight` reports "that domain is in a
 * different account" as its own distinct failure, and a filtered list could only ever say "not
 * found" — which sends an operator looking for a zone that is sitting right there. Callers that
 * want one account's zones filter the result themselves.
 *
 * Cloudflare caps `per_page` at 50 here. The page cap is a runaway guard, not a real limit: 500
 * zones on the account a single operator provisions PageVault from is not a case worth paging for.
 *
 * `api` is injectable so the paging and the `null`-vs-`[]` distinction can be tested without a
 * Cloudflare account — the same pattern `readEnvVar` and `restoreHint` use.
 */
export async function listZones({ maxPages = 10, api = cfApi } = {}) {
  const zones = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await api(`/zones?per_page=50&page=${page}`);
    if (!r.ok) return page === 1 ? null : zones; // null = could not ask, which is not "none exist"
    zones.push(...(r.result ?? []));
    if (page >= (r.result_info?.total_pages ?? 1)) break;
  }
  return zones;
}

// --- What the deployment actually has ---------------------------------------

/** The Worker script name. Fixed by the committed wrangler.jsonc; the API paths are built from it. */
export const WORKER_NAME = "pagevault";

/**
 * The bindings the DEPLOYED Worker currently has, by name — or `null` when we could not find out.
 *
 * 🔴 The three-valued return is the whole point. `.pagevault.json` is *declared intent* and it can
 * be stale, partial, or reconstructed from a CI secret written months ago; this is what the running
 * Worker is actually holding. Where they disagree, a re-deploy is about to resolve the disagreement
 * one way or the other, and it should not do that silently (#187).
 *
 * `null` means unknown, and unknown must never block a deploy. It is what you get from a first-ever
 * deploy (no script yet — 404), from a token that can deploy but not read script settings, and from
 * a network blip. Treating any of those as "the deployment has nothing" would strip capabilities on
 * a bad connection, which is a worse bug than the one this exists to catch.
 */
export async function deployedBindings(accountId) {
  if (!accountId) return null;
  const r = await cfApi(`/accounts/${accountId}/workers/scripts/${WORKER_NAME}/settings`);
  if (!r.ok) return null;
  const bindings = r.result?.bindings;
  return Array.isArray(bindings) ? bindings.map((b) => b.name) : null;
}

/**
 * View tracking as the operator asked for it on THIS run — `true`, `false`, or undefined for
 * "didn't say". Flags first, then the environment.
 *
 * `--analytics` / `--no-analytics` are the repo spellings; `--analytics off` works too because
 * `parseArgs` takes the next token as a value. `PAGEVAULT_ANALYTICS` is the one that matters for a
 * CI-deployed production, where there is no interactive prompt to answer and hand-editing a base64
 * secret was previously the only way to change the answer (#187).
 *
 * An unrecognised value is fatal rather than ignored. `PAGEVAULT_ANALYTICS=yes-please` silently
 * meaning "didn't say" is the same failure this whole issue is about: a setting that reads as
 * applied and isn't.
 */
export function analyticsChoice(flags = {}, env = process.env) {
  const word = (v) => String(v).trim().toLowerCase();
  const ON = ["on", "true", "1", "yes"];
  const OFF = ["off", "false", "0", "no"];

  if (flags["no-analytics"] === true) return false;
  if (flags.analytics === true) return true;
  if (typeof flags.analytics === "string") {
    if (ON.includes(word(flags.analytics))) return true;
    if (OFF.includes(word(flags.analytics))) return false;
    die(`Unrecognised --analytics value: ${flags.analytics}`, `Use ${c.bold("--analytics")} or ${c.bold("--no-analytics")} (or on/off).`);
  }

  const raw = env.PAGEVAULT_ANALYTICS;
  if (raw === undefined || word(raw) === "") return undefined;
  if (ON.includes(word(raw))) return true;
  if (OFF.includes(word(raw))) return false;
  die(`Unrecognised PAGEVAULT_ANALYTICS value: ${raw}`, "Use on or off. Unset it to leave view tracking as the deployment has it.");
}

/**
 * Which way view tracking resolves on this run, where that came from, and whether it is a downgrade.
 *
 * Pure, and separated from the provisioning it drives so both directions of the transition can be
 * tested without a Cloudflare account (#187).
 *
 * Lives here rather than in provision.mjs because rung 1–2 needs it too (#190), and the minimal
 * config writer should not have to import the interactive rung-3 provisioner to answer one
 * question. Sits next to `analyticsChoice`, which feeds its `flag`.
 *
 * @param {object} a
 * @param {boolean|undefined} a.flag      what the operator asked for on THIS run (--analytics, PAGEVAULT_ANALYTICS)
 * @param {boolean|undefined} a.declared  what `.pagevault.json` records
 * @param {boolean|null|undefined} a.live whether the deployed Worker binds ANALYTICS; null = unknown
 *
 * 🔴 `live` sits in the precedence chain, not merely in an assertion. That is the actual fix. The
 * bug was a re-deploy re-deciding an optional capability from silence every time, and no amount of
 * shouting about it later helps a schedule nobody is watching — whereas a deployment that already
 * answered the question keeps its answer for free, including in CI, without anyone editing a secret.
 *
 * The refusal is then only for a genuine contradiction: something here says off while the Worker
 * says on. That case cannot be resolved by guessing, so it stops. Note `value === undefined` implies
 * `live` was unknown — with a live reading there is always an answer — which is why the caller's
 * prompt-or-default can never itself become a downgrade.
 */
export function resolveAnalytics({ flag, declared, live }) {
  const known = live === true || live === false ? live : undefined;
  const value = flag ?? declared ?? known;
  const source =
    flag !== undefined ? "flag" : declared !== undefined ? "declared" : known !== undefined ? "live" : "unset";
  // Off is allowed to happen on purpose and no other way. `flag !== false` is the override: saying
  // it out loud on this run is what distinguishes "stop recording" from "never mentioned it".
  const downgrade = live === true && value === false && flag !== false;
  return { value, source, downgrade };
}

/**
 * What a resolved view-tracking answer contributes to `.pagevault.json` — a patch, spread into the
 * record, and usually empty.
 *
 * 🔴 The distinction is between an ANSWER and a SILENCE, and only rungs 1–2 have to draw it. Rung 3
 * interviews the operator, so every resolution there is an answer and `provision.mjs` saves
 * unconditionally. Rungs 1–2 have no interview: nothing-said means off, and writing THAT down turns
 * a default into `declared`, which outranks rung 3's interview forever — so an operator who never
 * thought about view tracking at rung 1 would climb to Secured and never be asked.
 *
 * That reasoning is right for the default and was wrong for the flag (#194). `--no-analytics` is not
 * silence; it is the operator saying it out loud, and honouring it for one deploy and forgetting it
 * by the next is the same shape of bug as #187 — a setting that reads as applied and isn't.
 *
 * `PAGEVAULT_ANALYTICS` counts, because `analyticsChoice` folds it into the same `flag` and rung 3
 * has always persisted it on that footing. A second rule about which explicit signals stick would be
 * a second asymmetry to explain, for a variable whose only real caller is CI — where the workspace
 * is thrown away and nothing persists anyway.
 */
export const analyticsPatch = (value, source) => (source === "flag" ? { analytics: value } : {});

/**
 * The template's view-tracking block, and the one function that removes it.
 *
 * 🔴 Shared by rung 1–2 (`tier0.mjs`) and rung 3 (`provision.mjs`) on purpose. Rung 3 stripped the
 * block and rung 1–2 never did, which is #190 — every rung 1–2 deploy bound ANALYTICS whether or not
 * the account had Analytics Engine, and wrangler refuses the whole deploy with error 10089 when the
 * binding is present and the product is off. Two copies of this regex is how that gap reappears, so
 * there is one, and `bindsAnalytics` is how both callers assert they got what they asked for.
 */
// 🔴 `\r?\n`, not `\n`. Windows checks out CRLF, and this is anchored on newlines — with `\n` alone
// the trailing `],` never matched, the block was silently left in place, and the caller's assertion
// turned that into "Failed to strip the Analytics Engine binding". Rung 3 with view tracking off was
// broken on Windows and nothing exercised it; the Windows CI job caught it the first time a test
// touched this function. The capture group is what keeps the surrounding line endings consistent.
const ANALYTICS_BLOCK =
  /(\r?\n) *\/\/ View tracking \(#91\)[\s\S]*?"analytics_engine_datasets": \[[\s\S]*?\r?\n *\],\r?\n/;

export const stripAnalyticsBinding = (config) => config.replace(ANALYTICS_BLOCK, "$1");

export const bindsAnalytics = (config) => config.includes("analytics_engine_datasets");

/** Where an operator turns Analytics Engine on. There is no API for it — it is a dashboard action. */
export const analyticsDashboard = (accountId) =>
  `https://dash.cloudflare.com/${accountId ?? ""}/workers/analytics-engine`;

/**
 * Where a resolved view-tracking answer came from, in words.
 *
 * Every rung says this out loud. `off` printed with no provenance is what made the #187 production
 * incident invisible: it read as a decision, and it was a silence.
 */
export const analyticsBecause = (source) =>
  ({
    flag: "you asked for it on this run",
    declared: `declared in ${CONTEXT_FILE}`,
    live: "the deployed Worker already has it",
    answer: "you just answered",
    default: "nothing asked for it, and there is no deployment to ask",
  })[source];

/**
 * Refuse a deploy that would drop view tracking the live Worker has (ADR-024).
 *
 * Shared by every rung. The refusal is the load-bearing half of #187 — dropping the binding is
 * silent and one-way, so the one case that cannot be resolved by guessing has to stop rather than
 * pick. Both commands named below reach every rung, so this needs no rung awareness.
 */
export function refuseAnalyticsDowngrade(source) {
  die("This deploy would turn view tracking OFF, and the live Worker currently has it on.", [
    source === "declared"
      ? `  ${CONTEXT_FILE} says off; the deployed Worker binds ANALYTICS. They disagree.`
      : `  Nothing here asked for view tracking; the deployed Worker binds ANALYTICS.`,
    "",
    "  Dropping it is silent and one-way. The Worker stops recording, no error is raised, and the",
    "  days between now and whenever someone notices are simply never in the data. Analytics Engine",
    "  keeps ~90 days, so there is nothing to backfill from either.",
    "",
    "  Say which you mean:",
    `    ${c.bold(runHint("deploy ANALYTICS=on", "upgrade --analytics"))}     keep recording`,
    `    ${c.bold(runHint("deploy ANALYTICS=off", "upgrade --no-analytics"))}    stop recording, deliberately`,
  ]);
}

// --- MCP smoke helpers ------------------------------------------------------
//
// `verify` and `health` both drive the live `/mcp` endpoint, so the one JSON-RPC
// caller lives here. The MCP server is the reason the project exists (ADR-006) — a
// deploy that serves docs but not `/mcp` is broken, and nothing used to catch that.

/**
 * The tools `/mcp` must expose. A missing one means a registration regression (#75).
 *
 * This must list EVERY tool `worker/src/mcp.ts` registers. It drifted to nine while the Worker
 * served twelve, which meant `verify` reported a healthy MCP surface with `revoke_public_link`,
 * `rotate_public_link` and `server_info` absent — a check that cannot fail is worse than no check,
 * because it is believed. `cli/mcp-tools.test.mjs` now pins the two lists together.
 */
export const EXPECTED_MCP_TOOLS = [
  "publish_document",
  "read_document",
  "list_documents",
  "list_portals",
  "search_portal",
  "create_portal",
  "update_portal_members",
  "mint_public_link",
  "pin_documents",
  "revoke_public_link",
  "rotate_public_link",
  "revoke_document",
  "edit_document",
  "traffic",
  "server_info",
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

/** The one `.env.local` this run reads and writes. Absolute, and it follows the state dir. */
export const envLocalPath = () => statePath(".env.local");

/**
 * A path as it is worth TYPING: bare when the file is IN the cwd, absolute otherwise.
 *
 * From a repo checkout the state dir is the cwd, so this keeps printing the `.env.local` that
 * `make setup` has always shown. Everywhere else it prints the whole path, which is the #157 fix:
 * a relative path is an instruction to write the file wherever the operator happens to be standing,
 * and that is not where the loader reads.
 *
 * "In the cwd", not "under the cwd" — an operator sitting in `~` would otherwise be handed
 * `.pagevault/.env.local`, which is correct only until they cd. The bug was a relative path that
 * quietly meant somewhere else; the narrow rule cannot reintroduce it.
 */
export const displayPath = (abs, cwd = process.cwd()) => (dirname(abs) === cwd ? relative(cwd, abs) : abs);

/**
 * The shell command that saves the token, in the dialect the operator is actually typing into.
 *
 * 🔴 `>` is not portable here. Windows PowerShell 5.1 — still the default shell on a stock Windows
 * box — redirects as UTF-16LE, and `readFileSync(path, "utf8")` cannot parse the result, so the
 * token is written and then silently unreadable. PowerShell 7 redirects as UTF-8 and would be fine;
 * we cannot tell which one is running, so we emit `Set-Content -Encoding ascii`, which is correct
 * in both. A Cloudflare token is ASCII, so nothing is lost. (`utf8` is not the answer: on 5.1 it
 * means UTF-8 *with* a BOM.)
 */
export function saveTokenCommand(path, platform = process.platform) {
  const line = "CLOUDFLARE_API_TOKEN=<paste>";
  return platform === "win32"
    ? `Set-Content '${path}' '${line}' -Encoding ascii`
    : `echo '${line}' > '${path}'`;
}

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
    // 🔴 Not optional in practice. Without it `views --live` and `sync-views` fail with a bare
    // Cloudflare 403, and every operator who followed this list built a token that cannot read
    // their own view history — discovered weeks later, by which point Analytics Engine's ~90-day
    // window has been quietly expiring the whole time (#167).
    ["Account", "Account Analytics", "Read", "any rung · pagevault views, sync-views"],
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
  // The absolute path, because the operator is standing wherever they are standing and this file
  // lives in the state dir. `statePath` creates that dir on the way past, so the command below
  // cannot fail on a directory that does not exist yet.
  const env = envLocalPath();
  console.log(`  4. Create it, copy the value, and save it ${c.dim("(gitignored)")}:`);
  console.log(`       ${c.bold(saveTokenCommand(displayPath(env)))}`);
  console.log();
  console.log(`  ${c.dim("Or skip the file —")} ${c.bold(`${runHint("setup", "init")} --cf-token <paste>`)}`);
}

/** Update-or-append `KEY=value` in .env.local, leaving any other lines intact. */
export function writeEnvLocalVar(key, value) {
  const path = statePath(".env.local");
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
    console.log(`  ${c.dim("Fine —")} ${c.bold(saveTokenCommand(displayPath(envLocalPath())))}`);
    return false;
  }
  writeEnvLocalToken(pasted);
  console.log(`  ${c.green("✓")} Saved to .env.local.`);
  return true;
}

/**
 * A value from gitignored .env.local ONLY. Split out from `fromEnv` so a caller can tell where a
 * credential came from — `loadCloudToken` exports the token into the environment, which makes
 * every later "is it in the environment?" check answer yes regardless of its real origin.
 *
 * The parsing itself lives in `target.mjs`, which the lean document commands already load and which
 * now reads this same file to find a bearer (#195). One parser, because a second copy of a format
 * this small is precisely what drifts — UTF-16LE, for instance, does not parse, which is why we
 * never suggest `>` on Windows (see `saveTokenCommand`), and that has to stay true in one place.
 */
export const fromEnvFile = (key) => readEnvVar(envLocalPath(), key);

/** A value from the environment, or from gitignored .env.local. */
export function fromEnv(key) {
  return process.env[key] ? process.env[key] : fromEnvFile(key);
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

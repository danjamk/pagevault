//
// Which deployment is this command about to act on? (ADR-021)
//
// Two files describe a deployment and, until this module existed, both independently answered that
// question — so four commands gave four different answers and one of them wrote to production. This
// is the single place that decides, for every command and both front doors.
//
// Nothing here reads a credential or performs I/O beyond looking for a marker file. It is pure
// enough to test from any directory, which matters: the cases that bite are a repo checkout beside
// a global login, and CI, and neither is convenient to reproduce by hand.
//
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
// `findByUrl` only — a pure comparison over an already-loaded registry. Loading the registry is the
// caller's job, which keeps this module free of I/O it did not ask for.
import { findByUrl } from "./registry.mjs";
import { sameDeployment } from "./client.mjs";

/** The file a checkout is recognized by. Also the file CI reconstructs — see `classifyMarker`. */
export const MARKER = ".pagevault.json";

/**
 * The nearest marker, walking up from `start` to the filesystem root. Returns its path or null.
 *
 * Ascent, not an exact match on CWD, because `git`, `npm` and `direnv` all work this way and an
 * operator standing in `worker/src` expects the same deployment as one standing in the repo root.
 *
 * This is what makes `make` and `pagevault` agree. `RUNNING_FROM_REPO` keys on where the *code*
 * lives, so a globally installed `pagevault` run inside the checkout targets production while
 * `node cli/bin/pagevault.mjs` in the same directory targets test. Keying on where the *user* is
 * standing removes that split.
 */
export function findMarker(start, { exists = existsSync } = {}) {
  let dir = start;
  const root = parse(dir).root;
  for (;;) {
    const candidate = join(dir, MARKER);
    if (exists(candidate)) return candidate;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null; // defensive: a path that will not shrink
    dir = parent;
  }
}

/**
 * Where is this invocation's marker? Three places, in strict order.
 *
 * 1. **`PAGEVAULT_HOME`, exclusively.** Its documented job is to "isolate EVERYTHING for a given
 *    deployment", and it is what every test suite uses: `HOME` and `PAGEVAULT_HOME` point at a temp
 *    dir *while the suite runs from the repo root*. If ascent could win here, the e2e suite would
 *    walk up, find the real `.pagevault.json`, and drive commands against a live deployment instead
 *    of local wrangler. So when it is set, we look there and nowhere else — no ascent, no fallback.
 * 2. **Ascent from CWD**, so standing anywhere in a checkout selects that checkout's deployment.
 * 3. **`~/.pagevault/`**, the installed default. Ascent cannot reach it (the marker sits *inside*
 *    `.pagevault/`, not in `$HOME`), so it is checked explicitly or an installed operator standing
 *    in an unrelated directory would resolve nothing.
 */
export function locateMarker({ env = process.env, cwd = process.cwd(), home = homedir(), exists = existsSync } = {}) {
  if (env.PAGEVAULT_HOME) {
    const pinned = join(env.PAGEVAULT_HOME, MARKER);
    return exists(pinned) ? pinned : null;
  }
  const found = findMarker(cwd, { exists });
  if (found) return found;
  const installed = join(home, ".pagevault", MARKER);
  return exists(installed) ? installed : null;
}

/**
 * What KIND of marker is this? Discriminated on **content**, never on an assumed shape.
 *
 * `deploy-prod.yml` reconstructs `.pagevault.json` from a base64 GitHub secret on every production
 * deploy, so the build-record shape is baked into a secret and a workflow. A reader that assumed
 * the pointer shape would break production deploys with no local reproduction. Support for the
 * record shape is therefore permanent, not a deprecation window.
 *
 *   pointer  { deployment: "test" }                     → names an entry in the registry
 *   record   { rung, accountId, host, kvId, … }         → a deployment in its own right
 *   empty    neither, or unreadable                     → tells us nothing; keep looking
 */
export function classifyMarker(obj) {
  if (obj && typeof obj === "object") {
    if (typeof obj.deployment === "string" && obj.deployment.trim()) {
      return { kind: "pointer", name: obj.deployment.trim() };
    }
    if (obj.rung !== undefined || obj.accountId || obj.host || obj.deployedUrl) {
      return { kind: "record", record: obj };
    }
  }
  return { kind: "empty" };
}

/** Read and classify a marker path. Unreadable or invalid JSON is `empty`, never a throw: a broken
 *  file must not stop a command that had a perfectly good answer elsewhere in the chain. */
export function readMarker(path, { read = readFileSync } = {}) {
  try {
    return classifyMarker(JSON.parse(read(path, "utf8")));
  } catch {
    return { kind: "empty" };
  }
}

/**
 * Is this registry entry's deployment provisioned from **this machine** — anywhere on it? (#170)
 *
 * 🔴 Deliberately NOT `locateMarker()`. That answers "which marker is nearest my cwd", which is the
 * right question for *which deployment am I acting on* and the wrong one here. A listing is global:
 * asked from `~` the nearest-marker answer is "no" and asked from the checkout it is "yes", for the
 * same deployment, two seconds apart. An answer that changes with your working directory is a worse
 * lie than the flat "no" this replaces.
 *
 * So the entry records **where** its build record is, and this follows that pointer. A pointer, not
 * a copy: `rung`, `accountId` and `host` are read fresh every time, so the registry can never hold a
 * stale `accountId` — which is the failure that rules out absorbing those fields on write.
 *
 * Every way this can go wrong degrades to `false`, which is the honest answer:
 *   - the checkout was deleted or moved  → the path does not exist, and it IS no longer provisioned
 *   - the file became unreadable or invalid JSON → we do not know, so we do not claim
 *   - that checkout was re-provisioned against a DIFFERENT deployment → the URLs disagree, and the
 *     entry must not claim a deployment it no longer owns
 *
 * An entry with no `markerPath` — a production deployed by CI — returns false without touching the
 * disk. That is a fact about the deployment, not a fault (#144).
 */
export function provisionedFrom(entry, { exists = existsSync, read = readFileSync } = {}) {
  const path = entry?.markerPath;
  if (typeof path !== "string" || !path || !exists(path)) return false;

  const marker = readMarker(path, { read });
  // A pointer marker means the registry is already authoritative for that directory — there is no
  // build record there, so nothing was provisioned from it. Only a record answers yes.
  if (marker.kind !== "record") return false;

  const url = recordUrl(marker.record);
  return Boolean(url) && sameDeployment(url, entry.url ?? "");
}

/** The URL a build record names. `deployedUrl` is written by a successful deploy; `host` is the
 *  intent recorded before one. Trailing slash trimmed so comparisons are string-safe. */
export function recordUrl(record) {
  const raw = record?.deployedUrl ?? (record?.host ? `https://${record.host}` : "");
  return String(raw ?? "").replace(/\/+$/, "");
}

/**
 * Resolve the deployment for this invocation.
 *
 * Order — identical for every command, which is the whole point:
 *
 *   1. `--deployment <name>`                   explicit, by name
 *   2. `--url <url>`                           explicit, by address
 *   3. PAGEVAULT_DEPLOYMENT                    environment, by name (direnv, CI, a one-off export)
 *   4. PAGEVAULT_URL                           environment, by address
 *   5. the nearest marker walking up from CWD  where you are standing
 *   6. the registry's `current`                the global default, set by `pagevault use`
 *   7. the login config                        the implicit `default` deployment
 *
 * Step 7 is what makes a client-only install work (#144): an install that talks to a deployment it
 * did not provision is a legitimate configuration, and having a login but no build record is a fact
 * about that deployment rather than an error. It stays as the final fallback permanently, so an
 * operator who never creates a registry keeps working exactly as before.
 *
 * `registry` is the phase-3 named store. Two ways a deployment gets attached to this result:
 *
 *   - a **pointer** marker (`{ deployment: "test" }`) or a name from (1)/(3)/(6), looked up directly
 *   - a **build record** marker, matched into the registry BY URL — decision (b)
 *
 * The second is what lets a checkout keep its untouched `.pagevault.json` and still get a bearer.
 * See `findByUrl` in registry.mjs for why rewriting that file was not an option.
 */
export function resolveTarget({
  flags = {},
  env = process.env,
  cwd = process.cwd(),
  home = homedir(),
  config = { url: "", token: "" },
  registry = null,
  locate = locateMarker,
  read = readMarker,
} = {}) {
  const trim = (u) => String(u ?? "").replace(/\/+$/, "");
  const configUrl = trim(config.url);
  const byName = (name) => (name ? (registry?.deployments?.[name] ?? null) : null);

  const markerPath = locate({ env, cwd, home });
  const marker = markerPath ? read(markerPath) : { kind: "empty" };
  const pointed = marker.kind === "pointer" ? byName(marker.name) : null;
  const markerUrl = marker.kind === "record" ? recordUrl(marker.record) : trim(pointed?.url);

  // A name that names nothing must not silently fall through to whatever is next in the chain —
  // that is how you act on the wrong deployment while believing you named the right one. Surfaced
  // here, thrown by the caller, so this function stays pure.
  const flagName = typeof flags.deployment === "string" ? flags.deployment.trim() : "";
  const envName = String(env.PAGEVAULT_DEPLOYMENT ?? "").trim();
  const askedName = flagName || envName;
  const unknownDeployment = askedName && !byName(askedName) ? askedName : null;

  const currentName = registry?.current ?? null;

  // Explicit beats environment beats where you happen to be standing beats the global default.
  const candidates = [
    ["flag-name", trim(byName(flagName)?.url)],
    ["flag", trim(flags.url)],
    ["env-name", trim(byName(envName)?.url)],
    ["env", trim(env.PAGEVAULT_URL)],
    ["marker", markerUrl],
    ["current", trim(byName(currentName)?.url)],
    ["config", configUrl],
  ];
  const [source, url] = candidates.find(([, value]) => value) ?? ["none", ""];

  // Which registry entry is this? By name when we got here by name, otherwise by URL — so a build
  // record, a `--url`, and the login config all pick up the matching entry's bearer and `protected`
  // flag without anyone having to name it.
  const namedBy = { "flag-name": flagName, "env-name": envName, current: currentName }[source] ?? null;
  const direct = marker.kind === "pointer" && source === "marker" ? marker.name : namedBy;
  const matched = direct
    ? { name: direct, entry: byName(direct) }
    : (url ? findByUrl(registry, url) : null);

  const record = marker.kind === "record" ? marker.record : (pointed ?? matched?.entry ?? null);
  return {
    url,
    source,
    // The deployment's name, when it has one. Null on an install with no registry — the URL is the
    // identity there, which is unambiguous if wordy.
    name: matched?.name ?? null,
    entry: matched?.entry ?? null,
    protected: matched?.entry?.protected === true,
    markerPath: markerPath ?? null,
    markerKind: marker.kind,
    // The build record backing this target, when there is one. `null` on a client-only install —
    // which is a shape, not a failure.
    record,
    provisioned: Boolean(record && (record.rung !== undefined || record.accountId)),
    // Both sources named a deployment and they disagree. Reads survive this; writes must not (#145).
    // A matched registry entry carries the RIGHT bearer, so it settles the disagreement rather than
    // being blocked by it — see resolveBearer.
    conflicted: Boolean(markerUrl && configUrl && markerUrl !== configUrl),
    markerUrl,
    configUrl,
    // A pointer naming a deployment the registry does not hold. Surfaced so a caller can say so
    // rather than silently falling through to the login config.
    unresolvedPointer: marker.kind === "pointer" && !pointed ? marker.name : null,
    // `--deployment` / PAGEVAULT_DEPLOYMENT named something unknown. Caller's job to refuse.
    unknownDeployment,
  };
}

/**
 * One line naming what a command is about to act on, and why that one.
 *
 * Every operator command prints this before acting. The "why" half is not decoration: the whole
 * class of bug this replaces was invisible precisely because nothing ever said which deployment had
 * been chosen or which file chose it.
 *
 * Names arrive with the registry (ADR-021 phase 3); until then the URL is the identity, which is
 * unambiguous if wordy.
 */
export function targetOrigin(t) {
  return (
    {
      "flag-name": "--deployment",
      flag: "--url",
      "env-name": "PAGEVAULT_DEPLOYMENT",
      env: "PAGEVAULT_URL",
      marker: t.markerPath ?? "project marker",
      current: "the current deployment",
      config: "login config",
      none: "nowhere",
    }[t.source] ?? "unknown"
  );
}

export function describeTarget(t) {
  if (!t.url) return "no deployment configured";
  // The name leads when there is one — it is what the operator typed and what `use` selected. An
  // install with no registry keeps the URL-only line it has always printed.
  return t.name ? `${t.name}  ${t.url}  (from ${targetOrigin(t)})` : `${t.url}  (from ${targetOrigin(t)})`;
}

/**
 * The bearer that belongs to the resolved deployment — or nothing (#155).
 *
 * 🔴 A credential is not interchangeable with a URL. `verify` used to take the URL from a
 * checkout's marker and the token from `~/.pagevault/config.json`, and sent PRODUCTION's bearer to
 * the test deployment. It came back 401, which was luck: had the two shared a bearer it would have
 * authenticated against the wrong one and run a write round-trip there.
 *
 * So the login config's token is usable only when the login config describes the deployment we
 * resolved. When the marker and the login disagree — `target.conflicted` — that token belongs to
 * the other one and must not be sent. Returning "" makes the caller say "no bearer available",
 * which is true and actionable, rather than raising an authentication error about a deployment the
 * operator never meant to touch.
 *
 * The registry entry's token sits second, and it is what ends the standoff. It is not a guess: it
 * was stored against this exact deployment, matched to it by name or by URL. When one is present
 * the disagreement above is no longer a reason to refuse — we are holding the right credential, so
 * `conflicted` gates only the login config's token, which is the one that could be the wrong one.
 */
export function resolveBearer(target, { env = "", state = "", config = "" } = {}) {
  if (env) return env;
  if (target?.entry?.token) return target.entry.token;
  if (state) return state;
  if (config && !target.conflicted) return config;
  return "";
}

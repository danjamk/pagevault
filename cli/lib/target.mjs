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
 *   1. `--deployment <name>` / `--url <url>`   explicit, wins always
 *   2. PAGEVAULT_DEPLOYMENT / PAGEVAULT_URL    environment (direnv, CI, a one-off export)
 *   3. the nearest marker walking up from CWD  where you are standing
 *   4. the login config                        the global default
 *
 * Step 4 is what makes a client-only install work (#144): an install that talks to a deployment it
 * did not provision is a legitimate configuration, and having a login but no build record is a fact
 * about that deployment rather than an error.
 *
 * `registry` is the phase-3 named store (ADR-021 rollout). Until it exists, a pointer marker is
 * recognized and reported but cannot be resolved — no file writes one yet, so this is unreachable
 * in practice and is here so the discriminator above is honest rather than aspirational.
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

  const markerPath = locate({ env, cwd, home });
  const marker = markerPath ? read(markerPath) : { kind: "empty" };
  const named = marker.kind === "pointer" ? registry?.deployments?.[marker.name] ?? null : null;
  const markerUrl = marker.kind === "record" ? recordUrl(marker.record) : trim(named?.url);

  // Explicit beats everything; environment beats where you happen to be standing.
  const candidates = [
    ["flag", trim(flags.url)],
    ["env", trim(env.PAGEVAULT_URL)],
    ["marker", markerUrl],
    ["config", configUrl],
  ];
  const [source, url] = candidates.find(([, value]) => value) ?? ["none", ""];

  const record = marker.kind === "record" ? marker.record : named ?? null;
  return {
    url,
    source,
    markerPath: markerPath ?? null,
    markerKind: marker.kind,
    // The build record backing this target, when there is one. `null` on a client-only install —
    // which is a shape, not a failure.
    record,
    provisioned: Boolean(record && (record.rung !== undefined || record.accountId)),
    // Both sources named a deployment and they disagree. Reads survive this; writes must not (#145).
    conflicted: Boolean(markerUrl && configUrl && markerUrl !== configUrl),
    markerUrl,
    configUrl,
    // A pointer we cannot follow yet — phase 3. Surfaced so a caller can say so rather than
    // silently falling through to the login config.
    unresolvedPointer: marker.kind === "pointer" && !named ? marker.name : null,
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
      flag: "--url",
      env: "PAGEVAULT_URL",
      marker: t.markerPath ?? "project marker",
      config: "login config",
      none: "nowhere",
    }[t.source] ?? "unknown"
  );
}

export function describeTarget(t) {
  if (!t.url) return "no deployment configured";
  return `${t.url}  (from ${targetOrigin(t)})`;
}

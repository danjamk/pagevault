//
// The named deployment registry (ADR-021 phase 3).
//
// One operator, several deployments: a production instance deployed by CI and a test one deployed
// from a checkout. Phases 1–2 built the resolver that decides WHICH of those a command acts on, and
// it worked — but `config.json` holds exactly one `{url, token}` pair, so there was nowhere to keep
// the second deployment's bearer. The resolver had nothing to resolve to. This is that place.
//
// Two properties this file exists to keep:
//
//   1. **`CLOUDFLARE_API_TOKEN` is NOT here.** It stays in per-clone `.env.local`, because that
//      placement *is* the #38 safety property: the prod credential is never on the laptop, so a
//      wrong-clone `make deploy` cannot touch prod by construction rather than by discipline. This
//      registry holds url, bearer and build metadata — never the credential that can create or
//      destroy infrastructure.
//   2. **Purely additive.** An install with no `deployments.json` behaves exactly as it did before
//      this file existed. `loadRegistry()` returning null is the ordinary state, not a degraded one.
//
// Zero dependencies beyond node built-ins and the lean client — the document commands load this.
//
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PvError, sameDeployment } from "./client.mjs";

export const REGISTRY_FILE = "deployments.json";

/**
 * Where the registry lives. Global by design — outside every repo, one copy.
 *
 * A function rather than a module-level constant because `PAGEVAULT_HOME` is what isolates the test
 * suites, and they set it *after* import. `CONFIG_PATH` in client.mjs computes at load time and has
 * lived with that; a new file should not inherit the wart.
 */
export function registryPath(env = process.env) {
  return join(env.PAGEVAULT_HOME || join(homedir(), ".pagevault"), REGISTRY_FILE);
}

/** A name is typed on a command line and becomes a JSON key. Keep it boring. */
export const isValidName = (name) => typeof name === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(name);

/**
 * The registry, or `null` when there isn't one — which is the normal state and never an error.
 *
 * Invalid JSON *is* an error, and a loud one: this file holds the bearer for every deployment, so
 * silently treating a corrupt registry as "no deployments" would fall through to the login config
 * and act on the wrong one. That is the exact failure mode ADR-021 exists to end.
 */
export function loadRegistry(env = process.env) {
  const path = registryPath(env);
  if (!existsSync(path)) return null;

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new PvError(`${path} is not valid JSON — fix or delete it.`);
  }
  const deployments = raw?.deployments && typeof raw.deployments === "object" ? raw.deployments : {};
  return {
    current: typeof raw?.current === "string" && raw.current.trim() ? raw.current.trim() : null,
    deployments,
  };
}

/**
 * Persist the registry at mode 0600 — it holds bearers.
 *
 * The mode is a POSIX guarantee only: NTFS ignores it, so on Windows this file is protected by the
 * profile directory's ACL rather than by anything asked for here. Kept because it is correct where
 * it is honored, and stated because the code otherwise reads as a promise it cannot keep everywhere.
 */
export function saveRegistry(registry, env = process.env) {
  const path = registryPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const clean = {
    current: registry.current ?? null,
    deployments: registry.deployments ?? {},
  };
  writeFileSync(path, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/** An empty registry, for the first write. */
export const emptyRegistry = () => ({ current: null, deployments: {} });

/** Look a deployment up by name. Returns the entry or null — never throws on a missing name. */
export function findByName(registry, name) {
  if (!registry || !name) return null;
  return registry.deployments?.[name] ?? null;
}

/**
 * 🔴 Look a deployment up by URL. This is the whole of decision (b), and it is why phase 3 needs no
 * migration and rewrites nothing in a working tree.
 *
 * A checkout's `.pagevault.json` is a **build record** — it has a host and an accountId but no name
 * and no bearer. CI reconstructs exactly that shape from a base64 secret on every production deploy
 * (`deploy-prod.yml`), so it cannot be converted to a pointer without breaking prod deploys with no
 * local reproduction. Matching the record's URL into the registry gives it a bearer while leaving
 * the file untouched, and a record with no matching entry degrades to precisely the old behaviour.
 *
 * Comparison goes through `sameDeployment`, so a trailing slash or host casing is never what decides
 * which deployment's credential gets sent.
 *
 * `current` wins a tie. Duplicate URLs across names should not happen, but if they do, resolving to
 * the deployment the operator selected is the least surprising of the available answers.
 */
export function findByUrl(registry, url) {
  if (!registry || !url) return null;
  const entries = Object.entries(registry.deployments ?? {});
  const matches = entries.filter(([, entry]) => sameDeployment(entry?.url, url));
  if (!matches.length) return null;
  const preferred = matches.find(([name]) => name === registry.current) ?? matches[0];
  return { name: preferred[0], entry: preferred[1] };
}

/**
 * Add or update one deployment, returning a NEW registry — callers save it explicitly.
 *
 * Merges rather than replaces, so `use` and a later `login --as` do not each drop the fields the
 * other wrote. A registry entry accumulates: url and token from a login, build metadata if the
 * deployment was ever provisioned from this machine.
 */
export function upsert(registry, name, patch) {
  if (!isValidName(name)) {
    throw new PvError(`"${name}" is not a usable deployment name — letters, digits, dot, dash, underscore.`);
  }
  const base = registry ?? emptyRegistry();
  return {
    ...base,
    deployments: { ...base.deployments, [name]: { ...(base.deployments?.[name] ?? {}), ...patch } },
  };
}

/** Drop a deployment. Clears `current` when it named the one being removed. */
export function remove(registry, name) {
  const base = registry ?? emptyRegistry();
  const { [name]: _gone, ...rest } = base.deployments ?? {};
  return { current: base.current === name ? null : base.current, deployments: rest };
}

/**
 * The registry as a list, for display. `provisioned` mirrors `resolveTarget`'s meaning of the word:
 * this machine holds the build record, so the provisioning commands can run. Its absence is a fact
 * about the deployment, not a fault (#144).
 */
export function listDeployments(registry) {
  if (!registry) return [];
  return Object.entries(registry.deployments).map(([name, entry]) => ({
    name,
    url: entry?.url ?? "",
    current: name === registry.current,
    protected: entry?.protected === true,
    provisioned: Boolean(entry && (entry.rung !== undefined || entry.accountId)),
    hasToken: Boolean(entry?.token),
  }));
}
//
// The PageVault HTTP client — config resolution, a fetch wrapper, and the read-back retry that
// KV's eventual consistency makes mandatory. Deliberately separate from the CLI's presentation
// so a second bin (the MCP proxy, #21) reuses exactly this auth + base-URL logic rather than
// re-deriving it. Zero dependencies — Node built-ins only.
//
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The login config lives in the same state dir the provisioning code uses, so PAGEVAULT_HOME
// isolates EVERYTHING for a given deployment — `.pagevault.json`, `.env.local`, and this file —
// which is what lets one machine hold several deployments cleanly. We read PAGEVAULT_HOME directly
// rather than import stateDir() from the provisioning module: this file is the lean HTTP client the
// document commands load, and it must not pull in the heavy provision tree. Default is unchanged:
// ~/.pagevault/config.json for a normal install or repo checkout.
export const CONFIG_PATH = join(process.env.PAGEVAULT_HOME || join(homedir(), ".pagevault"), "config.json");

/**
 * Write the login config the document commands read — `{ url, token }` at CONFIG_PATH, mode 0600
 * (it holds a bearer). The single writer, shared by the `login` command and `pagevault init` so a
 * successful install leaves you ready to publish with no second `login` step. `url`'s trailing
 * slash is trimmed to match loadConfig.
 */
export function saveLoginConfig({ url, token }) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const clean = { url: String(url).replace(/\/+$/, ""), token: String(token) };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  return CONFIG_PATH;
}

/**
 * A user-facing error: the CLI prints its message plainly, no stack. Carries the server's
 * error `code` and full response `details` when it wraps an API failure, so a command can
 * offer code-specific guidance (e.g. the `already_exists` collision paths — ADR-017).
 */
export class PvError extends Error {
  constructor(message, { code, details } = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/**
 * Resolve where to publish and how to authenticate. The environment wins over the config file,
 * so a one-off `PAGEVAULT_URL=… PAGEVAULT_API_TOKEN=… pagevault publish` overrides your saved
 * default without editing anything. Returns { url, token } with the url's trailing slash trimmed.
 */
export function loadConfig(env = process.env) {
  let file = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch {
      throw new PvError(`${CONFIG_PATH} is not valid JSON — fix or delete it.`);
    }
  }
  return {
    url: String(env.PAGEVAULT_URL || file.url || "").replace(/\/+$/, ""),
    token: String(env.PAGEVAULT_API_TOKEN || file.token || ""),
  };
}

/** Config that is actually usable, or a clear error telling you exactly how to set it. */
export function requireConfig(env = process.env) {
  const cfg = loadConfig(env);
  if (!cfg.url || !cfg.token) {
    throw new PvError(
      "Not configured. Point the CLI at your deployment:\n" +
        "  pagevault login --url https://share.example.com --token <PAGEVAULT_API_TOKEN>\n" +
        "or set PAGEVAULT_URL and PAGEVAULT_API_TOKEN per command.",
    );
  }
  return cfg;
}

/**
 * One API call. Returns parsed JSON on 2xx; throws PvError carrying the server's {error, code}
 * on anything else, so command code stays about the happy path. A network failure (wrong host,
 * offline) is reported as such rather than as an opaque fetch throw.
 */
export async function api(cfg, method, path, body) {
  let res;
  try {
    res = await fetch(`${cfg.url}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new PvError(`Could not reach ${cfg.url} — ${err.message}`);
  }

  const text = await res.text();
  const data = text ? safeJson(text) : {};
  if (!res.ok) {
    const msg = data?.error || text || res.statusText;
    throw new PvError(`${msg} (HTTP ${res.status}${data?.code ? `, ${data.code}` : ""})`, {
      code: data?.code,
      details: data,
    });
  }
  return data ?? {};
}

/**
 * One API call that returns the raw response body as text, not JSON — for `/raw`, whose body is
 * the stored HTML or markdown, not an envelope. Same auth and error handling as `api`; the error
 * path still tries to read a JSON {error, code} off a non-2xx so failures read the same.
 */
export async function apiText(cfg, method, path) {
  let res;
  try {
    res = await fetch(`${cfg.url}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
  } catch (err) {
    throw new PvError(`Could not reach ${cfg.url} — ${err.message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    const data = text ? safeJson(text) : null;
    const msg = data?.error || text || res.statusText;
    throw new PvError(`${msg} (HTTP ${res.status}${data?.code ? `, ${data.code}` : ""})`);
  }
  return text;
}

const safeJson = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * KV has no read-after-write guarantee, not even at the same edge (CLAUDE.md). A publish returns
 * a URL that can 404 for a beat — and opening it immediately is the first thing a new user does.
 * Poll GET /api/docs/{id} until the write is visible before we hand back a link. Returns whether
 * it became readable in time; the caller decides how loudly to warn if not.
 */
export async function waitReadable(cfg, id, { tries = 8, delayMs = 750 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      await api(cfg, "GET", `/docs/${encodeURIComponent(id)}`);
      return true;
    } catch {
      if (i < tries - 1) await sleep(delayMs);
    }
  }
  return false;
}
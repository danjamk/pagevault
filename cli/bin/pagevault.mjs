#!/usr/bin/env node
//
// pagevault — publish self-contained HTML to your own PageVault deployment from the terminal.
//
// A thin HTTP client of `/api`: no KV, no auth logic of its own, and it works against ANY
// deployment (yours or a colleague's) via PAGEVAULT_URL + PAGEVAULT_API_TOKEN. Zero dependencies.
// See https://github.com/danjamk/pagevault.
//
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { api, apiText, requireConfig, saveLoginConfig, waitReadable, PvError } from "../lib/client.mjs";
import { parseArgs, splitList, deriveTitle, sourceKindFor, truncate, table } from "../lib/format.mjs";
import { buildExport } from "../lib/export.mjs";
import { formatViews, queryViews } from "../lib/views.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// stdout is the pipe: on success it carries the URL and NOTHING else, so
// `pagevault publish x.html | pbcopy` just works. Everything human — status lines, warnings,
// tables, prompts — goes to stderr. This split is the whole point of task "print the URL and
// nothing else on success" (#7).
const out = (s) => stdout.write(`${s}\n`);
const note = (s) => stderr.write(`${s}\n`);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  if (flags.version || cmd === "--version" || cmd === "-v") return out(VERSION);
  if (!cmd || cmd === "help" || cmd === "--help" || flags.help) return usage();

  switch (cmd) {
    case "init":
      return init(flags);
    case "upgrade":
      return upgrade(flags);
    case "status":
      return status(flags);
    case "verify":
      return verify(flags);
    case "health":
      return health(flags);
    case "destroy":
      return destroy(flags);
    case "publish":
      return publish(positional, flags);
    case "list":
      return list(flags);
    case "read":
      return read(positional, flags);
    case "search":
      return search(positional, flags);
    case "mint":
      return mint(positional, flags);
    case "revoke":
      return revoke(positional, flags);
    case "rotate":
      return rotate(positional, flags);
    case "sync-access":
      return syncAccess(flags);
    case "share":
      return share(positional, flags);
    case "rm":
      return remove(positional, flags);
    case "export":
      return exportTree(positional, flags);
    case "views":
      return views(flags);
    case "login":
      return login(flags);
    default:
      throw new PvError(`Unknown command: ${cmd}\nRun \`pagevault help\`.`);
  }
}

async function publish(pos, flags) {
  const file = pos[0];
  if (!file) throw new PvError("Usage: pagevault publish <file.html|.md> [--portal s] [--name f] [--title t] [--public] …");
  if (!existsSync(file)) throw new PvError(`No such file: ${file}`);

  const cfg = requireConfig();
  const html = readFileSync(file, "utf8");
  // Identity is the filename (ADR-017): the file's basename, or --name to override it.
  const filename = typeof flags.name === "string" ? flags.name : basename(file);

  let res;
  try {
    res = await api(cfg, "POST", "/docs", {
      title: typeof flags.title === "string" ? flags.title : deriveTitle(html, file),
      filename,
      html,
      sourceKind: sourceKindFor(file, flags["source-kind"]),
      portal: typeof flags.portal === "string" ? flags.portal : undefined,
      summary: typeof flags.summary === "string" ? flags.summary : undefined,
      tags: splitList(flags.tags),
      emails: splitList(flags.emails),
      public: flags.public === true,
      ownerOnly: flags["owner-only"] === true,
      confirm: flags.confirm === true,
    });
  } catch (err) {
    // A same-filename collision is a decision, not a dead end: spell out the three ways forward,
    // using the id the server handed back with the 409. See ADR-017.
    if (err instanceof PvError && err.code === "already_exists" && err.details?.id) {
      const { id, name, portal } = err.details;
      throw new PvError(
        `A document named "${name}" already exists in portal "${portal}".\n` +
          `  Replace it in place:        pagevault publish ${file} --confirm\n` +
          `  Publish as a separate doc:  pagevault publish ${file} --name <other-filename>\n` +
          `  Change only its link:       pagevault mint ${id}`,
      );
    }
    throw err;
  }

  // Don't hand back a link the deployment can't serve yet.
  const readable = await waitReadable(cfg, res.id);

  // Human context → stderr, so stdout stays a clean URL. Echo the resolved filename + title so
  // identity is never invisible (ADR-017): the operator sees exactly what the update key is.
  note(`Published "${res.title}" (${res.name}) to portal "${res.portal}"${res.ownerOnly ? " — draft, owner-only" : ""}.`);
  if (res.extraEmails?.length) note(`Granted to: ${res.extraEmails.join(", ")}`);
  if (res.publicUrl) {
    note("⚠ Public link: anyone who has it can open this document, no login. It burns no Access seat.");
  }
  if (!readable) {
    note("Note: the write isn't confirmed at this edge yet (KV is eventually consistent) — the link may 404 for a few seconds.");
  }

  // The one shareable URL → stdout. Public? the /p/ capability link is what you hand out.
  out(res.publicUrl || res.url);
}

async function list(flags) {
  const cfg = requireConfig();
  const qs = new URLSearchParams();
  if (typeof flags.portal === "string") qs.set("portal", flags.portal);
  if (typeof flags.tag === "string") qs.set("tag", flags.tag);

  const { docs = [] } = await api(cfg, "GET", `/docs${qs.toString() ? `?${qs}` : ""}`);

  if (flags.json) return out(JSON.stringify(docs, null, 2));
  if (!docs.length) return note("No documents.");

  const rows = docs.map((d) => [
    d.id,
    truncate(d.name ?? "", 28),
    d.portal,
    truncate(d.title, 40),
    (d.createdAt || "").slice(0, 10),
    d.ownerOnly ? "draft" : d.public ? "public" : "",
  ]);
  out(table(["ID", "FILE", "PORTAL", "TITLE", "CREATED", ""], rows));
}

// The read side — the portal is memory, not an outbox. These mirror the MCP tools so the
// terminal is never a lesser surface than an agent (the parity principle, plan §#73).

async function read(pos, flags) {
  const id = pos[0];
  if (!id) throw new PvError("Usage: pagevault read <id> [--source] [--json]");
  const cfg = requireConfig();
  const enc = encodeURIComponent(id);

  // --source: the stored body (the original .md or the HTML) → stdout, byte-for-byte, so
  // `pagevault read <id> --source > report.md` round-trips. Nothing else on stdout.
  if (flags.source === true) {
    stdout.write(await apiText(cfg, "GET", `/docs/${enc}/raw`));
    return;
  }

  const meta = await api(cfg, "GET", `/docs/${enc}`);
  if (flags.json) return out(JSON.stringify(meta, null, 2));

  const visibility = meta.ownerOnly ? "draft (owner-only)" : meta.publicToken ? "public link live" : "portal members";
  const lines = [
    `${meta.title}`,
    `  id        ${meta.id}`,
    `  file      ${meta.name ?? ""}`,
    `  portal    ${meta.portal}`,
    `  format    ${meta.sourceKind ?? "html"}`,
    `  created   ${(meta.createdAt || "").slice(0, 10)}`,
    `  updated   ${(meta.updatedAt || "").slice(0, 10)}`,
    `  access    ${visibility}`,
  ];
  if (meta.tags?.length) lines.push(`  tags      ${meta.tags.join(", ")}`);
  if (meta.summary) lines.push(`  summary   ${meta.summary}`);
  if (meta.publicToken) lines.push(`  public    ${cfg.url}/p/${meta.publicToken}`);
  lines.push("", "Body: pagevault read " + id + " --source");
  out(lines.join("\n"));
}

async function search(pos, flags) {
  const [portal, ...terms] = pos;
  const query = terms.join(" ").trim();
  if (!portal || !query) {
    // The portal is required on purpose: a cross-client grep is how one client's material
    // ends up in another's answer (prime directive #5).
    throw new PvError("Usage: pagevault search <portal> <query…> [--limit N] [--json]");
  }

  const cfg = requireConfig();
  const qs = new URLSearchParams({ portal, q: query });
  if (typeof flags.limit === "string") qs.set("limit", flags.limit);

  const { hits = [] } = await api(cfg, "GET", `/search?${qs}`);

  if (flags.json) return out(JSON.stringify(hits, null, 2));
  if (!hits.length) return note(`No matches for "${query}" in portal "${portal}".`);

  const rows = hits.map((h) => [
    h.doc.id,
    truncate(h.doc.title, 44),
    (h.matched || []).join(","),
    (h.doc.createdAt || "").slice(0, 10),
  ]);
  out(table(["ID", "TITLE", "MATCHED", "CREATED"], rows));
}

// The public-link lifecycle. A public link is a capability URL: whoever holds it can open the
// document with no login (ADR-002). Minting and rotating are WIDENING — say so.

async function mint(pos) {
  const id = pos[0];
  if (!id) throw new PvError("Usage: pagevault mint <id>");
  const cfg = requireConfig();

  const res = await api(cfg, "PATCH", `/docs/${encodeURIComponent(id)}`, { makePublic: true });
  note("⚠ Public link: anyone who has it can open this document, no login. It burns no Access seat.");
  out(res.publicUrl || `${cfg.url}/p/${res.publicToken}`);
}

async function revoke(pos) {
  const id = pos[0];
  if (!id) throw new PvError("Usage: pagevault revoke <id>");
  const cfg = requireConfig();

  // Kill the /p/ link, keep the document. This is NOT delete — that's `pagevault rm`.
  await api(cfg, "PATCH", `/docs/${encodeURIComponent(id)}`, { makePublic: false });
  note(`Public link revoked for ${id}. Any /p/ URL for it is now dead. (The document itself is untouched — use \`rm\` to delete it.)`);
}

async function rotate(pos) {
  const id = pos[0];
  if (!id) throw new PvError("Usage: pagevault rotate <id>");
  const cfg = requireConfig();

  // One atomic call: the old token is dropped and a fresh one minted server-side. Two calls
  // (revoke then mint) would race KV's eventual consistency — hence the dedicated field.
  const res = await api(cfg, "PATCH", `/docs/${encodeURIComponent(id)}`, { rotatePublic: true });
  note("Rotated. Any previous /p/ URL is now dead.");
  note("⚠ The new link is public: anyone who has it can open this document, no login.");
  out(res.publicUrl || `${cfg.url}/p/${res.publicToken}`);
}

// Reconcile the Access viewer group with KV (#85). A thin /api call — the reconcile itself runs
// server-side, so the CLI never holds a Cloudflare token or the group id.
async function syncAccess(flags) {
  const reap = flags.reap === true;

  // Reaping removes people from Cloudflare Access (reclaiming seats). It only removes those KV no
  // longer authorizes and is recoverable by re-granting, but it is a real revocation — confirm the
  // intent before we even look at config.
  if (reap && flags.yes !== true) {
    if (!stdin.isTTY) throw new PvError("Refusing to --reap non-interactively without --yes.");
    const rl = createInterface({ input: stdin, output: stderr });
    const ans = (await rl.question("Reap Access seats for anyone KV no longer authorizes? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (ans !== "y") return note("Cancelled.");
  }

  const cfg = requireConfig();
  const res = await api(cfg, "POST", `/access/sync${reap ? "?reap=true" : ""}`);

  if (flags.json) return out(JSON.stringify(res, null, 2));

  const a = res.added?.length ?? 0;
  const r = res.removed?.length ?? 0;
  note(`Viewer group reconciled${reap ? " (reap)" : ""}: +${a} added, −${r} removed, ${res.kept?.length ?? 0} kept — ${res.groupSize} total.`);
  if (a) note(`  added:   ${res.added.join(", ")}`);
  if (r) note(`  removed: ${res.removed.join(", ")}`);
  if (!reap && res.groupSize !== undefined) {
    note("Run with --reap to also remove members KV no longer authorizes.");
  }
}

async function share(pos, flags) {
  const [portal, ...rest] = pos;
  const emails = [...rest, ...(splitList(flags.emails) ?? [])];
  if (!portal || !emails.length) {
    throw new PvError("Usage: pagevault share <portal> <email> [email …]");
  }

  const cfg = requireConfig();
  const res = await api(cfg, "PATCH", `/portals/${encodeURIComponent(portal)}`, { addMembers: emails });

  note(`Granted ${emails.join(", ")} to portal "${portal}".`);
  if (res.sync && res.sync !== "synced" && res.sync !== "ok") {
    note(`Access group sync: ${res.sync}`);
  }
  note(`Members now: ${(res.members ?? []).join(", ") || "(none)"}`);
}

async function remove(pos, flags) {
  const id = pos[0];
  if (!id) throw new PvError("Usage: pagevault rm <id> [--yes]");

  const cfg = requireConfig();

  // Destructive. Confirm interactively unless --yes; a non-TTY (a script) must pass --yes.
  if (flags.yes !== true) {
    if (!stdin.isTTY) throw new PvError(`Refusing to delete ${id} non-interactively without --yes.`);
    const rl = createInterface({ input: stdin, output: stderr });
    const ans = (await rl.question(`Delete document ${id}? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (ans !== "y") return note("Cancelled.");
  }

  await api(cfg, "DELETE", `/docs/${encodeURIComponent(id)}`);
  note(`Deleted ${id}.`);
}

async function exportTree(pos, flags) {
  const cfg = requireConfig();
  const outDir = pos[0] || `./pagevault-export-${new Date().toISOString().slice(0, 10)}`;

  const summary = await buildExport(
    cfg,
    {
      outDir,
      portal: typeof flags.portal === "string" ? flags.portal : undefined,
      zip: flags.zip === true,
      includeDrafts: flags["include-drafts"] === true,
    },
    note, // progress → stderr
  );

  // The one thing a script wants → stdout: the artifact path (the .zip if we made one).
  out(summary.zipPath || summary.outDir);
}

async function login(flags) {
  // Flags win, but fall back to the same env vars every other command already honors — so
  // `PAGEVAULT_URL=… PAGEVAULT_API_TOKEN=… pagevault login` persists your current environment to
  // config.json without re-typing it. Error only when neither a flag nor the env supplies a value.
  const url = (typeof flags.url === "string" ? flags.url : process.env.PAGEVAULT_URL || "").replace(/\/+$/, "");
  const token = typeof flags.token === "string" ? flags.token : process.env.PAGEVAULT_API_TOKEN || "";
  if (!url || !token) {
    throw new PvError(
      "Usage: pagevault login [--url https://share.example.com] [--token <PAGEVAULT_API_TOKEN>]\n" +
        "Provide both as flags, or set PAGEVAULT_URL and PAGEVAULT_API_TOKEN and run `pagevault login`.",
    );
  }

  // The same writer `pagevault init` uses, so an install and an explicit login leave identical
  // config. `login` is for a second machine, or someone else's deployment — `init` already writes
  // this for the deployment it just stood up.
  const path = saveLoginConfig({ url, token });
  note(`Saved to ${path} (mode 600).`);

  // Prove it works now, rather than at first publish.
  try {
    await api({ url, token }, "GET", "/docs");
    note("✓ Reached the deployment and authenticated.");
  } catch (err) {
    note(`⚠ Saved, but a test call failed: ${err.message}`);
  }
}

// The installed-product lifecycle (ADR-014): stand PageVault up on your own Cloudflare account,
// and redeploy it later — no repo clone. The provisioning code is dynamic-imported so the document
// commands above load none of it and stay a lean HTTP client. Both deploy the prebuilt Worker
// bundle the package ships. `--yes` (read from argv by the flow) makes them non-interactive.

async function init() {
  const { setup } = await import("../lib/provision/setup.mjs");
  const { deploy } = await import("../lib/provision/deploy.mjs");

  // setup walks the operator through the Cloudflare token, rung, owner, host, and account, writing
  // ~/.pagevault/. It returns ready:false (and prints what to do next) when it stopped early — a
  // missing token, or a token that reaches no account — in which case we do NOT deploy.
  const { ready } = await setup({ next: "pagevault init" });
  if (!ready) return;

  await deploy({ bundle: true });
}

async function upgrade() {
  // Redeploy the bundle that shipped with this installed package, keeping KV, config, and secrets.
  // Pairs with `npm update -g pagevault`: update the package for new code, then `pagevault upgrade`.
  const { deploy } = await import("../lib/provision/deploy.mjs");
  await deploy({ bundle: true });
}

// The operator commands — diagnostics and teardown for YOUR deployment. Each is the same engine
// `make status`/`verify`/`health`/`destroy` run (one engine, two front doors, ADR-014): the logic
// lives in ../lib/ops, dynamic-imported so the document commands above load none of it. They
// auto-target this install's deployment from ~/.pagevault/ state — zero config, like verify/health
// already were behind `make`.

async function status(flags) {
  const { statusCmd } = await import("../lib/ops/status.mjs");
  await statusCmd({ json: flags.json === true });
}

async function verify(flags) {
  const { verifyCmd } = await import("../lib/ops/verify.mjs");
  await verifyCmd({ json: flags.json === true });
}

async function health(flags) {
  const { healthCmd } = await import("../lib/ops/health.mjs");
  await healthCmd({ json: flags.json === true });
}

async function destroy(flags) {
  const { destroyCmd } = await import("../lib/ops/destroy.mjs");
  await destroyCmd({ keepData: flags["keep-data"] === true });
}

function usage() {
  note(`pagevault ${VERSION} — publish HTML or Markdown to your PageVault deployment

Set up & deploy:
  pagevault init [--yes]              stand PageVault up on your own Cloudflare account (no repo)
  pagevault upgrade [--yes]           redeploy the bundled Worker (after 'npm update -g pagevault')
  pagevault login [--url <url>] [--token <token>]   point at a deployment (falls back to env; init does this)

Publish & manage documents:
  pagevault publish <file.html|.md> [--portal s] [--name f] [--title t] [--summary s]
                                [--tags a,b] [--emails a@b,c@d] [--source-kind html|markdown]
                                [--public] [--owner-only] [--confirm]
                                --name sets the update key (default: the filename); --title is display only
  pagevault list [--portal s] [--tag t] [--json]
  pagevault read <id> [--source] [--json]
  pagevault search <portal> <query …> [--limit N] [--json]
  pagevault mint <id>                 mint a public /p/ link for an existing document
  pagevault revoke <id>               kill a document's public link (keeps the document)
  pagevault rotate <id>               replace the public link with a fresh one
  pagevault share <portal> <email> [email …]
  pagevault rm <id> [--yes]           delete the document (there is no undo)
  pagevault export [dir] [--portal s] [--include-drafts] [--zip]

Operate your deployment:
  pagevault status [--json]           what this install is configured for (local, no network)
  pagevault verify [--json]           smoke-test the live deployment (run after init/upgrade)
  pagevault health [--json]           assert /health reports the version you shipped
  pagevault sync-access [--reap] [--yes] [--json]  reconcile the Access viewer group with KV
  pagevault views [--days 30] [--portal s] [--doc id] [--json]  which documents were opened
  pagevault destroy [--keep-data]     tear the deployment down (asks; irreversible)

Config: PAGEVAULT_URL / PAGEVAULT_API_TOKEN, or ~/.pagevault/config.json (written by init/login).
On success, publish/mint/rotate print only the URL to stdout:  pagevault mint <id> | pbcopy
read --source prints the stored body to stdout:  pagevault read <id> --source > report.md
Export writes a browsable folder (index.html + one folder per portal); its path is printed to stdout.`);
}

/**
 * `pagevault views` — the one command that talks to Cloudflare rather than to a PageVault
 * deployment. Analytics Engine's binding is write-only; reading needs an account-scoped token
 * that the Worker deliberately does not hold (ADR-015, decision 6), which is also why there is
 * no MCP equivalent. Documented exception to CLI/MCP parity.
 */
async function views(flags) {
  const { loadContext, loadCloudToken } = await import("../lib/provision/context.mjs");
  const ctx = loadContext();

  let result;
  try {
    result = await queryViews(
      { accountId: flags.account || ctx.accountId, token: process.env.CLOUDFLARE_API_TOKEN || loadCloudToken() },
      { days: flags.days, portal: flags.portal, doc: flags.doc, limit: flags.limit },
    );
  } catch (err) {
    // ViewsError messages are written to be read, not debugged. Re-wrap so the CLI prints the
    // message plainly instead of a stack.
    throw new PvError(err.message);
  }

  // The table is human output, so it goes to stderr like every other table here. --json is the
  // pipe: `pagevault views --json | jq` should carry data and nothing else.
  if (flags.json) return out(JSON.stringify(result, null, 2));
  note(formatViews(result, null));
}

main().catch((err) => {
  note(err instanceof PvError ? `✗ ${err.message}` : `✗ ${err.stack || err}`);
  process.exit(1);
});
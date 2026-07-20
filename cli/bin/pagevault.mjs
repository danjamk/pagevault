#!/usr/bin/env node
//
// pagevault — publish self-contained HTML to your own PageVault deployment from the terminal.
//
// A thin HTTP client of `/api`: no KV, no auth logic of its own, and it works against ANY
// deployment (yours or a colleague's) via PAGEVAULT_URL + PAGEVAULT_API_TOKEN. Zero dependencies.
// See https://github.com/danjamk/pagevault.
//
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { api, apiText, requireConfig, waitReadable, CONFIG_PATH, PvError } from "../lib/client.mjs";
import { parseArgs, splitList, deriveTitle, sourceKindFor, truncate, table } from "../lib/format.mjs";
import { buildExport } from "../lib/export.mjs";

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
    case "login":
      return login(flags);
    default:
      throw new PvError(`Unknown command: ${cmd}\nRun \`pagevault help\`.`);
  }
}

async function publish(pos, flags) {
  const file = pos[0];
  if (!file) throw new PvError("Usage: pagevault publish <file.html|.md> [--portal s] [--title t] [--public] …");
  if (!existsSync(file)) throw new PvError(`No such file: ${file}`);

  const cfg = requireConfig();
  const html = readFileSync(file, "utf8");

  const res = await api(cfg, "POST", "/docs", {
    title: typeof flags.title === "string" ? flags.title : deriveTitle(html, file),
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

  // Don't hand back a link the deployment can't serve yet.
  const readable = await waitReadable(cfg, res.id);

  // Human context → stderr, so stdout stays a clean URL.
  note(`Published "${res.id}" to portal "${res.portal}"${res.ownerOnly ? " (draft — owner-only)" : ""}.`);
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
    d.portal,
    truncate(d.title, 44),
    (d.createdAt || "").slice(0, 10),
    d.ownerOnly ? "draft" : d.publicToken ? "public" : "",
  ]);
  out(table(["ID", "PORTAL", "TITLE", "CREATED", ""], rows));
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
  const url = typeof flags.url === "string" ? flags.url.replace(/\/+$/, "") : "";
  const token = typeof flags.token === "string" ? flags.token : "";
  if (!url || !token) {
    throw new PvError("Usage: pagevault login --url https://share.example.com --token <PAGEVAULT_API_TOKEN>");
  }

  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  // 0600: the file holds your bearer token.
  writeFileSync(CONFIG_PATH, `${JSON.stringify({ url, token }, null, 2)}\n`, { mode: 0o600 });
  note(`Saved to ${CONFIG_PATH} (mode 600).`);

  // Prove it works now, rather than at first publish.
  try {
    await api({ url, token }, "GET", "/docs");
    note("✓ Reached the deployment and authenticated.");
  } catch (err) {
    note(`⚠ Saved, but a test call failed: ${err.message}`);
  }
}

function usage() {
  note(`pagevault ${VERSION} — publish HTML or Markdown to your PageVault deployment

Usage:
  pagevault login --url <url> --token <token>
  pagevault publish <file.html|.md> [--portal s] [--title t] [--summary s]
                                [--tags a,b] [--emails a@b,c@d] [--source-kind html|markdown]
                                [--public] [--owner-only] [--confirm]
  pagevault list [--portal s] [--tag t] [--json]
  pagevault read <id> [--source] [--json]
  pagevault search <portal> <query …> [--limit N] [--json]
  pagevault mint <id>                 mint a public /p/ link for an existing document
  pagevault revoke <id>               kill a document's public link (keeps the document)
  pagevault rotate <id>               replace the public link with a fresh one
  pagevault share <portal> <email> [email …]
  pagevault sync-access [--reap] [--yes] [--json]  reconcile the Access viewer group with KV
  pagevault rm <id> [--yes]           delete the document (there is no undo)
  pagevault export [dir] [--portal s] [--include-drafts] [--zip]

Config: PAGEVAULT_URL / PAGEVAULT_API_TOKEN, or ~/.pagevault/config.json (via login).
On success, publish/mint/rotate print only the URL to stdout:  pagevault mint <id> | pbcopy
read --source prints the stored body to stdout:  pagevault read <id> --source > report.md
Export writes a browsable folder (index.html + one folder per portal); its path is printed to stdout.`);
}

main().catch((err) => {
  note(err instanceof PvError ? `✗ ${err.message}` : `✗ ${err.stack || err}`);
  process.exit(1);
});
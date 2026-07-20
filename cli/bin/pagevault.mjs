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
import { api, requireConfig, waitReadable, CONFIG_PATH, PvError } from "../lib/client.mjs";
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
  pagevault share <portal> <email> [email …]
  pagevault rm <id> [--yes]
  pagevault export [dir] [--portal s] [--include-drafts] [--zip]

Config: PAGEVAULT_URL / PAGEVAULT_API_TOKEN, or ~/.pagevault/config.json (via login).
On success, publish prints only the URL to stdout:  pagevault publish report.html | pbcopy
Export writes a browsable folder (index.html + one folder per portal); its path is printed to stdout.`);
}

main().catch((err) => {
  note(err instanceof PvError ? `✗ ${err.message}` : `✗ ${err.stack || err}`);
  process.exit(1);
});
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
import { helpText, usageError } from "../lib/help.mjs";
import { buildExport } from "../lib/export.mjs";
import { formatViews, plural, queryViews, summarizeViews } from "../lib/views.mjs";

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

  // `pagevault help <cmd>` and `pagevault <cmd> --help` both land on that command's own help
  // (#126). A bare `help`, or a `--help` on something we don't dispatch, falls back to the
  // top-level summary — including `init --help` and `upgrade --help`, which cli/smoke.mjs runs to
  // prove the lifecycle commands ship WITHOUT provisioning anything. Help must stay cheap and
  // exit 0.
  const showHelp = (name) => note((helpText(name) ?? usageText()).trimEnd());
  if (!cmd || cmd === "help" || cmd === "--help") return showHelp(positional[0]);
  if (flags.help) return showHelp(cmd);

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
    case "link":
      return link(positional, flags);
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
    case "portals":
      return portals(flags);
    case "portal-create":
      return portalCreate(positional, flags);
    case "share":
      return share(positional, flags);
    case "rm":
      return remove(positional, flags);
    case "export":
      return exportTree(positional, flags);
    case "views":
      return views(flags);
    case "backup":
      return backup(flags);
    case "restore":
      return restore(positional, flags);
    case "login":
      return login(flags);
    default:
      throw new PvError(`Unknown command: ${cmd}\nRun \`pagevault help\`.`);
  }
}

/**
 * The publish flags the user actually passed, rebuilt as a command string — so a collision's
 * "replace" suggestion carries their intent (`--public`, `--emails`, …) instead of dropping it.
 */
function passedPublishFlags(flags) {
  const parts = [];
  for (const key of ["portal", "name", "title", "summary", "tags", "emails", "source-kind"]) {
    const v = flags[key];
    if (typeof v === "string") parts.push(`--${key} ${/\s/.test(v) ? JSON.stringify(v) : v}`);
  }
  if (flags.public === true) parts.push("--public");
  if (flags["owner-only"] === true) parts.push("--owner-only");
  return parts.join(" ");
}

async function publish(pos, flags) {
  const file = pos[0];
  if (!file) throw new PvError(usageError("publish"));
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
    // A same-filename collision is a decision, not a dead end. Echo back the flags the user
    // passed, so the "replace" command carries their intent (a bare `--confirm` would silently
    // drop the `--public` they just asked for). And when they DID ask to make it public, lead
    // with `mint` — adding the link, no re-upload, is almost certainly what they meant. ADR-017.
    if (err instanceof PvError && err.code === "already_exists" && err.details?.id) {
      const { id, name, portal } = err.details;
      const opts = passedPublishFlags(flags);
      const replace = `pagevault publish ${file}${opts ? ` ${opts}` : ""} --confirm`;
      const mint = `pagevault mint ${id}`;
      const fork = `pagevault publish ${file} --name <other-filename>`;
      const lines =
        flags.public === true
          ? [
              `  Make it public (no re-upload):   ${mint}`,
              `  Replace its contents too:        ${replace}`,
              `  Publish as a separate document:  ${fork}`,
            ]
          : [
              `  Replace its contents:            ${replace}`,
              `  Publish as a separate document:  ${fork}`,
              `  Change only its link:            ${mint}`,
            ];
      throw new PvError(`A document named "${name}" already exists in portal "${portal}".\n${lines.join("\n")}`);
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
  if (!id) throw new PvError(usageError("read"));
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
    // The shareable URL, built by the server (public /p/ link if any, else the portal viewer URL).
    `  link      ${meta.publicUrl || meta.url || ""}`,
  ];
  if (meta.tags?.length) lines.push(`  tags      ${meta.tags.join(", ")}`);
  if (meta.summary) lines.push(`  summary   ${meta.summary}`);
  lines.push("", `Body: pagevault read ${id} --source   ·   URL only: pagevault link ${id}`);
  out(lines.join("\n"));
}

async function link(pos) {
  const id = pos[0];
  if (!id) throw new PvError(usageError("link"));
  const cfg = requireConfig();
  const meta = await api(cfg, "GET", `/docs/${encodeURIComponent(id)}`);
  // One URL → stdout, nothing else, so `pagevault link <id> | pbcopy` just works. A public doc
  // hands back its /p/ capability link; otherwise the portal viewer URL (login required).
  const url = meta.publicUrl || meta.url;
  if (!url) throw new PvError(`No URL for "${id}" — check the id with \`pagevault list\`.`);
  if (meta.ownerOnly) note("⚠ This is an owner-only draft — it opens for no one until you publish it.");
  else if (!meta.publicUrl) note("Note: this link requires login (portal members). For a public link: pagevault mint " + id);
  out(url);
}

async function search(pos, flags) {
  const [portal, ...terms] = pos;
  const query = terms.join(" ").trim();
  if (!portal || !query) {
    // The portal is required on purpose: a cross-client grep is how one client's material
    // ends up in another's answer (prime directive #5).
    throw new PvError(usageError("search"));
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
  if (!id) throw new PvError(usageError("mint"));
  const cfg = requireConfig();

  const res = await api(cfg, "PATCH", `/docs/${encodeURIComponent(id)}`, { makePublic: true });
  note("⚠ Public link: anyone who has it can open this document, no login. It burns no Access seat.");
  out(res.publicUrl || `${cfg.url}/p/${res.publicToken}`);
}

async function revoke(pos) {
  const id = pos[0];
  if (!id) throw new PvError(usageError("revoke"));
  const cfg = requireConfig();

  // Kill the /p/ link, keep the document. This is NOT delete — that's `pagevault rm`.
  await api(cfg, "PATCH", `/docs/${encodeURIComponent(id)}`, { makePublic: false });
  note(`Public link revoked for ${id}. Any /p/ URL for it is now dead. (The document itself is untouched — use \`rm\` to delete it.)`);
}

async function rotate(pos) {
  const id = pos[0];
  if (!id) throw new PvError(usageError("rotate"));
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

// Portals — the client boundary, and the thing permissions actually live on. The read side is one
// call; document counts are deliberately NOT fetched per portal, because that is a KV `list()` each
// and those have their own 1000/day quota (CLAUDE.md). Use `pagevault list --portal <slug>` for that.

async function portals(flags) {
  const cfg = requireConfig();
  const { portals: all = [] } = await api(cfg, "GET", "/portals");

  if (flags.json) return out(JSON.stringify(all, null, 2));
  if (!all.length) return note("No portals yet. Create one: pagevault portal-create <slug> --name \"Acme Corp\"");

  const rows = all.map((p) => [p.slug, p.kind, truncate(p.name ?? "", 32), (p.createdAt || "").slice(0, 10)]);
  out(table(["SLUG", "KIND", "NAME", "CREATED"], rows));
}

async function portalCreate(pos, flags) {
  const slug = pos[0];
  if (!slug) {
    throw new PvError(usageError("portal-create"));
  }

  const cfg = requireConfig();
  const kind = typeof flags.kind === "string" ? flags.kind : undefined;
  const portal = await api(cfg, "POST", "/portals", {
    slug,
    name: typeof flags.name === "string" ? flags.name : slug,
    kind,
    description: typeof flags.description === "string" ? flags.description : undefined,
  });

  note(`Created portal "${portal.slug}" (${portal.kind}) — ${portal.name}.`);
  if (portal.kind === "public") {
    note("⚠ A public portal: every document in it opens with no login, and it burns no Access seat.");
  } else if (portal.kind === "restricted") {
    note(`Add the client: pagevault share ${portal.slug} <email>`);
  }
  // stdout carries the one thing a script wants — the slug it can now publish into.
  out(portal.slug);
}

async function share(pos, flags) {
  const [portal, ...rest] = pos;
  const add = [...rest, ...(splitList(flags.emails) ?? [])];
  const remove = splitList(flags.remove) ?? [];
  if (!portal || (!add.length && !remove.length)) {
    throw new PvError(usageError("share"));
  }

  const cfg = requireConfig();
  const body = {};
  if (add.length) body.addMembers = add;
  if (remove.length) body.removeMembers = remove;
  const res = await api(cfg, "PATCH", `/portals/${encodeURIComponent(portal)}`, body);

  if (add.length) note(`Granted ${add.join(", ")} to portal "${portal}".`);
  if (remove.length) {
    note(`Removed ${remove.join(", ")} from portal "${portal}".`);
    // Removal is not synced on the hot path (ADR-002): KV stops authorizing them immediately, but
    // Cloudflare Access keeps admitting them — and keeps charging a seat — until the reconciler
    // runs. Saying "removed" without this would be a half-truth about a revocation.
    note("They lose access to every document in it. Their Access seat is freed by: pagevault sync-access --reap");
  }
  if (res.sync && res.sync !== "synced" && res.sync !== "ok") {
    note(`Access group sync: ${res.sync}`);
    // "not_configured" reads like a shrug, and it is two very different facts wearing one word. On
    // Public it is expected and harmless; on Secured it means the grant lands in KV and the person
    // still cannot get in. A fresh-machine run read it the first way on a deployment that was in
    // the second state, and reported `share` as broken — it wasn't; the deployment was.
    if (res.sync === "not_configured") {
      note("  → There is no Cloudflare Access group on this deployment.");
      note("    Public: expected. The grant is recorded and takes effect if you move to Secured.");
      note("    Secured: the deployment is misconfigured and this person cannot open anything —");
      note("             run `pagevault verify` to see what is wrong.");
    }
  }
  note(`Members now: ${(res.members ?? []).join(", ") || "(none)"}`);
}

async function remove(pos, flags) {
  const id = pos[0];
  if (!id) throw new PvError(usageError("rm"));

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
    throw new PvError(usageError("login"));
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

// Same-host disaster recovery (#133). These were `make`-only, which made them unreachable for an
// `npm install -g pagevault` operator — the one holding real client documents (Prime Directive #2).
// Both talk to Cloudflare directly with your provisioning token, not to /api: KV key metadata is
// what listings render from, and no PageVault endpoint exposes it.

async function backup(flags) {
  const { backupCmd } = await import("../lib/ops/backup.mjs");
  await backupCmd({
    out: typeof flags.out === "string" ? flags.out : undefined,
    kv: typeof flags.kv === "string" ? flags.kv : undefined,
  });
}

async function restore(pos, flags) {
  const { restoreCmd } = await import("../lib/ops/restore.mjs");
  // The file is positional (`pagevault restore backup.json`); --file is the alias `make restore`
  // passes, so FILE=… keeps working through the one engine.
  //
  // `--force` and `--yes` take no value, but parseArgs can't know that: `restore --force snap.json`
  // binds the filename to the flag and leaves no positional. Recover it — printing a usage line at
  // someone who plainly passed a file, in the one command people reach for mid-recovery, would be
  // the worst possible moment to be pedantic about argument order.
  const swallowed = ["force", "yes"].map((k) => flags[k]).find((v) => typeof v === "string");
  const file = pos[0] || (typeof flags.file === "string" ? flags.file : swallowed);
  if (!file) throw new PvError(usageError("restore"));
  await restoreCmd({
    file,
    kv: typeof flags.kv === "string" ? flags.kv : undefined,
    force: flags.force !== undefined,
  });
}

// The top-level summary — one line per command. Depth lives in `pagevault <cmd> --help` (#126),
// which is where a reader goes when a command misbehaves; this is the map, not the manual.
function usageText() {
  return `pagevault ${VERSION} — publish HTML or Markdown to your PageVault deployment

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
  pagevault link <id>                 print the shareable URL to stdout (| pbcopy)
  pagevault search <portal> <query …> [--limit N] [--json]
  pagevault mint <id>                 mint a public /p/ link for an existing document
  pagevault revoke <id>               kill a document's public link (keeps the document)
  pagevault rotate <id>               replace the public link with a fresh one
  pagevault rm <id> [--yes]           delete the document (there is no undo)
  pagevault export [dir] [--portal s] [--include-drafts] [--zip]

Portals — the client boundary; permissions live here, not on the document:
  pagevault portals [--json]          list your portals
  pagevault portal-create <slug> [--name "Acme Corp"] [--kind private|restricted|public]
                                [--description "…"]
  pagevault share <portal> <email> [email …]        grant access to everything in it
  pagevault share <portal> --remove a@b,c@d         revoke it

Operate your deployment:
  pagevault status [--json]           what this install is configured for (local, no network)
  pagevault verify [--json]           smoke-test the live deployment (run after init/upgrade)
  pagevault health [--json]           assert /health reports the version you shipped
  pagevault sync-access [--reap] [--yes] [--json]  reconcile the Access viewer group with KV
  pagevault views [--days 30] [--portal s] [--doc id] [--json]  which documents were opened
  pagevault views --sync              push those counts to MCP (one write; not live after)
  pagevault backup [--out <file.json>]  snapshot KV — same-host disaster recovery
  pagevault restore <file.json> [--force]  replay a backup (never deletes; asks first)
  pagevault destroy [--keep-data]     tear the deployment down (asks; irreversible)

Any command: pagevault <command> --help   for its flags and what they do.
Config: PAGEVAULT_URL / PAGEVAULT_API_TOKEN, or ~/.pagevault/config.json (written by init/login).
On success, publish/mint/rotate print only the URL to stdout:  pagevault mint <id> | pbcopy
read --source prints the stored body to stdout:  pagevault read <id> --source > report.md
Export writes a browsable folder (index.html + one folder per portal); its path is printed to stdout.`;
}

/**
 * `pagevault views` — one of the three commands that talk to Cloudflare rather than to a PageVault
 * deployment (`backup` and `restore` are the others). Analytics Engine's binding is write-only;
 * reading needs an account-scoped token that the Worker deliberately does not hold (ADR-015,
 * decision 6), which is why the *query* has no MCP equivalent. `--sync` pushes the aggregated
 * answer back so MCP can serve it (#127, ADR-019) — the Worker gains data, never the credential.
 */
async function views(flags) {
  if (flags.sync !== undefined) return syncViews(flags);

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

/**
 * `pagevault views --sync` — read Analytics Engine here, hand the Worker the result (#127).
 *
 * The two credentials never meet: the account-scoped analytics token stays on this machine and
 * the deployment bearer carries only the aggregate. That is the whole of ADR-019, and the reason
 * this is a flag on `views` rather than something the Worker could ever do for itself.
 */
async function syncViews(flags) {
  // A filtered sync would store a summary that CLAIMS to cover the deployment while holding one
  // portal — and every document outside it would then report a *measured* zero views, which is a
  // lie in the one direction that matters ("the client never opened it"). Refuse, never narrow.
  for (const flag of ["portal", "doc"]) {
    if (flags[flag] !== undefined) {
      throw new PvError(`--${flag} cannot be combined with --sync — the summary covers the whole deployment or it is wrong.`);
    }
  }

  const { loadContext, loadCloudToken } = await import("../lib/provision/context.mjs");
  const ctx = loadContext();
  const cfg = requireConfig();

  // 90 days, not the table's 30. "Have they ever opened it" is a lifetime question, and Analytics
  // Engine retains about three months — so a sync takes the whole window it can still see.
  const days = Number(flags.days ?? 90);
  // Rows are grouped per (portal, doc, title, surface, viewer), so one document can be many rows.
  // The table's default limit of 100 would truncate an aggregate silently.
  const limit = Number(flags.limit ?? 10000);

  let result;
  try {
    result = await queryViews(
      { accountId: flags.account || ctx.accountId, token: process.env.CLOUDFLARE_API_TOKEN || loadCloudToken() },
      { days, limit },
    );
  } catch (err) {
    throw new PvError(err.message);
  }

  // What still exists, so the summary can drop rows for documents that were revoked or torn down.
  const { docs = [] } = await api(cfg, "GET", "/docs");
  const knownIds = new Set(docs.map((d) => d.id));

  const { summary, skipped } = summarizeViews(result, { syncedAt: new Date().toISOString(), knownIds });
  const res = await api(cfg, "POST", "/views/summary", summary);

  // A truncated query would under-report views as confidently as a complete one, so say it.
  const truncated = result.rows.length >= limit;
  const counted = Object.keys(summary.docs).length;
  const total = Object.values(summary.docs).reduce((n, d) => n + d.views, 0);

  if (flags.json) return out(JSON.stringify({ ...res, skipped, truncated }, null, 2));

  note(
    [
      `Synced ${plural(counted, "document")} · ${plural(total, "view")} · last ${plural(days, "day")}.`,
      ...(skipped.length
        ? [`Skipped ${plural(skipped.length, "document")} no longer published — the dataset outlives the deployment.`]
        : []),
      ...(truncated
        ? [`⚠ Hit the ${limit}-row query limit, so the summary may be incomplete. Narrow it with --days.`]
        : []),
      `read_document and list_documents now report these over MCP, as of the sync — not live.`,
    ].join("\n"),
  );
}

main().catch((err) => {
  note(err instanceof PvError ? `✗ ${err.message}` : `✗ ${err.stack || err}`);
  process.exit(1);
});
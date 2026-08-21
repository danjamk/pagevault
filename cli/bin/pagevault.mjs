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
import { api, apiText, loadConfig, sameDeployment, saveLoginConfig, waitReadable, PvError } from "../lib/client.mjs";
import { resolveTarget, describeTarget, resolveBearerSource, stateEnvPath, stateToken, provisionedFrom, locateMarker, readMarker, recordUrl } from "../lib/target.mjs";
import { PROTECTED_COMMANDS, emptyRegistry, findByName, findByUrl, listDeployments, loadRegistry, protectedCommands, saveRegistry, shouldAdoptCurrent, upsert } from "../lib/registry.mjs";

import { parseArgs, splitList, deriveTitle, sourceKindFor, truncate, table } from "../lib/format.mjs";
import { applyPin, applyUnpin } from "../lib/pins.mjs";
import { helpText, usageError } from "../lib/help.mjs";
import { buildExport } from "../lib/export.mjs";
import { formatReferrers, formatRollup, formatViews, plural, queryBuckets, queryReferrers, queryViews, summarizeReferrers, summarizeReferrersByDay, summarizeViews } from "../lib/views.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// stdout is the pipe: on success it carries the URL and NOTHING else, so
// `pagevault publish x.html | pbcopy` just works. Everything human — status lines, warnings,
// tables, prompts — goes to stderr. This split is the whole point of task "print the URL and
// nothing else on success" (#7).
const out = (s) => stdout.write(`${s}\n`);
const note = (s) => stderr.write(`${s}\n`);

/**
 * Which deployment is this command acting on, and with which bearer? (ADR-021)
 *
 * The single door for every command that talks to `/api`. Before phase 3 the document commands
 * bypassed the resolver entirely and read the login config directly, so standing in a checkout
 * `status` reported the test deployment while `publish` wrote to production — the resolver was
 * correct and had nowhere to find a second bearer. Now the deployment and its credential come from
 * the same place, every time, and the pair is never assembled from two sources.
 *
 * Throws rather than falling through on every "you named something we cannot honour" case. Falling
 * through means acting on a DIFFERENT deployment while the operator believes they named one, which
 * is the whole failure this ADR is about.
 */
function commandTarget(flags = {}) {
  const config = loadConfig();
  const registry = loadRegistry(); // null when there is none — the ordinary state, not a fault
  const target = resolveTarget({ flags, config, registry });

  if (target.unknownDeployment) {
    const known = Object.keys(registry?.deployments ?? {});
    throw new PvError(
      `No deployment named "${target.unknownDeployment}".\n` +
        (known.length ? `Known: ${known.join(", ")}\n` : "No deployments are registered yet.\n") +
        "  pagevault deployments                       list them\n" +
        "  pagevault login --as <name> --url … --token …   add one",
    );
  }
  if (target.unresolvedPointer) {
    throw new PvError(
      `${target.markerPath} points at a deployment named "${target.unresolvedPointer}", which is not registered.\n` +
        "  pagevault deployments                       list what is\n" +
        `  pagevault login --as ${target.unresolvedPointer} --url … --token …   register it`,
    );
  }
  if (!target.url) {
    throw new PvError(
      "Not configured. Point the CLI at your deployment:\n" +
        "  pagevault login --url https://share.example.com --token <PAGEVAULT_API_TOKEN>\n" +
        "or set PAGEVAULT_URL and PAGEVAULT_API_TOKEN per command.",
    );
  }

  // 🔴 `state` — the `.env.local` sitting beside the build record — is the fourth source, and it
  // was missing here while `verify` and `health` resolved the identical target WITH it. So `init`
  // wrote the bearer, verify found it, and the very next `pagevault list` said there was none
  // (#195). The document commands are the ones an operator runs first; they cannot be the ones
  // looking in fewer places.
  const { token } = resolveBearerSource(target, {
    env: process.env.PAGEVAULT_API_TOKEN || "",
    state: stateToken(target),
    config: config.token,
  });
  if (!token) {
    // Reached when no credential on this machine describes the resolved deployment (#155). The
    // login's token is deliberately NOT sent when it describes another one — that is how a
    // production bearer once arrived at the test deployment. Saying where we looked matters as much
    // as saying we refused: "no bearer" against a machine that plainly has one reads as a bug.
    throw new PvError(
      `No bearer for ${target.url}.\n\n` +
        `  resolved   ${describeTarget(target)}\n` +
        `  logged in  ${target.configUrl || "(nothing)"}\n` +
        `  looked in  the environment, ${stateEnvPath(target) ?? "no build record on this machine"},\n` +
        `             the deployment registry, and the login config\n\n` +
        "A token that describes a different deployment is never sent here.\n" +
        "Register this one and its bearer travels with it:\n\n" +
        `  pagevault login --as <name> --url ${target.url} --token <PAGEVAULT_API_TOKEN>\n\n` +
        `or name it for one command: PAGEVAULT_API_TOKEN=… pagevault …`,
    );
  }

  announceTarget(target, registry);
  return { url: target.url, token, target };
}

/**
 * Say what we are about to act on. ADR-021 section 4 asks every command to do this, and the "why"
 * half is not decoration: this class of bug was invisible precisely because nothing ever named the
 * deployment or what chose it.
 *
 * Narrowed from "every command, always" to "whenever more than one answer was possible". On a
 * single-deployment install — no registry, resolved from the login config — there is no ambiguity
 * to surface and the line is pure noise on every `list`. The moment names exist, or you are
 * standing somewhere that decides, every command says which one. Always stderr, never stdout, so
 * `pagevault publish report.html | pbcopy` still carries only the URL.
 */
function announceTarget(target, registry) {
  if (!registry && target.source === "config") return;
  note(`→ ${describeTarget(target)}`);
}

/**
 * A deployment may be marked `"protected": true` in the registry. On one, the commands in
 * `PROTECTED_COMMANDS` require an explicit `--yes`. Publishing, editing and sharing are untouched
 * (ADR-021 section 6).
 *
 * This guards the three DOCUMENT commands, which is all the flag reached until #176. `upgrade` is
 * the fourth and it is gated in `deploy.mjs` instead — not for tidiness but because the two resolve
 * their target from different stores, and deploy's is the build record. See `refusesProtectedDeploy`.
 *
 * This is the narrow, declarative version of the guardrail: set once on production, costs nothing
 * on test, and does not train anyone to hit `y` without reading. A confirmation prompt on every
 * write was rejected for exactly that reason — publishing to production is the NORMAL case, so a
 * per-write prompt gets answered reflexively within a day and breaks CI, scripts and MCP besides.
 *
 * A refusal, not a prompt: `protected` must mean the same thing in a terminal and in a script.
 */
function requireYesOnProtected(cfg, flags, what) {
  if (!cfg.target?.protected || flags.yes === true) return;
  throw new PvError(
    `${cfg.target.name} is a protected deployment — ${what} needs an explicit --yes.\n\n` +
      `  ${cfg.target.name}  ${cfg.url}\n\n` +
      "Publishing, editing and sharing are unaffected; only the destructive commands ask.\n" +
      `Unset it by removing "protected" from that deployment in ~/.pagevault/deployments.json.`,
  );
}

/**
 * The two commands that read a build record and write through a bearer, and so are the only ones
 * that can act ACROSS deployments. `views --sync` is the dangerous one: it queries one deployment's
 * Analytics Engine and POSTs the summary to another, where no document id matches — storing a
 * near-empty summary that makes every document report a MEASURED zero over MCP. That is the exact
 * lie `syncViews` refuses when it rejects `--portal`, arriving through a door nobody guarded.
 *
 * The guard asks the precise question rather than the approximate one it used to: is the deployment
 * whose account we are about to read the same one we are about to write to? Phase 2 compared the
 * marker against the login config, which was a proxy for that and now reports a conflict in cases
 * the registry has already settled correctly.
 */
function resolveWriteTarget(flags, command) {
  const { url, token, target } = commandTarget(flags);
  if (target.markerUrl && !sameDeployment(url, target.markerUrl)) {
    throw new PvError(
      `${command} would read one deployment's account and write to another.\n\n` +
        `  provisioned here (${target.markerPath})\n    ${target.markerUrl}\n` +
        `  writing to       (${target.source})\n    ${url}\n\n` +
        "Refusing: a cross-deployment sync writes a summary whose ids match nothing there, which\n" +
        "reports a measured zero views for every document. Name the one you mean:\n\n" +
        `  pagevault ${command} --url ${target.markerUrl}`,
    );
  }
  return { url, token };
}

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
    case "edit":
      return edit(positional, flags);
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
    case "portal-delete":
      return portalDelete(positional, flags);
    case "pin":
      return pin(positional, flags);
    case "unpin":
      return unpin(positional, flags);
    case "share":
      return share(positional, flags);
    case "rm":
      return remove(positional, flags);
    case "export":
      return exportTree(positional, flags);
    case "views":
      return views(flags);
    case "sync-views":
      return syncViews(flags);
    case "backup":
      return backup(flags);
    case "restore":
      return restore(positional, flags);
    case "login":
      return login(flags);
    case "deployments":
      return deployments(flags);
    case "use":
      return use(positional);
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

  const cfg = commandTarget(flags);
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
  const cfg = commandTarget(flags);
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
  const cfg = commandTarget(flags);
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

/**
 * `pagevault edit <id>` — fix a published document's filename, title, summary or tags (#140).
 *
 * NOT the contents: those go through `publish` (create-or-update). The filename is the
 * document's identity (ADR-017), so renaming MOVES the document to a new URL — which is why
 * this prints the new link and says the old one redirects, rather than swapping it silently.
 */
async function edit(pos, flags) {
  const id = pos[0];
  if (!id) throw new PvError(usageError("edit"));

  const body = {};
  for (const [flag, field] of [["name", "name"], ["title", "title"], ["summary", "summary"]]) {
    if (typeof flags[flag] === "string") body[field] = flags[flag];
  }
  // `--tags ""` clears them; the flag being absent leaves them alone.
  if (typeof flags.tags === "string") body.tags = splitList(flags.tags) ?? [];
  if (Object.keys(body).length === 0) throw new PvError(usageError("edit"));

  const cfg = commandTarget(flags);

  let res;
  try {
    res = await api(cfg, "PATCH", `/docs/${encodeURIComponent(id)}`, body);
  } catch (err) {
    // The filename belongs to another document. There is no --confirm for this on purpose:
    // finishing a rename by destroying a different deliverable is never the intent. Point at
    // the operation that DOES replace a document, and let them choose it deliberately.
    if (err instanceof PvError && err.code === "name_taken" && err.details?.id) {
      throw new PvError(
        `${err.message}\n` +
          `  It is document ${err.details.id}.\n` +
          `  Pick a different --name, or replace that document deliberately:\n` +
          `    pagevault publish <file> --name ${body.name} --confirm`,
      );
    }
    throw err;
  }

  note(`Updated "${res.title}" (${res.name}) in portal "${res.portal}".`);
  if (res.movedFrom) {
    note(`Renamed, so it moved: ${res.movedFrom} → ${res.id}. The old link redirects here for a year.`);
    if (res.publicUrl) note("Its public /p/ link is unchanged and still works.");
  }
  // The canonical URL → stdout, so `pagevault edit <id> --name x.md | pbcopy` hands back the
  // link that now works. A public document's /p/ link is the one you actually give people.
  out(res.publicUrl || res.url);
}

async function link(pos, flags) {
  const id = pos[0];
  if (!id) throw new PvError(usageError("link"));
  const cfg = commandTarget(flags);
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

  const cfg = commandTarget(flags);
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

async function mint(pos, flags) {
  const id = pos[0];
  if (!id) throw new PvError(usageError("mint"));
  const cfg = commandTarget(flags);

  const res = await api(cfg, "PATCH", `/docs/${encodeURIComponent(id)}`, { makePublic: true });
  note("⚠ Public link: anyone who has it can open this document, no login. It burns no Access seat.");
  out(res.publicUrl || `${cfg.url}/p/${res.publicToken}`);
}

async function revoke(pos, flags) {
  const id = pos[0];
  if (!id) throw new PvError(usageError("revoke"));
  const cfg = commandTarget(flags);
  requireYesOnProtected(cfg, flags, "revoking a public link");

  // Kill the /p/ link, keep the document. This is NOT delete — that's `pagevault rm`.
  await api(cfg, "PATCH", `/docs/${encodeURIComponent(id)}`, { makePublic: false });
  note(`Public link revoked for ${id}. Any /p/ URL for it is now dead. (The document itself is untouched — use \`rm\` to delete it.)`);
}

async function rotate(pos, flags) {
  const id = pos[0];
  if (!id) throw new PvError(usageError("rotate"));
  const cfg = commandTarget(flags);
  requireYesOnProtected(cfg, flags, "rotating a public link");

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

  const target = resolveWriteTarget(flags, "sync-access");
  const res = await api(target, "POST", `/access/sync${reap ? "?reap=true" : ""}`);

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
  const cfg = commandTarget(flags);
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

  const cfg = commandTarget(flags);
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

/**
 * Delete a portal — the one command that can end a client's entire record.
 *
 * `DELETE /api/portals/{slug}` has existed and been tested since the portal API was written, and
 * had no caller on ANY surface (#180). So removing a mistyped slug meant hand-rolling a request with
 * a bearer read out of `deployments.json`, and the only shipped alternative was `destroy`, which
 * takes the whole deployment with it.
 *
 * 🔴 The confirmation is proportional to what is being destroyed, because one gesture cannot be
 * right for both cases here:
 *
 *   empty portal          → y/N, like `rm`. A slug and nothing else.
 *   documents, no flag    → refused. `--cascade` is the deliberate act, and asking "are you sure"
 *                           in its place would train the reflex this is trying to avoid.
 *   documents + --cascade → type the slug back, like `destroy`. Naming the count first, because
 *                           "3 documents" and "fourteen months of an engagement" are different
 *                           decisions and only the operator can tell which one this is.
 *
 * The count comes from a listing, and the SERVER's 409 is still the authority — KV is eventually
 * consistent, so a document published between the listing and the delete is a real case, and the
 * refusal it produces is surfaced intact rather than retried with cascade.
 */
async function portalDelete(pos, flags) {
  const slug = pos[0];
  if (!slug) throw new PvError(usageError("portal-delete"));

  const cfg = commandTarget(flags);
  requireYesOnProtected(cfg, flags, "deleting a portal");

  const path = `/portals/${encodeURIComponent(slug)}`;
  const { portals: all = [] } = await api(cfg, "GET", "/portals");
  const portal = all.find((p) => p.slug === slug);
  if (!portal) {
    throw new PvError(
      `No portal "${slug}" on ${cfg.url}.\n\n` +
        `Portals: ${all.map((p) => p.slug).join(", ") || "(none)"}`,
    );
  }

  const { docs = [] } = await api(cfg, "GET", `/docs?portal=${encodeURIComponent(slug)}`);

  if (docs.length && flags.cascade !== true) {
    // Refuse in the same shape the Worker would, before touching it. Naming the documents is the
    // point: a count is a number, and a list is a decision.
    throw new PvError(
      `Portal "${slug}" holds ${docs.length} document${docs.length === 1 ? "" : "s"}. Deleting it deletes them too.\n\n` +
        docs.slice(0, 8).map((d) => `  · ${d.name ?? d.title}`).join("\n") +
        (docs.length > 8 ? `\n  … and ${docs.length - 8} more` : "") +
        `\n\nThere is no undo, and the /p/ and /v/ links go with them.\n` +
        `  pagevault portal-delete ${slug} --cascade    delete the portal AND everything in it\n` +
        `  pagevault export --portal ${slug}            take a copy first`,
    );
  }

  if (flags.yes !== true) {
    if (!stdin.isTTY) {
      throw new PvError(`Refusing to delete portal "${slug}" non-interactively without --yes.`);
    }
    const rl = createInterface({ input: stdin, output: stderr });
    let ok;
    if (docs.length) {
      // The destroy model. A y/N here would be answered by reflex, and this is the gesture that
      // ends an engagement's record.
      note(`Deleting portal "${slug}" and all ${docs.length} document${docs.length === 1 ? "" : "s"} in it. This cannot be undone.`);
      ok = (await rl.question(`Type the portal slug to confirm (${slug}): `)).trim() === slug;
    } else {
      ok = (await rl.question(`Delete empty portal "${slug}"? [y/N] `)).trim().toLowerCase() === "y";
    }
    rl.close();
    if (!ok) return note("Cancelled — nothing was deleted.");
  }

  let res;
  try {
    res = await api(cfg, "DELETE", `${path}${flags.cascade === true ? "?cascade=true" : ""}`);
  } catch (err) {
    // The Worker refused because the portal filled up between our listing and this call — KV has no
    // read-after-write guarantee, so this is a real race and not a hypothetical. Surface its
    // refusal unchanged; do not "resolve" it by adding cascade to a delete the operator sized
    // against a smaller portal.
    if (err.code === "portal_not_empty") {
      throw new PvError(
        `${err.message}\n\n` +
          "That count is higher than when this command started — something was published in\n" +
          "between. Re-run and read it again before adding --cascade.",
      );
    }
    throw err;
  }

  note(`Deleted portal "${slug}"${res.deleted ? ` and ${res.deleted} document${res.deleted === 1 ? "" : "s"}` : ""}.`);
}

/**
 * Pinning — the order the portal index leads with (#142).
 *
 * 🔴 The filename is RESOLVED against the deployment before anything is written, and that is not
 * politeness. `partitionPinned` skips a pin naming no document, deliberately — it is what makes a
 * deleted or renamed document heal itself instead of blanking the page. The cost of that design is
 * that a typo pins nothing and says nothing, forever. So the one place that can still tell the
 * difference between "not here yet" and "misspelled" — the moment the operator types it — has to.
 *
 * The portal is inferred from the document when it is unambiguous, because `--portal` on top of a
 * filename is a thing to remember for no benefit in the ordinary case of a filename existing once.
 */
async function resolvePinTarget(cfg, name, flags) {
  const portalFlag = typeof flags.portal === "string" ? flags.portal : undefined;
  const qs = portalFlag ? `?portal=${encodeURIComponent(portalFlag)}` : "";
  const { docs = [] } = await api(cfg, "GET", `/docs${qs}`);

  const wanted = String(name).trim().toLowerCase();
  const matches = docs.filter((d) => String(d.name ?? "").toLowerCase() === wanted);

  if (!matches.length) {
    throw new PvError(
      `No document named "${name}"${portalFlag ? ` in portal "${portalFlag}"` : ""}.\n\n` +
        "Pinning names a FILENAME, not a title — `pagevault list` shows both.\n" +
        "A pin naming nothing is skipped when the page renders, so this would have been silent.",
    );
  }

  // One filename, two portals. The pin lives on a portal, so guessing here would pin the wrong
  // client's document — cheap to refuse, expensive to get wrong.
  const portals = [...new Set(matches.map((d) => d.portal))];
  if (portals.length > 1) {
    throw new PvError(
      `"${name}" exists in ${portals.length} portals: ${portals.join(", ")}.\n\n` +
        `Say which:  pagevault ${flags._cmd ?? "pin"} ${name} --portal <slug>`,
    );
  }

  return { portal: portals[0], doc: matches[0] };
}

/** GET the portal, apply `change` to its pin list, PATCH the whole order back. */
async function writePins(cfg, portalSlug, change) {
  const portal = await api(cfg, "GET", `/portals/${encodeURIComponent(portalSlug)}`);
  const before = portal.pinned ?? [];
  const after = change(before);

  const updated = await api(cfg, "PATCH", `/portals/${encodeURIComponent(portalSlug)}`, { pinned: after });
  const kept = updated.pinned ?? [];

  // 🔴 Version skew, not a cap. An older Worker does not know the `pinned` field, ignores it, and
  // answers 200 with the portal unchanged — so the write silently did nothing. npm ships
  // independently of deploys (ADR-010), which makes "new CLI, old Worker" the ORDINARY state right
  // after `npm update -g pagevault`, not an edge case. Distinguishable because we sent a non-empty
  // list and the field came back absent entirely; clearing pins sends `[]` and legitimately gets
  // nothing back, which is why the guard is on what we SENT.
  if (after.length && !kept.length) {
    throw new PvError(
      `${cfg.url} accepted the request but stored no pin order.\n\n` +
        "That deployment is running a Worker from before pinning existed — it ignored the field.\n" +
        "Bring it up to this CLI with `pagevault upgrade` (or `make deploy` from a checkout).\n\n" +
        "Nothing was changed, and nothing else about the portal was touched.",
    );
  }

  // A real cap. The Worker owns it, so it can keep fewer than we sent — say so rather than printing
  // a list the operator did not ask for and letting them find the missing one later.
  if (kept.length < after.length) {
    note(`⚠ ${after.length - kept.length} dropped — a portal holds at most ${kept.length} pinned documents.`);
  }
  return kept;
}

/** The pinned block, in order, as the operator will see it. */
const showPins = (pinned) =>
  pinned.length
    ? note(`Pinned, in order:\n${pinned.map((n, i) => `  ${i + 1}. ${n}`).join("\n")}`)
    : note("Nothing pinned — the portal reads newest-first, as it always has.");

async function pin(pos, flags) {
  const name = pos[0];
  if (!name) throw new PvError(usageError("pin"));

  const cfg = commandTarget(flags);
  const { portal } = await resolvePinTarget(cfg, name, { ...flags, _cmd: "pin" });

  // Exactly one placement, so two of them is a typo rather than a preference to resolve.
  const ops = ["top", "bottom", "up", "down"].filter((o) => flags[o] === true);
  if (flags.to !== undefined) ops.push("to");
  if (ops.length > 1) throw new PvError(`Pick one placement, not ${ops.length}: ${ops.map((o) => `--${o}`).join(" ")}`);

  const op = flags.to !== undefined ? Number(flags.to) : (ops[0] ?? "top");
  if (op === "to" || (typeof op === "number" && !Number.isFinite(op))) {
    throw new PvError(`--to needs a position, e.g. --to 2`);
  }

  const kept = await writePins(cfg, portal, (before) => applyPin(before, name, op));
  note(`Pinned "${name}" in portal "${portal}".`);
  showPins(kept);
}

async function unpin(pos, flags) {
  const name = pos[0];
  if (!name) throw new PvError(usageError("unpin"));

  const cfg = commandTarget(flags);
  // Deliberately NOT resolved against the documents: unpinning a name whose document is already
  // gone is exactly the cleanup someone would want, and refusing it would strand the entry.
  const portalSlug = typeof flags.portal === "string" ? flags.portal : (await resolvePinTarget(cfg, name, { ...flags, _cmd: "unpin" })).portal;

  const kept = await writePins(cfg, portalSlug, (before) => applyUnpin(before, name));
  note(`Unpinned "${name}" from portal "${portalSlug}".`);
  showPins(kept);
}

async function share(pos, flags) {
  const [portal, ...rest] = pos;
  const add = [...rest, ...(splitList(flags.emails) ?? [])];
  const remove = splitList(flags.remove) ?? [];
  if (!portal || (!add.length && !remove.length)) {
    throw new PvError(usageError("share"));
  }

  const cfg = commandTarget(flags);
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

  const cfg = commandTarget(flags);
  // On a protected deployment the prompt below is not enough — `--yes` must be typed, in a terminal
  // or a script alike.
  requireYesOnProtected(cfg, flags, "deleting a document");

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
  const cfg = commandTarget(flags);
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

/**
 * Everything this machine can reach, and which one is selected (ADR-021 phase 3).
 *
 * The login config is listed too, as the implicit `default` it has always been. Leaving it out
 * would show an operator a registry of one and a working `publish` they cannot account for.
 */
function deployments(flags) {
  const registry = loadRegistry();
  // Follows each entry's recorded marker path, so the answer is the same from `~` and from a
  // checkout. See provisionedFrom for why the nearest marker is the wrong question here (#170).
  const rows = listDeployments(registry, { provisioned: provisionedFrom });
  const config = loadConfig();

  // Only when nothing in the registry already describes it — otherwise it is the same deployment
  // listed twice under two identities, which is exactly the confusion this ADR removes.
  const configCovered = !config.url || Boolean(findByUrl(registry, config.url));
  const all = [
    ...rows,
    ...(configCovered ? [] : [{ name: "(login config)", url: config.url, current: !registry?.current, protected: false, provisioned: false, hasToken: Boolean(config.token) }]),
  ];

  if (flags.json) return out(JSON.stringify(all, null, 2));
  if (!all.length) {
    return note(
      "No deployments. Add one:\n" +
        "  pagevault login --as prod --url https://share.example.com --token <PAGEVAULT_API_TOKEN>",
    );
  }

  note(
    table(
      ["", "NAME", "URL", "PROVISIONED", "PROTECTED"],
      all.map((d) => [
        d.current ? "*" : "",
        d.name,
        d.url,
        // "Provisioned from this machine" — a fact about the deployment, not a fault (#144).
        d.provisioned ? "yes" : "no",
        d.protected ? "yes" : "",
      ]),
    ),
  );
  note("\n* is the default. Standing in a checkout still wins over it.");

  // A `no` that should be `yes` is the confusing case, and it has exactly one cause: the build
  // record is right here but the entry never recorded where. Say how to fix it rather than leaving
  // the operator to reconcile two commands that disagree.
  //
  // The NEAREST marker is fair game for a hint — it is a statement about where you are standing,
  // not about the deployment. Only the column itself has to be location-independent.
  const here = unrecordedMarkerFor(all);
  if (here) {
    note(
      `\n${here.name} is provisioned from this directory but does not say so.\n` +
        `  pagevault login --as ${here.name}    records it — no need to retype the URL or token.`,
    );
  }
}

/**
 * The marker path for `url`, but only if the marker this invocation can see actually describes that
 * deployment. Returns null otherwise — including for a pointer marker, which means the registry is
 * already authoritative for this directory and there is no build record to point back at (#170).
 */
function markerPathFor(url) {
  const path = locateMarker();
  if (!path) return null;
  const marker = readMarker(path);
  if (marker.kind !== "record") return null;
  return sameDeployment(recordUrl(marker.record), url) ? path : null;
}

/** A listed deployment that IS provisioned from where we are standing, but has no `markerPath`. */
function unrecordedMarkerFor(rows) {
  return rows.find((d) => !d.provisioned && d.url && markerPathFor(d.url)) ?? null;
}

/**
 * Select the default deployment — the `current` rung of the resolution order, below the project
 * marker. Writes the registry and nothing else; a marker in a working tree is never touched.
 */
function use(pos) {
  const name = pos[0];
  if (!name) throw new PvError(usageError("use"));

  const registry = loadRegistry();
  const entry = findByName(registry, name);
  if (!entry) {
    const known = Object.keys(registry?.deployments ?? {});
    throw new PvError(
      `No deployment named "${name}".\n` +
        (known.length ? `Known: ${known.join(", ")}` : "None are registered — add one with `pagevault login --as <name> …`."),
    );
  }

  saveRegistry({ ...registry, current: name }, process.env);
  note(`→ ${name}  ${entry.url}`);
  note("Standing in a checkout still selects that checkout's deployment.");
}

async function login(flags) {
  // Flags win, but fall back to the same env vars every other command already honors — so
  // `PAGEVAULT_URL=… PAGEVAULT_API_TOKEN=… pagevault login` persists your current environment to
  // config.json without re-typing it. Error only when neither a flag nor the env supplies a value.
  // `--as <name>` is the door into the registry (ADR-021 phase 3), and the only one — nothing else
  // writes a deployment entry, so an operator who never types it keeps the single-deployment
  // config.json they have always had. Without it, `login` behaves exactly as before.
  const name = typeof flags.as === "string" ? flags.as.trim() : "";
  const before = name ? (loadRegistry() ?? emptyRegistry()) : emptyRegistry();
  const existing = name ? findByName(before, name) : null;

  // Protection is a property of a registry entry, so there is nowhere to put it without a name.
  // Saying that beats writing a config.json and silently dropping the flag.
  const wantsProtection = flags.protected === true || flags["no-protected"] === true;
  if (wantsProtection && !name) {
    throw new PvError(
      "--protected applies to a named deployment. Add --as <name>:\n" +
        "  pagevault login --as prod --url … --token … --protected\n" +
        "  pagevault deployments        see which are registered",
    );
  }

  // An already-registered deployment can be amended without re-typing its credentials, which is what
  // makes `pagevault login --as prod --protected` a toggle rather than a re-registration.
  const url = (typeof flags.url === "string" ? flags.url : process.env.PAGEVAULT_URL || existing?.url || "").replace(/\/+$/, "");
  const token = typeof flags.token === "string" ? flags.token : process.env.PAGEVAULT_API_TOKEN || existing?.token || "";
  if (!url || !token) {
    throw new PvError(usageError("login"));
  }

  if (name) {
    const patch = { url, token };
    // Where this machine's build record for that deployment lives, when we can see one describing
    // it. A path, never a copy of its contents — see `provisionedFrom` (#170). Absent stays absent:
    // registering a CI-deployed production from a laptop records no path, because there is none.
    const markerPath = markerPathFor(url);
    if (markerPath) patch.markerPath = markerPath;
    // Written as an explicit `false` rather than dropped, so the file states the decision. Every
    // reader tests `=== true`, so absence and false mean the same thing to the code and different
    // things to a person reading it.
    if (flags.protected === true) patch.protected = true;
    if (flags["no-protected"] === true) patch.protected = false;
    let next = upsert(before, name, patch);

    // Adopt `current` only when nothing has claimed it AND we are not stealing the default from a
    // login that describes a DIFFERENT deployment. Registering prod-under-a-name should inherit the
    // selection; registering a second, unrelated deployment should not silently repoint everything
    // that runs outside a checkout. When we decline, `use` is one word away and we say so.
    const adopt = shouldAdoptCurrent(before, url, loadConfig().url);
    if (adopt) next = { ...next, current: name };

    const registryFile = saveRegistry(next, process.env);
    note(`Registered ${name} → ${url} in ${registryFile} (mode 600).`);
    if (next.deployments[name].protected === true) {
      note(`${name} is protected — ${protectedCommands()} will require --yes.`);
    } else if (flags["no-protected"] === true) {
      note(`${name} is no longer protected.`);
    }
    // Nothing to say when it was already selected — re-running this to flip a flag should not read
    // as advice to do something already done.
    if (adopt) note(`${name} is now the default deployment.`);
    else if (next.current !== name) note(`Make it the default: pagevault use ${name}`);

    try {
      await api({ url, token }, "GET", "/docs");
      note("✓ Reached the deployment and authenticated.");
    } catch (err) {
      note(`⚠ Registered, but a test call failed: ${err.message}`);
    }
    return;
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

async function init(flags = {}) {
  const { setup } = await import("../lib/provision/setup.mjs");
  const { deploy } = await import("../lib/provision/deploy.mjs");

  // setup walks the operator through the Cloudflare token, rung, owner, host, and account, writing
  // ~/.pagevault/. It returns ready:false (and prints what to do next) when it stopped early — a
  // missing token, or a token that reaches no account — in which case we do NOT deploy.
  const { ready } = await setup({ next: "pagevault init" });
  if (!ready) return;

  await deploy({ bundle: true, flags });
}

async function upgrade(flags = {}) {
  // Redeploy the bundle that shipped with this installed package, keeping KV, config, and secrets.
  // Pairs with `npm update -g pagevault`: update the package for new code, then `pagevault upgrade`.
  //
  // `--analytics` / `--no-analytics` ride along because this is the command a CI-deployed operator
  // actually has — flags reach provisioning, which otherwise takes view tracking from the declared
  // intent and then from what the live Worker already binds (#187).
  const { deploy } = await import("../lib/provision/deploy.mjs");
  await deploy({ bundle: true, flags });
}

// The operator commands — diagnostics and teardown for YOUR deployment. Each is the same engine
// `make status`/`verify`/`health`/`destroy` run (one engine, two front doors, ADR-014): the logic
// lives in ../lib/ops, dynamic-imported so the document commands above load none of it. They
// auto-target this install's deployment from ~/.pagevault/ state — zero config, like verify/health
// already were behind `make`.

async function status(flags) {
  const { statusCmd } = await import("../lib/ops/status.mjs");
  await statusCmd({ json: flags.json === true, flags });
}

async function verify(flags) {
  const { verifyCmd } = await import("../lib/ops/verify.mjs");
  await verifyCmd({ json: flags.json === true });
}

async function health(flags) {
  const { healthCmd } = await import("../lib/ops/health.mjs");
  await healthCmd({ json: flags.json === true, flags });
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
  pagevault init [--yes] [--cf-token <t>]   stand PageVault up on your own Cloudflare account (no repo)
                                --cf-token is the CLOUDFLARE token (login --token is the PageVault one)
  pagevault upgrade [--yes]           redeploy the bundled Worker (after 'npm update -g pagevault')
  pagevault login [--url <url>] [--token <token>] [--as <name>] [--protected]
                                point at a deployment (falls back to env; init does this)
                                --as registers it by name so several can coexist
                                --protected makes ${PROTECTED_COMMANDS.join("/")} require --yes there

Several deployments on one machine:
  pagevault deployments [--json]      everything this machine can reach; * is the default
  pagevault use <name>                make one the default
                                any command: --deployment <name>, or PAGEVAULT_DEPLOYMENT
                                standing in a checkout always selects that checkout's deployment

Publish & manage documents:
  pagevault publish <file.html|.md> [--portal s] [--name f] [--title t] [--summary s]
                                [--tags a,b] [--emails a@b,c@d] [--source-kind html|markdown]
                                [--public] [--owner-only] [--confirm]
                                --name sets the update key (default: the filename); --title is display only
  pagevault list [--portal s] [--tag t] [--json]
  pagevault read <id> [--source] [--json]
  pagevault edit <id> [--name f] [--title t] [--summary s] [--tags a,b]
                                fix a published document's filename/title; --name moves its URL
  pagevault link <id>                 print the shareable URL to stdout (| pbcopy)
  pagevault search <portal> <query …> [--limit N] [--json]
  pagevault mint <id>                 mint a public /p/ link for an existing document
  pagevault revoke <id> [--yes]       kill a document's public link (keeps the document)
  pagevault rotate <id> [--yes]       replace the public link with a fresh one
                                --yes is required only on a deployment marked protected
  pagevault rm <id> [--yes]           delete the document (there is no undo)
  pagevault export [dir] [--portal s] [--include-drafts] [--zip]

Portals — the client boundary; permissions live here, not on the document:
  pagevault portals [--json]          list your portals
  pagevault portal-create <slug> [--name "Acme Corp"] [--kind private|restricted|public]
                                [--description "…"]
  pagevault share <portal> <email> [email …]        grant access to everything in it
  pagevault share <portal> --remove a@b,c@d         revoke it
  pagevault portal-delete <slug> [--cascade] [--yes]  delete it; --cascade takes the documents too
  pagevault pin <filename> [--top|--bottom|--up|--down|--to <n>]   lead the index with it
  pagevault unpin <filename>          back to newest-first

Operate your deployment:
  pagevault status [--json]           what this install is configured for (local, no network)
  pagevault verify [--json]           smoke-test the live deployment (run after init/upgrade)
  pagevault health [--json]           assert /health reports the version you shipped
  pagevault sync-access [--reap] [--yes] [--json]  reconcile the Access viewer group with KV
  pagevault views [--days 30] [--portal s] [--doc id] [--json]  which documents were opened
  pagevault sync-views [--days 90] [--reset]        make those counts durable — run it on a schedule
  pagevault backup [--out <file.json>]  snapshot KV — same-host disaster recovery
  pagevault restore <file.json> [--force]  replay a backup (never deletes; asks first)
  pagevault destroy [--keep-data]     tear the deployment down (asks; irreversible)

Any command: pagevault <command> --help   for its flags and what they do.
Config: PAGEVAULT_URL / PAGEVAULT_API_TOKEN, or ~/.pagevault/config.json (written by init/login),
or ~/.pagevault/deployments.json for named deployments (written by login --as / use).
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
  // `views --sync` predates `sync-views` and still works. It is kept rather than cut because it is
  // in the docs, in muscle memory, and quite possibly in someone's crontab — and a scheduled sync
  // that starts failing silently is precisely the failure ADR-023 §9 exists to prevent. The notice
  // goes to stderr, so a `--json` pipe is unaffected.
  if (flags.sync !== undefined) {
    // No colour helper here on purpose: it lives in provision/context.mjs, which the document
    // commands dynamic-import precisely so the lean client stays lean. A deprecation note is not
    // worth loading the provisioning tree.
    note("Note: `views --sync` is now `pagevault sync-views` — same flags, same behaviour.");
    note("      The old form keeps working; the new one reads correctly in a crontab.");
    return syncViews(flags);
  }

  // 🔴 The stored summary is the DEFAULT read (ADR-025, #168). It needs no Cloudflare credential
  // and no account id — just the deployment bearer every other command already uses — and since
  // ADR-023 it accumulates, so it answers for history older than the 90 days a live query can see.
  //
  // `--live` is the opt-in for the other question: did THIS person open it, and what has happened
  // since the last sync. `--who` implies it, because identities exist nowhere else — the summary
  // has never held one (ADR-019 §4).
  const live = flags.live === true || flags.who === true;
  if (!live) {
    // `--by` is summary-only. `--live` answers a different question — did THIS person open it — and
    // breakdowns over it were deliberately left out (ADR-025 §3): `queryBuckets` exists, but nobody
    // has asked for them, and offering the flag on both paths would imply the two produce the same
    // numbers over the same history. They do not; the summary reaches further back.
    const BY = ["doc", "portal", "day", "surface", "referrer"];
    const by = flags.by ?? "doc";
    if (!BY.includes(by)) {
      throw new PvError(`--by ${by} is not a breakdown. Use one of: ${BY.join(", ")}.`);
    }
    if (flags.account) {
      throw new PvError(
        "--account applies to the live Analytics Engine query, which is not what this reads.\n\n" +
          "The stored summary comes from the deployment itself, so there is no account to name.\n" +
          "  pagevault views --live --account <id>",
      );
    }
    const cfg = commandTarget(flags);
    const params = new URLSearchParams();
    if (flags.days) params.set("days", String(flags.days));
    if (flags.portal) params.set("portal", flags.portal);
    if (flags.doc) params.set("doc", flags.doc);
    if (flags.group) {
      if (!["day", "week", "month"].includes(flags.group)) {
        throw new PvError(`--group must be day, week or month, got "${flags.group}".`);
      }
      params.set("group", flags.group);
    }
    let rolled;
    try {
      rolled = await api(cfg, "GET", `/views/summary?${params}`);
    } catch (err) {
      // 🔴 A CLI newer than the deployment it is talking to. This is the ORDINARY case, not an edge
      // one: the package ships on npm independently of any deploy (ADR-010), so every
      // `npm update -g pagevault` produces it until the operator upgrades the Worker. A raw
      // "405 method_not_allowed" would read as a broken deployment rather than an out-of-date one.
      if (err.code === "method_not_allowed") {
        throw new PvError(
          `${cfg.url} is running a version of PageVault that cannot serve view history.\n\n` +
            "Reading the stored summary arrived in 0.36.0. This CLI asks for it by default; that\n" +
            "deployment only accepts the write half.\n\n" +
            "  pagevault upgrade         bring the deployment up to this CLI\n" +
            "  pagevault views --live    query Analytics Engine instead (needs a Cloudflare token)",
        );
      }
      throw err;
    }
    // `--json` carries the WHOLE rollup, not just the requested breakdown: every breakdown is
    // already computed, and a consumer that has to re-request for a second view of the same window
    // would be paying twice for one aggregation.
    if (flags.json) return out(JSON.stringify(rolled, null, 2));
    return note(formatRollup(rolled, null, { by }));
  }

  const { loadCloudToken } = await import("../lib/provision/context.mjs");

  // 🔴 The account to query is THIS deployment's — not whichever build record happens to be nearest
  // the working directory. Standing in the checkout that provisioned `test` and running
  // `views --live --deployment prod` read TEST's Analytics Engine and printed the answer under
  // prod's name: a cross-deployment read, silent, and indistinguishable from the real thing (#167).
  // `sync-views` has been guarded since ADR-021 phase 2 because writing the wrong summary is
  // obviously bad; reading the wrong one and believing it is not obviously better.
  //
  // Resolved only when `--account` did not settle it, so `views --live --account <id>` still works
  // on a machine with no deployment configured at all — which is the one case that has no target to
  // resolve. `commandTarget` also announces which deployment was chosen, which this path never did.
  let accountId = flags.account;
  if (!accountId) {
    const cfg = commandTarget(flags);
    // `record` is null when it describes a different deployment, so this cannot inherit a foreign
    // account id. No record and no --account leaves it undefined, and `queryViews` refuses with the
    // message that names `--account` as the escape hatch.
    accountId = cfg.target.provisioned ? cfg.target.record?.accountId : undefined;
  }

  const creds = { accountId, token: process.env.CLOUDFLARE_API_TOKEN || loadCloudToken() };

  let result;
  let sources;
  try {
    result = await queryViews(creds, { days: flags.days, portal: flags.portal, doc: flags.doc, limit: flags.limit });
    // Skipped under --doc: referrers aggregate per portal (ADR-023, decision 5), so filtering to
    // one document would print a portal's whole traffic under that document's heading. Not a
    // narrower answer — a wrong one.
    if (!flags.doc) sources = await queryReferrers(creds, { days: flags.days, portal: flags.portal });
  } catch (err) {
    // ViewsError messages are written to be read, not debugged. Re-wrap so the CLI prints the
    // message plainly instead of a stack.
    throw new PvError(err.message);
  }

  // The table is human output, so it goes to stderr like every other table here. --json is the
  // pipe: `pagevault views --json | jq` should carry data and nothing else.
  if (flags.json) return out(JSON.stringify(sources ? { ...result, sources: sources.sources } : result, null, 2));

  note(formatViews(result, null));
  const referrers = sources ? formatReferrers(sources, null) : "";
  if (referrers) note(`\n${referrers}`);
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
      throw new PvError(`--${flag} cannot be combined with sync-views — the summary covers the whole deployment or it is wrong.`);
    }
  }

  const { loadContext, loadCloudToken } = await import("../lib/provision/context.mjs");
  const ctx = loadContext();
  // Before spending a Cloudflare query: the account we are about to read and the deployment we are
  // about to write to must be the same deployment.
  const target = resolveWriteTarget(flags, "sync-views");

  // 90 days, not the table's 30. "Have they ever opened it" is a lifetime question, and Analytics
  // Engine retains about three months — so a sync takes the whole window it can still see.
  const days = Number(flags.days ?? 90);
  // Rows are grouped per (portal, doc, surface, viewer, kind, DAY) now, so one document is one row
  // per day it was opened rather than one row overall — plus the portal-index rows, which
  // `summarizeViews` drops but which still arrive and still count against this limit.
  const limit = Number(flags.limit ?? 10000);

  const creds = { accountId: flags.account || ctx.accountId, token: process.env.CLOUDFLARE_API_TOKEN || loadCloudToken() };
  const syncedAt = new Date().toISOString();

  let result;
  let sources;
  try {
    result = await queryBuckets(creds, { days, limit, now: syncedAt });
    // Dated, for the series the Worker now stores per portal per day (#221). The limit is higher
    // than the undated query's because the same hosts recur across days — 200 rows is a handful of
    // sites, not a handful of site-days.
    sources = await queryReferrers(creds, { days, limit: 2000, byDay: true });
  } catch (err) {
    throw new PvError(err.message);
  }

  // What still exists, so the summary skips ids this deployment never created (#129). A document
  // it HAS seen and since revoked keeps its history — the Worker merges by window and never
  // deletes an entry it merely did not hear about (ADR-023 decision 4).
  const { docs = [] } = await api(target, "GET", "/docs");
  const knownIds = new Set(docs.map((d) => d.id));

  // 🔴 The owner address never leaves this machine. It is read here to bucket a view as yours or
  // the client's, and then dropped — the Worker receives counts, never the address (ADR-023 §7).
  // Where this machine does not hold a build record, `ownerEmail` is empty and the split is
  // ABSENT rather than guessed, which the Worker reads as "not measured" rather than as zero.
  const { summary, skipped } = summarizeViews(result, { syncedAt, knownIds, ownerEmail: ctx.ownerEmail ?? "" });
  // Both shapes, deliberately. `refs` is what this Worker will use; `portals` keeps a Worker older
  // than #221 reporting something it understands rather than an empty Sources panel. The undated
  // one is derived from the same dated rows, so they cannot disagree.
  summary.refs = summarizeReferrersByDay(sources);
  summary.portals = summarizeReferrers(sources);

  // `--reset` is the one named destructive path (ADR-023 §3). Append-only with no way out is how a
  // bad history becomes permanent — but it discards every bucket older than this window, which
  // Analytics Engine can no longer restate, so it asks first.
  const reset = flags.reset === true;
  if (reset && flags.yes !== true && !(await confirmReset(target))) {
    return note("Cancelled — nothing was written.");
  }

  const res = await api(target, "POST", `/views/summary${reset ? "?reset=true" : ""}`, summary);

  // A truncated query would under-report views as confidently as a complete one, so say it.
  const counted = Object.keys(summary.docs).length;
  const total = Object.values(summary.docs).reduce(
    (n, history) => n + Object.values(history).reduce((m, b) => m + (b.link ?? 0) + (b.pub ?? 0) + (b.portal ?? 0), 0),
    0,
  );

  if (flags.json) return out(JSON.stringify({ ...res, skipped, truncated: result.truncated }, null, 2));

  note(
    [
      `Synced ${plural(counted, "document")} · ${plural(total, "view")} · ${result.coverage.from} to ${result.coverage.to}.`,
      ...(reset ? ["History was reset — everything before this window is gone."] : []),
      ...(skipped.length
        ? [`Skipped ${plural(skipped.length, "document")} this deployment never created — the dataset outlives deployments.`]
        : []),
      ...(result.truncated
        ? [`⚠ Hit the ${limit}-row query limit, so the summary may be incomplete. Narrow it with --days.`]
        : []),
      ...(ctx.ownerEmail ? [] : ["No owner address on this machine, so views are not split into yours and the client's."]),
      // The invariant, stated at the one moment the operator has just satisfied it (ADR-023 §9).
      // Saying it here is what makes the next miss a lapse rather than a surprise.
      `Captured through ${result.coverage.to}. Sync again within 90 days or the tail ages out uncovered.`,
      `read_document and list_documents now report these over MCP, as of the sync — not live.`,
    ].join("\n"),
  );
}

/**
 * `--sync --reset` throws away history Analytics Engine cannot restate. Typed confirmation, not
 * y/N: this is the one command here whose damage is unrecoverable, and it should feel like it.
 */
async function confirmReset(target) {
  if (!stdin.isTTY) {
    throw new PvError("--sync --reset needs a terminal to confirm, or --yes to skip the prompt.");
  }
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    note(`This deletes every stored view bucket for ${target.url} and rebuilds from the last 90 days.`);
    note("Anything older than that is not in Analytics Engine any more and will not come back.");
    const answer = await rl.question("Type the deployment URL to confirm: ");
    return answer.trim() === target.url;
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  note(err instanceof PvError ? `✗ ${err.message}` : `✗ ${err.stack || err}`);
  process.exit(1);
});
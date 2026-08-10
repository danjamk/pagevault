#!/usr/bin/env node
//
// make check-docs — fail the build when the docs describe something the code doesn't do.
//
// Every check here compares prose against something authoritative in the tree. Nothing is a style
// opinion: a failure means a document makes a claim the code contradicts. Style, tone and the
// banned-phrase list are a human's job and deliberately absent.
//
// This exists because the drift kept being found by hand, late. A single audit turned up a product
// page advertising a route the Worker has never served, a feature tour advertising two features
// that were never built, and `verify` asserting nine MCP tools against a Worker that registers
// twelve. All four were mechanical, and all four survived months of reading.
//
// Zero dependencies. Node built-ins only, like the rest of scripts/.
//
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";

const ROOT = process.cwd();
const findings = [];
const add = (check, file, detail) => findings.push({ check, file, detail });

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git" || e === "dist" || e.startsWith(".")) continue;
    const p = join(dir, e);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

const all = walk(ROOT);
const read = (f) => readFileSync(f, "utf8");
const rel = (f) => relative(ROOT, f);
const prose = all.filter(
  (f) => f.endsWith(".md") && (f.includes(`${ROOT}/docs/`) || /\/(README|CONTRIBUTING|CLAUDE|CHANGELOG)\.md$/.test(f)),
);

// GitHub's heading-slug rule: strip formatting and punctuation, lowercase, then replace EACH space
// with a hyphen. "Walking away — a human-readable export" keeps the DOUBLE hyphen the em dash
// leaves behind. A slugifier that collapses whitespace reports false positives on every heading
// with an em dash, which is most of them in this repo.
const slug = (h) =>
  h
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/ /g, "-");

const anchors = new Map(
  prose.map((f) => [rel(f), new Set([...read(f).matchAll(/^#{1,6}\s+(.*)$/gm)].map((m) => slug(m[1])))]),
);

// --- 1 · internal links and anchors resolve ---------------------------------------------------
for (const f of prose) {
  for (const [, target] of read(f).matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:)/.test(target) || target.startsWith("../../issues")) continue;
    const [path, frag] = target.split("#");
    const dest = path ? resolve(dirname(f), path) : f;
    if (path && !existsSync(dest)) { add("link", rel(f), `missing file → ${target}`); continue; }
    const key = rel(dest);
    if (frag && anchors.has(key) && !anchors.get(key).has(slug(frag))) {
      add("anchor", rel(f), `missing anchor → ${target}`);
    }
  }
}

// --- 2 · every documented `make X` is a real target --------------------------------------------
const targets = new Set([...read(join(ROOT, "Makefile")).matchAll(/^([a-z][\w-]*):.*##/gm)].map((m) => m[1]));
for (const f of prose) {
  for (const [, t] of read(f).matchAll(/`make ([a-z][\w-]*)/g)) {
    if (!targets.has(t)) add("make", rel(f), `no such target → make ${t}`);
  }
}

// --- 3 · every CLI command appears in the reference ---------------------------------------------
const commands = new Set([...read(join(ROOT, "cli/bin/pagevault.mjs")).matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]));
const REF = "docs/setup/cli-reference.md";
// Headings group related commands — "### `pagevault mint <id>` · `revoke <id>` · `rotate <id>`"
// documents three. Match the bare name too, or the last two read as undocumented.
const refHeadings = [...read(join(ROOT, REF)).matchAll(/^#{2,4}\s+(.*)$/gm)].map((m) => m[1]).join("\n");
for (const cmd of [...commands].sort()) {
  if (!new RegExp(`\`(?:pagevault )?${cmd}\\b`).test(refHeadings)) add("cli", REF, `undocumented command → ${cmd}`);
}

// --- 4 · the MCP tool list the Worker registers is the one we check and document ----------------
// `cli/mcp-tools.test.mjs` pins EXPECTED_MCP_TOOLS to the Worker. This covers the docs side.
const registered = [...read(join(ROOT, "worker/src/mcp.ts")).matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
if (registered.length < 10) add("mcp", "worker/src/mcp.ts", "could not parse registerTool calls — this check has gone blind");
const CONNECT = "docs/setup/connect-mcp.md";
const connectText = read(join(ROOT, CONNECT));
for (const t of registered) if (!connectText.includes(t)) add("mcp", CONNECT, `undocumented tool → ${t}`);

// --- 5 · docs never name a route the Worker doesn't serve ---------------------------------------
const workerSrc = all.filter((f) => f.startsWith(join(ROOT, "worker/src"))).map(read).join("\n");
const liveRoots = new Set([...workerSrc.matchAll(/["'`](\/[a-z]+)/g)].map((m) => m[1]).filter((p) => p.length > 1));
// Repo directories and doc paths share the shape of a route and are not one. Nor do FILESYSTEM
// paths: `scheduling-the-sync.md` carries launchd and systemd snippets, and neither format expands
// `~` or `$HOME` — a plist's ProgramArguments must be a literal absolute path, so `/Users/…` and
// `/home/…` appear in docs that are correct precisely because they are absolute. `DTDs` comes from
// the Apple DOCTYPE every plist starts with.
const NOT_ROUTES = new Set(["docs", "setup", "adr", "design", "cli", "lib", "src", "test", "worker",
  "scripts", "examples", "images", "brand", "com", "org", "io", "dev", "en", "main", "blob", "tree",
  "Users", "home", "tmp", "DTDs"]);
for (const f of [...prose, join(ROOT, "docs/index.html")]) {
  // ADRs and shipped plans are point-in-time records; a route they named is history, not a claim.
  if (!existsSync(f) || rel(f).startsWith("docs/adr/") || rel(f).includes("implementation/")) continue;
  const text = read(f);
  const hits = [
    ...[...text.matchAll(/[\s"'`(>]\/([a-z]{1,6})\/[a-z{]/gi)].map((m) => m[1]),
    // Also catch host-relative paths — `share.example.com/d/rp92xk`. The dead /d/ route hid from a
    // scan that only looked for a leading slash.
    ...[...text.matchAll(/([a-z0-9.-]+\.[a-z]{2,})\/([a-z]{1,6})\/[a-z{]/gi)]
      .filter(([, host]) => !/(shields|github|githubusercontent|cloudflare|npmjs|claude|anthropic|keepachangelog|semver|google)\./i.test(host))
      .map((m) => m[2]),
  ];
  for (const seg of new Set(hits)) {
    if (NOT_ROUTES.has(seg) || liveRoots.has(`/${seg}`)) continue;
    add("route", rel(f), `route not served by the Worker → /${seg}/…`);
  }
}

// --- report -------------------------------------------------------------------------------------
const byCheck = findings.reduce((m, f) => ((m[f.check] ??= []).push(f), m), {});
for (const [check, list] of Object.entries(byCheck)) {
  console.error(`\n${check.toUpperCase()} — ${list.length}`);
  const seen = new Set();
  for (const f of list) {
    const k = `${f.file}|${f.detail}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.error(`  ${f.file}: ${f.detail}`);
  }
}
if (findings.length) {
  console.error(`\n✗ ${findings.length} finding(s) — a document says something the code does not do.\n`);
  process.exitCode = 1;
} else {
  console.log("✓ docs agree with the code (links, make targets, CLI commands, MCP tools, routes)");
}

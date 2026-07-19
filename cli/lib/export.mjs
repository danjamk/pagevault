//
// `pagevault export` — walk a deployment over /api and write a browsable folder tree: one folder
// per portal, each document as a standalone file, plus `_portal.json` per folder, `ACCESS.md` at
// the root, and a linking `index.html`. The "my stuff is real and I can leave with it" artifact.
//
// Intentionally lossy and NOT a restore format (that's #34): document ids and public tokens are
// omitted — id stability only matters when restoring, and if you're leaving, your URLs change.
//
// Assembly is CLI-side over existing /api GETs (see docs/engineering/implementation/EXPORT_PLAN.md
// for why not a console button): it keeps the Worker thin, streams doc-by-doc to disk, and honors
// canView() for free since every byte comes through /api under the bearer token. Zero dependencies.
//
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { api, PvError } from "./client.mjs";

// ── Pure helpers (unit-tested in cli/export.test.mjs) ────────────────────────────────────────

// Names Windows refuses as a filename, regardless of extension.
const WIN_RESERVED = new Set(
  ["con", "prn", "aux", "nul"].concat(
    Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
    Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
  ),
);

/**
 * A conservative filesystem slug for a document title: transliterate accents, drop emoji and
 * anything non-`[a-z0-9]`, collapse to single hyphens, cap the length. Empty (an emoji-only
 * title) becomes `untitled`; a Windows reserved word gets a suffix so it's a legal filename
 * everywhere. Portal folders don't pass through here — a portal slug is already a valid slug.
 */
export function slugify(name) {
  const base = String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, ""); // a hyphen left dangling by the slice
  const slug = base || "untitled";
  return WIN_RESERVED.has(slug) ? `${slug}-doc` : slug;
}

/**
 * `{date}-{slug}.{ext}`, made unique within a folder. Two documents with the same title on the
 * same day would otherwise overwrite each other — the second (and beyond) gets a short id suffix.
 * Mutates `taken` so repeated calls keep converging on distinct names.
 */
export function uniqueFilename(taken, date, slug, ext, id) {
  let name = `${date}-${slug}.${ext}`;
  if (taken.has(name)) name = `${date}-${slug}-${String(id).slice(0, 6)}.${ext}`;
  // Belt and suspenders: if even that clashes, keep widening the id slice.
  let n = 8;
  while (taken.has(name)) name = `${date}-${slug}-${String(id).slice(0, n++)}.${ext}`;
  taken.add(name);
  return name;
}

/**
 * One human-readable line describing who can open a document — the whole point of ACCESS.md.
 * Built from the portal floor plus the document's additive grants; a draft short-circuits it,
 * matching canView()'s one narrowing rule. Reads meta.extraEmails/publicToken, which is why the
 * export does a per-doc GET and never trusts list metadata (DocSummary omits both by design).
 */
export function accessLabel(kind, meta) {
  if (meta.ownerOnly) return "Draft — owner-only, not visible to the client";
  const parts = [];
  if (kind === "public") parts.push("Public — no login required");
  else if (kind === "restricted") parts.push("Portal members");
  else parts.push("Owner only"); // private
  if (meta.publicToken) parts.push("public link (anyone with the URL)");
  if (meta.extraEmails?.length) parts.push(`also shared with ${meta.extraEmails.join(", ")}`);
  return parts.join(" · ");
}

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const day = (iso) => String(iso ?? "").slice(0, 10);

/** `_portal.json` for one folder — name, kind, members, timestamps. No slug-internal ids. */
export function portalJson(portal) {
  return JSON.stringify(
    {
      slug: portal.slug,
      name: portal.name,
      kind: portal.kind,
      description: portal.description ?? "",
      members: portal.members ?? [],
      createdAt: portal.createdAt,
      updatedAt: portal.updatedAt,
    },
    null,
    2,
  );
}

/** The root `ACCESS.md` — the permissions you can actually look at, per portal and per document. */
export function renderAccessMd(snapshot) {
  const lines = [
    "# Access — who can see what",
    "",
    `Exported from ${snapshot.generatedFrom} on ${snapshot.date}.`,
    "",
    snapshot.includeDrafts
      ? "Owner-only drafts are included below and marked as such."
      : "Owner-only drafts are excluded from this export (`--include-drafts` to include them).",
    "",
  ];
  for (const p of snapshot.portals) {
    lines.push(`## ${p.name}  (${p.kind})`);
    lines.push("");
    lines.push(`Folder: \`${p.slug}/\``);
    lines.push(
      p.kind === "restricted"
        ? `Members (${p.members.length}): ${p.members.join(", ") || "(none)"}`
        : p.kind === "public"
          ? "Members: n/a — anyone can view, no login."
          : "Members: n/a — owner only.",
    );
    lines.push("");
    if (!p.docs.length) {
      lines.push("_No documents._", "");
      continue;
    }
    for (const d of p.docs) {
      lines.push(`- **${d.title}** — ${accessLabel(p.kind, d.meta)}  \`${d.filename}\``);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/** `index.html` — plain links, no framework, no build step. Opens in any browser. */
export function renderIndexHtml(snapshot) {
  const sections = snapshot.portals
    .map((p) => {
      const items = p.docs
        .map(
          (d) =>
            `      <li><a href="./${esc(p.slug)}/${esc(d.filename)}">${esc(d.title)}</a>` +
            ` <span class="meta">${esc(day(d.meta.createdAt))} · ${esc(accessLabel(p.kind, d.meta))}</span></li>`,
        )
        .join("\n");
      return (
        `    <section>\n      <h2>${esc(p.name)} <span class="kind">${esc(p.kind)}</span></h2>\n` +
        (p.docs.length ? `    <ul>\n${items}\n    </ul>` : "    <p class=\"empty\">No documents.</p>") +
        `\n    </section>`
      );
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PageVault export — ${esc(snapshot.date)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 48rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; }
  .sub { color: #6b7280; margin-top: 0; }
  section { margin: 2rem 0; }
  h2 { font-size: 1.15rem; border-bottom: 1px solid #8883; padding-bottom: .3rem; }
  .kind { font-size: .7rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; }
  ul { list-style: none; padding: 0; }
  li { padding: .35rem 0; }
  .meta { display: block; font-size: .8rem; color: #6b7280; }
  .empty { color: #6b7280; font-style: italic; }
  a { color: #2f6fed; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <h1>PageVault export</h1>
  <p class="sub">${esc(snapshot.generatedFrom)} · ${esc(snapshot.date)} · see <a href="./ACCESS.md">ACCESS.md</a> for permissions</p>
${sections}
</body>
</html>
`;
}

// ── Orchestration (exercised against a live deployment, not unit tests) ───────────────────────

/**
 * Fetch everything from `/api`, assemble the snapshot, write the tree, optionally zip. `note` is
 * the progress sink (stderr in the CLI). Returns a small summary for the caller to report.
 */
export async function buildExport(cfg, opts, note = () => {}) {
  const { outDir, portal: onlyPortal, zip = false, includeDrafts = false } = opts;

  if (existsSync(outDir) && readdirSync(outDir).length) {
    throw new PvError(`Refusing to write into non-empty directory ${outDir} — remove it or pick another path.`);
  }

  const date = new Date().toISOString().slice(0, 10);
  const { portals: allPortals = [] } = await api(cfg, "GET", "/portals");
  const portals = onlyPortal ? allPortals.filter((p) => p.slug === onlyPortal) : allPortals;
  if (onlyPortal && !portals.length) throw new PvError(`No such portal: ${onlyPortal}`);

  const snapshot = { generatedFrom: cfg.url, date, includeDrafts, portals: [] };
  let docCount = 0;
  let skippedDrafts = 0;

  for (const base of portals) {
    // Per-portal GET carries the member list; the summary list gives us the doc ids.
    const [detail, { docs: summaries = [] }] = await Promise.all([
      api(cfg, "GET", `/portals/${encodeURIComponent(base.slug)}`),
      api(cfg, "GET", `/docs?portal=${encodeURIComponent(base.slug)}`),
    ]);
    const portal = { ...base, members: detail.members ?? [], docs: [] };
    const taken = new Set();

    for (const s of summaries) {
      if (s.ownerOnly && !includeDrafts) {
        skippedDrafts++;
        continue;
      }
      // Full meta for the sharing state that list metadata omits, then the body bytes.
      const meta = await api(cfg, "GET", `/docs/${encodeURIComponent(s.id)}`);
      const raw = await rawBody(cfg, s.id);
      const ext = meta.sourceKind === "markdown" ? "md" : "html";
      const filename = uniqueFilename(taken, day(meta.createdAt), slugify(meta.title), ext, meta.id);
      portal.docs.push({ title: meta.title, filename, meta, raw });
      docCount++;
    }

    snapshot.portals.push(portal);
    note(`  ${portal.slug}: ${portal.docs.length} document${portal.docs.length === 1 ? "" : "s"}`);
  }

  writeTree(outDir, snapshot);
  note(
    `Wrote ${docCount} document${docCount === 1 ? "" : "s"} across ${snapshot.portals.length} portal` +
      `${snapshot.portals.length === 1 ? "" : "s"} to ${outDir}` +
      (skippedDrafts ? ` (${skippedDrafts} draft${skippedDrafts === 1 ? "" : "s"} skipped)` : ""),
  );

  let zipPath = null;
  let zipSkipped = false;
  if (zip) ({ zipPath, zipSkipped } = zipDir(outDir, note));

  return { outDir, docCount, portalCount: snapshot.portals.length, skippedDrafts, zipPath, zipSkipped };
}

/** Fetch a document body as text. /api/docs/{id}/raw returns bytes, not JSON. */
async function rawBody(cfg, id) {
  const res = await fetch(`${cfg.url}/api/docs/${encodeURIComponent(id)}/raw`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok) throw new PvError(`Could not read body for ${id} (HTTP ${res.status})`);
  return await res.text();
}

function writeTree(outDir, snapshot) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "index.html"), renderIndexHtml(snapshot));
  writeFileSync(join(outDir, "ACCESS.md"), renderAccessMd(snapshot));
  for (const p of snapshot.portals) {
    const dir = join(outDir, p.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "_portal.json"), `${portalJson(p)}\n`);
    for (const d of p.docs) writeFileSync(join(dir, d.filename), d.raw);
  }
}

/** Zip the folder with the system `zip`. No archive writer ships with Node, and the CLI takes no
 *  dependencies — so if `zip` isn't installed we leave the folder and say so, rather than fail. */
function zipDir(outDir, note) {
  const parent = dirname(outDir) || ".";
  const name = basename(outDir);
  const zipPath = `${outDir}.zip`;
  const res = spawnSync("zip", ["-r", "-q", `${name}.zip`, name], { cwd: parent });
  if (res.error?.code === "ENOENT") {
    note(`Note: \`zip\` not found — left the folder at ${outDir}. Zip it yourself, or drop --zip.`);
    return { zipPath: null, zipSkipped: true };
  }
  if (res.status !== 0) throw new PvError(`zip failed (exit ${res.status}).`);
  note(`Zipped to ${zipPath}`);
  return { zipPath, zipSkipped: false };
}

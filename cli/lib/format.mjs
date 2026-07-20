//
// Pure parsing + presentation helpers for the CLI. Kept out of the bin (which runs on import)
// so they're unit-testable without side effects, and out of the HTTP client so a reused client
// doesn't drag terminal formatting along. No dependencies.
//

/**
 * A tiny argv parser: positionals plus `--flag value` and bare `--bool`. A flag whose next token
 * is another `--flag` (or absent) is boolean `true`. Enough for this CLI; not a framework.
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/** A comma-separated flag value → trimmed non-empty items, or undefined if not a string. */
export function splitList(value) {
  if (typeof value !== "string") return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

/**
 * A title for a document that had none passed. Prefer the HTML's own <title>; fall back to the
 * filename without its extension. This is what makes `pagevault publish report.html` work with
 * no flags — prime directive #3.
 */
export function deriveTitle(html, filename) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  if (m && m[1].trim()) return m[1].trim();
  // Markdown has no <title>; use its first ATX heading (`# ...`) when there is one.
  const h1 = /^\s{0,3}#\s+(.+?)\s*#*\s*$/m.exec(html);
  if (h1 && h1[1].trim()) return h1[1].trim();
  const base = String(filename).split(/[/\\]/).pop() || "document";
  return base.replace(/\.[^.]+$/, "") || base;
}

/**
 * The document format for `pagevault publish`. An explicit `--source-kind` wins; otherwise infer
 * from the extension — `.md`/`.markdown` → markdown, everything else → html. The Worker renders
 * markdown to HTML at publish (#46) and keeps the original `.md` as the raw source, so
 * `pagevault publish report.md` just works — prime directive #3.
 */
export function sourceKindFor(filename, override) {
  if (override === "markdown" || override === "html") return override;
  return /\.(md|markdown)$/i.test(String(filename)) ? "markdown" : "html";
}

/** Truncate to `n` chars with an ellipsis, so a table column stays aligned. */
export function truncate(s, n) {
  const str = String(s ?? "");
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

/**
 * Render rows as a left-aligned column table (a header row plus data). Returns the string; the
 * caller decides where it goes. Column widths size to content.
 */
export function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (cells) => cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}
#!/usr/bin/env node
//
// make check-console — parse every inline <script> the Worker emits, as JavaScript.
//
// The Worker ships its UI as HTML built from TypeScript template literals: the owner console, the
// viewer shell, the portal page. That means roughly 45KB of browser JavaScript lives inside
// strings, where `tsc` has nothing to say about it. A missing brace, a bad escape, a stray
// backtick — all of it is valid *string content*, and the first sign is a blank page.
//
// This was written after exactly that: a backtick inside a comment inside `page()` terminated the
// template early. tsc did flag it, but as "';' expected" pointing at the comment — not at "you
// just ended a 39,000-character string." Nothing pointed at the console being unrenderable.
//
// Two traps this had to survive, both of which produced a confidently wrong pass on first attempt:
//
//   1. console.ts emits TWO scripts (a theme bootstrap and the app). Matching only the first
//      "passed" on 279 characters and reported success.
//   2. The file holds the UNEVALUATED template: `\\]` in source is `\]` at runtime. Parsing the
//      raw text reports regex errors that do not exist in the shipped script.
//
// Hence the floor check at the bottom: a run that finds implausibly little is a failure, not a
// pass. A check that cannot fail is worse than no check, because it gets believed.
//
// Zero dependencies. Node built-ins only, like the rest of scripts/.
//
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = "worker/src";
// Every script we expect to find, so a refactor that stops emitting one is visible rather than
// silently shrinking the check's coverage.
const MIN_SCRIPTS = 6;
const MIN_CONSOLE_APP_CHARS = 10000;

const findings = [];
let checked = 0;
let consoleAppChars = 0;

/** Byte offset → 1-based line number in the source file. */
const lineAt = (text, offset) => text.slice(0, offset).split("\n").length;

/**
 * Evaluate a template-literal body: real escape handling, interpolations stubbed. Returns null
 * (and records a finding) when the body is not a well-formed template — which is what an
 * unescaped backtick looks like from here.
 */
function evaluateTemplate(raw, where) {
  const stubbed = raw.replace(/\$\{[\s\S]*?\}/g, "__pv__");
  try {
    return new Function("__pv__", "return `" + stubbed + "`")("X");
  } catch (err) {
    // Overwhelmingly the cause, and the reason this script exists.
    const bare = (stubbed.match(/(^|[^\\])`/g) ?? []).length;
    const hint = bare > 0
      ? `${bare} unescaped backtick(s) in the script body — a backtick inside the template literal ends it early`
      : `not a well-formed template literal (${err.message})`;
    findings.push({ where, detail: hint });
    return null;
  }
}

for (const name of readdirSync(SRC).filter((f) => f.endsWith(".ts")).sort()) {
  const path = join(SRC, name);
  const text = readFileSync(path, "utf8");

  for (let i = text.indexOf("<script"); i >= 0; i = text.indexOf("<script", i + 1)) {
    const tagEnd = text.indexOf(">", i);
    const close = text.indexOf("</script>", tagEnd);
    if (tagEnd < 0 || close < 0) continue;

    const tag = text.slice(i, tagEnd + 1);
    let body = text.slice(tagEnd + 1, close);
    const where = `${path}:${lineAt(text, i)}`;

    // <script src="…"></script> loads a file; there is nothing inline to parse.
    if (/\ssrc=/.test(tag) && body.trim() === "") continue;
    // A mention inside a line comment, not an emitted tag — `// Raw HTML/<script> passes through`.
    // Anywhere before it on the line counts, not just the line start.
    if (text.slice(text.lastIndexOf("\n", i) + 1, i).includes("//")) continue;

    // A body that is exactly one interpolation (`${MERMAID_INIT}`) holds no inline source of its
    // own — resolve the constant from this file so the check still sees the real JavaScript.
    const only = body.trim().match(/^\$\{([A-Za-z_$][\w$]*)\}$/);
    if (only) {
      const decl = new RegExp("const\\s+" + only[1] + "\\s*=\\s*`([\\s\\S]*?)`").exec(text);
      if (!decl) continue; // defined elsewhere; nothing we can resolve here
      body = decl[1];
    }

    const js = evaluateTemplate(body, where);
    if (js === null) continue;
    if (js.trim().length === 0) continue;

    checked++;
    if (path.endsWith("console.ts") && js.length > consoleAppChars) consoleAppChars = js.length;

    try {
      new Function(js);
    } catch (err) {
      findings.push({ where, detail: `${err.message} (${js.length} chars of emitted JS)` });
    }
  }
}

// --- the check must be able to fail ------------------------------------------------------------
//
// Both of these caught a broken extractor during development, and neither is theoretical: an
// earlier version reported a clean pass having parsed 279 characters of the wrong script.
if (checked < MIN_SCRIPTS) {
  findings.push({
    where: SRC,
    detail: `only ${checked} inline script(s) found, expected at least ${MIN_SCRIPTS} — the extractor has gone blind`,
  });
}
if (consoleAppChars < MIN_CONSOLE_APP_CHARS) {
  findings.push({
    where: "worker/src/console.ts",
    detail: `the console app extracted as ${consoleAppChars} chars, expected at least ${MIN_CONSOLE_APP_CHARS} — wrong script matched`,
  });
}

if (findings.length) {
  console.error("");
  for (const f of findings) console.error(`  ${f.where}: ${f.detail}`);
  console.error(`\n✗ ${findings.length} inline script problem(s) — the browser would get invalid JavaScript.\n`);
  process.exitCode = 1;
} else {
  console.log(`✓ ${checked} inline Worker scripts parse as JavaScript (console app: ${consoleAppChars} chars)`);
}

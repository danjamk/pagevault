import MarkdownIt from "markdown-it";
import type { PluginSimple } from "markdown-it";
import { full as emojiPlugin } from "markdown-it-emoji";
import footnotePlugin from "markdown-it-footnote";
import taskListsPlugin from "markdown-it-task-lists";
import katexImport from "@vscode/markdown-it-katex";

// @vscode/markdown-it-katex ships CJS as `module.exports = { default: fn }` with no
// `__esModule` marker. Wrangler's esbuild hands the default import the wrapper object,
// not the function, and `md.use` throws `plugin.apply is not a function` at deploy —
// while vitest's loader unwraps it, so tests pass and the deploy fails. Unwrap here so
// it is correct under either bundler. (The other three plugins export a bare function
// or named exports and need no such dance.)
const katexMaybe = katexImport as unknown as PluginSimple | { default: PluginSimple };
const katexPlugin: PluginSimple = typeof katexMaybe === "function" ? katexMaybe : katexMaybe.default;

/**
 * Markdown → a self-contained HTML artifact.
 *
 * The render path (`handleRender`) is a pure byte-server that never loads `sourceKind`,
 * so conversion happens once at publish time and the output is stored as the doc body.
 * The wrapped HTML is the artifact: it renders in the sandboxed iframe under `docCsp`
 * exactly like any other hostile artifact. Nothing here runs in the trusted shell.
 *
 * Feature coverage tracks VS Code's markdown preview (which is also markdown-it):
 * GFM tables + strikethrough, task lists, footnotes, emoji, and math — all rendered
 * server-side into the body. Mermaid and syntax highlighting are drawn client-side by
 * libraries loaded from the CDNs `docCsp` already allowlists, and only when the source
 * actually contains a diagram or code — a plain-prose doc pulls in nothing.
 *
 * 🔴 The CDN hosts below MUST stay within the `script-src`/`style-src` allowlist in
 * `docCsp` (viewer.ts). Adding a host here that the CSP does not permit ships a feature
 * that silently fails to load. They are the same three hosts artifacts already use.
 */

const MERMAID_SRC = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
const MERMAID_INIT = `mermaid.initialize({startOnLoad:false,securityLevel:"strict"});mermaid.run();`;
const HLJS_SRC = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js";
const HLJS_CSS_LIGHT = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css";
const HLJS_CSS_DARK = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css";
const KATEX_CSS = "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.css";

const md = new MarkdownIt({
  html: true, // Raw HTML/`<script>` passes through. The sandbox contains it — see the test.
  linkify: true,
  typographer: true,
  breaks: false,
});

// Read-only task list checkboxes (disabled), exactly as GitHub/VS Code render them.
md.use(taskListsPlugin, { enabled: false, label: true });
md.use(footnotePlugin);
md.use(emojiPlugin);
// Math, server-side. Must be server-side: markdown-it would otherwise treat `_`/`*`
// inside `$…$` as emphasis before any client library sees it.
md.use(katexPlugin);

// A ```mermaid fence is not a code block — it is a diagram. Rewrite it to the element
// mermaid.js hydrates (`<pre class="mermaid">`); every other fence keeps the default
// `<pre><code class="language-x">`, which highlight.js targets and mermaid ignores.
const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, envAny, self) => {
  const token = tokens[idx];
  const info = token?.info.trim().split(/\s+/)[0]?.toLowerCase();
  if (token && info === "mermaid") {
    return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>\n`;
  }
  if (defaultFence) return defaultFence(tokens, idx, options, envAny, self);
  return self.renderToken(tokens, idx, options);
};

/** A fenced code block — the trigger for loading highlight.js (it only styles `pre code`,
 * so inline backticks are not worth a script fetch). */
const hasCode = (src: string): boolean => /(^|\n)\s*(```|~~~)/.test(src);
/** A ```mermaid / ~~~mermaid fence — the trigger for loading mermaid.js. */
const hasMermaid = (src: string): boolean => /(^|\n)\s*(```|~~~)\s*mermaid\b/i.test(src);

export function renderMarkdown(source: string): string {
  const body = md.render(source);

  // Math is detected from the *output* — KaTeX only emits `katex` markup when it found
  // and parsed math, so this is exact rather than a delimiter guess.
  const needsMath = body.includes('class="katex"');
  const needsMermaid = hasMermaid(source);
  const needsHljs = hasCode(source);

  const head: string[] = [`<style>${DEFAULT_CSS}</style>`];
  if (needsMath) head.push(`<link rel="stylesheet" href="${KATEX_CSS}">`);
  if (needsHljs) {
    head.push(`<link rel="stylesheet" href="${HLJS_CSS_LIGHT}" media="(prefers-color-scheme: light)">`);
    head.push(`<link rel="stylesheet" href="${HLJS_CSS_DARK}" media="(prefers-color-scheme: dark)">`);
  }

  const tail: string[] = [];
  if (needsMermaid) {
    tail.push(`<script src="${MERMAID_SRC}"></script><script>${MERMAID_INIT}</script>`);
  }
  if (needsHljs) {
    tail.push(`<script src="${HLJS_SRC}"></script><script>hljs.highlightAll();</script>`);
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head.join(
    "",
  )}</head><body class="markdown-body">${body}${tail.join("")}</body></html>`;
}

/**
 * The default document stylesheet. Legible, theme-aware, self-contained — no webfont so
 * there is nothing to load and nothing to fail. `mermaid` blocks are un-styled here on
 * purpose: mermaid.js owns their appearance once it hydrates.
 */
const DEFAULT_CSS = `
:root { color-scheme: light dark; --fg:#1a1a1a; --muted:#5a5f66; --bg:#ffffff; --accent:#34507a; --border:#e3e6ea; --code-bg:#f5f6f8; --quote:#6b7280; }
@media (prefers-color-scheme: dark) { :root { --fg:#e6e8eb; --muted:#9aa1ab; --bg:#16181c; --accent:#8fa8d6; --border:#2a2e35; --code-bg:#20242b; --quote:#9aa1ab; } }
* { box-sizing: border-box; }
body.markdown-body { margin: 0 auto; max-width: 46rem; padding: 3rem 1.25rem 5rem; color: var(--fg); background: var(--bg); font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; -webkit-text-size-adjust: 100%; }
.markdown-body > :first-child { margin-top: 0; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; font-weight: 650; margin: 2rem 0 1rem; text-wrap: balance; }
h1 { font-size: 2rem; padding-bottom: .3em; border-bottom: 1px solid var(--border); }
h2 { font-size: 1.5rem; padding-bottom: .3em; border-bottom: 1px solid var(--border); }
h3 { font-size: 1.25rem; } h4 { font-size: 1rem; } h5, h6 { font-size: .9rem; color: var(--muted); }
p, ul, ol, blockquote, table, pre { margin: 0 0 1rem; }
a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
ul, ol { padding-left: 1.5rem; }
li { margin: .25rem 0; }
li.task-list-item { list-style: none; margin-left: -1.25rem; }
li.task-list-item input { margin-right: .5rem; }
blockquote { margin-left: 0; padding: .2rem 1rem; border-left: 3px solid var(--border); color: var(--quote); }
code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: .9em; background: var(--code-bg); padding: .15em .4em; border-radius: 4px; }
pre { background: var(--code-bg); padding: 1rem; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; font-size: .875rem; }
pre.mermaid { background: none; padding: 0; text-align: center; }
img { max-width: 100%; height: auto; }
hr { border: none; border-top: 1px solid var(--border); margin: 2rem 0; }
table { border-collapse: collapse; display: block; overflow-x: auto; width: max-content; max-width: 100%; }
th, td { border: 1px solid var(--border); padding: .5rem .75rem; text-align: left; }
th { background: var(--code-bg); font-weight: 650; }
.footnotes { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border); font-size: .9rem; color: var(--muted); }
`.trim();

import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readDocument } from "../src/documents.js";
import { renderMarkdown } from "../src/markdown.js";
import { getDoc, getRawSource } from "../src/store.js";

const HOST = "https://share.example.com";
const TOKEN = "test-token-do-not-use-in-production";

async function publishMarkdown(source: string, title = "Notes") {
  const res = await SELF.fetch(`${HOST}/api/docs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title, html: source, sourceKind: "markdown" }),
  });
  expect(res.status).toBeLessThan(300);
  return ((await res.json()) as { id: string }).id;
}

// ---------------------------------------------------------------------------
// The renderer, in isolation. Everything here is server-side output.
// ---------------------------------------------------------------------------

describe("renderMarkdown — feature coverage (VS Code parity)", () => {
  it("renders headings, emphasis and lists", () => {
    const out = renderMarkdown("# Title\n\nSome **bold** and _italic_.\n\n- one\n- two");
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toContain("<li>one</li>");
  });

  it("renders GFM tables and strikethrough", () => {
    const out = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~");
    expect(out).toContain("<table>");
    expect(out).toContain("<th>a</th>");
    expect(out).toContain("<s>gone</s>");
  });

  it("renders task lists as read-only (disabled) checkboxes", () => {
    const out = renderMarkdown("- [x] done\n- [ ] todo");
    expect(out).toContain('type="checkbox"');
    expect(out).toContain("disabled");
    expect(out).toContain("checked");
    // Not interactive — no persistence, exactly how GitHub/VS Code show them.
    expect(out).not.toContain('type="checkbox" checked=""> <');
  });

  it("renders footnotes", () => {
    const out = renderMarkdown("Text with a note.[^1]\n\n[^1]: the note");
    expect(out).toContain('class="footnotes"');
    expect(out).toContain("the note");
  });

  it("renders emoji shortcodes to unicode", () => {
    expect(renderMarkdown("party :tada:")).toContain("🎉");
  });

  it("renders math server-side and links the KaTeX stylesheet", () => {
    const out = renderMarkdown("Euler: $e^{i\\pi}+1=0$");
    expect(out).toContain('class="katex"');
    expect(out).toContain("KaTeX");
    expect(out).toContain("katex.min.css");
  });
});

describe("renderMarkdown — mermaid and syntax highlighting", () => {
  it("rewrites a ```mermaid fence to a mermaid block and injects the loader", () => {
    const out = renderMarkdown("```mermaid\ngraph TD; A-->B;\n```");
    expect(out).toContain('<pre class="mermaid">');
    // The diagram source is present as escaped text, not a language-mermaid code block.
    expect(out).toContain("graph TD");
    expect(out).not.toContain('class="language-mermaid"');
    expect(out).toContain("mermaid@11");
  });

  it("injects highlight.js for a language-tagged code fence", () => {
    const out = renderMarkdown("```js\nconst x = 1;\n```");
    expect(out).toContain('class="language-js"');
    expect(out).toContain("highlight.min.js");
    expect(out).toContain("hljs.highlightAll");
  });

  it("🔴 a plain-prose doc pulls in NONE of the CDN loaders", () => {
    // Assert on the loader URLs, not the word "mermaid" — the default stylesheet always
    // carries a `pre.mermaid` rule.
    const out = renderMarkdown("# Just prose\n\nNo diagrams, no math, no code here.");
    expect(out).not.toContain("mermaid@11");
    expect(out).not.toContain("highlight.min.js");
    expect(out).not.toContain("katex.min.css");
    expect(out).not.toContain('class="katex"');
  });

  it("passes embedded raw HTML through — the sandbox contains it, we don't strip it", () => {
    // html:true is deliberate. The converted output is exactly as hostile as any artifact
    // and flows through the same sandbox + docCsp — asserted at the /render layer.
    const out = renderMarkdown("Before\n\n<script>alert(1)</script>\n\nAfter");
    expect(out).toContain("<script>alert(1)</script>");
  });
});

// ---------------------------------------------------------------------------
// Publish-time conversion end-to-end: what lands in KV, and what reads back.
// ---------------------------------------------------------------------------

describe("publish-time markdown conversion (#46)", () => {
  it("stores rendered HTML as the body but keeps the original .md as the source", async () => {
    const id = await publishMarkdown("# Report\n\nBody text.");

    // The render path is a dumb byte-server, so doc: must already be presentable HTML.
    const body = await getDoc(env, id);
    expect(body).toContain("<h1>Report</h1>");
    expect(body).toContain("<!doctype html>");

    // The original survives verbatim, for the raw download and read-back.
    expect(await getRawSource(env, id)).toBe("# Report\n\nBody text.");
  });

  it("read_document reads back the original markdown, not the rendered HTML", async () => {
    const id = await publishMarkdown("# Decisions\n\nWe chose CDC on V2.");
    const read = await readDocument(env, id);
    expect(read?.source).toBe("# Decisions\n\nWe chose CDC on V2.");
    expect(read?.source).not.toContain("<h1>");
  });
});

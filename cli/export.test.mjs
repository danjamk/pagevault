//
// Unit tests for the export builder's pure functions — slugifying, filename collisions, the
// access summary, and the two rendered artifacts. The orchestration (buildExport) is HTTP against
// a live deployment; the logic worth pinning is here. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  slugify,
  uniqueFilename,
  accessLabel,
  renderAccessMd,
  renderIndexHtml,
  portalJson,
} from "./lib/export.mjs";

test("slugify: lowercases, hyphenates, trims", () => {
  assert.equal(slugify("Q3 Architecture Review"), "q3-architecture-review");
  assert.equal(slugify("  Spaces  &  Symbols!!  "), "spaces-symbols");
});

test("slugify: transliterates accents and drops emoji", () => {
  assert.equal(slugify("Café résumé"), "cafe-resume");
  assert.equal(slugify("🚀 launch 🎉"), "launch");
});

test("slugify: an emoji-only or empty title becomes 'untitled'", () => {
  assert.equal(slugify("🎉🎉🎉"), "untitled");
  assert.equal(slugify(""), "untitled");
  assert.equal(slugify(null), "untitled");
});

test("slugify: Windows reserved names get a suffix so they're legal filenames", () => {
  assert.equal(slugify("CON"), "con-doc");
  assert.equal(slugify("prn"), "prn-doc");
  assert.equal(slugify("Com1"), "com1-doc");
  // Not reserved once it's part of a longer name.
  assert.equal(slugify("console notes"), "console-notes");
});

test("slugify: caps length and never leaves a trailing hyphen", () => {
  const slug = slugify("a".repeat(200));
  assert.ok(slug.length <= 80);
  const capped = slugify(`${"word-".repeat(30)}`);
  assert.ok(!capped.endsWith("-"));
});

test("uniqueFilename: same title same day gets a short-id suffix", () => {
  const taken = new Set();
  const a = uniqueFilename(taken, "2026-01-14", "review", "html", "abcdef123456");
  const b = uniqueFilename(taken, "2026-01-14", "review", "html", "zzzzzz999999");
  assert.equal(a, "2026-01-14-review.html");
  assert.equal(b, "2026-01-14-review-zzzzzz.html");
  assert.notEqual(a, b);
});

test("accessLabel: a draft short-circuits everything", () => {
  assert.match(accessLabel("restricted", { ownerOnly: true, extraEmails: ["x@y.com"] }), /Draft/);
});

test("accessLabel: portal floor plus additive grants", () => {
  assert.equal(accessLabel("restricted", { ownerOnly: false }), "Portal members");
  assert.equal(accessLabel("public", { ownerOnly: false }), "Public — no login required");
  assert.equal(accessLabel("private", { ownerOnly: false }), "Owner only");
  assert.match(
    accessLabel("restricted", { ownerOnly: false, extraEmails: ["cfo@acme.com"] }),
    /Portal members · also shared with cfo@acme\.com/,
  );
  assert.match(
    accessLabel("private", { ownerOnly: false, publicToken: "tok" }),
    /Owner only · public link/,
  );
});

const snapshot = () => ({
  generatedFrom: "https://share.example.com",
  date: "2026-07-19",
  includeDrafts: false,
  portals: [
    {
      slug: "acme-corp",
      name: "Acme Corp",
      kind: "restricted",
      members: ["a@acme.com", "b@acme.com"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      docs: [
        {
          title: "Architecture <Review>",
          filename: "2026-01-14-architecture-review.html",
          meta: { createdAt: "2026-01-14T00:00:00.000Z", ownerOnly: false, extraEmails: ["cfo@acme.com"] },
        },
      ],
    },
  ],
});

test("renderAccessMd: names members, the doc, and its share; states the draft default", () => {
  const md = renderAccessMd(snapshot());
  assert.match(md, /## Acme Corp {2}\(restricted\)/);
  assert.match(md, /Members \(2\): a@acme\.com, b@acme\.com/);
  assert.match(md, /Architecture <Review>/); // markdown, not escaped
  assert.match(md, /also shared with cfo@acme\.com/);
  assert.match(md, /drafts are excluded/i);
});

test("renderIndexHtml: links each doc and escapes HTML in titles", () => {
  const html = renderIndexHtml(snapshot());
  assert.match(html, /href="\.\/acme-corp\/2026-01-14-architecture-review\.html"/);
  assert.match(html, /Architecture &lt;Review&gt;/); // escaped for HTML context
  assert.ok(!html.includes("<Review>"), "raw angle brackets must not reach the HTML");
});

test("portalJson: shape carries members and timestamps, omits internal ids", () => {
  const obj = JSON.parse(portalJson(snapshot().portals[0]));
  assert.equal(obj.slug, "acme-corp");
  assert.equal(obj.kind, "restricted");
  assert.deepEqual(obj.members, ["a@acme.com", "b@acme.com"]);
  assert.ok(obj.createdAt && obj.updatedAt);
});

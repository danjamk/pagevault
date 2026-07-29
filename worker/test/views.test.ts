import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { publishDocument } from "../src/documents.js";
import { MAX_SUMMARY_BYTES, type ViewSummary, parseViewSummary, statsFor } from "../src/views.js";

/**
 * View metrics over MCP (#127, ADR-019).
 *
 * The Worker never queries Analytics Engine — that needs an account-scoped token ADR-015 keeps
 * off it. It receives an aggregate from `pagevault views --sync` and joins it onto documents.
 *
 * The failure this suite exists to prevent is a **measured-looking zero**. "0 views" is the most
 * valuable thing this feature says — *the client never opened it* — which is exactly why it must
 * never be produced by a document that was not in the measured window, or by no sync at all. Same
 * shape as the seat counter: a number that reads as fact at the moment it is not one.
 */

const TOKEN = "test-token-do-not-use-in-production";
const HOST = "https://share.example.com";

const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

const SYNCED = "2026-07-29T12:00:00.000Z";

const stats = (over: Record<string, unknown> = {}) => ({
  views: 3,
  lastViewedAt: "2026-07-28T09:00:00Z",
  surfaces: { link: 2, public: 0, portal: 1 },
  ...over,
});

const summaryFor = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  syncedAt: SYNCED,
  windowDays: 90,
  docs: { [id]: stats(over) },
});

const postSummary = (body: unknown) =>
  SELF.fetch(`${HOST}/api/views/summary`, { method: "POST", headers: auth, body: JSON.stringify(body) });

const getDoc = async (id: string) =>
  (await (await SELF.fetch(`${HOST}/api/docs/${id}`, { headers: auth })).json()) as Record<string, unknown>;

const listDocs = async () =>
  (await (await SELF.fetch(`${HOST}/api/docs`, { headers: auth })).json()) as {
    docs: Record<string, unknown>[];
    viewsSyncedAt?: string;
  };

/** Publish, and force `createdAt` older than the sync so the document counts as measured. */
async function publishOld(title: string, createdAt = "2026-01-01T00:00:00.000Z") {
  const { meta } = await publishDocument(env, { title, source: `<h1>${title}</h1>` });
  const { putMeta } = await import("../src/store.js");
  await putMeta(env, { ...meta, createdAt });
  return meta.id;
}

/** Wipe the summary between tests — the KV namespace is shared across the file. */
beforeEach(async () => {
  await env.PAGEVAULT.delete("views:summary");
});

describe("statsFor — the three answers that must not collapse into each other", () => {
  const doc = { id: "abc", createdAt: "2026-01-01T00:00:00.000Z" };
  const summary: ViewSummary = {
    syncedAt: SYNCED,
    windowDays: 90,
    docs: { abc: { views: 4, lastViewedAt: "2026-07-28T09:00:00Z", surfaces: { link: 4, public: 0, portal: 0 } } },
  };

  it("reports the counts for a measured document", () => {
    expect(statsFor(summary, doc)).toMatchObject({ views: 4 });
  });

  it("reports null — never zero — when no sync has ever run", () => {
    expect(statsFor(null, doc)).toBeNull();
  });

  it("reports null — never zero — for a document published since the last sync", () => {
    // The costly bug: a document published this morning is not in a summary taken yesterday, so
    // a `0` here would tell the operator the client ignored something that did not yet exist.
    expect(statsFor(summary, { id: "new", createdAt: "2026-07-30T00:00:00.000Z" })).toBeNull();
  });

  it("reports zero for a measured document nobody opened — the answer worth having", () => {
    expect(statsFor(summary, { id: "quiet", createdAt: "2026-01-01T00:00:00.000Z" })).toEqual({
      views: 0,
      lastViewedAt: null,
      surfaces: { link: 0, public: 0, portal: 0 },
    });
  });

  it("does not mistake sub-second ISO formatting for a later publish", () => {
    // `2026-07-29T12:00:00.000Z` vs `2026-07-29T12:00:00Z` — the same instant, but "." < "Z", so
    // a raw string compare puts the millisecond form first and would drop the document's metrics.
    expect(statsFor({ ...summary, syncedAt: "2026-07-29T12:00:00Z" }, { id: "abc", createdAt: SYNCED })).not.toBeNull();
  });
});

describe("parseViewSummary — the payload is rebuilt, never trusted", () => {
  const valid = { syncedAt: SYNCED, windowDays: 90, docs: { abc: stats() } };

  it("accepts a well-formed summary", () => {
    expect(parseViewSummary(valid)).toMatchObject({ syncedAt: SYNCED, windowDays: 90 });
  });

  it("drops fields it did not validate rather than passing them through", () => {
    // This lands inside an MCP response. An owner bearer is exactly what a leaked token is, so
    // "our own CLI sent it" is not a validation strategy.
    const parsed = parseViewSummary({
      ...valid,
      docs: { abc: { ...stats(), viewer: "cfo@acme.com", nested: { x: 1 } } },
    });
    expect(JSON.stringify(parsed)).not.toContain("cfo@acme.com");
    expect(Object.keys(parsed.docs["abc"]!)).toEqual(["views", "lastViewedAt", "surfaces"]);
  });

  it.each([
    ["a non-object body", "nope"],
    ["a missing syncedAt", { windowDays: 90, docs: {} }],
    ["an unparseable syncedAt", { syncedAt: "last Tuesday", windowDays: 90, docs: {} }],
    ["a zero window", { syncedAt: SYNCED, windowDays: 0, docs: {} }],
    ["a missing docs map", { syncedAt: SYNCED, windowDays: 90 }],
    ["docs as an array", { syncedAt: SYNCED, windowDays: 90, docs: [] }],
    ["a negative count", { syncedAt: SYNCED, windowDays: 90, docs: { a: stats({ views: -1 }) } }],
    ["a non-numeric count", { syncedAt: SYNCED, windowDays: 90, docs: { a: stats({ views: "many" }) } }],
    ["a non-string lastViewedAt", { syncedAt: SYNCED, windowDays: 90, docs: { a: stats({ lastViewedAt: 5 }) } }],
  ])("refuses %s", (_label, body) => {
    expect(() => parseViewSummary(body)).toThrow();
  });

  it("treats a missing surfaces block as zeros rather than refusing", () => {
    const parsed = parseViewSummary({ syncedAt: SYNCED, windowDays: 90, docs: { a: { views: 2 } } });
    expect(parsed.docs["a"]).toEqual({ views: 2, lastViewedAt: null, surfaces: { link: 0, public: 0, portal: 0 } });
  });

  it("refuses an oversized summary rather than storing a truncation", () => {
    // A summary quietly missing half a portal reports "never opened" for documents that were.
    const docs: Record<string, unknown> = {};
    for (let i = 0; i < 20000; i++) docs[`doc${i}`] = stats();
    expect(() => parseViewSummary({ syncedAt: SYNCED, windowDays: 90, docs })).toThrow(/too|bytes/i);
  });

  it("stays under its own ceiling for a realistic portal", () => {
    const docs: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) docs[`k3x9mq2vb7p${i}`] = stats();
    const parsed = parseViewSummary({ syncedAt: SYNCED, windowDays: 90, docs });
    expect(new TextEncoder().encode(JSON.stringify(parsed)).byteLength).toBeLessThan(MAX_SUMMARY_BYTES);
  });
});

describe("POST /api/views/summary", () => {
  it("stores a summary and reports what it took", async () => {
    const id = await publishOld("Sync Target");
    const res = await postSummary(summaryFor(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, syncedAt: SYNCED, windowDays: 90, documents: 1 });
  });

  it("refuses an unauthenticated write", async () => {
    // The metrics are client-behaviour data about a consulting engagement. The endpoint is
    // owner-bearer only, like every /api route.
    const res = await SELF.fetch(`${HOST}/api/views/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summaryFor("abc")),
    });
    expect(res.status).toBe(401);
  });

  it("answers 400 on a malformed payload, with the field named", async () => {
    const res = await postSummary({ syncedAt: SYNCED, docs: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_field" });
  });

  it("answers 413 when the summary would not fit", async () => {
    const docs: Record<string, unknown> = {};
    for (let i = 0; i < 20000; i++) docs[`doc${i}`] = stats();
    const res = await postSummary({ syncedAt: SYNCED, windowDays: 90, docs });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "too_large" });
  });

  it("is write-only — there is no GET that hands the metrics back on their own", async () => {
    const res = await SELF.fetch(`${HOST}/api/views/summary`, { headers: auth });
    expect(res.status).toBe(405);
  });
});

describe("the API joins metrics onto documents", () => {
  it("omits the fields entirely before any sync", async () => {
    const id = await publishOld("Never Synced");
    const doc = await getDoc(id);
    expect(doc["views"]).toBeUndefined();
    expect(doc["viewsSyncedAt"]).toBeUndefined();

    const list = await listDocs();
    expect(list.viewsSyncedAt).toBeUndefined();
    expect(list.docs.every((d) => d["views"] === undefined)).toBe(true);
  });

  it("carries counts, surfaces and the staleness stamp once synced", async () => {
    const id = await publishOld("Synced Doc");
    await postSummary(summaryFor(id));

    const doc = await getDoc(id);
    expect(doc).toMatchObject({
      views: 3,
      lastViewedAt: "2026-07-28T09:00:00Z",
      surfaces: { link: 2, public: 0, portal: 1 },
      viewsSyncedAt: SYNCED,
    });

    const list = await listDocs();
    expect(list.viewsSyncedAt).toBe(SYNCED);
    expect(list.docs.find((d) => d["id"] === id)).toMatchObject({ views: 3 });
  });

  it("reports a measured zero for a document the summary does not mention", async () => {
    const quiet = await publishOld("Nobody Opened This");
    const other = await publishOld("Something Else");
    await postSummary(summaryFor(other));

    expect(await getDoc(quiet)).toMatchObject({ views: 0, surfaces: { link: 0, public: 0, portal: 0 } });
  });

  it("says nothing about a document published since the sync", async () => {
    // Not zero. It was not in the window, so there is no honest number to give.
    const { meta } = await publishDocument(env, { title: "Published After", source: "<h1>after</h1>" });
    await postSummary({ syncedAt: "2020-01-01T00:00:00.000Z", windowDays: 90, docs: {} });

    const doc = await getDoc(meta.id);
    expect(doc["views"]).toBeUndefined();
  });
});

import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DocMeta, type Portal, putDoc, putPortal, putPublicToken } from "../src/store.js";

/**
 * The denial events, exercised through the routes rather than the logger.
 *
 * log.test.ts proves the logger cannot emit a credential. This proves the *routes* actually
 * emit something — every one of these paths returned a bare 404 and said nothing, which is
 * why "the link you sent me doesn't work" had no answer short of reasoning about KV by
 * hand. All four /p/ refusals look identical to the caller on purpose; they must not look
 * identical from the inside.
 */

const HOST = "https://share.example.com";
const HTML = "<h1>report</h1>";

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void out.push(line));
  vi.spyOn(console, "error").mockImplementation((line: string) => void err.push(line));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every structured event emitted so far, in order, with its stream. */
const events = () =>
  [...out.map((l) => ["log", l] as const), ...err.map((l) => ["error", l] as const)]
    .map(([stream, line]) => ({ stream, ...JSON.parse(line) }))
    .filter((e) => typeof e.event === "string");

const eventNames = () => events().map((e) => e.event);
const raw = () => [...out, ...err].join("\n");

const doc = (over: Partial<DocMeta> = {}): DocMeta => ({
  id: "k3x9mq2vb7pd",
  portal: "default",
  name: "q3-review.html",
  title: "Q3 Review",
  sourceKind: "html",
  ownerOnly: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  bytes: HTML.length,
  ...over,
});

const portal = (over: Partial<Portal> = {}): Portal => ({
  slug: "default",
  name: "Default",
  kind: "restricted",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("/p/{token} — the four refusals are four events", () => {
  const TOKEN = "tokenaaaaaaaaaaaaaaaaa";

  it("distinguishes a token that resolves to nothing", async () => {
    const res = await SELF.fetch(`${HOST}/p/${TOKEN}`);

    expect(res.status).toBe(404);
    expect(eventNames()).toContain("blocked_public_token_unknown");
  });

  it("flags a pub: key that outlived its document as an error, not a visitor problem", async () => {
    await putPublicToken(env, TOKEN, "ghostdoc1234");

    const res = await SELF.fetch(`${HOST}/p/${TOKEN}`);

    expect(res.status).toBe(404);
    // A dangling key is a KV inconsistency. Nothing else in the Worker reports it.
    const ev = events().find((e) => e.event === "dangling_public_token");
    expect(ev).toMatchObject({ stream: "error", level: "error", doc: "ghostdoc1234" });
  });

  it("distinguishes a rotated-away token — the usual cause of a dead client link", async () => {
    const meta = doc({ publicToken: "currenttokenbbbbbbbbb" });
    await putDoc(env, meta, HTML);
    await putPublicToken(env, TOKEN, meta.id); // stale key, points at a doc that moved on

    const res = await SELF.fetch(`${HOST}/p/${TOKEN}`);

    expect(res.status).toBe(404);
    expect(events().find((e) => e.event === "blocked_public_token_superseded")).toMatchObject({
      doc: meta.id,
      portal: "default",
    });
  });

  it("distinguishes a link refused because the document went owner-only", async () => {
    const meta = doc({ publicToken: TOKEN, ownerOnly: true });
    await putDoc(env, meta, HTML);
    await putPublicToken(env, TOKEN, meta.id);

    const res = await SELF.fetch(`${HOST}/p/${TOKEN}`);

    expect(res.status).toBe(404);
    expect(eventNames()).toContain("blocked_public_token_owner_only");
  });

  it("🔴 never writes the token itself, on any of the four branches", async () => {
    const live = doc({ id: "livedoc12345", publicToken: TOKEN, ownerOnly: true });
    await putDoc(env, live, HTML);
    await putPublicToken(env, TOKEN, live.id);

    await SELF.fetch(`${HOST}/p/unknowntokenccccccccc`);
    await SELF.fetch(`${HOST}/p/${TOKEN}`);

    // A /p/ token has no expiry — it is live until rotated, so a logged one is a
    // permanently valid credential. ADR-015 decision 2.
    expect(raw()).not.toContain(TOKEN);
    expect(raw()).not.toContain("unknowntokenccccccccc");
    // ...but the fingerprint is there, and it is stable, so a retry loop is still visible.
    const fps = events()
      .filter((e) => typeof e.token === "string")
      .map((e) => e.token);
    expect(fps).toHaveLength(2);
    expect(fps.every((f) => /^[0-9a-f]{8}$/.test(f))).toBe(true);
  });
});

describe("🔴 cross-portal document requests are the loudest event we emit", () => {
  it("logs at error level when a portal is asked for a document it does not own", async () => {
    await putPortal(env, portal({ slug: "marketing", name: "Marketing", kind: "public" }));
    const secret = doc({ id: "privatedoc12", portal: "acme", title: "Acme Migration Plan" });
    await putDoc(env, secret, HTML);

    // The leak in route form: a public portal's URL carrying a private portal's document id.
    const res = await SELF.fetch(`${HOST}/pub/marketing/${secret.id}`);

    expect(res.status).toBe(404);
    const ev = events().find((e) => e.event === "denied_cross_portal_document");
    expect(ev).toMatchObject({
      stream: "error",
      portal: "marketing",
      doc: "privatedoc12",
      ownedBy: "acme",
    });
  });

  it("separates a guessed-but-real client slug from a slug that does not exist", async () => {
    await putPortal(env, portal({ slug: "acme", name: "Acme", kind: "restricted" }));

    await SELF.fetch(`${HOST}/pub/acme`);
    await SELF.fetch(`${HOST}/pub/nosuchportal`);

    const [hit, miss] = events().filter((e) => e.event === "blocked_public_portal_route");
    // Identical 404s outside. Inside, one of these means someone guessed a client's slug
    // and tried the door that needs no login.
    expect(hit).toMatchObject({ portal: "acme", exists: true });
    expect(miss).toMatchObject({ portal: "nosuchportal", exists: false });
  });

  it("does not fire on a legitimate request for a document the portal owns", async () => {
    await putPortal(env, portal({ slug: "marketing", name: "Marketing", kind: "public" }));
    const meta = doc({ id: "publicdoc123", portal: "marketing", title: "Brochure" });
    await putDoc(env, meta, HTML);

    const res = await SELF.fetch(`${HOST}/pub/marketing/${meta.id}`);

    expect(res.status).toBe(200);
    expect(eventNames()).not.toContain("denied_cross_portal_document");
    expect(eventNames()).not.toContain("denied_document_view");
  });
});

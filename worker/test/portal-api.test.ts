import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { type DocMeta, getMembers, getPortal, putDoc, putMembers, putPortal } from "../src/store.js";

const TOKEN = "test-token-do-not-use-in-production";
const HOST = "https://share.example.com";
const auth = { Authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "Content-Type": "application/json" };

const call = (method: string, path: string, body?: unknown) =>
  SELF.fetch(`${HOST}${path}`, {
    method,
    headers: body === undefined ? auth : json,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function seedDoc(slug: string, id: string, over: Partial<DocMeta> = {}) {
  const meta: DocMeta = {
    id,
    portal: slug,
    name: `${id}.html`,
    title: `doc ${id}`,
    sourceKind: "html",
    ownerOnly: false,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    bytes: 10,
    ...over,
  };
  await putDoc(env, meta, "<h1>x</h1>");
  return meta;
}

describe("POST /api/portals", () => {
  it("creates a portal", async () => {
    const res = await call("POST", "/api/portals", {
      slug: "realplus",
      name: "RealPlus",
      kind: "restricted",
      description: "Deliverables for the RealPlus engagement",
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ slug: "realplus", name: "RealPlus", kind: "restricted" });
    expect(await getPortal(env, "realplus")).toMatchObject({ slug: "realplus" });
  });

  it("defaults to private — the safe kind", async () => {
    const res = await call("POST", "/api/portals", { slug: "scratch" });
    expect(await res.json()).toMatchObject({ kind: "private", name: "scratch" });
  });

  it("refuses a duplicate", async () => {
    await call("POST", "/api/portals", { slug: "realplus" });
    const res = await call("POST", "/api/portals", { slug: "realplus" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "portal_exists" });
  });

  it.each(["api", "mcp", "admin", "render", "p", "pub", "v"])(
    "🔴 refuses the reserved slug %o — it would shadow a route",
    async (slug) => {
      const res = await call("POST", "/api/portals", { slug });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_slug" });
    },
  );

  it.each(["Has-Caps", "has space", "a", "-lead", "trail-", "under_score"])(
    "refuses the malformed slug %o",
    async (slug) => {
      expect((await call("POST", "/api/portals", { slug })).status).toBe(400);
    },
  );

  it("refuses an unknown kind", async () => {
    const res = await call("POST", "/api/portals", { slug: "x1", kind: "secret" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/portals", () => {
  it("lists portals", async () => {
    await call("POST", "/api/portals", { slug: "realplus" });
    await call("POST", "/api/portals", { slug: "acme" });

    const { portals } = (await (await call("GET", "/api/portals")).json()) as {
      portals: { slug: string }[];
    };
    expect(portals.map((p) => p.slug).sort()).toEqual(["acme", "realplus"]);
  });

  it("returns counts on a single portal", async () => {
    await putPortal(env, {
      slug: "realplus",
      name: "RealPlus",
      kind: "restricted",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await putMembers(env, "realplus", ["a@x.com", "b@x.com"]);
    await seedDoc("realplus", "aaa111111111");

    const res = await call("GET", "/api/portals/realplus");
    expect(await res.json()).toMatchObject({ slug: "realplus", docCount: 1, memberCount: 2 });
  });

  it("404s an unknown portal", async () => {
    expect((await call("GET", "/api/portals/nope")).status).toBe(404);
  });
});

describe("PATCH /api/portals/{slug}", () => {
  beforeEach(async () => {
    await call("POST", "/api/portals", { slug: "realplus", name: "RealPlus", kind: "private" });
  });

  it("changes name, kind and description", async () => {
    const res = await call("PATCH", "/api/portals/realplus", {
      name: "RealPlus Inc",
      kind: "restricted",
      description: "Nine months of work",
    });

    expect(await res.json()).toMatchObject({
      name: "RealPlus Inc",
      kind: "restricted",
      description: "Nine months of work",
    });
  });

  it("leaves untouched fields alone", async () => {
    await call("PATCH", "/api/portals/realplus", { kind: "public" });
    expect(await getPortal(env, "realplus")).toMatchObject({ name: "RealPlus", kind: "public" });
  });
});

describe("🔴 DELETE /api/portals/{slug} — deleting a client's whole history", () => {
  beforeEach(async () => {
    await call("POST", "/api/portals", { slug: "realplus", kind: "restricted" });
  });

  it("deletes an empty portal without ceremony", async () => {
    const res = await call("DELETE", "/api/portals/realplus");

    expect(res.status).toBe(200);
    expect(await getPortal(env, "realplus")).toBeNull();
  });

  it("⭐ REFUSES a non-empty portal without ?cascade=true, and says what it would destroy", async () => {
    await seedDoc("realplus", "aaa111111111");
    await seedDoc("realplus", "bbb111111111");

    const res = await call("DELETE", "/api/portals/realplus");

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("portal_not_empty");
    expect(body.error).toContain("2 document"); // the number, not a vague warning

    // And nothing was touched.
    expect(await getPortal(env, "realplus")).not.toBeNull();
    expect(await env.PAGEVAULT.get("doc:aaa111111111")).not.toBeNull();
  });

  it("cascades when asked, and takes every key with it", async () => {
    const meta = await seedDoc("realplus", "aaa111111111", { publicToken: "tok1111111111111111111" });
    await env.PAGEVAULT.put(`pub:${meta.publicToken}`, meta.id);
    await putMembers(env, "realplus", ["a@x.com"]);

    const res = await call("DELETE", "/api/portals/realplus?cascade=true");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deleted: 1 });

    // No orphans: not the doc, not the metadata, not the index entry, not the public link.
    expect(await env.PAGEVAULT.get("doc:aaa111111111")).toBeNull();
    expect(await env.PAGEVAULT.get("meta:aaa111111111")).toBeNull();
    expect(await env.PAGEVAULT.get("idx:realplus:aaa111111111")).toBeNull();
    expect(await env.PAGEVAULT.get(`pub:${meta.publicToken}`)).toBeNull();
    expect(await getPortal(env, "realplus")).toBeNull();
    expect(await getMembers(env, "realplus")).toEqual([]);
  });
});

describe("⭐ members — one call, every document", () => {
  beforeEach(async () => {
    await call("POST", "/api/portals", { slug: "realplus", kind: "restricted" });
  });

  it("PUT replaces the whole list", async () => {
    await call("PUT", "/api/portals/realplus/members", { emails: ["a@x.com", "b@x.com"] });
    const res = await call("PUT", "/api/portals/realplus/members", { emails: ["c@x.com"] });

    expect(await res.json()).toMatchObject({ members: ["c@x.com"] });
  });

  it("POST adds and removes", async () => {
    await call("PUT", "/api/portals/realplus/members", { emails: ["a@x.com", "b@x.com"] });

    const res = await call("POST", "/api/portals/realplus/members", {
      add: ["c@x.com"],
      remove: ["a@x.com"],
    });

    const { members } = (await res.json()) as { members: string[] };
    expect(members.sort()).toEqual(["b@x.com", "c@x.com"]);
  });

  it("⭐ adding one person grants every document the client has ever received", async () => {
    // The entire payoff of putting permissions on the portal. Three documents, one write.
    await seedDoc("realplus", "aaa111111111");
    await seedDoc("realplus", "bbb111111111");
    await seedDoc("realplus", "ccc111111111");

    await call("POST", "/api/portals/realplus/members", { add: ["newhire@realplus.com"] });

    expect(await getMembers(env, "realplus")).toContain("newhire@realplus.com");
    // No per-document writes were needed, and none happened.
  });

  it("normalizes and dedupes", async () => {
    const res = await call("PUT", "/api/portals/realplus/members", {
      emails: ["  CTO@RealPlus.com ", "cto@realplus.com"],
    });
    expect(await res.json()).toMatchObject({ members: ["cto@realplus.com"] });
  });

  it("rejects a non-email", async () => {
    const res = await call("PUT", "/api/portals/realplus/members", { emails: ["not-an-email"] });
    expect(res.status).toBe(400);
  });

  it("caps the list — the same DoS bound as extraEmails", async () => {
    const emails = Array.from({ length: 101 }, (_, i) => `user${i}@x.com`);
    expect((await call("PUT", "/api/portals/realplus/members", { emails })).status).toBe(400);
  });

  it("404s an unknown portal", async () => {
    expect((await call("GET", "/api/portals/nope/members")).status).toBe(404);
  });
});

describe("portal API auth", () => {
  it("401s with no bearer token", async () => {
    const res = await SELF.fetch(`${HOST}/api/portals`);
    expect(res.status).toBe(401);
  });
});

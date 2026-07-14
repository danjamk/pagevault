import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  type Portal,
  getMembers,
  getPortal,
  isValidSlug,
  listPortals,
  mintId,
  mintPublicToken,
  normalizeEmail,
  putMembers,
  putPortal,
} from "../src/store.js";

const portal = (slug: string): Portal => ({
  slug,
  name: slug,
  kind: "restricted",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("slugs", () => {
  it.each(["realplus", "acme-corp", "a1", "default", "client-2026"])("accepts %s", (slug) => {
    expect(isValidSlug(slug)).toBe(true);
  });

  it.each([
    ["a", "too short — the pattern needs a start and an end character"],
    ["-leading", "leading hyphen"],
    ["trailing-", "trailing hyphen"],
    ["Has-Caps", "uppercase"],
    ["has_underscore", "underscore"],
    ["has space", "space"],
    ["has.dot", "dot"],
    ["a".repeat(41), "too long"],
    ["", "empty"],
  ])("rejects %o (%s)", (slug) => {
    expect(isValidSlug(slug)).toBe(false);
  });

  it.each(["api", "mcp", "admin", "render", "p", "pub", "v"])(
    "🔴 rejects the reserved slug %o — it would shadow a route",
    (slug) => {
      // A slug that shadows a route is a routing bug that presents as a permissions bug,
      // which is the worst way for one to present.
      expect(isValidSlug(slug)).toBe(false);
    },
  );
});

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  CTO@RealPlus.COM ")).toBe("cto@realplus.com");
  });
});

describe("ids and tokens", () => {
  it("mints 12-char ids from an unambiguous alphabet", () => {
    // No 0/O, no 1/l/I — these get read aloud and typed by hand.
    expect(mintId()).toMatch(/^[23456789abcdefghijkmnpqrstuvwxyz]{12}$/);
  });

  it("mints 22-char public tokens — more entropy than an id", () => {
    // A capability URL is the only thing protecting a public document.
    expect(mintPublicToken()).toMatch(/^[23456789abcdefghijkmnpqrstuvwxyz]{22}$/);
  });

  it("does not repeat itself", () => {
    const ids = new Set(Array.from({ length: 500 }, mintId));
    expect(ids.size).toBe(500);
  });
});

describe("portals", () => {
  it("round-trips a portal", async () => {
    await putPortal(env, portal("realplus"));
    expect(await getPortal(env, "realplus")).toMatchObject({ slug: "realplus", kind: "restricted" });
  });

  it("returns null for a portal that does not exist", async () => {
    expect(await getPortal(env, "nope")).toBeNull();
  });

  it("lists portals from key metadata, with no read per portal", async () => {
    await putPortal(env, portal("realplus"));
    await putPortal(env, portal("acme"));

    const portals = await listPortals(env);
    expect(portals.map((p) => p.slug).sort()).toEqual(["acme", "realplus"]);
  });

  it("🔴 does not mistake a members key for a portal", async () => {
    // The spec's key layout was `portal:{slug}:members`, which collides with
    // list({prefix: "portal:"}) — a member list would come back looking like a portal.
    // Members live under their own prefix precisely so that cannot happen.
    await putPortal(env, portal("realplus"));
    await putMembers(env, "realplus", ["cto@realplus.com"]);

    const portals = await listPortals(env);
    expect(portals).toHaveLength(1);
    expect(portals[0]?.slug).toBe("realplus");
  });
});

describe("members", () => {
  it("returns an empty list for a portal with no members", async () => {
    expect(await getMembers(env, "realplus")).toEqual([]);
  });

  it("⭐ one write adds a person to every document a client has ever received", async () => {
    // The payoff of the whole data model. Permissions live on the portal, so this is
    // one write — not one per document.
    await putMembers(env, "realplus", ["cto@realplus.com", "eric@realplus.com"]);
    expect(await getMembers(env, "realplus")).toEqual(["cto@realplus.com", "eric@realplus.com"]);
  });

  it("normalizes and dedupes on write", async () => {
    await putMembers(env, "realplus", ["  CTO@RealPlus.com ", "cto@realplus.com", ""]);
    expect(await getMembers(env, "realplus")).toEqual(["cto@realplus.com"]);
  });

  it("replaces rather than merges", async () => {
    await putMembers(env, "realplus", ["a@x.com", "b@x.com"]);
    await putMembers(env, "realplus", ["b@x.com"]);
    expect(await getMembers(env, "realplus")).toEqual(["b@x.com"]);
  });

  it("keeps portals isolated from each other", async () => {
    await putMembers(env, "realplus", ["cto@realplus.com"]);
    await putMembers(env, "acme", ["cfo@acme.com"]);

    expect(await getMembers(env, "realplus")).toEqual(["cto@realplus.com"]);
    expect(await getMembers(env, "acme")).toEqual(["cfo@acme.com"]);
  });
});

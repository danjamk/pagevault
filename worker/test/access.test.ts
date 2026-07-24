import { describe, expect, it } from "vitest";
import { canView, emailsMatch } from "../src/access.js";
import type { DocMeta, Portal, PortalKind } from "../src/store.js";

/**
 * ⚠️ The authorization matrix.
 *
 * This is the only part of the system where a bug is a security incident rather than a
 * bug. `canView` is pure, so every cell is exercised here with no Worker, no KV, and no
 * routes — which is exactly why routes come after this file.
 *
 * Two things in here carry all the risk:
 *   - "member of a DIFFERENT portal" — cross-portal leakage. Business-ending.
 *   - "ownerOnly + extraEmails" — an ordering bug that silently leaks drafts while
 *     every other test in the suite still passes.
 */

const OWNER = "owner@example.com";
const MEMBER = "cto@realplus.com";
const OTHER_MEMBER = "cfo@acme.com";
const STRANGER = "nobody@example.com";

const portal = (kind: PortalKind, slug = "realplus"): Portal => ({
  slug,
  name: slug,
  kind,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const doc = (over: Partial<DocMeta> = {}): DocMeta => ({
  id: "k3x9mq2vb7pd",
  portal: "realplus",
  name: "q3-review.html",
  title: "Q3 Review",
  sourceKind: "html",
  ownerOnly: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  bytes: 100,
  ...over,
});

const see = (
  d: DocMeta,
  p: Portal,
  members: string[],
  email: string | null,
): boolean => canView(d, p, members, email, OWNER);

describe("emailsMatch", () => {
  it("is case- and whitespace-insensitive", () => {
    expect(emailsMatch("  CTO@RealPlus.com ", "cto@realplus.com")).toBe(true);
  });

  it("is false for null on either side", () => {
    expect(emailsMatch(null, OWNER)).toBe(false);
    expect(emailsMatch(OWNER, null)).toBe(false);
  });

  it("is false for empty strings — an unset owner must never match", () => {
    expect(emailsMatch("", "")).toBe(false);
  });
});

describe("canView — the owner", () => {
  it.each<[string, PortalKind]>([
    ["private", "private"],
    ["restricted", "restricted"],
    ["public", "public"],
  ])("sees everything in a %s portal", (_name, kind) => {
    expect(see(doc(), portal(kind), [], OWNER)).toBe(true);
  });

  it("sees their own ownerOnly drafts", () => {
    expect(see(doc({ ownerOnly: true }), portal("restricted"), [], OWNER)).toBe(true);
  });

  it("is matched case-insensitively", () => {
    expect(see(doc(), portal("private"), [], "Owner@Example.COM")).toBe(true);
  });
});

describe("canView — restricted portals", () => {
  it("lets a member in", () => {
    expect(see(doc(), portal("restricted"), [MEMBER], MEMBER)).toBe(true);
  });

  it("keeps a non-member out", () => {
    expect(see(doc(), portal("restricted"), [MEMBER], STRANGER)).toBe(false);
  });

  it("keeps an unauthenticated visitor out", () => {
    expect(see(doc(), portal("restricted"), [MEMBER], null)).toBe(false);
  });

  it("matches members case-insensitively", () => {
    expect(see(doc(), portal("restricted"), ["CTO@RealPlus.com"], MEMBER)).toBe(true);
  });
});

describe("canView — private portals", () => {
  it("keeps everyone but the owner out", () => {
    expect(see(doc(), portal("private"), [], MEMBER)).toBe(false);
    expect(see(doc(), portal("private"), [], STRANGER)).toBe(false);
    expect(see(doc(), portal("private"), [], null)).toBe(false);
  });

  it("ignores a member list, if one somehow exists", () => {
    // A private portal is the default bucket. Membership is not how you get in.
    expect(see(doc(), portal("private"), [MEMBER], MEMBER)).toBe(false);
  });
});

describe("canView — public portals", () => {
  it("lets anyone in, including the unauthenticated", () => {
    expect(see(doc(), portal("public"), [], null)).toBe(true);
    expect(see(doc(), portal("public"), [], STRANGER)).toBe(true);
  });
});

describe("canView — extraEmails is ADDITIVE, never subtractive", () => {
  it("grants access to one document in a private portal", () => {
    // The Spec 01 simple path: `publish report.html --emails cfo@acme.com`, with no
    // portal invented for two people. This is the case that must keep working.
    const d = doc({ extraEmails: [OTHER_MEMBER] });
    expect(see(d, portal("private"), [], OTHER_MEMBER)).toBe(true);
  });

  it("grants nothing on a DIFFERENT document in the same portal", () => {
    const granted = doc({ id: "aaa", extraEmails: [OTHER_MEMBER] });
    const other = doc({ id: "bbb" });

    expect(see(granted, portal("private"), [], OTHER_MEMBER)).toBe(true);
    expect(see(other, portal("private"), [], OTHER_MEMBER)).toBe(false);
  });

  it("never REMOVES access a portal already grants", () => {
    // A portal member is not affected by someone else's grant on this doc. If
    // extraEmails were ever treated as a replacement rather than an addition, this is
    // the test that catches it.
    const d = doc({ extraEmails: [OTHER_MEMBER] });
    expect(see(d, portal("restricted"), [MEMBER], MEMBER)).toBe(true);
  });

  it("matches case-insensitively", () => {
    const d = doc({ extraEmails: ["CFO@Acme.com"] });
    expect(see(d, portal("private"), [], OTHER_MEMBER)).toBe(true);
  });

  it("still requires authentication — it is not a public grant", () => {
    const d = doc({ extraEmails: [OTHER_MEMBER] });
    expect(see(d, portal("private"), [], null)).toBe(false);
  });
});

describe("⭐ canView — ownerOnly beats EVERY grant", () => {
  // The ordering bug. If `extraEmails` is checked before `ownerOnly`, drafts leak
  // silently and every other test in this file still passes.

  it("hides an ownerOnly draft from a portal member", () => {
    expect(see(doc({ ownerOnly: true }), portal("restricted"), [MEMBER], MEMBER)).toBe(false);
  });

  it("⭐ hides an ownerOnly draft from someone on its OWN extraEmails list", () => {
    const d = doc({ ownerOnly: true, extraEmails: [OTHER_MEMBER] });
    expect(see(d, portal("restricted"), [MEMBER], OTHER_MEMBER)).toBe(false);
  });

  it("⭐ hides an ownerOnly draft even in a PUBLIC portal", () => {
    // ownerOnly is evaluated before the public-portal check. A draft parked in the
    // public marketing portal must not be world-readable.
    const d = doc({ ownerOnly: true });
    expect(see(d, portal("public"), [], null)).toBe(false);
    expect(see(d, portal("public"), [], STRANGER)).toBe(false);
  });

  it("still lets the owner see it — ownerOnly narrows for others, not for you", () => {
    const d = doc({ ownerOnly: true, extraEmails: [OTHER_MEMBER] });
    expect(see(d, portal("public"), [], OWNER)).toBe(true);
  });
});

describe("🔴 canView — cross-portal isolation is absolute", () => {
  // Threat #1. A consultant leaking Client A's material into Client B's portal doesn't
  // lose a feature — they lose a business.
  //
  // `members` is always the member list of the portal the document is IN. These tests
  // pass Client B's document alongside Client A's member list, which is precisely what
  // a lookup bug would do.

  const clientA = [MEMBER];

  it.each<[string, PortalKind]>([
    ["private", "private"],
    ["restricted", "restricted"],
  ])("a member of client A sees nothing in client B's %s portal", (_name, kind) => {
    const clientBPortal = portal(kind, "acme");
    const clientBDoc = doc({ portal: "acme" });

    // Client B's portal has its own members, and Client A's CTO is not among them.
    expect(see(clientBDoc, clientBPortal, [OTHER_MEMBER], MEMBER)).toBe(false);

    // And even if a bug handed us Client A's member list against Client B's portal,
    // the answer must not become "yes" for anyone outside that list.
    expect(see(clientBDoc, clientBPortal, [], MEMBER)).toBe(false);
    expect(see(clientBDoc, clientBPortal, clientA, STRANGER)).toBe(false);
  });

  it("an extraEmails grant in portal A confers nothing in portal B", () => {
    const grantedInA = doc({ id: "aaa", portal: "realplus", extraEmails: [OTHER_MEMBER] });
    const inB = doc({ id: "bbb", portal: "acme" });

    expect(see(grantedInA, portal("private", "realplus"), [], OTHER_MEMBER)).toBe(true);
    expect(see(inB, portal("private", "acme"), [], OTHER_MEMBER)).toBe(false);
  });

  it("a public portal does not leak a restricted portal's documents", () => {
    const restrictedDoc = doc({ portal: "realplus" });
    expect(see(restrictedDoc, portal("restricted", "realplus"), [MEMBER], STRANGER)).toBe(false);
  });
});

describe("canView — an unset owner cannot be impersonated", () => {
  it("does not treat an empty email as the owner", () => {
    // A misconfigured deployment with a blank OWNER_EMAIL must not hand ownership to
    // anyone whose email normalizes to "". Publishing already refuses in that state
    // (api.ts), but canView must not depend on that having happened.
    expect(canView(doc(), portal("private"), [], "", "")).toBe(false);
    expect(canView(doc(), portal("private"), [], null, "")).toBe(false);
  });
});

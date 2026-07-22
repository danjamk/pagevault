import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { recordView } from "../src/analytics.js";
import type { Env } from "../src/env.js";
import type { DocMeta } from "../src/store.js";

/**
 * 🔴 The privacy rule from ADR-015, decision 1, as a test.
 *
 * Identity is recorded where Cloudflare Access established it, and nowhere else. `/pub` and
 * `/p` have no Access application in front of them by design, so there is no identity to
 * record — and the rule is enforced on the *surface*, not on whether the caller happened to
 * pass null. A future route that threads an email into a public view must not be able to
 * write it, and that is what these assert.
 */

const doc = (over: Partial<DocMeta> = {}): DocMeta => ({
  id: "k3x9mq2vb7pd",
  portal: "acme",
  title: "Q3 Review",
  sourceKind: "html",
  ownerOnly: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  bytes: 128,
  ...over,
});

interface Point {
  indexes?: string[];
  blobs?: string[];
  doubles?: number[];
}

/** A stand-in for the binding, so we can read back exactly what would be written. */
function fakeDataset() {
  const points: Point[] = [];
  return {
    points,
    env: { ...env, ANALYTICS: { writeDataPoint: (p: Point) => void points.push(p) } } as unknown as Env,
  };
}

/** Blob order is fixed by recordView: id, title, surface, viewer. */
const viewerOf = (p: Point) => p.blobs?.[3];

describe("recordView — what a view record contains", () => {
  it("records the verified email on the Access-gated surface", () => {
    const { points, env: e } = fakeDataset();

    recordView(e, doc(), "portal", "cfo@acme.com");

    expect(points).toHaveLength(1);
    expect(viewerOf(points[0]!)).toBe("cfo@acme.com");
  });

  it("🔴 records no viewer on a public view, even when handed one", () => {
    const { points, env: e } = fakeDataset();

    // A caller passing an email here is the bug this guards against — /pub has no Access
    // app, so any email reaching it did not come from a verified JWT.
    recordView(e, doc(), "public", "cfo@acme.com");

    expect(viewerOf(points[0]!)).toBe("");
  });

  it("🔴 records no viewer on a capability-link view, even when handed one", () => {
    const { points, env: e } = fakeDataset();

    recordView(e, doc(), "link", "cfo@acme.com");

    expect(viewerOf(points[0]!)).toBe("");
  });

  it("partitions on the portal slug — the client boundary", () => {
    const { points, env: e } = fakeDataset();

    recordView(e, doc({ portal: "realplus" }), "portal", null);

    // Exactly one index. A second would be silently dropped, not rejected.
    expect(points[0]!.indexes).toEqual(["realplus"]);
  });

  it("carries the document, title and surface", () => {
    const { points, env: e } = fakeDataset();

    recordView(e, doc(), "link", null);

    expect(points[0]!.blobs).toEqual(["k3x9mq2vb7pd", "Q3 Review", "link", ""]);
  });

  it("🔴 stores no count, so sum(double1) cannot be written by accident", () => {
    const { points, env: e } = fakeDataset();

    recordView(e, doc(), "portal", "cfo@acme.com");

    // Analytics Engine samples at volume; the correct aggregate is always
    // sum(_sample_interval). A stored 1 invites the wrong query and reads plausibly.
    expect(points[0]!.doubles).toEqual([]);
  });

  it("is a no-op when the deployment opted out of the binding", () => {
    const without = { ...env, ANALYTICS: undefined } as unknown as Env;

    expect(() => recordView(without, doc(), "portal", "cfo@acme.com")).not.toThrow();
  });
});

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncGroupMembers } from "../src/access-group.js";
import type { Env } from "../src/env.js";

/**
 * The ADR-002 hot path. These drive the real code against a stubbed Cloudflare Access API
 * and assert the exact PUT body — so breaking the union, dropping the owner, or skipping
 * the config guard makes a test fail, not just a coverage number move.
 */

const OWNER = "owner@example.com";
const ACCOUNT = "acct-123";
const GROUP = "group-abc";
const GROUP_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/access/groups/${GROUP}`;

const testEnv = (over: Partial<Env> = {}, unset: (keyof Env)[] = []): Env => {
  const e: Env = { ...env, CF_API_TOKEN: "cf-token", CF_ACCOUNT_ID: ACCOUNT, CF_ACCESS_GROUP_ID: GROUP, ...over };
  for (const key of unset) delete (e as unknown as Record<string, unknown>)[key];
  return e;
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

interface StubOpts {
  readOk?: boolean;
  putOk?: boolean;
  exclude?: unknown[];
  require?: unknown[];
}

/** A fetch stub backed by an in-memory group. Records every call and its parsed body. */
function stubCf(initialEmails: string[], opts: StubOpts = {}) {
  const state = {
    name: "pagevault-viewers",
    include: initialEmails.map((email) => ({ email: { email } })),
    exclude: opts.exclude ?? [],
    require: opts.require ?? [],
  };
  const calls: { method: string; body?: Record<string, unknown> }[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    calls.push({ method, body: init?.body ? JSON.parse(init.body as string) : undefined });

    if (url !== GROUP_URL) return new Response("not found", { status: 404 });
    if (method === "GET") {
      if (opts.readOk === false) return json({ success: false, errors: [{ code: 1000, message: "no read" }] }, 403);
      return json({ success: true, result: state });
    }
    if (method === "PUT") {
      if (opts.putOk === false) return json({ success: false, errors: [{ code: 1001, message: "denied" }] }, 403);
      return json({ success: true, result: state });
    }
    return new Response("bad method", { status: 405 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

const putBodyEmails = (calls: { method: string; body?: Record<string, unknown> }[]): string[] => {
  const put = calls.find((c) => c.method === "PUT");
  const include = (put?.body?.include as { email: { email: string } }[]) ?? [];
  return include.map((r) => r.email.email);
};

afterEach(() => vi.unstubAllGlobals());

describe("syncGroupMembers", () => {
  it("adds a newly granted email and carries the existing owner through the PUT", async () => {
    const { calls } = stubCf([OWNER]);

    const res = await syncGroupMembers(testEnv(), ["cfo@acme.com"]);

    expect(res).toEqual({ status: "synced", added: ["cfo@acme.com"] });
    const emails = putBodyEmails(calls);
    expect(emails).toContain("cfo@acme.com");
    expect(emails).toContain(OWNER); // full-replacement PUT must never drop the owner
  });

  it("normalizes and dedups — a case variant of an existing member writes nothing", async () => {
    const { calls } = stubCf(["cfo@acme.com"]);

    const res = await syncGroupMembers(testEnv(), ["  CFO@Acme.com "]);

    expect(res).toEqual({ status: "noop" });
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("🔴 makes no request at all when CF_API_TOKEN is unset — Tier 0", async () => {
    const { calls } = stubCf([OWNER]);

    const res = await syncGroupMembers(testEnv({}, ["CF_API_TOKEN"]), ["x@acme.com"]);

    expect(res).toEqual({ status: "not_configured" });
    expect(calls).toHaveLength(0);
  });

  it("is not_configured when the account or group id is missing", async () => {
    stubCf([OWNER]);
    expect(await syncGroupMembers(testEnv({}, ["CF_ACCOUNT_ID"]), ["x@acme.com"])).toEqual({
      status: "not_configured",
    });
    expect(await syncGroupMembers(testEnv({}, ["CF_ACCESS_GROUP_ID"]), ["x@acme.com"])).toEqual({
      status: "not_configured",
    });
  });

  it("reports failure when the group read fails, and never PUTs", async () => {
    const { calls } = stubCf([OWNER], { readOk: false });

    const res = await syncGroupMembers(testEnv(), ["x@acme.com"]);

    expect(res.status).toBe("failed");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("reports failure when the group update (PUT) fails", async () => {
    stubCf([OWNER], { putOk: false });

    const res = await syncGroupMembers(testEnv(), ["x@acme.com"]);

    expect(res.status).toBe("failed");
  });

  it("is a noop for an empty email list and makes no request", async () => {
    const { calls } = stubCf([OWNER]);

    const res = await syncGroupMembers(testEnv(), []);

    expect(res).toEqual({ status: "noop" });
    expect(calls).toHaveLength(0);
  });

  it("carries exclude/require through so a PUT never clears them", async () => {
    const requireRule = [{ email_domain: { domain: "acme.com" } }];
    const { calls } = stubCf([OWNER], { require: requireRule });

    await syncGroupMembers(testEnv(), ["x@acme.com"]);

    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body?.require).toEqual(requireRule);
  });
});

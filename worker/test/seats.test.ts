import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { FREE_PLAN_SEATS, countAccessSeats } from "../src/seats.js";

/**
 * Access seat counting (#44).
 *
 * The one failure this must never have is reporting **zero** when it could not ask. At the free
 * plan's 50 seats Cloudflare blocks new logins with no notification at any tier, so a readout that
 * says "0 seats" because the API call failed reads as plenty of room at exactly the moment logins
 * are being refused. Every test below exists to keep `failed` and `not_configured` distinct from a
 * genuine count of zero.
 */

const ACCOUNT = "acct-123";
const usersUrl = (page: number) =>
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/access/users?per_page=1000&page=${page}`;

const testEnv = (over: Partial<Env> = {}, unset: (keyof Env)[] = []): Env => {
  const e: Env = { ...env, CF_API_TOKEN: "cf-token", CF_ACCOUNT_ID: ACCOUNT, ...over };
  for (const key of unset) delete (e as unknown as Record<string, unknown>)[key];
  return e;
};

const json = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

/** A Cloudflare users page. `seats`/`noSeats` control how many carry access_seat. */
const usersPage = (seats: number, noSeats = 0, page = 1, totalPages = 1) =>
  json({
    success: true,
    result: [
      ...Array.from({ length: seats }, () => ({ access_seat: true, gateway_seat: false })),
      ...Array.from({ length: noSeats }, () => ({ access_seat: false, gateway_seat: true })),
    ],
    result_info: { page, total_pages: totalPages },
  });

afterEach(() => vi.restoreAllMocks());

describe("countAccessSeats", () => {
  it("counts only users holding an Access seat", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(usersPage(3, 4));

    const r = await countAccessSeats(testEnv());
    expect(r).toEqual({ status: "ok", used: 3, limit: FREE_PLAN_SEATS, atLimit: false });
  });

  it("sends the Worker's runtime token, not a wider credential", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(usersPage(1));

    await countAccessSeats(testEnv());
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(usersUrl(1));
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer cf-token");
  });

  it("flags at-limit exactly at the ceiling, not one past it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(usersPage(FREE_PLAN_SEATS));

    const r = await countAccessSeats(testEnv());
    expect(r).toMatchObject({ status: "ok", used: FREE_PLAN_SEATS, atLimit: true });
  });

  it("is not at-limit one seat below", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(usersPage(FREE_PLAN_SEATS - 1));

    expect(await countAccessSeats(testEnv())).toMatchObject({ atLimit: false });
  });

  it("follows pagination — an account can hold more users than seats", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(usersPage(2, 0, 1, 3))
      .mockResolvedValueOnce(usersPage(3, 5, 2, 3))
      .mockResolvedValueOnce(usersPage(1, 0, 3, 3));

    expect(await countAccessSeats(testEnv())).toMatchObject({ used: 6 });
  });

  // --- the ones that matter ---------------------------------------------------------------

  it("reports not_configured — never zero — when there is no Access on this deployment", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    expect(await countAccessSeats(testEnv({}, ["CF_API_TOKEN"]))).toEqual({ status: "not_configured" });
    expect(await countAccessSeats(testEnv({}, ["CF_ACCOUNT_ID"]))).toEqual({ status: "not_configured" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports failed — never zero — on an HTTP error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ success: false }, 403));

    const r = await countAccessSeats(testEnv());
    expect(r.status).toBe("failed");
    expect(r).not.toHaveProperty("used");
  });

  it("reports failed — never zero — on a Cloudflare error envelope", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }),
    );

    const r = await countAccessSeats(testEnv());
    expect(r).toMatchObject({ status: "failed" });
    expect((r as { error: string }).error).toContain("Authentication error");
  });

  it("reports failed — never zero — when the network throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection reset"));

    expect(await countAccessSeats(testEnv())).toEqual({ status: "failed", error: "connection reset" });
  });

  it("counts a genuinely empty account as zero, distinctly from a failure", async () => {
    // The mirror of the tests above: zero IS a valid answer when we successfully asked.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(usersPage(0));

    expect(await countAccessSeats(testEnv())).toEqual({ status: "ok", used: 0, limit: FREE_PLAN_SEATS, atLimit: false });
  });

  it("stops pagination rather than looping forever on a bad total_pages", async () => {
    // Cloudflare claiming 9999 pages must not hold the console's request open indefinitely.
    //
    // mockImplementation, not mockResolvedValue: the latter hands back the SAME Response every
    // call, and a Response body can only be read once — so the second page would throw and the
    // count would come back `failed`, testing the mock rather than the cap.
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(usersPage(1, 0, 1, 9999)));

    const r = await countAccessSeats(testEnv());
    expect(r.status).toBe("ok");
    expect(spy.mock.calls.length).toBe(20);
    expect(r).toMatchObject({ used: 20 });
  });
});

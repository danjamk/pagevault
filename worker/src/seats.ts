import type { Env } from "./env.js";

/**
 * Cloudflare Access seat usage — the number that quietly ends a consulting engagement.
 *
 * At the free plan's 50 seats Cloudflare **blocks new logins**. There is no auto-bill, no grace,
 * and no seat-limit notification at any tier — the first sign is a client saying your report will
 * not open. `docs/adr/ADR-002-seat-bounding.md` is about bounding seat *consumption*; nothing ever
 * showed the operator the running total (#44).
 *
 * This is deliberately the whole feature: a count, shown in the console. No cron, no webhook, no
 * alerting. PageVault is single-operator infrastructure, so the person who would receive the alert
 * is the person already looking at the console when something breaks.
 *
 * ## Why this can use the Worker's own token
 *
 * `GET /accounts/{id}/access/users` is readable with the *narrow* runtime credential the Worker
 * already holds — one permission, "Access: Organizations, Identity Providers, and Groups"
 * (`cli/lib/provision/provision.mjs`). Verified against the live API before this was written. So
 * no widening, no second secret, and no re-provisioning for existing operators. Had it needed an
 * account-wide token this would have belonged in the CLI instead, next to `views` (ADR-015).
 *
 * ## Seats are consumed by LOGIN, not by membership
 *
 * Adding an email to a portal costs nothing until that person actually authenticates. So this
 * count is not derivable from KV or from the viewer group — the group is who *may* log in, and
 * the seat count is who *has*. Showing group size in its place would be a plausible number that
 * is not the one that blocks logins, which is worse than showing nothing.
 */

const CF_API = "https://api.cloudflare.com/client/v4";

/**
 * Cloudflare's free Zero Trust allowance. An ASSUMPTION, not an observation: reading the account's
 * actual plan needs billing scope the Worker deliberately does not hold, so this number is stated
 * as the free-plan figure wherever it is shown, and never as "your limit". A paid operator sees
 * their real count against a ceiling labelled as the free plan's, and can disregard it.
 */
export const FREE_PLAN_SEATS = 50;

export type SeatUsage =
  | { status: "ok"; used: number; limit: number; atLimit: boolean } //  counted
  | { status: "not_configured" } //  Public tier, or no runtime token — there are no Access seats
  | { status: "failed"; error: string }; //  configured, but Cloudflare did not answer

interface AccessUser {
  access_seat?: boolean;
}

/**
 * Count the Access seats in use on this account.
 *
 * Never throws and never guesses: a failure is reported as `failed`, not as zero. A zero that
 * actually means "we could not ask" is the failure mode this repo keeps relearning — a reading
 * that cannot fail gets believed, and here it would read as "plenty of room" at exactly the
 * moment logins are being blocked.
 */
export async function countAccessSeats(env: Env): Promise<SeatUsage> {
  const token = env.CF_API_TOKEN;
  const account = env.CF_ACCOUNT_ID;

  // Public deployments have no Cloudflare Access in front of them, so no seat is ever consumed.
  // Same shape as syncGroupMembers' not_configured — the caller shows nothing rather than a zero.
  if (!token || !account) return { status: "not_configured" };

  let used = 0;
  let page = 1;
  try {
    // Paginate. An account near the limit still fits in one page at per_page=1000, but an
    // operator sharing the account with other Zero Trust apps can hold far more users than seats.
    for (;;) {
      const url = `${CF_API}/accounts/${account}/access/users?per_page=1000&page=${page}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return { status: "failed", error: `HTTP ${res.status}` };

      const body = (await res.json()) as {
        success?: boolean;
        result?: AccessUser[];
        result_info?: { page?: number; total_pages?: number };
        errors?: { code?: number; message?: string }[];
      };
      if (!body.success) {
        const first = body.errors?.[0];
        return { status: "failed", error: first ? `${first.code ?? ""} ${first.message ?? ""}`.trim() : "unknown error" };
      }

      used += (body.result ?? []).filter((u) => u.access_seat === true).length;

      const total = body.result_info?.total_pages ?? 1;
      if (page >= total) break;
      page++;
      // A runaway pager would hold the console's request open; the free plan tops out at 50 seats
      // and this loop exists only for accounts with unrelated Zero Trust users.
      if (page > 20) break;
    }
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }

  return { status: "ok", used, limit: FREE_PLAN_SEATS, atLimit: used >= FREE_PLAN_SEATS };
}

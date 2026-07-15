import type { Env } from "./env.js";
import { normalizeEmail } from "./store.js";

/**
 * The `pagevault-viewers` Access group — the ADR-002 hot path.
 *
 * Cloudflare Access admits only members of this group to `/v/*`. `canView()` then does the
 * real per-document authorization. So a granted email is useless until it is *also* in the
 * group: Access stops the person at the door before the Worker ever runs. This module puts
 * them in the group.
 *
 * Access is a second source of truth alongside KV, and the two can drift. KV is
 * authoritative; this sync is best-effort-but-loud. The `sync-access` reconciler (future,
 * #20 out-of-scope) rebuilds the group from KV exactly and repairs drift.
 */

const CF_API = "https://api.cloudflare.com/client/v4";

/**
 * The outcome of admitting emails to the group. Every case is explicit, because the one
 * thing ADR-002 forbids is a silent half-success — a grant that lands in KV while Access
 * still blocks the person and nobody is told.
 */
export type GroupSyncResult =
  | { status: "synced"; added: string[] } // PUT succeeded; these addresses were newly added
  | { status: "noop" } //                   nothing to do — already present, or no emails
  | { status: "not_configured" } //         Tier 0: no CF_API_TOKEN / ids. Email-secured is unavailable.
  | { status: "failed"; error: string }; // configured, but the Cloudflare API call failed

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Flatten Cloudflare's error envelope to one line. */
function cfError(body: unknown, status: number, action: string): string {
  const errors = (body as { errors?: { code?: number; message?: string }[] } | null)?.errors;
  const first = Array.isArray(errors) && errors.length > 0 ? errors[0] : null;
  const detail = first ? `${first.code ?? ""} ${first.message ?? ""}`.trim() : `HTTP ${status}`;
  return `${action}: ${detail}`;
}

interface AccessGroup {
  name: string;
  include?: unknown[];
  exclude?: unknown[];
  require?: unknown[];
}

/**
 * Add `emails` to the viewer group so Cloudflare Access will admit them.
 *
 * Additive and idempotent: read the group, union in the addresses not already present, and
 * PUT the full include list back. An Access group PUT is a **full replacement**, so the
 * existing members — including the owner seeded at provision time — are read and carried
 * through, never omitted. `exclude`/`require` are passed through for the same reason.
 *
 * Read-modify-write: under concurrent publishes two syncs can race and lose an update. That
 * is acceptable for single-operator infrastructure; the reconciler repairs it from KV.
 */
export async function syncGroupMembers(env: Env, emails: string[]): Promise<GroupSyncResult> {
  const token = env.CF_API_TOKEN;
  const account = env.CF_ACCOUNT_ID;
  const groupId = env.CF_ACCESS_GROUP_ID;

  // Tier 0 (ADR-008): there is no Access application, so no one to admit and nothing to
  // sync. Callers turn this into a clear "enable portals first" rather than a quiet no-op.
  if (!token || !account || !groupId) return { status: "not_configured" };

  const wanted = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  if (wanted.length === 0) return { status: "noop" };

  const url = `${CF_API}/accounts/${account}/access/groups/${groupId}`;

  let group: AccessGroup;
  try {
    const res = await fetch(url, { headers: authHeaders(token) });
    const body = (await res.json()) as { success?: boolean; result?: AccessGroup };
    if (!res.ok || !body?.success || !body.result) {
      return { status: "failed", error: cfError(body, res.status, "read group") };
    }
    group = body.result;
  } catch (e) {
    return { status: "failed", error: `read group: ${errText(e)}` };
  }

  const include = Array.isArray(group.include) ? group.include : [];
  const present = new Set(
    include
      .map((rule) => (rule as { email?: { email?: string } })?.email?.email)
      .filter((e): e is string => typeof e === "string")
      .map(normalizeEmail),
  );

  const toAdd = wanted.filter((email) => !present.has(email));
  if (toAdd.length === 0) return { status: "noop" };

  const nextInclude = [...include, ...toAdd.map((email) => ({ email: { email } }))];

  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({
        name: group.name,
        include: nextInclude,
        exclude: group.exclude ?? [],
        require: group.require ?? [],
      }),
    });
    const body = (await res.json()) as { success?: boolean };
    if (!res.ok || !body?.success) {
      return { status: "failed", error: cfError(body, res.status, "update group") };
    }
  } catch (e) {
    return { status: "failed", error: `update group: ${errText(e)}` };
  }

  return { status: "synced", added: toAdd };
}

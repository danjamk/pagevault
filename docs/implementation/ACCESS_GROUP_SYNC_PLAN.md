# Implementation Plan — Access group sync (#20)

Make email-secured sharing work end to end. Today a granted email lands in
`canView()` but Cloudflare Access blocks the person before the Worker runs, because
they are not in `pagevault-viewers`. This wires the ADR-002 hot path: on grant, union
the email into the group so Access admits them and `canView()` does the real check.

Implements ADR-002. Reclassified as a **Tier-1 feature** by ADR-008 — which also
resolves the unset-token behavior below.

## What "done" looks like

- Publishing a document with `emails: ["x@acme.com"]` results in `x@acme.com` being a
  member of the `pagevault-viewers` Access group, and that person can complete the
  OTP login and open the document at `/v/...`. **Verified against the live deploy by
  actually logging in as a second identity — not just a green test.**
- With no `CF_API_TOKEN`, a grant-with-emails fails loudly and clearly, never silently.
- The owner is always in the group and is never removed by this path.

## The gap this plan closes first (not in the issue)

To call `PUT /accounts/{account_id}/access/groups/{group_id}` the Worker needs the
account ID and group ID. It has **neither** — `env.ts` carries `CF_API_TOKEN?` but no
ids, and the generated config carries only the AUDs. So step 1 is plumbing:

- `env.ts` — declare `CF_ACCOUNT_ID?` and `CF_ACCESS_GROUP_ID?`.
- `scripts/provision.mjs` — write both into the generated config (it holds `account.id`
  and `group.id` at provision time; both are already in `.pagevault-provision.json`).
- Live deploy — set the two vars and the `CF_API_TOKEN` **secret** (the Worker has none
  today), then redeploy, to test.

## Design

### New module: `worker/src/access-group.ts`

A minimal Cloudflare Access API client — the only place that talks to the group.

```
syncGroupMembers(env, emails: string[]): Promise<GroupSyncResult>
```

- **Guard first.** If `CF_API_TOKEN`, `CF_ACCOUNT_ID`, or `CF_ACCESS_GROUP_ID` is
  missing → return `{ status: "not_configured" }`. This is the Tier-0 case: email-
  secured is not available. Callers turn this into a loud, specific error (below).
- **Read-modify-write.** GET the group, read `include`, add `{ email: { email } }` for
  each new address not already present (dedup with `normalizeEmail`/`emailsMatch`, so a
  case difference is not a duplicate), then PUT `{ name, include }` — a **full
  replacement**, which is why the GET must preserve everything already there.
- **Owner preserved.** Because the path is additive (union, never subtract), the owner
  seeded at provision time stays. Tests assert it.
- **Lost-update race.** GET→PUT under concurrent publishes can drop an update. A comment
  says so. Acceptable for single-operator; the `sync-access` reconciler (out of scope,
  future) repairs it exactly.

`GroupSyncResult` = `{ status: "synced" | "not_configured" | "failed", added?: string[], error?: string }`.

### Failure semantics (decided)

1. **`not_configured`** → the grant is refused. `publish_document`/`update_portal_members`/
   `create_portal` return a clear error: *"email-secured sharing needs portals enabled
   (CF_API_TOKEN unset). Public links still work."* Never a silent half-success. Update
   the stale `env.ts` comment that still cites the superseded `Include: Everyone`
   fallback (ADR-008).
2. **`failed`** (token present, PUT errored) → KV keeps the grant (KV is the source of
   truth; the reconciler repairs from it), but the tool result says plainly: *"granted in
   PageVault, but not yet admitted to Access — reconcile or retry."* The doc and any
   public link are still valid; only email-admit is degraded. We do **not** report
   success.

Ordering everywhere: **write the grant to KV first, then sync to Access.** KV is
authoritative; Access is derived (ADR-002).

### Wiring — the three grant points (`worker/src/mcp.ts`, `documents.ts`)

- `publish_document` with `emails` → `documents.ts` stores `extraEmails` (line 164), then
  `syncGroupMembers(env, newEmails)`.
- `update_portal_members` → after `putMembers` (mcp.ts:216), sync the added emails.
- `create_portal` (kind `restricted`) with initial members → sync them.

A shared helper appends the admission status to each tool's text result, so the three
sites report consistently.

## Tests (`worker/test/`) — mutation-tested

- Granting an email issues a group `PUT` whose `include` contains that email
  (stub `fetch`, assert the request body). Break the union → test fails.
- Owner is always present in the PUT body.
- Case-insensitive dedup: granting `X@Acme.com` when `x@acme.com` is present adds nothing.
- `not_configured`: missing `CF_API_TOKEN` → grant refused with the specific error,
  **no** `fetch` to the CF API.
- `failed`: PUT returns non-2xx → tool reports the degraded status, KV grant still present.
- The security suite stays honest — no test may pass with the sync stubbed to a no-op.

## Live verification (the part that matters)

1. Retrieve `account_id` + group `id` from `.pagevault-provision.json` (or via the CF API).
2. Add `CF_ACCOUNT_ID` + `CF_ACCESS_GROUP_ID` vars to the generated config; set the
   `CF_API_TOKEN` secret on the Worker; `make deploy`.
3. Publish a throwaway doc to a restricted portal granting a **second** email you control.
4. Open `/v/...` as that identity in a clean browser, complete the OTP, confirm the doc
   opens. Then confirm a *non*-granted third address is denied at the Access wall.
5. Revoke the throwaway. Note the seat now held (ADR-002: reaping is a deliberate op).

## Out of scope (follow-on)

`sync-access` reconciler (recompute the union from KV, full-replacement PUT) and `--reap`.
Needs the CLI (#7) or console (#5). Tracked separately.

## Step order

1. Config plumbing (`env.ts`, `provision.mjs`).
2. `access-group.ts` + unit tests.
3. Wire the three grant points + result messaging.
4. Full `make check`.
5. Live deploy + the end-to-end login test above.
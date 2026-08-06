//
// The view-tracking read path (#91) — the engine behind `make views` and `pagevault views`.
//
// 🔴 This is the ONE operator capability that does not reach the Worker, and that is deliberate.
// Analytics Engine's binding is write-only; reading needs the SQL API and an account-scoped
// `Account Analytics Read` token — strictly wider than the Access-group-scoped CF_API_TOKEN the
// Worker holds. Putting it in the Worker is exactly the blast-radius widening ADR-002 exists to
// prevent, so the Worker writes and the operator reads. See ADR-015, decision 6.
//
// The practical consequence: *reading* is CLI-only — the MCP server runs *inside* the Worker, so
// it cannot query analytics without holding a credential that can read the whole account's.
// `backup` and `restore` are CLI-only for the same shape of reason, with a wider token still (it
// can delete namespaces).
//
// What DOES reach MCP is the answer, not the capability: `views --sync` aggregates here and PUTs
// a summary into one KV key, which `list_documents` / `read_document` then serve (#127, ADR-019).
// So the parity exception narrowed rather than closed — the CLI keeps identities and arbitrary
// windows; MCP gets counts and surfaces as of the last sync.
//
// Zero dependencies. Node built-ins only.
//

export const DATASET = "pagevault_views";

/** A user-facing failure: the front doors print `.message` plainly, no stack. */
export class ViewsError extends Error {}

/**
 * Blob positions are fixed by `recordView` in worker/src/analytics.ts. If that order ever
 * changes, this changes with it — there is no schema registry, and Analytics Engine will
 * happily return whatever is in blob2 under whatever name we ask for.
 */
const SELECT = [
  "index1 AS portal",
  "blob1 AS doc",
  "blob2 AS title",
  "blob3 AS surface",
  "blob4 AS viewer",
  // 🔴 sum(_sample_interval), never count(). Analytics Engine samples under load and reports
  // the sampling rate per row; count() silently under-reports once sampling kicks in, and it
  // under-reports by exactly the amount that makes the number look plausible.
  "sum(_sample_interval) AS views",
  "max(timestamp) AS last_view",
].join(", ");

/**
 * Query recent views.
 *
 * `days` is capped by reality, not by us: Analytics Engine retains three months, so anything
 * past ~90 returns nothing rather than erroring. The callers say so in their help text.
 */
export async function queryViews({ accountId, token }, opts = {}) {
  if (!accountId) {
    // Naming BOTH doors was wrong for an installed package (it does not have `make`), and pointing
    // an operator whose production is deployed by CI at `init` is worse than unhelpful — that
    // command would deploy production from their laptop (#144). `--account` has always existed
    // here; it was simply never mentioned, which left the CI-deployed case with no answer at all.
    // No `runHint` here: this module is deliberately dependency-free (see the header), and
    // importing it would drag the whole provision tree in to phrase one sentence. So the message
    // names the escape hatch rather than the setup command — which is the half that was missing.
    throw new ViewsError(
      "No Cloudflare account id. Views come from Analytics Engine, read with YOUR Cloudflare\n" +
        "credential — the Worker's binding is write-only, so it can never answer this itself\n" +
        "(ADR-015).\n\n" +
        "If this machine provisioned the deployment, set it up so the account id is recorded.\n" +
        "If it did not — production deployed by CI, for instance — name the account yourself:\n\n" +
        "  CLOUDFLARE_API_TOKEN=… pagevault views --account <account-id>\n\n" +
        "A token scoped to Account Analytics (Read) is enough, and cannot deploy or destroy.",
    );
  }
  if (!token) {
    throw new ViewsError(
      "No CLOUDFLARE_API_TOKEN. Reading views needs a token with the Account Analytics Read permission.",
    );
  }

  const days = Number(opts.days ?? 30);
  if (!Number.isFinite(days) || days <= 0) throw new ViewsError(`--days must be a positive number, got "${opts.days}".`);
  const limit = Number(opts.limit ?? 100);

  const where = [`timestamp > NOW() - INTERVAL '${Math.floor(days)}' DAY`];
  // Values are quoted through sqlString rather than interpolated: a portal slug is operator
  // input, but a document id can come off a URL, and a broken query is a worse error message
  // than a rejected argument.
  if (opts.portal) where.push(`index1 = ${sqlString(opts.portal)}`);
  if (opts.doc) where.push(`blob1 = ${sqlString(opts.doc)}`);

  const sql = [
    `SELECT ${SELECT}`,
    `FROM ${DATASET}`,
    `WHERE ${where.join(" AND ")}`,
    "GROUP BY portal, doc, title, surface, viewer",
    "ORDER BY views DESC",
    `LIMIT ${Math.floor(limit)}`,
    "FORMAT JSON",
  ].join("\n");

  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
    body: sql,
  });

  const body = await res.text();

  if (!res.ok) throw new ViewsError(explain(res.status, body));

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ViewsError(`Analytics Engine returned something that isn't JSON:\n${body.slice(0, 300)}`);
  }

  return {
    days: Math.floor(days),
    rows: (parsed.data ?? []).map((r) => ({
      portal: r.portal ?? "",
      doc: r.doc ?? "",
      title: r.title ?? "",
      surface: r.surface ?? "",
      // Empty by construction on the public and capability surfaces — they have no Access
      // application in front of them, so there was never an identity to record (ADR-015).
      viewer: r.viewer || null,
      views: Number(r.views ?? 0),
      lastView: r.last_view ?? null,
    })),
  };
}

/**
 * Aggregate query rows into the summary the Worker stores, so MCP can answer "did the client
 * actually open it?" without the Worker ever holding an analytics token (#127, ADR-019).
 *
 * Pure: the caller supplies `syncedAt` and the set of ids that still exist, so the whole thing is
 * testable with no network and no clock.
 *
 * 🔴 Counts and surfaces, never identities (ADR-019 decision 4). `viewer` is on every row and is
 * dropped here on purpose. "Opened four times through the public link, never by a signed-in
 * member" is useful and identifies nobody; putting an email within reach of an LLM is a separate
 * decision to be made on its own merits. The CLI table keeps identities — an operator reading
 * their own dashboard is a different act from an agent summarizing it.
 */
export function summarizeViews({ days, rows }, { syncedAt, knownIds = null } = {}) {
  // Null-prototype: keys are document ids that arrived from Cloudflare, and `__proto__` on a
  // normal object literal would set the prototype rather than store a count.
  const docs = Object.create(null);
  const skipped = new Set();

  for (const r of rows) {
    if (!r.doc) continue;

    // The dataset is account-level and outlives the deployment that wrote it (#129), so rows can
    // name documents that were revoked or torn down. Dropping them keeps the one KV key bounded
    // and stops MCP reporting metrics for something `list_documents` will never return.
    if (knownIds && !knownIds.has(r.doc)) {
      skipped.add(r.doc);
      continue;
    }

    const entry = (docs[r.doc] ??= { views: 0, lastViewedAt: null, surfaces: { link: 0, public: 0, portal: 0 } });
    entry.views += r.views;
    // hasOwn, not `in` — `in` also matches inherited members, so an unexpected surface value
    // would land on Object.prototype's namespace and produce NaN.
    if (Object.hasOwn(entry.surfaces, r.surface)) entry.surfaces[r.surface] += r.views;

    const seen = toIso(r.lastView);
    if (seen && (!entry.lastViewedAt || seen > entry.lastViewedAt)) entry.lastViewedAt = seen;
  }

  return { summary: { syncedAt, windowDays: days, docs }, skipped: [...skipped] };
}

/**
 * Analytics Engine hands back timestamps as ClickHouse DateTime (`2026-07-26 18:04:00`, UTC),
 * not ISO. Normalize so the stored summary reads the same shape whichever came back, and so the
 * string comparison above genuinely picks the latest view.
 */
function toIso(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  const t = s.includes("T") ? s : s.replace(" ", "T");
  return /(Z|[+-]\d{2}:?\d{2})$/.test(t) ? t : `${t}Z`;
}

/**
 * Turn the three failures that actually happen into the thing that fixes them. Everything else
 * passes through — a wrong guess dressed up as advice is worse than the raw response.
 */
function explain(status, body) {
  if (status === 403 || /authorization error/i.test(body)) {
    return [
      "Cloudflare refused the analytics query (403).",
      "",
      "The deploy token almost certainly lacks one permission. In the dashboard:",
      "  My Profile → API Tokens → your PageVault token → Edit →",
      "  add  Account · Account Analytics · Read",
      "",
      "This permission stays on your machine. The Worker never gets it — that is the point",
      "of ADR-015 decision 6, and it is why this command is not an MCP tool.",
    ].join("\n");
  }
  if (/unknown (table|dataset)|doesn't exist|does not exist/i.test(body)) {
    return [
      `No \`${DATASET}\` dataset on this account yet.`,
      "",
      "It materializes on the first write, so this means no document has been opened since",
      "view tracking was enabled. Open one and try again.",
    ].join("\n");
  }
  return `Analytics Engine query failed (${status}):\n${body.slice(0, 400)}`;
}

/** Single-quoted SQL literal. Analytics Engine's SQL escapes a quote by doubling it. */
const sqlString = (v) => `'${String(v).replaceAll("'", "''")}'`;

/**
 * Render rows as a table. Shared by both front doors so `make views` and `pagevault views`
 * cannot drift into two different-looking reports of the same data.
 */
export function formatViews({ days, rows }, c) {
  const dim = c?.dim ?? ((s) => s);
  const bold = c?.bold ?? ((s) => s);

  if (rows.length === 0) {
    return [
      `No views recorded in the last ${plural(days, "day")}.`,
      dim("Analytics Engine retains 3 months; a view lands within a minute of the page opening."),
    ].join("\n");
  }

  const head = ["VIEWS", "DOCUMENT", "PORTAL", "HOW", "WHO", "LAST"];
  const body = rows.map((r) => [
    String(r.views),
    truncate(r.title || r.doc, 38),
    r.portal,
    r.surface,
    // A dash, not "anonymous": nothing was withheld, there was nothing to record.
    r.viewer ?? dim("—"),
    r.lastView ? String(r.lastView).slice(0, 16).replace("T", " ") : "",
  ]);

  const widths = head.map((h, i) => Math.max(visible(h).length, ...body.map((row) => visible(row[i]).length)));
  const line = (cells) => cells.map((cell, i) => pad(cell, widths[i])).join("  ").trimEnd();

  const total = rows.reduce((n, r) => n + r.views, 0);
  return [
    bold(line(head)),
    ...body.map(line),
    "",
    dim(`${plural(total, "view")} across ${plural(rows.length, "document")}, last ${plural(days, "day")}.`),
    // Unconditional on purpose (#129). The conditional version — warn only when the window predates
    // the current deployment — sounds smarter and is worse: `upgrade` redeploys, so `deployedAt`
    // resets on every routine upgrade and the hint would fire almost always. A note that is right
    // every time and short enough to skim beats one that is precise in theory and noise in practice.
    dim("The dataset is account-level and outlives any single deployment, so rows may name"),
    dim("documents a teardown removed. Cross-check with `pagevault list`. Records age out at 3 months."),
  ].join("\n");
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Column widths must ignore ANSI, or a styled cell throws the whole table off. */
const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const pad = (s, w) => s + " ".repeat(Math.max(0, w - visible(s).length));
const truncate = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

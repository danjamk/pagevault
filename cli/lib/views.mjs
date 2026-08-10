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
 * 🔴 Blob positions are fixed by `recordView` in worker/src/analytics.ts, which holds the
 * authoritative copy of this table. If that order ever changes, this changes with it — there is
 * no schema registry, and Analytics Engine will happily return whatever is in blob2 under
 * whatever name we ask for.
 *
 *   blob1 doc · blob2 title · blob3 surface · blob4 viewer · blob5 kind · blob6 referrer host
 *
 * Positions are never reused, never reordered, never repurposed (ADR-023, decision 8). Rows
 * written before a field existed return empty for it, and empty means "not recorded then".
 */
const SELECT = [
  "index1 AS portal",
  "blob1 AS doc",
  "blob2 AS title",
  "blob3 AS surface",
  "blob4 AS viewer",
  "blob5 AS kind",
  // 🔴 sum(_sample_interval), never count(). Analytics Engine samples under load and reports
  // the sampling rate per row; count() silently under-reports once sampling kicks in, and it
  // under-reports by exactly the amount that makes the number look plausible.
  "sum(_sample_interval) AS views",
  "max(timestamp) AS last_view",
].join(", ");

/**
 * The referrer is NOT in the SELECT above, and that is decision 5 rather than an omission.
 *
 * Referrers aggregate at *portal* granularity. Host cardinality multiplied by document
 * multiplied by surface is how a `GROUP BY` that already returns one row per viewer turns into
 * hundreds, pushing real documents past `--limit` to make room for one visit from a link
 * shortener. So they get their own query, and it stays cheap.
 */
const REFERRER_SELECT = ["index1 AS portal", "blob6 AS referrer", "sum(_sample_interval) AS views"].join(", ");

/**
 * The sync's query: the same rows, split by DAY (#161).
 *
 * `toDate(timestamp)` yields exactly the `YYYY-MM-DD` the summary uses as a bucket key, so there is
 * no reformatting step between the query and the stored shape — and therefore no place for the two
 * to disagree about what a day is.
 *
 * Row count is documents × surfaces × viewers × days rather than documents × surfaces × viewers,
 * which is why the sync's `--limit` is four figures and the table's is three.
 */
const BUCKET_SELECT = [
  "index1 AS portal",
  "blob1 AS doc",
  "blob3 AS surface",
  "blob4 AS viewer",
  "blob5 AS kind",
  "toDate(timestamp) AS day",
  "sum(_sample_interval) AS views",
  "max(timestamp) AS last_view",
].join(", ");

/** Query recent views — one row per document, surface, viewer and kind. */
export async function queryViews(creds, opts = {}) {
  requireCreds(creds);

  const days = windowDays(opts.days);
  const limit = Number(opts.limit ?? 100);

  const where = [`timestamp > NOW() - INTERVAL '${days}' DAY`];
  // Values are quoted through sqlString rather than interpolated: a portal slug is operator
  // input, but a document id can come off a URL, and a broken query is a worse error message
  // than a rejected argument.
  if (opts.portal) where.push(`index1 = ${sqlString(opts.portal)}`);
  if (opts.doc) where.push(`blob1 = ${sqlString(opts.doc)}`);

  const parsed = await runQuery(
    creds,
    [
      `SELECT ${SELECT}`,
      `FROM ${DATASET}`,
      `WHERE ${where.join(" AND ")}`,
      "GROUP BY portal, doc, title, surface, viewer, kind",
      "ORDER BY views DESC",
      `LIMIT ${Math.floor(limit)}`,
      "FORMAT JSON",
    ].join("\n"),
  );

  return {
    days,
    rows: (parsed.data ?? []).map((r) => ({
      portal: r.portal ?? "",
      doc: r.doc ?? "",
      title: r.title ?? "",
      surface: r.surface ?? "",
      // Empty by construction on the public and capability surfaces — they have no Access
      // application in front of them, so there was never an identity to record (ADR-015).
      viewer: r.viewer || null,
      // 🔴 The one place empty is read AS a value, and it is sound only here. Every row written
      // before 0.32.0 predates the kind field, and every one of them was a document view —
      // `portalIndex` was not instrumented, so no other kind of row could exist. Reading empty
      // as "document" is therefore a statement of fact about history, not a default. Do not
      // copy this pattern to blob6, where empty genuinely means "unknown"; see queryReferrers.
      kind: r.kind || "document",
      views: Number(r.views ?? 0),
      lastView: r.last_view ?? null,
    })),
  };
}

/**
 * Where traffic came from, per portal (ADR-023, decision 5).
 *
 * A separate query rather than more columns on the one above — see REFERRER_SELECT for why.
 * Hosts only: the path, query and fragment were discarded in the Worker before the write, so
 * there is nothing here to strip and nothing that could have been stored.
 */
export async function queryReferrers(creds, opts = {}) {
  requireCreds(creds);

  const days = windowDays(opts.days);
  const limit = Number(opts.limit ?? 20);

  // 🔴 `blob5 != ''` is what keeps this honest, and it is not a filter for tidiness.
  //
  // Rows written before 0.32.0 have an empty blob6 because the field did not exist, which is
  // indistinguishable from the empty blob6 that means "arrived directly". Counting the first as
  // the second would report years of unknown traffic as DIRECT — reading "not recorded then" as
  // a value, which is exactly what decision 8 forbids. The kind field arrived in the same write
  // as the referrer, so its presence is the proof that this row's blank referrer was measured.
  const where = [`timestamp > NOW() - INTERVAL '${days}' DAY`, "blob5 != ''"];
  if (opts.portal) where.push(`index1 = ${sqlString(opts.portal)}`);

  const parsed = await runQuery(
    creds,
    [
      `SELECT ${REFERRER_SELECT}`,
      `FROM ${DATASET}`,
      `WHERE ${where.join(" AND ")}`,
      "GROUP BY portal, referrer",
      "ORDER BY views DESC",
      `LIMIT ${Math.floor(limit)}`,
      "FORMAT JSON",
    ].join("\n"),
  );

  return {
    days,
    sources: (parsed.data ?? []).map((r) => ({
      portal: r.portal ?? "",
      // null, not "": the reader labels it "direct", and a null cannot be mistaken for a host
      // whose name happens to be empty.
      referrer: r.referrer || null,
      views: Number(r.views ?? 0),
    })),
  };
}

/**
 * Query day buckets for the sync (#161). Returns the rows AND the window they cover.
 *
 * 🔴 The boundary is a DATE, not `NOW() - INTERVAL n DAY`, and that is the difference between a
 * correct history and one with a permanently wrong oldest day.
 *
 * A timestamp boundary lands mid-day, so the oldest day comes back partially counted. The Worker
 * clears and restates whole days by coverage, so that partial count would be written as if it were
 * the whole day — and no later sync ever fixes it, because the day only gets older and further from
 * the window. Aligning the query to midnight makes "what was queried" and "what the coverage claims"
 * the same statement rather than two nearly-equal ones.
 *
 * The newest day is partial too, and that is fine: it is today, and tomorrow's sync restates it in
 * full. Self-correcting in the direction that matters.
 */
export async function queryBuckets(creds, opts = {}) {
  requireCreds(creds);

  const days = windowDays(opts.days ?? 90);
  const limit = Number(opts.limit ?? 10000);
  // `now` is injectable so the whole thing is testable without a clock.
  const now = opts.now ? new Date(opts.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new ViewsError(`Invalid sync timestamp: ${opts.now}`);

  const to = isoDay(now);
  // Inclusive on both ends: `days` days of history means today plus the previous days - 1.
  const from = isoDay(new Date(now.getTime() - (days - 1) * 86_400_000));

  const parsed = await runQuery(
    creds,
    [
      `SELECT ${BUCKET_SELECT}`,
      `FROM ${DATASET}`,
      `WHERE timestamp >= toDateTime(${sqlString(`${from} 00:00:00`)})`,
      // No `title`: the summary stores counts against a document id, and carrying the title into
      // the GROUP BY would split a renamed document into two sets of buckets (ADR-017 — the id
      // survives a retitle, so the history should too).
      "GROUP BY portal, doc, surface, viewer, kind, day",
      "ORDER BY day DESC",
      `LIMIT ${Math.floor(limit)}`,
      "FORMAT JSON",
    ].join("\n"),
  );

  const rows = (parsed.data ?? []).map((r) => ({
    portal: r.portal ?? "",
    doc: r.doc ?? "",
    surface: r.surface ?? "",
    viewer: r.viewer || null,
    // See queryViews: empty predates the field, and every such row was a document view.
    kind: r.kind || "document",
    day: String(r.day ?? "").slice(0, 10),
    views: Number(r.views ?? 0),
    lastView: r.last_view ?? null,
  }));

  return { coverage: { from, to }, days, rows, truncated: rows.length >= Math.floor(limit) };
}

/** `YYYY-MM-DD` in UTC, which is the timezone every stored date is in. */
const isoDay = (d) => d.toISOString().slice(0, 10);

/**
 * `days` is capped by reality, not by us: Analytics Engine retains three months, so anything
 * past ~90 returns nothing rather than erroring. The callers say so in their help text.
 */
function windowDays(value) {
  const days = Number(value ?? 30);
  if (!Number.isFinite(days) || days <= 0) throw new ViewsError(`--days must be a positive number, got "${value}".`);
  return Math.floor(days);
}

function requireCreds({ accountId, token }) {
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
}

/** POST one statement to the SQL API and hand back the parsed body. Both queries go through here. */
async function runQuery({ accountId, token }, sql) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
    body: sql,
  });

  const body = await res.text();

  if (!res.ok) throw new ViewsError(explain(res.status, body));

  try {
    return JSON.parse(body);
  } catch {
    throw new ViewsError(`Analytics Engine returned something that isn't JSON:\n${body.slice(0, 300)}`);
  }
}

/**
 * Aggregate day-bucketed rows into the summary the Worker stores (#127, ADR-019, ADR-023).
 *
 * Pure: the caller supplies `syncedAt`, the coverage window, the set of ids that still exist and
 * the owner's address, so the whole thing is testable with no network and no clock.
 *
 * 🔴 Counts and surfaces, never identities (ADR-019 decision 4). `viewer` is on every portal row
 * and is dropped here on purpose — it is read to decide owner-or-not and then discarded, so the
 * address never reaches the Worker. "Opened four times through the public link, never by a
 * signed-in member" is useful and identifies nobody; putting an email within reach of an LLM is a
 * separate decision to be made on its own merits. The CLI table keeps identities — an operator
 * reading their own dashboard is a different act from an agent summarizing it.
 */
export function summarizeViews({ coverage, rows }, { syncedAt, knownIds = null, ownerEmail = "" } = {}) {
  // Null-prototype: keys are document ids that arrived from Cloudflare, and `__proto__` on a
  // normal object literal would set the prototype rather than store a count.
  const docs = Object.create(null);
  const skipped = new Set();
  const owner = String(ownerEmail ?? "").trim().toLowerCase();

  for (const r of rows) {
    // 🔴 Portal landings are traffic, not readership, and this summary is what MCP serves as a
    // property of a DOCUMENT. Folding index views into a document's count would be wrong twice
    // over: they have no document, and they would inflate "did the client open it" with people
    // who opened nothing. Skipped on kind rather than on the empty id, so a future index event
    // that does carry an id cannot slip in through the back.
    if (r.kind === "index") continue;
    if (!r.doc || !r.day) continue;

    // The dataset is account-level and outlives the deployment that wrote it (#129), so rows can
    // name documents this deployment never created. Ids it has never seen stay skipped — but a
    // document it HAS seen and since revoked keeps its history, because the Worker merges by
    // window and never deletes an entry it simply did not hear about (ADR-023 decision 4).
    if (knownIds && !knownIds.has(r.doc)) {
      skipped.add(r.doc);
      continue;
    }

    const history = (docs[r.doc] ??= Object.create(null));
    const bucket = (history[r.day] ??= {});

    // `pub`, not `public`: the stored key. Kept as a lookup rather than a string concat so an
    // unrecognised surface lands nowhere instead of inventing a key on the bucket.
    const key = BUCKET_SURFACE[r.surface];
    if (key) bucket[key] = (bucket[key] ?? 0) + r.views;

    // 🔴 The owner split, computed where the identity already is and never sent (ADR-023 §7).
    //
    // Only on `portal` — the other two surfaces have no Access application, so a view through
    // them is neither owner nor client but unattributed, and claiming otherwise would be the
    // wrong guess this decision exists to avoid. Where the owner's address is unknown the field
    // is left absent, which the Worker reads as "not measured" rather than as zero.
    if (r.surface === "portal" && owner) {
      const mine = String(r.viewer ?? "").trim().toLowerCase() === owner ? r.views : 0;
      bucket.owner = (bucket.owner ?? 0) + mine;
    }

    // Time of day only — the date is the bucket key, so storing it twice would be storing it twice.
    const seen = toIso(r.lastView);
    const time = seen ? seen.slice(11, 19) : "";
    if (time && (!bucket.t || time > bucket.t)) bucket.t = time;
  }

  // A bucket that recorded no surface is a day with nothing in it. Drop it here rather than
  // shipping it for the Worker to drop: sparse has to be built, not merely validated.
  for (const [id, history] of Object.entries(docs)) {
    for (const [day, bucket] of Object.entries(history)) {
      if (!bucket.link && !bucket.pub && !bucket.portal) delete history[day];
    }
    if (Object.keys(history).length === 0) delete docs[id];
  }

  return { summary: { v: 2, syncedAt, coverage, docs, portals: {} }, skipped: [...skipped] };
}

/** Query surface name → stored bucket key. `public` is `pub` in the wire shape. */
const BUCKET_SURFACE = { link: "link", public: "pub", portal: "portal" };

/**
 * Fold referrer rows into the summary's per-portal rollup (ADR-023 §5).
 *
 * Portal granularity, never per document per day — host cardinality multiplied by document
 * multiplied by day is how one KV value stops fitting in one KV value.
 */
export function summarizeReferrers({ sources = [] } = {}) {
  const portals = Object.create(null);
  for (const s of sources) {
    if (!s.portal || !s.views) continue;
    const hosts = (portals[s.portal] ??= Object.create(null));
    // "" is direct, and it is a measurement rather than a gap — queryReferrers only returns rows
    // written after the referrer field existed.
    const host = s.referrer ?? "";
    hosts[host] = (hosts[host] ?? 0) + s.views;
  }
  return portals;
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
    // An index row has no document because nobody opened one — they landed on the collection
    // page. Naming that beats an empty cell, which reads as a rendering bug (ADR-023, 6).
    r.kind === "index" ? dim("(portal index)") : truncate(r.title || r.doc, 38),
    r.portal,
    r.surface,
    // A dash, not "anonymous": nothing was withheld, there was nothing to record.
    r.viewer ?? dim("—"),
    r.lastView ? String(r.lastView).slice(0, 16).replace("T", " ") : "",
  ]);

  const widths = head.map((h, i) => Math.max(visible(h).length, ...body.map((row) => visible(row[i]).length)));
  const line = (cells) => cells.map((cell, i) => pad(cell, widths[i])).join("  ").trimEnd();

  // Counted apart, because they answer different questions. Rolling them into one total would
  // make "views across N documents" a number that is neither views of documents nor traffic.
  const docRows = rows.filter((r) => r.kind !== "index");
  const indexRows = rows.filter((r) => r.kind === "index");
  const total = docRows.reduce((n, r) => n + r.views, 0);
  const landings = indexRows.reduce((n, r) => n + r.views, 0);

  return [
    bold(line(head)),
    ...body.map(line),
    "",
    dim(`${plural(total, "view")} across ${plural(docRows.length, "document")}, last ${plural(days, "day")}.`),
    ...(landings
      ? [dim(`${plural(landings, "portal landing")} — someone opened a collection page, not a document.`)]
      : []),
    // Unconditional on purpose (#129). The conditional version — warn only when the window predates
    // the current deployment — sounds smarter and is worse: `upgrade` redeploys, so `deployedAt`
    // resets on every routine upgrade and the hint would fire almost always. A note that is right
    // every time and short enough to skim beats one that is precise in theory and noise in practice.
    dim("The dataset is account-level and outlives any single deployment, so rows may name"),
    dim("documents a teardown removed. Cross-check with `pagevault list`. Records age out at 3 months."),
  ].join("\n");
}

/**
 * Render where the traffic came from. Returns "" when there is nothing to say, so the caller can
 * drop the whole block rather than print a heading over an empty table.
 *
 * Hosts, never URLs. There is no path here to redact because none was ever written — the
 * reduction happens in the Worker before the record exists (ADR-023, decision 5).
 */
export function formatReferrers({ days, sources }, c) {
  const dim = c?.dim ?? ((s) => s);
  const bold = c?.bold ?? ((s) => s);

  if (!sources?.length) return "";

  const head = ["VIEWS", "SOURCE", "PORTAL"];
  const body = sources.map((s) => [
    String(s.views),
    // "direct" is a measured fact here and not a fallback: queryReferrers only returns rows
    // written after the referrer field existed, so a blank one means the browser sent none.
    s.referrer ?? dim("direct"),
    s.portal,
  ]);

  const widths = head.map((h, i) => Math.max(visible(h).length, ...body.map((row) => visible(row[i]).length)));
  const line = (cells) => cells.map((cell, i) => pad(cell, widths[i])).join("  ").trimEnd();

  return [
    bold(line(head)),
    ...body.map(line),
    "",
    dim(`Traffic sources, last ${plural(days, "day")}. The linking host only — never the page it linked from.`),
    // Named rather than left to be discovered as a bug report. A LinkedIn preview, a Slack
    // unfurl and a mail-client preload all fetch the page and all land here.
    dim("Automated previews and unfurls are counted, so public numbers read high."),
  ].join("\n");
}

/**
 * Render the stored summary's rollup — the DEFAULT read since ADR-025 (#168).
 *
 * A formatter and nothing more. The aggregation happens in the Worker (`worker/src/rollup.ts`) and
 * arrives over `GET /api/views/summary`, because this file has no build step and cannot import the
 * Worker's TypeScript — so computing it here would be a second implementation of the same
 * arithmetic over a versioned wire shape, and the copy nobody watches is the one that drifts.
 *
 * 🔴 The four states are rendered as four different things. An empty table is not an acceptable
 * rendering of "no sync has run": it reads as "nobody visited", which is the precise lie the
 * zero-versus-null rule exists to stop.
 */
export function formatRollup(r, c, { by = "doc" } = {}) {
  const dim = c?.dim ?? ((s) => s);
  const bold = c?.bold ?? ((s) => s);

  const asOf = r.syncedAt ? String(r.syncedAt).slice(0, 16).replace("T", " ") : null;
  const window = `${r.window.from} to ${r.window.to}`;

  if (r.state === "never-synced") {
    return [
      "No history captured yet.",
      "",
      dim("Views reach Analytics Engine the moment a page opens, but nothing moves them into the"),
      dim("durable summary until you ask. Analytics Engine keeps ~90 days; the summary keeps everything."),
      "",
      `  ${bold("pagevault sync-views")}   ${dim("promote what has been recorded so far")}`,
    ].join("\n");
  }

  if (r.state === "not-recording") {
    // Zero here would be a measurement. There is no binding, so there is no measurement (#185).
    return [
      "This deployment is not recording views.",
      "",
      dim("The Worker has no Analytics Engine binding, so nothing is being counted and nothing will be."),
      ...(r.total.views
        ? [dim(`The ${plural(r.total.views, "view")} below were measured before it was turned off, and are still true.`), ""]
        : [""]),
      `  ${bold("pagevault upgrade --analytics")}   ${dim("start recording")}`,
    ].join("\n");
  }

  // One table per breakdown (#162). `doc` is the default because "which document did they read" is
  // the question people arrive with; the other three are the ones the old shape could not answer at
  // all — it grouped by `(portal, doc, title, surface, viewer)`, so a document was many rows and
  // there was no time axis anywhere.
  const HEADS = {
    doc: ["VIEWS", "DOCUMENT", "PORTAL", "LINK", "PUBLIC", "PORTAL", "LAST"],
    portal: ["VIEWS", "PORTAL", "DOCS", "LINK", "PUBLIC", "PORTAL"],
    day: ["DAY", "VIEWS", ""],
    surface: ["VIEWS", "DOOR", "WHAT IT MEANS"],
    referrer: ["VIEWS", "SOURCE"],
  };
  const peak = Math.max(1, ...r.byDay.map((d) => d.views));
  const ROWS = {
    doc: () =>
      r.byDoc.map((d) => [
        String(d.views),
        truncate(d.title, 38),
        d.portal,
        String(d.surfaces.link),
        String(d.surfaces.public),
        String(d.surfaces.portal),
        d.lastViewedAt ? String(d.lastViewedAt).slice(0, 16).replace("T", " ") : dim("—"),
      ]),
    portal: () =>
      r.byPortal.map((p) => [
        String(p.views),
        p.portal,
        String(p.docs),
        String(p.surfaces.link),
        String(p.surfaces.public),
        String(p.surfaces.portal),
      ]),
    // A bar per day, scaled to the busiest one. The point of `--by day` is the SHAPE — whether
    // traffic is rising, or all of it landed the afternoon you sent the link — and a column of
    // numbers makes the reader do that work themselves.
    day: () =>
      r.byDay.map((d) => [
        d.granularity === "month" ? `${d.key}    ${dim("(month)")}` : d.key,
        String(d.views),
        dim("▇".repeat(Math.max(1, Math.round((d.views / peak) * 24)))),
      ]),
    // Which door they came through. The third column is not decoration: "link 50" means nothing
    // until you know a link is a /p/ capability URL that opens with no login, and that distinction
    // is the one an operator most needs when reading their own numbers.
    surface: () => [
      [String(r.total.surfaces.portal), "portal", dim("signed in, through the portal")],
      [String(r.total.surfaces.link), "link", dim("a /p/ capability URL — no login")],
      [String(r.total.surfaces.public), "public", dim("a listed public portal page")],
    ],
    referrer: () => r.byReferrer.map((s) => [String(s.views), s.host || dim("direct")]),
  };

  const head = HEADS[by];
  const body = ROWS[by]();

  const widths = head.map((h, i) => Math.max(visible(h).length, ...body.map((row) => visible(row[i]).length)));
  const line = (cells) => cells.map((cell, i) => pad(cell, widths[i])).join("  ").trimEnd();

  // Under `--by doc` the sources ride along as a second block, because "what did they read" and
  // "where did they come from" are usually one question. Every other breakdown gets one table.
  const referrers =
    by === "doc" && r.byReferrer.length
      ? [
          "",
          bold("SOURCES"),
          ...r.byReferrer.slice(0, 8).map((s) => `  ${String(s.views).padStart(5)}  ${s.host || dim("direct")}`),
          dim("  All-time per portal — referrers carry no date, so the window above does not apply."),
        ]
      : [];

  const emptyLine = {
    doc: `Nothing was opened between ${window}.`,
    portal: `No portal recorded traffic between ${window}.`,
    day: `No day between ${window} recorded a view.`,
    surface: `Nothing was opened between ${window}, through any door.`,
    referrer: "No referrers recorded. Every visit arrived without one, or nothing has been opened.",
  }[by];

  return [
    ...(body.length ? [bold(line(head)), ...body.map(line)] : [dim(emptyLine)]),
    ...referrers,
    "",
    // 🔴 All-time, and it must say so even here: referrers are stored per portal with no date
    // (ADR-023 §5), so a windowed heading over them would be a wrong number rather than a narrow
    // one. This is the breakdown where the mistake would be easiest to make.
    ...(by === "referrer"
      ? [dim(`${plural(r.total.views, "view")} in the window; the sources above are ALL-TIME and ignore it.`)]
      : [dim(`${plural(r.total.views, "view")} across ${plural(r.byDoc.filter((d) => d.views > 0).length, "document")}, ${window}.`)]),
    // Provenance, every time. A number whose source and staleness are unstated is the ADR-024
    // failure mode one domain over — it reads as current at exactly the moment it is not.
    dim(`Source: the stored summary, synced ${asOf}. Not live — run \`pagevault sync-views\` to refresh.`),
    ...(r.scope.monthlyBuckets
      ? [dim(`${plural(r.scope.monthlyBuckets, "bucket")} older than 90 days are monthly, so those views carry no day.`)]
      : []),
    ...(r.risk.state === "warn" || r.risk.state === "urgent" || r.risk.state === "losing"
      ? [
          "",
          bold(
            r.risk.state === "losing"
              ? `${plural(r.risk.lostDays, "day")} of history is already unrecoverable.`
              : `${plural(r.risk.uncapturedDays, "day")} of history becomes unrecoverable in ${plural(r.risk.daysUntilLoss ?? 0, "day")}.`,
          ),
          dim("  pagevault sync-views"),
        ]
      : []),
  ].join("\n");
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Column widths must ignore ANSI, or a styled cell throws the whole table off. */
const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const pad = (s, w) => s + " ".repeat(Math.max(0, w - visible(s).length));
const truncate = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

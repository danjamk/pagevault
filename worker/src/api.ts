import { bearerToken, isAuthorized } from "./auth.js";
import { originAllowed } from "./capability.js";
import { verifySession } from "./session.js";
import {
  BadRequest,
  Conflict,
  type DocEdit,
  type DocPatch,
  Misconfigured,
  NameTaken,
  documentPath,
  editDocument,
  parseEmails,
  parseSourceKind,
  parseSummary,
  parseTags,
  parseTitle,
  patchDocument,
  publishDocument,
  reconcileAccessGroup,
  requireString,
  searchPortal,
  updatePortalMembers,
} from "./documents.js";
import { type Env, analyticsEnabled } from "./env.js";
import { countAccessSeats } from "./seats.js";
import {
  type DocMeta,
  type Portal,
  type PortalKind,
  deleteDoc,
  deletePortal,
  getDoc,
  getMembers,
  getMeta,
  getPortal,
  getRawSource,
  isValidSlug,
  listDocs,
  listPortals,
  normalizePinned,
  putMembers,
  putPortal,
} from "./store.js";
import { assertFits, getViewSummary, mergeSummary, parseViewSummary, putViewSummary, syncRisk, withStats } from "./views.js";
import { rollup } from "./rollup.js";
import { log } from "./log.js";

/**
 * `/api/*` — the HTTP surface.
 *
 * A thin shell over `documents.ts`. The MCP server (`mcp.ts`) calls the same service, so
 * the portal-resolution ladder and the overwrite guard live in exactly one place. Two
 * publish paths would be two places for those rules to drift, and both drift quietly.
 */

/** Reject on Content-Length before buffering 25MB of JSON into a 128MB isolate. */
const MAX_BODY_BYTES = 12 * 1024 * 1024;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}

const fail = (status: number, code: string, error: string, extra?: Record<string, unknown>) =>
  json({ error, code, ...extra }, status);

export async function handleApi(request: Request, env: Env): Promise<Response> {
  // Defense in depth, ahead of the bearer check.
  //
  // A sandboxed artifact has an opaque origin, so anything it fetches arrives with
  // `Origin: null`. It has no bearer token either, so the check below would already refuse
  // it — but this is the cheapest possible second wall, and it means a future endpoint that
  // gets its auth wrong is still not reachable from inside an artifact. See ADR-007.
  if (!originAllowed(request)) {
    // The path is passed explicitly because `/api/*` carries no secret in the URL — the
    // bearer credential is a header (ADR-004). Knowing which endpoint was probed is the
    // whole value of this event.
    log("warn", "blocked_api_request_invalid_origin", { request, path: new URL(request.url).pathname });
    return fail(403, "forbidden_origin", "Cross-origin request refused");
  }

  // Two accepted bearer credentials, no cookies (ADR-004): the long-lived PAGEVAULT_API_TOKEN
  // (CLI, MCP) or a short-lived console session token. Both are owner-scoped, so a boolean is
  // all we need — the console does everything the token does. /mcp accepts ONLY the API token.
  const authorized = isAuthorized(request, env) || (await verifySession(env, bearerToken(request))) !== null;
  if (!authorized) {
    return fail(401, "unauthorized", "Missing or invalid bearer token");
  }

  const { pathname } = new URL(request.url);
  const rest = pathname.slice("/api".length);

  try {
    if (rest === "/docs") {
      if (request.method === "POST") return await createDoc(request, env);
      if (request.method === "GET") return await listDocsHandler(request, env);
      return fail(405, "method_not_allowed", `${request.method} not allowed on /api/docs`);
    }

    const rawDoc = /^\/docs\/([^/]+)\/raw$/.exec(rest);
    if (rawDoc?.[1]) {
      if (request.method === "GET") return await getDocRawHandler(env, rawDoc[1]);
      return fail(405, "method_not_allowed", `${request.method} not allowed on ${pathname}`);
    }

    const doc = /^\/docs\/([^/]+)$/.exec(rest);
    if (doc?.[1]) {
      if (request.method === "GET") return await getDocHandler(request, env, doc[1]);
      if (request.method === "PATCH") return await patchDocHandler(request, env, doc[1]);
      if (request.method === "DELETE") return await deleteDocHandler(env, doc[1]);
      return fail(405, "method_not_allowed", `${request.method} not allowed on ${pathname}`);
    }

    if (rest === "/search") {
      if (request.method === "GET") return await searchHandler(request, env);
      return fail(405, "method_not_allowed", `${request.method} not allowed on /api/search`);
    }

    if (rest === "/access/seats") {
      if (request.method === "GET") return json(await countAccessSeats(env));
      return fail(405, "method_not_allowed", `${request.method} not allowed on /api/access/seats`);
    }

    if (rest === "/access/sync") {
      if (request.method === "POST") return await accessSyncHandler(request, env);
      return fail(405, "method_not_allowed", `${request.method} not allowed on /api/access/sync`);
    }

    if (rest === "/views/summary") {
      if (request.method === "POST") return await putViewSummaryHandler(request, env);
      if (request.method === "GET") return await getViewsHandler(request, env);
      return fail(405, "method_not_allowed", `${request.method} not allowed on /api/views/summary`);
    }

    if (rest === "/portals") {
      if (request.method === "POST") return await createPortal(request, env);
      if (request.method === "GET") return json({ portals: await listPortals(env) });
      return fail(405, "method_not_allowed", `${request.method} not allowed on /api/portals`);
    }

    const members = /^\/portals\/([^/]+)\/members$/.exec(rest);
    if (members?.[1]) return await membersHandler(request, env, members[1]);

    const portal = /^\/portals\/([^/]+)$/.exec(rest);
    if (portal?.[1]) return await portalHandler(request, env, portal[1]);

    return fail(404, "not_found", `No such endpoint: ${pathname}`);
  } catch (err) {
    if (err instanceof Conflict) {
      // Surface the existing id + name so the CLI can offer the real next steps (--confirm to
      // replace, --name to fork, mint to change only the link). The message stays generic; the
      // CLI-specific guidance is the CLI's to build. See ADR-017.
      return fail(409, "already_exists", err.message, {
        id: err.existing.id,
        name: err.existing.name,
        portal: err.existing.portal,
      });
    }
    // A rename onto a filename that is already taken. Separate code from publish's
    // `already_exists` because the remedies differ: publish offers `--confirm` to replace,
    // and a rename deliberately offers no such thing (#140).
    if (err instanceof NameTaken) {
      return fail(409, "name_taken", err.message, {
        id: err.existing.id,
        name: err.existing.name,
        portal: err.existing.portal,
      });
    }
    if (err instanceof BadRequest) {
      const status = err.code === "too_large" ? 413 : 400;
      return fail(status, err.code, err.message);
    }
    if (err instanceof Misconfigured) return fail(500, err.code, err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * `GET /api/search?portal={slug}&q={query}[&limit=N]` — keyword search within one client's
 * documents (#73). Mirrors the `search_portal` MCP tool over the same `searchPortal` service. The
 * portal is REQUIRED: searching across every client at once is how one client's material ends up
 * in another's report (prime directive #5). A blank/whitespace query throws BadRequest → 400.
 */
async function searchHandler(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const portal = params.get("portal");
  const q = params.get("q") ?? params.get("query");
  if (!portal) return fail(400, "invalid_field", `"portal" is required`);
  if (!q) return fail(400, "invalid_field", `"q" is required`);
  const limit = Math.max(1, Math.min(50, Number(params.get("limit")) || 10));
  return json({ hits: await searchPortal(env, portal, q, limit) });
}

/**
 * `POST /api/access/sync[?reap=true]` — reconcile the `pagevault-viewers` Access group to match
 * KV (#85). Recomputes the desired set (portal members ∪ document `extraEmails` ∪ owner) and
 * rebuilds the group; `?reap=true` also prunes members KV no longer authorizes, reclaiming their
 * Access seats (ADR-002). Owner-bearer only, like every `/api` route.
 *
 * Tier 0 (no Access configured) is a `400 not_configured`, not a lie about success. A Cloudflare
 * API failure is a `502` — the reconcile is a downstream call that can genuinely fail.
 */
async function accessSyncHandler(request: Request, env: Env): Promise<Response> {
  const reap = new URL(request.url).searchParams.get("reap") === "true";
  const result = await reconcileAccessGroup(env, reap);

  if (result.status === "not_configured") {
    return fail(400, "not_configured", "Email-secured access is not enabled (Tier 0) — no group to reconcile.");
  }
  if (result.status === "failed") {
    return fail(502, "sync_failed", `Access group reconcile failed: ${result.error}`);
  }
  return json({
    added: result.added,
    removed: result.removed,
    kept: result.kept,
    groupSize: result.groupSize,
    reaped: reap,
  });
}

/**
 * `POST /api/views/summary` — the operator's machine hands back what it read from Analytics
 * Engine (#127). One KV key, one write. Owner-bearer only, like every `/api` route.
 *
 * This is the only way view metrics enter the Worker. There is no GET counterpart and no query
 * path: the Worker stores the result and serves it joined onto documents, which is the whole of
 * ADR-019 — data in, never the credential that produced it.
 *
 * 🔴 The merge is HERE rather than in the CLI, and that placement is the decision (ADR-023 §3). It
 * makes history append-only *by construction*: if the CLI merged, a CLI at an old version, or a
 * `--sync --days 7` from a second machine, would clobber everything it did not measure. Trusting the
 * client is the posture `parseViewSummary` already refuses to take.
 *
 * `?reset=true` is the one escape hatch, and it is named as destructive rather than discovered.
 * Append-only with no way out is how a bad history becomes permanent.
 */
async function putViewSummaryHandler(request: Request, env: Env): Promise<Response> {
  const incoming = parseViewSummary(await readJson(request));
  const reset = new URL(request.url).searchParams.get("reset") === "true";

  // Read-modify-write on eventually-consistent KV, deliberately. Two syncs inside the ~60s window
  // could both read the pre-merge value and the second would win, losing the first's contribution —
  // and the next sync repairs it, because a 90-day query re-derives every recent bucket from
  // scratch. Self-healing is the property that makes this safe; nothing here depends on
  // read-after-write, and nothing built on top of it should.
  const stored = reset ? null : await getViewSummary(env);
  const summary = mergeSummary(stored, incoming);

  // The payload fit; the merged history may not. Refuse rather than truncate — a summary quietly
  // missing half a portal reports "never opened" for documents that were.
  assertFits(summary);

  await putViewSummary(env, summary);

  return json({
    ok: true,
    syncedAt: summary.syncedAt,
    coverage: summary.coverage,
    documents: Object.keys(summary.docs).length,
    ...(reset ? { reset: true } : {}),
  });
}

/**
 * `GET /api/views/summary` — view history, without a Cloudflare credential (#168, ADR-025).
 *
 * 🔴 The point of this route is what it does NOT need. Reading traffic used to mean querying
 * Analytics Engine directly, which needs an account-scoped `Account Analytics Read` token and an
 * account id — so an operator running a deployment they did not provision (production deployed by
 * CI, read from a client-only install) could not see their own numbers at all. They were never
 * missing the data: it sits in `views:summary`, in the KV namespace their bearer already reads for
 * every other command. There was simply no way to ask for it.
 *
 * The Worker still cannot query Analytics Engine and gains no capability here (ADR-019 decision 1,
 * unchanged by ADR-025). This is aggregation over data the operator already synced in.
 *
 * `?raw=true` returns the stored summary verbatim. Kept deliberately distinct from the rolled-up
 * form: the summary is the durable artifact, and something must be able to fetch it for backup
 * without a rollup's opinions applied.
 */
async function getViewsHandler(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const summary = await getViewSummary(env);

  if (params.get("raw") === "true") {
    return json({ summary, ...(summary ? {} : { state: "never-synced" }) });
  }

  const now = new Date();
  // Asked of the binding, never inferred from an empty summary: "recorded nothing" and "cannot
  // record" produce identical data and mean opposite things (#185).
  const recording = analyticsEnabled(env);

  // The window. `days` is the ergonomic form every other surface already speaks; explicit `from`/`to`
  // exist because a rollup asked for a fixed historical window must not move under the caller.
  const days = clampDays(params.get("days"));
  const to = params.get("to") ?? dayKey(now.getTime());
  const from = params.get("from") ?? dayKey(now.getTime() - (days - 1) * 86_400_000);

  const portal = params.get("portal") ?? undefined;
  const doc = params.get("doc") ?? undefined;
  // Unrecognised values fall back to `day` rather than erroring: this is a presentation preference,
  // and a typo in a query string should not deny an operator their traffic. The rollup reports what
  // it actually grouped by, so a caller can always tell what it got.
  const groupRaw = params.get("group");
  const group = groupRaw === "week" || groupRaw === "month" ? groupRaw : "day";

  // The document index the rollup needs: a document's portal is not in the summary, and cannot be
  // (a document can move between portals — ADR-017 makes identity `(portal, filename)`).
  const docs = (await listDocs(env, portal)).map((d) => ({
    id: d.id,
    portal: d.portal,
    title: d.title,
    name: d.name,
    createdAt: d.createdAt,
  }));

  return json(
    rollup(summary, docs, {
      from,
      to,
      portal,
      doc,
      group,
      recording,
      risk: syncRisk(summary, now.toISOString(), recording),
    }),
  );
}

/** `YYYY-MM-DD` for an epoch-ms instant. */
const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * A window length that cannot be used to make the Worker do unbounded work.
 *
 * Bounded at ten years rather than at the 90-day Analytics Engine horizon: since ADR-023 the
 * summary ACCUMULATES, so it is the only source for history older than a live query can see, and
 * capping at 90 here would hide exactly the data this route exists to expose.
 */
function clampDays(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(Math.floor(n), 3650);
}

async function createDoc(request: Request, env: Env): Promise<Response> {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return fail(413, "too_large", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
  }

  const body = await readJson(request);

  const { meta, created, portal, sync } = await publishDocument(env, {
    title: parseTitle(body["title"]),
    filename: typeof body["filename"] === "string" ? body["filename"] : undefined,
    source: requireString(body["html"] ?? body["source"], "html"),
    portal: typeof body["portal"] === "string" ? body["portal"] : undefined,
    summary: parseSummary(body["summary"]),
    tags: parseTags(body["tags"]),
    ownerOnly: body["ownerOnly"] === true,
    extraEmails: parseEmails(body["emails"] ?? body["extraEmails"], "emails"),
    makePublic: body["public"] === true,
    sourceKind: parseSourceKind(body["sourceKind"]),
    confirm: body["confirm"] === true,
  });

  const result = publishResult(meta, portal, baseUrl(request, env));
  // #27: tell the caller whether a per-document email grant was actually admitted to Access.
  if (sync) result["sync"] = sync.status;
  return json(result, created ? 201 : 200);
}

async function listDocsHandler(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const portal = params.get("portal") ?? undefined;
  const tag = params.get("tag");

  const docs = (await listDocs(env, portal)).filter((doc) => !tag || doc.tags?.includes(tag));
  docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // One KV read per request for the whole listing, never one per document (#127). `viewsSyncedAt`
  // rides at the top level so a caller can say "as of Tuesday" rather than implying it just
  // looked; both it and the per-document fields are absent when no sync has run.
  const summary = await getViewSummary(env);
  // Asked of the binding, never inferred from an empty summary: "recorded nothing" and "cannot
  // record" produce identical data and mean opposite things (#185).
  const recording = analyticsEnabled(env);
  return json({
    docs: docs.map((doc) => withStats(doc, summary, recording)),
    // `viewsCoverage` replaces `viewsWindowDays`: the counts are no longer "the last N days" but
    // everything measured since the first sync, so a day count could only mislead about what the
    // numbers include (ADR-023 §1).
    ...(summary ? { viewsSyncedAt: summary.syncedAt, viewsCoverage: summary.coverage } : {}),
    // Computed HERE rather than by each reader (ADR-023 §9). The CLI, the console panel and the
    // MCP tool all need the same answer, and three implementations of one horizon calculation is
    // three chances for them to disagree about when your history is about to disappear.
    viewsRisk: syncRisk(summary, new Date().toISOString(), recording),
  });
}

async function getDocHandler(request: Request, env: Env, id: string): Promise<Response> {
  const meta = await getMeta(env, id);
  if (!meta) return fail(404, "not_found", `No such document: ${id}`);
  // Include the ready-to-open URL(s), built server-side the way publish does — the portal's kind
  // decides /v vs /pub, which a caller can't know from meta alone. Lets `pagevault link` / `read`
  // (and any /api client) hand back a URL without a second round-trip.
  const portal = await getPortal(env, meta.portal);
  const base = baseUrl(request, env);
  const summary = await getViewSummary(env);
  const body: Record<string, unknown> = {
    ...withStats(meta, summary, analyticsEnabled(env)),
    url: portal ? `${base}${documentPath(portal, id)}` : `${base}/v/${encodeURIComponent(meta.portal)}/${id}`,
  };
  if (summary) body["viewsSyncedAt"] = summary.syncedAt;
  if (meta.publicToken) body["publicUrl"] = `${base}/p/${meta.publicToken}`;
  return json(body);
}

/**
 * The document body, as bytes — what `pagevault export` (#35) writes to a file. Returns the
 * ORIGINAL source: the `.md` for a markdown document, the stored HTML for an html one
 * (`getRawSource ?? getDoc`), so the extension the CLI picks from `sourceKind` round-trips
 * honestly. Owner-scoped like every `/api` route; `canView` is not consulted because the
 * bearer already IS the owner, who sees everything. No KV write, but never cached — the body
 * is the private artifact.
 */
async function getDocRawHandler(env: Env, id: string): Promise<Response> {
  const meta = await getMeta(env, id);
  if (!meta) return fail(404, "not_found", `No such document: ${id}`);

  const body = (await getRawSource(env, id)) ?? (await getDoc(env, id));
  if (body === null) return fail(404, "not_found", `No stored body for document: ${id}`);

  const contentType = meta.sourceKind === "markdown" ? "text/markdown" : "text/html";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": `${contentType}; charset=utf-8`, "Cache-Control": "private, no-store" },
  });
}

async function deleteDocHandler(env: Env, id: string): Promise<Response> {
  const meta = await getMeta(env, id);
  if (!meta) return fail(404, "not_found", `No such document: ${id}`);

  await deleteDoc(env, meta);
  return json({ ok: true });
}

/**
 * The console's per-document controls: the `ownerOnly` (draft) toggle, public-link
 * mint/revoke, and per-document email grants. A thin shell over `patchDocument`, which owns
 * the single write and the Access-group sync — the same service the MCP tools reach for, so
 * the sync cannot be present on one path and forgotten on another.
 *
 * It ALSO carries the edit fields — `name`, `title`, `summary`, `tags` (#140) — routed to
 * `editDocument`. The body is not patchable anywhere: it goes through publish (create-or-update).
 */
async function patchDocHandler(request: Request, env: Env, id: string): Promise<Response> {
  const body = await readJson(request);

  const EDIT_FIELDS = ["name", "title", "summary", "tags"] as const;
  const REACH_FIELDS = ["ownerOnly", "makePublic", "rotatePublic", "addEmails", "removeEmails"] as const;
  const editing = EDIT_FIELDS.some((f) => f in body);
  const reaching = REACH_FIELDS.some((f) => f in body);

  // Refused rather than sequenced. A `name` change moves the document to a new id, so a
  // combined request would have to answer "which id did the reach change apply to?" — and the
  // honest answer depends on ordering the caller can't see. Two calls, unambiguous each.
  if (editing && reaching) {
    return fail(
      400,
      "invalid_field",
      "Edit fields (name, title, summary, tags) and reach fields (ownerOnly, makePublic, rotatePublic, addEmails, removeEmails) cannot be combined — renaming moves the document to a new id. Send them as two requests.",
    );
  }

  if (editing) return await editDocHandler(request, env, id, body);

  const patch: DocPatch = {};
  let any = false;
  if ("ownerOnly" in body) {
    if (typeof body["ownerOnly"] !== "boolean") return fail(400, "invalid_field", `"ownerOnly" must be a boolean`);
    patch.ownerOnly = body["ownerOnly"];
    any = true;
  }
  if ("makePublic" in body) {
    if (typeof body["makePublic"] !== "boolean") return fail(400, "invalid_field", `"makePublic" must be a boolean`);
    patch.makePublic = body["makePublic"];
    any = true;
  }
  if ("rotatePublic" in body) {
    if (typeof body["rotatePublic"] !== "boolean") return fail(400, "invalid_field", `"rotatePublic" must be a boolean`);
    patch.rotatePublic = body["rotatePublic"];
    any = true;
  }
  if ("addEmails" in body) {
    patch.addEmails = parseEmails(body["addEmails"], "addEmails") ?? [];
    any = true;
  }
  if ("removeEmails" in body) {
    patch.removeEmails = parseEmails(body["removeEmails"], "removeEmails") ?? [];
    any = true;
  }
  if (!any) {
    return fail(400, "invalid_field", `PATCH expects one of: name, title, summary, tags, ownerOnly, makePublic, rotatePublic, addEmails, removeEmails`);
  }

  const result = await patchDocument(env, id, patch);
  if (!result) return fail(404, "not_found", `No such document: ${id}`);

  // The public link is a different URL, not a meta field the caller can build reliably — the
  // host comes from PUBLIC_HOST, which only the Worker knows. Hand back the /p/ URL whenever a
  // token is present so `pagevault mint`/`rotate` can print it verbatim, matching publish.
  const out: Record<string, unknown> = { ...result.meta };
  if (result.meta.publicToken) out["publicUrl"] = `${baseUrl(request, env)}/p/${result.meta.publicToken}`;
  // Surface the group-sync outcome so a grant that landed in KV but that Access still blocks
  // is never silent (ADR-002). Absent when the patch granted no new email.
  if (result.sync) out["sync"] = result.sync.status;
  return json(out);
}

/**
 * The edit half of PATCH (#140): filename, title, summary, tags.
 *
 * `name` is the document's identity, so changing it moves the document to a new id — and the
 * response therefore carries a DIFFERENT `id` and `url` than the ones the caller asked about,
 * plus `movedFrom` and the old URL so a client can tell the operator what just happened rather
 * than silently swapping the link under them.
 */
async function editDocHandler(
  request: Request,
  env: Env,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const edit: DocEdit = {};
  if ("name" in body) edit.name = requireString(body["name"], "name");
  if ("title" in body) edit.title = parseTitle(body["title"]);
  // Distinguishable from absent: `""` and `[]` clear the field, so the console's Save can send
  // the whole form and have an emptied box actually empty the field.
  if ("summary" in body) edit.summary = typeof body["summary"] === "string" ? body["summary"] : "";
  if ("tags" in body) edit.tags = parseTags(body["tags"]) ?? [];

  const result = await editDocument(env, id, edit);
  if (!result) return fail(404, "not_found", `No such document: ${id}`);

  const base = baseUrl(request, env);
  const portal = await getPortal(env, result.meta.portal);
  const out: Record<string, unknown> = {
    ...result.meta,
    url: portal
      ? `${base}${documentPath(portal, result.meta.id)}`
      : `${base}/v/${encodeURIComponent(result.meta.portal)}/${result.meta.id}`,
  };
  if (result.meta.publicToken) out["publicUrl"] = `${base}/p/${result.meta.publicToken}`;
  if (result.movedFrom) {
    out["movedFrom"] = result.movedFrom;
    out["movedFromUrl"] = portal
      ? `${base}${documentPath(portal, result.movedFrom)}`
      : `${base}/v/${encodeURIComponent(result.meta.portal)}/${result.movedFrom}`;
  }
  return json(out);
}

// ---------------------------------------------------------------------------
// Portals
// ---------------------------------------------------------------------------

async function createPortal(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);

  // Validated as given, NOT lowercased first. Silently turning "Has-Caps" into "has-caps"
  // means the caller later references the name they typed and gets a 404.
  const slug = requireString(body["slug"], "slug").trim();
  if (!isValidSlug(slug)) {
    throw new BadRequest(
      "invalid_slug",
      `"${slug}" is not a valid portal slug: lowercase letters, digits and hyphens, 2-40 chars, and not a reserved word`,
    );
  }
  if (await getPortal(env, slug)) {
    throw new BadRequest("portal_exists", `Portal "${slug}" already exists`);
  }

  const now = new Date().toISOString();
  const portal: Portal = {
    slug,
    name: parseTitle(body["name"] ?? slug),
    kind: parsePortalKind(body["kind"]),
    createdAt: now,
    updatedAt: now,
  };
  const description = parseSummary(body["description"]);
  if (description) portal.description = description;

  await putPortal(env, portal);
  return json(portal, 201);
}

async function portalHandler(request: Request, env: Env, slug: string): Promise<Response> {
  const portal = await getPortal(env, slug);
  if (!portal) return fail(404, "no_such_portal", `No such portal: ${slug}`);

  if (request.method === "GET") {
    const [docs, members] = await Promise.all([listDocs(env, slug), getMembers(env, slug)]);
    // The console needs the member list to show and remove them, not just a count.
    return json({ ...portal, docCount: docs.length, memberCount: members.length, members });
  }

  if (request.method === "PATCH") {
    const body = await readJson(request);

    // Membership goes through the shared service so the Access group stays in sync (#20) —
    // the same code the MCP tool uses.
    const add = parseEmails(body["addMembers"], "addMembers") ?? [];
    const remove = parseEmails(body["removeMembers"], "removeMembers") ?? [];
    const memberChange = add.length > 0 || remove.length > 0;
    const memberResult = memberChange ? await updatePortalMembers(env, slug, add, remove) : null;

    // Portal metadata (optional, independent of membership).
    let updated: Portal = portal;
    if (
      body["name"] !== undefined ||
      body["kind"] !== undefined ||
      body["description"] !== undefined ||
      body["pinned"] !== undefined
    ) {
      updated = { ...portal, updatedAt: new Date().toISOString() };
      // 🔴 The primitive is "set the whole order", not "move this one up". Up / down / to-top /
      // to-bottom are computed against the current array by the caller, so this endpoint stays
      // idempotent and costs exactly one write however far something moved. `normalizePinned`
      // owns the cap, the de-duplication and the trim, so every surface gets the same answer.
      // An explicit empty array clears the block; omitting the key leaves it alone.
      if (body["pinned"] !== undefined) {
        if (!Array.isArray(body["pinned"])) return fail(400, "bad_pinned", "pinned must be an array of filenames");
        const pinned = normalizePinned(body["pinned"]);
        if (pinned.length) updated.pinned = pinned;
        else delete updated.pinned;
      }
      if (body["name"] !== undefined) updated.name = parseTitle(body["name"]);
      if (body["kind"] !== undefined) updated.kind = parsePortalKind(body["kind"]);
      if (body["description"] !== undefined) {
        const description = parseSummary(body["description"]);
        if (description) updated.description = description;
        else delete updated.description;
      }
      await putPortal(env, updated);
    }

    const members = memberResult ? memberResult.members : await getMembers(env, slug);
    return json({ ...updated, members, ...(memberResult ? { sync: memberResult.sync.status } : {}) });
  }

  if (request.method === "DELETE") return await deletePortalHandler(request, env, portal);

  return fail(405, "method_not_allowed", `${request.method} not allowed on /api/portals/${slug}`);
}

/**
 * Deleting a portal deletes a client's entire history. Make that impossible to do by
 * accident: it refuses on a non-empty portal unless the caller says `?cascade=true`, and
 * the error names how many documents it is about to destroy.
 */
async function deletePortalHandler(request: Request, env: Env, portal: Portal): Promise<Response> {
  const cascade = new URL(request.url).searchParams.get("cascade") === "true";
  const docs = await listDocs(env, portal.slug);

  if (docs.length > 0 && !cascade) {
    return fail(
      409,
      "portal_not_empty",
      `Portal "${portal.slug}" holds ${docs.length} document(s). Deleting it deletes them too. Re-send with ?cascade=true.`,
    );
  }

  for (const summary of docs) {
    const meta = await getMeta(env, summary.id);
    if (meta) await deleteDoc(env, meta);
  }
  await deletePortal(env, portal.slug);

  return json({ ok: true, deleted: docs.length });
}

// ---------------------------------------------------------------------------
// Members — the payoff of the whole data model
// ---------------------------------------------------------------------------

async function membersHandler(request: Request, env: Env, slug: string): Promise<Response> {
  const portal = await getPortal(env, slug);
  if (!portal) return fail(404, "no_such_portal", `No such portal: ${slug}`);

  if (request.method === "GET") return json({ members: await getMembers(env, slug) });

  // ⭐ One call adds a person to every document this client has ever received. That is the
  // entire reason permissions live on the portal rather than on the document.
  if (request.method === "PUT") {
    const body = await readJson(request);
    await putMembers(env, slug, parseEmails(body["emails"], "emails") ?? []);
    return json({ members: await getMembers(env, slug) });
  }

  if (request.method === "POST") {
    const body = await readJson(request);
    const add = parseEmails(body["add"], "add") ?? [];
    const remove = new Set(parseEmails(body["remove"], "remove") ?? []);

    const current = await getMembers(env, slug);
    const next = [...new Set([...current, ...add])].filter((email) => !remove.has(email));

    await putMembers(env, slug, next);
    return json({ members: await getMembers(env, slug) });
  }

  return fail(405, "method_not_allowed", `${request.method} not allowed on this endpoint`);
}

// ---------------------------------------------------------------------------

async function readJson(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BadRequest("invalid_json", "Request body is not valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequest("invalid_body", "Request body must be an object");
  }
  return body as Record<string, unknown>;
}

const PORTAL_KINDS: readonly PortalKind[] = ["private", "restricted", "public"];

function parsePortalKind(value: unknown): PortalKind {
  if (value === undefined) return "private";
  if (typeof value !== "string" || !PORTAL_KINDS.includes(value as PortalKind)) {
    throw new BadRequest("invalid_field", `"kind" must be one of: ${PORTAL_KINDS.join(", ")}`);
  }
  return value as PortalKind;
}

/**
 * Share links come from `PUBLIC_HOST`, falling back to the host the request arrived on —
 * which is nearly always right, and means an unset var degrades to correct rather than to
 * `https:///v/abc`.
 */
function baseUrl(request: Request, env: Env): string {
  const configured = env.PUBLIC_HOST?.trim();
  return configured ? `https://${configured}` : new URL(request.url).origin;
}

function publishResult(meta: DocMeta, portal: Portal, base: string) {
  const result: Record<string, unknown> = {
    id: meta.id,
    portal: meta.portal,
    name: meta.name,
    title: meta.title,
    // Always print where it landed. This — not a required --portal flag — is what catches a
    // client report filed into the wrong client's portal. See ADR-005.
    //
    // A public portal's URL is /pub/, not /v/: handing someone a /v/ link to a public page
    // walks them into an Access login wall and burns a seat.
    url: `${base}${documentPath(portal, meta.id)}`,
    ownerOnly: meta.ownerOnly,
  };
  if (meta.extraEmails) result["extraEmails"] = meta.extraEmails;
  // The public link is a *different* URL, not a variant: /v/ still requires a login.
  if (meta.publicToken) result["publicUrl"] = `${base}/p/${meta.publicToken}`;
  return result;
}

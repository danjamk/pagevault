import { BadRequest } from "./documents.js";
import type { Env } from "./env.js";

/**
 * View metrics, as MCP sees them (#127).
 *
 * 🔴 The Worker still never reads Analytics Engine. Reading it needs an account-scoped
 * `Account Analytics Read` token — strictly wider than the Access-group-scoped `CF_API_TOKEN` the
 * Worker holds, and enough to read analytics for every Worker on the account — so ADR-015
 * decision 6 keeps it off the Worker and [ADR-019](../../docs/adr/ADR-019-view-metrics-reach-mcp-by-sync.md)
 * does not weaken that.
 *
 * Instead `pagevault views --sync` reads from the operator's machine, aggregates, and hands the
 * Worker a *result*. This module stores that result and joins it onto documents. The Worker gains
 * data, never the capability to compute it.
 *
 * There is no `canView()` call here, and that is deliberate rather than an oversight: `/mcp` and
 * `/api` are gated as a whole by operator identity, so a per-document check on this path could not
 * fail (ADR-016, and the note on `canView` itself). Metrics ride along inside `list_documents` /
 * `read_document` and inherit whatever gate that read path has — a decorative check bolted on here
 * would be worse than none, because it would get believed.
 */

export interface ViewStats {
  views: number;
  /** ISO-8601, or null when the document has been measured and never opened. */
  lastViewedAt: string | null;
  /** Which door readers came through. Mirrors `ViewSurface` in analytics.ts. */
  surfaces: { link: number; public: number; portal: number };
}

export interface ViewSummary {
  syncedAt: string;
  windowDays: number;
  docs: Record<string, ViewStats>;
}

/** One key, so a sync costs one write against the 1000/day budget (ADR-019 decision 3). */
const SUMMARY_KEY = "views:summary";

/**
 * Well under KV's 25MB value cap, and roughly 8,000 documents at the size an entry actually is.
 * The point is not the ceiling but that hitting it is an error rather than a truncation.
 */
export const MAX_SUMMARY_BYTES = 1024 * 1024;

const SURFACES = ["link", "public", "portal"] as const;

export const getViewSummary = (env: Env): Promise<ViewSummary | null> =>
  env.PAGEVAULT.get<ViewSummary>(SUMMARY_KEY, "json");

export const putViewSummary = (env: Env, summary: ViewSummary): Promise<void> =>
  env.PAGEVAULT.put(SUMMARY_KEY, JSON.stringify(summary));

/**
 * The metrics to report for one document, or `null` when there is nothing honest to say.
 *
 * Three answers, and collapsing any two of them is the bug this function exists to prevent:
 *
 * - **No summary at all** → `null`. No sync has ever run.
 * - **Published since the sync** → `null`. The document was not in the measured window, so it was
 *   never counted. Reporting `0` here would say "the client never opened it" about a document
 *   that did not exist when we last looked.
 * - **Measured, no rows** → zeros. This is the *useful* answer, and the whole point of the
 *   feature: they had the chance and never opened it.
 *
 * A `0` that means "not measured" fails the same way a seat count of `0` that means "could not
 * ask" does — it reads as fact at precisely the moment it is not one.
 */
export function statsFor(
  summary: ViewSummary | null,
  doc: { id: string; createdAt: string },
): ViewStats | null {
  if (!summary) return null;
  // Parsed rather than compared as strings: both are ISO-8601, but `…:00.000Z` and `…:00Z` sort
  // in the wrong order lexicographically for the same instant.
  if (Date.parse(doc.createdAt) > Date.parse(summary.syncedAt)) return null;
  return summary.docs[doc.id] ?? { views: 0, lastViewedAt: null, surfaces: { link: 0, public: 0, portal: 0 } };
}

/** A document record with its metrics folded in, or handed back untouched when none apply. */
export function withStats<T extends { id: string; createdAt: string }>(
  doc: T,
  summary: ViewSummary | null,
): T | (T & ViewStats) {
  const stats = statsFor(summary, doc);
  return stats ? { ...doc, ...stats } : doc;
}

/**
 * Validate a posted summary and rebuild it field by field.
 *
 * Rebuilt, never spread: this is data that ends up inside an MCP response, and "it came from our
 * own CLI" is not a validation strategy — the endpoint takes an owner bearer, and an owner bearer
 * is exactly what a leaked token is.
 *
 * Throws `BadRequest`, which `/api`'s handler maps to 400 (or 413 for `too_large`).
 */
export function parseViewSummary(body: unknown): ViewSummary {
  if (!isRecord(body)) throw new BadRequest("invalid_field", "Body must be a JSON object");

  const syncedAt = body["syncedAt"];
  if (typeof syncedAt !== "string" || !Number.isFinite(Date.parse(syncedAt))) {
    throw new BadRequest("invalid_field", `"syncedAt" must be an ISO-8601 timestamp`);
  }

  const windowDays = Number(body["windowDays"]);
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    throw new BadRequest("invalid_field", `"windowDays" must be a positive number`);
  }

  const rawDocs = body["docs"];
  if (!isRecord(rawDocs)) {
    throw new BadRequest("invalid_field", `"docs" must be an object keyed by document id`);
  }

  // Null-prototype: `docs` is keyed by strings that arrived over the wire, and `__proto__` on a
  // normal object literal sets the prototype instead of a key.
  const docs: Record<string, ViewStats> = Object.create(null);

  for (const [id, value] of Object.entries(rawDocs)) {
    if (!isRecord(value)) throw new BadRequest("invalid_field", `docs["${id}"] must be an object`);

    const views = count(value["views"], `docs["${id}"].views`);

    const lastViewedAt = value["lastViewedAt"];
    if (lastViewedAt !== null && lastViewedAt !== undefined && typeof lastViewedAt !== "string") {
      throw new BadRequest("invalid_field", `docs["${id}"].lastViewedAt must be a string or null`);
    }

    const raw = isRecord(value["surfaces"]) ? value["surfaces"] : {};
    const surfaces = { link: 0, public: 0, portal: 0 };
    for (const s of SURFACES) surfaces[s] = count(raw[s] ?? 0, `docs["${id}"].surfaces.${s}`);

    docs[id] = { views, lastViewedAt: lastViewedAt ?? null, surfaces };
  }

  const summary: ViewSummary = { syncedAt, windowDays, docs };

  // Measured on the REBUILT object — the number that matters is what we would write, not what
  // arrived. Refusing beats storing a truncation: a summary quietly missing half a portal reports
  // "never opened" for documents that were.
  const bytes = new TextEncoder().encode(JSON.stringify(summary)).byteLength;
  if (bytes > MAX_SUMMARY_BYTES) {
    throw new BadRequest(
      "too_large",
      `View summary is ${bytes} bytes, over the ${MAX_SUMMARY_BYTES}-byte limit. Narrow the window with --days.`,
    );
  }

  return summary;
}

function count(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new BadRequest("invalid_field", `${field} must be a non-negative number`);
  return n;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

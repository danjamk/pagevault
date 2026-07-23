import { type DocMeta, type Portal, normalizeEmail } from "./store.js";

/**
 * Compare two emails. Never `===` on raw strings.
 *
 * A case-mismatched email silently failing an allowlist check is a confidentiality
 * bug that presents as a UI bug, which is the worst way for one to present.
 */
export function emailsMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return normalizeEmail(a) === normalizeEmail(b);
}

/**
 * May this person see the portal *itself* — its name, its index, the list of what a
 * client has been given?
 *
 * This is a different question from `canView`, and keeping them separate is what makes
 * the listing free.
 *
 * `extraEmails` is a **document** grant, not a portal grant. If you sent one report to a
 * client's CFO, the CFO can open that report — and has no business seeing the client's
 * entire index. So the index does not consult `extraEmails` at all, which is also why it
 * can be rendered from KV key metadata with **zero reads**: the only per-document
 * question left is `ownerOnly`, and that is in the metadata.
 *
 * Fold this into `canView` and you reintroduce a read per document on every portal page
 * load — the exact N+1 the data model exists to avoid.
 */
export function canViewPortal(
  portal: Portal,
  members: string[],
  email: string | null,
  ownerEmail: string,
): boolean {
  if (emailsMatch(email, ownerEmail)) return true;
  if (portal.kind === "public") return true;
  if (email === null) return false;

  if (portal.kind === "restricted") {
    return members.some((member) => emailsMatch(member, email));
  }

  // Private portals are the owner's. A per-document grant does not open the front door.
  return false;
}

/**
 * ⚠️ THE authorization function. There is no other one.
 *
 * Cloudflare Access answers "who are you?". This answers "may you see this?". Every
 * per-viewer path that shows a document to a *client* goes through here — the `/v/` route
 * and the portal index.
 *
 * The read-side MCP surface is a different shape, and the honest description matters
 * (ADR-016): `/mcp` is gated as a whole by operator identity, and the sole operator passes
 * check #1 below every time — so `readDocument()` does not call this per document, because
 * the call could not fail. Prime directive #5 ("one authorization function") is kept by there
 * being exactly one read path, not by a decorative check bolted onto it. If a multi-viewer MCP
 * surface is ever added, it routes its reads through here — that is what #5 is protecting.
 *
 * Pure by design: no `env`, no KV, no I/O. Everything it needs is an argument, so the
 * whole matrix can be exercised without a Worker.
 *
 * The order of these checks is load-bearing. Read `docs/adr/ADR-005-portal-data-model.md`
 * before changing any of it.
 */
export function canView(
  doc: DocMeta,
  portal: Portal,
  members: string[],
  email: string | null,
  ownerEmail: string,
): boolean {
  // 1. The owner sees everything they own.
  if (emailsMatch(email, ownerEmail)) return true;

  // 2. ownerOnly beats EVERY grant below it. This ordering is the whole point.
  //
  //    Move this below the extraEmails check and a draft with an email grant on it
  //    becomes visible to that person — a silently leaked draft, while every other
  //    test in the suite still passes. It is the single most dangerous line to
  //    reorder in this codebase.
  if (doc.ownerOnly) return false;

  // 3. A public portal is public. No identity required.
  if (portal.kind === "public") return true;

  // 4. Everything below requires an authenticated identity.
  if (email === null) return false;

  const viewer = normalizeEmail(email);

  // 5. Additive per-document grant. ADDITIVE ONLY.
  //
  //    Note the shape: this is an early `return true`. It is never a `return false`.
  //    A reviewer should be able to see from the control flow alone that extraEmails
  //    cannot take access away from someone the portal already permits.
  if (doc.extraEmails?.some((granted) => emailsMatch(granted, viewer))) return true;

  // 6. A restricted portal is its member list. Cross-portal isolation is absolute:
  //    `members` belongs to THIS portal, and membership elsewhere confers nothing.
  if (portal.kind === "restricted") {
    return members.some((member) => emailsMatch(member, viewer));
  }

  // 7. Private portal, and we already know this is not the owner.
  //
  //    An extraEmails grant above may still have let someone in, and that is correct
  //    and intended: a private portal is the DEFAULT bucket, not a vault. `publish
  //    report.html --emails cfo@acme.com` has to work without making the user invent
  //    a portal for two people.
  return false;
}
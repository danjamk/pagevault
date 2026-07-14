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
 * ⚠️ THE authorization function. There is no other one.
 *
 * Cloudflare Access answers "who are you?". This answers "may you see this?". Every
 * path that shows a document goes through here — including the read-side MCP tools,
 * where it feels like a convenience feature and is actually the same threat wearing a
 * different hat.
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
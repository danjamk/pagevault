//
// Pin-order arithmetic (#142).
//
// The API primitive is "set the whole order" — idempotent, one write however far something moved.
// Up / down / to-top / to-bottom are therefore computed HERE, against the list the deployment
// currently holds, and sent as a complete array. That is what keeps the endpoint from growing four
// verbs that each need their own concurrency story.
//
// Pure and dependency-free, so the arithmetic is testable without a deployment — which matters more
// than usual here, because "move up" at position 0 and "move down" at the end are exactly the cases
// a hand-test never reaches.
//
// 🔴 No MAX_PINNED here on purpose. The Worker's `normalizePinned` is the authority on the cap, the
// de-duplication and the trim; a second copy in the CLI is a second answer waiting to disagree.
// These functions may return a longer list than the deployment will keep, and the caller reports
// what came back rather than predicting it.
//

/** Case-insensitive, because document identity is (ADR-017). */
const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** Where `name` currently sits, or -1. */
export const indexOfPin = (pinned = [], name) => pinned.findIndex((p) => same(p, name));

/**
 * Add or move `name` within the pin list.
 *
 * `op` is `"top"` (the default — a newly pinned document is the one you just decided matters),
 * `"bottom"`, `"up"`, `"down"`, or a 1-based position.
 *
 * Moving something that is not pinned yet pins it: `pin x --up` on an unpinned document is a
 * request to feature it, and refusing on a technicality would be pedantry.
 */
export function applyPin(pinned = [], name, op = "top") {
  const list = [...pinned];
  const at = indexOfPin(list, name);
  const value = at === -1 ? String(name).trim() : list[at];
  if (at !== -1) list.splice(at, 1);

  // `at` is the OLD index; after the splice, positions above it have shifted down by one. `from`
  // is where the item effectively sits for a relative move, and for a not-yet-pinned document the
  // relative ops mean "put it at the end and then move", which lands where you would expect.
  const from = at === -1 ? list.length : at;

  let to;
  if (op === "top") to = 0;
  else if (op === "bottom") to = list.length;
  else if (op === "up") to = Math.max(0, from - 1);
  else if (op === "down") to = Math.min(list.length, from + 1);
  else {
    const n = Number(op);
    if (!Number.isFinite(n)) throw new Error(`Unknown pin position: ${op}`);
    // 1-based for humans, clamped rather than refused — "position 99" plainly means "last".
    to = Math.min(Math.max(0, Math.trunc(n) - 1), list.length);
  }

  list.splice(to, 0, value);
  return list;
}

/** Remove `name` from the pin list. Returns the list unchanged when it was not pinned. */
export function applyUnpin(pinned = [], name) {
  return [...pinned].filter((p) => !same(p, name));
}

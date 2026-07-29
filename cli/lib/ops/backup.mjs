//
// `pagevault backup` (and `make backup`) — snapshot the Workers KV namespace to a JSON file that
// `pagevault restore` replays.
//
// Same-host disaster recovery (Cloudflare → Cloudflare): keys stay stable, so document ids and
// every URL you've already shared survive a restore. This is NOT the human-readable export
// (`pagevault export`, #35) — different artifact, different purpose.
//
// One engine, two front doors (ADR-014, #133): the CLI imports backupCmd(); `make backup` runs it
// through `pagevault backup`. Backup is operator infrastructure, not a dev convenience — an
// `npm install -g pagevault` operator holds real client documents and had no way to snapshot them
// while this lived in `scripts/` (Prime Directive #2, "installed, not cloned").
//
// 🔴 The trap (spike 2026-07-16): a values-only dump silently loses KEY METADATA. PageVault's
// `meta:` and `portal:` keys carry their listing data in metadata (store.ts), and `listDocs()`
// SKIPS a metadata-less key — so a naive backup restores documents that are fetchable by id but
// invisible to every listing and portal index. So we back up name + value + metadata, joined by
// key name. Done over the Cloudflare API (token-first), not wrangler — the values endpoint gives
// us the body and the keys endpoint gives us the metadata inline.
//
import { writeFileSync } from "node:fs";
import { c, ok, info, warn, die, loadCloudToken, loadContext, cfApi, cfErr, banner, runHint } from "../provision/context.mjs";

const CF = "https://api.cloudflare.com/client/v4";

// Which front door the operator came through. `make` exports MAKELEVEL into every recipe, so a
// hint can name the incantation they can actually type — `make restore FILE=…` or
// `pagevault restore …`. Telling them the wrong one is how one command becomes two (#125).
const viaMake = () => process.env.MAKELEVEL !== undefined;

/**
 * Build one bulk-put-shaped entry from a keys-list item and its value. Pure and exported so a
 * test can prove metadata survives — the whole reason this module exists. Naively returning
 * `{ key, value }` (dropping metadata) is exactly the regression the test must catch.
 */
export function toEntry(keyItem, value) {
  const entry = { key: keyItem.name, value };
  if (keyItem.metadata !== undefined) entry.metadata = keyItem.metadata;
  if (keyItem.expiration !== undefined) entry.expiration = keyItem.expiration;
  return entry;
}

// A backup file carries only metadata (present on some keys) — never a secret — so it is safe
// beside your repo, but keep it gitignored anyway.
export function defaultOutName(now = new Date()) {
  return `pagevault-backup-${now.toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
}

/**
 * @param {{ out?: string, kv?: string }} [opts]
 *   out — where to write the snapshot (default: pagevault-backup-<timestamp>.json)
 *   kv  — a KV namespace id, overriding the one this install deployed
 */
export async function backupCmd({ out, kv } = {}) {
  const token = loadCloudToken();
  if (!token) die("No Cloudflare token.", `Run \`${runHint("setup", "init")}\` first — it captures and saves one.`);

  const ctx = loadContext();
  const account = ctx.accountId;
  const nsId = kv ?? ctx.kvId;
  if (!account) die("No Cloudflare account recorded.", `Run \`${runHint("setup", "init")}\`.`);
  if (!nsId) die("No KV namespace id.", "Deploy first, or pass --kv <id>.");

  const file = out ?? defaultOutName();
  const nsPath = `/accounts/${account}/storage/kv/namespaces/${nsId}`;

  console.log(banner("backup", `(KV ${nsId})`));

  // 1. Every key, with its metadata inline — paginated by the cursor in result_info.
  info("Listing keys…");
  const keys = [];
  let cursor = "";
  for (;;) {
    const q = `${nsPath}/keys?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await cfApi(q);
    if (!r.ok) die(`Couldn't list keys (${cfErr(r.errors)}).`, "Check the token has 'Workers KV Storage — Edit'.");
    keys.push(...(r.result ?? []));
    cursor = r.result_info?.cursor || "";
    if (!cursor) break;
  }
  if (keys.length === 0) {
    warn("The namespace is empty — nothing to back up.");
    return;
  }
  ok(`${keys.length} keys`);

  // 2. Each value (raw — the values endpoint returns the body, not a JSON envelope), paired
  //    with the metadata from step 1.
  info("Fetching values…");
  const entries = [];
  for (const k of keys) {
    const res = await fetch(`${CF}${nsPath}/values/${encodeURIComponent(k.name)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) die(`Couldn't read "${k.name}" (HTTP ${res.status}).`);
    entries.push(toEntry(k, await res.text()));
  }

  const withMeta = entries.filter((e) => e.metadata !== undefined).length;
  writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
  ok(`Wrote ${c.bold(file)} ${c.dim(`— ${entries.length} keys, ${withMeta} with metadata`)}`);

  const restoreCmd = viaMake() ? `make restore FILE=${file}` : `pagevault restore ${file}`;
  console.log(`\n  ${c.dim("Restore it with")} ${c.bold(restoreCmd)}${c.dim(" (into an empty namespace).")}\n`);
}

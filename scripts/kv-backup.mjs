#!/usr/bin/env node
//
// make backup — snapshot the Workers KV namespace to a JSON file that `make restore` replays.
//
// Same-host disaster recovery (Cloudflare → Cloudflare): keys stay stable, so document ids and
// every URL you've already shared survive a restore. This is NOT the human-readable export
// (#35) — different artifact, different purpose.
//
// 🔴 The trap (spike 2026-07-16): a values-only dump silently loses KEY METADATA. PageVault's
// `meta:` and `portal:` keys carry their listing data in metadata (store.ts), and `listDocs()`
// SKIPS a metadata-less key — so a naive backup restores documents that are fetchable by id but
// invisible to every listing and portal index. So we back up name + value + metadata, joined by
// key name. Done over the Cloudflare API (token-first), not wrangler — the values endpoint gives
// us the body and the keys endpoint gives us the metadata inline.
//
import { writeFileSync } from "node:fs";
import { c, ok, info, warn, die, loadCloudToken, loadContext, cfApi, cfErr, argValue } from "./context.mjs";

const CF = "https://api.cloudflare.com/client/v4";

/**
 * Build one bulk-put-shaped entry from a keys-list item and its value. Pure and exported so a
 * test can prove metadata survives — the whole reason this script exists. Naively returning
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
function defaultOutName() {
  const iso = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `pagevault-backup-${iso}.json`;
}

// Run only when invoked directly, so the pure helper above can be imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const token = loadCloudToken();
  if (!token) die("No Cloudflare token.", "Run `make setup` first — it captures and saves one.");

  const ctx = loadContext();
  const account = ctx.accountId;
  const nsId = argValue("--kv") ?? ctx.kvId;
  if (!account) die("No account in .pagevault.json.", "Run `make setup`.");
  if (!nsId) die("No KV namespace id.", "Deploy first, or pass --kv <id>.");

  const out = argValue("--out") ?? defaultOutName();
  const nsPath = `/accounts/${account}/storage/kv/namespaces/${nsId}`;

  console.log(`\n${c.head("PageVault — backup")} ${c.dim(`(KV ${nsId})`)}\n`);

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
    process.exit(0);
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
  writeFileSync(out, `${JSON.stringify(entries, null, 2)}\n`);
  ok(`Wrote ${c.bold(out)} ${c.dim(`— ${entries.length} keys, ${withMeta} with metadata`)}`);
  console.log(`\n  ${c.dim("Restore it with")} ${c.bold(`make restore FILE=${out}`)}${c.dim(" (into an empty namespace).")}\n`);
}

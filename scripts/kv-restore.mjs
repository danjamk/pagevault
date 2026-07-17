#!/usr/bin/env node
//
// make restore FILE=<backup.json> — replay a `make backup` file into the KV namespace.
//
// Same-host disaster recovery. Keys are restored verbatim — name, value, AND metadata — so
// documents come back visible to listings, not just fetchable by id (the whole point of the
// backup format). Over the Cloudflare API, token-first.
//
// Guards: refuses a non-empty target namespace unless --force (restore is meant for a fresh
// one), and prints the write cost before spending any of the 1000/day free quota.
//
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { c, ok, info, warn, die, loadCloudToken, loadContext, cfApi, cfErr, argValue, isInteractive, banner } from "./context.mjs";

// KV bulk write caps: 10,000 keys and 100 MB per request. Stay well under both.
const MAX_KEYS_PER_CALL = 1000;
const MAX_BYTES_PER_CALL = 80 * 1024 * 1024;

const token = loadCloudToken();
if (!token) die("No Cloudflare token.", "Run `make setup` first — it captures and saves one.");

const ctx = loadContext();
const account = ctx.accountId;
const nsId = argValue("--kv") ?? ctx.kvId;
const file = argValue("--in") ?? argValue("--file") ?? process.env.FILE;
const force = process.argv.includes("--force");

if (!account) die("No account in .pagevault.json.", "Run `make setup`.");
if (!nsId) die("No KV namespace id.", "Deploy first, or pass --kv <id>.");
if (!file) die("No backup file.", "Run `make restore FILE=pagevault-backup-….json`.");
if (!existsSync(file)) die(`No such file: ${file}`);

let entries;
try {
  entries = JSON.parse(readFileSync(file, "utf8"));
} catch (err) {
  die(`Couldn't parse ${file}: ${String(err).split("\n")[0]}`);
}
if (!Array.isArray(entries) || entries.some((e) => typeof e?.key !== "string")) {
  die(`${file} isn't a backup file.`, "Expected a JSON array of { key, value, metadata? } — the shape `make backup` writes.");
}

const nsPath = `/accounts/${account}/storage/kv/namespaces/${nsId}`;

console.log(banner("restore", `(KV ${nsId})`));

// Refuse a non-empty target unless forced — restore is same-host recovery into a fresh
// namespace, not a merge. Overwriting live keys is a data-loss footgun, so it must be explicit.
const probe = await cfApi(`${nsPath}/keys?limit=10`);
if (!probe.ok) die(`Couldn't read the namespace (${cfErr(probe.errors)}).`, "Check the token has 'Workers KV Storage — Edit'.");
const nonEmpty = (probe.result ?? []).length > 0;
if (nonEmpty && !force) {
  die(`Namespace ${nsId} is not empty.`, [
    "Restore is meant for an empty namespace (fresh disaster recovery).",
    "Restore into a new KV, or re-run with --force to overwrite existing keys.",
  ]);
}

const withMeta = entries.filter((e) => e.metadata !== undefined).length;
console.log(`  ${c.bold(String(entries.length))} keys ${c.dim(`(${withMeta} with metadata)`)} from ${c.bold(file)}`);
warn(`This writes ${entries.length} keys — ${entries.length} of the free ${c.bold("1000 writes/day")}.${nonEmpty ? c.red(" Existing keys will be overwritten.") : ""}`);

if (isInteractive() && !process.argv.includes("--yes")) {
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question(`\n  Restore now? [y/N] `)).trim().toLowerCase();
  rl.close();
  if (ans !== "y" && ans !== "yes") die("Cancelled — nothing was written.");
}

// Bulk-PUT in chunks under the per-request key/byte caps. PageVault namespaces are small, so
// this is usually one call — but chunk defensively for a large document set.
let written = 0;
let chunk = [];
let chunkBytes = 0;
const flush = async () => {
  if (chunk.length === 0) return;
  const r = await cfApi(`${nsPath}/bulk`, { method: "PUT", body: JSON.stringify(chunk) });
  if (!r.ok) die(`Bulk write failed after ${written} keys (${cfErr(r.errors)}).`);
  written += chunk.length;
  info(`Wrote ${written}/${entries.length}…`);
  chunk = [];
  chunkBytes = 0;
};
for (const e of entries) {
  const size = Buffer.byteLength(JSON.stringify(e));
  if (chunk.length >= MAX_KEYS_PER_CALL || chunkBytes + size > MAX_BYTES_PER_CALL) await flush();
  chunk.push(e);
  chunkBytes += size;
}
await flush();

ok(`Restored ${written} keys${withMeta ? `, ${withMeta} with metadata` : ""}.`);
console.log(`\n  ${c.dim("KV is eventually consistent (~60s) — listings may lag briefly after a restore.")}\n`);

//
// `pagevault restore <file>` (and `make restore FILE=<file>`) — replay a backup into the KV
// namespace.
//
// Same-host disaster recovery. Keys are restored verbatim — name, value, AND metadata — so
// documents come back visible to listings, not just fetchable by id (the whole point of the
// backup format). Over the Cloudflare API, token-first.
//
// One engine, two front doors (ADR-014, #133), same as backup.mjs: the decision logic is in
// restore-plan.mjs, the formatting is here, and both doors call restoreCmd().
//
// Guards: refuses to leave keys behind that the backup won't replace unless forced, and prints
// the write cost before spending any of the 1000/day free quota.
//
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { c, ok, info, warn, die, loadCloudToken, loadContext, cfApi, cfErr, isInteractive, banner, runHint, cloudCredentialHint } from "../provision/context.mjs";
import { planRestore } from "./restore-plan.mjs";

// KV bulk write caps: 10,000 keys and 100 MB per request. Stay well under both.
const MAX_KEYS_PER_CALL = 1000;
const MAX_BYTES_PER_CALL = 80 * 1024 * 1024;

/** Every key in the namespace. Paginated — KV caps a list page at 1000. */
async function listAllKeys(path) {
  const keys = [];
  let cursor = "";
  do {
    const q = `${path}/keys?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await cfApi(q);
    if (!page.ok) die(`Couldn't read the namespace (${cfErr(page.errors)}).`, "Check the token has 'Workers KV Storage — Edit'.");
    keys.push(...(page.result ?? []));
    cursor = page.result_info?.cursor ?? "";
  } while (cursor);
  return keys;
}

/** One summary entry, coloured. `planRestore` counts; this is the only place that formats. */
function line(e) {
  if (e.type === "document") return `· ${e.title ?? c.dim("(untitled)")} ${c.dim(e.id)}`;
  const noun = { portal: "portal key", link: "public link", other: "other key" }[e.type];
  return `· ${e.count} ${noun}${e.count === 1 ? "" : "s"}`;
}

/**
 * @param {{ file?: string, kv?: string, force?: boolean }} [opts]
 *   file  — the backup JSON to replay
 *   kv    — a KV namespace id, overriding the one this install deployed
 *   force — proceed even though keys not in the backup would survive
 */
export async function restoreCmd({ file, kv, force = false } = {}) {
  // Which front door the operator came through. `make` exports MAKELEVEL into every recipe, so
  // every hint below can name the incantation they can actually type: `make restore` spells the
  // override FORCE=1, the CLI spells it --force. Telling them the wrong one is how a refusal
  // becomes two refusals (#125).
  const viaMake = process.env.MAKELEVEL !== undefined;
  const forceHint = c.bold(viaMake ? "FORCE=1" : "--force");
  const kvHint = viaMake ? "KV=<id>" : "--kv <id>";
  const restoreHint = viaMake ? "make restore FILE=pagevault-backup-….json" : "pagevault restore pagevault-backup-….json";

  const token = loadCloudToken();
  const ctx = loadContext();
  const account = ctx.accountId;
  const nsId = kv ?? ctx.kvId;

  const SCOPE = "Account · Workers KV Storage · Edit";
  if (!token) die("No Cloudflare token on this machine.", cloudCredentialHint("restore", SCOPE));
  if (!account) die("No Cloudflare account recorded on this machine.", cloudCredentialHint("restore", SCOPE));
  if (!nsId) die("No KV namespace id.", "Deploy first, or pass --kv <id>.");
  if (!file) die("No backup file.", `Run \`${restoreHint}\`.`);
  if (!existsSync(file)) die(`No such file: ${file}`);

  let entries;
  try {
    entries = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    die(`Couldn't parse ${file}: ${String(err).split("\n")[0]}`);
  }
  if (!Array.isArray(entries) || entries.some((e) => typeof e?.key !== "string")) {
    die(`${file} isn't a backup file.`, "Expected a JSON array of { key, value, metadata? } — the shape a backup writes.");
  }

  const nsPath = `/accounts/${account}/storage/kv/namespaces/${nsId}`;

  console.log(banner("restore", `(KV ${nsId})`));

  // Restore is a bulk PUT, not a wipe-and-replace. That means the question worth asking is not
  // "is this namespace empty?" but "what is in here that the backup does NOT replace?" — because
  // those are the keys that survive and silently mix into the restored deployment. A bare
  // "not empty" refusal never said that, so the only way forward looked like --force (#125).
  const live = await listAllKeys(nsPath);
  const { surviving, overwritten, isSampleOnly, summary } = planRestore(live, entries.map((e) => e.key));

  if (live.length > 0 && surviving.length === 0) {
    // Provably safe: every key here is also in the backup, so the restore replaces all of it and
    // leaves nothing behind. No force needed — there is nothing to lose.
    info(`Namespace holds ${live.length} keys, and the backup replaces every one of them.`);
  } else if (surviving.length > 0 && !force) {
    die(`Namespace ${nsId} holds ${surviving.length} key${surviving.length === 1 ? "" : "s"} the backup won't replace.`, [
      ...(isSampleOnly
        ? [
            "This looks like the sample document `verify` publishes, not real data:",
            ...summary.map((e) => `  ${line(e)}`),
            "",
            "That is the usual cause: `verify` publishes a sample so you have something to open,",
            "and it runs first if you follow the deploy's `Next:` line literally.",
            `Nothing is deleted by a restore — re-run with ${forceHint} to write over it.`,
          ]
        : [
            "They would SURVIVE the restore and mix in with the restored data:",
            ...summary.map((e) => `  ${line(e)}`),
            "",
            ...(overwritten ? [`The backup would also overwrite ${overwritten} key${overwritten === 1 ? "" : "s"} already here.`, ""] : []),
            `If that list is disposable, re-run with ${forceHint}. If it is not, restore into a`,
            `fresh KV namespace instead (${kvHint}) and repoint the Worker at it.`,
          ]),
    ]);
  }

  const withMeta = entries.filter((e) => e.metadata !== undefined).length;
  console.log(`  ${c.bold(String(entries.length))} keys ${c.dim(`(${withMeta} with metadata)`)} from ${c.bold(file)}`);
  warn(`This writes ${entries.length} keys — ${entries.length} of the free ${c.bold("1000 writes/day")}.${overwritten ? c.red(` ${overwritten} existing key${overwritten === 1 ? "" : "s"} will be overwritten.`) : ""}`);
  if (surviving.length > 0) {
    // Reachable only when forced. Say plainly what is being kept, so a forced restore is still
    // an informed one — the flag suppresses the refusal, not the facts.
    console.log(`  ${c.dim(`${surviving.length} key${surviving.length === 1 ? "" : "s"} not in the backup will remain:`)}`);
    for (const e of summary) console.log(`    ${c.dim(line(e))}`);
  }

  if (isInteractive()) {
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
}

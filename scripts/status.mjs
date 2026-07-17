#!/usr/bin/env node
//
// make status — what this clone is configured for, at a glance. Local only, no Cloudflare
// calls. Shows both versions: the PageVault product version (what code you're running) and the
// .pagevault.json schema version (internal state format).
//
import { c, banner, loadContext, VERSION, SCHEMA_VERSION } from "./context.mjs";

const ctx = loadContext();
console.log(banner("status"));

const row = (label, val) => console.log(`  ${c.cyan(label.padStart(13))}  ${val ?? c.dim("—")}`);

row("PageVault", `v${VERSION}`);
row("State schema", `v${ctx.schemaVersion ?? SCHEMA_VERSION}`);
console.log();

if (ctx.rung === undefined) {
  console.log(`  ${c.dim("Not configured yet — run")} ${c.bold("make setup")}.\n`);
} else {
  row("Rung", String(ctx.rung));
  row("Owner", ctx.ownerEmail);
  row("Account", ctx.accountName ? `${ctx.accountName} ${c.dim(`(${String(ctx.accountId ?? "").slice(0, 8)})`)}` : ctx.accountId);
  if (ctx.host) row("Host", ctx.host);
  if (ctx.kvId) row("KV", c.dim(ctx.kvId));
  if (ctx.deployedUrl) row("Deployed", c.bold(ctx.deployedUrl));
  console.log();
}

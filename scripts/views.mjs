#!/usr/bin/env node
//
// make views — which documents your clients actually opened (#91).
//
// The OPERATOR front door: zero-config, auto-targeting this clone's deployment. The account id
// comes from .pagevault.json and the token from .env.local, so `make views` needs no flags and
// no login. `pagevault views` is the other front door; both share the engine in cli/lib/views.mjs.
//
// 🔴 This reads the Cloudflare SQL API, not PageVault's own /api — so the credential is the
// CLOUDFLARE_API_TOKEN, and it needs `Account Analytics Read`. The Worker deliberately cannot do
// this; see ADR-015, decision 6.
//
import { c, die, loadContext, loadCloudToken, argValue, banner } from "../cli/lib/provision/context.mjs";
import { formatViews, queryViews } from "../cli/lib/views.mjs";

const ctx = loadContext();
if (!ctx.accountId) die("No account pinned in .pagevault.json.", "Run `make setup` first.");

// A deployment that never opted in has no data to show, and saying so beats an empty table that
// looks like "nobody read your documents".
if (ctx.analytics === false) {
  die("View tracking is off for this deployment.", "Turn it on with `make provision ANALYTICS=on`, then redeploy.");
}

console.log(banner("views", ctx.host ?? ""));

try {
  const result = await queryViews(
    { accountId: ctx.accountId, token: loadCloudToken() },
    { days: argValue("--days"), portal: argValue("--portal"), doc: argValue("--doc"), limit: argValue("--limit") },
  );
  console.log(formatViews(result, c));
} catch (err) {
  die(err.message);
}

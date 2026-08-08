#!/usr/bin/env node
//
// Post a scheduled-sync result to Slack. Maintainer tooling; a fork without the webhook secrets
// never runs it (the workflow's `if:` guards see empty strings and skip).
//
//   node .github/scripts/notify-slack.mjs heartbeat sync-result.json
//   node .github/scripts/notify-slack.mjs alert     sync-result.json
//
// 🔴 A plain fetch, not a Slack Action from the marketplace. This runs in a job that can read
// production's Cloudflare token, its deployment bearer and its intent file — every third-party
// action added here is a supply-chain surface with access to all three, in exchange for building a
// JSON body this file builds in ten lines. The CLI ships zero runtime dependencies for the same
// reason (it is the thing that asks for your Cloudflare token); the job that holds those secrets
// should not be held to a looser standard than the code it runs.
//
// 🔴 The webhook URL is a bearer credential — anyone holding it can post to that channel — so it
// lives in the `production` environment's secrets and is read from the environment here. It is
// never logged, never echoed, and never written to a file. `--fail-with-body` style output is
// avoided for the same reason: curl error text can echo the request URL.
//
// Zero dependencies. Node built-ins only, like the CLI.
//
import { readFileSync } from "node:fs";

const [mode, resultPath] = process.argv.slice(2);

const DEPLOYMENT = process.env.DEPLOYMENT || "unknown deployment";
const RUN_URL =
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "";

const webhook = mode === "alert" ? process.env.SLACK_ALERT_WEBHOOK : process.env.SLACK_HEARTBEAT_WEBHOOK;
if (!webhook) {
  // Not an error. The workflow already guards on this; reaching here means someone ran it by hand.
  console.log(`No webhook configured for "${mode}" — nothing sent.`);
  process.exit(0);
}

/**
 * The sync's own `--json`, when it got far enough to produce one.
 *
 * A failed run often has no file at all, and that is exactly the case the alert matters most for —
 * so this returns null rather than throwing, and the message degrades to naming the deployment and
 * the run. An alert that cannot be sent because its own formatter crashed is worse than a vague one.
 */
function readResult(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const result = resultPath ? readResult(resultPath) : null;

function heartbeatText() {
  if (!result) return `PageVault · sync-views ran on *${DEPLOYMENT}* — no result file to report.`;

  const docs = Number(result.documents ?? 0);
  const { from, to } = result.coverage ?? {};
  const window = from && to ? `${from} → ${to}` : "window not reported";
  const parts = [
    `PageVault · view metrics synced · *${DEPLOYMENT}*`,
    `${docs} document${docs === 1 ? "" : "s"} · covering ${window}`,
  ];

  // Both of these are quiet correctness signals, and both are easy to never notice in a log.
  if (Array.isArray(result.skipped) && result.skipped.length) {
    parts.push(
      `${result.skipped.length} id${result.skipped.length === 1 ? "" : "s"} skipped — records this deployment never created (the dataset is account-level).`,
    );
  }
  if (result.truncated) {
    parts.push("⚠️ Hit the query row limit, so this summary may be incomplete.");
  }
  return parts.join("\n");
}

function alertText() {
  return [
    `🔴 PageVault · *view metrics sync FAILED* · *${DEPLOYMENT}*`,
    "",
    "This is not a broken build — it is history quietly not being saved. Views stay in Analytics",
    "Engine for about 90 days and only a sync makes them durable, so every failed run shortens the",
    "window in which this is still fixable.",
    "",
    "Re-run the workflow, or run `pagevault sync-views` against a machine that can reach the",
    "account. A 403 means the Cloudflare token is missing `Account · Account Analytics · Read`.",
  ].join("\n");
}

const text = mode === "alert" ? alertText() : heartbeatText();
const body = RUN_URL ? `${text}\n${RUN_URL}` : text;

// 🔴 Never fail the job over a notification, and that has to cover a THROWN fetch as well as a
// non-2xx one. An unreachable host — Slack down, DNS out, a webhook revoked — rejects rather than
// returning a status, and letting that propagate would turn a run whose sync SUCCEEDED red. A
// Slack outage would then look exactly like lost data, which inverts the entire point of alerting.
try {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: body }),
  });
  // Status only, never the body. A response can echo the request, and the request URL IS the
  // credential — logging it would publish the webhook into a job log.
  if (res.ok) console.log(`Slack ${mode} sent for ${DEPLOYMENT}.`);
  else console.error(`Slack rejected the ${mode} notification: HTTP ${res.status}`);
} catch (err) {
  // `err.message` only, for the same reason: a fetch failure's cause can carry the URL.
  console.error(`Slack ${mode} notification could not be delivered: ${err.message}`);
}

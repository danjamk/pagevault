#!/usr/bin/env node
//
// make health — ask the live deployment what code it's running (/health, ADR-010) and assert it
// matches the build in this checkout (releaseTag()). This is the loop #48 was built to close:
// baking <version>+<sha> into the Worker is what lets CI (and you) answer "is it actually up to
// date?" rather than trusting that a deploy landed.
//
// Exits non-zero on a mismatch or an unreachable /health, so a CI prod deploy (#38) fails loudly
// instead of going green on a rollout that silently didn't take.
//
import { c, ok, warn, die, loadContext, releaseTag, banner, fromEnv, mcpCall } from "./context.mjs";

const ctx = loadContext();
const base = (ctx.deployedUrl ?? (ctx.host ? `https://${ctx.host}` : "")).replace(/\/$/, "");
if (!base) die("No deployed URL in .pagevault.json.", "Deploy first — the deploy step records where it landed.");

const expected = releaseTag();
console.log(banner("health-check", `${base} · expecting ${c.bold(expected)}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const matches = (h) => h.ok && h.version === expected;

async function health() {
  try {
    const res = await fetch(`${base}/health`, { redirect: "manual" });
    if (res.status !== 200) return { ok: false, status: res.status };
    const body = await res.json().catch(() => null);
    return { ok: true, version: body?.version };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// A just-deployed Worker can take a beat to serve the new build everywhere. Poll before failing —
// same shape as `make verify`: a transient miss is propagation, not a bad deploy.
let last = await health();
if (!matches(last)) {
  process.stdout.write(`  ${c.dim("Waiting for /health to report the new build")}`);
  for (let i = 0; i < 11 && !matches(last); i++) {
    await sleep(5000);
    process.stdout.write(c.dim("."));
    last = await health();
  }
  process.stdout.write("\n");
}

if (matches(last)) {
  ok(`/health reports ${c.bold(last.version)} — matches the shipped build.`);

  // The build string matches. But a version-correct deploy with a dead /mcp is still a
  // broken deploy (#75) — health should say so, not trust the string alone. Assert the MCP
  // surface answers when we have a bearer; skip (don't fail) when we don't, e.g. a CI
  // context without the token.
  const bearer = fromEnv("PAGEVAULT_API_TOKEN");
  if (bearer) {
    const r = await mcpCall(base, bearer, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pagevault-health", version: "1" },
    });
    if (!r.ok || r.result?.serverInfo?.name !== "pagevault") {
      die(
        `/health matches ${c.bold(last.version)}, but /mcp did not answer (HTTP ${r.status}).`,
        "The build is up but the MCP surface is down — do not call this deploy healthy.",
      );
    }
    ok("/mcp answers — the MCP surface is up.");
  } else {
    warn("No PAGEVAULT_API_TOKEN — skipped the /mcp reachability check.");
  }
  process.exit(0);
}

if (!last.ok) {
  die(`/health didn't answer 200 (${last.status ?? last.error}).`, "The deploy may not have landed — check the deploy step's output.");
}
die(
  `/health reports ${c.bold(last.version ?? "unknown")}, but this checkout is ${c.bold(expected)}.`,
  "The deployment isn't running this commit's code. Re-run the deploy, or investigate a stuck rollout.",
);

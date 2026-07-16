#!/usr/bin/env node
//
// make verify — after a deploy: does it actually work? A smoke test that also confirms the
// infrastructure. Reads the deployed URL from .pagevault.json (deploy wrote it there) and
// checks the live host is serving *our* Worker, not Cloudflare's default page or a 5xx.
//
// Read-only and unauthenticated — it proves the deployment is up and routing. A deeper
// publish→read round-trip needs the API token and is left for the MCP/CLI to exercise.
//
import { c, ok, warn, die, loadContext } from "./context.mjs";

const ctx = loadContext();
const base = (ctx.deployedUrl ?? (ctx.host ? `https://${ctx.host}` : "")).replace(/\/$/, "");
if (!base) die("No deployed URL in .pagevault.json.", "Run `make deploy` first.");

console.log(`\n${c.bold("PageVault — verify")} ${c.dim(base)}\n`);

const findings = [];
const pass = (m) => findings.push(["pass", m]);
const fail = (m) => findings.push(["fail", m]);

async function get(path, init) {
  try {
    const res = await fetch(`${base}${path}`, { redirect: "manual", ...init });
    return { status: res.status, res };
  } catch (err) {
    return { status: 0, error: String(err) };
  }
}

// 1. The Worker is reachable and it is OURS. An unknown path returns our 404 envelope —
//    a fingerprint no default Cloudflare page or stray Worker would produce.
{
  const { status, res, error } = await get("/does-not-exist-" + "x".repeat(8));
  if (status === 0) fail(`unreachable — ${error}`);
  else if (status !== 404) fail(`unknown path returned ${status}, expected 404 (is this our Worker?)`);
  else {
    const body = await res.json().catch(() => ({}));
    if (body?.code === "not_found") pass("Worker is live and serving PageVault (404 envelope matches)");
    else fail(`404, but not our envelope (got ${JSON.stringify(body)}) — different Worker on this host?`);
  }
}

// 2. Root redirects to the console, as the router intends.
{
  const { status, res } = await get("/");
  const loc = res?.headers.get("location") ?? "";
  if (status === 302 && loc.endsWith("/admin")) pass("Root redirects to /admin");
  else warn(`Root returned ${status}${loc ? ` → ${loc}` : ""} (expected 302 → /admin)`);
}

// --- report ---------------------------------------------------------------

console.log();
for (const [level, m] of findings) {
  console.log(level === "pass" ? `  ${c.green("✓")} ${m}` : `  ${c.red("✗")} ${m}`);
}
const fails = findings.filter(([l]) => l === "fail").length;
console.log();
if (fails) die(`${fails} check(s) failed — the deployment is up but not serving correctly.`);
console.log(`  ${c.green("Deployment verified.")} Publish a document over MCP and open its /p/ link.\n`);

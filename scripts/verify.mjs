#!/usr/bin/env node
//
// make verify — after a deploy: does it actually work? A smoke test that ends with something
// you can open. It confirms the Worker is ours and routing, then PUBLISHES a real document
// (examples/welcome.html) over the bearer API and prints its public /p/ link.
//
// Why publish, not just ping: at rung 1 there is no Cloudflare Access, so the /admin console
// is (correctly) Forbidden — a fail-closed door with nothing behind it yet. A public
// capability link is the one door that works with zero Access and burns zero seats, so it is
// the honest "it works, go look" for a first deploy. Re-running is safe: it publishes with
// confirm:true and updates the same document in place.
//
import { readFileSync, existsSync } from "node:fs";
import { c, ok, warn, die, loadContext, fromEnv, banner, mcpCall, EXPECTED_MCP_TOOLS } from "./context.mjs";

const ctx = loadContext();
const base = (ctx.deployedUrl ?? (ctx.host ? `https://${ctx.host}` : "")).replace(/\/$/, "");
if (!base) die("No deployed URL in .pagevault.json.", "Run `make deploy` first.");

console.log(banner("verify", base));

async function get(path, init) {
  try {
    const res = await fetch(`${base}${path}`, { redirect: "manual", ...init });
    return { status: res.status, res };
  } catch (err) {
    return { status: 0, error: String(err) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. The Worker is reachable and it is OURS — an unknown path returns our 404 JSON envelope,
//    a fingerprint Cloudflare's own 404 page (which has no JSON body) never produces. A
//    brand-new workers.dev route can take up to a minute to go live after the first deploy,
//    so POLL for it rather than failing on a transient Cloudflare 404 — that's propagation,
//    not a broken deploy.
const isOurs = async () => {
  const { status, res } = await get("/does-not-exist-" + "x".repeat(8));
  if (status !== 404) return false;
  const body = await res.json().catch(() => ({}));
  return body?.code === "not_found";
};

let live = await isOurs();
if (!live) {
  process.stdout.write(`  ${c.dim("Waiting for the route to go live")}`);
  for (let i = 0; i < 12 && !live; i++) {
    await sleep(5000);
    process.stdout.write(c.dim("."));
    live = await isOurs();
  }
  process.stdout.write("\n");
}

if (!live) {
  console.log(`\n  ${c.red("✗")} The route isn't serving our Worker yet.`);
  console.log(`\n  ${c.dim("workers.dev routes can take a minute or two to go live on a brand-new subdomain —")}`);
  console.log(`  ${c.dim("this is propagation, not a broken deploy. Give it a moment, then re-run")} ${c.bold("make verify")}.\n`);
  process.exit(1);
}
console.log(`  ${c.green("✓")} Worker is live and serving PageVault`);

// 2. Root behaves for the rung. At rung 3 (Access) it redirects to the console; below that
//    there is no console to reach, so it serves the quiet landing (200, not a Forbidden).
{
  const { status, res } = await get("/");
  const loc = res?.headers.get("location") ?? "";
  const rung = ctx.rung ?? 1;
  if (rung >= 3) {
    status === 302 && loc.endsWith("/admin")
      ? console.log(`  ${c.green("✓")} Root redirects to /admin`)
      : console.log(`  ${c.yellow("!")} Root returned ${status}${loc ? ` → ${loc}` : ""} (expected 302 → /admin at rung 3)`);
  } else {
    status === 200
      ? console.log(`  ${c.green("✓")} Root serves the landing page`)
      : console.log(`  ${c.yellow("!")} Root returned ${status} (expected 200 landing at rung ${rung})`);
  }
}

console.log();
ok("Deployment verified.");

// Report the deployed build (ADR-010) — confirms the version bake landed, and is the field CI
// reads to compare deployed-vs-upstream.
{
  const { res } = await get("/health");
  const body = await res?.json().catch(() => null);
  if (body?.version && body.version !== "unknown") console.log(`  ${c.dim("Running")} ${c.bold(body.version)}`);
}

// The bearer gates both the MCP smoke and the sample publish. No token → skip both.
const bearer = fromEnv("PAGEVAULT_API_TOKEN");
if (!bearer) {
  console.log(`\n  ${c.yellow("!")} No ${c.bold("PAGEVAULT_API_TOKEN")} in .env.local — skipping the MCP + publish checks.`);
  console.log(`  ${c.dim("Re-run `make deploy` (it saves the token), or add it by hand, then `make verify` again.")}\n`);
  process.exit(0);
}

// --- 3. The MCP surface actually answers (#75) ------------------------------
//
// The reason the project exists (ADR-006). verify used to only PRINT "connect Claude to
// /mcp" and never check it — so a dead or half-registered /mcp (e.g. the OAuth wrap that
// 404'd /health on the spike) would sail through. Drive the protocol for real.

console.log(`\n  ${c.bold("MCP")} ${c.dim("— /mcp, the remote server Claude connects to")}`);

{
  const r = await mcpCall(base, bearer, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pagevault-verify", version: "1" },
  });
  if (!r.ok || r.result?.serverInfo?.name !== "pagevault") {
    warn(`MCP initialize failed (HTTP ${r.status})${r.error ? ` — ${r.error.message ?? JSON.stringify(r.error)}` : ""}`);
    process.exit(1);
  }
  console.log(`  ${c.green("✓")} initialize — server is ${c.bold("pagevault")} ${c.dim(`v${r.result.serverInfo.version ?? "?"}`)}`);
}

{
  const r = await mcpCall(base, bearer, "tools/list");
  const names = (r.result?.tools ?? []).map((t) => t.name);
  const missing = EXPECTED_MCP_TOOLS.filter((t) => !names.includes(t));
  if (!r.ok || missing.length) {
    warn(`tools/list is wrong (HTTP ${r.status}) — ${missing.length ? `missing: ${missing.join(", ")}` : "request failed"}`);
    process.exit(1);
  }
  console.log(`  ${c.green("✓")} tools/list — all ${names.length} tools present`);
}

{
  // A publish → read → revoke round-trip through the MCP *tools* — the write path, not
  // just /api. An ownerOnly draft (invisible to clients) that we revoke, so a passing run
  // leaves nothing behind. confirm:true so a leftover from a failed prior run updates in
  // place rather than erroring.
  const title = "__pagevault_verify_smoke__";
  const pub = await mcpCall(base, bearer, "tools/call", {
    name: "publish_document",
    arguments: {
      title,
      html: "<!doctype html><meta charset=utf-8><title>verify smoke</title><h1>verify smoke</h1><p>Transient — safe to delete.</p>",
      ownerOnly: true,
      confirm: true,
    },
  });
  const id = (pub.result?.content?.[0]?.text?.match(/URL:\s*(\S+)/)?.[1] ?? "").split("/").pop();
  if (!pub.ok || pub.result?.isError || !id) {
    warn(`publish_document (MCP) failed (HTTP ${pub.status})${pub.result?.isError ? " — the tool returned an error" : ""}`);
    process.exit(1);
  }

  const read = await mcpCall(base, bearer, "tools/call", { name: "read_document", arguments: { id } }, 2);
  const readOk = read.ok && !read.result?.isError && (read.result?.content?.[0]?.text ?? "").includes("verify smoke");

  // Clean up regardless of the read result, so a failed read still doesn't leave litter.
  const rev = await mcpCall(base, bearer, "tools/call", { name: "revoke_document", arguments: { id } }, 3);
  const revOk = rev.ok && !rev.result?.isError;

  if (!readOk || !revOk) {
    warn(
      `MCP round-trip incomplete (read=${readOk ? "ok" : "FAIL"}, revoke=${revOk ? "ok" : "FAIL"})` +
        (revOk ? "." : ` — an ownerOnly draft "${title}" may remain in the default portal (invisible to clients).`),
    );
    process.exit(1);
  }
  console.log(`  ${c.green("✓")} publish → read → revoke — the MCP write path works, nothing left behind`);
}

{
  // OAuth discovery exists only once #22 is deployed. A bearer-only (Tier-0/pre-#22)
  // deploy legitimately has none — report the mode, don't fail.
  const { status } = await get("/.well-known/oauth-authorization-server");
  status === 200
    ? console.log(`  ${c.green("✓")} OAuth discovery live ${c.dim("— claude.ai web/Desktop/mobile can connect")}`)
    : console.log(`  ${c.dim("○ OAuth not deployed — bearer-only (Claude Code). Expected pre-#22.")}`);
}

// --- 4. Publish the first document, so there is something to open ----------

const welcomePath = "examples/welcome.html";
if (!existsSync(welcomePath)) {
  console.log(`\n  ${c.yellow("!")} ${welcomePath} not found — skipping the sample publish.\n`);
  process.exit(0);
}

console.log(`\n  Publishing your first document ${c.dim("(examples/welcome.html)…")}`);
const html = readFileSync(welcomePath, "utf8");

let result;
try {
  const res = await fetch(`${base}/api/docs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Welcome to PageVault",
      summary: "It works — this is your first published document.",
      html,
      // public:true mints a capability link that bypasses Access entirely (zero seats).
      // confirm:true so re-running verify updates it in place instead of a 409.
      public: true,
      confirm: true,
    }),
  });
  result = { status: res.status, body: await res.json().catch(() => ({})) };
} catch (err) {
  result = { status: 0, body: { message: String(err) } };
}

if (result.status === 401 || result.status === 403) {
  warn(`Publish was rejected (HTTP ${result.status}) — the bearer token doesn't match the Worker's.`);
  console.log(`  ${c.dim("If you re-deployed into an existing Worker, re-run `make deploy` to reset the secret.")}\n`);
  process.exit(1);
}
if (result.status !== 200 && result.status !== 201) {
  warn(`Publish failed (HTTP ${result.status}): ${result.body?.message ?? JSON.stringify(result.body)}`);
  process.exit(1);
}

const publicUrl = result.body.publicUrl ?? "";
console.log(`  ${c.green("✓")} Published.\n`);
console.log(`  ${c.bold("Open this — it's live, no login required:")}`);
console.log(`\n     ${c.blue(publicUrl || base)}\n`);
console.log(`  ${c.dim("That page explains what just happened and proves the sandbox. Delete it whenever;")}`);
console.log(`  ${c.dim("it was only a hello. Next: connect Claude to")} ${c.bold(base + "/mcp")} ${c.dim("with your bearer token.")}\n`);

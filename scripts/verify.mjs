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
import { c, ok, warn, die, loadContext, fromEnv, banner } from "./context.mjs";

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

// --- 3. Publish the first document, so there is something to open ----------

const bearer = fromEnv("PAGEVAULT_API_TOKEN");
if (!bearer) {
  console.log(`\n  ${c.yellow("!")} No ${c.bold("PAGEVAULT_API_TOKEN")} in .env.local — skipping the sample publish.`);
  console.log(`  ${c.dim("Re-run `make deploy` (it saves the token), or add it by hand, then `make verify` again.")}\n`);
  process.exit(0);
}

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

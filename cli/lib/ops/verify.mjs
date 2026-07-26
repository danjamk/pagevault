//
// `pagevault verify` (and `make verify`) — after a deploy: does it actually work? A smoke test
// that ends with something you can open. It confirms the Worker is ours and routing, drives the
// /mcp protocol for real (#75), then PUBLISHES a real document (examples/welcome.html when present)
// over the bearer API and prints its public /p/ link.
//
// Why publish, not just ping: at rung 1 there is no Cloudflare Access, so the /admin console is
// (correctly) Forbidden — a fail-closed door with nothing behind it yet. A public capability link
// is the one door that works with zero Access and burns zero seats, so it is the honest "it works,
// go look" for a first deploy. Re-running is safe: it publishes with confirm:true and updates the
// same document in place.
//
// One engine, two front doors (ADR-014): `make verify` runs this through `pagevault verify`.
// `--json` collects the checks and emits a verdict object (drivable, #33) with the same exit codes;
// in that mode the narration is suppressed so stdout carries only the JSON.
//
import { readFileSync, existsSync } from "node:fs";
import { Resolver, lookup } from "node:dns/promises";
import { platform } from "node:process";
import { c, ok, warn, die, loadContext, fromEnv, banner, mcpCall, runHint, EXPECTED_MCP_TOOLS } from "../provision/context.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How to drop a cached NXDOMAIN, per platform. */
const DNS_FLUSH = {
  darwin: "sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder",
  linux: "sudo resolvectl flush-caches",
  win32: "ipconfig /flushdns",
};

/**
 * Why isn't this hostname answering? Distinguishes two failures that look identical from here and
 * have completely different fixes.
 *
 * `lookup()` goes through the SYSTEM resolver — the same path fetch, curl and every browser use,
 * and the one that caches a negative answer. The `Resolver` queries a public nameserver directly,
 * which is what `dig` does. When the second succeeds and the first fails, the record exists and the
 * machine is remembering that it didn't: a stale NXDOMAIN, which no amount of waiting on Cloudflare
 * will clear.
 *
 * That is not hypothetical — it is what a destroy → rebuild on the same hostname produces, which is
 * exactly the path this command is most used on. See #123.
 *
 * Returns "ok" | "local_cache" | "nowhere" | "unknown".
 */
export async function diagnoseDns(hostname) {
  const publicly = await (async () => {
    try {
      const r = new Resolver({ timeout: 3000, tries: 2 });
      r.setServers(["1.1.1.1", "8.8.8.8"]);
      const [v4, v6] = await Promise.allSettled([r.resolve4(hostname), r.resolve6(hostname)]);
      return v4.status === "fulfilled" || v6.status === "fulfilled";
    } catch {
      return false;
    }
  })();

  const locally = await (async () => {
    try {
      await lookup(hostname);
      return true;
    } catch {
      return false;
    }
  })();

  if (locally && publicly) return "ok";
  if (publicly && !locally) return "local_cache";
  if (!publicly && !locally) return "nowhere";
  return "unknown";
}

/** @param {{ json?: boolean }} [opts] */
export async function verifyCmd({ json = false } = {}) {
  const checks = [];
  const record = (name, passed, detail) => checks.push({ name, ok: passed, ...(detail ? { detail } : {}) });

  // All human narration flows through these; in --json mode they go silent so stdout is pure JSON.
  const say = (s = "") => {
    if (!json) console.log(s);
  };
  const tick = (s) => {
    if (!json) process.stdout.write(s);
  };
  const sok = (s) => {
    if (!json) ok(s);
  };
  const swarn = (s) => {
    if (!json) warn(s);
  };

  // Every exit — pass or fail — funnels here, so the JSON verdict and the exit code stay in lockstep
  // with the human path.
  const finish = (passed, extra = {}) => {
    if (json) process.stdout.write(`${JSON.stringify({ ok: passed, ...extra, checks }, null, 2)}\n`);
    process.exit(passed ? 0 : 1);
  };

  const ctx = loadContext();
  const base = (ctx.deployedUrl ?? (ctx.host ? `https://${ctx.host}` : "")).replace(/\/$/, "");
  if (!base) {
    record("deployed", false);
    if (json) return finish(false, { reason: "not_deployed" });
    die("No deployed URL in .pagevault.json.", "Run `pagevault init` first (or `make deploy` from the repo).");
  }

  say(banner("verify", base));

  const get = async (path, init) => {
    try {
      const res = await fetch(`${base}${path}`, { redirect: "manual", ...init });
      return { status: res.status, res };
    } catch (err) {
      return { status: 0, error: String(err) };
    }
  };

  // 1. The Worker is reachable and it is OURS — an unknown path returns our 404 JSON envelope, a
  //    fingerprint Cloudflare's own 404 page (no JSON body) never produces. A brand-new workers.dev
  //    route can take up to a minute to go live, so POLL rather than fail on a transient 404.
  const isOurs = async () => {
    const { status, res } = await get("/does-not-exist-" + "x".repeat(8));
    if (status !== 404) return false;
    const body = await res.json().catch(() => ({}));
    return body?.code === "not_found";
  };

  let live = await isOurs();
  if (!live) {
    tick(`  ${c.dim("Waiting for the route to go live")}`);
    for (let i = 0; i < 12 && !live; i++) {
      await sleep(5000);
      tick(c.dim("."));
      live = await isOurs();
    }
    tick("\n");
  }

  if (!live) {
    record("worker_live", false);
    say(`\n  ${c.red("✗")} The route isn't serving our Worker yet.`);

    // Before blaming provisioning, check whether this machine can even resolve the name. A stale
    // NXDOMAIN presents exactly like a route that hasn't come up, and the advice below — wait, then
    // go look at the dashboard — is the wrong advice for it (#123).
    const dns = await diagnoseDns(new URL(base).hostname);
    if (dns === "local_cache") {
      record("dns", false, "local_cache");
      say(`\n  ${c.yellow("!")} ${c.bold("This is a local DNS cache, not a deploy problem.")}`);
      say(`  ${c.dim("The hostname resolves at a public resolver but not on this machine — so something")}`);
      say(`  ${c.dim("here is still remembering that it didn't exist. Common right after a teardown and")}`);
      say(`  ${c.dim("rebuild on the same hostname. Waiting will not fix it; flushing will:")}`);
      say(`\n     ${c.bold(DNS_FLUSH[platform] ?? DNS_FLUSH.linux)}\n`);
      say(`  ${c.dim("Then re-run")} ${c.bold("pagevault verify")}${c.dim(".")}\n`);
      return finish(false, { reason: "dns_local_cache" });
    }
    record("dns", dns === "ok", dns);

    // Nothing was ever deployed here, or it was torn down. `deployedUrl` is written by a successful
    // deploy and stripped by destroy (#118), so its absence plus a hostname that resolves nowhere is
    // conclusive — and telling someone to wait for a certificate on a Worker that does not exist is
    // the same wrong-cause failure as the DNS one above. We only got here via the `ctx.host`
    // fallback, since an empty base is caught earlier.
    if (dns === "nowhere" && !ctx.deployedUrl) {
      say(`\n  ${c.yellow("!")} ${c.bold("Nothing is deployed at this hostname.")}`);
      say(`  ${c.dim(`${base} resolves nowhere, and this checkout has no record of a deploy —`)}`);
      say(`  ${c.dim("so this is a deployment that has not been built yet, or one that was torn down.")}`);
      say(`\n     ${c.bold(runHint("deploy", "init"))}\n`);
      return finish(false, { reason: "not_deployed" });
    }

    if ((ctx.rung ?? 1) >= 2) {
      // Rung 2/3 is a CUSTOM domain: the delay is edge-certificate provisioning, not workers.dev
      // propagation. Different cause, different wait — say so, or it reads as a broken deploy.
      say(`\n  ${c.dim("A custom domain provisions its own TLS certificate, which can take a few minutes on a")}`);
      say(`  ${c.dim("brand-new hostname — this is provisioning, not a broken deploy. Give it a moment, then")}`);
      say(`  ${c.dim("re-run")} ${c.bold("pagevault verify")}${c.dim(". If it is still failing after ~15 minutes, check the domain in the Cloudflare dashboard.")}\n`);
    } else {
      say(`\n  ${c.dim("workers.dev routes can take a minute or two to go live on a brand-new subdomain —")}`);
      say(`  ${c.dim("this is propagation, not a broken deploy. Give it a moment, then re-run")} ${c.bold("pagevault verify")}.\n`);
    }
    return finish(false, { reason: "route_not_live" });
  }
  record("worker_live", true);
  say(`  ${c.green("✓")} Worker is live and serving PageVault`);

  // 2. Root behaves for the rung. At rung 3 (Access) it redirects to the console; below that there
  //    is no console to reach, so it serves the quiet landing (200, not a Forbidden).
  {
    const { status, res } = await get("/");
    const loc = res?.headers.get("location") ?? "";
    const rung = ctx.rung ?? 1;
    if (rung >= 3) {
      const rootOk = status === 302 && loc.endsWith("/admin");
      record("root", rootOk, `${status}${loc ? ` → ${loc}` : ""}`);
      rootOk ? say(`  ${c.green("✓")} Root redirects to /admin`) : say(`  ${c.yellow("!")} Root returned ${status}${loc ? ` → ${loc}` : ""} (expected 302 → /admin when Secured)`);
    } else {
      record("root", status === 200, String(status));
      status === 200
        ? say(`  ${c.green("✓")} Root serves the landing page`)
        : say(`  ${c.yellow("!")} Root returned ${status} (expected 200 landing on a Public deployment)`);
    }
  }

  say();
  sok("Deployment verified.");

  // Report the deployed build (ADR-010) — confirms the version bake landed.
  {
    const { res } = await get("/health");
    const body = await res?.json().catch(() => null);
    if (body?.version && body.version !== "unknown") {
      record("build", true, body.version);
      say(`  ${c.dim("Running")} ${c.bold(body.version)}`);
    }
  }

  // The bearer gates both the MCP smoke and the sample publish. No token → skip both (still a pass).
  const bearer = fromEnv("PAGEVAULT_API_TOKEN");
  if (!bearer) {
    record("mcp", false, "skipped — no bearer");
    say(`\n  ${c.yellow("!")} No ${c.bold("PAGEVAULT_API_TOKEN")} in .env.local — skipping the MCP + publish checks.`);
    say(`  ${c.dim("Re-run `pagevault init` (it saves the token), or add it by hand, then verify again.")}\n`);
    return finish(true, { skipped: "auth_checks" });
  }

  // --- 3. The MCP surface actually answers (#75) — the reason the project exists (ADR-006) -----
  say(`\n  ${c.bold("MCP")} ${c.dim("— /mcp, the remote server Claude connects to")}`);

  {
    const r = await mcpCall(base, bearer, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pagevault-verify", version: "1" },
    });
    if (!r.ok || r.result?.serverInfo?.name !== "pagevault") {
      record("mcp_initialize", false, `HTTP ${r.status}`);
      swarn(`MCP initialize failed (HTTP ${r.status})${r.error ? ` — ${r.error.message ?? JSON.stringify(r.error)}` : ""}`);
      return finish(false, { reason: "mcp_initialize" });
    }
    record("mcp_initialize", true);
    say(`  ${c.green("✓")} initialize — server is ${c.bold("pagevault")} ${c.dim(`v${r.result.serverInfo.version ?? "?"}`)}`);
  }

  {
    const r = await mcpCall(base, bearer, "tools/list");
    const names = (r.result?.tools ?? []).map((t) => t.name);
    const missing = EXPECTED_MCP_TOOLS.filter((t) => !names.includes(t));
    if (!r.ok || missing.length) {
      record("mcp_tools", false, missing.length ? `missing: ${missing.join(", ")}` : `HTTP ${r.status}`);
      swarn(`tools/list is wrong (HTTP ${r.status}) — ${missing.length ? `missing: ${missing.join(", ")}` : "request failed"}`);
      return finish(false, { reason: "mcp_tools", missing });
    }
    record("mcp_tools", true, `${names.length} tools`);
    say(`  ${c.green("✓")} tools/list — all ${names.length} tools present`);
  }

  {
    // A publish → read → revoke round-trip through the MCP *tools* — the write path, not just /api.
    // An ownerOnly draft (invisible to clients) that we revoke, so a passing run leaves nothing
    // behind. confirm:true so a leftover from a failed prior run updates in place rather than erroring.
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
      record("mcp_roundtrip", false, "publish failed");
      swarn(`publish_document (MCP) failed (HTTP ${pub.status})${pub.result?.isError ? " — the tool returned an error" : ""}`);
      return finish(false, { reason: "mcp_publish" });
    }

    const read = await mcpCall(base, bearer, "tools/call", { name: "read_document", arguments: { id } }, 2);
    const readOk = read.ok && !read.result?.isError && (read.result?.content?.[0]?.text ?? "").includes("verify smoke");

    // Clean up regardless of the read result, so a failed read still doesn't leave litter.
    const rev = await mcpCall(base, bearer, "tools/call", { name: "revoke_document", arguments: { id } }, 3);
    const revOk = rev.ok && !rev.result?.isError;

    if (!readOk || !revOk) {
      record("mcp_roundtrip", false, `read=${readOk ? "ok" : "FAIL"} revoke=${revOk ? "ok" : "FAIL"}`);
      swarn(
        `MCP round-trip incomplete (read=${readOk ? "ok" : "FAIL"}, revoke=${revOk ? "ok" : "FAIL"})` +
          (revOk ? "." : ` — an ownerOnly draft "${title}" may remain in the default portal (invisible to clients).`),
      );
      return finish(false, { reason: "mcp_roundtrip" });
    }
    record("mcp_roundtrip", true);
    say(`  ${c.green("✓")} publish → read → revoke — the MCP write path works, nothing left behind`);
  }

  {
    // OAuth discovery exists only once #22 is deployed. A bearer-only (Tier-0/pre-#22) deploy
    // legitimately has none — report the mode, don't fail.
    const { status } = await get("/.well-known/oauth-authorization-server");
    record("oauth_discovery", status === 200, status === 200 ? "live" : "bearer-only");
    status === 200
      ? say(`  ${c.green("✓")} OAuth discovery live ${c.dim("— claude.ai web/Desktop/mobile can connect")}`)
      : say(`  ${c.dim("○ OAuth not deployed — bearer-only (Claude Code). Expected pre-#22.")}`);
  }

  // --- 4. Publish the first document, so there is something to open ---------------------------
  // examples/welcome.html ships with the repo, not the npm package — an installed `verify` simply
  // skips this step (the MCP round-trip above is the real proof); it isn't a failure.
  const welcomePath = "examples/welcome.html";
  if (!existsSync(welcomePath)) {
    say(`\n  ${c.dim("○ No examples/welcome.html here — skipping the sample publish (installed verify).")}\n`);
    return finish(true, { published: false });
  }

  say(`\n  Publishing your first document ${c.dim("(examples/welcome.html)…")}`);
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
    record("publish", false, `HTTP ${result.status}`);
    swarn(`Publish was rejected (HTTP ${result.status}) — the bearer token doesn't match the Worker's.`);
    say(`  ${c.dim("If you re-deployed into an existing Worker, re-run the deploy to reset the secret.")}\n`);
    return finish(false, { reason: "publish_auth" });
  }
  if (result.status !== 200 && result.status !== 201) {
    record("publish", false, `HTTP ${result.status}`);
    swarn(`Publish failed (HTTP ${result.status}): ${result.body?.message ?? JSON.stringify(result.body)}`);
    return finish(false, { reason: "publish_failed" });
  }

  const publicUrl = result.body.publicUrl ?? "";
  record("publish", true);
  say(`  ${c.green("✓")} Published.\n`);
  say(`  ${c.bold("Open this — it's live, no login required:")}`);
  say(`\n     ${c.blue(publicUrl || base)}\n`);
  say(`  ${c.dim("That page explains what just happened and proves the sandbox. Delete it whenever;")}`);
  say(`  ${c.dim("it was only a hello. Next: connect Claude to")} ${c.bold(base + "/mcp")} ${c.dim("with your bearer token.")}\n`);
  return finish(true, { published: true, publicUrl: publicUrl || null });
}

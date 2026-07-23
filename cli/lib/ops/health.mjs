//
// `pagevault health` (and `make health`, and prod CI) — ask the live deployment what code it's
// running (/health, ADR-010) and assert it matches the build this clone/install ships
// (releaseTag()). This is the loop #48 closed: baking <version>+<sha> into the Worker is what
// lets CI (and you) answer "is it actually up to date?" rather than trusting a deploy landed.
//
// Exits non-zero on a mismatch or an unreachable /health, so a CI prod deploy (#38) fails loudly
// instead of going green on a rollout that silently didn't take. `--json` emits the verdict as an
// object (drivable, #33) while keeping the same exit codes.
//
import { c, ok, warn, die, loadContext, releaseTag, banner, fromEnv, mcpCall } from "../provision/context.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

/** @param {{ json?: boolean }} [opts] */
export async function healthCmd({ json = false } = {}) {
  const ctx = loadContext();
  const base = (ctx.deployedUrl ?? (ctx.host ? `https://${ctx.host}` : "")).replace(/\/$/, "");
  if (!base) {
    if (json) {
      emit({ ok: false, reason: "not_deployed" });
      process.exit(1);
    }
    die("No deployed URL in .pagevault.json.", "Deploy first — the deploy step records where it landed.");
  }

  const expected = releaseTag();
  if (!json) console.log(banner("health-check", `${base} · expecting ${c.bold(expected)}`));

  const matches = (h) => h.ok && h.version === expected;
  async function probe() {
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
  // same shape as verify: a transient miss is propagation, not a bad deploy.
  let last = await probe();
  if (!matches(last)) {
    if (!json) process.stdout.write(`  ${c.dim("Waiting for /health to report the new build")}`);
    for (let i = 0; i < 11 && !matches(last); i++) {
      await sleep(5000);
      if (!json) process.stdout.write(c.dim("."));
      last = await probe();
    }
    if (!json) process.stdout.write("\n");
  }

  if (matches(last)) {
    // The build string matches. But a version-correct deploy with a dead /mcp is still a broken
    // deploy (#75) — assert the MCP surface answers when we have a bearer; skip (don't fail) when
    // we don't, e.g. a CI context without the token.
    const bearer = fromEnv("PAGEVAULT_API_TOKEN");
    let mcp = "skipped";
    if (bearer) {
      const r = await mcpCall(base, bearer, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "pagevault-health", version: "1" },
      });
      if (!r.ok || r.result?.serverInfo?.name !== "pagevault") {
        if (json) {
          emit({ ok: false, reason: "mcp_down", version: last.version, expected, status: r.status });
          process.exit(1);
        }
        die(
          `/health matches ${c.bold(last.version)}, but /mcp did not answer (HTTP ${r.status}).`,
          "The build is up but the MCP surface is down — do not call this deploy healthy.",
        );
      }
      mcp = "up";
    }
    if (json) {
      emit({ ok: true, version: last.version, expected, mcp });
      return;
    }
    ok(`/health reports ${c.bold(last.version)} — matches the shipped build.`);
    mcp === "up" ? ok("/mcp answers — the MCP surface is up.") : warn("No PAGEVAULT_API_TOKEN — skipped the /mcp reachability check.");
    process.exit(0);
  }

  if (json) {
    emit({
      ok: false,
      reason: last.ok ? "version_mismatch" : "unreachable",
      version: last.version ?? null,
      expected,
      status: last.status ?? null,
    });
    process.exit(1);
  }
  if (!last.ok) {
    die(`/health didn't answer 200 (${last.status ?? last.error}).`, "The deploy may not have landed — check the deploy step's output.");
  }
  die(
    `/health reports ${c.bold(last.version ?? "unknown")}, but this checkout is ${c.bold(expected)}.`,
    "The deployment isn't running this commit's code. Re-run the deploy, or investigate a stuck rollout.",
  );
}

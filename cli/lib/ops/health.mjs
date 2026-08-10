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
import { c, ok, warn, die, releaseTag, banner, fromEnv, mcpCall, runHint } from "../provision/context.mjs";
import { resolveTarget, describeTarget, resolveBearer } from "../target.mjs";
import { loadConfig } from "../client.mjs";
import { loadRegistry } from "../registry.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

/** @param {{ json?: boolean, flags?: object }} [opts] */
export async function healthCmd({ json = false, flags = {} } = {}) {
  const target = resolveTarget({ flags, config: loadConfig(), registry: loadRegistry() });
  const base = target.url;
  if (!base) {
    if (json) {
      emit({ ok: false, reason: "not_configured" });
      process.exit(1);
    }
    die("No deployment to check.", [
      "Nothing named one — no --url, no PAGEVAULT_URL, no project marker, no login config.",
      `  ${c.bold(runHint("deploy", "init"))}  to stand one up`,
      `  ${c.bold("pagevault login --url … --token …")}  to point at one you already have`,
    ]);
  }

  // Asserting the deployed build matches THIS install only means something when this install is
  // what deploys it. On a client-only install — a login for a deployment CI deploys (#144) — a
  // difference is expected rather than a fault: this laptop can hold 0.28.0 while CI shipped
  // 0.29.0, and failing on that would make `health` unusable on the deployment it matters most for.
  const pinned = target.provisioned;
  const expected = releaseTag();
  if (!json) {
    console.log(banner("health-check", pinned ? `expecting ${c.bold(expected)}` : "reporting what it runs"));
    console.log(`  ${c.dim("→")} ${describeTarget(target)}\n`);
  }

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
  // same shape as verify: a transient miss is propagation, not a bad deploy. Only when we are
  // asserting a match: with no version to wait for, polling would be a minute spent on nothing.
  let last = await probe();
  if (pinned && !matches(last)) {
    if (!json) process.stdout.write(`  ${c.dim("Waiting for /health to report the new build")}`);
    for (let i = 0; i < 11 && !matches(last); i++) {
      await sleep(5000);
      if (!json) process.stdout.write(c.dim("."));
      last = await probe();
    }
    if (!json) process.stdout.write("\n");
  }

  if (pinned ? matches(last) : last.ok) {
    // The build string matches. But a version-correct deploy with a dead /mcp is still a broken
    // deploy (#75) — assert the MCP surface answers when we have a bearer; skip (don't fail) when
    // we don't, e.g. a CI context without the token.
    // It used to read only `.env.local` and then report "No PAGEVAULT_API_TOKEN" while a usable
    // bearer sat in the login config — the one `verify` picks up seconds later on the same
    // deployment (#155). Same resolution as verify, same pairing rule.
    const bearer = resolveBearer(target, {
      env: process.env.PAGEVAULT_API_TOKEN,
      state: fromEnv("PAGEVAULT_API_TOKEN"),
      config: loadConfig({}).token,
    });
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

    // Sync risk rides along with the bearer we already resolved (ADR-023 §9, #165). It lives here
    // rather than in `status` because `status` is deliberately offline — it prints saved answers
    // and says so — and it is not on `/health`, which is unauthenticated: when you last synced is
    // a fact about how the operator works, and it does not belong on a public endpoint.
    const risk = bearer ? await fetchSyncRisk(base, bearer) : null;

    if (json) {
      emit({ ok: true, version: last.version, expected, mcp, pinned, source: target.source, views: risk });
      return;
    }
    ok(
      pinned
        ? `/health reports ${c.bold(last.version)} — matches the shipped build.`
        : `/health reports ${c.bold(last.version)}. This install did not deploy it, so there is no build to match it against.`,
    );
    mcp === "up" ? ok("/mcp answers — the MCP surface is up.") : warn("No PAGEVAULT_API_TOKEN — skipped the /mcp reachability check.");
    reportSyncRisk(risk);
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

/**
 * Ask the deployment how much view history is waiting to be captured.
 *
 * The Worker computes it — the CLI, the console panel and the MCP tool all need the same answer,
 * and three implementations of one horizon calculation is three chances to disagree about when
 * someone's history is about to disappear.
 *
 * Never fatal. `health` exists to answer "is this deployment up", and a deployment that is up with
 * an unreadable summary is still up.
 */
async function fetchSyncRisk(base, bearer) {
  try {
    const res = await fetch(`${base}/api/docs`, { headers: { Authorization: `Bearer ${bearer}` } });
    if (!res.ok) return null;
    return (await res.json())?.viewsRisk ?? null;
  } catch {
    return null;
  }
}

/**
 * 🔴 Alarm on RISK, not on age.
 *
 * "Synced 40 days ago" is a fact about the past that leaves the reader to do the arithmetic.
 * "12 days of history become unrecoverable in 3 weeks" is a fact about the future, and it is the
 * one that tells them whether to act today. Only the second is worth interrupting anyone for.
 */
function reportSyncRisk(risk) {
  if (!risk) return;
  // `make sync-views` now exists and reaches the same engine (#166), but this stays the CLI form on
  // purpose: `health` runs from installed deployments with no Makefile at all, and naming a target
  // that is not there is worse than naming the longer command that always is.
  const fix = "pagevault sync-views";
  const days = (n) => `${n} day${n === 1 ? "" : "s"}`;

  // 🔴 Outranks every other state (#185). A deployment with no Analytics Engine binding records
  // nothing, so there is no history at risk — and reporting that as "ok" is how a production
  // deployment showed twenty documents at zero views with a green alarm for months.
  if (risk.state === "off") {
    warn("View tracking is OFF on this deployment — nothing is being recorded.");
    console.log(`  ${c.dim("Documents report no view counts because none exist, not because nobody opened them.")}`);
    console.log(`  ${c.dim("Enable Analytics Engine on the account, then redeploy with")} ${c.bold("ANALYTICS=on")}${c.dim(".")}`);
    if (risk.capturedThrough) {
      console.log(`  ${c.dim(`Existing history through ${risk.capturedThrough} is intact — it simply stops accruing.`)}`);
    }
    return;
  }

  if (risk.state === "never") {
    // Not "0 days at risk" — that reads as "up to date", which is the opposite of true.
    warn("No view history captured yet.");
    console.log(`  ${c.dim(`Views reach Analytics Engine on their own, but only`)} ${c.bold(fix)} ${c.dim("makes them durable.")}`);
    return;
  }
  if (risk.state === "ok") {
    if (risk.uncapturedDays === 0) return ok("View history is captured through today.");
    return ok(`View history captured through ${risk.capturedThrough} — ${days(risk.daysUntilLoss)} of runway.`);
  }

  if (risk.state === "losing") {
    // Loud, but NOT fatal. Prod CI gates deploys on this command's exit code, and a deployment that
    // is up with an unsynced summary is still up — failing the deploy would punish the wrong thing
    // and train someone to stop reading the output.
    const lostVerb = risk.lostDays === 1 ? "has" : "have";
    warn(`${days(risk.lostDays)} of view history ${lostVerb} already been lost, and more goes every day.`);
    console.log(`  ${c.dim(`Captured through ${risk.capturedThrough}. Analytics Engine keeps about 90 days, and nothing`)}`);
    console.log(`  ${c.dim("but a sync takes it off that belt — what aged out uncovered does not come back.")}`);
    console.log(`  ${c.dim("Run")} ${c.bold(fix)} ${c.dim("to capture everything still there.")}`);
    return;
  }

  // "71 days ... become", "1 day ... becomes" — the verb agrees with the count, not with "history".
  const verb = risk.uncapturedDays === 1 ? "becomes" : "become";
  warn(`${days(risk.uncapturedDays)} of view history ${verb} unrecoverable in ${days(risk.daysUntilLoss)}.`);
  console.log(`  ${c.dim(`Captured through ${risk.capturedThrough}. Fix it with`)} ${c.bold(fix)}${c.dim(".")}`);
}

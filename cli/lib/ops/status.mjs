//
// `pagevault status` (and `make status`) — what this clone/install is configured for, at a
// glance. Local only, no Cloudflare calls. Shows both versions: the PageVault product version
// (what code you're running) and the .pagevault.json schema version (internal state format).
//
// One engine, two front doors (ADR-014): the CLI imports statusCmd(); `make status` runs it
// through `pagevault status`. No duplicate logic, no shim.
//
// 🔴 It reports INTENT, not observed state (#130). `.pagevault.json` records the answers the
// operator gave; nothing here asks the Worker whether they are still true. During a fresh-machine
// run a deployment was accidentally redeployed with Access unconfigured, and `status` went on
// printing "Tier Secured · Deployed https://…" the whole time — every line true of the file, the
// middle one false of the running Worker. It is the same failure as #118, where a post-teardown
// `status` named a KV namespace and a URL that no longer existed.
//
// The fix is not to make `status` phone home — local, instant and offline is the point, and
// `health` already asks the deployment. The fix is that it must not SOUND like a report from the
// deployment. Hence the header, the footer, and `source: "local"` in the JSON: an agent consuming
// `--json` has no tone to read, so the marker has to be a field.
//
import { c, banner, loadContext, VERSION, SCHEMA_VERSION, RUNNING_FROM_REPO } from "../provision/context.mjs";
import { resolveTarget, targetOrigin } from "../target.mjs";
import { loadConfig } from "../client.mjs";

// The "not set up yet" nudge names the right door: `make setup` from the repo, `pagevault init`
// from an install. Same reasoning everywhere a hint points at the setup step.
const SETUP_CMD = RUNNING_FROM_REPO ? "make setup" : "pagevault init";
const CHECK_CMD = RUNNING_FROM_REPO ? "make health" : "pagevault health";

/**
 * @param {{ json?: boolean, out?: (s: string) => void }} [opts]
 *   json — emit a machine-readable object instead of the human table (drivable, #33).
 *   out  — where the --json line goes (stdout by default); the human table always uses console.log.
 */
export async function statusCmd({ json = false, flags = {}, out = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const ctx = loadContext();
  // What this install would ACT on, which is not the same question as what it provisioned (#144).
  const target = resolveTarget({ flags, config: loadConfig() });

  if (json) {
    out(
      JSON.stringify(
        {
          // "local" is a promise about provenance, not a mode: every field below was read from
          // ~/.pagevault/, and none of it was confirmed against the deployment. `pagevault health
          // --json` is the observed-state surface.
          source: "local",
          // Which deployment the operator commands would act on, and what named it. `configured`
          // below still means "provisioned from here"; these say whether there is anything to talk
          // to at all, which is the distinction a client-only install turns on (#144).
          deployment: target.url || null,
          deploymentSource: target.source,
          provisioned: target.provisioned,
          version: VERSION,
          schemaVersion: ctx.schemaVersion ?? SCHEMA_VERSION,
          configured: ctx.rung !== undefined,
          tier: ctx.rung === undefined ? null : ctx.rung >= 3 ? "secured" : "public",
          rung: ctx.rung ?? null,
          ownerEmail: ctx.ownerEmail ?? null,
          account: ctx.accountId ? { name: ctx.accountName ?? null, id: ctx.accountId } : null,
          host: ctx.host ?? null,
          kvId: ctx.kvId ?? null,
          deployedUrl: ctx.deployedUrl ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(banner("status", "local configuration — not the live deployment"));
  const row = (label, val) => console.log(`  ${c.cyan(label.padStart(13))}  ${val ?? c.dim("—")}`);

  row("PageVault", `v${VERSION}`);
  row("State schema", `v${ctx.schemaVersion ?? SCHEMA_VERSION}`);
  console.log();

  // `target.provisioned`, not `ctx.rung` (#155). They disagreed: from a checkout, `health` said
  // "expecting <build> — matches" while `status` said "not provisioned from this machine", because
  // status read `loadContext()` and health read the resolver. Now that `stateDir()` follows the
  // marker they agree at the source, but branching on the resolver's answer is what keeps them
  // agreeing — it is the one that knows which deployment was chosen.
  if (!target.provisioned) {
    // Two very different situations used to print the same "not configured — run init" line, and
    // for one of them that advice is actively dangerous (#144): an operator whose production is
    // deployed by CI has a login and no build record, and `init` would deploy from their laptop.
    // Having a login but nothing provisioned here is a SHAPE, not a failure.
    if (target.url) {
      row("Deployment", c.bold(target.url));
      row("Resolved by", c.dim(targetOrigin(target)));
      console.log();
      console.log(`  ${c.dim("Connected, but not provisioned from this machine — so there is no tier, account or")}`);
      console.log(`  ${c.dim("namespace to report here. That is normal when the deployment is deployed elsewhere,")}`);
      console.log(`  ${c.dim("for instance by CI. The document commands work; the provisioning ones do not.")}\n`);
      console.log(`  ${c.dim("Ask the deployment itself with")} ${c.bold(CHECK_CMD)}${c.dim(".")}\n`);
      return;
    }
    console.log(`  ${c.dim("Not configured yet — run")} ${c.bold(SETUP_CMD)}.\n`);
    return;
  }

  row("Tier", ctx.rung >= 3 ? "Secured" : ctx.host ? "Public · own domain" : "Public");
  row("Owner", ctx.ownerEmail);
  row("Account", ctx.accountName ? `${ctx.accountName} ${c.dim(`(${String(ctx.accountId ?? "").slice(0, 8)})`)}` : ctx.accountId);
  if (ctx.host) row("Host", ctx.host);
  if (ctx.kvId) row("KV", c.dim(ctx.kvId));
  if (ctx.deployedUrl) row("Deployed", c.bold(ctx.deployedUrl));
  console.log();

  // The footer, not a flag. `status --check` was considered and rejected: `health` already fetches
  // /health and compares it to the build you shipped, and a second front door onto the same
  // question is how the two start disagreeing. Naming it here costs one line and stays honest.
  console.log(`  ${c.dim("These are your saved answers. They can name a host, a namespace or a URL that")}`);
  console.log(`  ${c.dim("no longer exists — confirm against the deployment with")} ${c.bold(CHECK_CMD)}${c.dim(".")}\n`);
}

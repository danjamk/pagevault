//
// `pagevault status` (and `make status`) — what this clone/install is configured for, at a
// glance. Local only, no Cloudflare calls. Shows both versions: the PageVault product version
// (what code you're running) and the .pagevault.json schema version (internal state format).
//
// One engine, two front doors (ADR-014): the CLI imports statusCmd(); `make status` runs it
// through `pagevault status`. No duplicate logic, no shim.
//
import { c, banner, loadContext, VERSION, SCHEMA_VERSION, RUNNING_FROM_REPO } from "../provision/context.mjs";

// The "not set up yet" nudge names the right door: `make setup` from the repo, `pagevault init`
// from an install. Same reasoning everywhere a hint points at the setup step.
const SETUP_CMD = RUNNING_FROM_REPO ? "make setup" : "pagevault init";

/**
 * @param {{ json?: boolean, out?: (s: string) => void }} [opts]
 *   json — emit a machine-readable object instead of the human table (drivable, #33).
 *   out  — where the --json line goes (stdout by default); the human table always uses console.log.
 */
export async function statusCmd({ json = false, out = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const ctx = loadContext();

  if (json) {
    out(
      JSON.stringify(
        {
          version: VERSION,
          schemaVersion: ctx.schemaVersion ?? SCHEMA_VERSION,
          configured: ctx.rung !== undefined,
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

  console.log(banner("status"));
  const row = (label, val) => console.log(`  ${c.cyan(label.padStart(13))}  ${val ?? c.dim("—")}`);

  row("PageVault", `v${VERSION}`);
  row("State schema", `v${ctx.schemaVersion ?? SCHEMA_VERSION}`);
  console.log();

  if (ctx.rung === undefined) {
    console.log(`  ${c.dim("Not configured yet — run")} ${c.bold(SETUP_CMD)}.\n`);
    return;
  }

  row("Rung", String(ctx.rung));
  row("Owner", ctx.ownerEmail);
  row("Account", ctx.accountName ? `${ctx.accountName} ${c.dim(`(${String(ctx.accountId ?? "").slice(0, 8)})`)}` : ctx.accountId);
  if (ctx.host) row("Host", ctx.host);
  if (ctx.kvId) row("KV", c.dim(ctx.kvId));
  if (ctx.deployedUrl) row("Deployed", c.bold(ctx.deployedUrl));
  console.log();
}

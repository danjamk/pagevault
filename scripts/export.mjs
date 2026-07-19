#!/usr/bin/env node
//
// make export — after a deploy: walk away with everything. Produces a zipped, browsable folder
// of every portal and document (index.html + ACCESS.md + one folder per portal, each doc a
// standalone file). The "my stuff is real and I can leave with it" artifact (#35).
//
// This is the OPERATOR front door: it auto-targets the deployment this clone just deployed —
// the URL from .pagevault.json (deployedUrl), the bearer from .env.local (PAGEVAULT_API_TOKEN) —
// so `make deploy && make export` is the whole ceremony, no login and no flags. The `pagevault
// export` CLI is the other front door, for pointing at someone else's deployment; both share the
// one engine in cli/lib/export.mjs, so the walk + slugify + rendering live in exactly one place.
//
import { c, ok, info, die, loadContext, fromEnv, argValue, banner } from "./context.mjs";
import { buildExport } from "../cli/lib/export.mjs";

const ctx = loadContext();
const base = (ctx.deployedUrl ?? (ctx.host ? `https://${ctx.host}` : "")).replace(/\/$/, "");
if (!base) die("No deployed URL in .pagevault.json.", "Run `make deploy` first.");

const token = fromEnv("PAGEVAULT_API_TOKEN");
if (!token) {
  die("No PAGEVAULT_API_TOKEN in .env.local.", [
    "It's your /api bearer — `make deploy` writes it there. Deploy first, or set it by hand.",
  ]);
}

console.log(banner("export", base));

// Zip by default — the point is one file you can hand off. `NOZIP=1` (--no-zip) leaves the folder.
const zip = !process.argv.includes("--no-zip");
const outDir = argValue("--out") || `./pagevault-export-${new Date().toISOString().slice(0, 10)}`;

try {
  const summary = await buildExport(
    { url: base, token },
    {
      outDir,
      portal: argValue("--portal"),
      zip,
      includeDrafts: process.argv.includes("--include-drafts"),
    },
    info,
  );
  const artifact = summary.zipPath || summary.outDir;
  ok(`Exported ${summary.docCount} document${summary.docCount === 1 ? "" : "s"} to ${c.bold(artifact)}`);
  if (summary.zipSkipped) {
    console.log(`  ${c.dim("`zip` wasn't found — the folder is there; zip it yourself or re-run with NOZIP=1.")}`);
  }
} catch (err) {
  die(err.message);
}

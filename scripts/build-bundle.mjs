// Build the self-contained Worker bundle the npm package ships (ADR-014, #86).
//
// The published `pagevault` package is the installed product: `pagevault init`/`upgrade` deploy a
// PREBUILT Worker, so the user's machine needs no TypeScript, no `worker/` source, and none of the
// Worker's dependencies. This produces that artifact.
//
// It runs wrangler's OWN bundler (`deploy --dry-run --outdir`), not a hand-rolled esbuild, so the
// nodejs_compat polyfills and compatibility flags are applied exactly as a real deploy would. The
// output is a single `index.js`; we keep that as `cli/dist/worker.js` and drop the 7 MB sourcemap
// (never shipped). At deploy time wrangler uploads this file verbatim with `--no-bundle`.
//
// Runs at pack/publish time (cli `prepack`) and via `make bundle`. Requires the repo (worker source
// + node_modules); it is maintainer-side, never something a package user runs.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = join(root, "worker", "wrangler.jsonc");
const distDir = join(root, "cli", "dist");
const tmpDir = join(distDir, ".build");
const bundle = join(distDir, "worker.js");

// Cloudflare's free-tier Worker script limit. The current Worker already deploys under it, so this
// is a regression guard, not a new constraint — but a dependency bump could cross it, and a bundle
// that fails to upload should fail the BUILD, loudly, not the operator's first `init`.
const LIMIT_GZIP_BYTES = 1024 * 1024;

// All progress goes to STDERR. This script runs as cli `prepack`, and `npm pack --json` captures
// prepack's STDOUT expecting pure JSON — anything we print there corrupts it. wrangler's own output
// is routed to stderr for the same reason.
console.error("Building the Worker bundle (wrangler --dry-run)…");
rmSync(tmpDir, { recursive: true, force: true });
execSync(`npx --yes wrangler@4 deploy --dry-run --outdir "${tmpDir}" --config "${config}"`, {
  stdio: ["ignore", process.stderr, process.stderr],
  cwd: root,
});

mkdirSync(distDir, { recursive: true });
copyFileSync(join(tmpDir, "index.js"), bundle);
rmSync(tmpDir, { recursive: true, force: true });

const raw = statSync(bundle).size;
const gzip = gzipSync(readFileSync(bundle)).length;
console.error(`Built cli/dist/worker.js — ${(raw / 1024).toFixed(0)} KiB raw, ${(gzip / 1024).toFixed(0)} KiB gzipped.`);

if (gzip > LIMIT_GZIP_BYTES) {
  console.error(
    `\n✗ Bundle is ${(gzip / 1024).toFixed(0)} KiB gzipped, over Cloudflare's ${(LIMIT_GZIP_BYTES / 1024).toFixed(0)} KiB free-tier limit.\n` +
      "  A dependency likely grew. Trim it, or this will fail to deploy.",
  );
  process.exit(1);
}

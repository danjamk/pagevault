//
// Pack-and-install smoke test (#56).
//
// The unit tests run from inside the repo, where every file is present. They never exercise the
// PUBLISHED artifact — a wrong `files` allowlist, a bad `bin` path, or a missing shebang would
// pass every test and only break when a stranger runs `npx pagevault`. npm publishes are
// permanent (you cannot republish a version), so this is the hard net: pack the tarball, install
// it into a throwaway dir, and run the binary the way a user's machine would.
//
// No deployment needed — `--version` and `help` don't touch /api. Wired as `prepublishOnly`, so a
// broken package cannot be published.

import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = dirname(fileURLToPath(import.meta.url));
const expected = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")).version;

// Run the installed binary and return its combined output. `help` prints to stderr (the CLI
// keeps stdout a clean URL channel), so we merge the streams — and a non-zero exit is itself a
// failure (a broken shebang or entrypoint).
function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.error) throw new Error(`could not run the installed binary (${args.join(" ")}): ${r.error.message}`);
  if (r.status !== 0) throw new Error(`\`${args.join(" ")}\` exited ${r.status}: ${(r.stderr || "").trim() || "(no output)"}`);
  return `${r.stdout || ""}${r.stderr || ""}`;
}

let tarball;
let temp;
let failure = null;
try {
  // 1. Pack exactly what `npm publish` would ship.
  const packed = JSON.parse(execSync("npm pack --json", { cwd: cliDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  tarball = join(cliDir, packed[0].filename);

  // 2. Install the tarball into a throwaway dir — a stranger's machine, not our repo.
  temp = mkdtempSync(join(tmpdir(), "pagevault-smoke-"));
  writeFileSync(join(temp, "package.json"), '{"name":"pagevault-smoke","private":true}\n');
  execSync(`npm install --no-audit --no-fund "${tarball}"`, { cwd: temp, stdio: ["ignore", "ignore", "pipe"] });

  // 3. Run the INSTALLED binary — this exercises the bin path, the shebang, and the files list.
  const bin = join(temp, "node_modules", ".bin", "pagevault");
  const version = run(bin, ["--version"]).trim();
  if (version !== expected) throw new Error(`\`--version\` printed "${version}", expected "${expected}"`);
  if (!/publish/i.test(run(bin, ["help"]))) {
    throw new Error("`help` ran but did not mention `publish` — the wrong file shipped, or a broken entrypoint");
  }

  console.log(`✓ packed, installed, and ran pagevault@${version} from the tarball`);
} catch (err) {
  failure = err?.message ?? String(err);
} finally {
  // process.exit() would skip this — so clean up here, then exit below.
  if (tarball) rmSync(tarball, { force: true });
  if (temp) rmSync(temp, { recursive: true, force: true });
}

if (failure) {
  console.error(`\n✗ pack-and-install smoke failed: ${failure}\n`);
  process.exit(1);
}

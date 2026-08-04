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
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const cliDir = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
const expected = pkg.version;
// The PRODUCT version (root package.json) — what an installed deploy reports. As of 0.19.0 the npm
// package version above is kept EQUAL to it (one number: `pagevault --version` matches /health). The
// two are still read from their own sources here, so this asserts each is wired to the right place —
// `--version` from cli/package.json, the deploy stamp from dist/version.txt (#87).
const productVersion = JSON.parse(readFileSync(join(cliDir, "..", "package.json"), "utf8")).version;

// The one place this test has to know what platform it is on. npm's bin shim on Windows is
// `pagevault.cmd`, not the extensionless script POSIX gets — and since CVE-2024-27980 Node refuses
// to spawn a `.cmd` at all without a shell. So name the shim explicitly and opt into the shell,
// which in turn means the path must be quoted: a temp dir can contain a space, and this suite exists
// precisely to catch the class of bug where it doesn't.
const isWindows = process.platform === "win32";
const shim = (bin) => (isWindows ? `"${bin}.cmd"` : bin);
const spawnOpts = (extra = {}) => ({ encoding: "utf8", shell: isWindows, ...extra });

// Run the installed binary and return its combined output. `help` prints to stderr (the CLI
// keeps stdout a clean URL channel), so we merge the streams — and a non-zero exit is itself a
// failure (a broken shebang or entrypoint).
function run(bin, args) {
  const r = spawnSync(shim(bin), args, spawnOpts());
  if (r.error) throw new Error(`could not run the installed binary (${args.join(" ")}): ${r.error.message}`);
  if (r.status !== 0) throw new Error(`\`${args.join(" ")}\` exited ${r.status}: ${(r.stderr || "").trim() || "(no output)"}`);
  return `${r.stdout || ""}${r.stderr || ""}`;
}

let tarball;
let temp;
let failure = null;
try {
  // 1. Pack exactly what `npm publish` would ship. Derive the tarball name (`<name>-<version>.tgz`)
  //    instead of parsing `npm pack --json`: npm 11 changed that output from an array `[{filename}]`
  //    to an object keyed by package name (`{ pagevault: {...} }`), and this smoke runs as
  //    `prepublishOnly` under whatever npm ran `publish`. The registry naming convention is stable,
  //    so the derived name is version-proof; `npm pack`'s own stdout (the filename) is ignored.
  const tarballName = `${pkg.name.replace(/^@/, "").replace(/\//g, "-")}-${pkg.version}.tgz`;
  execSync("npm pack", { cwd: cliDir, stdio: ["ignore", "ignore", "inherit"] });
  tarball = join(cliDir, tarballName);
  if (!existsSync(tarball)) throw new Error(`npm pack did not produce ${tarballName} in ${cliDir}`);

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

  // 4. The prebuilt Worker bundle must ship — `pagevault init`/`upgrade` deploy it, so a package
  // without it can't stand PageVault up (ADR-014, #86). `npm pack` ran `prepack` → `build`, so it
  // should be here; a missing or truncated file means the build didn't run or the allowlist is wrong.
  let bundleBytes = 0;
  try {
    bundleBytes = statSync(join(temp, "node_modules", "pagevault", "dist", "worker.js")).size;
  } catch {
    throw new Error("dist/worker.js is missing from the installed package — the bundle didn't ship (prepack/files)");
  }
  if (bundleBytes < 500_000) {
    throw new Error(`dist/worker.js shipped but is only ${bundleBytes} bytes — the bundle looks truncated or broken`);
  }

  // 5. The lifecycle commands ship and dispatch. `--help` short-circuits to usage before any
  // provisioning runs, so this stays a no-deploy check. `help` must document them.
  if (!/\binit\b/.test(run(bin, ["help"]))) {
    throw new Error("`help` does not mention `init` — the init/upgrade lifecycle commands didn't ship");
  }
  run(bin, ["init", "--help"]);
  run(bin, ["upgrade", "--help"]);

  // 5b. Per-command help resolves from the INSTALLED package (#126) — `lib/help.mjs` is a new file
  // and a wrong `files` allowlist would leave `<cmd> --help` printing the top-level wall forever.
  // Backup/restore are the reason this matters (#133): they are the commands an installed operator
  // reaches for under stress, and until now they existed only behind `make`.
  for (const cmd of ["backup", "restore"]) {
    const help = run(bin, [cmd, "--help"]);
    if (!help.startsWith(`Usage: pagevault ${cmd}`)) {
      throw new Error(`installed \`${cmd} --help\` did not print its own usage — lib/help.mjs or lib/ops/${cmd}.mjs didn't ship`);
    }
    if (!new RegExp(`\\b${cmd}\\b`).test(run(bin, ["help"]))) {
      throw new Error(`\`help\` does not mention \`${cmd}\` — same-host disaster recovery is invisible to an installed operator`);
    }
  }

  // 6. The installed package reports the PRODUCT version (from the stamped dist/version.txt), not
  // its own npm version — the #87 version stamp, exercised from an actual install (RUNNING_FROM_REPO
  // is false under node_modules, which the in-repo tests can't reach).
  const ctxUrl = pathToFileURL(join(temp, "node_modules", "pagevault", "lib", "provision", "context.mjs")).href;
  const reported = execSync(`node -e "import(process.argv[1]).then(m=>process.stdout.write(m.VERSION))" "${ctxUrl}"`, {
    encoding: "utf8",
  }).trim();
  if (reported !== productVersion) {
    throw new Error(`installed context VERSION is "${reported}", expected the stamped product version "${productVersion}"`);
  }

  // 7. The operator commands ship and dispatch from an install too (new in 0.19 — a fresh
  // lib/ops/ directory with its own relative imports). `status` is the safe probe: with an empty
  // ~/.pagevault it reports "not configured" and exits 0, which proves lib/ops loads and stateDir()
  // resolves under node_modules (RUNNING_FROM_REPO is false there — the in-repo tests can't reach it).
  if (!/\bstatus\b/.test(run(bin, ["help"]))) {
    throw new Error("`help` does not mention `status` — the operator commands (status/verify/health/destroy) didn't ship");
  }
  {
    // USERPROFILE alongside HOME: `os.homedir()` reads USERPROFILE on Windows and ignores HOME, so
    // without it this "fresh machine" probe would find the real ~/.pagevault. PAGEVAULT_HOME already
    // overrides both, but the isolation should not rest on a single variable.
    const env = { ...process.env, HOME: temp, USERPROFILE: temp, PAGEVAULT_HOME: temp };
    const r = spawnSync(shim(bin), ["status", "--json"], spawnOpts({ env }));
    if (r.status !== 0) throw new Error(`installed \`status --json\` exited ${r.status}: ${(r.stderr || "").trim() || "(no output)"}`);
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      throw new Error("installed `status --json` did not emit valid JSON — lib/ops failed to load from the package");
    }
    if (parsed.configured !== false) throw new Error("installed `status --json` on a fresh machine should report configured:false");
  }

  console.log(
    `✓ packed, installed, and ran pagevault@${version} (init/upgrade + status/verify/health/destroy + ${productVersion} bundle) from the tarball`,
  );
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

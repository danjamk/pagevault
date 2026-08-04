//
// Platform-conditional CLI behavior (#139). Two things the CLI decides from the machine it is
// running on — whether to emit ANSI, and which DNS-flush command to advise. Both are pure functions
// precisely so they can be tested from any platform: CI is Linux, I develop on macOS, and the cases
// that matter most are Windows and WSL, which neither of those can observe. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldUseColor } from "../cli/lib/provision/context.mjs";
import { dnsFlushHint, isWsl } from "../cli/lib/ops/verify.mjs";

// --- color -----------------------------------------------------------------------------------

test("color is on for an interactive terminal", () => {
  assert.equal(shouldUseColor({ env: {}, stdoutTTY: true, stderrTTY: true }), true);
});

test("color is off when neither stream is a terminal", () => {
  // CI logs, `> file`, a command substitution. This is what keeps escape sequences out of files.
  assert.equal(shouldUseColor({ env: {}, stdoutTTY: false, stderrTTY: false }), false);
});

test("a piped stdout keeps color, because the human is reading stderr", () => {
  // `pagevault publish report.html | pbcopy` is a documented flow: the URL goes down the pipe and
  // every human line goes to stderr, where someone is still watching. Keying on stdout alone would
  // strip the color out of exactly that session.
  assert.equal(shouldUseColor({ env: {}, stdoutTTY: false, stderrTTY: true }), true);
});

test("NO_COLOR wins over a live terminal, at any value including empty", () => {
  // The standard is presence, not truthiness — `NO_COLOR=` counts.
  assert.equal(shouldUseColor({ env: { NO_COLOR: "1" }, stdoutTTY: true, stderrTTY: true }), false);
  assert.equal(shouldUseColor({ env: { NO_COLOR: "" }, stdoutTTY: true, stderrTTY: true }), false);
  assert.equal(shouldUseColor({ env: { NO_COLOR: "0" }, stdoutTTY: true, stderrTTY: true }), false);
});

test("FORCE_COLOR beats NO_COLOR and a dead terminal", () => {
  assert.equal(shouldUseColor({ env: { FORCE_COLOR: "1" }, stdoutTTY: false, stderrTTY: false }), true);
  assert.equal(shouldUseColor({ env: { FORCE_COLOR: "1", NO_COLOR: "1" }, stdoutTTY: false }), true);
  // FORCE_COLOR=0 is the documented "off" spelling, and an empty value is not a request.
  assert.equal(shouldUseColor({ env: { FORCE_COLOR: "0" }, stdoutTTY: true, stderrTTY: true }), false);
  assert.equal(shouldUseColor({ env: { FORCE_COLOR: "", NO_COLOR: "1" }, stdoutTTY: true }), false);
});

// --- DNS flush -------------------------------------------------------------------------------

test("each platform gets its own flush command", () => {
  assert.match(dnsFlushHint("darwin", false).cmd, /dscacheutil -flushcache/);
  assert.match(dnsFlushHint("linux", false).cmd, /resolvectl flush-caches/);
  assert.match(dnsFlushHint("win32", false).cmd, /ipconfig \/flushdns/);
});

test("an unknown platform falls back to the Linux command rather than printing nothing", () => {
  assert.match(dnsFlushHint("aix", false).cmd, /resolvectl flush-caches/);
});

test("WSL is told to flush the WINDOWS cache, not its own", () => {
  // The trap: WSL looks like Linux to process.platform, but /etc/resolv.conf points at the Windows
  // host resolver. `resolvectl flush-caches` inside the distro clears a cache that was never
  // consulted — the user flushes, retries, sees the same failure, and blames the deploy (#123).
  const hint = dnsFlushHint("linux", true);
  assert.match(hint.cmd, /ipconfig\.exe \/flushdns/);
  assert.doesNotMatch(hint.cmd, /resolvectl/, "advising resolvectl under WSL is the bug");
  assert.ok(hint.note, "the WSL case must explain itself — the command alone looks wrong");
  assert.match(hint.note, /Windows/);
});

test("only the WSL case carries a note, so the common path stays terse", () => {
  assert.equal(dnsFlushHint("darwin", false).note, null);
  assert.equal(dnsFlushHint("linux", false).note, null);
  assert.equal(dnsFlushHint("win32", false).note, null);
});

test("isWsl is false off Linux without touching the filesystem", () => {
  assert.equal(isWsl("darwin"), false);
  assert.equal(isWsl("win32"), false);
});

test("isWsl agrees with the machine running the suite", () => {
  // On CI (ubuntu) and on my Mac this is false; inside a WSL distro it is true. Asserting the type
  // rather than the value keeps it honest on every host.
  assert.equal(typeof isWsl(), "boolean");
});

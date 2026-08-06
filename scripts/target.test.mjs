//
// Deployment resolution (ADR-021, phase 1). The cases that matter are a repo checkout beside a
// global login, and CI reconstructing a build record from a secret — neither convenient to
// reproduce by hand, both a one-line fixture here. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { classifyMarker, describeTarget, findMarker, locateMarker, readMarker, recordUrl, resolveTarget } from "../cli/lib/target.mjs";

// --- classification: content, never an assumed shape -------------------------------------------

test("a pointer marker names a deployment", () => {
  assert.deepEqual(classifyMarker({ deployment: "test" }), { kind: "pointer", name: "test" });
  assert.deepEqual(classifyMarker({ deployment: "  test  " }), { kind: "pointer", name: "test" });
});

test("a build record is recognized by its own fields — this is what CI writes", () => {
  // deploy-prod.yml restores exactly this from a base64 secret on every production deploy. If the
  // reader ever stops recognizing it, prod deploys break with no local reproduction.
  const ci = { rung: 3, ownerEmail: "o@example.com", host: "pv.example.com", accountId: "abc", kvId: "k" };
  assert.deepEqual(classifyMarker(ci), { kind: "record", record: ci });
  // Any one of the identifying fields is enough — an intent file written before a deploy has no kvId.
  assert.equal(classifyMarker({ rung: 1 }).kind, "record");
  assert.equal(classifyMarker({ host: "pv.example.com" }).kind, "record");
  assert.equal(classifyMarker({ accountId: "abc" }).kind, "record");
  assert.equal(classifyMarker({ deployedUrl: "https://pv.example.com" }).kind, "record");
});

test("a pointer wins over stray record fields, so a half-migrated file is unambiguous", () => {
  assert.equal(classifyMarker({ deployment: "test", host: "old.example.com" }).kind, "pointer");
});

test("anything else is empty rather than a guess", () => {
  assert.equal(classifyMarker({}).kind, "empty");
  assert.equal(classifyMarker({ schemaVersion: 1 }).kind, "empty");
  assert.equal(classifyMarker({ deployment: "" }).kind, "empty");
  assert.equal(classifyMarker(null).kind, "empty");
  assert.equal(classifyMarker("nope").kind, "empty");
});

test("an unreadable or invalid marker is empty, never a throw", () => {
  // A broken file must not stop a command that had a good answer elsewhere in the chain.
  assert.equal(readMarker("/nope", { read: () => { throw new Error("ENOENT"); } }).kind, "empty");
  assert.equal(readMarker("/bad", { read: () => "{not json" }).kind, "empty");
});

// --- ascent --------------------------------------------------------------------------------------

test("the marker is found by walking up, not only in CWD", () => {
  // Standing in worker/src must resolve the same deployment as standing in the repo root.
  const present = join("/repo", ".pagevault.json");
  const found = findMarker("/repo/worker/src", { exists: (p) => p === present });
  assert.equal(found, present);
});

test("the nearest marker wins over an ancestor's", () => {
  const exists = (p) => p === join("/repo", ".pagevault.json") || p === join("/repo/sub", ".pagevault.json");
  assert.equal(findMarker("/repo/sub/deep", { exists }), join("/repo/sub", ".pagevault.json"));
});

test("ascent terminates at the root rather than looping", () => {
  assert.equal(findMarker("/a/b/c", { exists: () => false }), null);
  assert.equal(findMarker("/", { exists: () => false }), null);
});

// --- record URL ------------------------------------------------------------------------------

test("a record's URL prefers what the deploy recorded over what was intended", () => {
  assert.equal(recordUrl({ deployedUrl: "https://pv.example.com/", host: "other.example.com" }), "https://pv.example.com");
  assert.equal(recordUrl({ host: "pv.example.com" }), "https://pv.example.com");
  assert.equal(recordUrl({}), "");
  assert.equal(recordUrl(null), "");
});

// --- resolution ------------------------------------------------------------------------------

const REPO_MARKER = join("/repo", ".pagevault.json");
const inRepo = { exists: (p) => p === REPO_MARKER };
const testRecord = { kind: "record", record: { rung: 3, accountId: "acct", deployedUrl: "https://test.example.com" } };

// --- locating the marker: PAGEVAULT_HOME is exclusive ------------------------------------------

test("PAGEVAULT_HOME wins over ascent, and does NOT fall back to it", () => {
  // The property every test suite depends on. `HOME` and `PAGEVAULT_HOME` point at a temp dir while
  // the suite runs from the repo root — if ascent could win, the e2e suite would walk up, find the
  // real .pagevault.json, and drive commands against a live deployment instead of local wrangler.
  const pinned = join("/tmp/scratch", ".pagevault.json");
  const exists = (p) => p === pinned || p === join("/repo", ".pagevault.json");
  assert.equal(locateMarker({ env: { PAGEVAULT_HOME: "/tmp/scratch" }, cwd: "/repo/worker", home: "/home/me", exists }), pinned);

  // Set but empty: null, never a silent fall back to the checkout the suite happens to run from.
  assert.equal(
    locateMarker({ env: { PAGEVAULT_HOME: "/tmp/empty" }, cwd: "/repo/worker", home: "/home/me", exists }),
    null,
  );
});

test("without PAGEVAULT_HOME, ascent finds the checkout", () => {
  const repo = join("/repo", ".pagevault.json");
  assert.equal(locateMarker({ env: {}, cwd: "/repo/worker/src", home: "/home/me", exists: (p) => p === repo }), repo);
});

test("ascent falling short lands on the installed default", () => {
  // `~/.pagevault/.pagevault.json` sits INSIDE `.pagevault/`, so ascent from an unrelated directory
  // can never reach it. Checked explicitly or an installed operator resolves nothing.
  const installed = join("/home/me", ".pagevault", ".pagevault.json");
  assert.equal(locateMarker({ env: {}, cwd: "/somewhere/else", home: "/home/me", exists: (p) => p === installed }), installed);
});

test("nothing anywhere is null, not a guess", () => {
  assert.equal(locateMarker({ env: {}, cwd: "/nowhere", home: "/home/me", exists: () => false }), null);
});

/** resolveTarget with a marker present at /repo and a global login pointing elsewhere. */
const resolveIn = (cwd, extra = {}) =>
  resolveTarget({
    cwd,
    env: {},
    home: "/home/me",
    config: { url: "https://prod.example.com", token: "bearer" },
    locate: (o) => locateMarker({ ...o, exists: inRepo.exists }),
    read: () => testRecord,
    ...extra,
  });

test("in the checkout → the checkout's deployment; outside it → the login", () => {
  const inside = resolveIn("/repo/worker/src");
  assert.equal(inside.url, "https://test.example.com");
  assert.equal(inside.source, "marker");
  assert.equal(inside.provisioned, true);

  const outside = resolveTarget({
    cwd: "/elsewhere",
    env: {},
    config: { url: "https://prod.example.com", token: "bearer" },
    locate: (o) => locateMarker({ ...o, exists: inRepo.exists }),
  });
  assert.equal(outside.url, "https://prod.example.com");
  assert.equal(outside.source, "config");
  assert.equal(outside.provisioned, false, "a login without a build record is client-only, not broken");
});

test("a disagreement is reported, not resolved away", () => {
  const t = resolveIn("/repo");
  assert.equal(t.conflicted, true);
  assert.equal(t.markerUrl, "https://test.example.com");
  assert.equal(t.configUrl, "https://prod.example.com");
});

test("agreement is not a conflict", () => {
  const t = resolveIn("/repo", { config: { url: "https://test.example.com", token: "b" } });
  assert.equal(t.conflicted, false);
});

test("explicit beats environment beats where you stand", () => {
  const base = { cwd: "/repo", config: { url: "https://prod.example.com" }, locate: (o) => locateMarker({ ...o, exists: inRepo.exists }), read: () => testRecord };
  assert.equal(resolveTarget({ ...base, env: {}, flags: { url: "https://flag.example.com" } }).source, "flag");
  assert.equal(resolveTarget({ ...base, env: { PAGEVAULT_URL: "https://env.example.com" } }).source, "env");
  assert.equal(resolveTarget({ ...base, env: {}, flags: { url: "https://f.example" } }).url, "https://f.example");
  // Environment still loses to an explicit flag.
  const both = resolveTarget({ ...base, env: { PAGEVAULT_URL: "https://env.example.com" }, flags: { url: "https://flag.example.com" } });
  assert.equal(both.url, "https://flag.example.com");
});

test("with nothing anywhere, the target is empty rather than invented", () => {
  const t = resolveTarget({ cwd: "/elsewhere", env: {}, config: {}, locate: () => null });
  assert.equal(t.url, "");
  assert.equal(t.source, "none");
  assert.equal(t.provisioned, false);
});

test("a pointer with no registry is surfaced, not silently ignored", () => {
  // Phase 3 builds the registry. Until then a pointer is recognized and reported so a caller can
  // say why it fell through, instead of quietly acting on the login config.
  const t = resolveTarget({
    cwd: "/repo",
    env: {},
    config: { url: "https://prod.example.com" },
    locate: (o) => locateMarker({ ...o, exists: inRepo.exists }),
    read: () => ({ kind: "pointer", name: "test" }),
  });
  assert.equal(t.unresolvedPointer, "test");
  assert.equal(t.source, "config");
});

test("a pointer resolves through the registry once one exists", () => {
  const t = resolveTarget({
    cwd: "/repo",
    env: {},
    config: { url: "https://prod.example.com" },
    locate: (o) => locateMarker({ ...o, exists: inRepo.exists }),
    read: () => ({ kind: "pointer", name: "test" }),
    registry: { deployments: { test: { url: "https://test.example.com", accountId: "acct", rung: 3 } } },
  });
  assert.equal(t.url, "https://test.example.com");
  assert.equal(t.source, "marker");
  assert.equal(t.provisioned, true);
  assert.equal(t.unresolvedPointer, null);
});

// --- describing the target --------------------------------------------------------------------

test("the target line names the deployment AND why it was chosen", () => {
  // The "why" half is not decoration. This whole class of bug was invisible precisely because
  // nothing ever said which deployment had been chosen, or which file chose it.
  const marker = resolveIn("/repo");
  assert.match(describeTarget(marker), /^https:\/\/test\.example\.com {2}\(from .*\.pagevault\.json\)$/);

  const fromEnv = resolveIn("/repo", { env: { PAGEVAULT_URL: "https://env.example.com" } });
  assert.equal(describeTarget(fromEnv), "https://env.example.com  (from PAGEVAULT_URL)");

  const fromFlag = resolveIn("/repo", { flags: { url: "https://flag.example.com" } });
  assert.equal(describeTarget(fromFlag), "https://flag.example.com  (from --url)");

  const fromLogin = resolveTarget({
    cwd: "/elsewhere",
    env: {},
    config: { url: "https://prod.example.com" },
    locate: () => null,
  });
  assert.equal(describeTarget(fromLogin), "https://prod.example.com  (from login config)");
});

test("nothing configured says so plainly rather than printing an empty URL", () => {
  const none = resolveTarget({ cwd: "/x", env: {}, config: {}, locate: () => null });
  assert.equal(describeTarget(none), "no deployment configured");
});

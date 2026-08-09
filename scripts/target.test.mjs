//
// Deployment resolution (ADR-021, phase 1). The cases that matter are a repo checkout beside a
// global login, and CI reconstructing a build record from a secret — neither convenient to
// reproduce by hand, both a one-line fixture here. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { classifyMarker, describeTarget, findMarker, locateMarker, provisionedFrom, readEnvVar, readMarker, recordUrl, resolveBearer, resolveBearerSource, resolveTarget, stateEnvPath, stateToken } from "../cli/lib/target.mjs";

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

// --- pairing the bearer with the deployment ----------------------------------------------------

test("🔴 a login token is never sent to a deployment the login does not describe (#155)", () => {
  // The bug this exists to stop: `verify` took the URL from a checkout's marker and the token from
  // ~/.pagevault/config.json, and sent PRODUCTION's bearer to the test deployment. The 401 was
  // luck — had the two shared a bearer it would have authenticated against the wrong one and run a
  // write round-trip there.
  const conflicted = resolveIn("/repo"); // marker → test, login → prod
  assert.equal(conflicted.conflicted, true);
  assert.equal(resolveBearer(conflicted, { config: "prod-bearer" }), "", "must refuse, not misdeliver");

  // Agreement is the ordinary case, and there the login's token is exactly right.
  const agreed = resolveIn("/repo", { config: { url: "https://test.example.com", token: "t" } });
  assert.equal(agreed.conflicted, false);
  assert.equal(resolveBearer(agreed, { config: "test-bearer" }), "test-bearer");
});

test("bearer precedence: environment, then state dir, then login", () => {
  const t = resolveIn("/repo", { config: { url: "https://test.example.com" } });
  assert.equal(resolveBearer(t, { env: "E", state: "S", config: "C" }), "E");
  assert.equal(resolveBearer(t, { state: "S", config: "C" }), "S");
  assert.equal(resolveBearer(t, { config: "C" }), "C");
  assert.equal(resolveBearer(t, {}), "");
});

test("an explicit token still wins over a conflict — the operator named it", () => {
  // `PAGEVAULT_API_TOKEN=… pagevault verify` is how you deliberately act on the other deployment.
  const conflicted = resolveIn("/repo");
  assert.equal(resolveBearer(conflicted, { env: "explicit", config: "prod-bearer" }), "explicit");
});

// --- the state dir's bearer (#195) --------------------------------------------------------------

test("🔴 the state dir's bearer is only sent to the deployment its marker describes", () => {
  // `.env.local` sits beside the build record, so it belongs to whatever that record names. Standing
  // in a checkout and naming another deployment resolves the other one — and must not be handed this
  // one's token. That is #155's shape, one file over.
  const here = resolveIn("/repo");
  assert.equal(resolveBearer(here, { state: "test-bearer" }), "test-bearer");

  const elsewhere = resolveIn("/repo", { flags: { url: "https://other.example.com" } });
  assert.equal(elsewhere.markerUrl, "https://test.example.com", "the marker still says what it said");
  assert.equal(resolveBearer(elsewhere, { state: "test-bearer" }), "", "not this deployment's credential");

  // No marker at all means nothing to pair a state bearer to, so there is nothing to send.
  const noMarker = resolveTarget({ cwd: "/elsewhere", env: {}, config: { url: "https://prod.example.com" }, locate: () => null });
  assert.equal(resolveBearer(noMarker, { state: "stray" }), "");
});

test("the bearer names the store it came from, because two of them share a name (#195)", () => {
  // A deploy reporting PAGEVAULT_API_TOKEN set, then a command reporting no bearer, was two true
  // statements about the Worker's secret and this machine's copy. Provenance is what makes the pair
  // readable.
  const t = resolveIn("/repo", { config: { url: "https://test.example.com", token: "c" } });
  assert.match(resolveBearerSource(t, { env: "E" }).from, /environment/);
  assert.equal(resolveBearerSource(t, { state: "S" }).from, stateEnvPath(t));
  assert.match(resolveBearerSource(t, { config: "C" }).from, /login config/);
  assert.equal(resolveBearerSource(t, {}).from, null);

  const named = resolveIn("/repo", {
    registry: { current: null, deployments: { test: { url: "https://test.example.com", token: "test-bearer" } } },
  });
  assert.equal(resolveBearerSource(named, { state: "S", config: "C" }).from, "test in deployments.json");
});

test("the state `.env.local` is the one beside the build record, not the cwd's", () => {
  const t = resolveIn("/repo/worker/src");
  assert.equal(stateEnvPath(t), join("/repo", ".env.local"), "beside the marker, wherever we are standing");
  assert.equal(stateEnvPath(resolveTarget({ cwd: "/x", env: {}, config: {}, locate: () => null })), null);
  // A missing file is "no bearer here", never a throw from a credential lookup.
  assert.equal(stateToken(t, { exists: () => false }), "");
});

test("readEnvVar parses what .env.local actually looks like on every platform", () => {
  const io = (text) => ({ exists: () => true, read: () => text });
  assert.equal(readEnvVar("/f", "PAGEVAULT_API_TOKEN", io("PAGEVAULT_API_TOKEN=abc\n")), "abc");
  // CRLF, quotes, and a leading BOM — PowerShell 5.1 writes all three.
  assert.equal(readEnvVar("/f", "PAGEVAULT_API_TOKEN", io("OTHER=x\r\nPAGEVAULT_API_TOKEN=\"abc\"\r\n")), "abc");
  assert.equal(readEnvVar("/f", "PAGEVAULT_API_TOKEN", io("﻿PAGEVAULT_API_TOKEN=abc\n")), "abc");
  // A value containing `=` survives — only the FIRST one separates key from value.
  assert.equal(readEnvVar("/f", "K", io("K=a=b\n")), "a=b");
  // A key that merely starts the same must not match.
  assert.equal(readEnvVar("/f", "PAGEVAULT_API", io("PAGEVAULT_API_TOKEN=abc\n")), undefined);
  assert.equal(readEnvVar(null, "K", io("K=v\n")), undefined);
  assert.equal(readEnvVar("/f", "K", { exists: () => true, read: () => { throw new Error("EACCES"); } }), undefined);
});

// --- the named registry (ADR-021 phase 3) ------------------------------------------------------

const REGISTRY = {
  current: "prod",
  deployments: {
    prod: { url: "https://prod.example.com", token: "prod-bearer", protected: true },
    test: { url: "https://test.example.com", token: "test-bearer", rung: 3, accountId: "acct" },
  },
};

/** As resolveIn, but with the registry loaded — the phase-3 world. */
const resolveReg = (cwd, extra = {}) => resolveIn(cwd, { registry: REGISTRY, ...extra });

test("🔴 a build record finds its bearer in the registry, by URL (#159)", () => {
  // THE bug this phase exists to close. Standing in the checkout, `status` reported the test
  // deployment (from the marker) while `list` and `publish` hit PROD, because the only bearer on
  // the machine was the login config's and there was nowhere to keep test's. Same directory, same
  // invocation, two deployments.
  //
  // The marker is untouched — still a build record, no `deployment` key, exactly what CI writes.
  const t = resolveReg("/repo/worker/src");
  assert.equal(t.url, "https://test.example.com", "still resolved by where you are standing");
  assert.equal(t.source, "marker");
  assert.equal(t.markerKind, "record", "no working-tree file was rewritten to make this work");
  assert.equal(t.name, "test", "matched into the registry by URL — decision (b)");
  assert.equal(resolveBearer(t, { config: "prod-bearer" }), "test-bearer", "the deployment's own bearer");
});

test("without a matching entry the refusal stands — the registry adds, it never loosens", () => {
  // Same conflicted target, registry that does not know this deployment. resolveBearer must still
  // refuse rather than fall back to the login config's token (#155).
  const t = resolveReg("/repo", { registry: { current: null, deployments: { prod: REGISTRY.deployments.prod } } });
  assert.equal(t.name, null);
  assert.equal(t.conflicted, true);
  assert.equal(resolveBearer(t, { config: "prod-bearer" }), "", "must refuse, not misdeliver");
});

test("--deployment resolves by name and outranks everything", () => {
  const t = resolveReg("/repo", { flags: { deployment: "prod" } });
  assert.equal(t.url, "https://prod.example.com");
  assert.equal(t.source, "flag-name");
  assert.equal(t.name, "prod");
  assert.equal(t.protected, true, "protected travels with the deployment, not the command");

  // Even against an explicit --url, which is the next rung down.
  const both = resolveReg("/repo", { flags: { deployment: "prod", url: "https://flag.example.com" } });
  assert.equal(both.url, "https://prod.example.com");
});

test("PAGEVAULT_DEPLOYMENT works for direnv and CI, and loses to a flag", () => {
  const t = resolveReg("/repo", { env: { PAGEVAULT_DEPLOYMENT: "prod" } });
  assert.equal(t.source, "env-name");
  assert.equal(t.name, "prod");

  const flagWins = resolveReg("/repo", { env: { PAGEVAULT_DEPLOYMENT: "prod" }, flags: { url: "https://flag.example.com" } });
  assert.equal(flagWins.source, "flag");
});

test("🔴 a name that names nothing is refused, never quietly downgraded", () => {
  // Falling through to the next rung here means acting on a DIFFERENT deployment while the operator
  // believes they named one. The resolver stays pure and reports it; the caller throws.
  const t = resolveReg("/repo", { flags: { deployment: "staging" } });
  assert.equal(t.unknownDeployment, "staging");
  assert.equal(resolveReg("/repo").unknownDeployment, null);
});

test("`current` is the global default: below where you stand, above the login config", () => {
  // Outside any checkout, `pagevault use prod` decides. Inside one, the checkout still wins — that
  // is the property that makes standing somewhere a guardrail rather than a suggestion.
  const outside = resolveTarget({
    cwd: "/elsewhere",
    env: {},
    config: { url: "https://old-login.example.com", token: "stale" },
    locate: () => null,
    registry: { current: "test", deployments: REGISTRY.deployments },
  });
  assert.equal(outside.url, "https://test.example.com");
  assert.equal(outside.source, "current");
  assert.equal(outside.name, "test");

  assert.equal(resolveReg("/repo/worker").source, "marker", "the checkout still beats `current`");
});

test("the login config keeps working as the implicit default when no registry exists", () => {
  // The permanent fallback. An operator who never runs `use` sees exactly the behaviour they had.
  const t = resolveTarget({ cwd: "/elsewhere", env: {}, config: { url: "https://prod.example.com", token: "b" }, locate: () => null });
  assert.equal(t.source, "config");
  assert.equal(t.name, null);
  assert.equal(resolveBearer(t, { config: "b" }), "b");
});

test("a URL reached any other way still picks up its entry's bearer and protection", () => {
  // --url, PAGEVAULT_URL and the login config all match by URL, so naming a deployment is a
  // convenience rather than a requirement for getting the right credential.
  const t = resolveReg("/elsewhere", { flags: { url: "https://prod.example.com" }, locate: () => null });
  assert.equal(t.name, "prod");
  assert.equal(t.protected, true);
  assert.equal(resolveBearer(t, {}), "prod-bearer");
});

test("the target line leads with the name once there is one to lead with", () => {
  assert.match(describeTarget(resolveReg("/repo")), /^test {2}https:\/\/test\.example\.com {2}\(from .*\.pagevault\.json\)$/);
  assert.equal(
    describeTarget(resolveReg("/repo", { flags: { deployment: "prod" } })),
    "prod  https://prod.example.com  (from --deployment)",
  );
  // No registry, no name — the URL-only line the ADR-021 phase-2 tests already pin.
  assert.equal(describeTarget(resolveIn("/repo", { env: { PAGEVAULT_URL: "https://env.example.com" } })), "https://env.example.com  (from PAGEVAULT_URL)");
});

test("a pointer marker resolves and carries its bearer, for anyone who opts into one", () => {
  const t = resolveTarget({
    cwd: "/repo",
    env: {},
    config: { url: "https://prod.example.com", token: "prod-bearer" },
    locate: (o) => locateMarker({ ...o, exists: inRepo.exists }),
    read: () => ({ kind: "pointer", name: "test" }),
    registry: REGISTRY,
  });
  assert.equal(t.url, "https://test.example.com");
  assert.equal(t.name, "test");
  assert.equal(t.unresolvedPointer, null);
  assert.equal(resolveBearer(t, { config: "prod-bearer" }), "test-bearer");
});

// --- provisionedFrom — is it provisioned from this machine, anywhere on it? (#170) --------------

const MARKER_PATH = "/checkout/.pagevault.json";
const entry = (over = {}) => ({ url: "https://test.example.com", token: "t", markerPath: MARKER_PATH, ...over });

/** A disk holding one build record at MARKER_PATH. `read` ignores the path, `exists` does not. */
const disk = (record, { at = MARKER_PATH } = {}) => ({
  exists: (p) => p === at,
  read: () => JSON.stringify(record),
});

test("🔴 the answer does not change with the working directory", () => {
  // The whole reason this does not use locateMarker(). A listing is global: asked from ~ the
  // nearest-marker answer is "no" and asked from the checkout it is "yes", for the same deployment
  // seconds apart. provisionedFrom takes no cwd at all, which is how that is guaranteed rather
  // than tested for — this asserts the signature stays that way.
  assert.equal(provisionedFrom.length <= 2, true, "takes an entry and options; never a cwd");
  const io = disk({ deployedUrl: "https://test.example.com", rung: 3 });
  assert.equal(provisionedFrom(entry(), io), true);
  assert.equal(provisionedFrom(entry(), io), true);
});

test("a recorded build record that still names this deployment reads as provisioned", () => {
  assert.equal(provisionedFrom(entry(), disk({ deployedUrl: "https://test.example.com" })), true);
  // `host` is the intent recorded before a successful deploy, and counts the same.
  assert.equal(provisionedFrom(entry(), disk({ host: "test.example.com" })), true);
});

test("no markerPath is not provisioned, and never touches the disk (#144)", () => {
  // A CI-deployed production. The absence is a fact about the deployment, not a fault.
  const io = { exists: () => assert.fail("must not stat"), read: () => assert.fail("must not read") };
  assert.equal(provisionedFrom(entry({ markerPath: undefined }), io), false);
  assert.equal(provisionedFrom(entry({ markerPath: "" }), io), false);
  assert.equal(provisionedFrom({ url: "https://x.example.com" }, io), false);
  assert.equal(provisionedFrom(null, io), false);
});

test("🔴 a moved or deleted checkout degrades to no, which is true", () => {
  // The stale-pointer case, and the reason this is a path rather than a copy of the fields: a
  // pointer that goes stale becomes the honest answer, where a stale accountId becomes a wrong one.
  assert.equal(provisionedFrom(entry(), { exists: () => false, read: () => assert.fail("gone") }), false);
});

test("🔴 a checkout re-provisioned against a different deployment stops claiming this one", () => {
  // Same path, different deployment. Without the URL re-check the entry would keep asserting it can
  // run infrastructure commands against a deployment that checkout no longer describes.
  assert.equal(provisionedFrom(entry(), disk({ deployedUrl: "https://other.example.com" })), false);
});

test("an unreadable or invalid record is not a claim", () => {
  assert.equal(provisionedFrom(entry(), { exists: () => true, read: () => "{not json" }), false);
  assert.equal(provisionedFrom(entry(), { exists: () => true, read: () => { throw new Error("EACCES"); } }), false);
  // A record naming no deployment at all cannot match one.
  assert.equal(provisionedFrom(entry(), disk({})), false);
});

test("🔴 a pointer marker is never a build record", () => {
  // { deployment: "test" } means the registry is already authoritative for that directory, so
  // there is nothing provisioned there to point back at. Recording one would create two sources
  // for a single relationship, which is how they come to disagree.
  assert.equal(provisionedFrom(entry(), disk({ deployment: "test" })), false);
});

test("matches the way every other comparison does — trailing slash and host casing", () => {
  assert.equal(provisionedFrom(entry({ url: "https://TEST.example.com/" }), disk({ deployedUrl: "https://test.example.com" })), true);
});

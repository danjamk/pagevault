//
// The named deployment registry (ADR-021 phase 3). This file holds a bearer per deployment, so the
// cases worth pinning are the ones where a wrong answer sends the wrong credential: a corrupt file
// that must not read as "no deployments", and URL matching that must not turn on a trailing slash.
// Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REGISTRY_FILE, emptyRegistry, findByName, findByUrl, isValidName, listDeployments,
  loadRegistry, registryPath, remove, saveRegistry, shouldAdoptCurrent, upsert,
} from "../cli/lib/registry.mjs";

/** A scratch PAGEVAULT_HOME, torn down after `fn`. */
function withHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pv-reg-"));
  const env = { PAGEVAULT_HOME: dir };
  try {
    return fn(env, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- location ----------------------------------------------------------------------------------

test("the registry is global, and PAGEVAULT_HOME moves it", () => {
  assert.equal(registryPath({ PAGEVAULT_HOME: "/tmp/scratch" }), join("/tmp/scratch", REGISTRY_FILE));
  // Resolved per call, not at import: the suites set PAGEVAULT_HOME after this module is loaded.
  assert.match(registryPath({}), /\.pagevault[/\\]deployments\.json$/);
});

// --- loading -----------------------------------------------------------------------------------

test("no registry is null — the ordinary state, not a degraded one", () => {
  withHome((env) => assert.equal(loadRegistry(env), null));
});

test("🔴 a corrupt registry throws rather than reading as 'no deployments'", () => {
  // Falling through to the login config here would act on the WRONG deployment with the wrong
  // bearer — the exact failure ADR-021 exists to end. Loud beats convenient.
  withHome((env, dir) => {
    writeFileSync(join(dir, REGISTRY_FILE), "{not json");
    assert.throws(() => loadRegistry(env), /not valid JSON/);
  });
});

test("a registry round-trips, and lands at 0600 because it holds bearers", () => {
  withHome((env, dir) => {
    const reg = upsert(emptyRegistry(), "prod", { url: "https://prod.example.com", token: "p", protected: true });
    saveRegistry({ ...reg, current: "prod" }, env);

    // POSIX only, and deliberately so: NTFS ignores the mode bits, reporting 0o666 for a file
    // written with 0o600. On Windows this file is protected by the profile directory's ACL rather
    // than by anything `writeFileSync` asked for — which is what registry.mjs says, and asserting
    // otherwise would be testing a promise the code does not make. Same guard as the config.json
    // check in cli/pagevault.test.mjs.
    assert.ok(statSync(join(dir, REGISTRY_FILE)).isFile());
    if (process.platform !== "win32") {
      const mode = statSync(join(dir, REGISTRY_FILE)).mode & 0o777;
      assert.equal(mode, 0o600, "a file holding every deployment's bearer is not world-readable");
    }

    const back = loadRegistry(env);
    assert.equal(back.current, "prod");
    assert.equal(back.deployments.prod.token, "p");
    assert.equal(back.deployments.prod.protected, true);
  });
});

test("a blank or missing `current` normalizes to null rather than an empty string", () => {
  withHome((env, dir) => {
    writeFileSync(join(dir, REGISTRY_FILE), JSON.stringify({ current: "   ", deployments: {} }));
    assert.equal(loadRegistry(env).current, null);
    writeFileSync(join(dir, REGISTRY_FILE), JSON.stringify({ deployments: null }));
    assert.deepEqual(loadRegistry(env), { current: null, deployments: {} });
  });
});

// --- lookup by URL: decision (b) ---------------------------------------------------------------

const REG = {
  current: "prod",
  deployments: {
    prod: { url: "https://prod.example.com", token: "prod-bearer", protected: true },
    test: { url: "https://test.example.com", token: "test-bearer", rung: 3, accountId: "acct" },
  },
};

test("🔴 a build record finds its bearer by URL, so no working-tree file is rewritten", () => {
  // This is the whole of decision (b). A checkout's `.pagevault.json` has a host and an accountId
  // but no name and no bearer, and CI reconstructs that exact shape from a base64 secret on every
  // production deploy — so it cannot become a pointer without breaking prod with no local repro.
  const hit = findByUrl(REG, "https://test.example.com");
  assert.equal(hit.name, "test");
  assert.equal(hit.entry.token, "test-bearer");
});

test("a trailing slash or host casing never decides which credential is sent", () => {
  assert.equal(findByUrl(REG, "https://TEST.example.com/").name, "test");
  assert.equal(findByUrl(REG, "https://test.example.com///").name, "test");
});

test("no match is null — which degrades to exactly the pre-registry behaviour", () => {
  assert.equal(findByUrl(REG, "https://unknown.example.com"), null);
  assert.equal(findByUrl(REG, ""), null);
  assert.equal(findByUrl(null, "https://prod.example.com"), null);
});

test("current wins a duplicate-URL tie, so the answer is the one the operator selected", () => {
  const dupes = {
    current: "prod",
    deployments: {
      alias: { url: "https://prod.example.com", token: "a" },
      prod: { url: "https://prod.example.com", token: "p" },
    },
  };
  assert.equal(findByUrl(dupes, "https://prod.example.com").name, "prod");
});

test("lookup by name is exact and missing names are null, not a throw", () => {
  assert.equal(findByName(REG, "test").token, "test-bearer");
  assert.equal(findByName(REG, "nope"), null);
  assert.equal(findByName(null, "test"), null);
});

// --- mutation ----------------------------------------------------------------------------------

test("upsert merges, so a later login does not drop build metadata", () => {
  const next = upsert(REG, "test", { token: "rotated" });
  assert.equal(next.deployments.test.token, "rotated");
  assert.equal(next.deployments.test.accountId, "acct", "merged, not replaced");
  assert.equal(REG.deployments.test.token, "test-bearer", "the input registry is not mutated");
});

test("names that would be awkward as a JSON key or a CLI argument are refused", () => {
  assert.ok(isValidName("prod") && isValidName("test-2") && isValidName("a.b_c"));
  assert.ok(!isValidName("") && !isValidName("has space") && !isValidName("-leading") && !isValidName("a/b"));
  assert.throws(() => upsert(emptyRegistry(), "has space", {}), /not a usable deployment name/);
});

test("removing the current deployment clears current rather than dangling", () => {
  const next = remove(REG, "prod");
  assert.equal(next.current, null);
  assert.deepEqual(Object.keys(next.deployments), ["test"]);
  // Removing a non-current one leaves the selection alone.
  assert.equal(remove(REG, "test").current, "prod");
});

// --- display -----------------------------------------------------------------------------------

test("the listing reports provisioned-from-here as a fact, not a fault (#144)", () => {
  const rows = listDeployments(REG);
  const prod = rows.find((r) => r.name === "prod");
  const test_ = rows.find((r) => r.name === "test");

  assert.equal(prod.current, true);
  assert.equal(prod.protected, true);
  assert.equal(prod.provisioned, false, "a CI-deployed instance is client-only here, and that is normal");
  assert.equal(prod.hasToken, true);

  assert.equal(test_.provisioned, true, "a build record on this machine means provisioning can run");
  assert.equal(test_.current, false);
  assert.deepEqual(listDeployments(null), []);
});
// --- claiming the default (#171) ---------------------------------------------------------------

test("🔴 a deploy never takes the default from a login describing another deployment (#171)", () => {
  // `pagevault upgrade` on the test deployment overwrote a config.json describing production. Where
  // production's bearer lived only in that file — which it did, until minutes before this was found
  // — the credential was destroyed rather than shadowed.
  assert.equal(shouldAdoptCurrent(null, "https://test.invalid", "https://prod.invalid"), false);
  assert.equal(shouldAdoptCurrent(REG, "https://test.example.com", ""), false, "`current` already claimed");
});

test("the ordinary single-deployment install still claims it, exactly as before", () => {
  // Deploying the deployment you are already logged into, and the first-ever deploy with no login at
  // all. Both must keep working or this fix breaks the ADR-014 install path it is protecting.
  assert.equal(shouldAdoptCurrent(null, "https://prod.invalid", "https://prod.invalid"), true);
  assert.equal(shouldAdoptCurrent(null, "https://prod.invalid", ""), true);
  // Trailing slashes and host casing must not be what decides this, same as everywhere else.
  assert.equal(shouldAdoptCurrent(null, "https://prod.invalid", "https://PROD.invalid/"), true);
});

test("an unclaimed registry still lets a matching deployment take the default", () => {
  const unclaimed = { current: null, deployments: REG.deployments };
  assert.equal(shouldAdoptCurrent(unclaimed, "https://prod.example.com", "https://prod.example.com"), true);
  assert.equal(shouldAdoptCurrent(unclaimed, "https://other.example.com", "https://prod.example.com"), false);
});

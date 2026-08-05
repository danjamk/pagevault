//
// The cross-deployment write guard (#145). `sync-access` and `views --sync` are the only commands
// that read `.pagevault.json` and write through `config.json`, so they are the only two that can
// act across deployments — and `views --sync` does the real damage: it queries one deployment's
// Analytics Engine and POSTs the summary to another, where no id matches, storing a near-empty
// summary that reports a MEASURED zero for every document. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCrossDeployment, sameDeployment } from "../cli/lib/client.mjs";

test("the same deployment written two ways is not a conflict", () => {
  // A trailing slash or a capitalized host must never be what refuses an operator's command.
  assert.equal(sameDeployment("https://pv.example.com", "https://pv.example.com/"), true);
  assert.equal(sameDeployment("https://PV.Example.COM", "https://pv.example.com"), true);
  assert.equal(sameDeployment("https://pv.example.com//", "https://pv.example.com"), true);
  assert.equal(isCrossDeployment("https://pv.example.com/", "https://pv.example.com"), false);
});

test("two different deployments are a conflict", () => {
  assert.equal(isCrossDeployment("https://test.example.com", "https://prod.example.com"), true);
  // The real shape of the incident: a repo checkout provisioned test, a global login points at prod.
  assert.equal(
    isCrossDeployment("https://pagevault.fractional5-labs.com", "https://pagevault.danjamkuhn.com"),
    true,
  );
});

test("a host that differs only by subdomain is still a different deployment", () => {
  assert.equal(isCrossDeployment("https://pagevault.example.com", "https://vault.example.com"), true);
  assert.equal(isCrossDeployment("https://a.workers.dev", "https://b.workers.dev"), true);
});

test("scheme and port count — they reach different Workers", () => {
  assert.equal(isCrossDeployment("https://pv.example.com", "http://pv.example.com"), true);
  assert.equal(isCrossDeployment("https://pv.example.com", "https://pv.example.com:8787"), true);
});

test("silence on either side is not a conflict", () => {
  // One source naming a deployment is the normal case for a client-only install (#144) and for a
  // fresh checkout. Refusing there would break installs that are working correctly.
  assert.equal(isCrossDeployment("", "https://prod.example.com"), false);
  assert.equal(isCrossDeployment("https://test.example.com", ""), false);
  assert.equal(isCrossDeployment("", ""), false);
  assert.equal(isCrossDeployment(undefined, "https://prod.example.com"), false);
  assert.equal(isCrossDeployment("https://test.example.com", undefined), false);
});

test("an unparseable value is compared as written, not assumed equal", () => {
  // Fail toward refusing a write, never toward permitting one.
  assert.equal(isCrossDeployment("not a url", "https://prod.example.com"), true);
  assert.equal(isCrossDeployment("not a url", "not a url"), false);
});

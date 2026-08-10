//
// The wrangler deploy command line (#139). The deploy itself shells out to Cloudflare and can't be
// exercised in a unit test — but the STRING handed to the shell can, and that string is where the
// bug was: an unquoted `--config ${path}` splits on the first space in the operator's home path.
// Installed, that path is `%USERPROFILE%\.pagevault\…`, so a Windows account named "First Last"
// breaks the deploy with an error naming neither the path nor the cause. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { deployCommand, deployTargetUrl, refusesProtectedDeploy, suggestName } from "../cli/lib/provision/deploy.mjs";
import { PROTECTED_COMMANDS, findByUrl, protectedCommands } from "../cli/lib/registry.mjs";

test("a config path containing a space survives command construction", () => {
  const cmd = deployCommand(String.raw`C:\Users\First Last\.pagevault\wrangler.generated.jsonc`);
  assert.match(cmd, /--config "C:\\Users\\First Last\\\.pagevault\\wrangler\.generated\.jsonc"/);
  // The regression itself: the shell must never see a bare `--config C:\Users\First`.
  assert.doesNotMatch(cmd, /--config [^"]/, "the config path must be quoted");
});

test("the same holds for a POSIX home with a space", () => {
  // Not Windows-only — `/Users/me/My Drive/…` and `/home/me/Nextcloud Sync/…` break identically.
  const cmd = deployCommand("/Users/me/My Drive/.pagevault/wrangler.generated.jsonc");
  assert.match(cmd, /--config "\/Users\/me\/My Drive\/\.pagevault\/wrangler\.generated\.jsonc"/);
  assert.doesNotMatch(cmd, /--config [^"]/);
});

test("an ordinary path is still quoted — one shape, not two", () => {
  // Quoting unconditionally means the space case is never a branch that can rot untested.
  assert.equal(
    deployCommand("worker/wrangler.generated.jsonc"),
    `npx --yes wrangler@4 deploy --config "worker/wrangler.generated.jsonc"`,
  );
});

test("it pins wrangler 4 and takes the install prompt away", () => {
  // `--yes` matters on a fresh machine: without it npx stops on an interactive confirm and the
  // deploy hangs with no output. The major pin is what keeps a wrangler 5 from landing mid-deploy.
  const cmd = deployCommand("cfg.jsonc");
  assert.match(cmd, /^npx --yes wrangler@4 deploy /);
});

// --- the name a printed `login` command suggests (#195) -----------------------------------------

test("a suggested deployment name is one the operator could actually paste", () => {
  // A printed command with `<name>` still in it is a command nobody can run, and on a first run the
  // values it leaves blank are precisely the ones the operator does not have yet.
  //
  // On workers.dev the first label is always our Worker's name and distinguishes nothing; the label
  // before `workers.dev` is the operator's own subdomain.
  assert.equal(suggestName("https://pagevault.fractional-lab5.workers.dev"), "fractional-lab5");
  assert.equal(suggestName("https://share.example.com"), "share");
  assert.equal(suggestName("https://example.com"), "example");
  // Never empty and never invalid — this string goes straight into `login --as`, which validates it.
  assert.equal(suggestName("not a url"), "pagevault");
  assert.match(suggestName("https://pagevault.fractional-lab5.workers.dev"), /^[a-z0-9][a-z0-9._-]*$/i);
});

// --- `protected` reaches the command that replaces running code (#176) --------------------------

test("which deployment a build record is about to overwrite", () => {
  // Rung 2+ serves on the custom domain, which is known before wrangler runs.
  assert.equal(deployTargetUrl({ rung: 2, host: "share.example.com" }), "https://share.example.com");
  assert.equal(deployTargetUrl({ rung: 3, host: "share.example.com", deployedUrl: "https://old.example.com" }),
    "https://share.example.com", "the host wins — deployedUrl can be a previous rung's address");

  // Rung 1 lands on workers.dev, whose URL wrangler only prints afterwards, so a re-deploy is
  // identified by where it landed last time.
  assert.equal(deployTargetUrl({ rung: 1, deployedUrl: "https://pagevault.me.workers.dev" }), "https://pagevault.me.workers.dev");

  // A genuinely first deploy resolves to nothing, and must — there is no deployment yet to have
  // agreed anything about, so there is nothing to gate and no name to print.
  assert.equal(deployTargetUrl({ rung: 1 }), "");
  assert.equal(deployTargetUrl({ rung: 2 }), "", "rung 2 with no host yet is equally unknown");
  assert.equal(deployTargetUrl({}), "");
});

test("🔴 a protected deployment refuses an upgrade without --yes (#176)", () => {
  const registry = {
    current: "prod",
    deployments: {
      prod: { url: "https://share.example.com", protected: true },
      test: { url: "https://pagevault.me.workers.dev" },
    },
  };
  const prod = findByUrl(registry, "https://share.example.com");
  const test0 = findByUrl(registry, "https://pagevault.me.workers.dev");

  assert.equal(refusesProtectedDeploy(prod, {}), true, "protected + no --yes refuses");
  assert.equal(refusesProtectedDeploy(prod, { yes: true }), false, "--yes is the way through");

  // A refusal, not a prompt: the answer must not depend on whether a terminal is attached, or
  // `protected` means one thing in a shell and another in a script.
  assert.equal(refusesProtectedDeploy(prod, { yes: "true" }), true, "only the boolean flag counts");

  // Everything else is untouched. An unprotected deployment, and a first deploy with no entry at
  // all, deploy exactly as they always have.
  assert.equal(refusesProtectedDeploy(test0, {}), false);
  assert.equal(refusesProtectedDeploy(null, {}), false, "an unregistered deployment is not gated");
  assert.equal(refusesProtectedDeploy(findByUrl(registry, ""), {}), false, "nor is a first deploy");
});

test("the gate fires on the deployment being overwritten, not the selected one", () => {
  // The reason this does not use `resolveTarget()`. `current` is prod; the build record in hand
  // describes test. Gating on the selection would refuse a test deploy — and, inverted, would wave
  // a protected production through whenever `use` pointed somewhere else.
  const registry = {
    current: "prod",
    deployments: {
      prod: { url: "https://share.example.com", protected: true },
      test: { url: "https://pagevault.me.workers.dev" },
    },
  };
  const overwriting = deployTargetUrl({ rung: 1, deployedUrl: "https://pagevault.me.workers.dev" });
  assert.equal(refusesProtectedDeploy(findByUrl(registry, overwriting), {}), false);
});

test("the protected command set is named from one list", () => {
  // #176 grew this set for the first time since it was written, and found three of the four places
  // that state it still saying "rm, revoke and rotate".
  assert.deepEqual(PROTECTED_COMMANDS, ["rm", "revoke", "rotate", "portal-delete", "upgrade"]);
  assert.equal(protectedCommands(), "rm, revoke, rotate, portal-delete and upgrade");
  // `destroy` stays out: it has a stronger guard (type the hostname), and listing it here would
  // imply --yes is enough for it.
  assert.ok(!PROTECTED_COMMANDS.includes("destroy"));
});

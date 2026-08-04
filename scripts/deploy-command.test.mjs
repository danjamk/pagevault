//
// The wrangler deploy command line (#139). The deploy itself shells out to Cloudflare and can't be
// exercised in a unit test — but the STRING handed to the shell can, and that string is where the
// bug was: an unquoted `--config ${path}` splits on the first space in the operator's home path.
// Installed, that path is `%USERPROFILE%\.pagevault\…`, so a Windows account named "First Last"
// breaks the deploy with an error naming neither the path nor the cause. Run with `node --test`.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { deployCommand } from "../cli/lib/provision/deploy.mjs";

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

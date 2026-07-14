import { reset } from "cloudflare:test";
import { afterEach } from "vitest";

// Wipe KV between tests.
//
// vitest-pool-workers 0.18 removed the `isolatedStorage` pool option in favour of an
// explicit `reset()`. Without this, writes accumulate across tests in a file: a list
// endpoint returns documents a previous test published, and the failure surfaces as a
// confusing off-by-N in whichever test happens to run last.
//
// It lives in a setup file rather than in each suite so that a new test file cannot
// forget it and inherit dirty state.
afterEach(async () => {
  await reset();
});
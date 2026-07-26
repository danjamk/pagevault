//
// CLI ↔ Worker end-to-end tests.
//
// `pagevault.test.mjs` covers the CLI's pure helpers and its argument guards — everything that
// happens BEFORE a request goes out. Nothing in this repo used to run a CLI command that actually
// talks to a Worker, so the whole document surface (publish, list, read, link, mint/rotate/revoke,
// share, search, export, rm) was unexercised at the seam where it matters: the HTTP shapes, the
// stdout/stderr split, and the exit codes a script depends on.
//
// This file closes that. It boots the real Worker under `wrangler dev` — real workerd, real
// router, Miniflare KV — and drives the real binary against it as a subprocess.
//
//   make test-e2e          (or: node --test cli/e2e.test.mjs)
//
// Isolation is total, so this can never touch a real deployment:
//   --persist-to   a throwaway KV state dir per suite
//   --env-file     a generated dev-vars file; worker/.dev.vars is never read
//   HOME + PAGEVAULT_HOME  point at a temp dir, so ~/.pagevault/config.json is invisible
//
// Two suites, because publishing behaves differently on either side of Cloudflare Access and both
// halves ship:
//   Public   — accessEnabled() false. A plain publish mints a /p/ link, because on a no-Access
//              deployment a members-only link opens for nobody (#111).
//   Secured  — accessEnabled() true. A plain publish is members-only; public is opt-in.
//
// WHAT THIS CANNOT CATCH. Miniflare's KV is strongly consistent; real KV is not (~60s, no
// read-after-write guarantee even at one edge). A read-after-write assumption will pass here and
// fail in production. Same for Access itself: AUTH_MODE=none treats every request as the owner, so
// this proves the shapes, never "the right person can see it." That is the lifecycle skill's job.
//
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("./bin/pagevault.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("..", import.meta.url));
const BEARER = "e2e-bearer-token";
const OWNER = "owner@e2e.test";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An unused TCP port. Racy in principle; in practice the window is microseconds and we bind next. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

/**
 * Boot the Worker under `wrangler dev` and wait for /health.
 *
 * `access` decides which half of the publish logic is under test: it sets CF_TEAM_NAME and
 * CF_ACCESS_AUD_DOCS, which is exactly what `accessEnabled(env)` reads (worker/src/env.ts). Auth is
 * still bypassed by AUTH_MODE=none — we are testing the *publish semantics* of a Secured
 * deployment, not its identity checks, which need a real JWT and belong in worker/test/auth.test.ts.
 */
async function startWorker({ access = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pv-e2e-"));
  const envFile = join(dir, "dev.vars");

  // CF_API_TOKEN is deliberately absent: it is optional (it only enables Access group sync), and
  // defining it makes wrangler emit a deprecation warning on every boot.
  writeFileSync(
    envFile,
    [
      `PAGEVAULT_API_TOKEN=${BEARER}`,
      "VIEWER_CAPABILITY_SECRET=e2e-capability-secret",
      `OWNER_EMAIL=${OWNER}`,
      "AUTH_MODE=none",
      `CF_TEAM_NAME=${access ? "e2e-team" : ""}`,
      `CF_ACCESS_AUD_DOCS=${access ? "e2e-aud-docs" : ""}`,
      `CF_ACCESS_AUD_ADMIN=${access ? "e2e-aud-admin" : ""}`,
    ].join("\n") + "\n",
  );

  // The repo's own wrangler (a devDependency), not `npx wrangler@4`. The provisioning code uses
  // npx because it runs from an installed package with no node_modules; this file only ever runs
  // from the repo, so resolving locally keeps CI off the registry and off a version drift.
  const port = await freePort();
  const child = spawn(
    join(REPO, "node_modules/.bin/wrangler"),
    [
      "dev",
      "--config", "worker/wrangler.jsonc",
      "--ip", "127.0.0.1",
      "--port", String(port),
      "--inspector-port", String(await freePort()),
      "--local",
      "--persist-to", join(dir, "state"),
      "--env-file", envFile,
    ],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
  );

  // Keep the output for the failure message — a Worker that won't boot (a bad binding, a build
  // error) is otherwise just a timeout with no cause attached.
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early (${child.exitCode}):\n${log}`);
    await sleep(1000);
    try {
      if ((await fetch(`${base}/health`)).ok) {
        return { base, dir, stop: () => stopWorker(child, dir) };
      }
    } catch {
      /* not up yet */
    }
  }
  stopWorker(child, dir);
  throw new Error(`wrangler dev never answered /health on ${base}:\n${log}`);
}

function stopWorker(child, dir) {
  child.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
}

/**
 * A CLI invocation, isolated. HOME and PAGEVAULT_HOME point at a scratch dir so the operator's real
 * ~/.pagevault/config.json can never be read (or written); URL and bearer come from the env, which
 * `loadConfig` gives precedence over any file. stdout and stderr stay SEPARATE, because keeping
 * them separate is half of what these tests assert.
 */
function makeRunner(base, home) {
  return (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PAGEVAULT_HOME: home,
        PAGEVAULT_URL: base,
        PAGEVAULT_API_TOKEN: BEARER,
      },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", text: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
}

/** A CLI call that must succeed. Failures carry both streams, so a red test names its own cause. */
const ok = (run, ...args) => {
  const r = run(...args);
  assert.equal(r.status, 0, `\`pagevault ${args.join(" ")}\` exited ${r.status}\n${r.text}`);
  return r;
};

/** The single URL a pipe-friendly command prints: exactly one line on stdout, and nothing else. */
function soleUrl(r) {
  const lines = r.stdout.split("\n");
  assert.equal(lines.length, 2, `stdout should be one line + newline, got ${JSON.stringify(r.stdout)}`);
  assert.equal(lines[1], "", "stdout should end with exactly one newline");
  assert.match(lines[0], /^https?:\/\/\S+$/, `stdout should be a bare URL, got ${JSON.stringify(lines[0])}`);
  return lines[0];
}

/** Portals have no CLI verb (see the parity test below), so fixtures go in over the API. */
const createPortal = (base, body) =>
  fetch(`${base}/api/portals`, {
    method: "POST",
    headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Write a fixture file into the suite's scratch dir and return its path. */
const fixture = (dir, name, body) => {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
};

// ---------------------------------------------------------------------------
// Public — no Cloudflare Access in front. This is rung 1 and rung 2.
// ---------------------------------------------------------------------------

describe("CLI against a live Worker — Public (no Access)", { timeout: 180_000 }, () => {
  let worker;
  let run;
  let scratch;

  before(async () => {
    worker = await startWorker({ access: false });
    scratch = mkdtempSync(join(tmpdir(), "pv-e2e-work-"));
    run = makeRunner(worker.base, scratch);
    // Two clients, so cross-portal isolation is testable at all.
    await createPortal(worker.base, { slug: "acme", name: "Acme Corp", kind: "restricted" });
    await createPortal(worker.base, { slug: "globex", name: "Globex", kind: "restricted" });
  });

  after(() => {
    worker?.stop();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("publish prints the URL and nothing else on stdout; the human context goes to stderr", () => {
    const file = fixture(scratch, "quarterly.html", "<!doctype html><title>Q3 Review</title><h1>Q3</h1><p>Body.</p>");
    const r = ok(run, "publish", file, "--portal", "acme");

    const url = soleUrl(r); // the `| pbcopy` contract (#7)
    assert.match(r.stderr, /Published "Q3 Review" \(quarterly\.html\) to portal "acme"/);
    // On a no-Access deployment a plain publish IS public — a members-only link would open for
    // nobody, so #111 makes the /p/ capability link the default rather than a dead URL.
    assert.match(url, /\/p\//, "a Public-tier publish should hand back a /p/ capability link");
  });

  it("the published /p/ link opens with no credentials at all", async () => {
    const file = fixture(scratch, "open-me.html", "<!doctype html><title>Open Me</title><h1>hello e2e</h1>");
    const url = soleUrl(ok(run, "publish", file, "--portal", "acme"));

    const res = await fetch(url); // no Authorization header — that is the whole point
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<iframe/i, "the viewer shell should frame the artifact, not inline it");
  });

  it("identity is the filename: the same file updates in place, --name forks a new document", () => {
    const file = fixture(scratch, "roadmap.html", "<!doctype html><title>Roadmap v1</title><h1>v1</h1>");
    const first = JSON.parse(ok(run, "list", "--portal", "acme", "--json").stdout);

    ok(run, "publish", file, "--portal", "acme");
    const afterPublish = JSON.parse(ok(run, "list", "--portal", "acme", "--json").stdout);
    const created = afterPublish.find((d) => d.name === "roadmap.html");
    assert.ok(created, "the document should be listed under its filename");
    assert.equal(afterPublish.length, first.length + 1);

    // Same filename, new contents, --confirm → same id, updated in place (ADR-017).
    writeFileSync(file, "<!doctype html><title>Roadmap v2</title><h1>v2</h1>");
    ok(run, "publish", file, "--portal", "acme", "--confirm");
    const updated = JSON.parse(ok(run, "read", created.id, "--json").stdout);
    assert.equal(updated.title, "Roadmap v2", "the title should follow the new contents");
    assert.equal(updated.id, created.id, "the same filename must keep the same id");

    // A different --name is a different document, from the very same file.
    ok(run, "publish", file, "--portal", "acme", "--name", "roadmap-2027.html");
    const forked = JSON.parse(ok(run, "list", "--portal", "acme", "--json").stdout);
    assert.equal(forked.length, afterPublish.length + 1, "--name should create a second document");
  });

  it("a same-filename collision refuses, and its suggested command carries the flags you passed", () => {
    const file = fixture(scratch, "collide.html", "<!doctype html><title>Collide</title><h1>one</h1>");
    ok(run, "publish", file, "--portal", "acme");

    const r = run("publish", file, "--portal", "acme", "--tags", "a,b");
    assert.equal(r.status, 1, "a second publish of the same filename must refuse");
    assert.match(r.stderr, /already exists in portal "acme"/);
    // The replace suggestion must not silently drop the flags — re-running it verbatim is the
    // documented escape hatch, and a bare `--confirm` would quietly discard `--tags`.
    assert.match(r.stderr, /--portal acme --tags a,b --confirm/);
    assert.equal(r.stdout, "", "a failed publish must print nothing to stdout");
  });

  it("markdown round-trips byte-for-byte through read --source", () => {
    const body = "# Decision Record\n\nWe chose **Debezium** over Fivetran.\n\n- lower cost\n- we run Kafka\n";
    const file = fixture(scratch, "decision.md", body);
    ok(run, "publish", file, "--portal", "acme");

    const id = JSON.parse(ok(run, "list", "--portal", "acme", "--json").stdout).find((d) => d.name === "decision.md").id;
    const meta = JSON.parse(ok(run, "read", id, "--json").stdout);
    assert.equal(meta.sourceKind, "markdown", "a .md file should be stored as markdown");
    assert.equal(meta.title, "Decision Record", "the H1 should become the title");

    // `pagevault read <id> --source > report.md` has to give back exactly what went in.
    assert.equal(ok(run, "read", id, "--source").stdout, body);
  });

  it("link prints one URL to stdout for piping", () => {
    const file = fixture(scratch, "linkable.html", "<!doctype html><title>Linkable</title><h1>x</h1>");
    const published = soleUrl(ok(run, "publish", file, "--portal", "acme"));
    const id = JSON.parse(ok(run, "list", "--portal", "acme", "--json").stdout).find((d) => d.name === "linkable.html").id;

    assert.equal(soleUrl(ok(run, "link", id)), published, "link must hand back the same URL publish printed");
  });

  it("the public-link lifecycle: rotate kills the old URL, revoke kills them all, mint brings one back", async () => {
    const file = fixture(scratch, "capability.html", "<!doctype html><title>Capability</title><h1>secret-ish</h1>");
    const original = soleUrl(ok(run, "publish", file, "--portal", "acme"));
    const id = JSON.parse(ok(run, "list", "--portal", "acme", "--json").stdout).find((d) => d.name === "capability.html").id;
    assert.equal((await fetch(original)).status, 200);

    const rotated = soleUrl(ok(run, "rotate", id));
    assert.notEqual(rotated, original, "rotate must mint a different token");
    assert.equal((await fetch(original)).status, 404, "the pre-rotation URL must be dead");
    assert.equal((await fetch(rotated)).status, 200);

    ok(run, "revoke", id);
    assert.equal((await fetch(rotated)).status, 404, "revoke must kill the live /p/ link");
    ok(run, "read", id); // revoke is not delete — the document survives

    const minted = soleUrl(ok(run, "mint", id));
    assert.equal((await fetch(minted)).status, 200, "mint must make it openable again");
    // Widening is never silent (ADR-002) — mint and rotate both have to say so out loud.
    assert.match(run("mint", id).stderr, /anyone who has it can open this document/i);
  });

  it("search is scoped to one portal — a term in Acme never surfaces under Globex", () => {
    // "changefeed" appears in no other fixture, so the hit count is about scoping rather than
    // about which other documents happen to mention Debezium.
    const file = fixture(scratch, "cdc-notes.html", "<!doctype html><title>CDC on V2</title><h1>CDC</h1>");
    ok(run, "publish", file, "--portal", "acme", "--summary", "Chose Debezium for changefeed capture.", "--tags", "decision");

    const hits = JSON.parse(ok(run, "search", "acme", "changefeed", "--json").stdout);
    assert.equal(hits.length, 1, "the term should be found in its own portal");
    assert.equal(hits[0].doc.title, "CDC on V2");
    assert.ok(hits[0].matched.includes("summary"), "the hit should say the summary is where it matched");

    // Prime directive #5: one client's material must never appear in another's answer.
    assert.deepEqual(JSON.parse(ok(run, "search", "globex", "changefeed", "--json").stdout), []);
  });

  it("list is scoped by portal and by tag", () => {
    const file = fixture(scratch, "globex-only.html", "<!doctype html><title>Globex Only</title><h1>g</h1>");
    ok(run, "publish", file, "--portal", "globex", "--tags", "type:report");

    const globex = JSON.parse(ok(run, "list", "--portal", "globex", "--json").stdout);
    assert.deepEqual(globex.map((d) => d.name), ["globex-only.html"]);

    const tagged = JSON.parse(ok(run, "list", "--tag", "type:report", "--json").stdout);
    assert.ok(tagged.length >= 1);
    assert.ok(tagged.every((d) => d.tags?.includes("type:report")));
  });

  it("an owner-only draft publishes, is flagged as a draft, and link warns it opens for nobody", () => {
    const file = fixture(scratch, "draft.html", "<!doctype html><title>Not Ready</title><h1>draft</h1>");
    ok(run, "publish", file, "--portal", "acme", "--owner-only");

    const id = JSON.parse(ok(run, "list", "--portal", "acme", "--json").stdout).find((d) => d.name === "draft.html").id;
    const meta = JSON.parse(ok(run, "read", id, "--json").stdout);
    assert.equal(meta.ownerOnly, true);
    assert.match(ok(run, "link", id).stderr, /owner-only draft/i);
  });

  it("share grants a portal member and reports the new membership", () => {
    const r = ok(run, "share", "globex", "cto@globex.test");
    assert.match(r.stderr, /Granted cto@globex\.test to portal "globex"/);
    assert.match(r.stderr, /Members now: .*cto@globex\.test/);
  });

  it("export writes a browsable tree and prints only its path", () => {
    const outDir = join(scratch, "exported");
    const r = ok(run, "export", outDir, "--portal", "acme");

    assert.equal(r.stdout.trim(), outDir, "stdout should carry the artifact path and nothing else");
    assert.ok(existsSync(join(outDir, "index.html")), "the export needs an index to be browsable");
    assert.match(readFileSync(join(outDir, "index.html"), "utf8"), /acme/i);
  });

  it("rm deletes the document, and refuses non-interactively without --yes", () => {
    const file = fixture(scratch, "temporary.html", "<!doctype html><title>Temporary</title><h1>bye</h1>");
    ok(run, "publish", file, "--portal", "globex");
    const id = JSON.parse(ok(run, "list", "--portal", "globex", "--json").stdout).find((d) => d.name === "temporary.html").id;

    const guarded = run("rm", id);
    assert.equal(guarded.status, 1, "a non-TTY delete without --yes must refuse");
    assert.match(guarded.stderr, /Refusing to delete/);
    ok(run, "read", id); // still there

    ok(run, "rm", id, "--yes");
    assert.equal(run("read", id).status, 1, "the document should be gone");
  });

  it("a wrong bearer is rejected, and the failure names the status rather than throwing a stack", () => {
    const r = spawnSync(process.execPath, [BIN, "list"], {
      encoding: "utf8",
      env: { ...process.env, HOME: scratch, PAGEVAULT_HOME: scratch, PAGEVAULT_URL: worker.base, PAGEVAULT_API_TOKEN: "wrong" },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /401/);
    assert.doesNotMatch(r.stderr, /at .*node:internal/, "a rejected call should read as a message, not a stack trace");
  });

  it("publishing into a portal that does not exist fails with the server's reason", () => {
    const file = fixture(scratch, "orphan.html", "<!doctype html><title>Orphan</title><h1>o</h1>");
    const r = run("publish", file, "--portal", "does-not-exist");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No such portal/);
  });

  // Portals from the terminal (#117). Until these landed, a CLI-only operator could not open a
  // second client portal at all, and could grant access but never revoke it — the parity principle
  // says CLI and MCP are the max feature set, and only the console may lag.

  it("portal-create opens a new portal and prints its slug for piping", () => {
    const r = ok(run, "portal-create", "initech", "--name", "Initech", "--kind", "restricted");
    assert.equal(r.stdout, "initech\n", "stdout should carry the slug and nothing else");
    assert.match(r.stderr, /Created portal "initech" \(restricted\) — Initech\./);

    // It exists, and it is immediately publishable into — the point of the command.
    const file = fixture(scratch, "initech-brief.html", "<!doctype html><title>Brief</title><h1>b</h1>");
    ok(run, "publish", file, "--portal", "initech");
    assert.deepEqual(JSON.parse(ok(run, "list", "--portal", "initech", "--json").stdout).map((d) => d.name), [
      "initech-brief.html",
    ]);
  });

  it("portals lists them, and --json carries the raw records", () => {
    const listed = JSON.parse(ok(run, "portals", "--json").stdout);
    const slugs = listed.map((p) => p.slug);
    for (const expected of ["acme", "globex", "initech"]) {
      assert.ok(slugs.includes(expected), `${expected} should be listed`);
    }
    assert.equal(listed.find((p) => p.slug === "initech").kind, "restricted");

    const human = ok(run, "portals").stdout;
    assert.match(human, /^SLUG\s+KIND\s+NAME\s+CREATED$/m);
    assert.match(human, /initech/);
  });

  it("a public portal is created as public, and says what that means", () => {
    const r = ok(run, "portal-create", "shopfront", "--name", "Shopfront", "--kind", "public");
    assert.match(r.stderr, /opens with no login, and it burns no Access seat/);
    assert.equal(JSON.parse(ok(run, "portals", "--json").stdout).find((p) => p.slug === "shopfront").kind, "public");
  });

  it("portal-create refuses a duplicate slug and an invalid one", () => {
    const dupe = run("portal-create", "acme");
    assert.equal(dupe.status, 1);
    assert.match(dupe.stderr, /already exists/);

    const bad = run("portal-create", "Not A Slug");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not a valid portal slug/);
  });

  it("share revokes as well as grants, and says the seat outlives the revocation", () => {
    ok(run, "portal-create", "umbrella", "--name", "Umbrella", "--kind", "restricted");
    ok(run, "share", "umbrella", "ceo@umbrella.test", "cfo@umbrella.test");

    const removed = ok(run, "share", "umbrella", "--remove", "cfo@umbrella.test");
    assert.match(removed.stderr, /Removed cfo@umbrella\.test from portal "umbrella"/);
    assert.match(removed.stderr, /Members now: ceo@umbrella\.test$/m);
    assert.doesNotMatch(removed.stderr, /cfo@umbrella\.test.*\n.*Members now.*cfo@/);
    // ADR-002: KV stops authorizing immediately, but Access keeps admitting (and charging for) them
    // until the reconciler runs. Reporting the removal without that is a half-truth.
    assert.match(removed.stderr, /sync-access --reap/);
  });

  it("share with neither a grant nor a revocation prints its usage", () => {
    const r = run("share", "umbrella");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage: pagevault share/);
    assert.match(r.stderr, /--remove/);
  });
});

// ---------------------------------------------------------------------------
// Secured — Cloudflare Access in front. This is rung 3, and its publish
// defaults are the opposite of Public's.
// ---------------------------------------------------------------------------

describe("CLI against a live Worker — Secured (Access enabled)", { timeout: 180_000 }, () => {
  let worker;
  let run;
  let scratch;

  before(async () => {
    worker = await startWorker({ access: true });
    scratch = mkdtempSync(join(tmpdir(), "pv-e2e-secured-"));
    run = makeRunner(worker.base, scratch);
    await createPortal(worker.base, { slug: "acme", name: "Acme Corp", kind: "restricted" });
  });

  after(() => {
    worker?.stop();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("a plain publish is members-only — no public link is minted as a side effect", () => {
    const file = fixture(scratch, "private.html", "<!doctype html><title>Private</title><h1>p</h1>");
    const url = soleUrl(ok(run, "publish", file, "--portal", "acme"));

    assert.doesNotMatch(url, /\/p\//, "Secured must not mint a capability link just because you published");
    assert.match(url, /\/v\/acme\//, "the shareable URL should be the portal viewer path");
    assert.doesNotMatch(run("publish", file, "--portal", "acme", "--confirm").stderr, /Public link/);
  });

  it("--public is opt-in, and link then reports the capability URL", async () => {
    const file = fixture(scratch, "shared.html", "<!doctype html><title>Shared</title><h1>s</h1>");
    const url = soleUrl(ok(run, "publish", file, "--portal", "acme", "--public"));

    assert.match(url, /\/p\//);
    assert.equal((await fetch(url)).status, 200, "a /p/ link must bypass Access entirely");

    const id = JSON.parse(ok(run, "list", "--portal", "acme", "--json").stdout).find((d) => d.name === "shared.html").id;
    assert.equal(soleUrl(ok(run, "link", id)), url);
  });

  it("link on a members-only document says login is required and points at mint", () => {
    const file = fixture(scratch, "members.html", "<!doctype html><title>Members</title><h1>m</h1>");
    ok(run, "publish", file, "--portal", "acme");
    const id = JSON.parse(ok(run, "list", "--portal", "acme", "--json").stdout).find((d) => d.name === "members.html").id;

    const r = ok(run, "link", id);
    assert.match(r.stderr, /requires login \(portal members\)/);
    assert.match(r.stderr, new RegExp(`pagevault mint ${id}`));
  });

  it("publishing with --emails records the grant and echoes it back", () => {
    const file = fixture(scratch, "granted.html", "<!doctype html><title>Granted</title><h1>g</h1>");
    const r = ok(run, "publish", file, "--portal", "acme", "--emails", "cfo@acme.test,vp@acme.test");

    assert.match(r.stderr, /Granted to: cfo@acme\.test, vp@acme\.test/);
    const id = JSON.parse(ok(run, "list", "--portal", "acme", "--json").stdout).find((d) => d.name === "granted.html").id;
    assert.deepEqual(JSON.parse(ok(run, "read", id, "--json").stdout).extraEmails, ["cfo@acme.test", "vp@acme.test"]);
  });
});

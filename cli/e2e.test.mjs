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

  it("edit fixes a typo'd filename: the document moves, the old link redirects, the body survives (#140)", async () => {
    // The bug that started #140, end to end: publish with a typo, correct it, and check that
    // nothing a client is already holding breaks. Its own portal — a rename changes what a
    // listing contains, and the shared fixtures are asserted exhaustively elsewhere.
    //
    // Public, so the forward is observable here: `/v/` is deliberately dead on a no-Access
    // deployment (it answers noPortalsHere), so `/pub/` is the route a rung-1/2 reader uses.
    await createPortal(worker.base, { slug: "renames", name: "Renames", kind: "public" });

    const body = "<!doctype html><title>Q3 Review</title><h1>Q3</h1>";
    const file = fixture(scratch, "q3-reveiw.html", body);
    ok(run, "publish", file, "--portal", "renames");
    const before = JSON.parse(ok(run, "list", "--portal", "renames", "--json").stdout).find(
      (d) => d.name === "q3-reveiw.html",
    );
    const publicUrl = soleUrl(ok(run, "link", before.id));

    // Title-only first: display edits must not move anything.
    ok(run, "edit", before.id, "--title", "Q3 Review (final)");
    const retitled = JSON.parse(ok(run, "read", before.id, "--json").stdout);
    assert.equal(retitled.id, before.id, "a title edit must not move the document");
    assert.equal(retitled.title, "Q3 Review (final)");

    // Now the rename. stdout stays pipe-clean — one URL, the one that now works.
    const renamed = run("edit", before.id, "--name", "q3-review.html");
    assert.equal(renamed.status, 0, renamed.text);
    soleUrl(renamed);
    assert.match(renamed.stderr, /Renamed, so it moved/);

    const listed = JSON.parse(ok(run, "list", "--portal", "renames", "--json").stdout);
    const after = listed.find((d) => d.name === "q3-review.html");
    assert.ok(after, "the document should now be listed under the corrected filename");
    assert.notEqual(after.id, before.id, "renaming must move the document to a new id");
    assert.deepEqual(listed.map((d) => d.name), ["q3-review.html"], "the old document must be gone, not duplicated");

    // The body came with it, byte for byte.
    assert.equal(ok(run, "read", after.id, "--source").stdout, body);

    // ⭐ The two link promises. The /p/ capability URL is untouched — its token was never a
    // function of the id — and the pre-rename portal URL forwards rather than 404ing.
    const stillPublic = await fetch(publicUrl);
    assert.equal(stillPublic.status, 200, "the public link must survive a rename unchanged");

    const old = await fetch(`${worker.base}/pub/renames/${before.id}`, { redirect: "manual" });
    assert.equal(old.status, 301, "the pre-rename URL must forward, not 404");
    assert.equal(old.headers.get("location"), `${worker.base}/pub/renames/${after.id}`);
  });

  it("edit refuses to rename onto a filename another document already uses", async () => {
    await createPortal(worker.base, { slug: "clashes", name: "Clashes", kind: "restricted" });
    fixture(scratch, "taken-a.html", "<!doctype html><title>A</title><h1>a</h1>");
    fixture(scratch, "taken-b.html", "<!doctype html><title>B</title><h1>b</h1>");
    ok(run, "publish", join(scratch, "taken-a.html"), "--portal", "clashes");
    ok(run, "publish", join(scratch, "taken-b.html"), "--portal", "clashes");
    const docs = JSON.parse(ok(run, "list", "--portal", "clashes", "--json").stdout);
    const a = docs.find((d) => d.name === "taken-a.html");

    const r = run("edit", a.id, "--name", "taken-b.html");
    assert.equal(r.status, 1, "renaming onto a taken filename must refuse");
    // No --confirm escape hatch here on purpose — point at the operation that DOES replace.
    assert.match(r.stderr, /already has a document named "taken-b.html"/);
    assert.match(r.stderr, /publish .* --confirm/);
    assert.equal(r.stdout, "", "a failed edit must print nothing to stdout");

    // Both documents are untouched.
    const after = JSON.parse(ok(run, "list", "--portal", "clashes", "--json").stdout);
    assert.ok(after.find((d) => d.name === "taken-a.html"));
    assert.ok(after.find((d) => d.name === "taken-b.html"));
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

  it("views --sync refuses a filtered sync before it queries anything", () => {
    // #127. A per-portal summary would claim to cover the deployment while holding one client,
    // so every document outside it would report a MEASURED zero views — "they never opened it"
    // about documents nobody measured. The guard runs before the Analytics Engine call, which is
    // also why this is assertable here with no Cloudflare credential in the environment.
    for (const flag of ["--portal", "--doc"]) {
      const r = run("views", "--sync", flag, "acme");
      assert.equal(r.status, 1, `views --sync ${flag} should exit 1`);
      assert.match(r.stderr, /cannot be combined with --sync/);
      assert.match(r.stderr, /whole deployment/);
    }
  });

  it("a synced summary reaches the CLI read side, and an unsynced one shows nothing (#127)", async () => {
    // The query half needs a real Analytics Engine and an account-scoped token, so it belongs to
    // the lifecycle run. What is testable here is the half that ships in the Worker: the summary
    // going in over /api and coming back out through `list --json` / `read --json`.
    const file = fixture(scratch, "metrics.html", "<!doctype html><title>Metrics Target</title><h1>m</h1>");
    ok(run, "publish", file, "--portal", "acme");
    const id = JSON.parse(ok(run, "list", "--portal", "acme", "--json").stdout).find(
      (d) => d.name === "metrics.html",
    ).id;

    // Absent before any sync — not zero.
    assert.equal(JSON.parse(ok(run, "read", id, "--json").stdout).views, undefined);

    const res = await fetch(`${worker.base}/api/views/summary`, {
      method: "POST",
      headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" },
      // Dated ahead of the document published a moment ago, so it falls inside the window.
      body: JSON.stringify({
        syncedAt: "2099-01-01T00:00:00.000Z",
        windowDays: 90,
        docs: { [id]: { views: 5, lastViewedAt: "2026-07-28T09:00:00Z", surfaces: { link: 5, public: 0, portal: 0 } } },
      }),
    });
    assert.equal(res.status, 200);

    const doc = JSON.parse(ok(run, "read", id, "--json").stdout);
    assert.equal(doc.views, 5);
    assert.deepEqual(doc.surfaces, { link: 5, public: 0, portal: 0 });
    assert.equal(doc.viewsSyncedAt, "2099-01-01T00:00:00.000Z");

    // Every other document in the portal was measured and had no rows — a real zero.
    const others = JSON.parse(ok(run, "list", "--portal", "acme", "--json").stdout).filter((d) => d.id !== id);
    assert.ok(others.length > 0, "the portal should hold other documents by now");
    assert.ok(
      others.every((d) => d.views === 0),
      "documents inside a synced window report a measured zero, not an absent field",
    );
  });

  it("--help answers for the command, not the whole CLI, and touches no deployment", () => {
    // #126: `<cmd> --help` used to print the top-level wall. `cli/help.test.mjs` pins the map to
    // the dispatch table; this proves the wiring survives against a configured, live deployment —
    // help must short-circuit BEFORE the command runs, not after it has published something.
    const r = run("publish", "--help");
    assert.equal(r.status, 0);
    assert.match(r.stderr, /^Usage: pagevault publish/);
    assert.match(r.stderr, /--confirm\s+required to REPLACE/);
    assert.equal(r.stdout, "", "help is human output — stdout stays the URL channel");
    assert.doesNotMatch(r.stderr, /Set up & deploy:/);
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

  it("share attempts the Access group sync inline — it is not deferred to sync-access", () => {
    // B4 from a fresh-machine run claimed `share` did not sync the group. It does: updatePortalMembers
    // calls syncGroupMembers on every addition. What that run actually hit was a deployment whose
    // config had been clobbered to Tier-0, leaving CF_ACCOUNT_ID and CF_ACCESS_GROUP_ID blank — so the
    // sync had nowhere to go and reported "not_configured".
    //
    // This harness has the same shape on purpose: Access is "enabled" (team + AUD) but there is no
    // account or group id, because Miniflare cannot hold a real Cloudflare Access group. So the
    // assertion is not "the group changed" — it is that the sync was ATTEMPTED and its outcome
    // surfaced, which is the part that was in doubt. The real group mutation is covered by the live
    // lifecycle ritual, where sync-access afterwards reports nothing left to add.
    const r = ok(run, "share", "acme", "newperson@acme.test");
    assert.match(r.stderr, /Granted newperson@acme\.test to portal "acme"/);
    assert.match(r.stderr, /Access group sync: not_configured/,
      "share must report the sync outcome, not stay silent about it");
    // And it must say what that means, in both directions — the bare status is what got misread.
    assert.match(r.stderr, /no Cloudflare Access group on this deployment/i);
    assert.match(r.stderr, /Secured: the deployment is misconfigured/);
  });

  it("publishing with --emails records the grant and echoes it back", () => {
    const file = fixture(scratch, "granted.html", "<!doctype html><title>Granted</title><h1>g</h1>");
    const r = ok(run, "publish", file, "--portal", "acme", "--emails", "cfo@acme.test,vp@acme.test");

    assert.match(r.stderr, /Granted to: cfo@acme\.test, vp@acme\.test/);
    const id = JSON.parse(ok(run, "list", "--portal", "acme", "--json").stdout).find((d) => d.name === "granted.html").id;
    assert.deepEqual(JSON.parse(ok(run, "read", id, "--json").stdout).extraEmails, ["cfo@acme.test", "vp@acme.test"]);
  });
});

// ---------------------------------------------------------------------------
// `verify` — the command whose entire job is telling you whether a deployment
// works, and which until now had no automated coverage at all.
//
// It repeatedly reported success it had not earned: passing while skipping every
// authenticated check, and passing with a recorded failure sitting inside its own
// JSON. Both shipped, and both were found by a human driving a real install. The
// invariant these tests exist to hold is small and absolute — **the verdict must
// agree with the checks** — and it is asserted on every scenario below, not just
// the ones designed to fail.
// ---------------------------------------------------------------------------

/**
 * Drive `pagevault verify --json` against a booted Worker with a synthetic deployment context.
 *
 * `verify` reads its target from `.pagevault.json`, not from PAGEVAULT_URL, so the context is
 * written rather than passed — which is also what lets a test claim `rung: 3` against a Worker that
 * has no Access, the exact drift a clobbered deployment produces. HOME and PAGEVAULT_HOME are both
 * redirected so the operator's real config can never supply a bearer this test did not choose.
 */
function runVerify(base, { rung = 1, bearer = BEARER, deployed = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "pv-verify-"));
  const ctx = { rung, ownerEmail: OWNER, accountId: "acct", schemaVersion: 1 };
  if (deployed) ctx.deployedUrl = base;
  writeFileSync(join(home, ".pagevault.json"), `${JSON.stringify(ctx, null, 2)}\n`);
  if (bearer) writeFileSync(join(home, ".env.local"), `PAGEVAULT_API_TOKEN=${bearer}\n`);

  const r = spawnSync(process.execPath, [BIN, "verify", "--json"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PAGEVAULT_HOME: home, PAGEVAULT_URL: "", PAGEVAULT_API_TOKEN: "" },
  });
  rmSync(home, { recursive: true, force: true });

  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* a crash, or non-JSON on stdout — the assertions below will say so */
  }
  return { status: r.status ?? 1, json, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * The invariant. A verdict that disagrees with its own checks is the bug class this suite exists
 * for, so it is asserted on every run regardless of what that run was testing.
 */
function verdictAgreesWithChecks({ status, json }) {
  assert.ok(json, "verify --json must emit parseable JSON on stdout");
  const decisive = (json.checks ?? []).filter((c) => !c.advisory);
  const expected = decisive.every((c) => c.ok);
  assert.equal(json.ok, expected, `ok:${json.ok} but decisive checks were ${JSON.stringify(decisive)}`);
  assert.equal(status, json.ok ? 0 : 1, "exit code must match the verdict — scripts read the code, not the JSON");
}

describe("verify against a live Worker", { timeout: 180_000 }, () => {
  let worker;

  before(async () => {
    // No Access, so root serves the landing page. A rung-1 context expects exactly that; a rung-3
    // context expects a redirect and will therefore fail — which is the drift test below.
    worker = await startWorker({ access: false });
  });

  after(() => worker?.stop());

  it("passes a healthy deployment, and every check it claims to have run is in the JSON", () => {
    const r = runVerify(worker.base);
    verdictAgreesWithChecks(r);
    assert.equal(r.status, 0, `expected a pass, got:\n${r.stdout}${r.stderr}`);

    // The checks that make this command worth running: it proved the Worker is ours, that /mcp
    // speaks the protocol, and that a document can be written and read back through the MCP tools.
    const names = r.json.checks.map((c) => c.name);
    for (const required of ["worker_live", "root", "mcp_initialize", "mcp_tools", "mcp_roundtrip"]) {
      assert.ok(names.includes(required), `${required} should have run`);
    }
    assert.equal(r.json.checks.find((c) => c.name === "mcp_roundtrip").ok, true);
  });

  it("FAILS when a check fails, rather than warning and exiting 0", () => {
    // The regression. A rung-3 context against a Worker with no Access is precisely the shape of a
    // Secured deployment redeployed with a Tier-0 config: root stops redirecting to /admin. That
    // check recorded false, printed a yellow "!", and the run finished green — so `--json` said
    // ok:true with a failed check inside it, and a script reading the exit code saw success.
    const r = runVerify(worker.base, { rung: 3 });
    verdictAgreesWithChecks(r);

    assert.equal(r.status, 1, "a Secured deployment not redirecting root must fail");
    assert.equal(r.json.ok, false);
    assert.equal(r.json.checks.find((c) => c.name === "root").ok, false);
    // Everything else was healthy — the point is that one decisive failure is enough.
    assert.equal(r.json.checks.find((c) => c.name === "worker_live").ok, true);
  });

  it("refuses to pass when it has no bearer to authenticate with", () => {
    // It used to report "Deployment verified" here, having tested none of the MCP surface, the write
    // path, or authentication. A verifier that cannot run its checks has no verdict to give.
    const r = runVerify(worker.base, { bearer: null });
    verdictAgreesWithChecks(r);
    assert.equal(r.status, 1);
    assert.equal(r.json.reason, "no_bearer");
    assert.ok(!(r.json.checks ?? []).some((c) => c.name === "mcp_roundtrip"), "it must not claim a round-trip it never ran");
  });

  it("fails on a bearer the Worker rejects, and says which stage broke", () => {
    const r = runVerify(worker.base, { bearer: "not-the-right-token" });
    verdictAgreesWithChecks(r);
    assert.equal(r.status, 1);
    assert.equal(r.json.reason, "mcp_initialize");
  });

  it("reports nothing-deployed instead of probing a URL it does not have", () => {
    const r = runVerify(worker.base, { deployed: false });
    assert.equal(r.status, 1);
    assert.equal(r.json?.reason, "not_deployed");
  });

  it("an absent OAuth server is advisory — it does not sink an otherwise healthy run", () => {
    // oauth_discovery is reported as a fact, not a fault: a bearer-only deployment legitimately has
    // none. Whatever this deployment answers, the check must never be the reason a run fails.
    const r = runVerify(worker.base);
    const oauth = r.json.checks.find((c) => c.name === "oauth_discovery");
    assert.ok(oauth, "oauth_discovery should be reported either way");
    if (!oauth.ok) assert.equal(oauth.advisory, true, "a failing oauth_discovery must be marked advisory");
    assert.equal(r.json.ok, true);
  });
});

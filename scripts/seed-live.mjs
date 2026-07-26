#!/usr/bin/env node
//
// Seed a LIVE deployment with a realistic client engagement, through the CLI.
//
//   node scripts/seed-live.mjs                 # act on .pagevault.json + .env.local
//   node scripts/seed-live.mjs --url https://… --token …
//   node scripts/seed-live.mjs --json          # machine-readable result, for the lifecycle skill
//
// The sibling of `scripts/demo.sh`, with two deliberate differences:
//
//   · demo.sh curls a LOCAL `wrangler dev`. This targets whatever you actually deployed, so it is
//     the step that proves a real Worker on real KV behind real Access serves real documents.
//   · demo.sh posts to /api directly. This shells out to `cli/bin/pagevault.mjs`, so seeding is
//     itself CLI coverage against the deployment — the publish path a human uses, not a curl the
//     CLI might have drifted from.
//
// It publishes with --confirm throughout, so re-running updates in place rather than colliding.
// Every document is drawn from examples/, which ships with the repo.
//
// It ends by printing the URLs a human has to open by eye — the sandbox rendering, the Access
// login wall, the public link — because those are exactly the checks no script can make.
//
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { argValue, fromEnv, loadContext, c, ok, info, warn, die } from "../cli/lib/provision/context.mjs";

const BIN = fileURLToPath(new URL("../cli/bin/pagevault.mjs", import.meta.url));
const JSON_MODE = process.argv.includes("--json");

// Human narration goes to stderr so `--json` keeps stdout clean, the same split the CLI itself uses.
const say = (s = "") => {
  if (!JSON_MODE) console.log(s);
};

// --- Where ------------------------------------------------------------------

const ctx = loadContext();
const url = (argValue("--url") ?? process.env.PAGEVAULT_URL ?? ctx.deployedUrl ?? (ctx.host ? `https://${ctx.host}` : "")).replace(/\/+$/, "");
const token = argValue("--token") ?? process.env.PAGEVAULT_API_TOKEN ?? fromEnv("PAGEVAULT_API_TOKEN") ?? "";

if (!url) die("No deployment to seed.", "Deploy first, or pass --url https://pagevault.you.com");
if (!token) die("No PAGEVAULT_API_TOKEN.", "It lands in .env.local at deploy; or pass --token <bearer>.");

const env = { ...process.env, PAGEVAULT_URL: url, PAGEVAULT_API_TOKEN: token };

/** Run the CLI. Returns { status, stdout, stderr }; never throws, so a partial seed still reports. */
function cli(...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env });
  return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

/** Portals have no CLI verb yet, so this one call goes over the API. See the note at the bottom. */
async function ensurePortal(slug, name, kind, description) {
  const res = await fetch(`${url}/api/portals`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ slug, name, kind, description }),
  });
  if (res.ok) return "created";

  // Already there is success for a re-run — and this seed is meant to be re-run. Key on the
  // server's error CODE, not its status: `portal_exists` comes back as a 400, so a status check
  // would make the second run of an idempotent script fail.
  const body = await res.json().catch(() => ({}));
  if (body?.code === "portal_exists") return "existing";
  die(`Couldn't create portal "${slug}" (HTTP ${res.status})`, `  ${JSON.stringify(body).slice(0, 300)}`);
}

// --- The corpus -------------------------------------------------------------
//
// Chosen so each document proves something different, not just to have volume:
//   a styled single-file page · a long markdown source · remote images inside the sandbox ·
//   a live Chart.js artifact that runs JS from a CDN · an owner-only draft · a public link.

const scratch = mkdtempSync(join(tmpdir(), "pv-seed-"));

// A live Chart.js artifact — JavaScript from a CDN, which is what an LLM actually produces. If the
// sandbox is right this renders and still cannot reach the API, the cookies, or the shell (ADR-007).
const chartHtml = `<!doctype html><html><head><meta charset="utf-8">
<title>Q3 Engineering Review</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>body{font:15px/1.6 system-ui;margin:2rem;max-width:52rem}h1{letter-spacing:-.02em}
.note{background:#eef1f5;padding:1rem;border-radius:6px;color:#33425c}</style></head>
<body>
<h1>Q3 Engineering Review</h1>
<p>Deployment frequency rose through the quarter as the QA restructure landed.</p>
<canvas id="c" height="120"></canvas>
<p class="note"><strong>This is a live Chart.js artifact.</strong> It runs JavaScript and pulls a
library from a CDN — and it is sealed in a sandboxed iframe with an opaque origin. If you can see
the chart, the sandbox is permissive enough to be useful. It still cannot read your session, call
the PageVault API, or touch the page around it.</p>
<script>
new Chart(document.getElementById('c'), {
  type: 'line',
  data: { labels: ['Jul','Aug','Sep'], datasets: [{
    label: 'Deploys / week', data: [4, 11, 23],
    borderColor: '#34507a', backgroundColor: 'rgba(52,80,122,.11)', fill: true, tension: .3 }]},
  options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
});
</script>
</body></html>`;

const chartPath = join(scratch, "q3-engineering-review.html");
writeFileSync(chartPath, chartHtml);

const draftPath = join(scratch, "2027-roadmap.html");
writeFileSync(
  draftPath,
  `<!doctype html><meta charset="utf-8"><title>2027 Platform Roadmap</title>
<h1>2027 Platform Roadmap</h1><p><strong>Draft — not for the client.</strong> If you are not the
owner and you can read this, owner-only drafts are broken and that is an incident.</p>`,
);

const CORPUS = [
  {
    portal: "acme",
    file: "examples/pagevault-features.html",
    title: "Platform Overview",
    summary: "What the platform does and how the pieces fit together.",
    tags: "type:overview",
    proves: "a styled single-file page renders in the shell",
  },
  {
    portal: "acme",
    file: "examples/artemis-program-overview.md",
    title: "Technical Primer",
    summary: "Long-form markdown: headings, tables, footnotes, math.",
    tags: "type:primer",
    proves: "markdown is rendered server-side, and read --source round-trips",
  },
  {
    portal: "acme",
    file: "examples/remote-image-test.html",
    title: "Remote Image Handling",
    summary: "Images loaded from third-party origins inside the sandbox.",
    tags: "type:test",
    proves: "remote images load inside a sandboxed iframe",
  },
  {
    portal: "acme",
    file: chartPath,
    title: "Q3 Engineering Review",
    summary: "Velocity and incident load, as a live Chart.js artifact.",
    tags: "type:report,decision",
    proves: "CDN JavaScript runs in the sandbox — the ADR-007 proof",
  },
  {
    portal: "acme",
    file: draftPath,
    title: "2027 Platform Roadmap",
    summary: "Not ready for the client.",
    tags: "type:roadmap",
    ownerOnly: true,
    proves: "an owner-only draft is invisible to a client identity",
  },
  {
    portal: "acme",
    file: "examples/pagevault-comparison.html",
    title: "How We Work",
    summary: "Engagement model and cadence — shared as a public link.",
    tags: "type:overview",
    public: true,
    proves: "a /p/ capability link opens with no login and burns no Access seat",
  },
  {
    // A SECOND restricted portal, and the only reason it exists: cross-portal isolation is prime
    // directive #5, and one restricted portal cannot test it. An Acme member must be refused here.
    // `notes` is no substitute — it is `kind: "public"`, so canView grants everyone by design.
    portal: "globex",
    file: "examples/remote-image-test.md",
    title: "Globex Migration Notes",
    summary: "A second client. Nothing in here may ever appear under Acme.",
    tags: "type:notes",
    proves: "cross-portal isolation — an Acme member must be DENIED this, not merely not shown it",
  },
  {
    portal: "notes",
    file: "examples/welcome.html",
    title: "Why HTML is the best universal document format",
    summary: "Public writing. No login, no seat, no wall.",
    tags: "type:essay",
    proves: "a public PORTAL serves a whole collection from /pub, which Access never sees",
  },
];

// --- Seed -------------------------------------------------------------------

say(`\n${c.head("PageVault — seed a live deployment")}  ${c.dim(url)}\n`);

// This writes documents to whatever .pagevault.json points at, which is a REAL deployment — so
// name the target and get a yes first, exactly as `deploy` does. `--yes` (and `--json`, which the
// lifecycle skill drives) skips the prompt; a non-TTY has nothing to ask.
if (!JSON_MODE && !process.argv.includes("--yes") && process.stdin.isTTY) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`  Publish ${CORPUS.length} documents to ${c.bold(url)}? [y/N] `)).trim().toLowerCase();
  rl.close();
  if (ans !== "y") die("Cancelled — nothing was published.");
  say();
}

const portals = [
  ["acme", "Acme Corp", "restricted", "Data platform engagement. Deliverables and decision records, newest first."],
  ["globex", "Globex", "restricted", "A second client, so cross-portal isolation is actually testable."],
  ["notes", "Notes", "public", "Public writing. No login, no seat, no wall."],
];
for (const [slug, name, kind, description] of portals) {
  const state = await ensurePortal(slug, name, kind, description);
  say(`  ${c.green("✓")} portal ${c.bold(slug)} ${c.dim(`(${kind}, ${state})`)}`);
}
say();

const results = [];
let failed = 0;

for (const doc of CORPUS) {
  if (!existsSync(doc.file)) {
    warn(`skipped ${doc.file} — not found (run from the repo root)`);
    failed++;
    continue;
  }

  const args = ["publish", doc.file, "--portal", doc.portal, "--title", doc.title, "--summary", doc.summary, "--tags", doc.tags, "--confirm"];
  if (doc.ownerOnly) args.push("--owner-only");
  if (doc.public) args.push("--public");

  const r = cli(...args);
  if (r.status !== 0) {
    say(`  ${c.red("✗")} ${doc.title} — ${r.stderr.split("\n")[0]}`);
    results.push({ ...doc, ok: false, error: r.stderr });
    failed++;
    continue;
  }

  // stdout is the one shareable URL; everything human went to stderr.
  results.push({ portal: doc.portal, title: doc.title, url: r.stdout, ownerOnly: !!doc.ownerOnly, public: !!doc.public, proves: doc.proves, ok: true });
  say(`  ${c.green("✓")} ${doc.title.padEnd(46)} ${c.dim(r.stdout)}`);
}

// --- What a machine cannot check --------------------------------------------

const rung = ctx.rung ?? 1;
const publicLink = results.find((r) => r.public)?.url;
const draft = results.find((r) => r.ownerOnly);

if (JSON_MODE) {
  process.stdout.write(
    `${JSON.stringify({ ok: failed === 0, url, rung, portals: portals.map(([s]) => s), documents: results, failed }, null, 2)}\n`,
  );
} else {
  say(`\n${"─".repeat(72)}`);
  say(`  ${c.bold("OPEN THESE BY EYE")} — the checks no script can make\n`);
  say(`  ${c.bold("1.")} The client portal, the only page a client ever sees:`);
  say(`       ${c.cyan(`${url}/v/acme`)}`);
  say(`       ${c.dim("Newest first, grouped by month. The 2027 draft should be badged for you")}`);
  say(`       ${c.dim("and absent entirely for a client identity.")}\n`);
  say(`  ${c.bold("2.")} The sandbox proof — open "Q3 Engineering Review" from that page.`);
  say(`       ${c.dim("The chart must RENDER (CDN JavaScript ran) and the page around it must")}`);
  say(`       ${c.dim("be untouched. A blank box means the sandbox is too tight; a broken")}`);
  say(`       ${c.dim("shell means it is too loose.")}\n`);
  if (publicLink) {
    say(`  ${c.bold("3.")} A public capability link — open it ${c.bold("logged out")} (private window):`);
    say(`       ${c.cyan(publicLink)}`);
    say(`       ${c.dim("No login, no Access seat. If this shows a login wall, /p/ is broken.")}\n`);
  }
  say(`  ${c.bold("4.")} A public PORTAL — a whole collection, served from /pub:`);
  say(`       ${c.cyan(`${url}/pub/notes`)}`);
  say(`       ${c.dim("Access never sees this path. Open it logged out too.")}\n`);
  if (rung >= 3) {
    say(`  ${c.bold("5.")} ${c.bold("Secured only")} — the identity checks, which need a browser:`);
    say(`       ${c.dim("· open")} ${c.cyan(`${url}/v/acme`)} ${c.dim("logged out → an Access login wall, not the portal")}`);
    say(`       ${c.dim("· log in as the owner  → all 6 documents, the draft badged")}`);
    say(`       ${c.dim("· log in as a client   → 5 documents, NO draft")}`);
    say(`       ${c.dim("· as that client, open")} ${c.cyan(`${url}/v/globex`)} ${c.dim("→ DENIED (prime directive #5)")}`);
    say(`       ${c.dim("  /v/notes is NOT this test — that portal is kind:public, so everyone sees it")}`);
    say(`       ${c.dim("· the console:")} ${c.cyan(`${url}/admin`)} ${c.dim("→ version footer matches your build")}`);
    if (draft) say(`       ${c.dim("· the draft's URL, as a client → denied, not merely hidden:")}\n         ${c.dim(draft.url)}`);
    say();
  }
  say(`${"─".repeat(72)}\n`);

  if (failed) warn(`${failed} document(s) did not publish — see above.`);
  else ok(`Seeded ${results.length} documents across ${portals.length} portals.`);

  // A parity gap worth re-reading every time this runs: MCP can create a portal, the CLI cannot,
  // so the two portals above went in over /api rather than through the binary under test.
  info(`Portals were created over /api — the CLI still has no ${c.bold("portal create")} verb (MCP does).`);
  say();
}

process.exit(failed ? 1 : 0);
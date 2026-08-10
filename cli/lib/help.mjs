//
// Per-command help (#126).
//
// `pagevault <cmd> --help` used to print the whole top-level usage wall and leave the reader to
// find their command in it — at exactly the moment they are least able to skim, because something
// just did not behave. Reaching for `<cmd> --help` is the first thing anyone does.
//
// One entry per command, and it is the SINGLE source for both surfaces:
//   · `usage`  — the invocation form(s). Thrown by the command's missing-argument guard, and the
//                first thing `--help` prints. So the guard and the help can never drift.
//   · `detail` — what `--help` adds: flags, and what the non-obvious ones actually do.
//
// Data only, no side effects, so `cli/help.test.mjs` can assert every dispatched command has an
// entry. That test is the point: a command added without help would otherwise fail silently, and
// this repo has learned that a check which cannot fail is worse than no check.
//

// The one exception to "data only": the set of commands `protected` gates is a fact about the code,
// not a sentence about it, and this file was one of four places restating it from memory (#176).
import { PROTECTED_COMMANDS } from "./registry.mjs";

const H = (usage, detail = "") => ({ usage, detail });

export const HELP = {
  // --- Set up & deploy ---------------------------------------------------------------------
  init: H(
    "Usage: pagevault init [--tier public|secured] [--host h] [--email you@example.com] [--cf-token t] [--yes]",
    `
Stand PageVault up on your own Cloudflare account — no repo clone. Walks you through the
Cloudflare API token, the tier, the owner email and the account, writes state to ~/.pagevault/,
deploys the bundled Worker, and saves your login config so \`publish\` works immediately.

Re-run it to climb a tier. It shows your current answers and asks only for what is new; your
documents carry across keeping their ids and filenames.

  --tier public|secured   Public = links anyone can open. Secured = named people, via Access
  --host pagevault.you.com  the hostname. Required for Secured, optional for Public
  --email you@example.com   the owner — the identity that can always see everything
  --rung 1|2|3            the escape hatch: 1 = workers.dev, 2 = your domain, 3 = Secured
  --cf-token <token>      your CLOUDFLARE API token, instead of saving it to .env.local first
  --analytics             turn view tracking on — rung 3 asks, rungs 1–2 default off
  --yes                   never prompt; flags and the environment supply every answer

⚠ --cf-token is the CLOUDFLARE credential — the one that provisions. \`login --token\` is the
  PageVault bearer. Two different secrets; the flags are named apart on purpose.

⚠ --yes on a FIRST deployment also needs a bearer. Non-interactively there is nobody to show a
  freshly minted PAGEVAULT_API_TOKEN to, so init refuses rather than deploying a Worker you
  cannot authenticate to. Either run it interactively once, or provide your own:

    export PAGEVAULT_API_TOKEN=$(openssl rand -hex 32)
    pagevault init --yes --tier public --email you@example.com`,
  ),

  upgrade: H(
    "Usage: pagevault upgrade [--yes] [--analytics|--no-analytics]",
    `
Redeploy the Worker bundle that shipped with your installed package — the second half of
\`npm update -g pagevault\`. Keeps your KV data, config and secrets, and never rotates a live
bearer.

  --yes             skip the confirmation, and confirm a deployment marked --protected
  --analytics       turn view tracking ON (needs Analytics Engine enabled on the account)
  --no-analytics    turn view tracking OFF, deliberately

On a deployment registered with \`login --protected\`, upgrade refuses without --yes. It replaces
the code that deployment is running, and nothing on this machine can put the old code back.

Neither analytics flag is the normal case. Left alone, an upgrade keeps view tracking exactly as
the deployment already has it — so a redeploy can never quietly drop it. Passing --no-analytics is
the only way to switch it off, because doing that by accident costs data nothing can recover:
Analytics Engine keeps about 90 days and there is no backfill.`,
  ),

  login: H(
    "Usage: pagevault login [--url https://share.example.com] [--token <PAGEVAULT_API_TOKEN>] [--as <name>] [--protected]",
    `
Point the CLI at a deployment: writes ~/.pagevault/config.json (mode 600 — it holds a bearer)
and proves the connection works now rather than at your first publish.

Both flags are optional — they fall back to PAGEVAULT_URL and PAGEVAULT_API_TOKEN, so
\`pagevault login\` alone persists the environment you already have exported.

\`init\` already does this for the deployment it stood up. Reach for \`login\` only for a second
machine, or for someone else's deployment.

  --as <name>           register it by NAME in ~/.pagevault/deployments.json instead, so this
                        machine can hold several deployments at once — a production instance
                        deployed by CI and a test one you deploy from a checkout.
  --protected           on this deployment, ${PROTECTED_COMMANDS.join("/")} require an explicit --yes.
                        --no-protected clears it. Needs --as; there is nowhere else to put it.

Without --as nothing changes: one deployment, one config.json, exactly as before. With it, the
bearer travels with the deployment, so a command can never pair one deployment's URL with
another's credential.

Re-running it on a deployment already registered amends that entry, so the credentials need not be
retyped to change a flag:

  pagevault login --as prod --protected

\`--as\` does not steal the default from a login that describes a different deployment. When it
declines, it says so, and \`pagevault use <name>\` is one word away.`,
  ),

  deployments: H(
    "Usage: pagevault deployments [--json]",
    `
Everything this machine can reach, with \`*\` marking the default. The login config is listed
too, as the implicit deployment it has always been.

PROVISIONED means the build record is on THIS machine, so \`upgrade\`, \`destroy\` and \`backup\`
can run. Its absence is a fact about the deployment — the normal state for one deployed by CI —
not a fault.

Which one a command acts on, in order:

  --deployment <name>       explicit
  PAGEVAULT_DEPLOYMENT      environment (direnv, CI, a one-off export)
  the checkout you are in   .pagevault.json, found by walking up from where you stand
  the default               \`*\` above, set by \`pagevault use\`
  the login config          ~/.pagevault/config.json

Standing somewhere is the guardrail: inside a checkout you get that checkout's deployment
whether or not you remember to say so.`,
  ),

  use: H(
    "Usage: pagevault use <name>",
    `
Make a registered deployment the default — the rung below the project marker, so it decides
everywhere except inside a checkout that names its own.

Writes ~/.pagevault/deployments.json and nothing else. No file in a working tree is touched, and
no bearer is ever written into a repository — a gitignore is one \`git add -f\` from being wrong.

  pagevault deployments     see what is registered
  pagevault login --as <name> --url … --token …    register one`,
  ),

  // --- Publish & manage documents ----------------------------------------------------------
  publish: H(
    "Usage: pagevault publish <file.html|.md> [--portal s] [--name f] [--title t] [--public] …",
    `
Publish a file and print its shareable URL to stdout — and nothing else, so
\`pagevault publish report.html | pbcopy\` does the obvious thing. Everything human goes to stderr.

  --portal <slug>         which portal to publish into (default: your default portal)
  --name <filename>       THE UPDATE KEY. Identity is the filename (ADR-017), not the title —
                          publishing the same name again replaces that document in place, at
                          the same URL. Defaults to the file's basename
  --title "Q3 Review"     display only. Changing it does not create a new document
  --summary "…"           one line, shown in listings and used by search
  --tags a,b,c            comma-separated
  --emails a@b,c@d        grant these people access to this document
  --source-kind html|markdown   override the extension sniff
  --public                also mint a /p/ capability link — anyone holding it can open the
                          document with no login. It burns no Cloudflare Access seat
  --owner-only            a draft. It opens for nobody but you
  --confirm               required to REPLACE an existing document with the same --name.
                          Without it, a same-name publish stops and shows you the options`,
  ),

  list: H(
    "Usage: pagevault list [--portal s] [--tag t] [--json]",
    `
Every document you can see, newest first: id, filename, portal, title, created date, and whether
it is a draft or has a public link.`,
  ),

  read: H(
    "Usage: pagevault read <id> [--source] [--json]",
    `
A document's metadata — portal, filename, format, visibility, and its shareable link.

  --source   print the STORED BODY to stdout byte-for-byte (the original .md, or the HTML), so
             \`pagevault read <id> --source > report.md\` round-trips
  --json     the metadata as an object`,
  ),

  edit: H(
    "Usage: pagevault edit <id> [--name f] [--title t] [--summary s] [--tags a,b]",
    `
Fix a published document's filename, title, summary or tags. Not its contents — republish the
file for those.

  --name <filename>   THE IDENTITY (ADR-017). Renaming MOVES the document to a new URL: the old
                      one redirects for a year, and any public /p/ link keeps working unchanged
  --title "Q3 Review" display only. Changing it never moves the document
  --summary "…"       one line, shown in listings and used by search. --summary "" clears it
  --tags a,b,c        replaces the existing tags. --tags "" clears them

Only the flags you pass are changed. Renaming onto a filename another document already uses is
refused outright — there is no --confirm here, because finishing a rename by destroying a
different deliverable is never what was meant. Replace a document deliberately instead:

  pagevault publish <file> --name <that-filename> --confirm

The new URL is printed to stdout: \`pagevault edit <id> --name q3.md | pbcopy\`.`,
  ),

  link: H(
    "Usage: pagevault link <id>",
    `
Print the document's shareable URL to stdout and nothing else — \`pagevault link <id> | pbcopy\`.
A public document hands back its /p/ capability link; otherwise the portal viewer URL, which
requires a login.`,
  ),

  search: H(
    "Usage: pagevault search <portal> <query …> [--limit N] [--json]",
    `
Full-text search within ONE portal. The portal is required on purpose: a cross-client grep is how
one client's material ends up in another client's answer (prime directive #5).`,
  ),

  mint: H(
    "Usage: pagevault mint <id>",
    `
Mint a public /p/ link for an existing document, without re-uploading it.

⚠ WIDENING. Anyone who receives, forwards or finds that URL can open the document with no login.
  It burns no Cloudflare Access seat. Undo it with \`pagevault revoke <id>\`.`,
  ),

  revoke: H(
    "Usage: pagevault revoke <id>",
    `
Kill a document's public /p/ link. The document itself is untouched and portal members keep
seeing it — to delete the document, use \`pagevault rm <id>\`.`,
  ),

  rotate: H(
    "Usage: pagevault rotate <id>",
    `
Replace a document's public link with a fresh one, atomically. The previous /p/ URL dies
immediately; the new one is just as public.`,
  ),

  rm: H(
    "Usage: pagevault rm <id> [--yes]",
    `
Delete the document. There is no undo, and no backup unless you made one.

  --yes   skip the confirmation. Required when there is no terminal to ask at`,
  ),

  export: H(
    "Usage: pagevault export [dir] [--portal s] [--include-drafts] [--zip]",
    `
Walk away with the CONTENT: a browsable folder — index.html, an ACCESS.md spelling out who could
see what, and one standalone file per document. Every file opens with no PageVault and no server.

Intentionally lossy and NOT a restore format: document ids and /p/ tokens are left out. For
same-host disaster recovery use \`pagevault backup\`.

  --portal <slug>     just one client
  --include-drafts    owner-only drafts too (excluded by default)
  --zip               one file instead of a folder`,
  ),

  // --- Portals -------------------------------------------------------------------------------
  portals: H(
    "Usage: pagevault portals [--json]",
    `
Your portals — the client boundary, and the thing permissions actually live on. Document counts
are deliberately not fetched: that is a KV list() per portal, and those have their own 1000/day
quota. Use \`pagevault list --portal <slug>\` instead.`,
  ),

  "portal-create": H(
    'Usage: pagevault portal-create <slug> [--name "Acme Corp"] [--kind private|restricted|public] [--description "…"]',
    `
  --kind restricted   a client portal — its members see everything in it
  --kind private      yours only (the default)
  --kind public       anyone with the link, no login, and it burns no Access seat

Prints the slug to stdout, so a script can publish into it immediately.`,
  ),

  "portal-delete": H(
    "Usage: pagevault portal-delete <slug> [--cascade] [--yes]",
    `
Delete a portal. Without --cascade it refuses on a portal that holds documents, and names them —
that refusal is the safety feature, not an obstacle to route around.

  --cascade         delete the documents in it too. No undo; the /p/ and /v/ links go with them
  --yes             skip the confirmation (required in a script)

The confirmation matches the blast radius. An empty portal asks y/N. A cascading delete makes you
type the slug back, after naming what it is about to destroy — the same gesture \`destroy\` uses,
because "3 documents" and "fourteen months of an engagement" are different decisions.

Take a copy first if there is any doubt:  pagevault export --portal <slug>

On a deployment registered with \`login --protected\`, this needs an explicit --yes.

There is no MCP tool for this, deliberately — see ADR-026. An agent may create and share; it may
not end a client boundary.`,
  ),

  share: H(
    `Usage: pagevault share <portal> <email> [email …]     grant access
       pagevault share <portal> --remove a@b,c@d     revoke it`,
    `
Permissions live on the PORTAL, not the document — so adding someone to a client's team is one
write, not one per document.

A removal takes effect in KV immediately, but Cloudflare Access keeps admitting them (and keeps
charging a seat) until the reconciler runs: \`pagevault sync-access --reap\`.`,
  ),

  // --- Operate your deployment ---------------------------------------------------------------
  status: H(
    "Usage: pagevault status [--json]",
    `
What THIS INSTALL is configured for — the tier, owner, account, host and KV id recorded in
~/.pagevault/. Local only: it makes no network call, so it describes your saved answers, not the
running deployment. To confirm the two agree, use \`pagevault health\`.

  --json   the same facts as an object, tagged "source": "local"`,
  ),

  verify: H(
    "Usage: pagevault verify [--json]",
    `
Smoke-test the live deployment end to end — run it after \`init\` or \`upgrade\`. Checks that the
Worker is ours, that the root serves, that /health reports the build you shipped, that /mcp
answers, and that a publish → rename → read → revoke round-trip works through the MCP tools. The
rename leg checks that the document's id actually moved — that is what renaming means, and a
same-id "rename" is the one failure the rest of the round-trip would pass straight through.

The round-trip's own documents are owner-only drafts under unique per-run filenames, revoked on the
way out. If a run dies partway it warns and names the draft to delete; it never blocks the next run.

It publishes a sample document so you have something to open. That matters during a recovery:
restore BEFORE you verify, or the sample's keys will be sitting in the namespace when the restore
asks what to do about them.`,
  ),

  health: H(
    "Usage: pagevault health [--json]",
    `
Ask the live deployment what code it is running (/health) and assert it matches the build this
install ships. Exits non-zero on a mismatch or an unreachable deployment, so CI fails loudly
instead of going green on a rollout that silently did not take.`,
  ),

  "sync-access": H(
    "Usage: pagevault sync-access [--reap] [--yes] [--json]",
    `
Reconcile the Cloudflare Access viewer group with KV. Secured deployments only; on Public it
reports that there is no group, which is expected.

  --reap   also REMOVE people KV no longer authorizes, freeing their Access seat. A real
           revocation — recoverable by re-granting, but confirm it
  --yes    skip the --reap confirmation`,
  ),

  views: H(
    "Usage: pagevault views [--by doc|portal|day|surface|referrer] [--days 30] [--portal s] [--doc id] [--live] [--who] [--json]",
    `
How much your documents were read. Reads the summary stored in your deployment — so it needs only
your PageVault bearer, no Cloudflare token and no account id, and it works from any machine that
can reach the deployment, including one that did not provision it.

The summary ACCUMULATES. Analytics Engine keeps ~90 days; the summary keeps everything that has
ever been synced into it, so this reaches further back than a live query can see. It is only as
current as your last \`pagevault sync-views\` — the output says when that was, every time.

  --by <what>      doc (default) · portal · day · surface · referrer. One table each. \`day\` draws the shape,
                   which is the question a column of numbers makes you answer yourself.
  --days <n>       window for the document counts. Default 30.
  --portal <slug>  one client.
  --doc <id>       one document. Referrers are dropped, not narrowed: they aggregate per portal
                   (ADR-023), so printing them under one document would be a wrong answer.

  --live           ask Analytics Engine instead — what has happened since the last sync, and WHO
                   opened it. Needs a Cloudflare token with Account Analytics (Read) and sees only
                   the last 90 days.
  --who            show viewer identities. Implies --live: the summary has never held an identity
                   (ADR-019), so there is nowhere else to get one.
  --account <id>   with --live, the Cloudflare account to query. Defaults to the one this install
                   provisioned; pass it when this machine did not.

Referrers are the linking HOST only, never the page it linked from — that path is someone else's
private context (ADR-023). They carry no date, so they are all-time even when the table above is
windowed, and the output says so.

Automated previews and unfurls fetch the page too, so public numbers read high.

Under --live, a "(portal index)" row is someone landing on a collection page without opening
anything. The summary does not store those, so they appear only there.

Under --live, view records are ACCOUNT-LEVEL and outlive the deployment that wrote them: after a
teardown and rebuild that query shows history the new deployment never created. The stored summary
belongs to the deployment and does not have this problem.

To make the numbers durable — and to let an agent see them — run \`pagevault sync-views\`.`,
  ),

  "sync-views": H(
    "Usage: pagevault sync-views [--days 90] [--account id] [--reset] [--yes] [--json]",
    `
Move view counts out of Analytics Engine and into your deployment, where they last.

This is the write half of \`views\`, and it is a separate command because it does a different kind
of thing: \`views\` looks at a 90-day window, \`sync-views\` rescues that window before it ages out
permanently. As a flag on \`views\` the consequential act looked like an option on the harmless one.
\`views --sync\` still works and always will.

Analytics Engine keeps about three months and nothing takes data off that belt but this command.
The stored summary ACCUMULATES: each run adds the window it could see and never removes what an
earlier one contributed, so your history outlives that retention. Run it at least once every 90
days or lose the tail that ages out uncovered — \`pagevault health\` says how much runway is left.

Counts and surfaces only. Viewer emails stay here, on your machine (ADR-019). read_document and
list_documents then report views, when they were last opened, and which door readers came through
— as of the sync, never live.

  --account <id>   the Cloudflare account to read. Needed when this machine did not provision the
                   deployment; Account Analytics (Read) is enough and cannot deploy or destroy.

  --reset          throw the stored history away and rebuild from this window alone. The one
                   destructive option here: anything older than 90 days is not in Analytics Engine
                   any more and does not come back. Asks first unless --yes.

Whole-deployment by design, so --portal and --doc are refused: a partial summary would report a
MEASURED zero for every document it left out. Defaults to a 90-day window (the table defaults to
30) because "have they ever opened it" is a lifetime question. Costs one KV write.

SCHEDULE IT. Daily is the sensible cadence and one KV write a day is nothing. The WORKER cannot
run this for you — its Analytics Engine binding is write-only, so it cannot read its own metrics
at any schedule (ADR-019). That is a fact about the Worker, not advice against scheduling: since
0.33.0 an operator-side schedule is what keeps history from ageing out uncovered.

Working snippets for launchd, a systemd timer, cron and a scheduled GitHub Action:
docs/setup/scheduling-the-sync.md — including the one that bites everybody, which is that
\`node\` is not on cron's PATH, so even the full path to this command fails without it.`,
  ),

  backup: H(
    "Usage: pagevault backup [--out <file.json>] [--kv <namespace-id>]",
    `
Snapshot the whole KV namespace — documents, portals, members and public-link tokens — to one
JSON file that \`pagevault restore\` replays. Same-host disaster recovery: keys are preserved
byte-for-byte, so document ids and every /p/ link you have already shared survive a restore.

The file carries key metadata but NO secrets. Keep it gitignored anyway.

  --out <file>   default: pagevault-backup-<timestamp>.json
  --kv <id>      a namespace other than the one this install deployed`,
  ),

  restore: H(
    "Usage: pagevault restore <file.json> [--kv <namespace-id>] [--force] [--yes]",
    `
Replay a backup into the KV namespace. A bulk write, NOT a wipe-and-replace: it puts back every
key in the backup and deletes nothing.

So the question it asks first is "what is in here that the backup will NOT replace?" — those keys
survive and mix in with the restored data. If any would, it stops and names them.

  --force   proceed anyway. Nothing is deleted either way; this suppresses the refusal, not the
            facts — the surviving keys are still listed
  --kv <id> restore into a different namespace
  --yes     skip the confirmation prompt

Recovering a lost deployment? Restore BEFORE you verify — \`verify\` publishes a sample document,
and its keys are not in your backup.`,
  ),

  destroy: H(
    "Usage: pagevault destroy [--keep-data]",
    `
Tear the deployment down: the Worker, the DNS record, the Access applications and group, and the
KV namespace with every document in it. Irreversible, and it asks — there is no --yes.

  --keep-data   leave the KV namespace and its documents in place

It lists what it will NOT remove before doing anything — Zero Trust itself, consumed Access
seats, up to three months of view records, and any resource your local state never named.`,
  ),
};

/**
 * The message a missing-argument guard throws: the invocation form, plus a pointer to the rest
 * when there is more to say. Same constant as `--help`, so the two cannot drift.
 */
export function usageError(cmd) {
  const entry = HELP[cmd];
  if (!entry) return `Unknown command: ${cmd}\nRun \`pagevault help\`.`;
  return entry.detail ? `${entry.usage}\nFull help: pagevault ${cmd} --help` : entry.usage;
}

/** The full text for `pagevault <cmd> --help`. Undefined for a command with no entry. */
export function helpText(cmd) {
  const entry = HELP[cmd];
  if (!entry) return undefined;
  return entry.detail ? `${entry.usage}\n${entry.detail}\n` : `${entry.usage}\n`;
}

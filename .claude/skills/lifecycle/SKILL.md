---
name: lifecycle
description: Drive PageVault's full install lifecycle against a real Cloudflare account — Public (no domain) → Public (domain) → Secured — rebuilding from nothing, running every automated check, and stopping at each human checkpoint with links to open. Use before a release, or after touching init/setup/deploy/provision/verify/destroy. Requires the operator to tear the deployment down first.
---

# PageVault — full lifecycle acceptance run

The installed product is `pagevault init` standing a deployment up on someone's own Cloudflare
account (ADR-014). That path touches Cloudflare's API, DNS, Zero Trust, and wrangler — none of
which the test suite can reach. `make test-e2e` covers the CLI against a local Worker; **this covers
everything that only breaks against the real thing.**

It is a ritual, not a test. It takes 20–45 minutes, most of it waiting on DNS and certificates, and
about half the value is in checks only a human with a browser can make.

This file drives the lifecycle from a **repo checkout**, against `node cli/bin/pagevault.mjs`. For
the other half — the installed npm package on a machine that has never seen this project, which
ADR-014 makes the actual product — see [`fresh-machine.md`](fresh-machine.md) and the self-contained
[`fresh-machine-prompt.md`](fresh-machine-prompt.md) you can paste into Claude Code over there.

**One deployment per Cloudflare account.** The Worker name and KV titles are hardcoded, so this
machine and a fresh one cannot both hold a deployment on the same account. Tear down before handing
off in either direction.

## Hard rules

1. **Never run `destroy`.** It is the one command that deletes client data. It refuses
   non-interactively by design, so you cannot run it even if you try. Dan runs it; you wait.
2. **Never run git mutating commands.** Draft `COMMIT_MESSAGE.md`, print the commands, stop.
3. **Stop at every `CHECKPOINT`.** Print the links, say what a pass looks like, and wait for Dan's
   answer before continuing. Do not assume a checkpoint passed.
4. **Always pass `--yes`** to `init`. Without it, `setup` prompts and you will hang.
5. **Log findings as you go** in a running list. Do not stop the run to fix things — finish the
   stage, then report. A finding is anything that surprised you, read badly, or needed a retry.

## Before you start

Confirm with Dan, in one message, and wait:

- **Which deployment** — read `.pagevault.json` (`host`, `accountId`, `rung`) and name it back.
  There is one Worker name (`pagevault`) and one KV title per account, so this run **replaces**
  whatever is on that account. It cannot be run alongside a deployment you want to keep.
- **Which stages** — all three, or just the one that changed.
- **Has he torn it down yet?** If not, give him the command and wait:

  ```bash
  node cli/bin/pagevault.mjs destroy
  ```

  It asks for the hostname, then the word `destroy`. A half-provisioned account masks first-run
  bugs, which is the entire reason this starts from nothing.

Then check the preconditions yourself:

```bash
node -v                                    # must be 22+
node cli/bin/pagevault.mjs status          # what this clone is pointed at
grep -c CLOUDFLARE_API_TOKEN .env.local    # the provisioning credential
grep -c PAGEVAULT_API_TOKEN .env.local     # see the gotcha below — required for --yes
make bundle                                # init deploys the PREBUILT worker, not src
```

`make bundle` is not optional: `pagevault init` runs in bundle mode (ADR-014), so without
`cli/dist/worker.js` it dies on "Bundle mode needs the prebuilt Worker."

## Stage 1 — Public, no domain (rung 1)

```bash
node cli/bin/pagevault.mjs init --yes --rung 1 --email <owner-email>
node cli/bin/pagevault.mjs verify
node cli/bin/pagevault.mjs health --json
node scripts/seed-live.mjs --json
```

Check automatically, and report each as pass/fail:

- `init` exits 0 and prints a `*.workers.dev` URL. First run on a fresh account **registers a
  workers.dev subdomain** — that is permanent and account-wide, so note the name it chose.
- `verify` exits 0. It covers: the Worker is ours, root serves a 200 landing (not a Forbidden),
  `/health` reports `<version>+<sha>`, `/mcp` answers `initialize` + `tools/list`, and a
  publish → read → revoke round-trip through the MCP tools.
- `health --json` version matches `node -p "require('./package.json').version"` plus the short SHA.
- `seed-live --json` returns `ok: true` with 7 documents across 2 portals.
- Every `/p/` URL in the seed output returns **200 with no Authorization header**. Fetch them.
- On rung 1 there is no Access, so a plain publish is public by nature (#111) — every document
  should come back with a `/p/` link, not a `/v/` one.

> **CHECKPOINT 1** — give Dan the workers.dev base URL and ask him to open:
> - `/v/acme` — at rung 1 this should be the *honest* page explaining it needs Access, not a broken
>   or empty portal.
> - the "Q3 Engineering Review" `/p/` link — the Chart.js chart must **render**. That proves the
>   sandbox is permissive enough to be useful while still opaque-origin (ADR-007).
> - the "Technical Primer" `/p/` link — long markdown, rendered server-side: headings, tables,
>   footnotes, math.

## Stage 2 — Public, on your domain (rung 2)

The claim under test is setup's own words: *"Not a one-way door; your documents carry across
untouched."* So capture the corpus first, climb, and compare.

```bash
node cli/bin/pagevault.mjs list --json > /tmp/pv-before.json
node cli/bin/pagevault.mjs init --yes --rung 2 --host <host> --email <owner-email>
node cli/bin/pagevault.mjs verify
node cli/bin/pagevault.mjs list --json > /tmp/pv-after.json
```

- **The documents must survive.** Same ids, same count, same filenames. Diff the two files and say
  so explicitly — this is the stage's whole point.
- `verify` exits 0. A brand-new hostname provisions its own TLS certificate; `verify` polls for 60s
  then tells you to wait. **If it fails on the route, wait two minutes and re-run before calling it
  a failure.** Only a second failure is a finding.
- `workers.dev` must now be **off** for the Worker — rung 2+ serves on the domain only. Confirm the
  old workers.dev URL no longer serves PageVault.
- Links must now be built on the custom host. Re-run the seed and check the URLs changed:

  ```bash
  node scripts/seed-live.mjs --json
  ```

> **CHECKPOINT 2** — ask Dan to open `https://<host>/` and one `/p/` link, and confirm the padlock
> (a valid certificate on the apex of the new hostname).

## Stage 3 — Secured (rung 3)

Needs Zero Trust already enabled on the account, and `CF_RUNTIME_TOKEN` in `.env.local` — without
it the Worker cannot sync the viewer group and email grants silently stop working (deploy warns).

```bash
node cli/bin/pagevault.mjs init --yes --rung 3 --host <host> --email <owner-email>
node cli/bin/pagevault.mjs verify
node scripts/seed-live.mjs --json
node cli/bin/pagevault.mjs sync-access --json
```

Check automatically:

- `init` provisions **two** Access applications (`<host>/v` and `<host>/admin`) and the
  `pagevault-viewers` group. Two AUDs, never one — a shared AUD is privilege escalation (ADR-001).
- `verify` exits 0, and root now **302s to `/admin`** (rung 3 behaviour, not the 200 landing).
- Deploy reports `CF_API_TOKEN (scoped runtime secret) set`. A warning here means group sync is off.
- **Fail-closed, unauthenticated** — fetch these with no cookie and no bearer:
  - `https://<host>/v/acme` → a 302 to `*.cloudflareaccess.com`, **never** the portal HTML.
  - `https://<host>/admin` → likewise.
  - `https://<host>/p/<token>` → **200**. Capability links bypass Access on purpose, and burn no seat.
  - `https://<host>/pub/notes` → **200**. A public portal is served from a path Access never sees.
- A plain publish is now members-only: seed output should show `/v/` URLs for everything except the
  one document marked public.
- `sync-access --json` reports the viewer group reconciled without error.

> **CHECKPOINT 3 — the one that matters.** Everything above proves the doors are shut. Only Dan can
> prove the right people get through. Give him the links and this list:
>
> 1. `https://<host>/v/acme` in a private window → an Access login wall.
> 2. Log in as the **owner** → all 6 acme documents, with "2027 Platform Roadmap" badged as a draft.
> 3. Log in as the **client test identity** — a second address that is not the owner; a `+tag` alias
>     of your own works and costs nothing → 5 documents, **no draft**.
> 4. As the client, paste the draft's direct URL → **denied**, not merely hidden from the list.
> 5. As the client, try `https://<host>/v/globex` → **denied**. This is prime directive #5, and
>     `globex` exists in the seed for no other reason. Do **not** use `/v/notes` for this — that
>     portal is `kind: "public"`, so `canView` grants everyone by design and a pass there proves
>     nothing.
> 6. `https://<host>/admin` → the console loads, and its footer version matches the build.
> 7. Open the Chart.js document in the portal → renders inside the shell.
> 8. The PDF export button on a document (Browser Run).
> 9. Connect Claude Desktop or claude.ai to `https://<host>/mcp` over OAuth, and ask it to
>    search the acme portal. This is the differentiator (ADR-006) — it should be checked at least
>    once per release, from a surface that is not Claude Code.
>
> **Seat discipline:** every browser identity that logs in consumes one of the 50 free Zero Trust
> seats, and they persist after teardown. Use the two identities above and no others.

## Stage 4 — teardown

Optional, and Dan runs it. Worth doing when provisioning code changed, because a `destroy` that
leaves debris turns the next run's fresh-account test into a lie.

```bash
node cli/bin/pagevault.mjs destroy
```

Afterwards, confirm for him: the host stops serving, both Access apps and the `pagevault-viewers`
group are gone from the dashboard, and both KV namespaces are deleted. Zero Trust itself and any
consumed seats are deliberately left alone.

## Gotchas — do not rediscover these

- **`init --yes` needs a bearer already in `.env.local`.** With no `PAGEVAULT_API_TOKEN` present and
  no TTY, `chooseBearer` returns `fail` and the deploy dies rather than minting a throwaway token
  (`cli/lib/provision/deploy.mjs`). If Dan wiped `.env.local`, either put a bearer back or run
  `init` interactively and let it mint one.
- **KV is eventually consistent (~60s).** A read straight after a write can 404. Retry before
  calling anything a bug; `publish` already polls via `waitReadable`.
- **KV writes are capped at 1000/day.** One seed run is ~20 writes, so three stages plus retries is
  fine — but do not loop it.
- **After a rung-3 `destroy`, `.pagevault.json` keeps a stale `kvId` and `deployedUrl`.** Rungs 1
  and 2 get those stripped; rung 3 does not (`cli/lib/ops/destroy.mjs`). The next deploy reconciles
  the dead KV id, so it self-heals — but `status` will report a URL that no longer serves.
- **The Worker name is hardcoded `pagevault`**, as are the KV titles. One deployment per account.
- **`destroy` is the only command that requires a TTY.** Everything else takes `--yes`.

## Reporting

End with a single report:

- **Stage table** — Public / Public+domain / Secured, each pass, fail, or not run.
- **Automated checks** — what was asserted and what came back.
- **Checkpoint answers** — Dan's verdict on each human check, verbatim.
- **Findings** — anything that surprised you, read badly, needed a retry, or contradicted the docs.
  Rank by whether it would confuse a first-time installer, because that is the audience this whole
  path exists for.

Then propose issues for the findings — **review the list with Dan before creating any of them**, and
put each on the board:

```bash
ghw issue create --assignee @me --project "PageVault Roadmap" \
  --label bug --label "track: packaging" --title "..." --body "..."
ghw issue view <N> --json projectItems   # verify; the flag silently no-ops sometimes
```

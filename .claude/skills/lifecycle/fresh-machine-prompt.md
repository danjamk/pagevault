# The prompt to paste into Claude Code on the fresh machine

Everything below the line is self-contained — there is no repo and no skill file on that machine, so
it carries the whole ritual. Copy from the line down.

---

You are helping me acceptance-test **PageVault**, a self-hosted publishing tool that installs from
npm and stands itself up on my own Cloudflare account. I have installed it globally
(`npm i -g pagevault`) and there is **no source checkout on this machine** — that is the point of the
test. The installed `pagevault` binary is the entire product.

Docs: https://github.com/danjamk/pagevault

## Rules

1. **Never run `pagevault destroy`.** It deletes documents and refuses to run non-interactively by
   design. If a teardown is needed, give me the command and wait for me.
2. **Always pass `--yes` to `init`** when you invoke it yourself, or it will prompt and hang. If a
   step genuinely needs my input (pasting the Cloudflare token), hand it to me instead of guessing.
3. **Stop at every CHECKPOINT.** Print the links, say what a pass looks like, and wait for my answer.
   Do not assume a checkpoint passed.
4. **Log findings as you go.** Do not stop to fix things — finish the stage, then report. A finding
   is anything that surprised you, read badly, needed a retry, or contradicted its own advice.
5. Note anything that assumes a repo: a message telling me to run a `make` target, or a path that is
   not under `~/.pagevault/`, is a bug on this machine. The installed CLI should never mention
   `make`.

## Before you start

Ask me to confirm, then check:

```bash
node -v                 # 22+ required; below that, setup should warn and say why
pagevault --version
pagevault status        # expect "Not configured yet — run pagevault init"
cat ~/.pagevault/.env.local 2>/dev/null | grep -c CLOUDFLARE_API_TOKEN
```

The last one is the provisioning credential. If it is missing I will paste it — `init` offers to save
it. A second token, `CF_RUNTIME_TOKEN`, is needed only for the Secured tier; without it the Worker
cannot sync the Cloudflare Access viewer group and email grants stop working.

**One deployment per Cloudflare account** — the Worker name and KV titles are fixed. If a deployment
already exists on this account, stop and tell me.

## Stage 1 — Public, no domain

```bash
pagevault init --yes --rung 1 --email <my-email>
pagevault verify
pagevault health --json
```

Check and report each as pass or fail:

- `init` exits 0 and prints a `*.workers.dev` URL. On a fresh account it registers a workers.dev
  subdomain — permanent and account-wide, so note the name it chose.
- It should write `~/.pagevault/config.json` by itself, so publishing needs no separate `login` step.
  Confirm the file exists and points at what was just deployed.
- `verify` exits 0: the Worker is live, root serves a 200 landing, `/health` reports
  `<version>+<sha>`, `/mcp` answers `initialize` and `tools/list`, and a publish → read → revoke
  round-trip through the MCP tools succeeds, and it **publishes the bundled welcome sample** and
  prints a `/p/` link. Open that link — an install that ends with a blank console is the failure
  this step exists to catch (#31). A skip here means the package shipped without `assets/`.
- `health --json` version matches `pagevault --version`.

Then publish real documents and confirm the whole surface works:

```bash
printf '<!doctype html><title>Fresh Machine</title><h1>Hello</h1><p>Published from an install.</p>' > /tmp/hello.html
pagevault publish /tmp/hello.html
pagevault list
pagevault portals
pagevault portal-create acme --name "Acme Corp" --kind restricted
pagevault publish /tmp/hello.html --portal acme --name acme-brief.html
pagevault link <the-id-from-list>
pagevault read <the-id> --source
```

- `publish` prints a URL on stdout and **nothing else** — everything human goes to stderr. Verify by
  redirecting: `pagevault publish /tmp/hello.html > /tmp/url.txt` should leave exactly one URL.
- At this tier there is no Cloudflare Access, so a plain publish returns a public `/p/` link. Fetch
  each one with **no** Authorization header and confirm 200.
- `read --source` must return the stored bytes exactly as published.

> **CHECKPOINT 1** — give me the base URL and the `/p/` links, and ask me to open them. I am checking
> that documents render, that the page around them is intact, and that a link opens with no login.

## Stage 2 — Secured

Needs a domain on this Cloudflare account, Zero Trust enabled, and `CF_RUNTIME_TOKEN` in
`~/.pagevault/.env.local`. Ask me for the hostname; if I do not have one available, skip this stage
and say so in the report.

```bash
pagevault list --json > /tmp/before.json
pagevault init --yes --rung 3 --host <hostname> --email <my-email>
pagevault verify
pagevault list --json > /tmp/after.json
```

- **The documents must survive the climb** — same ids, same count, same filenames. Diff the two files
  and say so explicitly.
- `init` provisions **two** Access applications (`<host>/v` and `<host>/admin`) and a
  `pagevault-viewers` group. Two distinct audience tags, never one shared.
- Deploy should report the scoped runtime secret was set. A warning means viewer-group sync is off.
- `verify` exits 0, and root now redirects to `/admin`.
- A brand-new hostname provisions a TLS certificate, so `verify` may fail once on the route. Wait two
  minutes and retry before calling it a failure. If it reports a local DNS cache, follow its advice —
  that is a different problem with a different fix.
- **Unauthenticated fetches**, no cookie and no bearer:
  - `https://<host>/v/acme` → 302 to a `*.cloudflareaccess.com` login. **Never** the portal HTML.
  - `https://<host>/admin` → same.
  - any `/p/` link → **200**. Capability links bypass Access deliberately.
- A plain publish is now members-only (a `/v/` URL); `--public` is opt-in.

```bash
pagevault share acme <a-second-email-I-give-you>
pagevault sync-access --json
```

> **CHECKPOINT 2** — the one that matters. Give me the links and this list, and wait:
> 1. `/v/acme` in a private window → an Access login wall.
> 2. Logged in as the owner → the documents are listed.
> 3. Logged in as the second identity → the same portal, and **no other portal's contents**.
> 4. `/admin` as the second identity → refused. It is a separate Access application, so I will be
>    challenged for a fresh login first; the refusal after that is the real test.
>
> Every browser identity that logs in consumes one of the 50 free Zero Trust seats, and they persist
> after teardown — so two identities, no more.

## Report

End with one report:

- **Stage table** — Public, Secured: pass, fail, or not run.
- **Automated checks** — what was asserted, and what came back.
- **Checkpoint answers** — my verdict on each, verbatim.
- **Findings**, ranked by whether they would stop a first-time installer. Call out separately
  anything that only breaks on a fresh machine: a missing file in the package, a message that
  assumes a repo, a step that needed knowledge the tool never gave me.

Then write the report to a file I can carry back, and tell me the path:

```bash
pagevault destroy    # give me this at the end — I run it, you do not
```
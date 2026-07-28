# Fresh-machine acceptance test

`SKILL.md` drives the lifecycle from a repo checkout, against `node cli/bin/pagevault.mjs`. This is
the other half: **the installed npm package, on a machine that has never seen this project.** ADR-014
makes that the product — `npm install -g pagevault` standing PageVault up on your own Cloudflare
account, with no clone — so it is the one path that has to work for a stranger.

Most of it can be faked on a dev machine. Four things cannot:

| Only a fresh machine tests | Why it hides on a dev box |
|---|---|
| Node absent, or the wrong major | nvm makes 22 the default here; a stranger has whatever they have |
| `npm i -g` permissions and PATH | already resolved here, years ago |
| No wrangler cache | `npx wrangler@4` downloads on first use — minutes, and it is silent about why |
| No Cloudflare login, no tokens | `.env.local` and an ambient `wrangler login` do not exist over there |

## Before you start

**One deployment per Cloudflare account.** The Worker name (`pagevault`) and the KV titles are
hardcoded, so the fresh machine and this one cannot both hold a deployment on the same account. Tear
down before handing off, and tear down again before handing back.

Carry two secrets across — copy the values, do not commit them anywhere:

```bash
grep -E 'CLOUDFLARE_API_TOKEN|CF_RUNTIME_TOKEN' .env.local   # from your checkout
```

- `CLOUDFLARE_API_TOKEN` — required. The provisioning credential.
- `CF_RUNTIME_TOKEN` — only for Secured. Without it the Worker cannot sync the viewer group, and
  email grants silently stop working (the deploy warns).

On the fresh machine those belong in `~/.pagevault/.env.local`, which `pagevault init` will offer to
write for you when you paste the token.

## Part 1 — by hand, before Claude Code

Do these yourself. They are the checks that are about the *machine*, and they are the ones a script
would paper over by having its environment already correct.

```bash
node -v                      # < 22? Good — carry on anyway and watch what setup says
npm i -g pagevault
which pagevault              # is it on PATH at all?
pagevault --version          # should match the release you are testing
pagevault status             # "Not configured yet — run pagevault init"
```

Watch for:

- **On Node < 22:** setup must warn (`Wrangler 4 needs Node 22+`) and tell you how to fix it, rather
  than failing later inside wrangler with something unreadable.
- **`status` must say `pagevault init`, never `make setup`.** A `make` hint means the installed
  package thinks it is a repo checkout.
- **The first `npx wrangler@4` takes minutes** on a cold cache and prints little. If a deploy looks
  hung, it is probably downloading wrangler.
- **Every path it writes should be under `~/.pagevault/`** — never the directory you happen to be
  standing in.

Then run a Public deployment end to end, and actually open the link:

```bash
pagevault init               # interactively — let it walk you through the token
pagevault verify
echo '<h1>Hello from a fresh machine</h1>' > hello.html
pagevault publish hello.html
```

That last command prints a URL and nothing else. Open it. If it renders, the installed product
works: the bundled Worker deployed, KV was created, the bearer was set, and the login config was
written — with no clone, no `make`, and no source on the machine.

## Part 2 — hand it to Claude Code

Tear your test deployment down first, so the full run starts from nothing:

```bash
pagevault destroy
```

Then install Claude Code on that machine and paste the contents of
[`fresh-machine-prompt.md`](fresh-machine-prompt.md) as your first message. It is self-contained —
it carries the whole ritual, so nothing has to be checked out over there.

## When you get back

The fresh machine's deployment must be destroyed before this machine can hold one again. Then here:

```bash
make deploy                  # rebuild from this checkout's .pagevault.json
make restore FILE=pagevault-backup-<date>.json FORCE=1
```

`FORCE=1` because `verify` publishes a document, which makes the namespace non-empty — see #125.

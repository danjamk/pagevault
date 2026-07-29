# PageVault — Onboarding Experience Design

**Status:** Written before the build (2026-07-16), kept current. Last revised 2026-07-28.
**Relates to:** [ADR-008](../adr/ADR-008-progressive-provisioning.md) (progressive provisioning),
[ADR-018](../adr/ADR-018-public-and-secured-tiers.md) (Public and Secured),
[ADR-014](../adr/ADR-014-installed-product-not-thin-client.md) (the installed package is the product).

> **This is the design, not the how-to.** It says why setup is shaped the way it is. For the steps
> themselves, start at the [README](../../README.md#is-this-for-you) and [`docs/setup/`](../setup/).
> The last section is a retrospective on what this document got wrong, which is the part I'd read
> first if I were someone else.

The setup path is the entire product for anyone who isn't me. If it doesn't work start to finish for
a stranger, nothing else in this repo matters.

---

## The principle: frictionless start, opt-in power

Nobody should have to learn what a portal is to publish their first link. The first run gets you a
working, shareable URL with the least possible ceremony; every heavier capability — a collection,
email-gated access — is something you turn on later, deliberately, when you have a reason. This is
prime directive #3 and ADR-008, applied to the whole path and not just the vocabulary.

---

## One hub, two axes

Every entry point — an article, the public showcase, the GitHub repo — funnels to **the repo as the
canonical documentation hub.** The showcase and any writing make the argument and link here; the
repo is where setup actually happens. So the repo's docs carry the entire onboarding load, and their
quality *is* the onboarding quality.

At the hub, two independent choices:

```
writing ┐
show-   ├──→  THE REPO  ──→  TIER?   Public    links anyone with the URL can open
case    │     (docs)         │                 · your own domain, optionally
repo    ┘                    │       Secured   named people only — Zero Trust + a domain
                             │                 · portals live here
                             │
                             └──→  PATH?   1. npm     `pagevault init`, no clone   ◀ default
                                           2. clone   read or change the code
                                           3. guided  an assistant drives either one
```

- **The tier axis is the honest gate.** Public is genuinely free and instant. The one real jump is
  Public → Secured: Cloudflare wants a card on file before it will enable Zero Trust, even on the
  free plan (confirmed 2026-07). I state that plainly rather than burying it. Portals cost nothing
  extra — they are a data model inside Secured, not a level above it.
- **The path axis is just "how much terminal do you want to touch."** All three share the same
  provisioning core, the same verification, the same teardown. They differ in the wrapper and the
  first sixty seconds.

---

## The upgrade ladder

**Two tiers**, and the first one contains a half-step: you can put your own domain on a Public
deployment without Access, Zero Trust, or a card. *"Use my domain"* and *"gate it to named people"*
are separate upgrades, and only the second crosses the card-on-file line. Conflating them was the
single biggest vocabulary bug this project shipped — see ADR-018.

| Tier | What you get | What it adds | New prerequisite | Reversible? |
|---|---|---|---|---|
| **Public** | Deploy to `*.workers.dev`, publish HTML and Markdown, share `/p/` links, publish and search over MCP | — | a Cloudflare account (**no card**), Node 22 | n/a |
| **Public**, on your domain | The same on `pagevault.you.com` | a custom-domain route | a domain **in that Cloudflare account** | yes — the route comes back off cleanly |
| **Secured** | Documents gated to named emails (one-time PIN), the owner console, per-client portals | two Access apps + a viewer group, and the portal data model | Zero Trust (**a card on file**), a scoped runtime token | **Zero Trust is the one-way door** |

Internally these are rungs 1, 2 and 3, and `.pagevault.json` still records the number because the
provisioning machinery keys on it. A user never sees the word.

Two things make the ladder work:

- **Every step is additive.** The KV namespace, portals, and documents carry across untouched — you
  never rebuild, you only add. Climb when you have a reason, not before. The one thing that does not
  carry is the *hostname*: moving from `workers.dev` to your own domain changes every URL you have
  already handed out.
- **The real commitment is Zero Trust.** Publishing on your own domain without gating is reversible.
  Zero Trust is the single step that can't be automated away or cleanly reversed, so it comes only
  when private access is actually wanted.

Two constraints that don't fit the table: a custom domain is *required* before you can gate
anything, because Cloudflare Access cannot protect a `*.workers.dev` host. And seats — one per
distinct viewer, 50 free — are consumed only at Secured, on login. Public authenticates nobody, so
`/p/` and `/pub/` links cost nothing forever.

---

## The three paths

1. **npm** *(default)* — `npm install -g pagevault && pagevault init`. Provisions and deploys with
   no repo checkout; the package carries a prebuilt Worker bundle, so nothing is compiled on your
   machine. This is the product ([ADR-014](../adr/ADR-014-installed-product-not-thin-client.md)),
   and the on-ramp most people take.
2. **clone** — `git clone`, then `make`. For reading or changing the code. `make` calls the same
   engine the CLI does, so this is not a second implementation.
3. **guided** — not a separate build at all. It's a quality bar on the docs that lets an assistant
   drive either path above, realized as [`ai-guided-setup.md`](../setup/ai-guided-setup.md).

The one-click Deploy button explored in the original design was **dropped** ([#28](https://github.com/danjamk/pagevault/issues/28)):
a button can create a Worker and a KV namespace, but it cannot set the runtime secrets or create the
Access applications, so it lands a stranger with a deployment that can neither publish nor gate.

---

## Ground zero to a shared link

No domain, no Zero Trust, no card:

```bash
npm install -g pagevault
pagevault init          # token, tier, account → provision, deploy, remember where it landed
pagevault publish report.html --public
```

`init` is interactive: it takes the API token, asks Public or Secured, confirms which Cloudflare
account it is about to deploy to, provisions, deploys, and writes the result to `~/.pagevault/` so
the CLI is already pointed at the deployment. There is no separate login step.

`/v/` and `/admin` fail closed at Public, which is correct — you aren't using them yet. When you
want them, re-run `init` and choose Secured.

### Make is the other front door, not another engine

The clone path's front door is the Makefile. `make help` lists everything, and the same workflow is
packaged as targets a person runs and an assistant can run identically:

- `make setup` — install dependencies, scaffold config, stop early if the environment is wrong.
- `make preflight` — **before** deploy: account, token and config readiness. Read-only, safe anytime.
- `make deploy` — provision and deploy.
- `make verify` — **after** deploy: liveness, the MCP surface, an authenticated round-trip, and a
  sample publish. The "did the deploy actually work" gate.
- `make destroy` — the teardown. The one command that requires a human at a TTY.

The pairing matters: `preflight` catches a broken *environment* before you spend a deploy; `verify`
catches a broken *deployment* after. Both exist as CLI commands too, running the same code — one
engine, two front doors. Climbing a tier is the same command again: `pagevault init` (or
`make deploy`) reads the current state and provisions only what the new tier adds.

---

## The assistant overlay

This is the most on-brand path, because it *is* the thesis: someone is in a Claude conversation,
finds PageVault, and asks *"how do I set this up?"* For that to work the project has to be legible
to an assistant, not just to a human reader. Two things, and neither is a fourth codebase:

1. **A runbook written for the assistant**, not adapted from the human one —
   [`ai-guided-setup.md`](../setup/ai-guided-setup.md). It is a decision tree with the exact
   commands, the named prerequisites, and what each failure means. It also tells the assistant how
   to *behave*: guide by default, confirm before anything widening or irreversible, never invent a
   portal name.
2. **Tools an assistant can drive** — named failures, exit codes, idempotent re-runs, and `--json`
   on the read commands so output can be parsed instead of scraped.

The endgame works today: paste an assistant the runbook URL, answer its questions, and it walks you
to a live deployment.

---

## What this document got wrong

Kept because a plan that was revised is more useful than one that pretends the path was straight.

- **It planned three tiers and shipped two.** "Running a practice" was designed as a level. It is a
  data model that costs nothing extra, and calling it a tier meant the CLI said *"rung 2 = domain"*
  while the README said *"Tier 2 = named people."* ADR-018 fixed the vocabulary after that collision
  reached real users.
- **It sequenced clone first and npm last** — "npm is clone-without-cloning," treated as packaging
  over a proven core. That was backwards. The installed package is the product (ADR-014), and the
  npm path turned out to be the least-exercised code in the repo precisely because it was built last
  and tested least. The first cold install on a machine that had never seen PageVault found a bug
  that left a live, unusable deployment.
- **It expected an `llms.txt` or `AGENT.md`.** Neither exists. The need was real; the shape was
  wrong. A runbook in `docs/setup/` that a human can also read beat a machine-only file at the repo
  root.
- **It listed a "tier 1 config profile" as an open question.** The answer was neither a committed
  second profile nor a documented hand-edit: provisioning writes the config programmatically, so
  there is no profile to keep in sync.
- **It was right about the Deploy button being a dead end**, and the issue still stayed open for
  weeks after the design had already decided. A decision recorded in a design doc is not a decision
  the tracker knows about.

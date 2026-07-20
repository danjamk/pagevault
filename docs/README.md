# PageVault docs

Start with the question you came here to answer.

| I want to… | Start here |
|---|---|
| **Understand the design** | [`architecture.md`](architecture.md), then the [`adr/`](adr/) records |
| **Run it myself** | the [Quick Start](../README.md#quick-start), then [`setup/prerequisites.md`](setup/prerequisites.md) |
| **See how it was built** | [`engineering/how-i-built-this.md`](engineering/how-i-built-this.md) |
| **Ship or release it** (maintainer) | [`engineering/deploy-prod.md`](engineering/deploy-prod.md), [`engineering/state-versioning.md`](engineering/state-versioning.md) |
| **Contribute** | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |

---

## Understand it

- [`architecture.md`](architecture.md) — the whole design, in one file.
- [`adr/`](adr/) — the decision records. The contested calls live here with the reasoning; read the relevant one before overturning it.
- [`design/onboarding-experience.md`](design/onboarding-experience.md) — the setup-ladder experience and why it's shaped the way it is.

## Run it yourself

- [Quick Start](../README.md#quick-start) — rung 1, public links, no card.
- [`setup/prerequisites.md`](setup/prerequisites.md) — what you need before you start.
- [`setup/backup-and-restore.md`](setup/backup-and-restore.md) — export your state and put it back.

## How it was built and shipped

- [`engineering/how-i-built-this.md`](engineering/how-i-built-this.md) — the workflow and the process behind the repo.
- [`engineering/mcp-best-practices.md`](engineering/mcp-best-practices.md) — the standard the remote MCP server is held to, and where it stands.
- [`engineering/implementation/`](engineering/implementation/) — the build plans, phase by phase.
- [`engineering/state-versioning.md`](engineering/state-versioning.md) — the `.pagevault.json` schema and its migrations.
- [`engineering/deploy-prod.md`](engineering/deploy-prod.md) — how I run PageVault's own production through CI (one operator's rig, not required).

## Contribute

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — the rules of the road, and the few that are non-negotiable.

> An *operations* section — what's logged, what the free tier does and doesn't tell you, and the seat guardrail — is on the way ([#45](../../issues/45)).

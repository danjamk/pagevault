# PageVault docs

Start with the question you came here to answer.

| I want to… | Start here |
|---|---|
| **Understand the design** | [`architecture.md`](architecture.md), then the [`adr/`](adr/) records |
| **Run it myself** | the [Quick Start](../README.md#install--pick-a-path), then [`setup/prerequisites.md`](setup/prerequisites.md) |
| **See how it was built** | [`engineering/how-i-built-this.md`](engineering/how-i-built-this.md) |
| **Ship or release it** (maintainer) | [`engineering/deploy-prod.md`](engineering/deploy-prod.md), [`engineering/state-versioning.md`](engineering/state-versioning.md) |
| **Contribute** | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |

---

## Understand it

- [`architecture.md`](architecture.md) — the whole design, in one file.
- [`adr/`](adr/) — the decision records. The contested calls live here with the reasoning; read the relevant one before overturning it.
- [`design/onboarding-experience.md`](design/onboarding-experience.md) — the setup-ladder experience and why it's shaped the way it is.

## Run it yourself

- [Quick Start](../README.md#install--pick-a-path) — Public: links anyone with the URL can open, no card.
- [`setup/prerequisites.md`](setup/prerequisites.md) — what you need before you start.
- [`setup/ai-guided-setup.md`](setup/ai-guided-setup.md) — hand your LLM this runbook and let it walk you through setup.
- [`setup/cli-reference.md`](setup/cli-reference.md) — every `pagevault` command, flag, and environment variable.
- [`setup/connect-mcp.md`](setup/connect-mcp.md) — point Claude (web, Desktop, Code) at your MCP server.
- [`setup/operating-a-deployment.md`](setup/operating-a-deployment.md) — someone else deployed it (CI, another machine): what works, what needs a credential, and why not to run `init`.
- [`setup/scheduling-the-sync.md`](setup/scheduling-the-sync.md) — keep your view history: launchd, a systemd timer, or a scheduled Action.
- [`setup/backup-and-restore.md`](setup/backup-and-restore.md) — export your state and put it back.
- [`architecture.md` §12](architecture.md#12-operations--what-the-deployment-tells-you) — what the deployment logs, what it never logs, and how to read view tracking.

## How it was built and shipped

- [`engineering/how-i-built-this.md`](engineering/how-i-built-this.md) — the workflow and the process behind the repo.
- [`engineering/mcp-best-practices.md`](engineering/mcp-best-practices.md) — the standard the remote MCP server is held to, and where it stands.
- [`engineering/implementation/`](engineering/implementation/) — the build plans, phase by phase. Open plans sit at the top; [`complete/`](engineering/implementation/complete/) holds the ones whose work has shipped, which is currently all of them.
- [`engineering/state-versioning.md`](engineering/state-versioning.md) — the `.pagevault.json` schema and its migrations.
- [`engineering/deploy-prod.md`](engineering/deploy-prod.md) — how I run PageVault's own production through CI (one operator's rig, not required).
- [`engineering/windows-smoke-test.md`](engineering/windows-smoke-test.md) — a hand-run protocol for the one platform CI cannot reach: native Windows.

## Contribute

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — the rules of the road, and the few that are non-negotiable.

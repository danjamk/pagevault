.DEFAULT_GOAL := help
.PHONY: help install setup dev demo status test test-security check-sandbox check login logout preflight provision deploy verify health logs destroy backup restore

# Written by `make provision`. Gitignored — it holds your email, team name, AUD tags and
# KV id, and this is a public repo.
DEPLOY_CONFIG := worker/wrangler.generated.jsonc

# Wrangler 4 requires Node 22; the system default here is 20. Every target that
# touches the toolchain selects it first, because the error you get otherwise does
# not obviously say "wrong Node".
NVM := . $$HOME/.nvm/nvm.sh && nvm use --silent

# `##@ ` lines are section headers; `## ` after a target is its one-line help. The awk
# prints them in file order, so keep each target under the header it belongs to.
help: ## List targets by group
	@awk 'BEGIN {FS = ":.*## "} \
		/^##@ / {printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next} \
		/^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

##@ Develop
install: ## Install dependencies
	@$(NVM) && pnpm install --frozen-lockfile --silent

setup: install ## Decide your rung and get the repo ready (local; nothing created)
	@if [ ! -f worker/.dev.vars ]; then \
		cp worker/.dev.vars.example worker/.dev.vars; \
		echo "→ created worker/.dev.vars from the example (gitignored)"; \
	fi
	@$(NVM) && node scripts/setup.mjs

dev: ## Run the Worker locally against Miniflare KV
	@if [ ! -f worker/.dev.vars ]; then \
		cp worker/.dev.vars.example worker/.dev.vars; \
		echo "→ created worker/.dev.vars from the example (gitignored)"; \
	fi
	@$(NVM) && pnpm dev

demo: ## Seed a running local Worker with a demo client engagement, and print where to look
	@bash scripts/demo.sh

status: ## Show what this clone is configured for (versions, rung, account)
	@$(NVM) && node scripts/status.mjs

##@ Test & check
test: ## Run the test suite
	@$(NVM) && pnpm test
	@$(NVM) && node --test scripts/*.test.mjs cli/*.test.mjs

test-security: ## Run only canView() + identity — the suite where a bug is an incident
	@$(NVM) && pnpm test:security

check-sandbox: ## Fail the build if the iframe is ever granted our origin (ADR-007)
# `allow-scripts` combined with same-origin is functionally NO SANDBOX: with scripts
# enabled the frame can reach into the parent and remove the attribute outright. It is
# the single change that silently deletes every protection in ADR-007, and it is exactly
# what gets added at 11pm because an artifact "needs" it.
#
# Comments in worker/src deliberately never spell the token out, so this stays a plain,
# absolute grep with no exceptions to argue about.
	@if grep -rn 'allow-same-origin' worker/src; then \
		echo ""; \
		echo "✗ allow-same-origin found in worker/src. Read docs/adr/ADR-007-viewer-shell.md."; \
		echo "  With allow-scripts, this is not a weaker sandbox — it is no sandbox."; \
		exit 1; \
	else \
		echo "✓ no allow-same-origin in worker/src"; \
	fi

check: check-sandbox ## Typecheck + test — the pre-PR gate, and what CI runs
	@$(NVM) && pnpm check

##@ Cloudflare account
login: ## Log in to Cloudflare (opens a browser), under the right Node
	@$(NVM) && npx wrangler login

logout: ## Log out of Cloudflare — for a clean, newbie-style test
	@$(NVM) && npx wrangler logout

preflight: ## Check your Cloudflare account is ready for your rung (read-only)
	@$(NVM) && node scripts/preflight.mjs

##@ Deploy & operate
provision: ## Rung 3: create the KV namespace, Access group, and two Access apps
	@$(NVM) && node scripts/provision.mjs

deploy: ## Deploy the Worker — rung-aware (Tier 0, or provision at rung 3)
	@$(NVM) && node scripts/deploy.mjs

verify: ## Smoke-test the live deployment (run after deploy)
	@$(NVM) && node scripts/verify.mjs

health: ## Assert the live /health matches this checkout's build (<version>+<sha>)
	@$(NVM) && node scripts/health-check.mjs

logs: ## Tail the deployed Worker
	@$(NVM) && npx wrangler tail --config $(DEPLOY_CONFIG)

destroy: ## Tear the deployment down — Worker, DNS, Access apps, group, and KV data
	@$(NVM) && node scripts/destroy.mjs

##@ Data (KV)
backup: ## Snapshot the KV namespace to a JSON file (OUT=path, KV=id optional)
	@$(NVM) && node scripts/kv-backup.mjs $(if $(OUT),--out $(OUT),) $(if $(KV),--kv $(KV),)

restore: ## Restore a backup into the KV namespace (make restore FILE=backup.json [KV=id] [FORCE=1])
	@$(NVM) && node scripts/kv-restore.mjs --in "$(FILE)" $(if $(KV),--kv $(KV),) $(if $(FORCE),--force,)

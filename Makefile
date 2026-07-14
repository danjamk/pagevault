.DEFAULT_GOAL := help
.PHONY: help install dev test test-security check-sandbox check deploy

# Wrangler 4 requires Node 22; the system default here is 20. Every target that
# touches the toolchain selects it first, because the error you get otherwise does
# not obviously say "wrong Node".
NVM := . $$HOME/.nvm/nvm.sh && nvm use --silent

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	@$(NVM) && pnpm install --frozen-lockfile

dev: ## Run the Worker locally against Miniflare KV
	@$(NVM) && pnpm dev

test: ## Run the test suite
	@$(NVM) && pnpm test

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

deploy: ## Deploy the Worker to Cloudflare
	@printf "Deploy to production? [y/N] " && read ans && [ "$$ans" = "y" ]
	@$(NVM) && pnpm deploy
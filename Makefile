.DEFAULT_GOAL := help
.PHONY: help install dev test check deploy

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

check: ## Typecheck + test — the pre-PR gate, and what CI runs
	@$(NVM) && pnpm check

deploy: ## Deploy the Worker to Cloudflare
	@printf "Deploy to production? [y/N] " && read ans && [ "$$ans" = "y" ]
	@$(NVM) && pnpm deploy
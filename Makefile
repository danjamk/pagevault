.DEFAULT_GOAL := help
.PHONY: help install setup dev demo status test test-security check-sandbox check-console check login logout preflight provision deploy verify health logs destroy backup restore views export bundle deploy-bundle publish-cli

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
	@$(NVM) && node cli/lib/provision/setup.mjs

dev: ## Run the Worker locally against Miniflare KV
	@if [ ! -f worker/.dev.vars ]; then \
		cp worker/.dev.vars.example worker/.dev.vars; \
		echo "→ created worker/.dev.vars from the example (gitignored)"; \
	fi
	@$(NVM) && pnpm dev

demo: ## Seed a running local Worker with a demo client engagement, and print where to look
	@bash scripts/demo.sh

status: ## Show what this clone is configured for (versions, rung, account)
	@$(NVM) && node cli/bin/pagevault.mjs status

##@ Test & check
test: ## Run the test suite
	@$(NVM) && pnpm test
	@$(NVM) && node --test scripts/*.test.mjs cli/*.test.mjs

test-security: ## Run only canView() + identity — the suite where a bug is an incident
	@$(NVM) && pnpm test:security

test-e2e: ## Drive the real CLI against a real Worker (wrangler dev + Miniflare KV)
# Included in `make test` by the cli/*.test.mjs glob above; this target is for running it alone.
# It boots its own Worker on a free port with a throwaway KV — it cannot reach a real deployment.
	@$(NVM) && node --test cli/e2e.test.mjs

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

check-docs: ## Fail the build if the docs describe something the code doesn't do
# Links and anchors, `make` targets, CLI commands, MCP tools, and route names — each compared
# against the thing that defines it. Not style; a failure is a factual contradiction.
#
# Added after an audit found a product page advertising a route the Worker never served and a
# feature tour advertising two features that were never built. Both were mechanical, and both
# survived months of people reading the pages.
	@$(NVM) && node scripts/check-docs.mjs

check-console: ## Fail the build if the Worker's inline browser JS doesn't parse
# The Worker ships its UI as HTML built from template literals, so ~45KB of browser JavaScript
# lives inside TypeScript strings where tsc has nothing to say about it. A stray backtick, a bad
# escape, an unbalanced brace — all valid *string content*, and the first sign is a blank page.
#
# Proven, not assumed: an unbalanced brace introduced into the console passes `tsc` with exit 0
# and all 25 console tests, and this catches it. Added after a backtick inside a comment inside
# page() silently terminated the template.
	@$(NVM) && node scripts/check-console.mjs

check-palette: ## Fail the build if a retired amber/cream hex reappears in the Worker (#122)
# The console moved to the neutral + signal-blue system (#67), but the landing, error, viewer and
# OAuth pages kept the old amber identity for months — the favicon and the landing page disagreed
# on a single page load. Tokens now live in worker/src/theme.ts; these hexes are how the drift
# looked, so a plain grep is enough to stop it recurring. Add a token, don't paste a colour.
# Amber/cream only. #34507a — the older brand blue — is deliberately NOT here: it survives in
# markdown.ts as the link colour for rendered DOCUMENT body copy, where a quieter navy beats the
# chrome's signal blue. Chrome vs document is the line; that one is a design call, not drift.
	@if grep -rniE '#(fbf6ec|f0ece0|f4ebd6|1e1610|4a3a28|d8cdb0|7d6b52|14110c|efe7d6|a99c82|e0a24a|b9822f|f6f2e9|241d12|6c624d)' worker/src; then \
		echo ""; \
		echo "✗ A retired amber/cream hex is back in worker/src. See #122."; \
		echo "  The palette lives in worker/src/theme.ts — use a var(--token), not a literal."; \
		exit 1; \
	else \
		echo "✓ no retired palette hexes in worker/src"; \
	fi

check: check-sandbox check-palette check-console ## Typecheck + test — the pre-PR gate, and what CI runs
	@$(NVM) && pnpm check

##@ Cloudflare account
login: ## Log in to Cloudflare (opens a browser), under the right Node
	@$(NVM) && npx wrangler login

logout: ## Log out of Cloudflare — for a clean, newbie-style test
	@$(NVM) && npx wrangler logout

preflight: ## Check your Cloudflare account is ready for your rung (read-only)
	@$(NVM) && node scripts/preflight.mjs

##@ Deploy & operate
provision: ## Rung 3: create the KV namespace, Access group, and two Access apps (ANALYTICS=on|off toggles view tracking)
	@$(NVM) && node cli/lib/provision/provision.mjs \
		$(if $(filter on,$(ANALYTICS)),--analytics,) $(if $(filter off,$(ANALYTICS)),--no-analytics,)

deploy: ## Deploy the Worker — rung-aware (Tier 0, or provision at rung 3; ANALYTICS=on|off toggles view tracking)
	@$(NVM) && node cli/lib/provision/deploy.mjs \
		$(if $(filter on,$(ANALYTICS)),--analytics,) $(if $(filter off,$(ANALYTICS)),--no-analytics,)

seed: ## Publish a realistic document set to the LIVE deployment, through the CLI (asks first)
	@$(NVM) && node scripts/seed-live.mjs

verify: ## Smoke-test the live deployment (run after deploy)
	@$(NVM) && node cli/bin/pagevault.mjs verify

health: ## Assert the live /health matches this checkout's build (<version>+<sha>)
	@$(NVM) && node cli/bin/pagevault.mjs health

logs: ## Tail the deployed Worker (ERRORS=1 only errors, SEARCH=text filter, JSON=1 raw)
# A bare tail on a healthy deployment is mostly request lines. Now that the Worker emits named
# events (architecture.md §12), the useful sessions are filtered: ERRORS=1 is the
# deployment-is-broken tier, SEARCH= narrows to one event family, JSON=1 pipes to jq.
	@$(NVM) && npx wrangler tail --config $(DEPLOY_CONFIG) \
		$(if $(ERRORS),--status error,) $(if $(SEARCH),--search "$(SEARCH)",) $(if $(JSON),--format json,)

destroy: ## Tear the deployment down — Worker, DNS, Access apps, group, and KV data
	@$(NVM) && node cli/bin/pagevault.mjs destroy

##@ Data
backup: ## Snapshot the KV namespace to a JSON file (OUT=path, KV=id optional)
# Same engine as `pagevault backup` — one code path, two front doors (#133). An installed
# operator holds the same client documents a clone does, and had no way to snapshot them.
	@$(NVM) && node cli/bin/pagevault.mjs backup $(if $(OUT),--out $(OUT),) $(if $(KV),--kv $(KV),)

restore: ## Restore a backup into the KV namespace (make restore FILE=backup.json [KV=id] [FORCE=1])
	@$(NVM) && node cli/bin/pagevault.mjs restore --file "$(FILE)" $(if $(KV),--kv $(KV),) $(if $(FORCE),--force,)

views: ## Which documents your clients actually opened (DAYS=30 PORTAL=slug DOC=id)
	@$(NVM) && node scripts/views.mjs $(if $(DAYS),--days $(DAYS),) $(if $(PORTAL),--portal $(PORTAL),) $(if $(DOC),--doc $(DOC),)

export: ## Walk away with everything: a zipped, browsable dump of your deployment (PORTAL=slug DRAFTS=1 NOZIP=1 OUT=dir)
# Auto-targets THIS clone's deployment — URL from .pagevault.json, bearer from .env.local — so
# `make deploy && make export` is the whole ceremony, no login. Zips by default; NOZIP=1 keeps
# the folder. (For someone else's deployment, use the `pagevault export` CLI instead.)
	@$(NVM) && node scripts/export.mjs $(if $(OUT),--out $(OUT),) \
		$(if $(PORTAL),--portal $(PORTAL),) $(if $(DRAFTS),--include-drafts,) $(if $(NOZIP),--no-zip,)

##@ Distribution
bundle: ## Build the self-contained Worker bundle the npm package ships (cli/dist/worker.js) — ADR-014
	@$(NVM) && node scripts/build-bundle.mjs

deploy-bundle: bundle ## Deploy the PREBUILT bundle (the installed-product path) — for validating the no_bundle deploy on a test host
	@$(NVM) && PAGEVAULT_BUNDLE=1 node cli/lib/provision/deploy.mjs

publish-cli: ## Publish the pagevault CLI to npm — prepublishOnly runs the unit tests + a pack/install smoke first (#56)
# The guard is in cli/package.json: `prepublishOnly` runs the node --test suites and smoke.mjs,
# which packs the tarball and runs the installed binary. A broken package can't reach npm.
	@$(NVM) && cd cli && npm publish

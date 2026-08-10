# examples/

Fixtures for `make seed` — a realistic document set published to a **test** deployment so the
console, the portal index, markdown rendering and remote-image handling have something real to
render. They exist for developing PageVault, not for using it.

**They do not ship.** `cli/package.json`'s `files` allowlist covers `bin`, `lib`, `dist` and
`assets`; this directory is repo-only and stays that way.

## Where the operator-facing sample lives

`cli/assets/welcome.html` — the document `pagevault verify` publishes so that a fresh deployment
ends with something openable rather than a blank console. It is in the **package**, because
`npm install -g pagevault` is the product (Prime Directive #2) and an operator who never clones this
repo still needs a first document.

It was in this directory until #31, which is why installed operators got no first document for
several releases and a skip line called that expected.

## Why there is no per-type sample taxonomy

Issue #31 originally proposed `examples/simulator/`, `examples/infographic/`,
`examples/explainer/` and so on — one sample per artifact type — so that a fresh operator could run
`pagevault publish examples/simulator/orbit.html`.

That command cannot work. An installed operator has no `examples/` directory, and giving them one
would mean shipping megabytes of demo HTML in the CLI package to solve a problem one bundled sample
already solves. The onboarding goal behind the proposal — *don't end setup at a blank console* — is
met by `verify` publishing `cli/assets/welcome.html` on every install path.

If you want a per-type gallery, the place for it is the public showcase deployment (#30), which is a
published portal rather than a directory in a repo.

## The rule these files still follow

Every artifact here is subject to Prime Directive #4: fully client-side, no external hosts except
where a fixture is *deliberately* testing remote-image behaviour, images inline, no persistence. They
render in a sandboxed iframe like anything else, and a fixture that broke the rule would be teaching
by example.

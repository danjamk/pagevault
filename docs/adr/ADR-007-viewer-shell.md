# ADR-007 — Artifacts render in a sandboxed iframe inside a trusted shell

**Status:** Accepted — **supersedes [ADR-003](ADR-003-document-sandbox.md)**
**Date:** 2026-07-14

## Context

The premise of this product is *hosting untrusted code on a trusted origin*. The HTML
is LLM-generated, it runs JavaScript by design, and it may have been produced from
content the model did not control — a summarized web page carrying a prompt injection
is enough. Served on the same origin as the console and the API, with the viewer's
`CF_Authorization` cookie attached automatically by the browser, it runs with ambient
authority.

**ADR-003 solved this** with a top-level `Content-Security-Policy: sandbox
allow-scripts` on the document response. That works: the document gets an opaque
origin, cannot read cookies, cannot touch storage, cannot make credentialed
same-origin requests. It is one header and it is genuinely secure.

It also, by construction, makes it impossible to put **anything** around the document.
ADR-003 said so explicitly in its own Consequences:

> *"Any future feature that needs the document to talk back to PageVault (view
> tracking from inside the page, an in-document share button) is blocked by this, by
> design. Such a feature needs the iframe-wrapper design instead. That is a real
> constraint on v2 and it should be paid honestly rather than by weakening this."*

The portal product needs exactly that. A document in a client portal needs a header
with the portal name and a link back to the collection. The roadmap needs a "Download
PDF" button and a read-receipt ping. All of it is chrome, and chrome needs a page.

**The trigger ADR-003 set for itself has fired.** This is the ADR system working, not
failing.

## Decision

The artifact **never renders in our origin's document context.**

1. `/v/{slug}/{id}` returns a **trusted shell** — our HTML, our JS, nothing from the
   artifact. This is where portal nav, PDF export, and any future chrome live.
2. The shell frames the artifact:

   ```html
   <iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="/render/{id}?cap={token}">
   ```

   **`allow-scripts` without `allow-same-origin` is the whole trick.** Scripts run;
   the frame gets a unique opaque origin; it cannot read our cookies, cannot touch the
   shell's DOM, and cannot make credentialed same-origin requests.
3. The shell holds a **short-lived HMAC capability token** scoped to that one
   document (~10 minutes). The iframe never receives one.
4. Privileged browser endpoints require the capability **and** an `Origin` check that
   **rejects `Origin: null`** — which is precisely what a sandboxed iframe's origin is.
   That single line is what stops artifact JS from calling the API even if it somehow
   obtained a token.
5. `/render/{id}` — the bytes route — **also** carries a strict CSP including the
   `sandbox` directive and `frame-ancestors 'self'`. So even a direct top-level
   navigation to it lands in an opaque origin.

Point 5 is one better than sharehtml, which relies on the iframe attribute alone and
sends no CSP at all. It costs one header and it removes the failure mode where
someone reaches the bytes route directly.

**Cookie-vs-header is the subtlety worth understanding rather than copying blindly:**

- Auth by **explicit header** (bearer, `Cf-Access-Jwt-Assertion`) → **skip** the
  capability check. The caller deliberately attached a credential; there is no ambient
  authority to abuse. This is the CLI and the MCP server.
- Auth by **cookie** → **require** the capability token and the `Origin` check.
  Cookies ride along automatically, so this is the confused-deputy surface. This is
  the browser.

## Alternatives considered

**Keep ADR-003's top-level CSP sandbox.** Equally secure, one header, zero moving
parts. Rejected because it forecloses the entire portal product: no chrome, no nav, no
PDF button, no view tracking. The security property is identical; the capability
ceiling is not.

**Serve artifacts from a second hostname.** The textbook fix — a genuinely separate
origin, so same-origin access is impossible by construction. Still rejected, for the
same reason as in ADR-003: it doubles the Access configuration, the DNS, and the
certificate setup, and adds a hostname to every step of the runbook. The cost lands
entirely on the person setting this up, and short setup is the product's central
claim. The opaque origin buys the same property for free.

**Sanitize the HTML on upload.** Rejected outright. The documents are *supposed* to
have scripts — a stripped Chart.js dashboard is a blank page. Sanitizing interactive
HTML is a losing arms race and directly destructive of the thing being sold.

**`srcdoc` instead of a `/render` route** (sharehtml's approach — the shell fetches
the bytes and assigns them to `iframe.srcdoc`). Works, and avoids a route. Rejected:
it means the artifact bytes travel through the shell's JS, and a 10MB document becomes
a 10MB string in the parent's memory before it renders. A separate route streams. We
do take their other trick, though — serving the raw bytes route with
`Content-Disposition: attachment` and `nosniff` so a direct navigation downloads rather
than executes.

## Consequences

- Two routes per document instead of one: the shell and the bytes. Slightly more
  machinery, and worth it.
- Capability tokens are a new primitive: HMAC over `{scope, email, docId, exp}`,
  signed with a secret. It is the same primitive as the console session token in
  ADR-004 — one implementation, two scopes, not two implementations.
- `/render` sits behind **no Access application**; it is gated by the capability token
  alone. That is what keeps Access out of the iframe, where an auth redirect would be
  a broken experience.
- **`allow-same-origin` must never appear in this codebase.** Combined with
  `allow-scripts` it is functionally no sandbox at all — the frame can reach into the
  parent and remove the attribute. It is exactly the change someone makes at 11pm
  because an artifact "needs" it. There is a **lint-level test asserting the string
  appears nowhere in the repo**, and a committed hostile-artifact fixture that tries
  to `fetch('/api/portals')`, read `document.cookie`, and POST to an external endpoint.
  All three must fail.
- **Public does not mean unsandboxed.** `/p/*` and `/pub/*` go through the same shell.
  A public artifact is more exposed, not less.
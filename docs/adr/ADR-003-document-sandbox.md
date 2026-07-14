# ADR-003 — Serve documents into an opaque origin via CSP `sandbox`

**Status:** **Superseded by [ADR-007](ADR-007-viewer-shell.md)** (2026-07-14)
**Date:** 2026-07-13

> **Why it was superseded, by its own terms.** The Consequences section below says:
> *"Any future feature that needs the document to talk back to PageVault (view
> tracking from inside the page, an in-document share button) is blocked by this, by
> design. Such a feature needs the iframe-wrapper design instead."* The product now
> needs exactly that — portal navigation, PDF export, and read receipts all require
> chrome around the document. The trigger this ADR set for itself has fired.
>
> **The security property is retained, not abandoned.** ADR-007 still puts the
> artifact in an opaque origin; it gets there via `sandbox="allow-scripts"` on an
> iframe instead of a top-level CSP header, and it *also* keeps the CSP `sandbox`
> directive on the bytes route as a second layer. The Alternatives section below —
> which already evaluated and deferred the iframe design — is why that decision took
> minutes rather than a re-litigation.

## Context

PageVault serves LLM-generated HTML. That HTML runs JavaScript — it is expected
to; the whole point is that these are interactive reports, dashboards, and
infographics with charts and animations inlined.

It is served from the same origin as `/admin` and `/api/*`.

Access sets a `CF_Authorization` cookie scoped `Path=/` on the hostname. The
browser sends it to every path on that host, including the ones with no Access
application. So a document's JavaScript runs same-origin with the viewer's ambient
credentials.

The attack is not exotic. An LLM writes a report summarizing a web page; that page
carries a prompt injection; the model emits a `<script>` block it was talked into
emitting. Now that script is running in your browser, on your hostname, while you
are logged in. It can call your own API. It can read documents you have access to.
If the console had used cookie auth, it could delete everything you have ever
published.

"The HTML is self-authored, so scripts are expected" is true and is not a reason to
trust it. The author is a language model, and the model's input is not always
yours.

## Decision

`/d/*` and `/p/*` are served with:

```
Content-Security-Policy: sandbox allow-scripts allow-popups allow-forms allow-downloads
```

Omitting `allow-same-origin` gives the document an **opaque origin**. It fails all
same-origin checks. Its JavaScript cannot read `document.cookie`, cannot access
`localStorage` / `sessionStorage` / IndexedDB (these throw), cannot register a
service worker, and cannot make credentialed same-origin requests back to our API.

Scripts still run. Canvas, SVG, inline styles, charts, animations, `crypto.subtle`
— all still work. Everything a genuinely self-contained single-file artifact does
still works.

This is one response header, and it converts "hostile document reads your session"
into "hostile document is a sealed box."

The console is served with a **separate, strict CSP using a per-request nonce**,
so a mistake in document serving cannot degrade the surface that holds the session
token.

`DOC_CSP` is an environment variable. Someone who forks this and disagrees can
change it. The default is safe.

## Alternatives considered

**Permissive-but-not-stupid CSP** — `frame-ancestors 'none'`, restricted
`form-action`, allow inline script/style. The original proposal. It blocks
clickjacking and third-party form exfiltration. It does **nothing** about
same-origin API access, which is the actual risk. Rejected as insufficient, though
those directives remain worth setting.

**Serve documents from a second hostname** (`docs.example.com` vs
`share.example.com`). This is the textbook fix — a separate origin, so same-origin
access is impossible by construction. It is what a large product would do.
Rejected: it doubles the Access configuration, doubles the DNS and certificate
setup, and adds a second hostname to every step of the runbook — all to buy what
one response header already buys. The cost lands entirely on the person setting
this up, and this project's central claim is that setup is short.

**Render documents inside a sandboxed `<iframe>` on a wrapper page.** Equivalent
isolation, and it would let PageVault add chrome around the document (title bar,
share controls). Rejected for v1: it means every document load is two requests, the
wrapper page becomes a thing to style and maintain, and full-bleed artifacts
(infographics designed to fill the viewport) get awkward. Reconsider if v2 wants
document chrome.

**Sanitize the HTML on upload** (strip scripts, allowlist tags). Rejected outright.
The documents are *supposed* to have scripts — a stripped Chart.js dashboard is a
blank page. Sanitizing interactive HTML is both a losing arms race and directly
destructive of the product.

## Consequences

- Documents that use `localStorage`, `sessionStorage`, IndexedDB, or same-origin
  `fetch()` will break. A self-contained artifact should not use any of these. In
  practice this is the trade: a small class of documents breaks, and no document
  can steal a session.
- The `sandbox` directive is **header-only**. It is ignored in a `<meta>` tag and
  ignored under `Content-Security-Policy-Report-Only`. It must be a real response
  header — which is exactly what a Worker is good at, but it means this protection
  cannot be replicated by someone serving these files from static hosting.
- `allow-scripts` plus `allow-same-origin` together defeat the sandbox entirely. If
  anyone ever adds `allow-same-origin` to make something work, they have removed
  the entire protection while appearing to keep it. This deserves a comment in the
  code, not just an ADR.
- Any future feature that needs the document to talk back to PageVault (view
  tracking from inside the page, an in-document share button) is blocked by this,
  by design. Such a feature needs the iframe-wrapper design instead. That is a
  real constraint on v2 and it should be paid honestly rather than by weakening
  this.

# PageVault — Sample Artifacts Plan (`examples/`)

> **Written 2026-07-15.** Covers GHI #31 (generic first-run test content) and the raw
> material it hands to #30 (the curated public showcase). Read `docs/architecture.md`
> first; the sample content is derived from it, not invented.

`examples/` is a committed source library of self-contained HTML artifacts. It has two
consumers: **this plan builds the artifacts**; #30 later curates a subset into the
official showcase portal. Same source HTML — who publishes it where is a deployment
choice.

---

## The organizing question

**What turns "it deployed" into "it works, and look what it can host"?**

A blank console is a dead first moment. `pagevault publish examples/...` → open the
link is a live one. The samples exist to make that first moment land, and — because
every one obeys the sandbox rules — they double as an **implicit conformance suite**:
they document "what a valid PageVault artifact looks like" by example.

## Decisions locked (2026-07-15)

- **Flat directory.** With 3–5 files, `examples/simulator/orbit.html`-style subfolders
  are redundant. Filenames carry the type; revisit if the set grows past ~8.
- **The first set is product-story content, not neutral placeholders.** Dan's call: the
  first four are *about PageVault*, built flashy to show range. This deviates from #31's
  original "neutral/generic sample" framing on purpose — these become #30's raw
  material. A later batch can add genuinely neutral/generic samples.
- **Copy obeys `VOICE.md`.** The flash lives in the pixels; the words stay first-person,
  plain-declarative, banned-phrase-clean. Content is sourced from `architecture.md` +
  the ADRs, never freelanced product claims.

## Visual foundation (see memory `visual-identity.md`)

A **standalone PageVault identity**, decoupled from djk-brand:

- **Accent: amber** (`#F59E0B` base / `#FBBF24` hover), distinct from djk-brand's
  reserved `#BA7517`.
- **Dark by default, with a working light toggle.** Semantic surface tokens resolve per
  theme (near-black ground, never pure black).
- **Wordmark: aperture** — access as a lens that opens. No vault dial.
- One shared inline token block + aperture SVG, piloted on the Architecture artifact,
  reused across the rest. An embedded typeface replaces the system-font stand-in for
  deliverables (avoid Inter / Space Grotesk defaults).

## The four artifacts (build order)

| # | File | Demonstrates | Source |
|---|---|---|---|
| 1 | `architecture.html` | Animated request flow: `Browser → Access (who?) → Worker · canView() (may?) → KV`. Click a node to trace the path; toggle the two questions. | `architecture.md` §1,3,5; ADR-001/004/007 |
| 2 | `overview.html` | Hero + scripted fake terminal (`pagevault publish` types itself, returns a URL). Scroll-driven reveals. | `architecture.md` §1,2 |
| 3 | `workflow.html` | The share journey; money shot = "add a teammate = **one write, not fourteen**" as a live counter. | `architecture.md` §1,10 |
| 4 | `comparison.html` | The honest matrix, interactive — including the rows where incumbents win. | README comparison table; `architecture.md` §11,12 |

Architecture goes first: lowest copy-risk, highest wow, and it forces the reusable token
block + aperture SVG into existence.

## Conformance rules (every sample)

- Single self-contained HTML, inline CSS/JS.
- **Zero external hosts** — no CDN fonts, no `https:` images. Prefer SVG/CSS; data-URI
  any raster. (Stricter than the live CSP on purpose.)
- Runs JS by design (proves `allow-scripts`).
- **Opaque-origin safe** — any `localStorage`/`sessionStorage` access wrapped in
  try/catch; nothing depends on persistence.
- Real routes only: `/v/{slug}`, `/v/{slug}/{id}`, `/render`, `/p/{token}`, `/pub/`.

## Deferred — blocked on consumers that don't exist yet

These #31 tasks wait on sibling issues; boxes stay unchecked with a pointer:

- Wire "publish your first sample" into the **CLI `publish`** → #7 (no `cli/` yet).
- Wire it into the **quickstart** and use a sample as the **`make smoke`** payload → #10
  (no `smoke` target yet).
- Wire it into the **post-deploy path** → #28.

## Guardrails

- Nothing from `~/yukon/brain` enters the public repo. Only finished, public-by-design
  HTML lands in `examples/`.
- Banned-phrase list (`VOICE.md`) is absolute in all sample copy.

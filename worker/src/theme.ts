/**
 * One palette, one place.
 *
 * The neutral white/cool-grey + signal-blue system (#67). It began life inline in the portal
 * console and was copied — partially, and then not at all — into the other HTML surfaces, so the
 * Worker ended up serving two identities at once: a blue console, and amber/cream landing, error,
 * viewer and OAuth pages left over from the retired aperture brand. The favicon and the landing
 * page disagreed on the same page load.
 *
 * Every surface now interpolates `THEME` at the top of its own `<style>`. That works under all
 * three CSP shapes in the codebase — a nonce belongs to the `<style>` tag, not its contents — and
 * it means the next token change happens once.
 *
 * Light and dark are both first-class. `color-scheme` is declared so form controls and scrollbars
 * follow, which is the bit that gives a hand-rolled dark mode away when it is missing.
 */
export const THEME = `
  :root {
    color-scheme: light dark;
    --paper: #f5f6f8; --surface: #ffffff; --ink: #1a1d21; --muted: #5b6470;
    --accent: #2f6fed; --border: #e3e6ea; --hover: #eef1f5;
    --chip-bg: rgba(47,111,237,.10); --chip-fg: #2f6fed;
    --draft-bg: rgba(91,100,112,.12); --draft-fg: #5b6470;
    --code-bg: #eff2f6; --danger: #c0392b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #16181c; --surface: #20242a; --ink: #e6e8eb; --muted: #9aa3ad;
      --accent: #5b8cf5; --border: #2a2e35; --hover: #1e2228;
      --chip-bg: rgba(91,140,245,.16); --chip-fg: #8fb0f7;
      --draft-bg: rgba(154,163,173,.16); --draft-fg: #9aa3ad;
      --code-bg: #171a1f; --danger: #ff7a6e;
    }
  }`;

/**
 * The PageVault mark: a leaning V knocked out of a blue rounded square.
 *
 * Shared by the console `<link>`, the landing `<link>`, the `/favicon.ico` route, and the landing
 * page's own wordmark — which is what a remote MCP client (claude.ai) fetches for the connector's
 * icon. Carries no width/height so a caller sizes it with CSS.
 */
/** The product page. One constant, so a rebrand or a domain move is a single edit. */
export const PRODUCT_URL = "https://danjamk.github.io/pagevault";

/**
 * The attribution mark, shown on client-facing surfaces unless the operator turns it off.
 *
 * This deliberately overturns an earlier decision. The portal index and the viewer shell carried
 * "no webfont, no logo — a portal is still the client's work, not our product, above the fold",
 * and that instinct was right about *weight*: a consultant's deliverable should not look like it
 * was made from a template, because looking substantial is what their fee is for. So this is one
 * muted line at the end of the chrome, never a logo and never above the client's own title —
 * closer to a printer's mark than a banner.
 *
 * `rel="noopener"` because it opens in a new tab; `nofollow` because a client portal is not a
 * backlink farm and we are not asking anyone's deliverable to carry SEO for us.
 */
export const attribution = (env: { PAGEVAULT_BRANDING?: string }): string =>
  showBranding(env)
    ? `<a class="pv-mark" href="${PRODUCT_URL}" target="_blank" rel="noopener nofollow">Powered by PageVault</a>`
    : "";

/**
 * Off only when the operator says so, in exactly those words.
 *
 * The comparison is inverted from `AUTH_MODE`'s on purpose. There, an unset variable had to fail
 * CLOSED, so it matched `"none"` exactly and anything else meant "authenticate". Here the risk runs
 * the other way: the safe default for a var that might simply be missing is the visible one, and a
 * forker who wants it gone gets a documented switch rather than a patch to maintain.
 */
export const showBranding = (env: { PAGEVAULT_BRANDING?: string }): boolean =>
  (env.PAGEVAULT_BRANDING ?? "").trim().toLowerCase() !== "off";

/** Shared styling for the mark. Muted, small, and never competing with the client's own content. */
export const ATTRIBUTION_CSS = `
  .pv-mark {
    color: var(--muted); text-decoration: none; font-size: .75rem;
    white-space: nowrap; opacity: .75;
  }
  .pv-mark:hover { color: var(--accent); opacity: 1; }`;

export const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect x="2" y="2" width="28" height="28" rx="8" fill="#2F6FED"/>' +
  '<path d="M9.5 10 L16 22.5 L22.5 10" transform="translate(2.5 0) skewX(-7)" stroke="#fff" stroke-width="4.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

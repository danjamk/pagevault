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
export const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect x="2" y="2" width="28" height="28" rx="8" fill="#2F6FED"/>' +
  '<path d="M9.5 10 L16 22.5 L22.5 10" transform="translate(2.5 0) skewX(-7)" stroke="#fff" stroke-width="4.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

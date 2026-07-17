import type { Env } from "./env.js";

/**
 * Two small trusted pages served from our own origin: the quiet root landing (shown at `/`
 * in publish mode) and a friendly console 403. Static HTML, no JS, no user content — so a
 * tight CSP with a single nonce for the inline <style> is all they need.
 *
 * They deliberately reveal nothing about portals, documents, or the owner. `/` is the
 * most-guessable URL on the deployment, and "portals invisible until needed" (ADR-005)
 * applies most strongly here: a stranger who truncates a shared link, or guesses the bare
 * host, must learn only that this is a PageVault instance — never who runs it or what's in it.
 *
 * Which page `/` serves is decided by the router (index.ts) from `CF_ACCESS_AUD_ADMIN`:
 * set only once rung 3 provisions Access. Absent → no console to redirect to → land here.
 */

const PROJECT_URL = "https://github.com/danjamk/pagevault";

const APERTURE = `<svg viewBox="0 0 100 100" width="30" height="30" aria-hidden="true">
  <circle cx="50" cy="50" r="44" fill="none" stroke="var(--amber-dim)" stroke-width="4"/>
  <g fill="var(--amber)">
    <path d="M50 10 A40 40 0 0 1 84 30 L50 50 Z" opacity=".9"/>
    <path d="M84 30 A40 40 0 0 1 84 70 L50 50 Z" opacity=".7"/>
    <path d="M84 70 A40 40 0 0 1 50 90 L50 50 Z" opacity=".55"/>
    <path d="M50 90 A40 40 0 0 1 16 70 L50 50 Z" opacity=".7"/>
    <path d="M16 70 A40 40 0 0 1 16 30 L50 50 Z" opacity=".85"/>
    <path d="M16 30 A40 40 0 0 1 50 10 L50 50 Z" opacity="1"/>
  </g>
</svg>`;

function shell(title: string, inner: string, status: number): Response {
  const nonce = crypto.randomUUID();
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style nonce="${nonce}">
  :root {
    --bg:#14110c; --ink:#efe7d6; --muted:#a99c82; --amber:#e0a24a; --amber-dim:#b9822f;
    --sans:system-ui,-apple-system,"Segoe UI",sans-serif;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f2e9; --ink:#241d12; --muted:#6c624d; --amber:#b9822f; --amber-dim:#9a6c25; }
  }
  html,body { height:100%; }
  body {
    margin:0; background:var(--bg); color:var(--ink);
    font:16px/1.6 var(--sans); -webkit-font-smoothing:antialiased;
    display:flex; align-items:center; justify-content:center; padding:1.5rem;
  }
  main { max-width:26rem; text-align:center; }
  .mark { display:inline-flex; align-items:center; gap:.55rem; margin-bottom:1.6rem; }
  .mark span { font:600 13px/1 var(--sans); letter-spacing:.14em; color:var(--muted); text-transform:uppercase; }
  h1 { font-size:1.35rem; letter-spacing:-.01em; margin:0 0 .6rem; }
  p { color:var(--muted); margin:0; }
  a { color:var(--amber); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .foot { margin-top:2rem; font-size:.82rem; }
</style>
</head><body><main>
  <div class="mark">${APERTURE}<span>PageVault</span></div>
  ${inner}
</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [
        "default-src 'none'",
        `style-src 'nonce-${nonce}'`,
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "Cache-Control": "public, max-age=300",
    },
  });
}

/** The quiet landing at `/` when there is no console to redirect to (rung 1/2). */
export function rootLanding(): Response {
  return shell(
    "PageVault",
    `<h1>Nothing to see at this address</h1>
     <p>This is a private PageVault instance. If someone shared a document with you,
     open the link they sent — the document lives there, not here.</p>
     <p class="foot"><a href="${PROJECT_URL}">What is PageVault?</a></p>`,
    200,
  );
}

/**
 * A friendly 403 for `/admin`, in place of bare `Forbidden` text. Context-aware on the same
 * signal the router uses: with Access provisioned it is genuinely owner-only; without it, the
 * console simply isn't available at this tier, and the honest thing is to say so.
 */
export function consoleForbidden(env: Env): Response {
  const inner = env.CF_ACCESS_AUD_ADMIN
    ? `<h1>Owner only</h1>
       <p>This console is limited to the site owner. If that's you, sign in through your
       Cloudflare Access login and reload.</p>`
    : `<h1>Console isn't enabled here</h1>
       <p>The owner console needs Cloudflare Access, which isn't turned on for this
       deployment. At this tier, publish over the API or the MCP server instead.</p>
       <p class="foot"><a href="${PROJECT_URL}">How to enable portals</a></p>`;
  return shell("PageVault — console", inner, 403);
}

import { emailsMatch } from "./access.js";
import { identify } from "./auth.js";
import { SORA_WORDMARK_WOFF2 } from "./console-font.js";
// The real limits, interpolated into the UI rather than retyped. A hint that says "max 300"
// while the server enforces something else is worse than no hint — it gets believed.
import {
  MAX_NAME_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_TAG_CHARS,
  MAX_TAGS,
  MAX_TITLE_CHARS,
} from "./documents.js";
import type { Env } from "./env.js";
import { FAVICON_SVG, consoleForbidden } from "./pages.js";
import { mintSession } from "./session.js";

/**
 * The owner console at /admin. Server-rendered, vanilla JS, no framework, no build. ADR-004.
 *
 * Two independent walls guard it. Cloudflare Access gates /admin to the owner — its app
 * includes only them — and the Worker checks the verified email against OWNER_EMAIL again
 * here, so a misconfigured Access policy is not a single point of failure. The page then
 * talks to /api with a short-lived session token, never PAGEVAULT_API_TOKEN and never a
 * cookie, under a strict nonced CSP distinct from (and tighter than) the artifact sandbox:
 * a bug in artifact serving must not reach the page that holds the session token.
 *
 * Look & feel follows the Claude Design console handoff (#67): the pv-* token system,
 * light + dark themes, the leaning-v brand, and a single-selected-portal layout. All brand
 * graphics are inline SVG; the wordmark's Sora glyphs are an inlined woff2 subset (CSP: no
 * webfont links). The sharing model stays link-first / public-by-default (ADR-011) — the
 * handoff mockup predates that decision and is not followed on that point.
 */
export async function handleConsole(request: Request, env: Env): Promise<Response> {
  const identity = await identify(request, env, "admin");
  if (!identity || !emailsMatch(identity.email, env.OWNER_EMAIL)) {
    return consoleForbidden(env);
  }

  const session = await mintSession(env, identity.email);
  if (!session) {
    return new Response("Server misconfigured: PAGEVAULT_API_TOKEN is not set", { status: 500 });
  }

  const nonce = crypto.randomUUID();
  const origin = new URL(request.url).origin;

  return new Response(page(session, nonce, identity.email, env.PAGEVAULT_VERSION || "dev", env.PAGEVAULT_DEPLOYED_AT || "", origin), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [
        "default-src 'none'",
        `style-src 'nonce-${nonce}'`,
        `script-src 'nonce-${nonce}'`,
        "img-src data:", // inline SVG marks reference nothing external; kept tight
        "font-src data:", // the inlined Sora wordmark subset (same-origin data URI)
        "connect-src 'self'", // the fetch() calls to /api
        "form-action 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join("; "),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

/**
 * One server-rendered page: a sidebar of portals, one selected portal in the main panel. A
 * document row leads with a document-type icon and carries an access *badge* — a neutral chip
 * whose icon is tinted by how far the document can travel (only you / team / anyone-with-the-
 * link / public). Expanding a row reveals the ADR-011 sharing controls.
 *
 * The session token is embedded as a JS string and sent as a bearer; on any 401 the page
 * reloads, which re-authenticates through Access and mints a fresh token (ADR-004).
 *
 * KV note: after a mutation we re-render the affected row from the API *response* (which is
 * read-your-write), never from a re-list — a re-list is eventually consistent and would show
 * stale state for up to a minute.
 */
function page(session: string, nonce: string, owner: string, version: string, deployedAt: string, origin: string): string {
  // Access logout lands on Cloudflare's default page and, on the next login, has no
  // redirect_url — so the user is dropped somewhere that 404s. `returnTo` closes the loop:
  // logout → login → back to /admin. Absolute (from the request origin) so it is right on
  // both the test and prod hostnames.
  const logoutUrl = `${origin}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(`${origin}/admin`)}`;
  // Footer identity: the baked version links to the changelog; the deploy date (baked at deploy,
  // ADR-010) answers "how fresh is this?". Both degrade gracefully before a redeploy sets them.
  const changelogUrl = "https://github.com/danjamk/pagevault/blob/main/CHANGELOG.md";
  // Date + time (UTC) — a day is too coarse to tell one day's redeploys apart. "2026-07-21T11:11"
  // → "2026-07-21 11:11 UTC". Labeled UTC because the stamp is, and the console renders anywhere.
  const deployDate = deployedAt ? esc(`${deployedAt.slice(0, 16).replace("T", " ")} UTC`) : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PageVault — console</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">
<script nonce="${nonce}">
  // Set the theme before first paint so there is no light→dark flash on a dark-mode load.
  (function () {
    try {
      var t = localStorage.getItem("pv-theme");
      if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    } catch (e) {}
  })();
</script>
<style nonce="${nonce}">
  @font-face {
    font-family:"PV Sora";
    src:url(${SORA_WORDMARK_WOFF2}) format("woff2");
    font-weight:400 800; font-style:normal; font-display:swap;
  }

  /* ── Design tokens (Claude Design handoff #67). Light is the default; the dark set is
     applied by prefers-color-scheme, then hard-overridden by an explicit data-theme. ── */
  :root {
    --pv-bg:#F5F6F8; --pv-surface:#FFFFFF; --pv-surface-2:#FBFBFC; --pv-border:#E6E8EC;
    --pv-border-2:#EDEFF2; --pv-ink:#16181D; --pv-text:#454B57; --pv-text-2:#5B6270;
    --pv-muted:#8A909C; --pv-faint:#A2A8B4; --pv-chip:#EFF1F4; --pv-chip-bd:#E6E8EC;
    --pv-field-bg:#FFFFFF; --pv-field-bd:#D8DBE0; --pv-accent:#2F6FED; --pv-accent-hover:#1F51B8;
    --pv-accent-soft:#F0F4FB; --pv-header:#FFFFFF; --pv-code-bg:#EEF3FE; --pv-code-bd:#DCE7FD;
    --pv-code-tx:#2F6FED; --pv-danger:#C6425A; --pv-warn:#B7791F;
    --pv-lv-individual:#8A909C; --pv-lv-team:#2F6FED; --pv-lv-link:#B7791F; --pv-lv-public:#C6425A;
  }
  ${DARK_TOKENS_MEDIA(nonce)}
  :root[data-theme="dark"] { ${DARK_TOKENS} }
  :root[data-theme="light"] { color-scheme:light; }

  *,*::before,*::after { box-sizing:border-box; }
  body {
    margin:0; background:var(--pv-bg); color:var(--pv-ink);
    font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .mono { font-family:ui-monospace,"SF Mono",Menlo,monospace; }
  /* The inline SVG sprite holds the <symbol> defs. It must take no layout space — and it must
     be hidden via a CLASS, never an inline style attribute: the console CSP is
     style-src 'nonce-…' with no unsafe-inline, which blocks inline styles outright. Left inline,
     the attribute is dropped, the <svg> renders at its default 300x150, and the page shifts down. */
  .sprite { position:absolute; width:0; height:0; overflow:hidden; }
  .min0 { min-width:0; }
  .icon { width:1em; height:1em; fill:none; stroke:currentColor; stroke-width:1.8;
          stroke-linecap:round; stroke-linejoin:round; flex:none; }
  input:focus-visible, button:focus-visible, a:focus-visible, select:focus-visible {
    outline:2px solid var(--pv-accent); outline-offset:1px;
  }

  /* ── Top bar ── */
  header { position:sticky; top:0; z-index:5; background:var(--pv-header);
           border-bottom:1px solid var(--pv-border); }
  .bar { max-width:1240px; margin:0 auto; display:flex; align-items:center;
         justify-content:space-between; gap:1rem; padding:13px 28px; }
  .brand { display:flex; align-items:center; gap:11px; min-width:0; }
  .mark { width:26px; height:26px; flex:none; }
  .wm { font-family:"PV Sora",-apple-system,system-ui,sans-serif; font-size:20px; font-weight:600;
        letter-spacing:-0.5px; color:var(--pv-ink); white-space:nowrap; }
  .wm .v { color:var(--pv-accent); font-weight:700; display:inline-block; transform:skewX(-7deg); }
  .wm .con { font-weight:400; color:var(--pv-muted); }
  .actions { display:flex; align-items:center; gap:16px; }
  .ttoggle { display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px;
             background:transparent; border:1px solid var(--pv-field-bd); border-radius:9px;
             color:var(--pv-text-2); cursor:pointer; }
  .ttoggle:hover { border-color:var(--pv-accent); color:var(--pv-accent); }
  .ttoggle .icon { width:16px; height:16px; stroke-width:1.7; }
  .profile-wrap { position:relative; display:inline-flex; }
  .profile { width:34px; height:34px; border-radius:50%; border:1px solid var(--pv-field-bd);
             background:var(--pv-accent-soft); color:var(--pv-accent); font:inherit; font-size:14px;
             font-weight:600; text-transform:uppercase; cursor:pointer; display:inline-flex;
             align-items:center; justify-content:center; }
  .profile:hover { border-color:var(--pv-accent); }
  .pmenu { position:absolute; top:calc(100% + 8px); right:0; min-width:220px; padding:6px; z-index:10;
           background:var(--pv-surface); border:1px solid var(--pv-border); border-radius:10px;
           box-shadow:0 12px 32px rgba(15,18,22,.18); }
  .pmenu[hidden] { display:none; }
  .pmenu-who { display:flex; flex-direction:column; gap:2px; padding:8px 10px; margin-bottom:4px;
               border-bottom:1px solid var(--pv-border-2); }
  .pmenu-label { font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:var(--pv-faint); }
  .pmenu-email { font-size:13px; color:var(--pv-ink); word-break:break-all; }
  .pmenu-item { display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:7px;
                font-size:13px; color:var(--pv-text); text-decoration:none; cursor:pointer; }
  .pmenu-item:hover { background:var(--pv-surface-2); color:var(--pv-ink); }
  .pmenu-item .icon { width:15px; height:15px; }

  /* ── Buttons ── */
  .btn { display:inline-flex; align-items:center; gap:7px; font:inherit; font-size:13px;
         font-weight:500; padding:8px 14px; border:1px solid var(--pv-field-bd); border-radius:9px;
         background:var(--pv-field-bg); color:var(--pv-ink); cursor:pointer; text-decoration:none; }
  .btn:hover { border-color:var(--pv-accent); color:var(--pv-accent); }
  .btn.primary { background:var(--pv-accent); border-color:var(--pv-accent); color:#fff; }
  .btn.primary:hover { background:var(--pv-accent-hover); border-color:var(--pv-accent-hover); color:#fff; }
  .btn.sm { font-size:12.5px; padding:6px 11px; border-radius:7px; }
  .btn.warn:hover { border-color:var(--pv-warn); color:var(--pv-warn); }
  .btn.ghost { background:none; border:none; color:var(--pv-accent); padding:0; font-weight:500; }
  .btn.ghost:hover { color:var(--pv-accent-hover); }
  .btn.danger { background:none; border:none; color:var(--pv-danger); padding:8px 6px; }
  .btn.danger:hover { text-decoration:underline; color:var(--pv-danger); }
  .btn .icon { width:14px; height:14px; }
  button.x { border:0; background:none; padding:0 2px; color:var(--pv-faint); cursor:pointer;
             display:inline-flex; }
  button.x:hover { color:var(--pv-danger); }
  button.x .icon { width:14px; height:14px; }

  /* ── Shell: sidebar + main ── */
  .shell { max-width:1240px; margin:0 auto; display:flex; align-items:flex-start; gap:0; }
  .side { width:266px; flex:none; align-self:stretch; border-right:1px solid var(--pv-border);
          padding:24px 16px; min-height:calc(100vh - 57px); }
  .side-head { display:flex; align-items:center; justify-content:space-between;
               padding:0 8px; margin-bottom:12px; }
  .ulabel { font-size:11px; font-weight:600; letter-spacing:1.3px; text-transform:uppercase;
            color:var(--pv-muted); }
  .prow { display:flex; align-items:center; gap:11px; width:100%; text-align:left; background:none;
          border:none; border-left:2px solid transparent; border-radius:0 8px 8px 0;
          padding:9px 12px; margin-bottom:2px; cursor:pointer; font:inherit; }
  .prow:hover { background:var(--pv-accent-soft); }
  .prow[aria-current="true"] { background:var(--pv-accent-soft); border-left-color:var(--pv-accent); }
  .prow .nm { flex:1; min-width:0; }
  .prow .nm b { display:block; font-size:14px; font-weight:500; letter-spacing:-0.2px;
                color:var(--pv-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .prow[aria-current="true"] .nm b { color:var(--pv-ink); }
  .prow .nm span { display:block; font-size:11.5px; color:var(--pv-faint); }
  .prow .cnt { font-size:12px; color:var(--pv-muted); background:var(--pv-chip); border-radius:5px;
               padding:1px 8px; font-variant-numeric:tabular-nums; }
  .side-div { height:1px; background:var(--pv-border); margin:20px 8px; }
  .legend { padding:0 8px; }
  .legend .rows { display:flex; flex-direction:column; gap:11px; margin-top:12px; }
  .legend .r { display:flex; align-items:center; gap:10px; font-size:12.5px; color:var(--pv-text-2); }
  .side-foot { display:flex; flex-direction:column; gap:6px; padding:16px 8px 0; margin-top:20px;
               border-top:1px solid var(--pv-border); }
  .side-foot .tagline { font-size:11.5px; color:var(--pv-faint); line-height:1.5; }
  /* Access seats (#44). Muted until it matters, red at the limit — where "the limit" is the free
     plan's 50, which we assume rather than observe, so the label always names the plan. */
  .side-foot .seats { font-size:11.5px; color:var(--pv-faint); line-height:1.5; }
  .side-foot .seats .n { color:var(--pv-muted); font-variant-numeric:tabular-nums; }
  .side-foot .seats.hot, .side-foot .seats.hot .n { color:var(--pv-danger); font-weight:600; }
  .side-foot .build { font-size:11px; color:var(--pv-faint); line-height:1.5; word-break:break-word;
                      font-variant-numeric:tabular-nums; }
  .side-foot .build a { color:var(--pv-muted); text-decoration:none; }
  .side-foot .build a:hover { color:var(--pv-accent); text-decoration:underline; }

  .main { flex:1; min-width:0; padding:28px 32px 64px; }

  @media (max-width:860px) {
    .shell { flex-direction:column; }
    .side { width:auto; align-self:auto; min-height:0; border-right:none;
            border-bottom:1px solid var(--pv-border); }
    .main { padding:20px; }
  }

  /* ── Access badge (neutral chip, level-tinted icon) ── */
  .badge { display:inline-flex; align-items:center; gap:6px; background:var(--pv-chip);
           border:1px solid var(--pv-chip-bd); border-radius:6px; color:var(--pv-text);
           font-size:12px; font-weight:500; padding:3px 10px 3px 7px; white-space:nowrap; }
  .badge .icon { width:15px; height:15px; }
  .lv-individual { color:var(--pv-lv-individual); }
  .lv-team { color:var(--pv-lv-team); }
  .lv-link { color:var(--pv-lv-link); }
  .lv-public { color:var(--pv-lv-public); }

  /* ── Portal header card ──
     Base access stays top-right beside the title; the buttons get their own right-aligned row
     under the description. As one right-hand column all five stacked, and that column set the
     card's height while leaving a band of empty space beside the portal name. */
  .phead { background:var(--pv-surface); border:1px solid var(--pv-border); border-radius:14px;
           padding:18px 22px; margin-bottom:20px; }
  .phead-top { display:flex; align-items:flex-start; justify-content:space-between; gap:16px;
               flex-wrap:wrap; }
  .phead h1 { font-size:22px; font-weight:600; letter-spacing:-0.6px; margin:0; color:var(--pv-ink); }
  .phead .titrow { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
  .phead .slug { font-size:13px; color:var(--pv-muted); }
  .phead p { font-size:13.5px; line-height:1.5; color:var(--pv-text-2); margin:6px 0 0; max-width:560px; }
  .phead .base { display:flex; align-items:center; gap:8px; flex:none; }
  .phead .base .lb { font-size:11px; letter-spacing:1px; text-transform:uppercase; color:var(--pv-faint);
                     flex:none; }
  .pacts { display:flex; align-items:center; justify-content:flex-end; gap:8px; flex-wrap:wrap;
           margin-top:12px; }
  .pacts:empty { display:none; }
  .seats { margin-top:16px; padding-top:14px; border-top:1px solid var(--pv-border-2); }
  .seats .cap { display:flex; align-items:center; gap:8px; margin-bottom:4px; font-size:13.5px;
                color:var(--pv-ink); }
  .seats .cap .icon { width:15px; height:15px; color:var(--pv-text-2); }
  .seats .cap .sub { font-size:12.5px; color:var(--pv-muted); font-weight:400; }
  .seatrow { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:12px; }

  /* ── Documents ── */
  .dochead { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;
             padding:0 2px; }
  .dochead .h { display:flex; align-items:baseline; gap:10px; }
  .dochead-act { display:flex; align-items:center; gap:10px; }
  .dochead h2 { font-size:16px; font-weight:600; letter-spacing:-0.3px; margin:0; color:var(--pv-ink); }
  .dochead .cnt { font-size:13px; color:var(--pv-muted); }
  .dochead-act .fresh { font-size:11.5px; color:var(--pv-faint); white-space:nowrap; }
  .doclist { background:var(--pv-surface); border:1px solid var(--pv-border); border-radius:14px;
             overflow:hidden; }
  .item + .item { border-top:1px solid var(--pv-border-2); }
  .doc { display:flex; align-items:center; gap:16px; padding:15px 20px; cursor:pointer; }
  .doc:hover { background:var(--pv-surface-2); }
  .doc[aria-expanded="true"] { background:var(--pv-surface-2); }
  .doc .dtype { width:20px; height:20px; stroke-width:1.5; color:var(--pv-muted); }
  /* Pinning (#142). The controls are quiet until the row is hovered or one of them has focus —
     a permanent column of arrows beside every document makes reordering look like the point of
     the page, and it is not. A PINNED row keeps its control visible: that is the state, not an
     affordance, and hiding it would leave nothing to say the order is deliberate. */
  .pinctl { display:inline-flex; align-items:center; gap:2px; }
  .pinb { background:none; border:0; padding:4px 6px; cursor:pointer; color:var(--pv-muted);
          line-height:1; font-size:13px; border-radius:4px; opacity:0; transition:opacity .12s; }
  .pinb .icon { width:17px; height:17px; }
  .doc:hover .pinb, .pinb:focus-visible, .doc.ispin .pinb { opacity:1; }
  .pinb:hover:not([disabled]) { background:var(--pv-surface-3, var(--pv-surface-2)); color:var(--pv-ink); }
  .pinb[disabled] { opacity:.25; cursor:default; }
  .doc:hover .pinb[disabled], .doc.ispin .pinb[disabled] { opacity:.25; }
  .pinb.on { color:var(--pv-accent, var(--pv-ink)); }
  /* A pinned row is marked on the leading edge rather than tinted: the badge column already
     carries reach, and a second background colour there would compete with it. */
  .doc.ispin { box-shadow: inset 3px 0 0 var(--pv-accent, var(--pv-muted)); }
  .doc .body { flex:1; min-width:0; }
  .doc .trow { display:flex; align-items:center; gap:9px; }
  .doc .t { font-size:14.5px; font-weight:500; letter-spacing:-0.2px; color:var(--pv-ink);
            text-decoration:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .doc a.t:hover { text-decoration:underline; }
  .doc .fmt { font-size:10.5px; font-weight:500; color:var(--pv-muted); text-transform:uppercase;
              letter-spacing:.5px; }
  .doc .widened { display:inline-flex; align-items:center; gap:5px; font-size:11.5px;
                  color:var(--pv-warn); margin-top:4px; }
  .doc .widened .icon { width:12px; height:12px; }
  .doc .d { font-size:12.5px; color:var(--pv-muted); flex:none; width:88px; text-align:right;
            font-variant-numeric:tabular-nums; }
  .doc .chev { width:18px; height:18px; color:var(--pv-muted); transition:transform .15s ease; }
  .doc[aria-expanded="true"] .chev { transform:rotate(180deg); color:var(--pv-muted); }
  @media (prefers-reduced-motion:reduce) { .doc .chev { transition:none; } }

  /* ── Expanded sharing panel (ADR-011, restyled) ── */
  .detail { padding:6px 20px 22px 56px; background:var(--pv-surface-2);
            border-top:1px solid var(--pv-border-2); font-size:13px; }
  .detail[hidden] { display:none; }
  .detail code { font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:12.5px;
                 word-break:break-all; }
  .dhint { color:var(--pv-muted); font-size:12px; margin:.15rem 0 .5rem; line-height:1.5; }
  .dhint.err { color:var(--pv-danger); }
  .warnline { display:flex; align-items:center; gap:.4rem; color:var(--pv-warn); font-size:12.5px;
              background:var(--pv-code-bg); border:1px solid var(--pv-code-bd); border-radius:7px;
              padding:.4rem .55rem; margin:10px 0; }
  .warnline .icon { flex:none; }

  /* Traffic (#164). Plain elements sized by percentage — no chart library, no build step, and
     nothing that needs a second request. A sparkline is a row of divs. */
  .tgrid { display:flex; gap:28px; flex-wrap:wrap; margin:14px 0 18px; }
  .tstat { display:flex; flex-direction:column; }
  .tstat b { font-size:26px; line-height:1.1; font-weight:600; }
  .tstat span { color:var(--pv-muted); font-size:12px; }
  .tsec { margin:18px 0; }
  .tsec .ulabel { display:block; margin-bottom:8px; }
  /* The chart is a flex row: a fixed y-axis column, then the plot. The axis is HTML rather than
     <text> inside the SVG because the plot uses preserveAspectRatio="none" to fill the panel, which
     would stretch any glyph in it out of shape. Nothing here is positioned, so nothing needs an
     inline style attribute the nonced CSP would drop. */
  .chart { display:flex; align-items:stretch; gap:8px; }
  .yaxis { flex:0 0 auto; display:flex; flex-direction:column; justify-content:space-between;
           align-items:flex-end; height:64px; min-width:22px;
           color:var(--pv-faint); font-size:11px; font-variant-numeric:tabular-nums; line-height:1; }
  .plot { flex:1 1 auto; min-width:0; }
  .spark { display:block; width:100%; height:64px;
           border-bottom:1px solid var(--pv-border-2); }
  .spark .bar { fill:var(--pv-accent); opacity:.85; }
  .spark .bar:hover { opacity:1; }
  /* A compacted month is a different KIND of number, not a smaller one — it covers 30 days rather
     than one. Lighter so a reader asks why, and the hint under the chart answers. */
  .spark .bar.mo { opacity:.45; }
  .spark .grid { stroke:var(--pv-border-2); stroke-width:.5; vector-effect:non-scaling-stroke; }
  /* One span per column, evenly distributed — the same even distribution the bars get from their
     fixed step, so they line up without either knowing about the other. */
  .dvals { display:flex; margin-top:3px; }
  .dvals span { flex:1 1 0; min-width:0; text-align:center; color:var(--pv-muted);
                font-size:10.5px; font-variant-numeric:tabular-nums; }
  .srange { display:flex; justify-content:space-between; color:var(--pv-faint); font-size:11.5px; margin-top:4px; }
  .trow { display:flex; align-items:center; gap:10px; padding:3px 0; font-size:13px; }
  .tname { flex:0 0 168px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tnum { flex:none; min-width:40px; text-align:right; font-variant-numeric:tabular-nums; color:var(--pv-muted); }
  .tbar { flex:1 1 auto; height:9px; background:var(--pv-code-bg); border-radius:3px; }
  .tbar rect { fill:var(--pv-accent); opacity:.7; }
  .cmd { font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:12.5px;
         background:var(--pv-code-bg); border:1px solid var(--pv-code-bd); border-radius:5px; padding:1px 5px; }
  .sharebar { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; margin-top:14px;
              background:var(--pv-surface); border:1px solid var(--pv-border); border-radius:9px;
              padding:.55rem .7rem; }
  .sharebar .lb { display:inline-flex; align-items:center; gap:.35rem; color:var(--pv-faint);
                  font-size:11px; text-transform:uppercase; letter-spacing:.5px; flex:none; }
  .sharebar .lb .icon { width:14px; height:14px; color:var(--pv-lv-link); }
  .sharebar code { flex:1 1 12rem; min-width:0; color:var(--pv-code-tx); background:var(--pv-code-bg);
                   border:1px solid var(--pv-code-bd); border-radius:7px; padding:6px 11px;
                   overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sharebar.dim code { color:var(--pv-muted); text-decoration:line-through; }
  /* The details block (#140) — what the document IS, as opposed to who can open it. */
  .meta { display:grid; grid-template-columns:auto 1fr; gap:6px 14px; margin:0 0 2px; font-size:12.5px; }
  .meta dt { display:inline-flex; align-items:center; gap:.35rem; color:var(--pv-faint);
             font-size:11px; text-transform:uppercase; letter-spacing:.5px; padding-top:5px; }
  .meta dt .icon { width:14px; height:14px; color:var(--pv-muted); }
  .meta dd { margin:0; min-width:0; display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; }
  .meta dd code { color:var(--pv-code-tx); background:var(--pv-code-bg); min-width:0;
                  border:1px solid var(--pv-code-bd); border-radius:7px; padding:4px 9px;
                  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .meta .sub { color:var(--pv-muted); font-size:12px; }
  .tags { display:flex; flex-wrap:wrap; gap:6px; }
  .tag { background:var(--pv-chip); border:1px solid var(--pv-chip-bd); border-radius:6px;
         padding:2px 8px; font-size:12px; color:var(--pv-text-2); }
  .reason { display:flex; align-items:flex-start; gap:.5rem; font-size:13px; margin:14px 0 2px; }
  .reason .icon { width:16px; height:16px; margin-top:1px; }
  .reason.link .icon { color:var(--pv-lv-link); }
  .reason.public .icon { color:var(--pv-lv-public); }
  .reason.team .icon { color:var(--pv-lv-team); }
  .reason.individual .icon { color:var(--pv-lv-individual); }
  .reason .sub { color:var(--pv-muted); }
  .reachsel { display:flex; gap:.5rem; margin:14px 0 2px; flex-wrap:wrap; }
  .ropt { display:flex; align-items:center; gap:.4rem; border:1px solid var(--pv-field-bd);
          border-radius:7px; padding:7px 12px; cursor:pointer; background:var(--pv-field-bg);
          font:inherit; font-size:12.5px; color:var(--pv-text); }
  .ropt:hover { border-color:var(--pv-accent); }
  .ropt .icon { width:15px; height:15px; color:var(--pv-muted); }
  .ropt[aria-pressed="true"] { border-color:var(--pv-accent); background:var(--pv-accent-soft);
                               color:var(--pv-ink); font-weight:600; }
  .ropt[data-reach="open"] .icon { color:var(--pv-lv-link); }
  .ropt[data-reach="open"][aria-pressed="true"] { border-color:var(--pv-lv-link);
    background:var(--pv-code-bg); }
  .keynote { display:flex; align-items:flex-start; gap:.4rem; font-size:12px; color:var(--pv-text-2);
             background:var(--pv-code-bg); border:1px solid var(--pv-code-bd); border-radius:7px;
             padding:.45rem .6rem; margin:12px 0 2px; }
  .keynote .icon { width:14px; height:14px; color:var(--pv-lv-link); margin-top:1px; flex:none; }
  .draftbar { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; background:var(--pv-chip);
              border:1px solid var(--pv-chip-bd); border-radius:9px; padding:.55rem .7rem;
              font-size:12.5px; margin-top:14px; }
  .draftbar .icon { width:15px; height:15px; color:var(--pv-lv-individual); flex:none; }
  .grow { flex:1 1 auto; }
  .subrow { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; margin-top:18px;
            padding-top:14px; border-top:1px solid var(--pv-border-2); }
  .subrow .lb { color:var(--pv-text); font-size:12.5px; font-weight:500; display:inline-flex;
                align-items:center; gap:.4rem; }
  .subrow .lb .icon { width:15px; height:15px; color:var(--pv-muted); }
  .foot { display:flex; align-items:center; margin-top:18px; padding-top:14px;
          border-top:1px solid var(--pv-border-2); gap:8px; }

  .chips { list-style:none; display:flex; flex-wrap:wrap; gap:8px; margin:6px 0 10px; padding:0; }
  .chip { display:inline-flex; align-items:center; gap:8px; background:var(--pv-chip);
          border:1px solid var(--pv-chip-bd); border-radius:8px; padding:6px 8px 6px 12px;
          font-size:13px; color:var(--pv-text); }
  .addrow { display:flex; gap:8px; align-items:center; }
  .addrow input { flex:1 1 auto; max-width:240px; padding:8px 12px; border:1px solid var(--pv-field-bd);
                  border-radius:8px; font:inherit; font-size:13px; background:var(--pv-field-bg);
                  color:var(--pv-ink); }
  .addrow input::placeholder { color:var(--pv-faint); }

  .empty { color:var(--pv-muted); padding:24px 20px; font-size:13px; }
  .err { color:var(--pv-danger); }

  /* ── Dialogs (#43 new portal, #6 upload) ── */
  dialog { border:1px solid var(--pv-border); border-radius:14px; padding:0; background:var(--pv-surface);
           color:var(--pv-ink); max-width:30rem; width:calc(100% - 2rem);
           box-shadow:0 16px 50px rgba(15,18,22,.28); }
  dialog::backdrop { background:rgba(15,18,22,.45); }
  .dlg-head { display:flex; align-items:center; gap:.5rem; padding:14px 18px;
              border-bottom:1px solid var(--pv-border); font-weight:600; font-size:15px; }
  .dlg-head .icon { width:17px; height:17px; color:var(--pv-accent); }
  .dlg-body { padding:18px; display:flex; flex-direction:column; gap:14px; }
  .field { display:flex; flex-direction:column; gap:5px; }
  .field > label, .flabel label { font-size:12.5px; color:var(--pv-muted); }
  /* The info button is a SIBLING of the label, never inside it: a button nested in a label is
     invalid HTML, and the label's activation behavior competes with the button's own click. */
  .flabel { display:flex; align-items:center; gap:6px; }
  .field input[type=text], .field input[type=email], .field select {
    padding:8px 11px; border:1px solid var(--pv-field-bd); border-radius:8px; font:inherit;
    font-size:14px; background:var(--pv-field-bg); color:var(--pv-ink); }
  .field input::placeholder { color:var(--pv-faint); }
  .field .hint { font-size:11.5px; color:var(--pv-muted); }
  .kinds { display:flex; flex-direction:column; gap:8px; }
  .kindopt { display:flex; gap:10px; align-items:flex-start; border:1px solid var(--pv-field-bd);
             border-radius:9px; padding:10px 12px; cursor:pointer; }
  .kindopt:hover { border-color:var(--pv-accent); }
  .kindopt input { margin:2px 0 0; flex:none; }
  .kindopt .kb { display:flex; flex-direction:column; gap:2px; }
  .kindopt .kt { font-weight:600; font-size:13px; display:flex; align-items:center; gap:6px; }
  .kindopt .kt .icon { width:15px; height:15px; }
  .kindopt .kt.private .icon { color:var(--pv-lv-individual); }
  .kindopt .kt.restricted .icon { color:var(--pv-lv-team); }
  .kindopt .kt.public .icon { color:var(--pv-lv-public); }
  .kindopt .kd { font-size:12px; color:var(--pv-muted); line-height:1.45; }
  .kindopt:has(input:checked) { border-color:var(--pv-accent); background:var(--pv-accent-soft); }
  .dlg-foot { display:flex; justify-content:flex-end; gap:.6rem; padding:14px 18px;
              border-top:1px solid var(--pv-border); }
  .dlg-err { color:var(--pv-danger); font-size:12.5px; }
  .dlg-err[hidden] { display:none; }

  /* ── Field help (#140) ──
     Native popover: the toggle is the popovertarget ATTRIBUTE, so there is no inline handler
     and nothing for the nonced CSP to block. It renders in the top layer, so it sits above the
     dialog that opened it, and light-dismisses on Esc or an outside click for free. */
  .infobtn { width:15px; height:15px; padding:0; border-radius:50%; cursor:pointer;
             border:1px solid var(--pv-field-bd); background:var(--pv-field-bg);
             color:var(--pv-muted); font:inherit; font-size:10px; font-weight:700;
             font-style:italic; line-height:1; vertical-align:middle; }
  .infobtn:hover { border-color:var(--pv-accent); color:var(--pv-ink); }
  .pop { max-width:26rem; width:calc(100% - 2rem); padding:16px 18px; border-radius:12px;
         border:1px solid var(--pv-border); background:var(--pv-surface); color:var(--pv-ink);
         font-size:12.5px; line-height:1.55; }
  .pop::backdrop { background:rgba(0,0,0,.35); }
  .pop h3 { margin:0 0 8px; font-size:13.5px; color:var(--pv-ink); }
  .pop p { margin:0 0 8px; color:var(--pv-text-2); }
  .pop ul { margin:0 0 8px; padding-left:18px; color:var(--pv-text-2); }
  .pop li { margin:2px 0; }
  .pop code { background:var(--pv-code-bg); border:1px solid var(--pv-code-bd); border-radius:5px;
              padding:1px 5px; font-size:11.5px; color:var(--pv-code-tx); }
  .pop .btn { margin-top:4px; }
  /* Without popover support the panels have no UA display:none, so they would dump their whole
     body into the dialog and the button would do nothing. Hide both rather than degrade to that. */
  @supports not selector(:popover-open) { .pop, .infobtn { display:none; } }
  /* Live character budget. Silent until it matters — a counter on every field from the first
     keystroke reads as a constraint you are about to hit, which is the wrong default. */
  .count { color:var(--pv-faint); }
  .count.near { color:var(--pv-warn); }
  .count.over { color:var(--pv-danger); font-weight:600; }
  .dropzone { display:flex; align-items:center; justify-content:center; text-align:center; gap:.5rem;
              border:1.5px dashed var(--pv-field-bd); border-radius:10px; padding:18px 16px;
              color:var(--pv-muted); font-size:13px; cursor:pointer; background:var(--pv-surface-2); }
  .dropzone.drag { border-color:var(--pv-accent); background:var(--pv-accent-soft); color:var(--pv-ink); }
  .dropzone.has-file { border-style:solid; color:var(--pv-ink); }
  .dropzone code { font-family:ui-monospace,Menlo,monospace; font-size:12px; }
  .checkrow { display:flex; align-items:flex-start; gap:.5rem; font-size:13px; cursor:pointer; }
  .checkrow input { margin:2px 0 0; flex:none; }
  .donerow { display:flex; flex-direction:column; gap:.6rem; }
  .donerow .lnk { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }
  .donerow code { font-family:ui-monospace,Menlo,monospace; font-size:12.5px; word-break:break-all;
                  background:var(--pv-code-bg); border:1px solid var(--pv-code-bd); border-radius:7px;
                  padding:6px 10px; color:var(--pv-code-tx); }
  .done-ok { display:flex; align-items:center; gap:.5rem; color:var(--pv-lv-team); font-weight:600;
             font-size:14px; }
  .done-ok .icon { width:16px; height:16px; }
  footer { max-width:1240px; margin:0 auto; padding:8px 32px 28px; color:var(--pv-faint); font-size:11.5px; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
${ICON_DEFS}
<header>
  <div class="bar">
    <span class="brand">
      <svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="2" width="28" height="28" rx="8" fill="var(--pv-accent)"/><path d="M9.5 10 L16 22.5 L22.5 10" transform="translate(2.5 0) skewX(-7)" stroke="#FFFFFF" stroke-width="4.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="wm" aria-label="PageVault console">page<span class="v">v</span>ault <span class="con">console</span></span>
    </span>
    <span class="actions">
      <button class="ttoggle" id="theme-toggle" title="Toggle theme" aria-label="Toggle light/dark theme"></button>
      <button class="btn primary" id="new-doc"><svg class="icon" aria-hidden="true"><use href="#i-upload"/></svg>Upload</button>
      <div class="profile-wrap">
        <button class="profile" id="profile" aria-haspopup="true" aria-expanded="false" title="Account">${esc(owner.slice(0, 1))}</button>
        <div class="pmenu" id="pmenu" role="menu" hidden>
          <div class="pmenu-who"><span class="pmenu-label">Signed in as</span><span class="pmenu-email">${esc(owner)}</span></div>
          <a class="pmenu-item" role="menuitem" href="${logoutUrl}" title="End your Cloudflare Access session"><svg class="icon" aria-hidden="true"><use href="#i-signout"/></svg>Sign out</a>
        </div>
      </div>
    </span>
  </div>
</header>
<div class="shell">
  <aside class="side">
    <div class="side-head">
      <span class="ulabel">Portals</span>
      <button class="btn ghost" id="new-portal"><svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg>New</button>
    </div>
    <nav id="nav" aria-label="Portals"></nav>
    <div class="side-div"></div>
    <button class="prow" id="nav-traffic"><svg class="icon" aria-hidden="true"><use href="#i-chart"/></svg><span class="nm"><b>Traffic</b><span class="mono">how much was read</span></span></button>
    <div class="side-div"></div>
    <div class="legend">
      <span class="ulabel">Reach</span>
      <div class="rows">
        <span class="r"><svg class="icon lv-individual" aria-hidden="true"><use href="#i-individual"/></svg>Individuals &mdash; only named people</span>
        <span class="r"><svg class="icon lv-team" aria-hidden="true"><use href="#i-users"/></svg>Team &mdash; portal scope, login required</span>
        <span class="r"><svg class="icon lv-link" aria-hidden="true"><use href="#i-link"/></svg>Anyone with the link</span>
        <span class="r"><svg class="icon lv-public" aria-hidden="true"><use href="#i-globe"/></svg>Public &mdash; listed &amp; browsable</span>
      </div>
    </div>
    <div class="side-foot">
      <span class="seats" id="seats" hidden></span>
      <span class="tagline">Self-hosted &middot; Cloudflare &middot; MIT</span>
      <span class="build">
        <a href="${changelogUrl}" target="_blank" rel="noopener" title="Changelog">v${esc(version)}</a>${deployedAt ? ` &middot; deployed <span data-utc="${esc(deployedAt)}" title="${esc(deployDate)}">${deployDate}</span>` : ""}
      </span>
    </div>
  </aside>
  <main class="main" id="app"><p class="empty">Loading&hellip;</p></main>
</div>
<dialog id="dlg-portal" aria-labelledby="dlg-portal-title">
  <form id="form-portal" method="dialog">
    <div class="dlg-head" id="dlg-portal-title"><svg class="icon" aria-hidden="true"><use href="#i-users"/></svg>New portal</div>
    <div class="dlg-body">
      <div class="field">
        <label for="np-name">Name</label>
        <input type="text" id="np-name" placeholder="Acme Corp" autocomplete="off">
      </div>
      <div class="field">
        <label for="np-slug">Slug</label>
        <input type="text" id="np-slug" placeholder="acme-corp" autocapitalize="none" autocomplete="off" autocorrect="off" spellcheck="false">
        <span class="hint">The URL path &mdash; lowercase letters, digits and hyphens, 2&ndash;40 chars.</span>
      </div>
      <div class="field">
        <label>Who can reach it</label>
        <div class="kinds">
          <label class="kindopt">
            <input type="radio" name="np-kind" value="private" checked>
            <span class="kb"><span class="kt private"><svg class="icon" aria-hidden="true"><use href="#i-individual"/></svg>Private</span>
            <span class="kd">Only you. Documents inside are yours alone, unless one widens itself.</span></span>
          </label>
          <label class="kindopt">
            <input type="radio" name="np-kind" value="restricted">
            <span class="kb"><span class="kt restricted"><svg class="icon" aria-hidden="true"><use href="#i-users"/></svg>Restricted &mdash; a team</span>
            <span class="kd">Everyone on the member list sees every document in the portal. The only kind whose members list actually grants access &mdash; login required.</span></span>
          </label>
          <label class="kindopt">
            <input type="radio" name="np-kind" value="public">
            <span class="kb"><span class="kt public"><svg class="icon" aria-hidden="true"><use href="#i-globe"/></svg>Public</span>
            <span class="kd">No login and no Access seat. Listed and browsable &mdash; anyone with the link can read everything in it.</span></span>
          </label>
        </div>
      </div>
      <div class="field">
        <label for="np-desc">Description <span class="hint">(optional)</span></label>
        <input type="text" id="np-desc" placeholder="One line, for your own reference" autocomplete="off">
      </div>
      <div class="dlg-err" id="np-err" role="alert" hidden></div>
    </div>
    <div class="dlg-foot">
      <button type="button" class="btn" id="np-cancel">Cancel</button>
      <button type="submit" class="btn primary" id="np-create">Create portal</button>
    </div>
  </form>
</dialog>
<dialog id="dlg-edit" aria-labelledby="dlg-edit-title">
  <form id="form-edit" method="dialog">
    <div class="dlg-head" id="dlg-edit-title"><svg class="icon" aria-hidden="true"><use href="#i-edit"/></svg>Portal settings</div>
    <div class="dlg-body">
      <div class="field">
        <label for="ep-name">Name</label>
        <input type="text" id="ep-name" placeholder="Acme Corp" autocomplete="off">
      </div>
      <div class="field">
        <label for="ep-desc">Description <span class="hint">(optional)</span></label>
        <input type="text" id="ep-desc" placeholder="One line, for your own reference" autocomplete="off">
      </div>
      <p class="hint">The slug and access kind aren&rsquo;t editable here &mdash; the slug is the portal&rsquo;s URL, and changing who can reach a portal is a separate, deliberate step.</p>
      <div class="dlg-err" id="ep-err" role="alert" hidden></div>
    </div>
    <div class="dlg-foot">
      <button type="button" class="btn" id="ep-cancel">Cancel</button>
      <button type="submit" class="btn primary" id="ep-save">Save</button>
    </div>
  </form>
</dialog>
<dialog id="dlg-doc" aria-labelledby="dlg-doc-title">
  <form id="form-doc" method="dialog">
    <div class="dlg-head" id="dlg-doc-title"><svg class="icon" aria-hidden="true"><use href="#i-edit"/></svg>Edit document</div>
    <div class="dlg-body">
      <div class="field">
        <div class="flabel"><label for="ed-name">Filename</label><button type="button" class="infobtn" popovertarget="pop-name" aria-label="What the filename means, and what renaming does">i</button></div>
        <input type="text" id="ed-name" maxlength="${MAX_NAME_CHARS}" placeholder="q3-review.md" autocapitalize="none" autocomplete="off" autocorrect="off" spellcheck="false">
        <p class="hint">The document&rsquo;s identity. <span class="count" id="ed-name-count"></span></p>
      </div>
      <div class="pop" id="pop-name" popover>
        <h3>The filename is the document&rsquo;s identity</h3>
        <p>It is the <strong>update key</strong>: publishing a file with this name again replaces
           this document in place, at the same URL. That is how you ship v2 of a report without
           the client&rsquo;s link going stale.</p>
        <p><strong>Renaming moves the document to a new URL.</strong> The address is derived from
           the filename, so the two cannot change independently. When you rename:</p>
        <ul>
          <li>the old URL <strong>redirects</strong> to the new one for a year;</li>
          <li>a public <code>/p/</code> link keeps working, completely unchanged;</li>
          <li>the document, its contents and its history all come with it &mdash; nothing is re-uploaded.</li>
        </ul>
        <p>Case does not count: <code>Report.md</code> and <code>report.md</code> are the same
           document, so fixing capitalization moves nothing. The extension is part of the name,
           though &mdash; <code>report.md</code> and <code>report.html</code> are two documents.</p>
        <p>A name another document in this portal already uses is refused. Rename is for fixing a
           mistake; replacing a document is a publish, and it asks first.</p>
        <button type="button" class="btn sm" popovertarget="pop-name" popovertargetaction="hide">Got it</button>
      </div>
      <div class="warnline" id="ed-movewarn" hidden>
        <svg class="icon" aria-hidden="true"><use href="#i-alert"/></svg>
        <span>Renaming moves this document to a <strong>new URL</strong>. The old one redirects for a year, and any public <code>/p/</code> link keeps working unchanged.</span>
      </div>
      <div class="field">
        <label for="ed-title">Title</label>
        <input type="text" id="ed-title" maxlength="${MAX_TITLE_CHARS}" placeholder="Q3 Review" autocomplete="off">
        <p class="hint">Display only &mdash; what the client sees in the portal index. Changing it never moves the document. <span class="count" id="ed-title-count"></span></p>
      </div>
      <div class="field">
        <label for="ed-summary">Summary <span class="hint">(optional)</span></label>
        <input type="text" id="ed-summary" maxlength="${MAX_SUMMARY_CHARS}" placeholder="One line, shown in the portal index" autocomplete="off">
        <p class="hint">One line under the title, for the client. <span class="count" id="ed-summary-count"></span></p>
      </div>
      <div class="field">
        <div class="flabel"><label for="ed-tags">Tags <span class="hint">(optional)</span></label><button type="button" class="infobtn" popovertarget="pop-tags" aria-label="What tags are for, with examples">i</button></div>
        <input type="text" id="ed-tags" placeholder="q3, type:report, client-facing" autocapitalize="none" autocomplete="off">
        <p class="hint">Comma-separated, for your own filing. <span class="count" id="ed-tags-count"></span></p>
      </div>
      <div class="pop" id="pop-tags" popover>
        <h3>Tags are for you, not the client</h3>
        <p>They never appear in the portal or on the document. They are how <em>you</em> find
           things later, across a nine-month engagement:</p>
        <ul>
          <li>in the console, and in <code>pagevault list --tag type:report</code>;</li>
          <li>as filters an agent can use over MCP when you ask what you sent a client.</li>
        </ul>
        <p>Anything works, but a <code>key:value</code> habit pays off once there are more than a
           handful. Some that hold up:</p>
        <ul>
          <li><code>type:report</code> &middot; <code>type:proposal</code> &middot; <code>type:adr</code> &mdash; what it is</li>
          <li><code>q3</code> &middot; <code>2026-h1</code> &mdash; when it belongs to</li>
          <li><code>phase:discovery</code> &middot; <code>phase:delivery</code> &mdash; where in the engagement</li>
          <li><code>draft</code> &middot; <code>final</code> &mdash; how settled it is</li>
        </ul>
        <p>Up to ${MAX_TAGS} tags, each up to ${MAX_TAG_CHARS} characters. Separate them with
           commas; duplicates are dropped. Clearing the box removes them all.</p>
        <button type="button" class="btn sm" popovertarget="pop-tags" popovertargetaction="hide">Got it</button>
      </div>
      <p class="hint">Contents aren&rsquo;t editable here &mdash; publish the file again to update them. Who can open it stays on the panel behind this dialog.</p>
      <div class="dlg-err" id="ed-err" role="alert" hidden></div>
    </div>
    <div class="dlg-foot">
      <button type="button" class="btn" id="ed-cancel">Cancel</button>
      <button type="submit" class="btn primary" id="ed-save">Save</button>
    </div>
  </form>
</dialog>
<dialog id="dlg-upload" aria-labelledby="dlg-upload-title">
  <form id="form-upload" method="dialog">
    <div class="dlg-head" id="dlg-upload-title"><svg class="icon" aria-hidden="true"><use href="#i-upload"/></svg>New document</div>
    <div class="dlg-body" id="up-body">
      <label class="dropzone" id="up-drop">
        <input type="file" id="up-file" accept=".html,.htm,.md,.markdown,text/html,text/markdown" hidden>
        <span id="up-filelabel">Drop an <code>.html</code> or <code>.md</code> file here, or click to choose</span>
      </label>
      <div class="warnline" id="up-relwarn" role="alert" hidden></div>
      <div class="field">
        <label for="up-title">Title</label>
        <input type="text" id="up-title" placeholder="Q3 Review" autocomplete="off">
      </div>
      <div class="field">
        <label for="up-portal">Portal</label>
        <select id="up-portal"></select>
      </div>
      <div class="field">
        <label>Who can open it</label>
        <label class="checkrow"><input type="checkbox" id="up-internal"><span>Keep it internal &mdash; only who the portal already allows, no public link</span></label>
        <div class="warnline" id="up-pubwarn"><svg class="icon" aria-hidden="true"><use href="#i-alert"/></svg>By default anyone with the link can open it, no login &mdash; a <strong>capability URL, not privacy</strong>. Check the box to keep it to the portal.</div>
      </div>
      <div class="field">
        <label for="up-emails">Share with</label>
        <input type="text" id="up-emails" placeholder="a@x.com, b@y.com" autocapitalize="none" autocomplete="off" spellcheck="false">
        <span class="hint">Emails, comma or space separated. Added to this document only.</span>
      </div>
      <div class="field">
        <label for="up-tags">Tags <span class="hint">(optional)</span></label>
        <input type="text" id="up-tags" placeholder="q3, infra" autocapitalize="none" autocomplete="off">
      </div>
      <div class="dlg-err" id="up-err" role="alert" hidden></div>
    </div>
    <div class="dlg-body" id="up-done" hidden></div>
    <div class="dlg-foot" id="up-foot">
      <button type="button" class="btn" id="up-cancel">Cancel</button>
      <button type="submit" class="btn primary" id="up-publish">Publish &amp; copy link</button>
    </div>
    <div class="dlg-foot" id="up-donefoot" hidden>
      <button type="button" class="btn" id="up-again">Publish another</button>
      <button type="button" class="btn primary" id="up-close">Done</button>
    </div>
  </form>
</dialog>
<script nonce="${nonce}">
  const T = ${JSON.stringify(session)};
  const app = document.getElementById("app");
  const nav = document.getElementById("nav");
  const PORTALS = {};      // slug -> { slug, name, kind, description, docCount, members }
  const DOCS = {};         // slug -> docs[] (lazy, cached after first view)
  const FETCHED = {};      // slug -> ms when DOCS[slug] was filled, for the staleness check below
  let selected = null;     // selected portal slug — mirrored into location.hash (#92)
  // The traffic panel is a view, not a portal, and it shares the "selected" variable so there is
  // one selection rather than two that can disagree. (No backticks in this comment — it lives
  // inside the template literal page() returns, where a bare one ends the string.)
  //
  // The sentinel starts with "!" because a portal slug cannot —
  // slugs are alphanumerics and hyphens — so no real portal can ever collide with it. A deployment
  // with a portal literally called "traffic" is not hypothetical; this one has "traffic-check".
  const TRAFFIC_VIEW = "!traffic";
  let TRAFFIC = null;      // the rollup, cached until Refresh
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const ico = (id, cls) => '<svg class="icon' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + id + '"/></svg>';

  // ── Theme ──────────────────────────────────────────────────────────────────
  const SUN = '<svg class="icon" aria-hidden="true"><use href="#i-sun"/></svg>';
  const MOON = '<svg class="icon" aria-hidden="true"><use href="#i-moon"/></svg>';
  const themeToggle = document.getElementById("theme-toggle");
  function currentTheme() {
    const set = document.documentElement.dataset.theme;
    if (set) return set;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function paintToggle() { themeToggle.innerHTML = currentTheme() === "dark" ? SUN : MOON; }
  themeToggle.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("pv-theme", next); } catch (e) {}
    paintToggle();
  });
  paintToggle();

  // ── Profile menu (email + sign out under one avatar) ─────────────────────────
  const profileBtn = document.getElementById("profile");
  const pmenu = document.getElementById("pmenu");
  const closeMenu = () => { pmenu.hidden = true; profileBtn.setAttribute("aria-expanded", "false"); };
  profileBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = pmenu.hidden;
    pmenu.hidden = !open;
    profileBtn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => {
    if (!pmenu.hidden && !pmenu.contains(e.target) && e.target !== profileBtn) closeMenu();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

  async function api(path, opts) {
    opts = opts || {};
    const headers = { Authorization: "Bearer " + T };
    if (opts.body) headers["Content-Type"] = "application/json";
    const r = await fetch(path, { method: opts.method || "GET", headers, body: opts.body });
    if (r.status === 401) { location.reload(); throw new Error("reauth"); }
    if (!r.ok) {
      let msg = path + " -> " + r.status, code = null, details = null;
      try {
        const j = JSON.parse(await r.text());
        if (j && j.error) msg = j.error;
        if (j && j.code) { code = j.code; details = j; }
      } catch (e) {}
      // Carry the machine-readable code, so a caller can answer a specific failure specifically
      // instead of forwarding the server's one-liner and leaving the operator to guess the fix.
      const err = new Error(msg);
      err.code = code; err.details = details;
      throw err;
    }
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }

  // Mirror of documentPath() in documents.ts: a public portal serves at /pub, everything
  // else at /v. A /v link to a public page walks the recipient into an Access login wall and
  // burns a seat, so this distinction is not cosmetic. See ADR-001/ADR-002.
  function viewPath(kind, slug, id) {
    const s = encodeURIComponent(slug), i = encodeURIComponent(id);
    return kind === "public" ? "/pub/" + s + "/" + i : "/v/" + s + "/" + i;
  }
  // Works on a listing summary (has .public) or a full meta (has .publicToken).
  const hasLink = (d) => (d.public !== undefined ? !!d.public : !!d.publicToken);

  // The link worth handing out: the most-open URL that actually works for its audience.
  function shareUrl(m, portal) {
    if (portal.kind === "public") return location.origin + viewPath("public", portal.slug, m.id);
    if (m.publicToken) return location.origin + "/p/" + m.publicToken;
    return location.origin + viewPath(portal.kind, portal.slug, m.id);
  }

  // A shareable link to the portal *index* (the browsable list, gated by canViewPortal):
  //   public     -> /pub/{slug}   anyone browses, no login
  //   restricted -> /v/{slug}     the team browses after signing in
  //   private     -> null          it opens only for the owner, so there is nothing to share.
  function portalUrl(p) {
    const s = encodeURIComponent(p.slug);
    if (p.kind === "public") return location.origin + "/pub/" + s;
    if (p.kind === "restricted") return location.origin + "/v/" + s;
    return null;
  }

  // Rank the reach ladder so a document "widened past the portal base" can be detected.
  const LV_RANK = { individual:0, team:1, link:2, public:3 };
  const baseLevel = (kind) => kind === "public" ? "public" : kind === "restricted" ? "team" : "individual";

  // Effective reach → the access level, its icon, and a human label. A draft narrows to
  // owner-only and beats everything (the one rule canView() applies before any grant).
  function reach(d, kind) {
    if (d.ownerOnly)       return { level:"individual", icon:"lock",       label:"Draft — only you", draft:true };
    if (kind === "public") return { level:"public",     icon:"globe",      label:"Public — listed" };
    if (hasLink(d))        return { level:"link",        icon:"link",       label:"Anyone with link" };
    if (kind === "restricted") return { level:"team",   icon:"users",      label:"Team" };
    return { level:"individual", icon:"individual", label:"Only you" };
  }

  // AccessBadge: neutral chip, icon tinted by level. iconOnly is used in nav rows and legend.
  function badge(r) {
    return '<span class="badge">' + ico(r.icon, "lv-" + r.level) + '<span>' + esc(r.label) + '</span></span>';
  }

  // Pinning (#142). The pin order lives on the PORTAL, as an ordered list of filenames, and the
  // API primitive is "set the whole order" — so every control here computes the complete array and
  // sends one PATCH. That is why there is no move endpoint and why a move costs the same as a pin.
  //
  // The arithmetic is a few lines rather than a shared module because it CANNOT be shared: this
  // script is a string inside the Worker, and cli/lib/pins.mjs is Node. Kept trivial for that
  // reason, and the Worker normalizes whatever arrives anyway — the cap, the de-duplication and
  // the trim have exactly one implementation, server-side.
  const pinList = (p) => (p && p.pinned) || [];
  const pinIdx = (p, d) => pinList(p).findIndex((n) => String(n).toLowerCase() === String(d.name || "").toLowerCase());

  // Pinned first in stored order, then the rest untouched — the same partition the client's portal
  // index does, so the console shows the page as the client will see it rather than a second order
  // nobody asked for.
  function orderByPin(docs, p) {
    const pins = pinList(p);
    if (!pins.length) return docs;
    const pinned = [];
    for (const n of pins) {
      const d = docs.find((x) => String(x.name || "").toLowerCase() === String(n).toLowerCase());
      if (d) pinned.push(d);
    }
    const ids = new Set(pinned.map((d) => d.id));
    return pinned.concat(docs.filter((d) => !ids.has(d.id)));
  }

  function rowHtml(d, portal) {
    const r = reach(d, portal.kind);
    const href = viewPath(portal.kind, portal.slug, d.id);
    const widened = !r.draft && LV_RANK[r.level] > LV_RANK[baseLevel(portal.kind)];
    const dtype = d.sourceKind === "markdown" ? "doc-md" : "doc-html";
    const at = pinIdx(portal, d);
    const pins = pinList(portal);
    // Up/down, not drag. Drag is a convenience over this identical primitive, so it can arrive
    // later without a rewrite — and on a list capped at 8 it is mostly a way to reorder a live
    // client portal by accident. Buttons are also the only version a keyboard can reach.
    const pinCtl = at === -1
      ? '<button class="pinb" data-act="pin" data-name="' + esc(d.name || "") + '" title="Pin to the top of the client page" aria-label="Pin">' + ico("pin") + '</button>'
      : '<span class="pinctl">' +
          '<button class="pinb" data-act="pinup" data-name="' + esc(d.name || "") + '"' + (at === 0 ? " disabled" : "") + ' title="Move up" aria-label="Move up">&#9650;</button>' +
          '<button class="pinb" data-act="pindown" data-name="' + esc(d.name || "") + '"' + (at === pins.length - 1 ? " disabled" : "") + ' title="Move down" aria-label="Move down">&#9660;</button>' +
          '<button class="pinb on" data-act="unpin" data-name="' + esc(d.name || "") + '" title="Unpin — back to newest-first" aria-label="Unpin">' + ico("pin") + '</button>' +
        '</span>';
    return (
      '<div class="doc' + (at === -1 ? "" : " ispin") + '" data-id="' + esc(d.id) + '" aria-expanded="false">' +
        ico(dtype, "dtype") +
        '<span class="body">' +
          '<span class="trow">' +
            '<a class="t" data-role="open" href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(d.title) + '</a>' +
            '<span class="fmt mono">' + (d.sourceKind === "markdown" ? "md" : "html") + '</span>' +
          '</span>' +
          (widened ? '<span class="widened">Widened past the portal base</span>' : '') +
        '</span>' +
        pinCtl +
        badge(r) +
        '<span class="d mono">' + esc((d.updatedAt || "").slice(0, 10)) + '</span>' +
        ico("chev", "chev") +
      '</div>'
    );
  }

  // The sharing panel (ADR-011). The link is always the hero; reach is one contextual choice
  // that defaults to the most open. Every action reuses the existing session-bearer mutations.
  function detailHtml(m, portal, notice) {
    const kind = portal.kind;
    const isPublicPortal = kind === "public";
    const hasPub = !!m.publicToken;
    const draft = !!m.ownerOnly;
    const link = shareUrl(m, portal);
    const parts = [];
    if (notice) parts.push('<div class="warnline">' + ico("alert") + esc(notice) + '</div>');

    // A draft opens for no one — say so and lead with Publish, instead of a live-looking Copy.
    if (draft) {
      parts.push(
        '<div class="draftbar">' + ico("alert") +
        '<span><strong>Draft</strong> — opens for no one yet, even people you have shared it with. Publish to make the link live.</span>' +
        '<span class="grow"></span>' +
        '<button class="btn primary sm" data-act="toggle" data-id="' + esc(m.id) + '" data-owneronly="1">Publish</button></div>'
      );
    }

    // Always a link, never a "None" state. Dimmed while a draft.
    parts.push(
      '<div class="sharebar' + (draft ? ' dim' : '') + '"><span class="lb">' + ico("link") + 'Share link</span>' +
      '<code>' + esc(link) + '</code>' +
      '<button class="btn sm" data-act="copy" data-url="' + esc(link) + '">' + ico("copy") + 'Copy</button>' +
      '<a class="btn sm" data-role="open" href="' + esc(link) + '" target="_blank" rel="noopener">Open &#8599;</a></div>'
    );

    if (isPublicPortal) {
      parts.push('<div class="reason public">' + ico("globe") + '<span><b>Anyone with this link can open it.</b> <span class="sub">This portal is public — everything in it is readable by anyone with the link, so per-person sharing does not apply.</span></span></div>');
    } else {
      const nExtra = (m.extraEmails || []).length;
      let rTier, rIcon, rTitle, rSub;
      if (draft) { rTier = "individual"; rIcon = "lock"; rTitle = "Only you — this is a draft"; rSub = "Publish above to let the link open for anyone else."; }
      else if (hasPub) { rTier = "link"; rIcon = "link"; rTitle = "Anyone with this link can open it"; rSub = "No login, no account — the simplest way to hand someone a report."; }
      else if (kind === "restricted") { rTier = "team"; rIcon = "users"; rTitle = "Your team can open it, after signing in"; rSub = "Portal members only — the link is not forwardable to outsiders."; }
      else if (nExtra) { rTier = "team"; rIcon = "users"; rTitle = "You and " + nExtra + " specific " + (nExtra === 1 ? "person" : "people") + " can open it"; rSub = "They sign in first. Add or remove people below, or open it to anyone with the link."; }
      else { rTier = "individual"; rIcon = "lock"; rTitle = "Only you can open it"; rSub = "Nothing is shared yet — choose a wider reach, or add a person below."; }
      parts.push('<div class="reason ' + rTier + '">' + ico(rIcon) + '<span><b>' + esc(rTitle) + '</b> <span class="sub">' + esc(rSub) + '</span></span></div>');

      // Reach is one choice: Anyone-with-link (default) vs portal-governed. The second option's
      // meaning comes from the portal — team for restricted, you for private. Moot for a draft.
      if (!draft) {
        const otherLabel = kind === "restricted" ? "My team" : "Only you";
        const otherIcon = kind === "restricted" ? "users" : "lock";
        parts.push(
          '<div class="reachsel" role="group" aria-label="Who can open this">' +
          '<button class="ropt" data-reach="open"' + (hasPub ? ' aria-pressed="true"' : ' data-act="mint" data-id="' + esc(m.id) + '"') + '>' + ico("link") + 'Anyone with the link</button>' +
          '<button class="ropt" data-reach="other"' + (hasPub ? ' data-act="revoke" data-id="' + esc(m.id) + '"' : ' aria-pressed="true"') + '>' + ico(otherIcon) + esc(otherLabel) + '</button>' +
          '</div>'
        );
        // The forwardable-link trade — shown whenever the public link is live, never hidden.
        if (hasPub) {
          parts.push('<div class="keynote">' + ico("alert") + '<span>A link is a key: anyone it is forwarded to can open it too. Fine for most work; worth knowing for the sensitive stuff.</span></div>');
        }
      }

      // Named individuals — specific people, additive. Only meaningful when the link is NOT
      // open to anyone: once it is, per-person grants add nothing, so the section is hidden.
      if (!hasPub) {
        parts.push('<div class="subrow"><span class="lb">' + ico("mail") + 'Also give specific people access</span></div>');
        parts.push('<div class="dhint">Added to this document only. Additive — it never removes anyone the portal already lets in.</div>');
        const emails = m.extraEmails || [];
        parts.push(emails.length
          ? '<ul class="chips">' + emails.map((e) =>
              '<li class="chip">' + esc(e) + '<button class="x" data-act="unshare" data-id="' + esc(m.id) + '" data-email="' + esc(e) + '" title="remove">' + ico("x") + '</button></li>'
            ).join("") + '</ul>'
          : '<div class="dhint">No one specific yet.</div>');
        parts.push(
          '<div class="addrow"><input type="email" placeholder="email to add" data-email-for="' + esc(m.id) + '">' +
          '<button class="btn sm" data-act="share" data-id="' + esc(m.id) + '">Add</button></div>'
        );
      }
    }

    // What the document IS, as opposed to who can open it. Until #140 none of this was here:
    // not the filename (the identity — so a typo made at upload was invisible as well as
    // uncorrectable), not the summary, and not the tags.
    const tags = m.tags || [];
    parts.push(
      '<div class="subrow"><span class="lb">' + ico("edit") + 'Details</span>' +
      '<span class="grow"></span>' +
      '<button class="btn sm" data-act="edit-doc" data-id="' + esc(m.id) + '">' + ico("edit") + 'Edit</button></div>' +
      '<dl class="meta">' +
        '<dt>' + ico(m.sourceKind === "markdown" ? "doc-md" : "doc-html") + 'Filename</dt>' +
        '<dd><code>' + esc(m.name || "") + '</code>' +
          '<span class="sub">the update key &mdash; republishing this filename replaces this document</span></dd>' +
        '<dt>Summary</dt>' +
        '<dd>' + (m.summary ? esc(m.summary) : '<span class="sub">None. Shown to the client in the portal index.</span>') + '</dd>' +
        '<dt>Tags</dt>' +
        '<dd>' + (tags.length
          ? '<span class="tags">' + tags.map((t) => '<span class="tag">' + esc(t) + '</span>').join("") + '</span>'
          : '<span class="sub">None. Yours only &mdash; the client never sees them.</span>') + '</dd>' +
      '</dl>'
    );

    // "Make draft" sits quietly by Delete when not already a draft (Publish lives in the draftbar).
    parts.push('<div class="foot"><span class="grow"></span>' +
      (draft ? '' : '<button class="btn sm warn" data-act="toggle" data-id="' + esc(m.id) + '" data-owneronly="0">Make draft</button>') +
      '<button class="btn danger" data-act="delete" data-id="' + esc(m.id) + '" data-title="' + esc(m.title) + '">Delete document</button></div>');
    return parts.join("");
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function renderNav() {
    const tnav = document.getElementById("nav-traffic");
    if (tnav) {
      if (selected === TRAFFIC_VIEW) tnav.setAttribute("aria-current", "true");
      else tnav.removeAttribute("aria-current");
    }
    nav.innerHTML = Object.values(PORTALS).map((p) => {
      const r = reach({ }, p.kind); // base level of the portal, icon-only
      const cur = p.slug === selected;
      return '<button class="prow" data-nav="' + esc(p.slug) + '"' + (cur ? ' aria-current="true"' : '') + '>' +
        ico(r.icon, "lv-" + r.level) +
        '<span class="nm"><b>' + esc(p.name) + '</b><span class="mono">' + esc(p.slug) + '</span></span>' +
        '<span class="cnt">' + (p.docCount || 0) + '</span></button>';
    }).join("");
  }

  function memberEditor(p) {
    if (p.kind === "restricted") {
      const members = p.members || [];
      const chips = members.length
        ? '<ul class="chips">' + members.map((m) => '<li class="chip">' + esc(m) + '<button class="x" data-act="remove-member" data-portal="' + esc(p.slug) + '" data-email="' + esc(m) + '" title="remove">' + ico("x") + '</button></li>').join("") + '</ul>'
        : '<div class="dhint">No members yet.</div>';
      return '<div class="seats"><div class="cap">' + ico("users") + '<span>Team seats</span><span class="sub">&middot; everyone here reaches every document in the portal</span></div>' +
        chips +
        '<div class="addrow"><input type="email" placeholder="email to add" data-member-for="' + esc(p.slug) + '">' +
        '<button class="btn sm" data-act="add-member" data-portal="' + esc(p.slug) + '">Add</button></div></div>';
    }
    return "";
  }

  // ── Traffic (#164) ─────────────────────────────────────────────────────────
  //
  // 🔴 This panel IS the dashboard. Analytics Engine has no console of its own, is absent from the
  // GraphQL API, and therefore cannot feed Cloudflare's Custom Dashboards either — the Worker's
  // Metrics tab will only ever show deployment-level request counts. The surface-parity principle
  // lets the console lag the CLI, but traffic is the thing you glance at rather than query.
  //
  // It costs nothing to serve: the rollup reads a KV value through the owner session the console
  // already holds. No Cloudflare credential reaches this page, and the Worker still never reads
  // Analytics Engine (ADR-019 decision 1).
  // 🔴 SVG, not a div sized by an inline style attribute. The console's CSP is nonced and drops
  // those (there is a test, and it caught this), so a bar sized that way renders at zero width and
  // the whole panel silently looks empty. x/y/width/height on a rect are ATTRIBUTES, so they
  // survive. preserveAspectRatio none lets a 0-100 viewBox stretch to whatever the row gives it.
  //
  // Note this comment ships to the browser inside the script, so it cannot contain the attribute
  // it is describing — the guard matches page content, and does not care that this is a comment.
  function trafficBar(n, peak) {
    const pct = peak > 0 ? Math.max(1, Math.round((n / peak) * 100)) : 0;
    return '<svg class="tbar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">' +
      '<rect width="' + pct + '" height="8" rx="1.5"/></svg>';
  }

  function renderTraffic() {
    if (!TRAFFIC) { app.innerHTML = '<p class="empty">Loading traffic&hellip;</p>'; return; }
    const r = TRAFFIC;
    const sync = '<code class="cmd">pagevault sync-views</code>';

    // 🔴 Sync STATUS, not a sync button. The console cannot perform a sync — the Worker cannot read
    // Analytics Engine at all, so a button here would have nothing to call. The honest surface is
    // the command, copyable. And no "paste your Cloudflare token" flow to make a real button
    // possible: that puts an account-scoped credential in a web page, where any console XSS
    // inherits it. Considered and refused; ADR-025 does not reopen it.
    if (r.state === "never-synced") {
      app.innerHTML = '<div class="card"><div class="chead"><h2>Traffic</h2></div>' +
        '<p class="empty">No history captured yet.</p>' +
        '<p class="dhint">Views reach Analytics Engine the moment a page opens, but nothing moves them ' +
        'into this deployment until you ask. Analytics Engine keeps about 90 days; what you sync here is kept ' +
        'for good.</p><p class="dhint">Run ' + sync + ' on the machine that provisioned this deployment.</p></div>';
      return;
    }
    if (r.state === "not-recording") {
      // Zero here would be a measurement. There is no binding, so there is no measurement (#185).
      app.innerHTML = '<div class="card"><div class="chead"><h2>Traffic</h2></div>' +
        '<p class="empty">This deployment is not recording views.</p>' +
        '<p class="dhint">The Worker has no Analytics Engine binding, so nothing is being counted and nothing ' +
        'will be.' + (r.total.views ? ' The ' + r.total.views + ' views below were measured before it was turned off, and are still true.' : '') +
        '</p><p class="dhint">Turn it on with <code class="cmd">pagevault upgrade --analytics</code>.</p></div>';
      return;
    }

    const when = r.syncedAt ? new Date(r.syncedAt).toLocaleString() : "never";
    const risky = r.risk && (r.risk.state === "warn" || r.risk.state === "urgent" || r.risk.state === "losing");
    const banner = risky
      ? '<div class="warnline">' + ico("alert") +
        (r.risk.state === "losing"
          ? '<span>' + r.risk.lostDays + ' days of history is already unrecoverable, and more goes each day. Run ' + sync + '.</span>'
          : '<span>' + r.risk.uncapturedDays + ' days of history becomes unrecoverable in ' + r.risk.daysUntilLoss + ' days. Run ' + sync + '.</span>') +
        '</div>'
      : "";

    const peakDay = Math.max.apply(null, [1].concat(r.byDay.map((d) => d.views)));
    const peakPortal = Math.max.apply(null, [1].concat(r.byPortal.map((p) => p.views)));
    const peakDoc = Math.max.apply(null, [1].concat(r.byDoc.map((d) => d.views)));

    // The tooltip. A multi-line SVG <title> rather than a positioned hover card, because the
    // console's CSP is nonced and drops style attributes — a card would need CSSOM positioning to
    // work at all, and a tooltip that silently lands at 0,0 is worse than the browser's own.
    // Native <title> also reaches a screen reader for free.
    //
    // 🔴 No referrers here, and there is no version of this that can have them. Referrer hosts are
    // stored per portal, ALL-TIME, with no date dimension at all (ADR-023 §5, so a host can never
    // be correlated with a reader on a given day). Putting byReferrer in a per-day tooltip would
    // render the identical list under every bar — an all-time total wearing a day's label. The
    // surface split below is the honest per-day answer to the same question.
    function dayTip(d) {
      const lines = [d.key + (d.granularity === "month" ? " (whole month)" : "") + " — " + d.views +
        (d.views === 1 ? " view" : " views")];

      const s = d.surfaces || { link: 0, public: 0, portal: 0 };
      const parts = [];
      if (s.link) parts.push(s.link + " via link");
      if (s.public) parts.push(s.public + " public");
      if (s.portal) parts.push(s.portal + " portal");
      if (parts.length) lines.push(parts.join(" · "));

      if (d.topDocs && d.topDocs.length) {
        lines.push("");
        lines.push(d.topDocs.length === 1 ? "Page" : "Top pages");
        d.topDocs.forEach((t) => { lines.push("  " + t.title + " — " + t.views); });
      }
      // 🔴 Double-escaped on purpose. This string sits inside the TypeScript template literal that
      // BUILDS the console script, so a single backslash-n is resolved by tsc into a real newline —
      // a syntax error inside the browser's own string literal. make check-console catches it, and
      // did. (No backticks in this comment either: it ships inside the template literal too.)
      return lines.join("\\n");
    }

    // Same reason as trafficBar: rect attributes, never inline style. One column per bucket, drawn
    // in a 100-unit-tall viewBox and stretched to the panel width.
    //
    // 🔴 preserveAspectRatio="none" is what makes the bars fill the panel, and it is also why no
    // <text> goes inside this SVG: the stretch would distort it. The y-axis and the value labels are
    // HTML siblings, laid out by flex so they line up with evenly-spaced columns without a single
    // positioned element.
    const step = r.byDay.length ? 100 / r.byDay.length : 100;
    // Value labels on every column stop being readable well before a month of them. Past the
    // threshold the axis and the tooltips carry it, which is what they are for.
    const showValues = r.byDay.length > 0 && r.byDay.length <= 14;
    const mid = Math.round(peakDay / 2);
    const days = r.byDay.length
      ? '<div class="chart">' +
          '<div class="yaxis" aria-hidden="true"><span>' + peakDay + '</span><span>' + mid + '</span><span>0</span></div>' +
          '<div class="plot">' +
            '<svg class="spark" viewBox="0 0 100 100" preserveAspectRatio="none">' +
              // Gridlines at the peak and the midpoint. A horizontal line stretched horizontally is
              // still a horizontal line, so these survive preserveAspectRatio="none" intact.
              '<line class="grid" x1="0" y1="0" x2="100" y2="0"/>' +
              '<line class="grid" x1="0" y1="50" x2="100" y2="50"/>' +
              r.byDay.map((d, i) => {
                const h = Math.max(2, Math.round((d.views / peakDay) * 100));
                return '<rect class="' + (d.granularity === "month" ? "bar mo" : "bar") + '" x="' +
                  (i * step + step * 0.15).toFixed(2) + '" y="' + (100 - h) +
                  '" width="' + (step * 0.7).toFixed(2) + '" height="' + h + '">' +
                  '<title>' + esc(dayTip(d)) + '</title></rect>';
              }).join("") +
            '</svg>' +
            (showValues
              ? '<div class="dvals">' + r.byDay.map((d) => '<span>' + d.views + '</span>').join("") + '</div>'
              : "") +
            '<div class="srange"><span>' + esc(r.byDay[0].key) + '</span><span>' + esc(r.byDay[r.byDay.length - 1].key) + '</span></div>' +
          '</div>' +
        '</div>' +
        (r.scope && r.scope.monthlyBuckets
          ? '<p class="dhint">Lighter columns are whole months: daily detail is kept for 90 days, then compacted.</p>'
          : "") +
        '<p class="dhint">Hover a column for its surface split and the pages that drove it.</p>'
      : '<p class="dhint">No day in this window recorded a view.</p>';

    // Top pages (#164 follow-up). byDoc arrives sorted by views, so this is a slice — but filter
    // zeros first: a measured document with no views in the window is a real and useful row in a
    // full listing, and noise in a "top" list.
    const topDocs = r.byDoc.filter((d) => d.views > 0).slice(0, 5);
    const docRows = topDocs.length
      ? topDocs.map((d) =>
          '<div class="trow"><span class="tname" title="' + esc(d.title + " — " + d.portal) + '">' + esc(d.title) + '</span>' +
          trafficBar(d.views, peakDoc) + '<span class="tnum">' + d.views + '</span></div>').join("")
      : '<p class="dhint">No document recorded a view in this window.</p>';

    const portalRows = r.byPortal.length
      ? r.byPortal.map((p) =>
          '<div class="trow"><span class="tname">' + esc(p.portal) + '</span>' + trafficBar(p.views, peakPortal) +
          '<span class="tnum">' + p.views + '</span></div>').join("")
      : '<p class="dhint">No portal recorded traffic in this window.</p>';

    const refRows = r.byReferrer.length
      ? r.byReferrer.slice(0, 8).map((s) =>
          '<div class="trow"><span class="tname">' + (s.host ? esc(s.host) : '<em>direct</em>') + '</span>' +
          '<span class="tnum">' + s.views + '</span></div>').join("")
      : '<p class="dhint">Nothing recorded a referrer.</p>';

    app.innerHTML =
      '<div class="card"><div class="chead"><h2>Traffic</h2>' +
      '<span class="fresh" title="These numbers come from the last sync, not from live traffic">As of ' + esc(when) + '</span></div>' +
      banner +
      '<div class="tgrid">' +
        '<div class="tstat"><b>' + r.total.views + '</b><span>views</span></div>' +
        '<div class="tstat"><b>' + r.byDoc.filter((d) => d.views > 0).length + '</b><span>documents opened</span></div>' +
        '<div class="tstat"><b>' + r.byPortal.length + '</b><span>portals</span></div>' +
      '</div>' +
      '<div class="tsec"><span class="ulabel">By day</span>' + days + '</div>' +
      '<div class="tsec"><span class="ulabel">By portal</span>' + portalRows + '</div>' +
      '<div class="tsec"><span class="ulabel">Top pages</span>' + docRows + '</div>' +
      // All-time, and it has to say so: referrers carry no date (ADR-023), so labelling them with
      // the window above would be a wrong number rather than a narrow one.
      '<div class="tsec"><span class="ulabel">Sources</span>' + refRows +
        '<p class="dhint">All-time per portal &mdash; referrers carry no date, so the window above does not apply. ' +
        'The linking host only, never the page it linked from.</p></div>' +
      '<p class="dhint">Not live. These are the numbers from your last ' + sync + ' &mdash; the Worker cannot read ' +
      'Analytics Engine itself, so nothing here updates on its own.</p>' +
      '</div>';
  }

  function renderMain() {
    if (selected === TRAFFIC_VIEW) return renderTraffic();
    const p = PORTALS[selected];
    if (!p) { app.innerHTML = '<p class="empty">No portals yet. Publish a document to create one.</p>'; return; }
    const r = reach({ }, p.kind);
    const docs = DOCS[p.slug];
    const pShare = portalUrl(p);
    const shareBtn = pShare
      ? '<button class="btn sm" data-act="copy" data-url="' + esc(pShare) + '" title="' +
        esc(p.kind === "public"
          ? "Anyone with this link can browse this portal — no login."
          : "Your team can browse this portal after signing in. Not forwardable to outsiders.") +
        '">' + ico("link") + 'Copy link</button>'
      : '';
    // Open the portal page itself, the way a document row can be opened. Only where the index is
    // reachable by its audience — a private portal has no browsable page to open (portalUrl null).
    const openBtn = pShare
      ? '<a class="btn sm" href="' + esc(pShare) + '" target="_blank" rel="noopener" title="Open the portal page">' + ico("open") + 'Open</a>'
      : '';
    const editBtn = '<button class="btn sm" data-act="edit-portal" data-portal="' + esc(p.slug) + '" title="Edit name and description">' + ico("edit") + 'Edit</button>';
    const head =
      '<div class="phead"><div class="phead-top"><div class="min0">' +
        '<div class="titrow"><h1>' + esc(p.name) + '</h1><span class="slug mono">/' + esc(p.slug) + '</span></div>' +
        (p.description ? '<p>' + esc(p.description) + '</p>' : '') +
      '</div><div class="base"><span class="lb">Base access</span>' + badge(r) + '</div></div>' +
      // Actions sit on their own row under the description, right-aligned to line up with the
      // badge above them. Inline with the badge they crowded it; stacked in a column they set
      // the card's height.
      '<div class="pacts">' + openBtn + shareBtn + editBtn + '</div>' +
      memberEditor(p) + '</div>';

    let list;
    if (!docs) list = '<p class="empty">Loading&hellip;</p>';
    else if (!docs.length) list = '<p class="empty">No documents yet. Publish one with the button above.</p>';
    else list = '<div class="doclist">' + orderByPin(docs, p).map((d) =>
      '<div class="item" data-item="' + esc(d.id) + '">' + rowHtml(d, p) +
      '<div class="detail" id="dt-' + esc(d.id) + '" data-detail="' + esc(d.id) + '" hidden></div></div>').join("") + '</div>';

    app.innerHTML = head +
      '<div class="dochead"><div class="h"><h2>Documents</h2><span class="cnt">' + (docs ? docs.length : "") + '</span></div>' +
      '<div class="dochead-act">' +
        freshLabel(p.slug) +
        '<button class="btn sm" data-act="refresh" title="Re-fetch the document list — picks up anything published from the CLI or an agent since this loaded">' + ico("refresh") + 'Refresh</button>' +
        '<button class="btn" id="pub-here"><svg class="icon" aria-hidden="true"><use href="#i-upload"/></svg>Upload to ' + esc(p.name) + '</button>' +
      '</div></div>' + list;
  }

  // "Read at 14:32" beside the Refresh button. A clock time, not "2 minutes ago": a relative
  // label has to be re-rendered to stay true, and one that silently stops ticking is worse than
  // no label at all. This says when the list came from the server and lets you judge it.
  function freshLabel(slug) {
    const at = FETCHED[slug];
    if (!at) return "";
    const t = new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return '<span class="fresh" title="When this list was last read from the server">Read at ' + esc(t) + '</span>';
  }

  // The portal named by the URL fragment, if any: "#acme" -> "acme". Written with slice rather
  // than a regex on purpose — this whole script lives inside a TS template literal, where a
  // regex containing a slash needs double-escaping and reads like a puzzle.
  function hashPortal() {
    try {
      let h = location.hash || "";
      if (h.charAt(0) === "#") h = h.slice(1);
      if (h.charAt(0) === "/") h = h.slice(1);
      return decodeURIComponent(h).trim();
    } catch (e) { return ""; }
  }

  /**
   * Show the traffic panel. One GET /api/views/summary, cached until Refresh.
   *
   * Deliberately NOT a KV list() — that quota is separate and small (1000/day), and a panel that
   * polled it would spend the operator's budget on a page they left open.
   */
  async function selectTraffic() {
    selected = TRAFFIC_VIEW;
    try { history.replaceState(null, "", "#" + encodeURIComponent(TRAFFIC_VIEW)); } catch (e) {}
    renderNav();
    renderMain();
    if (TRAFFIC) return;
    try {
      TRAFFIC = await api("/api/views/summary?days=30");
    } catch (e) {
      // A deployment older than this console has no such route. Say which it is — "failed to load"
      // sends someone looking at their network tab for a problem that is a version number.
      app.innerHTML = '<div class="card"><div class="chead"><h2>Traffic</h2></div>' +
        '<p class="empty">This deployment cannot serve view history yet.</p>' +
        '<p class="dhint">Reading the stored summary arrived in 0.36.0. Upgrade with ' +
        '<code class="cmd">pagevault upgrade</code>.</p></div>';
      return;
    }
    if (selected === TRAFFIC_VIEW) renderMain();
  }

  async function selectPortal(slug) {
    selected = slug;
    // Mirror the selection into the URL so a reload lands where you were, and a portal view can
    // be bookmarked or linked (#92). replaceState, NOT an assignment to location.hash: assigning
    // the hash pushes a history entry per click, so Back would walk back through portals instead
    // of leaving the console. replaceState also does not fire hashchange, so the listener below
    // cannot loop.
    //
    // (No backticks in this comment — it lives inside the template literal that page() returns,
    // where a bare backtick ends the string. tsc reports it 300 lines away, if at all.)
    try { history.replaceState(null, "", "#" + encodeURIComponent(slug)); } catch (e) {}
    renderNav();
    renderMain();
    if (!DOCS[slug]) {
      try {
        const res = await api("/api/docs?portal=" + encodeURIComponent(slug));
        DOCS[slug] = res.docs || [];
      } catch (e) { DOCS[slug] = []; }
      FETCHED[slug] = Date.now();
      if (selected === slug) renderMain();
    }
  }

  // Re-fetch from the server, keeping the selected portal (#92). load() re-reads the portal list
  // (so a portal created out-of-band appears) and re-selects the current one; clearing its doc
  // cache first forces the selected portal's documents to reload — the out-of-band-publish case.
  //
  // This is the EXPENSIVE one: a portal detail read is a KV list() each, so a full refresh costs
  // one list per portal. It is wired to the explicit Refresh button only.
  async function refresh() {
    if (selected) delete DOCS[selected];
    // Refresh is the ONLY thing that re-reads traffic. It is cached rather than polled: a console
    // left open on this panel must not spend the operator's quota on a page nobody is watching.
    TRAFFIC = null;
    await load();
  }

  // The cheap one: re-read just the selected portal's documents — a single list(). This is what
  // the out-of-band publish actually needs ("I published from Claude in another window"), and it
  // is what the tab-back below uses. A portal created elsewhere still needs the Refresh button.
  async function reselect() {
    if (!selected) return;
    delete DOCS[selected];
    await selectPortal(selected);
  }

  async function load() {
    try {
      const { portals } = await api("/api/portals");
      if (!portals.length) {
        nav.innerHTML = "";
        app.innerHTML = '<p class="empty">No portals yet. Publish a document to create one.</p>';
        return;
      }
      // One detail read per portal gives its docCount + members for the sidebar and header
      // card. Documents themselves load lazily for the selected portal (kinder to the KV
      // list quota than fetching every portal's docs up front).
      const details = await Promise.all(portals.map((p) => api("/api/portals/" + encodeURIComponent(p.slug))));
      details.forEach((d) => { PORTALS[d.slug] = d; });
      // Precedence: whatever is already selected (a refresh keeps your place), then the URL
      // fragment (a reload or a pasted link), then today's default-portal fallback. An unknown
      // slug in the hash falls through rather than showing an empty portal.
      const fromHash = hashPortal();
      // The traffic view is a legitimate place to have been and to link to, so it beats the
      // portal fallbacks — a reload on #!traffic must not silently land you on a portal.
      if (selected === TRAFFIC_VIEW || fromHash === TRAFFIC_VIEW) {
        renderNav();
        await selectTraffic();
        return;
      }
      const want = (selected && PORTALS[selected]) ? selected
        : (fromHash && PORTALS[fromHash]) ? fromHash
        : (PORTALS["default"] ? "default" : Object.keys(PORTALS)[0]);
      await selectPortal(want);
    } catch (e) {
      app.innerHTML = '<p class="empty err">Could not load: ' + esc(e.message) + '</p>';
    }
  }

  nav.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-nav]");
    if (b) selectPortal(b.dataset.nav);
  });

  document.getElementById("nav-traffic").addEventListener("click", () => { selectTraffic(); });

  // Someone edited the fragment, or followed a link to another portal in this same console.
  addEventListener("hashchange", () => {
    const s = hashPortal();
    if (s === TRAFFIC_VIEW) { if (selected !== TRAFFIC_VIEW) selectTraffic(); return; }
    if (s && PORTALS[s] && s !== selected) selectPortal(s);
  });

  // ── Access seats (#44) ─────────────────────────────────────────────────────
  //
  // At the free plan's 50 seats Cloudflare BLOCKS new logins — silently, with no notification at
  // any tier. The first sign is a client saying your report will not open. This is the whole
  // feature: the running total, where the operator already looks when something is wrong.
  //
  // Fetched after load() rather than rendered into the page, so a slow Cloudflare API call cannot
  // hold up the console. Failure and "no Access on this deployment" both leave it hidden — a seat
  // readout that shows 0 because it could not ask would read as plenty of room at exactly the
  // moment logins are being refused.
  async function loadSeats() {
    const el = document.getElementById("seats");
    if (!el) return;
    let s;
    try { s = await api("/api/access/seats"); } catch (e) { return; }
    if (!s || s.status !== "ok") return;

    const atLimit = s.used >= s.limit;
    el.className = "seats" + (atLimit ? " hot" : "");
    el.innerHTML = 'Access seats <span class="n">' + esc(s.used) + " of " + esc(s.limit) + "</span>" +
      (atLimit ? " &middot; limit reached, new logins blocked" : "");
    // The ceiling is the FREE plan's, which we assume — the Worker holds no billing scope to read
    // the real one. Say so on hover instead of implying we know the operator's plan.
    el.title = atLimit
      ? "Cloudflare is refusing new logins. Free Zero Trust allows " + s.limit +
        " seats; a seat is consumed when someone authenticates, and is not released until it expires."
      : "Seats consumed by people who have logged in. " + s.limit +
        " is Cloudflare's free Zero Trust allowance — if you are on a paid plan your limit is higher.";
    el.hidden = false;
  }

  // Come back to the tab and the list is current (#92). A publish from the CLI, an agent, or
  // another tab leaves this stale with nothing on screen to say so, and the operator publishing
  // is the same person watching — there is no third party to race, so an event stream would be
  // a Durable Object and a new failure mode for no one's benefit.
  //
  // Two guards, because "refresh whenever the tab is focused" is a poll wearing a disguise and
  // the house rule is that the console must not poll list(): a staleness window, so rapid
  // tab-switching is free, and a per-page-load ceiling, so a pathological day still cannot spend
  // the 1000/day quota. Both reset on a deliberate reload.
  const STALE_MS = 30000;
  const AUTO_MAX = 60;
  let autoUsed = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !selected) return;
    if (Date.now() - (FETCHED[selected] || 0) < STALE_MS) return;
    if (autoUsed >= AUTO_MAX) return;
    autoUsed++;
    reselect();
  });

  // Expand/collapse a row, reading full meta lazily on first open.
  async function toggle(id) {
    const detail = app.querySelector('[data-detail="' + id + '"]');
    const row = app.querySelector('.doc[data-id="' + id + '"]');
    if (!detail) return;
    const open = detail.hidden;
    detail.hidden = !open;
    if (row) row.setAttribute("aria-expanded", String(open));
    if (open && !detail.dataset.loaded) {
      detail.innerHTML = '<div class="dhint">Loading…</div>';
      try {
        const m = await api("/api/docs/" + encodeURIComponent(id));
        detail.innerHTML = detailHtml(m, PORTALS[m.portal]);
        detail.dataset.loaded = "1";
      } catch (e) {
        detail.innerHTML = '<div class="dhint err">Could not load: ' + esc(e.message) + '</div>';
      }
    }
  }

  // Re-render a single item from a fresh meta (an API response), keeping its panel open. Used
  // after every mutation so state comes from read-your-write, not an eventually-consistent list.
  function replaceItem(id, meta, notice) {
    const item = app.querySelector('[data-item="' + id + '"]');
    if (!item) return;
    const portal = PORTALS[meta.portal];
    item.innerHTML = rowHtml(meta, portal) + '<div class="detail" id="dt-' + esc(id) + '" data-detail="' + esc(id) + '"></div>';
    item.querySelector('.doc').setAttribute("aria-expanded", "true");
    const detail = item.querySelector('[data-detail="' + id + '"]');
    detail.dataset.loaded = "1";
    detail.innerHTML = detailHtml(meta, portal, notice);
    // Keep the cache coherent so a portal re-select shows the mutation.
    const cache = DOCS[meta.portal];
    if (cache) { const i = cache.findIndex((d) => d.id === id); if (i >= 0) cache[i] = meta; }
  }

  function copyBtn(btn) {
    const url = btn.dataset.url;
    const done = (ok) => { btn.innerHTML = ico("copy") + (ok ? "Copied" : "Copy"); };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => { btn.innerHTML = ico("copy") + "Copied"; setTimeout(() => done(false), 1200); }, () => prompt("Copy this link:", url));
    } else {
      prompt("Copy this link:", url);
    }
  }

  const patch = (id, body) => api("/api/docs/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(body) });

  app.addEventListener("click", async (ev) => {
    const actEl = ev.target.closest("[data-act]");
    if (actEl) {
      ev.stopPropagation();
      const a = actEl.dataset.act, id = actEl.dataset.id;
      try {
        if (a === "copy") { copyBtn(actEl); return; }
        if (a === "refresh") { await refresh(); return; }
        if (a === "mint") {
          // Widening to the default reach — no confirm; it is the expected action (ADR-011).
          replaceItem(id, await patch(id, { makePublic: true })); return;
        }
        if (a === "revoke") {
          // Narrowing removes access someone may already hold — this one still asks.
          if (!confirm("Only your team / you from now on? Anyone currently holding the public link loses access. The document itself stays.")) return;
          replaceItem(id, await patch(id, { makePublic: false })); return;
        }
        if (a === "toggle") {
          replaceItem(id, await patch(id, { ownerOnly: actEl.dataset.owneronly !== "1" })); return;
        }
        if (a === "share") {
          const inp = app.querySelector('[data-email-for="' + id + '"]');
          const v = inp && inp.value.trim();
          if (!v) return;
          const m = await patch(id, { addEmails: [v] });
          const notice = m.sync && m.sync !== "synced" && m.sync !== "noop"
            ? (m.sync === "not_configured" ? "Saved, but email sharing needs Access (enable portals) before this person can open it." : "Saved, but admitting them to Access failed — they cannot open it yet.")
            : null;
          replaceItem(id, m, notice); return;
        }
        if (a === "unshare") {
          replaceItem(id, await patch(id, { removeEmails: [actEl.dataset.email] })); return;
        }
        if (a === "delete") {
          if (!confirm('Delete "' + actEl.dataset.title + '"? This cannot be undone.')) return;
          await api("/api/docs/" + encodeURIComponent(id), { method: "DELETE" });
          const item = app.querySelector('[data-item="' + id + '"]');
          if (item) item.remove();
          const cache = DOCS[selected];
          if (cache) { const i = cache.findIndex((d) => d.id === id); if (i >= 0) cache.splice(i, 1); }
          if (PORTALS[selected]) PORTALS[selected].docCount = Math.max(0, (PORTALS[selected].docCount || 1) - 1);
          renderNav();
          return;
        }
        // Pin, unpin, and the two moves — one PATCH each, carrying the WHOLE order (#142).
        // Optimistic only in the sense that the response is authoritative: the Worker normalizes
        // (cap, de-duplication, trim) and we render what it kept, never what we sent.
        if (a === "pin" || a === "unpin" || a === "pinup" || a === "pindown") {
          const p = PORTALS[selected];
          if (!p) return;
          const name = actEl.dataset.name;
          const cur = (p.pinned || []).slice();
          const at = cur.findIndex((n) => String(n).toLowerCase() === String(name).toLowerCase());
          let next;
          if (a === "unpin") next = cur.filter((n, i) => i !== at);
          else if (a === "pin") next = [name].concat(cur.filter((n, i) => i !== at));
          else {
            // A move on something not pinned cannot happen — the control is only rendered for a
            // pinned row — but guard anyway rather than splicing at -1.
            if (at === -1) return;
            const to = a === "pinup" ? at - 1 : at + 1;
            if (to < 0 || to >= cur.length) return;
            next = cur.slice();
            next[at] = cur[to];
            next[to] = cur[at];
          }
          const res = await api("/api/portals/" + encodeURIComponent(selected), { method: "PATCH", body: JSON.stringify({ pinned: next }) });
          // An older Worker ignores the field and answers 200 unchanged. Say so rather than
          // silently doing nothing — the console is served BY the Worker so this should be
          // impossible, but a stale cached page against a rolled-back deployment is not.
          if (next.length && !(res.pinned || []).length) { alert("This deployment has not been upgraded for pinning."); return; }
          p.pinned = res.pinned || [];
          renderMain(); return;
        }
        if (a === "add-member") {
          const inp = app.querySelector('[data-member-for="' + actEl.dataset.portal + '"]');
          const v = inp && inp.value.trim();
          if (!v) return;
          const res = await api("/api/portals/" + encodeURIComponent(actEl.dataset.portal), { method: "PATCH", body: JSON.stringify({ addMembers: [v] }) });
          if (PORTALS[actEl.dataset.portal]) PORTALS[actEl.dataset.portal].members = res.members || [];
          renderMain(); return;
        }
        if (a === "remove-member") {
          const res = await api("/api/portals/" + encodeURIComponent(actEl.dataset.portal), { method: "PATCH", body: JSON.stringify({ removeMembers: [actEl.dataset.email] }) });
          if (PORTALS[actEl.dataset.portal]) PORTALS[actEl.dataset.portal].members = res.members || [];
          renderMain(); return;
        }
        if (a === "edit-portal") { openEdit(actEl.dataset.portal); return; }
        if (a === "edit-doc") { openDocEdit(id); return; }
      } catch (e) {
        alert("Failed: " + e.message);
      }
      return;
    }

    // A click on the title link navigates; anywhere else on the row toggles the panel.
    if (ev.target.closest('a[data-role="open"]')) return;
    const row = ev.target.closest(".doc");
    if (row) toggle(row.dataset.id);
  });

  // ── New-portal dialog (#43) ──────────────────────────────────────────────────
  const dlgPortal = document.getElementById("dlg-portal");
  const npErr = document.getElementById("np-err");
  function showNpErr(msg) { npErr.textContent = msg; npErr.hidden = false; }
  document.getElementById("new-portal").addEventListener("click", () => {
    document.getElementById("form-portal").reset();
    npErr.hidden = true; npErr.textContent = "";
    dlgPortal.showModal();
    document.getElementById("np-name").focus();
  });
  document.getElementById("np-cancel").addEventListener("click", () => dlgPortal.close());
  document.getElementById("form-portal").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    npErr.hidden = true;
    const slug = document.getElementById("np-slug").value.trim();
    const name = document.getElementById("np-name").value.trim();
    const description = document.getElementById("np-desc").value.trim();
    const picked = document.querySelector('input[name="np-kind"]:checked');
    const kind = picked ? picked.value : "private";
    if (!slug) { showNpErr("A slug is required — it becomes the portal's URL path."); return; }
    const body = { slug, kind };
    if (name) body.name = name;
    if (description) body.description = description;
    const btn = document.getElementById("np-create");
    btn.disabled = true;
    try {
      await api("/api/portals", { method: "POST", body: JSON.stringify(body) });
      dlgPortal.close();
      selected = slug; // land on the portal you just made
      await load();
    } catch (e) {
      showNpErr(e.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ── Edit-portal dialog (#70): name + description only ─────────────────────────
  // Deliberately not kind — changing a portal's access floor (restricted→public exposes every
  // document) is a confidentiality decision, not a settings tweak. The slug is the URL and stays.
  const dlgEdit = document.getElementById("dlg-edit");
  const epErr = document.getElementById("ep-err");
  let editSlug = null;
  function showEpErr(msg) { epErr.textContent = msg; epErr.hidden = false; }
  function openEdit(slug) {
    const p = PORTALS[slug];
    if (!p) return;
    editSlug = slug;
    epErr.hidden = true; epErr.textContent = "";
    document.getElementById("ep-name").value = p.name || "";
    document.getElementById("ep-desc").value = p.description || "";
    dlgEdit.showModal();
    document.getElementById("ep-name").focus();
  }
  document.getElementById("ep-cancel").addEventListener("click", () => dlgEdit.close());
  document.getElementById("form-edit").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    epErr.hidden = true;
    if (!editSlug) return;
    const name = document.getElementById("ep-name").value.trim();
    const description = document.getElementById("ep-desc").value.trim();
    if (!name) { showEpErr("A name is required."); return; }
    const btn = document.getElementById("ep-save");
    btn.disabled = true;
    try {
      // Always send description so clearing it actually clears it (the API deletes an empty one).
      const res = await api("/api/portals/" + encodeURIComponent(editSlug), { method: "PATCH", body: JSON.stringify({ name, description }) });
      const cur = PORTALS[editSlug];
      if (cur) { cur.name = res.name; cur.description = res.description; }
      dlgEdit.close();
      renderNav();  // the sidebar shows the name
      renderMain();
    } catch (e) {
      showEpErr(e.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ── Edit-document dialog (#140): filename, title, summary, tags ───────────────
  // Deliberately not the contents (publish the file again) and not who can open it — reach is
  // the panel's whole job (ADR-011), and burying it in a modal would undo that.
  const dlgDoc = document.getElementById("dlg-doc");
  const edErr = document.getElementById("ed-err");
  const edName = document.getElementById("ed-name");
  const edMoveWarn = document.getElementById("ed-movewarn");
  let editDocId = null;
  let editDocName = "";
  function showEdErr(msg) { edErr.textContent = msg; edErr.hidden = false; }
  // Identity is case-insensitive (ADR-017), so Report.md -> report.md moves nothing — the
  // warning has to agree with the server or it cries wolf on a capitalization fix.
  const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const syncMoveWarn = () => { edMoveWarn.hidden = sameName(edName.value, editDocName); };

  // The real server limits, interpolated at build time rather than retyped (see console.ts).
  const LIMITS = { name: ${MAX_NAME_CHARS}, title: ${MAX_TITLE_CHARS}, summary: ${MAX_SUMMARY_CHARS}, tags: ${MAX_TAGS}, tag: ${MAX_TAG_CHARS} };

  // Counters stay quiet until a field is most of the way used. Showing "0/300" from the first
  // keystroke frames a generous limit as a constraint you are about to hit.
  function syncCount(field, used, max, label) {
    const el = document.getElementById("ed-" + field + "-count");
    if (!el) return;
    const ratio = max ? used / max : 0;
    el.textContent = ratio >= 0.75 ? used + "/" + max + (label ? " " + label : "") : "";
    el.className = "count" + (used > max ? " over" : ratio >= 0.9 ? " near" : "");
  }
  function syncCounts() {
    syncCount("name", edName.value.trim().length, LIMITS.name);
    syncCount("title", document.getElementById("ed-title").value.trim().length, LIMITS.title);
    syncCount("summary", document.getElementById("ed-summary").value.trim().length, LIMITS.summary);
    const tags = parseList(document.getElementById("ed-tags").value);
    syncCount("tags", tags.length, LIMITS.tags, "tags");
  }

  function openDocEdit(id) {
    const m = (DOCS[selected] || []).find((d) => d.id === id);
    if (!m) return;
    editDocId = id;
    editDocName = m.name || "";
    edErr.hidden = true; edErr.textContent = "";
    edName.value = editDocName;
    document.getElementById("ed-title").value = m.title || "";
    document.getElementById("ed-summary").value = m.summary || "";
    document.getElementById("ed-tags").value = (m.tags || []).join(", ");
    syncMoveWarn();
    syncCounts();
    dlgDoc.showModal();
    edName.focus();
  }
  edName.addEventListener("input", syncMoveWarn);
  // One listener for the whole form — the counters read every field anyway.
  document.getElementById("form-doc").addEventListener("input", syncCounts);
  document.getElementById("ed-cancel").addEventListener("click", () => dlgDoc.close());
  document.getElementById("form-doc").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    edErr.hidden = true;
    if (!editDocId) return;
    const name = edName.value.trim();
    const title = document.getElementById("ed-title").value.trim();
    const summary = document.getElementById("ed-summary").value.trim();
    const tags = parseList(document.getElementById("ed-tags").value);
    if (!name) { showEdErr("A filename is required — it is the document's identity."); return; }
    if (!title) { showEdErr("A title is required."); return; }
    // Catch the countable limits here so the answer is specific, rather than bouncing off the
    // server with a generic one. The server still enforces all of them — this only gets there first.
    if (tags.length > LIMITS.tags) {
      showEdErr("Too many tags: " + tags.length + ", and the limit is " + LIMITS.tags + ". Remove " + (tags.length - LIMITS.tags) + ".");
      return;
    }
    const longTag = tags.find((t) => t.length > LIMITS.tag);
    if (longTag) {
      showEdErr('The tag "' + longTag + '" is ' + longTag.length + " characters; the limit is " + LIMITS.tag + ".");
      return;
    }
    const btn = document.getElementById("ed-save");
    btn.disabled = true;
    try {
      // Always send summary and tags so emptying a box actually clears the field.
      const res = await patch(editDocId, { name, title, summary, tags });
      dlgDoc.close();
      // A rename changes the id, so the row and its cache entry are both keyed by the OLD one.
      // Re-key them in place and render from the RESPONSE — never a re-fetch, which would read
      // back a write KV has not propagated yet. Same reason replaceItem exists.
      if (res.movedFrom) {
        const item = app.querySelector('[data-item="' + res.movedFrom + '"]');
        if (item) item.setAttribute("data-item", res.id);
        const cache = DOCS[res.portal];
        if (cache) { const i = cache.findIndex((d) => d.id === res.movedFrom); if (i >= 0) cache[i] = res; }
      }
      replaceItem(res.movedFrom ? res.id : editDocId, res);
      if (res.movedFrom) {
        alert('Renamed to "' + res.name + '".\\n\\nIts link changed:\\n' + (res.url || "") + '\\n\\nThe old link redirects here for a year' + (res.publicUrl ? ", and the public link is unchanged." : "."));
      }
    } catch (e) {
      // Title, summary, tags and the filename share ONE 1024-byte index budget in KV, so each
      // can be under its own limit while the combination is not. The server is the authority on
      // that — but "too long to index" with no numbers leaves you poking at fields, so name the
      // budget and point at the field that is almost always the one to cut.
      if (e.code === "metadata_too_large") {
        const used = name.length + title.length + summary.length + tags.join("").length;
        showEdErr(
          "Together, the filename, title, summary and tags are too long to index — they share one " +
          "budget, so each can be under its own limit while the total is not. About " + used +
          " characters here. Shorten the summary (usually the longest) or drop a tag, then save again."
        );
      } else if (e.code === "name_taken") {
        showEdErr(
          e.message + ". Pick a different filename — renaming onto it would destroy it. " +
          "To replace that document deliberately, publish over it instead."
        );
      } else {
        showEdErr(e.message);
      }
    } finally {
      btn.disabled = false;
    }
  });

  // ── Upload / publish dialog (#6) ──────────────────────────────────────────────
  const dlgUpload = document.getElementById("dlg-upload");
  const upErr = document.getElementById("up-err");
  const upDrop = document.getElementById("up-drop");
  const upFile = document.getElementById("up-file");
  const upFileLabel = document.getElementById("up-filelabel");
  const upTitle = document.getElementById("up-title");
  const upPortalSel = document.getElementById("up-portal");
  const upInternal = document.getElementById("up-internal");
  const upPubWarn = document.getElementById("up-pubwarn");
  const upRelWarn = document.getElementById("up-relwarn");
  let uploadHtml = null;
  let uploadKind = "html";
  const showUpErr = (msg) => { upErr.textContent = msg; upErr.hidden = false; };
  const parseList = (s) => (s || "").split(/[\\s,]+/).map((x) => x.trim()).filter(Boolean);

  // Cheap relative-reference scan: a reference that is not absolute http(s), data:, blob:, a
  // #anchor, or a mail/tel/js scheme will 404 for the recipient — we host one file, no assets.
  function relativeRefs(text, kind) {
    const re = kind === "markdown" ? /\\]\\(([^)\\s]+)/g : /(?:src|href)\\s*=\\s*["']([^"']+)["']/gi;
    const found = []; let m;
    while ((m = re.exec(text)) && found.length < 3) {
      const v = m[1].trim();
      if (v && !/^(https?:|data:|blob:|mailto:|tel:|javascript:|#)/i.test(v)) found.push(v);
    }
    return found;
  }

  async function takeFile(file) {
    if (!file) return;
    uploadHtml = await file.text();
    const ext = (file.name.match(/\\.([^.]+)$/) || ["", ""])[1].toLowerCase();
    uploadKind = ext === "md" || ext === "markdown" ? "markdown" : "html";
    upDrop.classList.add("has-file");
    upFileLabel.textContent = file.name + " · " + Math.max(1, Math.round(file.size / 1024)) + " KB · " + uploadKind;
    if (!upTitle.value.trim()) upTitle.value = file.name.replace(/\\.[^.]+$/, "");
    const rel = relativeRefs(uploadHtml, uploadKind);
    if (rel.length) {
      upRelWarn.innerHTML = ico("alert") + "Relative references (e.g. <strong>" + esc(rel[0]) +
        "</strong>) will 404 for the recipient — PageVault hosts one HTML file, no separate assets. Embed them as data: URIs or use absolute https URLs.";
      upRelWarn.hidden = false;
    } else {
      upRelWarn.hidden = true;
    }
  }

  upFile.addEventListener("change", () => takeFile(upFile.files[0]));
  upDrop.addEventListener("dragover", (e) => { e.preventDefault(); upDrop.classList.add("drag"); });
  upDrop.addEventListener("dragleave", () => upDrop.classList.remove("drag"));
  upDrop.addEventListener("drop", (e) => { e.preventDefault(); upDrop.classList.remove("drag"); takeFile(e.dataTransfer.files[0]); });
  // Public is the default (ADR-011); the forwardable-link note shows until you opt into internal.
  upInternal.addEventListener("change", () => { upPubWarn.hidden = upInternal.checked; });
  dlgUpload.addEventListener("click", (e) => { const c = e.target.closest('[data-act="copy"]'); if (c) { e.preventDefault(); copyBtn(c); } });

  function openUpload(presetPortal) {
    document.getElementById("form-upload").reset();
    uploadHtml = null; uploadKind = "html";
    upErr.hidden = true; upRelWarn.hidden = true; upPubWarn.hidden = false;
    upDrop.classList.remove("has-file", "drag");
    upFileLabel.innerHTML = 'Drop an <code>.html</code> or <code>.md</code> file here, or click to choose';
    const slugs = Object.keys(PORTALS);
    upPortalSel.innerHTML = slugs.length
      ? slugs.map((s) => '<option value="' + esc(s) + '">' + esc(PORTALS[s].name) + ' (' + esc(PORTALS[s].kind) + ')</option>').join("")
      : '<option value="">default (created on first publish)</option>';
    const want = (presetPortal && PORTALS[presetPortal]) ? presetPortal : (PORTALS["default"] ? "default" : (selected || ""));
    if (want) upPortalSel.value = want;
    document.getElementById("up-body").hidden = false;
    document.getElementById("up-done").hidden = true;
    document.getElementById("up-foot").hidden = false;
    document.getElementById("up-donefoot").hidden = true;
    dlgUpload.showModal();
  }
  document.getElementById("new-doc").addEventListener("click", () => openUpload(selected));
  app.addEventListener("click", (ev) => { if (ev.target.closest("#pub-here")) openUpload(selected); });
  document.getElementById("up-cancel").addEventListener("click", () => dlgUpload.close());
  document.getElementById("up-close").addEventListener("click", () => dlgUpload.close());
  document.getElementById("up-again").addEventListener("click", () => openUpload(selected));

  function showUploadDone(res) {
    const link = res.publicUrl || res.url;
    try { navigator.clipboard && navigator.clipboard.writeText(link); } catch (e) {}
    const done = document.getElementById("up-done");
    const wide = !res.ownerOnly && !!res.publicUrl;
    done.innerHTML =
      '<div class="donerow"><div class="done-ok">' + ico(wide ? "globe" : "lock") + 'Published to ' + esc(res.portal) + (wide ? ' — anyone with the link can open it' : '') + '</div>' +
      '<div class="lnk"><code>' + esc(link) + '</code>' +
      '<button type="button" class="btn primary sm" data-act="copy" data-url="' + esc(link) + '">' + ico("copy") + 'Copy link</button>' +
      '<a class="btn sm" href="' + esc(link) + '" target="_blank" rel="noopener">Open &#8599;</a></div></div>';
    document.getElementById("up-body").hidden = true;
    done.hidden = false;
    document.getElementById("up-foot").hidden = true;
    document.getElementById("up-donefoot").hidden = false;
  }

  document.getElementById("form-upload").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    upErr.hidden = true;
    if (!uploadHtml) { showUpErr("Choose an .html file first."); return; }
    const title = upTitle.value.trim();
    if (!title) { showUpErr("A title is required."); return; }
    const body = { title, html: uploadHtml, portal: upPortalSel.value, sourceKind: uploadKind };
    // Public by default (ADR-011) — a shareable link just happens; "keep internal" opts out.
    if (!upInternal.checked) body.public = true;
    const emails = parseList(document.getElementById("up-emails").value);
    if (emails.length) body.emails = emails;
    const tags = parseList(document.getElementById("up-tags").value);
    if (tags.length) body.tags = tags;

    const btn = document.getElementById("up-publish");
    btn.disabled = true;
    const publish = (overwrite) => api("/api/docs", { method: "POST", body: JSON.stringify(overwrite ? Object.assign({}, body, { confirm: true }) : body) });
    try {
      let res;
      try {
        res = await publish(false);
      } catch (e) {
        if (/already exists in portal/i.test(e.message)) {
          if (!confirm(e.message + ". Publishing replaces it in place, keeping the same URL. Replace it?")) { btn.disabled = false; return; }
          res = await publish(true);
        } else {
          throw e;
        }
      }
      showUploadDone(res);
      // The published portal's doc cache is now stale — drop it so a re-select refetches.
      if (res.portal) delete DOCS[res.portal];
      if (res.portal === selected) { delete DOCS[selected]; selectPortal(selected); }
      else { load(); }
    } catch (e) {
      showUpErr(e.message);
    } finally {
      btn.disabled = false;
    }
  });

  // Server timestamps are baked in UTC (ADR-010); show them in the operator's own zone. The
  // UTC text stays as the no-JS fallback and lives on in the title attribute.
  for (const el of document.querySelectorAll("[data-utc]")) {
    const d = new Date(el.dataset.utc);
    if (!isNaN(d)) el.textContent = d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  load();
  // Independent of load() on purpose: the seat count is a Cloudflare API round-trip, and the
  // document list must not wait on it.
  loadSeats();
</script>
</body>
</html>`;
}

// ── Brand + icon assets (inline SVG; CSP-safe) ─────────────────────────────────

// The dark token set, shared by the prefers-color-scheme default and the explicit override.
const DARK_TOKENS = `color-scheme:dark;
    --pv-bg:#0F1216; --pv-surface:#161A20; --pv-surface-2:#1B2027; --pv-border:#262C35;
    --pv-border-2:#232830; --pv-ink:#F1F3F6; --pv-text:#C4CAD4; --pv-text-2:#AEB5C0;
    --pv-muted:#828B98; --pv-faint:#646D7A; --pv-chip:#222831; --pv-chip-bd:#2B323C;
    --pv-field-bg:#10141A; --pv-field-bd:#2E353F; --pv-accent:#5B8CF5; --pv-accent-hover:#7CA4F8;
    --pv-accent-soft:#182231; --pv-header:#12161B; --pv-code-bg:#14202F; --pv-code-bd:#1F3350;
    --pv-code-tx:#7CA4F8; --pv-danger:#E0687E; --pv-warn:#D6A24A;
    --pv-lv-individual:#98A0AC; --pv-lv-team:#5B8CF5; --pv-lv-link:#D6A24A; --pv-lv-public:#E0687E;`;

// prefers-color-scheme dark, but only when the user has not pinned a theme (data-theme unset).
// The :not([data-theme]) guard lets an explicit light choice win over the OS preference.
const DARK_TOKENS_MEDIA = (_nonce: string): string =>
  `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { ${DARK_TOKENS} } }`;

// The icon symbol set — from the Claude Design handoff where provided (access + doc icons at
// their specified stroke widths), feather-style for the rest. Referenced with <use href="#i-…">.
const ICON_DEFS = `<svg class="sprite" aria-hidden="true"><defs>
  <symbol id="i-individual" viewBox="0 0 24 24"><circle cx="12" cy="7.5" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/></symbol>
  <symbol id="i-users" viewBox="0 0 24 24"><circle cx="8.5" cy="8" r="3"/><path d="M2.5 19a6 6 0 0 1 12 0"/><path d="M15.5 5.2a3 3 0 0 1 0 5.6"/><path d="M17 13.6a6 6 0 0 1 4.5 5.4"/></symbol>
  <symbol id="i-link" viewBox="0 0 24 24"><path d="M9 15l6-6"/><path d="M11 6.5l1.4-1.4a4.2 4.2 0 0 1 6 6L17 12.5"/><path d="M13 17.5l-1.4 1.4a4.2 4.2 0 0 1-6-6L7 11.5"/></symbol>
  <symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 3.6 9 14 14 0 0 1-3.6 9 14 14 0 0 1-3.6-9A14 14 0 0 1 12 3z"/></symbol>
  <symbol id="i-lock" viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></symbol>
  <symbol id="i-doc-html" viewBox="0 0 24 24"><path d="M13 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6l5 5v11a2 2 0 0 1-2 2z"/><path d="M10 13l-1.6 1.6L10 16.2M14 13l1.6 1.6L14 16.2"/></symbol>
  <symbol id="i-doc-md" viewBox="0 0 24 24"><path d="M13 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6l5 5v11a2 2 0 0 1-2 2z"/><path d="M8.5 16v-3l1.6 1.8L11.7 13v3M14 13v3M12.6 14.6L14 16.2l1.4-1.6"/></symbol>
  <symbol id="i-mail" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></symbol>
  <symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 3 2 20h20L12 3Z"/><line x1="12" y1="10" x2="12" y2="14"/><line x1="12" y1="17" x2="12" y2="17"/></symbol>
  <symbol id="i-widen" viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></symbol>
  <symbol id="i-chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
  <symbol id="i-x" viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></symbol>
  <symbol id="i-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></symbol>
  <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="i-chart" viewBox="0 0 24 24"><path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/></symbol>
  <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></symbol>
  <symbol id="i-moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></symbol>
  <symbol id="i-signout" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></symbol>
  <symbol id="i-upload" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></symbol>
  <symbol id="i-pin" viewBox="0 0 24 24"><path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3H7l3-3z"/></symbol>
  <symbol id="i-edit" viewBox="0 0 24 24"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></symbol>
  <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/></symbol>
  <symbol id="i-open" viewBox="0 0 24 24"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/></symbol>
</defs></svg>`;

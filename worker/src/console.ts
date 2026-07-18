import { emailsMatch } from "./access.js";
import { identify } from "./auth.js";
import type { Env } from "./env.js";
import { consoleForbidden } from "./pages.js";
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

  return new Response(page(session, nonce, identity.email, env.PAGEVAULT_VERSION || "dev", origin), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [
        "default-src 'none'",
        `style-src 'nonce-${nonce}'`,
        `script-src 'nonce-${nonce}'`,
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
 * One server-rendered page: portals → documents. Each document row leads with a *reach*
 * icon that names how far it can travel (only you / team / anyone-with-the-link / public);
 * expanding a row reveals the sharing controls — public-link mint & revoke, and the
 * per-document email grants. Restricted portals also carry the team editor.
 *
 * The session token is embedded as a JS string and sent as a bearer; on any 401 the page
 * reloads, which re-authenticates through Access and mints a fresh token (ADR-004).
 *
 * KV note: after a mutation we re-render the affected row from the API *response* (which is
 * read-your-write), never from a re-list — a re-list is eventually consistent and would show
 * stale state for up to a minute.
 */
function page(session: string, nonce: string, owner: string, version: string, origin: string): string {
  // Access logout lands on Cloudflare's default page and, on the next login, has no
  // redirect_url — so the user is dropped somewhere that 404s. `returnTo` closes the loop:
  // logout → login → back to /admin. Absolute (from the request origin) so it is right on
  // both the test and prod hostnames.
  const logoutUrl = `${origin}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(`${origin}/admin`)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PageVault — console</title>
<style nonce="${nonce}">
  :root {
    --ink:#1e1610; --line:#d8cdb0; --paper:#fbf6ec; --card:#fff; --blue:#34507a; --muted:#7d6b52;
    --closed:#6f6150; --gated:#34507a; --open:#a4402a; --danger:#8a2b2b;
    --closed-bg:#f1ead9; --gated-bg:#e9eef5; --open-bg:#f6e7e0;
  }
  *,*::before,*::after { box-sizing:border-box; }
  body { margin:0; font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; color:var(--ink); background:var(--paper); }
  .icon { width:1em; height:1em; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; flex:none; }
  header { display:flex; align-items:center; gap:1rem; padding:.7rem 1.25rem; border-bottom:1px solid var(--line); background:var(--card); }
  .brand { display:flex; align-items:center; gap:.5rem; }
  .brand h1 { font-size:1rem; margin:0; color:var(--blue); letter-spacing:.01em; }
  .mark { width:1.4rem; height:1.4rem; color:var(--blue); fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  .user { margin-left:auto; display:flex; align-items:center; gap:.75rem; }
  .who { color:var(--muted); font-size:.8125rem; }
  .signout { display:inline-flex; align-items:center; gap:.3rem; color:var(--muted); font-size:.8125rem; text-decoration:none; border:1px solid var(--line); border-radius:5px; padding:.15rem .5rem; }
  .signout:hover { color:var(--ink); background:var(--paper); }
  .signout .icon { width:.95em; height:.95em; }

  .shell { display:flex; align-items:flex-start; gap:1.5rem; max-width:64rem; margin:0 auto; padding:1.25rem 1.25rem 3rem; }
  .sidenav { flex:none; width:11rem; position:sticky; top:1rem; display:flex; flex-direction:column; gap:.1rem; }
  .content { flex:1 1 auto; min-width:0; }
  .navitem { display:flex; align-items:center; gap:.45rem; width:100%; text-align:left; border:1px solid transparent; background:none; color:var(--ink); font:inherit; font-size:.82rem; padding:.35rem .5rem; border-radius:6px; cursor:pointer; }
  .navitem:hover { background:var(--card); border-color:var(--line); }
  .navitem .icon { flex:none; }
  .navitem.public .icon { color:var(--open); } .navitem.restricted .icon { color:var(--gated); } .navitem.private .icon { color:var(--closed); }
  .navitem .nm { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .navitem .cnt { margin-left:auto; color:var(--muted); font-size:.72rem; font-variant-numeric:tabular-nums; }
  .portal { scroll-margin-top:1rem; }
  @media (max-width:820px) {
    .shell { flex-direction:column; gap:.75rem; }
    .sidenav { position:static; width:auto; flex-direction:row; flex-wrap:wrap; gap:.3rem; }
    .navitem { width:auto; }
  }

  .legend { display:flex; flex-wrap:wrap; gap:.35rem .9rem; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:.65rem .9rem; margin-bottom:1.1rem; font-size:.8rem; }
  .legend .lg-title { flex-basis:100%; color:var(--muted); font-size:.68rem; text-transform:uppercase; letter-spacing:.06em; }
  .legend .lg { display:inline-flex; align-items:center; gap:.4rem; }
  .tc { color:var(--closed); } .tg { color:var(--gated); } .to { color:var(--open); }

  .portal { border:1px solid var(--line); border-radius:8px; background:var(--card); margin-bottom:1.1rem; overflow:hidden; }
  .portal > h2 { display:flex; align-items:center; gap:.55rem; font-size:.95rem; margin:0; padding:.7rem 1rem; border-bottom:1px solid var(--line); }
  .portal > h2 .p-icon { font-size:1.05rem; }
  .portal.public > h2 .p-icon { color:var(--open); }
  .portal.restricted > h2 .p-icon { color:var(--gated); }
  .portal.private > h2 .p-icon { color:var(--closed); }
  .portal > h2 .name { font-weight:600; }
  .portal > h2 .kind { color:var(--muted); font-weight:400; font-size:.8em; }

  .access-note { display:flex; align-items:center; gap:.45rem; padding:.5rem 1rem; border-bottom:1px solid #efe7d4; color:var(--muted); font-size:.82rem; background:#fdfaf2; }

  .members { padding:.6rem 1rem; border-bottom:1px solid #efe7d4; background:#fdfaf2; }
  .members .cap { display:flex; align-items:center; gap:.4rem; color:var(--muted); font-size:.72rem; margin-bottom:.45rem; }

  .item { border-top:1px solid #efe7d4; }
  .item:first-of-type { border-top:0; }
  .doc { display:flex; align-items:center; gap:.6rem; padding:.55rem .5rem .55rem .8rem; cursor:pointer; }
  .doc:hover { background:#fbf7ec; }
  .doc .reach { display:inline-flex; align-items:center; justify-content:center; width:1.65rem; height:1.65rem; border-radius:6px; font-size:1rem; flex:none; }
  .reach.closed { color:var(--closed); background:var(--closed-bg); }
  .reach.gated  { color:var(--gated);  background:var(--gated-bg); }
  .reach.open   { color:var(--open);   background:var(--open-bg); }
  .doc .t { font-weight:500; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ink); text-decoration:none; }
  .doc a.t:hover { text-decoration:underline; }
  .doc .tag { flex:none; display:inline-flex; align-items:center; gap:.2rem; font-size:.7rem; color:var(--muted); border:1px solid var(--line); border-radius:99px; padding:.05rem .5rem; }
  .doc .tag.warn { color:var(--open); border-color:#d9b7ab; font-weight:600; }
  .doc .d { flex:none; margin-left:auto; color:var(--muted); font-size:.78rem; font-variant-numeric:tabular-nums; }
  .chev { flex:none; border:1px solid transparent; background:none; color:var(--muted); cursor:pointer; padding:.15rem; border-radius:5px; display:inline-flex; }
  .chev:hover { color:var(--ink); background:var(--paper); }
  .chev .icon { transition:transform .15s ease; }
  .doc[aria-expanded="true"] .chev .icon { transform:rotate(180deg); }
  @media (prefers-reduced-motion:reduce) { .chev .icon { transition:none; } }

  .detail { border-top:1px solid #efe7d4; background:#fdfaf2; padding:.7rem 1rem .85rem; font-size:.85rem; }
  .detail[hidden] { display:none; }
  .drow { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; padding:.25rem 0; }
  .drow .dlabel { display:inline-flex; align-items:center; gap:.35rem; color:var(--muted); min-width:9.5rem; flex:none; }
  .detail code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.78rem; word-break:break-all; background:var(--card); border:1px solid var(--line); border-radius:4px; padding:.1rem .35rem; }
  .detail hr { border:0; border-top:1px solid #efe7d4; margin:.55rem 0; }
  .dhint { color:var(--muted); font-size:.75rem; margin:.15rem 0 .4rem; }
  .dhint.err { color:var(--danger); }
  .warnline { display:flex; align-items:center; gap:.4rem; color:var(--open); font-size:.78rem; background:var(--open-bg); border:1px solid #d9b7ab; border-radius:5px; padding:.35rem .55rem; margin-bottom:.5rem; }
  .foot { display:flex; margin-top:.55rem; }
  .foot .grow { flex:1 1 auto; }

  .chips { list-style:none; display:flex; flex-wrap:wrap; gap:.4rem; margin:.1rem 0 .5rem; padding:0; }
  .chip { display:inline-flex; align-items:center; gap:.3rem; background:var(--gated-bg); border:1px solid #cdd9e8; color:#2c435f; border-radius:99px; padding:.1rem .3rem .1rem .6rem; font-size:.8rem; }
  .addrow { display:flex; gap:.4rem; }
  .addrow input { flex:1 1 auto; padding:.32rem .55rem; border:1px solid var(--line); border-radius:5px; font:inherit; font-size:.85rem; background:var(--card); }
  input:focus-visible, button:focus-visible, a:focus-visible { outline:2px solid var(--blue); outline-offset:1px; }

  button.btn, a.btn { font:inherit; font-size:.78rem; padding:.24rem .6rem; border:1px solid var(--line); border-radius:5px; background:var(--card); color:var(--blue); cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; gap:.3rem; }
  button.btn:hover, a.btn:hover { background:var(--paper); }
  button.btn.danger { color:var(--danger); }
  button.btn.open { color:var(--open); border-color:#d9b7ab; }
  button.x { border:0; background:none; padding:0 .15rem; color:#7690b0; cursor:pointer; display:inline-flex; }
  button.x:hover { color:var(--danger); }

  .empty { color:var(--muted); padding:.55rem 1rem; font-size:.85rem; }
  .err { color:var(--danger); }
  footer { max-width:64rem; margin:0 auto; padding:.25rem 1.25rem 1.5rem; color:var(--muted); font-size:.72rem; }
</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="i-lock" viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></symbol>
  <symbol id="i-users" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></symbol>
  <symbol id="i-link" viewBox="0 0 24 24"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/></symbol>
  <symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/></symbol>
  <symbol id="i-mail" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></symbol>
  <symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 3 2 20h20L12 3Z"/><line x1="12" y1="10" x2="12" y2="14"/><line x1="12" y1="17" x2="12" y2="17"/></symbol>
  <symbol id="i-chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
  <symbol id="i-x" viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></symbol>
  <symbol id="i-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></symbol>
  <symbol id="i-aperture" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94"/><path d="M9.69 8h11.48"/><path d="m7.38 12 5.74-9.94"/><path d="M9.69 16 3.95 6.06"/><path d="M14.31 16H2.83"/><path d="m16.62 12-5.74 9.94"/></symbol>
  <symbol id="i-signout" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></symbol>
</svg>
<header>
  <span class="brand"><svg class="mark" aria-hidden="true"><use href="#i-aperture"/></svg><h1>PageVault console</h1></span>
  <span class="user">
    <span class="who">${esc(owner)}</span>
    <a class="signout" href="${logoutUrl}" title="End your Cloudflare Access session"><svg class="icon" aria-hidden="true"><use href="#i-signout"/></svg>Sign out</a>
  </span>
</header>
<div class="shell">
  <nav id="nav" class="sidenav" aria-label="Portals"></nav>
  <main class="content">
    <div class="legend">
      <span class="lg-title">Who can reach a document</span>
      <span class="lg tc"><svg class="icon"><use href="#i-lock"/></svg> Only you</span>
      <span class="lg tg"><svg class="icon"><use href="#i-users"/></svg> Team &mdash; login required</span>
      <span class="lg to"><svg class="icon"><use href="#i-link"/></svg> Anyone with the link</span>
      <span class="lg to"><svg class="icon"><use href="#i-globe"/></svg> Public &mdash; listed</span>
    </div>
    <div id="app"><p class="empty">Loading…</p></div>
  </main>
</div>
<footer>PageVault ${esc(version)}</footer>
<script nonce="${nonce}">
  const T = ${JSON.stringify(session)};
  const app = document.getElementById("app");
  const PORTALS = {};
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const ico = (id) => '<svg class="icon"><use href="#i-' + id + '"/></svg>';

  async function api(path, opts) {
    opts = opts || {};
    const headers = { Authorization: "Bearer " + T };
    if (opts.body) headers["Content-Type"] = "application/json";
    const r = await fetch(path, { method: opts.method || "GET", headers, body: opts.body });
    if (r.status === 401) { location.reload(); throw new Error("reauth"); }
    if (!r.ok) {
      let msg = path + " -> " + r.status;
      try { const j = JSON.parse(await r.text()); if (j && j.error) msg = j.error; } catch (e) {}
      throw new Error(msg);
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
  // Copying the /v route for a page that is public just hands someone a login wall. Needs
  // full meta (the /p token is not in the listing).
  function shareUrl(m, portal) {
    if (portal.kind === "public") return location.origin + viewPath("public", portal.slug, m.id);
    if (m.publicToken) return location.origin + "/p/" + m.publicToken;
    return location.origin + viewPath(portal.kind, portal.slug, m.id);
  }

  // Effective reach — the most-open door this document has. A draft narrows to owner-only
  // and beats everything (the one rule canView() applies before any grant).
  function reach(d, kind) {
    if (d.ownerOnly)       return { tier:"closed", icon:"lock",  label:"Draft — only you" };
    if (kind === "public") return { tier:"open",   icon:"globe", label:"Public — listed" };
    if (hasLink(d))        return { tier:"open",   icon:"link",  label:"Anyone with the link" };
    if (kind === "restricted") return { tier:"gated", icon:"users", label:"Team — login required" };
    return { tier:"closed", icon:"lock", label:"Only you" };
  }

  function rowHtml(d, portal) {
    const r = reach(d, portal.kind);
    const href = viewPath(portal.kind, portal.slug, d.id);
    const tags =
      (d.ownerOnly ? '<span class="tag">draft</span>' : '') +
      (d.sourceKind === "markdown" ? '<span class="tag">md</span>' : '') +
      // A public link on an otherwise-private document is the case worth flagging out loud.
      (hasLink(d) && portal.kind === "private" ? '<span class="tag warn">' + ico("alert") + 'public link</span>' : '');
    return (
      '<div class="doc" data-id="' + esc(d.id) + '" aria-expanded="false">' +
        '<span class="reach ' + r.tier + '" title="' + esc(r.label) + '">' + ico(r.icon) + '</span>' +
        '<a class="t" data-role="open" href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(d.title) + '</a>' +
        tags +
        '<span class="d">' + esc((d.updatedAt || "").slice(0, 10)) + '</span>' +
        '<button class="chev" data-act="expand" data-id="' + esc(d.id) + '" aria-expanded="false" aria-controls="dt-' + esc(d.id) + '" title="Sharing details">' + ico("chev") + '</button>' +
      '</div>'
    );
  }

  // The sharing panel, built from a full-meta read (publicToken + extraEmails, absent from the
  // listing). The notice arg renders a one-line banner — used to surface a group-sync that did
  // not fully succeed after a grant.
  function detailHtml(m, portal, notice) {
    const kind = portal.kind;
    const href = viewPath(kind, portal.slug, m.id);
    const parts = [];
    if (notice) parts.push('<div class="warnline">' + ico("alert") + esc(notice) + '</div>');

    parts.push(
      '<div class="drow"><span class="dlabel">' + ico(kind === "public" ? "globe" : "lock") + 'This document</span>' +
      '<a class="btn" data-role="open" href="' + esc(href) + '" target="_blank" rel="noopener">Open &#8599;</a>' +
      '<button class="btn" data-act="copy" data-url="' + esc(shareUrl(m, portal)) + '">' + ico("copy") + 'Copy link</button>' +
      '<button class="btn" data-act="toggle" data-id="' + esc(m.id) + '" data-owneronly="' + (m.ownerOnly ? "1" : "0") + '">' + (m.ownerOnly ? "Publish" : "Make draft") + '</button></div>'
    );

    if (kind !== "public") {
      if (m.publicToken) {
        const purl = location.origin + "/p/" + m.publicToken;
        parts.push(
          '<div class="drow"><span class="dlabel">' + ico("link") + 'Public link</span>' +
          '<code>' + esc(purl) + '</code>' +
          '<button class="btn" data-act="copy" data-url="' + esc(purl) + '">' + ico("copy") + 'Copy</button>' +
          '<button class="btn danger" data-act="revoke" data-id="' + esc(m.id) + '">Revoke</button></div>'
        );
      } else {
        parts.push(
          '<div class="drow"><span class="dlabel">' + ico("link") + 'Public link</span>' +
          '<span class="dhint" style="margin:0">None.</span>' +
          '<button class="btn open" data-act="mint" data-id="' + esc(m.id) + '">' + ico("globe") + 'Make public</button></div>'
        );
      }

      parts.push('<hr>');
      parts.push('<div class="dlabel" style="min-width:0">' + ico("mail") + 'Also shared with</div>');
      parts.push('<div class="dhint">Specific people, added to this document only. Additive — it never removes anyone the portal already lets in.</div>');
      const emails = m.extraEmails || [];
      parts.push(emails.length
        ? '<ul class="chips">' + emails.map((e) =>
            '<li class="chip">' + esc(e) + '<button class="x" data-act="unshare" data-id="' + esc(m.id) + '" data-email="' + esc(e) + '" title="remove">' + ico("x") + '</button></li>'
          ).join("") + '</ul>'
        : '<div class="dhint">No extra people yet.</div>');
      parts.push(
        '<div class="addrow"><input type="email" placeholder="email to add" data-email-for="' + esc(m.id) + '">' +
        '<button class="btn" data-act="share" data-id="' + esc(m.id) + '">Add</button></div>'
      );
    } else {
      parts.push('<div class="dhint">This portal is public — everything in it is readable by anyone with the link, so per-person sharing does not apply.</div>');
    }

    parts.push('<div class="foot"><span class="grow"></span><button class="btn danger" data-act="delete" data-id="' + esc(m.id) + '" data-title="' + esc(m.title) + '">Delete document</button></div>');
    return parts.join("");
  }

  const nav = document.getElementById("nav");

  async function load() {
    try {
      const { portals } = await api("/api/portals");
      if (!portals.length) { app.innerHTML = '<p class="empty">No portals yet. Publish a document to create one.</p>'; nav.innerHTML = ""; return; }
      const blocks = [];
      const navItems = [];
      for (const p of portals) {
        PORTALS[p.slug] = p;
        const [detail, docsRes] = await Promise.all([
          api("/api/portals/" + encodeURIComponent(p.slug)),
          api("/api/docs?portal=" + encodeURIComponent(p.slug)),
        ]);

        // canView() reads members only for restricted portals. Rendering the team editor for
        // the other kinds admits emails to the Access group (burning a seat) while granting
        // nothing — so it is restricted-only; private and public get a one-line access note.
        let access;
        if (p.kind === "restricted") {
          const members = detail.members || [];
          const chips = members.length
            ? '<ul class="chips">' + members.map((m) => '<li class="chip">' + esc(m) + '<button class="x" data-act="remove-member" data-portal="' + esc(p.slug) + '" data-email="' + esc(m) + '" title="remove">' + ico("x") + '</button></li>').join("") + '</ul>'
            : '<div class="dhint">No members yet.</div>';
          access =
            '<div class="members"><span class="cap">' + ico("users") + 'Team — everyone here sees every document in this portal</span>' +
            chips +
            '<div class="addrow"><input type="email" placeholder="email to add" data-member-for="' + esc(p.slug) + '">' +
            '<button class="btn" data-act="add-member" data-portal="' + esc(p.slug) + '">Add</button></div></div>';
        } else if (p.kind === "public") {
          access = '<div class="access-note">' + ico("globe") + 'Anyone with the link — no login, no Access seats. This portal is listed and browsable.</div>';
        } else {
          access = '<div class="access-note">' + ico("lock") + 'Yours only, unless a document below widens itself.</div>';
        }

        const docs = docsRes.docs || [];
        const rows = docs.length
          ? docs.map((d) => '<div class="item" data-item="' + esc(d.id) + '">' + rowHtml(d, p) + '<div class="detail" id="dt-' + esc(d.id) + '" data-detail="' + esc(d.id) + '" hidden></div></div>').join("")
          : '<p class="empty">No documents.</p>';

        const pico = p.kind === "public" ? "globe" : p.kind === "restricted" ? "users" : "lock";
        navItems.push(
          '<button class="navitem ' + p.kind + '" data-nav="' + esc(p.slug) + '">' + ico(pico) +
          '<span class="nm">' + esc(p.name) + '</span><span class="cnt">' + docs.length + '</span></button>'
        );

        blocks.push(
          '<section class="portal ' + p.kind + '" id="portal-' + esc(p.slug) + '">' +
          '<h2><span class="p-icon">' + ico(pico) + '</span>' +
          '<span class="name">' + esc(p.name) + '</span><span class="kind">' + esc(p.slug) + ' &middot; ' + esc(p.kind) + '</span></h2>' +
          access + rows + '</section>'
        );
      }
      app.innerHTML = blocks.join("");
      nav.innerHTML = navItems.join("");
    } catch (e) {
      app.innerHTML = '<p class="empty err">Could not load: ' + esc(e.message) + '</p>';
    }
  }

  // Left-nav: clicking a portal brings it to the top — a quick table of contents.
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  nav.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-nav]");
    if (!b) return;
    const el = document.getElementById("portal-" + b.dataset.nav);
    if (el) el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
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
        if (a === "expand") { await toggle(id); return; }
        if (a === "copy") { copyBtn(actEl); return; }
        if (a === "mint") {
          if (!confirm("Make public? This mints an unguessable link anyone can open — no login, no Access seat.")) return;
          replaceItem(id, await patch(id, { makePublic: true })); return;
        }
        if (a === "revoke") {
          if (!confirm("Revoke the public link? Anyone holding it loses access. The document itself stays.")) return;
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
          // Surface a grant that landed in KV but that Access will not (yet) honor. ADR-002.
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
          return;
        }
        if (a === "add-member") {
          const inp = app.querySelector('[data-member-for="' + actEl.dataset.portal + '"]');
          const v = inp && inp.value.trim();
          if (!v) return;
          await api("/api/portals/" + encodeURIComponent(actEl.dataset.portal), { method: "PATCH", body: JSON.stringify({ addMembers: [v] }) });
          await load(); return;
        }
        if (a === "remove-member") {
          await api("/api/portals/" + encodeURIComponent(actEl.dataset.portal), { method: "PATCH", body: JSON.stringify({ removeMembers: [actEl.dataset.email] }) });
          await load(); return;
        }
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

  load();
</script>
</body>
</html>`;
}

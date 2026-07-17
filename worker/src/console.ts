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

  return new Response(page(session, nonce, identity.email, env.PAGEVAULT_VERSION || "dev"), {
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
 * One server-rendered page: portals → documents, with member editing (restricted portals
 * only), the draft toggle, delete, and a per-document view/copy link. The session token is
 * embedded as a JS string and sent as a bearer; on any 401 the page reloads, which
 * re-authenticates through Access and mints a fresh token (ADR-004).
 */
function page(session: string, nonce: string, owner: string, version: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PageVault — console</title>
<style nonce="${nonce}">
  :root { --ink:#1e1610; --line:#d8cdb0; --paper:#fbf6ec; --blue:#34507a; --muted:#7d6b52; }
  *,*::before,*::after { box-sizing:border-box; }
  body { margin:0; font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; color:var(--ink); background:var(--paper); }
  header { display:flex; align-items:baseline; gap:1rem; padding:.75rem 1.25rem; border-bottom:1px solid var(--line); background:#fff; }
  header h1 { font-size:1rem; margin:0; color:var(--blue); }
  header .who { margin-left:auto; color:var(--muted); font-size:.8125rem; }
  main { max-width:52rem; margin:0 auto; padding:1.5rem 1.25rem; }
  .portal { border:1px solid var(--line); border-radius:8px; background:#fff; margin-bottom:1rem; overflow:hidden; }
  .portal > h2 { font-size:.95rem; margin:0; padding:.7rem 1rem; border-bottom:1px solid var(--line); }
  .portal > h2 .kind { color:var(--muted); font-weight:400; font-size:.8em; }
  .doc { display:flex; gap:.75rem; align-items:center; padding:.55rem 1rem; border-top:1px solid #efe7d4; font-size:.9rem; }
  .doc .t { font-weight:500; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ink); text-decoration:none; }
  .doc a.t:hover { text-decoration:underline; }
  .doc .badge { flex:none; font-size:.7rem; color:var(--muted); border:1px solid var(--line); border-radius:99px; padding:.05rem .5rem; }
  .doc .d { flex:none; margin-left:auto; color:var(--muted); font-size:.78rem; font-variant-numeric:tabular-nums; }
  .doc .actions { flex:none; display:flex; gap:.4rem; }
  .access-note { padding:.55rem 1rem; border-top:1px solid #efe7d4; color:var(--muted); font-size:.82rem; }
  .members { padding:.55rem 1rem; border-top:1px solid #efe7d4; }
  .members ul { list-style:none; margin:0 0 .5rem; padding:0; display:flex; flex-wrap:wrap; gap:.4rem; }
  .members li { display:flex; align-items:center; gap:.35rem; background:var(--paper); border:1px solid var(--line); border-radius:99px; padding:.1rem .35rem .1rem .6rem; font-size:.8rem; }
  .members li.empty { border:0; background:none; color:var(--muted); padding:.1rem 0; }
  .addmem { display:flex; gap:.4rem; }
  .addmem input { flex:1 1 auto; padding:.3rem .5rem; border:1px solid var(--line); border-radius:5px; font:inherit; font-size:.85rem; }
  button { font:inherit; font-size:.78rem; padding:.2rem .55rem; border:1px solid var(--line); border-radius:5px; background:#fff; color:var(--blue); cursor:pointer; }
  button:hover { background:var(--paper); }
  button.danger { color:#8a2b2b; }
  button.x { border:0; background:none; padding:0 .2rem; color:var(--muted); }
  .empty { color:var(--muted); padding:.55rem 1rem; font-size:.85rem; }
  .err { color:#8a2b2b; }
  footer { max-width:52rem; margin:0 auto; padding:.25rem 1.25rem 1.5rem; color:var(--muted); font-size:.72rem; }
</style>
</head>
<body>
<header>
  <h1>PageVault console</h1>
  <span class="who">${esc(owner)}</span>
</header>
<main id="app"><p class="empty">Loading…</p></main>
<footer>PageVault ${esc(version)}</footer>
<script nonce="${nonce}">
  const T = ${JSON.stringify(session)};
  const app = document.getElementById("app");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

  async function api(path, opts) {
    opts = opts || {};
    const headers = { Authorization: "Bearer " + T };
    if (opts.body) headers["Content-Type"] = "application/json";
    const r = await fetch(path, { method: opts.method || "GET", headers, body: opts.body });
    if (r.status === 401) { location.reload(); throw new Error("reauth"); }
    if (!r.ok) throw new Error(path + " -> " + r.status);
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }

  // Mirror of documentPath() in documents.ts: a public portal serves at /pub, everything
  // else at /v. Handing a /v link to a public page walks the recipient into an Access login
  // wall and burns a seat — so this distinction is not cosmetic. See ADR-001/ADR-002.
  function docPath(kind, slug, id) {
    const s = encodeURIComponent(slug), i = encodeURIComponent(id);
    return kind === "public" ? "/pub/" + s + "/" + i : "/v/" + s + "/" + i;
  }

  function docRow(d, p) {
    const href = docPath(p.kind, p.slug, d.id);
    return '<div class="doc">' +
      '<a class="t" href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(d.title) + '</a>' +
      (d.ownerOnly ? '<span class="badge">draft</span>' : '') +
      '<span class="d">' + esc((d.updatedAt || "").slice(0, 10)) + '</span>' +
      '<span class="actions">' +
        '<button data-action="copy" data-href="' + esc(href) + '">Copy link</button>' +
        '<button data-action="toggle" data-id="' + esc(d.id) + '" data-owneronly="' + (d.ownerOnly ? "1" : "0") + '">' +
          (d.ownerOnly ? "Publish" : "Make draft") + '</button>' +
        '<button class="danger" data-action="delete" data-id="' + esc(d.id) + '" data-title="' + esc(d.title) + '">Delete</button>' +
      '</span></div>';
  }

  function memberRow(slug, email) {
    return '<li><span>' + esc(email) + '</span>' +
      '<button class="x" title="remove" data-action="remove-member" data-portal="' + esc(slug) + '" data-email="' + esc(email) + '">&times;</button></li>';
  }

  async function load() {
    try {
      const { portals } = await api("/api/portals");
      if (!portals.length) { app.innerHTML = '<p class="empty">No portals yet. Publish a document to create one.</p>'; return; }
      const blocks = [];
      for (const p of portals) {
        const [detail, docsRes] = await Promise.all([
          api("/api/portals/" + encodeURIComponent(p.slug)),
          api("/api/docs?portal=" + encodeURIComponent(p.slug)),
        ]);
        // Members are consulted by canView() ONLY for restricted portals: public returns
        // true before members is read, private falls through to a deny. Rendering the add
        // control for the other two kinds is worse than useless — Add admits the email to
        // the Access group and burns a free seat while granting nothing. So the member
        // block is restricted-only; private and public each get a one-line access note.
        let access;
        if (p.kind === "restricted") {
          const members = detail.members || [];
          const memberList = members.length
            ? members.map((m) => memberRow(p.slug, m)).join("")
            : '<li class="empty">No members</li>';
          access =
            '<div class="members"><ul>' + memberList + '</ul>' +
            '<div class="addmem"><input type="email" placeholder="email to add" data-portal="' + esc(p.slug) + '">' +
            '<button data-action="add-member" data-portal="' + esc(p.slug) + '">Add</button></div></div>';
        } else if (p.kind === "public") {
          access = '<div class="access-note">Anyone with the link — no login, no Access seats.</div>';
        } else {
          access = '<div class="access-note">Yours only.</div>';
        }
        const docs = docsRes.docs || [];
        const rows = docs.length ? docs.map((d) => docRow(d, p)).join("") : '<p class="empty">No documents.</p>';
        blocks.push(
          '<section class="portal">' +
          '<h2>' + esc(p.name) + ' <span class="kind">' + esc(p.slug) + ' &middot; ' + esc(p.kind) + '</span></h2>' +
          access + rows + '</section>'
        );
      }
      app.innerHTML = blocks.join("");
    } catch (e) {
      app.innerHTML = '<p class="empty err">Could not load: ' + esc(e.message) + '</p>';
    }
  }

  function flash(btn, msg) {
    const old = btn.textContent;
    btn.textContent = msg;
    btn.disabled = true;
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1200);
  }

  app.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button[data-action]");
    if (!btn) return;
    const a = btn.dataset.action;

    // Copy the absolute share link. The row already holds the correct path (/pub vs /v);
    // location.origin makes it absolute. No server round-trip, so no reload afterwards.
    if (a === "copy") {
      const url = location.origin + btn.dataset.href;
      try {
        await navigator.clipboard.writeText(url);
        flash(btn, "Copied");
      } catch {
        prompt("Copy this link:", url);
      }
      return;
    }

    try {
      if (a === "toggle") {
        await api("/api/docs/" + encodeURIComponent(btn.dataset.id),
          { method: "PATCH", body: JSON.stringify({ ownerOnly: btn.dataset.owneronly !== "1" }) });
      } else if (a === "delete") {
        if (!confirm('Delete "' + btn.dataset.title + '"? This cannot be undone.')) return;
        await api("/api/docs/" + encodeURIComponent(btn.dataset.id), { method: "DELETE" });
      } else if (a === "remove-member") {
        await api("/api/portals/" + encodeURIComponent(btn.dataset.portal),
          { method: "PATCH", body: JSON.stringify({ removeMembers: [btn.dataset.email] }) });
      } else if (a === "add-member") {
        const input = app.querySelector('input[data-portal="' + btn.dataset.portal + '"]');
        const email = input && input.value.trim();
        if (!email) return;
        await api("/api/portals/" + encodeURIComponent(btn.dataset.portal),
          { method: "PATCH", body: JSON.stringify({ addMembers: [email] }) });
      }
      await load();
    } catch (e) {
      alert("Failed: " + e.message);
    }
  });

  load();
</script>
</body>
</html>`;
}

import { canView, canViewPortal, emailsMatch } from "./access.js";
import type { ViewSurface } from "./analytics.js";
import { identify } from "./auth.js";
import { documentPath, portalPath } from "./documents.js";
import type { Env } from "./env.js";
import {
  type DocSummary,
  type Portal,
  getMembers,
  getMeta,
  getPortal,
  listDocs,
} from "./store.js";
import { log } from "./log.js";
import { renderShell } from "./viewer.js";

/**
 * `/v/{slug}` and `/v/{slug}/{id}` — the client-facing surface.
 *
 * Access app A sits in front of this path, so `identify()` always has a JWT to verify.
 * The Worker then answers the only question that matters: may *this* person see *this*.
 */
export async function handlePortalRoute(
  request: Request,
  env: Env,
  slug: string,
  id: string | null,
): Promise<Response> {
  const portal = await getPortal(env, slug);

  // A public portal's canonical home is /pub, which Access never sees. If someone reaches
  // it here they have already been through the login wall — but redirect anyway, so there
  // is one canonical URL and a mistakenly-shared /v link still lands in the right place.
  if (portal?.kind === "public") {
    const target = id === null ? portalPath(portal) : documentPath(portal, id);
    return Response.redirect(new URL(target, request.url).toString(), 302);
  }

  const identity = await identify(request, env, "docs");
  const email = identity?.email ?? null;

  // 🔴 Cloudflare Access let this request through, and we could not verify the JWT.
  //
  // That is not a visitor problem, it is a DEPLOYMENT problem — a wrong CF_ACCESS_AUD, a
  // wrong CF_TEAM_NAME, a Worker deployed against a different Access app. And it is
  // indistinguishable, from the outside, from "that portal doesn't exist": both are 404.
  //
  // The first real deploy of this Worker had exactly that bug (CF_TEAM_NAME carried the
  // full .cloudflareaccess.com domain, so the JWKS URL doubled it), and it presented as a
  // bare "Not found" with nothing to go on. Never again: it is impossible for an
  // unauthenticated request to reach this path unless the deployment is broken, so say so.
  if (email === null) {
    // `error`, not `warn`: this is a deployment fault, not a visitor fault, and it locks
    // out every user at once. It should be reachable via `wrangler tail --status error`.
    log("error", "jwt_verification_failed_behind_access", { request, slug });
    return misconfigured();
  }

  if (!portal) return notFound(env, email, slug);

  const members = await getMembers(env, slug);

  return id === null
    ? portalIndex(env, portal, members, email)
    : portalDocument(env, portal, members, email, id, "portal");
}

/**
 * `/pub/{slug}` and `/pub/{slug}/{id}` — the public tier.
 *
 * 🔴 This path has **no Cloudflare Access application in front of it**, and that is the
 * entire point.
 *
 * The first version of this served public portals from `/v/*`, which Access *does* cover.
 * The tests passed — Miniflare has no Access, so an unauthenticated request reached the
 * Worker and `canViewPortal` correctly returned true. In production it would have been a
 * disaster: an anonymous visitor to a public marketing page gets an OTP login wall, and if
 * they complete it they permanently consume one of the 50 free Access seats. For a page
 * that is deliberately public.
 *
 * The function was right. The deployment topology was wrong. That is a class of bug no
 * unit test can see, and it is why the route lives here, on its own path, rather than being
 * a `kind` check inside a protected one.
 */
export async function handlePublicPortalRoute(
  env: Env,
  slug: string,
  id: string | null,
): Promise<Response> {
  const portal = await getPortal(env, slug);

  // Only public portals are served here. A restricted portal reached through /pub is a
  // 404, not a redirect — a redirect would confirm that a client's portal exists.
  if (!portal || portal.kind !== "public") {
    // Both cases are the same 404 outside, and they are very different inside. A miss on a
    // slug that does not exist is noise; a miss on one that does means someone guessed a
    // real client's slug and tried the unauthenticated door. `exists` is the whole signal.
    log("warn", "blocked_public_portal_route", { portal: slug, exists: !!portal, doc: id });
    return notFound();
  }

  // No identify(), no members, no JWT. Nobody authenticates on this path, so nobody burns
  // a seat. That is an economic property of the route, not an afterthought.
  return id === null
    ? portalIndex(env, portal, [], null)
    : portalDocument(env, portal, [], null, id, "public");
}

async function portalIndex(
  env: Env,
  portal: Portal,
  members: string[],
  email: string | null,
): Promise<Response> {
  if (!canViewPortal(portal, members, email, env.OWNER_EMAIL)) {
    log("warn", "denied_portal_index", { portal: portal.slug, kind: portal.kind, email });
    return notFound();
  }

  const isOwner = email !== null && email === env.OWNER_EMAIL.trim().toLowerCase();

  // No reads. `ownerOnly` is the only per-document question the index has to answer, and
  // it lives in KV key metadata — see canViewPortal for why extraEmails is not consulted.
  const docs = (await listDocs(env, portal.slug))
    .filter((doc) => isOwner || !doc.ownerOnly)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return renderPortalPage(portal, docs, isOwner);
}

async function portalDocument(
  env: Env,
  portal: Portal,
  members: string[],
  email: string | null,
  id: string,
  surface: ViewSurface,
): Promise<Response> {
  const meta = await getMeta(env, id);
  if (!meta) return notFound();

  // 🔴 The document must actually live in the portal named in the URL.
  //
  // Without this, `/v/public-marketing/{a-private-doc-id}` would evaluate canView against
  // the PUBLIC portal and hand over a private client document. It is the cross-portal
  // leak in route form, and it is invisible in a unit test of canView() — which is
  // exactly why it gets its own test here.
  if (meta.portal !== portal.slug) {
    // 🔴 The loudest event this Worker emits. Someone asked for a document through a portal
    // that does not own it — the cross-portal leak in route form. It is a 404 either way,
    // but a *pattern* of these is someone walking ids across portals, and that is the one
    // thing that ends a consulting business. `error`, so it reaches
    // `wrangler tail --status error` without a filter.
    log("error", "denied_cross_portal_document", {
      portal: portal.slug,
      doc: meta.id,
      ownedBy: meta.portal,
      email,
    });
    return notFound();
  }

  if (!canView(meta, portal, members, email, env.OWNER_EMAIL)) {
    log("warn", "denied_document_view", {
      portal: portal.slug,
      doc: meta.id,
      ownerOnly: meta.ownerOnly,
      email,
    });
    return notFound();
  }

  return renderShell(env, meta, {
    email,
    backHref: portalPath(portal),
    backLabel: portal.name,
    // Everything is noindex for now, including public portals.
    //
    // A public portal is a deliberate act, so an argument exists for letting search engines
    // in — that is what would make the marketing-site plan work. But "the owner made this
    // public" and "the owner wants this in Google" are not the same statement, and the
    // costly mistake runs one way only. When the marketing site is actually built, this
    // becomes a per-portal flag rather than an assumption.
    noindex: true,
    // Share only on /pub/ — a public portal's URL opens for anyone. A /v/ document served
    // by this same handler is Access-gated, so its URL dead-ends for anyone not already in
    // the portal; no share affordance there. Keyed off kind, not noindex (they differ).
    shareable: portal.kind === "public",
    pdfEnabled: !!env.BROWSER,
    surface,
  });
}

/**
 * The page a client actually looks at.
 *
 * Deliberately plain. At n=1 client the bet is that the collection is useful to the
 * *owner* first — via the MCP read tools — not to the audience. This should not embarrass
 * anyone; it does not need to be a design project until a client has actually used it.
 *
 * **No PageVault branding above the fold.** The client is looking at your work, not at a
 * SaaS product.
 */
function renderPortalPage(portal: Portal, docs: DocSummary[], isOwner: boolean): Response {
  const months = groupByMonth(docs);

  const sections = months
    .map(
      ([month, entries]) => `
      <section>
        <h2>${esc(month)}</h2>
        <ul>
          ${entries.map((doc) => renderRow(portal, doc)).join("")}
        </ul>
      </section>`,
    )
    .join("");

  const empty = docs.length === 0 ? `<p class="empty">Nothing here yet.</p>` : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(portal.name)}</title>
<style>
  /* The neutral white/cool-grey + signal-blue system (#67). Tokens keep light/dark honest;
     no webfont, no logo — a portal is still the client's work, not our product, above the fold. */
  :root {
    color-scheme: light dark;
    --paper: #f5f6f8; --surface: #ffffff; --ink: #1a1d21; --muted: #5b6470;
    --accent: #2f6fed; --border: #e3e6ea; --hover: #eef1f5;
    --chip-bg: rgba(47,111,237,.10); --chip-fg: #2f6fed;
    --draft-bg: rgba(91,100,112,.12); --draft-fg: #5b6470;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #16181c; --surface: #20242a; --ink: #e6e8eb; --muted: #9aa3ad;
      --accent: #5b8cf5; --border: #2a2e35; --hover: #1e2228;
      --chip-bg: rgba(91,140,245,.16); --chip-fg: #8fb0f7;
      --draft-bg: rgba(154,163,173,.16); --draft-fg: #9aa3ad;
    }
  }
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.25rem 4rem;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: var(--ink); background: var(--paper);
  }
  .wrap { max-width: 44rem; margin: 0 auto; }
  h1 { font-size: 1.75rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  .desc { color: var(--muted); margin: 0 0 2rem; }
  .toolbar { display: flex; gap: .5rem; margin-bottom: 2rem; }
  .filter {
    flex: 1 1 auto; min-width: 0; padding: .6rem .75rem;
    border: 1px solid var(--border); border-radius: 6px; background: var(--surface);
    color: var(--ink); font: inherit; font-size: .9375rem;
  }
  .filter:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
  /* Refresh — reload to pick up documents published since the page opened. */
  .refresh {
    flex: 0 0 auto; margin-left: auto; display: inline-flex; align-items: center;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    color: var(--muted); padding: 0 .7rem; cursor: pointer;
  }
  .refresh:hover { color: var(--accent); border-color: var(--accent); }
  h2 {
    font-size: .75rem; text-transform: uppercase; letter-spacing: .08em;
    color: var(--muted); font-weight: 600;
    margin: 2rem 0 .5rem; padding-bottom: .4rem; border-bottom: 1px solid var(--border);
  }
  ul { list-style: none; margin: 0; padding: 0; }
  li { border-bottom: 1px solid var(--border); }
  li[hidden] { display: none; }
  .rowmain { display: flex; align-items: flex-start; gap: .5rem; }
  .rowmain:hover { background: var(--hover); }
  .rowlink { flex: 1 1 auto; min-width: 0; display: block; padding: .9rem 0 .25rem; text-decoration: none; color: inherit; }
  .title { font-weight: 600; color: var(--accent); }
  /* Document-type mark: a subtle cue, tinted with the muted ink so it never competes with the title. */
  .dicon { color: var(--muted); vertical-align: -2px; margin-right: .45rem; }
  .summary { display: block; color: var(--muted); font-size: .9375rem; margin-top: .1rem; }
  /* Share (copy link) — icon-only, quiet until hovered. */
  .share {
    flex: 0 0 auto; align-self: center; display: inline-flex; align-items: center;
    background: none; border: 1px solid var(--border); border-radius: 6px;
    color: var(--muted); padding: .35rem .45rem; cursor: pointer;
  }
  .share:hover { background: var(--surface); color: var(--accent); border-color: var(--accent); }
  /* Date + tags share one line, under the summary. */
  .row-meta {
    display: flex; align-items: center; flex-wrap: wrap; gap: .4rem;
    color: var(--muted); font-size: .8125rem; padding: 0 0 .9rem;
  }
  button.tag {
    padding: .1rem .45rem; background: var(--chip-bg); color: var(--chip-fg);
    border: 0; border-radius: 3px; font: inherit; font-size: .6875rem; font-weight: 600;
    letter-spacing: .04em; cursor: pointer;
  }
  button.tag:hover { text-decoration: underline; filter: brightness(1.06); }
  .draft {
    display: inline-block; margin-left: .4rem; padding: .05rem .4rem;
    background: var(--draft-bg); color: var(--draft-fg); border-radius: 3px;
    font-size: .6875rem; font-weight: 600; text-transform: uppercase;
  }
  .empty { color: var(--muted); }
  footer { margin-top: 4rem; color: var(--muted); font-size: .75rem; }
  footer a { color: var(--muted); }
  @media (max-width: 480px) { body { padding: 1.5rem 1rem 3rem; } h1 { font-size: 1.4rem; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(portal.name)}</h1>
  ${portal.description ? `<p class="desc">${esc(portal.description)}</p>` : ""}

  <div class="toolbar">
    ${docs.length > 0 ? `<input class="filter" id="filter" type="search" placeholder="Filter by title or tag" autocomplete="off">` : ""}
    <button type="button" class="refresh" id="refresh" title="Refresh" aria-label="Refresh">${ICON_REFRESH}</button>
  </div>
  ${empty}
  ${sections}

  <footer>Published with <a href="https://github.com/danjamk/pagevault">PageVault</a>.</footer>
</div>
<script>
  // Client-side, because the corpus is small — fourteen documents, not fourteen thousand.
  // No index, no service, no request.
  const input = document.getElementById("filter");
  const CHECK = ${JSON.stringify(ICON_CHECK)};

  function applyFilter() {
    const q = (input ? input.value : "").trim().toLowerCase();
    for (const li of document.querySelectorAll("li")) {
      li.hidden = q !== "" && !li.dataset.search.includes(q);
    }
    for (const section of document.querySelectorAll("section")) {
      section.hidden = [...section.querySelectorAll("li")].every((li) => li.hidden);
    }
  }
  if (input) input.addEventListener("input", applyFilter);

  document.addEventListener("click", (e) => {
    // A tag click filters by that tag — dropped into the search box so it's visible and clearable.
    const tag = e.target.closest(".tag");
    if (tag && input) {
      e.preventDefault();
      input.value = tag.dataset.tag;
      applyFilter();
      input.focus();
      return;
    }
    // A share click copies the document's absolute link. Clipboard needs no network — no connect-src.
    const share = e.target.closest(".share");
    if (share) {
      e.preventDefault();
      const url = new URL(share.dataset.share, location.origin).href;
      const flash = () => { const o = share.innerHTML; share.innerHTML = CHECK; setTimeout(() => { share.innerHTML = o; }, 1200); };
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(flash, () => prompt("Copy this link:", url));
      else prompt("Copy this link:", url);
      return;
    }
    // Refresh — reload to pick up documents published since the page opened.
    if (e.target.closest(".refresh")) location.reload();
  });
</script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // The index names a client and lists their deliverables. It is never cacheable and
      // never indexable, regardless of portal kind.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "script-src 'unsafe-inline'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join("; "),
    },
  });
}

function renderRow(portal: Portal, doc: DocSummary): string {
  // One helper, so a public portal can never emit a /v/ link — which would walk the reader
  // into an Access login wall and burn a seat on a page that is deliberately public.
  const href = documentPath(portal, doc.id);
  const date = doc.createdAt.slice(0, 10);
  const tagList = doc.tags ?? [];
  // Tags are buttons, not spans: clicking one filters by it (the handler drops it into the search
  // box). They sit OUTSIDE the row's <a>, so a tag click filters instead of opening the document.
  const tags = tagList
    .map((tag) => `<button type="button" class="tag" data-tag="${esc(tag)}">${esc(tag)}</button>`)
    .join("");
  const draft = doc.ownerOnly ? `<span class="draft">draft</span>` : "";
  const search = esc([doc.title, doc.summary ?? "", ...tagList].join(" ").toLowerCase());

  return `<li data-search="${search}">
    <div class="rowmain">
      <a class="rowlink" href="${esc(href)}">
        <span class="title">${typeIcon(doc.sourceKind)}${esc(doc.title)}</span>${draft}
        ${doc.summary ? `<span class="summary">${esc(doc.summary)}</span>` : ""}
      </a>
      <button type="button" class="share" data-share="${esc(href)}" title="Copy link" aria-label="Copy link">${ICON_SHARE}</button>
    </div>
    <div class="row-meta">
      <span class="date">${esc(date)}</span>${tags}
    </div>
  </li>`;
}

/**
 * Document-type marks and the share glyph for the client portal. Inline SVG (no sprite, no
 * webfont — the portal stays the client's work, not our product): a Markdown doc gets the
 * Markdown mark, everything else the `</>` glyph. `currentColor` so they inherit `.dicon`.
 */
const ICON_MD =
  `<svg class="dicon" width="15" height="10" viewBox="0 0 208 128" aria-hidden="true">` +
  `<rect width="198" height="118" x="5" y="5" ry="10" fill="none" stroke="currentColor" stroke-width="12"/>` +
  `<path fill="currentColor" d="M30 98V30h20l20 25 20-25h20v68H90V59L70 84 50 59v39zm125 0l-30-33h20V30h20v35h20z"/></svg>`;
const ICON_HTML =
  `<svg class="dicon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/></svg>`;
const ICON_SHARE =
  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="2.6"/>` +
  `<circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.3 10.8l7.4-4.5M8.3 13.2l7.4 4.5"/></svg>`;
const ICON_CHECK =
  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12l5 5L20 6"/></svg>`;
const ICON_REFRESH =
  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5"/></svg>`;
const typeIcon = (kind?: string): string => (kind === "markdown" ? ICON_MD : ICON_HTML);

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Newest first, grouped by month. The engagement, in order. */
function groupByMonth(docs: DocSummary[]): [string, DocSummary[]][] {
  const groups = new Map<string, DocSummary[]>();

  for (const doc of docs) {
    const date = new Date(doc.createdAt);
    const label = `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
    const bucket = groups.get(label);
    if (bucket) bucket.push(doc);
    else groups.set(label, [doc]);
  }

  return [...groups.entries()];
}

/**
 * 404 — but tell the OWNER what is actually going on.
 *
 * A stranger gets a bare 404, deliberately: a 403, or a "no such portal" message, would
 * confirm whether a client's portal exists. The owner already knows everything there is to
 * know, so leaving them to guess buys no security and costs them an afternoon.
 */
function notFound(env?: Env, email?: string | null, slug?: string): Response {
  const isOwner = env && email && emailsMatch(email, env.OWNER_EMAIL);

  if (!isOwner || !slug) return new Response("Not found", { status: 404 });

  return page(
    404,
    "No such portal",
    `There is no portal named <code>${esc(slug)}</code> on this deployment.`,
    `Create one, and publish something into it:
<pre>curl -X POST https://${esc(env.PUBLIC_HOST || "your-host")}/api/portals \\
  -H "Authorization: Bearer $PAGEVAULT_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"slug":"${esc(slug)}","name":"${esc(slug)}","kind":"restricted"}'</pre>
Or ask Claude to do it, if the MCP server is connected.`,
  );
}

/**
 * The deployment is broken, and only the operator can fix it. Say which knob.
 *
 * Reaching this means Cloudflare Access authenticated someone and the Worker could not
 * verify the resulting JWT. There is no visitor-side cause for that.
 */
const misconfigured = (): Response =>
  page(
    500,
    "PageVault is misconfigured",
    "Cloudflare Access authenticated you, but this Worker could not verify the token it issued.",
    `Almost always one of:
<ul>
  <li><code>CF_TEAM_NAME</code> — should be the team slug, e.g. <code>acme</code>. If it
      carries the full <code>.cloudflareaccess.com</code> domain the JWKS URL doubles it and
      every verification fails. (Recent builds tolerate both.)</li>
  <li><code>CF_ACCESS_AUD_DOCS</code> — must be the Audience tag of the Access application
      covering <code>/v</code>, not the one covering <code>/admin</code>.</li>
  <li>The Worker was deployed before the Access apps were created.</li>
</ul>
Run <code>make provision</code> then <code>make deploy</code>. <code>make logs</code> shows
the failure as <code>jwt_verification_failed_behind_access</code>.`,
  );

/** A plain, honest error page. No branding, no cleverness. */
function page(status: number, title: string, lead: string, detail: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { margin:0; padding:3rem 1.25rem; font:16px/1.6 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;
         color:#1e1610; background:#fbf6ec; }
  .wrap { max-width:40rem; margin:0 auto; }
  h1 { font-size:1.5rem; margin:0 0 .5rem; }
  .lead { color:#4a3a28; }
  code { background:#f0ece0; padding:.1rem .3rem; border-radius:3px; font-size:.9em; }
  pre { background:#1e1610; color:#f4ebd6; padding:1rem; border-radius:6px; overflow-x:auto;
        font-size:.8125rem; line-height:1.5; }
  pre code { background:none; padding:0; color:inherit; }
  ul { padding-left:1.2rem; } li { margin:.4rem 0; }
</style></head><body><div class="wrap">
<h1>${esc(title)}</h1>
<p class="lead">${lead}</p>
${detail}
</div></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    },
  );
}

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

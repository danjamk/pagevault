import { canView, canViewPortal, emailsMatch } from "./access.js";
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
import { logBlocked, renderShell } from "./viewer.js";

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
    logBlocked("jwt_verification_failed_behind_access", request, { slug });
    return misconfigured();
  }

  if (!portal) return notFound(env, email, slug);

  const members = await getMembers(env, slug);

  return id === null
    ? portalIndex(env, portal, members, email)
    : portalDocument(env, portal, members, email, id);
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
  if (!portal || portal.kind !== "public") return notFound();

  // No identify(), no members, no JWT. Nobody authenticates on this path, so nobody burns
  // a seat. That is an economic property of the route, not an afterthought.
  return id === null
    ? portalIndex(env, portal, [], null)
    : portalDocument(env, portal, [], null, id);
}

async function portalIndex(
  env: Env,
  portal: Portal,
  members: string[],
  email: string | null,
): Promise<Response> {
  if (!canViewPortal(portal, members, email, env.OWNER_EMAIL)) return notFound();

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
): Promise<Response> {
  const meta = await getMeta(env, id);
  if (!meta) return notFound();

  // 🔴 The document must actually live in the portal named in the URL.
  //
  // Without this, `/v/public-marketing/{a-private-doc-id}` would evaluate canView against
  // the PUBLIC portal and hand over a private client document. It is the cross-portal
  // leak in route form, and it is invisible in a unit test of canView() — which is
  // exactly why it gets its own test here.
  if (meta.portal !== portal.slug) return notFound();

  if (!canView(meta, portal, members, email, env.OWNER_EMAIL)) return notFound();

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
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.25rem 4rem;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #1e1610; background: #fbf6ec;
  }
  .wrap { max-width: 44rem; margin: 0 auto; }
  h1 { font-size: 1.75rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  .desc { color: #4a3a28; margin: 0 0 2rem; }
  .filter {
    width: 100%; padding: .6rem .75rem; margin-bottom: 2rem;
    border: 1px solid #d8cdb0; border-radius: 4px; background: #fff;
    font: inherit; font-size: .9375rem;
  }
  h2 {
    font-size: .75rem; text-transform: uppercase; letter-spacing: .08em;
    color: #7d6b52; font-weight: 600;
    margin: 2rem 0 .5rem; padding-bottom: .4rem; border-bottom: 1px solid #e5decb;
  }
  ul { list-style: none; margin: 0; padding: 0; }
  li { border-bottom: 1px solid #e5decb; }
  li a { display: block; padding: .9rem 0; text-decoration: none; color: inherit; }
  li a:hover { background: #f0ece0; }
  .title { font-weight: 600; color: #34507a; }
  .summary { color: #4a3a28; font-size: .9375rem; }
  .row-meta { color: #7d6b52; font-size: .8125rem; margin-top: .15rem; }
  .tag {
    display: inline-block; margin-left: .4rem; padding: .05rem .4rem;
    background: rgba(52,80,122,.11); color: #34507a; border-radius: 3px;
    font-size: .6875rem; font-weight: 600; letter-spacing: .04em;
  }
  .draft {
    display: inline-block; margin-left: .4rem; padding: .05rem .4rem;
    background: rgba(186,117,23,.12); color: #854f0b; border-radius: 3px;
    font-size: .6875rem; font-weight: 600; text-transform: uppercase;
  }
  .empty { color: #7d6b52; }
  footer { margin-top: 4rem; color: #7d6b52; font-size: .75rem; }
  footer a { color: #7d6b52; }
  @media (max-width: 480px) { body { padding: 1.5rem 1rem 3rem; } h1 { font-size: 1.4rem; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(portal.name)}</h1>
  ${portal.description ? `<p class="desc">${esc(portal.description)}</p>` : ""}

  ${docs.length > 2 ? `<input class="filter" id="filter" type="search" placeholder="Filter by title or tag" autocomplete="off">` : ""}
  ${empty}
  ${sections}

  <footer>Published with <a href="https://github.com/danjamk/pagevault">PageVault</a>.</footer>
</div>
<script>
  // Client-side, because the corpus is small — fourteen documents, not fourteen thousand.
  // No index, no service, no request.
  const input = document.getElementById("filter");
  if (input) {
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      for (const li of document.querySelectorAll("li")) {
        li.hidden = q !== "" && !li.dataset.search.includes(q);
      }
      for (const section of document.querySelectorAll("section")) {
        section.hidden = [...section.querySelectorAll("li")].every((li) => li.hidden);
      }
    });
  }
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
  const tags = (doc.tags ?? []).map((tag) => `<span class="tag">${esc(tag)}</span>`).join("");
  const draft = doc.ownerOnly ? `<span class="draft">draft</span>` : "";
  const search = esc([doc.title, doc.summary ?? "", ...(doc.tags ?? [])].join(" ").toLowerCase());

  return `<li data-search="${search}">
    <a href="${esc(href)}">
      <span class="title">${esc(doc.title)}</span>${draft}${tags}
      ${doc.summary ? `<div class="summary">${esc(doc.summary)}</div>` : ""}
      <div class="row-meta">${esc(date)}</div>
    </a>
  </li>`;
}

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

import { canView, canViewPortal } from "./access.js";
import { identify } from "./auth.js";
import type { Env } from "./env.js";
import {
  type DocSummary,
  type Portal,
  getMembers,
  getMeta,
  getPortal,
  listDocs,
} from "./store.js";
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
  const identity = await identify(request, env, "docs");
  const email = identity?.email ?? null;

  const portal = await getPortal(env, slug);
  if (!portal) return notFound();

  const members = await getMembers(env, slug);

  return id === null
    ? portalIndex(env, portal, members, email)
    : portalDocument(env, portal, members, email, id);
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
    backHref: `/v/${encodeURIComponent(portal.slug)}`,
    backLabel: portal.name,
    // Restricted and private portals are behind Access anyway; a public portal is not,
    // and its documents are only as private as a search engine allows.
    noindex: portal.kind !== "public",
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
  const href = `/v/${encodeURIComponent(portal.slug)}/${encodeURIComponent(doc.id)}`;
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

const notFound = () => new Response("Not found", { status: 404 });

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

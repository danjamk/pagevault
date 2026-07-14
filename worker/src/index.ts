import { handleApi, json } from "./api.js";
import type { Env } from "./env.js";
import { getMeta, getPublicTokenTarget } from "./store.js";
import { handleRender, renderShell } from "./viewer.js";

/**
 * PageVault — the router.
 *
 * Cloudflare Access answers "who are you?". This Worker answers "may you see this?" —
 * in exactly one function, `canView()`. The route-to-Access-app mapping is load-bearing:
 * read ADR-001 before changing it.
 *
 * Which paths have an Access application in front of them, and which do not, is a
 * security property of the deployment, not a detail:
 *
 *   /v/*      App A     portal + document   (#13)
 *   /admin    App B     owner console       (#5)
 *   /render   none      capability token only
 *   /p/*      none      capability URL, zero Access seats burned
 *   /api/*    none      bearer token
 *   /mcp      none      bearer token, and it CANNOT be Access-covered (ADR-006)
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // An Access app at `/` would cover the entire host, so the console cannot live
    // there. `/` is an unauthenticated redirect. See ADR-001.
    if (pathname === "/") {
      return Response.redirect(new URL("/admin", url).toString(), 302);
    }

    if (pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }

    // Artifact bytes. Framed by the shell, never navigated to. The capability token is
    // the only thing gating it — there is no Access app here, deliberately: an Access
    // login redirect inside a sandboxed iframe is a broken experience. See ADR-007.
    const render = /^\/render\/([^/]+)$/.exec(pathname);
    if (render?.[1]) {
      return handleRender(request, env, render[1]);
    }

    // A capability URL. No auth, no Access app, and therefore ZERO Access seats burned —
    // this is the escape valve that keeps the 50-seat free tier viable. Unguessable is
    // not private, and the UI says so at publish time.
    const pub = /^\/p\/([^/]+)$/.exec(pathname);
    if (pub?.[1]) {
      return handlePublicToken(env, pub[1]);
    }

    // Access app A. Portal index and documents, gated by canView. (#13)
    if (pathname.startsWith("/v/")) {
      return notImplemented("portal");
    }

    // Access app B. Owner only. (#5)
    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      return notImplemented("admin");
    }

    return json({ error: "Not found", code: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;

/**
 * `/p/{token}` — the single-document capability link.
 *
 * This route deliberately does **not** consult `canView`. Widening lives on a separate
 * route from inheritance, so that a bug in one cannot become a bug in the other
 * (ADR-005, invariant 4). Holding the token is the authorization.
 *
 * The artifact still goes through the shell and the sandbox. **Public does not mean
 * unsandboxed** — a public artifact is more exposed, not less.
 */
async function handlePublicToken(env: Env, token: string): Promise<Response> {
  const id = await getPublicTokenTarget(env, token);
  if (!id) return notFound();

  const meta = await getMeta(env, id);
  if (!meta) return notFound();

  // A rotated or revoked token is dead the moment the pub: key is deleted. But a doc
  // whose token was rotated may still have a *different* live token, so check that this
  // is the current one rather than trusting the lookup alone.
  if (meta.publicToken !== token) return notFound();

  // ownerOnly is the one narrowing rule and it beats every grant, including this one.
  // A draft must not be readable just because a link was minted before it was marked.
  if (meta.ownerOnly) return notFound();

  return renderShell(env, meta, { email: null, noindex: true });
}

const notFound = () => new Response("Not found", { status: 404 });

function notImplemented(surface: string): Response {
  return json({ error: `Not implemented: ${surface}`, code: "not_implemented" }, 501);
}

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { handleApi, json } from "./api.js";
import { isAuthorized } from "./auth.js";
import { handleConsole } from "./console.js";
import type { Env } from "./env.js";
import { handleMcp, mcpApiHandler } from "./mcp.js";
import { handleAuthorize } from "./oauth.js";
import { rootLanding } from "./pages.js";
import { handlePortalRoute, handlePublicPortalRoute } from "./portal.js";
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
 *   /mcp      none      bearer (Claude Code) OR OAuth 2.1 (hosted surfaces); CANNOT be Access-covered (ADR-006)
 *   /authorize none     OAuth consent (operator) — app-implemented, see oauth.ts
 *
 * As of #22 this router is the OAuthProvider's `defaultHandler`: it receives every request
 * that is not the MCP apiRoute (`/mcp`) or an OAuth endpoint (`/token`, `/register`, the
 * `.well-known` metadata) — including `/authorize`, which the provider routes here to serve.
 */
const router = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Version, machine-readable and unauthenticated: what code this deployment is running
    // (<version>+<sha>, ADR-010) and when it shipped. Lets `make verify` and CI (#38) answer
    // "am I up to date?". No secrets here — the source is public — so there's nothing to gate.
    //
    // I keep this shallow on purpose: it reports the build, it does NOT probe KV or any binding.
    // The endpoint is public, so a KV read on every hit would hand anyone on the internet a way to
    // burn the free-tier KV read quota (100k/day) — the one resource the product runs on. This is
    // a build report, not a liveness probe, and that shallowness is the point.
    if (pathname === "/health") {
      return json({
        name: "pagevault",
        version: env.PAGEVAULT_VERSION || "unknown",
        deployedAt: env.PAGEVAULT_DEPLOYED_AT || null,
      });
    }

    // The OAuth consent screen (ADR-006 / #22). `authorizeEndpoint` is app-implemented — the
    // OAuthProvider routes it here rather than serving it. See oauth.ts. `/mcp` itself never
    // reaches this router: the OAuthProvider owns it (a bearer request is intercepted in the
    // default export before OAuth; an OAuth-token request goes to mcpApiHandler).
    if (pathname === "/authorize") {
      return handleAuthorize(request, env);
    }

    // An Access app at `/` would cover the entire host, so the console cannot live there;
    // `/` reaches the Worker unauthenticated, with no Access app (ADR-001). What it serves
    // depends on whether Access is provisioned: with a console to reach (rung 3), redirect to
    // it; without one (rung 1/2), /admin is a dead Forbidden — serve a quiet landing instead,
    // so the bare host isn't PageVault's worst page. CF_ACCESS_AUD_ADMIN is set only at rung 3.
    if (pathname === "/") {
      return env.CF_ACCESS_AUD_ADMIN
        ? Response.redirect(new URL("/admin", url).toString(), 302)
        : rootLanding();
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

    // 🔴 The public tier. NO Access application, deliberately — an anonymous reader must
    // never hit a login wall, and must never burn one of the 50 free Access seats on a page
    // that is public by design. See portal.ts.
    const pubPortal = /^\/pub\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname);
    if (pubPortal?.[1]) {
      return handlePublicPortalRoute(env, pubPortal[1], pubPortal[2] ?? null);
    }

    // Access app A. Portal index and documents, gated by canView.
    const portal = /^\/v\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname);
    if (portal?.[1]) {
      return handlePortalRoute(request, env, portal[1], portal[2] ?? null);
    }

    // Access app B. Owner only. (#5)
    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      return handleConsole(request, env);
    }

    return json({ error: "Not found", code: "not_found" }, 404);
  },
};

/**
 * OAuth 2.1 for the hosted surfaces — claude.ai, Desktop, mobile, Cowork (ADR-006 / #22).
 *
 * The provider serves `/token`, `/register`, and the `.well-known` metadata; it routes `/mcp`
 * (only with a token it issued) to `mcpApiHandler`, and everything else to the router.
 * Constructed at module scope — it takes no env, so nothing secret lives here.
 */
const oauth = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,
  defaultHandler: router,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 🔴 Preserve the Claude Code path. The static PAGEVAULT_API_TOKEN bearer is NOT an
    // OAuth-issued token, so the OAuthProvider would 401 it — killing the one surface that
    // works today. Intercept it here, before OAuth ever sees it, and hand it to the existing
    // bearer-gated handler. `isAuthorized` is the same timing-safe compare the `/mcp` route
    // has always used; nothing else about this shortcut is trusted. See ADR-006's staged auth.
    const { pathname } = new URL(request.url);
    if (pathname === "/mcp" && isAuthorized(request, env)) {
      return handleMcp(request, env, ctx);
    }

    return oauth.fetch(request, env, ctx);
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

  // A /p/ capability link is self-authorizing — anyone with the URL can open it — so the
  // share control belongs here.
  return renderShell(env, meta, { email: null, noindex: true, shareable: true, pdfEnabled: !!env.BROWSER });
}

const notFound = () => new Response("Not found", { status: 404 });

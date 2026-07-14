import { handleApi, json } from "./api.js";
import type { Env } from "./env.js";

/**
 * PageVault — the router.
 *
 * Access answers "who are you?". This Worker answers "are you allowed to see this
 * specific document?". Read docs/architecture.md before changing routing; the
 * route-to-Access-app mapping is load-bearing and is recorded in ADR-001.
 *
 * Phase 0: skeleton only. Every route below is filled in by issues #2–#6.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // `/` is not an Access-protected route — an Access app at `/` would cover the
    // entire host. The console lives at /admin. See ADR-001.
    if (pathname === "/") {
      return Response.redirect(new URL("/admin", url).toString(), 302);
    }

    // Bearer-authenticated. No Access app in front of this path — this Worker is the
    // only thing guarding it. See ADR-001.
    if (pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }

    // Access app A. JWT verified here, then checked against the doc's allowlist. (#4)
    if (pathname.startsWith("/d/")) {
      return notImplemented("docs");
    }

    // No Access app. Capability URL. Costs zero Access seats. (#3)
    if (pathname.startsWith("/p/")) {
      return notImplemented("public");
    }

    // Access app B. Owner only. (#5, #6)
    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      return notImplemented("admin");
    }

    return json({ error: "Not found", code: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;

function notImplemented(surface: string): Response {
  return json({ error: `Not implemented: ${surface}`, code: "not_implemented" }, 501);
}
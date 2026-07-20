import type { AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { identify, timingSafeEqual } from "./auth.js";
import type { Env } from "./env.js";
import { normalizeEmail } from "./store.js";

/**
 * `/admin/authorize` — the OAuth consent screen (ADR-006 / #22, ADR-012).
 *
 * `authorizeEndpoint` is app-implemented: the OAuthProvider routes the request here rather
 * than serving it. We prove the visitor is the operator, then complete the grant — after which
 * the provider mints the code and redirects back to the client (claude.ai).
 *
 * Two ways to prove the operator, by tier (ADR-012):
 *
 *   Tier 3 (Access) — the consent lives at `/admin/authorize`, behind the `pagevault-owner`
 *     Access app, so the operator has already logged in as themselves. We verify that JWT and
 *     grant as the real identity. No token is typed into a form. This is the production path.
 *
 *   Tier 0/1 (no Access) — there is no login to gate consent with, so the operator proves
 *     themselves by pasting the PAGEVAULT_API_TOKEN. Spike-grade, and fine for a single-operator
 *     quickstart deployment; it is never the path a Tier-3 (prod) deployment takes.
 */
export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const provider = env.OAUTH_PROVIDER;
  if (!provider) {
    // Reaching /admin/authorize without the provider in front is a deployment error, not a
    // visitor error: the OAuthProvider is the only thing that routes here.
    return new Response("OAuth is not configured on this deployment.", { status: 500 });
  }

  const oauthReq = await provider.parseAuthRequest(request);
  const client = await provider.lookupClient(oauthReq.clientId);

  // --- Tier 3: Cloudflare Access is the IdP (ADR-012) ------------------------
  if (env.CF_ACCESS_AUD_ADMIN) {
    const owner = normalizeEmail(env.OWNER_EMAIL ?? "");
    const identity = await identify(request, env, "admin");
    // Access fronts this route — but ADR-004 says verify the JWT, never trust the gate. A
    // request that isn't the owner's is a 403 here, not a silent fall-through to the token form.
    if (!identity || !owner || identity.email !== owner) {
      return new Response("Not authorized — sign in as the owner.", { status: 403 });
    }
    if (request.method === "POST") {
      return completeGrant(provider, oauthReq, identity.email);
    }
    return consentPage(request, oauthReq, client, null, identity.email);
  }

  // --- Tier 0/1: no Access, prove the operator by the API token (spike-grade) -
  if (request.method === "POST") {
    const form = await request.formData();
    const token = form.get("token");
    if (typeof token === "string" && timingSafeEqual(token, env.PAGEVAULT_API_TOKEN)) {
      return completeGrant(provider, oauthReq, env.OWNER_EMAIL);
    }
    return consentPage(request, oauthReq, client, "That token didn't match. Try again.", null);
  }

  return consentPage(request, oauthReq, client, null, null);
}

/**
 * Complete the grant and send the operator back to the client's callback.
 *
 * 303, not 302: this redirect follows a form POST, and the client's callback
 * (claude.ai/api/mcp/auth_callback) expects a GET. 302 leaves the method ambiguous — some
 * browsers re-POST to the callback, which never completes the token exchange. 303 See Other
 * forces the GET. See #22 spike.
 */
async function completeGrant(provider: OAuthHelpers, oauthReq: AuthRequest, email: string): Promise<Response> {
  const { redirectTo } = await provider.completeAuthorization({
    request: oauthReq,
    // Opaque grant-owner id — single operator. NOT the email: the library embeds userId in the
    // authorization code, so an address there is a needless disclosure and an odd value for a
    // client to round-trip. Tool-facing identity travels in props instead.
    userId: "operator",
    metadata: { label: "operator" },
    scope: oauthReq.scope,
    props: { email },
  });
  return Response.redirect(redirectTo, 303);
}

/**
 * The consent form. Posts back to the same URL so the pending auth request (carried in the
 * query string) is preserved.
 *
 * `operator` set → the visitor is already authenticated (Tier 3, Access): a tokenless "Authorize"
 * button. `operator` null → the paste-token fallback (Tier 0/1), where the token travels in the
 * POST body, never the URL.
 */
function consentPage(
  request: Request,
  oauthReq: AuthRequest,
  client: ClientInfo | null,
  error: string | null,
  operator: string | null,
): Response {
  const clientName = esc(client?.clientName || oauthReq.clientId);
  const scopes = oauthReq.scope.length ? esc(oauthReq.scope.join(", ")) : "(none requested)";
  const action = esc(request.url);

  const inner = operator
    ? `  <p class="lead">Signed in as <span class="client">${esc(operator)}</span>.</p>
  <div class="row">Allow <span class="client">${clientName}</span> to connect to your PageVault MCP server?</div>
  <div class="row">Scopes requested: ${scopes}</div>
  <form method="POST" action="${action}">
    <button type="submit">Authorize</button>
  </form>`
    : `  <p class="lead"><span class="client">${clientName}</span> is asking to connect to your
     PageVault MCP server.</p>
  <div class="row">Scopes requested: ${scopes}</div>
  <form method="POST" action="${action}">
    <label for="token">Paste your PAGEVAULT_API_TOKEN to approve</label>
    <input id="token" name="token" type="password" autocomplete="off" autofocus required>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    <button type="submit">Authorize</button>
  </form>
  <p class="note">Spike-grade approval. A deployment with Cloudflare Access authenticates you
     through it instead of a pasted token.</p>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize — PageVault MCP</title>
<style>
  body { margin:0; padding:3rem 1.25rem; background:#fbf6ec; color:#1e1610;
         font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  .wrap { max-width:26rem; margin:0 auto; }
  h1 { font-size:1.35rem; margin:0 0 .25rem; }
  .lead { color:#4a3a28; margin:0 0 1.5rem; }
  .client { font-weight:600; color:#34507a; }
  .row { font-size:.875rem; color:#7d6b52; margin:.25rem 0; }
  form { margin-top:1.5rem; display:flex; flex-direction:column; gap:.6rem; }
  label { font-size:.8125rem; font-weight:600; color:#4a3a28; }
  input { padding:.6rem .75rem; border:1px solid #d8cdb0; border-radius:4px;
          background:#fff; font:inherit; }
  button { padding:.6rem .75rem; border:0; border-radius:4px; background:#34507a;
           color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  .err { color:#a11; font-size:.875rem; margin-top:.5rem; }
  .note { margin-top:1.5rem; font-size:.75rem; color:#7d6b52; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Authorize MCP access</h1>
${inner}
</div>
</body>
</html>`;

  return new Response(html, {
    status: error ? 401 : 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      // 🔴 Deliberately NO `form-action`. Browsers enforce form-action against the *redirect* a
      // submission follows, not just the form's action. This form posts to /admin/authorize, which
      // 303s to the client's callback (claude.ai/api/mcp/auth_callback) — a different origin.
      // `form-action 'self'` would silently block that navigation and the OAuth flow dies with no
      // error, frozen on this page. Do not add it back. The redirect target is already constrained:
      // the OAuthProvider only ever redirects to a registered redirect_uri. See #22 spike.
      "Content-Security-Policy": [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join("; "),
    },
  });
}

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

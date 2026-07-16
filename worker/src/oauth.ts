import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import { timingSafeEqual } from "./auth.js";
import type { Env } from "./env.js";

/**
 * `/authorize` — the OAuth consent screen (ADR-006 / #22).
 *
 * `authorizeEndpoint` is app-implemented: the OAuthProvider routes the request here rather
 * than serving it. We parse the pending auth request, prove the visitor is the operator,
 * and complete the grant — after which the provider mints the code and redirects back to
 * the client (claude.ai).
 *
 * 🔴 SPIKE-GRADE OPERATOR CHECK. The operator proves themselves by pasting the
 * PAGEVAULT_API_TOKEN. That is deliberately minimal — enough that a random visitor to
 * `/authorize` cannot mint a token for your MCP server — but it is NOT the production
 * login. The full build (#22, task 3) puts Cloudflare Access in front of this so the
 * operator logs in as themselves and the token is never typed into a form. Do not ship
 * this consent screen as-is.
 */
export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const provider = env.OAUTH_PROVIDER;
  if (!provider) {
    // Reaching /authorize without the provider in front is a deployment error, not a
    // visitor error: the OAuthProvider is the only thing that routes here.
    return new Response("OAuth is not configured on this deployment.", { status: 500 });
  }

  const oauthReq = await provider.parseAuthRequest(request);
  const client = await provider.lookupClient(oauthReq.clientId);

  if (request.method === "POST") {
    const form = await request.formData();
    const token = form.get("token");
    if (typeof token === "string" && timingSafeEqual(token, env.PAGEVAULT_API_TOKEN)) {
      const { redirectTo } = await provider.completeAuthorization({
        request: oauthReq,
        // Opaque grant-owner id — single operator. NOT the email: the library embeds userId
        // in the authorization code, so an address there is a needless disclosure and an odd
        // value for a client to round-trip. Tool-facing identity travels in props instead.
        userId: "operator",
        metadata: { label: "operator" },
        scope: oauthReq.scope,
        props: { email: env.OWNER_EMAIL },
      });
      // 303, not 302: this redirect follows a form POST, and the client's callback
      // (claude.ai/api/mcp/auth_callback) expects a GET. 302 leaves the method ambiguous —
      // some browsers re-POST to the callback, which never completes the token exchange.
      // 303 See Other forces the GET. See #22 spike.
      return Response.redirect(redirectTo, 303);
    }
    return consentPage(request, oauthReq, client, "That token didn't match. Try again.");
  }

  return consentPage(request, oauthReq, client, null);
}

/**
 * The consent form. Posts back to the same URL so the pending auth request (carried in the
 * query string) is preserved; the token travels in the POST body, never the URL.
 */
function consentPage(
  request: Request,
  oauthReq: AuthRequest,
  client: ClientInfo | null,
  error: string | null,
): Response {
  const clientName = esc(client?.clientName || oauthReq.clientId);
  const scopes = oauthReq.scope.length ? esc(oauthReq.scope.join(", ")) : "(none requested)";
  const action = esc(request.url);

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
  <p class="lead"><span class="client">${clientName}</span> is asking to connect to your
     PageVault MCP server.</p>
  <div class="row">Scopes requested: ${scopes}</div>
  <form method="POST" action="${action}">
    <label for="token">Paste your PAGEVAULT_API_TOKEN to approve</label>
    <input id="token" name="token" type="password" autocomplete="off" autofocus required>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    <button type="submit">Authorize</button>
  </form>
  <p class="note">Spike-grade approval. The full build authenticates you through
     Cloudflare Access instead of a pasted token.</p>
</div>
</body>
</html>`;

  return new Response(html, {
    status: error ? 401 : 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      // 🔴 Deliberately NO `form-action`. Browsers enforce form-action against the
      // *redirect* a submission follows, not just the form's action. This form posts to
      // /authorize, which 303s to the client's callback (claude.ai/api/mcp/auth_callback) —
      // a different origin. `form-action 'self'` would silently block that navigation and
      // the OAuth flow dies with no error, frozen on this page. Do not add it back. The
      // redirect target is already constrained: the OAuthProvider only ever redirects to a
      // registered redirect_uri. See #22 spike.
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

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  PAGEVAULT: KVNamespace;

  /**
   * KV owned entirely by the OAuth provider (ADR-006 / #22) — issued tokens, grants, and
   * client registrations. Separate from PAGEVAULT so the library's key space can never
   * collide with ours. Create with `wrangler kv namespace create OAUTH_KV`.
   */
  OAUTH_KV: KVNamespace;

  /**
   * Injected at runtime by @cloudflare/workers-oauth-provider before it invokes the api or
   * default handler — the only way to parse a pending auth request and complete a grant. Not
   * a binding you configure; a per-request handle. Optional because it is absent anywhere the
   * OAuthProvider is not in front (e.g. tests, and the bearer `/mcp` shortcut).
   */
  OAUTH_PROVIDER?: OAuthHelpers;

  /**
   * The code this Worker was built from: `<version>+<shortsha>` (ADR-010). Baked at deploy
   * from package.json + git, so the deployment can report exactly what it's running — via
   * `/health`, the MCP `serverInfo`, and the console footer. Absent on a hand-run dev build.
   */
  PAGEVAULT_VERSION?: string;

  /**
   * When this Worker was deployed (ISO 8601), baked alongside PAGEVAULT_VERSION at deploy. The
   * console footer shows the date so the operator can tell how fresh the running code is. Absent
   * on a hand-run dev build.
   */
  PAGEVAULT_DEPLOYED_AT?: string;

  /** Vars — plaintext, written into wrangler.jsonc by the provisioning script. */
  OWNER_EMAIL: string;
  CF_TEAM_NAME: string;
  PUBLIC_HOST: string;

  /**
   * One AUD per Access application. Deliberately two vars rather than a list: `/v`
   * must accept only the docs app's token and `/admin` only the console app's. A
   * single shared AUD would let any member of `pagevault-viewers` present their token
   * to the owner console — a privilege escalation that looks like a config
   * simplification. See ADR-001.
   */
  CF_ACCESS_AUD_DOCS: string;
  CF_ACCESS_AUD_ADMIN: string;

  /**
   * Account id and the `pagevault-viewers` group id, written by provisioning. The Worker
   * needs both to add a granted email to the group so Access will admit them (ADR-002 hot
   * path). Absent = email-secured sharing is unavailable (Tier 0, ADR-008); grants with
   * emails fail loudly rather than silently. Paired with the `CF_API_TOKEN` secret below.
   */
  CF_ACCOUNT_ID?: string;
  CF_ACCESS_GROUP_ID?: string;

  /**
   * Local development only. Auth is bypassed ONLY when this is exactly `"none"` AND
   * the request arrived on localhost. Both guards, always. See auth.ts.
   */
  AUTH_MODE?: string;

  /** Optional. Overrides the artifact CSP. Default is the sandbox — see ADR-007. */
  DOC_CSP?: string;

  /**
   * The Browser Run (Puppeteer) binding — optional. Present enables single-page PDF export
   * (#50); absent means this deployment opted out, and both the PDF button and the endpoint
   * degrade off cleanly. Browser Rendering is generally available on the account (a free-tier
   * allocation), so there is no enablement step to perform — `make provision` detects it and
   * reports whether it looks ready. A fork that never wants PDF leaves the binding out and
   * nothing breaks.
   */
  BROWSER?: Fetcher;

  /** Secrets. */
  PAGEVAULT_API_TOKEN: string;
  /** Signs capability and console session tokens. See ADR-007. */
  VIEWER_CAPABILITY_SECRET?: string;
  /**
   * The RUNTIME Cloudflare token — the second half of the two-token model. This is a standing
   * credential inside the Worker, so it is deliberately NARROW: a dedicated token scoped to a
   * single permission (Access: Organizations, Identity Providers, and Groups — Edit), enough to
   * read and PUT the `pagevault-viewers` group and nothing else (#24). It is NOT the broad
   * provisioning credential (`CLOUDFLARE_API_TOKEN` in `.env.local`, deploy-time only) — a
   * compromised Worker must not be able to touch KV, Workers, or the Access apps.
   *
   * Provisioning captures it as `CF_RUNTIME_TOKEN` in `.env.local`; `make deploy` sets it here.
   * Enables the Access group sync (ADR-002). Absent (with the ids above) = Tier 0 (ADR-008):
   * email-secured sharing is unavailable, and a grant with emails fails loudly rather than
   * falling back to a weaker `Include: Everyone` policy.
   */
  CF_API_TOKEN?: string;
}

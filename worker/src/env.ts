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
   * default handler — it is the only way to parse a pending auth request and complete a
   * grant. Not a binding you configure; a per-request handle. Optional in the type because
   * it is absent anywhere the OAuthProvider is not in front (e.g. tests).
   */
  OAUTH_PROVIDER?: OAuthHelpers;

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

  /** Secrets. */
  PAGEVAULT_API_TOKEN: string;
  /** Signs capability and console session tokens. See ADR-007. */
  VIEWER_CAPABILITY_SECRET?: string;
  /**
   * Optional. Enables the Access group sync (ADR-002). Absent (with the ids above) = Tier 0
   * (ADR-008): email-secured sharing is unavailable, and a grant with emails fails loudly
   * rather than falling back to a weaker `Include: Everyone` policy.
   */
  CF_API_TOKEN?: string;
}

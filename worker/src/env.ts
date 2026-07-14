export interface Env {
  PAGEVAULT: KVNamespace;

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
  /** Optional. Absent = fall back to `Include: Everyone` and warn. See ADR-002. */
  CF_API_TOKEN?: string;
}

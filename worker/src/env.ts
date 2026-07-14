export interface Env {
  PAGEVAULT: KVNamespace;

  /** Vars — plaintext, set in wrangler.jsonc by `pagevault init`. */
  OWNER_EMAIL: string;
  CF_TEAM_NAME: string;
  PUBLIC_HOST: string;

  /**
   * One AUD per Access application. Deliberately two separate vars rather than a
   * list: `/d` must accept only the docs app's token and `/admin` only the console
   * app's. A single shared AUD would let any `pagevault-viewers` member present
   * their token to the owner console. See ADR-001.
   */
  CF_ACCESS_AUD_DOCS: string;
  CF_ACCESS_AUD_ADMIN: string;

  /** Optional. Overrides the document CSP. Default is the sandbox — see ADR-003. */
  DOC_CSP?: string;

  /** Secrets. */
  PAGEVAULT_API_TOKEN: string;
  /** Optional. Absent = fall back to `Include: Everyone` and warn. See ADR-002. */
  CF_API_TOKEN?: string;
}
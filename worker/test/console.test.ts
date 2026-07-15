import { SELF } from "cloudflare:test";
import { type JWK, SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetJWKSCache } from "../src/auth.js";

/**
 * 🔴 The owner console at /admin (ADR-004). Two walls (Access + owner check), a session
 * token that is NOT the API token, and a strict nonced CSP distinct from the artifact
 * sandbox. Driven through real Access JWTs, the admin audience, and a stubbed JWKS — the
 * same harness portal.test.ts uses for /v.
 */

const TEAM = "testteam";
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
const JWKS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const AUD_ADMIN = "aud-admin-test";
const KID = "test-key-1";
const HOST = "https://share.example.com";
const OWNER = "owner@example.com";
const API_TOKEN = "test-token-do-not-use-in-production";

let privateKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKey = keys.privateKey;
  publicJwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: "RS256", use: "sig" };
});

beforeEach(() => {
  resetJWKSCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === JWKS_URL) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetJWKSCache();
});

async function adminJwt(email: string): Promise<Record<string, string>> {
  const jwt = await new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUD_ADMIN)
    .setSubject(`sub-${email}`)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { "Cf-Access-Jwt-Assertion": jwt };
}

const getAdmin = (headers: Record<string, string> = {}) => SELF.fetch(`${HOST}/admin`, { headers });

describe("🔴 /admin — owner only", () => {
  it("403s an unauthenticated request", async () => {
    expect((await getAdmin()).status).toBe(403);
  });

  it("403s a valid Access JWT for a non-owner", async () => {
    // The admin Access app already excludes non-owners; this is the Worker's second wall.
    expect((await getAdmin(await adminJwt("intruder@example.com"))).status).toBe(403);
  });

  it("renders the console for the owner", async () => {
    const res = await getAdmin(await adminJwt(OWNER));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("PageVault console");
  });
});

describe("🔴 /admin — session token + strict CSP (ADR-004)", () => {
  it("carries a strict nonced CSP distinct from the artifact sandbox", async () => {
    const csp = (await getAdmin(await adminJwt(OWNER))).headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'"); // console-specific — it fetches /api
    expect(csp).toMatch(/script-src 'nonce-/);
    expect(csp).not.toContain("unsafe-inline");
  });

  it("embeds a session token, never the long-lived API token", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    expect(body).not.toContain(API_TOKEN); // ADR-004: the API token must never reach the DOM
    expect(body).toContain("Bearer");
  });

  it("the embedded session token actually authenticates against /api", async () => {
    const body = await (await getAdmin(await adminJwt(OWNER))).text();
    const token = /const T = "([^"]+)"/.exec(body)?.[1];
    expect(token).toBeTruthy();

    const api = await SELF.fetch(`${HOST}/api/portals`, { headers: { Authorization: `Bearer ${token}` } });
    expect(api.status).toBe(200);
  });
});

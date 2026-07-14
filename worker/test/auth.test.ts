import { env } from "cloudflare:test";
import { SignJWT, type JWK, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { identify, resetJWKSCache, timingSafeEqual } from "../src/auth.js";
import type { Env } from "../src/env.js";

/**
 * ⚠️ Identity. Fail-closed tests come FIRST, deliberately.
 *
 * These sign real RS256 tokens and verify them through the real `jose` path — JWKS
 * fetch, `kid` match, signature, issuer, audience. Faking the verification would test
 * our mock instead of our code, and this is the file where that matters most.
 */

const TEAM = "testteam";
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
const JWKS_URL = `${ISSUER}/cdn-cgi/access/certs`;

const AUD_DOCS = "aud-docs-test";
const AUD_ADMIN = "aud-admin-test";

const KID = "test-key-1";
const OWNER = "owner@example.com";

let privateKey: CryptoKey;
let publicJwk: JWK;
/** A key Access never signed with — used to forge a well-formed but invalid token. */
let attackerKey: CryptoKey;

beforeAll(async () => {
  const real = await generateKeyPair("RS256", { extractable: true });
  privateKey = real.privateKey;
  publicJwk = { ...(await exportJWK(real.publicKey)), kid: KID, alg: "RS256", use: "sig" };

  const attacker = await generateKeyPair("RS256", { extractable: true });
  attackerKey = attacker.privateKey;
});

beforeEach(() => {
  // jose's createRemoteJWKSet fetches the key set over the network. Serve it from here
  // so the real verification path runs end to end.
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

interface TokenOptions {
  email?: string;
  sub?: string;
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  key?: CryptoKey;
  kid?: string;
}

async function mintToken(opts: TokenOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (opts.email !== undefined) claims["email"] = opts.email;
  else claims["email"] = OWNER;

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? KID })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUD_DOCS)
    .setSubject(opts.sub ?? "user-123")
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "5m")
    .sign(opts.key ?? privateKey);
}

const request = (token?: string, url = "https://share.example.com/v/default/abc"): Request =>
  new Request(url, token ? { headers: { "Cf-Access-Jwt-Assertion": token } } : undefined);

const testEnv = (over: Partial<Env> = {}): Env => ({
  ...env,
  CF_TEAM_NAME: TEAM,
  CF_ACCESS_AUD_DOCS: AUD_DOCS,
  CF_ACCESS_AUD_ADMIN: AUD_ADMIN,
  ...over,
});

// ---------------------------------------------------------------------------

describe("⚠️ identify — fails closed", () => {
  it("denies with no JWT at all", async () => {
    expect(await identify(request(), testEnv(), "docs")).toBeNull();
  });

  it("denies a token signed by a key Access never used", async () => {
    const forged = await mintToken({ key: attackerKey });
    expect(await identify(request(forged), testEnv(), "docs")).toBeNull();
  });

  it("denies a token whose kid matches no key in the JWKS", async () => {
    const forged = await mintToken({ key: attackerKey, kid: "some-other-kid" });
    expect(await identify(request(forged), testEnv(), "docs")).toBeNull();
  });

  it("denies an expired token", async () => {
    const stale = await mintToken({ expiresIn: "-1m" });
    expect(await identify(request(stale), testEnv(), "docs")).toBeNull();
  });

  it("denies a token from a DIFFERENT Access team", async () => {
    const other = await mintToken({ issuer: "https://someoneelse.cloudflareaccess.com" });
    expect(await identify(request(other), testEnv(), "docs")).toBeNull();
  });

  it("denies a token with no email claim", async () => {
    const anon = await mintToken({ email: "" });
    expect(await identify(request(anon), testEnv(), "docs")).toBeNull();
  });

  it("🔴 denies when CF_ACCESS_AUD is unset — missing config DENIES, never skips", async () => {
    const token = await mintToken();
    const unconfigured = testEnv({ CF_ACCESS_AUD_DOCS: "" });
    expect(await identify(request(token), unconfigured, "docs")).toBeNull();
  });

  it("🔴 denies when CF_TEAM_NAME is unset", async () => {
    const token = await mintToken();
    expect(await identify(request(token), testEnv({ CF_TEAM_NAME: "" }), "docs")).toBeNull();
  });

  it("🔴 never trusts Cf-Access-Authenticated-User-Email", async () => {
    // The header Cloudflare also injects, and the one every naive implementation reads.
    // Present, well-formed, and completely ignored.
    const req = new Request("https://share.example.com/v/default/abc", {
      headers: { "Cf-Access-Authenticated-User-Email": OWNER },
    });
    expect(await identify(req, testEnv(), "docs")).toBeNull();
  });

  it("🔴 never trusts the CF_Authorization cookie, even with a valid token in it", async () => {
    // The browser attaches this to every path on the hostname. A valid JWT sitting in
    // the cookie must still not authenticate — the header is the only channel.
    const token = await mintToken();
    const req = new Request("https://share.example.com/v/default/abc", {
      headers: { Cookie: `CF_Authorization=${token}` },
    });
    expect(await identify(req, testEnv(), "docs")).toBeNull();
  });
});

describe("🔴 identify — the two audiences are not interchangeable", () => {
  // ADR-001. A single shared CF_ACCESS_AUD looks like a config simplification and is a
  // privilege escalation: it would let any member of `pagevault-viewers` present their
  // portal token to the owner console.

  it("rejects the docs token on the admin surface", async () => {
    const docsToken = await mintToken({ audience: AUD_DOCS });
    expect(await identify(request(docsToken), testEnv(), "admin")).toBeNull();
  });

  it("rejects the admin token on the docs surface", async () => {
    const adminToken = await mintToken({ audience: AUD_ADMIN });
    expect(await identify(request(adminToken), testEnv(), "docs")).toBeNull();
  });

  it("accepts each token on its own surface", async () => {
    const docsToken = await mintToken({ audience: AUD_DOCS });
    const adminToken = await mintToken({ audience: AUD_ADMIN });

    expect(await identify(request(docsToken), testEnv(), "docs")).toMatchObject({ email: OWNER });
    expect(await identify(request(adminToken), testEnv(), "admin")).toMatchObject({ email: OWNER });
  });
});

describe("identify — the happy path", () => {
  it("returns the verified email and subject", async () => {
    const token = await mintToken({ email: "cto@realplus.com", sub: "abc-123" });
    expect(await identify(request(token), testEnv(), "docs")).toEqual({
      email: "cto@realplus.com",
      sub: "abc-123",
    });
  });

  it("normalizes the email from the token", async () => {
    const token = await mintToken({ email: "  CTO@RealPlus.COM " });
    expect(await identify(request(token), testEnv(), "docs")).toMatchObject({
      email: "cto@realplus.com",
    });
  });
});

describe("🔴 identify — the dev bypass cannot escape localhost", () => {
  // Two independent guards, because this is an authentication bypass.

  it.each(["", "None", "NONE", "false", "0", "true", undefined])(
    "enforces auth when AUTH_MODE is %o — only exact 'none' bypasses",
    async (mode) => {
      const req = request(undefined, "http://localhost:8787/v/default/abc");
      const devEnv = testEnv(mode === undefined ? {} : { AUTH_MODE: mode });
      expect(await identify(req, devEnv, "docs")).toBeNull();
    },
  );

  it("🔴 refuses to bypass on a real hostname, even with AUTH_MODE=none", async () => {
    // The guard that makes a leaked AUTH_MODE=none in production survivable: a deployed
    // Worker on a custom domain never sees a localhost Host header.
    const req = request(undefined, "https://share.example.com/v/default/abc");
    expect(await identify(req, testEnv({ AUTH_MODE: "none" }), "docs")).toBeNull();
  });

  it("bypasses on localhost with exactly AUTH_MODE=none", async () => {
    const req = request(undefined, "http://localhost:8787/v/default/abc");
    expect(await identify(req, testEnv({ AUTH_MODE: "none" }), "docs")).toMatchObject({
      email: OWNER,
    });
  });

  it("does not bypass into an ownerless identity", async () => {
    const req = request(undefined, "http://localhost:8787/v/default/abc");
    const noOwner = testEnv({ AUTH_MODE: "none", OWNER_EMAIL: "  " });
    expect(await identify(req, noOwner, "docs")).toBeNull();
  });
});

describe("timingSafeEqual", () => {
  it("matches identical strings", () => {
    expect(timingSafeEqual("hunter2", "hunter2")).toBe(true);
  });

  it("rejects a prefix — length is checked, not just content", () => {
    expect(timingSafeEqual("hunter", "hunter2")).toBe(false);
  });

  it("rejects empty strings — an unset token must never authorize", () => {
    expect(timingSafeEqual("", "")).toBe(false);
  });
});

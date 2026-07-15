import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintCapability, verifyCapability } from "../src/capability.js";
import type { Env } from "../src/env.js";
import { mintSession, verifySession } from "../src/session.js";
import { resetTokenKeyCache } from "../src/token.js";

/**
 * ⚠️ Console session tokens (ADR-004). The console embeds one of these and sends it as a
 * bearer to /api/*, so a bug here is a path to the owner's mutations. Fail-closed and
 * scope-separation cases come first and carry 🔴.
 */

const OWNER = "owner@example.com";
const NOW = 1_800_000_000; // fixed epoch seconds, for determinism
const TTL = 15 * 60;

beforeEach(() => resetTokenKeyCache());
afterEach(() => resetTokenKeyCache());

const noToken = (): Env => ({ ...env, PAGEVAULT_API_TOKEN: "" });

/** base64url, matching the module — for crafting a forged payload. */
const b64url = (s: string): string =>
  btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

describe("session token", () => {
  it("mints a token that verifies back to the owner email", async () => {
    const token = await mintSession(env, OWNER, NOW);
    expect(token).toBeTruthy();
    expect(await verifySession(env, token, NOW + 60)).toEqual({ email: OWNER });
  });

  it("🔴 rejects an expired session", async () => {
    const token = await mintSession(env, OWNER, NOW);
    expect(await verifySession(env, token, NOW + TTL + 1)).toBeNull();
  });

  it("🔴 cannot be replayed as another email — a tampered sub fails the signature", async () => {
    const token = await mintSession(env, OWNER, NOW);
    const sig = token!.slice(token!.indexOf(".") + 1);
    const forgedBody = b64url(JSON.stringify({ scope: "console", sub: "attacker@evil.com", exp: NOW + 999 }));
    expect(await verifySession(env, `${forgedBody}.${sig}`, NOW)).toBeNull();
  });

  it("🔴 rejects a flipped signature byte", async () => {
    const token = await mintSession(env, OWNER, NOW);
    const flipped = token!.slice(0, -1) + (token!.endsWith("A") ? "B" : "A");
    expect(await verifySession(env, flipped, NOW)).toBeNull();
  });

  it("rejects garbage and empty tokens", async () => {
    expect(await verifySession(env, null, NOW)).toBeNull();
    expect(await verifySession(env, "", NOW)).toBeNull();
    expect(await verifySession(env, "not-a-token", NOW)).toBeNull();
  });

  it("🔴 mints and verifies nothing without PAGEVAULT_API_TOKEN — fail closed", async () => {
    expect(await mintSession(noToken(), OWNER, NOW)).toBeNull();
    const valid = await mintSession(env, OWNER, NOW);
    expect(await verifySession(noToken(), valid, NOW)).toBeNull();
  });
});

describe("🔴 scope separation — a token for one scope is not a token for another", () => {
  // The whole reason session.ts derives its own key. These prove the separation is
  // cryptographic: a viewer token fails at the signature, not just at a scope field.

  it("a viewer capability does NOT verify as a console session", async () => {
    const cap = await mintCapability(env, "doc123", OWNER, NOW);
    expect(cap).toBeTruthy();
    expect(await verifySession(env, cap, NOW)).toBeNull();
  });

  it("a console session does NOT verify as a viewer capability", async () => {
    const session = await mintSession(env, OWNER, NOW);
    expect(await verifyCapability(env, session, "doc123", NOW)).toBeNull();
  });
});

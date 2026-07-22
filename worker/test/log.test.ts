import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprint, log } from "../src/log.js";

/**
 * 🔴 These are security tests, not logging tests.
 *
 * A capability token that reaches the log is a credential an operator can read out of
 * `wrangler tail` months later — and on `/p/{token}` those tokens never expire. ADR-015
 * decision 2 says never record a credential in replayable form; this file is what enforces
 * it, because the leak it replaces was introduced by accident and would be reintroduced the
 * same way.
 */

const CAP = "eyJhbGciOiJIUzI1NiJ9.SUPERSECRETCAPABILITY.sig";
const PUB = "pubtoken2222222222222";

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void out.push(line));
  vi.spyOn(console, "error").mockImplementation((line: string) => void err.push(line));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const emitted = () => [...out, ...err].join("\n");

/** Parse one emitted line, failing loudly rather than passing vacuously if it is missing. */
function parse(lines: string[], i = 0): Record<string, unknown> {
  const line = lines[i];
  if (line === undefined) throw new Error(`expected a log line at index ${i}, got none`);
  return JSON.parse(line);
}

describe("log()", () => {
  it("never writes the request URL, so a ?cap= token cannot reach the log", () => {
    const request = new Request(`https://share.example.com/render/k3x9mq2vb7pd?cap=${CAP}`);

    log("warn", "blocked_render_invalid_capability", { request, doc: "k3x9mq2vb7pd" });

    expect(emitted()).not.toContain(CAP);
    expect(emitted()).not.toContain("cap=");
    expect(parse(out)).not.toHaveProperty("url");
  });

  it("never writes the request path, because on /p/{token} the path IS the credential", () => {
    const request = new Request(`https://share.example.com/p/${PUB}`);

    log("warn", "blocked_public_token_unknown", { request });

    // The public token has no expiry — it is live until rotated. A logged path here is a
    // permanent credential sitting in the log.
    expect(emitted()).not.toContain(PUB);
    expect(parse(out)).not.toHaveProperty("path");
  });

  it("keeps the fields that are safe and useful", () => {
    const request = new Request("https://share.example.com/api/docs", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });

    log("warn", "blocked_api_request_invalid_origin", { request, path: "/api/docs" });

    const rec = parse(out);
    expect(rec).toMatchObject({
      level: "warn",
      event: "blocked_api_request_invalid_origin",
      method: "POST",
      origin: "https://evil.example",
      path: "/api/docs",
    });
    expect(rec.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("routes errors to console.error so `wrangler tail --status error` sees them", () => {
    log("error", "jwt_verification_failed_behind_access", { slug: "acme" });

    expect(err).toHaveLength(1);
    expect(out).toHaveLength(0);
    expect(parse(err).level).toBe("error");
  });

  it("routes non-errors to console.log", () => {
    log("warn", "blocked_api_request_invalid_origin");
    log("info", "document_viewed");

    expect(out).toHaveLength(2);
    expect(err).toHaveLength(0);
  });

  it("emits one line of parseable JSON per event", () => {
    log("warn", "a", { n: 1 });
    log("warn", "b", { n: 2 });

    expect(out).toHaveLength(2);
    expect(out.map((l) => JSON.parse(l).event)).toEqual(["a", "b"]);
    expect(out.every((l) => !l.includes("\n"))).toBe(true);
  });

  it("does not leak the Request object itself into the output", () => {
    const request = new Request(`https://share.example.com/p/${PUB}`);

    log("warn", "x", { request });

    expect(parse(out)).not.toHaveProperty("request");
  });
});

describe("fingerprint()", () => {
  it("is stable for the same secret and distinct for different ones", async () => {
    expect(await fingerprint(CAP)).toBe(await fingerprint(CAP));
    expect(await fingerprint(CAP)).not.toBe(await fingerprint(PUB));
  });

  it("is short and reveals no substring of the input", async () => {
    const fp = await fingerprint(CAP);

    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(CAP).not.toContain(fp);
  });
});

import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { putMembers, putPortal } from "../src/store.js";

/**
 * The remote MCP server, driven over real JSON-RPC on Streamable HTTP.
 *
 * Calling the tool callbacks directly would test our closures. This posts actual protocol
 * frames at `/mcp` and reads what comes back — which is what Claude will do.
 */

const TOKEN = "test-token-do-not-use-in-production";
const HOST = "https://share.example.com";

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
  // Streamable HTTP: the client must accept both, or the server has nowhere to reply.
  Accept: "application/json, text/event-stream",
};

let nextId = 1;

async function rpc(method: string, params: unknown = {}, token = TOKEN): Promise<Response> {
  return SELF.fetch(`${HOST}/mcp`, {
    method: "POST",
    headers: { ...HEADERS, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
}

/** Streamable HTTP may answer as JSON or as an SSE frame. Accept either. */
async function result(res: Response): Promise<Record<string, unknown>> {
  const body = await res.text();

  if (body.startsWith("event:") || body.includes("\ndata: ")) {
    const line = body.split("\n").find((l) => l.startsWith("data: "));
    return JSON.parse(line!.slice("data: ".length)).result;
  }
  return JSON.parse(body).result;
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await rpc("tools/call", { name, arguments: args });
  const payload = await result(res);
  const content = payload["content"] as { type: string; text: string }[];
  return content.map((c) => c.text).join("\n");
}

async function seedPortals() {
  const now = "2026-01-01T00:00:00.000Z";
  await putPortal(env, { slug: "realplus", name: "RealPlus", kind: "restricted", createdAt: now, updatedAt: now });
  await putMembers(env, "realplus", ["cto@realplus.com"]);
  await putPortal(env, { slug: "acme", name: "Acme", kind: "restricted", createdAt: now, updatedAt: now });
}

// ---------------------------------------------------------------------------

describe("🔴 /mcp — auth", () => {
  it("401s with no bearer token, and says how to authenticate", async () => {
    const res = await SELF.fetch(`${HOST}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(res.status).toBe(401);
    // MCP clients read this to mean "authenticate", not "go away".
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("401s with the wrong bearer token", async () => {
    expect((await rpc("tools/list", {}, "not-the-token")).status).toBe(401);
  });
});

describe("/mcp — protocol", () => {
  it("advertises every tool", async () => {
    const payload = await result(await rpc("tools/list"));
    const names = (payload["tools"] as { name: string }[]).map((t) => t.name).sort();

    expect(names).toEqual([
      "create_portal",
      "list_documents",
      "list_portals",
      "mint_public_link",
      "publish_document",
      "read_document",
      "revoke_document",
      "search_portal",
      "update_portal_members",
    ]);
  });

  it("⭐ warns the model that mint_public_link is a WIDENING operation", async () => {
    // The tool description is the only thing standing between a model and a casually
    // public client report. It has to say so, in the description, not in our docs.
    const payload = await result(await rpc("tools/list"));
    const tools = payload["tools"] as { name: string; description: string }[];
    const mint = tools.find((t) => t.name === "mint_public_link")!;

    expect(mint.description).toContain("WIDENING");
    expect(mint.description).toContain("Unguessable is NOT private");
  });

  it("⭐ tells the model never to infer the portal from conversation", async () => {
    const payload = await result(await rpc("tools/list"));
    const tools = payload["tools"] as { name: string; description: string }[];
    const publish = tools.find((t) => t.name === "publish_document")!;

    expect(publish.description).toContain("Never infer the portal");
    expect(publish.description).toContain("ASK THE USER");
  });
});

describe("publish_document", () => {
  it("publishes with no portal named, creating `default` — no concept tax", async () => {
    const out = await callTool("publish_document", {
      title: "Q3 Review",
      html: "<h1>Q3</h1>",
    });

    expect(out).toContain("Published");
    expect(out).toContain("Portal: default");
    expect(out).toMatch(/\/v\/default\/[a-z2-9]{12}/);
  });

  it("uses the only portal that exists, without asking", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    await putPortal(env, { slug: "realplus", name: "RealPlus", kind: "restricted", createdAt: now, updatedAt: now });

    const out = await callTool("publish_document", { title: "Q3", html: "<h1>x</h1>" });
    expect(out).toContain("Portal: realplus");
  });

  it("⭐ REFUSES to guess when several portals exist, and names them", async () => {
    // Inferring "this is probably the RealPlus one" from chat is exactly the failure that
    // files Client A's report into Client B's portal.
    await seedPortals();

    const out = await callTool("publish_document", { title: "Q3", html: "<h1>x</h1>" });

    expect(out).toContain("portal_ambiguous");
    expect(out).toContain("Ask the user");
    expect(out).toContain("realplus");
    expect(out).toContain("acme");
  });

  it("reports where it landed, every time", async () => {
    await seedPortals();
    const out = await callTool("publish_document", { title: "Q3", html: "<h1>x</h1>", portal: "acme" });

    // The printout is the safeguard against a misfile — not a required flag.
    expect(out).toContain("Portal: acme");
  });

  it("marks a draft as invisible to the client", async () => {
    const out = await callTool("publish_document", {
      title: "Roadmap",
      html: "<h1>x</h1>",
      ownerOnly: true,
    });
    expect(out).toContain("The client cannot see this");
  });
});

describe("⭐ publish_document — an agent must not clobber a deliverable in one tool call", () => {
  it("REFUSES to overwrite without confirm, and shows what would be replaced", async () => {
    await callTool("publish_document", { title: "Q3 Review", html: "<h1>original</h1>" });

    const out = await callTool("publish_document", {
      title: "Q3 Review",
      html: "<h1>a much longer replacement</h1>",
    });

    expect(out).toContain("already exists");
    expect(out).toContain("REPLACES it in place");
    expect(out).toContain("not recoverable");
    expect(out).toContain("confirm: true");
    // And the number, so a human can judge — not a vague warning.
    expect(out).toMatch(/bytes → \d+ bytes/);
  });

  it("does NOT touch the document when it refuses", async () => {
    const first = await callTool("publish_document", { title: "Q3 Review", html: "<h1>original</h1>" });
    const id = /id: ([a-z2-9]{12})|\/v\/default\/([a-z2-9]{12})/.exec(first)?.[2]!;

    await callTool("publish_document", { title: "Q3 Review", html: "<h1>replacement</h1>" });

    expect(await env.PAGEVAULT.get(`doc:${id}`)).toBe("<h1>original</h1>");
  });

  it("overwrites IN PLACE with confirm — same id, same URL, so the link stays current", async () => {
    const first = await callTool("publish_document", { title: "Q3 Review", html: "<h1>v1</h1>" });
    const url = /(\/v\/default\/[a-z2-9]{12})/.exec(first)![1]!;

    const second = await callTool("publish_document", {
      title: "Q3 Review",
      html: "<h1>v2</h1>",
      confirm: true,
    });

    expect(second).toContain("Updated in place");
    expect(second).toContain(url); // the SAME url — no graveyard of stale links
    expect(second).toContain("now sees the new version");

    const id = url.split("/").pop()!;
    expect(await env.PAGEVAULT.get(`doc:${id}`)).toBe("<h1>v2</h1>");
  });

  it("matches titles case-insensitively — the same deliverable, typed differently", async () => {
    await callTool("publish_document", { title: "Q3 Review", html: "<h1>v1</h1>" });
    const out = await callTool("publish_document", { title: "q3 review", html: "<h1>v2</h1>" });

    expect(out).toContain("already exists");
  });
});

describe("⭐ the read side — the portal is memory, not an outbox", () => {
  it("search_portal finds a decision six months later", async () => {
    await callTool("publish_document", {
      title: "Data Warehouse Architecture Review",
      html: "<h1>Architecture</h1><p>We chose Debezium for CDC on V2.</p>",
      summary: "CDC approach and the retire/wrap/rebuild roadmap",
      tags: ["type:architecture"],
    });
    await callTool("publish_document", { title: "Q3 Report", html: "<h1>unrelated</h1>" });

    const out = await callTool("search_portal", { portal: "default", query: "CDC" });

    expect(out).toContain("Data Warehouse Architecture Review");
    expect(out).not.toContain("Q3 Report");
    expect(out).toContain("matched: summary");
  });

  it("searches the BODY when the metadata does not match", async () => {
    await callTool("publish_document", {
      title: "Architecture",
      html: "<h1>x</h1><p>We chose Debezium.</p>",
    });

    const out = await callTool("search_portal", { portal: "default", query: "debezium" });
    expect(out).toContain("matched: body");
  });

  it("read_document returns the source", async () => {
    const pub = await callTool("publish_document", {
      title: "Architecture",
      html: "<h1>The decision</h1>",
      summary: "What we chose",
    });
    const id = /\/v\/default\/([a-z2-9]{12})/.exec(pub)![1]!;

    const out = await callTool("read_document", { id });

    expect(out).toContain("# Architecture");
    expect(out).toContain("What we chose");
    expect(out).toContain("<h1>The decision</h1>");
  });

  it("truncates a document that would eat the context window, and says so", async () => {
    const pub = await callTool("publish_document", {
      title: "Huge",
      html: `<h1>x</h1>${"y".repeat(200 * 1024)}`,
    });
    const id = /\/v\/default\/([a-z2-9]{12})/.exec(pub)![1]!;

    const out = await callTool("read_document", { id });
    expect(out).toContain("TRUNCATED");
  });

  it("list_portals shows what clients exist, with counts", async () => {
    await seedPortals();
    await callTool("publish_document", { title: "Q3", html: "<h1>x</h1>", portal: "realplus" });

    const out = await callTool("list_portals");
    expect(out).toContain("realplus");
    expect(out).toContain("1 document");
    expect(out).toContain("acme");
  });

  it("list_documents flags drafts", async () => {
    await callTool("publish_document", { title: "Draft", html: "<h1>x</h1>", ownerOnly: true });
    const out = await callTool("list_documents");
    expect(out).toContain("[draft]");
  });
});

describe("🔴 search_portal requires a portal — no cross-client grep", () => {
  it("scopes the search to one client", async () => {
    await seedPortals();
    await callTool("publish_document", { title: "RealPlus Secret", html: "<h1>x</h1>", portal: "realplus" });
    await callTool("publish_document", { title: "Acme Secret", html: "<h1>x</h1>", portal: "acme" });

    const out = await callTool("search_portal", { portal: "acme", query: "secret" });

    expect(out).toContain("Acme Secret");
    // Searching every client at once is how one client's material ends up in another's
    // report. The portal argument is required, and the tool honours it.
    expect(out).not.toContain("RealPlus Secret");
  });
});

describe("portal and member tools", () => {
  it("create_portal creates a client portal", async () => {
    const out = await callTool("create_portal", {
      slug: "realplus",
      name: "RealPlus",
      kind: "restricted",
    });
    expect(out).toContain("Created portal");
  });

  it("rejects a reserved slug that would shadow a route", async () => {
    const out = await callTool("create_portal", { slug: "admin", name: "x", kind: "private" });
    expect(out).toContain("invalid_slug");
  });

  it("⭐ update_portal_members grants every document a client has ever received", async () => {
    await seedPortals();
    await callTool("publish_document", { title: "A", html: "<h1>a</h1>", portal: "realplus" });
    await callTool("publish_document", { title: "B", html: "<h1>b</h1>", portal: "realplus" });

    const out = await callTool("update_portal_members", {
      portal: "realplus",
      add: ["newhire@realplus.com"],
    });

    // One call. Two documents. No per-document work.
    expect(out).toContain("newhire@realplus.com");
    expect(out).toContain("cto@realplus.com");
  });

  it("mint_public_link warns that the link is a capability URL", async () => {
    const pub = await callTool("publish_document", { title: "Memo", html: "<h1>x</h1>" });
    const id = /\/v\/default\/([a-z2-9]{12})/.exec(pub)![1]!;

    const out = await callTool("mint_public_link", { id });

    expect(out).toMatch(/\/p\/[a-z2-9]{22}/);
    expect(out).toContain("capability URL");
    expect(out).toContain("Anyone it is forwarded to can open it");
  });

  it("revoke_document deletes it and says there is no undo", async () => {
    const pub = await callTool("publish_document", { title: "Memo", html: "<h1>x</h1>" });
    const id = /\/v\/default\/([a-z2-9]{12})/.exec(pub)![1]!;

    const out = await callTool("revoke_document", { id });

    expect(out).toContain("cannot be undone");
    expect(await env.PAGEVAULT.get(`doc:${id}`)).toBeNull();
  });
});

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { mintSession } from "../src/session.js";
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

/** The full JSON-RPC envelope (`result` OR `error`), for asserting on failures. */
async function envelope(res: Response): Promise<Record<string, unknown>> {
  const body = await res.text();
  if (body.startsWith("event:") || body.includes("\ndata: ")) {
    const line = body.split("\n").find((l) => l.startsWith("data: "));
    return JSON.parse(line!.slice("data: ".length));
  }
  return JSON.parse(body);
}

/** Streamable HTTP may answer as JSON or as an SSE frame. Accept either. */
async function result(res: Response): Promise<Record<string, unknown>> {
  return (await envelope(res))["result"] as Record<string, unknown>;
}

/** Only text blocks join into the prose. A tool result may also carry resource_link blocks (#82). */
const proseOf = (content: { type: string; text?: string }[]): string =>
  content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await rpc("tools/call", { name, arguments: args });
  const payload = await result(res);
  return proseOf(payload["content"] as { type: string; text?: string }[]);
}

/**
 * The full tool result, so a test can read `structuredContent` (#81) as well as the prose.
 *
 * 🔴 A load-bearing side effect: the SDK validates `structuredContent` against the tool's
 * `outputSchema` before replying, and a non-error success that omits it becomes a JSON-RPC
 * *error* — at which point `result()` returns undefined and the `.structuredContent` read
 * throws. So every one of these calls is also an assertion that the schema was honoured.
 */
async function callToolFull(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; structured: Record<string, unknown>; content: { type: string; uri?: string; name?: string }[] }> {
  const res = await rpc("tools/call", { name, arguments: args });
  const payload = await result(res);
  const content = payload["content"] as { type: string; text?: string; uri?: string; name?: string }[];
  return {
    text: proseOf(content),
    structured: payload["structuredContent"] as Record<string, unknown>,
    content,
  };
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

  it("🔴 401s with a console session token — /mcp is API-token-only (ADR-004)", async () => {
    // Session tokens authenticate the console against /api. They must NOT reach /mcp, or a
    // token minted for a browser page becomes an agent credential. Surface isolation.
    const session = await mintSession(env, "owner@example.com");
    expect((await rpc("tools/list", {}, session!)).status).toBe(401);
  });
});

describe("🔴 /mcp — Origin is observed, never blocked (remote token-auth server)", () => {
  /**
   * This began as a 403 on any foreign Origin, to satisfy the MCP 2025-11-25 DNS-rebinding rule.
   * That rule is for localhost-bound servers; here it broke the claude.ai web client, which calls
   * /mcp from the browser with `Origin: https://claude.ai`. A rebound page steals nothing (no
   * cookie, no ambient authority — ADR-004), so the Origin check now logs and lets the auth gate
   * do the work. `isAuthorized` is the real defense, regardless of Origin.
   */
  const withOrigin = (origin: string | null, token = TOKEN) =>
    SELF.fetch(`${HOST}/mcp`, {
      method: "POST",
      headers: {
        ...HEADERS,
        Authorization: `Bearer ${token}`,
        ...(origin === null ? {} : { Origin: origin }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
    });

  it("🔴 allows Origin: https://claude.ai with a valid token — the regression that took prod down", async () => {
    // The claude.ai web app POSTs to /mcp from the browser carrying its own origin. Blocking it
    // 403'd the tool-list refresh and read as "server unavailable". If this ever 403s again, the
    // block is back.
    const res = await withOrigin("https://claude.ai");
    expect(res.status).toBe(200);
  });

  it("allows a request with no Origin — the Claude Code and connector path", async () => {
    expect((await withOrigin(null)).status).toBe(200);
  });

  it("allows our own origin", async () => {
    expect((await withOrigin(HOST)).status).toBe(200);
  });

  it("🔴 a foreign origin with NO token still 401s — auth is the gate, not Origin", async () => {
    // Origin never authorizes anything. A request without a valid credential is refused because
    // it lacks the credential, not because of where it claims to come from.
    const res = await withOrigin("https://evil.example.com", "not-the-token");
    expect(res.status).toBe(401);
  });
});

describe("/mcp — protocol", () => {
  it("advertises every tool", async () => {
    const payload = await result(await rpc("tools/list"));
    const names = (payload["tools"] as { name: string }[]).map((t) => t.name).sort();

    expect(names).toEqual([
      "create_portal",
      "edit_document",
      "list_documents",
      "list_portals",
      "mint_public_link",
      "pin_documents",
      "publish_document",
      "read_document",
      "revoke_document",
      "revoke_public_link",
      "rotate_public_link",
      "search_portal",
      "server_info",
      "traffic",
      "update_portal_members",
    ]);
  });

  it("pin_documents sets the whole order and reports what it dropped (#142)", async () => {
    await seedPortals();
    // Publish two documents so there is something real to pin.
    for (const name of ["sow.html", "weekly.html"]) {
      await callToolFull("publish_document", {
        portal: "acme",
        filename: name,
        title: name,
        html: `<!doctype html><title>${name}</title><p>x</p>`,
      });
    }

    // 🔴 The order is REPLACED, not merged — an agent sends the list it wants, top first.
    const set = await callToolFull("pin_documents", { portal: "acme", filenames: ["weekly.html", "sow.html"] });
    expect(set.structured["pinned"]).toEqual(["weekly.html", "sow.html"]);
    expect(set.structured["dropped"]).toEqual([]);

    // 🔴 A name matching no document is DROPPED and named. The renderer skips such a pin silently —
    // which is what makes a deleted document self-healing — so if this did not report, a model that
    // guessed a filename would be told it succeeded and the page would show nothing.
    const typo = await callToolFull("pin_documents", { portal: "acme", filenames: ["sow.html", "nope.html"] });
    expect(typo.structured["pinned"]).toEqual(["sow.html"]);
    expect(typo.structured["dropped"]).toEqual(["nope.html"]);
    expect(typo.text).toMatch(/not pinned/i);

    // 🔴 list_documents reports the position, which is what makes a RELATIVE move expressible at
    // all. `pin_documents` replaces the order, so "move this above that" needs the current one —
    // and nothing else on /mcp carries it: list_portals is built on PortalSummary, which
    // deliberately cannot. Without this an agent can only guess, and a guessed partial list
    // silently unpins everything it omits.
    await callToolFull("pin_documents", { portal: "acme", filenames: ["weekly.html", "sow.html"] });
    const listed = await callToolFull("list_documents", { portal: "acme" });
    const byName = new Map(
      (listed.structured["documents"] as { name: string; pinned?: number }[]).map((d) => [d.name, d.pinned]),
    );
    expect(byName.get("weekly.html")).toBe(1);
    expect(byName.get("sow.html")).toBe(2);
    // In the prose too — a host that renders text alone must not show an agent a bare list when it
    // is about to be asked to reorder one.
    expect(listed.text).toMatch(/\[pinned #1\]/);

    // An empty list clears the block rather than being a no-op, and the position goes with it.
    const cleared = await callToolFull("pin_documents", { portal: "acme", filenames: [] });
    expect(cleared.structured["pinned"]).toEqual([]);
    const after = await callToolFull("list_documents", { portal: "acme" });
    for (const d of after.structured["documents"] as { pinned?: number }[]) {
      expect(d.pinned).toBeUndefined();
    }
  });

  it("🔴 registers NO tool that deletes a portal (ADR-026)", async () => {
    // The exhaustive list above already fails if `delete_portal` is added — but it fails looking
    // like a list that needs updating, which is exactly how a deliberate omission gets "fixed".
    // This one fails saying what it is: a decision.
    //
    // `DELETE /api/portals/{slug}` exists and the CLI calls it (#180). MCP does not, and will not.
    // Every other tool's worst case is a wrong document at a right URL; this one's is nine months of
    // an engagement and every /p/ link already in a client's inbox, from one misread sentence, with
    // no undo. An agent may create and share. It may not end a client boundary.
    const payload = await result(await rpc("tools/list"));
    const tools = payload["tools"] as { name: string; description: string }[];

    expect(tools.find((t) => t.name === "delete_portal")).toBeUndefined();
    // And not under another name: nothing on /mcp may remove a portal.
    for (const t of tools) {
      expect(t.name).not.toMatch(/(delete|destroy|drop|remove|purge)_?portal/i);
    }

    // The closest destructive tool MCP does hold keeps the document — it is a flag, not a deletion.
    // If that ever stops being true, this assertion should be the thing that objects.
    const revoke = tools.find((t) => t.name === "revoke_document")!;
    expect(revoke).toBeDefined();
    expect(revoke.description.toLowerCase()).not.toMatch(/permanently deletes|cannot be undone/);
  });

  it("⭐ warns the model that mint_public_link is a WIDENING operation", async () => {
    // The tool description is the only thing standing between a model and a casually
    // public client report. It has to say so, in the description, not in our docs.
    const payload = await result(await rpc("tools/list"));
    const tools = payload["tools"] as { name: string; description: string }[];
    const mint = tools.find((t) => t.name === "mint_public_link")!;

    expect(mint.description).toContain("WIDENING");
    expect(mint.description).toContain("capability link"); // the guardrail wording, per-tool
  });

  it("⭐ tells the model never to infer the portal from conversation", async () => {
    const payload = await result(await rpc("tools/list"));
    const tools = payload["tools"] as { name: string; description: string }[];
    const publish = tools.find((t) => t.name === "publish_document")!;

    // The canonical rule now lives in server instructions (#80); the tool still carries the
    // operative instruction so trimming the description never drops the guardrail.
    expect(publish.description).toContain("ASK THE USER");
    expect(publish.description).toContain("never guess");
  });

  it("⭐ states the cross-cutting rules once, in server instructions (#80)", async () => {
    // De-duplicated out of the individual tool descriptions and into the server's instructions,
    // which a host surfaces as standing context for every tool.
    const init = await result(
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      }),
    );
    const instructions = init["instructions"] as string;

    expect(instructions).toContain("Never infer the portal"); // rule 1 — the client boundary (#5)
    expect(instructions).toContain("capability URL"); // rule 2 — public links
    expect(instructions).toContain("REPLACES it in place"); // rule 3 — publish overwrite
  });

  it("⭐ carries tool annotations so a host can gate calls (#80)", async () => {
    const payload = await result(await rpc("tools/list"));
    const tools = payload["tools"] as { name: string; title?: string; annotations?: Record<string, unknown> }[];
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    // The four read tools are auto-runnable.
    for (const name of ["list_portals", "list_documents", "read_document", "search_portal"]) {
      expect(byName[name]!.annotations?.["readOnlyHint"], name).toBe(true);
    }

    // The destructive ones are flagged so a host prompts before running them.
    for (const name of ["revoke_document", "revoke_public_link", "rotate_public_link", "publish_document"]) {
      expect(byName[name]!.annotations?.["readOnlyHint"], name).toBe(false);
      expect(byName[name]!.annotations?.["destructiveHint"], name).toBe(true);
    }

    // mint is widening but not destructive (no data loss), and idempotent.
    expect(byName["mint_public_link"]!.annotations?.["destructiveHint"]).toBe(false);
    expect(byName["mint_public_link"]!.annotations?.["idempotentHint"]).toBe(true);

    // Every tool has a human-readable title.
    for (const t of tools) expect(typeof t.title, t.name).toBe("string");
  });
});

describe("⭐ structured tool output — the read→publish chain is machine-readable (#81)", () => {
  it("tools/list declares outputSchema on the chain tools plus server_info, and not the others", async () => {
    const payload = await result(await rpc("tools/list"));
    const tools = payload["tools"] as { name: string; outputSchema?: Record<string, unknown> }[];
    const withSchema = tools
      .filter((t) => t.outputSchema)
      .map((t) => t.name)
      .sort();

    // The five #81 chain tools, plus server_info (#98), traffic (#163) and pin_documents (#142) —
    // all machine-readable returns. `traffic` earns one for the same reason `list_documents` does:
    // an agent asked to compare two windows or chart a trend needs the numbers, not a paragraph to
    // re-parse. `pin_documents` earns one because it reports what it DROPPED — a filename that
    // matched no document — and "which of my names were wrong" is a list, not a sentence.
    expect(withSchema).toEqual([
      "list_documents",
      "list_portals",
      "pin_documents",
      "publish_document",
      "read_document",
      "search_portal",
      "server_info",
      "traffic",
    ]);

    // The emitted schema is an object schema — the shape a 2020-12 host expects (SEP-1613).
    const read = tools.find((t) => t.name === "read_document")!;
    expect(read.outputSchema?.["type"]).toBe("object");
    expect(read.outputSchema?.["properties"]).toBeTruthy();
  });

  it("publish_document returns id + url + created as fields, not just prose", async () => {
    const { text, structured } = await callToolFull("publish_document", { title: "Q3", html: "<h1>x</h1>" });

    expect(structured["created"]).toBe(true);
    expect(structured["portal"]).toBe("default");
    expect(structured["public"]).toBe(false);
    expect(structured["ownerOnly"]).toBe(false);
    // The url an agent hands the user, no scraping — and it agrees with the prose.
    expect(structured["url"]).toMatch(/\/v\/default\/[a-z2-9]{12}$/);
    expect(text).toContain(structured["url"] as string);
    // The id joins straight to read_document, no regex over the prose.
    expect(await callToolFull("read_document", { id: structured["id"] as string })).toBeTruthy();
  });

  it("🔴 publish_document returns the stored byte count — so a stub is caught without read_document (#99)", async () => {
    const { text, structured } = await callToolFull("publish_document", {
      title: "Real Doc",
      html: "<h1>the whole thing</h1><p>lots of real content here</p>",
    });

    // The size the model needs to confirm a full doc landed, not a placeholder — in the publish
    // result itself, so no read_document round-trip is required to verify.
    expect(structured["bytes"]).toBeGreaterThan(0);
    expect(structured["bytes"]).toBe("<h1>the whole thing</h1><p>lots of real content here</p>".length);
    expect(text).toContain("Bytes:");
  });

  it("its html description forbids a placeholder/stub, verbatim (#99)", async () => {
    const payload = await result(await rpc("tools/list"));
    const tools = payload["tools"] as { name: string; inputSchema: { properties: Record<string, { description?: string }> } }[];
    const publish = tools.find((t) => t.name === "publish_document")!;
    const htmlDesc = publish.inputSchema.properties["html"]!.description ?? "";

    expect(htmlDesc).toContain("VERBATIM");
    expect(htmlDesc).toContain("placeholder");
    expect(htmlDesc).toContain("byte count"); // "the result reports the stored byte count"
  });

  it("publish_document reports created:false when it overwrites in place", async () => {
    await callTool("publish_document", { title: "Q3", html: "<h1>v1</h1>" });
    const { structured } = await callToolFull("publish_document", {
      title: "Q3",
      html: "<h1>v2</h1>",
      confirm: true,
    });
    expect(structured["created"]).toBe(false);
  });

  it("publish_document surfaces the public URL scheme for a public portal", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    await putPortal(env, { slug: "openhouse", name: "Open", kind: "public", createdAt: now, updatedAt: now });

    const { structured } = await callToolFull("publish_document", {
      title: "Flyer",
      html: "<h1>x</h1>",
      portal: "openhouse",
    });
    // A public-portal document lives at /pub/, never /v/ — handing out /v/ would burn an Access seat.
    expect(structured["url"]).toMatch(/\/pub\/openhouse\/[a-z2-9]{12}$/);
  });

  it("read_document carries the source, the true byte size, and the truncation flag", async () => {
    const { structured: pub } = await callToolFull("publish_document", {
      title: "Doc",
      html: "<h1>hello</h1>",
      summary: "a summary",
    });
    const { structured } = await callToolFull("read_document", { id: pub["id"] as string });

    expect(structured["source"]).toContain("<h1>hello</h1>");
    expect(structured["summary"]).toBe("a summary");
    expect(structured["truncated"]).toBe(false);
    expect(structured["sourceKind"]).toBe("html");
    expect(typeof structured["bytes"]).toBe("number");
  });

  it("read_document flags truncation and still reports the full byte size", async () => {
    const { structured: pub } = await callToolFull("publish_document", {
      title: "Huge",
      html: `<h1>x</h1>${"y".repeat(200 * 1024)}`,
    });
    const { structured } = await callToolFull("read_document", { id: pub["id"] as string });

    expect(structured["truncated"]).toBe(true);
    // bytes is the ORIGINAL size, not the truncated slice — so an agent knows the payload is partial.
    expect(structured["bytes"] as number).toBeGreaterThan(100 * 1024);
  });

  it("list_documents returns each document's id and opening url", async () => {
    await callTool("publish_document", { title: "A", html: "<h1>a</h1>" });
    const { structured } = await callToolFull("list_documents");

    const docs = structured["documents"] as Record<string, unknown>[];
    expect(docs).toHaveLength(1);
    expect(docs[0]!["id"]).toMatch(/^[a-z2-9]{12}$/);
    expect(docs[0]!["url"]).toMatch(/\/v\/default\/[a-z2-9]{12}$/);
    expect(docs[0]!["public"]).toBe(false);
    expect(docs[0]!["sourceKind"]).toBe("html");
  });

  it("search_portal returns matches with where-it-matched, machine-readable", async () => {
    await callTool("publish_document", {
      title: "Architecture",
      html: "<h1>x</h1><p>We chose Debezium.</p>",
      summary: "CDC approach",
    });
    const { structured } = await callToolFull("search_portal", { portal: "default", query: "debezium" });

    expect(structured["portal"]).toBe("default");
    expect(structured["query"]).toBe("debezium");
    const matches = structured["matches"] as Record<string, unknown>[];
    expect(matches).toHaveLength(1);
    expect(matches[0]!["matched"]).toContain("body");
    expect(matches[0]!["url"]).toMatch(/\/v\/default\/[a-z2-9]{12}$/);
  });

  it("list_portals returns slug/kind/documentCount as fields", async () => {
    await seedPortals();
    await callTool("publish_document", { title: "Q3", html: "<h1>x</h1>", portal: "realplus" });

    const { structured } = await callToolFull("list_portals");
    const portals = structured["portals"] as Record<string, unknown>[];
    const realplus = portals.find((p) => p["slug"] === "realplus")!;

    expect(realplus["kind"]).toBe("restricted");
    expect(realplus["documentCount"]).toBe(1);
  });
});

describe("⭐ server_info — what am I connected to, and is it current? (#98)", () => {
  it("reports version, host, and deployedAt as machine-readable fields", async () => {
    const { text, structured } = await callToolFull("server_info");

    // The env vars are baked at deploy; in the test harness they carry the configured values.
    expect(typeof structured["version"]).toBe("string");
    expect(structured["host"]).toBe(HOST); // PUBLIC_HOST in the test config
    expect(structured["releasesUrl"]).toContain("github.com");
    // The prose echoes the same, so a host that shows only text still surfaces it.
    expect(text).toContain("PageVault");
    expect(text).toContain(HOST);
  });

  it("splits the clean semver from the build sha, so a version compare needs no parsing", async () => {
    const { structured } = await callToolFull("server_info");
    // releaseVersion is the `<semver>` half of `<semver>+<sha>` — build metadata never rides along.
    expect(structured["releaseVersion"]).not.toContain("+");
  });

  it("its description tells the model how to check for updates and to admit uncertainty", async () => {
    const payload = await result(await rpc("tools/list"));
    const tools = payload["tools"] as { name: string; description: string }[];
    const info = tools.find((t) => t.name === "server_info")!;

    expect(info.description).toContain("releaseVersion");
    expect(info.description).toContain("pagevault upgrade"); // the update path
    expect(info.description).toContain("say"); // "...say so rather than guessing" — no hallucinated verdict
  });
});

describe("⭐ documents as MCP Resources — the user-addressable half (#82, ADR-016)", () => {
  /** Publish one doc and return its structured id/portal, so a test can address it as a resource. */
  async function publishOne(args: Record<string, unknown>): Promise<{ id: string; portal: string }> {
    const { structured } = await callToolFull("publish_document", args);
    return { id: structured["id"] as string, portal: structured["portal"] as string };
  }

  it("advertises the resources capability at initialize", async () => {
    const init = await result(
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      }),
    );
    expect((init["capabilities"] as Record<string, unknown>)["resources"]).toBeTruthy();
  });

  it("exposes the pagevault://{portal}/{id} template", async () => {
    const payload = await result(await rpc("resources/templates/list"));
    const templates = payload["resourceTemplates"] as { uriTemplate: string }[];
    expect(templates.some((t) => t.uriTemplate === "pagevault://{portal}/{id}")).toBe(true);
  });

  it("lists every published document as an addressable resource", async () => {
    await seedPortals();
    const { id } = await publishOne({ title: "Architecture", html: "<h1>x</h1>", portal: "realplus" });

    const payload = await result(await rpc("resources/list"));
    const resources = payload["resources"] as { uri: string; name: string; mimeType?: string }[];
    const hit = resources.find((r) => r.uri === `pagevault://realplus/${id}`)!;

    expect(hit).toBeTruthy();
    expect(hit.name).toBe("Architecture");
    expect(hit.mimeType).toBe("text/html");
  });

  it("reads a document back through its resource URI — the same source read_document returns", async () => {
    const { id, portal } = await publishOne({ title: "Memo", html: "<h1>the decision</h1>" });

    const payload = await result(await rpc("resources/read", { uri: `pagevault://${portal}/${id}` }));
    const contents = payload["contents"] as { uri: string; mimeType?: string; text?: string }[];

    expect(contents).toHaveLength(1);
    expect(contents[0]!.text).toContain("<h1>the decision</h1>");
    expect(contents[0]!.mimeType).toBe("text/html");
  });

  it("hands markdown back as markdown, with the right mime type", async () => {
    const { id, portal } = await publishOne({
      title: "Notes",
      html: "# Heading\n\n**bold**",
      sourceKind: "markdown",
    });

    const payload = await result(await rpc("resources/read", { uri: `pagevault://${portal}/${id}` }));
    const contents = payload["contents"] as { mimeType?: string; text?: string }[];

    expect(contents[0]!.text).toContain("# Heading");
    expect(contents[0]!.mimeType).toBe("text/markdown");
  });

  it("🔴 refuses a URI whose portal does not match where the document lives", async () => {
    await seedPortals();
    // Published into realplus, then addressed under acme — a handle that lies about its client.
    const { id } = await publishOne({ title: "RealPlus Only", html: "<h1>x</h1>", portal: "realplus" });

    const env = await envelope(await rpc("resources/read", { uri: `pagevault://acme/${id}` }));
    expect(env["error"]).toBeTruthy();
    expect(env["result"]).toBeUndefined();
  });

  it("errors on an unknown document id", async () => {
    const env = await envelope(await rpc("resources/read", { uri: "pagevault://default/zzzzzzzzzzzz" }));
    expect(env["error"]).toBeTruthy();
  });

  it("read tools return resource_link handles into the resource space (design point 4)", async () => {
    const { id } = await publishOne({ title: "Findable", html: "<h1>x</h1>" });

    const { content } = await callToolFull("list_documents");
    const link = content.find((c) => c.type === "resource_link" && c.uri === `pagevault://default/${id}`);

    expect(link).toBeTruthy();
    expect(link!.name).toBe("Findable");
  });

  it("search_portal hits carry resource_link handles too", async () => {
    const { id } = await publishOne({ title: "Debezium Doc", html: "<h1>x</h1><p>We chose Debezium.</p>" });

    const { content } = await callToolFull("search_portal", { portal: "default", query: "debezium" });
    const link = content.find((c) => c.type === "resource_link");

    expect(link?.uri).toBe(`pagevault://default/${id}`);
  });
});

describe("🔴 structured output — the empty-result paths must not throw a protocol error (#81)", () => {
  // The SDK trap: with an outputSchema set, a NON-error success that omits structuredContent
  // becomes a JSON-RPC error, not a tool result. The empty cases are the ones easiest to miss —
  // so each is pinned. callToolFull throws if the reply came back as an error instead.

  it("list_portals with no portals returns an empty array, not an error", async () => {
    const { text, structured } = await callToolFull("list_portals");
    expect(text).toContain("No portals yet.");
    expect(structured["portals"]).toEqual([]);
  });

  it("list_documents with no documents returns an empty array, not an error", async () => {
    const { text, structured } = await callToolFull("list_documents");
    expect(text).toContain("No documents found.");
    expect(structured["documents"]).toEqual([]);
  });

  it("search_portal with no matches returns an empty array, not an error", async () => {
    await callTool("publish_document", { title: "A", html: "<h1>a</h1>" });
    const { text, structured } = await callToolFull("search_portal", { portal: "default", query: "nothingmatchesthis" });

    expect(text).toContain("No matches");
    expect(structured["matches"]).toEqual([]);
    // The query and portal still come back, so an agent can report what it searched.
    expect(structured["query"]).toBe("nothingmatchesthis");
    expect(structured["portal"]).toBe("default");
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

  it("publishes markdown via sourceKind and reads the markdown source back (#63)", async () => {
    const out = await callTool("publish_document", {
      title: "Notes",
      html: "# Heading\n\nSome **markdown** body.",
      sourceKind: "markdown",
    });
    expect(out).toContain("Published");
    const id = /\/v\/default\/([a-z2-9]{12})/.exec(out)?.[1];
    expect(id).toBeTruthy();

    // read_document returns the ORIGINAL source — the .md the author wrote, not the rendered HTML.
    const doc = await callTool("read_document", { id: id! });
    expect(doc).toContain("# Heading");
    expect(doc).toContain("**markdown**");
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

  it("🔴 matches every term non-adjacently, across fields — not phrase-contiguous (#19)", async () => {
    await callTool("publish_document", {
      title: "Data Warehouse Architecture Review",
      html: "<h1>Architecture</h1><p>We chose Debezium for CDC on V2.</p>",
      summary: "CDC approach and the retire/wrap/rebuild roadmap",
      tags: ["type:architecture"],
    });
    await callTool("publish_document", { title: "Q3 Report", html: "<h1>unrelated</h1>" });

    // "CDC" is in the summary, "V2" only in the body — two terms, non-adjacent, spanning fields.
    // The old phrase-only matcher returned zero for this; AND-of-terms finds it.
    const out = await callTool("search_portal", { portal: "default", query: "CDC V2" });

    expect(out).toContain("Data Warehouse Architecture Review");
    expect(out).toContain("matched: summary, body");
    expect(out).not.toContain("Q3 Report");
  });

  it("excludes a document when any single term is absent (#19)", async () => {
    await callTool("publish_document", {
      title: "Architecture",
      html: "<h1>x</h1><p>We chose Debezium for CDC on V2.</p>",
      summary: "CDC approach",
    });

    const out = await callTool("search_portal", { portal: "default", query: "CDC banana" });
    expect(out).toContain("No matches");
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

  it("revoke_public_link kills the /p/ link but keeps the document (#73)", async () => {
    const pub = await callTool("publish_document", { title: "Memo", html: "<h1>x</h1>" });
    const id = /\/v\/default\/([a-z2-9]{12})/.exec(pub)![1]!;
    const minted = /\/p\/([a-z2-9]{22})/.exec(await callTool("mint_public_link", { id }))![1]!;

    const out = await callTool("revoke_public_link", { id });

    expect(out).toContain("revoked");
    // The link is dead...
    expect(await env.PAGEVAULT.get(`pub:${minted}`)).toBeNull();
    // ...but the document is not — revoke_public_link is not revoke_document.
    expect(await env.PAGEVAULT.get(`doc:${id}`)).not.toBeNull();
  });

  it("rotate_public_link swaps the link for a fresh one and warns it is a capability URL (#73)", async () => {
    const pub = await callTool("publish_document", { title: "Memo", html: "<h1>x</h1>" });
    const id = /\/v\/default\/([a-z2-9]{12})/.exec(pub)![1]!;
    const old = /\/p\/([a-z2-9]{22})/.exec(await callTool("mint_public_link", { id }))![1]!;

    const out = await callTool("rotate_public_link", { id });
    const fresh = /\/p\/([a-z2-9]{22})/.exec(out)![1]!;

    expect(fresh).not.toBe(old);
    expect(out).toContain("capability URL");
    expect(await env.PAGEVAULT.get(`pub:${old}`)).toBeNull(); // old link dead
    expect(await env.PAGEVAULT.get(`pub:${fresh}`)).toBe(id); // new link live
  });
});

describe("🔴 email grants sync to the Access group (ADR-002 hot path)", () => {
  // The test env has empty CF_ACCOUNT_ID / CF_ACCESS_GROUP_ID, so the sync is `not_configured`
  // and makes no network call — the Tier-0 shape. We assert the wiring surfaces that, loudly,
  // because a grant that KV accepts but Access silently blocks is the exact bug #20 fixes.

  it("publish_document with emails says loudly that Access will not admit them in Tier 0", async () => {
    const out = await callTool("publish_document", {
      title: "Board Deck",
      html: "<h1>x</h1>",
      emails: ["cfo@acme.com"],
    });

    expect(out).toContain("Shared: cfo@acme.com");
    expect(out).toContain("Email-secured access is not enabled");
  });

  it("publish_document with NO emails never mentions Access admission", async () => {
    const out = await callTool("publish_document", { title: "Memo", html: "<h1>x</h1>" });
    expect(out).not.toContain("Email-secured access is not enabled");
  });

  it("update_portal_members add warns that the new member will not be admitted in Tier 0", async () => {
    await seedPortals();

    const out = await callTool("update_portal_members", { portal: "realplus", add: ["newhire@realplus.com"] });

    expect(out).toContain("newhire@realplus.com");
    expect(out).toContain("Email-secured access is not enabled");
  });

  it("update_portal_members remove notes that the seat persists until reconcile", async () => {
    await seedPortals();

    const out = await callTool("update_portal_members", { portal: "realplus", remove: ["cto@realplus.com"] });

    expect(out).toContain("until 'sync-access' reconciles");
    // Removal is not the hot path — it must not claim an Access sync happened.
    expect(out).not.toContain("Email-secured access is not enabled");
  });
});

describe("view metrics ride along with the read tools (#127)", () => {
  /**
   * The metrics reach MCP by sync, never by query — the Worker holds no analytics credential
   * (ADR-019). What these assert is the *honesty* half: absent when unmeasured, zero only when
   * genuinely measured, and always stamped with when the sync ran.
   */
  const SYNCED = "2026-07-29T12:00:00.000Z";

  // v2 (#161): docs map to sparse day buckets rather than lifetime totals, so the fixtures name a
  // day. `coverage` is what the merge clears by, and it is stated rather than inferred from a
  // window length — see mergeSummary.
  const sync = (docs: Record<string, unknown>, syncedAt = SYNCED) =>
    SELF.fetch(`${HOST}/api/views/summary`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ v: 2, syncedAt, coverage: { from: "2026-05-01", to: "2026-07-29" }, docs, portals: {} }),
    });

  /** Publish through MCP, then backdate it so it falls inside the measured window. */
  async function publishBackdated(title: string): Promise<string> {
    const { structured } = await callToolFull("publish_document", { title, html: `<h1>${title}</h1>` });
    const id = structured["id"] as string;
    const { getMeta, putMeta } = await import("../src/store.js");
    const meta = (await getMeta(env, id))!;
    await putMeta(env, { ...meta, createdAt: "2026-01-01T00:00:00.000Z" });
    return id;
  }

  beforeEach(async () => {
    await env.PAGEVAULT.delete("views:summary");
  });

  it("read_document carries no view fields until a sync has run", async () => {
    const id = await publishBackdated("Unmeasured");
    const { structured } = await callToolFull("read_document", { id });

    // Absent, not zero: an agent must not be able to say "the client never opened it" on the
    // strength of a number nobody ever measured.
    expect(structured["views"]).toBeUndefined();
    expect(structured["viewsSyncedAt"]).toBeUndefined();
  });

  it("read_document reports counts, surfaces and when they were measured", async () => {
    const id = await publishBackdated("Measured");
    await sync({ [id]: { "2026-07-28": { link: 3, portal: 1, t: "09:00:00" } } });

    const { structured, text } = await callToolFull("read_document", { id });

    expect(structured).toMatchObject({ views: 4, viewsSyncedAt: SYNCED });
    expect(structured["surfaces"]).toEqual({ link: 3, public: 0, portal: 1 });
    // The prose half carries it too — a host that shows only text must not lose the caveat.
    expect(text).toContain("views: 4");
    expect(text).toContain("as of 2026-07-29");
  });

  it("says 'not opened yet' in prose for a measured zero", async () => {
    const id = await publishBackdated("Ignored");
    await sync({});

    const { structured, text } = await callToolFull("read_document", { id });
    expect(structured["views"]).toBe(0);
    // "0 views" is the datum; "not opened yet" is the sentence the operator actually wants back.
    expect(text).toContain("not opened yet");
  });

  it("list_documents stamps the listing once and never leaks a viewer identity", async () => {
    const id = await publishBackdated("Listed");
    await sync({ [id]: { "2026-07-28": { link: 2, t: "09:00:00" } } });

    const { structured, text } = await callToolFull("list_documents", {});

    expect(structured["viewsSyncedAt"]).toBe(SYNCED);
    const docs = structured["documents"] as Record<string, unknown>[];
    expect(docs.find((d) => d["id"] === id)).toMatchObject({ views: 2 });
    // ADR-019 decision 4: counts and surfaces reach the model, emails do not.
    expect(JSON.stringify(structured)).not.toMatch(/@[a-z]+\.(com|org)/);
    expect(text).toContain("views: 2");
    // Once at the foot, and in the PROSE: a host that renders only text would otherwise show a
    // column of counts with nothing saying when they were measured.
    expect(text).toContain("as of the last sync, 2026-07-29 — not live");
    expect(text.match(/as of the last sync/g)).toHaveLength(1);
  });

  it("says nothing about staleness when there is nothing to be stale", async () => {
    await publishBackdated("No Sync Yet");
    const { text } = await callToolFull("list_documents", {});
    expect(text).not.toContain("as of the last sync");
  });

  it("both read tools tell the model the numbers are as of the sync, not live", async () => {
    const res = await result(await rpc("tools/list"));
    const tools = res["tools"] as { name: string; description: string }[];

    for (const name of ["read_document", "list_documents"]) {
      const tool = tools.find((t) => t.name === name)!;
      // Without this the model reports a three-day-old count as if it just looked — the exact
      // liability ADR-019 decision 6 names.
      expect(tool.description).toContain("viewsSyncedAt");
      expect(tool.description).toContain("not from");
    }
  });
});

describe("/mcp — traffic (#163)", () => {
  const SYNCED = "2026-07-30T09:00:00.000Z";
  const today = new Date().toISOString().slice(0, 10);

  const sync = (
    docs: Record<string, unknown>,
    portals: Record<string, unknown> = {},
    refs?: Record<string, unknown>,
  ) =>
    SELF.fetch(`${HOST}/api/views/summary`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        v: 2,
        syncedAt: SYNCED,
        coverage: { from: "2026-05-01", to: today },
        docs,
        portals,
        ...(refs ? { refs } : {}),
      }),
    });

  async function publishBackdated(title: string): Promise<string> {
    const { structured } = await callToolFull("publish_document", { title, html: `<h1>${title}</h1>` });
    const id = structured["id"] as string;
    const { getMeta, putMeta } = await import("../src/store.js");
    const meta = (await getMeta(env, id))!;
    await putMeta(env, { ...meta, createdAt: "2026-01-01T00:00:00.000Z" });
    return id;
  }

  beforeEach(async () => {
    await env.PAGEVAULT.delete("views:summary");
  });

  it("🔴 never-synced is said in words, not reported as zero views", async () => {
    // An agent that reads "0" will tell the operator the client never opened it. That is a
    // different claim from "nothing has been measured", and it is the one thing a deployment
    // with no history cannot support.
    const { text, structured } = await callToolFull("traffic");
    expect(text).toContain("No view history has been captured yet");
    expect(text).toContain("NOT zero views");
    expect(text).toContain("pagevault sync-views");
    expect(structured["state"]).toBe("never-synced");
    expect(structured["syncedAt"]).toBeNull();
  });

  it("reports totals and a breakdown, from the same rollup the CLI and console read", async () => {
    const id = await publishBackdated("Measured");
    await sync({ [id]: { [today]: { link: 5, portal: 2, t: "10:00:00" } } }, { default: { "": 3, "news.ycombinator.com": 2 } });

    const { text, structured } = await callToolFull("traffic", { days: 30 });
    expect(structured["state"]).toBe("ok");
    expect(structured["total"]).toMatchObject({ views: 7 });
    expect((structured["byDoc"] as Record<string, unknown>[])[0]).toMatchObject({ id, views: 7 });
    expect(text).toContain("7 views");
  });

  it("🔴 staleness is in the PROSE, not only in structuredContent", async () => {
    // A host that renders only text would otherwise show a column of numbers with no "as of",
    // which reads as live. ADR-019 decision 6.
    const id = await publishBackdated("Stale");
    await sync({ [id]: { [today]: { link: 1 } } });

    const { text, structured } = await callToolFull("traffic");
    expect(text).toContain("As of the last sync, 2026-07-30");
    expect(text).toContain("not live");
    expect(structured["syncedAt"]).toBe(SYNCED);
  });

  it("🔴 carries counts and surfaces, and no identity anywhere", async () => {
    // Not a redaction — the stored summary has never held a viewer (ADR-019 decision 4). Pinned
    // so a later change that starts storing one cannot leak it through this tool by default.
    const id = await publishBackdated("No Identities");
    await sync({ [id]: { [today]: { portal: 4, owner: 2 } } });

    const { structured } = await callToolFull("traffic");
    const serialized = JSON.stringify(structured);
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain("viewer");
    expect(serialized).not.toContain("owner");
    expect(structured["total"]).toMatchObject({ surfaces: { link: 0, public: 0, portal: 4 } });
  });

  it("🔴 --by referrer warns when the counts ignore the window", async () => {
    // An UNDATED summary — the legacy per-portal map, with no date to filter on. A model repeating
    // a windowed heading over these would state a wrong number, so the prose has to contradict it.
    const id = await publishBackdated("Referred");
    await sync({ [id]: { [today]: { link: 1 } } }, { default: { "t.co": 9 } });

    const { text } = await callToolFull("traffic", { by: "referrer" });
    expect(text).toContain("IGNORE the window");
    expect(text).toContain("t.co: 9");
  });

  it("🔴 and says nothing of the sort once a dated series exists", async () => {
    // The warning is conditional, not decoration. Emitting it unconditionally is how the old
    // "ALL-TIME" claim survived so long being wrong about its own data (#221).
    const id = await publishBackdated("Referred");
    await sync(
      { [id]: { [today]: { link: 1 } } },
      { default: { "t.co": 9 } },
      { default: { [today]: { "t.co": 9 } } },
    );

    const { text } = await callToolFull("traffic", { by: "referrer" });
    expect(text).not.toContain("IGNORE the window");
    expect(text).toContain("t.co: 9");
  });

  it("a portal filter narrows the answer", async () => {
    const id = await publishBackdated("In Default");
    await sync({ [id]: { [today]: { link: 3 } } });

    const { structured } = await callToolFull("traffic", { portal: "nonexistent" });
    expect(structured["byDoc"]).toEqual([]);
    expect(structured["total"]).toMatchObject({ views: 0 });
  });

  it("--by surface names each door in words the operator uses", async () => {
    // The split is only useful if the reader knows a "link" view arrived through a /p/ capability
    // URL that needs no login. Raw keys make them look up the vocabulary.
    const id = await publishBackdated("Doors");
    await sync({ [id]: { [today]: { link: 4, portal: 2, pub: 1 } } });

    const { text } = await callToolFull("traffic", { by: "surface" });
    expect(text).toContain("portal (signed in): 2");
    expect(text).toContain("link (capability URL, no login): 4");
    expect(text).toContain("public (listed portal page): 1");
  });

  it("the tool description tells the model the numbers are not live", async () => {
    const payload = await result(await rpc("tools/list"));
    const tools = payload["tools"] as { name: string; description: string }[];
    const traffic = tools.find((t) => t.name === "traffic")!;
    expect(traffic.description).toContain("NOT from live traffic");
    expect(traffic.description).toContain("never imply");
    // And that it is the wrong tool for "did this person open it".
    expect(traffic.description).toContain("never reports WHO");
  });
});

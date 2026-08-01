import { describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolCatalog } from "../../tools/catalog.js";
import { buildManifest, registerCompactTools, summarize } from "../../tools/compact.js";
import { collectToolCatalog, registerFullTools } from "../../tools/index.js";

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** A small catalog standing in for the real tool surface. */
function fakeCatalog(): ToolCatalog {
  const catalog = new ToolCatalog();
  const registrar = catalog.asRegistrar();
  catalog.setCategory("generation");
  registrar.tool(
    "gen_image",
    "Generate an image from a prompt. Long tail of details that should not appear in the manifest one-liner.",
    {
      prompt: z.string().describe("The prompt."),
      steps: z.number().int().min(1).max(100).optional().describe("Sampling steps."),
    },
    async (args: { prompt: string; steps?: number }) => ({
      content: [{ type: "text" as const, text: `generated:${args.prompt}:${args.steps ?? "default"}` }],
    }),
  );
  catalog.setCategory("diagnostics");
  registrar.tool(
    "ping",
    "Report server liveness.",
    {},
    async () => ({ content: [{ type: "text" as const, text: "pong" }] }),
  );
  registrar.tool(
    "always_throws",
    "A tool whose handler throws.",
    {},
    async () => {
      throw new Error("boom");
    },
  );
  return catalog;
}

async function compactPair(catalog: ToolCatalog): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerCompactTools(server, catalog);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("ToolCatalog", () => {
  it("captures 4-arg server.tool() registrations with category and schema", () => {
    const catalog = fakeCatalog();
    expect(catalog.tools.size).toBe(3);
    const gen = catalog.get("gen_image");
    expect(gen?.category).toBe("generation");
    expect(gen?.description).toMatch(/^Generate an image/);
    expect(Object.keys(gen?.schema ?? {})).toEqual(["prompt", "steps"]);
  });

  it("keeps the first registration on duplicate names", () => {
    const catalog = new ToolCatalog();
    const registrar = catalog.asRegistrar();
    registrar.tool("dup", "first", {}, async () => ({ content: [] }));
    registrar.tool("dup", "second", {}, async () => ({ content: [] }));
    expect(catalog.get("dup")?.description).toBe("first");
  });

  it("groups tools by category in first-seen order", () => {
    const grouped = fakeCatalog().byCategory();
    expect([...grouped.keys()]).toEqual(["generation", "diagnostics"]);
    expect(grouped.get("diagnostics")?.map((t) => t.name)).toEqual(["ping", "always_throws"]);
  });
});

describe("summarize", () => {
  it("keeps only the first sentence", () => {
    expect(summarize("Does a thing. Also does another thing.")).toBe("Does a thing.");
  });

  it("caps runaway first sentences with an ellipsis", () => {
    const line = summarize(`${"word ".repeat(60)}end.`, 80);
    expect(line.length).toBeLessThanOrEqual(80);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("buildManifest", () => {
  it("lists every tool grouped by category with one-line summaries", () => {
    const manifest = buildManifest(fakeCatalog());
    expect(manifest).toContain("3 of 3 tools");
    expect(manifest).toContain("## generation (1)");
    expect(manifest).toContain("## diagnostics (2)");
    expect(manifest).toContain("- gen_image: Generate an image from a prompt.");
    expect(manifest).not.toContain("Long tail of details");
  });

  it("filters by category and search", () => {
    expect(buildManifest(fakeCatalog(), { category: "diagnostics" })).not.toContain("gen_image");
    expect(buildManifest(fakeCatalog(), { search: "liveness" })).toContain("ping");
    expect(buildManifest(fakeCatalog(), { search: "liveness" })).not.toContain("gen_image");
  });

  it("search also matches parameter names and descriptions", () => {
    // "sampling" appears only in gen_image's steps param description
    const manifest = buildManifest(fakeCatalog(), { search: "sampling" });
    expect(manifest).toContain("gen_image");
    expect(manifest).not.toContain("- ping");
  });

  it("filtered views carry a broaden-your-search hint", () => {
    expect(buildManifest(fakeCatalog(), { search: "liveness" })).toContain("FILTERED view");
    expect(buildManifest(fakeCatalog())).not.toContain("FILTERED view");
  });

  it("suggests categories when nothing matches", () => {
    const manifest = buildManifest(fakeCatalog(), { search: "no-such-thing" });
    expect(manifest).toContain("No tools matched");
    expect(manifest).toContain("generation, diagnostics");
  });
});

describe("compact mode over a real MCP client/server pair", () => {
  it("exposes exactly the three meta-tools", async () => {
    const client = await compactPair(fakeCatalog());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["call_tool", "describe_tool", "list_tools"]);
  });

  it("list_tools returns the manifest", async () => {
    const client = await compactPair(fakeCatalog());
    const res = await client.callTool({ name: "list_tools", arguments: {} });
    expect(textOf(res as never)).toContain("- ping: Report server liveness.");
  });

  it("describe_tool returns the full description and JSON schema", async () => {
    const client = await compactPair(fakeCatalog());
    const res = await client.callTool({ name: "describe_tool", arguments: { name: "gen_image" } });
    const text = textOf(res as never);
    expect(text).toContain("Long tail of details");
    expect(text).toContain('"prompt"');
    expect(text).toContain('"required"');
  });

  it("call_tool dispatches to the underlying handler", async () => {
    const client = await compactPair(fakeCatalog());
    const res = await client.callTool({
      name: "call_tool",
      arguments: { name: "gen_image", args: { prompt: "a cat", steps: 4 } },
    });
    expect(textOf(res as never)).toBe("generated:a cat:4");
  });

  it("call_tool accepts JSON-string args (small models double-encode)", async () => {
    const client = await compactPair(fakeCatalog());
    const res = await client.callTool({
      name: "call_tool",
      arguments: { name: "gen_image", args: '{"prompt": "a dog"}' },
    });
    expect(textOf(res as never)).toBe("generated:a dog:default");
  });

  it("call_tool works with omitted args for zero-arg tools", async () => {
    const client = await compactPair(fakeCatalog());
    const res = await client.callTool({ name: "call_tool", arguments: { name: "ping" } });
    expect(textOf(res as never)).toBe("pong");
  });

  it("call_tool returns a schema-bearing validation error on bad args", async () => {
    const client = await compactPair(fakeCatalog());
    const res = (await client.callTool({
      name: "call_tool",
      arguments: { name: "gen_image", args: { steps: 4 } },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    const text = textOf(res as never);
    expect(text).toContain("Invalid arguments for gen_image");
    expect(text).toContain("prompt");
    expect(text).toContain("Expected schema");
  });

  it("call_tool and describe_tool suggest alternatives for unknown names", async () => {
    const client = await compactPair(fakeCatalog());
    const res = (await client.callTool({
      name: "call_tool",
      arguments: { name: "gen" },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(textOf(res as never)).toContain("gen_image");
  });

  it("call_tool converts handler throws into isError results", async () => {
    const client = await compactPair(fakeCatalog());
    const res = (await client.callTool({
      name: "call_tool",
      arguments: { name: "always_throws" },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(textOf(res as never)).toContain("boom");
  });
});

describe("full mode + facade escape hatch (#616)", () => {
  // A code-execution MCP client snapshots the tool surface from tools/list and
  // exposes each as a callable `tools.mcp__comfyui__<tool>`. After a ComfyUI
  // restart + panel resume that snapshot can go stale and a cached direct
  // binding throws "is not a function". registerFullTools guarantees the direct
  // surface AND the facade (list_tools/describe_tool/call_tool) are advertised
  // together as ONE consistent snapshot, so `call_tool` is always a stable
  // route to any direct tool.
  async function fullPair(opts?: { facade?: boolean }): Promise<Client> {
    const server = new McpServer({ name: "test-full", version: "0.0.0" });
    await registerFullTools(server, opts);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-full-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("advertises the direct tools AND the facade as one consistent snapshot", async () => {
    const client = await fullPair();
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    // Direct tools survive (the ones that vanished for the reporter).
    for (const t of ["get_environment", "health_check", "list_local_models", "calculate"]) {
      expect(names.has(t), `full surface missing direct tool ${t}`).toBe(true);
    }
    // Facade escape hatch is present alongside them.
    for (const f of ["list_tools", "describe_tool", "call_tool"]) {
      expect(names.has(f), `full surface missing facade tool ${f}`).toBe(true);
    }
  }, 30_000);

  it("routes a direct tool through call_tool (transparent fallback for a stale binding)", async () => {
    const client = await fullPair();
    // `calculate` is a pure, offline tool (no ComfyUI connection) — a safe stand-in
    // for the reporter's get_environment. Reaching it via call_tool proves the
    // facade dispatches to the SAME direct handler, so a client that lost the
    // direct binding across a reconnect never dead-ends.
    const res = await client.callTool({
      name: "call_tool",
      arguments: { name: "calculate", args: { spec: "2 + 2" } },
    });
    const text = textOf(res as never);
    expect(text).not.toContain("Unknown tool");
    expect((res as { isError?: boolean }).isError).not.toBe(true);
    expect(text).toContain("4");
  }, 30_000);

  it("honors { facade: false } (COMFYUI_MCP_NO_FACADE opt-out) — direct tools only", async () => {
    const client = await fullPair({ facade: false });
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    expect(names.has("get_environment")).toBe(true);
    for (const f of ["list_tools", "describe_tool", "call_tool"]) {
      expect(names.has(f), `facade should be absent when opted out (${f})`).toBe(false);
    }
  }, 30_000);

  it("honors COMFYUI_MCP_NO_FACADE=1 via env (no opts) — direct tools only", async () => {
    const prev = process.env.COMFYUI_MCP_NO_FACADE;
    process.env.COMFYUI_MCP_NO_FACADE = "1";
    try {
      const client = await fullPair(); // no opts → env decides
      const names = new Set((await client.listTools()).tools.map((t) => t.name));
      expect(names.has("get_environment")).toBe(true);
      expect(names.has("call_tool")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.COMFYUI_MCP_NO_FACADE;
      else process.env.COMFYUI_MCP_NO_FACADE = prev;
    }
  }, 30_000);
});

describe("facade collision guard (#616 / codex P1)", () => {
  // If a direct tool already claims a facade meta-tool name (e.g. an autoloaded
  // workflow named `call_tool`), the live McpServer would throw on the duplicate
  // registration and crash startup. The guarantee here is: startup never crashes,
  // the first (direct) registration keeps the name, and the rest of the facade
  // still registers. A workflow named after a reserved meta is a namespace
  // conflict the user created; we warn rather than silently hijack it.
  it("skips a reserved name via the skip set without throwing", async () => {
    const server = new McpServer({ name: "test-collide", version: "0.0.0" });
    // A "direct" tool that squats the call_tool name (stands in for a workflow file).
    server.tool("call_tool", "A workflow that happens to be named call_tool.", {}, async () => ({
      content: [{ type: "text" as const, text: "workflow-call_tool" }],
    }));
    const catalog = fakeCatalog();
    // Would throw "call_tool is already registered" without the skip guard.
    expect(() => registerCompactTools(server, catalog, { skip: new Set(["call_tool"]) })).not.toThrow();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    // The direct tool survives; the other two metas still register.
    expect(names.has("call_tool")).toBe(true);
    expect(names.has("list_tools")).toBe(true);
    expect(names.has("describe_tool")).toBe(true);
    // And the surviving call_tool is the DIRECT one, not the facade meta.
    const res = await client.callTool({ name: "call_tool", arguments: {} });
    expect(textOf(res as never)).toBe("workflow-call_tool");
  });

  it("does NOT crash even when skip MISSES the collision (the pass-1/pass-2 race backstop)", async () => {
    // Simulates codex P1b: the catalog-based skip set fails to include a name that
    // is actually already on the live server (e.g. a reserved-name workflow removed
    // between the two discovery passes). registerCompactTools's try/catch must
    // swallow the duplicate-registration throw instead of crashing startup.
    const server = new McpServer({ name: "test-race", version: "0.0.0" });
    server.tool("list_tools", "A workflow squatting list_tools.", {}, async () => ({
      content: [{ type: "text" as const, text: "workflow-list_tools" }],
    }));
    // No skip set → the wrapper attempts to register list_tools again and must NOT throw.
    expect(() => registerCompactTools(server, fakeCatalog())).not.toThrow();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    // The other two metas still register; the squatting direct tool keeps its name.
    expect(names.has("describe_tool")).toBe(true);
    expect(names.has("call_tool")).toBe(true);
    const res = await client.callTool({ name: "list_tools", arguments: {} });
    expect(textOf(res as never)).toBe("workflow-list_tools");
  });
});

describe("collectToolCatalog (real tool surface)", () => {
  it("captures the full registered tool surface with schemas intact", async () => {
    const catalog = await collectToolCatalog();
    expect(catalog.tools.size).toBeGreaterThanOrEqual(100);
    for (const expected of ["generate_image", "health_check", "enqueue_workflow", "list_local_models"]) {
      expect(catalog.get(expected), `missing ${expected}`).toBeDefined();
      expect(catalog.get(expected)?.description.length).toBeGreaterThan(20);
    }
    // every static category from the registration table shows up
    const categories = [...catalog.byCategory().keys()];
    for (const c of ["generation", "workflows", "models", "custom-nodes", "server", "diagnostics"]) {
      expect(categories, `missing category ${c}`).toContain(c);
    }
    // and the manifest over the real surface stays token-light (< ~30KB ≈ 7k tokens)
    const manifest = buildManifest(catalog);
    expect(manifest.length).toBeLessThan(30_000);
  }, 30_000);
});

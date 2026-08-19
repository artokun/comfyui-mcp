import { describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolCatalog } from "../../tools/catalog.js";
import {
  buildManifest,
  contextualizeBareParseError,
  registerCompactTools,
  summarize,
} from "../../tools/compact.js";
import { collectToolCatalog, registerFullTools } from "../../tools/index.js";
import { TOOL_NAMES } from "../../tools/vocabulary.js";

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

  // #1525 — `list_tools search:"download model"` returned ONLY `runpod`. The filter
  // was matching the literal PHRASE, so `download_model` (an identifier, spelled
  // with an underscore) never contained it, while an unrelated tool whose prose
  // happens to say "download model" did. The one tool the caller obviously wanted
  // was the one excluded, and the only hit was the coincidence.
  function separatorCatalog(): ToolCatalog {
    const catalog = new ToolCatalog();
    const r = catalog.asRegistrar();
    // Category is set on the catalog, not passed per tool — matching fakeCatalog
    // above and the real registration order.
    catalog.setCategory("models");
    r.tool("download_model", "Download a model file to the local install.", {}, async () => ({ content: [] }));
    r.tool("list_local_models", "List installed checkpoints.", {}, async () => ({ content: [] }));
    catalog.setCategory("cloud");
    r.tool("runpod", "Manage pods. You can download model files onto a pod.", {}, async () => ({ content: [] }));
    // Terms deliberately FAR APART and in neither order, so a phrase match cannot
    // pass by accident. The download_model fixture cannot serve this: its corpus
    // reads "download model download a model file…", which contains the reversed
    // phrase "model download" by sheer concatenation — a surviving mutation is
    // what exposed that, and the test it made vacuous looked perfectly good.
    catalog.setCategory("system");
    r.tool("clear_vram", "Free GPU memory held by the cache after a long run.", {}, async () => ({ content: [] }));
    return catalog;
  }

  it("matches an identifier when the caller types it with a SPACE (#1525)", () => {
    const manifest = buildManifest(separatorCatalog(), { search: "download model" });

    // The reporter's tool is present — this is the whole bug.
    expect(manifest).toContain("download_model");
    // And it is the ONLY result: the tool whose NAME says it wins outright over
    // one that merely mentions downloading models in prose. Measured against the
    // real 37-tool surface, term-matching alone returned 10 tools here and 19 for
    // "install node" — findable, but still the "misleading filter" the report is
    // actually about.
    expect(manifest).toContain("1 of 4 tools");
    expect(manifest).not.toContain("runpod");
    expect(manifest).not.toContain("list_local_models");
  });

  it("falls back to the full corpus when NO name matches", () => {
    // The name tier must not cost the corpus search that makes parameter and
    // description text findable — "liveness" and "sampling" appear in no tool
    // name at all, and those cases are why the corpus search exists.
    const manifest = buildManifest(separatorCatalog(), { search: "checkpoints" });
    expect(manifest).toContain("list_local_models");
    expect(manifest).not.toContain("download_model");
  });

  it("matches with the separator typed either way round", () => {
    // Both spellings of the same intent must work, in both directions.
    expect(buildManifest(separatorCatalog(), { search: "download_model" })).toContain("download_model");
    expect(buildManifest(separatorCatalog(), { search: "DOWNLOAD MODEL" })).toContain("download_model");
    // A hyphenated query for an underscored name.
    expect(buildManifest(separatorCatalog(), { search: "download-model" })).toContain("download_model");
  });

  it("matches terms in ANY order and NOT adjacent (#1525)", () => {
    // "run" and "memory" both appear in clear_vram's description, far apart, in
    // neither given order — and no tool NAME carries both, so this exercises the
    // corpus tier specifically. A literal phrase match finds nothing here.
    expect(buildManifest(separatorCatalog(), { search: "run memory" })).toContain("clear_vram");
    expect(buildManifest(separatorCatalog(), { search: "memory run" })).toContain("clear_vram");
  });

  it("scopes the NAME tier to the category being browsed", () => {
    // Computed over the whole catalog, a name hit in ANOTHER category suppressed
    // the corpus results inside the one the caller asked for — the tier silently
    // emptying the very view being browsed. Within a category the question is
    // "which of THESE", so the tier is answered from the set the loop will show.
    const manifest = buildManifest(separatorCatalog(), { category: "cloud", search: "download model" });

    // `download_model` is in `models`, so it cannot appear here...
    expect(manifest).not.toContain("download_model");
    // ...and `runpod`, which mentions downloading model files, is the honest
    // answer for this category rather than an empty result.
    expect(manifest).toContain("runpod");
  });

  it("DISCLOSES that results were chosen by name, and how many it withheld", () => {
    // The name tier is narrowing, not preserving: "download model" used to return
    // runpod and no longer does. A caller who cannot tell a name-tier result from
    // "everything that matched" will read a one-line answer as the whole answer.
    const manifest = buildManifest(separatorCatalog(), { search: "download model" });

    expect(manifest).toContain("Showing tools whose NAME matches");
    // Counted, not hand-waved: runpod is the one tool the corpus search would
    // have returned here and this view is not showing.
    expect(manifest).toContain("1 other tool(s) also match");
    // It must NOT claim WHERE those tools matched. The corpus includes the name,
    // so a tool taking one term from its name and the rest from its description
    // is counted correctly while "matches in its description or parameters" would
    // be false for it — an accurate number wrapped in an inaccurate sentence.
    expect(manifest).not.toMatch(/mention these terms in their description/);
  });

  it("says nothing about a name tier when the corpus answered", () => {
    // No tool NAME contains both terms, so nothing was withheld and the note must
    // not appear — otherwise it would read as though results were being hidden.
    const manifest = buildManifest(separatorCatalog(), { search: "run memory" });

    expect(manifest).toContain("clear_vram");
    expect(manifest).not.toContain("Showing tools whose NAME matches");
  });

  it("keeps dots and slashes LITERAL (codex)", () => {
    // Folding them bought nothing — no tool name has one — and cost precision:
    // "v1.2" would split into "v1" + "2", each matching anywhere.
    const catalog = new ToolCatalog();
    const r = catalog.asRegistrar();
    catalog.setCategory("misc");
    r.tool("alpha", "Handles v1.2 payloads.", {}, async () => ({ content: [] }));
    r.tool("beta", "Handles v1 and takes 2 arguments.", {}, async () => ({ content: [] }));

    const manifest = buildManifest(catalog, { search: "v1.2" });
    expect(manifest).toContain("alpha");
    // `beta` would match if the dot were folded into a term separator.
    expect(manifest).not.toContain("- beta");
  });

  it("requires EVERY term, so multi-word search still narrows", () => {
    // Order-independent, but not an OR: a tool matching only one term is excluded.
    const both = buildManifest(separatorCatalog(), { search: "model download" });
    expect(both).toContain("download_model");

    const onlyOne = buildManifest(separatorCatalog(), { search: "download checkpoints" });
    // list_local_models has "checkpoints" but not "download"; download_model the
    // reverse. Neither has both, so neither matches.
    expect(onlyOne).toContain("No tools matched");
  });

  it("treats a whitespace-only search as no search at all", () => {
    const manifest = buildManifest(separatorCatalog(), { search: "   " });
    expect(manifest).toContain("4 of 4 tools");
    expect(manifest).not.toContain("FILTERED view");
    // The HEADER too. It used to test raw `opts.search`, so a whitespace-only
    // query stamped "(filtered)" onto a complete catalog — the behaviour was
    // right and this one line disagreed with it, which is exactly the sort of
    // half-true label this file keeps having to correct.
    expect(manifest).not.toContain("(filtered)");
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

  it("routes describe_tool through the stable call_tool facade when its direct binding is stale (#693)", async () => {
    const client = await compactPair(fakeCatalog());
    const res = (await client.callTool({
      name: "call_tool",
      arguments: { name: "describe_tool", args: { name: "gen_image" } },
    })) as { isError?: boolean };
    const text = textOf(res as never);
    expect(res.isError).not.toBe(true);
    expect(text).toContain("# gen_image");
    expect(text).toContain("Long tail of details");
    expect(text).toContain('"prompt"');
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

  // #1824 — ChatGPT multi_tool_use.parallel names each recipient payload
  // `parameters`. After the first functions.call_tool in a batch the model
  // copies that key inward instead of `args`. The SDK Zod shape used to
  // strip the unknown field, so download_model (and anything with a required
  // action) saw an empty object and failed with "action: Invalid option".
  it("call_tool accepts parameters as an alias for args (#1824)", async () => {
    const client = await compactPair(fakeCatalog());
    const res = (await client.callTool({
      name: "call_tool",
      arguments: { name: "gen_image", parameters: { prompt: "a cat", steps: 4 } },
    })) as { isError?: boolean };
    expect(res.isError).not.toBe(true);
    expect(textOf(res as never)).toBe("generated:a cat:4");
  });

  it("call_tool prefers args over a colliding parameters wrapper (#1824)", async () => {
    const client = await compactPair(fakeCatalog());
    const res = (await client.callTool({
      name: "call_tool",
      arguments: {
        name: "gen_image",
        args: { prompt: "from-args", steps: 2 },
        parameters: { prompt: "from-parameters", steps: 9 },
      },
    })) as { isError?: boolean };
    expect(res.isError).not.toBe(true);
    expect(textOf(res as never)).toBe("generated:from-args:2");
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

  it("call_tool names the replacement for a RETIRED name (#659)", async () => {
    const client = await compactPair(fakeCatalog());
    const res = (await client.callTool({
      name: "call_tool",
      arguments: { name: "apps_list" },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    const text = textOf(res as never);
    expect(text).toContain("removed in 0.49.0");
    expect(text).toContain('apps (action:"list")');
    expect(text).not.toContain("Did you mean");
  });

  it("call_tool resolves a retired name through the mcp__<server>__ prefix (#659)", async () => {
    const client = await compactPair(fakeCatalog());
    const res = (await client.callTool({
      name: "call_tool",
      arguments: { name: "mcp__comfyui__apps_run" },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(textOf(res as never)).toContain('apps (action:"run")');
  });

  it("describe_tool gives a retired name the same specific error (#659)", async () => {
    const client = await compactPair(fakeCatalog());
    const res = (await client.callTool({
      name: "describe_tool",
      arguments: { name: "submit_batch" },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(textOf(res as never)).toContain('batch (action:"submit")');
  });

  it("a merely-similar name still gets the fuzzy path, not the retired error (#659)", async () => {
    const client = await compactPair(fakeCatalog());
    const res = (await client.callTool({
      name: "call_tool",
      arguments: { name: "apps_list_v2" },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    const text = textOf(res as never);
    expect(text).toContain("Unknown tool 'apps_list_v2'.");
    expect(text).not.toContain("removed in");
  });

  // #804 in miniature: a tool the caller could not SEE must not be narrated as a
  // tool that does not EXIST. panel_* names are served by the orchestrator's
  // per-tab surface, never by this catalog, so this catalog's silence about them
  // is evidence about the SURFACE, not about the tool. Our own prose walks callers
  // into this (visualize_workflow's description points at panel_graph_outline; the
  // bundled debug-render / director skills name panel_* tools), and an outside MCP
  // client reading it holds none of them.
  describe("a panel_* name is answered as a wrong-surface fact, not as non-existence (#804)", () => {
    it("#1353: a DEFERRED/code-mode client is told where to look before concluding absence", async () => {
      // The reporter's Codex code-mode session declared the live-canvas tools missing,
      // repeatedly, while the panel MCP endpoint was answering tools/list with 91 tools
      // and HTTP 200. No transport error anywhere — the failure was this message.
      //
      // It said "if it offers nothing under `panel_`, there is no live-canvas route
      // from here". On code-mode the panel tools are DEFERRED: they sit in the
      // ALL_TOOLS catalog as `mcp__panel__panel_graph_outline`, so a scan of the direct
      // declarations for a bare `panel_` prefix finds nothing and the sentence licenses
      // exactly the wrong conclusion.
      const client = await compactPair(fakeCatalog());
      const res = (await client.callTool({
        name: "call_tool",
        arguments: { name: "panel_graph_outline" },
      })) as { isError?: boolean };
      const text = textOf(res as never);

      // The prefixed name it must actually look for…
      expect(text).toContain("mcp__panel__panel_graph_outline");
      // …the catalog it lives in…
      expect(text).toMatch(/ALL_TOOLS/);
      expect(text).toMatch(/deferred/i);
      // …and the absence test now requires BOTH to be empty before concluding.
      expect(text).toMatch(/Only when BOTH the direct declarations and the deferred catalog/);
    });

    it("names the panel surface, and gives a remedy for BOTH surfaces the caller might hold", async () => {
      const client = await compactPair(fakeCatalog());
      const res = (await client.callTool({
        name: "call_tool",
        arguments: { name: "panel_graph_outline" },
      })) as { isError?: boolean };
      expect(res.isError).toBe(true);
      const text = textOf(res as never);
      // Scoped to THIS server, and explicit that it is answering a different
      // question than "does this tool exist".
      expect(text).toMatch(/in THIS server.s call_tool catalog/);
      expect(text).toMatch(/says nothing about whether 'panel_graph_outline' exists/);
      expect(text).toMatch(/ComfyUI sidebar panel's own per-tab MCP server/);
      // Refuses to pick between the two states it cannot observe, and defers to
      // the one source that can settle it — the caller's own tool list.
      expect(text).toMatch(/cannot see what else your client holds/);
      expect(text).toMatch(/check the tool list your client gave you/);
      // Each state gets a remedy reachable FROM that state...
      expect(text).toMatch(/panel_graph_outline, or a panel router such as panel_call_tool/);
      expect(text).toMatch(/\bget_workflow\b/);
      // ...and neither prescribes a CALL FORM we cannot see: the Ollama backend
      // fronts the panel with a three-tool router, so an unconditional "call it
      // directly" would be wrong advice on a host that genuinely has the canvas.
      expect(text).not.toMatch(/call panel_graph_outline DIRECTLY/);
      // The sidebar fallback carries its condition — the pi backend has no MCP
      // client, so "the Agent tab has these tools" is not true everywhere.
      expect(text).toMatch(/on a backend that has ComfyUI tools/);
      // The bare unknown-name path must not also fire — "Did you mean" here would
      // offer a same-server near-miss for a name that was never a same-server tool.
      expect(text).not.toContain("Did you mean");
    });

    it("claims nothing about whether the name is a real panel tool", async () => {
      // A typo reaches this branch too. The namespace fact is true of it; "it
      // exists on the other surface" is not, so the message must not say so.
      const client = await compactPair(fakeCatalog());
      const res = (await client.callTool({
        name: "call_tool",
        arguments: { name: "panel_not_a_real_tool_xyz" },
      })) as { isError?: boolean };
      const text = textOf(res as never);
      expect(text).toMatch(/says nothing about whether 'panel_not_a_real_tool_xyz' exists/);
      // Conditional on the caller's list containing it, never asserted outright.
      expect(text).toMatch(/If it offers panel_not_a_real_tool_xyz/);
    });

    it("applies through a client's mcp__<server>__ namespacing", async () => {
      const client = await compactPair(fakeCatalog());
      const res = (await client.callTool({
        name: "call_tool",
        arguments: { name: "mcp__comfyui__panel_query_graph" },
      })) as { isError?: boolean };
      expect(res.isError).toBe(true);
      expect(textOf(res as never)).toMatch(/in THIS server.s call_tool catalog/);
    });

    it("describe_tool answers identically (one message, both entry points)", async () => {
      const client = await compactPair(fakeCatalog());
      const res = (await client.callTool({
        name: "describe_tool",
        arguments: { name: "panel_set_widget" },
      })) as { isError?: boolean };
      expect(res.isError).toBe(true);
      expect(textOf(res as never)).toMatch(/in THIS server.s call_tool catalog/);
    });

    it("a RETIRED panel name keeps its named replacement instead", async () => {
      // panel_get_graph is in the retirement ledger. "Ask the panel agent" would
      // dead-end there too — the ledger's answer (call panel_query_graph) is the
      // one that actually resolves, so retirement has to win the ordering.
      const client = await compactPair(fakeCatalog());
      const res = (await client.callTool({
        name: "call_tool",
        arguments: { name: "panel_get_graph" },
      })) as { isError?: boolean };
      expect(res.isError).toBe(true);
      const text = textOf(res as never);
      expect(text).toContain("panel_query_graph");
      expect(text).not.toMatch(/in THIS server.s call_tool catalog/);
    });

    it("never shadows a real same-server tool that happens to start with panel_", async () => {
      // An autoloaded workflow file is registered under its slugified filename, so
      // `panel_custom.json` genuinely is a `panel_custom` tool on THIS server. The
      // namespace branch runs only after catalog.get() misses, so that tool must
      // still dispatch normally rather than be talked about as someone else's.
      const catalog = fakeCatalog();
      catalog.setCategory("saved-workflows");
      catalog
        .asRegistrar()
        .tool("panel_custom", "An autoloaded workflow whose filename slugified to panel_custom.", {}, async () => ({
          content: [{ type: "text" as const, text: "ran the autoloaded workflow" }],
        }));
      const client = await compactPair(catalog);
      const res = (await client.callTool({
        name: "call_tool",
        arguments: { name: "panel_custom" },
      })) as { isError?: boolean };
      expect(res.isError).not.toBe(true);
      expect(textOf(res as never)).toBe("ran the autoloaded workflow");

      // ...and the same tool reached under a client's namespacing misses the exact
      // catalog lookup, so it lands in the unknown-name path. It must NOT be told
      // the prefix belongs to another server — that is a tool this server serves.
      const ns = (await client.callTool({
        name: "call_tool",
        arguments: { name: "mcp__comfyui__panel_custom" },
      })) as { isError?: boolean };
      const nsText = textOf(ns as never);
      expect(nsText).not.toMatch(/live-canvas surface/);
      expect(nsText).toContain("Did you mean");
      expect(nsText).toContain("panel_custom");

      // ...and a DIFFERENT panel_ name against this same catalog must not claim the
      // prefix is "not this server's to serve" — that catalog demonstrably serves
      // one. The ownership sentence is derived from the catalog, so it names what is
      // really there and says only that the requested name is not among it.
      const other = (await client.callTool({
        name: "call_tool",
        arguments: { name: "panel_typo" },
      })) as { isError?: boolean };
      const otherText = textOf(other as never);
      expect(otherText).toContain("This catalog does hold 1 name(s) under `panel_`");
      expect(otherText).toContain("panel_custom");
      expect(otherText).toContain("'panel_typo' is not among them");
      expect(otherText).not.toMatch(/holds no `panel_` names at all/);
    });

    it("says it serves no panel_ names only when the catalog really has none", async () => {
      const client = await compactPair(fakeCatalog());
      const res = (await client.callTool({
        name: "call_tool",
        arguments: { name: "panel_graph_outline" },
      })) as { isError?: boolean };
      expect(textOf(res as never)).toContain("This catalog holds no `panel_` names at all");
    });

    it("leaves a non-panel unknown name on the fuzzy path", async () => {
      const client = await compactPair(fakeCatalog());
      const res = (await client.callTool({
        name: "call_tool",
        arguments: { name: "gen" },
      })) as { isError?: boolean };
      const text = textOf(res as never);
      expect(text).toContain("Did you mean");
      expect(text).not.toMatch(/in THIS server.s call_tool catalog/);
    });
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
    for (const t of ["install_comfyui", "get_system_stats", "list_local_models", "calculate"]) {
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
    // for the reporter's environment read. Reaching it via call_tool proves the
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
    expect(names.has("install_comfyui")).toBe(true);
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
      expect(names.has("install_comfyui")).toBe(true);
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
    // Bound to the ledger, not to a hardcoded floor. The literal 100 here was
    // written when the surface was ~150 and it means "the catalog captured the
    // REAL surface, not an empty or partial one" — but the 0.50.0 consolidation
    // ratchets the surface DOWN past 100 on its way to the RFC's target of 32,
    // so a fixed floor turns a correct retirement red. No single slice crosses
    // it; the cumulative merge train does. TOOL_NAMES.length is the same
    // assertion, stated as the invariant instead of as a number that rots — and
    // it is strictly STRONGER, since a catalog that dropped a registered tool
    // now fails where 100 would still have passed. `>=` rather than `===`
    // because autoloaded workflow tools can add names on a dev box.
    expect(catalog.tools.size).toBeGreaterThanOrEqual(TOOL_NAMES.length);
    for (const expected of ["generate_image", "get_system_stats", "enqueue_workflow", "list_local_models"]) {
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

// #1160 — a bare JSON.parse message reaching a caller.
//
// On an AUTHENTICATED remote, upload_image AND get_image both returned the raw
// `Unexpected end of JSON input` — identical text from two different endpoints,
// with no endpoint, status, content type, or delivery state. Every request path
// in this repo that the report named is already guarded (readComfyJson names all
// four; /upload/image and /view report a non-OK status before parsing; the args
// parser catches its own JSON.parse), so the message escapes from a layer below
// those. This is the backstop at the choke point every compact call passes.
describe("a bare JSON parse error is contextualized (#1160)", () => {
  function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  it("names the tool and says it is NOT an argument problem", () => {
    const out = contextualizeBareParseError(
      new SyntaxError("Unexpected end of JSON input"),
      "upload_image",
    );
    const m = messageOf(out);
    expect(m).toContain("upload_image");
    expect(m).toMatch(/NOT a problem with your arguments/);
  });

  it("keeps the original text at the front so existing matchers still match", () => {
    const m = messageOf(
      contextualizeBareParseError(new SyntaxError("Unexpected end of JSON input"), "get_image"),
    );
    expect(m.startsWith("Unexpected end of JSON input")).toBe(true);
  });

  it("names the auth-gate reading, and that a working panel proves nothing about this server", () => {
    // The reporter's exact situation: browser-authenticated panel fine, headless
    // COMFYUI_URL 401. "The panel works" is the reasoning that hides it.
    const m = messageOf(contextualizeBareParseError(new SyntaxError("Unexpected end of JSON input"), "upload_image"));
    expect(m).toMatch(/auth gate or proxy/);
    expect(m).toMatch(/WITHOUT a browser session/);
    expect(m).toMatch(/get_system_stats/);
  });

  it("warns that an upload's delivery is UNDETERMINED", () => {
    // A parse failure says nothing about whether the POST landed; "it errored"
    // must not read as "nothing happened".
    const m = messageOf(contextualizeBareParseError(new SyntaxError("Unexpected end of JSON input"), "upload_image"));
    expect(m).toMatch(/may or may not have been delivered/);
    expect(m).toMatch(/verify before retrying/);
  });

  it("covers the other V8 JSON-parse spellings", () => {
    for (const msg of [
      "Unexpected token '<', \"<!doctype \"... is not valid JSON",
      "Unexpected non-whitespace character after JSON at position 4",
    ]) {
      expect(messageOf(contextualizeBareParseError(new SyntaxError(msg), "get_image"))).toMatch(
        /NOT a problem with your arguments/,
      );
    }
  });

  it("does NOT rewrite a non-SyntaxError, however its message reads", () => {
    // The instanceof check is a second guard on top of the message match: a
    // library that reports a parse failure as a plain Error is not something we
    // should be re-narrating as an auth-gate diagnosis.
    const err = new Error("Unexpected end of JSON input");
    expect(contextualizeBareParseError(err, "get_image")).toBe(err);
  });

  it("does NOT touch a SyntaxError that is not a JSON parse failure", () => {
    const err = new SyntaxError("Invalid regular expression: missing /");
    expect(contextualizeBareParseError(err, "get_image")).toBe(err);
  });

  it("does NOT paper over an error that is already diagnosed", () => {
    // The guards that work must keep their own wording — this is a backstop, not
    // a wrapper.
    const err = new Error("/upload/image returned 401: <html>login</html>");
    expect(contextualizeBareParseError(err, "upload_image")).toBe(err);
  });
});

// THE WIRING. The unit tests above call contextualizeBareParseError directly, so
// they cannot see the dispatcher dropping it — which is exactly the call-site
// blindness this suite keeps getting caught by. Drive the real call_tool.
describe("call_tool applies the parse backstop (#1160)", () => {
  function catalogThatThrows(err: unknown): ToolCatalog {
    const catalog = new ToolCatalog();
    const registrar = catalog.asRegistrar();
    catalog.setCategory("media");
    registrar.tool("upload_image", "Upload a file.", {}, async () => {
      throw err;
    });
    return catalog;
  }

  it("a handler throwing a bare JSON SyntaxError comes back contextualized", async () => {
    const client = await compactPair(catalogThatThrows(new SyntaxError("Unexpected end of JSON input")));
    const res = (await client.callTool({ name: "call_tool", arguments: { name: "upload_image" } })) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const t = textOf(res);
    expect(t).toContain("Unexpected end of JSON input");
    expect(t).toMatch(/NOT a problem with your arguments/);
    expect(t).toMatch(/may or may not have been delivered/);
  });

  it("a handler throwing an already-diagnosed error keeps its own wording", async () => {
    const client = await compactPair(
      catalogThatThrows(new Error("/upload/image returned 401: <html>login</html>")),
    );
    const res = (await client.callTool({ name: "call_tool", arguments: { name: "upload_image" } })) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const t = textOf(res);
    expect(t).toContain("returned 401");
    expect(t).not.toMatch(/NOT a problem with your arguments/);
  });
});

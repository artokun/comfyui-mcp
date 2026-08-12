// panel#754 — an unrecognized argument key was silently DROPPED, not rejected.
// Measured: a real call and one carrying an extra `utterly_bogus_param` key
// returned byte-identical replies. zod's default `z.object()` is "strip" mode,
// so an unknown key vanishes before the handler ever sees it — a caller with a
// misspelled or hallucinated field name gets no signal anything was wrong; the
// call just quietly does less than asked.
//
// These tests exercise the REAL dispatch path, not just the schema object in
// isolation: a genuine `@modelcontextprotocol/sdk` McpServer, registered via
// `registerPanelTools` exactly as production does, connected to a real Client
// over an in-memory transport. The unrecognized-key rejection has to survive
// `normalizeObjectSchema` + `safeParseAsync` inside the SDK's own
// `validateToolInput` — nothing here is mocked at the validation layer.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildPanelToolDefs, registerPanelTools, type PanelToolCtx } from "../../orchestrator/panel-tools.js";

const BOGUS_KEY = "__e2e_bogus_marker_754__";

function makeFakeCtx(): PanelToolCtx {
  return {
    call: async (cmd) => ({ content: [{ type: "text", text: JSON.stringify(cmd) }] }),
    confirm: async () => "yes" as const,
    bridge: {
      send: async () => ({}),
    } as unknown as PanelToolCtx["bridge"],
    tabId: "test-tab",
  } as PanelToolCtx;
}

describe("panel-tools #754: strict schemas reject unknown argument keys", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "panel-tools-strict-test", version: "1.0.0" });
    registerPanelTools(server, makeFakeCtx());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "panel-tools-strict-test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  const defs = buildPanelToolDefs();
  const allOptional = defs.filter((d) => z.object(d.schema).safeParse({}).success);
  const hasRequired = defs.filter((d) => !z.object(d.schema).safeParse({}).success);

  it("the survey itself is meaningful — both groups are non-trivial", () => {
    // If either group collapsed to 0 the tests below would pass vacuously.
    expect(allOptional.length).toBeGreaterThan(10);
    expect(hasRequired.length).toBeGreaterThan(10);
    expect(allOptional.length + hasRequired.length).toBe(defs.length);
  });

  describe.each(allOptional.map((d) => d.name))("all-optional tool: %s", (name) => {
    it("an empty call is NOT rejected for carrying an unknown key (there isn't one)", async () => {
      const r = await client.callTool({ name, arguments: {} });
      const text = (r.content as Array<{ text?: string }>)?.[0]?.text ?? "";
      // May still be isError for OPERATIONAL reasons against the fake ctx/bridge
      // (e.g. "no connected tab") — that is fine and expected; what must NOT
      // appear is the schema-validation rejection this test exists to check for.
      expect(text).not.toMatch(/Unrecognized key|Input validation error/);
    });

    it("the SAME call plus one unknown key IS rejected, naming the key", async () => {
      const r = await client.callTool({ name, arguments: { [BOGUS_KEY]: true } });
      expect(r.isError).toBe(true);
      const text = (r.content as Array<{ text?: string }>)?.[0]?.text ?? "";
      expect(text).toContain(BOGUS_KEY);
      expect(text).toMatch(/Unrecognized key|unrecognized_keys/);
    });
  });

  describe.each(hasRequired.map((d) => d.name))("required-field tool: %s", (name) => {
    it("an unknown key is flagged even when required fields are also missing", async () => {
      // Weaker than the all-optional case (this call was never going to validate
      // cleanly), but it proves strictness reaches EVERY tool uniformly — the
      // combined zod error still names the unknown key alongside the missing
      // required ones, rather than being silently absorbed into "just missing
      // fields".
      const r = await client.callTool({ name, arguments: { [BOGUS_KEY]: true } });
      expect(r.isError).toBe(true);
      const text = (r.content as Array<{ text?: string }>)?.[0]?.text ?? "";
      expect(text).toContain(BOGUS_KEY);
    });
  });

  it("SPOT CHECK — a VALID required-field call succeeds at the schema layer; the same call plus a bogus key does not", async () => {
    // panel_add_node requires only class_type; a fresh /object_info refresh isn't
    // needed for the fake ctx to accept the call — this isolates the schema-layer
    // effect from anything the real handler would do against a live panel.
    const valid = await client.callTool({ name: "panel_add_node", arguments: { class_type: "KSampler" } });
    const validText = (valid.content as Array<{ text?: string }>)?.[0]?.text ?? "";
    expect(validText).not.toMatch(/Unrecognized key|Input validation error/);

    const poisoned = await client.callTool({
      name: "panel_add_node",
      arguments: { class_type: "KSampler", [BOGUS_KEY]: true },
    });
    expect(poisoned.isError).toBe(true);
    const poisonedText = (poisoned.content as Array<{ text?: string }>)?.[0]?.text ?? "";
    expect(poisonedText).toContain(BOGUS_KEY);
  });

  it("WIRING: both registration call sites route through strictPanelSchema, not the raw shape", () => {
    // A green protocol-dispatch test above proves the CURRENT registration works;
    // it says nothing about whether a future edit reverts one of the two call
    // sites back to the raw (non-strict) shape while leaving the other fixed.
    // Read the source directly for both.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../../orchestrator/panel-tools.ts"), "utf8");

    // Slice each function to the START OF THE NEXT top-level declaration rather than a
    // fixed byte count. #873 inserted a policy check at the top of BOTH functions and
    // pushed the schema line past a 1200- and then an 1800-byte window; each time the
    // test failed for a reason that had nothing to do with what it asserts. The claim is
    // WHICH schema builder each call site uses — a window that depends on how much
    // unrelated code sits above it measures the wrong thing, and the natural repair
    // (widen it again) leaves the same trap armed for the next edit.
    const functionBody = (marker: string): string => {
      const start = src.indexOf(marker);
      expect(start, `${marker} not found`).toBeGreaterThan(0);
      const rest = src.slice(start + marker.length);
      const end = rest.search(/\nexport (async )?function |\nexport const /);
      return rest.slice(0, end === -1 ? undefined : end);
    };

    // registerPanelTools (MCP SDK / Codex HTTP transport).
    const registerBlock = functionBody("export function registerPanelTools(");
    expect(registerBlock).toMatch(/inputSchema:\s*strictPanelSchema\(d\.schema\)/);
    expect(registerBlock).not.toMatch(/inputSchema:\s*d\.schema[,\s]/);

    // createPanelMcpServer (Anthropic Agent SDK / Claude in-process transport).
    const createBlock = functionBody("export function createPanelMcpServer(");
    expect(createBlock).toMatch(/strictPanelSchema\(d\.schema\)/);
  });
});

describe("panel-tools: action policy survives real MCP dispatch", () => {
  let client: Client;
  let server: McpServer;
  const previous = process.env.COMFYUI_MCP_TOOL_ACTION_ALLOW;

  beforeAll(async () => {
    process.env.COMFYUI_MCP_TOOL_ACTION_ALLOW = "panel_canvas:fit";
    server = new McpServer({ name: "panel-action-policy-test", version: "1.0.0" });
    registerPanelTools(server, makeFakeCtx());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "panel-action-policy-test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    if (previous === undefined) delete process.env.COMFYUI_MCP_TOOL_ACTION_ALLOW;
    else process.env.COMFYUI_MCP_TOOL_ACTION_ALLOW = previous;
  });

  it("allows an exact pair and rejects another valid action before the handler", async () => {
    const allowed = await client.callTool({
      name: "panel_canvas",
      arguments: { action: "fit" },
    });
    expect(allowed.isError).not.toBe(true);

    const denied = await client.callTool({
      name: "panel_canvas",
      arguments: { action: "zoom", scale: 1.5 },
    });
    expect(denied.isError).toBe(true);
    expect((denied.content as Array<{ text?: string }>)[0]?.text).toContain(
      "panel_canvas:zoom",
    );
  });
});

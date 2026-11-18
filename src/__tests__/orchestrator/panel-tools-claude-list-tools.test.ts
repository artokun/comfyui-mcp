// #2963 — the Claude-lane panel server reported CONNECTED but contributed ZERO
// tools. `tools/list` on the Agent SDK's in-process server threw
// `Cannot read properties of undefined (reading 'push')`: the SDK converts our
// schemas with the zod it BUNDLES, and a host-zod 4.6 `z.record()` pushes onto a
// walker-context field that a bundled zod 4.4 context does not have. One throwing
// tool fails the whole list.
//
// Measured with the real SDK, not assumed: host zod 4.6.5/4.6.7 fails with Agent
// SDK 0.3.284 (bundles zod 4.4.3) and lists all tools with 0.3.285+ (bundles
// 4.5.4 or later), which is below our `^0.3.296` floor. So this file guards a
// dependency boundary, not a code path we own.
//
// Nothing else covers it. panel-tools-strict-schema drives `registerPanelTools`
// (the MCP SDK lane, which walks with the HOST zod), and
// inherited-mcp-not-in-session drives this lane's `callTool` only. Validation
// never touches JSON Schema conversion; only `tools/list` does. And from 0.3.286
// the SDK no longer fails the list, it silently leaves the unconvertible tool out,
// so "the list came back" is not enough: every def has to be in it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { buildPanelToolDefs, createPanelMcpServer } from "../../orchestrator/panel-tools.js";
import type { UiBridge } from "../../services/ui-bridge.js";

const TAB = "orchestrator::claude";
/** Never reached: listing touches no tab, and the bogus-key call is rejected before its handler. */
const bridge = {
  send: async () => ({ ok: true }),
  push: () => 1,
  canReach: () => true,
  isHeadless: () => false,
  tabs: () => [{ tab_id: TAB, title: "A", connected_at: 0 }],
  resolveActiveTabId: () => TAB,
} as unknown as UiBridge;

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

describe("#2963: the Claude in-process panel server lists every panel tool over real tools/list", () => {
  let client: Client;
  let tools: ListedTool[];

  beforeAll(async () => {
    const config = createPanelMcpServer(bridge, TAB) as unknown as { instance: McpServer };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-2963-claude", version: "1" });
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);
    ({ tools } = await client.listTools());
  });

  afterAll(async () => {
    await client.close();
  });

  it("lists exactly the shared panel tool defs, none dropped", () => {
    const expected = buildPanelToolDefs().map((d) => d.name).sort();
    expect(expected.length).toBeGreaterThan(50);
    expect(tools.map((t) => t.name).sort()).toEqual(expected);
  });

  it("every listed schema is a closed object (strict survives conversion)", () => {
    const open = tools
      .filter((t) => t.inputSchema.type !== "object" || t.inputSchema.additionalProperties !== false)
      .map((t) => t.name);
    expect(open).toEqual([]);
  });

  it("a z.record field is advertised as a string-keyed map of its value type", () => {
    // panel_add_mcp.headers is z.record(z.string(), z.string()), one of the
    // record fields that broke the list in the report.
    const addMcp = tools.find((t) => t.name === "panel_add_mcp");
    const headers = addMcp?.inputSchema.properties?.headers as Record<string, unknown> | undefined;
    expect(headers).toMatchObject({ type: "object", additionalProperties: { type: "string" } });
  });

  it("an unknown argument key is still rejected on this lane", async () => {
    const bogus = "__bogus_marker_2963__";
    const res = await client.callTool({ name: "panel_list_mcp", arguments: { [bogus]: true } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text?: string }>)[0]?.text ?? "").toContain(bogus);
  });
});

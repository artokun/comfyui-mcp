/**
 * Mount / unmount, measured on the wire.
 *
 * Reading the SDK and seeing that `disable()` sends a notification is not the claim that
 * matters. The claim is: a real MCP client connected to the panel server does not see the
 * Director tools, sees them after the pane opens, is TOLD the list changed, and loses them
 * again when the pane closes or the tab dies — and the entry points never go anywhere.
 *
 * Every assertion below goes through a real client over an in-memory transport pair, so a
 * regression in either direction — tools that never mount, or tools that never unmount — is
 * a red test, not a code-review argument.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountRegistry } from "../../orchestrator/mountable-tools.js";
import { registerPanelTools, type PanelToolCtx } from "../../orchestrator/panel-tools.js";
import { panePresence } from "../../services/panel-pane-state.js";

const DIRECTOR = ["panel_director_graph", "panel_director_link", "panel_director_subgraph"];
const ENTRY = ["panel_module", "panel_pane"];

function fakeCtx(): PanelToolCtx {
  return {
    call: async (cmd) => ({ content: [{ type: "text", text: JSON.stringify({ echoed: cmd }) }] }),
    confirm: async () => "no",
    bridge: {} as never,
    tabId: "tab-A",
  } as unknown as PanelToolCtx;
}

async function connectedClient(server: McpServer) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  const names = async () => (await client.listTools()).tools.map((t) => t.name).sort();
  return { client, names };
}

describe("mountable Director tools", () => {
  beforeEach(() => panePresence.reset());
  afterEach(() => panePresence.reset());

  it("a fresh session hides the Director group and keeps the entry points", async () => {
    const server = new McpServer({ name: "panel", version: "0" });
    registerPanelTools(server, fakeCtx());
    const { names } = await connectedClient(server);
    const list = await names();
    for (const n of DIRECTOR) expect(list).not.toContain(n);
    for (const n of ENTRY) expect(list).toContain(n);
  });

  it("opening the pane mounts the group and the client is TOLD the list changed", async () => {
    const server = new McpServer({ name: "panel", version: "0" });
    registerPanelTools(server, fakeCtx());
    const { client, names } = await connectedClient(server);

    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changed += 1;
    });

    panePresence.set("tab-A", "director", true);
    await new Promise((r) => setTimeout(r, 20));
    expect(changed).toBeGreaterThan(0);
    const list = await names();
    for (const n of DIRECTOR) expect(list).toContain(n);
  });

  it("closing the pane unmounts the group again, and the entry points survive", async () => {
    const server = new McpServer({ name: "panel", version: "0" });
    registerPanelTools(server, fakeCtx());
    const { names } = await connectedClient(server);
    panePresence.set("tab-A", "director", true);
    panePresence.set("tab-A", "director", false);
    await new Promise((r) => setTimeout(r, 20));
    const list = await names();
    for (const n of DIRECTOR) expect(list).not.toContain(n);
    for (const n of ENTRY) expect(list).toContain(n);
  });

  it("FALSE-NEGATIVE direction: a tab that dies without a close frame still unmounts", async () => {
    const server = new McpServer({ name: "panel", version: "0" });
    registerPanelTools(server, fakeCtx());
    const { names } = await connectedClient(server);
    panePresence.set("tab-A", "director", true);
    expect(await names()).toContain("panel_director_graph");
    panePresence.tabGone("tab-A");
    await new Promise((r) => setTimeout(r, 20));
    expect(await names()).not.toContain("panel_director_graph");
  });

  it("presence is conversation-wide: the pane open in ANY tab keeps the group mounted", async () => {
    const server = new McpServer({ name: "panel", version: "0" });
    registerPanelTools(server, fakeCtx());
    const { names } = await connectedClient(server);
    panePresence.set("tab-A", "director", true);
    panePresence.set("tab-B", "director", true);
    panePresence.set("tab-A", "director", false);
    await new Promise((r) => setTimeout(r, 20));
    expect(await names()).toContain("panel_director_graph");
    panePresence.set("tab-B", "director", false);
    await new Promise((r) => setTimeout(r, 20));
    expect(await names()).not.toContain("panel_director_graph");
  });

  it("a session created while the pane is already open comes up mounted", async () => {
    panePresence.set("tab-A", "director", true);
    const server = new McpServer({ name: "panel", version: "0" });
    registerPanelTools(server, fakeCtx());
    const { names } = await connectedClient(server);
    expect(await names()).toContain("panel_director_graph");
  });

  it("disposing a session drops its handles so they are not flipped after close", async () => {
    const server = new McpServer({ name: "panel", version: "0" });
    const reg = registerPanelTools(server, fakeCtx());
    const before = mountRegistry.size("director");
    expect(before).toBeGreaterThanOrEqual(DIRECTOR.length);
    reg.dispose();
    expect(mountRegistry.size("director")).toBe(before - DIRECTOR.length);
  });

  it("the entry point is never mountable — mutate it and this goes red", () => {
    const server = new McpServer({ name: "panel", version: "0" });
    registerPanelTools(server, fakeCtx());
    // If someone marks panel_module mountable, disabling the group would take the door with it.
    panePresence.set("tab-A", "director", false);
    const registered = (server as unknown as { _registeredTools: Record<string, { enabled: boolean }> })._registeredTools;
    for (const n of ENTRY) expect(registered[n]?.enabled).toBe(true);
    for (const n of DIRECTOR) expect(registered[n]?.enabled).toBe(false);
  });
});

// panel#291 — the panel's in-process (Agent SDK) tools are deferred behind tool
// search by default; the spawned `comfyui` stdio server is not. The reporter sees
// every `panel_*` tool missing from BOTH the declared list and the deferred
// catalog. Deferral alone does not explain an empty catalog, so this is not
// asserted as the cause — it removes the deferral variable so the next report
// distinguishes "deferred and unfound" from "never registered".
//
// These assertions run against REAL tool definitions: the server built exactly as
// production builds it, connected to a real MCP client over an in-memory
// transport, reading the `_meta` the SDK actually emits. Verified against the
// installed SDK that `tool(..., { alwaysLoad: true })` sets
// `_meta['anthropic/alwaysLoad'] = true` and that a plain tool has no `_meta`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPanelMcpServer } from "../../orchestrator/panel-tools.js";
import type { UiBridge } from "../../orchestrator/ui-bridge.js";

const ALWAYS_LOAD_META = "anthropic/alwaysLoad";

/** The set this PR opts out of deferral. Kept literal so the test states the
 *  intended surface rather than reading it back from the module under test. */
const EXPECTED_PROBE_TOOLS = ["panel_canvas", "panel_graph_outline"];

function fakeBridge(): UiBridge {
  /* `UiBridge` is a CLASS with private fields (`wss`, `extraServers`, …), so no
     structural literal can satisfy it and there is no narrower cast available.
     Nothing here calls the bridge: these assertions read tool DEFINITIONS from
     `tools/list`, and a handler is never invoked — so a real bridge would be a
     websocket server bound for no reason. */
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double for a class with private fields; no handler runs
  return {
    send: async () => ({}),
  } as unknown as UiBridge;
}

describe("panel#291 the deferral opt-out is scoped to the probe tools", () => {
  let client: Client;
  let close: (() => Promise<void>) | undefined;
  let tools: Array<{ name: string; _meta?: Record<string, unknown> }>;

  beforeAll(async () => {
    const config = createPanelMcpServer(fakeBridge(), "test-tab");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "panel-always-load-test", version: "1.0.0" });
    await Promise.all([
      config.instance.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    close = async () => {
      await client.close();
      await config.instance.close();
    };
    const listed = await client.listTools();
    tools = listed.tools as typeof tools;
  });

  afterAll(async () => {
    // Guarded: if beforeAll throws, `close` is never assigned, and an unguarded
    // call here replaces the real construction error with "close is not a
    // function" — which is what happened the first time this suite failed.
    if (close) await close();
  });

  it("the survey is meaningful — the panel surface is actually present", () => {
    // Without this, every assertion below passes vacuously on an empty list.
    expect(tools.length).toBeGreaterThan(50);
    for (const name of EXPECTED_PROBE_TOOLS) {
      expect(tools.map((t) => t.name)).toContain(name);
    }
  });

  it("each probe tool carries the alwaysLoad meta the SDK reads", () => {
    for (const name of EXPECTED_PROBE_TOOLS) {
      const found = tools.find((t) => t.name === name);
      expect(found?._meta?.[ALWAYS_LOAD_META]).toBe(true);
    }
  });

  it("ONLY the probe tools carry it — the whole surface is not conscripted", () => {
    // The regression this guards is re-introducing the SERVER-WIDE
    // `CreateSdkMcpServerOptions.alwaysLoad`, which sets the same `_meta` on
    // every tool. That would put all ~96 panel schemas (~77k characters of
    // description alone) into every turn-1 prompt to answer one yes/no question.
    // A presence check on the two probe tools cannot see that; a count can.
    const optedOut = tools
      .filter((t) => t._meta?.[ALWAYS_LOAD_META] === true)
      .map((t) => t.name)
      .sort();
    expect(optedOut).toEqual(EXPECTED_PROBE_TOOLS);
  });

  it("a representative ordinary tool stays deferred", () => {
    const ordinary = tools.find((t) => t.name === "panel_move_node");
    expect(ordinary).toBeDefined();
    expect(ordinary?._meta?.[ALWAYS_LOAD_META]).toBeUndefined();
  });
});

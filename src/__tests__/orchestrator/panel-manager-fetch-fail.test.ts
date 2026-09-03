// #2492 — panel_search_nodes and panel_list_nodes died as a transport-only
// "Failed to fetch" when the live H3 Desktop tab's browser Manager request
// never completed. Graph reads still worked. Host Manager HTTP can still
// serve the registry search / installed-pack listing; that is not a Manager
// outage and not a missing pack.

import { afterEach, describe, expect, it } from "vitest";
import { buildPanelToolDefs, type PanelToolCtx, type ToolResult } from "../../orchestrator/panel-tools.js";
import {
  HOST_HTTP_SEARCH_NOTE,
  setFetchMappingsForTests,
} from "../../services/manager-node-search.js";
import {
  HOST_HTTP_TRANSPORT_NOTE,
  setListInstalledNodesForTests,
} from "../../services/manager-node-list.js";
import type { InstalledNode } from "../../services/node-management.js";

afterEach(() => {
  setFetchMappingsForTests(undefined);
  setListInstalledNodesForTests(undefined);
});

const SEARCH_FETCH =
  "ComfyUI-Manager request to /v2/customnode/getmappings?mode=cache did not complete: Failed to fetch.";
const LIST_FETCH =
  "ComfyUI-Manager request to /v2/customnode/installed?mode=default did not complete: Failed to fetch.";

const CATALOGUE = {
  "https://github.com/someone/ComfyUI-Lightning": [
    ["LightningCompile"],
    { title: "ComfyUI-Lightning", description: "compile speedup" },
  ],
};

const PACKS: InstalledNode[] = [
  {
    module: "ComfyUI-Impact-Pack",
    cnrId: "comfyui-impact-pack",
    version: "8.0.0",
    enabled: true,
  },
];

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def;
}

function replyText(res: ToolResult): string {
  return res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

function failCtx(message: string): Pick<PanelToolCtx, "call"> {
  return {
    call: async () => ({
      isError: true,
      content: [{ type: "text", text: `Error: ${message}` }],
    }),
  };
}

describe("panel_search_nodes (#2492 Manager transport Failed to fetch)", () => {
  it("still returns packs from host Manager HTTP when the panel fail()s Failed to fetch", async () => {
    setFetchMappingsForTests(async (mode) => {
      if (mode !== "cache") throw new Error("should not leave cache");
      return CATALOGUE;
    });
    const res = await defByName("panel_search_nodes").handler(
      { query: "ComfyUI-Lightning" },
      failCtx(SEARCH_FETCH) as PanelToolCtx,
    );
    expect(res.isError).toBeUndefined();
    const text = replyText(res);
    expect(text).toMatch(/ComfyUI-Lightning/);
    expect(text).toMatch(/not a Manager outage/i);
    expect(text).not.toMatch(/does not exist|not found/i);
    expect(text).not.toMatch(/Failed to fetch/);
    const body = JSON.parse(text) as {
      count: number;
      source: string;
      note: string;
    };
    expect(body.count).toBe(1);
    expect(body.source).toBe("host_http");
    expect(body.note).toContain(HOST_HTTP_SEARCH_NOTE);
  });

  it("names both causes when host mappings also fail, not a missing pack", async () => {
    setFetchMappingsForTests(async () => {
      throw new Error("Manager customnode/getmappings?mode=cache: HTTP 403");
    });
    const res = await defByName("panel_search_nodes").handler(
      { query: "D2Cache" },
      failCtx(SEARCH_FETCH) as PanelToolCtx,
    );
    expect(res.isError).toBeUndefined();
    const text = replyText(res);
    expect(text).toMatch(/did not complete/i);
    expect(text).toMatch(/HTTP 403/);
    expect(text).toMatch(/not a Manager outage inferred from a transport-only fetch failure/i);
    expect(text).not.toMatch(/does not exist|not found/i);
    const body = JSON.parse(text) as { count: number; manager_outage?: boolean };
    expect(body.count).toBe(0);
    expect(body.manager_outage).toBeUndefined();
  });
});

describe("panel_list_nodes (#2492 Manager transport Failed to fetch)", () => {
  it("still lists installed packs from host Manager HTTP when the panel fail()s Failed to fetch", async () => {
    setListInstalledNodesForTests(async () => PACKS);
    const res = await defByName("panel_list_nodes").handler({}, failCtx(LIST_FETCH) as PanelToolCtx);
    expect(res.isError).toBeFalsy();
    const text = replyText(res);
    expect(text).not.toMatch(/Failed to fetch/);
    expect(text).toMatch(/not a Manager outage/i);
    expect(text).not.toMatch(/tab was not connected/i);
    const body: unknown = JSON.parse(text);
    expect(body).toMatchObject({
      source: "host_http",
      note: HOST_HTTP_TRANSPORT_NOTE,
      installed: {
        "ComfyUI-Impact-Pack": {
          ver: "8.0.0",
          cnr_id: "comfyui-impact-pack",
          enabled: true,
        },
      },
    });
  });

  it("names both causes when host installed listing also fails, not Manager down", async () => {
    setListInstalledNodesForTests(async () => {
      throw new Error("Manager customnode/installed: HTTP 503");
    });
    const res = await defByName("panel_list_nodes").handler({}, failCtx(LIST_FETCH) as PanelToolCtx);
    expect(res.isError).toBe(true);
    const text = replyText(res);
    expect(text).toMatch(/reached the panel tab/i);
    expect(text).toMatch(/HTTP 503/);
    expect(text).toMatch(/not a Manager outage inferred from a transport-only fetch failure/i);
    expect(text).not.toMatch(/could not be dispatched/i);
    expect(text).not.toMatch(/Manager down/i);
  });
});

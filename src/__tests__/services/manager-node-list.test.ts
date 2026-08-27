// #2459 — panel_list_nodes died as a tab-dispatch error when the panel tab
// was gone, even though Manager HTTP could list installed packs. listPanelNodes
// must serve that inventory (panel-shaped) instead of claiming a Manager outage.

import { afterEach, describe, expect, it } from "vitest";
import { markDispatched } from "../../services/ui-bridge.js";
import {
  HOST_HTTP_LIST_NOTE,
  dualCauseListFailure,
  installedNodesToPanelMap,
  isPanelTabDispatchFailure,
  listPanelNodes,
  setListInstalledNodesForTests,
} from "../../services/manager-node-list.js";
import type { InstalledNode } from "../../services/node-management.js";

afterEach(() => setListInstalledNodesForTests(undefined));

const REPORTER_WRAP =
  `nodes_list could not be dispatched to this session's panel tab — nothing was applied. ` +
  `The tab may be disconnected, still reconnecting after a restart/reload, or the ` +
  `session's binding is stale (e.g. another workflow tab is now active). Retry in a ` +
  `moment, or rebind with panel_set_workflow_target({mode:"current"}) to follow the ` +
  `tab that's live now. (no connected tab with id "orchestrator::claude". Connected: none)`;

const DISPATCH_FAIL = {
  isError: true,
  content: [{ type: "text", text: `Error: ${REPORTER_WRAP}` }],
};

const PACKS: InstalledNode[] = [
  {
    module: "ComfyUI-Impact-Pack",
    cnrId: "comfyui-impact-pack",
    version: "8.0.0",
    enabled: true,
  },
  {
    module: "some-git-node",
    auxId: "user/some-git-node",
    version: "abc1234",
    enabled: false,
  },
];

describe("isPanelTabDispatchFailure (#2459)", () => {
  it("matches the reporter dispatch wrapper", () => {
    expect(isPanelTabDispatchFailure(DISPATCH_FAIL)).toBe(true);
    expect(isPanelTabDispatchFailure(new Error(REPORTER_WRAP))).toBe(true);
  });

  it("matches a typed pre-dispatch failure even without the wrapper phrase", () => {
    expect(isPanelTabDispatchFailure(markDispatched(new Error("socket write failed"), false))).toBe(
      true,
    );
  });

  it("does not treat a live-tab Manager error or a successful listing as tab loss", () => {
    expect(
      isPanelTabDispatchFailure({
        isError: true,
        content: [{ type: "text", text: "Error: Manager customnode/installed: HTTP 500" }],
      }),
    ).toBe(false);
    expect(
      isPanelTabDispatchFailure({
        installed: { "ComfyUI-Impact-Pack": { ver: "8.0.0", cnr_id: "comfyui-impact-pack" } },
      }),
    ).toBe(false);
    expect(isPanelTabDispatchFailure(markDispatched(new Error("no connected tab"), true))).toBe(
      false,
    );
  });
});

describe("installedNodesToPanelMap", () => {
  it("inverts InstalledNode[] to the panel map keyed by module", () => {
    expect(installedNodesToPanelMap(PACKS)).toEqual({
      "ComfyUI-Impact-Pack": {
        ver: "8.0.0",
        cnr_id: "comfyui-impact-pack",
        enabled: true,
      },
      "some-git-node": {
        ver: "abc1234",
        aux_id: "user/some-git-node",
        enabled: false,
      },
    });
  });
});

describe("listPanelNodes (#2459)", () => {
  it("disconnected tab + live Manager HTTP → inventory, source host_http", async () => {
    const hostCalls: number[] = [];
    const out = await listPanelNodes({
      panelList: async () => DISPATCH_FAIL,
      listInstalled: async () => {
        hostCalls.push(1);
        return PACKS;
      },
    });
    expect(out.via).toBe("fallback");
    if (out.via !== "fallback") throw new Error("expected fallback");
    expect(hostCalls).toHaveLength(1);
    expect(out.value.source).toBe("host_http");
    expect(out.value.note).toBe(HOST_HTTP_LIST_NOTE);
    expect(out.value.note).toMatch(/not a Manager outage/i);
    expect(out.value.note).not.toMatch(/Manager down/i);
    expect(out.value.installed["ComfyUI-Impact-Pack"]).toEqual({
      ver: "8.0.0",
      cnr_id: "comfyui-impact-pack",
      enabled: true,
    });
    expect(out.value.installed["some-git-node"]?.aux_id).toBe("user/some-git-node");
  });

  it("falls back when the panel throws a typed pre-dispatch failure", async () => {
    const out = await listPanelNodes({
      panelList: async () => {
        throw markDispatched(
          new Error(`no connected tab with id "orchestrator::claude". Connected: none`),
          false,
        );
      },
      listInstalled: async () => PACKS,
    });
    expect(out.via).toBe("fallback");
    if (out.via !== "fallback") throw new Error("expected fallback");
    expect(out.value.source).toBe("host_http");
    expect(Object.keys(out.value.installed)).toEqual([
      "ComfyUI-Impact-Pack",
      "some-git-node",
    ]);
  });

  it("connected tab → still panel path (no host call)", async () => {
    const panel = {
      installed: { "ComfyUI-Impact-Pack": { ver: "8.0.0", cnr_id: "comfyui-impact-pack" } },
    };
    let hostCalls = 0;
    const out = await listPanelNodes({
      panelList: async () => panel,
      listInstalled: async () => {
        hostCalls += 1;
        throw new Error("fallback must not run");
      },
    });
    expect(out).toEqual({ via: "panel", value: panel });
    expect(hostCalls).toBe(0);
  });

  it("does not host-fallback a live-tab Manager HTTP error", async () => {
    const managerDown = {
      isError: true,
      content: [{ type: "text", text: "Error: Manager customnode/installed: HTTP 500" }],
    };
    let hostCalls = 0;
    const out = await listPanelNodes({
      panelList: async () => managerDown,
      listInstalled: async () => {
        hostCalls += 1;
        return PACKS;
      },
    });
    expect(out).toEqual({ via: "panel", value: managerDown });
    expect(hostCalls).toBe(0);
  });

  it("disconnected tab + host HTTP failure → honest dual cause, not Manager down", async () => {
    const out = await listPanelNodes({
      panelList: async () => DISPATCH_FAIL,
      listInstalled: async () => {
        throw new Error("Manager customnode/installed: HTTP 503");
      },
    });
    expect(out.via).toBe("failed");
    if (out.via !== "failed") throw new Error("expected failed");
    expect(out.message).toMatch(/could not be dispatched/i);
    expect(out.message).toMatch(/no connected tab|Connected:\s*none/i);
    expect(out.message).toMatch(/HTTP 503/);
    expect(out.message).toMatch(/not a Manager outage inferred from tab loss/i);
    expect(out.message).not.toMatch(/Manager down/i);
  });

  it("rethrows a non-dispatch panel throw", async () => {
    await expect(
      listPanelNodes({
        panelList: async () => {
          throw new Error("Manager customnode/installed: HTTP 403");
        },
        listInstalled: async () => PACKS,
      }),
    ).rejects.toThrow(/HTTP 403/);
  });

  it("uses the module test seam when listInstalled is omitted", async () => {
    setListInstalledNodesForTests(async () => PACKS);
    const out = await listPanelNodes({
      panelList: async () => DISPATCH_FAIL,
    });
    expect(out.via).toBe("fallback");
  });
});

describe("dualCauseListFailure copy", () => {
  it("names both tab loss and the host read, not a Manager outage from tab loss", () => {
    const msg = dualCauseListFailure(
      new Error(`no connected tab with id "t". Connected: none`),
      new Error("unreadable payload"),
    );
    expect(msg).toMatch(/no connected tab/);
    expect(msg).toMatch(/unreadable payload/);
    expect(msg).toMatch(/not a Manager outage inferred from tab loss/);
  });
});

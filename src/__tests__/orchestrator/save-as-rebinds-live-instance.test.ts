// #2768 — Save-As left the session fenced to the replaced source instance.
//
// panel_save_workflow(name) writes the copy and the panel makes dest active
// (new tab id, new workflow_uuid). The source tab id can still canReach —
// original file stays on disk, and the old route is not yet dead. Routing
// used to treat that as a live pin (#1917) and stay on the source. Then
// panel_list_workflows / panel_set_workflow_target({mode:"current"}) were
// stamped for the source instance and refused: workflow instance mismatch.
//
// After Save-As the session must follow dest and restamp dest. #1917 still
// applies only when dest is not the canvas this save replaced.

import { beforeEach, describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const NEW_UUID = "11111111-2222-4333-8444-555555555555";
const PRIOR_UUID = "99999999-8888-4777-a666-555555555555";
const OLD_TAB = "wf:src-route:workflows/original.json";
const NEW_TAB = "wf:dest-route:workflows/photo_to_anime_main.json";
const DEST_PATH = "workflows/photo_to_anime_main.json";
const SOURCE_PATH = "workflows/original.json";
const SCOPE = "orchestrator::codex";

const SAVE_AS_REPLY = {
  saved: true,
  saved_as: true,
  workflow: "photo_to_anime_main",
  copied_from: "original",
  original_on_disk: true,
  routing_key: "wf:workflows/photo_to_anime_main.json",
  workflow_uuid: NEW_UUID,
  workflow_instance_changed: true,
};

const MISMATCH =
  `workflow instance mismatch: this command was issued for workflow instance ${PRIOR_UUID}, ` +
  `and the active canvas reports ${NEW_UUID}`;

const textOf = (res: ToolResult): string =>
  res.content.map((c) => ("text" in c ? (c as { text: string }).text : "")).join("\n");

function toolNamed(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`${name} is not registered`);
  return def;
}

let stamps: Map<string, string>;
let liveUuid: Map<string, string>;
let sent: Array<Record<string, unknown>>;
let sentTab: string[];
let liveTabs: Array<{ tab_id: string; title: string; connected_at: number }>;
let reachable: Set<string>;
let scopePin: string;
let scopeRepins: Array<{ scope: string; path: string }>;

function afterSaveAsBothTabsLive(): void {
  liveTabs = [
    { tab_id: OLD_TAB, title: "original", connected_at: 0 },
    { tab_id: NEW_TAB, title: "photo_to_anime_main", connected_at: 1 },
  ];
  reachable = new Set([OLD_TAB, NEW_TAB]);
  liveUuid.set(OLD_TAB, PRIOR_UUID);
  liveUuid.set(NEW_TAB, NEW_UUID);
}

function mismatchIfStale(tabId: string): void {
  const stamp = stamps.get(tabId);
  const live = liveUuid.get(tabId);
  if (stamp && live && stamp !== live) throw new Error(MISMATCH);
}

function destListPayload(): Record<string, unknown> {
  return {
    active: {
      path: DEST_PATH,
      filename: "photo_to_anime_main.json",
      routing_key: "wf:workflows/photo_to_anime_main.json",
      workflow_uuid: NEW_UUID,
    },
    active_confirmed: true,
    workflows: [
      {
        path: SOURCE_PATH,
        filename: "original.json",
        routing_key: OLD_TAB,
        active: false,
      },
      {
        path: DEST_PATH,
        filename: "photo_to_anime_main.json",
        routing_key: "wf:workflows/photo_to_anime_main.json",
        active: true,
      },
    ],
  };
}

function bridgeFor(): PanelToolCtx["bridge"] {
  return {
    send: async (c: Record<string, unknown>, extra?: { tabId?: string }) => {
      sent.push(c);
      const tab = typeof extra?.tabId === "string" && extra.tabId ? extra.tabId : OLD_TAB;
      sentTab.push(tab);
      if (c.cmd === "workflow_save_as") {
        afterSaveAsBothTabsLive();
        return SAVE_AS_REPLY;
      }
      if (c.cmd === "workflow_list" || c.cmd === "graph_query") {
        const routed = tab === SCOPE ? scopePin : tab;
        mismatchIfStale(routed);
        if (c.cmd === "workflow_list") return destListPayload();
        return { nodes: [] };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: (id: string) => {
      if (id === SCOPE) return reachable.has(scopePin);
      return reachable.has(id);
    },
    liveTabIdFor: (id: string) => {
      if (id === SCOPE) return reachable.has(scopePin) ? scopePin : undefined;
      return reachable.has(id) ? id : undefined;
    },
    isHeadless: () => false,
    tabs: () => liveTabs,
    resolveActiveTabId: () => NEW_TAB,
    workflowUuidFor: (tabId: string) => {
      const key = tabId === SCOPE ? scopePin : tabId;
      const uuid = stamps.get(key);
      return { known: true, uuid };
    },
    refreshWorkflowUuid: (tabId: string, uuid: string) => {
      const key = tabId === SCOPE ? scopePin : tabId;
      stamps.set(key, uuid);
      if (tabId === SCOPE) stamps.set(SCOPE, uuid);
      return true;
    },
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    tabCanMutateGraph: () => true,
    repinScopeToWorkflow: (scope: string, path: string) => {
      scopeRepins.push({ scope, path });
      scopePin = NEW_TAB;
      return NEW_TAB;
    },
  } as PanelToolCtx["bridge"];
}

beforeEach(() => {
  stamps = new Map([
    [OLD_TAB, PRIOR_UUID],
    [SCOPE, PRIOR_UUID],
  ]);
  liveUuid = new Map([[OLD_TAB, PRIOR_UUID]]);
  sent = [];
  sentTab = [];
  liveTabs = [{ tab_id: OLD_TAB, title: "original", connected_at: 0 }];
  reachable = new Set([OLD_TAB]);
  scopePin = OLD_TAB;
  scopeRepins = [];
});

describe("#2768 Save-As rebinds the session onto the dest instance", () => {
  it("moves a real-tab session off the still-reachable source onto dest", async () => {
    const targets = new WorkflowTargetStore();
    targets.set(OLD_TAB, { mode: "current" });
    const ctx = makePanelToolCtx(bridgeFor(), OLD_TAB, targets);

    const res = await toolNamed("panel_save_workflow").handler({ name: "photo_to_anime_main" }, ctx);

    expect(res.isError, textOf(res)).toBeFalsy();
    expect(ctx.tabId).toBe(NEW_TAB);
    expect(stamps.get(NEW_TAB)).toBe(NEW_UUID);
    expect(stamps.get(NEW_TAB)).not.toBe(PRIOR_UUID);
  });

  it("panel_list_workflows and mode:current then observe dest, not a stale fence", async () => {
    const ctx = makePanelToolCtx(bridgeFor(), OLD_TAB, new WorkflowTargetStore());
    await toolNamed("panel_save_workflow").handler({ name: "photo_to_anime_main" }, ctx);

    sent = [];
    sentTab = [];
    const listed = await toolNamed("panel_list_workflows").handler({}, ctx);
    expect(listed.isError, textOf(listed)).toBeFalsy();
    expect(textOf(listed)).not.toMatch(/workflow instance mismatch/);
    expect(sentTab.every((id) => id === NEW_TAB)).toBe(true);

    const bound = await toolNamed("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    expect(bound.isError, textOf(bound)).toBeFalsy();
    expect(textOf(bound)).not.toMatch(/did NOT restore this session's graph binding/);
    expect(textOf(bound)).not.toMatch(/workflow instance mismatch/);
  });

  it("re-pins a SCOPE session whose source pin still reaches onto dest", async () => {
    const ctx = makePanelToolCtx(bridgeFor(), SCOPE, new WorkflowTargetStore());
    const res = await toolNamed("panel_save_workflow").handler({ name: "photo_to_anime_main" }, ctx);

    expect(res.isError, textOf(res)).toBeFalsy();
    expect(scopeRepins).toEqual([{ scope: SCOPE, path: DEST_PATH }]);
    expect(scopePin).toBe(NEW_TAB);
    expect(stamps.get(NEW_TAB)).toBe(NEW_UUID);

    sent = [];
    const listed = await toolNamed("panel_list_workflows").handler({}, ctx);
    expect(listed.isError, textOf(listed)).toBeFalsy();
  });
});

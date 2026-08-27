// #2419 — Save-As left panel_set_todo and panel_canvas routed to the old tab.
//
// After panel_save_workflow(name) created a Save-As copy and made it active,
// graph reads/edits rebound because the command fence was refreshed from the
// save reply (#814). Session-scoped commands still addressed the pre-save tab
// id (`wf:…:workflows/Untitled ….json`) and failed with "no connected tab",
// even though the only connected tab was the dest (`photo_to_anime_main`).
//
// The two updates are separate. The fence is already repaired. This file
// drives the ROUTING half: re-point the session onto the dest tab when the
// current address is dead. A live pin is left alone (#1917 / #884).
//
// Workaround that already worked: panel_set_workflow_target({mode:"current"}).
// That tool is the only writer of the routing target; this makes Save-As do
// the dead-pin recovery that workaround performs, without claiming current
// while a live pin holds routing elsewhere.

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
const OLD_TAB = "wf:src-route:workflows/Untitled 1.json";
const NEW_TAB = "wf:dest-route:workflows/photo_to_anime_main.json";
const DEST_PATH = "workflows/photo_to_anime_main.json";
const SCOPE = "orchestrator::codex";

const SAVE_AS_REPLY = {
  saved: true,
  saved_as: true,
  workflow: "photo_to_anime_main",
  copied_from: "Untitled 1",
  original_on_disk: true,
  routing_key: "wf:workflows/photo_to_anime_main.json",
  workflow_uuid: NEW_UUID,
  workflow_instance_changed: true,
};

const textOf = (res: ToolResult): string =>
  res.content.map((c) => ("text" in c ? (c as { text: string }).text : "")).join("\n");

function toolNamed(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`${name} is not registered`);
  return def;
}

let fence: string | undefined;
let sent: Array<Record<string, unknown>>;
let sentTab: string[];
let saved: boolean;
let liveTabs: Array<{ tab_id: string; title: string; connected_at: number }>;
let reachable: Set<string>;
let scopePin: string;
let scopeRepins: Array<{ scope: string; path: string }>;

function liveTabIds(): string[] {
  return liveTabs.map((t) => t.tab_id);
}

function afterSaveAsLive(): void {
  saved = true;
  liveTabs = [{ tab_id: NEW_TAB, title: "photo_to_anime_main", connected_at: 1 }];
  reachable = new Set([NEW_TAB]);
}

function bridgeFor(opts?: { keepOldTab?: boolean }): PanelToolCtx["bridge"] {
  return {
    send: async (c: Record<string, unknown>, extra?: { tabId?: string }) => {
      sent.push(c);
      sentTab.push(typeof extra?.tabId === "string" ? extra.tabId : "");
      if (c.cmd === "workflow_save_as") {
        if (!opts?.keepOldTab) afterSaveAsLive();
        return SAVE_AS_REPLY;
      }
      if (c.cmd === "workflow_save") {
        if (!opts?.keepOldTab) afterSaveAsLive();
        return { saved: true, workflow: "photo_to_anime_main", ...SAVE_AS_REPLY };
      }
      if (c.cmd === "workflow_list") {
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
              path: DEST_PATH,
              filename: "photo_to_anime_main.json",
              routing_key: "wf:workflows/photo_to_anime_main.json",
              active: true,
            },
          ],
        };
      }
      if (c.cmd === "set_todo") return { ok: true, items: c.items ?? [] };
      if (c.cmd === "graph_canvas") return { ok: true, action: c.action };
      return { ok: true };
    },
    push: () => 1,
    canReach: (id: string) => {
      if (id === SCOPE) return reachable.has(scopePin);
      return reachable.has(id);
    },
    isHeadless: () => false,
    tabs: () => liveTabs,
    resolveActiveTabId: () => liveTabIds()[0] ?? NEW_TAB,
    workflowUuidFor: () => ({ known: true, uuid: fence }),
    refreshWorkflowUuid: (_tabId: string, uuid: string) => {
      fence = uuid;
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
  fence = PRIOR_UUID;
  sent = [];
  sentTab = [];
  saved = false;
  liveTabs = [{ tab_id: OLD_TAB, title: "Untitled 1", connected_at: 0 }];
  reachable = new Set([OLD_TAB]);
  scopePin = OLD_TAB;
  scopeRepins = [];
});

describe("#2419 Save-As re-points a dead real-tab address onto the dest canvas", () => {
  it("moves ctx.tabId from the retired Untitled id onto the dest tab", async () => {
    const targets = new WorkflowTargetStore();
    targets.set(OLD_TAB, { mode: "pinned", path: "workflows/Untitled 1.json", filename: "Untitled 1" });
    const ctx = makePanelToolCtx(bridgeFor(), OLD_TAB, targets);

    const res = await toolNamed("panel_save_workflow").handler({ name: "photo_to_anime_main" }, ctx);

    expect(res.isError).toBeFalsy();
    expect(saved).toBe(true);
    expect(ctx.tabId).toBe(NEW_TAB);
    expect(ctx.tabId).not.toBe(OLD_TAB);
    expect(targets.get(NEW_TAB)).toMatchObject({ mode: "pinned", path: "workflows/Untitled 1.json" });
    expect(targets.get(OLD_TAB)).toEqual({ mode: "current" });
  });

  it("the next panel_set_todo and panel_canvas land on the dest tab, not the retired id", async () => {
    const targets = new WorkflowTargetStore();
    targets.set(OLD_TAB, { mode: "pinned", path: "workflows/Untitled 1.json" });
    const ctx = makePanelToolCtx(bridgeFor(), OLD_TAB, targets);
    await toolNamed("panel_save_workflow").handler({ name: "photo_to_anime_main" }, ctx);

    sent = [];
    sentTab = [];
    const todo = await toolNamed("panel_set_todo").handler(
      { items: [{ text: "continue", status: "active" }] },
      ctx,
    );
    const canvas = await toolNamed("panel_canvas").handler({ action: "fit" }, ctx);

    expect(todo.isError, textOf(todo)).toBeFalsy();
    expect(canvas.isError, textOf(canvas)).toBeFalsy();
    expect(sent.map((c) => c.cmd)).toEqual(["set_todo", "graph_canvas"]);
    expect(sentTab.every((id) => id === NEW_TAB)).toBe(true);
    expect(sentTab).not.toContain(OLD_TAB);
  });

  it("does not displace a live pin — the old tab is still reachable (#1917)", async () => {
    const ctx = makePanelToolCtx(bridgeFor({ keepOldTab: true }), OLD_TAB, new WorkflowTargetStore());
    const res = await toolNamed("panel_save_workflow").handler({ name: "photo_to_anime_main" }, ctx);

    expect(res.isError).toBeFalsy();
    expect(ctx.tabId).toBe(OLD_TAB);
  });
});

describe("#2419 Save-As re-points a dead SCOPE pin onto the dest canvas", () => {
  it("calls repinScopeToWorkflow with the dest path the save reply proved", async () => {
    const ctx = makePanelToolCtx(bridgeFor(), SCOPE, new WorkflowTargetStore());
    const res = await toolNamed("panel_save_workflow").handler({ name: "photo_to_anime_main" }, ctx);

    expect(res.isError).toBeFalsy();
    expect(scopeRepins).toEqual([{ scope: SCOPE, path: DEST_PATH }]);
    expect(scopePin).toBe(NEW_TAB);
  });

  it("the next panel_set_todo and panel_canvas then resolve through the dest pin", async () => {
    const ctx = makePanelToolCtx(bridgeFor(), SCOPE, new WorkflowTargetStore());
    await toolNamed("panel_save_workflow").handler({ name: "photo_to_anime_main" }, ctx);

    sent = [];
    sentTab = [];
    const todo = await toolNamed("panel_set_todo").handler(
      { items: [{ text: "continue", status: "active" }] },
      ctx,
    );
    const canvas = await toolNamed("panel_canvas").handler({ action: "fit" }, ctx);

    expect(todo.isError, textOf(todo)).toBeFalsy();
    expect(canvas.isError, textOf(canvas)).toBeFalsy();
    expect(sent.map((c) => c.cmd)).toEqual(["set_todo", "graph_canvas"]);
    expect(reachable.has(scopePin)).toBe(true);
  });

  it("does not call repinScopeToWorkflow when the scope pin still reaches (#1917)", async () => {
    const ctx = makePanelToolCtx(bridgeFor({ keepOldTab: true }), SCOPE, new WorkflowTargetStore());
    await toolNamed("panel_save_workflow").handler({ name: "photo_to_anime_main" }, ctx);

    expect(scopeRepins).toEqual([]);
    expect(scopePin).toBe(OLD_TAB);
  });
});

describe("#2419 Save-As routing recovery stays fail-closed when dest is ambiguous", () => {
  it("leaves routing on the old address when two live tabs match the dest path", async () => {
    const b = bridgeFor();
    const origSend = b.send;
    b.send = async (c, extra) => {
      const out = await origSend(c, extra);
      if (c.cmd === "workflow_save_as") {
        liveTabs = [
          { tab_id: NEW_TAB, title: "photo_to_anime_main", connected_at: 1 },
          { tab_id: "wf:other:workflows/photo_to_anime_main.json", title: "copy", connected_at: 2 },
        ];
        reachable = new Set();
      }
      return out;
    };
    const ctx = makePanelToolCtx(b, OLD_TAB, new WorkflowTargetStore());
    await toolNamed("panel_save_workflow").handler({ name: "photo_to_anime_main" }, ctx);
    expect(ctx.tabId).toBe(OLD_TAB);
  });
});

describe("#2419 WIRING: save re-points routing before the fence refresh", () => {
  it("panel_save_workflow calls repointRoutingAfterSave immediately before refreshFenceFromOwnReply", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../orchestrator/panel-tools.ts"),
      "utf8",
    );
    const saveIdx = src.indexOf('"panel_save_workflow"');
    expect(saveIdx).toBeGreaterThan(0);
    const saveBlock = src.slice(saveIdx, saveIdx + 9000);
    expect(saveBlock).toMatch(
      /repointRoutingAfterSave\(ctx, res\);\s*const fenceRebind = refreshFenceFromOwnReply\(ctx, res\)/,
    );
  });
});

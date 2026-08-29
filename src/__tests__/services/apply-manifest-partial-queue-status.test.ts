// #1699 — apply_manifest must not look complete while custom_nodes were never
// submitted, and panel_node_queue_status must not report a drained queue as
// apply_manifest completion of those leftovers.
//
// This file drives the SHIPPED applyManifest + panel_node_queue_status path
// (I/O is mocked; the result assembly and queue-status annotation are real).
import { beforeEach, describe, expect, it, vi } from "vitest";

const installCustomNodeMock = vi.hoisted(() => vi.fn());
const listInstalledNodesMock = vi.hoisted(() => vi.fn());

vi.mock("../../config.js", () => ({
  config: { comfyuiPath: "/fake/ComfyUI" },
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyuiTargetGeneration: () => 0,
  isRemoteMode: () => false,
}));

vi.mock("../../services/node-management.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/node-management.js")>();
  return {
    ...actual,
    installCustomNode: (...a: unknown[]) => installCustomNodeMock(...a),
    listInstalledNodes: (...a: unknown[]) => listInstalledNodesMock(...a),
  };
});

import { applyManifest } from "../../services/manifest.js";
import {
  buildManifestPartial,
  clearManifestPartialLeftover,
  describeManifestSource,
  getManifestPartialLeftover,
  recordManifestPartial,
} from "../../services/manifest-partial.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

const TAB = "11111111-2222-3333-4444-555555555555";

const textOf = (r: ToolResult): string =>
  r.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

function drainedBridge(): PanelToolCtx["bridge"] {
  return {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "nodes_queue_status") {
        // The reporter's exact "all installs finished" reading.
        return {
          status: {
            total_count: 0,
            done_count: 5,
            in_progress_count: 0,
            pending_count: 0,
            is_processing: false,
          },
          failure_reporting: "complete",
        };
      }
      return { ok: true };
    },
    tabIncarnation: () => "inc-A",
    push: () => 1,
    canReach: (id: string) => id === TAB,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: () => true,
    workflowUuidFor: () => ({ known: false }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

async function queueStatus(): Promise<{ text: string; parsed: Record<string, unknown> | null }> {
  const ctx = makePanelToolCtx(drainedBridge(), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_node_queue_status");
  if (!def) throw new Error("panel_node_queue_status is not registered");
  const res: ToolResult = await def.handler({} as never, ctx);
  const text = textOf(res);
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  return { text, parsed };
}

beforeEach(() => {
  clearManifestPartialLeftover();
  listInstalledNodesMock.mockReset().mockResolvedValue([]);
  installCustomNodeMock.mockReset();
});

describe("apply_manifest leftover + panel_node_queue_status (#1699)", () => {
  it("names the PARTIAL INSTALL and refuses to treat a drained queue as complete", async () => {
    const prevBudget = process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS;
    process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS = "40";
    installCustomNodeMock.mockReturnValueOnce(new Promise(() => {}));

    try {
      const applied = await applyManifest({
        manifest: {
          custom_nodes: [
            "https://github.com/ltdrdata/ComfyUI-Impact-Pack",
            "SeedVarianceEnhancer",
            "comfyui_controlnet_aux",
          ],
        },
      });

      expect(applied.success).toBe(false);
      expect(applied.partial?.kind).toBe("custom_nodes_not_started");
      expect(applied.partial?.not_started).toEqual([
        "SeedVarianceEnhancer",
        "comfyui_controlnet_aux",
      ]);
      expect(applied.partial?.message).toMatch(/PARTIAL INSTALL/);
      expect(applied.partial?.message).toMatch(/SeedVarianceEnhancer/);
      expect(applied.partial?.message).toMatch(/comfyui_controlnet_aux/);
      expect(getManifestPartialLeftover()?.not_started).toEqual([
        "SeedVarianceEnhancer",
        "comfyui_controlnet_aux",
      ]);

      const { text, parsed } = await queueStatus();
      expect(parsed, "queue-status must stay parseable JSON").not.toBeNull();
      expect(parsed?.queue_complete_for_apply_manifest).toBe(false);
      const leftover = parsed?.apply_manifest_partial as {
        not_started?: string[];
        message?: string;
      };
      expect(leftover?.not_started).toEqual([
        "SeedVarianceEnhancer",
        "comfyui_controlnet_aux",
      ]);
      expect(leftover?.message ?? text).toMatch(/PARTIAL INSTALL/);
      expect(text).toMatch(/SeedVarianceEnhancer/);
      expect(text).toMatch(/comfyui_controlnet_aux/);
      expect(text).not.toMatch(/poll the Manager queue/i);
    } finally {
      if (prevBudget === undefined) delete process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS;
      else process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS = prevBudget;
    }
  });

  it("names the pack in the PARTIAL INSTALL message", () => {
    const source = describeManifestSource({ pack: "z-image-turbo-controlnet" });
    const partial = buildManifestPartial({
      source,
      notStarted: ["SeedVarianceEnhancer", "comfyui_controlnet_aux"],
      stillInstalling: ["RES4LYF"],
    });
    expect(partial?.source).toBe('pack "z-image-turbo-controlnet"');
    expect(partial?.message).toMatch(/PARTIAL INSTALL of pack "z-image-turbo-controlnet"/);
    expect(partial?.message).toMatch(/SeedVarianceEnhancer/);
    expect(partial?.message).toMatch(/comfyui_controlnet_aux/);
    expect(partial?.message).toMatch(/RES4LYF/);
    expect(partial?.message).toMatch(/not on that queue/i);
  });

  it("does not annotate a drained queue when apply_manifest left nothing unsubmitted", async () => {
    listInstalledNodesMock.mockResolvedValue([
      { module: "already", cnrId: "already", enabled: true },
    ]);
    const applied = await applyManifest({
      manifest: { custom_nodes: ["already"] },
    });
    expect(applied.success).toBe(true);
    expect(applied.partial).toBeUndefined();
    expect(getManifestPartialLeftover()).toBeNull();

    const { parsed } = await queueStatus();
    expect(parsed?.queue_complete_for_apply_manifest).toBeUndefined();
    expect(parsed?.apply_manifest_partial).toBeUndefined();
  });

  it("retains submitted UNKNOWN entries when no custom_node was left unsubmitted (#1129)", async () => {
    const id = "https://github.com/example/ambiguous-pack";
    const partial = buildManifestPartial({
      source: "this inline manifest",
      notStarted: [],
      stillInstalling: [id],
      outcomeUnknown: [id],
    });

    expect(partial).not.toBeNull();
    expect(partial).toMatchObject({
      not_started: [],
      still_installing: [id],
      outcome_unknown: [id],
    });
    expect(partial?.message).toMatch(/outcome is UNKNOWN/i);
    expect(partial?.message).toMatch(/no local direct-install fallback is authorized/i);

    recordManifestPartial(partial);
    expect(getManifestPartialLeftover()).toMatchObject({
      not_started: [],
      still_installing: [id],
      outcome_unknown: [id],
    });

    const { text, parsed } = await queueStatus();
    expect(parsed?.queue_complete_for_apply_manifest).toBe(false);
    expect(parsed?.apply_manifest_partial).toMatchObject({
      not_started: [],
      still_installing: [id],
      outcome_unknown: [id],
    });
    expect(text).toMatch(/UNKNOWN/i);
    expect(text).toMatch(/no local direct-install fallback is authorized/i);
  });
});

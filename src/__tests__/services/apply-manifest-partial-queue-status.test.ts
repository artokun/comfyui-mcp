// #1699 — apply_manifest must not look complete while custom_nodes were never
// submitted, and panel_node_queue_status must not report a drained queue as
// apply_manifest completion of those leftovers.
//
// This file drives the SHIPPED applyManifest + panel_node_queue_status path
// (I/O is mocked; the result assembly and queue-status annotation are real).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  createManifestPartialOperation,
  describeManifestSource,
  getManifestPartialLeftover,
  readManifestPartials,
  recordManifestPartial,
} from "../../services/manifest-partial.js";
import {
  configureManifestOutcomeReader,
  publishManifestOutcome,
  resetManifestOutcomeReader,
} from "../../services/manifest-outcome-channel.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

const TAB = "11111111-2222-3333-4444-555555555555";
const TARGET = "http://127.0.0.1:8188";
const SCOPE = "orchestrator::test";
let previousOutcomeScope: string | undefined;

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

async function queueStatus(opts: {
  bridge?: PanelToolCtx["bridge"];
  target?: () => { url: string; generation: number } | undefined;
} = {}): Promise<{ text: string; parsed: Record<string, unknown> | null }> {
  const ctx = makePanelToolCtx(opts.bridge ?? drainedBridge(), TAB, new WorkflowTargetStore(), undefined, {
    manifestOutcomeScope: SCOPE,
    manifestOutcomeTarget: opts.target ?? (() => ({ url: TARGET, generation: 0 })),
  });
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
  previousOutcomeScope = process.env.COMFYUI_MCP_TAB;
  process.env.COMFYUI_MCP_TAB = SCOPE;
  listInstalledNodesMock.mockReset().mockResolvedValue([]);
  installCustomNodeMock.mockReset();
});

afterEach(() => {
  clearManifestPartialLeftover();
  if (previousOutcomeScope === undefined) delete process.env.COMFYUI_MCP_TAB;
  else process.env.COMFYUI_MCP_TAB = previousOutcomeScope;
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

    recordManifestPartial(partial, { target: TARGET, scope: SCOPE });
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

  it("annotates a signed child partial through the production channel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmcp-manifest-panel-"));
    const id = "https://github.com/example/child-only-pack";
    const partial = buildManifestPartial({
      source: "this inline manifest",
      notStarted: [],
      stillInstalling: [id],
      outcomeUnknown: [id],
    });
    if (!partial) throw new Error("expected partial fixture");
    try {
      // This is the child-side write; the panel tool reads through a separately
      // configured orchestrator-side verifier, with no process-local record.
      expect(
        publishManifestOutcome(partial, {
          dir,
          secret: "orchestrator-issued-child-secret",
          scope: SCOPE,
          target: TARGET,
        }),
      ).toBe(true);
      configureManifestOutcomeReader(dir, () => [
        { secret: "orchestrator-issued-child-secret", scope: SCOPE },
      ]);

      clearManifestPartialLeftover();
      const { parsed, text } = await queueStatus();
      expect(parsed?.queue_complete_for_apply_manifest).toBe(false);
      expect(parsed?.apply_manifest_partial).toMatchObject({
        still_installing: [id],
        outcome_unknown: [id],
      });
      expect(text).toMatch(/UNKNOWN/i);
    } finally {
      resetManifestOutcomeReader();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to annotate a status poll that crosses a ComfyUI retarget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmcp-manifest-retarget-"));
    const id = "https://github.com/example/old-target-pack";
    const partial = buildManifestPartial({
      source: "this inline manifest",
      notStarted: [],
      stillInstalling: [id],
      outcomeUnknown: [id],
    });
    if (!partial) throw new Error("expected partial fixture");
    let current = { url: TARGET, generation: 1 };
    const bridge = drainedBridge();
    const send = bridge.send;
    bridge.send = async (cmd: Record<string, unknown>) => {
      const result = await send(cmd);
      if (cmd.cmd === "nodes_queue_status") current = { url: "http://127.0.0.1:8189", generation: 2 };
      return result;
    };
    try {
      expect(
        publishManifestOutcome(partial, {
          dir,
          secret: "retarget-child-secret",
          scope: SCOPE,
          target: TARGET,
          operationId: "retarget-operation",
        }),
      ).toBe(true);
      configureManifestOutcomeReader(dir, () => [
        { secret: "retarget-child-secret", scope: SCOPE },
      ]);
      const { parsed } = await queueStatus({ bridge, target: () => current });
      expect(parsed?.apply_manifest_partial).toBeUndefined();
      expect(parsed?.queue_complete_for_apply_manifest).toBeUndefined();
    } finally {
      resetManifestOutcomeReader();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a late callback from an older operation after a newer record supersedes it", () => {
    const id = "https://github.com/example/old-operation-pack";
    const oldOperation = createManifestPartialOperation({
      operationId: "old-operation",
      source: "this inline manifest",
      scope: SCOPE,
      target: TARGET,
      targetGeneration: 1,
    });
    const oldBinding = oldOperation.bindItem(id);
    const oldPartial = buildManifestPartial({
      source: "this inline manifest",
      notStarted: [],
      stillInstalling: [id],
      outcomeUnknown: [id],
    });
    if (!oldPartial) throw new Error("expected old partial fixture");
    expect(
      oldOperation.reconcile({ ...oldBinding }, "selected"),
    ).toBe(false);
    expect(oldOperation.reconcile(oldBinding, "selected")).toBe(true);
    oldOperation.record(oldPartial);

    const newId = "https://github.com/example/new-operation-pack";
    const newOperation = createManifestPartialOperation({
      operationId: "new-operation",
      source: "this inline manifest",
      scope: SCOPE,
      target: TARGET,
      targetGeneration: 1,
    });
    const newPartial = buildManifestPartial({
      source: "this inline manifest",
      notStarted: [newId],
      stillInstalling: [],
    });
    if (!newPartial) throw new Error("expected new partial fixture");
    newOperation.record(newPartial);

    expect(oldOperation.reconcile(oldBinding, "failed")).toBe(false);
    expect(readManifestPartials(TARGET, SCOPE, 1)).toEqual([newPartial]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const restartMock = vi.hoisted(() => vi.fn());
const panelTarget = vi.hoisted(() => ({
  baseUrl: "http://127.0.0.1:8188",
  generation: 0,
}));
const panelTabTarget = vi.hoisted(() => ({
  baseUrl: "http://127.0.0.1:8188",
}));
const kitchenFixture = vi.hoisted(() => ({
  rec: {
    id: "ck_attention",
    kind: "ck_attention",
    why: "INT8 attention is available.",
    safe: "Restart required; consent-gated.",
    restart: true,
    download: false,
    change: { type: "flag", flag: "--use-ck-attention" },
  } as any,
  raceWidgetDispatch: false,
  widgetReachabilityArmed: false,
}));

vi.mock("../../services/workspace-env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/workspace-env.js")>();
  return { ...actual, resolveComfyuiPython: () => ({ python: undefined }) };
});

vi.mock("../../services/instance-witness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/instance-witness.js")>();
  return { ...actual, acquireInstanceWitness: async () => undefined };
});

vi.mock("../../comfyui/client.js", () => ({
  getLogs: vi.fn(async () => []),
  getSystemStats: vi.fn(async () => ({ system: { argv: [] }, devices: [] })),
}));

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    getComfyUIBaseUrl: () => panelTarget.baseUrl,
    getComfyuiTargetGeneration: () => panelTarget.generation,
  };
});

vi.mock("../../services/process-control.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/process-control.js")>();
  return { ...actual, restartComfyUI: restartMock };
});

vi.mock("../../services/kitchen.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/kitchen.js")>();
  return {
    ...actual,
    gatherKitchenStatus: vi.fn(async () => ({})),
    assessKitchenGraph: vi.fn(async () => {
      if (kitchenFixture.raceWidgetDispatch) kitchenFixture.widgetReachabilityArmed = true;
      return [kitchenFixture.rec];
    }),
  };
});

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { captureComfyUITargetFence } from "../../services/process-control.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";
function textOf(res: ToolResult): string {
  return res.content.map((c) => ("text" in c ? c.text : "")).join("\n");
}

function panelKitchenHarness(onGraphQuery?: () => void, onGraphRun?: () => void) {
  const sent: Array<Record<string, unknown>> = [];
  const beforeDispatch = { count: 0 };
  let widgetReachabilityRetargeted = false;
  const bridge = {
    send: async (
      cmd: Record<string, unknown>,
      sendOpts?: { beforeDispatch?: () => void },
    ) => {
      if (cmd.cmd === "graph_set_widget") {
        beforeDispatch.count += 1;
        sendOpts?.beforeDispatch?.();
      }
      sent.push(cmd);
      if (cmd.cmd === "graph_query") {
        onGraphQuery?.();
        return { nodes: [] };
      }
      if (cmd.cmd === "graph_run") onGraphRun?.();
      return {};
    },
    push: () => 1,
    canReach: () => !kitchenFixture.widgetReachabilityArmed || widgetReachabilityRetargeted,
    isHeadless: () => false,
    tabs: () => {
      if (kitchenFixture.widgetReachabilityArmed && !widgetReachabilityRetargeted) {
        widgetReachabilityRetargeted = true;
        panelTarget.baseUrl = "http://127.0.0.1:8288";
        panelTarget.generation = 1;
      }
      return [{ tab_id: TAB, title: "wf", connected_at: 0 }];
    },
    tabOrigin: () => panelTabTarget.baseUrl,
    tabServerOrigin: () => new URL(panelTabTarget.baseUrl).origin,
    tabIsLocal: () => true,
    resolveActiveTabId: () => TAB,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    workflowUuidFor: () => ({ known: false }),
    refreshWorkflowUuid: () => true,
  } as unknown as PanelToolCtx["bridge"];
  const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_kitchen")!;
  return { ctx, def, sent, beforeDispatch };
}

beforeEach(() => {
  vi.clearAllMocks();
  panelTarget.baseUrl = "http://127.0.0.1:8188";
  panelTarget.generation = 0;
  panelTabTarget.baseUrl = "http://127.0.0.1:8188";
  kitchenFixture.rec = {
    id: "ck_attention",
    kind: "ck_attention",
    why: "INT8 attention is available.",
    safe: "Restart required; consent-gated.",
    restart: true,
    download: false,
    change: { type: "flag", flag: "--use-ck-attention" },
  } as any;
  kitchenFixture.raceWidgetDispatch = false;
  kitchenFixture.widgetReachabilityArmed = false;
});

const widgetRecommendation = {
  id: "fp8_unet_fast:12",
  kind: "fp8_unet_fast",
  node_id: "12",
  why: "The live graph can use the faster FP8 dtype.",
  safe: "Widget-only change.",
  restart: false,
  download: false,
  change: {
    type: "widget",
    widget: "weight_dtype",
    value: "fp8_e4m3fn_fast",
    previous: "default",
  },
};

describe("panel_kitchen flag apply (#2277)", () => {
  it("reports applied only when the owned relaunch and serving argv prove the flag", async () => {
    restartMock.mockResolvedValue({
      stopped: true,
      started: true,
      startup: "confirmed",
      listener_ownership: "ours",
      message: "ComfyUI restarted successfully.",
      serving_argv: ["main.py", "--use-ck-attention"],
      target_fence: captureComfyUITargetFence(),
      target_stable: true,
    });
    const { ctx, def } = panelKitchenHarness();

    const res = await def.handler(
      { action: "apply", recommendation_id: "ck_attention", confirm: true, skip_proof: true } as never,
      ctx,
    );
    const body = JSON.parse(textOf(res));

    expect(body.applied).toBe(true);
    expect(body.flag_note).toMatch(/observed it in the serving ComfyUI argv/i);
    expect(restartMock).toHaveBeenCalledWith({
      additionalFlags: ["--use-ck-attention"],
      targetFence: captureComfyUITargetFence(),
    });
  });

  it("returns the launcher-specific refusal and applied:false when restart cannot inject it", async () => {
    restartMock.mockResolvedValue({
      stopped: false,
      started: false,
      startup: "not-attempted",
      listener_ownership: "unconfirmed",
      message:
        "Refusing to apply --use-ck-attention: ComfyUI Desktop owns the saved launch settings. " +
        "No launch argument was changed and ComfyUI was not stopped.",
      target_fence: captureComfyUITargetFence(),
      target_stable: true,
    });
    const { ctx, def } = panelKitchenHarness();

    const res = await def.handler(
      { action: "apply", recommendation_id: "ck_attention", confirm: true, skip_proof: true } as never,
      ctx,
    );
    const body = JSON.parse(textOf(res));

    expect(body.applied).toBe(false);
    expect(body.flag_note).toMatch(/Desktop owns the saved launch settings/i);
    expect(body.flag_note).toMatch(/applied:false/i);
  });

  it("refuses a cross-tab retarget during graph assessment before restart", async () => {
    const { ctx, def } = panelKitchenHarness(() => {
      panelTarget.baseUrl = "http://127.0.0.1:8288";
      panelTarget.generation = 1;
    });

    const res = await def.handler(
      { action: "apply", recommendation_id: "ck_attention", confirm: true, skip_proof: true } as never,
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/target changed/i);
    expect(restartMock).not.toHaveBeenCalled();
  });

  it("returns applied:false when the target changes during the relaunch result", async () => {
    restartMock.mockImplementation(async () => {
      panelTarget.baseUrl = "http://127.0.0.1:8288";
      panelTarget.generation = 1;
      return {
        stopped: true,
        started: true,
        startup: "confirmed",
        listener_ownership: "ours",
        message: "ComfyUI restarted successfully.",
        serving_argv: ["main.py", "--use-ck-attention"],
        target_fence: {
          baseUrl: "http://127.0.0.1:8188",
          generation: 0,
        },
        target_stable: true,
      };
    });
    const { ctx, def } = panelKitchenHarness();

    const res = await def.handler(
      { action: "apply", recommendation_id: "ck_attention", confirm: true, skip_proof: true } as never,
      ctx,
    );
    const body = JSON.parse(textOf(res));

    expect(body.applied).toBe(false);
    expect(body.flag_note).toMatch(/target changed/i);
    expect(restartMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the consent gate before any launcher mutation", async () => {
    const { ctx, def } = panelKitchenHarness();

    const res = await def.handler(
      { action: "apply", recommendation_id: "ck_attention", confirm: false, skip_proof: true } as never,
      ctx,
    );
    const body = JSON.parse(textOf(res));

    expect(body.applied).toBe(false);
    expect(body.needs_confirm).toBe(true);
    expect(restartMock).not.toHaveBeenCalled();
  });

  it("refuses widget dispatch when retargeting occurs during reachability wait", async () => {
    kitchenFixture.rec = widgetRecommendation as any;
    kitchenFixture.raceWidgetDispatch = true;
    const { ctx, def, sent, beforeDispatch } = panelKitchenHarness();

    const res = await def.handler(
      { action: "apply", recommendation_id: widgetRecommendation.id, skip_proof: true } as never,
      ctx,
    );
    const body = JSON.parse(textOf(res));

    expect(body.applied).toBe(false);
    expect(body.stale).toBe(true);
    expect(textOf(res)).toMatch(/target changed/i);
    expect(sent.some((cmd) => cmd.cmd === "graph_query")).toBe(true);
    expect(sent.some((cmd) => cmd.cmd === "graph_set_widget")).toBe(false);
    expect(beforeDispatch.count).toBe(1);
  });

  it("returns applied:false/stale when retargeting occurs during post-apply graph_run", async () => {
    kitchenFixture.rec = widgetRecommendation as any;
    const { ctx, def, sent } = panelKitchenHarness(undefined, () => {
      panelTarget.baseUrl = "http://127.0.0.1:8288";
      panelTarget.generation = 1;
    });

    const res = await def.handler(
      { action: "apply", recommendation_id: widgetRecommendation.id } as never,
      ctx,
    );
    const body = JSON.parse(textOf(res));

    expect(body.applied).toBe(false);
    expect(body.stale).toBe(true);
    expect(body.target_stable).toBe(false);
    expect(body.proof.status).toBe("stale");
    expect(textOf(res)).toMatch(/proof graph_run was in flight/i);
    expect(sent.some((cmd) => cmd.cmd === "graph_set_widget")).toBe(true);
    expect(sent.some((cmd) => cmd.cmd === "graph_run")).toBe(true);
  });
});

// #2180 — Panel 0.15.71 can report a registry install as unverified when the
// zip landed in custom_nodes but Manager did not add it to its installed list.
// The MCP fallback is allowed only with same-target local, readable pack evidence.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  remote: false,
  scanBase: undefined as string | undefined,
}));

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    isCloudMode: () => false,
    isRemoteMode: () => state.remote,
    getBootLocalComfyUIBaseUrl: () => "http://127.0.0.1:8188",
    getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  };
});

vi.mock("../../services/workspace-env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/workspace-env.js")>();
  return {
    ...actual,
    resolveCustomNodesScanBaseLive: async () => state.scanBase,
  };
});

const { buildPanelToolDefs, makePanelToolCtx } = await import("../../orchestrator/panel-tools.js");
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const TAB = "11111111-2222-3333-4444-555555555555";

function installDef() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_install_node");
  if (!def) throw new Error("panel_install_node is not registered");
  return def;
}

function bridge() {
  return {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "nodes_install") {
        return {
          queued: true,
          installed: false,
          verified: false,
          pending: false,
          id: "comfyui-reactor",
          dialect: "v4",
          note: "The installed list did not contain the target.",
        };
      }
      if (cmd.cmd === "nodes_queue_status") {
        return { status: { pending_count: 0, is_processing: true } };
      }
      return { ok: true };
    },
    tabIncarnation: () => "inc-A",
    tabIsLocal: () => true,
    tabServerOrigin: () => "http://127.0.0.1:8188",
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

async function install(id: string): Promise<Record<string, unknown>> {
  const ctx = makePanelToolCtx(bridge(), TAB, new WorkflowTargetStore());
  const result: ToolResult = await installDef().handler({ id } as never, ctx);
  const text = result.content.find((content) => content.type === "text");
  if (!text || text.type !== "text") throw new Error("install result had no text payload");
  return JSON.parse(text.text) as Record<string, unknown>;
}

beforeEach(() => {
  state.remote = false;
  state.scanBase = undefined;
});

describe("panel_install_node registry verification (#2180)", () => {
  it("accepts a readable pack on the live target and reports restart_required", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmcp-2180-"));
    try {
      const pack = join(root, "custom_nodes", "comfyui-reactor");
      mkdirSync(pack, { recursive: true });
      writeFileSync(join(pack, "__init__.py"), "NODE_CLASS_MAPPINGS = {}\n");
      state.scanBase = root;

      const result = await install("comfyui-reactor");

      expect(result.installed).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.restart_required).toBe(true);
      expect(result.verification_evidence).toBe("on-disk");
      expect(String(result.note)).toMatch(/readable custom-node pack/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the panel failure when the matching directory is absent or the panel is remote", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmcp-2180-"));
    try {
      const unrelated = join(root, "custom_nodes", "another-pack");
      mkdirSync(unrelated, { recursive: true });
      writeFileSync(join(unrelated, "__init__.py"), "NODE_CLASS_MAPPINGS = {}\n");
      state.scanBase = root;

      const absent = await install("comfyui-reactor");
      expect(absent.installed).toBe(false);
      expect(absent.verified).toBe(false);
      expect(absent.restart_required).toBeUndefined();

      const matching = join(root, "custom_nodes", "comfyui-reactor");
      mkdirSync(matching, { recursive: true });
      writeFileSync(join(matching, "__init__.py"), "NODE_CLASS_MAPPINGS = {}\n");
      state.remote = true;

      const remote = await install("comfyui-reactor");
      expect(remote.installed).toBe(false);
      expect(remote.verified).toBe(false);
      expect(remote.restart_required).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not promote an install-marker-only directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmcp-2180-"));
    try {
      const pack = join(root, "custom_nodes", "comfyui-reactor");
      mkdirSync(pack, { recursive: true });
      writeFileSync(join(pack, ".tracking"), "{}\n");
      state.scanBase = root;

      const result = await install("comfyui-reactor");

      expect(result.installed).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.restart_required).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// #1708 — panel_add_node("Lora Loader (LoraManager)") is refused after 5s even when
// the pack is healthy. The panel waits for app.widgets["AUTOCOMPLETE_TEXT_LORAS"],
// which ComfyUI 1.49+ never populates (getCustomWidgets goes to the widget store).
//
// Reload / panel_refresh_nodes / retry cannot help. The orchestrator must keep the
// panel's refusal and name the STRING-socket node that DOES add.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";

/** The reporter's exact panel refusal (issue #1708). */
const REPORTER_REFUSAL =
  `Cannot add "Lora Loader (LoraManager)": 1 required input type had no widget after 5.0s ` +
  `waiting for node extensions to register.\n` +
  `- input "text" (declared type "AUTOCOMPLETE_TEXT_LORAS"): no installed node outputs ` +
  `"AUTOCOMPLETE_TEXT_LORAS" and no frontend widget is registered for it.`;

function bridge(message: string) {
  const calls: string[] = [];
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push(String(cmd.cmd));
      throw new Error(message);
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { b, calls };
}

async function addNode(classType: string, message: string) {
  const { b, calls } = bridge(message);
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_add_node");
  if (!def) throw new Error("panel_add_node is not registered");
  const res: ToolResult = await def.handler({ class_type: classType } as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
    calls,
  };
}

describe("panel_add_node names the STRING-socket LoRA Manager loader (#1708)", () => {
  it("the reporter's case: keeps the refusal and points at LoRA Text Loader", async () => {
    const { text, isError, calls } = await addNode("Lora Loader (LoraManager)", REPORTER_REFUSAL);

    expect(isError).toBe(true);
    expect(text).toContain(REPORTER_REFUSAL);
    expect(text).toContain("LoRA Text Loader (LoraManager)");
    expect(text).toMatch(/lora_syntax/);
    expect(text).toMatch(/Do not retry this class_type/);
    // The panel names a reload; that remedy cannot work and must be contradicted.
    expect(text).toMatch(/reload \/ panel_refresh_nodes \/ retry will keep failing/i);
    expect(calls).toEqual(["graph_add_node"]);
  });

  it("does not retry or refresh — those cannot surface the Vue widget", async () => {
    const { calls } = await addNode("Lora Loader (LoraManager)", REPORTER_REFUSAL);
    expect(calls.filter((c) => c === "graph_add_node")).toHaveLength(1);
    expect(calls).not.toContain("refresh_nodes");
  });

  it("a different custom-widget wait is left alone", async () => {
    // SaveGLB-style union wait (#1062) shares the panel sentence but is NOT a
    // LoRA Manager Vue widget. Inventing the Text Loader remedy there is wrong.
    const other =
      `Cannot add "SaveGLB": 1 required input type had no widget after 5.0s ` +
      `waiting for node extensions to register.\n` +
      `- input "mesh" (declared type "MESH,FILE_3D_GLB"): no installed node outputs ` +
      `"MESH,FILE_3D_GLB" and no frontend widget is registered for it.`;
    const { text, isError } = await addNode("SaveGLB", other);

    expect(isError).toBe(true);
    expect(text).toContain(other);
    expect(text).not.toContain("LoRA Text Loader (LoraManager)");
    expect(text).not.toMatch(/Do not retry this class_type/);
  });

  it("a healthy add is untouched", async () => {
    const calls: string[] = [];
    const b = {
      send: async (cmd: Record<string, unknown>) => {
        calls.push(String(cmd.cmd));
        return { ok: true, node_id: 7 };
      },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => TAB,
      tabCanMutateGraph: () => true,
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_add_node");
    if (!def) throw new Error("panel_add_node is not registered");
    const res = await def.handler({ class_type: "LoRA Text Loader (LoraManager)" } as never, ctx);

    expect(res.isError).toBeFalsy();
    expect(calls).toEqual(["graph_add_node"]);
    const text = res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
    expect(text).not.toMatch(/Do not retry this class_type/);
  });
});

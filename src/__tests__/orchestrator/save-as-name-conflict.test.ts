// #1873 — after a Save-As copy, saving the edited graph back under the original
// name 409s, and the panel's "choose a different name" is what forced a third
// workflow file. There is no overwrite switch (ComfyUI's saveWorkflowAs would
// DELETE the occupant on confirm; the panel refuses that path). The supported
// way is panel_rename_workflow on the closed original, then on the active copy.
//
// Tests drive panel_save_workflow. The 409 text is the panel's conflictError.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/A_backup.json";

/** The reporter's exact 409 (issue #1873, from the panel's conflictError). */
const REPORTER_CONFLICT =
  `a workflow named "MiniMax_H3_Modular_Ref2VA_Long" already exists (409 Conflict) — ` +
  `choose a different name. The active tab was left unchanged (issue #309).`;

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

function saveDef() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_save_workflow");
  if (!def) throw new Error("panel_save_workflow is not registered");
  return def;
}

async function saveAs(name: string | undefined, message: string) {
  const { b, calls } = bridge(message);
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  const res: ToolResult = await saveDef().handler(
    (name === undefined ? {} : { name }) as never,
    ctx,
  );
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
    calls,
  };
}

describe("#1873 panel_save_workflow names the rename path on a Save-As 409", () => {
  it("the reporter's case: keeps the 409 and does not tell the agent to pick a third name as the fix", async () => {
    const { text, isError, calls } = await saveAs(
      "MiniMax_H3_Modular_Ref2VA_Long",
      REPORTER_CONFLICT,
    );

    expect(isError).toBe(true);
    expect(text).toContain(REPORTER_CONFLICT);
    expect(text).toMatch(/Do NOT pick a third name/i);
    expect(text).toContain("panel_rename_workflow");
    expect(text).toMatch(/CLOSED listed/i);
    expect(text).toMatch(/panel_save_workflow\(\)/);
    expect(calls).toEqual(["workflow_save_as"]);
  });

  it("does not dispatch a rename or a second save — the 409 wrote nothing", async () => {
    const { calls } = await saveAs("A", REPORTER_CONFLICT);
    expect(calls).toEqual(["workflow_save_as"]);
    expect(calls).not.toContain("workflow_rename");
    expect(calls).not.toContain("workflow_save");
  });

  it("an in-place 409 over the workflow's OWN file is left alone (#442)", async () => {
    const inplace =
      `Error storing user data file 'workflows/MiniMax_H3_Modular_Ref2VA_Long.json': 409 Conflict`;
    const { text, isError } = await saveAs(undefined, inplace);

    expect(isError).toBe(true);
    expect(text).toContain(inplace);
    expect(text).not.toMatch(/Do NOT pick a third name/i);
    expect(text).not.toContain("panel_rename_workflow");
  });

  it("a different named-save failure is left alone", async () => {
    const other = "name must not be blank — pass a non-whitespace workflow name";
    const { text, isError } = await saveAs("  ", other);

    expect(isError).toBe(true);
    expect(text).toContain(other);
    expect(text).not.toMatch(/Do NOT pick a third name/i);
  });

  it("a successful Save-As is untouched", async () => {
    const calls: string[] = [];
    const b = {
      send: async (cmd: Record<string, unknown>) => {
        calls.push(String(cmd.cmd));
        if (cmd.cmd === "workflow_save_as") {
          return {
            saved: true,
            workflow: "A_backup",
            saved_as: true,
            copied_from: "A",
            original_on_disk: true,
            workflow_uuid: "11111111-2222-4333-8444-555555555555",
          };
        }
        if (cmd.cmd === "workflow_list") {
          return {
            active: {
              path: "workflows/A_backup.json",
              filename: "A_backup.json",
              workflow_uuid: "11111111-2222-4333-8444-555555555555",
            },
            active_confirmed: true,
            workflows: [],
          };
        }
        return { ok: true };
      },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => TAB,
      workflowUuidFor: () => ({ known: true, uuid: "11111111-2222-4333-8444-555555555555" }),
      refreshWorkflowUuid: () => true,
      tabCanMutateGraph: () => true,
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
    const res = await saveDef().handler({ name: "A_backup" } as never, ctx);

    expect(res.isError).toBeFalsy();
    const text = res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
    expect(text).not.toMatch(/Do NOT pick a third name/i);
    expect(calls[0]).toBe("workflow_save_as");
  });

  it("the tool description names the rename path so the 409 is not the first time the agent hears it", () => {
    const desc = saveDef().description;
    expect(desc).toMatch(/409 Conflict/);
    expect(desc).toMatch(/do NOT pick a third name/i);
    expect(desc).toContain("panel_rename_workflow");

    const rename = buildPanelToolDefs().find((d) => d.name === "panel_rename_workflow");
    if (!rename) throw new Error("panel_rename_workflow is not registered");
    expect(rename.description).toMatch(/CLOSED listed/i);
    expect(rename.description).toContain("panel_save_workflow()");
  });
});

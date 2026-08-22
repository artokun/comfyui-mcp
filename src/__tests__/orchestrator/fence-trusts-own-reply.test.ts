// #814 — Save-As left a stale workflow identity, and the very next graph command
// failed with root-workflow-uuid-mismatch.
//
// panel_save_workflow and panel_new_workflow both re-point the active workflow,
// and both repair the session's command fence by calling rebindWorkflowFence(ctx)
// UNCONDITIONALLY — a generic re-derivation that makes its OWN independent
// workflow_list round trip and never sees the command's own reply. That read is
// refused by the exact fence this whole flow exists to repair (#1071), and the
// only remaining recovery (the panel's async hello re-advertise, checked by
// unreadableOrHealed) is timing-dependent.
//
// Both replies ALREADY carry workflow_uuid directly — #762 for workflow_new,
// #800 for workflow_save/save_as — published only after the panel's own FINAL
// SYNCHRONOUS check that the target is still the active workflow. Nothing
// downstream ever read it. refreshFenceFromOwnReply trusts it FIRST, before ever
// attempting the round trip that can be refused, and falls back to the EXISTING
// rebindWorkflowFence(ctx) unchanged when the reply carries none.
//
// One stale comment corrected along the way: panel_new_workflow's handler
// claimed "it is simply not carried on the workflow_new reply" — verified false
// against the current panel source (workflow_new DOES carry workflow_uuid, #762).

import { beforeEach, describe, expect, it } from "vitest";

import { buildPanelToolDefs, makePanelToolCtx, type PanelToolCtx, type ToolResult } from "../../orchestrator/panel-tools.js";

// RFC-shaped: WORKFLOW_UUID_RE requires a [1-5] version and an [89ab] variant
// nibble — an arbitrary placeholder is silently rejected, which would make a
// positive test pass for the wrong reason.
const NEW_UUID = "11111111-2222-4333-8444-555555555555";
const PRIOR_UUID = "99999999-8888-4777-a666-555555555555";

let fence: string | undefined;
let sent: Array<Record<string, unknown>>;
let stamps: string[];

const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text;

const REFUSED = "workflow instance mismatch: this command targets a different workflow than the active canvas";

/** A bridge whose workflow_list is ALWAYS refused — the exact wedge #814/#1071
 *  exist to escape. `reply` is what the triggering command (workflow_save /
 *  workflow_save_as / workflow_new) answers with. */
function bridgeFor(cmd: string, reply: Record<string, unknown>) {
  return {
    send: async (c: Record<string, unknown>) => {
      sent.push(c);
      if (c.cmd === cmd) return reply;
      if (c.cmd === "workflow_list") throw new Error(REFUSED);
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: "tab-1", title: "A", connected_at: 0 }],
    resolveActiveTabId: () => "tab-1",
    workflowUuidFor: () => ({ known: true, uuid: fence }),
    refreshWorkflowUuid: (_tabId: string, uuid: string) => {
      fence = uuid;
      stamps.push(uuid);
      return true;
    },
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

const ctxWith = (b: ReturnType<typeof bridgeFor>): PanelToolCtx => makePanelToolCtx(b, "tab-1");
const toolNamed = (name: string) => buildPanelToolDefs().find((d) => d.name === name)!;

beforeEach(() => {
  sent = [];
  stamps = [];
  fence = PRIOR_UUID; // the pre-existing fence, about to go stale
});

describe("#814 panel_save_workflow trusts its OWN reply before the round trip", () => {
  it("adopts the Save-As reply's proven uuid without ever attempting workflow_list", async () => {
    const reply = {
      saved: true,
      workflow: "renamed",
      workflow_uuid: NEW_UUID,
      routing_key: "wf:workflows/renamed.json",
      workflow_instance_changed: true,
    };
    const res = await toolNamed("panel_save_workflow").handler(
      { name: "renamed" },
      ctxWith(bridgeFor("workflow_save_as", reply)),
    );

    expect(res.isError).toBeFalsy();
    expect(fence).toBe(NEW_UUID);
    expect(fence).not.toBe(PRIOR_UUID);
    expect(sent.map((c) => c.cmd)).not.toContain("workflow_list");
  });

  it("adopts an in-place save's proven uuid too — the reply carries it unconditionally", async () => {
    const reply = { saved: true, workflow: "same", workflow_uuid: NEW_UUID, routing_key: "wf:workflows/same.json" };
    await toolNamed("panel_save_workflow").handler({}, ctxWith(bridgeFor("workflow_save", reply)));

    expect(fence).toBe(NEW_UUID);
    expect(sent.map((c) => c.cmd)).not.toContain("workflow_list");
  });

  it("falls back to the EXISTING rebindWorkflowFence round trip when the reply carries no uuid", async () => {
    // An older panel build, or the panel's own final check could not prove it
    // (#716's fail-closed omission) — behaviour here must be UNCHANGED from
    // before this fix: it still tries workflow_list (and here, still refused).
    const reply = { saved: true, workflow: "renamed" }; // no workflow_uuid
    const res = await toolNamed("panel_save_workflow").handler(
      { name: "renamed" },
      ctxWith(bridgeFor("workflow_save_as", reply)),
    );

    expect(res.isError).toBeFalsy(); // the save itself is still reported honestly
    expect(sent.map((c) => c.cmd)).toContain("workflow_list"); // fallback WAS attempted
    expect(stamps).toEqual([]); // and it was refused, so nothing was adopted
    expect(fence).toBe(PRIOR_UUID);
  });

  it("never turns a wedged fallback into a failed save", async () => {
    const res = await toolNamed("panel_save_workflow").handler(
      {},
      ctxWith(bridgeFor("workflow_save", { saved: true, workflow: "x" })),
    );

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBeTruthy();
  });
});

describe("#814/#812 panel_new_workflow trusts its OWN reply before the round trip", () => {
  it("adopts the reply's proven uuid without ever attempting workflow_list", async () => {
    const reply = { created: true, empty: true, key: "tmp:abc", routing_key: "tmp:abc", workflow_uuid: NEW_UUID };
    const res = await toolNamed("panel_new_workflow").handler({}, ctxWith(bridgeFor("workflow_new", reply)));

    expect(res.isError).toBeFalsy();
    expect(fence).toBe(NEW_UUID);
    expect(sent.map((c) => c.cmd)).not.toContain("workflow_list");
  });

  it("falls back to the EXISTING round trip when the reply carries no uuid", async () => {
    const reply = { created: true, empty: true, key: "tmp:abc", routing_key: "tmp:abc" }; // no workflow_uuid
    await toolNamed("panel_new_workflow").handler({}, ctxWith(bridgeFor("workflow_new", reply)));

    expect(sent.map((c) => c.cmd)).toContain("workflow_list");
    expect(stamps).toEqual([]);
    expect(fence).toBe(PRIOR_UUID);
  });
});

describe("#814 the reporter's exact sequence", () => {
  it("Save-As, then the VERY NEXT command, no longer sees a stale identity", async () => {
    const reply = {
      saved: true,
      workflow: "renamed",
      workflow_uuid: NEW_UUID,
      workflow_instance_changed: true,
    };
    await toolNamed("panel_save_workflow").handler(
      { name: "renamed" },
      ctxWith(bridgeFor("workflow_save_as", reply)),
    );

    // The next fenced command (panel_screenshot in the report) reads the fence
    // via workflowUuidFor — simulated here directly, since the point of this
    // fix is that the STAMP itself is correct by the time anything else runs.
    expect(fence).toBe(NEW_UUID);
  });
});

describe("#814 WIRING: both call sites route through refreshFenceFromOwnReply first", () => {
  it("panel_save_workflow and panel_new_workflow both try the direct path before the round trip", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../orchestrator/panel-tools.ts"),
      "utf8",
    );

    const saveIdx = src.indexOf('"panel_save_workflow"');
    const newIdx = src.indexOf('"panel_new_workflow"');
    expect(saveIdx).toBeGreaterThan(0);
    expect(newIdx).toBeGreaterThan(0);

    const saveBlock = src.slice(saveIdx, saveIdx + 8000);
    const newBlock = src.slice(newIdx, newIdx + 5000);
    const wired = /const fenceRebind = refreshFenceFromOwnReply\(ctx, res\) \?\? \(await rebindWorkflowFence\(ctx\)\);/;
    expect(saveBlock).toMatch(wired);
    expect(newBlock).toMatch(wired);
  });
});

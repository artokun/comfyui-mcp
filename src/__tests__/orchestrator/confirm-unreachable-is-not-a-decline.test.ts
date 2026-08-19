// #1332 — "Cancelled — ComfyUI was not restarted." was said about a ComfyUI that had
// just restarted.
//
// The reporter accepted the guarded restart. ComfyUI restarted — a fresh startup line
// in the server log proved it — and the tool reported a cancellation. The next panel
// call then failed with "still reconnecting after a restart/reload", which is the
// restart this reply had just denied.
//
// THE CAUSE IS ONE `catch`. ConfirmOutcome was tri-state, and its catch mapped every
// non-timeout failure to "no":
//
//   // Any other error (no panel, transport failure) → "no" so the destructive op is SKIPPED
//   return "no";
//
// Skipping is correct and does not change. What was wrong is the CLAIM built on it: a
// dropped transport is not a person saying no, and a restart is precisely the event
// that drops the transport its own confirmation has to travel back on. #796's defect
// class — "could not determine X" reported as "determined X is not the case".
//
// `unreachable` is that fourth fact. Every caller branches `!== "yes"`, so the
// destructive operation is still skipped by construction; only the sentence changes.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type ConfirmOutcome,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { getBootLocalComfyUIBaseUrl } from "../../config.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";
const BOOT_BASE = (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/\/+$/, "");

function bridge() {
  return {
    send: async () => ({ ok: true }),
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    // Bound to the local boot instance so panel_restart_comfyui reaches its
    // confirmation card (#1819 refuses unbindable targets before asking).
    tabIsLocal: () => true,
    tabServerOrigin: () => BOOT_BASE,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

/** Drive a tool whose confirmation returns `outcome`, and read what it tells the user. */
async function runWithConfirm(tool: string, outcome: ConfirmOutcome, args: object = {}): Promise<string> {
  const ctx = makePanelToolCtx(bridge(), TAB, new WorkflowTargetStore());
  ctx.confirm = async () => outcome;
  const def = buildPanelToolDefs().find((d) => d.name === tool);
  if (!def) throw new Error(`${tool} is not registered`);
  const res: ToolResult = await def.handler(args as never, ctx);
  return res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
}

describe("an unaskable question is not a decline (#1332)", () => {
  // THE TWO RESTART DECLINE CASES LIVE IN panel-restart-cancel-truth.test.ts, not here.
  //
  // They were here first and they passed locally and failed on macOS and Windows CI.
  // The decline branch probes ComfyUI's health for ~6s; my workstation has a live
  // ComfyUI on 8188 that answered, and CI has none, so the probe ran its full window
  // and reported the server DOWN instead of reaching the wording under test. The
  // assertion's outcome depended on the machine rather than the code — #1263's exact
  // shape, in a test written to fix a truthfulness bug.
  //
  // That file already owns this path and has the harness for it: a stubbed health
  // probe (setHealthProbe), a shrunk recheck window (setDeclineProbeTiming), and mocked
  // config/process-control. Re-deriving that here would have been a second, weaker copy.

  it("RESTART: a TIMEOUT keeps its own distinct wording", async () => {
    // Three refusals, three meanings: declined, unanswered, unaskable.
    const text = await runWithConfirm("panel_restart_comfyui", "timeout");

    expect(text).toMatch(/No confirmation received within/);
    expect(text).not.toContain("Cancelled — ComfyUI was not restarted.");
    expect(text).not.toMatch(/could not be reached to ask/);
  });

  it("CLEAR CANVAS: the other caller does not credit a decision nobody made", async () => {
    const text = await runWithConfirm("panel_clear", "unreachable");

    expect(text).toMatch(/NOT because it was declined/);
    expect(text).toMatch(/the question never appeared/);
    expect(text).not.toContain("Cancelled — the canvas was left as-is.");
  });

  it("CLEAR CANVAS: an explicit decline is still a cancellation", async () => {
    const text = await runWithConfirm("panel_clear", "no");
    expect(text).toContain("Cancelled — the canvas was left as-is.");
  });

  it("WIRING: the REAL confirm turns a transport failure into `unreachable`", async () => {
    // WITHOUT THIS TEST THE FIX WAS UNPROVEN. Every case above injects
    // `ctx.confirm = async () => outcome`, so they pin what each CALLER says and never
    // touch the one line that decides which outcome a dropped socket produces.
    // Verified: reverting that line to `return "no"` left all of them green.
    //
    // So drive the real implementation. A non-timeout throw is exactly what a restart
    // does to the socket its own confirmation card must answer on.
    const b = {
      ...(bridge() as object),
      send: async () => {
        throw new Error("panel tab is not open");
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());

    const outcome = await ctx.confirm("Restart ComfyUI now?", "Restart ComfyUI", 500);

    expect(outcome).toBe("unreachable");
    // …and specifically NOT the value that made the reporter's message false.
    expect(outcome).not.toBe("no");
  });

  it("THE SAFE PATH IS UNCHANGED: nothing destructive runs on `unreachable`", async () => {
    // The whole reason the old code returned "no" was to SKIP. That property is what
    // must survive this change — a clearer message would be a poor trade for a canvas
    // cleared without consent.
    const sent: string[] = [];
    const b = {
      ...(bridge() as object),
      send: async (cmd: Record<string, unknown>) => {
        sent.push(String(cmd.cmd));
        return { ok: true };
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
    ctx.confirm = async () => "unreachable";
    const def = buildPanelToolDefs().find((d) => d.name === "panel_clear");
    if (!def) throw new Error("panel_clear is not registered");
    await def.handler({} as never, ctx);

    expect(sent).not.toContain("graph_clear");
  });
});

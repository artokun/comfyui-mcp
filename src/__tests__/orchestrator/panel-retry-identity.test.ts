// #694 — EXPLICIT caller retry identity for MUTATING panel commands.
//
// When a mutating panel command fails OUTCOME-UNKNOWN (a post-write reply
// timeout or a mid-command disconnect — the bridge's two dispatched:true
// rejections), the error text must name the dispatched attempt's rid as the
// caller's retry token: re-issue identical args plus retry_of:"<rid>". A
// pre-write refusal (dispatched:false), a genuine executor ok:false error, and
// any READ mint NO token. retry_of is opaque caller data: the tools accept it,
// the handlers forward it to the cmd bag, and the bridge ships it to the wire
// untouched (see ui-bridge.test.ts for the wire-level assertions).
//
// The ctx-under-test is the REAL makePanelToolCtx (the token logic lives in its
// `call`); only the bridge is faked, mirroring the reconnectingBridge harness in
// panel-session-rebind-residuals.test.ts.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  RETRY_TOKEN_CMD_BY_TOOL,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import {
  markDispatched,
  markReplyTimeout,
  requiresWorkflowStampEnforcement,
  SESSION_EPOCH,
} from "../../services/ui-bridge.js";
import { buildModelsPushFrame, buildSessionEpochFrame, pushModelsFrame } from "../../orchestrator/index.js";

const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text;

/**
 * A bridge modelling ONE live tab ("tab-1") whose send() runs a test-supplied
 * script: it always fires the onDispatchedRid observer post-write (exactly like
 * the real UiBridge.dispatch) and then throws the scripted error.
 */
function failingBridge(fail: (cmd: Record<string, unknown>) => Error) {
  const bridge = {
    send: async (
      cmd: Record<string, unknown>,
      opts?: { tabId?: string; onDispatchedRid?: (rid: string) => void },
    ) => {
      opts?.onDispatchedRid?.("11111111-2222-3333-4444-555555555555");
      throw fail(cmd);
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: "tab-1", title: "tab-1", connected_at: 0 }],
    resolveActiveTabId: () => "tab-1",
  } as unknown as PanelToolCtx["bridge"];
  return bridge;
}

const DISPATCHED_RID = "11111111-2222-3333-4444-555555555555";
const RETRY_LINE =
  'To retry this exact mutation, re-issue identical args plus retry_of:"' +
  DISPATCHED_RID +
  '"; otherwise call normally.';

/** The bridge's canonical post-write reply timeout (typed: reply-timeout + dispatched:true). */
function replyTimeout(cmd: string): Error {
  return markReplyTimeout(
    markDispatched(
      new Error(
        `Panel tab tab-1 did not reply to "${cmd}" within 6000 ms — the ComfyUI tab may be backgrounded or frozen`,
      ),
      true,
    ),
  );
}

/** The bridge's POST-write mid-command drop for a mutating command (typed dispatched:true). */
function midCommandDrop(cmd: string): Error {
  return markDispatched(
    new Error(
      `panel tab tab-1 disconnected mid-command ("${cmd}") — OUTCOME UNKNOWN: the command was already sent, so the panel may have applied it. Verify before retrying instead of re-issuing it blindly.`,
    ),
    true,
  );
}

describe("#694 retry token on OUTCOME-UNKNOWN mutating failures", () => {
  it("(a) a mutating REPLY-TIMEOUT names the dispatched rid as the retry token", async () => {
    const ctx = makePanelToolCtx(failingBridge(() => replyTimeout("graph_add_node")), "tab-1");
    const res = await ctx.call({ cmd: "graph_add_node", class_type: "KSampler" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`retry_of:"${DISPATCHED_RID}"`);
    expect(textOf(res)).toContain(RETRY_LINE);
  });

  it("(a) a mutating MID-COMMAND DISCONNECT (dispatched:true) names the dispatched rid as the retry token", async () => {
    const ctx = makePanelToolCtx(failingBridge(() => midCommandDrop("graph_set_widget")), "tab-1");
    const res = await ctx.call({ cmd: "graph_set_widget", node_id: 3, widget: "steps", value: 20 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(RETRY_LINE);
  });

  it("(a) the four workflow mutators mint tokens too (workflow_save)", async () => {
    const ctx = makePanelToolCtx(failingBridge(() => replyTimeout("workflow_save")), "tab-1");
    const res = await ctx.call({ cmd: "workflow_save" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(RETRY_LINE);
  });

  it.each([
    ["reply timeout", () => replyTimeout("graph_load")],
    ["mid-command disconnect", () => midCommandDrop("graph_load")],
  ])(
    "(a) panel_flatten_workflow preserves an outcome-unknown %s instead of fabricating load success",
    async (_kind, failure) => {
      const ctx = makePanelToolCtx(failingBridge(failure), "tab-1");
      const flatten = buildPanelToolDefs().find((d) => d.name === "panel_flatten_workflow")!;
      const res = await flatten.handler({ graph: { nodes: [], links: [] } }, ctx);
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain(RETRY_LINE);
      expect(textOf(res)).not.toContain("Loaded onto the canvas");
    },
  );

  it("(b) a PRE-WRITE refusal (dispatched:false) mints NO token", async () => {
    const ctx = makePanelToolCtx(
      failingBridge(
        () => markDispatched(new Error('no connected tab with id "tab-1". Connected: none'), false),
      ),
      "tab-1",
    );
    const res = await ctx.call({ cmd: "graph_add_node", class_type: "KSampler" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("nothing was applied"); // the existing #442 wording is preserved
    expect(textOf(res)).not.toContain("retry_of");
  });

  it("(c) a genuine executor ok:false error carries NO token (a definite outcome)", async () => {
    const ctx = makePanelToolCtx(
      failingBridge(() => new Error("Executor refused: node 3 has a missing required input")),
      "tab-1",
    );
    const res = await ctx.call({ cmd: "graph_set_widget", node_id: 3, widget: "steps", value: 20 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Executor refused");
    expect(textOf(res)).not.toContain("retry_of");
  });

  it("(e) READS never mint a token — reply-timeout on graph_query", async () => {
    const ctx = makePanelToolCtx(failingBridge(() => replyTimeout("graph_query")), "tab-1");
    const res = await ctx.call({ cmd: "graph_query" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain("retry_of");
  });

  it("(e) READS never mint a token — mid-command drop phrasing on graph_outline", async () => {
    // Artificial combination (the bridge only emits OUTCOME UNKNOWN for mutating
    // commands): proves the token gate keys on the COMMAND's mutation surface
    // (requiresWorkflowStampEnforcement), never on error text.
    const ctx = makePanelToolCtx(failingBridge(() => midCommandDrop("graph_outline")), "tab-1");
    const res = await ctx.call({ cmd: "graph_outline" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain("retry_of");
  });

  it("(e) READS never mint a token — the realistic read-drop (park expired) path", async () => {
    // The bridge's real past-deadline read drop ("panel genuinely gone") is a
    // TRANSIENT error, so ctx.call takes the #332 retry-once path; when the retry
    // also fails the agent gets the reconnecting wrapper — never a token.
    const gone = () =>
      new Error(
        'panel tab tab-1 disconnected mid-command ("graph_outline") — panel genuinely gone; retry once a tab is connected',
      );
    const ctx = makePanelToolCtx(failingBridge(gone), "tab-1");
    const res = await ctx.call({ cmd: "graph_outline" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain("retry_of");
  });

  it("mints NO token when the bridge exposed no dispatched rid (defensive)", async () => {
    const bridge = {
      send: async () => {
        throw replyTimeout("graph_add_node"); // observer never fired
      },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: "tab-1", title: "tab-1", connected_at: 0 }],
      resolveActiveTabId: () => "tab-1",
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "tab-1");
    const res = await ctx.call({ cmd: "graph_add_node", class_type: "KSampler" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain("retry_of");
  });
});

describe("#694 retry_of threading through the tool defs", () => {
  function makeRecordingCtx() {
    const calls: Record<string, unknown>[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        return { content: [{ type: "text", text: JSON.stringify(cmd) }] };
      },
      confirm: async () => "yes" as const,
      bridge: { send: async () => ({}), push: () => 1 } as unknown as PanelToolCtx["bridge"],
      tabId: "tab-1",
    };
    return { ctx, calls };
  }
  const defByName = (name: string) => {
    const def = buildPanelToolDefs().find((d) => d.name === name);
    if (!def) throw new Error(`${name} not found`);
    return def;
  };

  it("a mutating tool forwards retry_of into its cmd bag, verbatim", async () => {
    const { ctx, calls } = makeRecordingCtx();
    await defByName("panel_set_widget").handler(
      { node_id: 1, widget: "steps", value: 5, retry_of: "tok-9" },
      ctx,
    );
    expect(calls[0]).toMatchObject({ cmd: "graph_set_widget", retry_of: "tok-9" });
  });

  // codex gate. The four UI-state tools declare retry_of in their schema and
  // their description promises dedupe. #778 reclassified their bridge commands
  // as `inert` for the workflow fence — and withRetryToken used to decide
  // forwarding with the FENCE predicate, so a caller-supplied token would have
  // been accepted, validated, and then silently dropped before the wire. A
  // caller who believes their retry is deduped and is wrong is the exact failure
  // the token exists to prevent, so forwarding asks the retry map's own question.
  it.each([
    ["panel_select_nodes", "graph_select_nodes", { node_ids: [1, 2] }],
    ["panel_enter_subgraph", "graph_enter_subgraph", { node_id: 3 }],
    ["panel_exit_subgraph", "graph_exit_subgraph", {}],
    ["panel_copy_nodes", "graph_copy_nodes", { node_ids: [1] }],
  ])("%s forwards a caller-supplied retry_of even though its cmd is inert", async (
    tool,
    cmd,
    args,
  ) => {
    expect(requiresWorkflowStampEnforcement({ cmd })).toBe(false); // inert since #778
    const { ctx, calls } = makeRecordingCtx();
    await defByName(tool).handler({ ...args, retry_of: "tok-ui" }, ctx);
    expect(calls[0]).toMatchObject({ cmd, retry_of: "tok-ui" });
  });

  it("no retry_of arg → the cmd bag carries no retry_of key at all", async () => {
    const { ctx, calls } = makeRecordingCtx();
    await defByName("panel_set_widget").handler({ node_id: 1, widget: "steps", value: 5 }, ctx);
    expect("retry_of" in calls[0]).toBe(false);
  });

  it("panel_save_workflow attaches the token on BOTH the save and save_as branches", async () => {
    const { ctx, calls } = makeRecordingCtx();
    await defByName("panel_save_workflow").handler({ retry_of: "tok-a" }, ctx);
    await defByName("panel_save_workflow").handler({ name: "copy", retry_of: "tok-b" }, ctx);
    // Find the save frames by NAME, not by index: #1045 added a `workflow_list`
    // fence probe after each save (a Save-As re-points the active workflow, so
    // the session has to re-anchor), which sits between them. The token contract
    // is about which frame CARRIES it, not where it lands in the sequence.
    const save = calls.find((c) => c.cmd === "workflow_save");
    const saveAs = calls.find((c) => c.cmd === "workflow_save_as");
    expect(save).toMatchObject({ cmd: "workflow_save", retry_of: "tok-a" });
    expect(saveAs).toMatchObject({ cmd: "workflow_save_as", retry_of: "tok-b" });
    // …and the probe itself must never carry a caller's retry token.
    for (const probe of calls.filter((c) => c.cmd === "workflow_list")) {
      expect("retry_of" in probe).toBe(false);
    }
  });

  it("a READ tool never forwards retry_of even when args smuggle one (belt-and-braces gate)", async () => {
    const { ctx, calls } = makeRecordingCtx();
    // zod strips unknown args in production, so this can only happen via a broken
    // transport — the per-command requiresWorkflowStampEnforcement gate still
    // keeps the token off a read frame.
    await defByName("panel_graph_outline").handler({ retry_of: "tok-x" }, ctx);
    expect("retry_of" in calls[0]).toBe(false);
  });

  it("explicitly read-only tools have NO retry_of in their schema or cmd bag (#694 gate)", async () => {
    // panel_list_subgraphs is read-only ("Read-only." in its description): a retry
    // token there would violate the reads-never-mint rule. It must be absent from
    // the retry map — schema, handler, everything.
    const def = defByName("panel_list_subgraphs");
    expect(JSON.stringify(def.schema ?? {})).not.toContain("retry_of");
    const { ctx, calls } = makeRecordingCtx();
    await def.handler({}, ctx);
    expect("retry_of" in calls[0]).toBe(false);
  });

  it("panel_clear (confirm-gated, empty schema) accepts and forwards the token", async () => {
    const { ctx, calls } = makeRecordingCtx();
    await defByName("panel_clear").handler({ retry_of: "tok-clear" }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "graph_clear", retry_of: "tok-clear" });
  });
});

/** The four commands RETRY_TOKEN_CMD_BY_TOOL admits that the workflow fence does
 *  NOT gate: they change only selection / subgraph scope / clipboard, and doing
 *  so twice is doing so once. */
const IDEMPOTENT_UI_STATE_CMDS = new Set([
  "graph_select_nodes",
  "graph_enter_subgraph",
  "graph_exit_subgraph",
  "graph_copy_nodes",
]);

describe("#694 retry_of schema surface", () => {
  it("(f) no DATA-RETURNING read is in the retry map (a ledger answer would be stale)", () => {
    // The invariant the assertion below used to protect only as a side effect.
    // A read's retry can be answered from the dedupe ledger with the outcome of
    // the FIRST call, so a read in this map would hand the agent stale data.
    const mapped = new Set(Object.values(RETRY_TOKEN_CMD_BY_TOOL));
    for (const readCmd of [
      "graph_find_nodes",
      "graph_list_subgraphs",
      "graph_screenshot",
      "graph_canvas",
      "graph_outline",
      "graph_query",
      "graph_get_state",
      "graph_serialize",
    ]) {
      expect(mapped.has(readCmd), `${readCmd} must not be in the retry map`).toBe(false);
    }
  });

  it("(f) every tool in RETRY_TOKEN_CMD_BY_TOOL accepts an OPTIONAL retry_of", () => {
    const defs = buildPanelToolDefs();
    for (const [name, cmd] of Object.entries(RETRY_TOKEN_CMD_BY_TOOL)) {
      const d = defs.find((x) => x.name === name);
      expect(d, `${name} exists in buildPanelToolDefs()`).toBeTruthy();
      // The map's cmd really is in the #694 mutation surface: either the bridge
      // fences it to a workflow, or it is one of the four UI-state commands the
      // map admits on purpose (see RETRY_TOKEN_CMD_BY_TOOL's own doc — they
      // change selection / scope / clipboard idempotently, so a deduped retry is
      // a no-op). Those four used to satisfy requiresWorkflowStampEnforcement
      // only BY ACCIDENT: it classified every graph command outside
      // BRIDGE_READONLY_CMDS as a canvas mutation, which is the #778 defect
      // itself. Naming them makes the map's real membership rule visible.
      expect(
        requiresWorkflowStampEnforcement({ cmd }) || IDEMPOTENT_UI_STATE_CMDS.has(cmd),
        `${name} → ${cmd} is fenced, or an admitted idempotent UI-state command`,
      ).toBe(true);
      const field = d!.schema.retry_of as z.ZodOptional<z.ZodString> | undefined;
      expect(field, `${name} schema carries retry_of`).toBeDefined();
      expect(field!.isOptional(), `${name} retry_of is optional`).toBe(true);
    }
  });

  it("(f) READ tools do NOT carry retry_of in their schema", () => {
    const defs = buildPanelToolDefs();
    for (const name of [
      "panel_graph_outline",
      "panel_query_graph",
      "panel_list_workflows",
      "panel_get_errors",
      "panel_open_workflow", // navigation — its own receipt verification handles retries
      "panel_new_workflow",
    ]) {
      const d = defs.find((x) => x.name === name);
      expect(d, `${name} exists`).toBeTruthy();
      expect(d!.schema.retry_of, `${name} has no retry_of`).toBeUndefined();
    }
  });

  it("(f) retry_of is not REQUIRED anywhere in the panel surface", () => {
    for (const d of buildPanelToolDefs()) {
      const field = d.schema.retry_of as z.ZodOptional<z.ZodString> | undefined;
      if (field) expect(field.isOptional(), `${d.name} retry_of optional`).toBe(true);
    }
  });

  it("(f) zod accepts retry_of on a mutating tool and passes it through to args", () => {
    const d = buildPanelToolDefs().find((x) => x.name === "panel_add_node")!;
    const schema = z.object(d.schema);
    const withToken = schema.parse({ class_type: "KSampler", retry_of: "rid-1" });
    expect(withToken.retry_of).toBe("rid-1");
    const without = schema.parse({ class_type: "KSampler" });
    expect("retry_of" in without).toBe(false);
  });
});

describe("#694 session epoch on the models push frame", () => {
  it("(h) two models frames pushed in the same process carry the SAME per-process epoch", () => {
    const f1 = buildModelsPushFrame([{ value: "model-a" } as never], "model-a", "claude");
    const f2 = buildModelsPushFrame([{ value: "model-b" } as never], "model-b", "codex");
    expect(f1).toMatchObject({ type: "models", backend: "claude", epoch: SESSION_EPOCH });
    expect(f2).toMatchObject({ type: "models", backend: "codex", epoch: SESSION_EPOCH });
    expect(f2.epoch).toBe(f1.epoch);
    expect(String(f1.epoch)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("(h) SESSION_EPOCH is a per-process UUID", () => {
    expect(SESSION_EPOCH).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("(h) the epoch-first session frame carries the same per-process epoch", () => {
    expect(buildSessionEpochFrame()).toEqual({ type: "session_epoch", epoch: SESSION_EPOCH });
  });

  it("(h) pushes an epoch handshake even when model discovery is empty", () => {
    const pushed: Array<{ frame: Record<string, unknown>; tabId: string | undefined }> = [];
    pushModelsFrame(
      {
        push: (frame, tabId) => {
          pushed.push({ frame, tabId });
          return 1;
        },
      } as never,
      "tab-empty",
      [],
      undefined,
      "claude",
    );
    expect(pushed).toEqual([
      {
        frame: { type: "models", epoch: SESSION_EPOCH, models: [], current: undefined, backend: "claude" },
        tabId: "tab-empty",
      },
    ]);
  });
});

// ── #694 second half: retention is only worth anything if a caller is TOLD.
//
// The bridge now keeps a mutation that completed AFTER its reply timeout. These
// assert the WIRING — that the retained outcome reaches the tool result a caller
// actually reads — rather than re-testing the bridge helper, which has its own
// coverage in ui-bridge.test.ts. A retention map nobody drains would satisfy
// every bridge-level test and still leave #694 exactly as reported.
describe("late-mutation notice reaches the caller (#694)", () => {
  /** A bridge whose mutations succeed, carrying a scripted late-completion map. */
  function bridgeWithLate(late: Record<string, { cmd: string; tabId: string; lateByMs: number }>) {
    const taken: string[] = [];
    return {
      taken,
      bridge: {
        send: async () => ({ ok: true }),
        push: () => 1,
        tabs: () => [{ tab_id: "tab-1" }],
        takeLateMutation: (rid: string) => {
          taken.push(rid);
          const hit = late[rid];
          if (!hit) return undefined;
          delete late[rid];
          return { ok: true as const, ...hit };
        },
      } as unknown as PanelToolCtx["bridge"],
    };
  }

  const addNode = () => buildPanelToolDefs().find((d) => d.name === "panel_add_node")!;

  it("prepends 'DID complete' when the retried rid had landed late", async () => {
    const { bridge, taken } = bridgeWithLate({
      "rid-late": { cmd: "graph_add_node", tabId: "tab-1", lateByMs: 2400 },
    });
    const ctx = makePanelToolCtx(bridge, "tab-1");
    const res = await addNode().handler(
      { node_type: "KSampler", retry_of: "rid-late" },
      ctx,
    );
    expect(taken).toContain("rid-late");
    const first = textOf(res);
    expect(first).toMatch(/DID complete/);
    expect(first).toMatch(/graph_add_node/);
    expect(first).toMatch(/2\.4s after its reply timeout/);
    // The retry's own result must still be there, not replaced by the notice.
    expect(res.content.length).toBeGreaterThan(1);
  });

  it("says nothing when the retried rid never landed late (the normal retry)", async () => {
    const { bridge, taken } = bridgeWithLate({});
    const ctx = makePanelToolCtx(bridge, "tab-1");
    const res = await addNode().handler(
      { node_type: "KSampler", retry_of: "rid-unknown" },
      ctx,
    );
    expect(taken).toContain("rid-unknown"); // asked...
    expect(textOf(res)).not.toMatch(/DID complete/); // ...and correctly told nothing
  });

  it("never asks when the caller passed no retry_of", async () => {
    // The drain is destructive, so an unconditional probe would consume a notice
    // meant for a caller who has not retried yet.
    const { bridge, taken } = bridgeWithLate({
      "rid-late": { cmd: "graph_add_node", tabId: "tab-1", lateByMs: 1000 },
    });
    const ctx = makePanelToolCtx(bridge, "tab-1");
    await addNode().handler({ node_type: "KSampler" }, ctx);
    expect(taken).toEqual([]);
  });


  it("stays silent when the token names a DIFFERENT command than this tool sends", async () => {
    // A token names an attempt. "The attempt you are retrying DID complete" is
    // only true if the retained completion is for the command this tool
    // dispatches; pasting a stale token onto another tool must not print a
    // confident notice about an unrelated write.
    const { bridge } = bridgeWithLate({
      "rid-other": { cmd: "graph_set_node_mode", tabId: "tab-1", lateByMs: 1500 },
    });
    const ctx = makePanelToolCtx(bridge, "tab-1");
    const res = await addNode().handler({ node_type: "KSampler", retry_of: "rid-other" }, ctx);
    expect(textOf(res)).not.toMatch(/DID complete/);
  });

  it("does not consume the notice when the retry itself throws", async () => {
    // The drain is destructive and now runs AFTER the handler: a failed retry
    // must leave the notice for the next attempt, not eat it.
    const late = { "rid-late": { cmd: "graph_add_node", tabId: "tab-1", lateByMs: 700 } };
    const { bridge, taken } = bridgeWithLate(late);
    (bridge as unknown as { send: () => Promise<unknown> }).send = async () => {
      throw new Error("panel gone");
    };
    const ctx = makePanelToolCtx(bridge, "tab-1");
    await addNode()
      .handler({ node_type: "KSampler", retry_of: "rid-late" }, ctx)
      .catch(() => undefined);
    expect(taken, "a throwing retry must not have drained").toEqual([]);
    expect(late["rid-late"], "the notice must survive for the next attempt").toBeTruthy();
  });
  it("does NOT skip the dispatch — the retry still runs (#687 stays reverted)", async () => {
    // Suppressing the write on the strength of a rid would be #683's inference
    // with the arrow reversed: the bridge stores no fingerprint, so a stale or
    // re-pasted token cannot prove the mutation being asked for now is the one
    // that landed. Dedupe is the panel ledger's job (#521); this only reports.
    const sent: Array<Record<string, unknown>> = [];
    const { bridge } = bridgeWithLate({
      "rid-late": { cmd: "graph_add_node", tabId: "tab-1", lateByMs: 900 },
    });
    (bridge as unknown as { send: (c: Record<string, unknown>) => Promise<unknown> }).send =
      async (c) => {
        sent.push(c);
        return { ok: true };
      };
    const ctx = makePanelToolCtx(bridge, "tab-1");
    await addNode().handler({ node_type: "KSampler", retry_of: "rid-late" }, ctx);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.some((c) => c.retry_of === "rid-late")).toBe(true);
  });
});

// #1519 — a live graph READ refused by the workflow fence because it carried no
// instance stamp, and the two states behind that refusal are not the same state.
//
// The reporter's session resumed onto a different workflow and the first live-canvas read
// came back
//
//   workflow instance mismatch: this command carries no workflow-instance stamp, and the
//   active canvas reports 2b3f4684-…. Nothing was applied.
//
// A missing stamp is not a wrong one. Deriving a fence from the live canvas is what
// fixes the first; doing that for the second ABANDONS the workflow the caller named
// (the retarget #1646 removed for cause). An inert read refused for a missing stamp,
// against a canvas that has an identity, and a session that has none, is therefore
// admitted: the first fence is minted from that canvas and the read is retried once.
// A wrong stamp, a pin, and a canvas with no identity still fail and name only the
// remedy that applies.

import { beforeEach, describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";
const LIVE = "2b3f4684-b7e7-495b-a7a1-f40439e35e0a"; // what the canvas reports
const STALE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"; // a fence that has gone stale

let listCalls: number;
let adopted: string[];
let sent: string[];
let fence: { known: boolean; uuid?: string };

/** What the panel returns once an unstamped outline is admitted. Distinctive so
 *  a green assertion cannot come from the diagnosis text. */
const OUTLINE = { node_count: 3, outline: "1 CheckpointLoaderSimple \"ckpt\"" };

/** Distinctive `graph_get_errors` payload so a green assertion cannot come from
 *  the diagnosis text either. The reporter's other refused read (#1913). */
const ERRORS = {
  nodes: [{ id: 7, type: "LoadImage", reasons: ["missing_media: input.png"] }],
  errored_count: 1,
};

/** A self-corroborating workflow_list reply: the active record also appears in the
 *  open-workflow list flagged active, which is what corroboration requires. */
function settled(uuid: string | null): Record<string, unknown> {
  const active: Record<string, unknown> = {
    path: "workflows/a.json",
    routing_key: TAB,
    ...(uuid ? { workflow_uuid: uuid } : {}),
  };
  return { active, workflows: [{ ...active, active: true }], active_confirmed: true };
}

type BridgeOpts = {
  issuedFor: string | null;
  liveUuid: string | null;
  probeRefused?: boolean;
  /** Serve the outline after a first fence is minted (the reporter's remaining case). */
  serveOutlineWhen?: "adopted" | "retry";
  /** The validator refuses to mint — diagnosis must still name the rebind. */
  refuseAdopt?: boolean;
};

/**
 * `issuedFor` — what the panel's refusal states: a uuid (the WRONG-stamp wording) or
 * `null` (the MISSING-stamp wording). `liveUuid` — what workflow_list reports for the
 * live canvas, `null` for a canvas that has no identity of its own. `probeRefused` —
 * a build predating panel #759 that fences the recovery probe too.
 */
function bridge(opts: BridgeOpts) {
  const refusal =
    `workflow instance mismatch: ` +
    (opts.issuedFor
      ? `this command was issued for workflow instance ${opts.issuedFor}`
      : `this command carries no workflow-instance stamp`) +
    `, and the active canvas reports ${LIVE}. Nothing was applied.`;
  return {
    send: async (cmd: Record<string, unknown>) => {
      const name = typeof cmd.cmd === "string" ? cmd.cmd : "";
      sent.push(name);
      if (name === "workflow_list") {
        listCalls += 1;
        // A build predating panel #759 fences the recovery probe too. It must
        // surface its own refusal, NOT re-enter the diagnosis that called it.
        if (opts.probeRefused) throw new Error(refusal);
        return settled(opts.liveUuid);
      }
      const outlineSends = sent.filter((c) => c === "graph_outline").length;
      const errorSends = sent.filter((c) => c === "graph_get_errors").length;
      const admitted =
        (opts.serveOutlineWhen === "adopted" && adopted.length > 0) ||
        (opts.serveOutlineWhen === "retry" &&
          (name === "graph_outline" ? outlineSends > 1 : errorSends > 1));
      if (admitted && name === "graph_outline") return OUTLINE;
      if (admitted && name === "graph_get_errors") return ERRORS;
      throw new Error(refusal);
    },
    push: () => 1,
    canReach: (id: string) => id === TAB,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: (_tabId: string, uuid: string) => {
      if (opts.refuseAdopt) return false;
      adopted.push(uuid);
      fence = { known: true, uuid };
      return true;
    },
    workflowUuidFor: () => fence,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

/** Drive a real READ tool through the real ctx.call path. */
async function callRead(
  name: "panel_graph_outline" | "panel_get_errors",
  opts: BridgeOpts,
  store = new WorkflowTargetStore(),
): Promise<{ text: string; isError: boolean }> {
  const ctx = makePanelToolCtx(bridge(opts), TAB, store);
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`${name} is not registered`);
  const res: ToolResult = await def.handler({} as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
  };
}

/** Drive a real READ tool (panel_graph_outline) through the real ctx.call path. */
async function outline(
  opts: BridgeOpts,
  store = new WorkflowTargetStore(),
): Promise<{ text: string; isError: boolean }> {
  return callRead("panel_graph_outline", opts, store);
}

/** The remedy that is right ONLY for an absent stamp. */
const REBIND = /panel_set_workflow_target\(\{mode:"current"\}\) derives this session's fence/;
/** The remedy that is right ONLY for a wrong stamp. */
const CHOOSE = /to read the workflow you issued for, bring it back with panel_open_workflow/;

beforeEach(() => {
  listCalls = 0;
  adopted = [];
  sent = [];
  fence = { known: true, uuid: undefined }; // definitively NOT fenced — #1519's state
});

describe("a fenced graph READ is diagnosed, and a missing stamp is not a wrong one (#1519)", () => {
  it("MISSING STAMP: mints a first fence from the live canvas and the outline runs", async () => {
    const { text, isError } = await outline({
      issuedFor: null,
      liveUuid: LIVE,
      serveOutlineWhen: "adopted",
    });

    // The live canvas really was re-read — without this every assertion below could
    // be satisfied by a message that never consulted the panel.
    expect(listCalls).toBeGreaterThan(0);
    // The first fence was minted from that reading, not from a guessed uuid.
    expect(adopted).toEqual([LIVE]);
    // And the outline the panel served after that mint is what the caller got —
    // not a diagnosis of the refusal that provoked it.
    expect(isError).toBe(false);
    expect(text).toContain("CheckpointLoaderSimple");
    expect(text).not.toMatch(/Error:/);
    expect(text).not.toMatch(REBIND);
    expect(text).not.toMatch(CHOOSE);
    expect(sent.filter((c) => c === "graph_outline").length).toBeGreaterThan(1);
  });

  it("MISSING STAMP, mint refused: still names the rebind and does not invent a wrong-stamp target", async () => {
    const { text, isError } = await outline({
      issuedFor: null,
      liveUuid: LIVE,
      refuseAdopt: true,
    });

    expect(listCalls).toBeGreaterThan(0);
    expect(isError).toBe(true);
    expect(text).toMatch(/MISSING stamp rather than a wrong one/);
    expect(text).toMatch(REBIND);
    expect(text).toContain(LIVE);
    expect(text).toContain("carries no workflow-instance stamp");
    expect(text).not.toMatch(CHOOSE);
    expect(adopted).toEqual([]);
  });

  it("WRONG STAMP: names the choice between two real workflows, and NOT the mint-a-stamp rebind", async () => {
    // The collapse this branch must not make. A session that HAS an identity and a
    // canvas that disagrees is a different fact, and mode:"current" abandons the
    // workflow the caller named rather than repairing anything.
    fence = { known: true, uuid: STALE };
    const { text } = await outline({ issuedFor: STALE, liveUuid: LIVE });

    expect(listCalls).toBeGreaterThan(0);
    expect(text).toMatch(/WRONG stamp, not a missing one/);
    expect(text).toMatch(CHOOSE);
    expect(text).not.toMatch(REBIND);
    // It names BOTH identities, which is the fact the caller has to choose between.
    expect(text).toContain(STALE);
    expect(text).toContain(LIVE);
    // And it discloses what re-targeting costs, rather than presenting it as repair.
    expect(text).toMatch(/re-points every later EDIT/);
    expect(adopted).toEqual([]);
  });

  it("NO IDENTITY ANYWHERE: says the rebind will NOT clear it, and sends the caller to re-open", async () => {
    // #1331's lesson, applied to the read path: when the live canvas has no identity
    // either, mode:"current" reports success while the read keeps failing.
    const { text } = await outline({ issuedFor: null, liveUuid: null });

    expect(listCalls).toBeGreaterThan(0);
    expect(text).toMatch(/will NOT clear this/);
    expect(text).toMatch(/panel_open_workflow\(<path>\)/);
    expect(text).toMatch(/panel_save_workflow/);
    // The remedy that cannot work here must not be offered as one.
    expect(text).not.toMatch(REBIND);
    expect(adopted).toEqual([]);
  });

  it("NO IDENTITY, but the session HAS a stamp: the verdict does not claim the session lacks one", async () => {
    // The same probe result reached from the other shape. "carries no workflow
    // identity EITHER" would be false here — this session is fenced to STALE — and a
    // verdict that describes the caller's state wrongly is the class of claim this
    // whole issue is about.
    fence = { known: true, uuid: STALE };
    const { text } = await outline({ issuedFor: STALE, liveUuid: null });

    expect(text).toMatch(/no workflow identity of its own/);
    expect(text).not.toMatch(/no workflow identity either/);
    expect(text).toMatch(/will NOT clear this/);
    expect(adopted).toEqual([]);
  });

  it("PINNED to a DIFFERENT workflow: naming mode:\"current\" also discloses that it releases the pin", async () => {
    // mode:"current" is the right remedy for a missing stamp AND it silently drops a
    // pin. A caller who followed it to fix a read would lose their target and find
    // out by editing the wrong workflow later. This is NOT the reconnect case
    // (#1913) where the pin still names the live canvas — minting from live
    // here would abandon b.json.
    const store = new WorkflowTargetStore();
    store.set(TAB, { mode: "pinned", path: "workflows/b.json", filename: "b.json" });
    const { text } = await outline({ issuedFor: null, liveUuid: LIVE }, store);

    expect(text).toMatch(REBIND);
    expect(text).toMatch(/PINNED to b\.json/);
    expect(text).toMatch(/RELEASES that pin/);
    expect(text).toMatch(/panel_open_workflow\("workflows\/b\.json"\)/);
    expect(adopted).toEqual([]);
    expect(store.get(TAB)).toEqual({
      mode: "pinned",
      path: "workflows/b.json",
      filename: "b.json",
    });
  });

  it("UNSTATED SHAPE: a refusal that names neither state gets NO remedy invented for it", async () => {
    // The third answer. A panel wording this cannot classify is not evidence for
    // either state, and guessing one would be the collapse in the other direction.
    const ctx = makePanelToolCtx(
      {
        send: async (cmd: Record<string, unknown>) => {
          if (cmd.cmd === "workflow_list") {
            listCalls += 1;
            return settled(LIVE);
          }
          throw new Error("workflow instance mismatch: this command targets a different workflow");
        },
        push: () => 1,
        canReach: (id: string) => id === TAB,
        isHeadless: () => false,
        tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
        resolveActiveTabId: () => TAB,
        refreshWorkflowUuid: (_t: string, u: string) => {
          adopted.push(u);
          return true;
        },
        workflowUuidFor: () => fence,
        tabCanMutateGraph: () => true,
        tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
      } as unknown as PanelToolCtx["bridge"],
      TAB,
      new WorkflowTargetStore(),
    );
    const def = buildPanelToolDefs().find((d) => d.name === "panel_graph_outline");
    if (!def) throw new Error("panel_graph_outline is not registered");
    const res: ToolResult = await def.handler({} as never, ctx);
    const text = res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

    expect(text).toMatch(/is NOT known from here/);
    expect(text).not.toMatch(REBIND);
    expect(text).not.toMatch(CHOOSE);
    expect(adopted).toEqual([]);
  });
});

describe("classified against the panel's REAL wording, not the fixture's short form", () => {
  // The short refusal above is the one #1519 was filed with. A current panel says more:
  // since 0.11.83 (`workflowInstanceMismatchMessage`) it appends its own remedy line,
  // and that line names BOTH exits as interchangeable —
  //
  //   Re-target with panel_set_workflow_target({mode:"current"}), or re-select the
  //   intended workflow with panel_open_workflow, then retry.
  //
  // which is right for the panel (it "observed only that the two identities differ")
  // and is exactly the collapse this branch resolves. Transcribed verbatim from
  // comfyui-mcp-panel@v0.15.3 so the classification is checked against the shape it
  // will actually meet, and so the extra prose cannot flip the regexes.
  const REAL = (compared: string): string =>
    `workflow instance mismatch: ${compared}. Nothing was applied.\n\n` +
    `That is the comparison, not the cause — the panel observed only that the two ` +
    `identities differ. It can mean the workflow was switched or replaced after the ` +
    `command was issued, that this session's fence was never established or could not ` +
    `be refreshed, or that the identity could not be read at all.\n\n` +
    `Re-target with panel_set_workflow_target({mode:"current"}), or re-select the ` +
    `intended workflow with panel_open_workflow, then retry. If NO panel tab is ` +
    `connected, neither will help and the connection is the thing to fix — ` +
    `panel_graph_outline reports connectivity directly.`;

  async function outlineRaw(refusal: string): Promise<string> {
    const ctx = makePanelToolCtx(
      {
        send: async (cmd: Record<string, unknown>) => {
          if (cmd.cmd === "workflow_list") {
            listCalls += 1;
            return settled(LIVE);
          }
          throw new Error(refusal);
        },
        push: () => 1,
        canReach: (id: string) => id === TAB,
        isHeadless: () => false,
        tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
        resolveActiveTabId: () => TAB,
        refreshWorkflowUuid: () => false,
        workflowUuidFor: () => fence,
        tabCanMutateGraph: () => true,
        tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
      } as unknown as PanelToolCtx["bridge"],
      TAB,
      new WorkflowTargetStore(),
    );
    const def = buildPanelToolDefs().find((d) => d.name === "panel_graph_outline");
    if (!def) throw new Error("panel_graph_outline is not registered");
    const res: ToolResult = await def.handler({} as never, ctx);
    return res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
  }

  it("the full MISSING-stamp refusal is still classified as missing", async () => {
    const text = await outlineRaw(
      REAL(`this command carries no workflow-instance stamp, and the active canvas reports ${LIVE}`),
    );
    expect(text).toMatch(/MISSING stamp rather than a wrong one/);
    expect(text).toMatch(REBIND);
    expect(text).not.toMatch(CHOOSE);
    expect(adopted).toEqual([]);
  });

  it("the full WRONG-stamp refusal is still classified as wrong", async () => {
    fence = { known: true, uuid: STALE };
    const text = await outlineRaw(
      REAL(
        `this command was issued for workflow instance ${STALE}, and the active canvas reports ${LIVE}`,
      ),
    );
    expect(text).toMatch(/WRONG stamp, not a missing one/);
    expect(text).toMatch(CHOOSE);
    // The panel offered mode:"current" here as an equal option. This side, having
    // measured which state it is, does NOT — it says what re-targeting costs instead.
    expect(text).not.toMatch(REBIND);
    expect(text).toMatch(/re-points every later EDIT/);
    expect(adopted).toEqual([]);
  });
});

describe("the #1519 diagnosis cannot re-enter itself, and changes no other path", () => {
  it("a panel that FENCES the recovery probe surfaces its refusal instead of recursing", async () => {
    // The probe this branch runs is `workflow_list`, which flows back through the same
    // catch. A build predating panel #759 fences it too — the branch is keyed on the
    // `graph_` prefix precisely so that reply cannot re-enter the diagnosis. Bounded
    // recursion would show up here as an exploding call count (or a hang), not as
    // wrong wording.
    const { text } = await outline({ issuedFor: null, liveUuid: LIVE, probeRefused: true });

    expect(listCalls).toBeLessThanOrEqual(4); // one read + at most the #1292 rechecks
    expect(text).toMatch(/UNKNOWN/);
    expect(text).toContain("carries no workflow-instance stamp");
    expect(adopted).toEqual([]);
  }, 20000);

  it("a MUTATION refused by the same fence keeps its own #1330 verdict", async () => {
    // The control. The mutation branch runs first and is untouched: its wording says
    // NOT APPLIED, which is the claim a read must not make and a write must.
    fence = { known: true, uuid: STALE };
    const ctx = makePanelToolCtx(
      bridge({ issuedFor: STALE, liveUuid: LIVE }),
      TAB,
      new WorkflowTargetStore(),
    );
    const def = buildPanelToolDefs().find((d) => d.name === "panel_connect");
    if (!def) throw new Error("panel_connect is not registered");
    const res: ToolResult = await def.handler({ from_node_id: 1, to_node_id: 2 } as never, ctx);
    const text = res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

    expect(text).toMatch(/NOT applied — nothing changed/);
    expect(text).not.toMatch(/no graph data was read/);
    expect(adopted).toEqual([]);
  });

  it("WRONG STAMP is not retried and is not adopted", async () => {
    fence = { known: true, uuid: STALE };
    await outline({ issuedFor: STALE, liveUuid: LIVE, serveOutlineWhen: "adopted" });
    expect(adopted).toEqual([]);
    expect(sent.filter((c) => c === "graph_outline")).toEqual(["graph_outline"]);
  });
});

describe("an unstamped inert read is admitted (#1519 remaining)", () => {
  it("already_current: retries the outline without minting a new fence", async () => {
    // The fence appeared between dispatch and the probe. Retrying now carries it;
    // minting again would be claiming a repair this call did not make.
    fence = { known: true, uuid: LIVE };
    const { text, isError } = await outline({
      issuedFor: null,
      liveUuid: LIVE,
      serveOutlineWhen: "retry",
    });
    expect(isError).toBe(false);
    expect(text).toContain("CheckpointLoaderSimple");
    expect(adopted).toEqual([]);
    expect(sent.filter((c) => c === "graph_outline").length).toBeGreaterThan(1);
  });

  it("a refusal that quotes BOTH clauses is UNKNOWN, not a missing stamp", async () => {
    // Unanchored regexes let `unstamped` win whenever both phrases appear.
    // The panel does not emit that naturally; the classifier must still not guess.
    const both =
      `workflow instance mismatch: this command carries no workflow-instance stamp, ` +
      `and this command was issued for workflow instance ${STALE}, and the active ` +
      `canvas reports ${LIVE}. Nothing was applied.`;
    const ctx = makePanelToolCtx(
      {
        send: async (cmd: Record<string, unknown>) => {
          if (cmd.cmd === "workflow_list") {
            listCalls += 1;
            return settled(LIVE);
          }
          throw new Error(both);
        },
        push: () => 1,
        canReach: (id: string) => id === TAB,
        isHeadless: () => false,
        tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
        resolveActiveTabId: () => TAB,
        refreshWorkflowUuid: (_t: string, u: string) => {
          adopted.push(u);
          return true;
        },
        workflowUuidFor: () => fence,
        tabCanMutateGraph: () => true,
        tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
      } as unknown as PanelToolCtx["bridge"],
      TAB,
      new WorkflowTargetStore(),
    );
    const def = buildPanelToolDefs().find((d) => d.name === "panel_graph_outline");
    if (!def) throw new Error("panel_graph_outline is not registered");
    const res: ToolResult = await def.handler({} as never, ctx);
    const text = res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

    expect(text).toMatch(/is NOT known from here/);
    expect(text).not.toMatch(REBIND);
    expect(text).not.toMatch(CHOOSE);
    expect(adopted).toEqual([]);
  });

  it("graph_run refused by the same fence is not called a read", async () => {
    // isFencedGraphRead is true for graph_run (it is not a canvas edit), but
    // GRAPH_CMD_EFFECT lists it as targeted. The advice must not say a retry
    // cannot double-apply a prompt, and the lead must not say no graph data
    // was read — a run that never queued is "nothing was applied".
    fence = { known: true, uuid: LIVE };
    const ctx = makePanelToolCtx(bridge({ issuedFor: null, liveUuid: LIVE }), TAB);
    const res: ToolResult = await ctx.call({ cmd: "graph_run" });
    const text = res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

    expect(res.isError).toBe(true);
    expect(text).toMatch(/nothing was applied/);
    expect(text).not.toMatch(/no graph data was read/);
    expect(text).not.toMatch(/this is a read/);
    expect(adopted).toEqual([]);
  });
});

describe("a PIN to the live canvas does not block minting a missing stamp (#1913)", () => {
  // After ComfyUI restarted and the panel reconnected, the session was still
  // pinned to the active workflow, the live canvas had a valid instance identity,
  // and both panel_graph_outline and panel_get_errors were refused for carrying
  // no stamp. The documented recovery (mode:"current") restored the fence AND
  // released the pin. Minting from the live canvas while the pin still names
  // that canvas keeps the pin.

  function pinToLive(): WorkflowTargetStore {
    const store = new WorkflowTargetStore();
    store.set(TAB, { mode: "pinned", path: "workflows/a.json", filename: "a.json" });
    return store;
  }

  function pinStillHeld(store: WorkflowTargetStore): void {
    expect(store.get(TAB)).toEqual({
      mode: "pinned",
      path: "workflows/a.json",
      filename: "a.json",
    });
  }

  it("panel_graph_outline runs, the stamp is minted from the live canvas, and the pin is kept", async () => {
    const store = pinToLive();
    const { text, isError } = await outline(
      { issuedFor: null, liveUuid: LIVE, serveOutlineWhen: "adopted" },
      store,
    );

    expect(listCalls).toBeGreaterThan(0);
    expect(adopted).toEqual([LIVE]);
    expect(isError).toBe(false);
    expect(text).toContain("CheckpointLoaderSimple");
    expect(text).not.toMatch(/Error:/);
    expect(text).not.toMatch(REBIND);
    expect(text).not.toMatch(/RELEASES that pin/);
    expect(sent.filter((c) => c === "graph_outline").length).toBeGreaterThan(1);
    pinStillHeld(store);
  });

  it("panel_get_errors runs the same way — the other refused read", async () => {
    const store = pinToLive();
    const { text, isError } = await callRead(
      "panel_get_errors",
      { issuedFor: null, liveUuid: LIVE, serveOutlineWhen: "adopted" },
      store,
    );

    expect(listCalls).toBeGreaterThan(0);
    expect(adopted).toEqual([LIVE]);
    expect(isError).toBe(false);
    expect(text).toContain("missing_media: input.png");
    expect(text).not.toMatch(/Error:/);
    expect(text).not.toMatch(REBIND);
    expect(sent.filter((c) => c === "graph_get_errors").length).toBeGreaterThan(1);
    pinStillHeld(store);
  });

  it("already_current: retries without minting and without releasing the pin", async () => {
    // The fence appeared between dispatch and the probe. Retrying now carries it;
    // minting again would claim a repair this call did not make, and mode:"current"
    // would drop the pin for nothing.
    fence = { known: true, uuid: LIVE };
    const store = pinToLive();
    const { text, isError } = await outline(
      { issuedFor: null, liveUuid: LIVE, serveOutlineWhen: "retry" },
      store,
    );
    expect(isError).toBe(false);
    expect(text).toContain("CheckpointLoaderSimple");
    expect(adopted).toEqual([]);
    expect(sent.filter((c) => c === "graph_outline").length).toBeGreaterThan(1);
    pinStillHeld(store);
  });
});

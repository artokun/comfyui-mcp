// #1329 — the refusal already knew the answer, and billed the caller for it.
//
// The reporter uploaded two images and both `panel_add_node("LoadImage")` calls were
// refused:
//
//   "LoadImage" required input "image" was added or retyped since this page loaded its
//   node schema, so creating it now would build the OLD shape. Call panel_refresh_nodes
//   and retry.
//
// They called panel_refresh_nodes and retried, and it worked — both times. That is an
// agent-visible error plus two extra calls for something with exactly one correct
// response and no decision in it.
//
// WHY AUTOMATING THIS IS SAFE, and why the same reasoning does NOT license retrying
// mutations generally: the panel's guard throws BEFORE it creates anything ("Refuse
// before creating anything" — comfyui-mcp-panel.js), so the retry cannot leave two
// nodes on the canvas. A transport failure is the opposite case — the outcome is
// unknown, which is exactly why those are never re-issued on our own initiative.

import { describe, expect, it } from "vitest";
import { markReplyTimeout } from "../../services/ui-bridge.js";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";

const STALE = () =>
  new Error(
    `"LoadImage" required input "image" was added or retyped since this page loaded its node ` +
      `schema, so creating it now would build the OLD shape. Call panel_refresh_nodes and retry.`,
  );

/** panel#1518 — a realistic NON-stale failure of the retried add: the panel's own
 *  `addNodeRefreshBusyMessage`, which is what a second add hits when the refresh this
 *  path abandoned is still holding the coalescer slot. */
const BUSY = () =>
  new Error(
    `Cannot add "LoadImage" right now: a node-def refresh was still running, and waiting for ` +
      `it would have used up this command's 25s budget. NOTHING WAS ADDED. RETRY in a few seconds.`,
  );

type AddOutcome = "stale" | "ok" | "busy";

/**
 * `addOutcomes` is consumed one per graph_add_node call: "stale" throws the refusal,
 * "busy" throws an unrelated (non-stale) refusal, "ok" succeeds. `refreshFails` makes
 * refresh_nodes throw.
 */
function bridge(addOutcomes: AddOutcome[], refreshFails: boolean | "timeout" | "acked-error-quoting-timeout" = false) {
  const calls: string[] = [];
  let addIdx = 0;
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push(String(cmd.cmd));
      if (cmd.cmd === "refresh_nodes") {
        // #1491 — THREE outcomes, not two. A reply TIMEOUT is tagged by the bridge
        // itself (markReplyTimeout); an acked executor error is a plain throw. The
        // orchestrator must tell them apart, because the correct advice is opposite.
        // An ACKED executor error that merely QUOTES the bridge's timeout wording. The
        // panel relays arbitrary error text, so this shape is reachable — and it is the
        // only input that separates "read the bridge's tag" from "match the message".
        if (refreshFails === "acked-error-quoting-timeout") {
          throw new Error(
            `refresh aborted: last attempt reported Panel tab ${TAB} did not reply to "refresh_nodes" within 30000 ms`,
          );
        }
        if (refreshFails === "timeout") {
          throw markReplyTimeout(
            new Error(`Panel tab ${TAB} did not reply to "refresh_nodes" within 30000 ms`),
          );
        }
        if (refreshFails) throw new Error("panel did not answer the refresh");
        return { refreshed: true };
      }
      if (cmd.cmd === "graph_add_node") {
        const outcome = addOutcomes[Math.min(addIdx, addOutcomes.length - 1)];
        addIdx += 1;
        if (outcome === "stale") throw STALE();
        if (outcome === "busy") throw BUSY();
        return { ok: true, node_id: 42 };
      }
      return { ok: true };
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

async function addNode(addOutcomes: AddOutcome[], refreshFails: boolean | "timeout" | "acked-error-quoting-timeout" = false) {
  const { b, calls } = bridge(addOutcomes, refreshFails);
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_add_node");
  if (!def) throw new Error("panel_add_node is not registered");
  const res: ToolResult = await def.handler({ class_type: "LoadImage" } as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
    calls,
  };
}

describe("a stale node schema is refreshed and retried once (#1329)", () => {
  it("the reporter's case: refuse → refresh → add, with no error surfaced", async () => {
    const { text, isError, calls } = await addNode(["stale", "ok"]);

    expect(isError).toBe(false);
    expect(calls).toEqual(["graph_add_node", "refresh_nodes", "graph_add_node"]);
    // The refusal never reaches the caller — it was actionable, and it was acted on.
    expect(text).not.toMatch(/added or retyped since this page loaded/);
  });

  it("EXACTLY once — a still-stale schema is not retried forever", async () => {
    const { isError, calls } = await addNode(["stale", "stale"]);

    expect(isError).toBe(true);
    expect(calls.filter((c) => c === "graph_add_node")).toHaveLength(2);
    expect(calls.filter((c) => c === "refresh_nodes")).toHaveLength(1);
  });

  it("…and when it is still stale, says the prescribed remedy will not clear it", async () => {
    // The caller must not follow the refusal's own advice into a loop we already ran.
    const { text } = await addNode(["stale", "stale"]);

    expect(text).toMatch(/already retried ONCE automatically/);
    expect(text).toMatch(/repeating panel_refresh_nodes will not clear it/);
    expect(text).toMatch(/Reload the ComfyUI browser tab/);
  });

  it("a FAILED refresh keeps the original refusal and discloses the attempt", async () => {
    // The schema refusal is the better error — it names what is wrong and what fixes
    // it. The refresh failure rides alongside so the caller is not left wondering
    // whether the automatic attempt happened.
    const { text, isError, calls } = await addNode(["stale", "ok"], true);

    expect(isError).toBe(true);
    expect(text).toMatch(/added or retyped since this page loaded/); // preserved verbatim
    expect(text).toMatch(/panel_refresh_nodes was dispatched and FAILED/);
    // The add is NOT retried after a failed refresh — the schema is unchanged.
    expect(calls.filter((c) => c === "graph_add_node")).toHaveLength(1);
  });

  it("a healthy add is untouched — one call, no refresh", async () => {
    const { isError, calls } = await addNode(["ok"]);

    expect(isError).toBe(false);
    expect(calls).toEqual(["graph_add_node"]);
  });

  it("an UNRELATED failure is never retried", async () => {
    // The guard keys on the drift sentence, not on the word panel_refresh_nodes, which
    // appears in several other remedies. Keying on the recommendation would make any of
    // them trigger a second mutating add.
    const { b, calls } = bridge(["ok"]);
    const bridgeThatFails = {
      ...(b as object),
      send: async (cmd: Record<string, unknown>) => {
        calls.push(String(cmd.cmd));
        throw new Error(
          "something else went wrong entirely. Call panel_refresh_nodes and retry.",
        );
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridgeThatFails, TAB, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_add_node");
    if (!def) throw new Error("panel_add_node is not registered");
    const res = await def.handler({ class_type: "LoadImage" } as never, ctx);

    expect(res.isError).toBe(true);
    expect(calls.filter((c) => c === "graph_add_node")).toHaveLength(1);
    expect(calls).not.toContain("refresh_nodes");
  });
});

describe("#1491: an auto-refresh that outran its ack is NOT a failed refresh", () => {
  it("a reply TIMEOUT tells the caller to retry, and never says the schema is unchanged", async () => {
    // The reported case: the automatic refresh "failed" at 30s and an explicit
    // panel_refresh_nodes moments later succeeded immediately. `joinMs` does not cancel
    // work already in flight — the panel's coalescer keeps running and registers what it
    // fetched — so on a large install the refresh legitimately outlives this ack.
    const { text, calls } = await addNode(["stale", "stale"], "timeout");

    expect(text).toContain("did NOT answer within its window");
    expect(text).toContain("RETRY the add");
    // panel#1518 — and the advice is only reached because the tool TOOK the retry first
    // and it was still stale. Bounded: exactly two adds, one refresh, never a loop.
    expect(calls).toEqual(["graph_add_node", "refresh_nodes", "graph_add_node"]);
    // The two claims that were false, and the second is the damaging one: it argues the
    // caller out of the only action that works.
    expect(text).not.toContain("so the schema is unchanged");
    expect(text).not.toContain("retrying the add will refuse again");
    // And it must not assert a frozen tab it never observed.
    expect(text).toContain("Nothing here observed the tab being frozen");
  });

  it("an ACKED error that QUOTES the timeout wording is still a failure", async () => {
    // #1468's point, and the reason this decision may not be made from message text: the
    // panel relays arbitrary error text, and ctx.call flattens a tagged timeout and an
    // acked error into the same text-only result. Only the bridge-owned tag separates
    // them. Without this fixture a text-matching implementation passes every other test
    // here — verified: it did.
    const { text } = await addNode(["stale", "stale"], "acked-error-quoting-timeout");

    expect(text).toContain("was dispatched and FAILED");
    expect(text).toContain("so the schema is unchanged");
    expect(text).not.toContain("RETRY the add");
    expect(text).not.toContain("did NOT answer within its window");
  });

  it("a GENUINE refresh failure keeps the original advice", async () => {
    // An acked executor error is not a timeout: the refresh really did not happen, so a
    // retry really will refuse again. Softening this case would be the opposite defect.
    const { text } = await addNode(["stale", "stale"], true);

    expect(text).toContain("was dispatched and FAILED");
    expect(text).toContain("so the schema is unchanged");
    expect(text).not.toContain("RETRY the add");
  });
});

describe("panel#1518: after an ack timeout the add is retried, not billed to the caller", () => {
  it("the reporter's case: refuse → refresh times out → retry → SUCCESS, no error surfaced", async () => {
    // Reported verbatim: "the tool returned an error, although the refresh continued. An
    // immediate identical panel_add_node retry succeeded." #1491 taught this branch to SAY
    // "retry the add"; this takes the retry instead of charging a round trip for it.
    const { text, isError, calls } = await addNode(["stale", "ok"], "timeout");

    expect(isError).toBe(false);
    expect(calls).toEqual(["graph_add_node", "refresh_nodes", "graph_add_node"]);
    // The false terminal failure is gone in both directions: no error flag, and the
    // refusal that caused it never reaches the caller.
    expect(text).not.toMatch(/added or retyped since this page loaded/);
    expect(text).not.toContain("did NOT answer within its window");
  });

  it("a GENUINE refresh failure is still never retried — the schema really is unchanged", async () => {
    // The duplicate-safety argument licenses ONE retry off a refusal that created nothing;
    // it does not license retrying whenever an add fails. This is the case where a retry
    // is known to be pointless, and softening it would be the opposite defect.
    const { isError, calls } = await addNode(["stale", "ok"], true);

    expect(isError).toBe(true);
    expect(calls).toEqual(["graph_add_node", "refresh_nodes"]);
  });

  it("an ACKED error QUOTING the timeout wording is not retried either — the tag decides", async () => {
    // #1468's rule, re-pinned at the new fork: the retry is now the consequence of
    // isReplyTimeoutResult, so a text-matching implementation would issue a real second
    // mutating add off a sentence the panel is free to write.
    const { isError, calls } = await addNode(["stale", "ok"], "acked-error-quoting-timeout");

    expect(isError).toBe(true);
    expect(calls).toEqual(["graph_add_node", "refresh_nodes"]);
  });

  it("an unrelated failure of the RETRY says which attempt it came from", async () => {
    // Without this the caller sees a bare second-attempt error on a path they never asked
    // to be retried, and cannot tell how many adds are unaccounted for.
    const { text, isError, calls } = await addNode(["stale", "busy"], "timeout");

    expect(isError).toBe(true);
    expect(calls).toEqual(["graph_add_node", "refresh_nodes", "graph_add_node"]);
    expect(text).toContain("NOTHING WAS ADDED"); // the panel's own error, verbatim
    expect(text).toContain("This add was an AUTOMATIC retry");
    expect(text).toContain("at most ONE add is unaccounted for");
  });

  it("…and that disclosure is NOT bolted onto a successful retry", async () => {
    const { text, isError } = await addNode(["stale", "ok"], "timeout");

    expect(isError).toBe(false);
    expect(text).not.toContain("This add was an AUTOMATIC retry");
  });

  it("still stale after the retry: does not overclaim a refresh it never saw finish", async () => {
    // The acked-success wording ("panel_refresh_nodes reported success", "repeating it will
    // not clear it", "reload the tab") is false here — nothing observed that refresh
    // finish, and it is still running.
    const { text } = await addNode(["stale", "stale"], "timeout");

    expect(text).toContain("the add was then retried ONCE anyway");
    expect(text).toContain("Neither attempt added anything");
    expect(text).not.toContain("panel_refresh_nodes reported success");
    expect(text).not.toContain("repeating panel_refresh_nodes will not clear it");
  });
});

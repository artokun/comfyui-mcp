// panel#1339 — "panel_set_widget transiently rejects matching re-derived workflow identity".
//
// The reporter's call was refused with "this workflow has no trusted identity for the
// panel to fence the command against", was told the identity "DOES carry an identity
// (<uuid>) and this session's fence has been re-derived onto it", retried, and it
// worked. They filed it as a contradiction and read it as a race.
//
// It is not a race. The FAILED CALL IS THE REPAIR: on this path `rebindWorkflowFence`
// adopts, so the refusal installs the fence the retry then succeeds with. What is
// actually broken is that ONE sentence covered two opposite outcomes:
//
//   refreshed        the tab had no fence and THIS CALL installed it → retry
//   already_current  the fence read back already present and equal, which cannot be
//                    the fence the command was refused against (the refusal proves
//                    that one was missing) → nothing was repaired, and the uuid
//                    quoted belongs to a tab reached during the check
//
// and those want opposite next moves. Taxonomy class 1: two distinct states collapsed
// into one indistinguishable answer.
//
// The prose split is half the fix. The half that matters for a PROGRAM is that the
// verdict must be readable without parsing the sentence — this project's standing rule
// is that an agent never decides to re-run a mutation by pattern-matching an error
// message. So the discriminator rides in `structuredContent.panel_fence`, and the
// "nothing was applied" half of it rests on the BRIDGE'S typed dispatch flag, never on
// the phrase match that selects the branch.

import { describe, expect, it } from "vitest";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  registerPanelTools,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { markDispatched } from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/niji_holo_impasto.json";
const LIVE_UUID = "55555555-5555-4555-8555-555555555555";

type Fence = { known: false } | { known: true; uuid?: string };

/** The refusal the bridge really mints for this state: `markDispatched(err, false)`
 *  — the typed proof that the frame never reached the socket (ui-bridge.ts). */
const identityRefusal = (tagged = true): Error => {
  const err = new Error(
    `"graph_set_widget" cannot be safely targeted to the active workflow: this workflow has ` +
      `no trusted identity for the panel to fence the command against. Reads and view-only ` +
      `commands still work (graph_outline, graph_query, graph_get_state).`,
  );
  // `tagged:false` is the hostile case: an error whose TEXT satisfies the branch's
  // phrase match but which carries no dispatch flag at all.
  return tagged ? markDispatched(err, false) : err;
};

function bridge(opts: { fence: Fence; activeUuid: string | null | "throw"; tagged?: boolean }) {
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "workflow_list") {
        if (opts.activeUuid === "throw") throw new Error("panel did not answer");
        const active = {
          path: "workflows/niji_holo_impasto.json",
          routing_key: TAB,
          ...(opts.activeUuid ? { workflow_uuid: opts.activeUuid } : {}),
        };
        return { active, workflows: [{ ...active, active: true }], active_confirmed: true };
      }
      throw identityRefusal(opts.tagged ?? true);
    },
    push: () => 1,
    canReach: (id: string) => id === TAB,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: () => true,
    workflowUuidFor: () => opts.fence,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return b;
}

async function setWidget(opts: {
  fence: Fence;
  activeUuid: string | null | "throw";
  tagged?: boolean;
}): Promise<{ text: string; res: ToolResult; fence: Record<string, unknown> | undefined }> {
  const ctx = makePanelToolCtx(bridge(opts), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
  if (!def) throw new Error("panel_set_widget is not registered");
  const res: ToolResult = await def.handler({ node_id: 7, widget: "steps", value: 20 } as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    res,
    fence: (res.structuredContent as { panel_fence?: Record<string, unknown> } | undefined)
      ?.panel_fence,
  };
}

/** THE ONE THIS CALL REPAIRED: no fence on the tab, live canvas has an identity. */
const REFRESHED = { fence: { known: false } as Fence, activeUuid: LIVE_UUID };
/** THE ONE IT DID NOT: a fence read back already present and already equal. */
const ALREADY_CURRENT = { fence: { known: true, uuid: LIVE_UUID } as Fence, activeUuid: LIVE_UUID };

describe("the two states behind one sentence are told apart (panel#1339)", () => {
  it("refreshed: says THIS CALL installed the fence, and the field says so too", async () => {
    const { text, fence } = await setWidget(REFRESHED);

    expect(text).toMatch(/THIS CALL installed one/);
    expect(text).toContain(LIVE_UUID);
    expect(text).toMatch(/RETRY THIS EXACT CALL ONCE/);

    expect(fence).toBeDefined();
    expect(fence?.rebind_status).toBe("refreshed");
    expect(fence?.fence_repaired_by_this_call).toBe("yes");
    expect(fence?.retry_clears_refusal).toBe("yes");
    expect(fence?.next_action).toBe("retry_same_call");
    expect(fence?.workflow_uuid).toBe(LIVE_UUID);
  });

  it("already_current: says NOTHING was repaired, and does not order a blind retry", async () => {
    const { text, fence } = await setWidget(ALREADY_CURRENT);

    expect(text).toMatch(/THIS CALL REPAIRED NOTHING/);
    // The claim the reporter read as a contradiction must be gone from THIS state.
    expect(text).not.toMatch(/this session's fence has been re-derived onto it/);
    expect(text).not.toMatch(/THIS CALL installed one/);
    expect(text).toMatch(/CONFIRM THE TARGET BEFORE RETRYING/);

    expect(fence).toBeDefined();
    expect(fence?.rebind_status).toBe("already_current");
    expect(fence?.fence_repaired_by_this_call).toBe("no");
    // Not "yes" and not "no": nothing here establishes whose tab that fence is.
    expect(fence?.retry_clears_refusal).toBe("unknown");
    expect(fence?.next_action).toBe("confirm_target_then_retry");
  });

  it("THE COLLAPSE: the two answers differ in the FIELD, not only in the prose", async () => {
    // This is the whole defect. Before the fix both states returned the identical
    // sentence and NO structured half at all, so a caller had exactly one observation
    // for two opposite situations.
    const a = await setWidget(REFRESHED);
    const b = await setWidget(ALREADY_CURRENT);

    expect(a.fence, "the refreshed refusal carries no machine-readable verdict").toBeDefined();
    expect(b.fence, "the already_current refusal carries no machine-readable verdict").toBeDefined();
    expect(a.fence?.fence_repaired_by_this_call).not.toBe(b.fence?.fence_repaired_by_this_call);
    expect(a.fence?.next_action).not.toBe(b.fence?.next_action);
    expect(a.fence?.rebind_status).not.toBe(b.fence?.rebind_status);
    // …and a caller reading ONLY the field never has to look at the sentence.
    expect(a.text).not.toBe(b.text);
  });

  it("no_identity keeps its remedy, and the field agrees a retry will NOT clear it", async () => {
    const { text, fence } = await setWidget({ fence: { known: false }, activeUuid: null });

    expect(text).toMatch(/CHECKED, so this is not a guess/);
    expect(text).toMatch(/panel_open_workflow\(<path>\)/);
    expect(text).toMatch(/panel_save_workflow/);
    expect(fence?.rebind_status).toBe("no_identity");
    expect(fence?.retry_clears_refusal).toBe("no");
    expect(fence?.next_action).toBe("open_or_save_workflow");
    expect(fence?.fence_repaired_by_this_call).toBe("no");
  });

  it("unreadable stays UNKNOWN in the field as well as in the sentence", async () => {
    const { text, fence } = await setWidget({ fence: { known: false }, activeUuid: "throw" });

    expect(text).toMatch(/the answer is UNKNOWN/);
    expect(fence?.retry_clears_refusal).toBe("unknown");
    expect(fence?.next_action).toBe("open_workflow");
  });
});

describe("the retry-safety claim stands on the bridge's typed flag, never on the text", () => {
  it("a TAGGED refusal reports retry_safe:yes and says nothing was applied", async () => {
    const { text, fence } = await setWidget(REFRESHED);

    expect(fence?.dispatched).toBe("no");
    expect(fence?.retry_safe).toBe("yes");
    expect(text).toMatch(/never written to the socket/);
    expect(text).toMatch(/cannot double-apply/);
  });

  it("an UNTAGGED error with the same words gets retry_safe:unknown, and no promise", async () => {
    // The branch is selected by /no trusted identity/i — a phrase any wrapped or
    // re-surfaced error can contain. Deciding "it is safe to re-run this mutation"
    // off that match is precisely the move this repo forbids. The word match may
    // choose WHAT TO EXPLAIN; only the bridge's flag may authorise a re-run.
    const { text, fence } = await setWidget({ ...REFRESHED, tagged: false });

    expect(fence?.dispatched).toBe("unknown");
    expect(fence?.retry_safe).toBe("unknown");
    expect(text).not.toMatch(/cannot double-apply/);
    expect(text).toMatch(/is NOT established here/);
  });
});

describe("explaining the refusal never becomes letting one through", () => {
  it("every state still REFUSES and still carries the panel's own cause", async () => {
    const states: Array<{ fence: Fence; activeUuid: string | null | "throw" }> = [
      REFRESHED,
      ALREADY_CURRENT,
      { fence: { known: false }, activeUuid: null },
      { fence: { known: false }, activeUuid: "throw" },
    ];
    for (const state of states) {
      const { text, res } = await setWidget(state);
      expect(res.isError).toBe(true);
      expect(text).toMatch(/^Error:/);
      expect(text).toMatch(/no trusted identity/);
    }
  });
});

describe("WIRING: the field survives the real MCP transport on an isError result", () => {
  it("a real Client sees structuredContent.panel_fence on the refusal", async () => {
    // The reachability claim, and it is NOT covered by #1589's test: that one proves
    // the SDK forwards `structuredContent` on a SUCCESS. A refusal takes a different
    // shape (`isError: true`), and a caller that cannot read the field over the wire
    // is back to parsing the sentence.
    const server = new McpServer({ name: "fence-1339-test", version: "1.0.0" });
    registerPanelTools(
      server,
      makePanelToolCtx(bridge(ALREADY_CURRENT), TAB, new WorkflowTargetStore()),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "fence-1339-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = await client.callTool({
        name: "panel_set_widget",
        arguments: { node_id: 7, widget: "steps", value: 20 },
      });
      expect(res.isError).toBe(true);
      const structured = res.structuredContent as
        | { panel_fence?: Record<string, unknown> }
        | undefined;
      expect(structured?.panel_fence, "the verdict did not survive the MCP round trip").toBeDefined();
      expect(structured?.panel_fence?.fence_repaired_by_this_call).toBe("no");
      expect(structured?.panel_fence?.next_action).toBe("confirm_target_then_retry");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("SOURCE: the CALL SITE emits the verdict, and the two statuses are not re-merged", () => {
    // A behavioural test proves today's build answers correctly. It cannot see an edit
    // that folds the two branches back into one `||` while leaving a helper that still
    // compiles, so read the call site itself.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../orchestrator/panel-tools.ts"),
      "utf8",
    );
    const at = src.indexOf("if (isNoTrustedIdentityRefusal(err) && isMutatingGraphCmd(cmd)) {");
    expect(at, "the no-trusted-identity branch is gone").toBeGreaterThan(0);
    const body = src.slice(at, at + 8000);

    // The exact shape of the bug.
    expect(body).not.toMatch(/rebind\.status === "refreshed" \|\| rebind\.status === "already_current"/);
    // Two separate decisions, each with its own answer…
    expect(body).toMatch(/rebind\.status === "refreshed"/);
    expect(body).toMatch(/rebind\.status === "already_current"/);
    // …and the machine-readable half is produced HERE, not merely available somewhere.
    expect(body).toContain("failWithFenceDiagnosis");
    // The retry-safety claim reads the typed flag at this call site.
    expect(body).toContain("dispatchOutcomeOf(err)");
  });
});

// #1129 (reopened) — legacy ComfyUI-Manager 3.x answers the install POST with
// `queued: true` and never enqueues the task. The reporter's follow-up read
// showed an idle queue with `total_count: 0` and no directory under
// custom_nodes, while panel_install_node had already reported success.
//
// #1143 fixed the OTHER half of this family — a pre-queue 403/404 refusal falls
// through to a direct clone. It keys on the rejection status, so it cannot fire
// here: the POST succeeded.
//
// WHY THIS ONLY WARNS, AND DOES NOT REPORT FAILURE. The first version checked the
// installed list too and, finding the pack absent, flipped the result to an
// error. Adversarial review killed that, correctly, on three counts:
//
//   - it substring-searched the RAW reply text instead of a validated shape, so
//     an error envelope or an unfamiliar dialect payload read as "absent" —
//     breaking this file's own rule that an unknown answer claims nothing;
//   - the fixture it was tested against (`{nodes:[{name}]}`) is not the panel's
//     production shape at all (`{installed: ...}`), so the check was only ever
//     passing because it searched text;
//   - a git URL's checkout directory need not match its URL basename, and the
//     panel documents those targets as rename-prone. Absence by derived name
//     therefore cannot PROVE failure.
//
// Since the second observation cannot be made decisive, the honest reply is a
// warning that says exactly what WAS observed — the queue has no such task — and
// tells the caller to confirm. A false "definitely failed" on a working install
// is the same class of harm as the false success this issue is about.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

const { buildPanelToolDefs, makePanelToolCtx } = await import("../../orchestrator/panel-tools.js");
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const TAB = "11111111-2222-3333-4444-555555555555";
const REPO = "https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context";

const textOf = (r: ToolResult): string =>
  r.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

let sent: string[] = [];

/** A class-method receiver catches accidental unbound invocation of the real
 * UiBridge resolver. The method deliberately reads instance state, like the
 * production method's `this.resolveTarget()` call. */
class ScopeKeyBridge {
  constructor(private readonly scopeTargets: Record<string, string>) {}

  resolveSharedTabId(scopeId?: string): string | undefined {
    return scopeId === undefined ? undefined : this.scopeTargets[scopeId];
  }
}

function bridge(opts: {
  install?: Record<string, unknown>;
  /** The `status` block nodes_queue_status wraps. */
  status?: Record<string, unknown> | null;
  queueErrors?: boolean;
  /** Model a bridge that cannot say which panel holds the route key. */
  noIncarnation?: boolean;
  tabId?: string;
  resolveSharedTabId?: (scopeId?: string) => string | undefined;
  scopeTargets?: Record<string, string>;
  incarnationArgs?: string[];
  dispatchedTabIds?: string[];
}) {
  const fixture = {
    send: async (cmd: Record<string, unknown>, sendOpts?: { tabId?: string }) => {
      sent.push(String(cmd.cmd));
      if (sendOpts?.tabId) opts.dispatchedTabIds?.push(sendOpts.tabId);
      if (cmd.cmd === "nodes_install") {
        // The reporter's exact reply.
        return opts.install ?? { queued: true, pending: true, dialect: "legacy" };
      }
      if (cmd.cmd === "nodes_queue_status") {
        if (opts.queueErrors) throw new Error("queue unreachable");
        // The panel wraps it: `{ status }` (plus recent_failures/note sometimes).
        return { status: opts.status ?? { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false } };
      }
      return { ok: true };
    },
    // The REAL UiBridge always reports this; a fixture without it models a
    // bridge that cannot identify which panel answered, which is a separate case
    // asserted below.
    ...(opts.resolveSharedTabId === undefined ? {} : { resolveSharedTabId: opts.resolveSharedTabId }),
    tabIncarnation: (id: string) => {
      opts.incarnationArgs?.push(id);
      if (opts.tabId?.startsWith("orchestrator::") && id !== TAB) {
        throw new Error(`scope address leaked to tabIncarnation: ${id}`);
      }
      return opts.noIncarnation ? undefined : "inc-A";
    },
    push: () => 1,
    canReach: (id: string) => id === TAB,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: () => true,
    workflowUuidFor: () => ({ known: false }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  };
  return (opts.scopeTargets === undefined
    ? fixture
    : Object.assign(new ScopeKeyBridge(opts.scopeTargets), fixture)) as unknown as PanelToolCtx["bridge"];
}

async function install(
  opts: Parameters<typeof bridge>[0],
): Promise<{ text: string; isError: boolean }> {
  const ctx = makePanelToolCtx(bridge(opts), opts.tabId ?? TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_install_node");
  if (!def) throw new Error("panel_install_node is not registered");
  const res: ToolResult = await def.handler({ repository: REPO } as never, ctx);
  return { text: textOf(res), isError: res.isError === true };
}

beforeEach(() => {
  sent = [];
});

describe("an install the Manager accepted and dropped says so (#1129)", () => {
  it("warns when the queue is IDLE and has seen no task at all", async () => {
    const out = await install({});

    // The read really happened — otherwise this asserts on a verdict reached
    // without looking, which is the defect itself.
    expect(sent).toContain("nodes_queue_status");

    expect(out.text).toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
    // States WHAT WAS OBSERVED, and refuses to convert it into proof. A queue
    // reset clears these same counters, so an install that really ran can read
    // this way — the message must say so rather than assert the task never ran.
    expect(out.text).toMatch(/total_count, done, in_progress all 0/);
    expect(out.text).toMatch(/not a receipt/);
    expect(out.text).toMatch(/NOT PROOF EITHER WAY/);
    expect(out.text).toMatch(/cleared by a queue RESET/);
    expect(out.text).toMatch(/do not reinstall on\s+the assumption it did not/);
    // The earlier wording asserted both of these outright; neither is supportable
    // once a queue reset can produce this same reading after a real install.
    expect(out.text).not.toMatch(/this is not a task that already ran/);
    expect(out.text).not.toMatch(/Retrying HERE will be dropped/);
    // Names the confirmation and the tool that CAN clone.
    expect(out.text).toMatch(/panel_list_nodes/);
    expect(out.text).toMatch(/install_custom_node/);

    // NO PROVENANCE CLAIM, in either direction. Five review rounds each found the
    // explanation of WHY the task was dropped false in some reachable state — an
    // id-only install submits no URL, and a `repository` that is any non-empty
    // string need not be one. Every fix branched on a fact the request does not
    // reliably carry. The observation needs no such fact, so the message no
    // longer makes one: less useful in the common case, never false.
    expect(out.text).not.toMatch(/git URL/i);
    expect(out.text).not.toMatch(/does not recognise/);

    // NOT an error. Absence could not be proven, so the result is not flipped —
    // a false definite failure on a working install is the mirror of this bug.
    expect(out.isError).toBe(false);
  });

  it("says nothing while the worker is PROCESSING, even at total_count 0 (codex P1)", async () => {
    // A snapshot taken mid-accept can read zero before the counters move. Treating
    // that as "never queued" would warn about an install that is starting
    // normally — the reporter's own signature requires an IDLE queue.
    const out = await install({
      status: { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: true },
    });

    expect(sent).toContain("nodes_queue_status");
    expect(out.text).not.toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
  });

  it("says nothing when idleness is UNKNOWN", async () => {
    // No `is_processing` at all: the shape cannot answer whether the worker is
    // running, so it is not made to.
    const out = await install({ status: { total_count: 0, done_count: 0 } });

    expect(out.text).not.toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
  });

  it("says nothing when the queue DID see a task", async () => {
    const out = await install({
      status: { total_count: 1, done_count: 0, in_progress_count: 1, is_processing: true },
    });

    expect(out.text).not.toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
  });

  it("says nothing on INCOHERENT counts", async () => {
    // total 0 with work recorded against it does not match the 3.x contract
    // (total = done + in_progress + queued), so this reasoning does not describe
    // that payload and must not be applied to it.
    const out = await install({
      status: { total_count: 0, done_count: 3, in_progress_count: 0, is_processing: false },
    });

    expect(out.text).not.toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
  });

  it("says nothing on a v4-style shape with no total_count", async () => {
    // v4 reports `pending_count` directly. The dropped-enqueue defect is legacy
    // 3.x behaviour, so a shape that cannot answer is left alone.
    //
    // EVERY OTHER FIELD IS PRESENT AND ZERO on purpose. An earlier version of this
    // fixture also omitted `done_count`, so the presence requirement rejected it
    // before `total_count` was ever consulted — the case passed while proving
    // nothing about the check it names. A surviving mutation ("treat a missing
    // total_count as zero") is what exposed that.
    const out = await install({
      status: { pending_count: 0, done_count: 0, in_progress_count: 0, is_processing: false },
    });

    expect(out.text).not.toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
  });

  it("claims nothing when a count is MISSING rather than zero (codex P2)", async () => {
    // Absent is not zero. The repo's established legacy-empty proof requires every
    // count to be reported and exact; accepting a missing field would let a
    // payload that never described the queue stand in for one that did.
    const noDone = await install({
      status: { total_count: 0, in_progress_count: 0, is_processing: false },
    });
    expect(noDone.text).not.toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);

    const noInProgress = await install({
      status: { total_count: 0, done_count: 0, is_processing: false },
    });
    expect(noInProgress.text).not.toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);

    // A reported pending_count has to agree too.
    const pending = await install({
      status: { total_count: 0, done_count: 0, in_progress_count: 0, pending_count: 2, is_processing: false },
    });
    expect(pending.text).not.toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
  });

  it("claims nothing when the read lands on a DIFFERENT tab (codex P1)", async () => {
    // ctx.call runs ensureReachable first, which silently rebinds an unpinned
    // current-mode session onto the sole remaining interactive tab. Another
    // ComfyUI's empty queue is not evidence about an install dispatched
    // elsewhere. Same guard #1468 needed — this is the second probe in this file
    // to need it, which is why it is asserted rather than assumed.
    const OTHER = "99999999-8888-7777-6666-555555555555";
    let gone = false;
    const b = {
      send: async (cmd: Record<string, unknown>) => {
        sent.push(String(cmd.cmd));
        if (cmd.cmd === "nodes_install") {
          gone = true; // the bound tab disappears right after the install
          return { queued: true, pending: true, dialect: "legacy" };
        }
        return { status: { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false } };
      },
      // A STABLE incarnation on purpose: the route key must be the only thing
      // that differs, or this case stops isolating the route-key pin. Without it
      // the fail-closed unknown-incarnation rule short-circuits first and the
      // test passes for the wrong reason — a surviving mutation caught exactly
      // that.
      tabIncarnation: () => "inc-STABLE",
      push: () => 1,
      canReach: (id: string) => (gone ? id === OTHER : id === TAB),
      isHeadless: () => false,
      tabs: () =>
        gone
          ? [{ tab_id: OTHER, title: "other", connected_at: 0 }]
          : [{ tab_id: TAB, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => (gone ? OTHER : TAB),
      refreshWorkflowUuid: () => true,
      workflowUuidFor: () => ({ known: false }),
      tabCanMutateGraph: () => true,
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    } as unknown as PanelToolCtx["bridge"];

    const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_install_node");
    const res: ToolResult = await def!.handler({ repository: REPO } as never, ctx);

    // The rebind really happened — asserted, not inferred, or this test would
    // stay green if ensureReachable quietly declined to rebind.
    expect(ctx.tabId).toBe(OTHER);
    expect(textOf(res)).not.toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
  });

  it("claims nothing when the SAME key is taken over by another panel (codex P1)", async () => {
    // The route key is not the panel. A `wf:` key is `wf:<tabRouteId>:<path>` — it
    // names a WORKFLOW, so it recurs, and a different browser tab can take it over
    // with `ctx.tabId` completely unchanged. The previous guard compared only the
    // key and would have read the REPLACEMENT panel's empty queue while the
    // message claimed it was "on that same panel".
    let incarnation = "inc-A";
    const b = {
      send: async (cmd: Record<string, unknown>) => {
        sent.push(String(cmd.cmd));
        if (cmd.cmd === "nodes_install") {
          incarnation = "inc-B"; // another browser tab takes over the same key
          return { queued: true, pending: true, dialect: "legacy" };
        }
        return { status: { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false } };
      },
      tabIncarnation: () => incarnation,
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

    const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_install_node");
    const res: ToolResult = await def!.handler({ repository: REPO } as never, ctx);

    // The key really did NOT change — that is the whole point of this case.
    expect(ctx.tabId).toBe(TAB);
    expect(textOf(res)).not.toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
  });

  it("still warns when the same panel holds the key throughout", async () => {
    // The other half: a stable incarnation must not suppress the warning, or the
    // guard above would quietly switch the whole feature off.
    const b = {
      send: async (cmd: Record<string, unknown>) => {
        sent.push(String(cmd.cmd));
        return cmd.cmd === "nodes_install"
          ? { queued: true, pending: true, dialect: "legacy" }
          : { status: { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false } };
      },
      tabIncarnation: () => "inc-STABLE",
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

    const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_install_node");
    const res: ToolResult = await def!.handler({ repository: REPO } as never, ctx);

    expect(textOf(res)).toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
  });

  it.each([
    ["Claude", "orchestrator::claude"],
    ["HTTP", "orchestrator::codex"],
  ])("resolves the %s scope address before reading the panel incarnation", async (_lane, SCOPE) => {
    const incarnationArgs: string[] = [];
    const dispatchedTabIds: string[] = [];
    const out = await install({
      tabId: SCOPE,
      scopeTargets: { [SCOPE]: TAB },
      incarnationArgs,
      dispatchedTabIds,
    });

    // Production-shaped Claude and HTTP contexts carry their backend-qualified
    // scope address into the shared tool server, while UiBridge routes it to
    // the real panel connection. ScopeKeyBridge's class method fails if the
    // resolver is called without its receiver.
    expect(out.text).toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
    expect(dispatchedTabIds).toEqual([SCOPE, SCOPE]);
    expect(incarnationArgs).toEqual([TAB, TAB]);
  });

  it("claims nothing when the bridge cannot identify the panel (codex final)", async () => {
    // UNKNOWN is not "unchanged". Comparing two undefined incarnations yields
    // equality, so a same-key takeover would pass the guard while the message
    // claims the read happened "on that same panel" — a false statement produced
    // by a guard that cannot see. A bridge that cannot answer does not get to.
    const out = await install({ noIncarnation: true });

    expect(sent).toContain("nodes_queue_status");
    expect(out.text).not.toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
    expect(out.text).not.toMatch(/on that same panel/);
  });

  it("claims nothing when the queue read itself fails", async () => {
    const out = await install({ queueErrors: true });

    expect(out.text).not.toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
    expect(out.isError).toBe(false);
  });

  it("does not read the queue at all when nothing claimed it was queued", async () => {
    // Nothing to contradict, and probing would spend a round trip per install for
    // no reason (codex P2 — this is the only extra read, and it is conditional).
    const out = await install({ install: { installed: true, dialect: "v4" } });

    expect(sent).not.toContain("nodes_queue_status");
    expect(out.isError).toBe(false);
  });
});

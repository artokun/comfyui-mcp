// #2481 — panel_set_todo delivered to the tab but no ACK within 15000 ms.
//
// The generic mutating-delivery disclosure then left the caller guessing:
// "may have been applied … a blind retry can apply it twice", with no
// mutation receipt, no idempotency key, and no read-back. Later graph
// mutations on the same tab succeeded — a transient ACK failure, not a dead
// tab. set_todo is a full-replace, so the tray is locally observable: after
// a tagged no-reply we take ONE get_todo read and report applied /
// not-applied, or return the original timeout WITH a mutation receipt when
// the read cannot answer.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

const { buildPanelToolDefs, makePanelToolCtx } = await import("../../orchestrator/panel-tools.js");
import { markReplyTimeout } from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const TAB = "11111111-2222-3333-4444-555555555555";
const OTHER_TAB = "99999999-8888-7777-6666-555555555555";
const DESKTOP = "desktop-tab";
const MOBILE = "mobile-tab";
const MUTATION_RID = "rid-set-todo-2481";

const ITEMS = [
  { text: "load workflow", status: "done" },
  { text: "run refine", status: "active" },
  { text: "save result", status: "pending" },
];

const textOf = (res: ToolResult): string =>
  res.content.map((c) => ("text" in c ? (c.text ?? "") : "")).join(" ");

const ackTimeout = (cmd: string, ms: number): Error =>
  new Error(
    `Panel tab ${TAB} did not reply to "${cmd}" within ${ms} ms — the ComfyUI tab may be ` +
      `backgrounded or frozen. This command MUTATES and was already delivered to the tab, so it ` +
      `may have been applied despite the missing reply — check the current state before ` +
      `re-issuing it; a blind retry can apply it twice`,
  );

let sent: Array<{ cmd: string; tabId?: string; timeoutMs?: number }> = [];

function bridge(opts: {
  setReply?: "timeout" | "acked-error" | "acked-error-timeout-worded" | "ok";
  probeItems?: typeof ITEMS | "timeout" | "other";
  loseTabAfterSet?: boolean;
  headlessRedirect?: boolean;
}) {
  let tabGone = false;
  return {
    send: async (
      cmd: Record<string, unknown>,
      o?: { timeoutMs?: number; tabId?: string; onDispatchedRid?: (rid: string) => void },
    ) => {
      sent.push({
        cmd: String(cmd.cmd),
        tabId: o?.tabId,
        timeoutMs: o?.timeoutMs,
      });
      if (cmd.cmd === "set_todo") {
        if (opts.setReply === "acked-error") {
          throw new Error("Executor refused: footer tray is disabled");
        }
        if (opts.setReply === "acked-error-timeout-worded") {
          throw new Error(
            `Panel tab ${TAB} did not reply to "set_todo" within 15000 ms — the ` +
              `ComfyUI tab may be backgrounded or frozen. Reported by the tray owner: ` +
              `nothing was applied.`,
          );
        }
        if (opts.setReply === "ok" || opts.setReply === undefined) {
          o?.onDispatchedRid?.(MUTATION_RID);
          return { ok: true, count: Array.isArray(cmd.items) ? cmd.items.length : 0 };
        }
        if (opts.loseTabAfterSet) tabGone = true;
        o?.onDispatchedRid?.(MUTATION_RID);
        throw markReplyTimeout(ackTimeout("set_todo", 15000));
      }
      if (cmd.cmd === "get_todo") {
        if (opts.probeItems === "timeout") throw ackTimeout("get_todo", 8000);
        if (opts.probeItems === "other") {
          return { items: [{ text: "stale leftover", status: "pending" }] };
        }
        return { items: opts.probeItems ?? ITEMS };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: (id: string) => {
      if (opts.headlessRedirect) return id === MOBILE || id === DESKTOP;
      if (tabGone) return id === OTHER_TAB;
      return id === TAB;
    },
    isHeadless: (id: string) => (opts.headlessRedirect ? id === MOBILE : false),
    tabs: () => {
      if (opts.headlessRedirect) {
        return [
          { tab_id: MOBILE, title: "phone", connected_at: 0 },
          { tab_id: DESKTOP, title: "wf", connected_at: 0 },
        ];
      }
      return tabGone
        ? [{ tab_id: OTHER_TAB, title: "other", connected_at: 0 }]
        : [{ tab_id: TAB, title: "wf", connected_at: 0 }];
    },
    resolveActiveTabId: () => {
      if (opts.headlessRedirect) return DESKTOP;
      return tabGone ? OTHER_TAB : TAB;
    },
    refreshWorkflowUuid: () => true,
    workflowUuidFor: () => ({ known: false }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as PanelToolCtx["bridge"];
}

async function runSetTodo(
  opts: Parameters<typeof bridge>[0],
  args: Record<string, unknown> = { items: ITEMS },
): Promise<{ text: string; isError: boolean; boundTab: string }> {
  const tab = opts.headlessRedirect ? MOBILE : TAB;
  const ctx = makePanelToolCtx(bridge(opts), tab, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_set_todo");
  if (!def) throw new Error("panel_set_todo is not registered");
  const res: ToolResult = await def.handler(args as never, ctx);
  return { text: textOf(res), isError: res.isError === true, boundTab: ctx.tabId };
}

beforeEach(() => {
  sent = [];
});

describe("an unacknowledged set_todo is settled by a read, not by a guess (#2481)", () => {
  it("reports the write as applied when the tray holds the delivered list", async () => {
    const out = await runSetTodo({ setReply: "timeout", probeItems: ITEMS });

    expect(sent.map((s) => s.cmd)).toEqual(["set_todo", "get_todo"]);
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/CHECKED FOR YOU/);
    expect(out.text).toMatch(/"applied": true/);
    expect(out.text).toMatch(new RegExp(`"mutation_id": "${MUTATION_RID}"`));
    expect(out.text).toMatch(/not evidence the write failed/);
    expect(out.text).not.toMatch(/a blind retry can apply it twice/);
  });

  it("reports the write as NOT applied when the tray holds a different list", async () => {
    const out = await runSetTodo({ setReply: "timeout", probeItems: "other" });

    expect(sent.map((s) => s.cmd)).toEqual(["set_todo", "get_todo"]);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/"applied": false/);
    expect(out.text).toMatch(/does NOT show the list/);
    expect(out.text).toMatch(new RegExp(`"mutation_id": "${MUTATION_RID}"`));
    expect(out.text).toMatch(/full-replace/);
    expect(out.text).toMatch(/stale leftover/);
    expect(out.text).not.toMatch(/a blind retry can apply it twice/);
  });

  it("returns a mutation receipt when the tray read itself cannot answer", async () => {
    const out = await runSetTodo({ setReply: "timeout", probeItems: "timeout" });

    expect(sent.map((s) => s.cmd)).toEqual(["set_todo", "get_todo"]);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/may have been applied despite the missing reply/);
    expect(out.text).toMatch(/"applied": "unknown"/);
    expect(out.text).toMatch(new RegExp(`"mutation_id": "${MUTATION_RID}"`));
    expect(out.text).toMatch(/"requested"/);
    expect(out.text).toMatch(/run refine/);
    expect(out.text).toMatch(/full-replace: re-issuing that exact list cannot duplicate it/);
  });

  it("does not second-guess an ACKED executor error", async () => {
    const out = await runSetTodo({ setReply: "acked-error" });

    expect(sent.map((s) => s.cmd)).not.toContain("get_todo");
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/footer tray is disabled/);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
    expect(out.text).not.toMatch(/mutation_id/);
  });

  it("does not settle an ACKED error reproducing the canonical sentence VERBATIM", async () => {
    const out = await runSetTodo({ setReply: "acked-error-timeout-worded" });

    expect(out.text).toMatch(
      /did not reply to "set_todo" within 15000 ms — the ComfyUI tab may be backgrounded or frozen/,
    );
    expect(sent.map((s) => s.cmd)).not.toContain("get_todo");
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/nothing was applied/);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
  });

  it("claims nothing when the probe lands on a DIFFERENT tab", async () => {
    const out = await runSetTodo({
      setReply: "timeout",
      probeItems: ITEMS,
      loseTabAfterSet: true,
    });

    expect(out.boundTab).toBe(OTHER_TAB);
    expect(sent.some((s) => s.cmd === "get_todo")).toBe(true);
    expect(out.isError).toBe(true);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
    expect(out.text).not.toMatch(/"applied": true/);
    expect(out.text).toMatch(/"applied": "unknown"/);
    expect(out.text).toMatch(new RegExp(`"mutation_id": "${MUTATION_RID}"`));
  });

  it("does not take a tray read on a successful ACK", async () => {
    const out = await runSetTodo({ setReply: "ok" });

    expect(sent.map((s) => s.cmd)).toEqual(["set_todo"]);
    expect(out.isError).toBe(false);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
  });

  it("probes the desktop tab a redirected set_todo was delivered to", async () => {
    const out = await runSetTodo({
      setReply: "timeout",
      probeItems: ITEMS,
      headlessRedirect: true,
    });

    expect(sent.map((s) => s.cmd)).toEqual(["set_todo", "get_todo"]);
    expect(sent[0]?.tabId).toBe(DESKTOP);
    expect(sent[1]?.tabId).toBe(DESKTOP);
    expect(out.boundTab).toBe(MOBILE);
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/"applied": true/);
  });
});

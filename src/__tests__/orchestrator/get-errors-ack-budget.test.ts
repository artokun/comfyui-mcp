// #1493 — `panel_get_errors` timed out at 20 000 ms on a tab that was alive.
//
// Reported sequence: `panel_refresh_nodes`, three `panel_set_widget` writes on promoted
// COMBO widgets of a model-loader subgraph, `panel_save_workflow` — every one acked — and
// then `panel_get_errors` came back as
//
//   Panel tab workflows/… did not reply to "graph_get_errors" within 20000 ms —
//   the ComfyUI tab may be backgrounded or frozen
//
// The tab was neither backgrounded nor frozen. It had just answered four commands, and
// `graph_get_errors` is the panel command that deliberately spends the LONGEST wall clock:
// its handler awaits a FORCED /object_info re-register before it will trust a combo to
// clear a resolved missing-model candidate (#610, measured at ~14.5 s on a real Windows
// install), and it spends a shared 18 000 ms elective budget across that refresh race, the
// /system_stats probe and the /view media probes (GET_ERRORS_TOTAL_BUDGET_MS in the panel's
// web/js/lib/get-errors-budget.js).
//
// That 18 000 ms was sized against the orchestrator's generic 20 000 ms read default, which
// leaves 2 000 ms for everything the call still does AFTER its waits — collectMissingAssets
// over the whole graph, the per-node live combo scan, the subgraph walk, and serializing a
// reply large enough that the tool ships two truncation riders for it. On the reporter's
// workflow that margin was not enough, so the panel replied LATE and the orchestrator had
// already given up — leaving the agent with no error surface at all for a workflow whose
// nodes are visibly red, which is exactly what the shared budget exists to prevent (#589).
//
// The margin has to come from the ORCHESTRATOR. The panel's 18 s bound must stay where it
// is: it is what keeps a current panel safe in front of an older orchestrator still using
// the 20 s default. So `graph_get_errors` joins the #599 refresh-ack cohort — the same
// bounded 30 s budget `graph_set_widget`, `graph_add_node`, `graph_remove_widget`,
// `graph_get_object_info` and `refresh_nodes` already forward for the same reason.
//
// The property under test is the CALL SITE. A shared constant that nothing passes still
// greps, and a one-argument wiring change is invisible to any test that only exercises the
// bridge — so these run the real tool def and read the bound it actually forwarded.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildPanelToolDefs, type PanelToolCtx } from "../../orchestrator/panel-tools.js";
import { BRIDGE_READ_DEFAULT_TIMEOUT_MS } from "../../services/ui-bridge.js";

const PANEL_TOOLS_TS = fileURLToPath(new URL("../../orchestrator/panel-tools.ts", import.meta.url));

/** The #599 bounded refresh-ack budget (OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS). Duplicated as
 *  a literal on purpose: if the constant moves, these tests force the relationship to the
 *  panel's own budget to be re-examined rather than silently re-broken. */
const REFRESH_ACK_MS = 30_000;

/** GET_ERRORS_TOTAL_BUDGET_MS in the PANEL repo (web/js/lib/get-errors-budget.js) — the
 *  wall clock one graph_get_errors call may spend on elective server waits alone, before
 *  any of its own graph work. The orchestrator's wait must clear this with real margin.
 *  Duplicated across repos deliberately, exactly as the panel duplicates the 20 000 ms
 *  read default in its own budget test. */
const PANEL_GET_ERRORS_ELECTIVE_BUDGET_MS = 18_000;

/** Run a real panel tool def against a stub ctx and hand back the per-call ack bound it
 *  forwarded as `ctx.call`'s second argument. `undefined` means the tool passed none and
 *  the bridge would fall back to its own default — which is the bug. */
async function forwardedAckMs(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<{ cmd: Record<string, unknown> | undefined; timeoutMs: number | undefined }> {
  const def = buildPanelToolDefs().find((d) => d.name === tool);
  if (!def) throw new Error(`tool ${tool} not found in buildPanelToolDefs()`);
  let seenCmd: Record<string, unknown> | undefined;
  let seenTimeout: number | undefined;
  const ctx = {
    call: async (cmd: Record<string, unknown>, timeoutMs?: number) => {
      seenCmd = cmd;
      seenTimeout = timeoutMs;
      return { content: [{ type: "text", text: JSON.stringify(cmd) }] };
    },
    tabId: "test-tab",
  } as unknown as PanelToolCtx;
  await def.handler(args, ctx);
  return { cmd: seenCmd, timeoutMs: seenTimeout };
}

describe("panel_get_errors ack budget (#1493)", () => {
  it("forwards graph_get_errors with the bounded refresh-ack budget, not the 20 s read default", async () => {
    const { cmd, timeoutMs } = await forwardedAckMs("panel_get_errors");
    expect(cmd).toMatchObject({ cmd: "graph_get_errors" });
    expect(timeoutMs).toBe(REFRESH_ACK_MS);
    // The regression this closes: no bound at all, so the bridge applied its generic
    // read default. Named separately so a revert reads as the reported bug, not as an
    // off-by-one in the constant.
    expect(timeoutMs).not.toBeUndefined();
    expect(timeoutMs).toBeGreaterThan(BRIDGE_READ_DEFAULT_TIMEOUT_MS);
  });

  it("clears the panel's own elective budget with real margin, not the 2 s that failed", async () => {
    const { timeoutMs } = await forwardedAckMs("panel_get_errors");
    // The panel can legitimately spend its whole 18 000 ms budget waiting on the server
    // before it starts the graph work whose reply this bound is waiting for. The old
    // default left 2 000 ms for that work plus delivery; the reporter's workflow needed
    // more. Require the orchestrator to leave at least half the panel's budget again.
    expect(timeoutMs!).toBeGreaterThanOrEqual(
      PANEL_GET_ERRORS_ELECTIVE_BUDGET_MS + PANEL_GET_ERRORS_ELECTIVE_BUDGET_MS / 2,
    );
  });

  it("stays BOUNDED, so a genuinely frozen tab still fails", async () => {
    const { timeoutMs } = await forwardedAckMs("panel_get_errors");
    expect(Number.isFinite(timeoutMs!)).toBe(true);
    expect(timeoutMs!).toBeLessThanOrEqual(60_000);
  });

  it("uses the SAME bound as the #599 siblings, so the cohort cannot drift apart", async () => {
    // Read from the real defs rather than from the literal: if the shared constant is
    // ever re-tuned, every member moves together or this fails.
    const errors = await forwardedAckMs("panel_get_errors");
    const refresh = await forwardedAckMs("panel_refresh_nodes");
    const setWidget = await forwardedAckMs("panel_set_widget", {
      node_id: 39,
      widget: "ckpt_name",
      value: "sd_xl_base_1.0.safetensors",
    });
    expect(refresh.cmd).toMatchObject({ cmd: "refresh_nodes" });
    expect(setWidget.cmd).toMatchObject({ cmd: "graph_set_widget" });
    expect(errors.timeoutMs).toBe(refresh.timeoutMs);
    expect(errors.timeoutMs).toBe(setWidget.timeoutMs);
  });

  it("leaves no OTHER graph_get_errors dispatch on the default (a second call site is a third path)", () => {
    // A behavioural test can only see the call site it exercises. Counting occurrences
    // cannot see a call site added later on a different branch, so pin the SOURCE: every
    // graph_get_errors dispatch in the file must carry the refresh-ack constant.
    const src = readFileSync(PANEL_TOOLS_TS, "utf8");
    const dispatches = [...src.matchAll(/cmd:\s*"graph_get_errors"[^\n]*/g)].map((m) => m[0]);
    expect(dispatches.length).toBeGreaterThan(0);
    for (const line of dispatches) {
      expect(
        line,
        `a graph_get_errors dispatch is missing OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS: ${line}`,
      ).toContain("OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS");
    }
  });
});

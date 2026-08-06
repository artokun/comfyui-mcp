// #689 — a pin written during a pending update-all / snapshot-restore window
// must CANCEL the queued panel-affecting work, not just warn about it.
//
// These tests drive the REAL install_comfyui(action:'panel', panel_action:'pin') tool handler with a
// stubbed ComfyUI-Manager and a real temp-dir marker/lock/settings file, and
// assert the four honesty cases:
//   1. proven cancel      → resetQueue called ON THE MARKER'S SERVER, pending
//                           counts named before/after, marker cleared;
//   2. reset failure /    → marker KEPT and today's warning preserved;
//      unverifiable state
//   3. in-flight work     → "cannot cancel", never "saved";
//   4. no markers         → no Manager calls at all.
// Snapshot restores cancel by deleting Manager's deferred-restore file (local
// only); remote reports "cannot cancel — remote host" truthfully.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The marker records the server the op was queued on; the cancel must target
// THAT server even after the orchestrator is retargeted (#689).
const ORIG = "http://orig:8188";
let currentBase = ORIG;

vi.mock("../../config.js", () => {
  const config = {
    comfyuiPath: undefined as string | undefined,
    resolvedPort: 8188,
    comfyuiHost: "127.0.0.1",
    comfyuiSsl: false,
    githubToken: undefined as string | undefined,
  };
  return {
    config,
    isLocalMode: () => true,
    isRemoteMode: () => false,
    getComfyUIBaseUrl: () => currentBase,
    getComfyUIAuthHeaders: () => ({}),
  };
});

// Any Manager traffic is recorded and answered by the per-test persona.
const managerCalls: Array<{ url: string; method: string }> = [];
let managerHandler: (url: string, init?: RequestInit) => Response = () =>
  new Response("not found", { status: 404 });

vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    managerCalls.push({ url, method: init?.method ?? "GET" });
    return managerHandler(url, init);
  }),
}));

import { config } from "../../config.js";
import {
  activePanelPendingOps,
  recordPanelPendingOp,
  SNAPSHOT_RESTORE_PENDING_MS,
  UPDATE_ALL_PENDING_MS,
} from "../../services/panel-pin-guard.js";
import { getPanelPinState, PANEL_PIN_ENV_VAR } from "../../services/panel-settings.js";
import {
  fetchManagerQueueCounts,
  fetchManagerTaskHistoryEntry,
  resetManagerApiCacheForTests,
} from "../../services/node-management.js";
import { updateAllCustomNodes } from "../../services/update-comfyui.js";
import { restoreNodeSnapshot } from "../../services/node-snapshots.js";
import { panelAction } from "../../tools/install-panel.js";

let dir: string;

beforeEach(() => {
  managerCalls.length = 0;
  managerHandler = () => new Response("not found", { status: 404 });
  currentBase = ORIG;
  resetManagerApiCacheForTests();
  dir = mkdtempSync(join(tmpdir(), "cmcp-pincancel-"));
  process.env.COMFYUI_MCP_PANEL_SETTINGS = join(dir, "panel-settings.json");
  process.env.COMFYUI_MCP_PANEL_LOCK = join(dir, "panel-op.lock");
  process.env.COMFYUI_MCP_PANEL_PENDING = join(dir, "panel-pending-ops.json");
  config.comfyuiPath = undefined;
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_PANEL_SETTINGS;
  delete process.env.COMFYUI_MCP_PANEL_LOCK;
  delete process.env.COMFYUI_MCP_PANEL_PENDING;
  delete process.env[PANEL_PIN_ENV_VAR];
  config.comfyuiPath = undefined;
  resetManagerApiCacheForTests();
  rmSync(dir, { recursive: true, force: true });
});

// ── The pin path, driven directly ───────────────────────────────────────────
// 0.50.0 slice 13 folded the panel tool into
// install_comfyui (action:"panel", panel_action:"pin"), so the unit under test
// is the exported action handler rather than a captured server.tool
// registration. Same body, same locking, same JSON.

async function writePin(): Promise<Record<string, unknown>> {
  const result = await panelAction("pin", "0.11.3", undefined);
  expect(result.isError ?? false).toBe(false);
  const first = result.content[0] as { text?: string };
  return JSON.parse(first.text ?? "{}") as Record<string, unknown>;
}

// ── Stub Manager personas ────────────────────────────────────────────────────

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface QueueState {
  pending: number;
  inProgress: number;
  done: number;
}

interface V4PersonaOpts {
  resetFails?: boolean;
  /** Completed task ui_ids the Manager reports in its queue history. */
  history?: Set<string>;
  /** Override the history response entirely (e.g. a mismatched ui_id). */
  historyResponder?: (uiId: string) => unknown;
  /** Counts for THIS orchestrator (the client_id=comfyui-mcp filter).
   *  Defaults to the shared state object. */
  mine?: QueueState;
  /** Race injection run when the reset lands (e.g. dequeue a task first). */
  onReset?: () => void;
  /** After a reset fires, the client-filtered status 404s (post-reset state
   *  unreadable). */
  clientStatusFailsAfterReset?: boolean;
}

/**
 * A Manager v4 host whose queue state the test controls: shared counts,
 * client-filtered counts (?client_id=comfyui-mcp), a queue-history lookup
 * (?ui_id=), and a reset that wipes PENDING only (running survives).
 */
function v4Persona(state: QueueState, opts: V4PersonaOpts = {}) {
  const mine = opts.mine ?? state;
  const history = opts.history ?? new Set<string>();
  let resetDone = false;
  managerHandler = (url, init) => {
    const u = new URL(url);
    const path = u.pathname;
    const method = init?.method ?? "GET";
    if (path === "/v2/manager/queue/status" && method === "GET") {
      const isMine = u.searchParams.get("client_id") === "comfyui-mcp";
      if (isMine && resetDone && opts.clientStatusFailsAfterReset) {
        return new Response("gone", { status: 404 });
      }
      const s = isMine ? mine : state;
      return jsonRes({
        total_count: s.done + s.inProgress + s.pending,
        done_count: s.done,
        in_progress_count: s.inProgress,
        pending_count: s.pending,
        is_processing: s.inProgress > 0,
      });
    }
    if (path === "/v2/manager/queue/history" && method === "GET") {
      const uiId = u.searchParams.get("ui_id") ?? "";
      if (opts.historyResponder) return jsonRes(opts.historyResponder(uiId));
      return history.has(uiId)
        ? jsonRes({ history: { ui_id: uiId, kind: "update", result: "done" } })
        : jsonRes({ history: {} });
    }
    if (path === "/v2/manager/queue/reset" && method === "POST") {
      if (opts.resetFails) return new Response("boom", { status: 500 });
      resetDone = true;
      state.pending = 0; // wipe_queue() clears PENDING only — running survives
      mine.pending = 0;
      opts.onReset?.();
      return new Response("", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

/** A legacy 3.x host: no /v2 surface, no pending_count — the arithmetic path. */
function legacyPersona(state: QueueState) {
  managerHandler = (url, init) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    if (path === "/manager/queue/status" && method === "GET") {
      return jsonRes({
        total_count: state.done + state.inProgress + state.pending,
        done_count: state.done,
        in_progress_count: state.inProgress,
        is_processing: state.inProgress > 0,
      });
    }
    if (path === "/manager/version" && method === "GET") {
      return new Response("V3.41", { status: 200 });
    }
    if (path === "/manager/queue/reset" && method === "POST") {
      state.pending = 0;
      return new Response("", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

function recordUpdateAllMarker(extra: { base?: string; uiId?: string } = { base: ORIG }) {
  return recordPanelPendingOp(
    "update-all",
    "an update-all request may have been handed to ComfyUI-Manager",
    UPDATE_ALL_PENDING_MS,
    extra,
  );
}

interface CancellationReport {
  kind: string;
  outcome: string;
  markerCleared: boolean;
  pendingBefore?: number;
  pendingAfter?: number;
  inProgress?: number;
  detail: string;
}

function cancelReports(report: Record<string, unknown>): CancellationReport[] {
  return (report.pendingOpCancellations ?? []) as CancellationReport[];
}

const resetPosts = () =>
  managerCalls.filter((c) => c.method === "POST" && c.url.includes("/manager/queue/reset"));

const clientStatusGets = () => managerCalls.filter((c) => c.url.includes("client_id=comfyui-mcp"));

const historyGets = () => managerCalls.filter((c) => c.url.includes("/manager/queue/history"));

describe("pin write cancels a pending update-all (#689)", () => {
  it("proven cancel (v4 + ui_id): resets ON THE MARKER'S SERVER after proving our tasks pending, names the counts, clears the marker", async () => {
    recordUpdateAllMarker({ base: ORIG, uiId: "ui-1" });
    // Shared queue has OTHER clients' work too — the report must name it.
    v4Persona({ pending: 5, inProgress: 0, done: 3 }, { mine: { pending: 2, inProgress: 0, done: 1 } });
    // Retarget AFTER the marker was recorded: everything must still hit ORIG.
    currentBase = "http://new:8188";

    const report = await writePin();

    // The pin itself always lands.
    expect(report.outcome).toBe("active");
    expect(getPanelPinState().pinned).toBe(true);

    // Every Manager call went to the marker's server — none to the new target.
    expect(managerCalls.length).toBeGreaterThan(0);
    expect(managerCalls.every((c) => c.url.startsWith(ORIG))).toBe(true);
    // Proof came first: the panel's per-pack task ids were checked against the
    // queue history, and OUR tasks were counted via the client filter — only
    // then the reset.
    expect(historyGets().some((c) => c.url.includes("ui_id=ui-1_comfyui-agent-panel"))).toBe(true);
    expect(historyGets().some((c) => c.url.includes("ui_id=ui-1_comfyui-mcp-panel"))).toBe(true);
    expect(clientStatusGets()).toHaveLength(1);
    expect(resetPosts()).toEqual([]);

    // The report names OUR dropped count AND the shared blast radius — never "saved".
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.pendingBefore).toBe(2);
    expect(cancel.inProgress).toBe(0);
    expect(cancel.detail).toMatch(/queue-wide reset/);
    expect(cancel.detail).toMatch(/NOTHING was sent/);

    // Marker provably cleared; no residue warning in the note.
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(report.pendingPanelOps).toHaveLength(1);
    expect(report.note as string).toMatch(/WARNING — a panel-affecting operation/);
    expect(report.note as string).toMatch(/Pending-op handling:/);
  });

  it("shared pending from OTHER clients never triggers a reset — nothing of ours ⇒ already-drained", async () => {
    // THE finding-1 case: our update-all already drained; only unrelated
    // tasks are pending. A reset would clear THOSE (collateral) while
    // claiming the panel was saved.
    recordUpdateAllMarker({ base: ORIG, uiId: "ui-2" });
    v4Persona({ pending: 5, inProgress: 1, done: 3 }, { mine: { pending: 0, inProgress: 0, done: 1 } });

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0); // no collateral damage
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("already-drained");
    expect(cancel.markerCleared).toBe(true);
    expect(cancel.detail).toMatch(/not pending, not running, and not in the Manager's/);
    expect(activePanelPendingOps()).toEqual([]);
  });

  it("panel's task in the v4 queue history ⇒ already RAN — already-drained, NO reset", async () => {
    recordUpdateAllMarker({ base: ORIG, uiId: "ui-9" });
    v4Persona(
      { pending: 4, inProgress: 0, done: 3 },
      { mine: { pending: 2, inProgress: 0, done: 1 }, history: new Set(["ui-9_comfyui-agent-panel"]) },
    );

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("already-drained");
    expect(cancel.markerCleared).toBe(true);
    expect(cancel.detail).toMatch(/queue history/);
    expect(cancel.detail).toMatch(/already RAN/);
    expect(cancel.detail).toMatch(/may ALREADY have been moved/);
    expect(activePanelPendingOps()).toEqual([]);
  });

  it("v4 marker WITHOUT a ui_id: our pending work is ambiguous — NO reset, could-not-verify", async () => {
    recordUpdateAllMarker({ base: ORIG }); // has base, no uiId
    v4Persona({ pending: 3, inProgress: 0, done: 1 }, { mine: { pending: 2, inProgress: 0, done: 1 } });

    const report = await writePin();

    expect(clientStatusGets().length).toBe(1); // it looked…
    expect(resetPosts()).toHaveLength(0); // …but could not prove, so no blind reset
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/recorded no ui_id/);
    expect(cancel.detail).toMatch(/NO reset was sent/);
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(report.note as string).toMatch(/WARNING/);
  });

  it("v4 marker without a ui_id, nothing of ours in flight: already-drained", async () => {
    recordUpdateAllMarker({ base: ORIG });
    v4Persona({ pending: 4, inProgress: 0, done: 1 }, { mine: { pending: 0, inProgress: 0, done: 1 } });

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("already-drained");
    expect(cancel.markerCleared).toBe(true);
    expect(activePanelPendingOps()).toEqual([]);
  });

  it("base-less marker: NO blind reset even with pending work on the current target — UNVERIFIED, marker kept", async () => {
    recordUpdateAllMarker({}); // no base captured (older marker shape)
    v4Persona({ pending: 1, inProgress: 0, done: 0 });

    const report = await writePin();

    // Round 3: a reset here could wipe an innocent server's queue, so none is
    // sent at all — the outcome can never be proven from the wrong server.
    expect(resetPosts()).toHaveLength(0);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/recorded NO server/);
    expect(cancel.detail).toMatch(/NO reset was sent/);
    expect(cancel.detail).not.toMatch(/cancelled the queued update-all|best-effort/);
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(report.pendingPanelOps).toHaveLength(1);
    expect(report.note as string).toMatch(/WARNING — a panel-affecting operation is still pending/);
  });

  it("base-less marker with an idle current target: NO reset sent, still unverified, marker kept", async () => {
    recordUpdateAllMarker({});
    v4Persona({ pending: 0, inProgress: 0, done: 3 });

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/recorded NO server/);
    expect(cancel.detail).toMatch(/proves NOTHING/);
    expect(activePanelPendingOps()).toHaveLength(1);
  });

  it("reset failure: marker KEPT, warning preserved, nothing claimed", async () => {
    recordUpdateAllMarker({ base: ORIG, uiId: "ui-3" });
    v4Persona({ pending: 2, inProgress: 0, done: 3 }, { resetFails: true });

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/queue-wide reset/);
    // The marker and today's warning survive.
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(report.pendingPanelOps).toHaveLength(1);
    expect(report.note as string).toMatch(/WARNING — a panel-affecting operation is still pending/);
    expect(report.note as string).not.toMatch(/cancelled the queued update-all/);
  });

  it("unverifiable pre-reset state: NOTHING is sent, marker KEPT", async () => {
    recordUpdateAllMarker();
    managerHandler = () => new Response("not found", { status: 404 }); // Manager gone

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0); // fail closed — no blind reset
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(cancel.detail).toMatch(/NOTHING was sent/);
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(report.note as string).toMatch(/WARNING/);
  });

  it("in-flight detected FIRST: our work running AND pending — already-running, NO reset sent", async () => {
    // Round-4 finding: pending > 0 must not fall through to the reset path
    // while a task of ours is in flight.
    recordUpdateAllMarker({ base: ORIG, uiId: "ui-r1" });
    v4Persona({ pending: 2, inProgress: 1, done: 1 }, { mine: { pending: 2, inProgress: 1, done: 1 } });

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("already-running");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.pendingBefore).toBe(2);
    expect(cancel.inProgress).toBe(1);
    expect(cancel.detail).toMatch(/cannot cancel/i);
    expect(cancel.detail).toMatch(/RUNNING/);
    expect(activePanelPendingOps()).toHaveLength(1);
  });

  it("v4 marker without a ui_id, our work running AND pending: already-running — NO reset", async () => {
    recordUpdateAllMarker({ base: ORIG }); // no uiId
    v4Persona({ pending: 2, inProgress: 1, done: 1 }, { mine: { pending: 2, inProgress: 1, done: 1 } });

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("already-running");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.inProgress).toBe(1);
    expect(activePanelPendingOps()).toHaveLength(1);
  });

  it("in-flight (already dequeued): cannot cancel, NO reset sent, never 'saved'", async () => {
    recordUpdateAllMarker({ base: ORIG, uiId: "ui-4" });
    v4Persona({ pending: 0, inProgress: 1, done: 3 }, { mine: { pending: 0, inProgress: 1, done: 1 } });

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0); // pointless — reset only drops pending
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("already-running");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.inProgress).toBe(1);
    expect(cancel.detail).toMatch(/cannot cancel/i);
    expect(cancel.detail).toMatch(/RUNNING/);
    expect(cancel.detail).not.toMatch(/dropped|cancelled the queued/);
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(report.note as string).toMatch(/WARNING — a panel-affecting operation is still pending/);
  });

  it("a possible concurrent refill never triggers a queue-wide reset", async () => {
    recordUpdateAllMarker({ base: ORIG, uiId: "ui-5b" });
    const mine: QueueState = { pending: 2, inProgress: 0, done: 1 };
    v4Persona(
      { pending: 2, inProgress: 0, done: 3 },
      {
        mine,
        onReset: () => {
          mine.inProgress = 1; // a task dequeued mid-reset…
          mine.pending = 3; // …and a concurrent enqueue added MORE than was dropped
        },
      },
    );

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.pendingBefore).toBe(2);
    // mineAfter.pending > mine.pending: a "dropped" count would be zero or
    // negative, i.e. fabricated. The report names the movement and stops there.
    expect(cancel.detail).toMatch(/NOTHING was sent/);
    expect(activePanelPendingOps()).toHaveLength(1);
  });

  it("a possible partial drain is not claimed because no reset is sent", async () => {    recordUpdateAllMarker({ base: ORIG, uiId: "ui-5" });
    const mine: QueueState = { pending: 2, inProgress: 0, done: 1 };
    v4Persona(
      { pending: 2, inProgress: 0, done: 3 },
      {
        mine,
        onReset: () => {
          mine.inProgress = 1; // a task was dequeued mid-reset…
          mine.pending = 1; // …and a concurrent enqueue re-filled one slot
        },
      },
    );

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.pendingBefore).toBe(2);
    // 2 → 1 is a drop of ONE: the report must not claim both were dropped.
    expect(cancel.detail).toMatch(/NOTHING was sent/);
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(report.note as string).toMatch(/WARNING/);
  });

  it("post-reset state is never needed because no reset is sent", async () => {
    recordUpdateAllMarker({ base: ORIG, uiId: "ui-8" });
    v4Persona({ pending: 2, inProgress: 0, done: 1 }, { clientStatusFailsAfterReset: true });

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/NOTHING was sent/);
    expect(activePanelPendingOps()).toHaveLength(1);
  });

  it("a history entry with a DIFFERENT ui_id proves nothing — could-not-verify, marker kept", async () => {
    recordUpdateAllMarker({ base: ORIG, uiId: "ui-x" });
    v4Persona(
      { pending: 0, inProgress: 0, done: 1 },
      {
        // A proxy/variant answering with somebody else's history entry.
        historyResponder: () => ({
          history: { ui_id: "someone-elses-task", kind: "update", result: "done" },
        }),
      },
    );

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/queue history on .* could not be read/);
    expect(activePanelPendingOps()).toHaveLength(1);
  });

  it("already drained (no trace of the panel's task): marker cleared, truthfully not a cancel — and says the panel may ALREADY have moved", async () => {
    recordUpdateAllMarker({ base: ORIG, uiId: "ui-6" });
    v4Persona({ pending: 0, inProgress: 0, done: 3 });

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("already-drained");
    expect(cancel.markerCleared).toBe(true);
    expect(cancel.detail).toMatch(/NOTHING left to cancel/);
    // Finding 4: "already finished" alone is not enough — the report must
    // name the possibility that the update already landed.
    expect(cancel.detail).toMatch(/may ALREADY have been moved/);
    expect(cancel.detail).toMatch(/install_comfyui\(action:'panel', panel_action:'status'\)/);
    expect(cancel.detail).not.toMatch(/cancelled the queued|dropped \d/);
    expect(activePanelPendingOps()).toEqual([]);
  });

  it("legacy 3.x: pending work can never be attributed — NO blind reset, could-not-verify", async () => {
    recordUpdateAllMarker({ base: ORIG, uiId: "ui-7" }); // uiId is useless on 3.x
    legacyPersona({ pending: 2, inProgress: 0, done: 2 });

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0); // 3.x has no task history — never reset
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.pendingBefore).toBe(2); // still measured via total−done−in_progress
    expect(cancel.detail).toMatch(/no task history/);
    expect(cancel.detail).toMatch(/NO reset was sent/);
    expect(activePanelPendingOps()).toHaveLength(1);
  });

  it("legacy 3.x, empty and idle: already-drained via the arithmetic counts", async () => {
    recordUpdateAllMarker({ base: ORIG });
    legacyPersona({ pending: 0, inProgress: 0, done: 3 });

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("already-drained");
    expect(cancel.markerCleared).toBe(true);
    expect(activePanelPendingOps()).toEqual([]);
  });

  it("incoherent 3.x counts (the #639 stale signature) read as could-not-verify", async () => {
    recordUpdateAllMarker();
    // total < done + in_progress: the stale-3.x no-op shape. Nothing may be
    // concluded from it — and a blind reset must NOT be sent on it either.
    managerHandler = (url, init) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      if (path === "/manager/queue/status" && method === "GET") {
        return jsonRes({ total_count: 0, done_count: 2, in_progress_count: 0, is_processing: false });
      }
      if (path === "/manager/version" && method === "GET") return new Response("V3.41", { status: 200 });
      return new Response("not found", { status: 404 });
    };

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(activePanelPendingOps()).toHaveLength(1);
  });
});

describe("pin write cancels a deferred snapshot restore (#689)", () => {
  function recordSnapshotMarker() {
    return recordPanelPendingOp(
      "snapshot-restore",
      'a snapshot restore ("prod") may have been requested',
      SNAPSHOT_RESTORE_PENDING_MS,
      { base: ORIG },
    );
  }

  it("local: deletes restore-snapshot.json from the live Manager files dir, clears the marker, no Manager calls", async () => {
    const comfyRoot = join(dir, "ComfyUI");
    config.comfyuiPath = comfyRoot;
    const restoreFile = join(
      comfyRoot,
      "user",
      "__manager",
      "startup-scripts",
      "restore-snapshot.json",
    );
    mkdirSync(dirname(restoreFile), { recursive: true });
    writeFileSync(restoreFile, "{}");
    recordSnapshotMarker();

    const report = await writePin();

    expect(existsSync(restoreFile)).toBe(true);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("cannot-cancel");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/no operation identity/);
    expect(activePanelPendingOps()).toHaveLength(1);
    // The cancel is filesystem-local — the Manager was never contacted.
    expect(managerCalls).toEqual([]);
  });

  it("local, no restore file: already applied or never scheduled — marker cleared, truthfully not a cancel", async () => {
    config.comfyuiPath = join(dir, "ComfyUI"); // nothing scheduled
    recordSnapshotMarker();

    const report = await writePin();

    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("cannot-cancel");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/no operation identity/);
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(managerCalls).toEqual([]);
  });

  it("remote: truthful 'cannot cancel — remote host', marker KEPT, no Manager calls", async () => {
    config.comfyuiPath = undefined; // remote mode — the file lives on the host
    recordSnapshotMarker();

    const report = await writePin();

    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("cannot-cancel");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/no operation identity/);
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(report.pendingPanelOps).toHaveLength(1);
    expect(report.note as string).toMatch(/WARNING — a panel-affecting operation is still pending/);
    expect(managerCalls).toEqual([]);
  });

  it("marker recorded for a DIFFERENT server (remote→local retarget): cannot cancel from here, local file UNTOUCHED, marker kept", async () => {
    const comfyRoot = join(dir, "ComfyUI");
    config.comfyuiPath = comfyRoot;
    const restoreFile = join(
      comfyRoot,
      "user",
      "__manager",
      "startup-scripts",
      "restore-snapshot.json",
    );
    mkdirSync(dirname(restoreFile), { recursive: true });
    writeFileSync(restoreFile, "{}");
    // The restore was requested against a remote host; the orchestrator was
    // then retargeted to this local install. Local evidence must never clear
    // the remote marker.
    recordPanelPendingOp(
      "snapshot-restore",
      'a snapshot restore ("prod") may have been requested',
      SNAPSHOT_RESTORE_PENDING_MS,
      { base: "http://other:8188" },
    );

    const report = await writePin();

    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("cannot-cancel");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/cannot cancel from here/);
    expect(cancel.detail).toContain("http://other:8188");
    // The local file is NOT touched — deleting it would prove nothing about
    // the remote host (and could cancel an unrelated LOCAL restore).
    expect(existsSync(restoreFile)).toBe(true);
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(report.pendingPanelOps).toHaveLength(1);
    expect(report.note as string).toMatch(/WARNING/);
    expect(managerCalls).toEqual([]);
  });

  it("base-less restore marker with a local restore file: best-effort delete, but UNVERIFIED — marker kept", async () => {
    const comfyRoot = join(dir, "ComfyUI");
    config.comfyuiPath = comfyRoot;
    const restoreFile = join(
      comfyRoot,
      "user",
      "__manager",
      "startup-scripts",
      "restore-snapshot.json",
    );
    mkdirSync(dirname(restoreFile), { recursive: true });
    writeFileSync(restoreFile, "{}");
    recordPanelPendingOp(
      "snapshot-restore",
      'a snapshot restore ("prod") may have been requested',
      SNAPSHOT_RESTORE_PENDING_MS,
    ); // no base — older marker shape

    const report = await writePin();

    // The local file WILL run at the next local restart, so deleting it is
    // protective — but it proves nothing about which host the marker is for.
    expect(existsSync(restoreFile)).toBe(true);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("cannot-cancel");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/no operation identity/);
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(managerCalls).toEqual([]);
  });

  it("base-less restore marker with NO local restore file: not provably drained — marker kept", async () => {
    config.comfyuiPath = join(dir, "ComfyUI"); // nothing scheduled locally
    recordPanelPendingOp(
      "snapshot-restore",
      'a snapshot restore ("prod") may have been requested',
      SNAPSHOT_RESTORE_PENDING_MS,
    ); // no base

    const report = await writePin();

    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("cannot-cancel");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/no operation identity/);
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(managerCalls).toEqual([]);
  });
});

describe("the snapshot restore marker follows the POST's actual target (#689 round 3)", () => {
  it("a mid-call retarget cannot split the marker and the restore POST across servers", async () => {
    managerHandler = (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/snapshot/restore" && init?.method === "POST") {
        // Retarget DURING the call: anything resolving the base afterwards
        // would get the new server — but the POST and its marker were pinned
        // to the target captured at the start of the operation.
        currentBase = "http://new:8188";
        return new Response("", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const result = await restoreNodeSnapshot("prod");

    expect(result.message).toMatch(/requested/i);
    // The POST went to the target pinned at the start…
    const posts = managerCalls.filter((c) => c.url.includes("/snapshot/restore"));
    expect(posts.map((c) => c.url)).toEqual([`${ORIG}/snapshot/restore`]);
    // …and the marker names THAT server, not the new one.
    const ops = activePanelPendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].base).toBe(ORIG);
  });
});

describe("pin write with no pending markers", () => {
  it("makes NO Manager calls at all", async () => {
    const report = await writePin();

    expect(report.outcome).toBe("active");
    expect(report.pendingPanelOps).toBeUndefined();
    expect(report.pendingOpCancellations).toBeUndefined();
    expect(managerCalls).toEqual([]);
  });
});

describe("the update-all marker captures base + ui_id at enqueue (#689)", () => {
  it("records the server it queued on and the ui_id of the attempt that landed", async () => {
    let enqueuedUiId: string | undefined;
    managerHandler = (url, init) => {
      const u = new URL(url);
      const method = init?.method ?? "GET";
      if (u.pathname === "/v2/manager/queue/status" && method === "GET") {
        return jsonRes({
          total_count: 0,
          done_count: 0,
          in_progress_count: 0,
          pending_count: 0,
          is_processing: false,
        });
      }
      if (u.pathname === "/v2/manager/queue/update_all" && method === "POST") {
        enqueuedUiId = u.searchParams.get("ui_id") ?? undefined;
        return jsonRes({});
      }
      if (u.pathname === "/v2/manager/queue/start" && method === "POST") {
        return new Response("", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    await updateAllCustomNodes();

    expect(enqueuedUiId).toBeTruthy();
    const ops = activePanelPendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("update-all");
    expect(ops[0].base).toBe(ORIG);
    expect(ops[0].uiId).toBe(enqueuedUiId);
  });

  it("the marker is BASE-UNKNOWN until the enqueue proves the target — no stale base can survive (#689 round 3)", async () => {
    let markerDuringEnqueue: { ops: Array<{ base?: string; uiId?: string }> } | undefined;
    managerHandler = (url, init) => {
      const u = new URL(url);
      const method = init?.method ?? "GET";
      if (u.pathname === "/v2/manager/queue/status" && method === "GET") {
        return jsonRes({
          total_count: 0,
          done_count: 0,
          in_progress_count: 0,
          pending_count: 0,
          is_processing: false,
        });
      }
      if (u.pathname === "/v2/manager/queue/update_all" && method === "POST") {
        // What the marker on disk says DURING the enqueue: it must not name a
        // server yet — a retarget before this point could have made it stale.
        markerDuringEnqueue = JSON.parse(
          readFileSync(process.env.COMFYUI_MCP_PANEL_PENDING as string, "utf-8"),
        ) as typeof markerDuringEnqueue;
        return jsonRes({});
      }
      if (u.pathname === "/v2/manager/queue/start" && method === "POST") {
        return new Response("", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    await updateAllCustomNodes();

    expect(markerDuringEnqueue?.ops).toHaveLength(1);
    expect(markerDuringEnqueue?.ops[0].base).toBeUndefined();
    expect(markerDuringEnqueue?.ops[0].uiId).toBeUndefined();
    // …and after the enqueue it is enriched with the proven base + ui_id
    // (asserted by the previous test).
  });

  it("enrichment failure never leaves a stale base — the marker reads as unverifiable (#689 round 3)", async () => {
    managerHandler = (url, init) => {
      const u = new URL(url);
      const method = init?.method ?? "GET";
      if (u.pathname === "/v2/manager/queue/status" && method === "GET") {
        return jsonRes({
          total_count: 0,
          done_count: 0,
          in_progress_count: 0,
          pending_count: 0,
          is_processing: false,
        });
      }
      if (u.pathname === "/v2/manager/queue/update_all" && method === "POST") {
        // Break the marker store between the initial record and the enrichment.
        writeFileSync(process.env.COMFYUI_MCP_PANEL_PENDING as string, "{ not json");
        return jsonRes({});
      }
      if (u.pathname === "/v2/manager/queue/start" && method === "POST") {
        return new Response("", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    // The update still reports "queued" (a marker problem must not punish a
    // success)…
    const result = await updateAllCustomNodes();
    expect(result.message).toMatch(/[Qq]ueued/);
    // …and the corrupt record reads as a synthetic UNKNOWN marker (fail
    // closed) — never as a stale base the pin path could trust.
    const ops = activePanelPendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("unknown");

    // A pin afterwards cannot prove anything, sends NOTHING, and keeps the
    // warning.
    managerHandler = () => new Response("not found", { status: 404 });
    const report = await writePin();
    expect(resetPosts()).toHaveLength(0);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("cannot-cancel");
    expect(cancel.markerCleared).toBe(false);
    expect(report.note as string).toMatch(/WARNING/);
  });
});

describe("fetchManagerQueueCounts", () => {
  it("returns undefined (could-not-verify) when the Manager is unreachable", async () => {
    managerHandler = () => new Response("not found", { status: 404 });
    await expect(fetchManagerQueueCounts(ORIG)).resolves.toBeUndefined();
  });
});

describe("fetchManagerTaskHistoryEntry (#689 round 4)", () => {
  it("returns the entry ONLY when the ui_id matches; {} is provably absent", async () => {
    v4Persona(
      { pending: 0, inProgress: 0, done: 0 },
      { history: new Set(["ui-a_comfyui-agent-panel"]) },
    );
    await expect(
      fetchManagerTaskHistoryEntry("ui-a_comfyui-agent-panel", ORIG),
    ).resolves.toMatchObject({ uiId: "ui-a_comfyui-agent-panel", kind: "update" });
    await expect(
      fetchManagerTaskHistoryEntry("ui-b_comfyui-agent-panel", ORIG),
    ).resolves.toBeNull();
  });

  it("a mismatched ui_id in the response is UNTRUSTED (undefined), never proof", async () => {
    v4Persona(
      { pending: 0, inProgress: 0, done: 0 },
      { historyResponder: () => ({ history: { ui_id: "other-task", kind: "update" } }) },
    );
    await expect(
      fetchManagerTaskHistoryEntry("ui-a_comfyui-agent-panel", ORIG),
    ).resolves.toBeUndefined();
  });
});

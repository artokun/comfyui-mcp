// #1615 — panel_run's duplicate fence refused a post-reconnect scoped preview,
// and the override it named was documented as not applying to that caller.
//
// TWO bug-shaped halves of one report, tested here together because they are the
// two halves of one refusal the reporter actually hit:
//
// (2) QueueMonitor.start() cleared the self-queue ledger on ANY retarget. The
//     orchestrator retargets on a panel hello, and a hello can re-spell the SAME
//     server — `127.0.0.1:8188` -> `localhost:8188` is the example start()'s own
//     docstring gives. Renders still in flight ON THAT SERVER then read as
//     unattributable, `selfAttributedProven` went false, and the fence refused
//     every run until the queue drained. The jobs never became foreign; only
//     their spelling changed.
//
// (1) All three places documenting `allow_duplicate` scoped it to "a sweep/batch"
//     — precisely the case the post-reconnect caller is NOT in. Reading
//     "only ... (a sweep/batch)", the correct inference is that the escape hatch
//     belongs to someone else, so the caller stops. That is the reported symptom
//     ("prevents normal incremental verification after reconnect").
//
// The wiring matters as much as the behaviour: the production retarget path in
// orchestrator/index.ts calls QueueMonitor.stop() ITSELF and only then start(),
// so these tests drive that exact sequence rather than start() alone.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPanelToolDefs, makePanelToolCtx, type PanelToolCtx } from "../../orchestrator/panel-tools.js";
import { QueueMonitor } from "../../services/queue-monitor.js";

type QMPriv = {
  url: string | null;
  stopped: boolean;
  selfQueuedIds: Set<string>;
  lastSelfQueueTs: number | null;
  state: {
    connected: boolean;
    runningPromptId: string | null;
    pendingPromptIds: string[];
    queueRemaining: number;
    lastServerAliveTs: number | null;
    lastFrameTs: number | null;
  };
};
const qm = QueueMonitor as unknown as QMPriv;

// Ports nothing listens on: start() opens a real WS, and pointing it at a live
// ComfyUI would let an actual server mutate state underneath the assertions.
const ORIGINAL = "http://127.0.0.1:39971";
const RESPELLED = "http://localhost:39971"; // same server, different spelling
const ELSEWHERE = "http://127.0.0.1:39972"; // a genuinely different ComfyUI

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def;
}

function makeCtx(runReply: Record<string, unknown>): PanelToolCtx {
  const bridge = {
    send: async () => ({}),
    push: () => 1,
    canReach: () => true,
  } as unknown as PanelToolCtx["bridge"];
  const ctx = makePanelToolCtx(bridge, "test-tab");
  (ctx as { call: PanelToolCtx["call"] }).call = async () => ({
    content: [{ type: "text", text: JSON.stringify(runReply) }],
  });
  return ctx;
}

function firstText(res: { content?: Array<{ type: string; text?: string }> }): string {
  return res.content?.find((c) => c.type === "text")?.text ?? "";
}

/** The user's render, queued by US, still running on ComfyUI. */
function anOwnRenderInFlight(): void {
  QueueMonitor.markSelfQueued("p-mine");
  qm.state.runningPromptId = "p-mine";
  qm.state.pendingPromptIds = [];
  qm.state.queueRemaining = 1;
}

/**
 * What the watchdog looks like once it is back up on the retargeted URL. start()
 * resets the liveness clocks and the socket is not really open here, so restore
 * the observable view the fence reads — the QUESTION under test is what happened
 * to the ledger, which start() alone decides.
 */
function watchdogBackUp(): void {
  qm.state.connected = true;
  qm.state.lastServerAliveTs = Date.now();
  qm.state.lastFrameTs = Date.now();
}

/** Exactly what orchestrator/index.ts does on a target change: stop, then start. */
function orchestratorRetargetsTo(url: string): void {
  QueueMonitor.stop();
  QueueMonitor.start(url);
  watchdogBackUp();
}

beforeEach(() => {
  qm.url = ORIGINAL;
  qm.stopped = false;
  qm.selfQueuedIds.clear();
  qm.lastSelfQueueTs = null;
  watchdogBackUp();
  qm.state.runningPromptId = null;
  qm.state.pendingPromptIds = [];
  qm.state.queueRemaining = 0;
});

afterEach(() => {
  QueueMonitor.stop();
  qm.selfQueuedIds.clear();
  qm.lastSelfQueueTs = null;
  qm.stopped = true;
  qm.url = null;
});

describe("#1615: a re-spelled retarget must not orphan the self-queue ledger", () => {
  it("the reporter's case — a hello re-spells the same server, and the scoped preview still queues", async () => {
    anOwnRenderInFlight();
    expect(QueueMonitor.snapshot().selfAttributedProven).toBe(true);

    orchestratorRetargetsTo(RESPELLED);

    // The server did not move, so neither did ownership of what is running on it.
    expect(qm.selfQueuedIds.has("p-mine")).toBe(true);
    expect(QueueMonitor.snapshot().selfAttributedProven).toBe(true);

    const res = await defByName("panel_run").handler({ to_node_id: 16 }, makeCtx({ queued: true, prompt_id: "p-next" }));
    expect(firstText(res)).not.toContain("refused to queue");
  });

  it("a genuine retarget still drops ownership — another ComfyUI's jobs are foreign (#559 intact)", async () => {
    anOwnRenderInFlight();

    orchestratorRetargetsTo(ELSEWHERE);

    expect(qm.selfQueuedIds.size).toBe(0);
    expect(qm.lastSelfQueueTs).toBeNull();
    expect(QueueMonitor.snapshot().selfAttributedProven).toBe(false);

    const res = await defByName("panel_run").handler({ to_node_id: 16 }, makeCtx({ queued: true, prompt_id: "p-next" }));
    expect(firstText(res)).toContain("refused to queue");
  });

  it("same origin, DIFFERENT base path is a different ComfyUI behind one proxy — ownership drops", () => {
    qm.url = "http://127.0.0.1:39971/comfy-a";
    anOwnRenderInFlight();

    orchestratorRetargetsTo("http://127.0.0.1:39971/comfy-b");

    expect(qm.selfQueuedIds.size).toBe(0);
    expect(QueueMonitor.snapshot().selfAttributedProven).toBe(false);
  });

  it("a trailing slash is not a retarget either", () => {
    anOwnRenderInFlight();

    orchestratorRetargetsTo(`${ORIGINAL}/`);

    expect(qm.selfQueuedIds.has("p-mine")).toBe(true);
  });

  it("a first start() with no previous target keeps nothing — there is no prior server", () => {
    qm.url = null;
    QueueMonitor.markSelfQueued("p-stray");

    QueueMonitor.stop();
    QueueMonitor.start(ORIGINAL);

    expect(qm.selfQueuedIds.size).toBe(0);
  });
});

describe("#1615: the allow_duplicate override names the caller it is actually for", () => {
  // A caller reading "pass true ONLY to ... (a sweep/batch)" concludes the hatch
  // is not theirs. These assert the post-reconnect case is named as ordinary in
  // every place the override is described — the tool description, the parameter
  // description, and the refusal the caller actually reads.
  const panelRun = () => defByName("panel_run");

  function allowDuplicateDescription(): string {
    const field = panelRun().schema.allow_duplicate as { description?: string };
    return field.description ?? "";
  }

  it("the parameter description licenses the post-reconnect preview, not just a sweep", () => {
    const d = allowDuplicateDescription();
    expect(d).toMatch(/after a reconnect that is the ordinary case/i);
    expect(d).toMatch(/to_node_id preview/i);
    // The old wording made sweep/batch the DEFINITION of the override.
    expect(d).not.toMatch(/only to deliberately queue behind it \(a sweep\/batch\)/i);
  });

  it("the tool description does not scope the override to a sweep either", () => {
    const d = panelRun().description;
    expect(d).toMatch(/to_node_id preview after a reconnect is the ordinary case/i);
    expect(d).not.toMatch(/only to deliberately stack behind it/i);
  });

  it("the refusal the caller reads names their own case as the ordinary one", async () => {
    qm.state.runningPromptId = "p-unaccounted";
    qm.state.queueRemaining = 1; // in flight, and not provably ours

    const res = await defByName("panel_run").handler({ to_node_id: 16 }, makeCtx({ queued: true }));
    const text = firstText(res);

    expect(text).toContain("refused to queue");
    expect(text).toContain("allow_duplicate:true");
    expect(text).toMatch(/after a reconnect that is the ORDINARY case/);
    expect(text).toMatch(/scoped to_node_id preview/);
    // Sweep/batch survives as an example, never as the licence.
    expect(text).not.toMatch(/If you genuinely intend to stack another render behind it \(a deliberate sweep\/batch\)/);
  });
});

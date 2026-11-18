// #2955 — panel_run captured the PREVIOUS prompt/filename right after two
// panel_set_widget calls that both reported success. History showed the old
// SaveImage prefix; nothing errored.
//
// Root cause, in this repository's seam: the per-tab graph lane releases a
// targeted mutation (and graph_run) as soon as its frame is written (#2559),
// and the frontend's graph_set_widget awaits /object_info work before it
// applies the value. A graph_run that reaches the panel while an earlier write
// is still unacknowledged — or while that write's handler is still in its
// orchestrator-side preflight and has not sent the frame at all — serializes
// the old value. The write then acks `set` and panel_run reports queued.
//
// The panel below models exactly that: graph_set_widget applies only when the
// test releases it, and graph_run snapshots the widget values at the moment
// its frame ARRIVES. Every case drives the shipped tool defs against a real
// UiBridge; no live canvas is involved.

import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { UiBridge } from "../../services/ui-bridge.js";
import {
  __panelToolsTestHooks,
  buildPanelToolDefs,
  makePanelToolCtx,
  RETRY_TOKEN_CMDS,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { RunCompletions } from "../../orchestrator/run-completion-journal.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import { waitFor } from "../helpers/wait-for.js";

const TAB = "wf:workflows/chizu_scout.json";
const TAB2 = "wf:workflows/other_canvas.json";
const TAB3 = "wf:workflows/third_canvas.json";
const WORKFLOW_UUID = "22222222-2222-4222-8222-222222222222";
const PROMPT_NODE = 6;
const SAVE_NODE = 9;
const OLD = { text: "scout 03 full body", filename_prefix: "Chizu_V02_Scout_03_FullBody_NoRating" };
const NEW = { text: "scout 04 full body safe", filename_prefix: "Chizu_V02_Scout_04_FullBody_Safe" };

let bridge: UiBridge;
let port: number;
/** The workflow stamp the bridge resolves for TAB; a test swaps it to model a replacement. */
let workflowUuid = WORKFLOW_UUID;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = addr && typeof addr === "object" ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
}

async function startBridge(): Promise<void> {
  let lastErr = "no attempt made";
  for (let attempt = 0; attempt < 6; attempt++) {
    port = await freePort();
    bridge = new UiBridge(port);
    bridge.start();
    if (await bridge.whenReady()) {
      bridge.setTabWorkflowUuidResolver(() => workflowUuid);
      // Production installs this in orchestrator/index.ts; it is what makes a
      // delivered mutation visible to the bridge at all.
      bridge.setLateMutationFilter((cmdName) => RETRY_TOKEN_CMDS.has(cmdName));
      return;
    }
    lastErr = `bind to ${port} lost a close→rebind race`;
    await bridge.stop();
  }
  throw new Error(`could not bind a free bridge port after 6 attempts: ${lastErr}`);
}

function helloFrame(tab = TAB, session = "browser-tab-2955"): string {
  return JSON.stringify({
    type: "hello",
    tab_id: tab,
    title: "chizu_scout",
    tab_session_id: session,
    enforces_workflow_stamp: true,
    enforces_workflow_stamp_at_write: true,
    enforces_expected_node_type_at_write: true,
    enforces_expected_node_identity_at_write: true,
  });
}

function connectPanel(tab = TAB, session?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    sock.on("open", () => {
      sock.send(helloFrame(tab, session ?? (tab === TAB ? "browser-tab-2955" : `browser-tab-${tab}`)));
      resolve(sock);
    });
    sock.on("error", reject);
  });
}

function viewing() {
  return {
    scope: "root",
    kind: "root",
    workflow: "chizu_scout.json",
    workflow_uuid: workflowUuid,
    graph_identity: "graph:root-2955",
  };
}

type Widgets = { text: string; filename_prefix: string };
type HeldWrite = { msg: Record<string, unknown>; release: (opts?: { ok?: boolean }) => void };

type PanelOpts = {
  holdRuns?: boolean;
  holdRead?: string;
  /** Never answer this command (its reply is lost; the bridge times it out). */
  dropCmd?: string;
  /** Lose only the FIRST frame of this command before the panel sees it (it never
   *  runs, so the ledger never learns its rid); later frames are handled normally. */
  dropFirst?: string;
  /**
   * Model the panel's rid ledger (#517/#694, comfyui-mcp-panel command-dedupe):
   * a retry_of whose original the ledger holds with the SAME fingerprint is
   * answered with the original's own reply — joining it if still running, no
   * second apply; a different fingerprint is rejected before execution; an
   * unknown token fails open and executes fresh.
   */
  ledger?: boolean;
  /** With ledger: a joined duplicate gives up after this long with the panel's
   *  "STILL RUNNING … DO NOT RETRY" error (awaitDuplicateReply's bound). */
  duplicateBudgetMs?: number;
  /** A retry the ledger does not know is parked (defer_until_idle-shaped reply). */
  deferUnknownRetry?: boolean;
  /** Called for every frame the panel receives, before it is answered. */
  onFrame?: (msg: Record<string, unknown>) => void;
};

type ScriptedPanel = {
  readonly values: Widgets;
  /** One entry per graph_run the panel EXECUTED (serialized): what it serialized. */
  readonly runs: Array<{ rid: string; serialized: Widgets }>;
  /** graph_set_widget executions (fresh writes) that reached the panel, held until released. */
  readonly writes: HeldWrite[];
  /** How many widget writes were actually APPLIED to the graph. */
  readonly applyCount: number;
  /** graph_set_widget frames answered from the ledger instead of executing. */
  readonly ledgerAnswers: number;
  /** Resolves once `n` executing graph_set_widget frames have reached the panel. */
  writesArrived(n: number): Promise<void>;
  /** Resolves when the first graph_run frame reaches the panel. */
  runArrived(): Promise<void>;
  /** The socket this script answers on. */
  readonly sock: WebSocket;
  /** With holdRuns, ack graph_run frame `i` now (queued, with a prompt id). */
  releaseRun(i: number): void;
  /** With holdRead, how many are held, and answer them all. */
  readonly heldReadCount: number;
  releaseReads(): void;
  /** Frames of `dropCmd` that reached the panel. */
  readonly dropped: Array<Record<string, unknown>>;
};

function nodeRow(id: unknown, values: Widgets) {
  const isSave = String(id) === String(SAVE_NODE);
  return {
    id: isSave ? SAVE_NODE : PROMPT_NODE,
    type: isSave ? "SaveImage" : "CLIPTextEncode",
    is_subgraph: false,
    node_identity: `node:${isSave ? SAVE_NODE : PROMPT_NODE}`,
    widgets: isSave ? { filename_prefix: values.filename_prefix } : { text: values.text },
  };
}

const RETRY_REJECTED = "Retry rejected: retry_of refers to a different command or workflow.";

/**
 * graph_set_widget is HELD until the test releases it (the frontend's
 * /object_info await before applyWidgetWrite), then applied and acked.
 * graph_run serializes the values present when its frame arrives.
 */
function attachPanel(sock: WebSocket, opts: PanelOpts = {}): ScriptedPanel {
  const values: Widgets = { ...OLD };
  const runs: Array<{ rid: string; serialized: Widgets }> = [];
  const writes: HeldWrite[] = [];
  const dropped: Array<Record<string, unknown>> = [];
  const arrivalWaiters: Array<{ n: number; resolve: () => void }> = [];
  const runWaiters: Array<() => void> = [];
  const heldReads: Array<() => void> = [];
  let applyCount = 0;
  let ledgerAnswers = 0;
  type Entry = { fp: string; reply?: Record<string, unknown>; joiners: string[] };
  const writeLedger = new Map<string, Entry>();
  const runLedger = new Map<string, Entry>();
  const send = (frame: Record<string, unknown>) => sock.send(JSON.stringify(frame));
  // The panel's commandFingerprint (lib/command-dedupe.js): the whole frame minus rid
  // and retry_of, key-order independent — the workflow stamp, every argument AND
  // timeout_ms are part of it. A positive join therefore needs the retry to carry the
  // original's timeout, as production's caller-requested timeout does (#2559).
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
          )
        : v;
  const fingerprint = (m: Record<string, unknown>) => {
    const { rid: _rid, retry_of: _retryOf, ...rest } = m;
    return JSON.stringify(canon(rest));
  };
  const writeFp = fingerprint;
  const runFp = fingerprint;
  const droppedFirst = new Set<string>();
  const settleEntry = (entry: Entry | undefined, reply: Record<string, unknown>) => {
    if (!entry) return;
    entry.reply = reply;
    for (const joiner of entry.joiners.splice(0)) send({ ...reply, rid: joiner });
  };
  /** true when the ledger answered (or will answer) this retry without executing it */
  const answerFromLedger = (ledger: Map<string, Entry>, msg: Record<string, unknown>, fp: string): boolean => {
    if (!opts.ledger || typeof msg.retry_of !== "string") return false;
    const original = ledger.get(msg.retry_of);
    if (!original) return false; // fails open: execute fresh
    const rid = msg.rid as string;
    ledgerAnswers += 1;
    if (original.fp !== fp) {
      send({ rid, ok: false, error: RETRY_REJECTED });
      return true;
    }
    if (original.reply) {
      send({ ...original.reply, rid });
      return true;
    }
    original.joiners.push(rid);
    if (opts.duplicateBudgetMs !== undefined) {
      setTimeout(() => {
        const at = original.joiners.indexOf(rid);
        if (at < 0) return;
        original.joiners.splice(at, 1);
        send({
          rid,
          ok: false,
          error:
            "This request id is STILL RUNNING in the panel and has not produced an outcome. This " +
            "delivery was a DUPLICATE of it, so nothing new was started and nothing was applied twice. " +
            "DO NOT RETRY: the original may still complete.",
        });
      }, opts.duplicateBudgetMs);
    }
    return true;
  };
  sock.on("message", (buf) => {
    const msg = JSON.parse(buf.toString()) as Record<string, unknown>;
    if (typeof msg.rid !== "string" || typeof msg.cmd !== "string") return;
    const rid = msg.rid;
    opts.onFrame?.(msg);
    if (opts.dropCmd && msg.cmd === opts.dropCmd) {
      dropped.push(msg);
      return;
    }
    if (opts.dropFirst && msg.cmd === opts.dropFirst && !droppedFirst.has(msg.cmd)) {
      droppedFirst.add(msg.cmd);
      dropped.push(msg);
      return;
    }
    if (msg.cmd === "graph_set_widget") {
      const fp = writeFp(msg);
      if (answerFromLedger(writeLedger, msg, fp)) return;
      if (opts.deferUnknownRetry && typeof msg.retry_of === "string") {
        send({
          rid,
          ok: true,
          result: { deferred: true, receipt: `defer-${rid}`, status: "waiting_for_queue_idle" },
        });
        return;
      }
      const entry: Entry = { fp, joiners: [] };
      writeLedger.set(rid, entry);
      let done = false;
      writes.push({
        msg,
        release: (releaseOpts) => {
          if (done) return;
          done = true;
          if (releaseOpts?.ok === false) {
            const reply = { rid, ok: false, error: "widget write refused by the panel" };
            send(reply);
            settleEntry(entry, reply);
            return;
          }
          const widget = msg.widget as keyof Widgets;
          const previous = values[widget];
          values[widget] = String(msg.value);
          applyCount += 1;
          const reply = {
            rid,
            ok: true,
            result: { set: { node_id: msg.node_id, widget, previous, value: msg.value } },
          };
          send(reply);
          settleEntry(entry, reply);
        },
      });
      for (const w of arrivalWaiters.splice(0)) {
        if (writes.length >= w.n) w.resolve();
        else arrivalWaiters.push(w);
      }
      return;
    }
    if (msg.cmd === "graph_run") {
      const fp = runFp(msg);
      if (answerFromLedger(runLedger, msg, fp)) return;
      runLedger.set(rid, { fp, joiners: [] });
      runs.push({ rid, serialized: { ...values } });
      for (const resolve of runWaiters.splice(0)) resolve();
      if (opts.holdRuns) return;
      const reply = { rid, ok: true, result: { queued: true, prompt_id: `p-2955-${runs.length}` } };
      send(reply);
      settleEntry(runLedger.get(rid), reply);
      return;
    }
    if (opts.holdRead && msg.cmd === opts.holdRead) {
      heldReads.push(() => send({ rid, ok: true, result: { errors: [] } }));
      return;
    }
    const ids = Array.isArray(msg.ids) ? msg.ids : [msg.node_id ?? PROMPT_NODE];
    const result =
      msg.cmd === "graph_query" || msg.cmd === "graph_get_subgraph"
        ? { viewing: viewing(), truncated: false, nodes: ids.map((id) => nodeRow(id, values)), node_count: ids.length }
        : { ok: true };
    send({ rid, ok: true, result });
  });
  return {
    get values() {
      return values;
    },
    runs,
    writes,
    dropped,
    get applyCount() {
      return applyCount;
    },
    get ledgerAnswers() {
      return ledgerAnswers;
    },
    writesArrived(n: number) {
      if (writes.length >= n) return Promise.resolve();
      return new Promise((resolve) => arrivalWaiters.push({ n, resolve }));
    },
    runArrived() {
      if (runs.length > 0) return Promise.resolve();
      return new Promise((resolve) => runWaiters.push(resolve));
    },
    sock,
    get heldReadCount() {
      return heldReads.length;
    },
    releaseReads() {
      for (const answer of heldReads.splice(0)) answer();
    },
    releaseRun(i: number) {
      const run = runs[i];
      if (!run) throw new Error(`no graph_run #${i} reached the panel`);
      const reply = { rid: run.rid, ok: true, result: { queued: true, prompt_id: `p-2955-${i + 1}` } };
      send(reply);
      settleEntry(runLedger.get(run.rid), reply);
    },
  };
}

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} is not registered`);
  return def;
}

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

function newCtx(tab = TAB): PanelToolCtx {
  return makePanelToolCtx(bridge, tab, new WorkflowTargetStore());
}

async function connected(opts: PanelOpts = {}, tab = TAB): Promise<ScriptedPanel> {
  const sock = await connectPanel(tab);
  const panel = attachPanel(sock, opts);
  await waitFor(() => expect(bridge.canReach(tab)).toBe(true));
  return panel;
}

function setWidget(ctx: PanelToolCtx, nodeId: number, widget: keyof Widgets, value: string) {
  return defByName("panel_set_widget").handler({ node_id: nodeId, widget, value } as never, ctx);
}

function panelRun(ctx: PanelToolCtx, args: Record<string, unknown> = {}) {
  return defByName("panel_run").handler(args as never, ctx);
}

type BarrierSnapshot = { intents: number; awaited: number; unknown: number };

/** Every barrier wait panel_run enters from now on, in order. */
function observeBarrier(): { calls: BarrierSnapshot[]; next: () => Promise<BarrierSnapshot> } {
  const calls: BarrierSnapshot[] = [];
  const waiters: Array<(s: BarrierSnapshot) => void> = [];
  __panelToolsTestHooks.setRunFreshnessWaitObserver((snapshot) => {
    calls.push(snapshot);
    waiters.shift()?.(snapshot);
  });
  return {
    calls,
    next: () => {
      const seen = calls[calls.length - 1];
      return seen ? Promise.resolve(seen) : new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/**
 * Which happened first: panel_run entering its freshness wait, or its graph_run
 * frame reaching the panel. Ordered against the barrier itself, never a clock:
 * a run that skipped the wait shows up here as "run".
 */
async function firstOf(
  barrier: { next: () => Promise<BarrierSnapshot> },
  panel: ScriptedPanel,
): Promise<{ kind: "barrier"; snapshot: BarrierSnapshot } | { kind: "run" }> {
  return Promise.race([
    barrier.next().then((snapshot) => ({ kind: "barrier" as const, snapshot })),
    panel.runArrived().then(() => ({ kind: "run" as const })),
  ]);
}

/** A session whose graph_set_widget reply window is shrunk so a held write times out. */
function slowWriteCtx(writeTimeoutMs = 300, tab = TAB): PanelToolCtx {
  const ctx = newCtx(tab);
  const inner = ctx.call.bind(ctx);
  ctx.call = (cmd, timeoutMs, onDispatchedRid, beforeDispatch, options) =>
    inner(
      cmd,
      cmd.cmd === "graph_set_widget" ? writeTimeoutMs : timeoutMs,
      onDispatchedRid,
      beforeDispatch,
      options,
    );
  return ctx;
}

function tokenOf(res: ToolResult): string {
  const token = /retry_of:"([^"]+)"/.exec(textOf(res))?.[1];
  if (!token) throw new Error(`no retry_of token in: ${textOf(res)}`);
  return token;
}

/** True once `p` has settled, without awaiting it. */
function tracked<T>(p: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false;
  const promise = p.finally(() => {
    done = true;
  });
  return { promise, settled: () => done };
}

beforeEach(async () => {
  workflowUuid = WORKFLOW_UUID;
  RunCompletions.reset();
  __panelToolsTestHooks.setRetrySettleMs(0);
  await startBridge();
});

afterEach(async () => {
  vi.restoreAllMocks();
  __panelToolsTestHooks.setRunFreshnessBarrierMs(null);
  __panelToolsTestHooks.setRunFreshnessWaitObserver(null);
  __panelToolsTestHooks.setOutstandingMutationReadSettleMs(null);
  __panelToolsTestHooks.setRetrySettleMs(null);
  __panelToolsTestHooks.setRunLateAckGraceMs(null);
  RunCompletions.reset();
  await bridge.stop();
});

describe("panel_run observes earlier acknowledged mutations before serialization (#2955)", () => {
  it("reproduction: set prompt + set filename + run issued together serializes the NEW values", async () => {
    const panel = await connected();
    const ctx = newCtx();

    const barrier = observeBarrier();
    const text = setWidget(ctx, PROMPT_NODE, "text", NEW.text);
    const prefix = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    const run = tracked(panelRun(ctx));

    const first = await firstOf(barrier, panel);
    expect(first.kind, "graph_run reached the serializer before the earlier writes").toBe("barrier");
    expect(first.kind === "barrier" && first.snapshot.intents).toBe(2);
    await panel.writesArrived(2);
    // Both write frames are on the panel and unacknowledged: the run must not
    // have reached the serializer yet.
    expect(panel.runs).toHaveLength(0);
    for (const w of panel.writes) w.release();

    const [textRes, prefixRes, runRes] = await Promise.all([text, prefix, run.promise]);
    expect(textRes.isError, textOf(textRes)).not.toBe(true);
    expect(prefixRes.isError, textOf(prefixRes)).not.toBe(true);
    expect(runRes.isError, textOf(runRes)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized).toEqual(NEW);
    expect(RunCompletions.ticketFor("p-2955-1")).toBeDefined();
  });

  it("waits for a write still in its orchestrator-side preflight (frame not yet sent)", async () => {
    const panel = await connected();
    const ctx = newCtx();

    // Same tick: the write's preflight reads have not even been answered yet.
    const barrier = observeBarrier();
    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    const run = tracked(panelRun(ctx));

    const first = await firstOf(barrier, panel);
    expect(first.kind, "graph_run overtook a write still in its preflight").toBe("barrier");
    // No frame is on the wire yet — only the call registry can see this write.
    expect(first.kind === "barrier" && first.snapshot).toEqual({ intents: 1, awaited: 0, unknown: 0 });
    await panel.writesArrived(1);
    expect(panel.runs, "graph_run overtook a write the caller issued first").toHaveLength(0);
    expect(run.settled()).toBe(false);
    panel.writes[0]?.release();

    const [writeRes, runRes] = await Promise.all([write, run.promise]);
    expect(writeRes.isError, textOf(writeRes)).not.toBe(true);
    expect(runRes.isError, textOf(runRes)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized.filename_prefix).toBe(NEW.filename_prefix);
  });

  it("waits for a frame another session delivered to the same tab (bridge-level receipt)", async () => {
    const panel = await connected();
    // A second conversation on the same canvas writes through the bridge
    // directly; this session's tool registry knows nothing about it.
    const foreign = bridge.send(
      { cmd: "graph_set_widget", node_id: PROMPT_NODE, widget: "text", value: NEW.text },
      { tabId: TAB, timeoutMs: 5000 },
    );
    await panel.writesArrived(1);
    expect(bridge.listAwaitedMutations(TAB)).toHaveLength(1);
    const barrier = observeBarrier();
    const run = tracked(panelRun(newCtx()));
    const first = await firstOf(barrier, panel);
    expect(first.kind, "graph_run overtook another session's unacknowledged write").toBe("barrier");
    // This session has no call of its own in flight — only the bridge receipt.
    expect(first.kind === "barrier" && first.snapshot).toEqual({ intents: 0, awaited: 1, unknown: 0 });
    expect(panel.runs).toHaveLength(0);
    panel.writes[0]?.release();

    await foreign;
    const runRes = await run.promise;
    expect(runRes.isError, textOf(runRes)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized.text).toBe(NEW.text);
  });

  it("refuses BEFORE dispatch when an earlier write stays unacknowledged, then a re-run queues exactly once", async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(120);
    const panel = await connected();
    const ctx = newCtx();

    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    const refused = await panelRun(ctx);
    const text = textOf(refused);

    expect(refused.isError).toBe(true);
    expect(panel.runs, "a refused run must never reach the panel").toHaveLength(0);
    expect(text).toMatch(/panel_run was NOT dispatched/);
    expect(text).toMatch(/nothing was queued/i);
    expect(text).toContain("panel_set_widget");
    expect(text).toMatch(/minted no retry_of token/);
    expect(text).not.toMatch(/retry_of:"/);
    expect(text).not.toMatch(/ORIGINAL run/);
    expect(RunCompletions.ticketFor("p-2955-1")).toBeUndefined();

    panel.writes[0]?.release();
    const writeRes = await write;
    expect(writeRes.isError, textOf(writeRes)).not.toBe(true);

    const rerun = await panelRun(ctx);
    expect(rerun.isError, textOf(rerun)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized.filename_prefix).toBe(NEW.filename_prefix);
  });

  it("does NOT wait for writes issued after the run started (no absorbing the next cell)", async () => {
    const panel = await connected();
    const ctx = newCtx();

    const cell04 = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    const barrier = observeBarrier();
    const run = tracked(panelRun(ctx));
    const first = await firstOf(barrier, panel);
    expect(first.kind).toBe("barrier");
    expect(first.kind === "barrier" && first.snapshot).toEqual({ intents: 1, awaited: 1, unknown: 0 });
    // The next cell's write starts while the run is waiting on cell 04.
    const cell05 = setWidget(ctx, PROMPT_NODE, "text", "scout 05 portrait");
    await panel.writesArrived(2);

    panel.writes[0]?.release();
    const runRes = await run.promise;
    expect(runRes.isError, textOf(runRes)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized).toEqual({ ...OLD, filename_prefix: NEW.filename_prefix });
    // The later write is still unacknowledged: the run did not wait for it.
    expect(panel.values.text).toBe(OLD.text);

    panel.writes[1]?.release();
    expect((await cell04).isError).not.toBe(true);
    expect((await cell05).isError).not.toBe(true);
  });

  it("refuses without rebinding when the session's target switches while waiting", async () => {
    const panel = await connected();
    const ctx = newCtx();

    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    const barrier = observeBarrier();
    const run = tracked(panelRun(ctx));
    expect((await firstOf(barrier, panel)).kind).toBe("barrier");
    ctx.tabId = "wf:workflows/another_canvas.json";
    panel.writes[0]?.release();

    const res = await run.promise;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/panel_run was NOT dispatched/);
    expect(textOf(res)).toMatch(/target changed/i);
    expect(textOf(res)).toContain(TAB);
    expect(textOf(res)).toContain("wf:workflows/another_canvas.json");
    expect(ctx.tabId, "the barrier must never rebind the session").toBe("wf:workflows/another_canvas.json");
    expect(panel.runs).toHaveLength(0);
    await write;
  });

  it("a prerequisite write the panel REFUSED refuses the concurrent run; a later explicit run uses the graph as it stands", async () => {
    const panel = await connected();
    const ctx = newCtx();

    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    const barrier = observeBarrier();
    const run = tracked(panelRun(ctx));
    expect((await firstOf(barrier, panel)).kind).toBe("barrier");
    panel.writes[0]?.release({ ok: false });

    const writeRes = await write;
    expect(writeRes.isError).toBe(true);
    const runRes = await run.promise;
    expect(runRes.isError).toBe(true);
    expect(textOf(runRes)).toMatch(/panel_run was NOT dispatched/);
    expect(textOf(runRes)).toMatch(/FAILED: panel_set_widget returned an error/);
    expect(panel.runs, "a failed prerequisite must not become a queued stale render").toHaveLength(0);

    const later = await panelRun(ctx);
    expect(later.isError, textOf(later)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized).toEqual(OLD);
  });

  it("an earlier TIMED-OUT write refuses before dispatch; its late acknowledgement then lets the run through", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(60);
    const panel = await connected();

    const timedOut = await bridge
      .send(
        { cmd: "graph_set_widget", node_id: SAVE_NODE, widget: "filename_prefix", value: NEW.filename_prefix },
        { tabId: TAB, timeoutMs: 40 },
      )
      .then(
        () => "acked",
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
    expect(timedOut).toMatch(/did not reply to "graph_set_widget"/);
    const rid = bridge.listOutstandingMutations(TAB)[0]?.rid;
    expect(rid).toBeTruthy();
    expect(bridge.mutationSettlement(rid as string)).toBe("unknown");
    const barrier = observeBarrier();

    const refused = await panelRun(newCtx());
    expect(barrier.calls).toEqual([{ intents: 0, awaited: 0, unknown: 1 }]);
    expect(refused.isError).toBe(true);
    expect(panel.runs, "no GPU time on a graph whose edit outcome is unknown").toHaveLength(0);
    expect(textOf(refused)).toMatch(/panel_run was NOT dispatched/);
    expect(textOf(refused)).toMatch(/UNKNOWN outcome/);
    expect(textOf(refused)).toContain(`that edit's own token retry_of:"${rid}"`);
    expect(textOf(refused)).toContain("panel_set_widget");
    // The receipt is retained for reconciliation, not consumed by the refusal.
    expect(bridge.listOutstandingMutations(TAB).map((m) => m.rid)).toEqual([rid]);

    // The late apply lands: that is proven settlement, and the next run includes it.
    panel.writes[0]?.release();
    await waitFor(() => expect(bridge.mutationSettlement(rid as string)).toBe("settled"));
    const next = await panelRun(newCtx());
    expect(next.isError, textOf(next)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized.filename_prefix).toBe(NEW.filename_prefix);
  });

  it("an awaited write that TIMES OUT during the wait refuses instead of releasing the run", async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(250);
    const panel = await connected();

    const write = bridge
      .send(
        { cmd: "graph_set_widget", node_id: SAVE_NODE, widget: "filename_prefix", value: NEW.filename_prefix },
        { tabId: TAB, timeoutMs: 60 },
      )
      .then(
        () => "acked",
        () => "timed out",
      );
    await panel.writesArrived(1);
    const barrier = observeBarrier();
    const res = await panelRun(newCtx());

    expect(barrier.calls).toEqual([{ intents: 0, awaited: 1, unknown: 0 }]);
    expect(await write).toBe("timed out");
    expect(res.isError).toBe(true);
    expect(panel.runs).toHaveLength(0);
    expect(textOf(res)).toMatch(/UNKNOWN outcome/);
    expect(textOf(res)).not.toMatch(/awaiting the panel's reply/);
  });

  it("an exact edit retry_of JOINS the still-running original in the panel ledger: one apply, settled, then the run proceeds", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    const panel = await connected({ ledger: true });
    const first = await setWidget(slowWriteCtx(), SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    expect(first.isError).toBe(true);
    const token = tokenOf(first);
    expect((await panelRun(newCtx())).isError, "outcome-unknown edit must refuse the run").toBe(true);
    expect(panel.runs).toHaveLength(0);

    const ctx = slowWriteCtx(); // same caller-requested timeout as the original: same fingerprint
    const retry = defByName("panel_set_widget").handler(
      { node_id: SAVE_NODE, widget: "filename_prefix", value: NEW.filename_prefix, retry_of: token } as never,
      ctx,
    );
    // The panel's ledger joined the retry onto the running original: nothing new executed.
    await waitFor(() => expect(panel.ledgerAnswers).toBe(1));
    expect(panel.writes).toHaveLength(1);
    panel.writes[0]?.release(); // the ORIGINAL completes; the joined retry gets its reply
    expect((await retry).isError, "retry answered with the original's outcome").not.toBe(true);
    expect(panel.applyCount, "applied once, never twice").toBe(1);
    await waitFor(() => expect(bridge.mutationSettlement(token)).toBe("settled"));

    const barrier = observeBarrier();
    const res = await panelRun(ctx);
    expect(barrier.calls, "a settled edit: no wait").toEqual([]);
    expect(res.isError, textOf(res)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized.filename_prefix).toBe(NEW.filename_prefix);
    expect(panel.applyCount).toBe(1);
  });

  it("the ledger's STILL-RUNNING duplicate reply does not settle the edit: the run stays refused until the original answers", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    const panel = await connected({ ledger: true, duplicateBudgetMs: 30 });
    const first = await setWidget(slowWriteCtx(), SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    const token = tokenOf(first);

    const retry = await defByName("panel_set_widget").handler(
      { node_id: SAVE_NODE, widget: "filename_prefix", value: NEW.filename_prefix, retry_of: token } as never,
      slowWriteCtx(),
    );
    expect(retry.isError).toBe(true);
    expect(textOf(retry)).toMatch(/STILL RUNNING/);
    expect(bridge.mutationSettlement(token)).toBe("unknown");
    expect((await panelRun(newCtx())).isError).toBe(true);
    expect(panel.runs).toHaveLength(0);

    panel.writes[0]?.release(); // the original's late reply is its definite outcome
    await waitFor(() => expect(bridge.mutationSettlement(token)).toBe("settled"));
    const res = await panelRun(newCtx());
    expect(res.isError, textOf(res)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.applyCount).toBe(1);
  });

  it("a non-error but NON-TERMINAL retry reply (parked until idle) does not settle the edit", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    const panel = await connected({ deferUnknownRetry: true });
    const first = await setWidget(slowWriteCtx(), SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    const token = tokenOf(first);

    const retry = await defByName("panel_set_widget").handler(
      { node_id: SAVE_NODE, widget: "filename_prefix", value: NEW.filename_prefix, retry_of: token } as never,
      newCtx(),
    );
    expect(textOf(retry)).toContain("waiting_for_queue_idle");
    expect(panel.applyCount).toBe(0);
    expect(bridge.mutationSettlement(token), "a parked edit is not an applied one").toBe("unknown");
    const res = await panelRun(newCtx());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`retry_of:"${token}"`);
    expect(panel.runs).toHaveLength(0);
  });
});

describe("panel_run freshness barrier never releases onto a different graph (#2955)", () => {
  it("same-tab workflow replacement during the wait refuses with zero graph_run", async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(150);
    const panel = await connected();
    const ctx = newCtx();

    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    const barrier = observeBarrier();
    const run = tracked(panelRun(ctx));
    expect((await firstOf(barrier, panel)).kind).toBe("barrier");

    // The orchestrator's identity-boundary reset: a different workflow now
    // occupies the same tab id, and the old write's waiter is cancelled.
    workflowUuid = "33333333-3333-4333-8333-333333333333";
    bridge.dropQueuedDeliveries(TAB);
    expect((await write).isError).toBe(true);

    const res = await run.promise;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/panel_run was NOT dispatched/);
    expect(textOf(res)).toMatch(/workflow on that tab changed|graph identity/);
    expect(textOf(res)).toMatch(/Nothing was rebound/);
    expect(panel.runs).toHaveLength(0);
  });

  it("a reconnect during the wait refuses with zero graph_run on either socket", async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(150);
    const panel = await connected();
    const ctx = newCtx();

    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    const barrier = observeBarrier();
    const run = tracked(panelRun(ctx));
    expect((await firstOf(barrier, panel)).kind).toBe("barrier");

    const before = bridge.tabConnectionIdentity(TAB);
    panel.sock.close();
    const replacement = attachPanel(await connectPanel());
    await waitFor(() =>
      expect(bridge.tabConnectionIdentity(TAB)?.generation).not.toBe(before?.generation),
    );

    const res = await run.promise;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/panel_run was NOT dispatched/);
    expect(textOf(res)).toMatch(/connection was replaced or re-registered/);
    expect(panel.runs).toHaveLength(0);
    expect(replacement.runs).toHaveLength(0);
    expect((await write).isError).toBe(true);
  });

  it("a same-socket re-hello (new connection generation) during the wait refuses even after the write settles", async () => {
    const panel = await connected();
    const ctx = newCtx();

    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    const barrier = observeBarrier();
    const run = tracked(panelRun(ctx));
    expect((await firstOf(barrier, panel)).kind).toBe("barrier");

    const before = bridge.tabConnectionIdentity(TAB)?.generation;
    panel.sock.send(helloFrame());
    await waitFor(() => expect(bridge.tabConnectionIdentity(TAB)?.generation).not.toBe(before));
    panel.writes[0]?.release();
    expect((await write).isError).not.toBe(true);

    const res = await run.promise;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/connection was replaced or re-registered/);
    expect(panel.runs).toHaveLength(0);
  });

  it("a re-hello AFTER the wait but before graph_run is written is refused by the dispatch fence", async () => {
    // panel_set_widget ends with ONE post-write graph_query read-back (#2933), and
    // graph reads hold this tab's graph lane until answered (#2069). Parked before
    // the write is released, the lane read would queue that read-back behind
    // it, so `await write` could not return until the parked read timed out.
    // The lane read is therefore parked while the read-back is being answered: it
    // is dispatched (and held) after the read-back and before graph_run, which
    // queues behind it, so the re-hello lands between the barrier and dispatch.
    let read: Promise<unknown> | undefined;
    let writeReleased = false;
    const panel = await connected({
      holdRead: "graph_get_errors",
      onFrame: (msg) => {
        if (!read && writeReleased && msg.cmd === "graph_query" && msg.fields === "detail") {
          // A read now occupies the tab's graph lane, so graph_run will queue behind it.
          read = bridge.send({ cmd: "graph_get_errors" }, { tabId: TAB, timeoutMs: 5000 });
        }
      },
    });
    const ctx = newCtx();
    let runCalled: () => void = () => {};
    const runCallSeen = new Promise<void>((resolve) => {
      runCalled = resolve;
    });
    const inner = ctx.call.bind(ctx);
    ctx.call = (cmd, timeoutMs, onDispatchedRid, beforeDispatch, options) => {
      if (cmd.cmd === "graph_run") runCalled();
      return inner(cmd, timeoutMs, onDispatchedRid, beforeDispatch, options);
    };

    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    const barrier = observeBarrier();
    const run = tracked(panelRun(ctx));
    expect((await firstOf(barrier, panel)).kind).toBe("barrier");

    writeReleased = true;
    panel.writes[0]?.release();
    await waitFor(() => expect(panel.heldReadCount).toBe(1));
    expect((await write).isError).not.toBe(true);
    await runCallSeen; // the barrier passed; the handler is dispatching graph_run
    const before = bridge.tabConnectionIdentity(TAB)?.generation;
    panel.sock.send(helloFrame());
    await waitFor(() => expect(bridge.tabConnectionIdentity(TAB)?.generation).not.toBe(before));
    panel.releaseReads();
    await read;

    const res = await run.promise;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/The bridge refused the frame unsent/);
    expect(textOf(res)).toMatch(/connection was replaced or re-registered/);
    expect(panel.runs, "graph_run must never reach the re-registered canvas").toHaveLength(0);
  });

  it("finds another session's pending write through a routed tab alias (prefix), not only the exact id", async () => {
    const panel = await connected();
    const foreign = bridge.send(
      { cmd: "graph_set_widget", node_id: PROMPT_NODE, widget: "text", value: NEW.text },
      { tabId: TAB, timeoutMs: 5000 },
    );
    await panel.writesArrived(1);
    const alias = TAB.slice(0, 16);
    expect(bridge.listAwaitedMutations(alias)).toHaveLength(1);

    const ctx = makePanelToolCtx(bridge, alias, new WorkflowTargetStore());
    const barrier = observeBarrier();
    const run = tracked(panelRun(ctx));
    const first = await firstOf(barrier, panel);
    expect(first.kind, "the alias-addressed run overtook the pending write").toBe("barrier");
    expect(first.kind === "barrier" && first.snapshot).toEqual({ intents: 0, awaited: 1, unknown: 0 });
    panel.writes[0]?.release();
    await foreign;

    const res = await run.promise;
    expect(res.isError, textOf(res)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized.text).toBe(NEW.text);
  });

  it("an unverifiable receiving connection refuses before waiting, with zero graph_run", async () => {
    const panel = await connected();
    const ctx = newCtx();
    ctx.panelConnectionIncarnationIdentity = () => undefined;

    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    const res = await panelRun(ctx);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/connection's identity could not be read/);
    expect(panel.runs).toHaveLength(0);
    panel.writes[0]?.release();
    await write;
  });
});

describe("panel_run retry_of of an outcome-unknown ORIGINAL run while edits are pending (#2955)", () => {
  async function uncertainOriginalRun(
    panel: ScriptedPanel,
    tab = TAB,
  ): Promise<{ token: string; ctx: PanelToolCtx }> {
    __panelToolsTestHooks.setRunLateAckGraceMs(0);
    const ctx = newCtx(tab);
    const inner = ctx.call.bind(ctx);
    ctx.call = (cmd, timeoutMs, onDispatchedRid, beforeDispatch, options) =>
      inner(cmd, cmd.cmd === "graph_run" ? 80 : timeoutMs, onDispatchedRid, beforeDispatch, options);
    const original = await panelRun(ctx);
    expect(original.isError).toBe(true);
    const token = /retry_of:"([^"]+)"/.exec(textOf(original))?.[1];
    expect(token, textOf(original)).toBeTruthy();
    expect(panel.runs).toHaveLength(1);
    return { token: token as string, ctx };
  }

  it("refuses the RETRY without dispatch and keeps the original's token — no plain-rerun guidance", async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(120);
    const panel = await connected({ holdRuns: true });
    const { token, ctx } = await uncertainOriginalRun(panel);

    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    const res = await panelRun(ctx, { retry_of: token });
    const text = textOf(res);

    expect(res.isError).toBe(true);
    expect(panel.runs, "the retry must not reach the panel at all").toHaveLength(1);
    expect(text).toContain(`panel_run (retry_of:"${token}") was NOT dispatched`);
    expect(text).toMatch(/ORIGINAL run you are retrying is still outcome-UNKNOWN/);
    expect(text).toMatch(/Do NOT re-run panel_run without retry_of/);
    expect(text).toContain(`the SAME retry_of:"${token}"`);
    expect(text).not.toMatch(/nothing was queued/i);
    expect(text).not.toMatch(/minted no retry_of token/);
    // The original's receipt is still held for reconciliation.
    expect(bridge.peekDeliveredMutation(token)?.status).toBe("timed_out");

    panel.writes[0]?.release();
    await write;
  });

  it("an original whose late ack has landed gets NO shortcut while an edit is pending; it reconciles locally once the edit settles — one graph_run ever", async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(120);
    const panel = await connected({ holdRuns: true });
    const { token, ctx } = await uncertainOriginalRun(panel);
    panel.releaseRun(0);
    await waitFor(() => expect(bridge.peekLateMutation(token)).toBeDefined());

    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    const refused = await panelRun(ctx, { retry_of: token });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain(`panel_run (retry_of:"${token}") was NOT dispatched`);
    expect(textOf(refused)).toContain(`the SAME retry_of:"${token}"`);
    expect(panel.runs, "no new submission").toHaveLength(1);

    panel.writes[0]?.release();
    expect((await write).isError).not.toBe(true);
    const res = await panelRun(ctx, { retry_of: token });
    expect(res.isError, textOf(res)).not.toBe(true);
    expect(textOf(res)).toContain("p-2955-1");
    expect(panel.runs, "answered from the retained receipt, not re-sent").toHaveLength(1);
    expect(RunCompletions.ticketFor("p-2955-1")).toBeDefined();
  });

  it("a prompt-receipt-only original (no reply body) + a pending edit: the retry is refused with the original's token — no new graph_run", async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(120);
    const panel = await connected({ holdRuns: true });
    const { token, ctx } = await uncertainOriginalRun(panel);
    panel.sock.send(JSON.stringify({ type: "run_receipt", run_rid: token, prompt_id: "p-receipt-only" }));
    // The exact late prompt receipt is reconciled by the bounded handoff (ticket),
    // but there is no retained reply body for the run.
    await waitFor(() => expect(RunCompletions.ticketFor("p-receipt-only")).toBeDefined());
    expect(bridge.peekLateMutation(token)).toBeUndefined();

    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    const res = await panelRun(ctx, { retry_of: token });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`panel_run (retry_of:"${token}") was NOT dispatched`);
    expect(textOf(res)).toMatch(/Do NOT re-run panel_run without retry_of/);
    expect(panel.runs, "a prompt receipt alone must not unlock a fresh graph_run").toHaveLength(1);
    panel.writes[0]?.release();
    await write;
  });

  it("a retry_of naming a DIFFERENT batch or branch is refused while edits are pending, and is never answered from the original's receipt", async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(120);
    const panel = await connected({ holdRuns: true, ledger: true });
    const { token, ctx } = await uncertainOriginalRun(panel);
    panel.releaseRun(0);
    await waitFor(() => expect(bridge.peekLateMutation(token)).toBeDefined());

    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    for (const changed of [{ batch_count: 3 }, { to_node_id: SAVE_NODE }]) {
      const res = await panelRun(ctx, { ...changed, retry_of: token });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain(`the SAME retry_of:"${token}"`);
    }
    expect(panel.runs).toHaveLength(1);
    panel.writes[0]?.release();
    await write;

    // Nothing pending now. The token names ONE single-batch full run; a 3-batch
    // retry is a different run and must not inherit its outcome.
    const other = await panelRun(ctx, { batch_count: 3, retry_of: token });
    expect(other.isError).toBe(true);
    expect(textOf(other)).toMatch(/different command or workflow/);
    expect(textOf(other)).not.toContain("p-2955-1");
    expect(panel.runs, "the panel's ledger refused it before executing").toHaveLength(1);
  });

  it("a token from ANOTHER tab's run while this tab has an edit pending is refused — no submission on either tab", async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(120);
    const panel = await connected();
    const other = await connected({ holdRuns: true }, TAB2);
    const { token } = await uncertainOriginalRun(other, TAB2);

    const ctx = newCtx();
    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    const res = await panelRun(ctx, { retry_of: token });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`retry_of:"${token}"`);
    expect(panel.runs).toHaveLength(0);
    expect(other.runs).toHaveLength(1);
    panel.writes[0]?.release();
    await write;
  });
});

describe("panel_run never reads forgotten receipt history as freshness (#2955)", () => {
  it("TTL keeps an awaiting write discoverable and turns an unknown one into uncertainty — zero graph_run until both settle", async () => {
    const panel = await connected();
    const lost = await bridge
      .send(
        { cmd: "graph_set_widget", node_id: SAVE_NODE, widget: "filename_prefix", value: NEW.filename_prefix },
        { tabId: TAB, timeoutMs: 40 },
      )
      .then(
        () => "acked",
        () => "timed out",
      );
    expect(lost).toBe("timed out");
    const uRid = bridge.listOutstandingMutations(TAB)[0]?.rid as string;
    const awaited = bridge.send(
      { cmd: "graph_set_widget", node_id: PROMPT_NODE, widget: "text", value: NEW.text },
      { tabId: TAB, timeoutMs: 60_000 },
    );
    await panel.writesArrived(2);

    // Eleven minutes later: past the bridge's ten-minute receipt TTL.
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 11 * 60_000);
    __panelToolsTestHooks.setRunFreshnessBarrierMs(80);
    const refused = await panelRun(newCtx());
    expect(refused.isError).toBe(true);
    expect(panel.runs).toHaveLength(0);
    expect(bridge.listAwaitedMutations(TAB), "the awaited write is never evicted").toHaveLength(1);
    expect(bridge.listUncertainTargets(TAB)).toEqual([
      expect.objectContaining({ tabId: TAB, count: 1, rids: [uRid], cmds: ["graph_set_widget"] }),
    ]);
    expect(bridge.mutationSettlement(uRid)).toBe("unknown");
    expect(textOf(refused)).toMatch(/dropped from the bridge's bounded receipt memory/);
    expect(textOf(refused)).toContain(`retry_of:"${uRid}"`);
    expect(textOf(refused)).toMatch(/awaiting the panel's reply/);

    panel.writes[1]?.release();
    await awaited;
    panel.writes[0]?.release(); // the evicted write's late reply: its definite outcome
    await waitFor(() => expect(bridge.listUncertainTargets(TAB)).toEqual([]));
    expect(bridge.mutationSettlement(uRid)).toBe("settled");
    const res = await panelRun(newCtx());
    expect(res.isError, textOf(res)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized).toEqual(NEW);
  });

  it("an evicted uncertainty is NOT cleared by any retry (its frame was not kept) — only by its own late reply", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    // No ledger: the panel holds no record of the original (fails open), so an
    // exact-looking retry executes fresh and returns a terminal success.
    const panel = await connected();
    const first = await setWidget(slowWriteCtx(), SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    const token = tokenOf(first);
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 11 * 60_000);
    expect(bridge.listUncertainTargets(TAB)[0]?.rids).toEqual([token]);
    expect(bridge.peekDeliveredMutation(token), "the full receipt itself is gone").toBeUndefined();

    const retry = defByName("panel_set_widget").handler(
      { node_id: SAVE_NODE, widget: "filename_prefix", value: NEW.filename_prefix, retry_of: token } as never,
      newCtx(),
    );
    await panel.writesArrived(2);
    panel.writes[1]?.release();
    expect((await retry).isError, "the retry itself succeeded").not.toBe(true);
    expect(bridge.listUncertainTargets(TAB)[0]?.rids, "…but proves nothing about the evicted original").toEqual([
      token,
    ]);
    const refused = await panelRun(newCtx());
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/does NOT clear them/);
    expect(textOf(refused)).toContain(`retry_of:"${token}"`);
    expect(panel.runs).toHaveLength(0);

    panel.writes[0]?.release(); // the ORIGINAL's own late reply: its definite outcome
    await waitFor(() => expect(bridge.listUncertainTargets(TAB)).toEqual([]));
    const res = await panelRun(newCtx());
    expect(res.isError, textOf(res)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
  });

  it("capacity overflow on another tab cannot evict this tab's awaiting write; the overflowed tab's uncertainty survives disconnects and binds only its own document", async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(80);
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    bridge.setTabGoneListener(() => {}, { graceMs: 60_000 });
    const panel = await connected();
    const other = await connected({ dropCmd: "graph_move_node" }, TAB2);

    const held = bridge.send(
      { cmd: "graph_set_widget", node_id: SAVE_NODE, widget: "filename_prefix", value: NEW.filename_prefix },
      { tabId: TAB, timeoutMs: 60_000 },
    );
    await panel.writesArrived(1);
    // 300 mutations on the other tab whose replies are lost: more receipts than the cache keeps.
    await Promise.all(
      Array.from({ length: 300 }, (_, i) =>
        bridge
          .send({ cmd: "graph_move_node", node_id: i + 1, pos: [0, 0] }, { tabId: TAB2, timeoutMs: 30 })
          .catch(() => undefined),
      ),
    );
    expect(other.dropped).toHaveLength(300);
    expect(bridge.listAwaitedMutations(TAB), "this tab's held write is still discoverable").toHaveLength(1);
    const evicted = bridge.listUncertainTargets(TAB2);
    expect(evicted).toHaveLength(1);
    expect(evicted[0]?.count).toBeGreaterThan(0);
    expect(
      (evicted[0]?.count ?? 0) + bridge.listUnsettledMutations(TAB2).length,
      "every unresolved outcome is accounted for — compacted, not dropped",
    ).toBe(300);
    expect(evicted[0]?.rids.length).toBeLessThan(evicted[0]?.count ?? 0);

    const here = await panelRun(newCtx());
    expect(here.isError).toBe(true);
    expect(textOf(here)).toMatch(/awaiting the panel's reply/);
    expect(panel.runs).toHaveLength(0);
    const there = await panelRun(newCtx(TAB2));
    expect(there.isError).toBe(true);
    expect(textOf(there)).toMatch(/bounded receipt memory/);
    expect(textOf(there)).toMatch(/not individually tracked/);
    expect(other.runs).toHaveLength(0);

    panel.writes[0]?.release();
    await held;
    const ok = await panelRun(newCtx());
    expect(ok.isError, textOf(ok)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);

    // The socket drops past its grace: that proves nothing about the document.
    other.sock.close();
    await waitFor(() => expect(bridge.canReach(TAB2)).toBe(false));
    bridge.__runTabGoneClocksForTest();
    expect(bridge.listUncertainTargets(TAB2), "grace expiry is not settlement").toHaveLength(1);
    // The SAME browser document comes back: its unknown edits still bind its runs.
    const back = await connected({}, TAB2);
    const stillRefused = await panelRun(newCtx(TAB2));
    expect(stillRefused.isError).toBe(true);
    expect(back.runs).toHaveLength(0);
    back.sock.close();
    await waitFor(() => expect(bridge.canReach(TAB2)).toBe(false));
    // A DIFFERENT browser tab opens the same workflow under the same key: another
    // in-memory graph, which the old document's edits cannot touch.
    const otherDocument = attachPanel(await connectPanel(TAB2, "browser-tab-2955-second-document"));
    await waitFor(() => expect(bridge.canReach(TAB2)).toBe(true));
    const fresh = await panelRun(newCtx(TAB2));
    expect(fresh.isError, textOf(fresh)).not.toBe(true);
    expect(otherDocument.runs).toHaveLength(1);
    expect(bridge.listUncertainTargets(TAB2), "…and the old document's uncertainty is kept").toHaveLength(1);
  });

  it("a surviving document that reconnects AFTER its grace still blocks runs until its edit's own outcome arrives", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    bridge.setTabGoneListener(() => {}, { graceMs: 60_000 });
    const panel = await connected();
    const first = await setWidget(slowWriteCtx(), SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    const token = tokenOf(first);

    panel.sock.close();
    await waitFor(() => expect(bridge.canReach(TAB)).toBe(false));
    bridge.__runTabGoneClocksForTest(); // declared gone — but the document is still alive
    const revived = await connectPanel(); // same tab_session_id: the same document
    const back = attachPanel(revived);
    await waitFor(() => expect(bridge.canReach(TAB)).toBe(true));

    const refused = await panelRun(newCtx());
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain(`retry_of:"${token}"`);
    expect(back.runs).toHaveLength(0);

    // The original edit finishes in that document and its late reply arrives.
    revived.send(
      JSON.stringify({
        rid: token,
        ok: true,
        result: { set: { node_id: SAVE_NODE, widget: "filename_prefix", previous: OLD.filename_prefix, value: NEW.filename_prefix } },
      }),
    );
    await waitFor(() => expect(bridge.mutationSettlement(token)).toBe("settled"));
    const res = await panelRun(newCtx());
    expect(res.isError, textOf(res)).not.toBe(true);
    expect(back.runs).toHaveLength(1);
  });
});

describe("retry_of settles an unknown edit only on proven same-receiver, same-command evidence (#2955)", () => {
  it("a same-widget/value retry answered on ANOTHER tab does not settle tab A's edit; A still blocks with its token", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    const panel = await connected({ ledger: true });
    const other = await connected({ ledger: true }, TAB2);
    const first = await setWidget(slowWriteCtx(), SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    const token = tokenOf(first);
    expect(bridge.peekDeliveredMutation(token)?.status).toBe("timed_out");

    // The session was re-pointed at tab B. B's ledger never saw the original, fails
    // open, and runs the replayed frame fresh: a terminal success — on B.
    const retry = defByName("panel_set_widget").handler(
      { node_id: SAVE_NODE, widget: "filename_prefix", value: NEW.filename_prefix, retry_of: token } as never,
      newCtx(TAB2),
    );
    await other.writesArrived(1);
    expect(other.writes[0]?.msg.retry_of).toBe(token);
    other.writes[0]?.release();
    expect((await retry).isError).not.toBe(true);
    expect(other.applyCount).toBe(1);

    expect(bridge.mutationSettlement(token), "B's answer is not A's outcome").toBe("unknown");
    const res = await panelRun(newCtx());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`that edit's own token retry_of:"${token}"`);
    expect(panel.runs).toHaveLength(0);
    expect(panel.applyCount, "the original on A is still held, never applied").toBe(0);
  });

  it("an EVICTED original's retry on another tab cannot clear A's marker either", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    const panel = await connected({ ledger: true });
    const other = await connected({ ledger: true }, TAB2);
    const first = await setWidget(slowWriteCtx(), SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    const token = tokenOf(first);
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 11 * 60_000);
    expect(bridge.listUncertainTargets(TAB)[0]?.rids).toEqual([token]);

    const retry = defByName("panel_set_widget").handler(
      { node_id: SAVE_NODE, widget: "filename_prefix", value: NEW.filename_prefix, retry_of: token } as never,
      newCtx(TAB2),
    );
    await other.writesArrived(1);
    other.writes[0]?.release();
    expect((await retry).isError).not.toBe(true);

    expect(bridge.listUncertainTargets(TAB)[0]?.rids).toEqual([token]);
    const res = await panelRun(newCtx());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`retry_of:"${token}"`);
    expect(panel.runs).toHaveLength(0);
  });

  it("a retry answered by a DIFFERENT browser document under the same tab key does not settle the original document's edit", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    const panel = await connected({ ledger: true });
    const first = await setWidget(slowWriteCtx(), SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    const token = tokenOf(first);
    panel.sock.close();
    await waitFor(() => expect(bridge.canReach(TAB)).toBe(false));

    // Another browser tab opens the same workflow under the same key. Its ledger has
    // never seen the token: the replayed frame runs fresh there and succeeds.
    const second = attachPanel(await connectPanel(TAB, "browser-tab-2955-second-document"), { ledger: true });
    await waitFor(() => expect(bridge.canReach(TAB)).toBe(true));
    const retry = defByName("panel_set_widget").handler(
      { node_id: SAVE_NODE, widget: "filename_prefix", value: NEW.filename_prefix, retry_of: token } as never,
      slowWriteCtx(),
    );
    await second.writesArrived(1);
    second.writes[0]?.release();
    expect((await retry).isError).not.toBe(true);
    expect(bridge.mutationSettlement(token), "another document's answer is not this edit's outcome").toBe("unknown");

    // The ORIGINAL document comes back: its edit's outcome is still unknown.
    second.sock.close();
    await waitFor(() => expect(bridge.canReach(TAB)).toBe(false));
    const back = attachPanel(await connectPanel());
    await waitFor(() => expect(bridge.canReach(TAB)).toBe(true));
    const res = await panelRun(newCtx());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`retry_of:"${token}"`);
    expect(back.runs).toHaveLength(0);
  });

  it("the same document re-registered under ANOTHER workflow tab id cannot settle the first tab's edit (tab binding)", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    const panel = await connected({ dropFirst: "graph_move_node" });
    const lost = await bridge
      .send({ cmd: "graph_move_node", node_id: 4, pos: [0, 0] }, { tabId: TAB, timeoutMs: 40 })
      .then(
        () => "acked",
        () => "timed out",
      );
    expect(lost).toBe("timed out");
    const original = bridge.listOutstandingMutations(TAB)[0]?.rid as string;
    // Same socket, same browser document, now registered under another workflow
    // tab id. The stamp resolver is constant here, so the tab id is the only thing
    // that tells the two canvases apart.
    panel.sock.send(helloFrame(TAB3));
    await waitFor(() => expect(bridge.canReach(TAB3)).toBe(true));
    let retryRid = "";
    await bridge.send(
      { cmd: "graph_move_node", node_id: 4, pos: [0, 0], retry_of: original },
      {
        tabId: TAB3,
        timeoutMs: 5000,
        onDispatchedRid: (rid) => {
          retryRid = rid;
        },
      },
    );
    expect(bridge.markMutationReconciled(original, retryRid), "answered for another tab's canvas").toBe(false);
    expect(bridge.mutationSettlement(original)).toBe("unknown");
  });

  it("a stray ack that the #2559 FIFO path hands to the retry's waiter does not prove the retry was answered", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    const panel = await connected(); // no ledger: the retry is a fresh, held write
    const first = await setWidget(slowWriteCtx(), SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    const token = tokenOf(first);
    const retry = defByName("panel_set_widget").handler(
      { node_id: SAVE_NODE, widget: "filename_prefix", value: NEW.filename_prefix, retry_of: token } as never,
      slowWriteCtx(5000),
    );
    await panel.writesArrived(2);
    // The graph already holds the value: the original's apply landed, but its reply
    // never did, which is the outcome-unknown case. panel_set_widget's single
    // post-write read-back (#2933) therefore observes it, and the retry handler
    // succeeds. That makes the bridge's own-rid check the ONLY thing standing
    // between the borrowed ack and a settled original; were the graph still old,
    // a read-back mismatch would block reconciliation on its own and this test
    // would no longer exercise that check.
    panel.values.filename_prefix = NEW.filename_prefix;
    // An ack under a rid nobody is waiting on, for the same node: the bridge hands it
    // to the retry's pending waiter so that call is not stranded (#2559).
    panel.sock.send(
      JSON.stringify({
        rid: "stray-ack-2955",
        ok: true,
        result: { set: { node_id: SAVE_NODE, widget: "filename_prefix", previous: OLD.filename_prefix, value: NEW.filename_prefix } },
      }),
    );
    const retryRes = await retry;
    expect(retryRes.isError).not.toBe(true);
    expect(
      JSON.parse(retryRes.content.find((c) => c.type === "text")?.text ?? "null").post_write_readback,
    ).toMatchObject({ status: "matched" });
    expect(bridge.mutationSettlement(token), "a borrowed ack is not the retry's own answer").toBe("unknown");
    // Nor did it settle the retry's OWN receipt: completing a waiter is not an
    // outcome. Each unknown must block on its own, so the run's refusal names BOTH
    // tokens and neither is masked by the other.
    const retryRid = panel.writes[1]?.msg.rid as string;
    expect(retryRid).toBeTruthy();
    expect(bridge.mutationSettlement(retryRid), "the borrowed ack did not settle the retry's own receipt").toBe(
      "unknown",
    );
    const blocked = await panelRun(newCtx());
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toContain(`that edit's own token retry_of:"${token}"`);
    expect(textOf(blocked)).toContain(`that edit's own token retry_of:"${retryRid}"`);
    expect(panel.runs).toHaveLength(0);

    // The retry's OWN definite reply settles the retry's receipt only. The original
    // stays unknown, so the run is still refused and still queues nothing.
    panel.writes[1]?.release();
    await waitFor(() => expect(bridge.mutationSettlement(retryRid)).toBe("settled"));
    expect(bridge.mutationSettlement(token)).toBe("unknown");
    const stillBlocked = await panelRun(newCtx());
    expect(stillBlocked.isError).toBe(true);
    expect(textOf(stillBlocked)).toContain(`that edit's own token retry_of:"${token}"`);
    expect(textOf(stillBlocked)).not.toContain(`retry_of:"${retryRid}"`);
    expect(panel.runs).toHaveLength(0);
  });

  it("the same tab under a DIFFERENT workflow cannot settle the old workflow's edit", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    // No ledger (an old or reset panel): a retry always executes fresh.
    const panel = await connected();
    const first = await setWidget(slowWriteCtx(), SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    const token = tokenOf(first);
    expect(bridge.peekDeliveredMutation(token)?.frame.workflow_uuid).toBe(WORKFLOW_UUID);

    workflowUuid = "44444444-4444-4444-8444-444444444444";
    const retry = defByName("panel_set_widget").handler(
      { node_id: SAVE_NODE, widget: "filename_prefix", value: NEW.filename_prefix, retry_of: token } as never,
      newCtx(),
    );
    await panel.writesArrived(2);
    expect(panel.writes[1]?.msg.workflow_uuid).toBe("44444444-4444-4444-8444-444444444444");
    panel.writes[1]?.release();
    expect((await retry).isError).not.toBe(true);
    expect(bridge.mutationSettlement(token), "another workflow's write is another command").toBe("unknown");

    workflowUuid = WORKFLOW_UUID; // back on the original workflow (A-B-A)
    const res = await panelRun(newCtx());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`retry_of:"${token}"`);
    expect(panel.runs).toHaveLength(0);
  });

  it("a non-widget retry with different effective args (same node) does not settle; the identical frame does", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    const panel = await connected({ dropFirst: "graph_move_node" });
    const lost = await bridge
      .send({ cmd: "graph_move_node", node_id: 4, pos: [0, 0] }, { tabId: TAB, timeoutMs: 40 })
      .then(
        () => "acked",
        () => "timed out",
      );
    expect(lost).toBe("timed out");
    const original = bridge.listOutstandingMutations(TAB)[0]?.rid as string;
    const retryRid = async (frame: Record<string, unknown>): Promise<string> => {
      let rid = "";
      await bridge.send(frame as { cmd: string }, {
        tabId: TAB,
        timeoutMs: 5000,
        onDispatchedRid: (r) => {
          rid = r;
        },
      });
      return rid;
    };

    // Same command name and node — what a cmd/node/widget/value hash would equate.
    const moved = await retryRid({ cmd: "graph_move_node", node_id: 4, pos: [7, 7], retry_of: original });
    expect(bridge.markMutationReconciled(original, moved), "a different position is a different command").toBe(false);
    expect(bridge.mutationSettlement(original)).toBe("unknown");
    expect((await panelRun(newCtx())).isError).toBe(true);
    expect(panel.runs).toHaveLength(0);

    // Positive control: the identical frame, same tab, same connection.
    const same = await retryRid({ cmd: "graph_move_node", node_id: 4, pos: [0, 0], retry_of: original });
    expect(bridge.markMutationReconciled(original, same)).toBe(true);
    expect(bridge.mutationSettlement(original)).toBe("settled");
    const res = await panelRun(newCtx());
    expect(res.isError, textOf(res)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
  });

  it("a retry whose frame differs from the original only in timeout_ms is a different fingerprint: rejected, nothing settles", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    const panel = await connected({ ledger: true });
    const first = await setWidget(slowWriteCtx(), SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    const token = tokenOf(first);
    const retry = await defByName("panel_set_widget").handler(
      { node_id: SAVE_NODE, widget: "filename_prefix", value: NEW.filename_prefix, retry_of: token } as never,
      newCtx(), // the tool's own 90 s timeout, not the original's
    );
    expect(retry.isError).toBe(true);
    expect(textOf(retry)).toMatch(/different command or workflow/);
    expect(bridge.mutationSettlement(token)).toBe("unknown");
    expect((await panelRun(newCtx())).isError).toBe(true);
    expect(panel.runs).toHaveLength(0);
    expect(panel.applyCount).toBe(0);
  });

  it("an explicit applied:\"unknown\" retry reply settles nothing, even with a set object", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    const panel = await connected({ dropFirst: "graph_set_widget" });
    const first = await setWidget(slowWriteCtx(), SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    const token = tokenOf(first);
    panel.sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString()) as Record<string, unknown>;
      if (msg.cmd !== "graph_set_widget" || msg.retry_of !== token) return;
      // Answer before the scripted handler does: an applied-unknown reply carrying a set.
      panel.sock.send(
        JSON.stringify({
          rid: msg.rid,
          ok: true,
          result: {
            applied: "unknown",
            set: { node_id: SAVE_NODE, widget: "filename_prefix", previous: OLD.filename_prefix, value: NEW.filename_prefix },
          },
        }),
      );
    });
    const retry = await defByName("panel_set_widget").handler(
      { node_id: SAVE_NODE, widget: "filename_prefix", value: NEW.filename_prefix, retry_of: token } as never,
      newCtx(),
    );
    expect(textOf(retry)).toContain("unknown");
    expect(bridge.mutationSettlement(token)).toBe("unknown");
    expect((await panelRun(newCtx())).isError).toBe(true);
    expect(panel.runs).toHaveLength(0);
  });

  it("positive control: an original LOST before the panel saw it is settled by its exact retry on the same tab", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    const panel = await connected({ ledger: true, dropFirst: "graph_set_widget" });
    const first = await setWidget(slowWriteCtx(), SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    const token = tokenOf(first);
    expect(panel.dropped).toHaveLength(1);

    const retry = defByName("panel_set_widget").handler(
      { node_id: SAVE_NODE, widget: "filename_prefix", value: NEW.filename_prefix, retry_of: token } as never,
      slowWriteCtx(),
    );
    await panel.writesArrived(1);
    panel.writes[0]?.release();
    expect((await retry).isError).not.toBe(true);
    expect(bridge.mutationSettlement(token)).toBe("settled");

    const barrier = observeBarrier();
    const res = await panelRun(newCtx());
    expect(barrier.calls).toEqual([]);
    expect(res.isError, textOf(res)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized.filename_prefix).toBe(NEW.filename_prefix);
    expect(panel.applyCount).toBe(1);
  });
});

describe("settlement needs the write's OWN definite outcome — waiter completion is not proof (#2955)", () => {
  const SET_RESULT = {
    set: { node_id: SAVE_NODE, widget: "filename_prefix", previous: OLD.filename_prefix, value: NEW.filename_prefix },
  };

  /** A write delivered by ANOTHER session (no intent in the run's ctx), held by the panel. */
  async function heldForeignWrite(panel: ScriptedPanel, timeoutMs = 60_000) {
    const sent = bridge
      .send(
        { cmd: "graph_set_widget", node_id: SAVE_NODE, widget: "filename_prefix", value: NEW.filename_prefix },
        { tabId: TAB, timeoutMs },
      )
      .then(
        (result) => ({ settled: "resolved" as const, result }),
        (err: unknown) => ({ settled: "rejected" as const, result: err }),
      );
    await panel.writesArrived(panel.writes.length + 1);
    const rid = panel.writes[panel.writes.length - 1]?.msg.rid as string;
    return { sent, rid };
  }

  it("a FIFO-borrowed ack completes the held write's waiter but not its settlement — the only prerequisite, zero graph_run", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    const panel = await connected();
    const { sent, rid } = await heldForeignWrite(panel);

    // An ack under a rid nobody is waiting on, for the same node (#2559 FIFO).
    panel.sock.send(JSON.stringify({ rid: "orphan-ack-2955", ok: true, result: SET_RESULT }));
    expect((await sent).settled, "the waiter is not stranded").toBe("resolved");
    expect(bridge.mutationSettlement(rid), "a borrowed ack is not this write's outcome").toBe("unknown");

    const barrier = observeBarrier();
    const res = await panelRun(newCtx()); // a separate session: no intent can mask the write
    expect(barrier.calls).toEqual([{ intents: 0, awaited: 0, unknown: 1 }]);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`that edit's own token retry_of:"${rid}"`);
    expect(panel.runs).toHaveLength(0);
    expect(panel.applyCount, "the actual write is still held").toBe(0);

    panel.writes[0]?.release(); // its OWN definite reply
    await waitFor(() => expect(bridge.mutationSettlement(rid)).toBe("settled"));
    const next = await panelRun(newCtx());
    expect(next.isError, textOf(next)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized.filename_prefix).toBe(NEW.filename_prefix);
  });

  it('an explicit applied:"unknown" under the write\'s OWN rid does not settle it: a concurrent run from another session refuses', async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(150);
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    const panel = await connected();
    const { sent, rid } = await heldForeignWrite(panel);
    const barrier = observeBarrier();
    const run = tracked(panelRun(newCtx()));
    expect((await firstOf(barrier, panel)).kind).toBe("barrier");

    panel.sock.send(JSON.stringify({ rid, ok: true, result: { applied: "unknown", ...SET_RESULT } }));
    expect((await sent).settled).toBe("resolved");
    const res = await run.promise;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`retry_of:"${rid}"`);
    expect(panel.runs).toHaveLength(0);
    expect(bridge.mutationSettlement(rid)).toBe("unknown");

    // Its own DEFINITE outcome arrives later: settled, and the run proceeds.
    panel.sock.send(JSON.stringify({ rid, ok: true, result: { applied: true, ...SET_RESULT } }));
    await waitFor(() => expect(bridge.mutationSettlement(rid)).toBe("settled"));
    const next = await panelRun(newCtx());
    expect(next.isError, textOf(next)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
  });

  it('a LATE applied:"unknown" reply to a timed-out write keeps the receipt unknown; a late definite one settles it', async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    const panel = await connected();
    const { sent, rid } = await heldForeignWrite(panel, 40);
    expect((await sent).settled).toBe("rejected");
    expect(bridge.mutationSettlement(rid)).toBe("unknown");

    panel.sock.send(JSON.stringify({ rid, ok: true, result: { applied: "unknown", ...SET_RESULT } }));
    expect(bridge.peekDeliveredMutation(rid)?.status, "the full receipt is kept").toBe("timed_out");
    expect(bridge.peekLateMutation(rid), "and no 'it applied' notice is minted").toBeUndefined();
    const refused = await panelRun(newCtx());
    expect(refused.isError).toBe(true);
    expect(panel.runs).toHaveLength(0);

    panel.sock.send(JSON.stringify({ rid, ok: true, result: SET_RESULT }));
    await waitFor(() => expect(bridge.mutationSettlement(rid)).toBe("settled"));
    const next = await panelRun(newCtx());
    expect(next.isError, textOf(next)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
  });

  it('a LATE applied:"unknown" reply to an EVICTED write keeps its marker; a late definite one clears it', async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(40);
    const panel = await connected();
    const { sent, rid } = await heldForeignWrite(panel, 40);
    expect((await sent).settled).toBe("rejected");
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 11 * 60_000);
    expect(bridge.listUncertainTargets(TAB)[0]?.rids).toEqual([rid]);

    panel.sock.send(JSON.stringify({ rid, ok: true, result: { applied: "unknown", ...SET_RESULT } }));
    expect(bridge.listUncertainTargets(TAB)[0]?.rids, "an unresolved answer clears nothing").toEqual([rid]);
    const refused = await panelRun(newCtx());
    expect(refused.isError).toBe(true);
    expect(panel.runs).toHaveLength(0);

    panel.sock.send(JSON.stringify({ rid, ok: false, error: "widget write refused by the panel" }));
    await waitFor(() => expect(bridge.listUncertainTargets(TAB)).toEqual([]));
    const next = await panelRun(newCtx());
    expect(next.isError, textOf(next)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
  });

  for (const [label, reply] of [
    ["applied:true", { ok: true, result: { applied: true, ...SET_RESULT } }],
    ["a terminal refusal", { ok: false, error: "widget write refused by the panel" }],
    ["applied:false (nothing applied)", { ok: true, result: { applied: false, reason: "value unchanged" } }],
  ] as const) {
    it(`positive control: a definite OWN reply (${label}) settles the write and the concurrent run proceeds`, async () => {
      const panel = await connected();
      const { sent, rid } = await heldForeignWrite(panel);
      const barrier = observeBarrier();
      const run = tracked(panelRun(newCtx()));
      expect((await firstOf(barrier, panel)).kind).toBe("barrier");

      panel.sock.send(JSON.stringify({ rid, ...reply }));
      await sent;
      const res = await run.promise;
      expect(res.isError, textOf(res)).not.toBe(true);
      expect(bridge.mutationSettlement(rid)).toBe("settled");
      expect(panel.runs).toHaveLength(1);
    });
  }
});

describe("receipts dispatched by a snapshotted edit call AFTER the snapshot still need their own outcome (#2955)", () => {
  const setResult = (nodeId: number, widget: keyof Widgets, value: string) => ({
    set: { node_id: nodeId, widget, previous: OLD[widget], value },
  });

  async function preflightRun(panel: ScriptedPanel, ctx: PanelToolCtx) {
    const barrier = observeBarrier();
    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    const run = tracked(panelRun(ctx));
    const first = await firstOf(barrier, panel);
    expect(first.kind).toBe("barrier");
    // Caught in its preflight: one intent, and no receipt exists yet.
    expect(first.kind === "barrier" && first.snapshot).toEqual({ intents: 1, awaited: 0, unknown: 0 });
    await panel.writesArrived(1);
    return { write, run, rid: panel.writes[0]?.msg.rid as string };
  }

  /**
   * panel_set_widget ends with ONE post-write read-back (#2933). The held write is
   * not applied, so put the value on the graph WITHOUT settling that write. The
   * borrowed ack then completes the setter with a matched read-back, and the run
   * is refused for the write's own still-unknown receipt alone, not for a
   * read-back mismatch, which would fail the call and mask the receipt.
   */
  function graphHoldsValueButWriteIsHeld(panel: ScriptedPanel, widget: keyof Widgets, value: string) {
    panel.values[widget] = value;
  }

  const readbackStatus = (res: ToolResult) =>
    (JSON.parse(res.content.find((c) => c.type === "text")?.text ?? "null") as Record<string, unknown> | null)
      ?.post_write_readback;

  it("a preflight write later completed by a BORROWED ack: zero graph_run until its own definite reply", async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(400);
    const panel = await connected();
    const ctx = newCtx();
    const { write, run, rid } = await preflightRun(panel, ctx);

    graphHoldsValueButWriteIsHeld(panel, "filename_prefix", NEW.filename_prefix);
    panel.sock.send(
      JSON.stringify({ rid: "orphan-ack-2955-r6", ok: true, result: setResult(SAVE_NODE, "filename_prefix", NEW.filename_prefix) }),
    );
    const writeRes = await write;
    expect(writeRes.isError, "the borrowed ack completes the setter without error").not.toBe(true);
    expect(readbackStatus(writeRes)).toMatchObject({ status: "matched" });
    expect(bridge.mutationSettlement(rid)).toBe("unknown");

    const res = await run.promise;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`that edit's own token retry_of:"${rid}"`);
    expect(textOf(res), "refused for the unknown receipt, not a failed call").not.toMatch(/FAILED:/);
    expect(panel.runs, "graph_run must not overtake the still-held write").toHaveLength(0);
    expect(panel.applyCount).toBe(0);

    panel.writes[0]?.release(); // the write's OWN definite reply
    await waitFor(() => expect(bridge.mutationSettlement(rid)).toBe("settled"));
    const next = await panelRun(ctx);
    expect(next.isError, textOf(next)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized.filename_prefix).toBe(NEW.filename_prefix);
  });

  it("positive control: a borrowed ack, then the write's own reply inside the window — the run waits and includes it", async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(5_000);
    const panel = await connected();
    const ctx = newCtx();
    const { write, run, rid } = await preflightRun(panel, ctx);

    graphHoldsValueButWriteIsHeld(panel, "filename_prefix", NEW.filename_prefix);
    panel.sock.send(
      JSON.stringify({ rid: "orphan-ack-2955-r6b", ok: true, result: setResult(SAVE_NODE, "filename_prefix", NEW.filename_prefix) }),
    );
    const writeRes = await write;
    expect(writeRes.isError).not.toBe(true);
    expect(readbackStatus(writeRes)).toMatchObject({ status: "matched" });
    expect(run.settled(), "still waiting on the write's own outcome").toBe(false);
    expect(panel.runs).toHaveLength(0);
    panel.writes[0]?.release();

    const res = await run.promise;
    expect(res.isError, textOf(res)).not.toBe(true);
    expect(bridge.mutationSettlement(rid)).toBe("settled");
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized.filename_prefix).toBe(NEW.filename_prefix);
  });

  it('a preflight write answered under its OWN rid with applied:"unknown": zero graph_run until a definite reply', async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(400);
    const panel = await connected();
    const ctx = newCtx();
    const { write, run, rid } = await preflightRun(panel, ctx);

    panel.sock.send(
      JSON.stringify({
        rid,
        ok: true,
        result: { applied: "unknown", ...setResult(SAVE_NODE, "filename_prefix", NEW.filename_prefix) },
      }),
    );
    // The setter takes no read-back for an explicit applied:"unknown" (#2933 reads back
    // only definite acknowledgements), so it returns without error and the run is
    // refused for the unknown receipt alone.
    expect((await write).isError).not.toBe(true);
    expect(bridge.mutationSettlement(rid)).toBe("unknown");
    const res = await run.promise;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`retry_of:"${rid}"`);
    expect(textOf(res), "refused for the unknown receipt, not a failed call").not.toMatch(/FAILED:/);
    expect(panel.runs).toHaveLength(0);

    panel.sock.send(
      JSON.stringify({ rid, ok: true, result: { applied: true, ...setResult(SAVE_NODE, "filename_prefix", NEW.filename_prefix) } }),
    );
    await waitFor(() => expect(bridge.mutationSettlement(rid)).toBe("settled"));
    const next = await panelRun(ctx);
    expect(next.isError, textOf(next)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
  });

  it("two edit calls on ONE session: each receipt is attributed to the call that sent it", async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(400);
    const panel = await connected();
    const ctx = newCtx();
    const barrier = observeBarrier();
    const prefix = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    const text = setWidget(ctx, PROMPT_NODE, "text", NEW.text);
    const run = tracked(panelRun(ctx));
    const first = await firstOf(barrier, panel);
    expect(first.kind === "barrier" && first.snapshot).toEqual({ intents: 2, awaited: 0, unknown: 0 });
    await panel.writesArrived(2);
    const ridOf = (widget: string) => panel.writes.find((w) => w.msg.widget === widget)?.msg.rid as string;
    const prefixRid = ridOf("filename_prefix");
    const textRid = ridOf("text");

    // The prefix write gets its own definite reply; the text write only a borrowed ack.
    panel.writes.find((w) => w.msg.rid === prefixRid)?.release();
    graphHoldsValueButWriteIsHeld(panel, "text", NEW.text);
    panel.sock.send(JSON.stringify({ rid: "orphan-ack-2955-r6c", ok: true, result: setResult(PROMPT_NODE, "text", NEW.text) }));
    expect((await prefix).isError).not.toBe(true);
    const textRes = await text;
    expect(textRes.isError).not.toBe(true);
    expect(readbackStatus(textRes)).toMatchObject({ status: "matched" });

    const res = await run.promise;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`retry_of:"${textRid}"`);
    expect(textOf(res), "refused for the unknown receipt, not a failed call").not.toMatch(/FAILED:/);
    expect(textOf(res), "the settled write is not reported as open").not.toContain(prefixRid);
    expect(panel.runs).toHaveLength(0);
  });
});

describe("panel_run observes earlier acknowledged mutations before serialization (#2955) — concurrency", () => {
  it("concurrent runs do not wait on each other's graph_run acknowledgement", async () => {
    const sock = await connectPanel();
    const runFrames: string[] = [];
    let firstRid: string | undefined;
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString()) as Record<string, unknown>;
      if (typeof msg.rid !== "string" || typeof msg.cmd !== "string") return;
      if (msg.cmd !== "graph_run") {
        sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { ok: true } }));
        return;
      }
      runFrames.push(msg.rid);
      // Hold the FIRST run's ack; answer the second at once.
      if (!firstRid) {
        firstRid = msg.rid;
        return;
      }
      sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { queued: true, prompt_id: "p-second" } }));
    });
    await waitFor(() => expect(bridge.canReach(TAB)).toBe(true));
    const ctx = newCtx();
    const barrier = observeBarrier();

    const first = tracked(panelRun(ctx));
    await waitFor(() => expect(runFrames).toHaveLength(1));
    const second = await panelRun(ctx, { allow_duplicate: true });
    expect(second.isError, textOf(second)).not.toBe(true);
    expect(runFrames).toHaveLength(2);
    expect(first.settled()).toBe(false);
    expect(barrier.calls, "an in-flight graph_run must not hold the next run").toEqual([]);

    sock.send(JSON.stringify({ rid: firstRid, ok: true, result: { queued: true, prompt_id: "p-first" } }));
    expect((await first.promise).isError).not.toBe(true);
  });

  it("a sequential write-then-run has nothing outstanding and carries no freshness note", async () => {
    const panel = await connected();
    const ctx = newCtx();
    const write = setWidget(ctx, SAVE_NODE, "filename_prefix", NEW.filename_prefix);
    await panel.writesArrived(1);
    panel.writes[0]?.release();
    expect((await write).isError).not.toBe(true);
    expect(bridge.listAwaitedMutations(TAB)).toHaveLength(0);
    const barrier = observeBarrier();

    const res = await panelRun(ctx);
    expect(barrier.calls, "nothing outstanding: no wait at all").toEqual([]);
    expect(res.isError, textOf(res)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized.filename_prefix).toBe(NEW.filename_prefix);
    expect(textOf(res)).not.toMatch(/OUTCOME UNKNOWN|NOT dispatched/);
  });
});

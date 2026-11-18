// COMBINED integration: #2955 run freshness (PR2992) x widget write receipts
// (#2918 / #2931 / #2933, PR2991).
//
// Each case drives the SHIPPED panel_set_widget and panel_run definitions through
// makePanelToolCtx and a real UiBridge over a WebSocket. The scripted panel on the other
// end answers the wire protocol. It resolves node identities for the setter's preflight,
// applies graph_set_widget, can run "node code" after it acknowledges a write, serves the
// setter's post-write graph read from its live values, and serializes graph_run from its
// live values when the frame ARRIVES. It also models the panel's rid ledger for retry_of.
// Every frame it receives is logged in arrival order, so ordering and counts are
// asserted on the wire, not inferred from handler return values.
//
// Scope (unchanged by the combination):
//   - the barrier covers OVERLAPPING calls only;
//   - a write's single read-back is one observation, not durability;
//   - nothing is ever replayed automatically.

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

const TAB = "wf:workflows/canvas_combined.json";
const WORKFLOW_A = "33333333-3333-4333-8333-333333333333";
const WORKFLOW_B = "44444444-4444-4444-8444-444444444444";
const GRAPH_A = "graph:root-combined-A";
const GRAPH_B = "graph:root-combined-B";

const PROMPT = 6;
const SAVE = 9;
const LORA = 12;
const REFINER = 13;

type NodeSpec = { type: string; widgets: Record<string, unknown> };

function initialNodes(): Map<number, NodeSpec> {
  return new Map<number, NodeSpec>([
    [PROMPT, { type: "CLIPTextEncode", widgets: { text: "scout 03 full body" } }],
    [SAVE, { type: "SaveImage", widgets: { filename_prefix: "Chizu_V02_Scout_03" } }],
    [
      LORA,
      { type: "Lora Loader (LoraManager)", widgets: { text: "", loras: [], strength_model: 1 } },
    ],
    [REFINER, { type: "DenoLocalLLMRefiner", widgets: { system_prompt: "OLD planner prompt" } }],
  ]);
}

let bridge: UiBridge;
let port: number;
/** What the bridge resolves as TAB's workflow stamp (a test flips it to model a replacement). */
let workflowUuid = WORKFLOW_A;

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
      // Production installs this in orchestrator/index.ts.
      bridge.setLateMutationFilter((cmdName) => RETRY_TOKEN_CMDS.has(cmdName));
      return;
    }
    lastErr = `bind to ${port} lost a close->rebind race`;
    await bridge.stop();
  }
  throw new Error(`could not bind a free bridge port after 6 attempts: ${lastErr}`);
}

type Frame = Record<string, unknown> & { cmd: string; rid: string };

type PanelOpts = {
  /** Hold every fresh graph_set_widget until the test releases it. */
  holdWrites?: boolean;
  /** Hold every fresh graph_run reply (its ack never arrives unless released). */
  holdRuns?: boolean;
  /** Older panel: rows carry no node_identity. */
  noIdentity?: boolean;
  /** Node code run synchronously right AFTER the panel acknowledged a write. */
  afterAck?: (nodeId: number, widget: string, panel: ScriptedPanel) => void;
  /** Answer the setter's post-write detail read with an error. */
  failReadbackFor?: number;
  /** Park every frame of this read command until releaseReads(). */
  holdRead?: string;
};

type ScriptedPanel = {
  nodes: Map<number, NodeSpec>;
  /** node incarnation suffix per node id (bump to model a same-id replacement) */
  incarnation: Map<number, number>;
  graphIdentity: string;
  viewingWorkflow: string;
  readonly frames: Frame[];
  readonly runs: Array<{ rid: string; serialized: Record<string, Record<string, unknown>> }>;
  readonly applyCount: number;
  readonly ledgerAnswers: number;
  heldWrites: Array<() => void>;
  releaseWrites(): void;
  heldReads: Array<() => void>;
  releaseReads(): void;
  releaseRun(i: number): void;
  writesArrived(n: number): Promise<void>;
  sock: WebSocket;
};

function framesOf(panel: ScriptedPanel, cmd: string): Frame[] {
  return panel.frames.filter((f) => f.cmd === cmd);
}

/** Index of the setter's post-write detail read for `nodeId` (after its graph_set_widget). */
function readbackIndex(panel: ScriptedPanel, nodeId: number): number {
  const setAt = panel.frames.findIndex(
    (f) => f.cmd === "graph_set_widget" && Number(f.node_id) === nodeId,
  );
  if (setAt < 0) return -1;
  return panel.frames.findIndex(
    (f, i) =>
      i > setAt &&
      f.cmd === "graph_query" &&
      f.fields === "detail" &&
      Array.isArray(f.ids) &&
      f.ids.length === 1 &&
      Number(f.ids[0]) === nodeId,
  );
}

function attachPanel(sock: WebSocket, opts: PanelOpts = {}): ScriptedPanel {
  const send = (frame: Record<string, unknown>) => sock.send(JSON.stringify(frame));
  const frames: Frame[] = [];
  const runs: ScriptedPanel["runs"] = [];
  const writeWaiters: Array<{ n: number; resolve: () => void }> = [];
  let applyCount = 0;
  let ledgerAnswers = 0;
  let writeArrivals = 0;
  type Entry = { fp: string; reply?: Record<string, unknown>; joiners: string[] };
  const runLedger = new Map<string, Entry>();
  // The panel's commandFingerprint (comfyui-mcp-panel web/js/lib/command-dedupe.js): the
  // WHOLE frame minus rid and retry_of, stably stringified. The bridge-written
  // workflow_uuid stamp and timeout_ms are therefore part of it.
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

  const panel: ScriptedPanel = {
    nodes: initialNodes(),
    incarnation: new Map(),
    graphIdentity: GRAPH_A,
    viewingWorkflow: WORKFLOW_A,
    frames,
    runs,
    get applyCount() {
      return applyCount;
    },
    get ledgerAnswers() {
      return ledgerAnswers;
    },
    heldWrites: [],
    releaseWrites() {
      for (const release of panel.heldWrites.splice(0)) release();
    },
    heldReads: [],
    releaseReads() {
      for (const answer of panel.heldReads.splice(0)) answer();
    },
    releaseRun(i: number) {
      const run = runs[i];
      if (!run) throw new Error(`no graph_run #${i} reached the panel`);
      const reply = { rid: run.rid, ok: true, result: { queued: true, prompt_id: `p-combined-${i + 1}` } };
      send(reply);
      const entry = runLedger.get(run.rid);
      if (entry) {
        entry.reply = reply;
        for (const joiner of entry.joiners.splice(0)) send({ ...reply, rid: joiner });
      }
    },
    writesArrived(n: number) {
      if (writeArrivals >= n) return Promise.resolve();
      return new Promise((resolve) => writeWaiters.push({ n, resolve }));
    },
    sock,
  };

  const viewing = () => ({
    scope: "root",
    kind: "root",
    workflow: "canvas_combined.json",
    workflow_uuid: panel.viewingWorkflow,
    graph_identity: panel.graphIdentity,
  });
  const row = (id: number) => {
    const node = panel.nodes.get(id);
    if (!node) return null;
    return {
      id,
      type: node.type,
      is_subgraph: false,
      ...(opts.noIdentity ? {} : { node_identity: `node:${id}:${panel.incarnation.get(id) ?? 0}` }),
      widgets: { ...node.widgets },
      inputs: [],
    };
  };
  const snapshot = () => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [id, node] of panel.nodes) out[String(id)] = { ...node.widgets };
    return out;
  };

  sock.on("message", (buf) => {
    const msg = JSON.parse(buf.toString()) as Record<string, unknown>;
    if (typeof msg.rid !== "string" || typeof msg.cmd !== "string") return;
    const frame = msg as Frame;
    frames.push(frame);
    const rid = frame.rid;

    if (frame.cmd === "graph_set_widget") {
      writeArrivals += 1;
      for (const w of writeWaiters.splice(0)) {
        if (writeArrivals >= w.n) w.resolve();
        else writeWaiters.push(w);
      }
      const apply = () => {
        const id = Number(frame.node_id);
        const node = panel.nodes.get(id);
        const widget = String(frame.widget);
        if (!node || !(widget in node.widgets)) {
          send({ rid, ok: false, error: `Node ${id} has no widget "${widget}". Nothing was written.` });
          return;
        }
        const previous = node.widgets[widget];
        node.widgets[widget] = frame.value;
        applyCount += 1;
        send({ rid, ok: true, result: { set: { node_id: frame.node_id, widget, previous, value: frame.value } } });
        // The acknowledgement is on the wire; node code may now act before the
        // panel serves its next frame (the setter's read-back).
        opts.afterAck?.(id, widget, panel);
      };
      if (opts.holdWrites) panel.heldWrites.push(apply);
      else apply();
      return;
    }

    if (frame.cmd === "graph_run") {
      const fp = fingerprint(frame);
      if (typeof frame.retry_of === "string") {
        // The panel's rid ledger: an exact retry of a retained original joins or
        // replays it (no second execution); a different fingerprint is rejected.
        const original = runLedger.get(frame.retry_of);
        if (original) {
          ledgerAnswers += 1;
          if (original.fp !== fp) {
            send({ rid, ok: false, error: "Retry rejected: retry_of refers to a different command or workflow." });
          } else if (original.reply) {
            send({ ...original.reply, rid });
          } else {
            original.joiners.push(rid);
          }
          return;
        }
      }
      runLedger.set(rid, { fp, joiners: [] });
      runs.push({ rid, serialized: snapshot() });
      if (opts.holdRuns) return;
      panel.releaseRun(runs.length - 1);
      return;
    }

    if (opts.holdRead && frame.cmd === opts.holdRead) {
      panel.heldReads.push(() => send({ rid, ok: true, result: { errors: [] } }));
      return;
    }

    if (frame.cmd === "graph_query" || frame.cmd === "graph_get_subgraph") {
      const ids = Array.isArray(frame.ids) ? frame.ids : [frame.node_id ?? PROMPT];
      const isReadback =
        frame.cmd === "graph_query" && frame.fields === "detail" && ids.length === 1 &&
        frames.some((f) => f.cmd === "graph_set_widget" && Number(f.node_id) === Number(ids[0]));
      if (isReadback && opts.failReadbackFor === Number(ids[0])) {
        send({ rid, ok: false, error: "graph_query failed: the tab is busy" });
        return;
      }
      if (frame.cmd === "graph_get_subgraph") {
        const id = Number(ids[0]);
        send({ rid, ok: false, error: `Node ${id} (${panel.nodes.get(id)?.type}) is not a subgraph` });
        return;
      }
      const rows = ids.map((id) => row(Number(id))).filter((r) => r !== null);
      send({ rid, ok: true, result: { viewing: viewing(), truncated: false, nodes: rows, node_count: rows.length } });
      return;
    }

    send({ rid, ok: true, result: { ok: true } });
  });
  return panel;
}

function connectPanel(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    sock.on("open", () => {
      sock.send(
        JSON.stringify({
          type: "hello",
          tab_id: TAB,
          title: "canvas_combined",
          tab_session_id: "browser-tab-combined",
          enforces_workflow_stamp: true,
          enforces_workflow_stamp_at_write: true,
          enforces_expected_node_type_at_write: true,
          enforces_expected_node_identity_at_write: true,
        }),
      );
      resolve(sock);
    });
    sock.on("error", reject);
  });
}

async function connected(opts: PanelOpts = {}): Promise<ScriptedPanel> {
  const sock = await connectPanel();
  const panel = attachPanel(sock, opts);
  await waitFor(() => expect(bridge.canReach(TAB)).toBe(true));
  return panel;
}

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} is not registered`);
  return def;
}

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

function jsonOf(res: ToolResult): Record<string, unknown> {
  return JSON.parse(res.content.find((c) => c.type === "text")?.text ?? "null") as Record<string, unknown>;
}

const readbackOf = (res: ToolResult) =>
  (jsonOf(res).post_write_readback ?? {}) as Record<string, unknown>;

function newCtx(): PanelToolCtx {
  return makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
}

function setWidget(ctx: PanelToolCtx, nodeId: number, widget: string, value: string) {
  return defByName("panel_set_widget").handler({ node_id: nodeId, widget, value } as never, ctx);
}

function panelRun(ctx: PanelToolCtx, args: Record<string, unknown> = {}) {
  return defByName("panel_run").handler(args as never, ctx);
}

/** Resolves once panel_run has entered its freshness wait (ordered against the barrier, not a clock). */
function barrierEntered(): Promise<{ intents: number; awaited: number; unknown: number }> {
  return new Promise((resolve) => {
    __panelToolsTestHooks.setRunFreshnessWaitObserver((snapshot) => resolve(snapshot));
  });
}

/** Node code that puts the PREVIOUS value back after the acknowledgement (setupNode-style). */
function restorePrevious(target: number, widget: string, previous: unknown): PanelOpts["afterAck"] {
  return (id, w, panel) => {
    if (id === target && w === widget) panel.nodes.get(id)!.widgets[widget] = previous;
  };
}

beforeEach(async () => {
  workflowUuid = WORKFLOW_A;
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

describe("combined: ordinary writes with read-back, then a concurrent run (#2955 x #2933)", () => {
  it("prompt + filename + run issued together: the run serializes BOTH new values after both read-backs", async () => {
    const panel = await connected({ holdWrites: true });
    const ctx = newCtx();

    const entered = barrierEntered();
    const text = setWidget(ctx, PROMPT, "text", "scout 04 full body safe");
    const prefix = setWidget(ctx, SAVE, "filename_prefix", "Chizu_V02_Scout_04_Safe");
    const run = panelRun(ctx);

    expect((await entered).intents).toBe(2);
    await panel.writesArrived(2);
    expect(panel.runs, "graph_run reached the serializer before the writes applied").toHaveLength(0);
    panel.releaseWrites();
    const [textRes, prefixRes, runRes] = await Promise.all([text, prefix, run]);

    // Each write is acknowledged AND observed once by its own read-back.
    for (const res of [textRes, prefixRes]) {
      expect(res.isError, textOf(res)).not.toBe(true);
      expect(readbackOf(res)).toMatchObject({ status: "matched" });
      expect(String(readbackOf(res).note)).toMatch(/cannot see a later change/);
    }
    // The run queued once and serialized the new values.
    expect(runRes.isError, textOf(runRes)).not.toBe(true);
    expect(textOf(runRes)).toContain("p-combined-1");
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized[String(PROMPT)]).toEqual({ text: "scout 04 full body safe" });
    expect(panel.runs[0]?.serialized[String(SAVE)]).toEqual({ filename_prefix: "Chizu_V02_Scout_04_Safe" });

    // Wire counts and order: two writes, one read-back each, ONE graph_run, which
    // arrived only after both read-backs (the barrier waits for the whole setter call).
    expect(framesOf(panel, "graph_set_widget")).toHaveLength(2);
    expect(framesOf(panel, "graph_run")).toHaveLength(1);
    expect(panel.applyCount).toBe(2);
    const runAt = panel.frames.findIndex((f) => f.cmd === "graph_run");
    const promptReadback = readbackIndex(panel, PROMPT);
    const saveReadback = readbackIndex(panel, SAVE);
    expect(promptReadback).toBeGreaterThan(-1);
    expect(saveReadback).toBeGreaterThan(-1);
    expect(runAt).toBeGreaterThan(Math.max(promptReadback, saveReadback));
    // The run receipt makes no claim about the widgets' verification.
    expect(textOf(runRes)).not.toMatch(/post_write_readback|matched/);
  });
});

describe("combined: a refused or not-observed prerequisite blocks the dependent concurrent run", () => {
  it("a derived-widget refusal (LoraManager text) concurrent with a run: no write, no graph_run", async () => {
    const panel = await connected();
    const ctx = newCtx();

    const entered = barrierEntered();
    const lora = setWidget(ctx, LORA, "text", "<lora:VIA_Breast_Anima:0.8>");
    const run = panelRun(ctx);
    expect((await entered).intents).toBe(1);
    const [loraRes, runRes] = await Promise.all([lora, run]);

    expect(loraRes.isError).toBe(true);
    expect(textOf(loraRes)).toContain('cannot set "text" on Lora Loader (LoraManager)');
    expect(textOf(loraRes)).toMatch(/No graph_set_widget was dispatched/);
    expect(runRes.isError).toBe(true);
    expect(textOf(runRes)).toMatch(/panel_run was NOT dispatched/);
    expect(textOf(runRes)).toMatch(/FAILED: panel_set_widget returned an error/);
    expect(framesOf(panel, "graph_set_widget")).toHaveLength(0);
    expect(framesOf(panel, "graph_run")).toHaveLength(0);

    // An explicit run on its own renders the graph as it stands (text still empty).
    const later = await panelRun(ctx);
    expect(later.isError, textOf(later)).not.toBe(true);
    expect(panel.runs).toHaveLength(1);
    expect(panel.runs[0]?.serialized[String(LORA)]).toMatchObject({ text: "" });
  });

  it("an immediate read-back mismatch fails the setter and refuses the concurrent run: one write, zero graph_run, no replay", async () => {
    const panel = await connected({
      afterAck: restorePrevious(REFINER, "system_prompt", "OLD planner prompt"),
    });
    const ctx = newCtx();

    const entered = barrierEntered();
    const write = setWidget(ctx, REFINER, "system_prompt", "NEW planner prompt");
    const run = panelRun(ctx);
    expect((await entered).intents).toBe(1);
    const [writeRes, runRes] = await Promise.all([write, run]);

    expect(writeRes.isError).toBe(true);
    expect(jsonOf(writeRes)).toMatchObject({
      acknowledged: true,
      value_observed_after_write: false,
      post_write_readback: {
        status: "mismatch",
        observed: "OLD planner prompt",
        observed_equals_previous: true,
        confirmed_by: "graph read after write",
      },
    });
    expect(String(jsonOf(writeRes).note)).toMatch(/not that the write never applied, and not why/);
    expect(runRes.isError).toBe(true);
    expect(textOf(runRes)).toMatch(/FAILED: panel_set_widget returned an error/);
    expect(framesOf(panel, "graph_set_widget"), "the mismatch must not be replayed").toHaveLength(1);
    expect(framesOf(panel, "graph_run")).toHaveLength(0);
    expect(panel.applyCount).toBe(1);

    // A later explicit run serializes what the graph actually holds.
    const later = await panelRun(ctx);
    expect(later.isError, textOf(later)).not.toBe(true);
    expect(panel.runs[0]?.serialized[String(REFINER)]).toEqual({ system_prompt: "OLD planner prompt" });
    expect(framesOf(panel, "graph_set_widget")).toHaveLength(1);
  });
});

describe("combined: a preflight write's own receipt still gates the run after a borrowed ack + matched read-back (#2955 x #2933)", () => {
  it("a borrowed ack completes the setter with a MATCHED read-back, yet the run waits for the write's own definite reply; a later independent edit is excluded", async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(5_000);
    const panel = await connected({ holdWrites: true });
    const ctx = newCtx();

    // Write A and the run issued together: the run's snapshot sees A only as an
    // intent in its preflight (no receipt exists yet).
    const entered = barrierEntered();
    const writeA = setWidget(ctx, SAVE, "filename_prefix", "Chizu_V02_Scout_11");
    let runDone = false;
    const run = panelRun(ctx).finally(() => {
      runDone = true;
    });
    expect(await entered).toEqual({ intents: 1, awaited: 0, unknown: 0 });
    await panel.writesArrived(1);
    const ridA = framesOf(panel, "graph_set_widget")[0]!.rid;

    // The graph shows A's value although A's frame is still held (not applied by the
    // panel), and an ack under a rid nobody awaits is handed to A's waiter (#2559 FIFO).
    panel.nodes.get(SAVE)!.widgets.filename_prefix = "Chizu_V02_Scout_11";
    panel.sock.send(
      JSON.stringify({
        rid: "orphan-ack-combined",
        ok: true,
        result: { set: { node_id: SAVE, widget: "filename_prefix", previous: "Chizu_V02_Scout_03", value: "Chizu_V02_Scout_11" } },
      }),
    );
    const writeARes = await writeA;
    expect(writeARes.isError, textOf(writeARes)).not.toBe(true);
    expect(readbackOf(writeARes)).toMatchObject({ status: "matched" });
    expect(bridge.mutationSettlement(ridA), "a borrowed ack is not A's outcome").toBe("unknown");
    expect(panel.applyCount).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runDone, "the run must keep waiting for A's own outcome").toBe(false);
    expect(framesOf(panel, "graph_run")).toHaveLength(0);

    // A LATER, independent edit from another session, issued after the run started:
    // not part of the run's snapshot, so the run must not wait for it.
    const writeB = setWidget(newCtx(), PROMPT, "text", "scout 11 later edit");
    await panel.writesArrived(2);
    const ridB = framesOf(panel, "graph_set_widget")[1]!.rid;

    // A's OWN definite reply: the run proceeds once, with B still held.
    panel.heldWrites.shift()!();
    const runRes = await run;
    expect(runRes.isError, textOf(runRes)).not.toBe(true);
    expect(bridge.mutationSettlement(ridA)).toBe("settled");
    expect(framesOf(panel, "graph_run")).toHaveLength(1);
    expect(panel.runs[0]?.serialized[String(SAVE)]).toEqual({ filename_prefix: "Chizu_V02_Scout_11" });
    expect(panel.runs[0]?.serialized[String(PROMPT)], "the later edit is not absorbed").toEqual({
      text: "scout 03 full body",
    });
    expect(textOf(runRes)).not.toContain(ridB);

    // B completes normally afterwards; nothing was replayed.
    panel.releaseWrites();
    const writeBRes = await writeB;
    expect(readbackOf(writeBRes)).toMatchObject({ status: "matched" });
    expect(framesOf(panel, "graph_set_widget")).toHaveLength(2);
  });
});

describe("combined: an unverified acknowledgement stays unverified and is never execution proof", () => {
  it.each([
    ["the panel publishes no node incarnation", { noIdentity: true } as PanelOpts, /did not publish a node incarnation/],
    ["the read-back itself fails", { failReadbackFor: PROMPT } as PanelOpts, /graph read failed/],
  ] as const)("%s: the run proceeds on the acknowledgement; neither receipt claims verification", async (_label, opts, reason) => {
    const panel = await connected(opts);
    const ctx = newCtx();

    const entered = barrierEntered();
    const write = setWidget(ctx, PROMPT, "text", "scout 05");
    const run = panelRun(ctx);
    expect((await entered).intents).toBe(1);
    const [writeRes, runRes] = await Promise.all([write, run]);

    // The setter keeps the panel's acknowledgement, explicitly unverified.
    expect(writeRes.isError, textOf(writeRes)).not.toBe(true);
    expect(jsonOf(writeRes).set).toMatchObject({ widget: "text", value: "scout 05" });
    const readback = readbackOf(writeRes);
    expect(readback.status).toBe("unverified");
    expect(String(readback.reason)).toMatch(reason);
    expect(String(readback.note)).toMatch(/current value was not verified/);
    expect(String(readback.note)).toMatch(/not a durability or execution claim/);

    // The run treats a non-error acknowledgement as a settled prerequisite (the
    // reviewed #2955 contract) and queues once; it never restates the edit as verified.
    expect(runRes.isError, textOf(runRes)).not.toBe(true);
    expect(framesOf(panel, "graph_run")).toHaveLength(1);
    expect(textOf(runRes)).not.toMatch(/post_write_readback|matched|value_observed/);
    expect(framesOf(panel, "graph_set_widget")).toHaveLength(1);
  });
});

describe("combined: the setter's read-back shares the tab's graph lane (latency coupling)", () => {
  it("a read already holding the lane delays the write's read-back and therefore the concurrent run; nothing is skipped or replayed", async () => {
    const panel = await connected({ holdWrites: true, holdRead: "graph_get_errors" });
    const ctx = newCtx();

    const entered = barrierEntered();
    let writeDone = false;
    const write = setWidget(ctx, PROMPT, "text", "scout 10").finally(() => {
      writeDone = true;
    });
    const run = panelRun(ctx);
    await entered;
    await panel.writesArrived(1);
    // Another caller's graph read takes the tab's graph lane (#2069: reads hold it
    // until answered) while the write is still being applied.
    const read = bridge.send({ cmd: "graph_get_errors" }, { tabId: TAB, timeoutMs: 15000 });
    await waitFor(() => expect(panel.heldReads).toHaveLength(1));
    panel.releaseWrites();
    // The write is acknowledged, but its read-back queues behind the held read, so
    // the setter call (and the run waiting on it) cannot finish yet.
    await waitFor(() => expect(panel.applyCount).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readbackIndex(panel, PROMPT), "read-back overtook the held lane read").toBe(-1);
    expect(writeDone).toBe(false);
    expect(framesOf(panel, "graph_run")).toHaveLength(0);

    panel.releaseReads();
    await read;
    const [writeRes, runRes] = await Promise.all([write, run]);
    expect(readbackOf(writeRes)).toMatchObject({ status: "matched" });
    expect(runRes.isError, textOf(runRes)).not.toBe(true);
    const getErrorsAt = panel.frames.findIndex((f) => f.cmd === "graph_get_errors");
    expect(readbackIndex(panel, PROMPT)).toBeGreaterThan(getErrorsAt);
    expect(panel.frames.findIndex((f) => f.cmd === "graph_run")).toBeGreaterThan(readbackIndex(panel, PROMPT));
    expect(panel.runs[0]?.serialized[String(PROMPT)]).toEqual({ text: "scout 10" });
    expect(framesOf(panel, "graph_set_widget")).toHaveLength(1);
  });
});

describe("combined: delayed changes and target switches", () => {
  it("a change AFTER the single read-back is not caught: 'matched' was one observation, and a sequential run serializes the later value", async () => {
    const panel = await connected();
    const ctx = newCtx();

    const writeRes = await setWidget(ctx, PROMPT, "text", "scout 06");
    expect(readbackOf(writeRes)).toMatchObject({ status: "matched" });
    expect(String(readbackOf(writeRes).note)).toMatch(/cannot see a later change; if a run must use this value, panel_query_graph the node again first/);

    // Node code (or another editor) changes the widget after the read-back.
    panel.nodes.get(PROMPT)!.widgets.text = "scout 03 full body";

    // A run issued AFTER the write returned is sequential: there is nothing to wait for.
    const runRes = await panelRun(ctx);
    expect(runRes.isError, textOf(runRes)).not.toBe(true);
    expect(panel.runs[0]?.serialized[String(PROMPT)]).toEqual({ text: "scout 03 full body" });
    expect(framesOf(panel, "graph_set_widget")).toHaveLength(1);
  });

  it("a workflow replacement while the run waits: the run refuses unsent and the write's read-back is unverified (not matched)", async () => {
    const panel = await connected({ holdWrites: true });
    const ctx = newCtx();

    const entered = barrierEntered();
    const write = setWidget(ctx, SAVE, "filename_prefix", "Chizu_V02_Scout_07");
    const run = panelRun(ctx);
    await entered;
    await panel.writesArrived(1);
    // Same tab, different workflow: the bridge stamp and the panel's viewing both move.
    workflowUuid = WORKFLOW_B;
    panel.viewingWorkflow = WORKFLOW_B;
    panel.graphIdentity = GRAPH_B;
    panel.releaseWrites();
    const [writeRes, runRes] = await Promise.all([write, run]);

    expect(runRes.isError).toBe(true);
    expect(textOf(runRes)).toMatch(/panel_run was NOT dispatched/);
    expect(textOf(runRes)).toMatch(/workflow on that tab changed|graph identity changed/);
    expect(framesOf(panel, "graph_run")).toHaveLength(0);

    expect(writeRes.isError, textOf(writeRes)).not.toBe(true);
    expect(readbackOf(writeRes)).toMatchObject({ status: "unverified" });
    expect(String(readbackOf(writeRes).reason)).toMatch(/same graph view/);
    expect(framesOf(panel, "graph_set_widget")).toHaveLength(1);
  });

  it("a same-id node replacement before the read-back: the write is unverified, never matched against the new node", async () => {
    const panel = await connected({
      afterAck: (id, _w, p) => {
        if (id === PROMPT) p.incarnation.set(PROMPT, 1);
      },
    });
    const ctx = newCtx();
    const writeRes = await setWidget(ctx, PROMPT, "text", "scout 08");

    expect(writeRes.isError, textOf(writeRes)).not.toBe(true);
    expect(readbackOf(writeRes)).toMatchObject({ status: "unverified" });
    expect(String(readbackOf(writeRes).reason)).toMatch(/different node incarnation/);
  });
});

describe("combined: an outcome-unknown run and its retry_of around widget receipts", () => {
  async function uncertainOriginalRun(panel: ScriptedPanel): Promise<{ token: string; ctx: PanelToolCtx }> {
    __panelToolsTestHooks.setRunLateAckGraceMs(0);
    const ctx = newCtx();
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

  it("a mismatching write concurrent with the retry refuses it with the ORIGINAL token; the later retry joins the original — one queue entry ever", async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(2000);
    const panel = await connected({
      holdRuns: true,
      afterAck: restorePrevious(REFINER, "system_prompt", "OLD planner prompt"),
    });
    const { token, ctx } = await uncertainOriginalRun(panel);

    // 1) A write whose read-back does not observe the value, concurrent with the retry.
    const write = setWidget(ctx, REFINER, "system_prompt", "NEW planner prompt");
    const refused = await panelRun(ctx, { retry_of: token });
    const writeRes = await write;
    expect(writeRes.isError).toBe(true);
    expect(readbackOf(writeRes)).toMatchObject({ status: "mismatch" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain(`panel_run (retry_of:"${token}") was NOT dispatched`);
    expect(textOf(refused)).toContain(`the SAME retry_of:"${token}"`);
    expect(textOf(refused)).toMatch(/Do NOT re-run panel_run without retry_of/);
    expect(framesOf(panel, "graph_run"), "the refused retry sent nothing").toHaveLength(1);

    // 2) Nothing is outstanding now; the same token reaches the panel ledger, which
    //    joins the still-running original instead of executing a second time.
    const retry = panelRun(ctx, { retry_of: token });
    await waitFor(() => expect(panel.ledgerAnswers).toBe(1));
    panel.releaseRun(0);
    const retryRes = await retry;
    expect(retryRes.isError, textOf(retryRes)).not.toBe(true);
    expect(textOf(retryRes)).toContain("p-combined-1");
    expect(panel.runs, "no duplicate queue entry").toHaveLength(1);
    const runFrames = framesOf(panel, "graph_run");
    expect(runFrames).toHaveLength(2);
    expect(runFrames[1]?.retry_of).toBe(token);
    expect(framesOf(panel, "graph_set_widget"), "the mismatching write was never replayed").toHaveLength(1);
  });

  it("an observed write before the retry: the retry carries the original token and is answered by the original (late body), no second execution", async () => {
    __panelToolsTestHooks.setRunFreshnessBarrierMs(2000);
    const panel = await connected({ holdRuns: true });
    const { token, ctx } = await uncertainOriginalRun(panel);
    panel.releaseRun(0);
    await waitFor(() => expect(bridge.peekLateMutation(token)).toBeDefined());

    const writeRes = await setWidget(ctx, SAVE, "filename_prefix", "Chizu_V02_Scout_09");
    expect(readbackOf(writeRes)).toMatchObject({ status: "matched" });

    const retryRes = await panelRun(ctx, { retry_of: token });
    expect(retryRes.isError, textOf(retryRes)).not.toBe(true);
    expect(textOf(retryRes)).toContain("p-combined-1");
    expect(panel.runs, "answered from the original's retained reply, not re-executed").toHaveLength(1);
    // The original serialized the PRE-write filename: a retry does not re-render the new one.
    expect(panel.runs[0]?.serialized[String(SAVE)]).toEqual({ filename_prefix: "Chizu_V02_Scout_03" });
  });
});

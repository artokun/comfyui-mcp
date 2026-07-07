// Unit tests for the Gemini CLI ACP backend (gemini-backend.ts).
//
// We CANNOT run the real `gemini` CLI here, so we drive the REAL GeminiBackend /
// AcpClient code end-to-end against a FAKE ACP server spoken over a mocked
// child_process. `node:child_process` is mocked so `spawn()` returns an in-process
// fake child whose stdin/stdout are wired to a tiny JSON-RPC-2.0 ACP server that
// implements the handshake (initialize → session/new), one streamed prompt turn
// (agent_thought_chunk + tool_call + tool_call_update + agent_message_chunk, then
// a session/prompt response with stopReason), and session/cancel. This exercises
// the line framing, the request/response correlation, the session/update →
// AgentEvent mapping, the terminal-result invariant, and interrupt — all
// deterministically, with no real binary.

import { describe, expect, it, beforeEach, vi } from "vitest";
import type {
  AgentEvent,
  NeutralTurn,
  BackendStartOptions,
} from "../../orchestrator/agent-backend.js";

// ---- shared state the mocked child_process writes into / the tests read ----
const hoisted = vi.hoisted(() => ({
  // The spawned fake procs (one per backend prepare()).
  procs: [] as Array<Record<string, unknown>>,
  // The argv passed to spawn() for each spawned proc (to assert --model pinning).
  spawnArgs: [] as string[][],
  // Every JSON-RPC message the client SENT to the server (requests + notifications).
  received: [] as Array<Record<string, unknown>>,
  // Per-test server behavior: "complete" auto-finishes the prompt with end_turn;
  // "cancel" streams a bit then WAITS for session/cancel before resolving.
  config: { mode: "complete" as "complete" | "cancel" },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");

  function makeFakeProc() {
    const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
    proc.pid = 4242;
    proc.exitCode = null;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    proc.stdin = stdin;
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.kill = () => {
      if (proc.exitCode === null) {
        proc.exitCode = 0;
        proc.emit("exit", 0, null);
      }
      return true;
    };
    // When the client ends stdin (close()), surface a clean child exit so
    // AcpClient.exitPromise resolves and close() returns.
    stdin.on("finish", () => {
      if (proc.exitCode === null) {
        proc.exitCode = 0;
        proc.emit("exit", 0, null);
      }
    });

    const write = (obj: unknown) => stdout.write(`${JSON.stringify(obj)}\n`);
    const notify = (sessionId: string, update: Record<string, unknown>) =>
      write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });

    // Drive a streamed prompt turn, then resolve the request (or wait for cancel).
    let pendingPromptId: number | string | null = null;
    const SESSION_ID = "sess-test-1";

    const streamTurn = (id: number | string, sessionId: string) => {
      // Reasoning (thinking) chunk.
      notify(sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking..." },
      });
      // A tool call (start → completed).
      notify(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "panel_run",
        kind: "other",
        status: "pending",
      });
      notify(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "ran" } }],
      });
      // Reply message in two chunks (same messageId groups them).
      notify(sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg_1",
        content: { type: "text", text: "Hello" },
      });
      notify(sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg_1",
        content: { type: "text", text: " there!" },
      });
      if (hoisted.config.mode === "complete") {
        write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      } else {
        // Park the prompt; session/cancel will resolve it.
        pendingPromptId = id;
      }
    };

    // Read newline-framed JSON-RPC from the client's stdin.
    let buf = "";
    stdin.on("data", (chunk: Buffer) => {
      buf += String(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        hoisted.received.push(msg);
        const method = msg.method as string | undefined;
        const id = msg.id as number | string | undefined;
        if (method === "initialize" && id !== undefined) {
          write({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: true,
                promptCapabilities: { image: true, audio: false, embeddedContext: true },
                mcpCapabilities: { http: true, sse: false },
              },
              agentInfo: { name: "gemini", title: "Gemini", version: "test" },
              authMethods: [],
            },
          });
        } else if (method === "session/new" && id !== undefined) {
          write({ jsonrpc: "2.0", id, result: { sessionId: SESSION_ID } });
        } else if (method === "session/load" && id !== undefined) {
          write({ jsonrpc: "2.0", id, result: {} });
        } else if (method === "authenticate" && id !== undefined) {
          write({ jsonrpc: "2.0", id, result: {} });
        } else if (method === "session/prompt" && id !== undefined) {
          // Stream on the next tick so the request is registered first.
          setImmediate(() => streamTurn(id, (msg.params as { sessionId: string }).sessionId));
        } else if (method === "session/cancel") {
          if (pendingPromptId !== null) {
            const pid = pendingPromptId;
            pendingPromptId = null;
            write({ jsonrpc: "2.0", id: pid, result: { stopReason: "cancelled" } });
          }
        }
      }
    });

    hoisted.procs.push(proc);
    return proc;
  }

  return {
    ...actual,
    spawn: (_cmd: string, args: string[]) => {
      hoisted.spawnArgs.push(Array.isArray(args) ? args : []);
      return makeFakeProc();
    },
    // killProcessTree calls spawnSync("taskkill", …) on win32 — make it a no-op.
    spawnSync: () => ({ status: 0, pid: 1, stdout: "", stderr: "", signal: null, output: [] }),
  };
});

let GeminiBackend: typeof import("../../orchestrator/gemini-backend.js").GeminiBackend;

beforeEach(async () => {
  hoisted.procs.length = 0;
  hoisted.spawnArgs.length = 0;
  hoisted.received.length = 0;
  hoisted.config.mode = "complete";
  ({ GeminiBackend } = await import("../../orchestrator/gemini-backend.js"));
});

/** A push-driven async channel of NeutralTurns (PanelAgent's "channel in" seam). */
function makeChannel() {
  const queue: NeutralTurn[] = [];
  let resolveNext: ((r: IteratorResult<NeutralTurn>) => void) | null = null;
  let closed = false;
  const iterable: AsyncIterable<NeutralTurn> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<NeutralTurn>> {
          if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((res) => {
            resolveNext = res;
          });
        },
      };
    },
  };
  return {
    iterable,
    push(t: NeutralTurn) {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: t, done: false });
      } else queue.push(t);
    },
    close() {
      closed = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined as never, done: true });
      }
    },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Start consuming a backend.run() generator into an events array. */
function consume(gen: AsyncIterable<AgentEvent>, events: AgentEvent[]): Promise<void> {
  return (async () => {
    for await (const ev of gen) events.push(ev);
  })();
}

describe("GeminiBackend (ACP over stdio)", () => {
  it("handshake → prompt → streamed updates → result maps to the canonical AgentEvent sequence", async () => {
    const backend = new GeminiBackend({ cwd: process.cwd(), systemAppend: "BE NICE." });
    const channel = makeChannel();
    const events: AgentEvent[] = [];
    const opts: BackendStartOptions = { channel: channel.iterable };
    const run = consume(backend.run(opts), events);

    channel.push({ text: "hi there" });
    await waitFor(() => events.some((e) => e.type === "result"));
    channel.close();
    await run;

    // session event first, carrying the ACP sessionId.
    expect(events[0]).toMatchObject({ type: "session", sessionId: "sess-test-1" });

    // Thinking delta surfaced (agent_thought_chunk → assistant_delta thinking:true).
    expect(events.some((e) => e.type === "assistant_delta" && e.thinking === true)).toBe(true);

    // Reply deltas concatenate to the full message.
    const replyDeltas = events
      .filter((e): e is Extract<AgentEvent, { type: "assistant_delta" }> => e.type === "assistant_delta" && !e.thinking)
      .map((e) => e.text)
      .join("");
    expect(replyDeltas).toBe("Hello there!");

    // Tool call start + end both surfaced with the tool's title as the name.
    const toolStart = events.find((e) => e.type === "tool_call" && e.phase === "start");
    const toolEnd = events.find((e) => e.type === "tool_call" && e.phase === "end");
    expect(toolStart).toMatchObject({ type: "tool_call", name: "panel_run", phase: "start" });
    expect(toolEnd).toMatchObject({ type: "tool_call", name: "panel_run", phase: "end" });

    // Exactly one committed assistant message with the full reply + its stream id.
    const assistants = events.filter((e) => e.type === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ type: "assistant", text: "Hello there!", id: "msg_1" });

    // Exactly one terminal result (the "exactly one result" invariant), ok + subtype.
    const results = events.filter((e) => e.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: "result", ok: true, subtype: "end_turn" });

    // Stream bubbles are balanced (every stream_start has a stream_end).
    const starts = events.filter((e) => e.type === "stream_start").length;
    const ends = events.filter((e) => e.type === "stream_end").length;
    expect(starts).toBe(ends);
    expect(starts).toBeGreaterThanOrEqual(2); // a thinking stream + a reply stream

    // The handshake + session were established and the prompt carried the persona
    // preamble (ACP session/new has no instructions field) as the first text block.
    const methods = hoisted.received.map((m) => m.method);
    expect(methods).toContain("initialize");
    expect(methods).toContain("session/new");
    const promptMsg = hoisted.received.find((m) => m.method === "session/prompt");
    expect(promptMsg).toBeTruthy();
    const promptBlocks = (promptMsg!.params as { prompt: Array<{ type: string; text?: string }> }).prompt;
    expect(promptBlocks[0].type).toBe("text");
    expect(promptBlocks[0].text).toContain("<system>");
    expect(promptBlocks[0].text).toContain("BE NICE.");
    expect(promptBlocks[0].text).toContain("hi there");

    await backend.close();
  });

  it("interrupt() sends session/cancel and the turn ends with a single cancelled result", async () => {
    hoisted.config.mode = "cancel";
    const backend = new GeminiBackend({ cwd: process.cwd() });
    const channel = makeChannel();
    const events: AgentEvent[] = [];
    const run = consume(backend.run({ channel: channel.iterable }), events);

    channel.push({ text: "do a long thing" });
    // Wait until the stream has started (proves the turn is in flight) before cancelling.
    await waitFor(() => events.some((e) => e.type === "assistant_delta"));

    await backend.interrupt();

    await waitFor(() => events.some((e) => e.type === "result"));
    channel.close();
    await run;

    // The client sent a session/cancel for the live session.
    const cancel = hoisted.received.find((m) => m.method === "session/cancel");
    expect(cancel).toBeTruthy();
    expect((cancel!.params as { sessionId: string }).sessionId).toBe("sess-test-1");

    // Exactly one terminal result, marked not-ok with the cancelled stopReason.
    const results = events.filter((e) => e.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: "result", ok: false, subtype: "cancelled" });

    await backend.close();
  });

  it("listModels returns the static Gemini catalog (no effort metadata)", async () => {
    const backend = new GeminiBackend();
    const models = await backend.listModels();
    expect(models.map((m) => m.id)).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);
    // Gemini has no discrete effort scale → no effort metadata (panel hides picker).
    expect(models.every((m) => m.supportsEffort === undefined && m.supportedEffortLevels === undefined)).toBe(true);
  });

  it("applies the panel-selected model to the FIRST spawn (--model) before prepare", async () => {
    // No construction-time model; the panel-selected Gemini model arrives as
    // opts.model and must pin the very first `gemini --acp` spawn (P1a).
    const backend = new GeminiBackend({ cwd: process.cwd() });
    const channel = makeChannel();
    const events: AgentEvent[] = [];
    const run = consume(backend.run({ channel: channel.iterable, model: "gemini-2.5-flash" }), events);

    channel.push({ text: "hi" });
    await waitFor(() => events.some((e) => e.type === "result"));
    channel.close();
    await run;

    expect(hoisted.spawnArgs).toHaveLength(1);
    expect(hoisted.spawnArgs[0]).toContain("--acp");
    expect(hoisted.spawnArgs[0]).toContain("--model");
    expect(hoisted.spawnArgs[0][hoisted.spawnArgs[0].indexOf("--model") + 1]).toBe("gemini-2.5-flash");

    await backend.close();
  });

  it("a live setModel() respawns the CLI with the new --model and a fresh session", async () => {
    const backend = new GeminiBackend({ cwd: process.cwd(), model: "gemini-2.5-pro" });
    const channel = makeChannel();
    const events: AgentEvent[] = [];
    const run = consume(backend.run({ channel: channel.iterable }), events);

    // First turn on the initial model.
    channel.push({ text: "turn one" });
    await waitFor(() => events.filter((e) => e.type === "result").length >= 1);
    expect(hoisted.spawnArgs).toHaveLength(1);
    expect(hoisted.spawnArgs[0][hoisted.spawnArgs[0].indexOf("--model") + 1]).toBe("gemini-2.5-pro");

    // Live model switch (panel picker → PanelAgent.setOptions → agent.setModel).
    await backend.setModel("gemini-2.5-flash");

    // Next turn must transparently respawn with the new --model + a fresh session.
    channel.push({ text: "turn two" });
    await waitFor(() => events.filter((e) => e.type === "result").length >= 2);
    channel.close();
    await run;

    // A SECOND `gemini --acp` was spawned, pinned to the new model.
    expect(hoisted.spawnArgs).toHaveLength(2);
    expect(hoisted.spawnArgs[1]).toContain("--acp");
    expect(hoisted.spawnArgs[1][hoisted.spawnArgs[1].indexOf("--model") + 1]).toBe("gemini-2.5-flash");

    // The respawn opened a fresh session → a second `session` event was emitted.
    expect(events.filter((e) => e.type === "session").length).toBe(2);
    // Both turns completed cleanly.
    expect(events.filter((e) => e.type === "result").every((r) => (r as { ok: boolean }).ok)).toBe(true);

    await backend.close();
  });

  it("ignores a non-Gemini model id passed to setModel (e.g. the Claude panel model)", async () => {
    const backend = new GeminiBackend({ cwd: process.cwd(), model: "gemini-2.5-pro" });
    const channel = makeChannel();
    const events: AgentEvent[] = [];
    const run = consume(backend.run({ channel: channel.iterable }), events);

    channel.push({ text: "turn one" });
    await waitFor(() => events.filter((e) => e.type === "result").length >= 1);

    // PanelAgent may relay the Claude panel model — it must NOT respawn Gemini.
    await backend.setModel("claude-opus-4-8");

    channel.push({ text: "turn two" });
    await waitFor(() => events.filter((e) => e.type === "result").length >= 2);
    channel.close();
    await run;

    // Still only one spawn (no respawn), and only one session.
    expect(hoisted.spawnArgs).toHaveLength(1);
    expect(events.filter((e) => e.type === "session").length).toBe(1);

    await backend.close();
  });
});

describe("buildAcpMcpServers", () => {
  it("maps http specs to the ACP SSE variant (live CLIs reject type 'http')", async () => {
    const { buildAcpMcpServers } = await import("../../orchestrator/gemini-backend.js");
    const out = buildAcpMcpServers({
      panel: { transport: "http", url: "http://127.0.0.1:9181/tab1" },
      comfy: { transport: "stdio", command: "node", args: ["x.js"], env: { A: "1" } },
    });
    expect(out).toContainEqual({ type: "sse", name: "panel", url: "http://127.0.0.1:9181/tab1", headers: [] });
    // stdio mapping unchanged
    expect(out).toContainEqual({ name: "comfy", command: "node", args: ["x.js"], env: [{ name: "A", value: "1" }] });
    // the rejected variant must NOT appear
    expect(out.some((s) => s.type === "http")).toBe(false);
  });
});

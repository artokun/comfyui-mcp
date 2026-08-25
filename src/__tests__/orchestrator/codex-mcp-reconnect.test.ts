// #1524 — Codex lane. After panel_restart_comfyui the session resumes with the
// generic comfyui gateway and NO mcp__panel__* entries in ALL_TOOLS.
// tools.mcp__panel__panel_set_todo then throws TypeError: is not a function.
//
// Claude got reconnectMcpServer() in #1681. Codex's control plane is different:
// mcpServerStatus/list to see the drop, config/mcpServer/reload to re-init
// (applied on the NEXT turn). Codex does not auto-reconnect HTTP MCP
// (openai/codex#11489); stdio comfyui is respawned by the client, panel is not.
//
// These tests drive the live CodexBackend.run() path with a fake app-server
// client, same seam as the code-mode host-retry suite.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { waitFor } from "../helpers/wait-for.js";
import type { AgentEvent } from "../../orchestrator/agent-backend.js";

vi.mock("../../utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type BackendModule = typeof import("../../orchestrator/codex-backend.js");
type Backend = InstanceType<BackendModule["CodexBackend"]>;

let CodexBackend: BackendModule["CodexBackend"];

beforeAll(async () => {
  vi.resetModules();
  ({ CodexBackend } = await import("../../orchestrator/codex-backend.js"));
});

afterAll(() => vi.unstubAllEnvs());

/** Live `mcpServerStatus/list` tools field is a name→schema map, not an array. */
const CACHED_PANEL_TOOLS = { panel_graph_outline: {}, panel_set_todo: {} };
const PANEL_UP = [
  { name: "comfyui", runtimeStatus: "connected", tools: { list_tools: {}, call_tool: {} } },
  { name: "panel", runtimeStatus: "connected", tools: CACHED_PANEL_TOOLS },
];
/** Dropped HTTP panel: runtimeStatus failed, tools inventory still cached. */
const PANEL_GONE = [
  { name: "comfyui", runtimeStatus: "connected", tools: { list_tools: {}, call_tool: {} } },
  { name: "panel", runtimeStatus: "failed", tools: CACHED_PANEL_TOOLS },
];
const MCP_SERVERS = {
  comfyui: { transport: "stdio" as const, command: "node", args: ["mcp.js"] },
  panel: { transport: "http" as const, url: "http://127.0.0.1:9198/tab" },
};
const WORKER_TRANSPORT_FAILURE =
  "Transport send error: WorkerTransport<StreamableHttpClientWorker<...>> error: " +
  "HTTP request failed sending request to http://127.0.0.1:9198/orchestrator%3A%3Acodex";

const noticesOf = (events: AgentEvent[]) =>
  events.filter(
    (e): e is Extract<AgentEvent, { type: "error" }> =>
      e.type === "error" && (e as { sessionNotice?: boolean }).sessionNotice === true,
  );

type Listing =
  | Array<{
      name: string;
      runtimeStatus?: string;
      authStatus?: string;
      tools?: Record<string, unknown> | unknown[];
    }>
  | "throw";

async function waitUntil(pred: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Drive {
  events: AgentEvent[];
  reloadCalls: number;
  polls: number;
  pollParams: unknown[];
  turnStarts: number;
  endTurn(kind?: "completed" | "worker-transport"): Promise<void>;
  finish(): Promise<void>;
}

function startDrive(opts: {
  listings: Listing[];
  reloadThrows?: boolean;
  requiredMcpTools?: Readonly<Record<string, readonly string[]>>;
}): Drive {
  const listings = [...opts.listings];
  const events: AgentEvent[] = [];
  let polls = 0;
  let reloadCalls = 0;
  let starts = 0;
  const turnWaiters: Array<() => void> = [];
  let waitingForTurn = false;

  const client = {
    notificationHandler: null as ((msg: unknown) => void) | null,
    exitError: null as Error | null,
    exitPromise: new Promise<void>(() => {}),
    request: vi.fn(async (method: string, params?: unknown) => {
      if (method === "thread/start" || method === "thread/resume") {
        return { thread: { id: "thread-1" }, model: "gpt-5.6-sol" };
      }
      if (method === "model/list") return { data: [{ id: "gpt-5.6-sol", hidden: false }] };
      if (method === "turn/start") {
        starts += 1;
        drive.turnStarts = starts;
        waitingForTurn = true;
        for (const w of turnWaiters.splice(0)) w();
        return { turn: { id: `turn-${starts}` } };
      }
      if (method === "mcpServerStatus/list") {
        polls += 1;
        drive.polls = polls;
        drive.pollParams.push(params);
        if (listings.length === 0) throw new Error("no listing scripted");
        const next = listings.length > 1 ? listings.shift()! : listings[0];
        if (next === "throw") throw new Error("mcpServerStatus/list unavailable");
        return { data: next, nextCursor: null };
      }
      if (method === "config/mcpServer/reload") {
        reloadCalls += 1;
        drive.reloadCalls = reloadCalls;
        if (opts.reloadThrows) throw new Error("unknown method config/mcpServer/reload");
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    }),
    close: vi.fn(async () => {}),
  };

  const turns: Array<{ text: string }> = [];
  let turnResolve: (() => void) | null = null;
  let finished = false;
  let idle = false;
  async function* channel() {
    for (;;) {
      idle = false;
      while (turns.length) yield turns.shift()!;
      if (finished) return;
      idle = true;
      await new Promise<void>((resolve) => {
        turnResolve = resolve;
      });
    }
  }

  const backend: Backend = new CodexBackend({
    model: "gpt-5.6-sol",
    mcpServers: MCP_SERVERS,
    requiredMcpTools: opts.requiredMcpTools,
  });
  Object.assign(backend, { client, liveCatalog: [{ id: "gpt-5.6-sol", supportsEffort: true }] });

  const done = (async () => {
    for await (const ev of backend.run({ channel: channel() })) events.push(ev);
  })();

  const drive: Drive = {
    events,
    reloadCalls: 0,
    polls: 0,
    pollParams: [],
    turnStarts: 0,
    async endTurn(kind = "completed") {
      await waitFor(() => expect(events.some((e) => e.type === "session")).toBe(true));
      idle = false;
      turns.push({ text: "continue" });
      turnResolve?.();
      turnResolve = null;
      if (!waitingForTurn) {
        await new Promise<void>((resolve) => turnWaiters.push(resolve));
      }
      await waitUntil(() => waitingForTurn && starts > 0);
      waitingForTurn = false;
      const turnId = `turn-${starts}`;
      if (kind === "worker-transport") {
        client.notificationHandler?.({
          method: "error",
          params: {
            threadId: "thread-1",
            turnId,
            error: { message: WORKER_TRANSPORT_FAILURE },
            willRetry: false,
          },
        });
      } else {
        client.notificationHandler?.({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: turnId, status: "completed" } },
        });
      }
      // The MCP watch runs AFTER the turn result, before the run loop waits
      // for the next channel item. Idle is the barrier that it finished.
      await waitFor(() => expect(idle).toBe(true));
    },
    async finish() {
      finished = true;
      turnResolve?.();
      await done;
    },
  };
  return drive;
}

describe("Codex mid-session MCP drop reconnects panel tools (#1524)", () => {
  it("a WorkerTransport send failure forces one panel reload without retrying the turn (#1777)", async () => {
    // Codex can report the HTTP send failure while its status inventory still
    // says `panel` is connected. The observed error is the recovery trigger;
    // the reload is control-plane only and must not re-run panel_run.
    const drive = startDrive({ listings: [PANEL_UP] });
    await drive.endTurn("worker-transport");

    expect(drive.reloadCalls).toBe(1);
    expect(drive.turnStarts).toBe(1);
    const failure = drive.events.find(
      (e): e is Extract<AgentEvent, { type: "error" }> =>
        e.type === "error" && !(e as { sessionNotice?: boolean }).sessionNotice,
    );
    expect(failure?.outcomeUnknown).toBe(true);
    expect(failure?.message).toMatch(/did not retry/i);
    expect(failure?.message).toMatch(/outcome as UNKNOWN/i);
    expect(noticesOf(drive.events)).toHaveLength(0);

    await drive.endTurn();
    await drive.finish();
    expect(drive.reloadCalls).toBe(1);
    expect(drive.turnStarts).toBe(2);
    expect(noticesOf(drive.events)).toHaveLength(1);
    expect(noticesOf(drive.events)[0].message).toMatch(/reconnect brought it back/);
  });

  it("a drop the reload fixes is narrated once, as fixed, on the next turn", async () => {
    // Reload is queued for the NEXT turn. Same-turn is silent; the following
    // poll is the verdict, and that is the only line the user gets.
    const drive = startDrive({ listings: [PANEL_GONE, PANEL_UP] });
    await drive.endTurn();
    expect(drive.reloadCalls).toBe(1);
    expect(drive.pollParams[0]).toMatchObject({
      detail: "toolsAndAuthOnly",
      threadId: "thread-1",
    });
    expect(noticesOf(drive.events)).toHaveLength(0);

    await drive.endTurn();
    await drive.finish();
    expect(drive.reloadCalls).toBe(1);
    const notices = noticesOf(drive.events);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("panel");
    expect(notices[0].message).toMatch(/reconnect brought it back/);
  });

  it("a drop the reload does NOT fix is reported once — not fought every turn", async () => {
    const drive = startDrive({ listings: [PANEL_GONE] });
    await drive.endTurn();
    await drive.endTurn();
    await drive.endTurn();
    await drive.finish();

    expect(drive.reloadCalls).toBe(1);
    const notices = noticesOf(drive.events);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("panel");
    expect(notices[0].message).toMatch(/reconnect did not bring it back/);
  });

  it("a healthy listing never reloads", async () => {
    const drive = startDrive({ listings: [PANEL_UP], requiredMcpTools: { comfyui: ["call_tool"] } });
    await drive.endTurn();
    await drive.endTurn();
    await drive.finish();
    expect(drive.reloadCalls).toBe(0);
    expect(noticesOf(drive.events)).toHaveLength(0);
  });

  it("reloads a connected server whose status inventory is a partial catalog", async () => {
    const drive = startDrive({
      listings: [
        [
          // Codex can keep the server runtime marked connected while its
          // independently-built aggregate omits the stable facade wrapper.
          { name: "comfyui", runtimeStatus: "connected", tools: { list_tools: {}, describe_tool: {} } },
          { name: "panel", runtimeStatus: "connected", tools: CACHED_PANEL_TOOLS },
        ],
        PANEL_UP,
      ],
      requiredMcpTools: { comfyui: ["call_tool"] },
    });
    await drive.endTurn();
    expect(drive.reloadCalls).toBe(1);
    expect(noticesOf(drive.events)).toHaveLength(0);

    await drive.endTurn();
    await drive.finish();
    expect(drive.reloadCalls).toBe(1);
    expect(noticesOf(drive.events)).toHaveLength(1);
    expect(noticesOf(drive.events)[0].message).toMatch(/reconnect brought it back/);
  });

  it("does not report partial-catalog recovery when reload omits the inventory", async () => {
    const drive = startDrive({
      listings: [
        [
          { name: "comfyui", runtimeStatus: "connected", tools: { list_tools: {}, describe_tool: {} } },
          { name: "panel", runtimeStatus: "connected", tools: CACHED_PANEL_TOOLS },
        ],
        [
          { name: "comfyui", runtimeStatus: "connected" },
          { name: "panel", runtimeStatus: "connected", tools: CACHED_PANEL_TOOLS },
        ],
        [
          { name: "comfyui", runtimeStatus: "connected", tools: {} },
          { name: "panel", runtimeStatus: "connected", tools: CACHED_PANEL_TOOLS },
        ],
        PANEL_UP,
      ],
      requiredMcpTools: { comfyui: ["call_tool"] },
    });
    await drive.endTurn();
    expect(drive.reloadCalls).toBe(1);
    expect(noticesOf(drive.events)).toHaveLength(0);

    await drive.endTurn();
    expect(drive.reloadCalls).toBe(1);
    expect(noticesOf(drive.events)).toHaveLength(0);

    await drive.endTurn();
    expect(drive.reloadCalls).toBe(1);
    expect(noticesOf(drive.events)).toHaveLength(0);

    await drive.endTurn();
    await drive.finish();
    expect(drive.reloadCalls).toBe(1);
    expect(noticesOf(drive.events)).toHaveLength(1);
    expect(noticesOf(drive.events)[0].message).toMatch(/reconnect brought it back/);
  });

  it("keeps connected absent or empty inventories from triggering a reload", async () => {
    const drive = startDrive({
      listings: [
        [
          { name: "comfyui", runtimeStatus: "connected" },
          { name: "panel", runtimeStatus: "connected", tools: CACHED_PANEL_TOOLS },
        ],
        [
          { name: "comfyui", runtimeStatus: "connected", tools: {} },
          { name: "panel", runtimeStatus: "connected", tools: CACHED_PANEL_TOOLS },
        ],
      ],
      requiredMcpTools: { comfyui: ["call_tool"] },
    });
    await drive.endTurn();
    await drive.endTurn();
    await drive.finish();
    expect(drive.reloadCalls).toBe(0);
    expect(noticesOf(drive.events)).toHaveLength(0);
  });

  it("a poll that throws stays silent and never takes the turn down", async () => {
    const drive = startDrive({ listings: ["throw"] });
    await drive.endTurn();
    await drive.finish();
    expect(drive.reloadCalls).toBe(0);
    expect(noticesOf(drive.events)).toHaveLength(0);
    expect(drive.events.some((e) => e.type === "result")).toBe(true);
  });

  it("a reload that throws is reported as unverified, not as a failed reconnect", async () => {
    const drive = startDrive({ listings: [PANEL_GONE], reloadThrows: true });
    await drive.endTurn();
    await drive.finish();
    expect(drive.reloadCalls).toBe(1);
    const notices = noticesOf(drive.events);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toMatch(/reconnect was attempted/);
    expect(notices[0].message).toMatch(/could not be read back/);
    expect(notices[0].message).not.toMatch(/did not bring it back/);
  });

  it("a second drop after recovery is a new episode, with its own reload", async () => {
    const drive = startDrive({ listings: [PANEL_GONE, PANEL_UP, PANEL_UP, PANEL_GONE] });
    await drive.endTurn(); // drop → queue reload
    await drive.endTurn(); // up → recovered
    await drive.endTurn(); // still up — silent
    await drive.endTurn(); // drop again → queue reload
    await drive.finish();
    expect(drive.reloadCalls).toBe(2);
    const notices = noticesOf(drive.events);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toMatch(/reconnect brought it back/);
  });

  it("runtimeStatus=failed with omitted tools still reloads", async () => {
    // Deleting the runtimeStatus→failed branch leaves this green if the
    // mapper still keys on empty tools arrays — this fixture has neither.
    const drive = startDrive({
      listings: [
        [
          { name: "comfyui", runtimeStatus: "connected" },
          { name: "panel", runtimeStatus: "failed" },
        ],
      ],
    });
    await drive.endTurn();
    await drive.finish();
    expect(drive.reloadCalls).toBe(1);
    expect(drive.pollParams[0]).toMatchObject({ threadId: "thread-1", detail: "toolsAndAuthOnly" });
  });

  it("runtimeStatus=starting does not reload even with an empty tools map", async () => {
    const drive = startDrive({
      listings: [
        [
          { name: "comfyui", runtimeStatus: "connected", tools: { list_tools: {} } },
          { name: "panel", runtimeStatus: "starting", tools: {} },
        ],
      ],
    });
    await drive.endTurn();
    await drive.finish();
    expect(drive.reloadCalls).toBe(0);
  });

  it("a needs-auth server is reported but never reloaded", async () => {
    const drive = startDrive({
      listings: [
        [
          { name: "comfyui", runtimeStatus: "connected", tools: { list_tools: {} } },
          { name: "panel", runtimeStatus: "authenticationRequired", tools: CACHED_PANEL_TOOLS },
        ],
      ],
    });
    await drive.endTurn();
    await drive.endTurn();
    await drive.finish();
    expect(drive.reloadCalls).toBe(0);
    const notices = noticesOf(drive.events);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toMatch(/cannot clear this status/);
  });

  it("does not poll when this session was given no MCP servers", async () => {
    const client = {
      notificationHandler: null as ((msg: unknown) => void) | null,
      exitError: null,
      exitPromise: new Promise<void>(() => {}),
      request: vi.fn(async (method: string) => {
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "model/list") return { data: [] };
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        throw new Error(`unexpected request: ${method}`);
      }),
      close: vi.fn(async () => {}),
    };
    const backend: Backend = new CodexBackend({ model: "gpt-5.6-sol" });
    Object.assign(backend, { client, liveCatalog: [{ id: "gpt-5.6-sol" }] });
    async function* channel() {
      yield { text: "hello" };
    }
    const iterator = backend.run({ channel: channel() });
    await iterator.next(); // session
    const pending = iterator.next();
    await waitUntil(() => (backend as Backend & { turnId?: string }).turnId === "turn-1");
    client.notificationHandler?.({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });
    await pending;
    const rest: unknown[] = [];
    for await (const ev of iterator) rest.push(ev);
    expect(client.request.mock.calls.some((c) => c[0] === "mcpServerStatus/list")).toBe(false);
    expect(client.request.mock.calls.some((c) => c[0] === "config/mcpServer/reload")).toBe(false);
    void rest;
  });
});

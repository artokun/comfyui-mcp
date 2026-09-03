// #1524, WIRING — the check has to run on the real init path, against the real
// configured server set.
//
// A helper-only suite would pass with the call site deleted: `degradedMcpServers`
// is pure, and a test that builds both sides itself proves only that it compares
// two arrays. What has to be pinned is that `route()`'s `system`/`init` branch
// feeds it (a) the servers this session was actually GIVEN — including the
// in-process `panel` server, which is added inside buildOptions and appears in no
// dep — and (b) the report the harness sent, and that a degraded session yields a
// visible event.
//
// Harness pattern follows claude-turn-markers.test.ts: the optional Agent SDK is
// mocked, the backend is driven through run(), and the canonical AgentEvents are
// collected.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../orchestrator/agent-backend.js";
import { waitFor } from "../helpers/wait-for.js";

process.env.COMFYUI_MCP_TURN_REGISTRY_DIR = mkdtempSync(join(tmpdir(), "claude-init-mcp-registry-"));

const hoisted = vi.hoisted(() => ({
  queue: new (class {
    private buf: unknown[] = [];
    private waiters: Array<() => void> = [];
    private closed = false;
    reset(): void {
      this.buf = [];
      this.closed = false;
    }
    push(m: unknown): void {
      this.buf.push(m);
      for (const w of this.waiters.splice(0)) w();
    }
    end(): void {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w();
    }
    async *iterate(): AsyncGenerator<unknown> {
      for (;;) {
        while (this.buf.length) yield this.buf.shift();
        if (this.closed) return;
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    }
  })(),
  /** The mcpServers object the backend actually handed the SDK. */
  lastMcpServers: null as Record<string, unknown> | null,
  lastForkSession: undefined as boolean | undefined,
  lastResume: undefined as string | undefined,
  /** What `q.mcpServerStatus()` answers, and how many times it was asked. */
  statusPoll: null as null | Array<{ name: string; status: string }>,
  statusPolls: 0,
  /** Servers the harness was asked to reconnect, in order. */
  reconnectCalls: [] as string[],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (arg: {
    prompt?: AsyncIterable<unknown>;
    options?: { mcpServers?: Record<string, unknown>; forkSession?: boolean; resume?: string };
  }) => {
    hoisted.lastMcpServers = arg.options?.mcpServers ?? null;
    hoisted.lastForkSession = arg.options?.forkSession;
    hoisted.lastResume = arg.options?.resume;
    void (async () => {
      for await (const _ of arg.prompt ?? []) void _;
    })();
    const iter = hoisted.queue.iterate();
    return Object.assign(iter, {
      supportedModels: async () => [],
      supportedCommands: async () => [],
      interrupt: async () => {},
      setModel: async () => {},
      mcpServerStatus: async () => {
        hoisted.statusPolls += 1;
        if (!hoisted.statusPoll) throw new Error("no status available");
        return hoisted.statusPoll;
      },
      reconnectMcpServer: async (name: string) => {
        hoisted.reconnectCalls.push(name);
      },
    });
  },
}));

beforeEach(() => {
  hoisted.queue.reset();
  hoisted.lastMcpServers = null;
  hoisted.lastForkSession = undefined;
  hoisted.lastResume = undefined;
  hoisted.statusPoll = null;
  hoisted.statusPolls = 0;
  hoisted.reconnectCalls = [];
});

const initWith = (mcp_servers?: Array<{ name: string; status: string }>) => ({
  type: "system",
  subtype: "init",
  session_id: "00000000-1111-2222-3333-444444444444",
  model: "claude-test-1",
  apiKeySource: "none",
  skills: [],
  ...(mcp_servers ? { mcp_servers } : {}),
});

/** A stand-in for the in-process panel server (createSdkMcpServer's shape). */
const PANEL_SERVER = { type: "sdk", name: "comfyui-panel", instance: {} } as never;
const COMFYUI_SERVER = { type: "stdio", command: "node", args: [] } as never;

async function drive(
  deps: { mcpServers?: Record<string, unknown>; panelServer?: unknown },
  init: unknown,
): Promise<AgentEvent[]> {
  const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
  const backend = new ClaudeBackend({
    mcpServers: (deps.mcpServers ?? {}) as never,
    systemAppend: "",
    ...(deps.panelServer ? { panelServer: deps.panelServer as never } : {}),
  });
  const events: AgentEvent[] = [];
  async function* idle(): AsyncGenerator<{ text: string }> {
    await new Promise<void>(() => {}); // never submits a turn
  }
  const done = (async () => {
    for await (const ev of backend.run({ channel: idle() as never })) events.push(ev);
  })();
  hoisted.queue.push(init);
  await waitFor(() => expect(events.some((e) => e.type === "session")).toBe(true));
  hoisted.queue.end();
  await done;
  return events;
}

/** Same, but the session takes a turn and ends it — the point at which a server
 *  still connecting at init is re-read. `turns` result messages are pushed. */
async function driveTurns(
  deps: { mcpServers?: Record<string, unknown>; panelServer?: unknown },
  init: unknown,
  turns = 1,
): Promise<AgentEvent[]> {
  const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
  const backend = new ClaudeBackend({
    mcpServers: (deps.mcpServers ?? {}) as never,
    systemAppend: "",
    ...(deps.panelServer ? { panelServer: deps.panelServer as never } : {}),
  });
  const events: AgentEvent[] = [];
  async function* oneTurn(): AsyncGenerator<{ text: string }> {
    yield { text: "hello" };
    await new Promise<void>(() => {});
  }
  const done = (async () => {
    for await (const ev of backend.run({ channel: oneTurn() as never })) events.push(ev);
  })();
  hoisted.queue.push(init);
  await waitFor(() => expect(events.some((e) => e.type === "session")).toBe(true));
  for (let i = 0; i < turns; i++) hoisted.queue.push({ type: "result", subtype: "success" });
  await waitFor(() => expect(events.filter((e) => e.type === "result")).toHaveLength(turns));
  hoisted.queue.end();
  await done;
  return events;
}

const noticesOf = (events: AgentEvent[]) =>
  events.filter(
    (e): e is Extract<AgentEvent, { type: "error" }> =>
      e.type === "error" && (e as { sessionNotice?: boolean }).sessionNotice === true,
  );

describe("a Claude session that started without an MCP server reports it (#1524)", () => {
  it("names the panel server when the session came up without it", async () => {
    // The reporter's exact split: comfyui back, the 92 panel_* tools gone.
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "failed" },
      ]),
    );
    const notices = noticesOf(events);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("panel");
    // …and does NOT accuse the server that DID come up. Over-reporting here is
    // the same defect pointing the other way.
    expect(notices[0].message).not.toContain("comfyui");
  });

  it("compares against the server set the session was GIVEN, panel included", async () => {
    // The `panel` entry is added inside the backend, not passed in deps. A check
    // that compared the report against `deps.mcpServers` alone would never see
    // the panel server go missing — which is the entire reported failure.
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([{ name: "comfyui", status: "connected" }]),
    );
    expect(hoisted.lastMcpServers && Object.keys(hoisted.lastMcpServers).sort()).toEqual([
      "comfyui",
      "panel",
    ]);
    expect(noticesOf(events)[0]?.message).toContain("panel");
  });

  it("stays silent when every configured server connected", async () => {
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "connected" },
      ]),
    );
    expect(noticesOf(events)).toHaveLength(0);
  });

  it("stays silent when the harness sends no report at all", async () => {
    // Older/other harnesses omit the field. Silence there is mandatory: this
    // path runs on every session start.
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith(undefined),
    );
    expect(noticesOf(events)).toHaveLength(0);
  });

  it("does not report `panel` for a backend that was never given one", async () => {
    // makePanelServer returns undefined for non-claude keys, so `panel` is not in
    // that session's set and its absence from the report is correct, not a fault.
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER } },
      initWith([{ name: "comfyui", status: "connected" }]),
    );
    expect(noticesOf(events)).toHaveLength(0);
  });

  it("stays silent for a server still CONNECTING at init", async () => {
    // Server startup does not block the session, so `pending` at init is a slow
    // connection, not a failed one. Reporting it would fire on healthy sessions.
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "pending" },
      ]),
    );
    expect(noticesOf(events)).toHaveLength(0);
  });

  it("still emits the session event alongside the notice", async () => {
    // The notice must not displace init's real job — a swallowed session id
    // would break resume, which is a far worse bug than the one being fixed.
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([{ name: "comfyui", status: "failed" }]),
    );
    expect(events.filter((e) => e.type === "session")).toHaveLength(1);
    expect(noticesOf(events)).toHaveLength(1);
  });
});

describe("the turn-end watch settles what init could not (#1524)", () => {
  it("reports a pending-at-init server that settled as FAILED, after trying the reconnect", async () => {
    // The hole an init-only check leaves: `init` is the only MCP report the
    // session pushes, so `pending` there followed by a failure is silent forever
    // — the same six-hour silence, moved a few hundred milliseconds later.
    hoisted.statusPoll = [
      { name: "comfyui", status: "connected" },
      { name: "panel", status: "failed" },
    ];
    const events = await driveTurns(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "pending" },
      ]),
    );
    const notices = noticesOf(events);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("panel");
    // The one bounded reconnect was tried, and the outcome line quotes the
    // verdict re-read — so two polls, not one.
    expect(hoisted.reconnectCalls).toEqual(["panel"]);
    expect(hoisted.statusPolls).toBe(2);
    expect(notices[0].message).toMatch(/reconnect did not bring it back/);
  });

  it("says nothing when it settled as connected", async () => {
    hoisted.statusPoll = [
      { name: "comfyui", status: "connected" },
      { name: "panel", status: "connected" },
    ];
    const events = await driveTurns(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "pending" },
      ]),
    );
    expect(noticesOf(events)).toHaveLength(0);
    expect(hoisted.reconnectCalls).toEqual([]);
    expect(hoisted.statusPolls).toBe(1);
  });

  it("watches on EVERY turn end — the mid-session drop has no other signal", async () => {
    // `init` is the only report the session pushes, so a healthy-init session
    // that loses a server hours in is invisible unless something asks. The ask
    // is one control round-trip per completed turn — turn-driven, so it needs
    // no timer and cannot spam.
    hoisted.statusPoll = [
      { name: "comfyui", status: "connected" },
      { name: "panel", status: "connected" },
    ];
    await driveTurns(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "pending" },
      ]),
      3,
    );
    expect(hoisted.statusPolls).toBe(3);
  });

  it("polls a healthy session too — and stays silent while it stays healthy", async () => {
    // The watch cannot know the toolset thinned without looking, so the healthy
    // session pays the same one round-trip per turn. What it must NEVER pay is
    // a false alarm or an unneeded reconnect.
    hoisted.statusPoll = [
      { name: "comfyui", status: "connected" },
      { name: "panel", status: "connected" },
    ];
    const events = await driveTurns(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "connected" },
      ]),
      2,
    );
    expect(hoisted.statusPolls).toBe(2);
    expect(noticesOf(events)).toHaveLength(0);
    expect(hoisted.reconnectCalls).toEqual([]);
  });

  it("stays silent when the poll is unavailable or throws", async () => {
    // `mcpServerStatus()` is an optional Query method. A harness without it
    // leaves the servers unmentioned rather than guessed at — and must never
    // take the turn stream down with it.
    hoisted.statusPoll = null; // the mock throws
    const events = await driveTurns(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "pending" },
      ]),
    );
    expect(noticesOf(events)).toHaveLength(0);
    expect(hoisted.reconnectCalls).toEqual([]);
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
  });
});

describe("a forked resume uses THIS run's MCP set, not the session-recorded one (#1700)", () => {
  const MAGIC = { type: "stdio", command: "npx", args: ["-y", "@21st-dev/magic"] } as never;

  it("hands the SDK forkSession plus the post-remove server set", async () => {
    // The reporter's case: magic was removed from config, then panel_reload
    // resumed the old session. A plain resume restores the recorded MCP set, so
    // magic stayed failed. The shipped backend must fork AND pass the current
    // deps (no magic) so the replacement session cannot relaunch it.
    const events: AgentEvent[] = [];
    const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
    const backend = new ClaudeBackend({
      mcpServers: { comfyui: COMFYUI_SERVER } as never,
      systemAppend: "",
      panelServer: PANEL_SERVER,
    });
    async function* idle(): AsyncGenerator<{ text: string }> {
      await new Promise<void>(() => {});
    }
    const done = (async () => {
      for await (const ev of backend.run({
        channel: idle() as never,
        resume: "sess-with-magic",
        forkSession: true,
      })) {
        events.push(ev);
      }
    })();
    hoisted.queue.push(
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "connected" },
      ]),
    );
    await waitFor(() => expect(events.some((e) => e.type === "session")).toBe(true));
    hoisted.queue.end();
    await done;

    expect(hoisted.lastResume).toBe("sess-with-magic");
    expect(hoisted.lastForkSession).toBe(true);
    expect(hoisted.lastMcpServers && Object.keys(hoisted.lastMcpServers).sort()).toEqual([
      "comfyui",
      "panel",
    ]);
    expect(hoisted.lastMcpServers).not.toHaveProperty("magic");
    expect(noticesOf(events)).toHaveLength(0);
  });

  it("a plain resume does not set forkSession — that is the bug's shape", async () => {
    const events: AgentEvent[] = [];
    const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
    const backend = new ClaudeBackend({
      mcpServers: { comfyui: COMFYUI_SERVER, magic: MAGIC } as never,
      systemAppend: "",
    });
    async function* idle(): AsyncGenerator<{ text: string }> {
      await new Promise<void>(() => {});
    }
    const done = (async () => {
      for await (const ev of backend.run({
        channel: idle() as never,
        resume: "sess-with-magic",
      })) {
        events.push(ev);
      }
    })();
    hoisted.queue.push(initWith([{ name: "comfyui", status: "connected" }]));
    await waitFor(() => expect(events.some((e) => e.type === "session")).toBe(true));
    hoisted.queue.end();
    await done;

    expect(hoisted.lastResume).toBe("sess-with-magic");
    expect(hoisted.lastForkSession).toBeUndefined();
  });
});

// #2742, WIRING — same argument as the block above, for the variant that passes
// the status check. A helper-only suite would pass with the call site deleted, and
// the call site is the whole point: `serversWithoutTools` reads `message.tools`,
// which nothing in `route()` had ever looked at.
describe("a Claude session whose MCP server connected but registered nothing (#2742)", () => {
  const withTools = (
    mcp_servers: Array<{ name: string; status: string }>,
    tools: string[],
  ) => ({ ...initWith(mcp_servers), tools });

  it("reports the panel server that connected and contributed zero tools", async () => {
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      withTools(
        [
          { name: "comfyui", status: "connected" },
          { name: "panel", status: "connected" },
        ],
        // The reporters' exact shape: comfyui tools present throughout, panel_*
        // absent from every surface.
        ["Read", "Bash", "mcp__comfyui__generate_image", "mcp__comfyui__get_history"],
      ),
    );
    const notices = noticesOf(events);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("panel");
    expect(notices[0].message).toContain("ZERO tools");
    // Not the degraded wording — the server did not fail to connect.
    expect(notices[0].message).not.toContain("started without");
  });

  it("says nothing when both servers contributed tools", async () => {
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      withTools(
        [
          { name: "comfyui", status: "connected" },
          { name: "panel", status: "connected" },
        ],
        ["mcp__comfyui__generate_image", "mcp__panel__panel_graph_outline"],
      ),
    );
    expect(noticesOf(events)).toHaveLength(0);
  });

  it("stays silent on an init message that carries no tool list at all", async () => {
    // Every existing #1524 fixture is this shape. A new alarm on them would be a
    // false positive on healthy sessions, which is the one outcome worse than the
    // silence this replaces.
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "connected" },
      ]),
    );
    expect(noticesOf(events)).toHaveLength(0);
  });

  it("reports the connection failure ONCE, not twice, when the server also failed", async () => {
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      withTools(
        [
          { name: "comfyui", status: "connected" },
          { name: "panel", status: "failed" },
        ],
        ["mcp__comfyui__generate_image"],
      ),
    );
    const notices = noticesOf(events);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("started without");
  });
});

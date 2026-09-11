import { it, expect } from "vitest";
import { DshBackend, dshMcpServers } from "../../orchestrator/dsh-backend.js";
const A = '["provider","a"]',
  B = '["provider","b"]';
function fixture({
  fail = false,
  resumeFails = false,
  systemAppend = "",
  usageEvents = [] as Array<{ used: number; size: number; sessionId?: string }>,
  noticeEvents = [] as any[],
  failAfterNotices = false,
} = {}) {
  const calls: any[] = [];
  const connections: any[] = [];
  const statuses: any[] = [];
  const connect = async (_: unknown, model = A) => {
    const abort = new AbortController();
    let selected = model;
    const options = () => [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: selected,
        options: [
          { value: A, name: "A" },
          { value: B, name: "B" },
        ],
      },
      {
        id: "reasoning_effort",
        name: "Effort",
        type: "select",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
    ];
    const c: any = {
      info: {
        agentCapabilities: { promptCapabilities: { image: model === B } },
      },
      close: async () => {
        c.closed = true;
        abort.abort();
      },
      rpc: {
        signal: abort.signal,
        newSession: async (p: any) => {
          calls.push(["new", p]);
          return { sessionId: "original", configOptions: options() };
        },
        resumeSession: async (p: any) => {
          calls.push(["resume", p]);
          if (resumeFails) throw Error("missing session");
          return { configOptions: options() };
        },
        closeSession: async (p: any) => {
          calls.push(["closeSession", p]);
          return {};
        },
        setSessionConfigOption: async (p: any) => {
          calls.push(["select", p]);
          if (p.configId === "model") selected = p.value;
          return { configOptions: options() };
        },
        cancel: async () => {
          calls.push(["cancel"]);
        },
        prompt: async (p: any) => {
          calls.push(["prompt", p]);
          if (fail) {
            abort.abort();
            throw Error("ACP connection closed");
          }
          for (const usage of usageEvents)
            c.onUpdate?.({
              sessionId: usage.sessionId ?? p.sessionId,
              update: { sessionUpdate: "usage_update", ...usage },
            });
          for (const update of noticeEvents)
            c.onUpdate?.({ sessionId: p.sessionId, update });
          if (failAfterNotices) throw Error("Interrupted test turn");
          if (!noticeEvents.length)
            c.onUpdate?.({
              sessionId: p.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "OK" },
              },
            });
          return { stopReason: "end_turn" };
        },
      },
    };
    connections.push(c);
    return c;
  };
  const backend = new DshBackend({
    cwd: process.cwd(),
    systemAppend,
    status: (s) => statuses.push(s),
    installation: {
      command: "node",
      args: [],
      home: process.cwd(),
      source: "configured",
    },
    connect: connect as any,
  });
  return { backend, calls, connections, statuses };
}
async function* one() {
  yield { text: "only OK" };
}
const textNotice = (text: string, thought = false) => ({
  sessionUpdate: thought ? "agent_thought_chunk" : "agent_message_chunk",
  content: { type: "text", text },
});
const toolStart = (id = "tool") => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  title: "read-only fixture",
});
const toolEnd = (id = "tool") => ({
  sessionUpdate: "tool_call_update",
  toolCallId: id,
  status: "completed",
});
async function transcript(noticeEvents: any[], failAfterNotices = false) {
  const f = fixture({ noticeEvents, failAfterNotices }),
    events: any[] = [];
  try {
    for await (const e of f.backend.run({ channel: one(), resume: "original" }))
      events.push(e);
    return events;
  } finally {
    await f.backend.close();
  }
}
it("places the final summary in a new bubble after tool results", async () => {
  const events = await transcript([
    textNotice("inspect", true),
    textNotice("先读取节点。"),
    toolStart(),
    toolEnd(),
    textNotice("验证完毕，已写入。"),
  ]);
  const commits = events.filter((e) => e.type === "assistant");
  expect(commits.map((e) => e.text)).toEqual([
    "先读取节点。",
    "验证完毕，已写入。",
  ]);
  expect(commits[0].id).not.toBe(commits[1].id);
  const finalStart = events.findIndex(
    (e) => e.type === "stream_start" && e.id === commits[1].id,
  );
  expect(finalStart).toBeGreaterThan(
    events.findIndex((e) => e.type === "tool_call" && e.phase === "end"),
  );
  expect(
    events.filter((e) => e.type === "dsh_process").map((e) => e.id),
  ).toEqual([commits[0].id]);
  expect(events.filter((e) => e.type === "result")).toHaveLength(1);
});
it("closes a thought-only bubble before tools without attaching the later summary to it", async () => {
  const events = await transcript([
    textNotice("inspect", true),
    toolStart(),
    toolEnd(),
    textNotice("完成"),
  ]);
  const start = events.find((e) => e.type === "stream_start");
  expect(events.find((e) => e.type === "dsh_thought_end")).toMatchObject({
    id: start.id,
  });
  expect(events.find((e) => e.type === "assistant").id).not.toBe(start.id);
});
it("keeps contiguous text fragments in one bubble and does not duplicate commits for parallel tools", async () => {
  const events = await transcript([
    textNotice("开始"),
    textNotice("检查"),
    toolStart("a"),
    toolStart("b"),
    toolEnd("b"),
    toolEnd("a"),
    textNotice("全部"),
    textNotice("完成"),
  ]);
  expect(
    events.filter((e) => e.type === "assistant").map((e) => e.text),
  ).toEqual(["开始检查", "全部完成"]);
  expect(events.filter((e) => e.type === "stream_start")).toHaveLength(2);
});
it("keeps a normal tool-free answer together", async () => {
  const events = await transcript([
    textNotice("think", true),
    textNotice("A"),
    textNotice("B"),
  ]);
  expect(
    events.filter((e) => e.type === "assistant").map((e) => e.text),
  ).toEqual(["AB"]);
  expect(events.filter((e) => e.type === "stream_start")).toHaveLength(1);
  expect(events.filter((e) => e.type === "dsh_process")).toHaveLength(0);
});
it("closes thought-only streams on failure and reports one failed turn", async () => {
  const events = await transcript([textNotice("thinking", true)], true);
  expect(events.filter((e) => e.type === "dsh_thought_end")).toHaveLength(1);
  expect(events.filter((e) => e.type === "result")).toEqual([
    expect.objectContaining({ ok: false }),
  ]);
});
it("updates the context ring on each ACP usage report, including reset and overflow", async () => {
  const f = fixture({
    usageEvents: [
      { used: 77600, size: 1000000 },
      { used: 128000, size: 1000000 },
      { used: 0, size: 1000000 },
      { used: 2000000, size: 1000000 },
      { used: 900000, size: 1000000, sessionId: "other" },
    ],
  });
  try {
    for await (const _ of f.backend.run({
      channel: one(),
      resume: "original",
      model: A,
    })) {
    }
    expect(f.statuses.map((s) => s.contextPct)).toEqual([0.0776, 0.128, 0, 1]);
    expect(f.statuses.map((s) => s.used)).toEqual([77600, 128000, 0, 2000000]);
    expect(
      f.statuses.every((s) => s.sessionId === "original" && s.model === A),
    ).toBe(true);
  } finally {
    await f.backend.close();
  }
});
it("does not send invalid context ratios to the panel", async () => {
  const f = fixture({
    usageEvents: [
      { used: -1, size: 1000 },
      { used: 1, size: 0 },
      { used: NaN, size: 1000 },
      { used: 1, size: Infinity },
    ],
  });
  try {
    for await (const _ of f.backend.run({
      channel: one(),
      resume: "original",
    })) {
    }
    expect(f.statuses).toEqual([]);
  } finally {
    await f.backend.close();
  }
});
it("injects instructions once for a new session, never on resume, preserving user text", async () => {
  for (const resume of [undefined, "original"]) {
    const f = fixture({ systemAppend: "DSH instructions" });
    async function* turns() {
      yield { text: "用户原文" };
      yield { text: "second" };
    }
    try {
      for await (const _ of f.backend.run({ channel: turns(), resume })) {
      }
      const p = f.calls.filter((c) => c[0] === "prompt");
      expect(p[0][1].prompt[0].text).toBe(
        resume ? "用户原文" : "DSH instructions\n\n用户原文",
      );
      expect(p[1][1].prompt[0].text).toBe("second");
    } finally {
      await f.backend.close();
    }
  }
});
it("uses standard ACP, streams a result, and keeps session identity", async () => {
  const f = fixture();
  const events = [];
  for await (const e of f.backend.run({
    channel: one(),
    resume: "original",
    model: A,
  }))
    events.push(e);
  expect(f.calls.filter((c) => c[0] === "new")).toHaveLength(0);
  const prompts = f.calls.filter((c) => c[0] === "prompt");
  expect(prompts).toHaveLength(1);
  expect(prompts[0][1]).not.toHaveProperty("_meta");
  expect(events.filter((e) => e.type === "result")).toEqual([
    { type: "result", ok: true, subtype: "end_turn", turn: 1 },
  ]);
  expect(events.find((e) => e.type === "assistant")).toMatchObject({
    text: "OK",
    turn: 1,
  });
  await f.backend.close();
});
it("never replays a turn whose connection failed", async () => {
  const f = fixture({ fail: true });
  const events = [];
  for await (const e of f.backend.run({ channel: one(), resume: "original" }))
    events.push(e);
  expect(f.calls.filter((c) => c[0] === "prompt")).toHaveLength(1);
  expect(events.filter((e) => e.type === "result")).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ ok: false });
  await f.backend.close();
});
it("does not replace a failed resume with a new session", async () => {
  const f = fixture({ resumeFails: true });
  await expect(async () => {
    for await (const _ of f.backend.run({
      channel: one(),
      resume: "missing",
    })) {
    }
  }).rejects.toThrow("missing");
  expect(
    f.calls.filter((c) => c[0] === "new" || c[0] === "prompt"),
  ).toHaveLength(0);
  await f.backend.close();
});
it("model change renegotiates image capability and resumes the same session", async () => {
  const f = fixture();
  async function* turns() {
    yield { text: "first" };
    yield { text: "second" };
  }
  let switched = false;
  for await (const e of f.backend.run({
    channel: turns(),
    resume: "original",
    model: A,
  }))
    if (e.type === "result" && !switched) {
      switched = true;
      await f.backend.setModel(B);
    }
  expect(f.connections).toHaveLength(2);
  expect(f.connections[0].closed).toBe(true);
  expect(f.backend.capabilities.vision).toBe(true);
  expect(
    f.calls
      .filter((c) => c[0] === "resume")
      .every((c) => c[1].sessionId === "original"),
  ).toBe(true);
  expect(f.calls.filter((c) => c[0] === "prompt")).toHaveLength(2);
  await f.backend.close();
});
it("model catalog requests share the empty probe instead of creating one per call", async () => {
  const f = fixture();
  const results = await Promise.all([
    f.backend.listModels(),
    f.backend.listModels(),
  ]);
  expect(results[0]).toHaveLength(2);
  expect(f.calls.filter((c) => c[0] === "new")).toHaveLength(1);
  expect(f.calls.filter((c) => c[0] === "prompt")).toHaveLength(0);
  await f.backend.close();
});
it("DSH receives the public HTTP MCP variant and explicit stdio arguments", () => {
  const servers = dshMcpServers({
    panel: { transport: "http", url: "http://127.0.0.1:9198/example" },
    comfyui: {
      transport: "stdio",
      command: process.execPath,
      args: ["index.js"],
      env: { MODE: "compact" },
    },
  });
  expect(servers[0]).toMatchObject({ type: "http", headers: [] });
  expect(servers[1]).toMatchObject({
    command: process.execPath,
    args: ["index.js"],
    env: [{ name: "MODE", value: "compact" }],
  });
});
it("refuses a second live owner and releases ownership on close", async () => {
  const a = fixture(),
    b = fixture();
  for await (const _ of a.backend.run({ channel: one(), resume: "original" })) {
  }
  await expect(async () => {
    for await (const _ of b.backend.run({
      channel: one(),
      resume: "original",
    })) {
    }
  }).rejects.toThrow("already owned");
  expect(b.calls.filter((c) => c[0] === "prompt")).toHaveLength(0);
  await a.backend.close();
  await b.backend.close();
  const c = fixture();
  for await (const _ of c.backend.run({ channel: one(), resume: "original" })) {
  }
  expect(c.calls.filter((c) => c[0] === "prompt")).toHaveLength(1);
  await c.backend.close();
});

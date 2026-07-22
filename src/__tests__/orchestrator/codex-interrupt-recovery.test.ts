import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

type BackendModule = typeof import("../../orchestrator/codex-backend.js");
type Backend = InstanceType<BackendModule["CodexBackend"]>;

let CodexBackend: BackendModule["CodexBackend"];

beforeAll(async () => {
  vi.stubEnv("COMFYUI_MCP_CODEX_INTERRUPT_TIMEOUT_MS", "25");
  vi.stubEnv("COMFYUI_MCP_CODEX_CLOSE_TIMEOUT_MS", "25");
  vi.stubEnv("COMFYUI_MCP_CODEX_FORCE_KILL_GRACE_MS", "10");
  vi.resetModules();
  ({ CodexBackend } = await import("../../orchestrator/codex-backend.js"));
});

afterAll(async () => {
  // Allow detached close-budget checks from intentionally hung fakes to settle.
  await new Promise((resolve) => setTimeout(resolve, 200));
  vi.unstubAllEnvs();
});

const DEADLINE_MS = 250;

async function settlesWithin(promise: Promise<unknown>, timeoutMs = DEADLINE_MS): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function installActiveClient(backend: Backend, client: object): void {
  Object.assign(backend, {
    client,
    threadId: "thread-1",
    turnId: "turn-1",
  });
}

describe("CodexBackend interrupt recovery", () => {
  it("keeps the turn alive while app-server reports a retryable error", async () => {
    const onActivity = vi.fn();
    const client = {
      notificationHandler: null as ((message: unknown) => void) | null,
      exitError: null,
      exitPromise: new Promise(() => {}),
      request: vi.fn(async (method: string) => {
        if (method === "thread/start") {
          return { thread: { id: "thread-1" }, model: "gpt-5.6-sol" };
        }
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        throw new Error(`unexpected request: ${method}`);
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const backend = new CodexBackend({ model: "gpt-5.6-sol" });
    Object.assign(backend, { client });

    async function* channel() {
      yield { text: "continue" };
    }

    const iterator = backend.run({ channel: channel(), onActivity });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "session", sessionId: "thread-1" },
    });
    const nextEvent = iterator.next();
    for (let attempt = 0; attempt < 10 && !(backend as any).turnId; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    client.notificationHandler?.({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: true,
        error: { message: "Reconnecting... 2/5" },
      },
    });
    client.notificationHandler?.({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });

    await expect(nextEvent).resolves.toMatchObject({
      value: { type: "result", ok: true, subtype: "completed" },
    });
    expect(onActivity).toHaveBeenCalledTimes(2);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("still terminates the turn for a non-retrying app-server error", async () => {
    const client = {
      notificationHandler: null as ((message: unknown) => void) | null,
      exitError: null,
      exitPromise: new Promise(() => {}),
      request: vi.fn(async (method: string) => {
        if (method === "thread/start") {
          return { thread: { id: "thread-1" }, model: "gpt-5.6-sol" };
        }
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        throw new Error(`unexpected request: ${method}`);
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const backend = new CodexBackend({ model: "gpt-5.6-sol" });
    Object.assign(backend, { client });

    async function* channel() {
      yield { text: "continue" };
    }

    const iterator = backend.run({ channel: channel() });
    await iterator.next();
    const errorEvent = iterator.next();
    for (let attempt = 0; attempt < 10 && !(backend as any).turnId; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    client.notificationHandler?.({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: { message: "provider unavailable" },
      },
    });

    await expect(errorEvent).resolves.toMatchObject({
      value: { type: "error", message: "provider unavailable" },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "result", ok: false, subtype: "error" },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("keeps a responsive client and bounds an unresponsive one", async () => {
    const responsive = {
      request: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const responsiveBackend = new CodexBackend();
    installActiveClient(responsiveBackend, responsive);

    await expect(responsiveBackend.interrupt()).resolves.toBeUndefined();
    expect(responsive.request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(responsive.close).not.toHaveBeenCalled();
    expect((responsiveBackend as any).client).toBe(responsive);

    const unresponsive = {
      request: vi.fn(() => new Promise(() => {})),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const unresponsiveBackend = new CodexBackend();
    installActiveClient(unresponsiveBackend, unresponsive);

    expect(await settlesWithin(unresponsiveBackend.interrupt())).toBe(true);
    expect(unresponsive.close).toHaveBeenCalledOnce();
    expect((unresponsiveBackend as any).client).toBeNull();
    expect((unresponsiveBackend as any).turnId).toBeNull();
  });

  it("deduplicates concurrent interrupt teardown", async () => {
    let resolveClose!: () => void;
    const client = {
      request: vi.fn(() => new Promise(() => {})),
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveClose = resolve;
          }),
      ),
    };
    const backend = new CodexBackend();
    installActiveClient(backend, client);

    expect(await settlesWithin(Promise.all([backend.interrupt(), backend.interrupt()]))).toBe(true);
    expect(client.close).toHaveBeenCalledOnce();
    expect((backend as any).client).toBeNull();
    resolveClose();
  });

  it("ends an active run even when close and exitPromise never settle", async () => {
    let channelReads = 0;
    const client = {
      notificationHandler: null as ((message: unknown) => void) | null,
      exitError: null,
      exitPromise: new Promise(() => {}),
      request: vi.fn(async (method: string) => {
        if (method === "thread/start") {
          return { thread: { id: "thread-1" }, model: "gpt-5.6-sol" };
        }
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        if (method === "turn/interrupt") return new Promise(() => {});
        throw new Error(`unexpected request: ${method}`);
      }),
      close: vi.fn(() => new Promise(() => {})),
    };
    const backend = new CodexBackend({ model: "gpt-5.6-sol" });
    Object.assign(backend, { client });

    async function* channel() {
      channelReads += 1;
      yield { text: "first" };
      channelReads += 1;
      yield { text: "second" };
    }

    const iterator = backend.run({ channel: channel() });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "session", sessionId: "thread-1" },
    });
    const firstTurnEvent = iterator.next();
    for (let attempt = 0; attempt < 10 && !(backend as any).turnId; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect((backend as any).turnId).toBe("turn-1");

    expect(await settlesWithin(backend.interrupt())).toBe(true);
    await expect(firstTurnEvent).resolves.toMatchObject({
      value: { type: "result", ok: true, subtype: "interrupted" },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(client.close).toHaveBeenCalledOnce();
    expect(channelReads).toBe(1);
  });

  it("does not let a stale timeout clear a replacement client", async () => {
    const oldClient = {
      request: vi.fn(() => new Promise(() => {})),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const replacement = { marker: "replacement" };
    const backend = new CodexBackend();
    installActiveClient(backend, oldClient);

    const interrupting = backend.interrupt();
    Object.assign(backend, {
      client: replacement,
      threadId: "thread-2",
      turnId: "turn-2",
    });

    expect(await settlesWithin(interrupting)).toBe(true);
    expect((backend as any).client).toBe(replacement);
    expect((backend as any).threadId).toBe("thread-2");
    expect((backend as any).turnId).toBe("turn-2");
    expect(oldClient.close).toHaveBeenCalledOnce();
  });

  it("bounds backend shutdown when transport close never settles", async () => {
    const client = {
      notificationHandler: vi.fn(),
      close: vi.fn(() => new Promise(() => {})),
    };
    const backend = new CodexBackend();
    installActiveClient(backend, client);

    expect(await settlesWithin(backend.close())).toBe(true);
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.notificationHandler).toBeNull();
    expect((backend as any).client).toBeNull();
  });

  it("handles a late interrupt rejection without an unhandledRejection", async () => {
    let rejectRequest!: (error: Error) => void;
    const client = {
      request: vi.fn(
        () =>
          new Promise((_, reject) => {
            rejectRequest = reject;
          }),
      ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const backend = new CodexBackend();
    installActiveClient(backend, client);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      expect(await settlesWithin(backend.interrupt())).toBe(true);
      rejectRequest(new Error("late interrupt rejection"));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

// #1929 — Windows can refuse the bundled `codex-code-mode-host.exe` spawn with
// ERROR_SHARING_VIOLATION (os error 32). The first code-mode call failed before
// JS ran; repeating the identical call succeeded. Codex does not retry that
// spawn; CodexBackend.runTurn() must, once, with a short backoff.
//
// These tests drive the live notificationHandler (the same seam as the
// interrupt-recovery suite) so the retry is proven on the shipped turn path.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type BackendModule = typeof import("../../orchestrator/codex-backend.js");
type Backend = InstanceType<BackendModule["CodexBackend"]>;

let CodexBackend: BackendModule["CodexBackend"];
let isWindowsCodeModeHostSharingViolation: BackendModule["isWindowsCodeModeHostSharingViolation"];

beforeAll(async () => {
  vi.stubEnv("COMFYUI_MCP_CODEX_HOST_SPAWN_RETRY_MS", "15");
  vi.resetModules();
  ({ CodexBackend, isWindowsCodeModeHostSharingViolation } = await import(
    "../../orchestrator/codex-backend.js"
  ));
});

afterAll(() => vi.unstubAllEnvs());

/** The reporter's exact (scrubbed) Windows error — French FormatMessage + os error 32. */
const REPORTER_ERROR =
  "failed to spawn code-mode host ~/AppData/Roaming/nvm/v22.22.3/node_modules/comfyui-mcp/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex-code-mode-host.exe: Le processus ne peut pas acceder au fichier car ce fichier est utilise par un autre processus. (os error 32)";

const MISSING_HOST_ERROR =
  "failed to spawn code-mode host /opt/homebrew/bin/codex-code-mode-host: No such file or directory (os error 2)";

type Handler = ((message: unknown) => void) | null;

async function waitUntil(pred: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function turnStartsOf(request: ReturnType<typeof vi.fn>): number {
  return request.mock.calls.filter((c) => c[0] === "turn/start").length;
}

/** Open a live turn on a fake app-server client and return the notify seam. */
async function liveTurn() {
  let starts = 0;
  const client = {
    notificationHandler: null as Handler,
    exitError: null,
    exitPromise: new Promise(() => {}),
    request: vi.fn(async (method: string) => {
      if (method === "thread/start") return { thread: { id: "thread-1" }, model: "gpt-5.6-sol" };
      if (method === "turn/start") {
        starts += 1;
        return { turn: { id: `turn-${starts}` } };
      }
      throw new Error(`unexpected request: ${method}`);
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const backend: Backend = new CodexBackend({ model: "gpt-5.6-sol" });
  Object.assign(backend, { client });

  async function* channel() {
    yield { text: "read ALL_TOOLS" };
  }

  const iterator = backend.run({ channel: channel() });
  await iterator.next(); // session
  const pending = iterator.next();
  await waitUntil(() => (backend as Backend & { turnId?: string }).turnId === "turn-1");

  const notify = (msg: Record<string, unknown>) => client.notificationHandler?.(msg);
  return { backend, client, iterator, pending, notify };
}

describe("isWindowsCodeModeHostSharingViolation (#1929)", () => {
  it("matches the reporter's French os-error-32 host spawn", () => {
    expect(isWindowsCodeModeHostSharingViolation(REPORTER_ERROR)).toBe(true);
  });

  it("matches the English sharing-violation wording", () => {
    expect(
      isWindowsCodeModeHostSharingViolation(
        "failed to spawn code-mode host C:\\codex-code-mode-host.exe: The process cannot access the file because it is being used by another process. (os error 32)",
      ),
    ).toBe(true);
  });

  it("does not match a missing host (os error 2) — that is not transient", () => {
    expect(isWindowsCodeModeHostSharingViolation(MISSING_HOST_ERROR)).toBe(false);
  });

  it("does not match an unrelated os-error-32", () => {
    expect(
      isWindowsCodeModeHostSharingViolation(
        "The process cannot access the file because it is being used by another process. (os error 32)",
      ),
    ).toBe(false);
  });
});

describe("CodexBackend code-mode host spawn retry (#1929)", () => {
  it("retries the turn once after the reporter's sharing-violation, then succeeds", async () => {
    const { backend, client, iterator, pending, notify } = await liveTurn();
    expect(turnStartsOf(client.request)).toBe(1);

    notify({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: { message: REPORTER_ERROR },
      },
    });

    await waitUntil(() => turnStartsOf(client.request) >= 2);
    await waitUntil(() => (backend as Backend & { turnId?: string }).turnId === "turn-2");

    notify({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed" } },
    });

    await expect(pending).resolves.toMatchObject({
      value: { type: "result", ok: true, subtype: "completed" },
    });
    expect(turnStartsOf(client.request)).toBe(2);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("a racing turn/completed for the failed turn does not prevent the retry", async () => {
    const { backend, client, iterator, pending, notify } = await liveTurn();

    notify({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: { message: REPORTER_ERROR },
      },
    });
    notify({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed" } },
    });

    await waitUntil(() => turnStartsOf(client.request) >= 2);
    await waitUntil(() => (backend as Backend & { turnId?: string }).turnId === "turn-2");

    notify({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed" } },
    });

    await expect(pending).resolves.toMatchObject({
      value: { type: "result", ok: true, subtype: "completed" },
    });
    expect(turnStartsOf(client.request)).toBe(2);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("a second sharing-violation after the retry is terminal", async () => {
    const { backend, client, iterator, pending, notify } = await liveTurn();

    notify({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: { message: REPORTER_ERROR },
      },
    });
    await waitUntil(() => turnStartsOf(client.request) >= 2);
    await waitUntil(() => (backend as Backend & { turnId?: string }).turnId === "turn-2");

    notify({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-2",
        willRetry: false,
        error: { message: REPORTER_ERROR },
      },
    });

    await expect(pending).resolves.toMatchObject({
      value: { type: "error", message: REPORTER_ERROR },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "result", ok: false, subtype: "error" },
    });
    expect(turnStartsOf(client.request)).toBe(2);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("does not retry a missing-host spawn (os error 2)", async () => {
    const { client, iterator, pending, notify } = await liveTurn();

    notify({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: { message: MISSING_HOST_ERROR },
      },
    });

    await expect(pending).resolves.toMatchObject({
      value: { type: "error", message: MISSING_HOST_ERROR },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "result", ok: false, subtype: "error" },
    });
    expect(turnStartsOf(client.request)).toBe(1);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("retries when turn/start itself rejects with the sharing-violation", async () => {
    let startCalls = 0;
    const client = {
      notificationHandler: null as Handler,
      exitError: null,
      exitPromise: new Promise(() => {}),
      request: vi.fn(async (method: string) => {
        if (method === "thread/start") return { thread: { id: "thread-1" }, model: "gpt-5.6-sol" };
        if (method === "turn/start") {
          startCalls += 1;
          if (startCalls === 1) throw new Error(REPORTER_ERROR);
          return { turn: { id: "turn-2" } };
        }
        throw new Error(`unexpected request: ${method}`);
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const backend: Backend = new CodexBackend({ model: "gpt-5.6-sol" });
    Object.assign(backend, { client });

    async function* channel() {
      yield { text: "read ALL_TOOLS" };
    }
    const iterator = backend.run({ channel: channel() });
    await iterator.next();
    const pending = iterator.next();

    await waitUntil(() => startCalls >= 2);
    await waitUntil(() => (backend as Backend & { turnId?: string }).turnId === "turn-2");

    client.notificationHandler?.({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed" } },
    });

    await expect(pending).resolves.toMatchObject({
      value: { type: "result", ok: true, subtype: "completed" },
    });
    expect(startCalls).toBe(2);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });
});

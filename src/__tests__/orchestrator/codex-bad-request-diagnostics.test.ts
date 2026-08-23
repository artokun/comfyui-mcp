// #2114 — a provider 400 can reject the awaited `turn/start` request instead of
// arriving as an app-server `error` notification. That path must still use the
// scrubbed Codex diagnostic formatter and must not silently turn into the bare
// `{"detail":"Bad Request"}` panel message.

import { beforeAll, describe, expect, it, vi } from "vitest";
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

describe("Codex turn/start bad-request diagnostics (#2114)", () => {
  it("formats a rejected 400 and preserves structured request diagnostics", async () => {
    const client = {
      notificationHandler: null as ((message: unknown) => void) | null,
      exitError: null,
      exitPromise: new Promise<void>(() => {}),
      request: vi.fn(async (method: string) => {
        if (method === "thread/start") return { thread: { id: "thread-2114" }, model: "gpt-5.6-sol" };
        if (method === "turn/start") {
          const error = Object.assign(new Error('{"detail":"Bad Request"}'), {
            code: -32600,
            data: {
              code: "invalid_request_error",
              type: "invalid_request",
              request_id: "req_2114",
            },
          });
          throw error;
        }
        throw new Error(`unexpected request: ${method}`);
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const backend: Backend = new CodexBackend({ model: "gpt-5.6-sol" });
    Object.assign(backend, { client, liveCatalog: [{ id: "gpt-5.6-sol" }] });

    async function* channel() {
      yield { text: "apply the prompt" };
    }

    const events: AgentEvent[] = [];
    for await (const event of backend.run({ channel: channel() })) events.push(event);

    const error = events.find(
      (event): event is Extract<AgentEvent, { type: "error" }> => event.type === "error",
    );
    expect(error?.type).toBe("error");
    expect(error?.message).toContain("HTTP 400 Bad Request");
    expect(error?.message).toContain("code=invalid_request_error");
    expect(error?.message).toContain("request_id=req_2114");
    expect(error?.message).not.toContain('{"detail":"Bad Request"}');
    expect(events).toContainEqual({ type: "result", ok: false, subtype: "error", turn: 1 });
    expect(client.request).toHaveBeenCalledTimes(2);
  });
});

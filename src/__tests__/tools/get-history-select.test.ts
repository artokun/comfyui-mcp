import { describe, expect, it, beforeEach, vi } from "vitest";

// Mock the client so the get_history tool is tested in isolation. We only care
// about how it SELECTS "the most recent" entry when no prompt_id is given.
const getHistoryMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getLogs: vi.fn(),
  getHistory: (...a: unknown[]) => getHistoryMock(...a),
}));

import { registerDiagnosticsTools } from "../../tools/diagnostics.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function getHandler(name: string): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => {
      if (n === name) handler = h;
    },
  };
  registerDiagnosticsTools(server as never);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

const entry = (queueNumber: number, id: string) => ({
  prompt: [queueNumber, id, {}, {}, []],
  outputs: {},
  status: { status_str: "success", completed: true, messages: [] },
});

beforeEach(() => {
  getHistoryMock.mockReset();
});

describe("get_history (no prompt_id) selection", () => {
  it("picks the entry with the highest queue number, NOT the dict-last entry", async () => {
    // Dict order would pick "older-run" (inserted last), but its queue number is
    // lower — the real newest is "newest-run" (queue 42). This is the off-by-one
    // that made get_history / the panel's 'Run finished' card lag one render.
    getHistoryMock.mockResolvedValue({
      "newest-run": entry(42, "newest-run"),
      "older-run": entry(41, "older-run"),
    });

    const handler = getHandler("get_history");
    const res = await handler({});
    expect(res.content[0].text).toContain("Execution: newest-run");
    expect(res.content[0].text).not.toContain("Execution: older-run");
  });

  it("still returns the exact entry when a prompt_id is given", async () => {
    getHistoryMock.mockResolvedValue({ "abc-123": entry(7, "abc-123") });
    const handler = getHandler("get_history");
    const res = await handler({ prompt_id: "abc-123" });
    expect(res.content[0].text).toContain("Execution: abc-123");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../../comfyui/client.js";
import { resetClient } from "../../comfyui/client.js";
import { getJobStatus } from "../../services/queue-manager.js";
import { TRACEBACK_MAX_CHARS } from "../../services/job-history.js";

const PROMPT_ID = "prompt-123";
const START = 1_705_505_423_000;

function historyEntry(
  messages: HistoryEntry["status"]["messages"],
  statusStr = "success",
): HistoryEntry {
  return {
    prompt: {},
    outputs: {},
    status: {
      status_str: statusStr,
      completed: true,
      messages,
    },
  };
}

function mockFetchForHistory(entry: HistoryEntry): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const path = String(url);
    if (path.includes("/queue")) {
      return Response.json({ queue_running: [], queue_pending: [] });
    }
    if (path.includes(`/history/${PROMPT_ID}`)) {
      return Response.json({ [PROMPT_ID]: entry });
    }
    return new Response("Unexpected URL", { status: 500 });
  }));
}

describe("getJobStatus history enrichment", () => {
  beforeEach(() => {
    resetClient();
  });

  afterEach(() => {
    resetClient();
    vi.unstubAllGlobals();
  });

  it("adds ComfyUI execution_error details for failed prompts", async () => {
    const longTraceback = `Traceback\n${"x".repeat(TRACEBACK_MAX_CHARS + 100)}`;
    mockFetchForHistory(historyEntry([
      ["execution_start", { prompt_id: PROMPT_ID, timestamp: START }],
      ["executed", { prompt_id: PROMPT_ID, node: "3", timestamp: START + 1200 }],
      ["execution_error", {
        prompt_id: PROMPT_ID,
        node_id: "7",
        node_type: "KSampler",
        exception_message: "CUDA out of memory. Tried to allocate 2.20 GiB",
        exception_type: "RuntimeError",
        traceback: longTraceback,
        current_inputs: { seed: 42, steps: 20 },
        timestamp: START + 2500,
      }],
    ], "error"));

    const status = await getJobStatus(PROMPT_ID);

    expect(status).toMatchObject({
      running: false,
      pending: false,
      done: true,
      status_str: "error",
      error: {
        node_id: "7",
        node_type: "KSampler",
        exception_message: "CUDA out of memory. Tried to allocate 2.20 GiB",
        exception_type: "RuntimeError",
        current_inputs: { seed: 42, steps: 20 },
        traceback_truncated: true,
        is_oom: true,
      },
      execution_stats: {
        total_duration_ms: 2500,
        nodes: {
          "3": { duration_ms: 1200 },
        },
      },
    });
    // #809: the cut is now MARKED inline — a traceback that simply stopped at 2000 chars
    // was indistinguishable, to a reader, from one that ended. The retained payload is
    // still exactly TRACEBACK_MAX_CHARS; the marker rides after it.
    const tb = status.error?.traceback ?? "";
    expect(tb.slice(0, TRACEBACK_MAX_CHARS)).toHaveLength(TRACEBACK_MAX_CHARS);
    expect(tb.slice(TRACEBACK_MAX_CHARS)).toMatch(/more char\(s\) cut at the fixed 2000-char/);
    expect(tb.slice(TRACEBACK_MAX_CHARS)).toContain("get_logs");
  });

  it("adds optional timing stats for successful completed prompts", async () => {
    mockFetchForHistory(historyEntry([
      ["execution_start", { prompt_id: PROMPT_ID, timestamp: START }],
      ["executed", { prompt_id: PROMPT_ID, node: "1", timestamp: START + 100 }],
      ["executed", { prompt_id: PROMPT_ID, display_node: "2", timestamp: START + 400 }],
      ["execution_success", { prompt_id: PROMPT_ID, timestamp: START + 650 }],
    ]));

    const status = await getJobStatus(PROMPT_ID);

    expect(status).toMatchObject({
      running: false,
      pending: false,
      done: true,
      status_str: "success",
      execution_stats: {
        total_duration_ms: 650,
        nodes: {
          "1": { duration_ms: 100 },
          "2": { duration_ms: 300 },
        },
      },
    });
    expect(status.error).toBeUndefined();
  });
});

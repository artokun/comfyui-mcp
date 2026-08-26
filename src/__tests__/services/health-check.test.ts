import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchApi = vi.fn();
const getQueue = vi.fn();
const getSystemStats = vi.fn();

vi.mock("../../comfyui/client.js", () => ({
  getClient: () => ({ fetchApi }),
  // #385 — call sites moved from `client.fetchApi` to `comfyApiFetch`, which
  // returns a 4xx instead of throwing. Routed to the SAME spy so every
  // existing "which route did we ask for" assertion still pins the same thing.
  comfyApiFetch: (...a: unknown[]) => (fetchApi)(...(a as [string])),
  getQueue: (...args: unknown[]) => getQueue(...args),
  getSystemStats: (...args: unknown[]) => getSystemStats(...args),
}));

// Imported after the mock so the module picks up the stub.
const { runHealthCheck } = await import("../../services/health-check.js");

describe("runHealthCheck", () => {
  beforeEach(() => {
    fetchApi.mockReset();
    getQueue.mockReset();
    getSystemStats.mockReset();

    getSystemStats.mockResolvedValue({
      system: {
        python_version: "3.11.0",
        comfyui_version: "0.5.0",
        pytorch_version: "2.4.0",
        ram_free: 8 * 1024 ** 3,
      },
      devices: [
        {
          name: "NVIDIA GeForce RTX 4090",
          vram_total: 24 * 1024 ** 3,
          vram_free: 22 * 1024 ** 3,
        },
      ],
    });
    getQueue.mockResolvedValue({ queue_running: [], queue_pending: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reports version, GPU, queue, and populated model categories", async () => {
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/models/checkpoints") {
        return new Response(JSON.stringify(["sd_xl_base_1.0.safetensors"]), {
          status: 200,
        });
      }
      if (path === "/internal/logs") {
        return new Response("startup ok\nready\n", { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const text = await runHealthCheck({
      modelCategories: ["checkpoints", "loras"],
    });

    expect(text).toContain("**ComfyUI**: 0.5.0");
    expect(text).toContain("VRAM free 22.0/24.0 GB");
    expect(text).toContain("**Queue**: 0 running, 0 pending");
    expect(text).toContain("checkpoints: 1");
    expect(text).toContain("loras: **EMPTY**");
  });

  it("surfaces a recent error from /internal/logs", async () => {
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/internal/logs") {
        return new Response(
          "startup ok\nTraceback (most recent call last):\n  File 'x.py'\n",
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const text = await runHealthCheck({ modelCategories: ["checkpoints"] });
    expect(text).toContain("Recent errors");
    expect(text).toMatch(/Traceback/);
  });

  it("throws ConnectionError when ComfyUI is unreachable", async () => {
    getSystemStats.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:8188"));
    await expect(
      runHealthCheck({ modelCategories: ["checkpoints"] }),
    ).rejects.toThrow(/ComfyUI unreachable/);
    expect(getSystemStats).toHaveBeenCalledWith({ diagnosticContext: "health" });
  });
});

// #1146 — recent_errors:0 means "show me none", and it returned EVERYTHING.
//
// `slice(-0)` is `slice(0)`: -0 === 0 in JS, so the negative-index reading never
// happens and the whole array comes back. A reporter asking for zero got the
// full historical ComfyUI log and a response truncated at ~12k tokens — the
// opposite of the request, from the one argument value meant to suppress it.
describe("recent_errors as a limit (#1146)", () => {
  const LOG = [
    "Traceback (most recent call last):",
    "  File a.py, line 1",
    "ERROR: node blew up",
    "startup ok",
    "Exception: boom",
  ].join("\n");

  // This block is a sibling of the suite above, so it needs its own stats stub —
  // runHealthCheck reads system/devices before it ever reaches the log section.
  beforeEach(() => {
    fetchApi.mockReset();
    getSystemStats.mockReset();
    getQueue.mockReset();
    getSystemStats.mockResolvedValue({
      system: { python_version: "3.11.0", comfyui_version: "0.5.0", ram_free: 8 * 1024 ** 3 },
      devices: [{ name: "GPU", vram_total: 24 * 1024 ** 3, vram_free: 22 * 1024 ** 3 }],
    });
    getQueue.mockResolvedValue({ queue_running: [], queue_pending: [] });
  });

  function serverWithLog() {
    fetchApi.mockImplementation(async (path: string) =>
      path === "/internal/logs"
        ? new Response(LOG, { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 }),
    );
  }

  it("0 returns NO error lines — not all of them", async () => {
    serverWithLog();
    const text = await runHealthCheck({ modelCategories: [], recentErrors: 0 });
    expect(text).not.toMatch(/Traceback/);
    expect(text).not.toMatch(/node blew up/);
    expect(text).not.toMatch(/Recent errors\*\* \(last/);
  });

  it("0 says NOT REQUESTED — it must not claim the log is clean", async () => {
    // The log was never read for content, so "none in /internal/logs" would
    // assert an absence nobody observed: a caller shrinking a response would be
    // told their server is healthy as a side effect.
    serverWithLog();
    const text = await runHealthCheck({ modelCategories: [], recentErrors: 0 });
    expect(text).toMatch(/not requested \(recent_errors=0\)/);
    expect(text).toMatch(/NOT checked/);
    expect(text).not.toMatch(/none in \/internal\/logs/);
  });

  it("does not even fetch the log when none were asked for", async () => {
    serverWithLog();
    await runHealthCheck({ modelCategories: [], recentErrors: 0 });
    expect(fetchApi.mock.calls.filter((c) => c[0] === "/internal/logs")).toHaveLength(0);
  });

  it("a positive limit still takes the LAST N matching lines", async () => {
    serverWithLog();
    const text = await runHealthCheck({ modelCategories: [], recentErrors: 1 });
    expect(text).toMatch(/Recent errors\*\* \(last 1\)/);
    // The most recent match, not the first.
    expect(text).toMatch(/Exception: boom/);
    expect(text).not.toMatch(/Traceback/);
  });

  it("a genuinely clean log still reports none — the honest empty is preserved", async () => {
    fetchApi.mockImplementation(async (path: string) =>
      path === "/internal/logs"
        ? new Response("startup ok\nready\n", { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 }),
    );
    const text = await runHealthCheck({ modelCategories: [], recentErrors: 20 });
    expect(text).toMatch(/none in \/internal\/logs/);
  });

  it("a negative limit is treated as zero, not as a slice from the end", async () => {
    serverWithLog();
    const text = await runHealthCheck({ modelCategories: [], recentErrors: -5 });
    expect(text).toMatch(/not requested/);
    expect(text).not.toMatch(/Traceback/);
  });

  it("does not match normal log lines containing the word 'error' as a substring", async () => {
    // Issue #2329: normal output like "0 errors found" or "no errors" gets matched
    // by /error/i but should not be treated as actual error lines.
    fetchApi.mockImplementation(async (path: string) =>
      path === "/internal/logs"
        ? new Response(
            "startup ok\nImport check: 0 errors found\nModel load status: 0 errors\n[ERROR] Real error occurred here\nStartup: 0 errors during init\n",
            { status: 200 }
          )
        : new Response(JSON.stringify([]), { status: 200 }),
    );
    const text = await runHealthCheck({ modelCategories: [], recentErrors: 10 });
    // Should only match the real [ERROR] line, not the "0 errors" lines
    expect(text).toMatch(/Real error occurred here/);
    expect(text).toMatch(/Recent errors\*\* \(last 1\)/);
    expect(text).not.toMatch(/0 errors found/);
    expect(text).not.toMatch(/0 errors during/);
  });

  it("filters lines by actual error severity, not substring matching", async () => {
    // Only lines with [ERROR], [EXCEPTION], or Traceback markers should be kept
    fetchApi.mockImplementation(async (path: string) =>
      path === "/internal/logs"
        ? new Response(
            [
              "2026-08-25T20:00:00 [INFO] ComfyUI startup",
              "2026-08-25T20:00:01 [INFO] Import successful: 0 errors",
              "2026-08-25T20:00:02 [WARNING] Some warning message",
              "2026-08-25T20:00:03 [ERROR] Connection error on port 8188",
              "2026-08-25T20:00:04 [ERROR] Failed to load model",
            ].join("\n"),
            { status: 200 }
          )
        : new Response(JSON.stringify([]), { status: 200 }),
    );
    const text = await runHealthCheck({ modelCategories: [], recentErrors: 10 });
    // Should only have 2 error lines
    expect(text).toMatch(/Recent errors\*\* \(last 2\)/);
    expect(text).toMatch(/Connection error/);
    expect(text).toMatch(/Failed to load model/);
    expect(text).not.toMatch(/0 errors/);
    expect(text).not.toMatch(/Some warning/);
  });

  it("matches ERROR: prefix format without brackets", async () => {
    // Python logging format: ERROR:root:message or ERROR:module:message
    fetchApi.mockImplementation(async (path: string) =>
      path === "/internal/logs"
        ? new Response(
            [
              "2026-08-25T20:00:00 [INFO] startup",
              "2026-08-25T20:00:01 DEBUG: Some debug info, 0 errors found",
              "2026-08-25T20:00:02 ERROR:root:Failed to load model weights",
              "2026-08-25T20:00:03 INFO: Model cached, 0 errors so far",
              "2026-08-25T20:00:04 ERROR:comfyui.loader:Checkpoint not found",
            ].join("\n"),
            { status: 200 }
          )
        : new Response(JSON.stringify([]), { status: 200 }),
    );
    const text = await runHealthCheck({ modelCategories: [], recentErrors: 10 });
    // Should only have 2 ERROR: lines, not the 0 errors or debug lines
    expect(text).toMatch(/Recent errors\*\* \(last 2\)/);
    expect(text).toMatch(/Failed to load model/);
    expect(text).toMatch(/Checkpoint not found/);
    expect(text).not.toMatch(/0 errors/);
    expect(text).not.toMatch(/DEBUG/);
  });

  it("groups error marker with continuation lines before slicing", async () => {
    // Regression: if we slice the lines array after adding continuations, we might
    // return only a continuation line without its error marker.
    fetchApi.mockImplementation(async (path: string) =>
      path === "/internal/logs"
        ? new Response(
            [
              "2026-08-25T20:00:00 [INFO] startup",
              "Traceback (most recent call last):",
              "  File a.py, line 1, in module",
              "  File b.py, line 2, in func",
              "  ValueError: invalid value",
              "2026-08-25T20:00:01 [ERROR] Later error",
            ].join("\n"),
            { status: 200 }
          )
        : new Response(JSON.stringify([]), { status: 200 }),
    );
    const text = await runHealthCheck({ modelCategories: [], recentErrors: 1 });
    // With recent_errors:1, should get the LAST error group, which is the simple [ERROR] line.
    // NOT the continuation line "ValueError: invalid value" without its traceback context.
    expect(text).toMatch(/Recent errors\*\* \(last 1\)/);
    expect(text).toMatch(/Later error/);
    expect(text).not.toMatch(/ValueError/);
  });

  it("handles non-string JSON responses from /internal/logs", async () => {
    // If /internal/logs returns JSON that's not a string (e.g., {"error":"failed"}),
    // we should not crash on text.split() but fall back to raw text.
    fetchApi.mockImplementation(async (path: string) =>
      path === "/internal/logs"
        ? new Response(JSON.stringify({ error: "backend failure" }), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 }),
    );
    const text = await runHealthCheck({ modelCategories: [], recentErrors: 10 });
    // Should not crash and should report none found
    expect(text).toMatch(/Recent errors/);
    // The raw JSON object converted to string won't have error markers, so no errors found
    expect(text).toMatch(/none in \/internal\/logs/);
  });
});

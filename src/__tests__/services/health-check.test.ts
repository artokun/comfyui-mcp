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

// #2347 — the #2329 severity predicate was keyed on two shapes stock ComfyUI never
// emits, so the health report silently omitted real render failures and issued an
// explicit all-clear for the commonest one. Each row here is a faithful
// /internal/logs body: the route joins records as `l["t"] + " - " + l["m"]`, so every
// line carries a timestamp prefix — which is why `^Traceback` could never fire, and
// why severity must be matched on the entry BODY.
//
// The case that decides this issue is the OOM pair: before the fix they produced
// output byte-identical to a healthy server, in the diagnostic users paste into bug
// reports. "none in /internal/logs" for a crashed render is worse than the blob #2329
// removed.
describe("recent_errors sees ComfyUI's own failures (#2347)", () => {
  const TS = "2026-08-26T07:00:00.000Z";
  const logBody = (...messages: string[]): string =>
    JSON.stringify(messages.map((m) => TS + " - " + m + "\n").join(""));

  const healthFor = async (body: string): Promise<string> => {
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/internal/logs") return new Response(body, { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    });
    return runHealthCheck({ modelCategories: [], recentErrors: 10 });
  };

  it("A: keeps the exception header AND the frames, not just the tail", async () => {
    const text = await healthFor(
      logBody(
        "!!! Exception during processing !!!",
        "Traceback (most recent call last):",
        '  File "x.py", line 1, in run',
        "RuntimeError: shape is invalid",
      ),
    );
    expect(text).not.toMatch(/Recent errors\*\*: none/);
    // The tail alone is not enough — it names the exception without locating it.
    expect(text).toContain("RuntimeError: shape is invalid");
    expect(text).toContain("Exception during processing");
    expect(text).toContain("Traceback (most recent call last):");
    expect(text).toContain("x.py");
  });

  it("B: an OOM during processing is NOT reported as a healthy server", async () => {
    const text = await healthFor(
      logBody(
        "!!! Exception during processing !!! Allocation on device",
        "Got an OOM, unloading all loaded models.",
      ),
    );
    expect(text).not.toMatch(/Recent errors\*\*: none/);
    expect(text).toContain("Got an OOM");
  });

  it("D: a bare OOM notice with no exception header still reports", async () => {
    const text = await healthFor(logBody("Got an OOM, unloading all loaded models."));
    expect(text).not.toMatch(/Recent errors\*\*: none/);
    expect(text).toContain("Got an OOM");
  });

  it("E: a genuinely healthy log still reports none — the control", async () => {
    // Without this, every assertion above is satisfiable by reporting everything,
    // which is the #2329 blob this must not reintroduce.
    const text = await healthFor(
      logBody("got prompt", "Prompt executed in 3.21 seconds", "0 errors found"),
    );
    expect(text).toMatch(/Recent errors\*\*: none in \/internal\/logs/);
  });
});

// #2355 — ColoredFormatter wraps error/warning markers in ANSI escape sequences,
// so patterns anchored to the start of the body (after stripping timestamp) need
// to strip ANSI first. This catches a WARNING-level gap: a custom-node import
// failure is logged at WARNING but covered only by the `^Traceback` pattern,
// which was dead. ANSI escapes also reach the health report, confusing diagnostics.
describe("handles ANSI escape sequences in log lines (#2355)", () => {
  const TS = "2026-08-26T07:00:00.000Z";
  const ansiRed = "\x1b[1m\x1b[31m";    // bold red
  const ansiYellow = "\x1b[1m\x1b[33m"; // bold yellow
  const ansiReset = "\x1b[0m";           // reset

  const logWithAnsi = (...messages: string[]): string =>
    JSON.stringify(messages.map((m) => TS + " - " + m + "\n").join(""));

  const healthFor = async (body: string): Promise<string> => {
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/internal/logs") return new Response(body, { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    });
    return runHealthCheck({ modelCategories: [], recentErrors: 10 });
  };

  it("strips ANSI escape sequences and matches anchored patterns", async () => {
    // A real ERROR line from ColoredFormatter has ANSI codes prepended
    const text = await healthFor(
      logWithAnsi(
        `${ansiRed}[ERROR]${ansiReset} !!! Exception during processing !!!`,
        "Traceback (most recent call last):",
        '  File "x.py", line 1, in run',
        `${ansiRed}[ERROR]${ansiReset} RuntimeError: shape is invalid`,
      ),
    );
    expect(text).not.toMatch(/Recent errors\*\*: none/);
    expect(text).toContain("RuntimeError: shape is invalid");
    expect(text).toContain("Exception during processing");
    expect(text).toContain("Traceback (most recent call last):");
  });

  it("WARNING-level traceback with ANSI is caught (row C from #2355)", async () => {
    // Custom-node import failures are logged at WARNING level with ANSI escapes
    const text = await healthFor(
      logWithAnsi(
        `${ansiYellow}[WARNING]${ansiReset} Cannot import cv2 module for custom nodes`,
        `${ansiYellow}[WARNING]${ansiReset} Traceback (most recent call last):`,
        '  File "nodes.py", line 2336',
        "  File in import_module",
        `${ansiYellow}[WARNING]${ansiReset} ModuleNotFoundError: No module named 'cv2'`,
      ),
    );
    expect(text).not.toMatch(/Recent errors\*\*: none/);
    // The issue says this should show the traceback header and frames
    expect(text).toContain("Traceback");
    expect(text).toContain("ModuleNotFoundError");
    expect(text).toContain("nodes.py");
  });

  it("does not emit raw ANSI escape sequences in the health report", async () => {
    // ANSI control characters should not appear in the emitted report
    const text = await healthFor(
      logWithAnsi(
        `${ansiRed}[ERROR]${ansiReset} !!! Exception during processing !!!`,
        "Traceback (most recent call last):",
        '  File "x.py"',
        `${ansiRed}[ERROR]${ansiReset} RuntimeError: boom`,
      ),
    );
    // Should not contain the ANSI escape sequences (x1b is the ESC character)
    expect(text).not.toContain("\x1b[");
    expect(text).not.toContain("[0m");
    // But should contain the actual error message
    expect(text).toContain("RuntimeError: boom");
    expect(text).toContain("Exception during processing");
  });

  it("handles OOM notice with ANSI codes", async () => {
    const text = await healthFor(
      logWithAnsi(
        `${ansiRed}[ERROR]${ansiReset} !!! Exception during processing !!!`,
        `${ansiRed}[ERROR]${ansiReset} Got an OOM, unloading all loaded models.`,
      ),
    );
    expect(text).not.toMatch(/Recent errors\*\*: none/);
    expect(text).toContain("Got an OOM");
    expect(text).not.toContain("\x1b[");
  });

  it("correctly strips ANSI while preserving indented frame lines", async () => {
    // Frame lines are indented and should be preserved even when subsequent
    // lines have ANSI codes
    const text = await healthFor(
      logWithAnsi(
        `${ansiRed}[ERROR]${ansiReset} Traceback (most recent call last):`,
        '  File "a.py", line 1, in <module>',
        '  File "b.py", line 2, in func',
        `${ansiRed}[ERROR]${ansiReset} ValueError: invalid value`,
      ),
    );
    expect(text).not.toMatch(/Recent errors\*\*: none/);
    expect(text).toContain("Traceback");
    expect(text).toContain("a.py");
    expect(text).toContain("b.py");
    expect(text).toContain("ValueError");
  });

  it("control: genuinely healthy log with ANSI codes still reports none", async () => {
    // A healthy log might have startup messages with ANSI formatting
    const text = await healthFor(
      logWithAnsi(
        `${ansiYellow}[INFO]${ansiReset} ComfyUI startup`,
        `${ansiYellow}[INFO]${ansiReset} Import successful: 0 errors`,
        `${ansiYellow}[INFO]${ansiReset} Ready to process`,
      ),
    );
    expect(text).toMatch(/Recent errors\*\*: none in \/internal\/logs/);
  });
});


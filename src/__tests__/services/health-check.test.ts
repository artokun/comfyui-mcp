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

// #2355 — the two anchors #2347 added (`^!!! Exception during processing` and
// `^Traceback\(`) could not fire on a real server, for one layer down from the
// reason #2329's `^Traceback` could not: ColoredFormatter.format() prepends an
// ANSI-wrapped `[LEVEL]` tag before delegating, so it sits between the timestamp
// prefix and the anchor.
//
// The fixtures below are the SHAPE MEASURED from ComfyUI 0.34.0's own logger —
// captured by importing app/logger.py, running its setup_logger(), emitting through
// the exact production call sites, and serialising the deque the way
// api_server/routes/internal/internal_routes.py:24 does. #2347's table was built by
// reconstructing the format from its description instead, which is precisely why it
// shipped two patterns that never matched. Only the file paths are shortened here;
// the load-bearing bytes are verbatim.
//
// Three facts a reconstruction gets wrong, all of which these encode:
//   * the tag is bold+colour for WARNING and above, colour-only below it, so INFO is
//     `\x1b[32m[INFO]\x1b[0m ` with no bold;
//   * a record's tag and timestamp appear on its FIRST physical line only — the
//     continuation lines of a multi-line message (every traceback frame, and the
//     exception tail) carry neither;
//   * `logging.x(traceback.format_exc())` leaves a trailing BLANK line, because
//     format_exc() already ends in a newline and the handler appends its terminator.
describe("recent_errors survives ColoredFormatter's ANSI [LEVEL] tag (#2355)", () => {
  const TS = "2026-08-26T07:00:00.000000";
  // app/logger.py: f"{ANSI_BOLD}{colour}[{levelname}]{ANSI_RESET} ", bold only >= WARNING.
  const ERR = "\x1b[1m\x1b[31m[ERROR]\x1b[0m ";
  const WARN = "\x1b[1m\x1b[33m[WARNING]\x1b[0m ";
  const INFO = "\x1b[32m[INFO]\x1b[0m ";

  /**
   * One /internal/logs body. Each argument is ONE logging call, so the timestamp
   * goes on its first physical line only and the handler's terminator newline ends
   * it — which is how the next record's timestamp comes to butt straight against it.
   */
  const payload = (...records: string[]): string =>
    JSON.stringify(records.map((m) => `${TS} - ${m}\n`).join(""));

  const healthFor = async (body: string): Promise<string> => {
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/internal/logs") return new Response(body, { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    });
    return runHealthCheck({ modelCategories: [], recentErrors: 20 });
  };

  // Row C of #2355, and the only row with no other cover: a custom-node import
  // failure is logged at WARNING (nodes.py:2335-2336 — the traceback FIRST, then the
  // "Cannot import" line), so the `[ERROR]`/`[EXCEPTION]` clause does not reach it.
  // Before the fix the backward walk stopped dead: the `[WARNING] Traceback` line was
  // not a header, not indented and not blank, so the user got the exception name with
  // nothing that located it.
  it("row C: a WARNING-level traceback keeps its header and its frames", async () => {
    const text = await healthFor(
      payload(
        `${WARN}Traceback (most recent call last):\n` +
          '  File "C:\\ComfyUI\\nodes.py", line 2313, in load_custom_node\n' +
          "    module_spec.loader.exec_module(module)\n" +
          '  File "C:\\ComfyUI\\custom_nodes\\comfyui_controlnet_aux\\__init__.py", line 2, in <module>\n' +
          "    import comfyui_controlnet_aux\n" +
          "ModuleNotFoundError: No module named 'comfyui_controlnet_aux'\n",
        `${WARN}Cannot import C:\\ComfyUI\\custom_nodes\\comfyui_controlnet_aux module for custom nodes: No module named 'comfyui_controlnet_aux'`,
      ),
    );
    expect(text).not.toMatch(/Recent errors\*\*: none/);
    // The exception name alone was what #2347 set out to stop being the whole report.
    expect(text).toContain("Traceback (most recent call last):");
    expect(text).toContain("nodes.py");
    expect(text).toContain("comfyui_controlnet_aux\\__init__.py");
    expect(text).toContain("ModuleNotFoundError: No module named 'comfyui_controlnet_aux'");
  });

  // Rows D and E: a second, independent gap. execution.py:637 formats the header as
  // f"!!! Exception during processing !!! {ex}", which is EMPTY for a zero-arg
  // exception, and the traceback's tail then renders with no colon — so #2347's
  // `/^[A-Za-z0-9_.]*(Error|Exception)\s*:/` dropped it and the report named no
  // exception at all.
  it("row D: a zero-arg KeyboardInterrupt is still named", async () => {
    const text = await healthFor(
      payload(
        `${ERR}!!! Exception during processing !!! `,
        `${ERR}Traceback (most recent call last):\n` +
          '  File "C:\\ComfyUI\\execution.py", line 619, in execute\n' +
          "    output_data, output_ui, has_subgraph = get_output_data(obj, input_data_all)\n" +
          "KeyboardInterrupt\n",
      ),
    );
    expect(text).not.toMatch(/Recent errors\*\*: none/);
    // The TAIL, as its own emitted line — `toContain` alone cannot tell it apart from
    // a frame that happens to mention the same name, which is how row E first passed
    // under the mutation that drops the tail entirely.
    expect(text).toMatch(/^ {2}KeyboardInterrupt$/m);
    expect(text).toContain("execution.py");
  });

  it("row E: a bare zero-arg RuntimeError is still named", async () => {
    const text = await healthFor(
      payload(
        `${ERR}!!! Exception during processing !!! `,
        `${ERR}Traceback (most recent call last):\n` +
          '  File "C:\\ComfyUI\\custom_nodes\\pack\\node.py", line 41, in sample\n' +
          "    raise RuntimeError\n" +
          "RuntimeError\n",
      ),
    );
    expect(text).not.toMatch(/Recent errors\*\*: none/);
    // Not `toContain("RuntimeError")`: the frame above the tail is `raise RuntimeError`,
    // so that assertion is satisfied by the frame whether or not the tail survives.
    expect(text).toMatch(/^ {2}RuntimeError$/m);
    expect(text).toContain("node.py");
  });

  // Rows A and B keep working. They are carried by the pre-existing `[ERROR]` clause
  // rather than by the new anchors, so they are a REGRESSION guard, not proof the
  // anchors fire — row C is what proves that.
  it("row A: an ERROR-level render failure reports header, frames and tail", async () => {
    const text = await healthFor(
      payload(
        `${ERR}!!! Exception during processing !!! mat1 and mat2 shapes cannot be multiplied (1x768 and 1024x1024)`,
        `${ERR}Traceback (most recent call last):\n` +
          '  File "C:\\ComfyUI\\execution.py", line 619, in execute\n' +
          "    raise RuntimeError(...)\n" +
          "RuntimeError: mat1 and mat2 shapes cannot be multiplied (1x768 and 1024x1024)\n",
      ),
    );
    expect(text).toContain("!!! Exception during processing !!!");
    expect(text).toContain("RuntimeError: mat1 and mat2 shapes cannot be multiplied");
  });

  it("row B: the OOM notice is still reported", async () => {
    const text = await healthFor(
      payload(
        `${ERR}!!! Exception during processing !!! Allocation on device`,
        `${ERR}Got an OOM, unloading all loaded models.`,
      ),
    );
    expect(text).toContain("Got an OOM, unloading all loaded models.");
  });

  // The report is a diagnostic users paste into bug reports. Raw escape bytes there
  // are noise, and scrubLogLines never stripped them.
  it("no raw ANSI escape reaches the health report", async () => {
    const text = await healthFor(
      payload(
        `${ERR}!!! Exception during processing !!! boom`,
        `${ERR}Traceback (most recent call last):\n` +
          '  File "C:\\ComfyUI\\execution.py", line 619, in execute\n' +
          "RuntimeError: boom\n",
      ),
    );
    expect(text).toContain("RuntimeError: boom");
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/\x1b/);
    expect(text).not.toContain("[0m");
  });

  // The control. A healthy log carries the SAME tags — INFO is colour-only, no bold —
  // and "0 errors found" is the line #2329 was filed about. If this ever goes red the
  // patterns have started matching prose, and the fix has become the bug.
  it("control: a healthy log with the same ANSI tags still reports none", async () => {
    const text = await healthFor(
      payload(
        `${INFO}Total VRAM 24564 MB, total RAM 65413 MB`,
        `${INFO}Using pytorch attention`,
        `${INFO}0 errors found in the model list`,
        `${INFO}Exit code 0 from the last subprocess`,
        `${INFO}Starting server`,
      ),
    );
    expect(text).toMatch(/Recent errors\*\*: none in \/internal\/logs/);
  });
});

import { describe, expect, it, beforeEach, vi } from "vitest";

// Mock the client + validator so diagnose_run is tested in isolation: we care about
// WHICH run it picks, and how it turns a history entry + validation issues into the
// "why did it fail / what's missing" answer a canvas-less client needs.
const getHistoryMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getLogs: vi.fn(),
  getHistory: (...a: unknown[]) => getHistoryMock(...a),
}));

const validateWorkflowMock = vi.fn();
vi.mock("../../services/workflow-validator.js", () => ({
  validateWorkflow: (...a: unknown[]) => validateWorkflowMock(...a),
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

/** A history entry; `messages` carries the execution_error when the run failed. */
const entry = (
  queueNumber: number,
  id: string,
  opts: {
    graph?: Record<string, unknown>;
    error?: Record<string, unknown>;
    status?: string;
  } = {},
) => ({
  prompt: [queueNumber, id, opts.graph ?? { "1": { class_type: "KSampler", inputs: {} } }, {}, []],
  outputs: {},
  status: {
    status_str: opts.status ?? (opts.error ? "error" : "success"),
    completed: !opts.error,
    messages: opts.error ? [["execution_error", opts.error]] : [],
  },
});

const clean = { valid: true, issues: [], summary: "ok" };

beforeEach(() => {
  getHistoryMock.mockReset();
  validateWorkflowMock.mockReset();
  validateWorkflowMock.mockResolvedValue(clean);
});

describe("diagnose_run — run selection", () => {
  it("prefers the most recent FAILED run over a newer successful one", async () => {
    // The user asks "why did it fail?" after kicking off something that worked —
    // the failure is what they mean, even though it isn't the newest entry.
    getHistoryMock.mockResolvedValue({
      "old-fail": entry(1, "old-fail", { error: { node_id: 7, node_type: "VAEDecode" } }),
      "new-ok": entry(2, "new-ok"),
    });
    const res = await getHandler("diagnose_run")({});
    expect(res.content[0].text).toContain("old-fail");
    expect(res.content[0].text).toContain("VAEDecode");
  });

  it("falls back to the most recent run when nothing failed", async () => {
    getHistoryMock.mockResolvedValue({
      a: entry(1, "a"),
      b: entry(2, "b"),
    });
    const res = await getHandler("diagnose_run")({});
    expect(res.content[0].text).toContain("Diagnosis: b");
    expect(res.content[0].text).toContain("No runtime error recorded");
  });

  it("honors an explicit prompt_id", async () => {
    getHistoryMock.mockResolvedValue({ specific: entry(1, "specific") });
    const res = await getHandler("diagnose_run")({ prompt_id: "specific" });
    expect(getHistoryMock).toHaveBeenCalledWith("specific");
    expect(res.content[0].text).toContain("Diagnosis: specific");
  });

  it("reports cleanly when there is no history at all", async () => {
    getHistoryMock.mockResolvedValue({});
    const res = await getHandler("diagnose_run")({});
    expect(res.content[0].text).toContain("No execution history");
  });
});

describe("diagnose_run — failure explanation", () => {
  it("names the failed node, exception type/message, and trims a long traceback", async () => {
    const traceback = Array.from({ length: 40 }, (_, i) => `frame ${i}\n`);
    getHistoryMock.mockResolvedValue({
      p: entry(1, "p", {
        error: {
          node_id: 12,
          node_type: "CheckpointLoaderSimple",
          exception_type: "FileNotFoundError",
          exception_message: "model.safetensors not found",
          traceback,
        },
      }),
    });
    const text = (await getHandler("diagnose_run")({})).content[0].text;
    expect(text).toContain("Failed node**: 12 (CheckpointLoaderSimple)");
    expect(text).toContain("FileNotFoundError");
    expect(text).toContain("model.safetensors not found");
    // Only the tail is included — a full traceback would flood the agent's context.
    expect(text).toContain("frame 39");
    expect(text).not.toContain("frame 0\n");
  });

  it("surfaces missing models with the exact file and the widget holding it", async () => {
    getHistoryMock.mockResolvedValue({ p: entry(1, "p", { error: { node_id: 3 } }) });
    validateWorkflowMock.mockResolvedValue({
      valid: false,
      summary: "bad",
      issues: [
        {
          severity: "error",
          kind: "missing_model",
          node_id: "3",
          node_type: "CheckpointLoaderSimple",
          input: "ckpt_name",
          value: "sdxl_base.safetensors",
          message: "not in list",
        },
      ],
    });
    const text = (await getHandler("diagnose_run")({})).content[0].text;
    expect(text).toContain("Missing models");
    expect(text).toContain("sdxl_base.safetensors");
    expect(text).toContain("ckpt_name");
    expect(text).toContain("search_civitai_models"); // actionable next step
  });

  it("surfaces missing node types, de-duplicated", async () => {
    getHistoryMock.mockResolvedValue({ p: entry(1, "p") });
    validateWorkflowMock.mockResolvedValue({
      valid: false,
      summary: "bad",
      issues: [
        { severity: "error", kind: "missing_node_type", node_id: "1", node_type: "IPAdapter", message: "x" },
        { severity: "error", kind: "missing_node_type", node_id: "2", node_type: "IPAdapter", message: "x" },
      ],
    });
    const text = (await getHandler("diagnose_run")({})).content[0].text;
    expect(text).toContain("Missing node types");
    // De-duplicated: one bullet for the pack, not one per node.
    expect(text.match(/- \*\*IPAdapter\*\*/g)?.length).toBe(1);
    expect(text).toContain("install_custom_node");
  });

  it("separates other validation errors from missing models/nodes", async () => {
    getHistoryMock.mockResolvedValue({ p: entry(1, "p") });
    validateWorkflowMock.mockResolvedValue({
      valid: false,
      summary: "bad",
      issues: [
        { severity: "error", kind: "value_not_in_list", node_id: "5", node_type: "KSampler", message: "bad sampler" },
        { severity: "warning", kind: "disconnected", node_id: "9", node_type: "Note", message: "ignored" },
      ],
    });
    const text = (await getHandler("diagnose_run")({})).content[0].text;
    expect(text).toContain("Validation errors");
    expect(text).toContain("bad sampler");
    expect(text).not.toContain("ignored"); // warnings aren't errors
  });

  it("says the graph validates clean when the failure was purely runtime", async () => {
    getHistoryMock.mockResolvedValue({
      p: entry(1, "p", { error: { node_id: 1, exception_type: "RuntimeError" } }),
    });
    const text = (await getHandler("diagnose_run")({})).content[0].text;
    expect(text).toContain("validates clean");
  });

  it("handles a history entry with no recorded graph", async () => {
    getHistoryMock.mockResolvedValue({
      p: { prompt: [1, "p"], outputs: {}, status: { status_str: "error", completed: false, messages: [] } },
    });
    const text = (await getHandler("diagnose_run")({})).content[0].text;
    expect(text).toContain("no recorded graph");
    expect(validateWorkflowMock).not.toHaveBeenCalled();
  });
});

describe("diagnose_run — interrupted runs (mobile#23)", () => {
  // ComfyUI records an interrupted run with status_str "error" plus an
  // execution_interrupted message and NO execution_error. Echoing the raw
  // "error" made cancelled runs read as failures downstream (mobile's
  // classifier keys on the exact word "error" → "Render failed").
  const interruptedEntry = (queueNumber: number, id: string) => ({
    prompt: [queueNumber, id, { "1": { class_type: "KSampler", inputs: {} } }, {}, []],
    outputs: {},
    status: {
      status_str: "error",
      completed: false,
      messages: [
        ["execution_start", { prompt_id: id, timestamp: 1 }],
        ["execution_interrupted", { prompt_id: id, node_id: "5", node_type: "KSampler" }],
      ],
    },
  });

  it("reports Status: interrupted (not error) with an Interrupted section, no Runtime-failure section", async () => {
    getHistoryMock.mockResolvedValue({ p: interruptedEntry(1, "p") });
    const text = (await getHandler("diagnose_run")({ prompt_id: "p" })).content[0].text;
    expect(text).toContain("**Status**: interrupted");
    expect(text).not.toContain("**Status**: error");
    expect(text).toContain("### Interrupted");
    expect(text).toContain("interrupted/cancelled at node 5 (KSampler)");
    expect(text).not.toContain("### Runtime failure");
    expect(text).not.toContain("_No runtime error recorded");
  });

  it("a genuine execution_error wins over an interrupted marker in the same entry", async () => {
    const e = interruptedEntry(1, "p") as { status: { messages: unknown[] } };
    e.status.messages.push([
      "execution_error",
      { node_id: 7, node_type: "VAEDecode", exception_type: "RuntimeError", exception_message: "boom" },
    ]);
    getHistoryMock.mockResolvedValue({ p: e });
    const text = (await getHandler("diagnose_run")({ prompt_id: "p" })).content[0].text;
    expect(text).toContain("**Status**: error");
    expect(text).toContain("### Runtime failure");
    expect(text).not.toContain("### Interrupted");
  });

  it("formatRunOutcome maps an interrupted entry without node info too", async () => {
    const { formatRunOutcome } = await import("../../tools/diagnostics.js");
    const lines = formatRunOutcome({
      prompt: {},
      outputs: {},
      status: {
        status_str: "error",
        completed: false,
        messages: [["execution_interrupted", {}]],
      },
    } as never);
    expect(lines[0]).toBe("**Status**: interrupted");
    expect(lines.join("\n")).toContain("### Interrupted");
  });
});

import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../../comfyui/client.js";
import {
  analyzeHistoryEntry,
  extractExecutionError,
  extractExecutionStats,
  extractTextOutputs,
  hasAffirmativeSuccessStatus,
  historyCompletionTimeMs,
  historyTerminalTimeMs,
} from "../../services/job-history.js";

function historyEntry(messages: unknown): HistoryEntry {
  return {
    prompt: {},
    outputs: {},
    status: {
      status_str: "error",
      completed: true,
      messages,
    },
  } as HistoryEntry;
}

describe("job-history malformed message parsing", () => {
  it("ignores non-array status messages", () => {
    const entry = historyEntry({ type: "execution_error" });

    expect(extractExecutionError(entry)).toBeUndefined();
    expect(extractExecutionStats(entry)).toBeUndefined();
    expect(analyzeHistoryEntry(entry)).toEqual({});
  });

  it("ignores malformed message tuples and missing data objects", () => {
    const entry = historyEntry([
      "execution_start",
      ["execution_start"],
      ["execution_error", null],
      ["executed", "not-an-object"],
      [123, { timestamp: 1 }],
      ["execution_success", ["not-an-object"]],
    ]);

    expect(extractExecutionError(entry)).toBeUndefined();
    expect(extractExecutionStats(entry)).toBeUndefined();
    expect(analyzeHistoryEntry(entry)).toEqual({});
  });
});

// ── Text-preview outputs ────────────────────────────────────────────────
// Text-preview nodes (Preview as Text / ShowText / pack equivalents) write no
// file — they publish into the node's `ui` dict, which /history stores under
// outputs[nodeId]. We only harvested images/videos, so text workflows finished
// with nothing for the agent to report (help-thread report from seanmcmagic).

function outputsEntry(outputs: Record<string, unknown>): HistoryEntry {
  return {
    prompt: {},
    outputs,
    status: { status_str: "success", completed: true, messages: [] },
  } as unknown as HistoryEntry;
}

describe("extractTextOutputs", () => {
  it("extracts the common { text: [string] } shape", () => {
    const entry = outputsEntry({ "7": { text: ["a caption"] } });
    expect(extractTextOutputs(entry)).toEqual([{ node_id: "7", text: ["a caption"] }]);
  });

  it("accepts a bare string and the `string` key variant", () => {
    expect(extractTextOutputs(outputsEntry({ "1": { text: "hello" } }))).toEqual([
      { node_id: "1", text: ["hello"] },
    ]);
    expect(extractTextOutputs(outputsEntry({ "2": { string: ["packy"] } }))).toEqual([
      { node_id: "2", text: ["packy"] },
    ]);
  });

  it("stringifies non-string scalars and preserves empty strings", () => {
    const entry = outputsEntry({ "3": { text: ["", 42, true, "keep"] } });
    expect(extractTextOutputs(entry)).toEqual([
      { node_id: "3", text: ["", "42", "true", "keep"] },
    ]);
  });

  it("reports a ShowText node that legitimately emitted an empty string (#373)", () => {
    // { text: [""] } is a present-but-empty output, not an absent one — it must
    // be reported so the agent sees the node ran and produced "".
    expect(extractTextOutputs(outputsEntry({ "5": { text: [""] } }))).toEqual([
      { node_id: "5", text: [""] },
    ]);
    expect(extractTextOutputs(outputsEntry({ "5": { text: "" } }))).toEqual([
      { node_id: "5", text: [""] },
    ]);
    expect(analyzeHistoryEntry(outputsEntry({ "5": { text: [""] } })).text_outputs).toEqual([
      { node_id: "5", text: [""] },
    ]);
  });

  it("collects text from multiple nodes and ignores image-only nodes", () => {
    const entry = outputsEntry({
      "5": { images: [{ filename: "a.png", subfolder: "", type: "output" }] },
      "6": { text: ["from six"] },
      "8": { text: ["from eight"] },
    });
    expect(extractTextOutputs(entry)).toEqual([
      { node_id: "6", text: ["from six"] },
      { node_id: "8", text: ["from eight"] },
    ]);
  });

  it("returns nothing for image-only, empty, or malformed outputs", () => {
    expect(extractTextOutputs(outputsEntry({ "5": { images: [] } }))).toEqual([]);
    expect(extractTextOutputs(outputsEntry({ "5": { text: [] } }))).toEqual([]);
    expect(extractTextOutputs(outputsEntry({ "5": null as unknown as object }))).toEqual([]);
    expect(extractTextOutputs({ prompt: {}, status: {} } as unknown as HistoryEntry)).toEqual([]);
  });
});

describe("analyzeHistoryEntry text_outputs", () => {
  it("surfaces text_outputs when the run produced text", () => {
    const entry = outputsEntry({ "7": { text: ["reported back"] } });
    expect(analyzeHistoryEntry(entry).text_outputs).toEqual([
      { node_id: "7", text: ["reported back"] },
    ]);
  });

  it("omits text_outputs entirely for an image-only run", () => {
    const entry = outputsEntry({
      "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] },
    });
    expect(analyzeHistoryEntry(entry).text_outputs).toBeUndefined();
    expect("text_outputs" in analyzeHistoryEntry(entry)).toBe(false);
  });
});

describe("extractTextOutputs — real ComfyUI payload", () => {
  // Captured verbatim from a live ComfyUI run (StringConstant -> PreviewAny) on
  // 2026-07-20. Locks the on-the-wire shape so a future refactor can't silently
  // stop reading text-preview results.
  it("reads the exact /history payload PreviewAny produces", () => {
    const entry = outputsEntry({ "2": { text: ["TEXT-PREVIEW-PROOF-42"] } });
    expect(extractTextOutputs(entry)).toEqual([
      { node_id: "2", text: ["TEXT-PREVIEW-PROOF-42"] },
    ]);
    expect(analyzeHistoryEntry(entry).text_outputs).toEqual([
      { node_id: "2", text: ["TEXT-PREVIEW-PROOF-42"] },
    ]);
  });
});

describe("hasAffirmativeSuccessStatus (#751 asset-registration gate)", () => {
  const entryWith = (status: Record<string, unknown>): HistoryEntry =>
    ({ prompt: {}, outputs: {}, status }) as unknown as HistoryEntry;

  it("accepts a genuine success (status_str success, no error messages)", () => {
    expect(
      hasAffirmativeSuccessStatus(
        entryWith({
          status_str: "success",
          completed: true,
          messages: [
            ["execution_start", { timestamp: 1 }],
            ["execution_success", { timestamp: 2 }],
          ],
        }),
      ),
    ).toBe(true);
  });

  it("rejects status_str 'error' even when messages are absent", () => {
    expect(
      hasAffirmativeSuccessStatus(
        entryWith({ status_str: "error", completed: true, messages: [] }),
      ),
    ).toBe(false);
  });

  it("rejects missing status_str / missing status (default-success is not evidence)", () => {
    expect(
      hasAffirmativeSuccessStatus(entryWith({ completed: true, messages: [] })),
    ).toBe(false);
    expect(hasAffirmativeSuccessStatus(entryWith({}))).toBe(false);
  });

  it("rejects a contradictory entry: status_str success but an error/interrupt message exists", () => {
    expect(
      hasAffirmativeSuccessStatus(
        entryWith({
          status_str: "success",
          completed: true,
          messages: [["execution_error", { exception_message: "boom" }]],
        }),
      ),
    ).toBe(false);
    expect(
      hasAffirmativeSuccessStatus(
        entryWith({
          status_str: "success",
          completed: true,
          messages: [["execution_interrupted", {}]],
        }),
      ),
    ).toBe(false);
  });

  it("treats malformed messages as no evidence either way (status_str still decides)", () => {
    // Malformed tuples are dropped by normalization — they are neither an
    // error veto nor success evidence; the affirming status_str carries it.
    expect(
      hasAffirmativeSuccessStatus(
        entryWith({
          status_str: "success",
          completed: true,
          messages: ["execution_error", ["execution_error"], ["execution_error", null]],
        }),
      ),
    ).toBe(true);
  });
});

describe("historyCompletionTimeMs (#751 r4 real-completion-time gate)", () => {
  const NOW = 1_800_000_000_000;
  const entryWith = (messages: unknown[]): HistoryEntry =>
    ({
      prompt: {},
      outputs: {},
      status: { status_str: "success", completed: true, messages },
    }) as unknown as HistoryEntry;

  it("returns the execution_success timestamp (epoch ms)", () => {
    const entry = entryWith([
      ["execution_start", { timestamp: NOW - 5000 }],
      ["execution_success", { timestamp: NOW - 1000 }],
    ]);
    expect(historyCompletionTimeMs(entry, NOW)).toBe(NOW - 1000);
  });

  it("normalizes epoch-seconds timestamps to ms", () => {
    const successS = Math.floor((NOW - 2000) / 1000);
    const entry = entryWith([["execution_success", { timestamp: successS }]]);
    expect(historyCompletionTimeMs(entry, NOW)).toBe(successS * 1000);
  });

  it("does NOT fall back to execution_start (start time is not completion time)", () => {
    const entry = entryWith([["execution_start", { timestamp: NOW - 5000 }]]);
    expect(historyCompletionTimeMs(entry, NOW)).toBeUndefined();
  });

  it("returns undefined when messages are absent or the timestamp is not a number", () => {
    expect(historyCompletionTimeMs(entryWith([]), NOW)).toBeUndefined();
    expect(
      historyCompletionTimeMs(entryWith([["execution_success", {}]]), NOW),
    ).toBeUndefined();
    expect(
      historyCompletionTimeMs(
        entryWith([["execution_success", { timestamp: "soon" }]]),
        NOW,
      ),
    ).toBeUndefined();
  });

  it("rejects implausibly far-future timestamps as untrustworthy", () => {
    const entry = entryWith([
      ["execution_success", { timestamp: NOW + 3_600_000 }],
    ]);
    expect(historyCompletionTimeMs(entry, NOW)).toBeUndefined();
  });
});

describe("#2512 interrupted history is a terminal end event", () => {
  const START = 1_700_000_000_000;
  const INTERRUPT = START + 21 * 60 * 1000 + 8 * 1000;
  const interrupted = (): HistoryEntry =>
    ({
      prompt: {},
      outputs: {},
      status: {
        status_str: "error",
        completed: true,
        messages: [
          ["execution_start", { timestamp: START }],
          ["execution_interrupted", { timestamp: INTERRUPT }],
        ],
      },
    }) as HistoryEntry;

  it("extractExecutionStats measures start → execution_interrupted", () => {
    expect(extractExecutionStats(interrupted())?.total_duration_ms).toBe(INTERRUPT - START);
  });

  it("historyTerminalTimeMs reads the interrupt timestamp (historyCompletionTimeMs stays success-only)", () => {
    const entry = interrupted();
    expect(historyTerminalTimeMs(entry, INTERRUPT + 1_000)).toBe(INTERRUPT);
    expect(historyCompletionTimeMs(entry, INTERRUPT + 1_000)).toBeUndefined();
  });
});

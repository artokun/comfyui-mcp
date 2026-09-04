import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../../comfyui/client.js";

// The watched-path registration tests drive JobWatcher.watch end to end; mock
// the ComfyUI client/config boundary so no real server is needed. The pure
// buildCompletionNotification tests above are unaffected by these mocks (they
// assert no URLs).
const getHistoryMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getHistory: (...a: unknown[]) => getHistoryMock(...a),
  getClient: vi.fn(),
  ensureConnected: vi.fn(),
}));
vi.mock("../../config.js", () => ({
  isCloudMode: () => false,
  getCloudUrl: () => "",
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
}));

import {
  buildCompletionNotification,
  JobWatcher,
  pollIntervalMs,
  watcherTimeoutMs,
} from "../../services/job-watcher.js";
import { AssetRegistry } from "../../services/asset-registry.js";
import type { WorkflowJSON } from "../../comfyui/types.js";
import { waitFor } from "../helpers/wait-for.js";

const PROMPT_ID = "prompt-complete";
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

describe("buildCompletionNotification", () => {
  it("includes failure details and execution stats from history", () => {
    const notification = buildCompletionNotification(
      PROMPT_ID,
      historyEntry([
        ["execution_start", { prompt_id: PROMPT_ID, timestamp: START }],
        ["executed", { prompt_id: PROMPT_ID, node: "4", timestamp: START + 250 }],
        ["execution_error", {
          prompt_id: PROMPT_ID,
          node_id: "9",
          node_type: "VAEDecode",
          exception_message: "CUDA out of memory while decoding",
          exception_type: "RuntimeError",
          traceback: ["Traceback line 1\n", "Traceback line 2\n"],
          current_inputs: { samples: ["8", 0] },
          timestamp: START + 900,
        }],
      ], "error"),
      START,
    );

    expect(notification).toMatchObject({
      prompt_id: PROMPT_ID,
      status: "error",
      duration_ms: 900,
      error: {
        node_id: "9",
        node_type: "VAEDecode",
        exception_message: "CUDA out of memory while decoding",
        exception_type: "RuntimeError",
        traceback: "Traceback line 1\nTraceback line 2\n",
        current_inputs: { samples: ["8", 0] },
        is_oom: true,
      },
      execution_stats: {
        total_duration_ms: 900,
        nodes: {
          "4": { duration_ms: 250 },
        },
      },
    });
  });

  it("ignores malformed history messages while building completion notifications", () => {
    const notification = buildCompletionNotification(
      PROMPT_ID,
      {
        prompt: {},
        outputs: {},
        status: {
          status_str: "error",
          completed: true,
          messages: [
            "execution_error",
            ["execution_error"],
            ["execution_error", null],
            ["executed", "not-an-object"],
          ],
        },
      } as HistoryEntry,
      START,
    );

    expect(notification).toMatchObject({
      prompt_id: PROMPT_ID,
      status: "success",
      outputs: [],
      cached_nodes: [],
    });
    expect(notification.error).toBeUndefined();
    expect(notification.execution_stats).toBeUndefined();
  });

  it("drops malformed image/video refs — never emits filename=undefined (codex r2 P1)", () => {
    const entry = {
      prompt: {},
      outputs: {
        "9": {
          images: [
            { subfolder: "", type: "output" }, // filename missing
            { filename: "", subfolder: "", type: "output" }, // empty filename
            { filename: 123, subfolder: "", type: "output" }, // non-string filename
            null, // not an object at all
            { filename: "good.png", subfolder: "", type: "output" },
          ],
          videos: [{ type: "output" }, { filename: "clip.mp4", type: "output" }],
        },
        // Every ref malformed — the node must drop out entirely, not emit
        // an output entry with zero real files.
        "10": { images: [{ type: "output" }] },
      },
      status: {
        status_str: "success",
        completed: true,
        messages: [
          ["execution_success", { prompt_id: PROMPT_ID, timestamp: START }],
        ],
      },
    } as unknown as HistoryEntry;

    const notification = buildCompletionNotification(PROMPT_ID, entry, START);

    expect(notification.outputs).toEqual([
      {
        node_id: "9",
        images: [expect.objectContaining({ filename: "good.png" })],
      },
    ]);
    expect(notification.video_outputs).toEqual([
      {
        node_id: "9",
        videos: [expect.objectContaining({ filename: "clip.mp4" })],
      },
    ]);
  });

  it("extracts image and video outputs (videos/video/gifs keys)", () => {
    const entry: HistoryEntry = {
      prompt: {},
      outputs: {
        // Node with both an image and a video key — both must be preserved.
        "9": {
          images: [{ filename: "out.png", subfolder: "", type: "output" }],
          videos: [{ filename: "render.mp4", subfolder: "video", type: "output" }],
        },
        // Singular 'video' and 'gifs' on one node accumulate into one entry,
        // in mediaKey order (video before gifs).
        "12": {
          video: [{ filename: "clip.webm", subfolder: "video", type: "output" }],
          gifs: [{ filename: "preview.webp" }],
        },
        // Null node output must be skipped, not crash.
        "13": null,
      },
      status: {
        status_str: "success",
        completed: true,
        messages: [
          ["execution_start", { prompt_id: PROMPT_ID, timestamp: START }],
          ["execution_success", { prompt_id: PROMPT_ID, timestamp: START + 1 }],
        ],
      },
    } as unknown as HistoryEntry;

    const notification = buildCompletionNotification(PROMPT_ID, entry, START);

    expect(notification.outputs).toEqual([
      {
        node_id: "9",
        images: [
          expect.objectContaining({ filename: "out.png", type: "output" }),
        ],
      },
    ]);
    expect(notification.video_outputs).toEqual([
      {
        node_id: "9",
        videos: [
          expect.objectContaining({
            filename: "render.mp4",
            subfolder: "video",
            type: "output",
          }),
        ],
      },
      {
        node_id: "12",
        videos: [
          expect.objectContaining({ filename: "clip.webm", type: "output" }),
          expect.objectContaining({ filename: "preview.webp", type: "output" }),
        ],
      },
    ]);
  });

  it("#2845 collects a SaveVideoDexter dexter_video object as a video output", () => {
    const entry: HistoryEntry = {
      prompt: {},
      outputs: {
        "6335": {
          dexter_video: {
            filename: "ComfyUI_00067_.mp4",
            subfolder: "video",
            type: "output",
          },
        },
      },
      status: {
        status_str: "success",
        completed: true,
        messages: [["execution_success", { prompt_id: PROMPT_ID, timestamp: START }]],
      },
    };

    const notification = buildCompletionNotification(PROMPT_ID, entry, START);

    expect(notification.outputs).toEqual([]);
    expect(notification.video_outputs).toEqual([
      {
        node_id: "6335",
        videos: [
          expect.objectContaining({
            filename: "ComfyUI_00067_.mp4",
            subfolder: "video",
            type: "output",
          }),
        ],
      },
    ]);
  });

  it("#2845 collects an nkd_video array the same way, and ignores nested non-media", () => {
    const entry: HistoryEntry = {
      prompt: {},
      outputs: {
        "44": {
          nkd_video: [
            { filename: "NKD_test__v012.mp4", subfolder: "unionen-time-machine/test", type: "output" },
          ],
        },
        "50": {
          wrapper: { inner: { filename: "hidden.mp4", subfolder: "video", type: "output" } },
          notes: { filename: "readme.txt", type: "output" },
          audio: [{ filename: "take.flac", subfolder: "", type: "output" }],
        },
      },
      status: {
        status_str: "success",
        completed: true,
        messages: [["execution_success", { prompt_id: PROMPT_ID, timestamp: START }]],
      },
    };

    const notification = buildCompletionNotification(PROMPT_ID, entry, START);

    expect(notification.outputs).toEqual([]);
    expect(notification.video_outputs).toEqual([
      {
        node_id: "44",
        videos: [
          expect.objectContaining({
            filename: "NKD_test__v012.mp4",
            subfolder: "unionen-time-machine/test",
            type: "output",
          }),
        ],
      },
    ]);
  });

  it("#2512 interrupted duration/finished-at come from execution_interrupted, not delivery time", () => {
    const interruptAt = START + 21 * 60 * 1000 + 8 * 1000;
    const notification = buildCompletionNotification(
      PROMPT_ID,
      historyEntry(
        [
          ["execution_start", { prompt_id: PROMPT_ID, timestamp: START }],
          ["execution_interrupted", { prompt_id: PROMPT_ID, timestamp: interruptAt }],
        ],
        "error",
      ),
      START,
    );
    expect(notification.status).toBe("interrupted");
    expect(notification.duration_ms).toBe(interruptAt - START);
    expect(Date.parse(notification.timestamp)).toBe(interruptAt);
  });
});

function sampleWorkflow(): WorkflowJSON {
  return {
    "3": { class_type: "KSampler", inputs: { seed: 42, steps: 20, cfg: 7 } },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "ComfyUI", images: ["8", 0] },
    },
  };
}

function completionEntry(opts: {
  statusStr?: string;
  messages?: unknown[];
  outputs?: Record<string, unknown>;
}): HistoryEntry {
  return {
    prompt: [1, "p", sampleWorkflow(), {}, []],
    outputs: opts.outputs ?? {
      "9": {
        images: [{ filename: "watched_00001_.png", subfolder: "", type: "output" }],
      },
    },
    status: {
      ...(opts.statusStr !== undefined ? { status_str: opts.statusStr } : {}),
      completed: true,
      messages: opts.messages ?? [],
    },
  } as unknown as HistoryEntry;
}

/** Drive one watched completion through the real poll track and wait until
 *  handleCompletion has fully finished (it always ends by deleting the
 *  watcher — on success, on history failure, and on write failure alike). */
async function runWatchedCompletion(
  promptId: string,
  entry: HistoryEntry,
): Promise<void> {
  process.env.COMFYUI_JOB_POLL_INTERVAL_S = "0.01";
  getHistoryMock.mockResolvedValue({ [promptId]: entry });
  JobWatcher.watch(promptId, sampleWorkflow());
  try {
    await waitFor(
      () => {
        expect(JobWatcher.listActive()).not.toContain(promptId);
      },
      { timeout: 3000, interval: 10 },
    );
  } finally {
    JobWatcher.unwatch(promptId);
    delete process.env.COMFYUI_JOB_POLL_INTERVAL_S;
  }
}

describe("watched-path asset registration (#751 r3 gate)", () => {
  beforeEach(() => {
    getHistoryMock.mockReset();
    AssetRegistry.configure({ ttlMs: 24 * 60 * 60 * 1000, now: Date.now });
    AssetRegistry.clear();
  });

  afterEach(() => {
    for (const id of JobWatcher.listActive()) JobWatcher.unwatch(id);
    delete process.env.COMFYUI_JOB_POLL_INTERVAL_S;
  });

  it("does NOT register when the history entry's status_str is 'error' (messages absent)", async () => {
    await runWatchedCompletion(
      "watched-error",
      completionEntry({ statusStr: "error", messages: [] }),
    );
    expect(AssetRegistry.list()).toHaveLength(0);
  });

  it("does NOT register when success is only the builder's default (no status_str, malformed messages)", async () => {
    await runWatchedCompletion(
      "watched-default-success",
      completionEntry({
        messages: [
          "execution_error",
          ["execution_error"],
          ["execution_error", null],
        ],
      }),
    );
    expect(AssetRegistry.list()).toHaveLength(0);
  });

  it("registers a genuinely successful watched completion", async () => {
    const ts = Date.now() - 1000;
    await runWatchedCompletion(
      "watched-success",
      completionEntry({
        statusStr: "success",
        messages: [
          ["execution_start", { prompt_id: "watched-success", timestamp: ts - 4000 }],
          ["execution_success", { prompt_id: "watched-success", timestamp: ts }],
        ],
      }),
    );
    const all = AssetRegistry.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      promptId: "watched-success",
      filename: "watched_00001_.png",
      source: "watched",
    });
  });

  it("canonicalizes an unsupported history type on the watched production path", async () => {
    const ts = Date.now() - 1000;
    await runWatchedCompletion(
      "watched-raw-type",
      completionEntry({
        statusStr: "success",
        outputs: {
          "9": {
            images: [{ filename: "watched-raw-type.png", subfolder: "", type: "legacy-output-tag" }],
          },
        },
        messages: [
          ["execution_start", { prompt_id: "watched-raw-type", timestamp: ts - 1 }],
          ["execution_success", { prompt_id: "watched-raw-type", timestamp: ts }],
        ],
      }),
    );

    expect(AssetRegistry.list()[0]).toMatchObject({
      type: "output",
      url: expect.stringContaining("type=output"),
    });
  });
});

describe("watched-path createdAt provenance (#751 r4 gate)", () => {
  beforeEach(() => {
    getHistoryMock.mockReset();
    AssetRegistry.configure({ ttlMs: 24 * 60 * 60 * 1000, now: Date.now });
    AssetRegistry.clear();
  });

  afterEach(() => {
    for (const id of JobWatcher.listActive()) JobWatcher.unwatch(id);
    delete process.env.COMFYUI_JOB_POLL_INTERVAL_S;
  });

  it("uses the entry's real execution_success timestamp when present", async () => {
    const ts = Date.now() - 8000;
    await runWatchedCompletion(
      "watched-ts",
      completionEntry({
        statusStr: "success",
        messages: [
          ["execution_start", { prompt_id: "watched-ts", timestamp: ts - 5000 }],
          ["execution_success", { prompt_id: "watched-ts", timestamp: ts }],
        ],
      }),
    );
    const [rec] = AssetRegistry.list();
    expect(rec.createdAt).toBe(ts);
    expect(rec.createdAtSource).toBe("history");
  });

  it("uses the watch's observed finish time (provenance 'observed') when the entry has no timestamp", async () => {
    const before = Date.now();
    await runWatchedCompletion(
      "watched-nots",
      completionEntry({ statusStr: "success", messages: [] }),
    );
    const after = Date.now();
    const [rec] = AssetRegistry.list();
    expect(rec.createdAtSource).toBe("observed");
    expect(rec.createdAt).toBeGreaterThanOrEqual(before);
    expect(rec.createdAt).toBeLessThanOrEqual(after);
  });

  it("treats a far-future execution_success timestamp as bogus and falls back to observed", async () => {
    await runWatchedCompletion(
      "watched-futurets",
      completionEntry({
        statusStr: "success",
        messages: [
          ["execution_success", { prompt_id: "watched-futurets", timestamp: Date.now() + 3_600_000 }],
        ],
      }),
    );
    const [rec] = AssetRegistry.list();
    expect(rec.createdAtSource).toBe("observed");
    expect(rec.createdAt).toBeLessThan(Date.now() + 60_000);
  });
});

describe("watcher timeout / poll env overrides", () => {
  afterEach(() => {
    delete process.env.COMFYUI_JOB_TIMEOUT_S;
    delete process.env.COMFYUI_JOB_POLL_INTERVAL_S;
  });

  it("defaults to 30 minutes (not the old hardcoded 10)", () => {
    expect(watcherTimeoutMs()).toBe(1800 * 1000);
  });

  it("honors COMFYUI_JOB_TIMEOUT_S", () => {
    process.env.COMFYUI_JOB_TIMEOUT_S = "3600";
    expect(watcherTimeoutMs()).toBe(3600 * 1000);
  });

  it("falls back to the default on garbage / non-positive values", () => {
    process.env.COMFYUI_JOB_TIMEOUT_S = "banana";
    expect(watcherTimeoutMs()).toBe(1800 * 1000);
    process.env.COMFYUI_JOB_TIMEOUT_S = "-5";
    expect(watcherTimeoutMs()).toBe(1800 * 1000);
  });

  it("honors COMFYUI_JOB_POLL_INTERVAL_S with a 2s default", () => {
    expect(pollIntervalMs()).toBe(2000);
    process.env.COMFYUI_JOB_POLL_INTERVAL_S = "5";
    expect(pollIntervalMs()).toBe(5000);
  });
});

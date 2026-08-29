import { describe, expect, it, beforeEach, vi } from "vitest";

// Mock the ComfyUI client + config so reconcile runs against canned /history
// payloads. getClient/ensureConnected are imported by job-watcher (same module
// graph), so the mock must provide them even though reconcile never calls them.
const getHistoryMock = vi.fn();
const getOutputImageMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getHistory: (...a: unknown[]) => getHistoryMock(...a),
  getClient: vi.fn(),
  ensureConnected: vi.fn(),
}));
vi.mock("../../services/image-management.js", () => ({
  getOutputImage: (...a: unknown[]) => getOutputImageMock(...a),
}));
vi.mock("../../config.js", () => ({
  isCloudMode: () => false,
  getCloudUrl: () => "",
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
}));

import { reconcileAssetsFromHistory } from "../../services/asset-reconcile.js";
import { AssetRegistry } from "../../services/asset-registry.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function sampleGraph(): WorkflowJSON {
  return {
    "3": {
      class_type: "KSampler",
      inputs: { seed: 42, steps: 20, cfg: 7, sampler_name: "euler" },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "ComfyUI", images: ["8", 0] },
    },
  };
}

interface EntryOpts {
  queue: number;
  promptId: string;
  filename?: string;
  graph?: unknown;
  outputs?: Record<string, unknown>;
  /** Full status override; defaults to a completed success with
   *  execution_start + execution_success messages at successTs. */
  status?: Record<string, unknown>;
  /** ms epoch for execution_start/execution_success (start = end - 5s).
   *  Omit to produce a success entry with NO timestamp messages. */
  successTs?: number;
}

function historyEntry(opts: EntryOpts) {
  const {
    queue,
    promptId,
    filename = `${promptId}_00001_.png`,
    graph = sampleGraph(),
    outputs = { "9": { images: [{ filename, subfolder: "", type: "output" }] } },
    successTs,
  } = opts;
  const status = opts.status ?? {
    status_str: "success",
    completed: true,
    messages:
      successTs === undefined
        ? []
        : [
            ["execution_start", { prompt_id: promptId, timestamp: successTs - 5000 }],
            ["execution_success", { prompt_id: promptId, timestamp: successTs }],
          ],
  };
  return {
    prompt: [queue, promptId, graph, {}, []],
    outputs,
    status,
  };
}

beforeEach(() => {
  getHistoryMock.mockReset();
  getOutputImageMock.mockReset();
  getOutputImageMock.mockResolvedValue({ base64: "aGk=", mimeType: "image/png", filename: "ok.png" });
  AssetRegistry.configure({ ttlMs: DAY_MS, now: Date.now });
  AssetRegistry.clear();
});

describe("reconcileAssetsFromHistory", () => {
  it("registers outputs from a completed run this session never watched (#751)", async () => {
    const successTs = Date.now() - 10_000;
    getHistoryMock.mockResolvedValue({
      "panel-prompt": historyEntry({ queue: 5, promptId: "panel-prompt", successTs }),
    });

    const result = await reconcileAssetsFromHistory();

    expect(result).toEqual({
      scanned: 1,
      registered: 1,
      skippedExisting: 0,
      skippedUnavailable: 0,
      probeLimitReached: false,
    });
    const [record] = AssetRegistry.list();
    expect(record).toMatchObject({
      promptId: "panel-prompt",
      nodeId: "9",
      filename: "panel-prompt_00001_.png",
      subfolder: "",
      type: "output",
      source: "history-reconcile",
      createdAt: successTs,
      createdAtSource: "history",
    });
    expect(record.assetId).toMatch(/^a_[0-9a-f]{8}$/);
    expect(record.url).toContain("filename=panel-prompt_00001_.png");
    // The recorded graph is the generate_image (action:"regenerate") /
    // get_image (action:"asset_metadata") provenance.
    expect(AssetRegistry.get(record.assetId)?.workflow["3"].class_type).toBe("KSampler");
  });

  it("does not overwrite or duplicate an existing watched registration", async () => {
    const watchedTs = Date.now() - 60_000;
    AssetRegistry.configure({ now: () => watchedTs });
    const [watched] = AssetRegistry.register({
      promptId: "p1",
      workflow: sampleGraph(),
      outputs: [
        {
          node_id: "9",
          images: [
            {
              filename: "p1_00001_.png",
              subfolder: "",
              type: "output",
              url: "http://127.0.0.1:8188/view?filename=p1_00001_.png&subfolder=&type=output",
            },
          ],
        },
      ],
    });
    AssetRegistry.configure({ now: Date.now });

    getHistoryMock.mockResolvedValue({
      p1: historyEntry({
        queue: 9,
        promptId: "p1",
        filename: "p1_00001_.png",
        successTs: Date.now() - 1000,
      }),
    });

    const result = await reconcileAssetsFromHistory();

    expect(result).toEqual({
      scanned: 1,
      registered: 0,
      skippedExisting: 1,
      skippedUnavailable: 0,
      probeLimitReached: false,
    });
    const all = AssetRegistry.list();
    expect(all).toHaveLength(1);
    expect(all[0].assetId).toBe(watched.assetId);
    expect(all[0].source).toBe("watched");
    expect(all[0].createdAt).toBe(watchedTs);
  });

  it("fabricates nothing: skips incomplete, graph-less, and output-less entries", async () => {
    const ts = Date.now() - 1000;
    getHistoryMock.mockResolvedValue({
      running: historyEntry({
        queue: 3,
        promptId: "running",
        status: {
          status_str: "success",
          completed: false,
          messages: [["execution_start", { prompt_id: "running", timestamp: ts }]],
        },
      }),
      nograph: historyEntry({ queue: 2, promptId: "nograph", successTs: ts, graph: {} }),
      nooutput: historyEntry({ queue: 1, promptId: "nooutput", successTs: ts, outputs: {} }),
    });

    const result = await reconcileAssetsFromHistory();

    expect(result.registered).toBe(0);
    expect(AssetRegistry.list()).toHaveLength(0);
  });

  it("registers only entries whose history status AFFIRMATIVELY says success (codex P1)", async () => {
    const ts = Date.now() - 1000;
    getHistoryMock.mockResolvedValue({
      // The codex P1 case: status_str "error" with NO messages — the
      // notification builder would default this to "success".
      "error-no-messages": historyEntry({
        queue: 5,
        promptId: "error-no-messages",
        status: { status_str: "error", completed: true, messages: [] },
      }),
      // Error with the messages key missing entirely.
      "error-messages-missing": historyEntry({
        queue: 4,
        promptId: "error-messages-missing",
        status: { status_str: "error", completed: true },
      }),
      // Unknown status: completed but no status_str at all.
      "status-unknown": historyEntry({
        queue: 3,
        promptId: "status-unknown",
        status: { completed: true, messages: [] },
      }),
      // Contradictory: status_str says success but an execution_error
      // message exists — fail toward NOT registering.
      "status-contradictory": historyEntry({
        queue: 2,
        promptId: "status-contradictory",
        status: {
          status_str: "success",
          completed: true,
          messages: [
            ["execution_error", { prompt_id: "status-contradictory", timestamp: ts, exception_message: "boom" }],
          ],
        },
      }),
      // Control: a genuine success DOES register, proving the scan continued.
      good: historyEntry({ queue: 1, promptId: "good", successTs: ts }),
    });

    const result = await reconcileAssetsFromHistory();

    expect(result.registered).toBe(1);
    const all = AssetRegistry.list();
    expect(all).toHaveLength(1);
    expect(all[0].promptId).toBe("good");
  });

  it("skips entries with no real completion timestamp rather than fabricating one (codex P1)", async () => {
    const ts = Date.now() - 1000;
    getHistoryMock.mockResolvedValue({
      // No messages at all — no execution_success timestamp anywhere.
      timeless: historyEntry({ queue: 4, promptId: "timeless" }),
      // Only execution_start: that is NOT completion time — using it would
      // backdate a long render past the TTL/since boundary and hide it.
      "start-only": historyEntry({
        queue: 3,
        promptId: "start-only",
        status: {
          status_str: "success",
          completed: true,
          messages: [["execution_start", { prompt_id: "start-only", timestamp: ts }]],
        },
      }),
      // Bogus far-future timestamp — untrustworthy.
      "future-ts": historyEntry({ queue: 2, promptId: "future-ts", successTs: Date.now() + 3_600_000 }),
      // Control: properly timestamped success registers.
      good: historyEntry({ queue: 1, promptId: "good", successTs: ts }),
    });

    const result = await reconcileAssetsFromHistory();

    expect(result.registered).toBe(1);
    const all = AssetRegistry.list();
    expect(all).toHaveLength(1);
    expect(all[0].promptId).toBe("good");
    expect(all[0].createdAt).toBe(ts);
  });

  it("rejects malformed image refs — never registers filename=undefined (codex r2 P1)", async () => {
    const ts = Date.now() - 1000;
    getHistoryMock.mockResolvedValue({
      mixed: historyEntry({
        queue: 2,
        promptId: "mixed",
        successTs: ts,
        outputs: {
          "9": {
            images: [
              { subfolder: "", type: "output" }, // filename missing
              { filename: "", subfolder: "", type: "output" }, // empty filename
              { filename: 123, subfolder: "", type: "output" }, // non-string filename
              null, // not an object at all
              { filename: "mixed_00002_.png", subfolder: "", type: "output" },
            ],
          },
        },
      }),
      allbad: historyEntry({
        queue: 1,
        promptId: "allbad",
        successTs: ts,
        outputs: { "9": { images: [{ type: "output" }] } },
      }),
    });

    const result = await reconcileAssetsFromHistory();

    expect(result.registered).toBe(1);
    const all = AssetRegistry.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ promptId: "mixed", filename: "mixed_00002_.png" });
  });

  it("reconciles only the newest maxPrompts completed prompts, ordered by queue number", async () => {
    const ts = Date.now() - 1000;
    getHistoryMock.mockResolvedValue({
      oldest: historyEntry({ queue: 1, promptId: "oldest", successTs: ts }),
      newest: historyEntry({ queue: 3, promptId: "newest", successTs: ts }),
      middle: historyEntry({ queue: 2, promptId: "middle", successTs: ts }),
    });

    const result = await reconcileAssetsFromHistory({ maxPrompts: 2 });

    expect(result).toEqual({
      scanned: 2,
      registered: 2,
      skippedExisting: 0,
      skippedUnavailable: 0,
      probeLimitReached: false,
    });
    const promptIds = AssetRegistry.list().map((r) => r.promptId).sort();
    expect(promptIds).toEqual(["middle", "newest"]);
  });

  it("normalizes epoch-seconds history timestamps to ms", async () => {
    const successMs = Date.now() - 30_000;
    const successS = Math.floor(successMs / 1000);
    getHistoryMock.mockResolvedValue({
      "seconds-prompt": historyEntry({
        queue: 1,
        promptId: "seconds-prompt",
        successTs: successS,
      }),
    });

    await reconcileAssetsFromHistory();

    const [record] = AssetRegistry.list();
    expect(record.createdAt).toBe(successS * 1000);
  });

  it("registers entries older than the TTL but they read as expired (TTL stays authoritative)", async () => {
    AssetRegistry.configure({ ttlMs: 60_000 });
    getHistoryMock.mockResolvedValue({
      "old-prompt": historyEntry({
        queue: 1,
        promptId: "old-prompt",
        successTs: Date.now() - 120_000,
      }),
    });

    const result = await reconcileAssetsFromHistory();

    expect(result.registered).toBe(1);
    expect(AssetRegistry.list()).toHaveLength(0);
  });

  it("uses the guarded consumer and canonicalizes an untrusted history type", async () => {
    const ts = Date.now() - 1000;
    getHistoryMock.mockResolvedValue({
      unsafeType: historyEntry({
        queue: 1,
        promptId: "unsafeType",
        successTs: ts,
        outputs: {
          "9": {
            images: [{ filename: "safe.png", subfolder: "", type: "untrusted-type" }],
          },
        },
      }),
    });

    await reconcileAssetsFromHistory();

    expect(getOutputImageMock).toHaveBeenCalledWith("safe.png", "output", "", {
      requireImageContent: true,
    });
    expect(AssetRegistry.list()[0]).toMatchObject({
      filename: "safe.png",
      type: "output",
      url: expect.stringContaining("type=output"),
    });
  });

  it("stops at the bounded image-probe budget and preserves already validated refs", async () => {
    const ts = Date.now() - 1000;
    const images = Array.from({ length: 4 }, (_, i) => ({
      filename: `many_${i}.png`,
      subfolder: "",
      type: "output",
    }));
    getHistoryMock.mockResolvedValue({
      many: historyEntry({
        queue: 1,
        promptId: "many",
        successTs: ts,
        outputs: { "9": { images } },
      }),
    });

    const result = await reconcileAssetsFromHistory({ maxImageProbes: 2 });

    expect(getOutputImageMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ registered: 2, probeLimitReached: true });
    expect(AssetRegistry.list().map((record) => record.filename).sort()).toEqual(["many_0.png", "many_1.png"]);
  });

  it("does not spend the successful-image budget on failed probes", async () => {
    const ts = Date.now() - 1000;
    getHistoryMock.mockResolvedValue({
      mixed: historyEntry({
        queue: 1,
        promptId: "mixed",
        successTs: ts,
        outputs: {
          "9": {
            images: [
              { filename: "missing.png", subfolder: "", type: "output" },
              { filename: "valid_0.png", subfolder: "", type: "output" },
              { filename: "valid_1.png", subfolder: "", type: "output" },
            ],
          },
        },
      }),
    });
    getOutputImageMock
      .mockRejectedValueOnce(new Error("IMAGE_NOT_FOUND"))
      .mockResolvedValue({ base64: "aGk=", mimeType: "image/png", filename: "valid.png" });

    const result = await reconcileAssetsFromHistory({ maxImageProbes: 2, maxFailedProbes: 2 });

    expect(getOutputImageMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      registered: 2,
      skippedUnavailable: 1,
      probeLimitReached: false,
    });
    expect(AssetRegistry.list().map((record) => record.filename).sort()).toEqual([
      "valid_0.png",
      "valid_1.png",
    ]);
  });
});

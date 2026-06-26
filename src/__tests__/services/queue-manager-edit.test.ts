import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>(
    "../../config.js",
  );
  return { ...actual, isCloudMode: () => false };
});

const getQueueMock = vi.fn();
const deleteQueueItemMock = vi.fn();
const enqueuePromptMock = vi.fn();

vi.mock("../../comfyui/client.js", () => ({
  getClient: vi.fn(),
  getHistory: vi.fn(),
  getQueue: (...args: unknown[]) => getQueueMock(...args),
  interrupt: vi.fn(),
  deleteQueueItem: (...args: unknown[]) => deleteQueueItemMock(...args),
  clearQueue: vi.fn(),
  enqueuePrompt: (...args: unknown[]) => enqueuePromptMock(...args),
}));

const watchMock = vi.fn();
vi.mock("../../services/job-watcher.js", () => ({
  JobWatcher: { watch: (...args: unknown[]) => watchMock(...args) },
}));

import {
  editQueuedJob,
  getQueueSummary,
  getQueuedWorkflow,
  moveQueuedJob,
} from "../../services/queue-manager.js";
import type { QueueStatus } from "../../comfyui/types.js";

const workflow = {
  "1": { class_type: "CLIPTextEncode", inputs: { text: "old prompt" } },
  "2": { class_type: "KSampler", inputs: { steps: 20, cfg: 6 } },
};

const queue: QueueStatus = {
  queue_running: [[7, "running-id", { r: { class_type: "SaveImage", inputs: {} } }, {}, []]],
  queue_pending: [
    [8, "pending-a", workflow, { client_id: "abc" }, []],
    [9, "pending-b", { "3": { class_type: "SaveImage", inputs: {} } }, {}, []],
  ],
};

beforeEach(() => {
  getQueueMock.mockReset();
  deleteQueueItemMock.mockReset();
  enqueuePromptMock.mockReset();
  watchMock.mockReset();
  getQueueMock.mockResolvedValue(queue);
  enqueuePromptMock.mockResolvedValue({ prompt_id: "new-id", queue_remaining: 3 });
});

describe("queue-manager pending job inspection/editing", () => {
  it("omits workflow payloads by default and includes them when requested", async () => {
    const compact = await getQueueSummary();
    expect(compact.pending_jobs[0]).toEqual({ number: 8, prompt_id: "pending-a" });

    const full = await getQueueSummary({ include_workflows: true });
    expect(full.pending_jobs[0]).toMatchObject({
      number: 8,
      prompt_id: "pending-a",
      workflow,
      extra_data: { client_id: "abc" },
    });
    expect(full.running_jobs[0].workflow).toEqual({ r: { class_type: "SaveImage", inputs: {} } });
  });

  it("returns one pending workflow with its queue position", async () => {
    const item = await getQueuedWorkflow("pending-a");
    expect(item).toMatchObject({
      prompt_id: "pending-a",
      number: 8,
      position: 1,
      workflow,
      extra_data: { client_id: "abc" },
    });
  });

  it("moves a pending job by deleting and re-enqueueing at the front", async () => {
    const result = await moveQueuedJob("pending-a", "front");

    expect(deleteQueueItemMock).toHaveBeenCalledWith("pending-a");
    expect(enqueuePromptMock).toHaveBeenCalledWith(
      workflow,
      { client_id: "abc" },
      { front: true },
    );
    expect(watchMock).toHaveBeenCalledWith("new-id", workflow);
    expect(result).toMatchObject({
      old_prompt_id: "pending-a",
      new_prompt_id: "new-id",
      position: "front",
    });
  });

  it("edits queued node inputs and re-enqueues the patched workflow", async () => {
    const result = await editQueuedJob({
      prompt_id: "pending-a",
      node_inputs: {
        "1": { text: "new prompt" },
        "2": { steps: 32 },
      },
      position: "back",
    });

    const patched = enqueuePromptMock.mock.calls[0][0];
    expect(patched).toEqual({
      "1": { class_type: "CLIPTextEncode", inputs: { text: "new prompt" } },
      "2": { class_type: "KSampler", inputs: { steps: 32, cfg: 6 } },
    });
    expect(enqueuePromptMock.mock.calls[0][2]).toEqual({ front: false });
    expect(result.new_prompt_id).toBe("new-id");
    expect(workflow["1"].inputs.text).toBe("old prompt");
  });

  it("rejects edits for a missing pending job", async () => {
    await expect(moveQueuedJob("missing", "back")).rejects.toThrow(/not found/i);
    expect(deleteQueueItemMock).not.toHaveBeenCalled();
  });
});

describe("queue_remaining is the real (non-negative) queue count", () => {
  it("ignores ComfyUI's negative front-enqueue 'number' and reports the live count", async () => {
    // ComfyUI returns a NEGATIVE `number` (priority counter) for front:true,
    // which historically leaked through as queue_remaining: -17.
    enqueuePromptMock.mockResolvedValue({ prompt_id: "new-id", queue_remaining: -17 });

    const result = await moveQueuedJob("pending-a", "front");

    // queue = 1 running + 2 pending = 3 (from the live /queue read), never -17.
    expect(result.queue_remaining).toBe(3);
  });

  it("falls back to a clamped (>= 0) hint when the queue can't be re-read", async () => {
    // First /queue read (getQueuedWorkflow) succeeds; the post-enqueue read fails.
    getQueueMock.mockResolvedValueOnce(queue).mockRejectedValueOnce(new Error("boom"));
    enqueuePromptMock.mockResolvedValue({ prompt_id: "new-id", queue_remaining: -17 });

    const result = await moveQueuedJob("pending-a", "front");

    expect(result.queue_remaining).toBe(0);
  });
});

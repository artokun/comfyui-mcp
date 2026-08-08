import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";

// Mock the ComfyUI client so enqueue + /object_info are observable, and the
// job watcher so no background state is created.
const enqueuePromptMock = vi.fn(async () => ({
  prompt_id: "pid-1",
  queue_remaining: 0,
}));
const getObjectInfoMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  enqueuePrompt: (...a: unknown[]) => enqueuePromptMock(...a),
  getSystemStats: vi.fn(),
  getObjectInfo: (...a: unknown[]) => getObjectInfoMock(...a),
}));

const watchMock = vi.fn();
vi.mock("../../services/job-watcher.js", () => ({
  JobWatcher: { watch: (...a: unknown[]) => watchMock(...a) },
}));

import {
  enqueueWorkflow,
  seedInputRange,
} from "../../services/workflow-executor.js";
import type { ObjectInfo, WorkflowJSON } from "../../comfyui/types.js";
import { logger } from "../../utils/logger.js";

const INT32_MAX = 2147483647;

const OBJECT_INFO: ObjectInfo = {
  ClaudeNode: {
    input: {
      required: {
        prompt: ["STRING", {}],
        seed: [
          "INT",
          { default: 0, min: 0, max: INT32_MAX, control_after_generate: true },
        ],
      },
    },
    output: ["STRING"],
    output_is_list: [false],
    output_name: ["text"],
    name: "ClaudeNode",
    display_name: "Claude",
    description: "",
    category: "api node/text",
    output_node: false,
  },
  KSampler: {
    input: {
      required: {
        seed: ["INT", { default: 0, min: 0, max: 0xffffffffffffffff }],
      },
    },
    output: ["LATENT"],
    output_is_list: [false],
    output_name: ["latent"],
    name: "KSampler",
    display_name: "KSampler",
    description: "",
    category: "sampling",
    output_node: false,
  },
};

function enqueuedWorkflow(): WorkflowJSON {
  return enqueuePromptMock.mock.calls[0][0] as WorkflowJSON;
}

function enqueuedExtraData(): Record<string, unknown> | undefined {
  return enqueuePromptMock.mock.calls[0][1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  enqueuePromptMock.mockClear();
  watchMock.mockClear();
  getObjectInfoMock.mockReset();
  getObjectInfoMock.mockResolvedValue(OBJECT_INFO);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("seedInputRange", () => {
  it("uses the node's declared [min, max] when present", () => {
    expect(seedInputRange(OBJECT_INFO, "ClaudeNode", "seed")).toEqual([
      0,
      INT32_MAX,
    ]);
  });

  it("falls back to the int32 range for an unknown class_type", () => {
    expect(seedInputRange(OBJECT_INFO, "NoSuchNode", "seed")).toEqual([
      0,
      INT32_MAX,
    ]);
  });

  it("falls back to the int32 range when object_info is unavailable", () => {
    expect(seedInputRange(undefined, "ClaudeNode", "seed")).toEqual([
      0,
      INT32_MAX,
    ]);
  });

  it("returns null when the declared bounds are incoherent (min > max)", () => {
    const broken = {
      Weird: {
        input: { required: { seed: ["INT", { min: 100, max: 5 }] } },
      },
    } as unknown as ObjectInfo;
    // No safely-drawable value exists inside the declared range; the int32
    // fallback would be OUTSIDE it, so the range is refused, not substituted.
    expect(seedInputRange(broken, "Weird", "seed")).toBeNull();
  });

  it("returns null when the declared minimum is above the safe draw ceiling", () => {
    const huge = {
      Huge: {
        input: {
          required: {
            seed: ["INT", { min: 2 ** 60, max: 2 ** 64 - 1 }],
          },
        },
      },
    } as unknown as ObjectInfo;
    expect(seedInputRange(huge, "Huge", "seed")).toBeNull();
  });

  it("rounds fractional declared bounds inward to integers inside the range", () => {
    const frac = {
      Frac: {
        input: { required: { seed: ["INT", { min: 0.5, max: 10.9 }] } },
      },
    } as unknown as ObjectInfo;
    expect(seedInputRange(frac, "Frac", "seed")).toEqual([1, 10]);
  });

  it("honors a declared max wider than int32 (KSampler 2^64-1)", () => {
    const [min, max] = seedInputRange(OBJECT_INFO, "KSampler", "seed");
    expect(min).toBe(0);
    expect(max).toBeGreaterThan(INT32_MAX);
    // …but the draw ceiling is clamped to exactly-representable doubles.
    expect(max).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });
});

describe("enqueueWorkflow seed randomization (#865)", () => {
  it("never draws above the node's declared max (ClaudeNode int32)", async () => {
    // With the old fixed 2**32 range this draw lands at 4294967291, which
    // ComfyUI rejects with "Value 4294967291 bigger than max of 2147483647".
    vi.spyOn(Math, "random").mockReturnValue(0.9999999);
    await enqueueWorkflow({
      "1": { class_type: "ClaudeNode", inputs: { prompt: "hi", seed: 1 } },
    });
    const seed = enqueuedWorkflow()["1"].inputs.seed as number;
    expect(seed).toBeLessThanOrEqual(INT32_MAX);
    // Assert the exact draw, not just the bound: min + floor(r * (max-min+1)).
    expect(seed).toBe(Math.floor(0.9999999 * (INT32_MAX + 1)));
  });

  it("uses the int32 fallback when the class_type is unknown to object_info", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9999999);
    await enqueueWorkflow({
      "1": { class_type: "CustomNodeNotInObjectInfo", inputs: { seed: 1 } },
    });
    const seed = enqueuedWorkflow()["1"].inputs.seed as number;
    expect(seed).toBeLessThanOrEqual(INT32_MAX);
    expect(seed).toBe(Math.floor(0.9999999 * (INT32_MAX + 1)));
  });

  it("still enqueues with the int32 fallback when /object_info cannot be fetched", async () => {
    getObjectInfoMock.mockRejectedValue(new Error("server mid-restart"));
    vi.spyOn(Math, "random").mockReturnValue(0.9999999);
    const result = await enqueueWorkflow({
      "1": { class_type: "ClaudeNode", inputs: { seed: 1 } },
    });
    expect(result.prompt_id).toBe("pid-1");
    // Exact fallback draw — proves the seed WAS re-randomized within the
    // int32 range (seed 1 passing `<= INT32_MAX` alone would also pass if
    // the failure path silently stopped randomizing).
    const seed = enqueuedWorkflow()["1"].inputs.seed as number;
    expect(seed).toBe(Math.floor(0.9999999 * (INT32_MAX + 1)));
  });

  it("leaves the seed untouched when the declared range has no safe draw", async () => {
    getObjectInfoMock.mockResolvedValue({
      HugeMin: {
        input: {
          required: { seed: ["INT", { min: 2 ** 60, max: 2 ** 64 - 1 }] },
        },
      },
    });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    await enqueueWorkflow({
      "1": { class_type: "HugeMin", inputs: { seed: 2 ** 60 } },
    });
    expect(enqueuedWorkflow()["1"].inputs.seed).toBe(2 ** 60);
  });

  it("draws within a wider declared range when the node allows it", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    await enqueueWorkflow({
      "3": { class_type: "KSampler", inputs: { seed: 1 } },
    });
    const seed = enqueuedWorkflow()["3"].inputs.seed as number;
    // Exact draw distinguishes the declared range (clamped to
    // MAX_SAFE_INTEGER) from the old fixed 2**32 range: 0.5 * 2**32 would
    // give 2**31, not 2**52.
    expect(seed).toBe(0.5 * (Number.MAX_SAFE_INTEGER + 1));
  });

  it("leaves inputs named in preserve_seed_inputs exactly as supplied", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    await enqueueWorkflow(
      {
        "3": {
          class_type: "KSampler",
          inputs: { seed: 42, noise_seed: 7 },
        },
      },
      { preserve_seed_inputs: ["seed"] },
    );
    const inputs = enqueuedWorkflow()["3"].inputs;
    expect(inputs.seed).toBe(42); // caller-fixed, untouched
    expect(inputs.noise_seed).not.toBe(7); // still re-randomized
  });

  it("does not touch any seed when disable_random_seed is set", async () => {
    await enqueueWorkflow(
      {
        "1": { class_type: "ClaudeNode", inputs: { seed: 1 } },
        "3": { class_type: "KSampler", inputs: { seed: 42 } },
      },
      { disable_random_seed: true },
    );
    const wf = enqueuedWorkflow();
    expect(wf["1"].inputs.seed).toBe(1);
    expect(wf["3"].inputs.seed).toBe(42);
  });

  it("registers the job watcher with the workflow actually sent", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    await enqueueWorkflow({
      "1": { class_type: "ClaudeNode", inputs: { seed: 1 } },
    });
    expect(watchMock).toHaveBeenCalledTimes(1);
    expect(watchMock.mock.calls[0][0]).toBe("pid-1");
    expect(watchMock.mock.calls[0][1]).toEqual(enqueuedWorkflow());
  });
});

describe("enqueueWorkflow UI metadata", () => {
  it("attaches UI metadata generated from the post-randomization workflow", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    await enqueueWorkflow({
      "3": { class_type: "KSampler", inputs: { seed: 1 } },
    });

    const randomizedSeed = enqueuedWorkflow()["3"].inputs.seed;
    const extraPngInfo = enqueuedExtraData()?.extra_pnginfo as Record<string, unknown>;
    const ui = extraPngInfo.workflow as {
      nodes: Array<{ type: string; widgets_values?: unknown[] }>;
    };
    const sampler = ui.nodes.find((node) => node.type === "KSampler");
    expect(randomizedSeed).toBe(0.5 * (Number.MAX_SAFE_INTEGER + 1));
    expect(sampler?.widgets_values).toContain(randomizedSeed);
  });

  it("nested-merges generated metadata with existing request data", async () => {
    const extraData = {
      api_key_comfy_org: "credential",
      client_id: "client-123",
      partial_execution: { targets: ["9"] },
      extra_pnginfo: { source: "caller" },
    };

    await enqueueWorkflow(
      { "1": { class_type: "ClaudeNode", inputs: { prompt: "hi", seed: 7 } } },
      { disable_random_seed: true, extra_data: extraData },
    );

    const sent = enqueuedExtraData()!;
    expect(sent).toMatchObject({
      api_key_comfy_org: "credential",
      client_id: "client-123",
      partial_execution: { targets: ["9"] },
      extra_pnginfo: { source: "caller" },
    });
    const extraPngInfo = sent.extra_pnginfo as Record<string, unknown>;
    expect((extraPngInfo.workflow as { nodes: unknown[] }).nodes).toHaveLength(1);
    expect(extraData).toEqual({
      api_key_comfy_org: "credential",
      client_id: "client-123",
      partial_execution: { targets: ["9"] },
      extra_pnginfo: { source: "caller" },
    });
  });

  it("nested-merges metadata without replacing a valid caller workflow", async () => {
    const callerWorkflow = { nodes: [], links: [], version: 0.4 };
    const extraData = {
      api_key_comfy_org: "credential",
      client_id: "client-123",
      partial_execution: { targets: ["9"] },
      extra_pnginfo: {
        workflow: callerWorkflow,
        source: "caller",
      },
    };

    await enqueueWorkflow(
      { "1": { class_type: "ClaudeNode", inputs: { prompt: "hi", seed: 7 } } },
      { disable_random_seed: true, extra_data: extraData },
    );

    expect(enqueuedExtraData()).toEqual(extraData);
    expect(extraData.extra_pnginfo.workflow).toBe(callerWorkflow);
    expect(getObjectInfoMock).not.toHaveBeenCalled();
  });

  it("logs converter warnings and still attaches the generated UI metadata", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    await enqueueWorkflow(
      { custom: { class_type: "ClaudeNode", inputs: { prompt: "hi", seed: 7 } } },
      { disable_random_seed: true },
    );

    const extraPngInfo = enqueuedExtraData()?.extra_pnginfo as Record<string, unknown>;
    expect((extraPngInfo.workflow as { nodes: unknown[] }).nodes).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      "Workflow UI metadata conversion completed with warnings",
      expect.objectContaining({ warnings: expect.arrayContaining([expect.stringContaining("remapped")]) }),
    );
  });

  it("fails open and enqueues the original prompt exactly once when conversion throws", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const malformed = { "1": null } as unknown as WorkflowJSON;
    const extraData = { client_id: "client-123" };

    const result = await enqueueWorkflow(malformed, {
      disable_random_seed: true,
      extra_data: extraData,
    });

    expect(result.prompt_id).toBe("pid-1");
    expect(enqueuePromptMock).toHaveBeenCalledTimes(1);
    expect(enqueuePromptMock).toHaveBeenCalledWith(malformed, extraData);
    expect(warn).toHaveBeenCalledWith(
      "Workflow UI metadata conversion failed; enqueueing without it",
      expect.objectContaining({ error: expect.any(String) }),
    );
  });
});

// A non-object extra_pnginfo cannot be merged into, and spreading it would
// DISCARD whatever the caller put there. Attaching UI metadata is an
// enhancement; dropping a field the caller set would be a regression.
describe("enqueueWorkflow UI metadata — a field we cannot merge into is left alone", () => {
  it("does not drop an ARRAY extra_pnginfo to make room for the workflow", async () => {
    const extraData = { extra_pnginfo: ["caller", "data"], client_id: "c1" };

    await enqueueWorkflow(
      { "1": { class_type: "ClaudeNode", inputs: { prompt: "hi", seed: 7 } } },
      { disable_random_seed: true, extra_data: extraData },
    );

    expect(enqueuedExtraData()).toEqual(extraData);
    expect(enqueuedExtraData()!.extra_pnginfo).toEqual(["caller", "data"]);
  });

  it("does not drop a STRING extra_pnginfo either", async () => {
    const extraData = { extra_pnginfo: "opaque" };

    await enqueueWorkflow(
      { "1": { class_type: "ClaudeNode", inputs: { prompt: "hi", seed: 7 } } },
      { disable_random_seed: true, extra_data: extraData },
    );

    expect(enqueuedExtraData()).toEqual(extraData);
  });
});

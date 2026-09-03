import { describe, expect, it, beforeEach } from "vitest";
import { AssetRegistry, applyOverrides } from "../../services/asset-registry.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

function sampleWorkflow(): WorkflowJSON {
  return {
    "3": {
      class_type: "KSampler",
      inputs: { seed: 42, steps: 20, cfg: 7, sampler_name: "euler" },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: "a cat" },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "ComfyUI", images: ["8", 0] },
    },
  };
}

function sampleOutputs() {
  return [
    {
      node_id: "9",
      images: [
        {
          filename: "ComfyUI_00001_.png",
          subfolder: "",
          type: "output",
          url: "http://localhost:8188/view?filename=ComfyUI_00001_.png&subfolder=&type=output",
        },
      ],
    },
  ];
}

describe("AssetRegistry", () => {
  let now = 1_700_000_000_000;
  const clock = () => now;

  beforeEach(() => {
    now = 1_700_000_000_000;
    AssetRegistry.configure({ ttlMs: 60_000, now: clock });
    AssetRegistry.clear();
  });

  it("registers output images and returns AssetRecords", () => {
    const records = AssetRegistry.register({
      promptId: "p1",
      workflow: sampleWorkflow(),
      outputs: sampleOutputs(),
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      promptId: "p1",
      filename: "ComfyUI_00001_.png",
      subfolder: "",
      type: "output",
      nodeId: "9",
    });
    expect(records[0].assetId).toMatch(/^a_[0-9a-f]{8}$/);
    expect(records[0].url).toContain("filename=ComfyUI_00001_.png");
  });

  it("looks up records by asset id", () => {
    const [rec] = AssetRegistry.register({
      promptId: "p1",
      workflow: sampleWorkflow(),
      outputs: sampleOutputs(),
    });
    const fetched = AssetRegistry.get(rec.assetId);
    expect(fetched?.assetId).toBe(rec.assetId);
    expect(fetched?.workflow["3"].inputs.cfg).toBe(7);
  });

  it("generates deterministic ids for the same (promptId, filename, subfolder, type)", () => {
    const [first] = AssetRegistry.register({
      promptId: "p1",
      workflow: sampleWorkflow(),
      outputs: sampleOutputs(),
    });
    AssetRegistry.clear();
    const [second] = AssetRegistry.register({
      promptId: "p1",
      workflow: sampleWorkflow(),
      outputs: sampleOutputs(),
    });
    expect(first.assetId).toBe(second.assetId);
  });

  it("canonicalizes raw types before identity and URL publication", () => {
    const records = AssetRegistry.register({
      promptId: "p1",
      workflow: sampleWorkflow(),
      source: "history-reconcile",
      outputs: [
        {
          node_id: "9",
          images: [
            {
              filename: "same.png",
              subfolder: "",
              type: "history-specific-tag",
              url: "http://localhost:8188/view?filename=same.png&subfolder=&type=history-specific-tag",
            },
            {
              filename: "same.png",
              subfolder: "",
              type: "output",
              url: "http://localhost:8188/view?filename=same.png&subfolder=&type=output",
            },
          ],
        },
      ],
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "output",
      url: expect.stringContaining("type=output"),
    });
    expect(AssetRegistry.find("p1", {
      filename: "same.png",
      subfolder: "",
      type: "history-specific-tag",
    })?.assetId).toBe(records[0].assetId);
  });

  it("gives watched provenance precedence over history reconciliation", () => {
    const [history] = AssetRegistry.register({
      promptId: "p1",
      workflow: sampleWorkflow(),
      source: "history-reconcile",
      createdAt: now - 500,
      outputs: sampleOutputs(),
    });
    const [watched] = AssetRegistry.register({
      promptId: "p1",
      workflow: { "3": { class_type: "WatchedWorkflow", inputs: {} } },
      source: "watched",
      createdAt: now,
      outputs: sampleOutputs(),
    });

    expect(watched.assetId).toBe(history.assetId);
    expect(AssetRegistry.get(history.assetId)).toMatchObject({
      source: "watched",
      createdAt: now,
      workflow: { "3": { class_type: "WatchedWorkflow" } },
    });

    expect(AssetRegistry.register({
      promptId: "p1",
      workflow: sampleWorkflow(),
      source: "history-reconcile",
      createdAt: now + 100,
      outputs: sampleOutputs(),
    })).toEqual([]);
    expect(AssetRegistry.get(history.assetId)?.source).toBe("watched");
  });

  it("generates distinct ids for different prompts even with same filename", () => {
    const [a] = AssetRegistry.register({
      promptId: "p1",
      workflow: sampleWorkflow(),
      outputs: sampleOutputs(),
    });
    const [b] = AssetRegistry.register({
      promptId: "p2",
      workflow: sampleWorkflow(),
      outputs: sampleOutputs(),
    });
    expect(a.assetId).not.toBe(b.assetId);
  });

  it("lists records newest-first and respects limit", () => {
    AssetRegistry.register({
      promptId: "p1",
      workflow: sampleWorkflow(),
      outputs: sampleOutputs(),
    });
    now += 1000;
    AssetRegistry.register({
      promptId: "p2",
      workflow: sampleWorkflow(),
      outputs: [
        {
          node_id: "9",
          images: [
            {
              filename: "ComfyUI_00002_.png",
              subfolder: "",
              type: "output",
              url: "u",
            },
          ],
        },
      ],
    });
    const all = AssetRegistry.list({});
    expect(all).toHaveLength(2);
    expect(all[0].filename).toBe("ComfyUI_00002_.png");
    expect(all[1].filename).toBe("ComfyUI_00001_.png");

    const limited = AssetRegistry.list({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].filename).toBe("ComfyUI_00002_.png");
  });

  it("prunes expired records when ttl elapses", () => {
    AssetRegistry.register({
      promptId: "p1",
      workflow: sampleWorkflow(),
      outputs: sampleOutputs(),
    });
    expect(AssetRegistry.list({})).toHaveLength(1);
    now += 60_001;
    const pruned = AssetRegistry.prune();
    expect(pruned).toBe(1);
    expect(AssetRegistry.list({})).toHaveLength(0);
  });

  it("get() returns undefined for expired records and prunes them", () => {
    const [rec] = AssetRegistry.register({
      promptId: "p1",
      workflow: sampleWorkflow(),
      outputs: sampleOutputs(),
    });
    now += 60_001;
    expect(AssetRegistry.get(rec.assetId)).toBeUndefined();
  });

  it("multiple SaveImage nodes register multiple records", () => {
    const outputs = [
      {
        node_id: "9",
        images: [
          { filename: "a.png", subfolder: "", type: "output", url: "u1" },
          { filename: "b.png", subfolder: "", type: "output", url: "u2" },
        ],
      },
      {
        node_id: "10",
        images: [
          { filename: "c.png", subfolder: "sub", type: "output", url: "u3" },
        ],
      },
    ];
    const records = AssetRegistry.register({
      promptId: "p1",
      workflow: sampleWorkflow(),
      outputs,
    });
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.filename).sort()).toEqual(["a.png", "b.png", "c.png"]);
  });

  it("ignores empty image arrays without throwing", () => {
    const records = AssetRegistry.register({
      promptId: "p1",
      workflow: sampleWorkflow(),
      outputs: [{ node_id: "9", images: [] }],
    });
    expect(records).toHaveLength(0);
  });

  it("clones the workflow so callers cannot mutate stored snapshots", () => {
    const wf = sampleWorkflow();
    const [rec] = AssetRegistry.register({
      promptId: "p1",
      workflow: wf,
      outputs: sampleOutputs(),
    });
    wf["3"].inputs.cfg = 999;
    const fetched = AssetRegistry.get(rec.assetId);
    expect(fetched?.workflow["3"].inputs.cfg).toBe(7);
  });
});

describe("applyOverrides", () => {
  it("returns a clone when no overrides given", () => {
    const wf = sampleWorkflow();
    const out = applyOverrides(wf, undefined);
    expect(out).not.toBe(wf);
    expect(out["3"].inputs.cfg).toBe(7);
  });

  it("sets matching inputs on every node that has the key", () => {
    const wf: WorkflowJSON = {
      "3": { class_type: "KSampler", inputs: { cfg: 7, steps: 20, seed: 1 } },
      "4": { class_type: "KSamplerAdvanced", inputs: { cfg: 6, noise_seed: 2 } },
      "6": { class_type: "CLIPTextEncode", inputs: { text: "old" } },
    };
    const out = applyOverrides(wf, { cfg: 8, text: "new" });
    expect(out["3"].inputs.cfg).toBe(8);
    expect(out["4"].inputs.cfg).toBe(8);
    expect(out["6"].inputs.text).toBe("new");
    // Untouched fields preserved
    expect(out["3"].inputs.steps).toBe(20);
    expect(out["4"].inputs.noise_seed).toBe(2);
  });

  it("does not add inputs to nodes that lack the key", () => {
    const wf: WorkflowJSON = {
      "3": { class_type: "KSampler", inputs: { cfg: 7 } },
      "6": { class_type: "CLIPTextEncode", inputs: { text: "hi" } },
    };
    const out = applyOverrides(wf, { cfg: 8 });
    expect("cfg" in out["6"].inputs).toBe(false);
  });

  it("does not mutate the original workflow", () => {
    const wf = sampleWorkflow();
    applyOverrides(wf, { cfg: 99 });
    expect(wf["3"].inputs.cfg).toBe(7);
  });
});

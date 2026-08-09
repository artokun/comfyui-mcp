import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Force local mode and stub the underlying SDK Client so getObjectInfo resolves
// against a canned /object_info fixture (no live ComfyUI). Mirrors the pattern
// in comfyui/object-info-cache.test.ts.
vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return { ...actual, isCloudMode: () => false, getComfyUIApiHost: () => "127.0.0.1:8188" };
});

const getNodeDefs = vi.fn();
vi.mock("@stable-canvas/comfyui-client", () => ({
  Client: class {
    // #385 — call sites moved to `comfyApiFetch`, which reuses the library's
    // own routing (apiURL/apiHeaders) and its injected `fetch`, so it can read a
    // 4xx instead of having `fetchApi` throw it away. The double routes `fetch`
    // back through its own `fetchApi`, so every existing impl and spy in this
    // file keeps working and keeps asserting the same route.
    apiURL(p: string) {
      return p;
    }
    apiHeaders(init?: { headers?: unknown }) {
      return (init && init.headers) || {};
    }
    async fetch(u: string, init?: unknown) {
      return (this as unknown as { fetchApi: (u: string, i?: unknown) => unknown }).fetchApi(u, init);
    }
    getNodeDefs = getNodeDefs;
    close() {}
  },
}));

const { dslToWorkflowWithWarnings } = await import("../../tools/workflow-dsl.js");
const { resetObjectInfoCache } = await import("../../comfyui/client.js");

const FIXTURE = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [["model.safetensors"], {}] } },
    output: ["MODEL", "CLIP", "VAE"],
    output_name: ["MODEL", "CLIP", "VAE"],
  },
  KSampler: {
    input: { required: { model: ["MODEL", {}], latent_image: ["LATENT", {}] } },
    output: ["LATENT"],
    output_name: ["LATENT"],
  },
};

describe('visualize_workflow (action:"from_dsl") advisory wiring warnings', () => {
  beforeEach(() => {
    getNodeDefs.mockReset();
    resetObjectInfoCache();
  });
  afterEach(() => vi.clearAllMocks());

  it("emits no warnings for correctly-typed wiring", async () => {
    getNodeDefs.mockResolvedValue(FIXTURE);
    const { warnings } = await dslToWorkflowWithWarnings(
      "1: CheckpointLoaderSimple\n  ckpt_name = \"m.safetensors\"\n3: KSampler\n  model <- 1.0\n",
    );
    expect(warnings).toEqual([]);
  });

  it("flags a type mismatch via slot-compat", async () => {
    getNodeDefs.mockResolvedValue(FIXTURE);
    // output index 1 of CheckpointLoaderSimple is CLIP, but KSampler.model wants MODEL.
    const { warnings } = await dslToWorkflowWithWarnings(
      "1: CheckpointLoaderSimple\n3: KSampler\n  model <- 1.1\n",
    );
    expect(warnings).toContain("type mismatch: 1.1 (CLIP) → 3.model (MODEL)");
  });

  it("flags an output index out of range and lists the real outputs", async () => {
    getNodeDefs.mockResolvedValue(FIXTURE);
    const { warnings } = await dslToWorkflowWithWarnings(
      "1: CheckpointLoaderSimple\n3: KSampler\n  model <- 1.5\n",
    );
    expect(warnings).toContain(
      "output index 5 out of range for CheckpointLoaderSimple (3 outputs: MODEL, CLIP, VAE)",
    );
  });

  it("flags an unknown class_type", async () => {
    getNodeDefs.mockResolvedValue(FIXTURE);
    const { warnings } = await dslToWorkflowWithWarnings("9: TotallyMadeUpNode\n  foo = 1\n");
    expect(warnings).toEqual(['unknown class_type "TotallyMadeUpNode"']);
  });

  it("returns no warnings (and still converts) when ComfyUI is offline", async () => {
    getNodeDefs.mockRejectedValue(new Error("ECONNREFUSED"));
    const { workflow, warnings } = await dslToWorkflowWithWarnings(
      "1: CheckpointLoaderSimple\n3: KSampler\n  model <- 1.1\n",
    );
    expect(warnings).toEqual([]);
    expect(workflow["3"].class_type).toBe("KSampler");
  });
});

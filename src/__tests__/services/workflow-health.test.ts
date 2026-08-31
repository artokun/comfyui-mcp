import { describe, expect, it } from "vitest";
import { analyzeGraphHealth } from "../../services/workflow-health.js";
import type { ObjectInfo, WorkflowJSON } from "../../comfyui/types.js";

// Minimal /object_info covering the node types used across these cases.
const OBJECT_INFO = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [["sd_xl_base.safetensors"], {}] } },
    output: ["MODEL", "CLIP", "VAE"],
    output_node: false,
  },
  CLIPTextEncode: {
    input: { required: { text: ["STRING"], clip: ["CLIP"] } },
    output: ["CONDITIONING"],
    output_node: false,
  },
  KSampler: {
    input: {
      required: {
        model: ["MODEL"],
        positive: ["CONDITIONING"],
        negative: ["CONDITIONING"],
        latent_image: ["LATENT"],
      },
    },
    output: ["LATENT"],
    output_node: false,
  },
  VAEDecode: {
    input: { required: { samples: ["LATENT"], vae: ["VAE"] } },
    output: ["IMAGE"],
    output_node: false,
  },
  SaveImage: {
    input: { required: { images: ["IMAGE"] } },
    output: [],
    output_node: true,
  },
  UpscaleModelLoader: {
    input: { required: { model_name: [["x4.pth"], {}] } },
    output: ["UPSCALE_MODEL"],
    output_node: false,
  },
  EmptyLatentImage: {
    input: { required: { width: ["INT"], height: ["INT"], batch_size: ["INT"] } },
    output: ["LATENT"],
    output_node: false,
  },
  EmptySD3LatentImage: {
    input: { required: { width: ["INT"], height: ["INT"], batch_size: ["INT"] } },
    output: ["LATENT"],
    output_node: false,
  },
  VAEEncode: {
    input: { required: { pixels: ["IMAGE"], vae: ["VAE"] } },
    output: ["LATENT"],
    output_node: false,
  },
  LoadImage: {
    input: { required: { image: [["ref.png"], {}] } },
    output: ["IMAGE", "MASK"],
    output_node: false,
  },
  LatentUpscale: {
    input: { required: { samples: ["LATENT"], width: ["INT"], height: ["INT"] } },
    output: ["LATENT"],
    output_node: false,
  },
  TextEncodeQwenImageEdit: {
    input: {
      required: { clip: ["CLIP"], prompt: ["STRING"] },
      optional: { vae: ["VAE"], image: ["IMAGE"] },
    },
    output: ["CONDITIONING"],
    output_node: false,
  },
  // A reroute: its input slot is the wildcard type, not CONDITIONING.
  Reroute: {
    input: { required: { "": ["*"] } },
    output: ["*"],
    output_node: false,
  },
  // One typed conditioning input and one untyped one — a fork that a CONDITIONING-only
  // count would read as a chain.
  AnyConditioningMux: {
    input: { required: { conditioning: ["CONDITIONING"], alt: ["*"] } },
    output: ["CONDITIONING"],
    output_node: false,
  },
  // One conditioning input plus scalar widgets that can be converted to inputs.
  ConditioningSetTimestepRange: {
    input: { required: { conditioning: ["CONDITIONING"], start: ["INT"], end: ["INT"] } },
    output: ["CONDITIONING"],
    output_node: false,
  },
  ConditioningZeroOut: {
    input: { required: { conditioning: ["CONDITIONING"] } },
    output: ["CONDITIONING"],
    output_node: false,
  },
  // Two inbound CONDITIONING slots: a fork, not a link in a chain.
  ConditioningCombine: {
    input: { required: { conditioning_1: ["CONDITIONING"], conditioning_2: ["CONDITIONING"] } },
    output: ["CONDITIONING"],
    output_node: false,
  },
  // The generic edit-reference node. Deliberately NOT in QWEN_EDIT_ENCODERS -- its
  // reference geometry is whatever latent it is handed, and ComfyUI's own
  // Qwen-Image-Layered templates pair it with an empty layered latent on purpose.
  ReferenceLatent: {
    input: { required: { conditioning: ["CONDITIONING"] }, optional: { latent: ["LATENT"] } },
    output: ["CONDITIONING"],
    output_node: false,
  },
  TextEncodeQwenImageEditPlus: {
    input: {
      required: { clip: ["CLIP"], prompt: ["STRING"] },
      optional: { vae: ["VAE"], image1: ["IMAGE"] },
    },
    output: ["CONDITIONING"],
    output_node: false,
  },
  // A latent generator whose dimensions are driven by real nodes: still all zeros.
  PrimitiveInt: { input: { required: { value: ["INT"] } }, output: ["INT"], output_node: false },
  // An Empty*Latent*-NAMED node that actually derives its latent from an image.
  EmptyLatentFromReference: {
    input: { required: { reference: ["IMAGE"], batch_size: ["INT"] } },
    output: ["LATENT"],
    output_node: false,
  },
  ImageUpscaleWithModel: {
    input: { required: { upscale_model: ["UPSCALE_MODEL"], image: ["IMAGE"] } },
    output: ["IMAGE"],
    output_node: false,
  },
} as unknown as ObjectInfo;

const wf = (nodes: Record<string, unknown>) => nodes as unknown as WorkflowJSON;

describe("analyzeGraphHealth", () => {
  it("reports an isolated node as disconnected", () => {
    const h = analyzeGraphHealth(
      wf({
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "9": { class_type: "SaveImage", inputs: {} },
      }),
      OBJECT_INFO,
    );
    const dc = h.findings.filter((f) => f.kind === "disconnected");
    // Node 1 has no consumers (nothing reads it) and no inbound → isolated.
    expect(dc.some((f) => f.node_ids.includes("1"))).toBe(true);
    // SaveImage is an output node → never flagged disconnected.
    expect(dc.some((f) => f.node_ids.includes("9"))).toBe(false);
  });

  it("reports a duplicate checkpoint load once, listing all node ids", () => {
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "17": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "5": { class_type: "KSampler", inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["4", 2] } },
        "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["17", 2] } },
        "9": { class_type: "SaveImage", inputs: { images: ["6", 0] } },
      }),
      OBJECT_INFO,
    );
    const dup = h.findings.filter((f) => f.kind === "duplicate_model_load");
    expect(dup).toHaveLength(1);
    expect(dup[0].node_ids.sort()).toEqual(["17", "4"]);
    expect(dup[0].detail).toMatch(/sd_xl_base\.safetensors/);
  });

  it("reports an orphaned upscale branch that never reaches a save node", () => {
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "5": { class_type: "KSampler", inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["4", 2] } },
        "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["4", 2] } },
        "9": { class_type: "SaveImage", inputs: { images: ["6", 0] } },
        // Orphaned branch: loader -> upscale, output feeds nothing.
        "22": { class_type: "UpscaleModelLoader", inputs: { model_name: "x4.pth" } },
        "23": { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["22", 0], image: ["6", 0] } },
      }),
      OBJECT_INFO,
    );
    const orphans = h.findings.filter((f) => f.kind === "orphaned_branch");
    expect(orphans).toHaveLength(1);
    // Node 23's output reaches nothing; 22 feeds 23. Both are in the component.
    expect(orphans[0].node_ids).toContain("23");
    expect(orphans[0].node_ids).toContain("22");
  });

  it("flags a graph with NO output node (the 'Prompt has no outputs' failure)", () => {
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "5": { class_type: "KSampler", inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["4", 2] } },
        "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["4", 2] } },
        // No SaveImage / PreviewImage — ComfyUI would reject this prompt.
      }),
      OBJECT_INFO,
    );
    const noOut = h.findings.filter((f) => f.kind === "no_output_reachable");
    expect(noOut).toHaveLength(1);
    expect(noOut[0].detail).toMatch(/Prompt has no outputs/);
    expect(noOut[0].detail).toMatch(/SaveImage/);
  });

  it("does NOT flag no_output_reachable when a save node is present", () => {
    const h = analyzeGraphHealth(
      wf({
        "6": { class_type: "VAEDecode", inputs: {} },
        "9": { class_type: "SaveImage", inputs: { images: ["6", 0] } },
      }),
      OBJECT_INFO,
    );
    expect(h.findings.filter((f) => f.kind === "no_output_reachable")).toHaveLength(0);
  });

  it("groups multiple unreached nodes into one finding per connected component", () => {
    const h = analyzeGraphHealth(
      wf({
        "9": { class_type: "SaveImage", inputs: {} },
        // Component A: 10 -> 11 (unreached, connected to each other)
        "10": { class_type: "UpscaleModelLoader", inputs: { model_name: "x4.pth" } },
        "11": { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["10", 0], image: ["10", 0] } },
        // Component B: 20 -> 21 (separate unreached chain)
        "20": { class_type: "UpscaleModelLoader", inputs: { model_name: "x4.pth" } },
        "21": { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["20", 0], image: ["20", 0] } },
      }),
      OBJECT_INFO,
    );
    const orphans = h.findings.filter((f) => f.kind === "orphaned_branch");
    // Two disjoint components → exactly two findings (not four line items).
    expect(orphans).toHaveLength(2);
    for (const o of orphans) expect(o.node_ids).toHaveLength(2);
  });

  it("falls back to slot-name heuristics for a Sampler-family class absent from object_info", () => {
    const h = analyzeGraphHealth(
      wf({
        // Unknown custom sampler, missing the `model` required input.
        "1": { class_type: "MyCustomSampler", inputs: { positive: ["2", 0], negative: ["2", 0], latent_image: ["2", 0] } },
        "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
      }),
      OBJECT_INFO,
    );
    const missing = h.findings.filter((f) => f.kind === "missing_required_input");
    const modelMiss = missing.find((f) => f.node_ids.includes("1") && /model/.test(f.detail));
    expect(modelMiss).toBeDefined();
    expect(modelMiss?.heuristic).toBe(true);
  });

  it("reports muted/bypassed nodes as info via _meta.mode", () => {
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "9": { class_type: "KSampler", inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["4", 2] }, _meta: { mode: "bypassed" } },
        "10": { class_type: "SaveImage", inputs: { images: ["9", 0] } },
      }),
      OBJECT_INFO,
    );
    const info = h.findings.filter((f) => f.kind === "muted_or_bypassed");
    expect(info).toHaveLength(1);
    expect(info[0].severity).toBe("info");
    expect(info[0].node_ids).toEqual(["9"]);
    expect(info[0].detail).toMatch(/bypassed/);
  });

  it("populates the node-type histogram and total_nodes", () => {
    const h = analyzeGraphHealth(
      wf({
        "1": { class_type: "CLIPTextEncode", inputs: { text: "a", clip: ["4", 1] } },
        "2": { class_type: "CLIPTextEncode", inputs: { text: "b", clip: ["4", 1] } },
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "9": { class_type: "SaveImage", inputs: {} },
      }),
      OBJECT_INFO,
    );
    expect(h.total_nodes).toBe(4);
    expect(h.node_type_histogram.CLIPTextEncode).toBe(2);
    expect(h.node_type_histogram.CheckpointLoaderSimple).toBe(1);
  });

  // --- partial denoise over an empty latent (#2678) -------------------------

  it("flags a sampler running denoise below 1.0 on a latent straight from EmptyLatentImage", () => {
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "8": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
        "9": {
          class_type: "KSampler",
          inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["8", 0], steps: 50, denoise: 0.65 },
        },
        "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 2] } },
        "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
      }),
      OBJECT_INFO,
    );
    const f = h.findings.filter((x) => x.kind === "partial_denoise_empty_latent");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("warning");
    // Both ends of the bad pairing are named so the caller can jump to either.
    expect(f[0].node_ids).toEqual(["9", "8"]);
    expect(f[0].node_type).toBe("KSampler");
    expect(f[0].detail).toMatch(/0\.65/);
    expect(f[0].detail).toMatch(/steps=50/);
    expect(f[0].detail).toMatch(/VAEEncode/);
    // The message must not overclaim across model families: a flat field is the
    // flow-matching outcome, and it is attributed as such rather than asserted
    // for every sampler. EPS models still render an image -- just not an edit.
    expect(f[0].detail).toMatch(/flow-matching/);
    // ...and it must not claim the sampler gets NO source content -- a Qwen edit
    // encoder really does carry the reference on CONDITIONING. The precise claim is
    // that conditioning does not seed the starting state.
    expect(f[0].detail).toMatch(/CONDITIONING/);
    expect(f[0].detail).toMatch(/starting state/);
  });

  // "Is this latent empty?" is decided from real object_info slot TYPES, not from the
  // presence of links. These two cases pull in opposite directions and both must hold.
  const withLatentSource = (source: Record<string, unknown>) =>
    analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "5": { class_type: "LoadImage", inputs: { image: "ref.png" } },
        "7": { class_type: "PrimitiveInt", inputs: { value: 1024 } },
        ...source,
        "9": {
          class_type: "KSampler",
          inputs: {
            model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["8", 0],
            steps: 50, denoise: 0.65,
          },
        },
        "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 2] } },
        "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
      }),
      OBJECT_INFO,
    ).findings.filter((x) => x.kind === "partial_denoise_empty_latent").length;

  it("does NOT flag an Empty*Latent*-named node fed an IMAGE -- that latent is derived", () => {
    expect(
      withLatentSource({
        "8": { class_type: "EmptyLatentFromReference", inputs: { reference: ["5", 0], batch_size: 1 } },
      }),
    ).toBe(0);
  });

  it("STILL flags EmptyLatentImage whose width comes from a link -- a scalar feed is not content", () => {
    // A blanket "consumes no links" rule would go quiet here and miss a real defect:
    // driving width from PrimitiveInt changes the shape of the zeros, not their content.
    expect(
      withLatentSource({
        "8": { class_type: "EmptyLatentImage", inputs: { width: ["7", 0], height: 1024, batch_size: 1 } },
      }),
    ).toBe(1);
  });

  it("declines to call an UNINSTALLED custom latent node empty even with NO links", () => {
    // The name is the only evidence available, and a name is not a fact: a custom
    // EmptyLatent* node can synthesise content from literal configuration and take no
    // links at all. Absent from object_info, it must not fall through to "empty".
    expect(
      withLatentSource({
        "8": { class_type: "EmptyLatentFromPath", inputs: { path: "seed.latent", batch_size: 1 } },
      }),
    ).toBe(0);
  });

  it("declines to call an UNINSTALLED custom latent node empty when it consumes a link", () => {
    // Absent from object_info, so what the link carries is unknowable. Staying quiet
    // costs a warning we might have raised; guessing would cost a false one.
    expect(
      withLatentSource({
        "8": { class_type: "EmptyLatentSomethingCustom", inputs: { mystery: ["5", 0] } },
      }),
    ).toBe(0);
  });

  it("does not crash when latent_image points at a node id that does not exist", () => {
    const h = analyzeGraphHealth(
      wf({
        "9": {
          class_type: "KSampler",
          inputs: { model: ["4", 0], latent_image: ["999", 0], steps: 50, denoise: 0.65 },
        },
        "11": { class_type: "SaveImage", inputs: { images: ["9", 0] } },
      }),
      OBJECT_INFO,
    );
    expect(h.findings.filter((x) => x.kind === "partial_denoise_empty_latent")).toHaveLength(0);
  });

  it("reproduces the #2678 graph: TextEncodeQwenImageEditPlus + EmptyLatentImage at denoise 0.65", () => {
    // The reporter's shape verbatim -- LoadImage reference, Plus encoder (CONDITIONING
    // only), EmptyLatentImage 1024x1024, KSampler steps 50 / cfg 4 / denoise 0.65.
    // It validated and executed with no error and rendered a texture-only field.
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "5": { class_type: "LoadImage", inputs: { image: "ref.png" } },
        // image1 wired from LoadImage: the reference IS reaching the encoder, so the
        // conditioning genuinely carries source content. The finding must still fire --
        // conditioning steers denoising but never seeds the sampler's starting state.
        "6": { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["4", 1], prompt: "change the garment", image1: ["5", 0] } },
        "7": { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["4", 1], prompt: "", image1: ["5", 0] } },
        "8": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
        "9": {
          class_type: "KSampler",
          inputs: {
            model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["8", 0],
            seed: 42, steps: 50, cfg: 4, sampler_name: "euler", scheduler: "simple", denoise: 0.65,
          },
        },
        "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 2] } },
        "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
      }),
      OBJECT_INFO,
    );
    expect(h.findings.some((x) => x.kind === "partial_denoise_empty_latent")).toBe(true);
  });

  it("does NOT flag denoise 1.0 over an empty latent -- that is ordinary txt2img", () => {
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "8": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
        "9": {
          class_type: "KSampler",
          inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["8", 0], denoise: 1.0 },
        },
        "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 2] } },
        "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
      }),
      OBJECT_INFO,
    );
    expect(h.findings.filter((x) => x.kind === "partial_denoise_empty_latent")).toHaveLength(0);
  });

  it("does NOT flag a sub-1.0 denoise fed by VAEEncode -- that is correct img2img", () => {
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "5": { class_type: "LoadImage", inputs: { image: "ref.png" } },
        "8": { class_type: "VAEEncode", inputs: { pixels: ["5", 0], vae: ["4", 2] } },
        "9": {
          class_type: "KSampler",
          inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["8", 0], steps: 50, denoise: 0.65 },
        },
        "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 2] } },
        "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
      }),
      OBJECT_INFO,
    );
    expect(h.findings.filter((x) => x.kind === "partial_denoise_empty_latent")).toHaveLength(0);
  });

  it("does NOT flag a hires-fix chain where the empty latent is one hop upstream", () => {
    // EmptyLatentImage -> KSampler(denoise 1.0) -> LatentUpscale -> KSampler(denoise 0.5).
    // The second sampler's latent carries real content, so the direct-connection scope
    // is what keeps this healthy graph quiet.
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "8": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
        "9": {
          class_type: "KSampler",
          inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["8", 0], denoise: 1.0 },
        },
        "12": { class_type: "LatentUpscale", inputs: { samples: ["9", 0], width: 1024, height: 1024 } },
        "13": {
          class_type: "KSampler",
          inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["12", 0], steps: 50, denoise: 0.5 },
        },
        "10": { class_type: "VAEDecode", inputs: { samples: ["13", 0], vae: ["4", 2] } },
        "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
      }),
      OBJECT_INFO,
    );
    expect(h.findings.filter((x) => x.kind === "partial_denoise_empty_latent")).toHaveLength(0);
  });

  it("covers the whole Empty*Latent* family, not just EmptyLatentImage", () => {
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "8": { class_type: "EmptySD3LatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
        "9": {
          class_type: "KSampler",
          inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["8", 0], steps: 50, denoise: 0.8 },
        },
        "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 2] } },
        "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
      }),
      OBJECT_INFO,
    );
    const f = h.findings.filter((x) => x.kind === "partial_denoise_empty_latent");
    expect(f).toHaveLength(1);
    expect(f[0].detail).toMatch(/EmptySD3LatentImage/);
  });

  // The boundary is NOT a bare denoise threshold. comfy/samplers.py set_steps builds
  // `calculate_sigmas(int(steps / denoise))[-(steps + 1):]`, which only drops leading
  // sigmas when `int(steps / denoise) > steps`. Below, every expectation was computed
  // from that expression, so these cases pin ComfyUI's arithmetic rather than a
  // rounded stand-in for it.
  const fireCount = (denoise: number, steps: number | undefined) =>
    analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "8": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
        "9": {
          class_type: "KSampler",
          inputs: {
            model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["8", 0],
            denoise, ...(steps === undefined ? {} : { steps }),
          },
        },
        "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 2] } },
        "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
      }),
      OBJECT_INFO,
    ).findings.filter((x) => x.kind === "partial_denoise_empty_latent").length;

  it("does NOT fire at denoise 0.9999 with steps 50 -- int(50/0.9999)=50 is the FULL schedule", () => {
    // A bare `denoise <= 0.9999` rule would have warned here on a healthy txt2img graph.
    expect(fireCount(0.9999, 50)).toBe(0);
    expect(fireCount(0.99, 50)).toBe(0);
  });

  it("fires at denoise 0.98 with steps 50 -- int(50/0.98)=51 truncates the schedule", () => {
    expect(fireCount(0.98, 50)).toBe(1);
  });

  it("takes `steps` into account: denoise 0.9 is healthy at 4 steps and degenerate at 20", () => {
    // int(4/0.9)  = 4  -> full schedule, an ordinary 4-step txt2img run.
    expect(fireCount(0.9, 4)).toBe(0);
    // int(20/0.9) = 22 -> truncated.
    expect(fireCount(0.9, 20)).toBe(1);
  });

  it("still fires on the reported denoise 0.65 / steps 50 -- int(50/0.65)=76", () => {
    expect(fireCount(0.65, 50)).toBe(1);
  });

  it("stays silent at denoise 1.0 regardless of steps", () => {
    expect(fireCount(1.0, 50)).toBe(0);
    expect(fireCount(1.0, 4)).toBe(0);
  });

  it("fires at denoise <= 0, where set_steps yields an EMPTY schedule and no sampling runs", () => {
    expect(fireCount(0, 50)).toBe(1);
  });

  it("makes no claim when `steps` is absent or not a literal -- steps decides the boundary", () => {
    expect(fireCount(0.65, undefined)).toBe(0);
    expect(fireCount(0.65, 0)).toBe(0);
  });

  it("ignores a denoise that is a converted input rather than a literal widget value", () => {
    // `["12", 0]` is a link -- its runtime value is unknowable statically, so claiming
    // the graph is broken would be a guess.
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "8": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
        "9": {
          class_type: "KSampler",
          inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["8", 0], steps: 50, denoise: ["12", 0] },
        },
        "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 2] } },
        "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
      }),
      OBJECT_INFO,
    );
    expect(h.findings.filter((x) => x.kind === "partial_denoise_empty_latent")).toHaveLength(0);
  });

  it("ignores a non-numeric denoise -- coercion would both false-fire and false-zero", () => {
    // The connection-tuple case above is silent for an incidental reason: ["12", 0]
    // stringifies with a comma, so the arithmetic NaNs regardless of the guard. These
    // two shapes are what the guard actually buys, and both are false positives:
    //   "0.65" -> Math.trunc(50 / "0.65") = 76 > 50, so it would FIRE, and
    //   ""     -> "" <= 0 is true, so it would fire via the empty-schedule branch.
    const withDenoise = (denoise: unknown) =>
      analyzeGraphHealth(
        wf({
          "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
          "8": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
          "9": {
            class_type: "KSampler",
            inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["8", 0], steps: 50, denoise },
          },
          "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 2] } },
          "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
        }),
        OBJECT_INFO,
      ).findings.filter((x) => x.kind === "partial_denoise_empty_latent").length;

    expect(withDenoise("0.65")).toBe(0);
    expect(withDenoise("")).toBe(0);
    expect(withDenoise(Number.NaN)).toBe(0);
  });

  it("flags an unknown custom sampler class by its slot shape, not a class allowlist", () => {
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "8": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
        "9": {
          class_type: "SomeCustomKSampler",
          inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["8", 0], steps: 50, denoise: 0.5 },
        },
        "10": { class_type: "SaveImage", inputs: { images: ["9", 0] } },
      }),
      OBJECT_INFO,
    );
    const f = h.findings.filter((x) => x.kind === "partial_denoise_empty_latent");
    expect(f).toHaveLength(1);
    expect(f[0].node_type).toBe("SomeCustomKSampler");
  });
});

describe("analyzeGraphHealth — empty latent under an image-edit reference (#2681)", () => {
  // Built as a plain typed record, not as a WorkflowJSON, so the cases below can edit
  // and extend a graph without an assertion at every site. The single widening cast
  // stays where every other case in this file puts it: at the `wf(...)` call.
  type TestNode = { class_type: string; inputs: Record<string, unknown> };
  type TestGraph = Record<string, TestNode>;

  // The encoder's `vae` and `image1` are both wired: ComfyUI only appends
  // reference_latents when BOTH are present, so this conditioning really does carry
  // a reference and the sampled canvas really is expected to match its geometry.
  const editGraph = (
    over: {
      width?: number;
      height?: number;
      denoise?: number;
      steps?: number;
      latentFrom?: string;
      encoderInputs?: Record<string, unknown>;
    } = {},
  ): TestGraph => ({
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
    "5": { class_type: "LoadImage", inputs: { image: "8058752590630.JPG" } },
    "6": {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: over.encoderInputs ?? {
        clip: ["4", 1],
        prompt: "remove the hanger, steamed symmetric e-commerce still life",
        vae: ["4", 2],
        image1: ["5", 0],
      },
    },
    "7": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["6", 0] } },
    "8": {
      class_type: "EmptyLatentImage",
      inputs: { width: over.width ?? 1104, height: over.height ?? 1472, batch_size: 1 },
    },
    "80": { class_type: "VAEEncode", inputs: { pixels: ["5", 0], vae: ["4", 2] } },
    "9": {
      class_type: "KSampler",
      inputs: {
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: [over.latentFrom ?? "8", 0],
        seed: 42,
        steps: over.steps ?? 50,
        cfg: 4,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: over.denoise ?? 1.0,
      },
    },
    "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 2] } },
    "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
  });

  const editHealth = (g: TestGraph, objectInfo: ObjectInfo = OBJECT_INFO) =>
    analyzeGraphHealth(wf(g), objectInfo).findings;
  const editHits = (g: TestGraph, objectInfo: ObjectInfo = OBJECT_INFO) =>
    editHealth(g, objectInfo).filter((x) => x.kind === "edit_reference_empty_latent");

  it("reproduces the #2681 graph: Plus encoder + EmptyLatentImage 1104x1472 at denoise 1.0", () => {
    const findings = editHealth(editGraph());
    const hits = findings.filter((x) => x.kind === "edit_reference_empty_latent");
    expect(hits).toHaveLength(1);
    expect(hits[0].node_ids).toEqual(["9", "8", "6"]);
    // The arithmetic, not a vague adjective: 1104*1472 = 1625088 px against the
    // encoder's hard-coded int(1024*1024) = 1048576 px reference budget.
    expect(hits[0].detail).toContain("1104x1472 = 1625088 px is 1.55x that 1048576 px budget");
    expect(hits[0].detail).toContain("1.24x linear");
    // Area is strong evidence, not a theorem -- the encoder rounds each reference
    // dimension to a multiple of 8, so an extreme aspect ratio can move its area a few
    // percent. The message states the arithmetic and does not claim proof from it.
    expect(hits[0].detail).not.toContain("provably");
    expect(hits[0].detail).toContain("line up only by coincidence");
    // Rule 6 is silent here -- denoise is 1.0, so the schedule is never truncated.
    expect(findings.filter((x) => x.kind === "partial_denoise_empty_latent")).toHaveLength(0);
  });

  it("stays silent when the encoder has no VAE — it emits no reference latents at all", () => {
    // ComfyUI: `if vae is not None: ref_latents.append(vae.encode(...))`. Without a
    // VAE the node is a plain VL-conditioned text encoder and an empty latent is
    // ordinary txt2img. This is also the shape of the #2678 regression test above.
    expect(
      editHits(
        editGraph({
          encoderInputs: { clip: ["4", 1], prompt: "change the garment", image1: ["5", 0] },
        }),
      ),
    ).toHaveLength(0);
  });

  it("stays silent when no image is connected to the encoder", () => {
    expect(
      editHits(editGraph({ encoderInputs: { clip: ["4", 1], prompt: "a cat", vae: ["4", 2] } })),
    ).toHaveLength(0);
  });

  it("stays silent when latent_image comes from a VAEEncode — the official edit shape", () => {
    expect(editHits(editGraph({ latentFrom: "80" }))).toHaveLength(0);
  });

  it("follows the CONDITIONING chain through a pass-through node", () => {
    // positive <- ConditioningZeroOut <- the encoder. The walk must reach it.
    const g = editGraph();
    g["9"].inputs.positive = ["7", 0];
    expect(editHits(g)).toHaveLength(1);
  });

  it("does NOT fire on a generic ReferenceLatent — the Qwen-Image-Layered shape", () => {
    // Both bundled layered templates reach reference_latents through a
    // `ReferenceLatent` fed by a `CLIPTextEncode`, over an empty layered latent, on
    // purpose. Keying the rule on ReferenceLatent scores 2 false positives on the
    // 533-template corpus; keying it on the Qwen edit encoders scores 0.
    const g: TestGraph = {
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
      "5": { class_type: "LoadImage", inputs: { image: "ref.png" } },
      "6": { class_type: "CLIPTextEncode", inputs: { clip: ["4", 1], text: "layers" } },
      "60": { class_type: "VAEEncode", inputs: { pixels: ["5", 0], vae: ["4", 2] } },
      "61": { class_type: "ReferenceLatent", inputs: { conditioning: ["6", 0], latent: ["60", 0] } },
      "8": { class_type: "EmptyLatentImage", inputs: { width: 640, height: 640, batch_size: 1 } },
      "9": {
        class_type: "KSampler",
        inputs: {
          model: ["4", 0],
          positive: ["61", 0],
          negative: ["6", 0],
          latent_image: ["8", 0],
          steps: 20,
          denoise: 1.0,
        },
      },
      "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 2] } },
      "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
    };
    expect(editHits(g)).toHaveLength(0);
  });

  it("says equal-area-is-not-equal-shape rather than claiming a mismatch it cannot prove", () => {
    const hits = editHits(editGraph({ width: 1024, height: 1024 }));
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain("equal area is not equal shape");
    expect(hits[0].detail).not.toContain("provably differ");
  });

  it("omits the geometry clause when the empty latent's dimensions are not literals", () => {
    const g = editGraph();
    g["8"].inputs.width = ["12", 0];
    g["12"] = { class_type: "PrimitiveInt", inputs: { value: 1104 } };
    const hits = editHits(g);
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).not.toContain("px budget");
    expect(hits[0].detail).not.toContain("equal area");
  });

  it("scopes the encoder to the sampler's OWN conditioning chain", () => {
    // Two samplers in one graph: node 9 is a correct edit (VAEEncode latent), node 19
    // is a plain txt2img whose positive is a CLIPTextEncode. The edit encoder is
    // present in the graph but is NOT upstream of 19, so 19 must stay silent -- a
    // per-graph "is there an edit encoder anywhere?" test would flag it.
    const g = editGraph({ latentFrom: "80" });
    g["18"] = { class_type: "CLIPTextEncode", inputs: { clip: ["4", 1], text: "a landscape" } };
    g["180"] = {
      class_type: "EmptyLatentImage",
      inputs: { width: 1104, height: 1472, batch_size: 1 },
    };
    g["19"] = {
      class_type: "KSampler",
      inputs: {
        model: ["4", 0],
        positive: ["18", 0],
        negative: ["18", 0],
        latent_image: ["180", 0],
        steps: 20,
        denoise: 1.0,
      },
    };
    expect(editHits(g)).toHaveLength(0);
  });

  it("ends the walk at a wildcard-typed reroute rather than guessing what it carries", () => {
    // Only CONDITIONING-typed slots are followed. A `*` reroute could be carrying
    // anything, so the walk stops and the finding is not raised -- the same direction
    // producesEmptyLatent takes for an unknown class. This costs a warning we could
    // have raised on a rerouted graph and can never cost a false one; the test exists
    // so that trade is asserted rather than accidental.
    const g = editGraph();
    g["70"] = { class_type: "Reroute", inputs: { "": ["6", 0] } };
    g["9"].inputs.positive = ["70", 0];
    expect(editHits(g)).toHaveLength(0);
  });

  it("requires an image slot the encoder's own CLASS declares", () => {
    // TextEncodeQwenImageEdit takes `image`, not `image1`. A node carrying `image1` is
    // malformed, and matching on the NAME alone would classify it as emitting a
    // reference over a slot its class does not have.
    const bad = editGraph();
    bad["6"].class_type = "TextEncodeQwenImageEdit";
    expect(editHits(bad)).toHaveLength(0);

    // Control: the same class with the slot it DOES declare still fires, so the test
    // above is measuring the slot and not the rename.
    const good = editGraph();
    good["6"].class_type = "TextEncodeQwenImageEdit";
    good["6"].inputs = {
      clip: ["4", 1],
      prompt: "remove the hanger",
      vae: ["4", 2],
      image: ["5", 0],
    };
    expect(editHits(good)).toHaveLength(1);
  });

  it("declines when the encoder's class is absent from object_info", () => {
    // Same direction producesEmptyLatent takes: an uninstalled class has no known slot
    // types, so whether it emits a reference is unknowable. Costs a warning, never
    // raises a false one -- and the validator already errors on the unknown class.
    const withoutEncoder: ObjectInfo = Object.fromEntries(
      Object.entries(OBJECT_INFO).filter(([name]) => name !== "TextEncodeQwenImageEditPlus"),
    );
    expect(editHits(editGraph(), withoutEncoder)).toHaveLength(0);
  });

  it("calls denoise 0 an EMPTY schedule, not a truncated one", () => {
    // startsBelowSigmaMax is true for two different reasons. At denoise <= 0 ComfyUI
    // builds an empty sigma tensor and runs no sampling steps at all -- the latent comes
    // back untouched. Saying "truncates the schedule" there would be false.
    const hits = editHits(editGraph({ denoise: 0, steps: 50 }));
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain("builds an EMPTY sigma schedule");
    expect(hits[0].detail).not.toContain("truncates the sigma schedule");
  });

  it("stops at a node with two inbound conditionings, and leaves rule 6 its warning", () => {
    // A fork: which branch survives to the output is a run-time decision, so an encoder
    // on one of them is not proof the sampler receives its reference. Declining is the
    // safe half; the load-bearing half is that rule 6 must NOT be suppressed here, or a
    // false positive would have cost a real warning.
    const g = editGraph({ denoise: 0.65, steps: 50 });
    g["71"] = {
      class_type: "ConditioningCombine",
      inputs: { conditioning_1: ["6", 0], conditioning_2: ["7", 0] },
    };
    g["9"].inputs.positive = ["71", 0];
    const findings = editHealth(g);
    expect(findings.filter((x) => x.kind === "edit_reference_empty_latent")).toHaveLength(0);
    expect(findings.filter((x) => x.kind === "partial_denoise_empty_latent")).toHaveLength(1);
  });

  it("counts a connected wildcard slot as a fork arm, not as nothing", () => {
    // One typed CONDITIONING input from the encoder plus one connected `*`. The wildcard
    // may be what actually reaches the output, so the typed branch is not proof. Counting
    // only CONDITIONING-typed inputs would read this as a chain of one and fire -- and
    // then suppress rule 6, turning a false positive into a lost warning.
    const g = editGraph({ denoise: 0.65, steps: 50 });
    g["72"] = {
      class_type: "AnyConditioningMux",
      inputs: { conditioning: ["6", 0], alt: ["7", 0] },
    };
    g["9"].inputs.positive = ["72", 0];
    const findings = editHealth(g);
    expect(findings.filter((x) => x.kind === "edit_reference_empty_latent")).toHaveLength(0);
    expect(findings.filter((x) => x.kind === "partial_denoise_empty_latent")).toHaveLength(1);
  });

  it("does not count a converted scalar widget as a second branch", () => {
    // `start` converted from a widget to an input is a NUMBER feed, not a fork arm.
    // Counting every connected input instead of the CONDITIONING-typed ones would make
    // this node look like a two-branch fork and silently drop the finding.
    const g = editGraph();
    g["73"] = {
      class_type: "ConditioningSetTimestepRange",
      inputs: { conditioning: ["6", 0], start: ["74", 0], end: 1 },
    };
    g["74"] = { class_type: "PrimitiveInt", inputs: { value: 0 } };
    g["9"].inputs.positive = ["73", 0];
    expect(editHits(g)).toHaveLength(1);
  });

  it("makes the re-synthesis consequence conditional on the grids actually differing", () => {
    // The checker cannot see the source image, so it cannot know whether the literal
    // canvas happened to match. Asserting the plastic/CGI outcome unconditionally would
    // claim more than it establishes.
    const hits = editHits(editGraph({ width: 1024, height: 1024 }));
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain("where the grids differ");
    expect(hits[0].detail).toContain("Where they happen to coincide it is fine");
  });

  it("replaces the partial-denoise finding rather than double-reporting the same sampler", () => {
    // At denoise 0.65 BOTH conditions hold. Rule 6 would add "to generate from
    // scratch, set denoise to 1.0" -- which for an edit graph is how you land on
    // #2681. One finding, and it carries rule 6's arithmetic so nothing is lost.
    const findings = editHealth(editGraph({ denoise: 0.65, steps: 50 }));
    expect(findings.filter((x) => x.kind === "partial_denoise_empty_latent")).toHaveLength(0);
    const hits = findings.filter((x) => x.kind === "edit_reference_empty_latent");
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain("ALSO runs denoise=0.65");
    expect(hits[0].detail).toContain("#2678");
  });
});

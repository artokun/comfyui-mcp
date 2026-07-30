import { describe, it, expect } from "vitest";
import { convertUiToApi } from "../../services/workflow-converter.js";

// Minimal object_info for the node types used below.
const OBJECT_INFO = {
  LoadImage: { input: { required: { image: ["IMAGE_UPLOAD"] } } },
  ImageBlur: { input: { required: { image: ["IMAGE"], blur_radius: ["INT"] } } },
  SaveImage: {
    input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } },
  },
} as never;

// LoadImage(1) -> [Blur(2)] -> SaveImage(3), where Blur's mode is parameterised.
function chain(blurMode: number) {
  return {
    nodes: [
      {
        id: 1,
        type: "LoadImage",
        mode: 0,
        inputs: [],
        outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }],
        widgets_values: ["in.png"],
      },
      {
        id: 2,
        type: "ImageBlur",
        mode: blurMode,
        inputs: [{ name: "image", type: "IMAGE", link: 1 }],
        outputs: [{ name: "IMAGE", type: "IMAGE", links: [2] }],
        widgets_values: [5],
      },
      {
        id: 3,
        type: "SaveImage",
        mode: 0,
        inputs: [{ name: "images", type: "IMAGE", link: 2 }],
        outputs: [],
        widgets_values: ["out"],
      },
    ],
    links: [
      [1, 1, 0, 2, 0, "IMAGE"],
      [2, 2, 0, 3, 0, "IMAGE"],
    ],
  } as never;
}

describe("convertUiToApi — bypass / mute resolution", () => {
  it("bypassed (mode 4) node is excluded and its consumer passes through to the upstream source", () => {
    const { workflow } = convertUiToApi(chain(4), OBJECT_INFO);
    expect(workflow["2"]).toBeUndefined(); // bypassed node not in the prompt
    // SaveImage's images reconnects through the bypassed blur to LoadImage(1).
    expect(workflow["3"].inputs.images).toEqual(["1", 0]);
    expect(workflow["1"]).toBeDefined();
  });

  it("muted (mode 2) node is excluded and drops the downstream connection", () => {
    const { workflow } = convertUiToApi(chain(2), OBJECT_INFO);
    expect(workflow["2"]).toBeUndefined();
    expect(workflow["3"].inputs.images).toBeUndefined(); // connection dropped
  });

  it("active (mode 0) node is kept and wired normally", () => {
    const { workflow } = convertUiToApi(chain(0), OBJECT_INFO);
    expect(workflow["2"]).toBeDefined();
    expect(workflow["3"].inputs.images).toEqual(["2", 0]);
    expect(workflow["2"].inputs.image).toEqual(["1", 0]);
  });

  it("serializes a v3 dynamic-combo node's nested widgets into dotted model.* keys", () => {
    // Nano Banana 2 shape: `model` is a COMFY_DYNAMICCOMBO_V3 whose selected
    // option reveals aspect_ratio/resolution/thinking_level (positional widgets)
    // plus an AUTOGROW image list (NOT a positional widget). The saved
    // widgets_values therefore are: [prompt, model, aspect_ratio, resolution,
    // thinking_level, seed, control_after_generate, response_modalities].
    const objectInfo = {
      GeminiNanoBanana2V2: {
        input: {
          required: {
            prompt: ["STRING", { multiline: true }],
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "Nano Banana 2 (Gemini 3.1 Flash Image)",
                    inputs: {
                      required: {
                        aspect_ratio: ["COMBO", { options: ["auto", "1:1", "16:9"] }],
                        resolution: ["COMBO", { options: ["1K", "2K", "4K"] }],
                        thinking_level: ["COMBO", { options: ["MINIMAL", "HIGH"] }],
                        images: ["COMFY_AUTOGROW_V3", { min: 0 }],
                      },
                    },
                  },
                ],
              },
            ],
            seed: ["INT", { default: 42, control_after_generate: true }],
            response_modalities: ["COMBO", { options: ["IMAGE", "IMAGE+TEXT"] }],
          },
        },
      },
      SaveImage: {
        input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } },
      },
    } as never;

    const ui = {
      nodes: [
        {
          id: 1,
          type: "GeminiNanoBanana2V2",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }],
          widgets_values: [
            "a red cube", // prompt
            "Nano Banana 2 (Gemini 3.1 Flash Image)", // model (combo key)
            "16:9", // model.aspect_ratio
            "2K", // model.resolution
            "HIGH", // model.thinking_level
            7, // seed
            "fixed", // control_after_generate (phantom, skipped)
            "IMAGE", // response_modalities
          ],
        },
        {
          id: 2,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: 1 }],
          outputs: [],
          widgets_values: ["out"],
        },
      ],
      links: [[1, 1, 0, 2, 0, "IMAGE"]],
    } as never;

    const { workflow } = convertUiToApi(ui, objectInfo);
    expect(workflow["1"].inputs).toMatchObject({
      prompt: "a red cube",
      model: "Nano Banana 2 (Gemini 3.1 Flash Image)",
      "model.aspect_ratio": "16:9",
      "model.resolution": "2K",
      "model.thinking_level": "HIGH",
      seed: 7,
      response_modalities: "IMAGE",
    });
    // AUTOGROW images is not a positional widget — it must NOT consume the seed
    // slot, and no `model.images` key is emitted from widgets_values.
    expect(workflow["1"].inputs).not.toHaveProperty("model.images");
    expect(workflow["1"].inputs).not.toHaveProperty("aspect_ratio");
  });

  it("virtual Set/Get bus nodes are dropped and consumers resolve through the bus", () => {
    // LoadImage(1) -> SetNode(2,'BUS');  GetNode(3,'BUS') -> SaveImage(4)
    const ui = {
      nodes: [
        {
          id: 1,
          type: "LoadImage",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }],
          widgets_values: ["in.png"],
        },
        {
          id: 2,
          type: "SetNode",
          mode: 0,
          inputs: [{ name: "IMAGE", type: "IMAGE", link: 1 }],
          outputs: [],
          widgets_values: ["BUS"],
        },
        {
          id: 3,
          type: "GetNode",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [2] }],
          widgets_values: ["BUS"],
        },
        {
          id: 4,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: 2 }],
          outputs: [],
          widgets_values: ["out"],
        },
      ],
      links: [
        [1, 1, 0, 2, 0, "IMAGE"],
        [2, 3, 0, 4, 0, "IMAGE"],
      ],
    } as never;
    const { workflow } = convertUiToApi(ui, OBJECT_INFO);
    expect(workflow["2"]).toBeUndefined(); // SetNode dropped
    expect(workflow["3"]).toBeUndefined(); // GetNode dropped
    expect(workflow["4"].inputs.images).toEqual(["1", 0]); // resolved through the bus
  });
});

describe("convertUiToApi — serialized-widget nodes (has_serialized_properties)", () => {
  // Real-world shape: WhatDreamsCost's LTXDirector packs extra/reordered widgets
  // into widgets_values (23 slots, timeline JSON included), so positional mapping
  // shifts every widget after the first unaccounted slot — frame_rate came out
  // "seconds", display_mode 768, divisible_by 18 (field bug, 2026-07-14). The
  // node's authoritative named values live in node.properties.
  const DIRECTOR_INFO = {
    LTXDirector: {
      input: {
        required: {
          model: ["MODEL"],
          clip: ["CLIP"],
          start_second: ["FLOAT", { default: 0 }],
          end_second: ["FLOAT", { default: 5 }],
          timeline_data: ["STRING", { default: "" }],
          local_prompts: ["STRING", { default: "", multiline: true }],
          segment_lengths: ["STRING", { default: "" }],
          epsilon: ["FLOAT", { default: 0.001 }],
          guide_strength: ["STRING", { default: "" }],
        },
        optional: {
          use_custom_audio: ["BOOLEAN", { default: false }],
          use_custom_motion: ["BOOLEAN", { default: true }],
          inpaint_audio: ["BOOLEAN", { default: true }],
          frame_rate: ["FLOAT", { default: 24 }],
          display_mode: [["frames", "seconds"], { default: "seconds" }],
          custom_width: ["INT", { default: 0 }],
          custom_height: ["INT", { default: 0 }],
          resize_method: [["maintain aspect ratio", "stretch to fit", "pad"], {}],
          divisible_by: ["INT", { default: 32 }],
          img_compression: ["INT", { default: 18 }],
          override_audio: ["BOOLEAN", { default: false }],
        },
      },
      input_order: {
        required: [
          "model", "clip", "start_second", "end_second", "timeline_data",
          "local_prompts", "segment_lengths", "epsilon", "guide_strength",
        ],
        optional: [
          "use_custom_audio", "use_custom_motion", "inpaint_audio", "frame_rate",
          "display_mode", "custom_width", "custom_height", "resize_method",
          "divisible_by", "img_compression", "override_audio",
        ],
      },
    },
  } as never;

  function directorGraph(withFlag: boolean) {
    return {
      nodes: [
        {
          id: 1316,
          type: "LTXDirector",
          mode: 0,
          inputs: [
            { name: "model", type: "MODEL", link: null },
            { name: "clip", type: "CLIP", link: null },
          ],
          outputs: [],
          // Deliberately misaligned vs input_order — the node's custom widget
          // serialization, trimmed from the real 23-slot _stripscratch capture.
          widgets_values: [
            "0", "15", "15", "0", "360", "360",
            '{"mainTrackEnabled":true}', "camera arc shot", "96,72,72", "0.001",
            "1,1,1", false, true, true, 24, "seconds", 768, 1344,
            "maintain aspect ratio", 32, 18, false, "extra",
          ],
          properties: {
            ...(withFlag ? { has_serialized_properties: true } : {}),
            "Node name for S&R": "LTXDirector",
            frame_rate: 24,
            display_mode: "seconds",
            custom_width: 768,
            custom_height: 1344,
            resize_method: "maintain aspect ratio",
            divisible_by: 32,
            img_compression: 18,
            use_custom_audio: false,
            use_custom_motion: true,
            inpaint_audio: true,
            override_audio: false,
            epsilon: 0.001,
            start_second: 0,
            timeline_data: '{"mainTrackEnabled":true}',
          },
        },
      ],
      links: [],
    } as never;
  }

  it("prefers the authoritative properties values when the flag is set", () => {
    const { workflow } = convertUiToApi(directorGraph(true), DIRECTOR_INFO);
    const inputs = (workflow["1316"] as { inputs: Record<string, unknown> }).inputs;
    expect(inputs.frame_rate).toBe(24);
    expect(inputs.display_mode).toBe("seconds");
    expect(inputs.custom_width).toBe(768);
    expect(inputs.custom_height).toBe(1344);
    expect(inputs.divisible_by).toBe(32);
    expect(inputs.img_compression).toBe(18);
    // non-input properties must NOT leak into the prompt
    expect(inputs["Node name for S&R"]).toBeUndefined();
  });

  it("without the flag the positional mapping is untouched (stale property copies can't hijack normal nodes)", () => {
    const { workflow } = convertUiToApi(directorGraph(false), DIRECTOR_INFO);
    const inputs = (workflow["1316"] as { inputs: Record<string, unknown> }).inputs;
    // positional (mis)mapping proceeds as before — the point is only that
    // properties did NOT override it: frame_rate keeps whatever slot landed there.
    expect(inputs.frame_rate).not.toBe(24);
  });
});

describe("convertUiToApi — asset-combo fallback (issue #407)", () => {
  // Real Krea 2 manual-pack shape: node 54 is a UNETLoader whose saved
  // unet_name is the advertised Krea Turbo model, but the CONNECTED server only
  // has flux-2-klein installed. object_info's combo therefore lists the wrong
  // files. Previously comboOpts[0] silently rewrote unet_name to the first
  // installed model, producing a misleading "success".
  const KREA_INFO = {
    UNETLoader: {
      input: {
        required: {
          unet_name: [
            ["flux-2-klein-9b.safetensors", "some-other-unet.safetensors"],
          ],
          weight_dtype: [["default", "fp8_e4m3fn"]],
        },
      },
    },
    KSampler: {
      input: {
        required: {
          model: ["MODEL"],
          sampler_name: [["euler", "dpmpp_2m", "heun"]],
          steps: ["INT"],
        },
      },
    },
  } as never;

  function kreaGraph(unetName: string) {
    return {
      nodes: [
        {
          id: 54,
          type: "UNETLoader",
          mode: 0,
          inputs: [],
          outputs: [{ name: "MODEL", type: "MODEL", links: [10] }],
          widgets_values: [unetName, "fp8_e4m3fn"],
        },
        {
          id: 60,
          type: "KSampler",
          mode: 0,
          inputs: [{ name: "model", type: "MODEL", link: 10 }],
          outputs: [],
          // sampler_name "euler" is valid; a stale value must still fall back.
          widgets_values: ["euler", 20],
        },
      ],
      links: [[10, 54, 0, 60, 0, "MODEL"]],
    } as never;
  }

  it("keeps the declared model name when it is not installed, instead of substituting the first installed model", () => {
    const declared = "krea2_turbo_fp8.safetensors";
    const { workflow, warnings } = convertUiToApi(kreaGraph(declared), KREA_INFO);
    // The declared model survives — NOT rewritten to flux-2-klein-9b.
    expect(workflow["54"].inputs.unet_name).toBe(declared);
    expect(workflow["54"].inputs.unet_name).not.toBe("flux-2-klein-9b.safetensors");
    // …and the substitution is flagged so it surfaces as a real missing-asset error.
    expect(
      warnings.some(
        (w) => w.includes("54") && w.includes(declared) && /missing-asset/.test(w),
      ),
    ).toBe(true);
  });

  it("still falls back for a non-asset enum combo (stale UI-helper value)", () => {
    // A KSampler.sampler_name of a value not in the list is a plain enum, not a
    // file — the harmless first-option fallback must still apply.
    const graph = kreaGraph("flux-2-klein-9b.safetensors");
    graph.nodes[1].widgets_values = ["totally_not_a_sampler", 20];
    const { workflow } = convertUiToApi(graph, KREA_INFO);
    expect(workflow["60"].inputs.sampler_name).toBe("euler"); // first option
  });

  it("does not warn or alter a valid installed model", () => {
    const { workflow, warnings } = convertUiToApi(
      kreaGraph("flux-2-klein-9b.safetensors"),
      KREA_INFO,
    );
    expect(workflow["54"].inputs.unet_name).toBe("flux-2-klein-9b.safetensors");
    expect(warnings.some((w) => /missing-asset/.test(w))).toBe(false);
  });

  it("keeps the declared value for an EXTENSIONLESS asset combo (DiffusersLoader.model_path)", () => {
    // DiffusersLoader lists extensionless directory names — no file extension to
    // key off, so detection must fall back to the asset-widget-name allowlist.
    const info = {
      DiffusersLoader: {
        input: {
          required: {
            model_path: [["installed-diffusers-dir", "another-dir"]],
          },
        },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "DiffusersLoader",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: ["krea-turbo-diffusers"],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["1"].inputs.model_path).toBe("krea-turbo-diffusers");
    expect(workflow["1"].inputs.model_path).not.toBe("installed-diffusers-dir");
    expect(warnings.some((w) => /missing-asset/.test(w))).toBe(true);
  });

  it("keeps the declared value for a .pt2 checkpoint (extension coverage)", () => {
    const info = {
      CheckpointLoaderSimple: {
        input: { required: { ckpt_name: [["installed.pt2", "other.pt2"]] } },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "CheckpointLoaderSimple",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: ["not-installed.pt2"],
        },
      ],
      links: [],
    } as never;
    const { workflow } = convertUiToApi(ui, info);
    expect(workflow["1"].inputs.ckpt_name).toBe("not-installed.pt2");
  });
});

describe("convertUiToApi — media-combo fallback (issue #504)", () => {
  // A LoadImage node whose `image` widget points at a freshly staged upload
  // (2Dto3D_v2_front_clean.png) that isn't yet in the CONNECTED server's STALE
  // /object_info combo (which still only lists KENT_concept_00012_.png). Before
  // the fix, media values failed looksLikeAssetFilename() so comboOpts[0]
  // silently replaced the user's image — headless execution then ran on the
  // WRONG source image with no warning.
  const STALE_INFO = {
    LoadImage: {
      input: {
        required: {
          image: [["KENT_concept_00012_.png"]],
          upload: ["IMAGE_UPLOAD"],
        },
      },
    },
  } as never;

  function loadImageGraph(image: string) {
    return {
      nodes: [
        {
          id: 12,
          type: "LoadImage",
          mode: 0,
          inputs: [],
          outputs: [
            { name: "IMAGE", type: "IMAGE", links: [] },
            { name: "MASK", type: "MASK", links: [] },
          ],
          widgets_values: [image, "image"],
        },
      ],
      links: [],
    } as never;
  }

  it("PRESERVES a staged LoadImage value NOT in the stale combo (never comboOpts[0])", () => {
    const staged = "2Dto3D_v2_front_clean.png";
    const { workflow, warnings } = convertUiToApi(loadImageGraph(staged), STALE_INFO);
    // The staged image survives — NOT silently rewritten to the first cached file.
    expect(workflow["12"].inputs.image).toBe(staged);
    expect(workflow["12"].inputs.image).not.toBe("KENT_concept_00012_.png");
    // …and the substitution is flagged so it surfaces as an honest missing-asset error.
    expect(
      warnings.some(
        (w) => w.includes("12") && w.includes(staged) && /missing-asset/.test(w),
      ),
    ).toBe(true);
  });

  it("does not warn or alter a LoadImage value that IS present on the server", () => {
    const { workflow, warnings } = convertUiToApi(
      loadImageGraph("KENT_concept_00012_.png"),
      STALE_INFO,
    );
    expect(workflow["12"].inputs.image).toBe("KENT_concept_00012_.png");
    expect(warnings.some((w) => /missing-asset/.test(w))).toBe(false);
  });

  it("preserves an extensionless staged image via the media widget-name allowlist", () => {
    // Some staged inputs carry a subfolder path with no extension; the value has
    // no file suffix and the stale combo has none either, so detection must fall
    // back to the `image` widget-name allowlist rather than substituting.
    const { workflow, warnings } = convertUiToApi(
      loadImageGraph("clipspace/staged_input"),
      STALE_INFO,
    );
    expect(workflow["12"].inputs.image).toBe("clipspace/staged_input");
    expect(workflow["12"].inputs.image).not.toBe("KENT_concept_00012_.png");
    expect(warnings.some((w) => /missing-asset/.test(w))).toBe(true);
  });

  it("preserves a staged .mp4 media value for a video loader (extension coverage)", () => {
    const info = {
      VHS_LoadVideo: {
        input: { required: { video: [["cached_clip.mp4"]] } },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "VHS_LoadVideo",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: ["freshly_staged.mp4"],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["1"].inputs.video).toBe("freshly_staged.mp4");
    expect(warnings.some((w) => /missing-asset/.test(w))).toBe(true);
  });
});

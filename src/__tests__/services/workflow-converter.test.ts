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
  // the fix, LoadImage.image was not recognized as a media selector, so
  // comboOpts[0] silently replaced the user's image — headless execution then
  // ran on the WRONG source image with no warning.
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

  it("preserves an extensionless staged image via the (classType,input) loader allowlist", () => {
    // Isolate the allowlist: BOTH the staged value AND the stale combo option are
    // extensionless, so no extension heuristic can carry this — preservation must
    // come purely from LoadImage.image being a KNOWN loader input. (The prior
    // fixture's stale combo held a ".png", so the retired regex passed regardless
    // and never actually exercised the allowlist.)
    const EXTLESS_INFO = {
      LoadImage: {
        input: {
          required: {
            image: [["cached_input"]],
            upload: ["IMAGE_UPLOAD"],
          },
        },
      },
    } as never;
    const { workflow, warnings } = convertUiToApi(
      loadImageGraph("clipspace/staged_input"),
      EXTLESS_INFO,
    );
    expect(workflow["12"].inputs.image).toBe("clipspace/staged_input");
    expect(workflow["12"].inputs.image).not.toBe("cached_input");
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

  it("preserves LoadImage.image flagged by object_info upload metadata (no name/ext match)", () => {
    // The value is extensionless AND arrives on a class NOT in the loader
    // allowlist by chance — but object_info flags the input `{image_upload:true}`,
    // the authoritative upload-selector signal — so it must still be preserved.
    const info = {
      MyCustomImageLoader: {
        input: {
          required: {
            image: [["on_disk_input"], { image_upload: true }],
          },
        },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 7,
          type: "MyCustomImageLoader",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: ["staged_upload"],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["7"].inputs.image).toBe("staged_upload");
    expect(warnings.some((w) => /missing-asset/.test(w))).toBe(true);
  });
});

describe("convertUiToApi — true-enum over-preservation guard (P0 regression, #504)", () => {
  // The #504 fix must NOT over-correct: a combo merely *named* image/audio/video,
  // or a media-looking value on a TRUE enum, is NOT an asset selector. Preserving
  // an out-of-list value there feeds ComfyUI a "Value not in list" it hard-rejects,
  // breaking conversions that previously substituted comboOpts[0] + warned.

  it("SUBSTITUTES+warns a non-loader enum literally named `image` (not preserved)", () => {
    // A node whose combo happens to be named `image` but whose options are a real
    // enum ["foreground","background"] — a value of "mask" is invalid and must be
    // replaced by the first option, NOT preserved as a phantom missing-asset.
    const info = {
      SomeMaskModeNode: {
        input: {
          required: {
            image: [["foreground", "background"]],
          },
        },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 3,
          type: "SomeMaskModeNode",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: ["mask"],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["3"].inputs.image).toBe("foreground");
    expect(workflow["3"].inputs.image).not.toBe("mask");
    expect(
      warnings.some(
        (w) => w.includes("3") && w.includes("mask") && /substituting/.test(w),
      ),
    ).toBe(true);
    // …and it must NOT be misreported as a missing asset (would preserve it).
    expect(warnings.some((w) => /missing-asset/.test(w))).toBe(false);
  });

  it("SUBSTITUTES+warns a format `extension` enum with a media-looking value (.bmp not preserved)", () => {
    // A true format enum [".png",".jpg"] with a ".bmp" value: the retired
    // extension heuristic wrongly preserved ".bmp" (it matches a media regex);
    // ComfyUI rejects it. Must substitute the first option instead.
    const info = {
      SaveImageFormatNode: {
        input: {
          required: {
            extension: [[".png", ".jpg"]],
          },
        },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 5,
          type: "SaveImageFormatNode",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: [".bmp"],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["5"].inputs.extension).toBe(".png");
    expect(workflow["5"].inputs.extension).not.toBe(".bmp");
    expect(
      warnings.some(
        (w) => w.includes("5") && w.includes(".bmp") && /substituting/.test(w),
      ),
    ).toBe(true);
    expect(warnings.some((w) => /missing-asset/.test(w))).toBe(false);
  });

  it("validates object-form widgets_values too — invalid enum substitutes (not copied raw)", () => {
    // Name->value object form (VHS_VideoCombine shape). This path copied values
    // straight in WITHOUT combo validation, so an invalid true-enum value on a
    // combo named `image` leaked through unchanged. It must now substitute+warn.
    const info = {
      MaskModeCombine: {
        input: {
          required: {
            image: [["foreground", "background"]],
            format: [["mp4", "webm"]],
          },
        },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 9,
          type: "MaskModeCombine",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: { image: "mask", format: "mp4" },
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["9"].inputs.image).toBe("foreground");
    expect(workflow["9"].inputs.image).not.toBe("mask");
    // a VALID value on the same object form is left untouched
    expect(workflow["9"].inputs.format).toBe("mp4");
    expect(
      warnings.some((w) => w.includes("9") && /substituting/.test(w)),
    ).toBe(true);
  });

  it("object-form still PRESERVES a real loader asset value (allowlist survives the path)", () => {
    // The object-form validation must keep the asset-preservation semantics: a
    // staged LoadImage.image absent from the stale combo is preserved, not swapped.
    const info = {
      LoadImage: {
        input: { required: { image: [["cached.png"]], upload: ["IMAGE_UPLOAD"] } },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 10,
          type: "LoadImage",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: { image: "staged_fresh.png" },
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["10"].inputs.image).toBe("staged_fresh.png");
    expect(warnings.some((w) => /missing-asset/.test(w))).toBe(true);
  });

  it("WARNS (not silent) when a combo has ZERO options on the server", () => {
    // An empty option list ([[], {}]) — e.g. no models installed — has nothing to
    // substitute to. The saved literal is kept, but must be flagged, not silently
    // emitted as an out-of-list value the server will reject.
    const info = {
      EmptyEnum: {
        input: { required: { mode: [[], {}] } },
        input_order: { required: ["mode"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 504,
          type: "EmptyEnum",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: ["retired"],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["504"].inputs.mode).toBe("retired");
    expect(
      warnings.some((w) => w.includes("504") && w.includes("retired")),
    ).toBe(true);
  });

  it("validates has_serialized_properties overwrites too — invalid enum substitutes", () => {
    // Authoritative node.properties overwrite the positional mapping AFTER combo
    // validation; an invalid enum restored there previously leaked unvalidated to
    // ComfyUI. It must be validated (substituted) as well.
    const info = {
      SerNode: {
        input: {
          required: {
            mode: [["a", "b"]],
          },
        },
        input_order: { required: ["mode"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 11,
          type: "SerNode",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: ["a"],
          properties: {
            has_serialized_properties: true,
            mode: "z", // stale, out-of-list — must NOT survive
          },
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["11"].inputs.mode).toBe("a");
    expect(workflow["11"].inputs.mode).not.toBe("z");
    expect(
      warnings.some((w) => w.includes("11") && /substituting/.test(w)),
    ).toBe(true);
  });
});

describe("convertUiToApi — linked PrimitiveNode combo validation (P1-A, #504)", () => {
  // A PrimitiveNode wired into a combo input provides a LITERAL value that is
  // assigned AFTER the widget-value validation (widgets first, links after), so
  // it previously bypassed combo validation entirely: an out-of-list literal
  // overwrote the validated widget value and reached the API unchecked.

  it("SUBSTITUTES+warns an out-of-list enum fed by a linked PrimitiveNode", () => {
    const info = {
      KSamplerSelect: {
        input: { required: { sampler_name: [["euler", "dpmpp_2m"]] } },
        input_order: { required: ["sampler_name"] },
      },
      PrimitiveNode: { input: { required: {} } },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "PrimitiveNode",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: ["removed_sampler"], // no longer a valid option
        },
        {
          id: 2,
          type: "KSamplerSelect",
          mode: 0,
          inputs: [{ name: "sampler_name", type: "COMBO", link: 10 }],
          outputs: [],
          widgets_values: ["euler"], // valid, but the link overrides it
        },
      ],
      links: [[10, 1, 0, 2, 0, "COMBO"]],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    // The stale primitive literal must NOT reach the API — substituted to first opt.
    expect(workflow["2"].inputs.sampler_name).toBe("euler");
    expect(workflow["2"].inputs.sampler_name).not.toBe("removed_sampler");
    expect(
      warnings.some(
        (w) =>
          w.includes("2") &&
          w.includes("removed_sampler") &&
          /substituting/.test(w),
      ),
    ).toBe(true);
    expect(warnings.some((w) => /missing-asset/.test(w))).toBe(false);
  });

  it("PRESERVES+warns a stale LOADER asset fed by a linked PrimitiveNode", () => {
    const info = {
      CheckpointLoaderSimple: {
        input: { required: { ckpt_name: [["installed.safetensors"]] } },
        input_order: { required: ["ckpt_name"] },
      },
      PrimitiveNode: { input: { required: {} } },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "PrimitiveNode",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: ["not_installed.safetensors"],
        },
        {
          id: 2,
          type: "CheckpointLoaderSimple",
          mode: 0,
          inputs: [{ name: "ckpt_name", type: "COMBO", link: 10 }],
          outputs: [],
          widgets_values: [],
        },
      ],
      links: [[10, 1, 0, 2, 0, "COMBO"]],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    // A loader asset is preserved (honest missing-asset), NOT swapped to opt[0].
    expect(workflow["2"].inputs.ckpt_name).toBe("not_installed.safetensors");
    expect(workflow["2"].inputs.ckpt_name).not.toBe("installed.safetensors");
    expect(
      warnings.some(
        (w) =>
          w.includes("2") &&
          w.includes("not_installed.safetensors") &&
          /missing-asset/.test(w),
      ),
    ).toBe(true);
  });

  it("SUBSTITUTES+warns an invalid dynamic-combo NESTED value fed by a linked PrimitiveNode (dotted key)", () => {
    // A PrimitiveNode wired straight into a dotted "<combo>.<leaf>" nested input:
    // validateComboWidgetValue's top-level lookup can't find "model.aspect_ratio",
    // so the resolver must recover the LEAF spec from the selected option.
    const info = {
      NanoBananaNode: {
        input: {
          required: {
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "Nano Banana 2",
                    inputs: {
                      required: {
                        aspect_ratio: ["COMBO", { options: ["auto", "1:1", "16:9"] }],
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
        input_order: { required: ["model"] },
      },
      PrimitiveNode: { input: { required: {} } },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "PrimitiveNode",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: ["4:3"], // invalid aspect_ratio
        },
        {
          id: 2,
          type: "NanoBananaNode",
          mode: 0,
          inputs: [{ name: "model.aspect_ratio", type: "COMBO", link: 10 }],
          outputs: [],
          widgets_values: ["Nano Banana 2"], // selects the option; leaf is linked
        },
      ],
      links: [[10, 1, 0, 2, 0, "COMBO"]],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["2"].inputs["model.aspect_ratio"]).toBe("auto");
    expect(workflow["2"].inputs["model.aspect_ratio"]).not.toBe("4:3");
    expect(
      warnings.some(
        (w) =>
          w.includes("2") &&
          w.includes("aspect_ratio") &&
          /substituting/.test(w),
      ),
    ).toBe(true);
    expect(warnings.some((w) => /missing-asset/.test(w))).toBe(false);
  });

  it("PRESERVES+warns a stale NESTED loader asset fed by a linked PrimitiveNode (dotted key)", () => {
    // The leaf name (lora_name) is a model-loader selector, so a stale value must
    // be preserved (honest missing-asset) even when supplied through the dotted
    // override path — leaf-name classification must survive the resolver.
    const info = {
      DynLoraNode: {
        input: {
          required: {
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "with-lora",
                    inputs: {
                      required: {
                        lora_name: ["COMBO", { options: ["installed.safetensors"] }],
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
        input_order: { required: ["model"] },
      },
      PrimitiveNode: { input: { required: {} } },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "PrimitiveNode",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: ["not_installed.safetensors"],
        },
        {
          id: 2,
          type: "DynLoraNode",
          mode: 0,
          inputs: [{ name: "model.lora_name", type: "COMBO", link: 10 }],
          outputs: [],
          widgets_values: ["with-lora"],
        },
      ],
      links: [[10, 1, 0, 2, 0, "COMBO"]],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["2"].inputs["model.lora_name"]).toBe("not_installed.safetensors");
    expect(workflow["2"].inputs["model.lora_name"]).not.toBe("installed.safetensors");
    expect(
      warnings.some(
        (w) =>
          w.includes("2") &&
          w.includes("not_installed.safetensors") &&
          /missing-asset/.test(w),
      ),
    ).toBe(true);
  });

  it("SUBSTITUTES+warns an invalid OPTIONAL dynamic-combo nested leaf fed by a linked PrimitiveNode", () => {
    // V3 option inputs can live under `optional`, not just `required` — the
    // resolver must search both or the leaf spec is missing and validation skipped.
    const info = {
      NanoBananaNode: {
        input: {
          required: {
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "Nano Banana 2",
                    inputs: {
                      optional: {
                        output_format: ["COMBO", { options: ["png", "webp"] }],
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
        input_order: { required: ["model"] },
      },
      PrimitiveNode: { input: { required: {} } },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "PrimitiveNode",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: ["gif"], // invalid output_format
        },
        {
          id: 2,
          type: "NanoBananaNode",
          mode: 0,
          inputs: [{ name: "model.output_format", type: "COMBO", link: 10 }],
          outputs: [],
          widgets_values: ["Nano Banana 2"],
        },
      ],
      links: [[10, 1, 0, 2, 0, "COMBO"]],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["2"].inputs["model.output_format"]).toBe("png");
    expect(workflow["2"].inputs["model.output_format"]).not.toBe("gif");
    expect(
      warnings.some(
        (w) =>
          w.includes("2") &&
          w.includes("output_format") &&
          /substituting/.test(w),
      ),
    ).toBe(true);
  });

  it("REFUSES the tail when a LINKED nested leaf precedes trailing widgets — placeholder ambiguity must not shift the seed (#517 P0-A)", () => {
    // model.aspect_ratio is converted-to-input (linked). widgets_values
    // ["Nano Banana 2", 12345] is AMBIGUOUS: on a frontend that drops the converted
    // widget's slot it is [model, seed] (seed=12345); on one that RETAINS a
    // placeholder it is [model, aspect_ratio-placeholder, seed?] and 12345 is the
    // placeholder, not the seed. The two can't be told apart positionally, so
    // consuming vs skipping the linked leaf silently shifts the seed either way.
    // The safe contract is to REFUSE: warn + leave the trailing widget(s) to their
    // defaults, and let the link supply the nested leaf. seed must NOT be silently
    // assigned the ambiguous 12345.
    const info = {
      NanoBananaNode: {
        input: {
          required: {
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "Nano Banana 2",
                    inputs: {
                      required: {
                        aspect_ratio: ["COMBO", { options: ["auto", "1:1"] }],
                      },
                    },
                  },
                ],
              },
            ],
            seed: ["INT"],
          },
        },
        input_order: { required: ["model", "seed"] },
      },
      PrimitiveNode: { input: { required: {} } },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "NanoBananaNode",
          mode: 0,
          inputs: [{ name: "model.aspect_ratio", type: "COMBO", link: 10 }],
          outputs: [],
          widgets_values: ["Nano Banana 2", 12345], // aspect_ratio linked = ambiguous slot
        },
        {
          id: 2,
          type: "PrimitiveNode",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: ["1:1"],
        },
      ],
      links: [[10, 2, 0, 1, 0, "COMBO"]],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    // seed must NOT be silently assigned the ambiguous trailing value.
    expect(workflow["1"].inputs.seed).not.toBe(12345);
    // The nested leaf still comes from the link.
    expect(workflow["1"].inputs["model.aspect_ratio"]).toBe("1:1");
    // The refusal is warned (not silent).
    expect(
      warnings.some(
        (w) =>
          w.includes("1") &&
          w.includes("model.aspect_ratio") &&
          /default/.test(w),
      ),
    ).toBe(true);
  });

  it("does NOT let a RETAINED linked-nested placeholder shift a control-eligible seed (#517 P0-A silent-seed)", () => {
    // Exact placeholder-retention repro: `multiplier` is a linked nested leaf; the
    // frontend RETAINED its serialized placeholder, so widgets_values is
    // ["A", 4(placeholder), 424242(seed), "fixed"]. The pre-fix code skipped the
    // linked leaf WITHOUT consuming its slot, mapped seed=4, then skipped the real
    // 424242 as the control_after_generate phantom — the user's seed silently became
    // 4. The fix REFUSES the tail: seed is left to default, 4 never lands on it.
    const info = {
      MultNode: {
        input: {
          required: {
            mode: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "A",
                    inputs: { required: { multiplier: ["FLOAT", {}] } },
                  },
                ],
              },
            ],
            seed: ["INT", { control_after_generate: true, default: 0 }],
          },
        },
        input_order: { required: ["mode", "seed"] },
      },
      PrimitiveNode: { input: { required: {} } },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "MultNode",
          mode: 0,
          inputs: [{ name: "mode.multiplier", type: "FLOAT", link: 10 }],
          outputs: [],
          widgets_values: ["A", 4, 424242, "fixed"],
        },
        {
          id: 2,
          type: "PrimitiveNode",
          mode: 0,
          inputs: [],
          outputs: [{ name: "FLOAT", type: "FLOAT", links: [10] }],
          widgets_values: [8],
        },
      ],
      links: [[10, 2, 0, 1, 0, "FLOAT"]],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    // The retained placeholder must NEVER become the seed.
    expect(workflow["1"].inputs.seed).not.toBe(4);
    // seed falls to its schema default, not a shifted placeholder value.
    expect(workflow["1"].inputs.seed).toBe(0);
    // The linked nested leaf is supplied by its (PrimitiveNode) source, not the
    // retained placeholder 4.
    expect(workflow["1"].inputs["mode.multiplier"]).toBe(8);
    expect(
      warnings.some(
        (w) =>
          w.includes("1") &&
          w.includes("mode.multiplier") &&
          /default/.test(w),
      ),
    ).toBe(true);
  });

  it("re-anchors nested leaves when a PrimitiveNode overrides the dynamic PARENT (A -> B)", () => {
    // Positional mapping emits model="A" and validates model.choice="a1" against
    // A. A PrimitiveNode then overrides the parent model="B". Without a final
    // re-anchor, model.choice="a1" (valid for A, invalid for B) reaches the API.
    const info = {
      DynParentNode: {
        input: {
          required: {
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "A",
                    inputs: {
                      required: { choice: ["COMBO", { options: ["a1", "a2"] }] },
                    },
                  },
                  {
                    key: "B",
                    inputs: {
                      required: { choice: ["COMBO", { options: ["b1", "b2"] }] },
                    },
                  },
                ],
              },
            ],
          },
        },
        input_order: { required: ["model"] },
      },
      PrimitiveNode: { input: { required: {} } },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "PrimitiveNode",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: ["B"], // overrides the parent selection
        },
        {
          id: 3,
          type: "DynParentNode",
          mode: 0,
          inputs: [{ name: "model", type: "COMBO", link: 10 }],
          outputs: [],
          widgets_values: ["A", "a1"], // saved under option A
        },
      ],
      links: [[10, 1, 0, 3, 0, "COMBO"]],
    } as never;
    const { workflow } = convertUiToApi(ui, info);
    expect(workflow["3"].inputs.model).toBe("B");
    // model.choice must be re-anchored to B's options, NOT left as A's "a1".
    expect(workflow["3"].inputs["model.choice"]).not.toBe("a1");
    expect(["b1", "b2"]).toContain(workflow["3"].inputs["model.choice"]);
  });

  it("drops a wrong-option nested leaf when the dynamic PARENT is fed by a real link", () => {
    // model is fed by a NON-Primitive link (runtime value unknown), and the saved
    // nested model.choice="a1" belongs to option A. Since the resolved option
    // could be B (choice=[b1,b2]), the option-dependent literal must be dropped —
    // not left as a wrong-option "a1" in the prompt.
    const info = {
      ComboProvider: {
        input: { required: {} },
        output: ["COMBO"],
        output_name: ["COMBO"],
      },
      DynParentNode: {
        input: {
          required: {
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "A",
                    inputs: {
                      required: { choice: ["COMBO", { options: ["a1", "a2"] }] },
                    },
                  },
                  {
                    key: "B",
                    inputs: {
                      required: { choice: ["COMBO", { options: ["b1", "b2"] }] },
                    },
                  },
                ],
              },
            ],
          },
        },
        input_order: { required: ["model"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "ComboProvider",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: [],
        },
        {
          id: 3,
          type: "DynParentNode",
          mode: 0,
          inputs: [{ name: "model", type: "COMBO", link: 10 }],
          outputs: [],
          widgets_values: ["A", "a1"],
        },
      ],
      links: [[10, 1, 0, 3, 0, "COMBO"]],
    } as never;
    const { workflow } = convertUiToApi(ui, info);
    // model is a link ref; the wrong-option leaf must be gone.
    expect(Array.isArray(workflow["3"].inputs.model)).toBe(true);
    expect("model.choice" in workflow["3"].inputs).toBe(false);
  });

  it("drops a linked-leaf literal under a link-ref parent whose option combo is EMPTY (no silent literal)", () => {
    // model (parent) is a real link; model.choice (leaf) is a linked PrimitiveNode
    // "retired"; the option's choice combo is empty [[], {}]. The leaf must NOT be
    // silently kept — with no valid membership under any option it is dropped.
    const info = {
      ComboProvider: {
        input: { required: {} },
        output: ["COMBO"],
        output_name: ["COMBO"],
      },
      DynParentNode: {
        input: {
          required: {
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "A",
                    inputs: { required: { choice: [[], {}] } },
                  },
                ],
              },
            ],
          },
        },
        input_order: { required: ["model"] },
      },
      PrimitiveNode: { input: { required: {} } },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "ComboProvider",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: [],
        },
        {
          id: 2,
          type: "PrimitiveNode",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [11] }],
          widgets_values: ["retired"],
        },
        {
          id: 3,
          type: "DynParentNode",
          mode: 0,
          inputs: [
            { name: "model", type: "COMBO", link: 10 },
            { name: "model.choice", type: "COMBO", link: 11 },
          ],
          outputs: [],
          widgets_values: [],
        },
      ],
      links: [
        [10, 1, 0, 3, 0, "COMBO"],
        [11, 2, 0, 3, 1, "COMBO"],
      ],
    } as never;
    const { workflow } = convertUiToApi(ui, info);
    expect(Array.isArray(workflow["3"].inputs.model)).toBe(true);
    // No silent out-of-list "retired" literal on model.choice.
    expect("model.choice" in workflow["3"].inputs).toBe(false);
  });

  it("drops an ORPHAN dotted leaf LITERAL whose optional dynamic parent is ENTIRELY ABSENT (default-deny)", () => {
    // `model` is an OPTIONAL COMFY_DYNAMICCOMBO_V3 left completely unset — no
    // widget value, and optional so it is never default-filled — hence absent
    // from inputs. A PrimitiveNode feeds a literal straight into the nested dotted
    // `model.aspect_ratio`. With no parent option selected there is no schema
    // context for the leaf and ComfyUI would reject the un-parented input, so it
    // must be dropped rather than left as an orphan literal.
    const info = {
      DynOptNode: {
        input: {
          required: {},
          optional: {
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "Nano Banana 2",
                    inputs: {
                      required: {
                        aspect_ratio: ["COMBO", { options: ["auto", "1:1", "16:9"] }],
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
        input_order: { required: [], optional: ["model"] },
      },
      PrimitiveNode: { input: { required: {} } },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "PrimitiveNode",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: ["16:9"],
        },
        {
          id: 2,
          type: "DynOptNode",
          mode: 0,
          inputs: [{ name: "model.aspect_ratio", type: "COMBO", link: 10 }],
          outputs: [],
          widgets_values: [], // parent `model` never set
        },
      ],
      links: [[10, 1, 0, 2, 0, "COMBO"]],
    } as never;
    const { workflow } = convertUiToApi(ui, info);
    // Parent absent, and the orphan leaf must NOT survive as an un-parented literal.
    expect("model" in workflow["2"].inputs).toBe(false);
    expect("model.aspect_ratio" in workflow["2"].inputs).toBe(false);
  });

  it("drops an ORPHAN dotted leaf LINK-REF whose optional dynamic parent is ENTIRELY ABSENT (default-deny)", () => {
    // Same orphan shape, but the nested dotted leaf is fed by a REAL (non-Primitive)
    // node, so it resolves to a [id, slot] link ref instead of a literal. An
    // un-parented link ref is just as invalid as an un-parented literal — the
    // parent combo has no selected option — so default-deny drops it too. (The
    // previous code kept array-valued orphans, leaking a leaf the server rejects.)
    const info = {
      ComboProvider: {
        input: { required: {} },
        output: ["COMBO"],
        output_name: ["COMBO"],
      },
      DynOptNode: {
        input: {
          required: {},
          optional: {
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "Nano Banana 2",
                    inputs: {
                      required: {
                        aspect_ratio: ["COMBO", { options: ["auto", "1:1", "16:9"] }],
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
        input_order: { required: [], optional: ["model"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "ComboProvider",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: [],
        },
        {
          id: 2,
          type: "DynOptNode",
          mode: 0,
          inputs: [{ name: "model.aspect_ratio", type: "COMBO", link: 10 }],
          outputs: [],
          widgets_values: [], // parent `model` never set
        },
      ],
      links: [[10, 1, 0, 2, 0, "COMBO"]],
    } as never;
    const { workflow } = convertUiToApi(ui, info);
    // The ComboProvider is still in the prompt (so this is not dangling-ref pruning)…
    expect(workflow["1"]).toBeDefined();
    // …but the orphan link-ref leaf under the absent parent must be dropped.
    expect("model" in workflow["2"].inputs).toBe(false);
    expect("model.aspect_ratio" in workflow["2"].inputs).toBe(false);
  });

  it("drops a real-LINK dotted leaf when the PRESENT parent's final option does NOT define it (default-deny)", () => {
    // model="B" is a present literal parent whose option B does NOT define `choice`
    // (only option A does). model.choice is fed by a REAL node → a [id, slot] link
    // ref. It is orphaned under B, and ComfyUI rejects the unknown input, so the
    // re-anchor pass must DROP it even though it's an array (link) value — the case
    // that previously slipped through the `Array.isArray(leafVal) continue` guard.
    const info = {
      ComboProvider: {
        input: { required: {} },
        output: ["COMBO"],
        output_name: ["COMBO"],
      },
      DynParentNode: {
        input: {
          required: {
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "A",
                    inputs: {
                      required: { choice: ["COMBO", { options: ["a1", "a2"] }] },
                    },
                  },
                  { key: "B", inputs: { required: {} } }, // B defines no `choice`
                ],
              },
            ],
          },
        },
        input_order: { required: ["model"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "ComboProvider",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: [],
        },
        {
          id: 3,
          type: "DynParentNode",
          mode: 0,
          inputs: [{ name: "model.choice", type: "COMBO", link: 10 }],
          outputs: [],
          widgets_values: ["B"], // final selected option is B
        },
      ],
      links: [[10, 1, 0, 3, 0, "COMBO"]],
    } as never;
    const { workflow } = convertUiToApi(ui, info);
    expect(workflow["1"]).toBeDefined(); // provider stays — not dangling-ref pruning
    expect(workflow["3"].inputs.model).toBe("B");
    // The real-link leaf is orphaned under option B and must be dropped.
    expect("model.choice" in workflow["3"].inputs).toBe(false);
  });

  it("KEEPS a real-LINK dotted leaf when the PRESENT parent's final option DOES define it", () => {
    // Guard against over-deletion: model="A" defines `choice`, and model.choice is
    // a real link into a defined leaf → a valid connection that must be preserved
    // as-is (its runtime value is validated by ComfyUI, not here).
    const info = {
      ComboProvider: {
        input: { required: {} },
        output: ["COMBO"],
        output_name: ["COMBO"],
      },
      DynParentNode: {
        input: {
          required: {
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "A",
                    inputs: {
                      required: { choice: ["COMBO", { options: ["a1", "a2"] }] },
                    },
                  },
                ],
              },
            ],
          },
        },
        input_order: { required: ["model"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "ComboProvider",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: [],
        },
        {
          id: 3,
          type: "DynParentNode",
          mode: 0,
          inputs: [{ name: "model.choice", type: "COMBO", link: 10 }],
          outputs: [],
          widgets_values: ["A"],
        },
      ],
      links: [[10, 1, 0, 3, 0, "COMBO"]],
    } as never;
    const { workflow } = convertUiToApi(ui, info);
    expect(workflow["3"].inputs.model).toBe("A");
    // Valid link into a defined leaf — kept as the [id, slot] ref.
    expect(workflow["3"].inputs["model.choice"]).toEqual(["1", 0]);
  });

  it("drops a real-LINK dotted leaf under a real-LINK parent when SOME option omits the leaf (runtime-unknown default-deny)", () => {
    // model (parent) is fed by a REAL link → the resolved option is unknowable.
    // Option A defines `choice`, option B does NOT. model.choice is fed by another
    // real link. If the parent resolves to B at runtime, `model.choice` is an
    // unknown input ComfyUI rejects. Since we can't know the resolution, default-
    // deny: the leaf must be dropped unless EVERY option defines it.
    const info = {
      ComboProvider: {
        input: { required: {} },
        output: ["COMBO"],
        output_name: ["COMBO"],
      },
      DynParentNode: {
        input: {
          required: {
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "A",
                    inputs: {
                      required: { choice: ["COMBO", { options: ["a1", "a2"] }] },
                    },
                  },
                  { key: "B", inputs: { required: {} } }, // B omits `choice`
                ],
              },
            ],
          },
        },
        input_order: { required: ["model"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "ComboProvider",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: [],
        },
        {
          id: 2,
          type: "ComboProvider",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [11] }],
          widgets_values: [],
        },
        {
          id: 3,
          type: "DynParentNode",
          mode: 0,
          inputs: [
            { name: "model", type: "COMBO", link: 10 },
            { name: "model.choice", type: "COMBO", link: 11 },
          ],
          outputs: [],
          widgets_values: [],
        },
      ],
      links: [
        [10, 1, 0, 3, 0, "COMBO"],
        [11, 2, 0, 3, 1, "COMBO"],
      ],
    } as never;
    const { workflow } = convertUiToApi(ui, info);
    // Parent stays a runtime link ref…
    expect(Array.isArray(workflow["3"].inputs.model)).toBe(true);
    // …but the leaf, not defined by every option, is dropped (would orphan under B).
    expect("model.choice" in workflow["3"].inputs).toBe(false);
  });

  it("KEEPS a real-LINK dotted leaf under a real-LINK parent when EVERY option defines the leaf", () => {
    // Guard against over-deletion: both options A and B define `choice`, so the
    // linked leaf is valid whichever option resolves and must be preserved.
    const info = {
      ComboProvider: {
        input: { required: {} },
        output: ["COMBO"],
        output_name: ["COMBO"],
      },
      DynParentNode: {
        input: {
          required: {
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "A",
                    inputs: {
                      required: { choice: ["COMBO", { options: ["a1", "a2"] }] },
                    },
                  },
                  {
                    key: "B",
                    inputs: {
                      required: { choice: ["COMBO", { options: ["b1", "b2"] }] },
                    },
                  },
                ],
              },
            ],
          },
        },
        input_order: { required: ["model"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "ComboProvider",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: [],
        },
        {
          id: 2,
          type: "ComboProvider",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [11] }],
          widgets_values: [],
        },
        {
          id: 3,
          type: "DynParentNode",
          mode: 0,
          inputs: [
            { name: "model", type: "COMBO", link: 10 },
            { name: "model.choice", type: "COMBO", link: 11 },
          ],
          outputs: [],
          widgets_values: [],
        },
      ],
      links: [
        [10, 1, 0, 3, 0, "COMBO"],
        [11, 2, 0, 3, 1, "COMBO"],
      ],
    } as never;
    const { workflow } = convertUiToApi(ui, info);
    expect(Array.isArray(workflow["3"].inputs.model)).toBe(true);
    // Defined by every option → the link ref is preserved.
    expect(workflow["3"].inputs["model.choice"]).toEqual(["2", 0]);
  });

  it("PRESERVES a LITERAL nested leaf defined by SOME (not all) options under a real-LINK parent — no silent user-value drop (#517 P0-B)", () => {
    // The dynamic parent `model` is fed by a real link (converted to input) but the
    // frontend RETAINED its widgets_values placeholder ["A", 0.75], so the positional
    // pass sets model.strength=0.75. Option A DEFINES strength (FLOAT default 0.5),
    // option B OMITS it. The pre-fix strict default-deny deleted model.strength purely
    // because B lacks it — silently discarding the user's 0.75 so execution used A's
    // default 0.5. A LITERAL user value defined by at least one option (and valid where
    // defined) must be PRESERVED: dropping it on option B, a resolution that may never
    // occur, is the corruption. (Link-ref leaves — no user scalar to lose — keep the
    // strict every-option rule; see the two tests above.)
    const info = {
      ComboProvider: {
        input: { required: {} },
        output: ["COMBO"],
        output_name: ["COMBO"],
      },
      DynParentNode: {
        input: {
          required: {
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "A",
                    inputs: {
                      required: { strength: ["FLOAT", { default: 0.5 }] },
                    },
                  },
                  { key: "B", inputs: { required: {} } }, // B omits `strength`
                ],
              },
            ],
          },
        },
        input_order: { required: ["model"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 5,
          type: "ComboProvider",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [20] }],
          widgets_values: [],
        },
        {
          id: 3,
          type: "DynParentNode",
          mode: 0,
          inputs: [{ name: "model", type: "COMBO", link: 20 }],
          outputs: [],
          // Retained placeholder: parent "A" + nested literal strength 0.75.
          widgets_values: ["A", 0.75],
        },
      ],
      links: [[20, 5, 0, 3, 0, "COMBO"]],
    } as never;
    const { workflow } = convertUiToApi(ui, info);
    // Parent is a runtime link ref…
    expect(Array.isArray(workflow["3"].inputs.model)).toBe(true);
    // …and the user's literal strength is PRESERVED, not dropped to A's default 0.5.
    expect(workflow["3"].inputs["model.strength"]).toBe(0.75);
  });

  it("leaves a VALID enum fed by a linked PrimitiveNode untouched (no warn)", () => {
    const info = {
      KSamplerSelect: {
        input: { required: { sampler_name: [["euler", "dpmpp_2m"]] } },
        input_order: { required: ["sampler_name"] },
      },
      PrimitiveNode: { input: { required: {} } },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "PrimitiveNode",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: ["dpmpp_2m"],
        },
        {
          id: 2,
          type: "KSamplerSelect",
          mode: 0,
          inputs: [{ name: "sampler_name", type: "COMBO", link: 10 }],
          outputs: [],
          widgets_values: ["euler"],
        },
      ],
      links: [[10, 1, 0, 2, 0, "COMBO"]],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["2"].inputs.sampler_name).toBe("dpmpp_2m");
    expect(warnings.some((w) => /substituting|missing-asset/.test(w))).toBe(
      false,
    );
  });
});

describe("convertUiToApi — option-bearing / dynamic nested combo validation (P1-B, #504)", () => {
  // The option-list extraction only read spec[0] as the options array, so it
  // MISSED the ["COMBO",{options:[...]}] form and V3 dynamic-combo nested combos —
  // those values were copied raw and reached the API unvalidated.

  it("SUBSTITUTES+warns an out-of-list nested value in a V3 dynamic combo", () => {
    const info = {
      NanoBananaNode: {
        input: {
          required: {
            prompt: ["STRING"],
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "Nano Banana 2",
                    inputs: {
                      required: {
                        aspect_ratio: ["COMBO", { options: ["auto", "1:1", "16:9"] }],
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
        input_order: { required: ["prompt", "model"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "NanoBananaNode",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: ["a prompt", "Nano Banana 2", "4:3"],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["1"].inputs.model).toBe("Nano Banana 2");
    // The nested "4:3" is not a valid aspect_ratio option — substituted to "auto".
    expect(workflow["1"].inputs["model.aspect_ratio"]).toBe("auto");
    expect(workflow["1"].inputs["model.aspect_ratio"]).not.toBe("4:3");
    expect(
      warnings.some(
        (w) =>
          w.includes("1") &&
          w.includes("aspect_ratio") &&
          /substituting/.test(w),
      ),
    ).toBe(true);
  });

  it("leaves a VALID nested dynamic-combo value untouched (no warn)", () => {
    const info = {
      NanoBananaNode: {
        input: {
          required: {
            prompt: ["STRING"],
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "Nano Banana 2",
                    inputs: {
                      required: {
                        aspect_ratio: ["COMBO", { options: ["auto", "1:1", "16:9"] }],
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
        input_order: { required: ["prompt", "model"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "NanoBananaNode",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: ["a prompt", "Nano Banana 2", "16:9"],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["1"].inputs["model.aspect_ratio"]).toBe("16:9");
    expect(warnings.some((w) => /substituting|missing-asset/.test(w))).toBe(
      false,
    );
  });

  it("REFUSES to map trailing widgets after a STALE dynamic parent when a trailing widget is control-eligible (ambiguous slot count) — no stale value on seed (#517 P0)", () => {
    // Saved parent "removed-model" is no longer an option and is substituted to
    // "new-model". The array [removed-model, 12345] is AMBIGUOUS: it could be
    // [parent, seed] (old option had 0 nested) OR [parent, orphaned-nested] (old
    // option owned 1 nested, seed omitted). Since the trailing `seed` is
    // control-eligible (variable phantom slot), the removed option's nested arity
    // can't be reconstructed unambiguously, so we REFUSE: seed is left to default
    // rather than risk a stale nested value being mapped onto it. This is the safe
    // contract — a wrong seed is silently wrong; a defaulted seed is warned.
    const info = {
      NanoBananaNode: {
        input: {
          required: {
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "new-model",
                    inputs: {
                      required: {
                        aspect_ratio: ["COMBO", { options: ["1:1", "16:9"] }],
                      },
                    },
                  },
                ],
              },
            ],
            seed: ["INT"],
          },
        },
        input_order: { required: ["model", "seed"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "NanoBananaNode",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: ["removed-model", 12345],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["1"].inputs.model).toBe("new-model");
    // seed must NOT hold an ambiguous positional value from the stale layout.
    expect(workflow["1"].inputs.seed).not.toBe(12345);
    // The refusal is warned (not silent).
    expect(
      warnings.some(
        (w) =>
          w.includes("1") &&
          w.includes("removed-model") &&
          /can't be reconstructed|default/.test(w),
      ),
    ).toBe(true);
  });

  it("REFUSES (never realigns) a STALE dynamic parent even when the CURRENT schema added a trailing widget — an orphaned nested value never lands on a later widget (#517 P0 schema-drift)", () => {
    // The saved parent option "Removed" is gone; the OLD option owned a nested
    // `strength` (=0.75) sitting between the parent and the trailing `seed`. The
    // CURRENT schema has ALSO added a trailing `new_widget`. A naive surplus
    // arithmetic (values-left minus current-trailing-count) cancels the orphaned
    // slot to zero and would silently map seed=0.75 and new_widget=42 — the orphan
    // STILL lands on seed. Since neither the removed option's arity NOR the
    // trailing schema drift is recoverable, the fix REFUSES all positional mapping
    // after the stale parent: seed and new_widget default, and the orphaned 0.75
    // NEVER reaches a later widget.
    const info = {
      DriftNode: {
        input: {
          required: {
            mode: [
              "COMFY_DYNAMICCOMBO_V3",
              { options: [{ key: "A", inputs: { required: {} } }] },
            ],
            seed: ["INT", { default: 0 }],
            new_widget: ["INT", { default: 99 }],
          },
        },
        input_order: { required: ["mode", "seed", "new_widget"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "DriftNode",
          mode: 0,
          inputs: [],
          outputs: [],
          // OLD "Removed" option owned strength=0.75; saved [mode, strength, seed]
          widgets_values: ["Removed", 0.75, 42],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["1"].inputs.mode).toBe("A");
    // The orphaned nested value NEVER lands on a later widget.
    expect(workflow["1"].inputs.seed).not.toBe(0.75);
    expect(workflow["1"].inputs.new_widget).not.toBe(0.75);
    // seed/new_widget fall to their schema defaults, not a shifted positional value.
    expect(workflow["1"].inputs.seed).toBe(0);
    expect(workflow["1"].inputs.new_widget).toBe(99);
    expect(
      warnings.some(
        (w) =>
          w.includes("1") &&
          w.includes("Removed") &&
          /can't be reconstructed|default/.test(w),
      ),
    ).toBe(true);
  });

  it("REFUSES (warn + default) when a stale dynamic parent is followed by a control-eligible seed — the orphaned nested value never lands on seed (#517 P0)", () => {
    // Exact P0 repro shape: current option A owns no nested; the OLD option owned a
    // nested strength=0.75 now sitting before the trailing top-level `seed`. `seed`
    // is control_after_generate (variable phantom slot), so the surplus is
    // ambiguous — we can't tell [mode, strength, seed] from [mode, seed, control].
    // We REFUSE: seed must NOT be silently overwritten by the orphaned 0.75.
    const info = {
      StaleSeedNode: {
        input: {
          required: {
            mode: [
              "COMFY_DYNAMICCOMBO_V3",
              { options: [{ key: "A", inputs: { required: {} } }] },
            ],
            seed: ["INT", { default: 0 }],
          },
        },
        input_order: { required: ["mode", "seed"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "StaleSeedNode",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: ["Removed", 0.75, 42],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["1"].inputs.mode).toBe("A");
    // seed must NOT be the orphaned nested value.
    expect(workflow["1"].inputs.seed).not.toBe(0.75);
    // The refusal is warned; seed is left to its schema default rather than a
    // silently-misaligned positional value.
    expect(
      warnings.some(
        (w) =>
          w.includes("1") &&
          w.includes("Removed") &&
          /can't be reconstructed|default/.test(w),
      ),
    ).toBe(true);
  });

  it("REFUSES to reconstruct (warn + default-fill) when a trailing widget after a stale dynamic parent is itself a dynamic combo (#517 P0)", () => {
    // Two dynamic combos in a row; the FIRST is stale. The trailing one's nested
    // arity is value-dependent and can't be counted, so the surplus is ambiguous.
    // Rather than risk misassigning, the remaining widgets are left to defaults.
    const info = {
      TwoDynNode: {
        input: {
          required: {
            mode: [
              "COMFY_DYNAMICCOMBO_V3",
              { options: [{ key: "A", inputs: { required: {} } }] },
            ],
            other: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "X",
                    inputs: { required: { sub: ["COMBO", { options: ["p", "q"] }] } },
                  },
                ],
              },
            ],
          },
        },
        input_order: { required: ["mode", "other"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "TwoDynNode",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: ["Removed", 0.75, "X", "p"],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["1"].inputs.mode).toBe("A");
    expect(
      warnings.some(
        (w) => w.includes("Removed") && /can't be reconstructed|default/.test(w),
      ),
    ).toBe(true);
  });

  it("REFUSES (warn + default) when a stale dynamic parent has an EMPTY current options list — the type marker, not the option-key heuristic, must fire the guard (#517 P0 empty-options)", () => {
    // The CURRENT schema's dynamic combo has NO options at all
    // (["COMFY_DYNAMICCOMBO_V3", {options: []}]) — e.g. its option source hasn't
    // populated yet, or every option was removed. The saved selection is therefore
    // stale by definition, and the OLD option owned a nested strength=0.75 sitting
    // between the parent and the trailing `seed`. An empty options array has NO
    // keyed {key,inputs} entries, so the object-key heuristic reports NOT-dynamic
    // and the stale-parent guard would be BYPASSED — the loop would silently map
    // seed=0.75 (the orphaned nested value) and treat 42 as a phantom slot. Keying
    // the guard off the EXPLICIT type string ("COMFY_DYNAMICCOMBO_V3") fires the
    // refusal here too: seed keeps its schema default, and 0.75 never lands on it.
    const info = {
      EmptyOptsNode: {
        input: {
          required: {
            model: ["COMFY_DYNAMICCOMBO_V3", { options: [] }],
            seed: ["INT", { default: 0 }],
          },
        },
        input_order: { required: ["model", "seed"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "EmptyOptsNode",
          mode: 0,
          inputs: [],
          outputs: [],
          // OLD removed option owned strength=0.75; saved
          // [model, strength(nested), seed, control-phantom].
          widgets_values: ["removed-option", 0.75, 42, "fixed"],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    // The parent itself is preserved (an empty option list can't substitute it).
    // The critical invariant: seed is NOT the silently-shifted orphaned 0.75.
    expect(workflow["1"].inputs.seed).not.toBe(0.75);
    // seed falls to its schema default rather than an ambiguous positional value.
    expect(workflow["1"].inputs.seed).toBe(0);
    // The refusal is warned (not silent) and names the stale selection.
    expect(
      warnings.some(
        (w) =>
          w.includes("1") &&
          w.includes("removed-option") &&
          /can't be reconstructed|default/.test(w),
      ),
    ).toBe(true);
  });

  it("DEFAULTS the tail when a STILL-VALID dynamic option's nested arity DRIFTED (leftover) — no stale nested value on the seed (#517 P0 arity-drift)", () => {
    // The saved option key "A" STILL EXISTS, so the stale-parent (removed-key) guard
    // does NOT fire. But when the graph was saved, option A owned a nested
    // `multiplier` (=4); the CURRENT schema's option A has REMOVED it. Mapping with
    // the current (empty) nested layout consumes nothing, so the loop assigns
    // seed=4 (the stale nested value) and skips the REAL 424242 as the control
    // phantom — the user's seed silently becomes 4, with a leftover "fixed" proving
    // the drift. The leftover-drift guard must default the post-combo widgets: seed
    // must NOT be 4.
    const info = {
      DriftArityNode: {
        input: {
          required: {
            mode: [
              "COMFY_DYNAMICCOMBO_V3",
              // Current option A defines NO nested inputs (multiplier was removed).
              { options: [{ key: "A", inputs: { required: {} } }] },
            ],
            seed: ["INT", { control_after_generate: true, default: 0 }],
          },
        },
        input_order: { required: ["mode", "seed"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "DriftArityNode",
          mode: 0,
          inputs: [],
          outputs: [],
          // Saved under the OLD layout: [mode, multiplier(nested,=4), seed, control].
          widgets_values: ["A", 4, 424242, "fixed"],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    // Parent stays "A" (still a valid option).
    expect(workflow["1"].inputs.mode).toBe("A");
    // The stale nested value must NEVER become the seed.
    expect(workflow["1"].inputs.seed).not.toBe(4);
    // seed falls to its schema default, not the shifted positional value.
    expect(workflow["1"].inputs.seed).toBe(0);
    // The drift is warned (not silent).
    expect(
      warnings.some(
        (w) => w.includes("1") && /nested-input layout|default/.test(w),
      ),
    ).toBe(true);
  });

  it("does NOT let the arity-drift guard mis-fire on a LINKED-leaf refusal in a LATER dynamic combo — earlier valid combo must not default the later parent (#517 P0-A/drift interaction)", () => {
    // Two dynamic combos in order. The FIRST (`first`) is a normal still-valid combo
    // (sets sawDynamicCombo). The SECOND (`second`) has a LINKED nested leaf
    // (second.choice), which triggers the P0-A refuse-the-tail path — leaving a
    // leftover. Without the tailRefused gate, the post-loop drift guard would ALSO
    // fire, wrongly deleting `second` (a valid parent selection) and defaulting it to
    // the first option. The gate must suppress the drift guard here: `second` keeps
    // its saved "Y".
    const info = {
      TwoParentNode: {
        input: {
          required: {
            first: [
              "COMFY_DYNAMICCOMBO_V3",
              { options: [{ key: "A", inputs: { required: {} } }] },
            ],
            second: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "X",
                    inputs: {
                      required: { choice: ["COMBO", { options: ["x1"] }] },
                    },
                  },
                  {
                    key: "Y",
                    inputs: {
                      required: { choice: ["COMBO", { options: ["y1"] }] },
                    },
                  },
                ],
              },
            ],
          },
        },
        input_order: { required: ["first", "second"] },
      },
      PrimitiveNode: { input: { required: {} } },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "TwoParentNode",
          mode: 0,
          // second.choice is converted-to-input (linked).
          inputs: [{ name: "second.choice", type: "COMBO", link: 10 }],
          outputs: [],
          widgets_values: ["A", "Y", 424242],
        },
        {
          id: 2,
          type: "PrimitiveNode",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: ["y1"],
        },
      ],
      links: [[10, 2, 0, 1, 0, "COMBO"]],
    } as never;
    const { workflow } = convertUiToApi(ui, info);
    expect(workflow["1"].inputs.first).toBe("A");
    // The later parent must KEEP its saved selection, not be defaulted to "X".
    expect(workflow["1"].inputs.second).toBe("Y");
  });

  it("DEFAULTS a shifted NESTED leaf on proven arity-shrink even with NO trailing top-level widget (#517 P0 nested-shrink)", () => {
    // Old option A owned nested [obsolete, strength]; the CURRENT schema's A dropped
    // `obsolete`, leaving [strength]. Saved ["A", 4, 0.75] was serialized as
    // [mode, obsolete=4, strength=0.75]. Mapping with the current layout assigns
    // strength=4 (the OBSOLETE value!) and leaves 0.75 as a leftover. There is NO
    // trailing top-level widget, so the guard must STILL fire on the leftover and
    // default the shifted nested leaf — strength must NOT silently be 4.
    const info = {
      NestedShrinkNode: {
        input: {
          required: {
            mode: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "A",
                    // `obsolete` was removed; only `strength` remains.
                    inputs: { required: { strength: ["FLOAT", { default: 1 }] } },
                  },
                ],
              },
            ],
          },
        },
        input_order: { required: ["mode"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "NestedShrinkNode",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: ["A", 4, 0.75], // [mode, obsolete=4, strength=0.75]
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["1"].inputs.mode).toBe("A");
    // The shifted OBSOLETE value must NOT survive on the strength leaf.
    expect(workflow["1"].inputs["mode.strength"]).not.toBe(4);
    // It is dropped (absent) so ComfyUI supplies the option's runtime default.
    expect("mode.strength" in workflow["1"].inputs).toBe(false);
    expect(
      warnings.some(
        (w) => w.includes("1") && /nested-input layout|default/.test(w),
      ),
    ).toBe(true);
  });

  it("does NOT default a later EMPTY-OPTIONS V3 parent when an earlier valid combo set the drift flag (#517 P1 empty-options multi-combo)", () => {
    // An earlier valid dynamic combo (`first`) sets sawDynamicCombo. The later combo
    // (`second`) is an EMPTY-OPTIONS V3 whose saved selection is stale → the stale-
    // parent refusal fires. That refusal must set tailRefused so the leftover guard
    // does NOT delete `second` — an empty options list has no substitution or default
    // to restore it from, so deleting it would LOSE the declared parent entirely.
    const info = {
      TwoWithEmptyNode: {
        input: {
          required: {
            first: [
              "COMFY_DYNAMICCOMBO_V3",
              { options: [{ key: "A", inputs: { required: {} } }] },
            ],
            second: ["COMFY_DYNAMICCOMBO_V3", { options: [] }],
          },
        },
        input_order: { required: ["first", "second"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "TwoWithEmptyNode",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: ["A", "my-model", 42], // first=A, second=my-model + trailing
        },
      ],
      links: [],
    } as never;
    const { workflow } = convertUiToApi(ui, info);
    expect(workflow["1"].inputs.first).toBe("A");
    // The empty-options parent's declared value is preserved, NOT deleted.
    expect(workflow["1"].inputs.second).toBe("my-model");
  });

  it("PRESERVES a shared SCALAR required leaf under a runtime-linked dynamic parent — not dropped as a non-member (#517 false-positive)", () => {
    // `mode` is fed by a real (non-Primitive) link, so the resolved option is
    // unknown at convert time. BOTH options define a required SCALAR `strength`
    // (FLOAT, no combo options). The default-deny must NOT drop it: a scalar leaf
    // has no option list to be an in-list "member" of, so the membership check
    // must not apply — the leaf is valid whichever option resolves because every
    // option DEFINES it. Dropping it would cause a missing-required-input failure.
    const info = {
      ComboProvider: {
        input: { required: {} },
        output: ["COMBO"],
        output_name: ["COMBO"],
      },
      ScalarLeafNode: {
        input: {
          required: {
            mode: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "A",
                    inputs: { required: { strength: ["FLOAT", {}] } },
                  },
                  {
                    key: "B",
                    inputs: { required: { strength: ["FLOAT", {}] } },
                  },
                ],
              },
            ],
          },
        },
        input_order: { required: ["mode"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "ComboProvider",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: [],
        },
        {
          id: 3,
          type: "ScalarLeafNode",
          mode: 0,
          inputs: [{ name: "mode", type: "COMBO", link: 10 }],
          outputs: [],
          widgets_values: ["A", 0.75],
        },
      ],
      links: [[10, 1, 0, 3, 0, "COMBO"]],
    } as never;
    const { workflow } = convertUiToApi(ui, info);
    // Parent is a link ref.
    expect(Array.isArray(workflow["3"].inputs.mode)).toBe(true);
    // The shared scalar leaf is PRESERVED with its value.
    expect(workflow["3"].inputs["mode.strength"]).toBe(0.75);
  });

  it("still DROPS a genuinely orphaned COMBO leaf (value not in an option's list) under a runtime-linked dynamic parent (#517 guard intact)", () => {
    // Contrast to the scalar case: `choice` IS a combo. The saved literal "a1"
    // is valid only under option A; option B's `choice` list is ["b1","b2"], so a
    // runtime resolution to B would orphan it. The default-deny must still drop it.
    const info = {
      ComboProvider: {
        input: { required: {} },
        output: ["COMBO"],
        output_name: ["COMBO"],
      },
      ComboLeafNode: {
        input: {
          required: {
            mode: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "A",
                    inputs: { required: { choice: ["COMBO", { options: ["a1", "a2"] }] } },
                  },
                  {
                    key: "B",
                    inputs: { required: { choice: ["COMBO", { options: ["b1", "b2"] }] } },
                  },
                ],
              },
            ],
          },
        },
        input_order: { required: ["mode"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "ComboProvider",
          mode: 0,
          inputs: [],
          outputs: [{ name: "COMBO", type: "COMBO", links: [10] }],
          widgets_values: [],
        },
        {
          id: 3,
          type: "ComboLeafNode",
          mode: 0,
          inputs: [{ name: "mode", type: "COMBO", link: 10 }],
          outputs: [],
          widgets_values: ["A", "a1"],
        },
      ],
      links: [[10, 1, 0, 3, 0, "COMBO"]],
    } as never;
    const { workflow } = convertUiToApi(ui, info);
    expect(Array.isArray(workflow["3"].inputs.mode)).toBe(true);
    // The option-dependent combo leaf is dropped (not a member of every option).
    expect("mode.choice" in workflow["3"].inputs).toBe(false);
  });

  it("skips the phantom control_after_generate slot after a NESTED seed widget", () => {
    // A dynamic option exposing a nested controlled seed carries a phantom
    // "fixed"/"randomize" value after it (like top-level seeds). Not skipping it
    // shifts every following widget: aspect_ratio would eat "fixed" and steps
    // would eat "16:9".
    const info = {
      SeededNanoNode: {
        input: {
          required: {
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "new-model",
                    inputs: {
                      required: {
                        seed: ["INT", { control_after_generate: true }],
                        aspect_ratio: ["COMBO", { options: ["1:1", "16:9"] }],
                      },
                    },
                  },
                ],
              },
            ],
            steps: ["INT"],
          },
        },
        input_order: { required: ["model", "steps"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "SeededNanoNode",
          mode: 0,
          inputs: [],
          outputs: [],
          // [model, nested seed, phantom "fixed", nested aspect_ratio, steps]
          widgets_values: ["new-model", 42, "fixed", "16:9", 7],
        },
      ],
      links: [],
    } as never;
    const { workflow } = convertUiToApi(ui, info);
    expect(workflow["1"].inputs["model.seed"]).toBe(42);
    // aspect_ratio must be "16:9", NOT the phantom "fixed".
    expect(workflow["1"].inputs["model.aspect_ratio"]).toBe("16:9");
    // steps must land on 7, not be shifted onto "16:9".
    expect(workflow["1"].inputs.steps).toBe(7);
  });

  it("SUBSTITUTES+warns an out-of-list required combo DEFAULT (schema-drift default-fill)", () => {
    // A required combo whose own schema `default` is not among its options (custom
    // node version drift). With no saved widget value the default-fill loop emits
    // it — it must be validated (substituted to first option), not passed raw.
    const info = {
      DriftySampler: {
        input: {
          required: {
            sampler_name: [["euler", "dpmpp_2m"], { default: "removed_sampler" }],
          },
        },
        input_order: { required: ["sampler_name"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 77,
          type: "DriftySampler",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: [], // nothing saved -> default-fill path
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["77"].inputs.sampler_name).toBe("euler");
    expect(workflow["77"].inputs.sampler_name).not.toBe("removed_sampler");
    expect(
      warnings.some(
        (w) =>
          w.includes("77") &&
          w.includes("removed_sampler") &&
          /substituting/.test(w),
      ),
    ).toBe(true);
  });

  it("consumes+validates an OPTIONAL positional nested leaf and keeps later widget index aligned", () => {
    // A V3 option whose nested widget lives under `optional`. It occupies a
    // positional widgets_values slot; reading only `required` would skip it and
    // mis-position the trailing top-level `seed` widget. The nested value must be
    // validated (substituted) AND the following widget must still land correctly.
    const info = {
      NanoBananaNode: {
        input: {
          required: {
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "Nano Banana 2",
                    inputs: {
                      optional: {
                        output_format: ["COMBO", { options: ["png", "webp"] }],
                      },
                    },
                  },
                ],
              },
            ],
            seed: ["INT"],
          },
        },
        input_order: { required: ["model", "seed"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "NanoBananaNode",
          mode: 0,
          inputs: [],
          outputs: [],
          // model, model.output_format (optional nested), seed
          widgets_values: ["Nano Banana 2", "gif", 12345],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    // The optional nested leaf is consumed + validated (gif -> png).
    expect(workflow["1"].inputs["model.output_format"]).toBe("png");
    // …and the trailing top-level `seed` still lands on the right slot.
    expect(workflow["1"].inputs.seed).toBe(12345);
    expect(
      warnings.some(
        (w) => w.includes("1") && w.includes("output_format") && /substituting/.test(w),
      ),
    ).toBe(true);
  });

  it("SUBSTITUTES+warns an out-of-list value on a top-level [\"COMBO\",{options}] spec", () => {
    const info = {
      ApiImageNode: {
        input: {
          required: {
            response_modalities: [
              "COMBO",
              { options: ["IMAGE", "IMAGE+TEXT"] },
            ],
          },
        },
        input_order: { required: ["response_modalities"] },
      },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "ApiImageNode",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: ["AUDIO"], // not an option — helper missed this shape before
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["1"].inputs.response_modalities).toBe("IMAGE");
    expect(workflow["1"].inputs.response_modalities).not.toBe("AUDIO");
    expect(
      warnings.some(
        (w) => w.includes("1") && w.includes("AUDIO") && /substituting/.test(w),
      ),
    ).toBe(true);
  });
});

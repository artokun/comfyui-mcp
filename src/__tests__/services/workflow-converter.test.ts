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

  it("does NOT consume a positional slot for a LINKED nested leaf — trailing widget stays aligned", () => {
    // model.aspect_ratio is converted-to-input (linked), so it has NO positional
    // widgets_values entry: ["Nano Banana 2", 12345] = [model, seed]. Consuming a
    // slot for the linked leaf would steal seed's value. It must be skipped.
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
          widgets_values: ["Nano Banana 2", 12345], // aspect_ratio linked = no slot
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
    const { workflow } = convertUiToApi(ui, info);
    // seed keeps its real value — not stolen by the linked nested leaf.
    expect(workflow["1"].inputs.seed).toBe(12345);
    // and the nested leaf comes from the link.
    expect(workflow["1"].inputs["model.aspect_ratio"]).toBe("1:1");
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

  it("does NOT consume nested slots for a STALE (substituted) dynamic parent — trailing widget stays aligned", () => {
    // Saved parent "removed-model" is no longer an option and is substituted to
    // "new-model". The saved array was serialized against the OLD option's layout
    // (here: no nested widgets), so its nested arity is unrecoverable. We must
    // consume NO nested slots against the replacement's layout — doing so would
    // steal the trailing `seed` value. seed must survive; the required nested
    // aspect_ratio of the replacement is left to default-fill.
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
          // OLD option had no nested widgets: [model(stale), seed]
          widgets_values: ["removed-model", 12345],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(ui, info);
    expect(workflow["1"].inputs.model).toBe("new-model");
    // seed is NOT stolen by an ambiguous nested slot.
    expect(workflow["1"].inputs.seed).toBe(12345);
    expect(
      warnings.some(
        (w) => w.includes("1") && w.includes("removed-model") && /substituting/.test(w),
      ),
    ).toBe(true);
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

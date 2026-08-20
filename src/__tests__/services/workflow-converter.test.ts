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
      ImageSource: {
        input: { required: {} },
        output: ["IMAGE"],
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
          inputs: [
            { name: "model.images.image_1", type: "IMAGE", link: 2 },
          ],
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
          id: 3,
          type: "ImageSource",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [2] }],
          widgets_values: [],
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
      links: [
        [1, 1, 0, 2, 0, "IMAGE"],
        [2, 3, 0, 1, 0, "IMAGE"],
      ],
    } as never;

    const { workflow } = convertUiToApi(ui, objectInfo);
    expect(workflow["1"].inputs).toMatchObject({
      prompt: "a red cube",
      model: "Nano Banana 2 (Gemini 3.1 Flash Image)",
      "model.aspect_ratio": "16:9",
      "model.resolution": "2K",
      "model.thinking_level": "HIGH",
      "model.images.image_1": ["3", 0],
      seed: 7,
      response_modalities: "IMAGE",
    });
    // AUTOGROW images is not a positional widget — it must NOT consume the seed
    // slot, and no `model.images` key is emitted from widgets_values.
    expect(workflow["1"].inputs).not.toHaveProperty("model.images");
    expect(workflow["1"].inputs).not.toHaveProperty("aspect_ratio");
  });

  it("preserves linked COMFY_AUTOGROW_V3 entries without a serialized parent value", () => {
    const objectInfo = {
      PrimitiveInt: {
        input: { required: { value: ["INT", { default: 0 }] } },
        output: ["INT"],
      },
      ComfyMathExpression: {
        input: {
          required: {
            expression: ["STRING", { default: "a + b" }],
            values: [
              "COMFY_AUTOGROW_V3",
              {
                template: {
                  input: { required: { value: ["FLOAT,INT,BOOLEAN", {}] } },
                  names: ["a", "b"],
                  min: 1,
                },
              },
            ],
          },
        },
        output: ["FLOAT", "INT", "BOOLEAN"],
      },
    } as never;

    const ui = {
      nodes: [
        {
          id: 1,
          type: "PrimitiveInt",
          mode: 0,
          inputs: [],
          outputs: [{ name: "INT", type: "INT", links: [1, 2] }],
          widgets_values: [8],
        },
        {
          id: 2,
          type: "ComfyMathExpression",
          mode: 0,
          inputs: [
            { name: "values.a", type: "FLOAT,INT,BOOLEAN", link: 1 },
            { name: "values.b", type: "FLOAT,INT,BOOLEAN", link: 2 },
            { name: "expression", type: "STRING", link: null, widget: { name: "expression" } },
          ],
          outputs: [{ name: "INT", type: "INT", links: null }],
          widgets_values: ["a + b"],
        },
      ],
      links: [
        [1, 1, 0, 2, 0, "INT"],
        [2, 1, 0, 2, 1, "INT"],
      ],
    } as never;

    const { workflow } = convertUiToApi(ui, objectInfo);
    expect(workflow["2"].inputs).toEqual({
      expression: "a + b",
      "values.a": ["1", 0],
      "values.b": ["1", 0],
    });
    expect(workflow["2"].inputs).not.toHaveProperty("values");
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

  // #1400 — the SAME bus, spelled with the PRO_ variants. The de-virtualizer and the
  // main loop used to keep separate copies of this type list; they now share one, and
  // this is what notices if that list is narrowed back to the two common names.
  it("a PRO_Set/PRO_Get bus resolves identically — the whole type list is live", () => {
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
          type: "PRO_SetNode",
          mode: 0,
          inputs: [{ name: "IMAGE", type: "IMAGE", link: 1 }],
          outputs: [],
          widgets_values: ["BUS"],
        },
        {
          id: 3,
          type: "PRO_GetNode",
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
    expect(workflow["2"]).toBeUndefined();
    expect(workflow["3"]).toBeUndefined();
    expect(workflow["4"].inputs.images).toEqual(["1", 0]);
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
    // The point of this test is that `properties` did NOT override the
    // positional pass. `frame_rate !== 24` used to stand in for that, but it no
    // longer can: the three BOOLEAN widgets refuse the STRING values sitting on
    // them, so #1869's extras-skipping realigns the TAIL and it now arrives at
    // 24 positionally — the same answer properties would have given. Assert the
    // HEAD instead, which nothing can realign and which properties would have
    // corrected if it were being consulted.
    expect(inputs.timeline_data).toBe("15"); // properties say '{"mainTrackEnabled":true}'
    expect(inputs.epsilon).toBe("360"); // properties say 0.001
    expect(inputs.start_second).toBe("0"); // properties say the NUMBER 0
    expect(inputs["Node name for S&R"]).toBeUndefined();
  });
});

describe("convertUiToApi — combined-type widget (issue #193, LTXVEmptyLatentAudio)", () => {
  // Real /object_info: frame_rate is declared with the COMBINED type "FLOAT,INT"
  // (accepts either) plus a widgetType hint. Before the fix isWidgetInput only
  // matched the exact scalar types, so frame_rate was treated as a LINK input,
  // dropped from the widget list, and batch_size stole frame_rate's slot value
  // while frame_rate fell back to its default (25).
  const LTXV_INFO = {
    LTXVEmptyLatentAudio: {
      input: {
        required: {
          frames_number: ["INT", { default: 97 }],
          frame_rate: ["FLOAT,INT", { default: 25, widgetType: "FLOAT" }],
          batch_size: ["INT", { default: 1 }],
          audio_vae: ["VAE", {}],
        },
      },
      input_order: {
        required: ["frames_number", "frame_rate", "batch_size", "audio_vae"],
      },
    },
  } as never;

  function ltxvGraph() {
    return {
      nodes: [
        {
          id: 5,
          type: "LTXVEmptyLatentAudio",
          mode: 0,
          // audio_vae is a real VAE link slot; the three scalars live in widgets_values
          // in UI widget order: frames_number, frame_rate, batch_size.
          inputs: [{ name: "audio_vae", type: "VAE", link: null }],
          outputs: [{ name: "Latent", type: "LATENT", links: [] }],
          widgets_values: [121, 24, 1],
        },
      ],
      links: [],
    } as never;
  }

  it("maps frames_number/frame_rate/batch_size positionally (frame_rate is a FLOAT,INT widget)", () => {
    const { workflow } = convertUiToApi(ltxvGraph(), LTXV_INFO);
    const inputs = (workflow["5"] as { inputs: Record<string, unknown> }).inputs;
    expect(inputs.frames_number).toBe(121);
    expect(inputs.frame_rate).toBe(24);
    expect(inputs.batch_size).toBe(1);
  });

  // Cross-repo regression for panel#193 (same root cause, live-canvas strip):
  // reproduce the EXACT reported symptom to prove it never recurs — the pre-fix
  // converter emitted {frames_number:121, batch_size:24, frame_rate:25}, i.e.
  // batch_size stole frame_rate's 24 and frame_rate fell back to its default 25.
  it("panel#193 exact symptom: batch_size no longer steals frame_rate's value, frame_rate not defaulted", () => {
    const { workflow } = convertUiToApi(ltxvGraph(), LTXV_INFO);
    const inputs = (workflow["5"] as { inputs: Record<string, unknown> }).inputs;
    // pre-fix (buggy) values must NOT appear
    expect(inputs.batch_size).not.toBe(24);
    expect(inputs.frame_rate).not.toBe(25);
    // exactly the live-canvas values
    expect(inputs).toMatchObject({ frames_number: 121, frame_rate: 24, batch_size: 1 });
  });

  // A widgetType hint alone (type is a bare link-shaped string) is enough to treat
  // the slot as a positional scalar widget — guards the second recognition path in
  // isScalarWidgetType so a hint-only frontend build can't reintroduce the shift.
  it("recognizes a widgetType-hint-only scalar widget (no combined type)", () => {
    const HINT_INFO = {
      LTXVEmptyLatentAudio: {
        input: {
          required: {
            frames_number: ["INT", { default: 97 }],
            frame_rate: ["FLOAT", { default: 25, widgetType: "FLOAT" }],
            batch_size: ["INT", { default: 1 }],
            audio_vae: ["VAE", {}],
          },
        },
        input_order: {
          required: ["frames_number", "frame_rate", "batch_size", "audio_vae"],
        },
      },
    } as never;
    const { workflow } = convertUiToApi(ltxvGraph(), HINT_INFO);
    const inputs = (workflow["5"] as { inputs: Record<string, unknown> }).inputs;
    expect(inputs).toMatchObject({ frames_number: 121, frame_rate: 24, batch_size: 1 });
  });
});

describe("convertUiToApi — name-keyed widgets carry dynamic-combo nested values (issue #384 fallback)", () => {
  // The live-canvas fallback reconstructs widgets_values as a name->value OBJECT.
  // A V3 dynamic combo's selected-option nested inputs must still be emitted as
  // "<combo>.<nested>" from that object form (not only from the positional array).
  const DYN_INFO = {
    MyDynNode: {
      input: {
        required: {
          method: [
            "COMFY_DYNAMICCOMBO_V3",
            {
              options: [
                { key: "rcas", inputs: { required: { strength: ["FLOAT", { default: 0.5 }] } } },
                { key: "none", inputs: { required: {} } },
              ],
            },
          ],
        },
      },
      input_order: { required: ["method"] },
    },
  } as never;

  it("emits <combo>.<nested> from object-form widgets_values", () => {
    const graph = {
      nodes: [
        {
          id: 7,
          type: "MyDynNode",
          mode: 0,
          inputs: [],
          outputs: [],
          // object (name-keyed) form, as produced by the graph_get_state fallback
          widgets_values: { method: "rcas", strength: 0.8 },
        },
      ],
      links: [],
    } as never;
    const { workflow } = convertUiToApi(graph, DYN_INFO);
    const inputs = (workflow["7"] as { inputs: Record<string, unknown> }).inputs;
    expect(inputs.method).toBe("rcas");
    expect(inputs["method.strength"]).toBe(0.8);
  });

  // An option's nested input may live under `inputs.optional` (e.g. an asset
  // selector). The object-form fallback must merge required+optional like the
  // positional branch, or it silently drops the optional nested value — a #504/#407
  // regression on the live-canvas fallback path.
  it("emits an OPTIONAL nested <combo>.<nested> from object-form widgets_values", () => {
    const OPT_INFO = {
      OptDynNode: {
        input: {
          required: {
            method: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "load",
                    inputs: {
                      required: { strength: ["FLOAT", { default: 0.5 }] },
                      optional: { vae_name: [["a.safetensors", "b.safetensors"], {}] },
                    },
                  },
                ],
              },
            ],
          },
        },
        input_order: { required: ["method"] },
      },
    } as never;
    const graph = {
      nodes: [
        {
          id: 9,
          type: "OptDynNode",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: { method: "load", strength: 0.6, vae_name: "b.safetensors" },
        },
      ],
      links: [],
    } as never;
    const { workflow } = convertUiToApi(graph, OPT_INFO);
    const inputs = (workflow["9"] as { inputs: Record<string, unknown> }).inputs;
    expect(inputs["method.strength"]).toBe(0.6);
    // the optional nested asset selector must survive (kept-declared, not dropped)
    expect(inputs["method.vae_name"]).toBe("b.safetensors");
  });
});

describe("convertUiToApi — name-keyed nested-leaf name collisions must FAIL CLOSED (P0)", () => {
  // Two dynamic-combo parents each exposing a nested leaf of the SAME name. The
  // flat name→value capture (graph_get_state fallback) can only hold ONE "strength"
  // slot, so reading nested values by leaf name would push it onto BOTH controls —
  // a silent wrong-value regression (the #504/#499 bug class).
  const TWO_COMBO_INFO = {
    TwoComboNode: {
      input: {
        required: {
          first: [
            "COMFY_DYNAMICCOMBO_V3",
            { options: [{ key: "on", inputs: { required: { strength: ["FLOAT", { default: 0.5 }] } } }] },
          ],
          second: [
            "COMFY_DYNAMICCOMBO_V3",
            { options: [{ key: "on", inputs: { required: { strength: ["FLOAT", { default: 0.5 }] } } }] },
          ],
        },
      },
      input_order: { required: ["first", "second"] },
    },
  } as never;

  function twoComboGraph(widgets: Record<string, unknown>) {
    return {
      nodes: [
        { id: 3, type: "TwoComboNode", mode: 0, inputs: [], outputs: [], widgets_values: widgets },
      ],
      links: [],
    } as never;
  }

  it("REFUSES a collapsed flat leaf shared by two dynamic-combo parents (never emits both to one value)", () => {
    // pre-fix: BOTH first.strength AND second.strength came out 0.8 (collapsed).
    const { workflow, warnings } = convertUiToApi(
      twoComboGraph({ first: "on", second: "on", strength: 0.8 }),
      TWO_COMBO_INFO,
    );
    const inputs = (workflow["3"] as { inputs: Record<string, unknown> }).inputs;
    // must NOT silently collapse the same value onto both controls
    expect(inputs["first.strength"]).toBeUndefined();
    expect(inputs["second.strength"]).toBeUndefined();
    expect(warnings.some((w) => /more than one control/i.test(w))).toBe(true);
  });

  it("uses PARENT-QUALIFIED keys when the capture provides them (both correct, distinct)", () => {
    const { workflow } = convertUiToApi(
      twoComboGraph({
        first: "on",
        second: "on",
        "first.strength": 0.2,
        "second.strength": 0.8,
      }),
      TWO_COMBO_INFO,
    );
    const inputs = (workflow["3"] as { inputs: Record<string, unknown> }).inputs;
    expect(inputs["first.strength"]).toBe(0.2);
    expect(inputs["second.strength"]).toBe(0.8);
  });

  it("REFUSES a nested leaf that shadows a top-level widget of the same name", () => {
    const SHADOW_INFO = {
      ShadowNode: {
        input: {
          required: {
            strength: ["FLOAT", { default: 1 }], // top-level widget
            method: [
              "COMFY_DYNAMICCOMBO_V3",
              { options: [{ key: "load", inputs: { required: { strength: ["FLOAT", { default: 0.5 }] } } }] },
            ],
          },
        },
        input_order: { required: ["strength", "method"] },
      },
    } as never;
    const graph = {
      nodes: [
        {
          id: 4,
          type: "ShadowNode",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: { strength: 0.9, method: "load" },
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(graph, SHADOW_INFO);
    const inputs = (workflow["4"] as { inputs: Record<string, unknown> }).inputs;
    // The single flat "strength" slot can't be attributed to EITHER the top-level
    // widget or the nested leaf, so BOTH destinations must fail closed — the
    // top-level is left to its NODE DEFAULT (1), never the untrusted stored 0.9,
    // and the nested leaf is not emitted at all.
    expect(inputs.strength).not.toBe(0.9); // must not trust the collapsed value
    expect(inputs.strength).toBe(1); // filled with the widget's declared default
    expect(inputs["method.strength"]).toBeUndefined();
    expect(warnings.some((w) => /more than one control/i.test(w))).toBe(true);
  });

  it("a top-level widget stays safe when the nested leaf is PARENT-QUALIFIED (not competing for the flat slot)", () => {
    const SHADOW_INFO = {
      ShadowNode: {
        input: {
          required: {
            strength: ["FLOAT", { default: 1 }],
            method: [
              "COMFY_DYNAMICCOMBO_V3",
              { options: [{ key: "load", inputs: { required: { strength: ["FLOAT", { default: 0.5 }] } } }] },
            ],
          },
        },
        input_order: { required: ["strength", "method"] },
      },
    } as never;
    const graph = {
      nodes: [
        {
          id: 6,
          type: "ShadowNode",
          mode: 0,
          inputs: [],
          outputs: [],
          // nested value is parent-qualified, so the flat "strength" is unambiguously
          // the top-level widget's.
          widgets_values: { strength: 0.9, method: "load", "method.strength": 0.2 },
        },
      ],
      links: [],
    } as never;
    const { workflow } = convertUiToApi(graph, SHADOW_INFO);
    const inputs = (workflow["6"] as { inputs: Record<string, unknown> }).inputs;
    expect(inputs.strength).toBe(0.9);
    expect(inputs["method.strength"]).toBe(0.2);
  });
});

describe("convertUiToApi — Set/Get bus resolution (issue #361)", () => {
  const GETSET_INFO = {
    CheckpointLoaderSimple: {
      input: { required: { ckpt_name: [["a.ckpt", "b.ckpt"], {}] } },
    },
    KSampler: {
      input: { required: { model: ["MODEL"], seed: ["INT"] } },
    },
  } as never;

  // Loader(1).MODEL --link10--> SetNode(2) "mdl"
  //   GetNode(3) "mdl" --link12--> KSampler(4).model       (resolved via the bus)
  //   SetNode(2) passthrough output --link11--> KSampler(5).model  (direct off Set)
  function busGraph() {
    return {
      nodes: [
        {
          id: 1,
          type: "CheckpointLoaderSimple",
          mode: 0,
          inputs: [],
          outputs: [{ name: "MODEL", type: "MODEL", links: [10] }],
          widgets_values: ["a.ckpt"],
        },
        {
          id: 2,
          type: "SetNode",
          mode: 0,
          inputs: [{ name: "MODEL", type: "MODEL", link: 10 }],
          outputs: [{ name: "*", type: "MODEL", links: [11] }],
          widgets_values: ["mdl"],
        },
        {
          id: 3,
          type: "GetNode",
          mode: 0,
          inputs: [],
          outputs: [{ name: "*", type: "MODEL", links: [12] }],
          widgets_values: ["mdl"],
        },
        {
          id: 4,
          type: "KSampler",
          mode: 0,
          inputs: [{ name: "model", type: "MODEL", link: 12 }],
          outputs: [],
          widgets_values: [123],
        },
        {
          id: 5,
          type: "KSampler",
          mode: 0,
          inputs: [{ name: "model", type: "MODEL", link: 11 }],
          outputs: [],
          widgets_values: [456],
        },
      ],
      links: [
        [10, 1, 0, 2, 0, "MODEL"],
        [11, 2, 0, 5, 0, "MODEL"],
        [12, 3, 0, 4, 0, "MODEL"],
      ],
    } as never;
  }

  it("resolves a GetNode consumer through the bus to the real source", () => {
    const { workflow } = convertUiToApi(busGraph(), GETSET_INFO);
    expect(workflow["4"].inputs.model).toEqual(["1", 0]);
    expect(workflow["4"].inputs.seed).toBe(123);
  });

  it("preserves a link taken directly off a SetNode passthrough output (was dropped)", () => {
    const { workflow } = convertUiToApi(busGraph(), GETSET_INFO);
    expect(workflow["5"].inputs.model).toEqual(["1", 0]);
    // virtual bus nodes never appear in the prompt
    expect(workflow["2"]).toBeUndefined();
    expect(workflow["3"]).toBeUndefined();
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
    const { workflow } = convertUiToApi(ui, info);
    // THE P0, unchanged and non-negotiable: the retained placeholder must NEVER
    // become the seed.
    expect(workflow["1"].inputs.seed).not.toBe(4);
    // #1037 — this row is now RESOLVED rather than refused, and the seed the user
    // actually saved survives. Counting settles it: 3 slots remain after the
    // parent; "placeholders retained" consumes 1 and leaves 2 for seed + its
    // control_after_generate phantom, while "omitted" would leave 3. Only one
    // adds up, so the placeholder is stepped over and 424242 lands on seed.
    //
    // This assertion used to read `toBe(0)`. That was the refusal's outcome and
    // the best answer available while the ambiguity was unresolvable — but it
    // meant the user's seed was silently REPLACED BY ZERO, which is its own
    // quiet data loss. Recovering 424242 is strictly better, and the guard that
    // matters (never 4) is untouched.
    expect(workflow["1"].inputs.seed).toBe(424242);
    // The linked nested leaf is supplied by its (PrimitiveNode) source, not the
    // retained placeholder 4.
    expect(workflow["1"].inputs["mode.multiplier"]).toBe(8);
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
    const { workflow, warnings } = convertUiToApi(ui, info);
    // Parent stays a runtime link ref…
    expect(Array.isArray(workflow["3"].inputs.model)).toBe(true);
    // …but the leaf, not defined by every option, is dropped (would orphan under B).
    expect("model.choice" in workflow["3"].inputs).toBe(false);
    // …and the drop MUST be warned (FIX 2) — a silently removed link is the bug class.
    expect(
      warnings.some(
        (w) =>
          w.includes("3") &&
          w.includes("model.choice") &&
          w.includes("model") &&
          /dropped|link/.test(w),
      ),
    ).toBe(true);
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

  it("does NOT delete VALID earlier values when a LATER combo refuses — a refusal's expected leftover is not a drift signal (#517 FIX 1 no-false-positive)", () => {
    // `first` is a valid dynamic combo with a correctly-mapped nested leaf
    // (first.note="hello"); `count`=7 is an ordinary widget after it; `second` is a
    // dynamic combo whose nested `choice` is LINKED, so it hits the linked-leaf
    // refusal with saved values remaining. The refusal INTENTIONALLY leaves a
    // leftover — that leftover must NOT be read as "first drifted" and cause the guard
    // to delete the perfectly valid first.note and count. (A refusal suppresses the
    // drift guard for the whole node; earlier drift, if any, is positionally
    // indistinguishable from this valid layout and falls to the accepted limitation.)
    const info = {
      MixedNode: {
        input: {
          required: {
            first: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "A",
                    inputs: { required: { note: ["STRING", {}] } },
                  },
                ],
              },
            ],
            count: ["INT", { default: 0 }],
            second: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
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
        input_order: { required: ["first", "count", "second"] },
      },
      PrimitiveNode: { input: { required: {} } },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "MixedNode",
          mode: 0,
          // second.choice is converted-to-input (linked).
          inputs: [{ name: "second.choice", type: "COMBO", link: 10 }],
          outputs: [],
          widgets_values: ["A", "hello", 7, "Y", 424242],
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
    // The valid earlier nested leaf and widget must be PRESERVED, not deleted.
    expect(workflow["1"].inputs["first.note"]).toBe("hello");
    expect(workflow["1"].inputs.count).toBe(7);
    // The later linked-leaf combo keeps its saved selection.
    expect(workflow["1"].inputs.second).toBe("Y");
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

// #1869 — AMVideoRead/AMVideoWrite serialize frontend action buttons into
// widgets_values (`browse`, `open_in_explorer`, `copy_path` above file_path,
// and interspersed `detect_range` before first_frame). Those buttons are
// absent from /object_info, so pairing from slot 0 used to land them on
// real inputs (`frame_mode='open_in_explorer'`, `first_frame='copy_path'`).
describe("convertUiToApi — serialized action buttons must not shift widget values (#1869)", () => {
  const AM_VIDEO_READ = {
    input: {
      required: {
        file_path: ["STRING", { default: "" }],
        frame_mode: [["single", "range", "all"], { default: "all" }],
        first_frame: ["INT", { default: 1 }],
        last_frame: ["INT", { default: -1 }],
      },
    },
    output: ["IMAGE"],
    output_node: true,
  };

  const FILE_PATH = "D:/shots/plate.mov";
  const FRAME_MODE = "range";
  const FIRST_FRAME = 12;
  const LAST_FRAME = 48;

  it("skips prefix and interspersed action-button tokens on AMVideoRead", () => {
    const ui = {
      nodes: [
        {
          id: 1,
          type: "AMVideoRead",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: [
            "browse",
            "open_in_explorer",
            "copy_path",
            FILE_PATH,
            FRAME_MODE,
            "detect_range",
            FIRST_FRAME,
            LAST_FRAME,
          ],
        },
      ],
      links: [],
    } as never;
    const { workflow } = convertUiToApi(ui, { AMVideoRead: AM_VIDEO_READ } as never);
    expect(workflow["1"].inputs.file_path).toBe(FILE_PATH);
    expect(workflow["1"].inputs.frame_mode).toBe(FRAME_MODE);
    expect(workflow["1"].inputs.first_frame).toBe(FIRST_FRAME);
    expect(workflow["1"].inputs.last_frame).toBe(LAST_FRAME);
    expect(workflow["1"].inputs.file_path).not.toBe("browse");
    expect(workflow["1"].inputs.frame_mode).not.toBe("open_in_explorer");
    expect(workflow["1"].inputs.first_frame).not.toBe("copy_path");
    expect(workflow["1"].inputs.first_frame).not.toBe("detect_range");
  });

  it("skips prefix action-button tokens on AMVideoWrite (no detect_range)", () => {
    const codec = "h264";
    const outPath = "D:/out/shot.mov";
    const ui = {
      nodes: [
        {
          id: 2,
          type: "AMVideoWrite",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: [
            "browse",
            "open_in_explorer",
            "copy_path",
            outPath,
            codec,
          ],
        },
      ],
      links: [],
    } as never;
    const { workflow } = convertUiToApi(ui, {
      AMVideoWrite: {
        input: {
          required: {
            file_path: ["STRING", { default: "" }],
            codec: [["h264", "prores", "dnxhr"], { default: "h264" }],
          },
        },
        output: [],
        output_node: true,
      },
    } as never);
    expect(workflow["2"].inputs.file_path).toBe(outPath);
    expect(workflow["2"].inputs.codec).toBe(codec);
    expect(workflow["2"].inputs.file_path).not.toBe("browse");
    expect(workflow["2"].inputs.codec).not.toBe("open_in_explorer");
  });

  // The two cases below are the SAME SHAPE to a positional pass — one loose
  // STRING slot, one extra value, a lowercase-identifier candidate. Only the
  // token itself distinguishes them, so the uncorroborated path is allowed to
  // skip a button we have actually seen serialized and nothing else.
  it("skips an action prefix when no downstream widget can corroborate it", () => {
    const ui = {
      nodes: [
        {
          id: 3,
          type: "AMPathOnly",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: ["browse", "D:/out.mov", "final take"],
        },
      ],
      links: [],
    } as never;
    const { workflow } = convertUiToApi(ui, {
      AMPathOnly: {
        input: {
          required: { file_path: ["STRING", {}], note: ["STRING", {}] },
        },
        output: [],
      },
    } as never);
    expect(workflow["3"].inputs.file_path).toBe("D:/out.mov");
    expect(workflow["3"].inputs.note).toBe("final take");
  });

  it("leaves an ordinary lowercase STRING alone when nothing corroborates a skip", () => {
    const ui = {
      nodes: [
        {
          id: 4,
          type: "PlainText",
          mode: 0,
          inputs: [],
          outputs: [],
          widgets_values: ["hello", "Extra Thing"],
        },
      ],
      links: [],
    } as never;
    const { workflow } = convertUiToApi(ui, {
      PlainText: { input: { required: { text: ["STRING", {}] } }, output: [] },
    } as never);
    // `hello` is a plain value, not a button token — the extra trailing entry
    // must NOT promote it out of its own slot.
    expect(workflow["4"].inputs.text).toBe("hello");
  });

  it("preserves a known button spelling when the declared COMBO explicitly accepts it", () => {
    const { workflow } = convertUiToApi(
      ({
        nodes: [{ id: 1, type: "ComboCollision", mode: 0, inputs: [], outputs: [], widgets_values: ["browse", "other", "42"] }],
        links: [],
      }) as never,
      {
        ComboCollision: {
          input: {
            required: {
              mode: [["browse", "other"], {}],
              note: ["STRING", {}],
            },
          },
          output: [],
        },
      } as never,
    );
    expect(workflow["1"].inputs.mode).toBe("browse");
    expect(workflow["1"].inputs.note).toBe("other");
  });
});

// Independent review of the first cut broke it four ways. Every case below is a
// SILENT WRONG VALUE — the converter emitted a plausible graph carrying someone
// else's data — which is strictly worse than the misalignment being fixed. The
// common cause was matching the general SHAPE of an identifier and then trying
// to corroborate the skip positionally: that can tell something in the gap does
// not belong, but not WHICH, and it always dropped the first.
describe("convertUiToApi — extras-skipping must never eat a legitimate value (#1869 review)", () => {
  const oneNode = (type: string, widgets_values: unknown[]) =>
    ({
      nodes: [{ id: 1, type, mode: 0, inputs: [], outputs: [], widgets_values }],
      links: [],
    }) as never;

  it("keeps a snake_case STRING that merely LOOKS like a button token", () => {
    const { workflow } = convertUiToApi(
      oneNode("N", ["my_path", "label", "detect_range", 12]),
      {
        N: {
          input: {
            required: {
              path: ["STRING", {}],
              label: ["STRING", {}],
              first_frame: ["INT", {}],
            },
          },
          output: [],
        },
      } as never,
    );
    expect(workflow["1"].inputs.path).toBe("my_path");
    expect(workflow["1"].inputs.label).toBe("label");
    expect(workflow["1"].inputs.first_frame).toBe(12);
  });

  // #361: a stale asset value must be PRESERVED so it surfaces as a missing-asset
  // error. Skipping it replaced the checkpoint name with a button token, and the
  // resulting warning then named the WRONG value as the one the user declared.
  it("preserves a stale asset value instead of skipping it (#361)", () => {
    const { workflow } = convertUiToApi(
      oneNode("N", ["my_model", "detect_range", 12]),
      {
        N: {
          input: {
            required: {
              ckpt_name: [["a.safetensors"], {}],
              first_frame: ["INT", {}],
            },
          },
          output: [],
        },
      } as never,
    );
    expect(workflow["1"].inputs.ckpt_name).toBe("my_model");
    expect(workflow["1"].inputs.first_frame).toBe(12);
  });

  // ComfyUI coerces these itself, and frontends serialize both shapes. Treating
  // them as type mismatches DROPPED a real widget value.
  it("accepts a BOOLEAN serialized as 0/1", () => {
    const { workflow } = convertUiToApi(oneNode("N", [0, "browse"]), {
      N: { input: { required: { enabled: ["BOOLEAN", {}] } }, output: [] },
    } as never);
    expect(workflow["1"].inputs.enabled).toBe(0);
  });

  it("accepts an INT serialized as a numeric STRING", () => {
    const { workflow } = convertUiToApi(oneNode("N", ["1024", "browse"]), {
      N: { input: { required: { width: ["INT", {}] } }, output: [] },
    } as never);
    expect(workflow["1"].inputs.width).toBe("1024");
  });

  // The known-token list cannot cover every pack's buttons, so the type signal
  // has to carry the ones it has never seen. It is the ONLY thing that can
  // recover a button sitting mid-row on a numeric widget — a prefix rule cannot
  // see it, and the vocabulary does not know it.
  it("skips an UNKNOWN button token that lands on a numeric widget", () => {
    const { workflow } = convertUiToApi(
      oneNode("N", ["D:/x.mov", "recalculate_everything", 12]),
      {
        N: {
          input: { required: { file_path: ["STRING", {}], frames: ["INT", {}] } },
          output: [],
        },
      } as never,
    );
    expect(workflow["1"].inputs.file_path).toBe("D:/x.mov");
    expect(workflow["1"].inputs.frames).toBe(12);
  });

  // Three BOOLEANs in a row refusing three STRINGs is what realigns the TAIL of
  // a badly-shifted custom node (LTXDirector, above) even though its head is
  // unrecoverable. Pin it directly rather than leaning on that test.
  it("realigns a run of BOOLEANs that STRING values had shifted", () => {
    const { workflow } = convertUiToApi(
      oneNode("N", ["a", "b", "c", true, false, 7]),
      {
        N: {
          input: {
            required: {
              flag_a: ["BOOLEAN", {}],
              flag_b: ["BOOLEAN", {}],
              count: ["INT", {}],
            },
          },
          output: [],
        },
      } as never,
    );
    expect(workflow["1"].inputs.flag_a).toBe(true);
    expect(workflow["1"].inputs.flag_b).toBe(false);
    expect(workflow["1"].inputs.count).toBe(7);
  });
});

---
name: qwen-image-edit
description: Build Qwen Image Edit workflows covering model loading, conditioning, LoRAs, prompt patterns, and XY plot testing
globs:
  - "**/*.json"
---

# Qwen Image Edit Workflows

## Overview

Qwen Image Edit uses a vision-language model (Qwen2.5-VL) to edit images based on natural language instructions. The model "sees" the source image through CLIP conditioning and generates an edited version.

## Models

### Required Components

| Component | Node | Model Name | Notes |
|-----------|------|------------|-------|
| **UNET** | `UNETLoader` | `qwen_image_edit_2511_bf16.safetensors` | Official 2511 edit model (bf16) |
| **CLIP** | `CLIPLoader` (type=`qwen_image`) | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | Shared across all Qwen models |
| **VAE** | `VAELoader` | `qwen_image_vae.safetensors` | Qwen-specific VAE |

### Alternative UNET Models

| Model | Path | Focus |
|-------|------|-------|
| `qwenImageEditRemix_v10` | `qwenImageEditRemix_v10.safetensors` | Community remix, general editing |
| `qwenUltimateRealism_v11` | `Qwen/imageized/qwenUltimateRealism_v11.safetensors` | Product photography, hyper-realistic |
| `copaxTimeless` | `Qwen/realistic/copaxTimeless_qwenUltraRealistic.safetensors` | Ultra-realistic portraits |
| `qwnImageEdit_v16Bf16` | `Qwen/abliterated/qwnImageEdit_v16Bf16.safetensors` | Abliterated (uncensored) |

## Conditioning Nodes

### TextEncodeQwenImageEditPlusAdvance_lrzjason (Recommended)

From the `qweneditutils` custom node pack. The **Advanced** variant is preferred because it:
- Outputs a **LATENT directly** (no need for separate EmptyLatentImage)
- Has separate **VL-resize** and **non-resize** image slots for fine control
- Supports **target_size** control for output resolution
- Includes a **pad/center/disabled crop** method with pad_info output

```
Required Inputs:
  - clip: CLIP
  - prompt: STRING — natural language edit instruction

Optional Inputs:
  - vae: VAE — needed for image encoding and latent output
  - vl_resize_image1-3: IMAGE — images that get VL-resized (downscaled for vision encoder)
  - not_resize_image1-3: IMAGE — images kept at full resolution
  - target_size: [1024, 1344, 1536, 2048, 768, 512] (default 1024)
  - target_vl_size: [392, 384] (default 384)
  - upscale_method: [lanczos, bicubic, area]
  - crop_method: [pad, center, disabled]
  - instruction: STRING — system instruction template (has sensible default)

Outputs (10):
  [0] conditioning_with_full_ref: CONDITIONING — use as positive conditioning
  [1] latent: LATENT — auto-scaled latent, feed directly to KSampler
  [2] target_image1: IMAGE — processed target-size image
  [3] target_image2: IMAGE
  [4] target_image3: IMAGE
  [5] vl_resized_image1: IMAGE — VL-resized version
  [6] vl_resized_image2: IMAGE
  [7] vl_resized_image3: IMAGE
  [8] conditioning_with_first_ref: CONDITIONING — conditioning with only first ref
  [9] pad_info: ANY — padding info for later unpadding
```

**Key advantage**: Output [1] (latent) eliminates the need for a separate `EmptyLatentImage` or `VAEEncode` node. The Advanced node handles latent creation internally at the correct resolution.

### Other Conditioning Variants

- **TextEncodeQwenImageEditPlus** (Phr00t v2, built-in) is simpler: 4 image inputs, outputs only CONDITIONING. Requires separate EmptyLatentImage. Good for quick edits.
- **TextEncodeQwenImageEditPlus_lrzjason**: 5 image inputs, resize toggles, but less control than Advance
- **TextEncodeQwenImageEditPlusPro_lrzjason**: Per-image VL resize selection via `vl_resize_indexs` string, `main_image_index` control

## Lightning LoRAs (Fast Generation)

### 4-Step Lightning (2511 Edit)

```json
{
  "class_type": "LoraLoaderModelOnly",
  "inputs": {
    "model": ["<unet_node>", 0],
    "lora_name": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
    "strength_model": 1.0
  }
}
```

**Settings**: steps=4, cfg=1.0, sampler=euler, scheduler=simple, denoise=1.0

### 4-Step Lightning (General Qwen)

For non-edit models (txt2img, 2512):
- `Qwen-Image-Lightning-4steps-V1.0.safetensors` (strength 1.0)

### 8-Step Lightning

- `Qwen-Image-Lightning-8steps-V1.0.safetensors`, higher detail than 4-step

## Sampler Settings

| Preset | Steps | CFG | Sampler | Scheduler | Denoise | LoRA |
|--------|-------|-----|---------|-----------|---------|------|
| Lightning 4-step (2511 edit) | 4 | 1.0 | euler | simple | 1.0 | 2511-Lightning-4steps |
| Lightning 8-step | 8 | 1.0 | euler | simple | 1.0 | Lightning-8steps |
| Standard edit | 40 | 4.0 | euler | simple | 0.75 | none |
| Quality edit | 50 | 4.0 | euler | simple | 0.5-0.8 | none |

> **The sub-1.0 denoise rows REQUIRE a `VAEEncode` latent.** A denoise low enough to
> shorten the sampling schedule — which 0.5-0.8 certainly is — keeps part of the
> incoming latent, so that latent has to BE the source image. Wire `latent_image` from
> a `VAEEncode` of the source (or from a node that emits a source-derived latent, like
> `TextEncodeQwenImageEditPlusAdvance_lrzjason` output [1]). Pairing these rows with an
> `EmptyLatentImage` runs clean and returns a flat, near-uniform field — an empty latent
> has no source content to preserve. Feeding the reference through
> `TextEncodeQwenImageEditPlus` does **not** rescue it: that image rides on CONDITIONING,
> which steers denoising but never seeds the sampler's starting state.

**Denoise for editing**: Lower denoise = closer to source — *provided the latent IS the source*. 0.5-0.8 range for standard editing on a `VAEEncode` latent. Lightning uses 1.0 (model handles fidelity internally).

## Resolutions

> **This table is for Qwen-Image TEXT-TO-IMAGE. Do not pick an edit graph's output
> size from it.** An edit graph's geometry is decided by the SOURCE image, not by you
> — see "Resolution on an edit graph" below. Choosing 1104x1472 here for an edit was
> #2681.

Qwen-Image operates at ~1.6 megapixels natively:

| Aspect | Resolution | Use Case |
|--------|-----------|----------|
| Square | 1328x1328 | General |
| Portrait 3:4 | 1104x1472 | Portraits |
| Portrait 9:16 | 928x1664 | Phone format |
| Landscape 4:3 | 1472x1104 | Landscape scenes |
| Landscape 16:9 | 1664x928 | Widescreen |
| Video-ready | 832x480 | For WAN 2.2 FLF pipeline |

**For video pipelines**: Use 832x480 to match WAN 2.2's default resolution.

### Resolution on an edit graph

`TextEncodeQwenImageEdit` and `TextEncodeQwenImageEditPlus` do not take a size. They
scale every reference image to a hard-coded `int(1024 * 1024)` px — **~1.05 MP, at the
source's own aspect ratio** — VAE-encode it, and hand it to the model as a reference
latent (`comfy_extras/nodes_qwen.py`).

The model then lays the reference tokens and the tokens it is generating on **one
shared, centred coordinate grid** (`comfy/ldm/qwen_image/model.py`, `process_img`), so
reference position (i, j) and output position (i, j) mean the same place only when the
two grids are the same size. That is the whole reason the official templates run the
one image through `FluxKontextImageScale` and then feed the sampler a `VAEEncode` of
*that* scaled image: canvas geometry and reference geometry come out identical by
construction. Every `PREFERRED_KONTEXT_RESOLUTIONS` entry is ~1.05 MP for the same
reason.

So on an edit graph you do not choose a resolution — you inherit one:

- **Right:** `LoadImage` -> `FluxKontextImageScale` -> (`TextEncodeQwenImageEditPlus`
  *and* `VAEEncode`) -> KSampler `latent_image`.
- **Wrong:** an `EmptyLatentImage` at a size from the table above. Its dimensions are
  literals; the reference's are computed from the source when the graph runs. At
  1104x1472 (1.63 MP) against a 1.05 MP reference the grids are 1.24x apart linearly,
  the model cannot copy detail across them, and it re-synthesises the subject instead —
  materials come back looking plastic/CGI and printed detail comes back as a generic
  shape (#2681). Nothing errors; the image just is not the edit you asked for.

`create_workflow (action:"validate")` now flags this pairing as
`edit_reference_empty_latent`.

## Prompt Patterns

### Edit Instructions (Natural Language)

```
"Change the black cat into a cute girl with a black bodysuit and jeans"
"Make the sky a dramatic sunset with orange and purple clouds"
"Add a red sports car parked in front of the house"
"Remove the person on the left and fill with the background"
```

### Multi-Angle LoRA (qwen-image-edit-2511-multiple-angles-lora)

Uses `<sks>` token with structured angle/distance prompts:

```
<sks> front view eye-level shot close-up
<sks> front-right quarter view low-angle shot medium shot
<sks> back view elevated shot wide shot
```

**Template**: `<sks> {direction} view {angle} shot {distance}`

Directions: front, front-right quarter, right side, back-right quarter, back, back-left quarter, left side, front-left quarter
Angles: low-angle, eye-level, elevated, high-angle
Distances: close-up, medium shot, wide shot

## Negative Conditioning

Always use `ConditioningZeroOut` for negative conditioning with Qwen edit:

```json
{
  "class_type": "ConditioningZeroOut",
  "inputs": { "conditioning": ["<positive_cond_node>", 0] }
}
```

## Complete Workflow: Lightning Edit (Advanced Node)

Uses `TextEncodeQwenImageEditPlusAdvance_lrzjason`, which outputs the latent directly, so no EmptyLatentImage is needed.

```json
{
  "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "qwen_image_edit_2511_bf16.safetensors", "weight_dtype": "default" }},
  "2": { "class_type": "LoraLoaderModelOnly", "inputs": { "model": ["1", 0], "lora_name": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", "strength_model": 1 }},
  "3": { "class_type": "CLIPLoader", "inputs": { "clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image" }},
  "4": { "class_type": "VAELoader", "inputs": { "vae_name": "qwen_image_vae.safetensors" }},
  "5": { "class_type": "LoadImage", "inputs": { "image": "<source_image.png>" }},
  "6": { "class_type": "TextEncodeQwenImageEditPlusAdvance_lrzjason", "inputs": {
    "clip": ["3", 0], "prompt": "<edit instruction>", "vae": ["4", 0],
    "vl_resize_image1": ["5", 0],
    "target_size": 1024, "target_vl_size": 384,
    "upscale_method": "lanczos", "crop_method": "pad"
  }},
  "7": { "class_type": "ConditioningZeroOut", "inputs": { "conditioning": ["6", 0] }},
  "8": { "class_type": "KSampler", "inputs": {
    "model": ["2", 0],
    "positive": ["6", 0],
    "negative": ["7", 0],
    "latent_image": ["6", 1],
    "seed": 42, "steps": 4, "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 1
  }},
  "9": { "class_type": "VAEDecode", "inputs": { "samples": ["8", 0], "vae": ["4", 0] }},
  "10": { "class_type": "SaveImage", "inputs": { "images": ["9", 0], "filename_prefix": "qwen_edit" }}
}
```

**Key connections**:
- `"latent_image": ["6", 1]`: KSampler gets its latent directly from the Advanced node's output [1]
- `"positive": ["6", 0]`: conditioning_with_full_ref from output [0]
- `"vl_resize_image1": ["5", 0]`: source image goes into VL-resize slot (downscaled for vision encoder)

### Simpler Alternative (Phr00t v2)

If `qweneditutils` custom node is unavailable, use the built-in `TextEncodeQwenImageEditPlus` with a separate `EmptyLatentImage`:

```json
{
  "6": { "class_type": "TextEncodeQwenImageEditPlus", "inputs": {
    "clip": ["3", 0], "prompt": "<edit instruction>", "vae": ["4", 0], "image1": ["5", 0]
  }},
  "8": { "class_type": "EmptyLatentImage", "inputs": { "width": 1024, "height": 1024, "batch_size": 1 }}
}
```

Replace node 6 and add node 8. KSampler latent_image connects to `["8", 0]` instead of `["6", 1]`.

**Do not leave that `EmptyLatentImage` wired to the sampler.** It is shown above only
because it is what the Plus encoder's own signature leaves you needing, and it fails in a
different way on each side of denoise 1.0:

- Below 1.0 it renders a flat, near-uniform field, always. The encoder emits CONDITIONING
  only, so the latent is genuinely empty, and a truncated sigma schedule exists to
  preserve an incoming latent that here has nothing in it (#2678).
- At 1.0 it renders a plausible image that is not your source — *unless* its width and
  height happen to equal the geometry the encoder derived, which is ~1.05 MP at the
  source's aspect ratio. A 1024x1024 empty latent over an exactly-square source does line
  up, and is fine. 1104x1472 over that same source does not: the model aligns reference
  and output on one shared grid, cannot copy across grids that far apart, and
  re-synthesises instead (#2681). See "Resolution on an edit graph".

The second case is the trap, because it depends on a source you may not have looked at
and it fails silently. A `VAEEncode` removes the coincidence — it cannot be the wrong
size, because it is derived from the same pixels the encoder saw.

Feed `latent_image` from a `VAEEncode` of the same image you gave the encoder, scaled
once up front so both see identical geometry:

```json
{
  "5b": { "class_type": "FluxKontextImageScale", "inputs": { "image": ["5", 0] }},
  "6":  { "class_type": "TextEncodeQwenImageEditPlus", "inputs": {
    "clip": ["3", 0], "prompt": "<edit instruction>", "vae": ["4", 0], "image1": ["5b", 0]
  }},
  "8":  { "class_type": "VAEEncode", "inputs": { "pixels": ["5b", 0], "vae": ["4", 0] }}
}
```

KSampler `latent_image` connects to `["8", 0]`. Any denoise is then meaningful: 1.0 for
a full edit, sub-1.0 to stay closer to the source.

### Basic Variant (Official ComfyUI Example)

The official "Qwen 2511 Edit Simple" example uses newer built-in nodes for model patching and image scaling:

**Additional nodes in the official pipeline:**

- **`ModelSamplingAuraFlow`** (shift=3.1): Flow matching shift applied to the UNET. Used instead of `ModelSamplingSD3`.
- **`CFGNorm`** (strength=1): Normalizes CFG guidance for more stable generation. Applied after `ModelSamplingAuraFlow`.
- **`FluxKontextImageScale`**: Auto-scales input images to the correct resolution for Qwen. No manual size parameters needed.
- **`FluxKontextMultiReferenceLatentMethod`** (method=`index_timestep_zero`): Applied to both positive and negative conditioning. Handles multi-reference latent indexing.
- **`VAEEncode`**: Encodes the scaled image to latent (instead of `EmptyLatentImage`).

**Official pipeline flow:**
```
UNETLoader → [LoraLoaderModelOnly] → ModelSamplingAuraFlow (shift=3.1) → CFGNorm (strength=1) → MODEL
CLIPLoader (qwen_image) → CLIP
VAELoader → VAE

LoadImage → FluxKontextImageScale → scaled_image
  ├─ TextEncodeQwenImageEditPlus (positive) → FluxKontextMultiReferenceLatentMethod → positive CONDITIONING
  ├─ TextEncodeQwenImageEditPlus (negative, empty) → FluxKontextMultiReferenceLatentMethod → negative CONDITIONING
  └─ VAEEncode → LATENT

KSampler → VAEDecode → SaveImage
```

**Official sampler settings:**

| Variant | Steps | CFG | Sampler | Scheduler | Denoise | LoRA |
|---------|-------|-----|---------|-----------|---------|------|
| Standard | 40 | 4.0 | euler | simple | 1.0 | none |
| Lightning | 4 | 1.0 | euler | simple | 1.0 | 2511-Lightning-4steps |

**Note**: The `FluxKontextMultiReferenceLatentMethod` and `FluxKontextImageScale` nodes may not be needed when using Comfy's official model files directly, but may be required with community-repackaged models.

## XY Plot Technique (from Widgets.json)

For batch-testing multiple edit variations, use the Easy Nodes XY Plot system:

1. **Text Multiline** nodes define parameter lists (e.g., directions, angles)
2. **Split String** breaks them into indexed options
3. **easy textIndexSwitch** selects one at a time
4. **easy promptReplace** substitutes `{X}`, `{Y}`, `{Z}` placeholders in the base prompt
5. **easy XYPlotAdvanced** + **easy XYInputs: PromptSR** drives the sweep
6. **easy pipeIn** bundles model/clip/vae/latent into a pipeline

This produces a grid image showing all combinations, useful for finding the best angle/distance/style for a given subject.

## VRAM Considerations

- Qwen 2511 edit bf16: ~10GB VRAM
- CLIP (fp8): ~7GB VRAM
- VAE: ~200MB
- Total: ~17-18GB, fits comfortably on 24GB GPUs
- **Always `clear_vram` before loading** if switching from another model family

## Tips

1. **Upload source images first** with `upload_image (action:"image")` before building the workflow
2. **Match output resolution** to the next pipeline step (e.g., 832x480 for WAN FLF) — but only on a *generation* graph. On an edit graph the size is the source's; resize the RESULT afterwards instead of sampling at the size you want
3. **Lightning LoRA + denoise 1.0** works well. The model handles structure preservation through conditioning
4. **Take an edit graph's `latent_image` from a `VAEEncode` of the source, not from an `EmptyLatentImage`** — at sub-1.0 denoise the empty latent decodes to a flat, near-uniform field (#2678), and at denoise 1.0 it is right only if its literal size happens to equal the geometry the encoder derived from the source, which is exactly the coincidence a `VAEEncode` removes (#2681). Neither failure errors. `create_workflow (action:"validate")` flags both pairings (`partial_denoise_empty_latent`, `edit_reference_empty_latent`)
5. The **lrzjason Pro variant** is best for multi-image compositions where you need fine control over which images get VL-resized
6. **Use `get_workflow (action:"analyze")`** to understand any saved Qwen edit workflow before modifying or executing it. It returns a structured summary, not raw JSON. Only use `get_workflow` when you need the actual JSON for `enqueue_workflow` or `create_workflow (action:"modify")`.

## Sources

- **Official:** none found.
- **Empirical:** sampler values, wiring, and prompt notes from working graphs in `packs/` and observed renders; not a vendor prompting guide.

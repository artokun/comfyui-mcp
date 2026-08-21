---
name: ideogram-ultra
description: Build Ideogram 4 (Ideogram Ultra) txt2img and img2img workflows with the local open-weights model, dual conditional/unconditional models with DualModelGuider, Qwen3-VL text encoder, and structured JSON ("compositional deconstruction") prompts for strong text rendering and layout control
globs:
  - "**/*.json"
---

# Ideogram 4 (Ideogram Ultra) Workflows

## Overview

**This is a LOCAL open-weights pipeline, NOT the hosted Ideogram API.** There is no API key, no `IdeogramGenerate` API node, and no network call at generation time. Comfy-Org released the Ideogram 4 weights on Hugging Face and they run entirely on your GPU via standard `UNETLoader` / `CLIPLoader` / `VAELoader` nodes. (Note: ComfyUI *also* ships separate API/"partner" nodes that call the paid hosted Ideogram service. That is a different thing and is not what this workflow uses.)

Ideogram 4 is best known for **text rendering / typography**, **poster and graphic-design layouts**, and **prompt adherence**. The hallmark of this workflow is a **structured JSON prompt** (a "compositional deconstruction" caption with bounding boxes) instead of a plain text prompt. This is what gives precise control over where text and objects land in the frame.

Source workflow this skill is derived from: `IDEOGRAM_ULTRA_WORKFLOW-V2.json` (UI format, 66 nodes, 4 subgraphs), by Aitrepreneur. It provides both a **TEXT TO IMAGE** path and an **IMAGE TO IMAGE** path.

### Two unusual things to know up front

1. **Dual models.** Two UNETs are loaded: a conditional model (`ideogram4_fp8_scaled`) and an `..._unconditional_fp8_scaled` model. A `DualModelGuider` node uses both to perform asymmetric classifier-free guidance; the unconditional model provides the CFG baseline. There is **no negative text prompt**; negative conditioning is `ConditioningZeroOut`.
2. **Two text models, different jobs.**
   - `qwen3vl_8b_fp8_scaled` is the **actual diffusion text encoder** (loaded with `CLIPLoader`, type `ideogram4`).
   - `gemma4_e4b_it_fp8_scaled` is used **only inside an optional prompt-builder subgraph** (a `TextGenerate` node) that auto-writes the structured JSON from a plain idea. It is not the diffusion encoder.

## Installation

### Custom nodes

The workflow needs these four custom node packs (clone into `ComfyUI/custom_nodes/`). Exact repos from the installer scripts:

```bash
git clone https://github.com/ltdrdata/ComfyUI-Manager.git
git clone https://github.com/rgthree/rgthree-comfy
git clone https://github.com/kijai/ComfyUI-KJNodes
git clone https://github.com/cubiq/ComfyUI_essentials
```

- **ComfyUI-KJNodes** (kijai) provides `Ideogram4PromptBuilderKJ`, `ImageSharpenKJ`, `TextGenerate`, and the Ideogram 4 helper nodes. **Required.**
- **rgthree-comfy** provides `Power Lora Loader`, `Fast Groups Muter/Bypasser`, `Label`, `Any Switch`. (Used for UI/convenience; the core pipeline still works without them.)
- **ComfyUI_essentials** (cubiq) provides `ImageResize+` (used in the img2img path).
- **ComfyUI-Manager** handles node/model management; not required at run time.

> The core nodes used in the simplified workflows below (`UNETLoader`, `CLIPLoader`, `VAELoader`, `DualModelGuider`, `SamplerCustomAdvanced`, `ModelSamplingAuraFlow`, `BasicScheduler`, `EmptyFlux2LatentImage`, `CLIPTextEncode`, `ConditioningZeroOut`, `VAEDecode`) are **built into ComfyUI** (recent versions). Only `Ideogram4PromptBuilderKJ` / `ImageSharpenKJ` require KJNodes.

### Models

Five files. Folder layout and download URLs are taken verbatim from `IDEOGRAM_ULTRA-MODELS-NODES_INSTALL.bat` / `...RUNPOD.sh`:

| File | Folder | Source URL |
|------|--------|------------|
| `ideogram4_fp8_scaled.safetensors` | `models/diffusion_models/` | `https://huggingface.co/Comfy-Org/Ideogram-4/resolve/main/diffusion_models/ideogram4_fp8_scaled.safetensors` |
| `ideogram4_unconditional_fp8_scaled.safetensors` | `models/diffusion_models/` | `https://huggingface.co/Comfy-Org/Ideogram-4/resolve/main/diffusion_models/ideogram4_unconditional_fp8_scaled.safetensors` |
| `qwen3vl_8b_fp8_scaled.safetensors` | `models/text_encoders/` | `https://huggingface.co/Aitrepreneur/FLX/resolve/main/qwen3vl_8b_fp8_scaled.safetensors` |
| `gemma4_e4b_it_fp8_scaled.safetensors` | `models/text_encoders/` | `https://huggingface.co/Aitrepreneur/FLX/resolve/main/gemma4_e4b_it_fp8_scaled.safetensors` |
| `flux2-vae.safetensors` | `models/vae/` | `https://huggingface.co/Aitrepreneur/FLX/resolve/main/flux2-vae.safetensors` |

Notes / things to verify:
- The two **diffusion models** come from the official `Comfy-Org/Ideogram-4` HF repo. The **text encoders + VAE** are mirrored from the third-party `Aitrepreneur/FLX` repo in these scripts; the official ones also live on Comfy-Org / Comfy-Org-adjacent repos. Both should be identical files but the FLX mirror is what the provided installer pulls.
- **File sizes are uncertain.** The official ComfyUI docs page lists each diffusion model at ~13.8 GB, qwen3vl at ~8 GB, gemma4 at ~2 GB, vae at ~335 MB (~38.9 GB total). A web search result claimed `ideogram4_fp8_scaled` is ~9.28 GB. Treat sizes as approximate and confirm against the HF file listing.
- `flux2-vae.safetensors` is the same VAE used by Flux 2 / Klein workflows.

### Linux / RunPod note

`IDEOGRAM_ULTRA-AUTO_INSTALL-RUNPOD.sh` creates a venv and installs Torch `2.4.0` + `cu121` by default (override via env vars `CUDA_TAG`, `TORCH_VERSION`, etc.). Same five model files, same four node repos.

### JSON template pack (optional)

`IDEOGRAM-TEMPLATES.zip` contains 25 ready-made structured-JSON templates for the `Ideogram4PromptBuilderKJ` node (film poster, book cover, logo board, character sheet, magazine cover, etc.). Per its README, copy the `.json` files into:

```
ComfyUI/user/default/kjnodes/ideogram4/templates
```

then pick them from the template dropdown inside the prompt-builder node.

## Key Nodes

### CLIPLoader (text encoder)

Ideogram 4 uses **Qwen3-VL** as its diffusion text encoder. Load it with `CLIPLoader` and **type `ideogram4`**:

```json
{
  "class_type": "CLIPLoader",
  "inputs": {
    "clip_name": "qwen3vl_8b_fp8_scaled.safetensors",
    "type": "ideogram4",
    "device": "default"
  }
}
```

### UNETLoader x2 (conditional + unconditional)

```json
{ "class_type": "UNETLoader", "inputs": { "unet_name": "ideogram4_fp8_scaled.safetensors", "weight_dtype": "default" }},
{ "class_type": "UNETLoader", "inputs": { "unet_name": "ideogram4_unconditional_fp8_scaled.safetensors", "weight_dtype": "default" }}
```

### ModelSamplingAuraFlow (shift)

Applied to **both** models. In the source workflow `shift = 5`:

```json
{ "class_type": "ModelSamplingAuraFlow", "inputs": { "model": ["<unet>", 0], "shift": 5 }}
```

### DualModelGuider

The heart of the pipeline. Takes the (shifted) conditional model, the (shifted) unconditional model, positive conditioning, and negative conditioning, plus a CFG value (`5` in the source). This replaces the usual `CFGGuider`.

```json
{
  "class_type": "DualModelGuider",
  "inputs": {
    "model": ["<conditional_model_sampling>", 0],
    "model_negative": ["<unconditional_model_sampling>", 0],
    "positive": ["<clip_text_encode>", 0],
    "negative": ["<conditioning_zero_out>", 0],
    "cfg": 5
  }
}
```

> Input names for `DualModelGuider` (`model_negative`, `cfg`) are inferred from the subgraph wiring and KJNodes; verify against your installed KJNodes version, since the exact widget/socket names may differ.

### EmptyFlux2LatentImage

Ideogram 4 uses the Flux 2 latent format, so the empty latent is `EmptyFlux2LatentImage` (not `EmptyLatentImage`):

```json
{ "class_type": "EmptyFlux2LatentImage", "inputs": { "width": 1024, "height": 1024, "batch_size": 1 }}
```

### BasicScheduler + KSamplerSelect + RandomNoise + SamplerCustomAdvanced

Generation uses the modular sampler stack, not `KSampler`:

```json
{ "class_type": "BasicScheduler", "inputs": { "model": ["<conditional_model_sampling>", 0], "scheduler": "simple", "steps": 28, "denoise": 1 }},
{ "class_type": "KSamplerSelect", "inputs": { "sampler_name": "euler" }},
{ "class_type": "RandomNoise", "inputs": { "noise_seed": 42 }},
{ "class_type": "SamplerCustomAdvanced", "inputs": {
  "noise": ["<random_noise>", 0],
  "guider": ["<dual_model_guider>", 0],
  "sampler": ["<ksampler_select>", 0],
  "sigmas": ["<basic_scheduler>", 0],
  "latent_image": ["<empty_latent>", 0]
}}
```

### Ideogram4PromptBuilderKJ (the JSON prompt builder)

A KJNodes node that outputs the structured caption JSON string (see "Prompt Style" below). On the canvas you draw bounding boxes for objects/text, set descriptions, a color palette, and background/style. Its string output feeds `CLIPTextEncode`. Source widget values include `width 1920`, `height 1080`, a high-level prompt, a background description, a `color_palette` array, and an `elements` array.

#### ⚠️ Editing this node programmatically (panel_set_widget WILL NOT STICK)

**This is the single most important thing to know about this node.** Its `elements_data` / `style_palette_data` widgets are **NOT the source of truth**. They are serialized *from* a live in-browser array (`node._boxes`) inside the KJNodes editor JS. Two mechanisms defeat any external widget edit:

- **Queue-time re-serialization.** In `web/js/ideogram4_prompt_builder.js`, `elementsWidget.serializeValue()` regenerates the value from `node._boxes` *every time the graph is queued*. So `panel_set_widget(14, "elements_data", ...)` sets the value, but ComfyUI overwrites it with the stale editor boxes the instant you run. **The edit silently reverts on every run.**
- **You can't reach `node._boxes`.** It lives in the browser tab; no panel/MCP tool can touch it. Editing `elements_data`, `ideo_editor`, or forcing `import_mode` alone does nothing durable. `node._boxes` is only ever re-seeded from `elements_data` on workflow *load* (`onConfigure`), and even then the saved `o.ideo.boxes` blob wins over the widget, so a stale saved workflow reloads stale.

**The symptom:** you edit the JSON, the panel confirms the new value, but the render (and the visible builder JSON) still shows the OLD prompt, e.g. old subject/region text that "won't go away."

**The correct, node-designed fix is to drive it via `import_json`:**
1. Add a `PrimitiveStringMultiline` node containing the FULL caption JSON (the `high_level_description` + `style_description` + `compositional_deconstruction` shape from "Prompt Style" below).
2. Wire it into node 14's **`import_json`** input.
3. Set **`import_mode = "always"`**.

The Python `execute()` then does `used_import = imported is not None and (import_mode == "always" or not boxes)` → the caption is built **entirely** from `import_json`; the poisoned `elements_data`/`node._boxes` are ignored. Bonus: running once in this mode pushes the caption back into the editor via `ui`, which re-seeds `node._boxes` and flushes the stale boxes for good. From then on, edit the prompt in the wired string node, **not** the builder's visual editor. (`import_mode = "when empty"` only seeds the editor when it has no regions, then the editor wins again, so for programmatic control it MUST be `"always"`.)

### ImageSharpenKJ (post-process)

The source applies a light RCAS sharpen after decode: `sharpen_mode = rcas`, `strength = 0.55`.

## Parameters / Settings

Values below are exactly what the source `IDEOGRAM_ULTRA_WORKFLOW-V2.json` ships with.

| Parameter | Value | Where |
|-----------|-------|-------|
| sampler | `euler` | `KSamplerSelect` |
| scheduler | `simple` | `BasicScheduler` |
| steps | **28** (default) | `BasicScheduler` / `INTConstant STEPS` |
| steps (turbo) | **12** | per workflow Note: "TURBO: 12 STEPS — quick image, lower quality" |
| cfg | **5** | `DualModelGuider` |
| shift | **5** | `ModelSamplingAuraFlow` (both models) |
| denoise (txt2img) | 1.0 | `BasicScheduler` |
| denoise (img2img) | **0.6** | `PrimitiveFloat DENOISE` |
| sharpen | rcas, 0.55 | `ImageSharpenKJ` |
| noise control | `RandomNoise`, fixed seed | seed sample value `1335735769456` |

There is also a `CFGOverride` node in the sampler subgraph (widgets `3, 0.7, 1`); it is an optional override and is not the primary guidance path. The primary CFG is `DualModelGuider`'s `5`.

## Resolutions / Aspect Ratios

The source default is **1920x1080** (set via `INTConstant WIDTH/HEIGHT`, fed into the prompt builder and latent). The bundled template README recommends:

| Use case | Resolution | Aspect |
|----------|-----------|--------|
| Vertical posters / covers | 1440x2560 | 9:16 |
| Wide landscape | 2560x1440 | 16:9 |
| Square asset sheets | 2048x2048 | 1:1 |
| Ultrawide / special layouts | 2880x1440 or 2048x1024 | 2:1-ish |
| Source default | 1920x1080 | 16:9 |

If a layout looks cramped, increase resolution while keeping the aspect ratio. Use the same width/height in the prompt-builder JSON, the latent, and (img2img) the resize node.

## Prompt Style — Structured JSON ("compositional deconstruction")

Ideogram 4 in this workflow expects a **JSON caption**, not free text. Minimum required shape:

```json
{
  "high_level_description": "one-sentence summary of the whole image",
  "compositional_deconstruction": {
    "background": "scene, environment, color palette, lighting, overall mood",
    "elements": [
      {
        "type": "obj",
        "bbox": [top, left, bottom, right],
        "desc": "what this object is and how it's rendered"
      },
      {
        "type": "text",
        "bbox": [top, left, bottom, right],
        "text": "ACTUAL TEXT TO RENDER",
        "desc": "font style, color, alignment, vintage/print treatment, etc."
      }
    ]
  }
}
```

An optional `style_description` object (`aesthetics`, `lighting`, `medium`, `art_style`, `color_palette`) can sit at the top level for global style locking.

### bbox rules (critical)

- Format is **`[top, left, bottom, right]`**, values **0 to 1000** (NOT pixels, NOT x/y/w/h).
- **One bbox per major subject.** Do not split a person into face/hair/clothes boxes; put all detail in one `desc`.
- Use extra boxes only for separate items (a product, a title, a second character).
- For character groups in wide images, use **vertical columns** of non-overlapping boxes.
- For posters: reserve a top zone for the title, middle for the subject, bottom for subtitle/CTA.
- Overlapping text boxes cause garbled text. Increase spacing or remove boxes.

### Text rendering tips

- Keep rendered text **short and bold** ("ORDER NOW", "COMING THIS FALL"). Long/tiny text still fails sometimes.
- Lock style explicitly when needed, e.g. `"rendered as an actual live-action photograph, not anime, not illustration"` or `"high-quality Japanese anime, cel shading, not photographic"`.
- 3 to 6 strong elements beat 20 overlapping ones.

### Generating the JSON automatically

Two options the source provides:

1. **Local (Gemma4 subgraph):** the "JSON Prompt Builder (Gemma4)" subgraph runs a `TextGenerate` node on `gemma4_e4b_it_fp8_scaled` with a system prompt that converts a plain idea into the JSON. (TextGenerate widgets in source: max_tokens 2048, temperature 0.7, top_k 64, top_p 0.95, etc.)
2. **External LLM:** a workflow Note ships a full system prompt ("You are an expert Ideogram 4 structured JSON prompt assistant…") to paste into ChatGPT/Claude to produce the caption JSON, which you then paste into the manual prompt field.

Either way, the resulting JSON must be valid (double quotes, no trailing commas, exact key `compositional_deconstruction`) or the builder reports "NOT A VALID IDEOGRAM 4 CAPTION JSON".

## Complete Workflow: Text to Image (API format, simplified)

This is the core txt2img path derived from the source, written in API format. Put your structured JSON caption into node `5`'s `text`.

```json
{
  "1":  { "class_type": "UNETLoader", "inputs": { "unet_name": "ideogram4_fp8_scaled.safetensors", "weight_dtype": "default" }},
  "2":  { "class_type": "UNETLoader", "inputs": { "unet_name": "ideogram4_unconditional_fp8_scaled.safetensors", "weight_dtype": "default" }},
  "3":  { "class_type": "CLIPLoader", "inputs": { "clip_name": "qwen3vl_8b_fp8_scaled.safetensors", "type": "ideogram4", "device": "default" }},
  "4":  { "class_type": "VAELoader", "inputs": { "vae_name": "flux2-vae.safetensors" }},

  "5":  { "class_type": "CLIPTextEncode", "inputs": { "clip": ["3", 0], "text": "<STRUCTURED JSON CAPTION HERE>" }},
  "6":  { "class_type": "ConditioningZeroOut", "inputs": { "conditioning": ["5", 0] }},

  "7":  { "class_type": "ModelSamplingAuraFlow", "inputs": { "model": ["1", 0], "shift": 5 }},
  "8":  { "class_type": "ModelSamplingAuraFlow", "inputs": { "model": ["2", 0], "shift": 5 }},

  "9":  { "class_type": "DualModelGuider", "inputs": {
            "model": ["7", 0],
            "model_negative": ["8", 0],
            "positive": ["5", 0],
            "negative": ["6", 0],
            "cfg": 5
          }},

  "10": { "class_type": "EmptyFlux2LatentImage", "inputs": { "width": 1920, "height": 1080, "batch_size": 1 }},
  "11": { "class_type": "BasicScheduler", "inputs": { "model": ["7", 0], "scheduler": "simple", "steps": 28, "denoise": 1 }},
  "12": { "class_type": "KSamplerSelect", "inputs": { "sampler_name": "euler" }},
  "13": { "class_type": "RandomNoise", "inputs": { "noise_seed": 42 }},

  "14": { "class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["13", 0],
            "guider": ["9", 0],
            "sampler": ["12", 0],
            "sigmas": ["11", 0],
            "latent_image": ["10", 0]
          }},

  "15": { "class_type": "VAEDecode", "inputs": { "samples": ["14", 0], "vae": ["4", 0] }},
  "16": { "class_type": "ImageSharpenKJ", "inputs": { "image": ["15", 0], "sharpen_mode": "rcas", "strength": 0.55 }},
  "17": { "class_type": "SaveImage", "inputs": { "images": ["16", 0], "filename_prefix": "IDEOGRAM" }}
}
```

If you don't have KJNodes / want to skip sharpening, drop node `16` and feed `["15", 0]` straight into `SaveImage`.

## Image to Image (notes)

The source img2img path adds, before sampling:

1. `LoadImage` → `ImageResize+` (ComfyUI_essentials; `keep proportion`, lanczos, e.g. target 1024) → `VAEEncode` (with `flux2-vae`) to produce the input latent.
2. Feed that latent into `SamplerCustomAdvanced.latent_image` instead of `EmptyFlux2LatentImage`.
3. Set **denoise `0.6`** on `BasicScheduler` (this is the `PrimitiveFloat DENOISE` value in the source). Lower denoise = closer to the input image.

Everything else (dual models, DualModelGuider, scheduler, sampler, decode, sharpen) is identical to txt2img.

> The exact `VAEEncode` wiring for img2img is inferred (the source routes it through an rgthree `Any Switch` and subgraph I/O); confirm sockets in your build.

## Pipeline at a Glance

```
UNETLoader (ideogram4_fp8_scaled) ─────► ModelSamplingAuraFlow(shift=5) ─┐
UNETLoader (ideogram4_unconditional) ──► ModelSamplingAuraFlow(shift=5) ─┤
                                                                          ├─► DualModelGuider(cfg=5)
CLIPLoader (qwen3vl_8b, type=ideogram4) ─► CLIPTextEncode(JSON) ──────────┤        │
                                              └► ConditioningZeroOut ──────┘        │
EmptyFlux2LatentImage (1920x1080) ─────────────────────────────────────────────────┤
BasicScheduler (simple, 28, denoise=1) ─────────────────────────────────────────────┤
KSamplerSelect (euler) ─────────────────────────────────────────────────────────────┤
RandomNoise (fixed seed) ───────────────────────────────────────────────────────────┘
                                              └► SamplerCustomAdvanced ─► VAEDecode (flux2-vae)
                                                                          └► ImageSharpenKJ (rcas 0.55) ─► SaveImage

Optional upstream: Ideogram4PromptBuilderKJ  OR  TextGenerate(gemma4) ─► CLIPTextEncode.text
```

## VRAM Considerations

- Both diffusion models plus the Qwen3-VL encoder are large. Loading **two** ~13.8 GB UNETs is the main cost; expect this to be heavy on 24 GB GPUs. The official docs cite a 16 GB minimum for the FP8 models, but that assumes ComfyUI swaps models in/out rather than holding both resident.
- **Always `clear_vram`** before switching to Ideogram 4 from another model family.
- If you OOM: rely on ComfyUI's automatic model offloading, run `--lowvram`, or reduce resolution.
- Exact VRAM numbers for the dual-model setup are **not verified** in the source files. Treat the above as guidance, not measured figures.

## Troubleshooting

- **Prompt edits to `Ideogram4PromptBuilderKJ` won't stick / stale prompt keeps coming back.** `elements_data` is re-serialized from the browser editor's `node._boxes` at queue time, so `panel_set_widget` reverts on every run and you can't reach `node._boxes` externally. Fix: wire a `PrimitiveStringMultiline` (full caption JSON) into the node's `import_json` input and set `import_mode = "always"`. See "Editing this node programmatically" under Key Nodes. This is the ONLY reliable way to drive the prompt from outside the browser.
- **"NOT A VALID IDEOGRAM 4 CAPTION JSON".** JSON is malformed. Use double quotes, no trailing commas, exact key `compositional_deconstruction`, matched brackets. Validate in any JSON linter.
- **Garbled / overlapping text in the image.** Text bboxes overlap or text is too long. Increase spacing, shorten text, remove boxes.
- **Style drift (anime when you wanted photo, etc.).** Add explicit style-lock language in the element/style description.
- **Wrong element placement.** Remember bbox is `[top, left, bottom, right]` 0 to 1000, not pixels and not x/y/w/h.
- **Same seed, different image across machines.** Expected; it differs by GPU, drivers, PyTorch/CUDA/ComfyUI versions (per template README).
- **CLIPLoader type missing `ideogram4`.** Update ComfyUI; the `ideogram4` CLIP type and the Flux2/Ideogram nodes require a recent build (installer pins ComfyUI portable `v0.24.0`).
- **`Ideogram4PromptBuilderKJ` / `DualModelGuider` not found.** Update KJNodes (`git pull` in `custom_nodes/ComfyUI-KJNodes`); these are recent additions.

## Sources

- **Official:** none found as a prompting guide. Weights listed from https://huggingface.co/Comfy-Org/Ideogram-4 are download URLs, not prompting docs.
- **Empirical:** sampler values, wiring, and prompt notes from working graphs in `packs/` and observed renders; not a vendor prompting guide.

---
name: qwen-txt2img
description: Build Qwen Image 2512 text-to-image workflows — QwenImageIntegratedKSampler, separate component loading, lightning LoRAs, and fine-tuned model variants
globs:
  - "**/*.json"
---

# Qwen Image 2512 Text-to-Image Workflows

## Overview

Qwen Image 2512 is the latest (December 2025) text-to-image model from the Qwen family. It uses a vision-language model (Qwen2.5-VL) as the text encoder and generates high-quality images from natural language prompts. Two workflow approaches:

1. **QwenImageIntegratedKSampler** — All-in-one node (recommended for simplicity)
2. **Separate component loading** — UNETLoader + CLIPLoader + VAELoader + standard KSampler (more flexible)

## Models

### Standard Components

| Component | Node | Model | Notes |
|-----------|------|-------|-------|
| **UNET** | `UNETLoader` | `qwen_image_2512_fp8_e4m3fn.safetensors` | FP8, not currently installed — download if needed |
| **CLIP** | `CLIPLoader` (type=`qwen_image`) | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | Shared across all Qwen models, in clip/ |
| **VAE** | `VAELoader` | `qwen_image_vae.safetensors` | Qwen-specific VAE (242MB) |

### Fine-tuned Variants (Installed)

| Model | Path | Focus |
|-------|------|-------|
| `qwenImageEditRemix_v10` | `diffusion_models/qwenImageEditRemix_v10.safetensors` | General-purpose remix |
| `qwenUltimateRealism_v11` | UNETLoader path | Product photography, hyper-realistic |
| `copaxTimeless` | UNETLoader path | Ultra-realistic portraits |
| `qwnImageEdit_v16Bf16` | UNETLoader path | Abliterated (uncensored) |

## Lightning LoRAs

### 4-Step Lightning (General Qwen / txt2img)

```json
{
  "class_type": "LoraLoaderModelOnly",
  "inputs": {
    "model": ["<unet_node>", 0],
    "lora_name": "Qwen-Image-Lightning-4steps-V1.0.safetensors",
    "strength_model": 1.0
  }
}
```

**Settings**: steps=4, cfg=1.0, sampler=euler, scheduler=simple, denoise=1.0

### 8-Step Lightning (Higher Quality)

```json
{
  "class_type": "LoraLoaderModelOnly",
  "inputs": {
    "model": ["<unet_node>", 0],
    "lora_name": "Qwen-Image-Lightning-8steps-V1.0.safetensors",
    "strength_model": 1.0
  }
}
```

**Settings**: steps=8, cfg=1.0 (or 2.5 for character detail), sampler=euler, scheduler=simple

## Sampler Settings

| Preset | Steps | CFG | Sampler | Scheduler | Denoise | LoRA | Notes |
|--------|-------|-----|---------|-----------|---------|------|-------|
| **Lightning 4-step** | 4 | 1.0 | euler | simple | 1.0 | Lightning-4steps | Fastest, good quality |
| **Lightning 8-step** | 8 | 1.0 | euler | simple | 1.0 | Lightning-8steps | Better detail |
| **Lightning character** | 8 | 2.5 | euler | simple | 1.0 | Lightning-8steps | Best for portraits |
| **Standard** | 50 | 4.0 | euler | simple | 1.0 | none | Official ComfyUI |
| **Golden quality** | 50 | 4.5 | euler | simple | 1.0 | none | Community best |
| **Character composition** | 30 | 4.0 | euler_ancestral | beta | 1.0 | none | Multi-character scenes |
| **CopaxTimeless** | 30 | 4.0 | res_multistep | sgm_uniform | 1.0 | none | Ultra-realistic |
| **UltimateRealism** | 30 | 7.5 | euler | simple | 1.0 | none | Product photography |

### ModelSamplingAuraFlow

For standard (non-lightning) presets, apply flow matching shift:

```json
{
  "class_type": "ModelSamplingAuraFlow",
  "inputs": { "model": ["<unet_or_lora>", 0], "shift": 3.1 }
}
```

**Shift=3.1** is the standard value for Qwen Image. Not needed with lightning LoRA (baked into the distillation).

## Resolutions

Qwen operates at ~1.6 megapixels natively:

| Aspect | Resolution | Use Case |
|--------|-----------|----------|
| Square | 1328x1328 | General |
| Portrait 3:4 | 1104x1472 | Portraits |
| Portrait 2:3 | 1056x1584 | |
| Portrait 9:16 | 928x1664 | Phone format |
| Landscape 4:3 | 1472x1104 | Landscape scenes |
| Landscape 3:2 | 1584x1056 | |
| Landscape 16:9 | 1664x928 | Widescreen |
| Ultra portrait | 1536x2048 | Tall format |
| Video-ready | 832x480 | For WAN 2.2 FLF pipeline |

## Approach 1: QwenImageIntegratedKSampler (All-in-One)

The `QwenImageIntegratedKSampler` custom node handles model patching, conditioning, sampling, and output in a single node. Simplest workflow — just 4 nodes for model loading + 1 integrated sampler + 1 save.

### Node Inputs

```
Required:
  - model: MODEL (from UNETLoader)
  - clip: CLIP (from CLIPLoader, type=qwen_image)
  - vae: VAE
  - positive_prompt: STRING
  - negative_prompt: STRING
  - generation_mode: "文生图 text-to-image" or "图生图 image-to-image"
  - batch_size: INT (default 1)
  - width: INT (default 0, step 8)
  - height: INT (default 0, step 8)
  - seed: INT
  - steps: INT (default 4)
  - cfg: FLOAT (default 1)
  - sampler_name: euler, dpmpp_2m, etc.
  - scheduler: simple, sgm_uniform, beta, etc.
  - denoise: FLOAT (default 1)

Optional:
  - image1-5: IMAGE (reference images for i2i or multi-ref)
  - latent: LATENT
  - controlnet_data: CONTROL_NET_DATA
  - auraflow_shift: FLOAT (default 3)
  - cfg_norm_strength: FLOAT (default 1)

Outputs:
  [0] IMAGE — generated image
  [1] LATENT — output latent (optional)
  [2] IMAGE — scaled input image (for i2i)
```

### Complete Workflow: Integrated Sampler (Lightning 4-Step)

```json
{
  "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "qwenImageEditRemix_v10.safetensors", "weight_dtype": "default" }},
  "2": { "class_type": "LoraLoaderModelOnly", "inputs": { "model": ["1", 0], "lora_name": "Qwen-Image-Lightning-4steps-V1.0.safetensors", "strength_model": 1.0 }},
  "3": { "class_type": "CLIPLoader", "inputs": { "clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image" }},
  "4": { "class_type": "VAELoader", "inputs": { "vae_name": "qwen_image_vae.safetensors" }},
  "5": { "class_type": "QwenImageIntegratedKSampler", "inputs": {
    "model": ["2", 0],
    "clip": ["3", 0],
    "vae": ["4", 0],
    "positive_prompt": "<detailed natural language prompt>",
    "negative_prompt": "",
    "generation_mode": "文生图 text-to-image",
    "batch_size": 1,
    "width": 1024,
    "height": 1344,
    "seed": 42,
    "steps": 4,
    "cfg": 1,
    "sampler_name": "euler",
    "scheduler": "simple",
    "denoise": 1,
    "auraflow_shift": 3,
    "cfg_norm_strength": 1
  }},
  "6": { "class_type": "SaveImage", "inputs": { "images": ["5", 0], "filename_prefix": "qwen_t2i" }}
}
```

## Approach 2: Separate Component Loading (Standard Pipeline)

More flexible — allows inserting additional processing nodes between stages.

### Pipeline Flow

```
UNETLoader → [LoraLoaderModelOnly] → [ModelSamplingAuraFlow (shift=3.1)] → MODEL
CLIPLoader (qwen_image) → CLIP
VAELoader → VAE

CLIPTextEncode (positive) → CONDITIONING
ConditioningZeroOut → negative CONDITIONING

EmptyLatentImage (1024x1344) → LATENT

KSampler → VAEDecode → SaveImage
```

### Complete Workflow: Separate Loading (Lightning 4-Step)

```json
{
  "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "qwenImageEditRemix_v10.safetensors", "weight_dtype": "default" }},
  "2": { "class_type": "LoraLoaderModelOnly", "inputs": { "model": ["1", 0], "lora_name": "Qwen-Image-Lightning-4steps-V1.0.safetensors", "strength_model": 1.0 }},
  "3": { "class_type": "CLIPLoader", "inputs": { "clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image" }},
  "4": { "class_type": "VAELoader", "inputs": { "vae_name": "qwen_image_vae.safetensors" }},
  "5": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["3", 0], "text": "<detailed natural language prompt>" }},
  "6": { "class_type": "ConditioningZeroOut", "inputs": { "conditioning": ["5", 0] }},
  "7": { "class_type": "EmptyLatentImage", "inputs": { "width": 1024, "height": 1344, "batch_size": 1 }},
  "8": { "class_type": "KSampler", "inputs": {
    "model": ["2", 0],
    "positive": ["5", 0],
    "negative": ["6", 0],
    "latent_image": ["7", 0],
    "seed": 42, "steps": 4, "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 1
  }},
  "9": { "class_type": "VAEDecode", "inputs": { "samples": ["8", 0], "vae": ["4", 0] }},
  "10": { "class_type": "SaveImage", "inputs": { "images": ["9", 0], "filename_prefix": "qwen_t2i" }}
}
```

### Complete Workflow: Standard Quality (50-Step)

```json
{
  "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "qwenImageEditRemix_v10.safetensors", "weight_dtype": "default" }},
  "2": { "class_type": "ModelSamplingAuraFlow", "inputs": { "model": ["1", 0], "shift": 3.1 }},
  "3": { "class_type": "CLIPLoader", "inputs": { "clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image" }},
  "4": { "class_type": "VAELoader", "inputs": { "vae_name": "qwen_image_vae.safetensors" }},
  "5": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["3", 0], "text": "<detailed natural language prompt>" }},
  "6": { "class_type": "ConditioningZeroOut", "inputs": { "conditioning": ["5", 0] }},
  "7": { "class_type": "EmptyLatentImage", "inputs": { "width": 1328, "height": 1328, "batch_size": 1 }},
  "8": { "class_type": "KSampler", "inputs": {
    "model": ["2", 0],
    "positive": ["5", 0],
    "negative": ["6", 0],
    "latent_image": ["7", 0],
    "seed": 42, "steps": 50, "cfg": 4, "sampler_name": "euler", "scheduler": "simple", "denoise": 1
  }},
  "9": { "class_type": "VAEDecode", "inputs": { "samples": ["8", 0], "vae": ["4", 0] }},
  "10": { "class_type": "SaveImage", "inputs": { "images": ["9", 0], "filename_prefix": "qwen_t2i_hq" }}
}
```

## Negative Conditioning

Always use `ConditioningZeroOut` for Qwen txt2img:

```json
{
  "class_type": "ConditioningZeroOut",
  "inputs": { "conditioning": ["<positive_cond>", 0] }
}
```

Or use an empty string in `CLIPTextEncode` — but ZeroOut is more explicit and reliable.

## QwenImageDiffsynthControlnet

For ControlNet support with Qwen models. Patches the model with a DiffSynth control signal:

```
Required Inputs:
  - model: MODEL
  - model_patch: MODEL_PATCH (from DiffSynth ControlNet loader)
  - vae: VAE
  - image: IMAGE (control image)
  - strength: FLOAT (default 1.0)

Optional:
  - mask: MASK

Outputs:
  [0] MODEL (patched)
```

**DiffSynth ControlNets support**: canny, depth, inpaint only (NOT pose).

## Concept/Style LoRAs (Installed)

Located in `loras/Qwen/`:
- `style/` — Figure makers, reality transform, panel painter
- `concept/` — Various concept LoRAs
- `poses/` — Pose-specific LoRAs
- `character/` — Character enhancement
- `anime/` — Anime style LoRAs
- `tool/` — Utility LoRAs (anything2real, gaussian splash)
- `equirectangular projection/` — 360 panorama LoRA

Apply with `LoraLoaderModelOnly`:

```json
{
  "class_type": "LoraLoaderModelOnly",
  "inputs": {
    "model": ["<unet_or_lightning_lora>", 0],
    "lora_name": "Qwen\\concept\\hinaQwenImageAsianMixLora_v2.safetensors",
    "strength_model": 0.8
  }
}
```

## Prompt Style

Natural language, 1–3 sentences. Be descriptive:

```
Good: "Professional portrait of an Asian woman in her late 20s, wearing a cream linen blazer at a Tokyo rooftop café during golden hour, holding a matcha latte, editorial fashion photography, shot on Sony A7III 85mm f/1.4"
Bad: "1girl, cafe, blazer, matcha"
```

Tips:
- Put text to render in quotes within the prompt
- "photograph" works better than "photorealistic"
- Negative prompts: use NLP-style descriptions, not keyword spam (or just use ZeroOut)

## VRAM Considerations

| Config | VRAM | Notes |
|--------|------|-------|
| FP8 UNET + fp8 CLIP + VAE | ~17-18GB | Fits comfortably on RTX 4090 |
| bf16 UNET (edit model) | ~10GB UNET + 7GB CLIP | Also fits well |

- **Always `clear_vram`** before switching to Qwen from another model family
- Lightning 4-step is extremely fast (~3-5s per image)

## Tips

1. **QwenImageIntegratedKSampler** is the simplest approach for basic txt2img — one node handles everything
2. For **LoRA stacking** or **ControlNet**, use the separate component pipeline instead
3. The integrated sampler's `auraflow_shift` defaults to 3 (close to the recommended 3.1) — adjust only if needed
4. For **video pipeline** output (feeding into WAN FLF), set resolution to 832x480
5. **CopaxTimeless pick**: res_multistep + sgm_uniform at CFG 4.0 for ultra-realistic results
6. Multiple concept LoRAs can stack — reduce individual strength to 0.5-0.7 when combining

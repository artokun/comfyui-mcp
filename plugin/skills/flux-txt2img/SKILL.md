---
name: flux-txt2img
description: Build Flux txt2img workflows — Flux.1 Dev (SRPO), Flux 2 Klein 9B, Turbo LoRAs, FluxGuidance, and DualCLIPLoader patterns
globs:
  - "**/*.json"
---

# Flux Text-to-Image Workflows

## Overview

Flux is a guidance-distilled diffusion model family from Black Forest Labs. It uses a separate `FluxGuidance` node instead of KSampler CFG (which must always be 1.0). Three variants are available locally:

1. **Flux.1 Dev SRPO** — Fine-tuned Flux.1 Dev with SRPO alignment. Uses DualCLIPLoader (T5XXL + CLIP-L). BF16 only.
2. **Flux 2 Klein 9B** — Distilled Flux 2 variant. Uses single CLIPLoader (Qwen3-8B) + `flux2-vae.safetensors`. Fast 4-step generation.
3. **Flux 2 Turbo LoRA** — Applied to Flux.1 Dev for 4-step generation.

## Models

### Flux.1 Dev SRPO

| Component | Node | Model | Notes |
|-----------|------|-------|-------|
| **UNET** | `UNETLoader` | `flux.1-dev-SRPO-BFL-bf16.safetensors` | 22.7GB, **BF16 only** — FP8 produces broken results |
| **CLIP** | `DualCLIPLoader` (type=`flux`) | `clip_name1`: `t5xxl_fp8_e4m3fn.safetensors`, `clip_name2`: `clip_l.safetensors` | T5XXL (4.7GB) + CLIP-L (235MB) |
| **VAE** | `VAELoader` | `ae.safetensors` | Standard Flux/Z-Image VAE (320MB) |

### Flux 2 Klein 9B

| Component | Node | Model | Notes |
|-----------|------|-------|-------|
| **UNET** | `UNETLoader` | `bigLove_klein1.safetensors` | 17.3GB, Klein 9B variant |
| **CLIP** | `CLIPLoader` (type=`flux`) | `qwen_3_8b_fp8mixed.safetensors` | Qwen3-8B in text_encoders/ (8.3GB) |
| **VAE** | `VAELoader` | `flux2-vae.safetensors` | Flux 2 specific VAE (321MB) |

**Klein 9B vs Flux.1 Dev**: Klein uses Qwen3-8B text encoder (not T5XXL + CLIP-L). It has a different VAE (`flux2-vae.safetensors`). 9B distilled runs in 4 steps; 9B base needs ~50 steps at CFG 5.0. Fits in ~20GB VRAM with FP8.

### Flux 2 Turbo LoRA (applied to Flux.1 Dev)

| Component | Node | Model | Notes |
|-----------|------|-------|-------|
| **LoRA** | `LoraLoaderModelOnly` | `flux2-turbo-lora.safetensors` | 2.6GB, strength 1.0 |
| **Alt LoRA** | `LoraLoaderModelOnly` | `Flux2TurboComfyv2.safetensors` | Community variant, same size |

## Conditioning

### CLIPTextEncodeFlux (Recommended for Flux.1 Dev)

Provides separate prompt fields for each text encoder:

```json
{
  "class_type": "CLIPTextEncodeFlux",
  "inputs": {
    "clip": ["<dual_clip>", 0],
    "clip_l": "short prompt for CLIP-L",
    "t5xxl": "detailed description for T5XXL",
    "guidance": 3.5
  }
}
```

`clip_l` captures key semantic features. `t5xxl` expands and refines descriptions. For simple use, put the same prompt in both fields. **Guidance is built into this node** — no separate FluxGuidance needed.

### FluxGuidance (Alternative)

If using standard `CLIPTextEncode` instead of `CLIPTextEncodeFlux`, apply guidance separately:

```json
{
  "class_type": "FluxGuidance",
  "inputs": {
    "conditioning": ["<clip_text_encode>", 0],
    "guidance": 3.5
  }
}
```

### Guidance Values

| Scenario | Guidance | Notes |
|----------|----------|-------|
| Short prompts | 3.5–4.0 | Tighter prompt adherence |
| Long/complex prompts | 1.0–1.5 | More creative freedom |
| Realism | 2.5 | Less glossy skin, richer detail |
| Standard | 3.5 | Default for most use cases |

### Negative Conditioning

Flux does NOT support traditional negative prompts (guidance-distilled, CFG=1.0). Use `ConditioningZeroOut`:

```json
{
  "class_type": "ConditioningZeroOut",
  "inputs": { "conditioning": ["<positive_cond>", 0] }
}
```

Or simply use an empty `CLIPTextEncode` for the negative input.

## Sampler Settings

### Flux.1 Dev SRPO

| Parameter | Standard | Notes |
|-----------|----------|-------|
| steps | 20 | Range: 20–28 |
| cfg | 1.0 | **Always 1.0** — guidance is via FluxGuidance |
| sampler_name | ipndm | Author-recommended for SRPO |
| scheduler | beta | Author-recommended for SRPO |
| guidance | 3.5 | Via CLIPTextEncodeFlux or FluxGuidance |
| denoise | 1.0 | |

**SRPO note**: The ipndm/beta combo is specifically recommended by the SRPO author. Standard Flux settings (euler/simple) also work but ipndm/beta gives better results with this fine-tune.

### Flux 2 Klein 9B (Distilled)

| Parameter | Value | Notes |
|-----------|-------|-------|
| steps | 4 | Distilled model, 4 steps is optimal |
| cfg | 1.0 | Always 1.0 |
| sampler_name | euler | |
| scheduler | simple | |
| denoise | 1.0 | |

### Flux 2 Klein 9B (Base/Undistilled)

| Parameter | Value | Notes |
|-----------|-------|-------|
| steps | 50 | Full quality |
| cfg | 5.0 | Higher CFG for base model |
| sampler_name | euler | |
| scheduler | simple | |

### Flux.1 Dev + Turbo LoRA

| Parameter | Value | Notes |
|-----------|-------|-------|
| steps | 4 | Turbo-distilled |
| cfg | 1.0 | |
| sampler_name | euler | |
| scheduler | simple | |
| lora_strength | 1.0 | |

## Resolutions

| Aspect | Resolution | Megapixels |
|--------|-----------|------------|
| Square | 1024x1024 | 1.0MP |
| Portrait 3:4 | 896x1152 | 1.0MP |
| Landscape 4:3 | 1152x896 | 1.0MP |
| Landscape 16:9 | 1344x768 | 1.0MP |
| Portrait 9:16 | 768x1344 | 1.0MP |

Flux operates at ~1 megapixel natively. Dimensions should be multiples of 8.

## Prompt Style

Natural language descriptions. No quality tags needed (unlike SDXL/Illustrious). Detailed, descriptive prompts work best.

```
Good: "A young woman with auburn hair sits at a sunlit cafe in Paris, wearing a cream linen blazer, soft bokeh background, shot on Sony A7III 85mm f/1.4"
Bad: "masterpiece, best quality, 1girl, cafe, paris"
```

## Complete Workflow: Flux.1 Dev SRPO

```json
{
  "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "flux.1-dev-SRPO-BFL-bf16.safetensors", "weight_dtype": "default" }},
  "2": { "class_type": "DualCLIPLoader", "inputs": { "clip_name1": "t5xxl_fp8_e4m3fn.safetensors", "clip_name2": "clip_l.safetensors", "type": "flux" }},
  "3": { "class_type": "VAELoader", "inputs": { "vae_name": "ae.safetensors" }},
  "4": { "class_type": "CLIPTextEncodeFlux", "inputs": {
    "clip": ["2", 0],
    "clip_l": "<short prompt>",
    "t5xxl": "<detailed prompt>",
    "guidance": 3.5
  }},
  "5": { "class_type": "ConditioningZeroOut", "inputs": { "conditioning": ["4", 0] }},
  "6": { "class_type": "EmptyLatentImage", "inputs": { "width": 896, "height": 1152, "batch_size": 1 }},
  "7": { "class_type": "KSampler", "inputs": {
    "model": ["1", 0],
    "positive": ["4", 0],
    "negative": ["5", 0],
    "latent_image": ["6", 0],
    "seed": 42, "steps": 20, "cfg": 1, "sampler_name": "ipndm", "scheduler": "beta", "denoise": 1
  }},
  "8": { "class_type": "VAEDecode", "inputs": { "samples": ["7", 0], "vae": ["3", 0] }},
  "9": { "class_type": "SaveImage", "inputs": { "images": ["8", 0], "filename_prefix": "flux_srpo" }}
}
```

## Complete Workflow: Flux 2 Klein 9B (Distilled, 4-Step)

```json
{
  "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "bigLove_klein1.safetensors", "weight_dtype": "default" }},
  "2": { "class_type": "CLIPLoader", "inputs": { "clip_name": "qwen_3_8b_fp8mixed.safetensors", "type": "flux" }},
  "3": { "class_type": "VAELoader", "inputs": { "vae_name": "flux2-vae.safetensors" }},
  "4": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["2", 0], "text": "<prompt>" }},
  "5": { "class_type": "ConditioningZeroOut", "inputs": { "conditioning": ["4", 0] }},
  "6": { "class_type": "EmptyLatentImage", "inputs": { "width": 1024, "height": 1024, "batch_size": 1 }},
  "7": { "class_type": "KSampler", "inputs": {
    "model": ["1", 0],
    "positive": ["4", 0],
    "negative": ["5", 0],
    "latent_image": ["6", 0],
    "seed": 42, "steps": 4, "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 1
  }},
  "8": { "class_type": "VAEDecode", "inputs": { "samples": ["7", 0], "vae": ["3", 0] }},
  "9": { "class_type": "SaveImage", "inputs": { "images": ["8", 0], "filename_prefix": "flux_klein" }}
}
```

**Klein note**: Uses single `CLIPLoader` (not DualCLIPLoader) with `type: "flux"` and the Qwen3-8B text encoder from `text_encoders/`. The CLIP loader path resolves from `models/text_encoders/`.

## Complete Workflow: Flux.1 Dev + Turbo LoRA (4-Step)

```json
{
  "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "flux.1-dev-SRPO-BFL-bf16.safetensors", "weight_dtype": "default" }},
  "2": { "class_type": "LoraLoaderModelOnly", "inputs": { "model": ["1", 0], "lora_name": "flux2-turbo-lora.safetensors", "strength_model": 1.0 }},
  "3": { "class_type": "DualCLIPLoader", "inputs": { "clip_name1": "t5xxl_fp8_e4m3fn.safetensors", "clip_name2": "clip_l.safetensors", "type": "flux" }},
  "4": { "class_type": "VAELoader", "inputs": { "vae_name": "ae.safetensors" }},
  "5": { "class_type": "CLIPTextEncodeFlux", "inputs": {
    "clip": ["3", 0],
    "clip_l": "<short prompt>",
    "t5xxl": "<detailed prompt>",
    "guidance": 3.5
  }},
  "6": { "class_type": "ConditioningZeroOut", "inputs": { "conditioning": ["5", 0] }},
  "7": { "class_type": "EmptyLatentImage", "inputs": { "width": 1024, "height": 1024, "batch_size": 1 }},
  "8": { "class_type": "KSampler", "inputs": {
    "model": ["2", 0],
    "positive": ["5", 0],
    "negative": ["6", 0],
    "latent_image": ["7", 0],
    "seed": 42, "steps": 4, "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 1
  }},
  "9": { "class_type": "VAEDecode", "inputs": { "samples": ["8", 0], "vae": ["4", 0] }},
  "10": { "class_type": "SaveImage", "inputs": { "images": ["9", 0], "filename_prefix": "flux_turbo" }}
}
```

## LoRA Support

### Custom LoRAs (jellyfish, etc.)

Apply Flux LoRAs with `LoraLoaderModelOnly` between UNET and KSampler:

```json
{
  "class_type": "LoraLoaderModelOnly",
  "inputs": {
    "model": ["<unet_or_previous_lora>", 0],
    "lora_name": "<lora_file>.safetensors",
    "strength_model": 1.0
  }
}
```

### Klein LoRAs

Klein 9B LoRAs go in `loras/Flux.2 Klein 9B/` subfolder:
- `klein_slider_detail.safetensors` — Detail slider LoRA

## VRAM Considerations

| Model | VRAM | Notes |
|-------|------|-------|
| SRPO BF16 + DualCLIP | ~24GB | Fills RTX 4090 exactly. **Must use BF16** — FP8 is broken for SRPO |
| Klein 9B FP8 + Qwen3-8B | ~20GB | Fits comfortably on 4090 |
| SRPO + Turbo LoRA | ~24GB | Same as SRPO base |

- **Always `clear_vram`** before switching to Flux from another model family
- T5XXL is the main VRAM consumer alongside the UNET — both stay loaded during sampling
- CLIP-L is small (235MB) and negligible

## Tips

1. **KSampler CFG must always be 1.0** — all guidance is through `CLIPTextEncodeFlux` or `FluxGuidance`
2. **SRPO requires BF16** — the FP8 quantization is known to produce broken results with this fine-tune
3. For **short prompts** (1-2 sentences), increase guidance to 3.5–4.0. For **long prompts** (paragraph), decrease to 1.0–1.5
4. Flux generates excellent text in images — put text to render in quotes within your prompt
5. Klein 9B is the fastest option at 4 steps — use it for rapid iteration, then switch to SRPO for final quality

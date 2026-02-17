---
name: z-image-txt2img
description: Build Z-Image txt2img workflows — RedCraft checkpoint, Z-Image Turbo/Base LoRAs, ControlNet, and sampler presets
globs:
  - "**/*.json"
---

# Z-Image Text-to-Image Workflows

## Overview

Z-Image is a 6B-parameter image generation model from Alibaba's Tongyi Lab using a Scalable Single-Stream DiT (S3-DiT) architecture. It uses a Qwen text encoder (not CLIP-L/T5), and the same `ae.safetensors` VAE as Flux. Two variants:

1. **Z-Image Base** (and RedCraft finetune) — Full model, supports negative prompts, LoRA training, ControlNet. 10-30 steps.
2. **Z-Image Turbo** — DMD-distilled, 8-10 steps, no effective negative prompts (CFG baked in).

## Models

### RedCraft Redzimage DX1 (Installed — Combined Checkpoint)

| Component | Node | Model | Notes |
|-----------|------|-------|-------|
| **Checkpoint** | `CheckpointLoaderSimple` | `redcraftRedzimageUpdatedJAN30_redzibDX1.safetensors` | 17GB, bundles UNET+CLIP+VAE |

RedCraft is a Z-Image Base finetune by the RedCraft team. Designed for faster inference than stock Z-Image Base. Uses `CheckpointLoaderSimple` since it's a combined checkpoint — no need for separate loaders.

### Z-Image Turbo (Separate Components — May Need Download)

| Component | Node | Model | Notes |
|-----------|------|-------|-------|
| **UNET** | `UNETLoader` | `z_image_turbo_bf16.safetensors` | Not currently installed |
| **CLIP** | `CLIPLoader` (type=`qwen_image`) | `qwen_3_4b.safetensors` | Not currently installed |
| **VAE** | `VAELoader` | `ae.safetensors` | Same as Flux VAE (320MB) |

### Z-Image Base (Separate Components — May Need Download)

| Component | Node | Model | Notes |
|-----------|------|-------|-------|
| **UNET** | `UNETLoader` | `z_image_base_bf16.safetensors` | Not currently installed |
| **CLIP** | `CLIPLoader` (type=`qwen_image`) | `qwen_3_4b.safetensors` | Not currently installed |
| **VAE** | `VAELoader` | `ae.safetensors` | Same as Flux VAE |

## Conditioning

### TextEncodeZImageOmni (Built-in)

For Z-Image separate component loading. Supports reference images via CLIP Vision:

```
Required Inputs:
  - clip: CLIP
  - prompt: STRING (multiline)
  - auto_resize_images: BOOLEAN (default true)

Optional Inputs:
  - image_encoder: CLIP_VISION (for reference images)
  - vae: VAE
  - image1-3: IMAGE (up to 3 reference images)

Outputs:
  [0] CONDITIONING
```

### CLIPTextEncode (For RedCraft Checkpoint)

When using `CheckpointLoaderSimple`, standard `CLIPTextEncode` works since the checkpoint bundles the correct tokenizer:

```json
{
  "class_type": "CLIPTextEncode",
  "inputs": { "clip": ["<checkpoint>", 1], "text": "<prompt>" }
}
```

## Sampler Settings

### RedCraft DX1

| Preset | Steps | CFG | Sampler | Scheduler | Notes |
|--------|-------|-----|---------|-----------|-------|
| **Distilled Fast** | 10 | 1.0 | euler | simple | Quick iteration |
| **Standard** | 30 | 4.0 | euler | simple | Full quality |

### Z-Image Turbo

| Preset | Steps | CFG | Sampler | Scheduler | Notes |
|--------|-------|-----|---------|-----------|-------|
| Author recommended | 14 | 1.0 | res_2s | simple | CopaxTimeless author pick |
| Beauty/fashion | 10 | 1.0 | euler_ancestral | beta | Smooth skin, fashion photography |
| **Sharpest** | 10 | 1.0 | dpmpp_sde | beta | Sharpest, most natural (560-image test) |

### Z-Image Base (Two-Stage)

**Stage 1 — Primary generation:**

| Parameter | Value |
|-----------|-------|
| Steps | 22 |
| CFG | 4.0 (range 4–7) |
| Sampler | res_2s |
| Scheduler | beta |
| Denoise | 1.0 |

**Stage 2 — Detail refinement (optional img2img pass):**

| Parameter | Value |
|-----------|-------|
| Steps | 3 |
| CFG | 4.0 |
| Sampler | res_2s |
| Scheduler | normal |
| Denoise | 0.15 |

## Negative Prompts

### RedCraft / Z-Image Base

Supports negative prompts at CFG > 1.0:

```
3D, ai generated, semi realistic, illustrated, drawing, comic, digital painting, 3D model, blender, video game screenshot, screenshot, render, high-fidelity, smooth textures, CGI, masterpiece, text, writing, subtitle, watermark, logo, blurry, low quality, jpeg, artifacts, grainy
```

### Z-Image Turbo

Negative prompts are **not effective** — CFG is baked in via distillation. Use the positive prompt to guide away from unwanted elements instead.

Recommended positive-side avoidance template:
```
over-smooth skin, plastic skin, doll face, anime, CGI, waxy texture, blurry face, fake pores, exaggerated makeup, over-sharpening, unrealistic symmetry, flat lighting, low detail skin, extra fingers, distorted anatomy
```

## Resolutions

| Aspect | Resolution | Notes |
|--------|-----------|-------|
| Square | 1024x1024 | Standard |
| Square (native) | 1328x1328 | Higher quality at native resolution |
| Portrait 3:4 | 896x1152 | |
| Portrait 5:8 | 832x1216 | |
| Portrait 9:16 | 768x1344 | |
| Landscape 16:9 | 1280x720 | |

Dimensions must be divisible by 16.

## LoRA System

### ZImageTurbo LoRAs

Located in `loras/ZImageTurbo/` with subfolders:
- `style/` — Style LoRAs (e.g., `TurboPussyZ_v2.safetensors`)
- `concept/` — Concept LoRAs (e.g., `body from below.safetensors`, `ZITnsfwLoRA.safetensors`)
- `character/` — Character LoRAs (e.g., `NSFW_master_ZIT_000008766.safetensors`)
- `action/` — Action LoRAs

**Use with Z-Image Turbo base model.** Typical LoRA strength: 0.6–1.0.

### ZImageBase LoRAs

Located in `loras/ZImageBase/` with subfolders:
- `style/` — Style LoRAs (e.g., `NSGIRL-Z-Image-LoRA-By-MM744.safetensors`)
- `concept/` — Concept LoRAs

**Use with Z-Image Base or RedCraft.** Typical LoRA strength: 0.6–1.0.

### Z-Image-Aesthetic-Base v1

General aesthetic improvement LoRA:
- File: `Z-Image-Aesthetic-Base v1.safetensors` (352MB)
- Settings: euler_ancestral + beta, 30 steps, CFG 4, strength 0.6–1.0

### Applying LoRAs

```json
{
  "class_type": "LoraLoader",
  "inputs": {
    "model": ["<checkpoint_or_unet>", 0],
    "clip": ["<checkpoint_or_clip>", 1],
    "lora_name": "ZImageTurbo\\style\\TurboPussyZ_v2.safetensors",
    "strength_model": 0.8,
    "strength_clip": 0.8
  }
}
```

**Note**: When using `CheckpointLoaderSimple` for RedCraft, model output is index 0 and CLIP output is index 1. When stacking multiple LoRAs, chain them sequentially.

## ControlNet

### ZImageFunControlnet (Built-in)

Experimental built-in node for Z-Image ControlNet. Patches the model with a control signal:

```
Required Inputs:
  - model: MODEL
  - model_patch: MODEL_PATCH (from ControlNet loader)
  - vae: VAE
  - strength: FLOAT (default 1.0, range -10 to 10)

Optional Inputs:
  - image: IMAGE (reference/control image)
  - inpaint_image: IMAGE
  - mask: MASK

Outputs:
  [0] MODEL (patched)
```

### Z-Image-Turbo-Fun-Controlnet-Union

A unified ControlNet supporting multiple condition types:
- Canny, HED, Depth, Pose, MLSD
- Strength: 0.65–0.80 (v2.1 recommended range)
- Best paired with `res_2s`, `res_5s`, or `res_2m` samplers + `beta57` scheduler

## Complete Workflow: RedCraft DX1 (Fast, 10-Step)

```json
{
  "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "redcraftRedzimageUpdatedJAN30_redzibDX1.safetensors" }},
  "2": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["1", 1], "text": "<positive prompt>" }, "_meta": { "title": "Positive" }},
  "3": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["1", 1], "text": "" }, "_meta": { "title": "Negative" }},
  "4": { "class_type": "EmptyLatentImage", "inputs": { "width": 1024, "height": 1024, "batch_size": 1 }},
  "5": { "class_type": "KSampler", "inputs": {
    "model": ["1", 0],
    "positive": ["2", 0],
    "negative": ["3", 0],
    "latent_image": ["4", 0],
    "seed": 42, "steps": 10, "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 1
  }},
  "6": { "class_type": "VAEDecode", "inputs": { "samples": ["5", 0], "vae": ["1", 2] }},
  "7": { "class_type": "SaveImage", "inputs": { "images": ["6", 0], "filename_prefix": "redcraft" }}
}
```

## Complete Workflow: RedCraft DX1 with LoRA Stack

```json
{
  "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "redcraftRedzimageUpdatedJAN30_redzibDX1.safetensors" }},
  "2": { "class_type": "LoraLoader", "inputs": {
    "model": ["1", 0], "clip": ["1", 1],
    "lora_name": "Z-Image-Aesthetic-Base v1.safetensors",
    "strength_model": 0.8, "strength_clip": 0.8
  }},
  "3": { "class_type": "LoraLoader", "inputs": {
    "model": ["2", 0], "clip": ["2", 1],
    "lora_name": "ZImageBase\\style\\NSGIRL-Z-Image-LoRA-By-MM744.safetensors",
    "strength_model": 0.7, "strength_clip": 0.7
  }},
  "4": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["3", 1], "text": "<positive prompt>" }},
  "5": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["3", 1], "text": "<negative prompt>" }},
  "6": { "class_type": "EmptyLatentImage", "inputs": { "width": 896, "height": 1152, "batch_size": 1 }},
  "7": { "class_type": "KSampler", "inputs": {
    "model": ["3", 0],
    "positive": ["4", 0],
    "negative": ["5", 0],
    "latent_image": ["6", 0],
    "seed": 42, "steps": 30, "cfg": 4, "sampler_name": "euler", "scheduler": "simple", "denoise": 1
  }},
  "8": { "class_type": "VAEDecode", "inputs": { "samples": ["7", 0], "vae": ["1", 2] }},
  "9": { "class_type": "SaveImage", "inputs": { "images": ["8", 0], "filename_prefix": "redcraft_lora" }}
}
```

## Prompt Style

Natural language descriptions work best (uses Qwen LLM tokenizer, not CLIP):

```
Good: "Professional headshot of a confident businesswoman in her 30s, natural makeup, soft studio lighting, neutral gray background, sharp focus on eyes, Canon EOS R5"
Bad: "masterpiece, best quality, 1girl, businesswoman, studio"
```

## VRAM Considerations

| Config | VRAM | Notes |
|--------|------|-------|
| RedCraft DX1 checkpoint | ~17GB | Fits comfortably on RTX 4090 |
| Z-Image Turbo separate | ~8GB UNET + CLIP | Very lightweight |
| Z-Image Base separate | ~12GB | |

- **Always `clear_vram`** before switching to Z-Image from another model family
- RedCraft is one of the most VRAM-efficient quality models available

## Tips

1. RedCraft DX1 with 10 steps / CFG 1.0 is surprisingly fast and high quality for quick iteration
2. For maximum sharpness with Turbo LoRAs, use `dpmpp_sde` + `beta` scheduler
3. The `Z-Image-Aesthetic-Base v1` LoRA at 0.6–0.8 strength noticeably improves output quality across all Z-Image Base variants
4. Z-Image excels at photorealistic human generation — it's the go-to for portrait and fashion photography
5. When switching between Turbo and Base LoRAs, use the matching base model variant

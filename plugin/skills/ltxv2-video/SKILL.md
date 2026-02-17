---
name: ltxv2-video
description: Build LTX-V2 19B video workflows — text-to-video, image-to-video, distilled model, camera control LoRAs, and two-stage upscaling
globs:
  - "**/*.json"
---

# LTX-V2 19B Video Workflows

## Overview

LTX-V2 (LTX-2) is a 19-billion parameter DiT-based video foundation model from Lightricks. It uses a Gemma 3 12B text encoder and supports both text-to-video (T2V) and image-to-video (I2V). Key features:

- **Distilled model** for fast 8-step generation
- **Two-stage pipeline**: Generate at low res, then 2x spatial upscale in latent space
- **Camera control LoRAs** for cinematic movements
- **Audio-video generation** in a single pass (optional)

## Models

### Checkpoint (Installed)

| Component | Node | Model | Notes |
|-----------|------|-------|-------|
| **Checkpoint** | `CheckpointLoaderSimple` | `ltx-2-19b-distilled.safetensors` | 41GB bf16, distilled variant |

### Text Encoder (Installed)

| Component | Node | Model | Notes |
|-----------|------|-------|-------|
| **Gemma 3** | `CLIPLoader` (type=`ltxv`) | `gemma_3_12B_it_fp4_mixed.safetensors` | 9GB FP4, in text_encoders/ |

**Loading note**: The checkpoint bundles the VAE internally. The Gemma 3 text encoder loads separately. Use `CLIPLoader` with `type: "ltxv"` pointing at the `text_encoders/` directory.

### LoRAs (Installed)

| LoRA | File | Purpose |
|------|------|---------|
| **Distilled LoRA** | `ltx2/ltx-2-19b-lora-camera-control-dolly-left.safetensors` | Camera dolly left |
| **Distilled LoRA (384)** | `ltx2/ltx-2-19b-distilled-lora-384.safetensors` | Apply to base model for distilled behavior |
| **Camera Dolly Left** | `ltx-2-19b-lora-camera-control-dolly-left.safetensors` | Camera movement |

### Concept/Style LoRAs (Installed)

Located in `loras/LTXV2/`:
- `style/PLORAV7_LTX_000010500.safetensors`
- `concept/head_swap_v1_13500_first_frame.safetensors`
- `concept/LTX-2 - Better Female Nudity.safetensors`
- `action/LTX2-i2v-OralSuite.safetensors`
- `action/LTX2-i2v-SexThrust.safetensors`
- And more in `concept/` and `action/` subfolders

## Key Nodes

### LTXVConditioning

Binds text conditioning with frame rate information:

```json
{
  "class_type": "LTXVConditioning",
  "inputs": {
    "positive": ["<clip_text_encode>", 0],
    "negative": ["<clip_text_encode_neg>", 0],
    "frame_rate": 25
  }
}
```

### EmptyLTXVLatentVideo

Creates the initial video latent (for T2V):

```json
{
  "class_type": "EmptyLTXVLatentVideo",
  "inputs": {
    "width": 768,
    "height": 512,
    "length": 97,
    "batch_size": 1
  }
}
```

**Frame count constraint**: Must be `8n + 1` (9, 17, 25, 33, 41, 49, 57, 65, 73, 81, 89, 97, 105, 113, 121).

### LTXVScheduler

Dedicated sigma schedule for LTX-V2 latent space:

```json
{
  "class_type": "LTXVScheduler",
  "inputs": {
    "steps": 8,
    "max_shift": 2.05,
    "base_shift": 0.95,
    "stretch": true,
    "terminal": 0.1
  }
}
```

Connect the optional `latent` input for latent-aware shift scaling.

### LTXVImgToVideo (For I2V)

All-in-one node that encodes image, creates latent, and wraps conditioning:

```json
{
  "class_type": "LTXVImgToVideo",
  "inputs": {
    "positive": ["<conditioning>", 0],
    "negative": ["<conditioning>", 0],
    "vae": ["<checkpoint>", 2],
    "image": ["<load_image>", 0],
    "width": 768,
    "height": 512,
    "length": 97,
    "batch_size": 1,
    "strength": 0.6
  }
}
```

### LTXVLatentUpsampler (For Two-Stage Upscale)

```json
{
  "class_type": "LTXVLatentUpsampler",
  "inputs": {
    "latent": ["<sampler_output>", 0],
    "upscale_model": ["<upscale_loader>", 0]
  }
}
```

Requires `LatentUpscaleModelLoader` with `ltx-2-spatial-upscaler-x2-1.0.safetensors`.

## Sampler Settings

### Distilled Model (Installed)

Uses `SamplerCustomAdvanced` with manual sigmas, NOT standard `KSampler`:

| Parameter | Stage 1 (Generate) | Stage 2 (Upscale) |
|-----------|--------------------|--------------------|
| sampler | euler | euler |
| steps | 8 | 4 |
| cfg | 1.0 | 1.0 |
| scheduler | LTXVScheduler | Manual sigmas |

**Stage 1 sigmas** (via LTXVScheduler): `max_shift=2.05`, `base_shift=0.95`, `stretch=true`, `terminal=0.1`

**Stage 2 sigmas** (manual, for upscale refinement): `0.909375, 0.725, 0.421875, 0.0`

### Base Model (If Using Distilled LoRA on Base)

| Parameter | Value |
|-----------|-------|
| sampler | res_2s |
| steps | 20 |
| cfg | 4.0 |
| scheduler | LTXVScheduler |
| distilled_lora_strength | 0.6 |

## Resolution and Frame Count

### Resolutions (Must be multiples of 32)

| Aspect | Stage 1 | After 2x Upscale | Notes |
|--------|---------|-------------------|-------|
| 3:2 landscape | 768x512 | 1536x1024 | Default |
| 16:9 landscape | 960x544 | 1920x1088 | Official example |
| 1:1 square | 640x640 | 1280x1280 | |
| 4:3 landscape | 704x512 | 1408x1024 | |

Start at lower resolution for Stage 1 to manage VRAM, then upscale.

### Frame Count (`8n + 1`)

| Frames | Duration @25fps | Duration @24fps | Notes |
|--------|----------------|-----------------|-------|
| 49 | 1.96s | 2.04s | Quick test |
| 81 | 3.24s | 3.38s | Short clip |
| 97 | 3.88s | 4.04s | Default |
| 121 | 4.84s | 5.04s | Official example, recommended |
| 161 | 6.44s | 6.71s | Longer clip |
| 257 | 10.28s | 10.71s | Maximum |

### Frame Rate

Standard: **25 fps** (conditioned via `LTXVConditioning`). 24 and 30 fps also supported.

## Pipeline Flow: T2V Distilled

```
CheckpointLoaderSimple → MODEL + VAE
CLIPLoader (ltxv, gemma_3_12B_it_fp4_mixed) → CLIP
  ├─ CLIPTextEncode (positive) → CONDITIONING
  └─ CLIPTextEncode (negative) → CONDITIONING

LTXVConditioning (positive, negative, frame_rate=25) → pos/neg CONDITIONING
EmptyLTXVLatentVideo (768x512, 121 frames) → LATENT
LTXVScheduler (steps=8, max_shift=2.05, base_shift=0.95) → SIGMAS

SamplerCustomAdvanced (model, sigmas, positive, negative, latent)
  → Stage 1 LATENT

[Optional: LTXVLatentUpsampler → 2x LATENT → SamplerCustomAdvanced Stage 2]

VAEDecode (or LTXVSpatioTemporalTiledVAEDecode for VRAM savings) → IMAGE
VHS_VideoCombine (or CreateVideo + SaveVideo) → MP4
```

## Complete Workflow: T2V Distilled (8-Step)

```json
{
  "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "ltx-2-19b-distilled.safetensors" }},
  "2": { "class_type": "CLIPLoader", "inputs": { "clip_name": "gemma_3_12B_it_fp4_mixed.safetensors", "type": "ltxv" }},
  "3": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["2", 0], "text": "<positive prompt>" }},
  "4": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["2", 0], "text": "" }},
  "5": { "class_type": "LTXVConditioning", "inputs": {
    "positive": ["3", 0], "negative": ["4", 0], "frame_rate": 25
  }},
  "6": { "class_type": "EmptyLTXVLatentVideo", "inputs": {
    "width": 768, "height": 512, "length": 121, "batch_size": 1
  }},
  "7": { "class_type": "LTXVScheduler", "inputs": {
    "steps": 8, "max_shift": 2.05, "base_shift": 0.95,
    "stretch": true, "terminal": 0.1, "latent": ["6", 0]
  }},
  "8": { "class_type": "KSamplerSelect", "inputs": { "sampler_name": "euler" }},
  "9": { "class_type": "SamplerCustomAdvanced", "inputs": {
    "model": ["1", 0],
    "positive": ["5", 0],
    "negative": ["5", 1],
    "sigmas": ["7", 0],
    "latent_image": ["6", 0],
    "noise": ["10", 0],
    "sampler": ["8", 0],
    "guider": ["11", 0]
  }},
  "10": { "class_type": "RandomNoise", "inputs": { "noise_seed": 42 }},
  "11": { "class_type": "CFGGuider", "inputs": {
    "model": ["1", 0],
    "positive": ["5", 0],
    "negative": ["5", 1],
    "cfg": 1.0
  }},
  "12": { "class_type": "VAEDecode", "inputs": { "samples": ["9", 0], "vae": ["1", 2] }},
  "13": { "class_type": "VHS_VideoCombine", "inputs": {
    "images": ["12", 0], "frame_rate": 25, "loop_count": 0,
    "filename_prefix": "ltxv2", "format": "video/h264-mp4",
    "pingpong": false, "save_output": true,
    "pix_fmt": "yuv420p", "crf": 19, "save_metadata": true, "trim_to_audio": false
  }}
}
```

**Alternative simple output** (built-in nodes instead of VHS):
```json
{
  "12": { "class_type": "VAEDecode", "inputs": { "samples": ["9", 0], "vae": ["1", 2] }},
  "13": { "class_type": "CreateVideo", "inputs": { "images": ["12", 0], "fps": 25 }},
  "14": { "class_type": "SaveVideo", "inputs": { "video": ["13", 0], "filename_prefix": "video/ltxv2", "format": "auto", "codec": "auto" }}
}
```

## Camera Control LoRAs

Seven official camera control LoRAs from Lightricks:

| Movement | LoRA File |
|----------|-----------|
| Dolly Left | `ltx-2-19b-lora-camera-control-dolly-left.safetensors` |
| Dolly Right | `ltx-2-19b-lora-camera-control-dolly-right.safetensors` |
| Dolly In | `ltx-2-19b-lora-camera-control-dolly-in.safetensors` |
| Dolly Out | `ltx-2-19b-lora-camera-control-dolly-out.safetensors` |
| Jib Up | `ltx-2-19b-lora-camera-control-jib-up.safetensors` |
| Jib Down | `ltx-2-19b-lora-camera-control-jib-down.safetensors` |
| Static | `ltx-2-19b-lora-camera-control-static.safetensors` |

**Usage**: Apply with `LoraLoaderModelOnly` at strength **1.0**. Do NOT describe camera movement in your prompt — the LoRA handles it.

```json
{
  "class_type": "LoraLoaderModelOnly",
  "inputs": {
    "model": ["<checkpoint>", 0],
    "lora_name": "ltx-2-19b-lora-camera-control-dolly-left.safetensors",
    "strength_model": 1.0
  }
}
```

**Cannot combine** camera control LoRA with IC-LoRA (canny/depth/pose) in the same generation.

## Concept/Style LoRAs

Apply with `LoraLoaderModelOnly`. Typical strength: 0.5–1.0.

```json
{
  "class_type": "LoraLoaderModelOnly",
  "inputs": {
    "model": ["<checkpoint_or_camera_lora>", 0],
    "lora_name": "LTXV2\\concept\\LTX-2 - Better Female Nudity.safetensors",
    "strength_model": 0.8
  }
}
```

Concept/style LoRAs CAN be stacked with camera control LoRAs.

## VRAM Considerations

| Config | VRAM | Notes |
|--------|------|-------|
| bf16 checkpoint + FP4 Gemma | ~24GB+ | Tight on RTX 4090, may OOM |
| FP8 checkpoint + FP4 Gemma | ~16-20GB | Recommended for 24GB GPUs |
| bf16 + tiled VAE decode | ~22GB | Use `LTXVSpatioTemporalTiledVAEDecode` |

**VRAM warnings from MEMORY.md**: "LTXV2 can OOM on 24GB — suggest FP8 quantized models or --lowvram"

### Tips for 24GB GPUs

1. Use `VAEDecodeTiled` or `LTXVSpatioTemporalTiledVAEDecode` instead of standard `VAEDecode`
2. Start at 768x512 resolution, upscale in Stage 2
3. Use FP4 Gemma text encoder (installed)
4. Consider GGUF quantized models for tighter VRAM budgets
5. **Always `clear_vram`** before switching to LTX-V2 from another model family
6. Reduce frame count to 81 or 49 if OOM persists

## Prompt Style

Natural language descriptions. Be specific about motion, camera angles, and temporal progression:

```
Good: "A woman with flowing auburn hair walks through a sun-dappled forest, leaves falling gently around her, soft golden hour lighting, cinematic depth of field"
Bad: "woman, forest, walking"
```

Describe the **entire scene progression**, not just a single moment. Include lighting, mood, and motion cues.

## Two-Stage Upscale Pattern

For production quality, generate at low resolution then upscale:

1. **Stage 1**: Generate at 768x512, 121 frames, 8 steps (distilled)
2. **Upscale**: `LTXVLatentUpsampler` (2x spatial) → 1536x1024
3. **Stage 2**: Resample the upscaled latent with 3-4 steps at CFG 1.0
4. **Decode**: Use tiled VAE decode for the larger resolution

This requires the spatial upscaler model: `ltx-2-spatial-upscaler-x2-1.0.safetensors` (place in `models/latent_upscale_models/`).

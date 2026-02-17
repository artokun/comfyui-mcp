---
name: wan-flf-video
description: Build WAN 2.2 First-Last-Frame video workflows — native dual hi-lo (required), and WanVideoWrapper VACE approaches
globs:
  - "**/*.json"
---

# WAN 2.2 First-Last-Frame (FLF) Video Workflows

## Overview

First-Last-Frame (FLF) video generation takes a start image and an end image and generates a smooth video transition between them. WAN 2.2 I2V (Image-to-Video) 14B model excels at this.

## CRITICAL: Dual Hi-Lo Architecture (REQUIRED)

**WAN 2.2 I2V uses a split-noise architecture.** Unlike WAN 2.1, the 2.2 model was trained with separate HighNoise and LowNoise components that handle different denoising ranges. **You MUST use both models in a two-pass KSamplerAdvanced setup.** Using a single model produces low-quality, broken output.

- **HighNoise model** (pass 1, steps 0→N/2): Establishes structure, motion, and composition
- **LowNoise model** (pass 2, steps N/2→N): Refines details and ensures fidelity to input frames
- Both passes share the same conditioning from `WanFirstLastFrameToVideo`
- Pass 1 returns noisy latent → Pass 2 continues from there

**NEVER use a single KSampler with only one model for WAN 2.2 I2V.**

Two native approaches are available:
1. **Native Dual Hi-Lo (Default)** — `WanFirstLastFrameToVideo` + dual `KSamplerAdvanced` two-pass
2. **WanVideoWrapper** — `WanVideoVACEStartToEndFrame` + `WanVideoVACEEncode` + `WanVideoSampler` (VACE, caching, context windows)

## Models

### UNET Pairs (Always load BOTH Hi and Lo)

**Remix NSFW (Recommended — built-in lightning, fp16):**
| Model | Loader | Notes |
|-------|--------|-------|
| `Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp16_v2.1.safetensors` | `UNETLoader` | HighNoise, built-in lightning acceleration |
| `Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp16_v2.1.safetensors` | `UNETLoader` | LowNoise, built-in lightning acceleration |

**GGUF Q8 (Alternative — needs external lightning LoRAs):**
| Model | Loader | Notes |
|-------|--------|-------|
| `Wan2.2-I2V-A14B-HighNoise-Q8_0.gguf` | `UnetLoaderGGUF` | HighNoise, quantized |
| `Wan2.2-I2V-A14B-LowNoise-Q8_0.gguf` | `UnetLoaderGGUF` | LowNoise, quantized |

**Official fp8:**
| Model | Loader | Notes |
|-------|--------|-------|
| `wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` | `UNETLoader` | HighNoise, needs lightning LoRA |
| `wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` | `UNETLoader` | LowNoise, needs lightning LoRA |

### Text Encoder

| Model | Node | Notes |
|-------|------|-------|
| `nsfw_wan_umt5-xxl_bf16_fixed.safetensors` | `CLIPLoaderGGUF` (type=`wan`) | NSFW-tuned, pair with Remix models |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `CLIPLoader` (type=`wan`) | Standard UMT5-XXL fp8 |

### CLIP Vision + VAE

| Component | Node | Model |
|-----------|------|-------|
| **CLIP Vision** | `CLIPVisionLoader` | `clip_vision_h.safetensors` |
| **VAE** | `VAELoader` | `wan_2.1_vae.safetensors` |

## ModelSamplingSD3 (REQUIRED)

WAN 2.2 uses flow matching and requires `ModelSamplingSD3` applied to **each** UNET:

```json
{"class_type": "ModelSamplingSD3", "inputs": {"model": ["<unet>", 0], "shift": 5}}
```

**shift=5** for lightning/Remix models. shift=8 for standard (non-lightning) models.

## Lightning LoRAs

**Remix NSFW models have lightning baked in — no external LoRA needed.**

For GGUF/fp8 models, use paired hi/lo lightning LoRAs:
- `wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors` → HighNoise UNET
- `wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors` → LowNoise UNET

## LoRA Stacks (rgthree)

Each model path has two stacked loaders (Common + Specific), each supporting 4 LoRA slots:

```
Hi path: UNETLoader(HN) → ModelSamplingSD3(shift=5) → Hi Common Stack → Hi Lora Stack → MODEL_HI
Lo path: UNETLoader(LN) → ModelSamplingSD3(shift=5) → Lo Common Stack → Lo Lora Stack → MODEL_LO
```

Common stacks hold shared LoRAs (quality/style). Specific stacks hold model-variant LoRAs. Set slots to `"None"` when unused. Even with no LoRAs, include the stacks — they pass CLIP through for text encoding.

## Image Resizing (ImageResizeKJv2)

Input frames MUST be resized to the target video resolution before FLF and CLIPVisionEncode. The end frame inherits width/height from the start frame's resize to ensure matching dimensions.

```json
{"class_type": "ImageResizeKJv2", "inputs": {
  "image": ["<load_image>", 0], "width": 480, "height": 720,
  "upscale_method": "nearest-exact", "keep_proportion": "crop",
  "pad_color": "0, 0, 0", "crop_position": "center", "divisible_by": 2
}}
```

## KSamplerAdvanced Two-Pass Settings

| Parameter | Pass 1 (Hi) | Pass 2 (Lo) |
|-----------|-------------|-------------|
| model | Hi LoRA stack output | Lo LoRA stack output |
| add_noise | **enable** | **disable** |
| steps | 4 | 4 |
| cfg | 1 | 1 |
| sampler_name | **uni_pc** | **uni_pc** |
| scheduler | **beta** | **beta** |
| start_at_step | 0 | 2 |
| end_at_step | 2 | 4 |
| return_with_leftover_noise | **enable** | **disable** |
| latent_image | WanFLF output[2] | **Pass 1 output[0]** |

Both passes share the same positive/negative conditioning from `WanFirstLastFrameToVideo` outputs [0] and [1].

**For standard (non-lightning) models**: steps=20, split at step 10, cfg=4, sampler=euler, scheduler=simple, shift=8.

## Negative Prompt (REQUIRED)

Always include a quality negative prompt:

```
The tones are vibrant, overexposed, static, details are unclear, subtitles, style, work, painting, image, still, overall grayish, worst quality, low quality, JPEG compression artifacts, ugly, incomplete, extra fingers, poorly drawn hands, poorly drawn faces, deformed, disfigured, distorted limbs, merged fingers, motionless image, cluttered background, three legs, many people in the background, walking backwards
```

## Node: WanFirstLastFrameToVideo

```
Required Inputs:
  - positive: CONDITIONING (from CLIPTextEncode)
  - negative: CONDITIONING (from CLIPTextEncode with negative prompt)
  - vae: VAE
  - width: INT (from ImageResizeKJv2 end frame output[1])
  - height: INT (from ImageResizeKJv2 end frame output[2])
  - length: INT (default 81, step 4) — number of frames
  - batch_size: INT (default 1)

Optional Inputs:
  - clip_vision_start_image: CLIP_VISION_OUTPUT (from CLIPVisionEncode)
  - clip_vision_end_image: CLIP_VISION_OUTPUT (from CLIPVisionEncode)
  - start_image: IMAGE (resized start frame)
  - end_image: IMAGE (resized end frame)

Outputs:
  - [0] positive: CONDITIONING → feed to BOTH Hi and Lo KSamplerAdvanced
  - [1] negative: CONDITIONING → feed to BOTH Hi and Lo KSamplerAdvanced
  - [2] latent: LATENT → feed to Hi Pass only (Lo Pass gets Hi Pass output)
```

## Pipeline Flow

```
UNETLoader (HighNoise) → ModelSamplingSD3 (shift=5) → Hi Common Stack → Hi Lora Stack → MODEL_HI
UNETLoader (LowNoise) → ModelSamplingSD3 (shift=5) → Lo Common Stack → Lo Lora Stack → MODEL_LO
CLIPLoaderGGUF (wan) → CLIP
  ├─ CLIPTextEncode (positive) → CONDITIONING
  └─ CLIPTextEncode (negative) → CONDITIONING
CLIPVisionLoader → CLIPVisionEncode (start) + CLIPVisionEncode (end)
VAELoader → VAE
LoadImage (start) → ImageResizeKJv2 (480x720) → resized start
LoadImage (end) → ImageResizeKJv2 (match dims) → resized end

WanFirstLastFrameToVideo (positive, negative, vae, clip_vision_start, clip_vision_end,
  start_image, end_image, width/height from resize)
  → modified positive [0], modified negative [1], latent [2]

KSamplerAdvanced (Hi: MODEL_HI, steps 0→2, add_noise=enable, return_leftover=enable)
  → noisy LATENT
KSamplerAdvanced (Lo: MODEL_LO, steps 2→4, add_noise=disable, return_leftover=disable)
  → final LATENT

VAEDecode → IMAGE → VHS_VideoCombine (raw output)
                   → VRAM_Debug → SeedVR2VideoUpscaler (1080p) → VHS_VideoCombine (upscaled)
```

## Complete Workflow: Native FLF (Remix NSFW + Lightning)

```json
{
  "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp16_v2.1.safetensors", "weight_dtype": "default" }, "_meta": { "title": "UNET HighNoise" }},
  "2": { "class_type": "UNETLoader", "inputs": { "unet_name": "Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp16_v2.1.safetensors", "weight_dtype": "default" }, "_meta": { "title": "UNET LowNoise" }},
  "3": { "class_type": "CLIPLoaderGGUF", "inputs": { "clip_name": "nsfw_wan_umt5-xxl_bf16_fixed.safetensors", "type": "wan" }},
  "4": { "class_type": "CLIPVisionLoader", "inputs": { "clip_name": "clip_vision_h.safetensors" }},
  "5": { "class_type": "VAELoader", "inputs": { "vae_name": "wan_2.1_vae.safetensors" }},
  "6": { "class_type": "LoadImage", "inputs": { "image": "<start_image.png>" }, "_meta": { "title": "Start Frame" }},
  "7": { "class_type": "LoadImage", "inputs": { "image": "<end_image.png>" }, "_meta": { "title": "End Frame" }},
  "8": { "class_type": "ModelSamplingSD3", "inputs": { "model": ["1", 0], "shift": 5 }, "_meta": { "title": "Hi Shift" }},
  "9": { "class_type": "ModelSamplingSD3", "inputs": { "model": ["2", 0], "shift": 5 }, "_meta": { "title": "Lo Shift" }},
  "10": { "class_type": "Lora Loader Stack (rgthree)", "inputs": {
    "model": ["8", 0], "clip": ["3", 0],
    "lora_01": "None", "strength_01": 1, "lora_02": "None", "strength_02": 1,
    "lora_03": "None", "strength_03": 1, "lora_04": "None", "strength_04": 1
  }, "_meta": { "title": "Hi Common" }},
  "11": { "class_type": "Lora Loader Stack (rgthree)", "inputs": {
    "model": ["10", 0], "clip": ["10", 1],
    "lora_01": "None", "strength_01": 1, "lora_02": "None", "strength_02": 1,
    "lora_03": "None", "strength_03": 1, "lora_04": "None", "strength_04": 1
  }, "_meta": { "title": "Hi Lora" }},
  "12": { "class_type": "Lora Loader Stack (rgthree)", "inputs": {
    "model": ["9", 0], "clip": ["3", 0],
    "lora_01": "None", "strength_01": 1, "lora_02": "None", "strength_02": 1,
    "lora_03": "None", "strength_03": 1, "lora_04": "None", "strength_04": 1
  }, "_meta": { "title": "Low Common" }},
  "13": { "class_type": "Lora Loader Stack (rgthree)", "inputs": {
    "model": ["12", 0], "clip": ["12", 1],
    "lora_01": "None", "strength_01": 1, "lora_02": "None", "strength_02": 1,
    "lora_03": "None", "strength_03": 1, "lora_04": "None", "strength_04": 1
  }, "_meta": { "title": "Low Lora" }},
  "14": { "class_type": "ImageResizeKJv2", "inputs": {
    "image": ["6", 0], "width": 480, "height": 720,
    "upscale_method": "nearest-exact", "keep_proportion": "crop",
    "pad_color": "0, 0, 0", "crop_position": "center", "divisible_by": 2
  }, "_meta": { "title": "Resize Start" }},
  "15": { "class_type": "ImageResizeKJv2", "inputs": {
    "image": ["7", 0], "width": ["14", 1], "height": ["14", 2],
    "upscale_method": "nearest-exact", "keep_proportion": "crop",
    "pad_color": "0, 0, 0", "crop_position": "center", "divisible_by": 2
  }, "_meta": { "title": "Resize End" }},
  "16": { "class_type": "CLIPVisionEncode", "inputs": { "clip_vision": ["4", 0], "image": ["14", 0], "crop": "center" }},
  "17": { "class_type": "CLIPVisionEncode", "inputs": { "clip_vision": ["4", 0], "image": ["15", 0], "crop": "center" }},
  "18": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["11", 1], "text": "<positive prompt>" }, "_meta": { "title": "Positive" }},
  "19": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["11", 1], "text": "The tones are vibrant, overexposed, static, details are unclear, subtitles, style, work, painting, image, still, overall grayish, worst quality, low quality, JPEG compression artifacts, ugly, incomplete, extra fingers, poorly drawn hands, poorly drawn faces, deformed, disfigured, distorted limbs, merged fingers, motionless image, cluttered background, three legs, many people in the background, walking backwards" }, "_meta": { "title": "Negative" }},
  "20": { "class_type": "WanFirstLastFrameToVideo", "inputs": {
    "positive": ["18", 0], "negative": ["19", 0], "vae": ["5", 0],
    "clip_vision_start_image": ["16", 0], "clip_vision_end_image": ["17", 0],
    "start_image": ["14", 0], "end_image": ["15", 0],
    "width": ["15", 1], "height": ["15", 2], "length": 81, "batch_size": 1
  }},
  "21": { "class_type": "KSamplerAdvanced", "inputs": {
    "model": ["11", 0], "positive": ["20", 0], "negative": ["20", 1], "latent_image": ["20", 2],
    "add_noise": "enable", "noise_seed": 0, "steps": 4, "cfg": 1,
    "sampler_name": "uni_pc", "scheduler": "beta",
    "start_at_step": 0, "end_at_step": 2, "return_with_leftover_noise": "enable"
  }, "_meta": { "title": "Hi Pass" }},
  "22": { "class_type": "KSamplerAdvanced", "inputs": {
    "model": ["13", 0], "positive": ["20", 0], "negative": ["20", 1], "latent_image": ["21", 0],
    "add_noise": "disable", "noise_seed": 0, "steps": 4, "cfg": 1,
    "sampler_name": "uni_pc", "scheduler": "beta",
    "start_at_step": 2, "end_at_step": 4, "return_with_leftover_noise": "disable"
  }, "_meta": { "title": "Lo Pass" }},
  "23": { "class_type": "VAEDecode", "inputs": { "samples": ["22", 0], "vae": ["5", 0] }},
  "24": { "class_type": "VHS_VideoCombine", "inputs": {
    "images": ["23", 0], "frame_rate": 16, "loop_count": 0,
    "filename_prefix": "wan_flf", "format": "video/h264-mp4",
    "pingpong": false, "save_output": true,
    "pix_fmt": "yuv420p", "crf": 19, "save_metadata": true, "trim_to_audio": false
  }}
}
```

## Optional: Video Upscaling with SeedVR2

Add after `VAEDecode` for AI-powered video upscaling to 1080p. Use `VRAM_Debug` to free VRAM between generation and upscaling:

```json
{
  "25": { "class_type": "VRAM_Debug", "inputs": {
    "image_pass": ["23", 0], "empty_cache": true, "gc_collect": true, "unload_all_models": true
  }},
  "26": { "class_type": "SeedVR2LoadDiTModel", "inputs": {
    "model": "seedvr2_ema_3b_fp8_e4m3fn.safetensors", "device": "cuda:0",
    "blocks_to_swap": 0, "swap_io_components": false, "cache_model": false, "attention_mode": "sdpa"
  }},
  "27": { "class_type": "SeedVR2LoadVAEModel", "inputs": {
    "model": "ema_vae_fp16.safetensors", "device": "cuda:0",
    "encode_tiled": false, "decode_tiled": false, "cache_model": false
  }},
  "28": { "class_type": "SeedVR2VideoUpscaler", "inputs": {
    "image": ["25", 1], "dit": ["26", 0], "vae": ["27", 0],
    "seed": 0, "resolution": 1080, "max_resolution": 0,
    "batch_size": 5, "uniform_batch_size": false, "color_correction": "lab"
  }},
  "29": { "class_type": "VHS_VideoCombine", "inputs": {
    "images": ["28", 0], "frame_rate": 16, "loop_count": 0,
    "filename_prefix": "wan_flf_upscaled", "format": "video/h264-mp4",
    "pingpong": false, "save_output": true,
    "pix_fmt": "yuv420p", "crf": 19, "save_metadata": true, "trim_to_audio": false
  }}
}
```

## Alternative: GGUF Models with Lightning LoRAs

When using GGUF Q8 models instead of Remix, add paired lightning LoRAs:

```
Hi path: UnetLoaderGGUF(HN Q8) → ModelSamplingSD3(shift=5) → LoraLoaderModelOnly(hi_noise_lightning) → Hi Common Stack → Hi Lora Stack
Lo path: UnetLoaderGGUF(LN Q8) → ModelSamplingSD3(shift=5) → LoraLoaderModelOnly(lo_noise_lightning) → Lo Common Stack → Lo Lora Stack
```

LoRA files:
- `Unknown\no tags\wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors`
- `Unknown\no tags\wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors`

## Approach 2: WanVideoWrapper (Advanced Control)

Uses the WanVideoWrapper custom node pack for more control over conditioning, caching, context windows, and advanced features.

### Key Differences from Native

- Uses `WANVIDEOMODEL` type instead of generic `MODEL`
- Uses `WANVIDIMAGE_EMBEDS` for conditioning instead of `CONDITIONING`
- Has own sampler (`WanVideoSampler`) with shift parameter and scheduler options
- Supports TeaCache, MagCache, EasyCache for speed optimization
- Supports context windows for longer videos
- VACE module provides more flexible frame conditioning

### VACE-Based FLF Pipeline

```
WanVideoModelLoader → WANVIDEOMODEL
WanVideoVAELoader → WANVAE
WanVideoTextEncode → WANVIDEOTEXTEMBEDS
WanVideoClipVisionEncode (start + end images) → WANVIDIMAGE_CLIPEMBEDS

WanVideoVACEStartToEndFrame (start_image, end_image, num_frames=81)
  → images batch, masks

WanVideoVACEEncode (vae, input_frames, input_masks, width, height, num_frames)
  → WANVIDIMAGE_EMBEDS (vace_embeds)

WanVideoSampler (model, image_embeds, text_embeds, steps, cfg, shift, scheduler)
  → LATENT

WanVideoDecode (vae, samples) → IMAGE → VHS_VideoCombine → MP4
```

### WanVideoSampler Settings

| Parameter | Standard | Lightning | Notes |
|-----------|----------|-----------|-------|
| steps | 30 | 4 | |
| cfg | 6.0 | 1.0 | |
| shift | 5.0 | 5.0 | Flow matching shift |
| scheduler | unipc | euler | WanVideoWrapper has own schedulers |
| force_offload | true | true | Move model to CPU after sampling |

### When to Use WanVideoWrapper vs Native

| Feature | Native | WanVideoWrapper |
|---------|--------|-----------------|
| Simplicity | Simpler | More complex |
| Dual Hi-Lo | Manual two-pass | May handle internally |
| LoRA loading | Lora Loader Stack (rgthree) | WanVideoLoraSelect / WanVideoSetLoRAs |
| Caching (TeaCache) | Not available | Built-in |
| Context windows | Not available | WanVideoContextOptions |
| Block swap (VRAM) | Not available | WanVideoBlockSwap |
| VACE conditioning | Not available | Full VACE support |
| Long video (>81 frames) | Limited | InfiniteTalk / context windows |

**Recommendation**: Use **Native dual hi-lo** for standard FLF transitions. Use **WanVideoWrapper** when you need caching, context windows, VRAM management, or advanced conditioning.

## Resolution & Frame Count

### Standard Resolutions

| Aspect | Resolution | Megapixels |
|--------|-----------|------------|
| Portrait 2:3 | 480x720 | 0.35MP (recommended default) |
| Landscape 16:9 | 832x480 | 0.4MP |
| Portrait 9:16 | 480x832 | 0.4MP |
| Square | 640x640 | 0.4MP |

**Width and height must be divisible by 16.** Use `ImageResizeKJv2` with `divisible_by: 2` and `keep_proportion: crop`.

### Frame Count

- **81 frames** at 16fps = ~5 seconds (default, recommended)
- **49 frames** at 16fps = ~3 seconds (faster, less motion)
- **121 frames** at 16fps = ~7.5 seconds (longer, more VRAM)
- Frame count should be `4n + 1` (1, 5, 9, ..., 49, 81, 121)

### Frame Rate

Standard: **16 fps** for WAN 2.2 output.

## Video Output

### VHS_VideoCombine

```json
{
  "class_type": "VHS_VideoCombine",
  "inputs": {
    "images": ["<vae_decode>", 0],
    "frame_rate": 16,
    "loop_count": 0,
    "filename_prefix": "wan_flf",
    "format": "video/h264-mp4",
    "pingpong": false,
    "save_output": true,
    "pix_fmt": "yuv420p",
    "crf": 19,
    "save_metadata": true,
    "trim_to_audio": false
  }
}
```

## VRAM Considerations

### Dual Hi-Lo with Remix fp16

- Two UNETs loaded sequentially (ComfyUI offloads between passes): ~14GB each
- NSFW UMT5-XXL bf16: ~8GB (offloaded after text encoding)
- CLIP Vision H: ~1.5GB (offloaded after encoding)
- VAE: ~200MB
- Latent (81 frames at 480x720): ~1-2GB

ComfyUI manages VRAM by offloading models between passes. The Hi UNET is offloaded before the Lo UNET loads.

### Tips

1. **Always `clear_vram`** before switching to WAN from another model family
2. Use `VRAM_Debug` node between generation and SeedVR2 upscaling to free all VRAM
3. For 24GB GPUs, 81 frames at 480x720 is the practical maximum
4. Remix NSFW models have lightning baked in — no separate LoRA needed, 4 steps total

## Morph LoRAs (Smooth Metamorphosis)

By default, FLF produces a **transition/dissolve** between frames. For true **morphing** (one shape seamlessly reshaping into another), use a morph LoRA on both Hi and Lo paths.

### Magical Morph (Recommended)

| Variant | File | Strength | Notes |
|---------|------|----------|-------|
| HighNoise | `wan2.2_i2v_magical_morph_highnoise.safetensors` | 0.7-1.0 | Apply to Hi Common stack |
| LowNoise | `wan2.2_i2v_magical_morph_lownoise.safetensors` | 0.7-1.0 | Apply to Lo Common stack |

- Source: [NikolaSigmoid/wan2.2-i2v-loras-magical-morph](https://huggingface.co/NikolaSigmoid/wan2.2-i2v-loras-magical-morph)
- No trigger word needed — the LoRA modifies the denoising behavior
- **Strength 1.0** can add visual sparkle/particle effects. Reduce to 0.7-0.8 for cleaner morphs
- Works with Remix NSFW models (no conflict with built-in lightning)

### SkinMorph Redmond (Alternative — Face/Body Focus)

For person-to-person morphs (identity, gender transforms):
- Trigger word: `Skin morph`
- Strength: 0.8-1.0
- Source: [CivitAI](https://civitai.com/models/2210162/wan22-skinmorph-redmond-i2v-14b)

## Prompt Tips

Describe the **transition motion**, not just the start/end states:

```
Good: "A small cat sitting on the ground smoothly transforms and grows into a woman standing tall, seamless transformation, cinematic"
Bad: "A cat and a girl"
```

**IMPORTANT — Prompt language affects visuals:**
- **AVOID** words like "magical", "enchanted", "mystical" — they cause literal sparkle/particle effects
- **USE** clean motion language: "smoothly transforms", "gradually reshapes", "seamlessly morphs", "transitions into"
- The morph LoRA handles the morphing effect — the prompt should describe **motion and form change**, not style
- Include scale/position cues when subjects differ in size: "grows into", "expands upward", "shrinks down"

## Settings Quick Reference

| Config | Lightning (Remix) | Standard |
|--------|------------------|----------|
| Models | Remix NSFW Hi+Lo fp16 | Official Hi+Lo fp8 |
| CLIP | nsfw_wan_umt5-xxl_bf16_fixed | umt5_xxl_fp8_e4m3fn_scaled |
| ModelSamplingSD3 shift | 5 | 8 |
| Total steps | 4 | 20 |
| Hi pass end_at_step | 2 | 10 |
| CFG | 1 | 4 |
| Sampler | uni_pc | euler |
| Scheduler | beta | simple |
| External LoRA needed | No (built-in) | Yes (paired hi/lo) |

## Multi-Step Pipeline Pattern

### Anchor Frame Strategy (Proportions)

When the start and end frames have different subject sizes (e.g., small cat → tall person), **generate the "anchor" frame first** — the one with the most complex composition — then use Qwen Edit to create the other frame from it. This ensures:
- Consistent background/scene between frames
- Correct relative proportions (the edit inherits the scene scale)
- Better FLF results since both frames share the same visual context

**Example — Cat-to-Girl Morph:**
1. Generate **girl standing in front of barn** with Z-Image (she fills the frame)
2. Qwen Edit: "Replace the woman with a small cat sitting at the bottom of the image"
3. FLF: cat (start) → girl (end) — proportions are correct because the barn establishes scale

**Anti-pattern:** Generating cat and girl independently produces mismatched scale.

### Full Pipeline

1. **Generate anchor frame** with Z-Image/SDXL/Flux (portrait orientation for standing subjects)
2. **Qwen Edit to create second frame** — the edit preserves scene context
3. **Clear VRAM** between model families
4. **Upload both frames** with `upload_image`
5. **Run dual hi-lo FLF** with morph LoRA if morphing is desired
6. **Optionally upscale** with SeedVR2 to 1080p

Proven timing on RTX 4090: Z-Image (35s) → Qwen Edit (78s) → WAN FLF 81 frames (139s) = **~4 minutes total**.

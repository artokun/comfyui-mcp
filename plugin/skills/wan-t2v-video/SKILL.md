---
name: wan-t2v-video
description: Build WAN 2.2 Text-to-Video workflows — dual hi-lo models, lightning LoRAs, VACE modules, and KSamplerAdvanced two-pass
globs:
  - "**/*.json"
---

# WAN 2.2 Text-to-Video (T2V) Workflows

## Overview

WAN 2.2 T2V generates videos from text prompts using a 14B parameter MoE (Mixture of Experts) architecture split across two specialized models:

- **HighNoise model**: Handles early denoising — establishes structure, motion, composition
- **LowNoise model**: Handles late denoising — refines details, sharpens output

This dual-model technique is the same as FLF/I2V (see wan-flf-video skill) but without image conditioning nodes.

**Key difference from I2V/FLF**: T2V does NOT use `CLIPVisionEncode`, `WanFirstLastFrameToVideo`, or any image input. It uses `EmptyHunyuanLatentVideo` for latent initialization and text-only conditioning.

## Models

### UNET (Installed)

| Model | Loader | Notes |
|-------|--------|-------|
| `Wan2_2-T2V-A14B_HIGH_fp8_e4m3fn_scaled_KJ.safetensors` | `UNETLoader` | HighNoise expert, 14.3GB FP8 |
| `Wan2_2-T2V-A14B-LOW_fp8_e4m3fn_scaled_KJ.safetensors` | `UNETLoader` | LowNoise expert, 14.3GB FP8 |

### Text Encoder

| Component | Node | Model | Notes |
|-----------|------|-------|-------|
| **CLIP (T5)** | `CLIPLoader` (type=`wan`) | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | UMT5-XXL fp8, in clip/ |

### VAE

| Component | Node | Model |
|-----------|------|-------|
| **VAE** | `VAELoader` | `wan_2.1_vae.safetensors` |

### VACE Modules (Installed — For Advanced Control)

| Model | Size | Notes |
|-------|------|-------|
| `Wan2_2_Fun_VACE_module_A14B_HIGH_bf16.safetensors` | 5.8GB | HighNoise VACE module |
| `Wan2_2_Fun_VACE_module_A14B_LOW_bf16.safetensors` | 5.8GB | LowNoise VACE module |

VACE modules add reference image / pose / depth conditioning to T2V. See WanVideoWrapper section below.

## Lightning LoRAs (Installed)

### T2V Lightning v1.1 (Paired Hi/Lo)

| LoRA | Applies To | Path |
|------|-----------|------|
| `wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise` | HighNoise UNET | `Unknown/no tags/` |
| `wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise` | LowNoise UNET | `Unknown/no tags/` |

### T2V Lightning Seko V2.0 (Alternative Paired)

| LoRA | Path |
|------|------|
| `Wan2.2_HN_T2V_Lightning_4steps-lora-rank64-Seko_V2.0_HIGH` | Root loras/ |
| `Wan2.2_HN_T2V_Lightning_4steps-lora-rank64-Seko_V2.0_LOW` | Root loras/ |

### T2V CFG-Step Distill (Higher Quality)

| LoRA | Path | Notes |
|------|------|-------|
| `lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank128_bf16` | Root loras/ | CFG+step distilled, use with more steps |

## Sampler Settings

### Lightning (4-Step, Recommended for Speed)

| Parameter | Pass 1 (Hi) | Pass 2 (Lo) |
|-----------|-------------|-------------|
| model | Hi + Hi Lightning LoRA | Lo + Lo Lightning LoRA |
| add_noise | enable | disable |
| steps | 4 | 4 |
| cfg | 1.0 | 1.0 |
| sampler_name | euler | euler |
| scheduler | simple | simple |
| start_at_step | 0 | 2 |
| end_at_step | 2 | 4 |
| return_with_leftover_noise | enable | disable |

### Standard (20-Step, Full Quality)

| Parameter | Pass 1 (Hi) | Pass 2 (Lo) |
|-----------|-------------|-------------|
| model | Hi + ModelSamplingSD3 (shift=8) | Lo + ModelSamplingSD3 (shift=8) |
| add_noise | enable | disable |
| steps | 20 | 20 |
| cfg | 3.5 | 3.5 |
| sampler_name | euler | euler |
| scheduler | simple | simple |
| start_at_step | 0 | 10 |
| end_at_step | 10 | 20 |
| return_with_leftover_noise | enable | disable |

### ModelSamplingSD3

Required for WAN 2.2 flow matching. Apply to BOTH models:

```json
{
  "class_type": "ModelSamplingSD3",
  "inputs": { "model": ["<unet>", 0], "shift": 8 }
}
```

**T2V shift values**:
- Standard: **shift=8** (good balance of motion and detail)
- Lightning: **shift=5** (lower shift for distilled models)
- Range 6–9: Higher shift = more detail, lower shift = stronger motion

## EmptyHunyuanLatentVideo

Creates the initial video latent for T2V (no image input):

```json
{
  "class_type": "EmptyHunyuanLatentVideo",
  "inputs": {
    "width": 832,
    "height": 480,
    "length": 81,
    "batch_size": 1
  }
}
```

This replaces `WanFirstLastFrameToVideo` (which is for FLF/I2V only). The latent goes directly to KSamplerAdvanced Pass 1.

## Negative Prompt

```
The tones are vibrant, overexposed, static, details are unclear, subtitles, style, work, painting, image, still, overall grayish, worst quality, low quality, JPEG compression artifacts, ugly, incomplete, extra fingers, poorly drawn hands, poorly drawn faces, deformed, disfigured, distorted limbs, merged fingers, motionless image, cluttered background, three legs, many people in the background, walking backwards
```

## Pipeline Flow

```
UNETLoader (HIGH T2V) → ModelSamplingSD3 (shift) → LoraLoaderModelOnly (Hi Lightning) → MODEL_HI
UNETLoader (LOW T2V) → ModelSamplingSD3 (shift) → LoraLoaderModelOnly (Lo Lightning) → MODEL_LO
CLIPLoader (wan) → CLIP
  ├─ CLIPTextEncode (positive) → CONDITIONING
  └─ CLIPTextEncode (negative) → CONDITIONING
VAELoader → VAE

EmptyHunyuanLatentVideo (832x480, 81 frames) → LATENT

KSamplerAdvanced (Hi: MODEL_HI, steps 0-2, add_noise=enable, return_leftover=enable)
  → noisy LATENT
KSamplerAdvanced (Lo: MODEL_LO, steps 2-4, add_noise=disable, return_leftover=disable)
  → final LATENT

VAEDecode → IMAGE → VHS_VideoCombine → MP4
```

## Complete Workflow: T2V Lightning (4-Step)

```json
{
  "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "Wan2_2-T2V-A14B_HIGH_fp8_e4m3fn_scaled_KJ.safetensors", "weight_dtype": "default" }, "_meta": { "title": "UNET HighNoise T2V" }},
  "2": { "class_type": "UNETLoader", "inputs": { "unet_name": "Wan2_2-T2V-A14B-LOW_fp8_e4m3fn_scaled_KJ.safetensors", "weight_dtype": "default" }, "_meta": { "title": "UNET LowNoise T2V" }},
  "3": { "class_type": "ModelSamplingSD3", "inputs": { "model": ["1", 0], "shift": 5 }, "_meta": { "title": "Hi Shift" }},
  "4": { "class_type": "ModelSamplingSD3", "inputs": { "model": ["2", 0], "shift": 5 }, "_meta": { "title": "Lo Shift" }},
  "5": { "class_type": "LoraLoaderModelOnly", "inputs": {
    "model": ["3", 0],
    "lora_name": "Unknown\\no tags\\wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors",
    "strength_model": 1.0
  }, "_meta": { "title": "Hi Lightning" }},
  "6": { "class_type": "LoraLoaderModelOnly", "inputs": {
    "model": ["4", 0],
    "lora_name": "Unknown\\no tags\\wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors",
    "strength_model": 1.0
  }, "_meta": { "title": "Lo Lightning" }},
  "7": { "class_type": "CLIPLoader", "inputs": { "clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan" }},
  "8": { "class_type": "VAELoader", "inputs": { "vae_name": "wan_2.1_vae.safetensors" }},
  "9": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["7", 0], "text": "<positive prompt describing the video scene and motion>" }, "_meta": { "title": "Positive" }},
  "10": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["7", 0], "text": "The tones are vibrant, overexposed, static, details are unclear, subtitles, worst quality, low quality, motionless image" }, "_meta": { "title": "Negative" }},
  "11": { "class_type": "EmptyHunyuanLatentVideo", "inputs": {
    "width": 832, "height": 480, "length": 81, "batch_size": 1
  }},
  "12": { "class_type": "KSamplerAdvanced", "inputs": {
    "model": ["5", 0],
    "positive": ["9", 0],
    "negative": ["10", 0],
    "latent_image": ["11", 0],
    "add_noise": "enable", "noise_seed": 0, "steps": 4, "cfg": 1,
    "sampler_name": "euler", "scheduler": "simple",
    "start_at_step": 0, "end_at_step": 2, "return_with_leftover_noise": "enable"
  }, "_meta": { "title": "Hi Pass" }},
  "13": { "class_type": "KSamplerAdvanced", "inputs": {
    "model": ["6", 0],
    "positive": ["9", 0],
    "negative": ["10", 0],
    "latent_image": ["12", 0],
    "add_noise": "disable", "noise_seed": 0, "steps": 4, "cfg": 1,
    "sampler_name": "euler", "scheduler": "simple",
    "start_at_step": 2, "end_at_step": 4, "return_with_leftover_noise": "disable"
  }, "_meta": { "title": "Lo Pass" }},
  "14": { "class_type": "VAEDecode", "inputs": { "samples": ["13", 0], "vae": ["8", 0] }},
  "15": { "class_type": "VHS_VideoCombine", "inputs": {
    "images": ["14", 0], "frame_rate": 16, "loop_count": 0,
    "filename_prefix": "wan_t2v", "format": "video/h264-mp4",
    "pingpong": false, "save_output": true,
    "pix_fmt": "yuv420p", "crf": 19, "save_metadata": true, "trim_to_audio": false
  }}
}
```

## Complete Workflow: T2V Standard (20-Step)

Same structure as above but replace the LoRA and sampler settings:

- Remove LoRA nodes (5 and 6) — connect ModelSamplingSD3 outputs directly to KSamplerAdvanced
- Change `shift` to **8** in ModelSamplingSD3 nodes
- Change KSamplerAdvanced settings:
  - `steps`: 20, `cfg`: 3.5
  - Pass 1: `start_at_step`: 0, `end_at_step`: 10
  - Pass 2: `start_at_step`: 10, `end_at_step`: 20

## WanVideoWrapper Approach (Advanced)

For more control, use the WanVideoWrapper custom node pack. Key differences from native:
- Uses `WanVideoModelLoader` → `WANVIDEOMODEL` type
- Uses `WanVideoSampler` with built-in shift parameter
- Supports TeaCache, context windows, block swap for VRAM management

### WanVideoWrapper T2V Pipeline

```
WanVideoModelLoader (T2V model) → WANVIDEOMODEL
WanVideoVAELoader → WANVAE
WanVideoTextEncode (positive + negative prompts) → WANVIDEOTEXTEMBEDS
WanVideoImageToVideoEncode (no images — creates empty embeds for T2V)
  → WANVIDIMAGE_EMBEDS

WanVideoSampler (model, image_embeds, text_embeds, steps, cfg, shift, scheduler)
  → LATENT

WanVideoDecode → IMAGE → VHS_VideoCombine → MP4
```

### WanVideoSampler T2V Settings

| Parameter | Standard | Lightning | Notes |
|-----------|----------|-----------|-------|
| steps | 30 | 4 | |
| cfg | 6.0 | 1.0 | |
| shift | 5.0 | 5.0 | Flow matching shift |
| scheduler | unipc | euler | |
| force_offload | true | true | |

## Concept LoRAs (Installed)

Located in `loras/Wan Video 2.2 T2V-A14B/`:
- `concept/PussyLoRA_HighNoise_Wan2.2_HearmemanAI.safetensors` + LowNoise pair

Apply concept LoRAs the same way as lightning LoRAs — match hi/lo to the correct model pass. Use `LoraLoaderModelOnly` with strength 0.5–1.0.

## Resolution & Frame Count

### Resolutions

| Aspect | Resolution | Notes |
|--------|-----------|-------|
| Landscape 16:9 | 832x480 | Default, recommended |
| Portrait 9:16 | 480x832 | |
| 720p landscape | 1280x720 | Higher quality, more VRAM |
| 720p portrait | 720x1280 | |

Width and height must be **divisible by 16**.

### Frame Count (`4n + 1`)

- **81 frames** at 16fps = ~5 seconds (default, recommended)
- **49 frames** at 16fps = ~3 seconds (faster)
- **121 frames** at 16fps = ~7.5 seconds (longer, more VRAM)

### Frame Rate

Standard: **16 fps** for WAN 2.2 output.

## VRAM Considerations

| Config | VRAM | Notes |
|--------|------|-------|
| Dual FP8 models + UMT5 fp8 | ~22-24GB | Tight on RTX 4090 |
| Single FP8 model (no dual) | ~14-16GB | Lower quality but safer |
| With VACE modules | +5.8GB per module | Very tight, may need block swap |

- **Always `clear_vram`** before switching to WAN T2V from another model family
- Lightning (4 steps) dramatically reduces generation time: ~70s vs ~5-10 min for 20 steps
- Only one UNET is active during each pass — they swap in/out

## Prompt Tips

Describe **motion and temporal progression**, not just a scene:

```
Good: "A beautiful young woman slowly walks through a blooming cherry blossom garden, petals drifting in the breeze, soft sunlight filtering through branches, cinematic slow motion, 4K quality"
Bad: "woman in garden"
```

Include motion cues: "slowly walks", "camera pans", "wind blowing", "gradually reveals"

## T2V vs I2V/FLF Comparison

| Feature | T2V | I2V/FLF |
|---------|-----|---------|
| Input | Text only | Text + start/end images |
| Latent init | EmptyHunyuanLatentVideo | WanFirstLastFrameToVideo |
| CLIPVision | Not used | Required |
| Models | T2V-specific (HIGH/LOW) | I2V-specific (HIGH/LOW) |
| Lightning LoRAs | T2V-specific | I2V-specific |
| Creativity | Full creative freedom | Constrained by input frames |
| Use case | Original content | Transitions, animations |

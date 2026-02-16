---
name: model-compatibility
description: Model family compatibility matrix — loaders, resolutions, samplers, CFG, VAE, ControlNet, and LoRA compatibility for SD 1.5, SDXL, Flux, SD3, and video models
globs:
  - "**/*.json"
---

# ComfyUI Model Compatibility Matrix

## Stable Diffusion 1.5 (SD 1.5)

### Overview

The original widely-adopted Stable Diffusion model. Huge ecosystem of fine-tunes, LoRAs, ControlNets, and embeddings. Still the most compatible and lightweight model family.

### Configuration

| Parameter | Value |
|-----------|-------|
| **Loader** | `CheckpointLoaderSimple` |
| **Native Resolution** | 512x512 |
| **Supported Resolutions** | 512x512, 512x768, 768x512, 768x768 (some fine-tunes) |
| **VAE** | Built-in or external (`vae-ft-mse-840000-ema-pruned.safetensors`) |
| **CLIP** | Single CLIP-L (output index 1 from checkpoint) |
| **Text Encoder Node** | `CLIPTextEncode` |
| **CFG Range** | 7-12 (typical: 7.5) |
| **Negative Prompt** | Yes — very important for quality |
| **Steps** | 20-30 (standard samplers) |
| **Sampler** | All standard samplers: `euler`, `euler_ancestral`, `dpmpp_2m`, `dpmpp_sde`, `ddim` |
| **Scheduler** | `normal`, `karras` |
| **Denoise** | 1.0 (txt2img), 0.5-0.8 (img2img) |
| **VRAM (FP16)** | ~2-3GB |

### Workflow Pattern

```
CheckpointLoaderSimple → MODEL(0), CLIP(1), VAE(2)
  CLIP(1) → CLIPTextEncode (positive) → CONDITIONING
  CLIP(1) → CLIPTextEncode (negative) → CONDITIONING
EmptyLatentImage (width=512, height=512) → LATENT
KSampler (cfg=7.5, steps=20, sampler="euler", scheduler="normal") → LATENT
VAEDecode → IMAGE
SaveImage
```

### VAE Notes

- Most SD 1.5 checkpoints have a built-in VAE, but it's often mediocre
- **Recommended**: Use external `vae-ft-mse-840000-ema-pruned.safetensors` for better color accuracy
- Load via `VAELoader` node and connect to `VAEDecode`
- FP16 VAE can produce NaN on some images — FP32 VAE is more stable

### ControlNet Compatibility

SD 1.5 has the largest ControlNet ecosystem:

| ControlNet | Model File Pattern | Notes |
|------------|-------------------|-------|
| Canny | `control_v11p_sd15_canny` | Edge detection |
| Depth | `control_v11f1p_sd15_depth` | Depth map |
| OpenPose | `control_v11p_sd15_openpose` | Skeleton/pose |
| Scribble | `control_v11p_sd15_scribble` | Hand-drawn lines |
| Lineart | `control_v11p_sd15_lineart` | Clean lines |
| Softedge | `control_v11p_sd15_softedge` | Soft edges (HED) |
| Normal | `control_v11p_sd15_normalbae` | Normal maps |
| Seg | `control_v11p_sd15_seg` | Semantic segmentation |
| Tile | `control_v11f1e_sd15_tile` | Tile/upscale guidance |
| Inpaint | `control_v11p_sd15_inpaint` | Inpainting guidance |
| IP-Adapter | `ip-adapter_sd15` | Image prompt |

### LoRA Compatibility

- SD 1.5 LoRAs ONLY work with SD 1.5 base models
- Format: `.safetensors` in `models/loras/`
- Loader: `LoraLoader` node — connects between checkpoint and CLIPTextEncode
- Strength range: 0.5-1.0 (higher can cause artifacts)

---

## SDXL (Stable Diffusion XL)

### Overview

Major upgrade from SD 1.5 with dual CLIP encoders, higher native resolution, and better prompt understanding. Includes Turbo and Lightning variants for fast generation.

### Configuration — SDXL 1.0 (Base)

| Parameter | Value |
|-----------|-------|
| **Loader** | `CheckpointLoaderSimple` |
| **Native Resolution** | 1024x1024 |
| **Supported Resolutions** | 1024x1024, 832x1216, 1216x832, 896x1152, 1152x896, 768x1344, 1344x768 |
| **VAE** | Built-in (SDXL has good integrated VAE) |
| **CLIP** | Dual CLIP: CLIP-L + CLIP-G |
| **Text Encoder Node** | `CLIPTextEncode` (unified) or `CLIPTextEncodeSDXL` (separate G/L) |
| **CFG Range** | 5-10 (typical: 7.0) |
| **Negative Prompt** | Yes — moderately important |
| **Steps** | 20-40 |
| **Sampler** | `euler`, `euler_ancestral`, `dpmpp_2m`, `dpmpp_sde` |
| **Scheduler** | `normal`, `karras` |
| **Denoise** | 1.0 (txt2img), 0.5-0.8 (img2img) |
| **VRAM (FP16)** | ~6-7GB |

### Configuration — SDXL Turbo

| Parameter | Value |
|-----------|-------|
| **Loader** | `CheckpointLoaderSimple` |
| **Resolution** | 512x512 (optimized for lower res) |
| **CFG** | 1.0-2.0 |
| **Steps** | 1-4 |
| **Sampler** | `euler_ancestral` |
| **Scheduler** | `normal` |
| **Negative Prompt** | Minimal or empty |
| **Denoise** | 1.0 |

### Configuration — SDXL Lightning

| Parameter | Value |
|-----------|-------|
| **Loader** | `CheckpointLoaderSimple` + `LoraLoader` (Lightning LoRA) |
| **Resolution** | 1024x1024 |
| **CFG** | 1.0-2.0 |
| **Steps** | 4-8 (match the Lightning variant: 2-step, 4-step, 8-step) |
| **Sampler** | `euler` |
| **Scheduler** | `sgm_uniform` |
| **Negative Prompt** | Empty or minimal |
| **Special** | Requires matching Lightning LoRA for the step count |

### SDXL Refiner

The optional SDXL refiner model does a second pass to improve fine details:

```
CheckpointLoaderSimple (base) → KSampler (steps=25, start=0, end=20)
CheckpointLoaderSimple (refiner) → KSampler (steps=25, start=20, end=25)
```

- The refiner uses `KSamplerAdvanced` with `start_at_step` and `end_at_step`
- Typically run the base for 80% of steps, refiner for the last 20%
- Refiner checkpoint: `sd_xl_refiner_1.0.safetensors`

### Workflow Pattern

```
CheckpointLoaderSimple → MODEL(0), CLIP(1), VAE(2)
  CLIP(1) → CLIPTextEncode (positive) → CONDITIONING
  CLIP(1) → CLIPTextEncode (negative) → CONDITIONING
EmptyLatentImage (width=1024, height=1024) → LATENT
KSampler (cfg=7.0, steps=25, sampler="dpmpp_2m", scheduler="karras") → LATENT
VAEDecode → IMAGE
SaveImage
```

### ControlNet Compatibility

SDXL ControlNets are separate from SD 1.5 ControlNets:

| ControlNet | Model File Pattern | Notes |
|------------|-------------------|-------|
| Canny | `control-lora-canny-rank256` or `diffusers_xl_canny` | Often LoRA-based |
| Depth | `control-lora-depth-rank256` or `diffusers_xl_depth` | |
| T2I-Adapter | `t2i-adapter-*-sdxl` | Lighter alternative to ControlNet |
| IP-Adapter | `ip-adapter_sdxl` | Image prompt adapter |
| InstantID | `instantid-*` | Face-specific |

### LoRA Compatibility

- SDXL LoRAs ONLY work with SDXL base models — NOT with SD 1.5
- Same `LoraLoader` node as SD 1.5
- Lightning LoRAs are SDXL LoRAs that enable few-step generation

---

## Flux (Flux.1)

### Overview

Black Forest Labs' model with a T5-XXL text encoder. Produces high-quality images without negative prompts. Available in schnell (fast) and dev (quality) variants.

### Configuration — Flux Schnell

| Parameter | Value |
|-----------|-------|
| **Loader** | `CheckpointLoaderSimple` (single-file) or `DualCLIPLoader` + `UNETLoader` + `VAELoader` (split) |
| **Native Resolution** | 1024x1024 (flexible aspect ratios) |
| **Supported Resolutions** | Flexible: 512x512 to 2048x2048, any aspect ratio |
| **VAE** | Separate Flux VAE (`ae.safetensors`) — NOT shared with SD models |
| **CLIP** | T5-XXL + CLIP-L via `DualCLIPLoader` |
| **Text Encoder Node** | `CLIPTextEncode` (single combined) |
| **CFG** | **1.0** (MUST be 1.0 — higher values cause severe artifacts) |
| **Negative Prompt** | **NONE** — do not connect negative conditioning |
| **Steps** | 4 |
| **Sampler** | `euler` |
| **Scheduler** | `simple` or `sgm_uniform` |
| **Denoise** | 1.0 |
| **VRAM (FP16)** | ~24GB (FP8: ~12GB) |

### Configuration — Flux Dev

| Parameter | Value |
|-----------|-------|
| **Same as Schnell except:** | |
| **Steps** | 20-50 (typical: 30) |
| **Scheduler** | `sgm_uniform` |
| **VRAM (FP16)** | ~24GB (FP8: ~12GB) |

### Loading Methods

**Method 1: Single Checkpoint (simplest)**
```
CheckpointLoaderSimple (ckpt_name="flux1-schnell.safetensors")
  → MODEL(0), CLIP(1), VAE(2)
```

**Method 2: Split Components (recommended for FP8)**
```
UNETLoader (unet_name="flux1-schnell-fp8.safetensors") → MODEL
DualCLIPLoader (clip_name1="t5xxl_fp16.safetensors", clip_name2="clip_l.safetensors", type="flux") → CLIP
VAELoader (vae_name="ae.safetensors") → VAE
```

### CRITICAL Rules

- **CFG MUST be 1.0** — Flux uses guidance embedded in the model, not classifier-free guidance
- **No negative prompt** — Empty string or don't connect the negative input at all
- **Separate VAE required** — Flux uses its own VAE (`ae.safetensors`), not SD VAEs
- **FP8 strongly recommended** for 24GB cards — FP16 Flux barely fits in 24GB VRAM
- T5-XXL encoder can be loaded in FP8 to save additional VRAM

### Workflow Pattern

```
UNETLoader (flux fp8) → MODEL
DualCLIPLoader (t5xxl + clip_l, type="flux") → CLIP
VAELoader (ae.safetensors) → VAE

CLIPTextEncode (positive prompt) → CONDITIONING
  (no negative CLIPTextEncode needed)

EmptyLatentImage (width=1024, height=1024) → LATENT

KSampler (cfg=1.0, steps=4, sampler="euler", scheduler="simple") → LATENT
VAEDecode (vae from VAELoader) → IMAGE
SaveImage
```

### ControlNet Compatibility

Flux ControlNets are model-specific:

| ControlNet | Notes |
|------------|-------|
| Flux ControlNet (Canny) | Specific Flux-compatible ControlNet |
| Flux ControlNet (Depth) | Specific Flux-compatible ControlNet |
| InstantX ControlNets | Community Flux ControlNets |
| Flux IP-Adapter | Image prompt for Flux |

SD 1.5 and SDXL ControlNets do NOT work with Flux.

### LoRA Compatibility

- Flux LoRAs ONLY work with Flux models
- Typically loaded via `LoraLoader` same as SD models
- Flux LoRA ecosystem is smaller than SD 1.5/SDXL but growing
- Some Flux LoRAs require specific trigger words

---

## Stable Diffusion 3 / 3.5 (SD3)

### Overview

Stability AI's next-generation model with triple CLIP architecture. Better prompt adherence and longer prompt support via T5-XXL.

### Configuration

| Parameter | Value |
|-----------|-------|
| **Loader** | `CheckpointLoaderSimple` or triple-clip loader |
| **Native Resolution** | 1024x1024 |
| **VAE** | Built-in (integrated) |
| **CLIP** | Triple: CLIP-L + CLIP-G + T5-XXL |
| **Text Encoder Node** | `CLIPTextEncode` or `CLIPTextEncodeSD3` |
| **CFG Range** | 4-7 (typical: 5.0) |
| **Negative Prompt** | Minimal — SD3 needs very little negative guidance |
| **Steps** | 20-30 |
| **Sampler** | `euler`, `dpmpp_2m` |
| **Scheduler** | `sgm_uniform`, `normal` |
| **Denoise** | 1.0 (txt2img) |
| **Shift** | Some samplers support a shift parameter for SD3 |
| **VRAM (FP16)** | ~12GB (without T5-XXL: ~6GB) |

### Triple CLIP Loading

```
CheckpointLoaderSimple → MODEL(0), CLIP(1), VAE(2)
```

Or for separate CLIP control:
```
DualCLIPLoader (clip_l + clip_g) → CLIP
CLIPLoader (t5xxl) → CLIP
```

### Key Differences from SD 1.5/SDXL

- Much better text rendering capabilities
- Handles spatial relationships better ("cat on the left, dog on the right")
- T5-XXL enables very long, detailed prompts (no 77-token limit concern)
- Lower CFG values (4-7 vs 7-12)
- Minimal negative prompting needed
- `shift` parameter in sampling affects noise schedule

### ControlNet Compatibility

- SD3-specific ControlNets are limited
- Check for SD3-compatible community ControlNets
- SD 1.5 and SDXL ControlNets do NOT work with SD3

---

## LTXV (Video Models)

### Overview

Latent video diffusion models for text-to-video and image-to-video generation. Very VRAM-intensive.

### Configuration

| Parameter | Value |
|-----------|-------|
| **Loader** | Special video checkpoint loader (varies by node pack) |
| **Resolution** | 512x512 or 768x768 per frame (depends on model) |
| **Frames** | 16-64 (depends on VRAM) |
| **FPS** | 8-24 |
| **VRAM** | 20GB+ FP16, ~6-10GB FP8 |
| **Key Warning** | Can OOM on 24GB VRAM — always use FP8 quantized models |

### VRAM Management

- **Always use FP8 quantized models** on 24GB cards
- Reduce frame count if OOM persists
- Lower resolution helps significantly
- Close other GPU-using applications
- Consider `--lowvram` flag for ComfyUI

---

## Cross-Family Compatibility Rules

### LoRA Compatibility

LoRAs are **model-family specific** and are NOT interchangeable:

| LoRA Trained For | Works With | Does NOT Work With |
|-----------------|------------|-------------------|
| SD 1.5 | SD 1.5 and its fine-tunes | SDXL, Flux, SD3 |
| SDXL | SDXL and its fine-tunes | SD 1.5, Flux, SD3 |
| Flux | Flux models only | SD 1.5, SDXL, SD3 |
| SD3 | SD3/3.5 models only | SD 1.5, SDXL, Flux |

Using a LoRA with the wrong base model will produce garbage images or errors.

### ControlNet Compatibility

ControlNets are also **model-family specific**:

| ControlNet Trained For | Works With | Does NOT Work With |
|-----------------------|------------|-------------------|
| SD 1.5 (v1.1 series) | SD 1.5 base + fine-tunes | SDXL, Flux, SD3 |
| SDXL | SDXL base + fine-tunes | SD 1.5, Flux, SD3 |
| Flux | Flux models only | SD 1.5, SDXL, SD3 |

### VAE Compatibility

| VAE | Compatible Models | Notes |
|-----|-------------------|-------|
| `vae-ft-mse-840000-ema-pruned` | SD 1.5 family | Best external VAE for SD 1.5 |
| SDXL built-in VAE | SDXL family | Good quality, no external needed |
| `sdxl_vae.safetensors` | SDXL family | External SDXL VAE option |
| `ae.safetensors` (Flux VAE) | Flux only | Required for Flux, incompatible with SD |
| SD3 built-in VAE | SD3 family | Integrated, no external needed |

**Rule**: Never mix VAEs across model families. An SD 1.5 VAE decoding Flux latents will produce garbage.

### Embedding/Textual Inversion Compatibility

| Embedding Type | Compatible Models |
|---------------|-------------------|
| SD 1.5 embeddings | SD 1.5 family only |
| SDXL embeddings | SDXL family only |
| Flux/SD3 | Generally don't use traditional embeddings |

### Sampler/Scheduler Compatibility

Most samplers work across all models, but some combinations are optimal:

| Model | Best Sampler | Best Scheduler | Notes |
|-------|-------------|----------------|-------|
| SD 1.5 | `euler_ancestral`, `dpmpp_2m` | `karras`, `normal` | All standard samplers work |
| SDXL | `dpmpp_2m`, `euler` | `karras`, `normal` | Same as SD 1.5 |
| SDXL Turbo | `euler_ancestral` | `normal` | Must use 1-4 steps |
| SDXL Lightning | `euler` | `sgm_uniform` | Must match step count to LoRA |
| Flux Schnell | `euler` | `simple` | 4 steps only |
| Flux Dev | `euler` | `sgm_uniform` | 20-50 steps |
| SD3 | `euler`, `dpmpp_2m` | `sgm_uniform`, `normal` | Lower CFG needed |

## Quick Decision Guide

### Choosing a Model

| Use Case | Recommended Model | Why |
|----------|------------------|-----|
| Maximum ecosystem/community support | SD 1.5 | Most LoRAs, ControlNets, embeddings |
| High quality, good prompt following | SDXL | Best balance of quality and ecosystem |
| Fastest generation | SDXL Turbo/Lightning | 1-4 steps |
| Best prompt understanding | Flux Dev | T5-XXL encoder, natural language |
| Fast + good quality | Flux Schnell | 4 steps, no negative needed |
| Text in images | SD3.5 | Best text rendering |
| Low VRAM (<6GB) | SD 1.5 | Smallest memory footprint |
| Video generation | LTXV / AnimateDiff | Only options for video |

### Choosing Resolution

| Model | Minimum | Recommended | Maximum (before OOM on 24GB) |
|-------|---------|-------------|-------------------------------|
| SD 1.5 | 256x256 | 512x512 | 768x768 |
| SDXL | 512x512 | 1024x1024 | 1536x1536 |
| Flux (FP8) | 512x512 | 1024x1024 | 2048x2048 |
| Flux (FP16) | 512x512 | 1024x1024 | 1024x1024 (tight) |
| SD3 | 512x512 | 1024x1024 | 1536x1536 |

Going below the recommended resolution produces blurry/low-quality results. Going above the maximum risks OOM errors or quality degradation (tiling artifacts).

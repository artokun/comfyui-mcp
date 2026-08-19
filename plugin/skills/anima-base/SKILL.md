---
name: anima-base
description: Anime/illustration text-to-image (ANIMA 1.0, ~2B Cosmos DiT) — use for anime, manga, illustrated characters; accepts Danbooru tags + natural language; runs/trains on <6GB VRAM; includes anime inpainting via Anima-LLLite ControlNet
globs:
  - "**/*.json"
---

# ANIMA 1.0 (Anima Base Ultra) Text-to-Image Workflows

## Overview

**Anima** is a ~2B-parameter anime / illustration text-to-image base model from **CircleStone Labs** (in collaboration with Comfy Org). It is **not** SDXL-lineage: the architecture is **NVIDIA Cosmos-Predict2-2B-Text2Image (a DiT / flow model)**, trained on several million anime images plus ~800k non-anime artistic images. It is **best for anime, manga, and illustrated characters/styles** (not realism).

Key traits:
- Accepts **Danbooru-style tags AND/OR natural language** in the same prompt.
- Very low VRAM — generates (and trains) on **<6GB VRAM**; runs on any PC that can run SDXL/Illustrious.
- License: **CircleStone Labs Non-Commercial License** (with NVIDIA Open Model License terms on the weights/derivatives). Generated images are usable commercially per the model card — verify the current license text before relying on this.

Loaded in ComfyUI with **standard split-file loaders** (not a single checkpoint):

| Component | Node | Model file | Folder | Notes |
|-----------|------|-----------|--------|-------|
| **Diffusion model** | `UNETLoader` | `anima-base-v1.0.safetensors` | `models/diffusion_models/` | weight_dtype `default`; ~4GB fp |
| **Text encoder** | `CLIPLoader` | `qwen_3_06b_base.safetensors` | `models/text_encoders/` | Qwen3-0.6B base; **`type": "stable_diffusion"`** in this pack |
| **VAE** | `VAELoader` | `qwen_image_vae.safetensors` | `models/vae/` | Qwen-Image VAE (~254MB) |

> **Verified from the pack's workflow JSON:** `CLIPLoader` widget values are `["qwen_3_06b_base.safetensors", "stable_diffusion", "default"]`. (The HF model card describes standard loaders; the exact CLIP `type` string `stable_diffusion` is what the Aitrepreneur "Anima Base Ultra" workflow ships — use it as-is.)

## Installation

The "Anima Base Ultra" pack (by Aitrepreneur) installs custom nodes and downloads all models. Models are mirrored on `https://huggingface.co/Aitrepreneur/FLX/resolve/main` (the official source is `https://huggingface.co/circlestone-labs/Anima`).

### Custom nodes (git clone into `ComfyUI/custom_nodes/`)

| Node pack | Repo | Used for |
|-----------|------|----------|
| ComfyUI-Manager | `https://github.com/ltdrdata/ComfyUI-Manager.git` | management |
| ComfyUI-Impact-Pack | `https://github.com/ltdrdata/ComfyUI-Impact-Pack` | FaceDetailer / EditDetailerPipe |
| ComfyUI-Impact-Subpack | `https://github.com/ltdrdata/ComfyUI-Impact-Subpack` | UltralyticsDetectorProvider |
| rgthree-comfy | `https://github.com/rgthree/rgthree-comfy` | Power Lora Loader, Fast Groups, Any Switch |
| ComfyUI-KJNodes | `https://github.com/kijai/ComfyUI-KJNodes` | helpers |
| ComfyUI_UltimateSDUpscale | `https://github.com/ssitu/ComfyUI_UltimateSDUpscale` | tiled upscaling |
| ComfyUI_tinyterraNodes | `https://github.com/TinyTerra/ComfyUI_tinyterraNodes` | ttN seed |
| comfyui_controlnet_aux | `https://github.com/Fannovel16/comfyui_controlnet_aux` | DWPreprocessor, DepthAnythingV2 |
| **ComfyUI-Anima-LLLite** | `https://github.com/kohya-ss/ComfyUI-Anima-LLLite` | **`AnimaLLLiteApply`** (ControlNet + inpainting) |

### Models (download URLs from the pack's .bat / .sh)

Base `$HF = https://huggingface.co/Aitrepreneur/FLX/resolve/main`, `$YOLO11 = https://huggingface.co/Ultralytics/YOLO11/resolve/main`. Append `?download=true`.

| Folder | File | Source |
|--------|------|--------|
| `diffusion_models/` | `anima-base-v1.0.safetensors` | `$HF` |
| `text_encoders/` | `qwen_3_06b_base.safetensors` | `$HF` |
| `vae/` | `qwen_image_vae.safetensors` | `$HF` |
| `controlnet/` | `anima-lllite-inpainting-v1.safetensors` | `$HF` |
| `controlnet/` | `anima-lllite-depth-1.safetensors` | `$HF` |
| `controlnet/` | `anima-lllite-lineart-1.safetensors` | `$HF` |
| `controlnet/` | `anima-lllite-pose-1.safetensors` | `$HF` |
| `controlnet/` | `anima-lllite-any-test-like-1-step2000.safetensors` | `$HF` |
| `loras/` | `anima-turbo-lora-v0.1.safetensors` | `$HF` |
| `loras/` | `anima-highres-aesthetic-boost.safetensors` | `$HF` |
| `loras/` | `anima-preview-3-masterpieces-v5.safetensors` | `$HF` |
| `loras/` | `anima_p3_rdbt_v0.29.b.122.safetensors` | `$HF` |
| `upscale_models/` | `4x_foolhardy_Remacri.pth`, `4x-ClearRealityV1.pth` | `$HF` |
| `ultralytics/bbox/` | `face_yolov9c.pt`, `hand_yolov9c.pt`, `Eyeful_v2-Paired.pt` | `$HF` |
| `ultralytics/segm/` | `ntd11_anime_nsfw_segm_v5-variant1.pt` | `$HF` |
| `ultralytics/segm/` | `yolo11m-seg.pt` | `$YOLO11` |
| `sams/` | `sam_vit_b_01ec64.pth` | `$HF` |

The DWPreprocessor/DepthAnythingV2 aux models (`dw-ll_ucoco_384_bs5.torchscript.pt`, `yolox_l.onnx`, `depth_anything_v2_vitl.pth`) are auto-fetched by `comfyui_controlnet_aux` on first use.

## Key Nodes

### Loaders
```json
{
  "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "anima-base-v1.0.safetensors", "weight_dtype": "default" }},
  "2": { "class_type": "CLIPLoader", "inputs": { "clip_name": "qwen_3_06b_base.safetensors", "type": "stable_diffusion", "device": "default" }},
  "3": { "class_type": "VAELoader", "inputs": { "vae_name": "qwen_image_vae.safetensors" }}
}
```

### Anima Turbo LoRA (the shipped default — 12-step fast mode)
Applied with rgthree `Power Lora Loader`. The plain ComfyUI equivalent is `LoraLoaderModelOnly`:
```json
{
  "class_type": "LoraLoaderModelOnly",
  "inputs": { "model": ["1", 0], "lora_name": "anima-turbo-lora-v0.1.safetensors", "strength_model": 1.0 }
}
```
Other LoRAs the pack ships (toggle on/off in Power Lora Loader): `anima-highres-aesthetic-boost`, `anima-preview-3-masterpieces-v5`, `anima_p3_rdbt_v0.29.b.122`. In the **non-turbo** groups these three are enabled and the turbo LoRA is off; in the **turbo** groups only the turbo LoRA is on.

### AnimaLLLiteApply (ControlNet + inpainting — from ComfyUI-Anima-LLLite)
Patches the **MODEL** (Anima uses LLLite-style control, not standard `ControlNetApply` conditioning). Inputs: `model`, `image`, `mask`; widget order `[lllite_name, strength, start_percent, end_percent]`; output: patched `MODEL`.
```json
{
  "class_type": "AnimaLLLiteApply",
  "inputs": {
    "model": ["<model>", 0],
    "image": ["<control_or_source_image>", 0],
    "mask": ["<mask>", 0],
    "lllite_name": "anima-lllite-pose-1.safetensors",
    "strength": 1.0, "start_percent": 0.0, "end_percent": 1.0
  }
}
```

## Settings

The base model and the turbo-LoRA path want **different** settings:

| Mode | Steps | CFG | Sampler | Scheduler | Denoise | Notes |
|------|-------|-----|---------|-----------|---------|-------|
| **Base (no turbo LoRA)** | 30–50 | 4–5 | `er_sde` | `simple` | 1.0 | Author-recommended for the base model |
| **Turbo LoRA (shipped default)** | 12 | 1.0 | `er_sde` | `simple` | 1.0 | `anima-turbo-lora-v0.1` enabled |
| Upscale pass (UltimateSDUpscale) | 12 | 1.0 | `er_sde` | `simple` | 0.28 | `4x_foolhardy_Remacri.pth`, scale 2x |

**Sampler character (from model card):** `er_sde` = neutral style, flat colors, sharp lines; `euler_ancestral` = softer/thinner lines; `dpmpp_2m_sde_gpu` = similar with more variety. Optional `beta57` scheduler for painterly looks.

## Resolutions

The base model supports 512²–1536². The pack recommends these to avoid distortion:

| Aspect | Resolution |
|--------|-----------|
| 1:1 | 1024x1024 |
| 3:4 | 896x1152 |
| 5:8 | 832x1216 |
| 9:16 | 768x1344 |
| 9:21 | 640x1536 |

## Prompt Style

Anima accepts **Danbooru tags + natural language together**. The pack's recommended formula:

```
masterpiece, best quality, score_7, safe, highres, official art,
1girl, solo,
@artist name,
clean lineart, detailed eyes, soft shading,

A young anime woman with long silver hair and blue eyes stands in a rainy neon city at night.
She wears a black futuristic jacket with glowing blue details. Medium close-up, wet pavement
reflections, soft background blur, cinematic lighting.
```

Structure: **quality tags → subject/count tags → optional `@artist name` → anime style tags → 2–4 natural-language sentences** describing subject, outfit, pose, composition, background, lighting, mood. Use lowercase tags with spaces (not underscores), except score tags like `score_7`. Artist tags use `@artist name`; browse names at the community Anima Style Explorer (`https://thetacursed.github.io/Anima-Style-Explorer/`).

**Negative prompt (recommended):**
```
worst quality, low quality, score_1, score_2, score_3, artist name, bad anatomy, bad hands,
missing fingers, extra fingers, extra arms, extra legs, duplicate, twins, text, watermark,
signature, simple background
```
Unlike Flux/Qwen, Anima **does** use a real negative prompt via a second `CLIPTextEncode` (CFG > 1 in base mode).

## Complete Workflow: Text-to-Image (Turbo, 12-step)

```json
{
  "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "anima-base-v1.0.safetensors", "weight_dtype": "default" }},
  "2": { "class_type": "CLIPLoader", "inputs": { "clip_name": "qwen_3_06b_base.safetensors", "type": "stable_diffusion", "device": "default" }},
  "3": { "class_type": "VAELoader", "inputs": { "vae_name": "qwen_image_vae.safetensors" }},
  "4": { "class_type": "LoraLoaderModelOnly", "inputs": { "model": ["1", 0], "lora_name": "anima-turbo-lora-v0.1.safetensors", "strength_model": 1.0 }},
  "5": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["2", 0], "text": "masterpiece, best quality, score_7, safe, highres, official art, 1girl, solo, clean lineart, detailed eyes, soft shading,\n\nA young anime woman with long silver hair and blue eyes stands in a rainy neon city at night, cinematic lighting." }},
  "6": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["2", 0], "text": "worst quality, low quality, score_1, score_2, score_3, bad anatomy, bad hands, extra fingers, text, watermark, signature, simple background" }},
  "7": { "class_type": "EmptyLatentImage", "inputs": { "width": 896, "height": 1152, "batch_size": 1 }},
  "8": { "class_type": "KSampler", "inputs": {
    "model": ["4", 0],
    "positive": ["5", 0],
    "negative": ["6", 0],
    "latent_image": ["7", 0],
    "seed": 42, "steps": 12, "cfg": 1, "sampler_name": "er_sde", "scheduler": "simple", "denoise": 1
  }},
  "9": { "class_type": "VAEDecode", "inputs": { "samples": ["8", 0], "vae": ["3", 0] }},
  "10": { "class_type": "SaveImage", "inputs": { "images": ["9", 0], "filename_prefix": "anima" }}
}
```

**Base-quality variant (no turbo):** drop node 4 (feed `["1", 0]` into KSampler), set `steps: 30`, `cfg: 4.5`. Optionally enable the three quality LoRAs (`anima-highres-aesthetic-boost`, `anima-preview-3-masterpieces-v5`, `anima_p3_rdbt_v0.29.b.122`) by chaining `LoraLoaderModelOnly` nodes.

## Complete Workflow: Anime Inpainting (Anima-LLLite ControlNet)

The pack's "INPAINTING CONTROLNET" group: load an image with a painted mask, `VAEEncode` it, apply `SetLatentNoiseMask`, patch the model with the **inpainting LLLite** (fed the same image + mask), then sample. The mask region is regenerated from the prompt while the rest is preserved.

```json
{
  "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "anima-base-v1.0.safetensors", "weight_dtype": "default" }},
  "2": { "class_type": "CLIPLoader", "inputs": { "clip_name": "qwen_3_06b_base.safetensors", "type": "stable_diffusion", "device": "default" }},
  "3": { "class_type": "VAELoader", "inputs": { "vae_name": "qwen_image_vae.safetensors" }},
  "4": { "class_type": "LoraLoaderModelOnly", "inputs": { "model": ["1", 0], "lora_name": "anima-turbo-lora-v0.1.safetensors", "strength_model": 1.0 }},
  "5": { "class_type": "LoadImage", "inputs": { "image": "<masked_image.png>" }},
  "6": { "class_type": "AnimaLLLiteApply", "inputs": {
    "model": ["4", 0], "image": ["5", 0], "mask": ["5", 1],
    "lllite_name": "anima-lllite-inpainting-v1.safetensors",
    "strength": 1.0, "start_percent": 0.0, "end_percent": 1.0
  }},
  "7": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["2", 0], "text": "<what to paint into the masked area>" }},
  "8": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["2", 0], "text": "worst quality, low quality, bad anatomy, text, watermark" }},
  "9": { "class_type": "VAEEncode", "inputs": { "pixels": ["5", 0], "vae": ["3", 0] }},
  "10": { "class_type": "SetLatentNoiseMask", "inputs": { "samples": ["9", 0], "mask": ["5", 1] }},
  "11": { "class_type": "KSampler", "inputs": {
    "model": ["6", 0],
    "positive": ["7", 0],
    "negative": ["8", 0],
    "latent_image": ["10", 0],
    "seed": 42, "steps": 12, "cfg": 1, "sampler_name": "er_sde", "scheduler": "simple", "denoise": 1
  }},
  "12": { "class_type": "VAEDecode", "inputs": { "samples": ["11", 0], "vae": ["3", 0] }},
  "13": { "class_type": "SaveImage", "inputs": { "images": ["12", 0], "filename_prefix": "anima_inpaint" }}
}
```

**Other LLLite ControlNets** (same `AnimaLLLiteApply` node, swap `lllite_name`, feed a preprocessed control image; mask can be a full-white/blank mask when not inpainting):
- `anima-lllite-pose-1.safetensors` ← `DWPreprocessor` (OpenPose)
- `anima-lllite-depth-1.safetensors` ← `DepthAnythingV2Preprocessor`
- `anima-lllite-lineart-1.safetensors` / `anima-lllite-any-test-like-1-step2000.safetensors` ← lineart / generic control

## Upscaling (optional)

The pack upscales with `UltimateSDUpscale` (`4x_foolhardy_Remacri.pth`, 2x, **denoise 0.28**, 12 steps, er_sde/simple) and refines faces/hands/eyes with Impact-Pack `FaceDetailer` driven by `UltralyticsDetectorProvider` (`face_yolov9c.pt`, `hand_yolov9c.pt`, `Eyeful_v2-Paired.pt`) + SAM (`sam_vit_b_01ec64.pth`).

## VRAM

- Anima is ~2B params → generates in **<6GB VRAM** (runs anywhere SDXL/Illustrious runs).
- Text encoder (Qwen3-0.6B) and VAE are both small.
- A **GGUF** quantized build exists for even lower memory (`Abiray/Anima-base-v1.0-GGUF`) — would need a GGUF loader node (e.g. ComfyUI-GGUF), not included in this pack. *Unverified against this workflow.*

## Troubleshooting

1. **Weird/distorted images** → use a recommended resolution (1024x1024, 896x1152, 832x1216, 768x1344, 640x1536).
2. **Turbo result looks washed/flat** → that's turbo at CFG 1; for max quality switch to base mode (drop turbo LoRA, 30–50 steps, CFG 4–5).
3. **`AnimaLLLiteApply` missing** → install `ComfyUI-Anima-LLLite`; it is **not** a standard ControlNet node.
4. **CLIP loads but output is garbage** → confirm `CLIPLoader` `type` is `stable_diffusion` and the file is `qwen_3_06b_base.safetensors` (the Qwen3-0.6B *base*, not the chat/edit Qwen models).
5. **Inpainting ignores the mask** → ensure both `SetLatentNoiseMask` AND the inpainting `AnimaLLLiteApply` receive the painted mask; encode the *source* image with `VAEEncode` (denoise 1.0 is fine because the noise mask preserves unmasked pixels).

## Training custom LoRAs

To train your own Anima LoRA (character/style) on <6GB VRAM, use the **Citron Anima LoRA Trainer** — see the `anima-lora-trainer` skill. Trained `.safetensors` LoRAs drop into `models/loras/` and load via `Power Lora Loader` / `LoraLoaderModelOnly` exactly like the bundled LoRAs above.

## Sources

- **Official:** model weights at https://huggingface.co/circlestone-labs/Anima — no vendor prompting guide cited.
- **Empirical:** tag-order / @artist prompting and sampler wiring from working graphs; Anima Style Explorer is community, not vendor docs.

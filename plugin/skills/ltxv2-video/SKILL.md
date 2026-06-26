---
name: ltxv2-video
description: Build Lightricks LTX-2 / LTX-2.3 video workflows — text-to-video, image-to-video, GGUF and bundled checkpoints, distilled model, camera control LoRAs, synchronized audio, two-stage upscaling, and swapping alternate/GGUF base models
globs:
  - "**/*.json"
---

# LTX-2 / LTX-2.3 Video Workflows

## Version naming (read this first)

There is no "LTX 3.2" or "LTX2.3" as separate products — the user's shorthand refers to **Lightricks LTX-2.3**, a point release of the LTX-2 family. The lineage is:

- **LTX-Video** (2024) — first text-to-video model from Lightricks.
- **LTX-2 / LTX-V2** (Oct 2025) — 19B-class DiT audio-video foundation model. Bundled checkpoint `ltx-2-19b-distilled.safetensors`, Gemma 3 12B text encoder.
- **LTX-2.3** (released ~March 2026) — **22B**-parameter DiT update. Rebuilt VAE (sharper textures/faces/hair/text), ~4x larger text connector (text projection) for prompt adherence, native 9:16 portrait, LoRA support, HiFi-GAN vocoder for cleaner synchronized audio, up to 4K@50fps / ~20s clips. Apache 2.0. **Distributed primarily as GGUF UNets** (community quants) plus separate VAE / text-encoder / text-projection files — NOT a single bundled checkpoint like LTX-2.

When the user says "LTX3.2" / "LTX2.3", treat it as **LTX-2.3**. This skill covers both LTX-2 (bundled checkpoint path) and LTX-2.3 (GGUF UNet path).

---

## ⭐ Render-verified correct setup (read this FIRST — 2026-06-19)

> The GGUF-UNet + `DualCLIPLoader` + `gemma_3_12B_it_fp4_mixed` path documented later
> in this skill (the Aitrepreneur installer path) **produces soft/mushy video with
> inaccurate faces and eyes.** It runs, but it is NOT the quality path. The setup
> below is the official Comfy-Org template, render-proven sharp (1280×704, accurate
> faces, synchronized 48 kHz stereo audio).

### Models (exact, render-verified)

| Component | File | Source repo | Folder | Notes |
|-----------|------|-------------|--------|-------|
| **Checkpoint** | `ltx-2.3-22b-dev.safetensors` (46 GB, max quality) **or** `ltx-2.3-22b-dev-fp8.safetensors` (~23 GB, official VRAM-friendly) | `Lightricks/LTX-2.3` / `Lightricks/LTX-2.3-fp8` | **`checkpoints/`** (NOT `unet/`) | The checkpoint carries the transformer **and** the audio VAE. Loaded by `CheckpointLoaderSimple` + reused by `LTXVAudioVAELoader` + `LTXAVTextEncoderLoader`. |
| **Gemma text encoder** | `gemma_3_12B_it_fp8_scaled.safetensors` (13 GB) | `Comfy-Org/ltx-2` → `split_files/text_encoders/` | `text_encoders/` | Use fp8_scaled (unpacked). The Aitrepreneur `fp4_mixed` mirror file is **truncated (5.3 GB vs 9.4 GB) AND a packed-fp4 layout** core can't reshape → `shape [15360,1920] invalid for input 27582328`. |
| **Distilled speed LoRA** | `ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors` @ **0.5** | `Comfy-Org/ltx-2.3` → `split_files/loras/` | `loras/` | The newer *dynamic rank-111* distilled LoRA — NOT the older `...384-1.1`. |
| **Gemma abliterated LoRA** ⭐ | `gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors` @ **1.0** | `Comfy-Org/ltx-2` → `split_files/loras/` | `loras/` | **Applied to the text-encoder CLIP via a `LoraLoader`. This is the prompt-accuracy / correct-eyes fix.** Missing this = subtly-wrong faces. |
| **Spatial upscaler** | `ltx-2.3-spatial-upscaler-x2-1.1.safetensors` | `Lightricks/LTX-2.3` | `latent_upscale_models/` | Used by the stage-2 `LTXVLatentUpsampler`. Use `x2-1.1`, not `x2-1.0`. |

### Node stack (the right one)

- **`LTXAVTextEncoderLoader`** (CORE, `comfy_extras/nodes_lt_audio.py`) — loads gemma + the **full checkpoint** together via `comfy.sd.load_clip([gemma, ckpt], type=LTXV)`. This is the audio-video encoder driving **both video and audio/voice**. **Do NOT use `DualCLIPLoader(type=ltxv)` + a separate `ltx-2.3_text_projection` file** — that is the legacy video-only path and yields mush.
- **Gemma abliterated LoRA** via a `LoraLoader` (CLIP LoRA) on the encoder output → CLIPTextEncode.
- **Two-stage**: base sample (~768×512) → **`LTXVLatentUpsampler`** (×2 spatial, uses the upscaler model + the checkpoint VAE) → refine sample → **1280×704** output. The upscale is the sharpness. A single-stage graph is visibly softer.
- Guider: the Comfy-Org template uses plain **`CFGGuider` cfg=1** (distilled); the LTXVideo repo example uses **`MultimodalGuider` + `GuiderParameters`** (separate AUDIO/VIDEO) + **`ClownSampler_Beta`** (RES4LYF). Both produce sharp output — the LoRAs + two-stage matter more than the guider.
- **ffmpeg is required** for the final mux: `<comfy-venv>/python -m pip install imageio-ffmpeg`, then reboot. `CreateVideo`/`SaveVideo`/`VHS_VideoCombine` fail with `ffmpeg ... could not be found` otherwise.

### Custom nodes
`ComfyUI-LTXVideo` (LTXV* nodes, `MultimodalGuider`, `GuiderParameters`, `LTXVPreprocess`, `LTXVTiledVAEDecode`, `GemmaAPITextEncode`, `LTXFloatToInt`) + `RES4LYF` (`ClownSampler_Beta`, only for the repo-example sampler). `LTXAVTextEncoderLoader`, `ResizeImageMaskNode`, `CreateVideo`, `SaveVideo`, `ManualSigmas`, `LTXVScheduler`, the `Primitive*` nodes are all CORE ComfyUI.

### Quality troubleshooting (symptom → cause → fix)
- **Mushy/garbage, no clear subject** → empty positive prompt, or `DualCLIPLoader`+projection text encoder. Fix: set a prompt; use `LTXAVTextEncoderLoader`.
- **Coherent but soft/blurry, faces & eyes slightly wrong** → no two-stage upscale and/or missing the gemma abliterated LoRA and/or the old distilled LoRA. Fix: full two-stage template + both LoRAs above.
- **`status: success` but no video file / `outputs` only has a math or text node** → the output node (SaveVideo/VHS) failed validation and was *silently dropped*; the graph short-circuited. Check the ComfyUI log for `Failed to validate prompt for output N` and fix that node (missing ffmpeg, a broken connection, a model-not-in-list).
- **`DualCLIPLoader` reshape `[15360,1920] invalid for input 27582328`** → wrong/truncated gemma → use `gemma_3_12B_it_fp8_scaled`.
- **`LatentUpscaleModelLoader: ...x2-1.0 not in list`** → reference `...x2-1.1`.
- **SaveVideo writes to a subfolder** (`video/<prefix>_NNNNN.mp4`) — its history `outputs` entry isn't under `images/videos/gifs`, so a naive "find the video" check misses it. Look on disk under `output/video/`.

### MCP UI→API converter gotchas (`src/services/workflow-converter.ts`)
The official template exercised several `convertUiToApi` gaps (all now fixed — keep in mind if a template still mis-converts):
- **V3 dynamic combos** (`COMFY_DYNAMICCOMBO_V3`, e.g. `ResizeImageMaskNode.resize_type`): each selected option's nested input must be keyed **`<combo>.<nested>`** (e.g. `resize_type.longer_size`, `resize_type.width`), NOT flat — ComfyUI rebuilds the nested dict via `dynamic_paths`/`finalize_prefix`. A flat key is rejected `required_input_missing`.
- **`Reroute`** is virtual — its connections must be passed through (consumer resolves to the Reroute's input), else everything downstream dangles and the graph short-circuits.
- **`VHS_VideoCombine`** stores `widgets_values` as a name→value **object**, not a positional array.
- **Typed `Primitive*` nodes** (`PrimitiveInt/Float/Boolean/StringMultiline`) are real executable nodes — keep them as **link sources**, don't bake their values into a consumer's `widgets_values` by index (mis-positions V3 nested inputs).

### Pack
`packs/ltx-2.3-txt2vid` (and the i2v/flf/extender variants) should be built on this official two-stage template. For a no-input-file **T2V** pack, set the template's `bypass_i2v` / "Switch to Text to Video?" boolean true and feed the I2V `image` input a blank `EmptyImage` (discarded at runtime but still validates).

---

> Source note: the install scripts below pull LTX-2.3 files from a third-party mirror repo `huggingface.co/Aitrepreneur/FLX`, not the official `Lightricks/LTX-2.3` repo. The official weights live at `huggingface.co/Lightricks/LTX-2.3`. Filenames/quants match what those scripts download.

## Overview

LTX-2 is a DiT-based video foundation model from Lightricks. It uses a Gemma 3 12B text encoder and supports both text-to-video (T2V) and image-to-video (I2V). Key features:

- **Distilled model** for fast 8-step generation; **dev model** for higher quality (~20+ steps)
- **Two-stage pipeline**: Generate at low res, then 2x spatial upscale in latent space
- **Camera control LoRAs** for cinematic movements
- **Synchronized audio-video generation** in a single pass (LTX-2.3 audio VAE + HiFi-GAN vocoder)
- **GGUF quantization** (LTX-2.3) for low-VRAM local inference via ComfyUI-GGUF

## Models

### LTX-2 (bundled checkpoint path)

| Component | Node | Model | Notes |
|-----------|------|-------|-------|
| **Checkpoint** | `CheckpointLoaderSimple` | `ltx-2-19b-distilled.safetensors` | 41GB bf16, distilled variant; bundles VAE internally |
| **Gemma 3** | `CLIPLoader` (type=`ltxv`) | `gemma_3_12B_it_fp4_mixed.safetensors` | 9GB FP4, in `text_encoders/` |

**Loading note (LTX-2)**: The bundled checkpoint contains the VAE internally. The Gemma 3 text encoder loads separately via `CLIPLoader` with `type: "ltxv"` pointing at `text_encoders/`.

### LTX-2.3 (GGUF UNet path — current install)

LTX-2.3 ships as a **separate GGUF UNet + standalone VAE + text encoder + text projection**, not a single bundled checkpoint. The install scripts (see below) place files like this:

| Component | Node | Model file | Folder | Notes |
|-----------|------|-----------|--------|-------|
| **UNet (GGUF)** | `UnetLoaderGGUF` ("Unet Loader (GGUF)", *bootleg* category, from ComfyUI-GGUF) | `ltx-2.3-22b-dev-Q4_K_S.gguf` / `-Q5_K_S.gguf` / `-Q8_0.gguf` | `models/unet/` | 22B dev model. Q4_K_S <12GB VRAM, Q5_K_S 12–16GB, Q8_0 24GB+ |
| **Video VAE** | `VAELoader` | `LTX23_video_vae_bf16.safetensors` | `models/vae/` | rebuilt LTX-2.3 VAE |
| **Audio VAE** | `VAELoader` | `LTX23_audio_vae_bf16.safetensors` | `models/vae/` | only for audio-sync output |
| **Gemma 3** | `CLIPLoader` (type=`ltxv`) | `gemma_3_12B_it_fp4_mixed.safetensors` | `models/text_encoders/` | same FP4 encoder as LTX-2 |
| **Text projection** | loaded with the text encoder | `ltx-2.3_text_projection_bf16.safetensors` | `models/text_encoders/` | the enlarged text connector new in 2.3 |
| **Spatial upscaler** | `LatentUpscaleModelLoader` | `ltx-2.3-spatial-upscaler-x2-1.1.safetensors` | `models/latent_upscale_models/` | replaces LTX-2's `...x2-1.0` |

**Loading note (LTX-2.3)**: Because the UNet is a bare GGUF, the VAE no longer comes "for free" with a checkpoint — load `LTX23_video_vae_bf16.safetensors` explicitly with `VAELoader`. Place GGUF UNets in `models/unet/` and use the GGUF Unet loader. Some community 2.3 workflows pair `gemma_3_12B_it.safetensors` (full) instead of the FP4 mixed file; the installer uses the FP4 mixed one.

### Install scripts (Step-by-step source of truth)

Three installers (by "Aitrepreneur") were used; they all download from `HF = https://huggingface.co/Aitrepreneur/FLX/resolve/main`:

- `LTX-2-3-MODELS-NODES_INSTALL-V2.bat` — run from `...\ComfyUI_windows_portable\ComfyUI\`. Locks the current pip env into a constraints file, sanitizes each node's `requirements.txt` (strips torch/file-wheels/extra-index lines), clones nodes, downloads models. Flags: `/update`, `/force`, `/dryrun`, `/restore`.
- `LTX-2-3-ULTRA-COMFYUI-MANAGER_AUTO_INSTALL-V2.bat` — full one-click: downloads ComfyUI portable `v0.22.0`, installs 7-Zip/Git if missing, clones the same nodes, downloads the same models, then launches ComfyUI.
- `LTX-2-3-AUTO_INSTALL-RUNPOD-V2.sh` — Linux/RunPod. Recreates a clean venv, pins **torch 2.4.0 / torchvision 0.19.0 / torchaudio 2.4.0 / xformers 0.0.27.post2 on cu121**, transformers 4.51.3, tokenizers >=0.21,<0.22, timm 1.0.15. Pins **ComfyUI-LTXVideo to commit `cd5d371518afb07d6b3641be8012f644f25269fc`** for workflow compatibility, and verifies the LTXVideo import at the end.

Exact model download URLs (all `?download=true` from the `FLX` mirror), grouped by target folder:

```
models/text_encoders/ltx-2.3_text_projection_bf16.safetensors
models/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors
models/vae/LTX23_video_vae_bf16.safetensors
models/vae/LTX23_audio_vae_bf16.safetensors
models/unet/ltx-2.3-22b-dev-<Q4_K_S|Q5_K_S|Q8_0>.gguf
models/latent_upscale_models/ltx-2.3-spatial-upscaler-x2-1.1.safetensors
models/loras/ltx-2.3-22b-distilled-lora-384-1.1.safetensors
models/loras/ltx-2-19b-ic-lora-detailer.safetensors
```

Custom nodes cloned by all three scripts:

| Node | Repo |
|------|------|
| ComfyUI-Manager | `github.com/ltdrdata/ComfyUI-Manager` |
| **ComfyUI-GGUF** (GGUF UNet loader) | `github.com/city96/ComfyUI-GGUF` |
| **ComfyUI-LTXVideo** (pin `cd5d371…` on RunPod) | `github.com/Lightricks/ComfyUI-LTXVideo` |
| rgthree-comfy | `github.com/rgthree/rgthree-comfy` |
| ComfyUI-Easy-Use | `github.com/yolain/ComfyUI-Easy-Use` |
| ComfyUI-KJNodes | `github.com/kijai/ComfyUI-KJNodes` |
| RES4LYF (advanced samplers e.g. res_2s) | `github.com/ClownsharkBatwing/RES4LYF` |
| ComfyUI-Custom-Scripts | `github.com/pythongosssss/ComfyUI-Custom-Scripts` |
| ComfyUI-VideoHelperSuite | `github.com/Kosinkadink/ComfyUI-VideoHelperSuite` |
| ComfyUI-WanVideoWrapper | `github.com/kijai/ComfyUI-WanVideoWrapper` |
| ComfyUI-Impact-Pack | `github.com/ltdrdata/ComfyUI-Impact-Pack` |
| Comfyui_TTP_Toolset | `github.com/TTPlanetPig/Comfyui_TTP_Toolset` |
| ComfyMath | `github.com/evanspearman/ComfyMath` |
| WhatDreamsCost-ComfyUI | `github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI` |

### LoRAs (Installed)

| LoRA | File | Purpose |
|------|------|---------|
| **Distilled LoRA (384, 2.3)** | `loras/ltx-2.3-22b-distilled-lora-384-1.1.safetensors` | Apply to the 2.3 dev UNet for fast distilled behavior |
| **IC-LoRA detailer** | `loras/ltx-2-19b-ic-lora-detailer.safetensors` | Detail/refinement IC-LoRA |
| **Distilled LoRA (384, LTX-2)** | `ltx2/ltx-2-19b-distilled-lora-384.safetensors` | Apply to LTX-2 base for distilled behavior |
| **Camera Dolly Left** | `ltx-2-19b-lora-camera-control-dolly-left.safetensors` | Camera movement (see Camera Control section) |

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

> **Feeding a prior stage's output into I2V (e.g. Krea2 image → LTX video).** The
> `LoadImage` that feeds `LTXVImgToVideo.image` needs the source frame registered
> as a ComfyUI INPUT. When that frame is an OUTPUT from an earlier stage, call
> **`stage_output_as_input`** with its `{ filename, subfolder?, type? }` and drop
> the returned input filename into `LoadImage`. (For a file already on local
> disk, `upload_image`.) **NEVER copy the output file into, or guess, a
> filesystem `input/` path** — ComfyUI's input/output dirs may be CUSTOM
> (`--input-directory` / `--output-directory`), so a guessed path makes
> `LoadImage` reject the file (`Invalid image file`) and wastes the render.
> `stage_output_as_input` goes through the server API (`/view` → `/upload/image`)
> and resolves the real dirs correctly.

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

Requires `LatentUpscaleModelLoader`. Use `ltx-2.3-spatial-upscaler-x2-1.1.safetensors` for LTX-2.3 (or `ltx-2-spatial-upscaler-x2-1.0.safetensors` for LTX-2).

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

## Complete Workflow: LTX-2.3 GGUF (dev, T2V)

The LTX-2.3 path differs from LTX-2 in three places: the model is a **GGUF UNet** loaded with `UnetLoaderGGUF` (no `CheckpointLoaderSimple`), the **VAE is loaded separately** with `VAELoader`, and the dev model wants **more steps (~20+) at low CFG**. Everything downstream (LTXVConditioning, EmptyLTXVLatentVideo, LTXVScheduler, SamplerCustomAdvanced) is the same.

```json
{
  "1": { "class_type": "UnetLoaderGGUF", "inputs": { "unet_name": "ltx-2.3-22b-dev-Q8_0.gguf" }},
  "2": { "class_type": "VAELoader", "inputs": { "vae_name": "LTX23_video_vae_bf16.safetensors" }},
  "3": { "class_type": "CLIPLoader", "inputs": { "clip_name": "gemma_3_12B_it_fp4_mixed.safetensors", "type": "ltxv" }},
  "4": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["3", 0], "text": "<positive prompt>" }},
  "5": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["3", 0], "text": "" }},
  "6": { "class_type": "LTXVConditioning", "inputs": {
    "positive": ["4", 0], "negative": ["5", 0], "frame_rate": 25
  }},
  "7": { "class_type": "EmptyLTXVLatentVideo", "inputs": {
    "width": 768, "height": 512, "length": 121, "batch_size": 1
  }},
  "8": { "class_type": "LTXVScheduler", "inputs": {
    "steps": 20, "max_shift": 2.05, "base_shift": 0.95,
    "stretch": true, "terminal": 0.1, "latent": ["7", 0]
  }},
  "9": { "class_type": "KSamplerSelect", "inputs": { "sampler_name": "euler" }},
  "10": { "class_type": "RandomNoise", "inputs": { "noise_seed": 42 }},
  "11": { "class_type": "CFGGuider", "inputs": {
    "model": ["1", 0], "positive": ["6", 0], "negative": ["6", 1], "cfg": 3.0
  }},
  "12": { "class_type": "SamplerCustomAdvanced", "inputs": {
    "model": ["1", 0], "positive": ["6", 0], "negative": ["6", 1],
    "sigmas": ["8", 0], "latent_image": ["7", 0],
    "noise": ["10", 0], "sampler": ["9", 0], "guider": ["11", 0]
  }},
  "13": { "class_type": "VAEDecode", "inputs": { "samples": ["12", 0], "vae": ["2", 0] }},
  "14": { "class_type": "CreateVideo", "inputs": { "images": ["13", 0], "fps": 25 }},
  "15": { "class_type": "SaveVideo", "inputs": { "video": ["14", 0], "filename_prefix": "video/ltxv23", "format": "auto", "codec": "auto" }}
}
```

**For the distilled 2.3 path**, apply `ltx-2.3-22b-distilled-lora-384-1.1.safetensors` to the GGUF UNet with `LoraLoaderModelOnly` and drop steps to 8, cfg 1.0 (same distilled settings as LTX-2). Note the VAE comes from node `["2", 0]` (the separate `VAELoader`), not from the model loader.

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
4. For LTX-2.3, pick the GGUF quant to match VRAM: **Q4_K_S** (<12GB), **Q5_K_S** (12–16GB), **Q8_0** (24GB+). The dev GGUF needs ~20+ steps; the distilled LoRA path runs ~8 steps
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

This requires the spatial upscaler model in `models/latent_upscale_models/`: `ltx-2.3-spatial-upscaler-x2-1.1.safetensors` (LTX-2.3) or `ltx-2-spatial-upscaler-x2-1.0.safetensors` (LTX-2).

## Using alternate / GGUF base models (incl. the "sulphur" model)

You can swap the LTX UNet for any LTX-2.3-compatible base model. The most-asked-about one is **Sulphur 2** (the user's "sulphur2Base_dev.safetensors" — see name note below).

### What Sulphur 2 actually is (verified June 2026)

- **It exists and is real.** Sulphur 2 is an uncensored, realism-leaning **finetune/derivative of LTX-2.3** (22B DiT), marketed as a drop-in replacement inside existing LTX-2.3 ComfyUI graphs (T2V + I2V + the other 2.3 formats). It is NOT its own architecture and is **not LTX-2 (19B) compatible** — it targets the LTX-2.3 stack (2.3 VAE + Gemma 3 text encoder + 2.3 text projection).
- **Filename caveat:** there is no file literally named `sulphur2Base_dev.safetensors`. The real base checkpoints are **`sulphur_dev_bf16.safetensors`** (~46 GB) and **`sulphur_dev_fp8mixed.safetensors`** (~29 GB). There is also a distilled variant (`sulphur_distil_bf16.safetensors`) and a LoRA (`sulphur_lora_rank_768.safetensors`). Treat "sulphur2Base_dev" as the user's shorthand for the Sulphur 2 base dev checkpoint.
- **GGUF version: confirmed.** `vantagewithai/Sulphur-2-Base-GGUF` hosts `sulphur_dev-<quant>.gguf` for Q3_K_S/M, Q4_0/1/K_S/K_M, Q5_0/1/K_S/K_M, Q6_K, Q8_0 (~10–23 GB). There is also a `Civitai/Sulphur-2-distilled-fp8` and Civitai listings ("Sulphur 2 Base", "Rebels Sulphur 2 GGUF").
- **Hosting:** HF `SulphurAI/Sulphur-2-base` (safetensors + a bundled Qwen-based prompt-enhancer GGUF), HF `vantagewithai/Sulphur-2-Base-GGUF` (the GGUF quants), and Civitai mirrors. Uncensored open weights — in scope to document; nothing here is fabricated, but verify the exact repo/license yourself before downloading.

### How to load it (it slots straight into the LTX-2.3 GGUF workflow above)

The GGUF quant is just a different UNet — load it with the **same `UnetLoaderGGUF` node**, keep the rest of the 2.3 graph identical:

1. Put `sulphur_dev-Q8_0.gguf` (or your chosen quant) in `models/unet/`.
2. In the LTX-2.3 GGUF workflow above, change node `"1"`:
   ```json
   "1": { "class_type": "UnetLoaderGGUF", "inputs": { "unet_name": "sulphur_dev-Q8_0.gguf" }}
   ```
3. Keep the **same LTX-2.3 companions**: `VAELoader` → `LTX23_video_vae_bf16.safetensors`, `CLIPLoader (type=ltxv)` → `gemma_3_12B_it_fp4_mixed.safetensors`, plus `ltx-2.3_text_projection_bf16.safetensors`. These must match the LTX-2.3 architecture — do not pair it with LTX-2 (19B) VAE/encoder.
4. For the **bf16/fp8 safetensors** (non-GGUF) variants, load with the LTX checkpoint/diffusion-model loader the workflow uses for the safetensors path (Lightricks recommends the native LTX Video nodes documented at docs.ltx.video, not the auto-generated Diffusers snippet) rather than `UnetLoaderGGUF`.
5. Obey the same constraints as any LTX-2.3 gen: frame count `8n+1`, resolution multiples of 32, `LTXVConditioning` frame_rate, dev model ~20+ steps / distilled ~8 steps.

### General rule for ANY alternate LTX base model

To verify a third-party model is usable before wiring it up:
- Confirm the **architecture/version it was trained on** (LTX-2 19B vs LTX-2.3 22B). Mixing a 2.3 UNet with a 2.0 VAE/encoder will fail or produce garbage.
- For **GGUF**: requires the **ComfyUI-GGUF** custom node (installed by the scripts), file in `models/unet/`, loaded via `UnetLoaderGGUF`. Match the correct VAE + text encoder + text projection for that LTX version.
- For **safetensors finetunes**: load like the matching official checkpoint, keep the official VAE/encoder of the same version.
- If you only have a **LoRA** (e.g. `sulphur_lora_rank_768.safetensors`), apply it to the matching base UNet with `LoraLoaderModelOnly` instead of swapping the whole model.

## Troubleshooting

### LTXVideo "kornia" import error (`pad` ImportError)

**Symptom:** ComfyUI-LTXVideo fails to load with an ImportError from `kornia.geometry.transform.pyramid` — `pad` can no longer be imported. This happens with **kornia 0.8.3+**, which stopped exporting `pad` from that module.

**What the fix does** (`FIX-LTXVIDEO-KORNIA.bat`, run from the `ComfyUI_windows_portable` folder): it patches `ComfyUI/custom_nodes/ComfyUI-LTXVideo/pyramid_blending.py`:
1. Backs the file up to `pyramid_blending.py.bak_kornia_fix`.
2. Removes the broken `pad,` line from the `from kornia.geometry.transform.pyramid import ( ... )` block.
3. Inserts a compatibility shim right after `import torch.nn.functional as F`:
   ```python
   # Compatibility fix for Kornia 0.8.3+ where pad is no longer exported here
   pad = F.pad
   ```
4. Verifies `pad = F.pad` is present and the broken import is gone.

**Manual equivalent** if you don't run the .bat — edit `pyramid_blending.py`: delete `pad,` from the kornia import list and add `pad = F.pad` after the `import torch.nn.functional as F` line, then restart ComfyUI. (Alternatively, pin kornia to a pre-0.8.3 release, but the patch is the lighter-touch fix and is what the install set ships.)

### LTXVideo version / workflow mismatch

The RunPod installer pins **ComfyUI-LTXVideo to commit `cd5d371518afb07d6b3641be8012f644f25269fc`** for workflow compatibility. If 2.3 workflows error on the latest LTXVideo, check out that commit. Torch is pinned to 2.4.0 + cu121; do not let a node's `requirements.txt` upgrade torch (the installers sanitize requirements to prevent this).

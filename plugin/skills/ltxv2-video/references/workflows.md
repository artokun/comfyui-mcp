# LTX-2 / LTX-2.3 — install scripts and complete API-JSON workflows

Bulky copy-paste material split out of [`../SKILL.md`](../SKILL.md). Read that
first for the verified setup, node stack and sampler settings; come here when you
need the exact install commands or a full graph to build from.

## Contents

- [Install scripts (step-by-step source of truth)](#install-scripts-step-by-step-source-of-truth): LTX-2 and LTX-2.3 GGUF download commands
- [Complete Workflow: T2V Distilled (8-Step)](#complete-workflow-t2v-distilled-8-step): LTX-2 bundled-checkpoint graph
- [Complete Workflow: LTX-2.3 GGUF (dev, T2V)](#complete-workflow-ltx-23-gguf-dev-t2v): GGUF UNet + separate VAE graph

## Install scripts (step-by-step source of truth)

Three installers (by "Aitrepreneur") were used; they all download from `HF = https://huggingface.co/Aitrepreneur/FLX/resolve/main`:

- `LTX-2-3-MODELS-NODES_INSTALL-V2.bat` runs from `...\ComfyUI_windows_portable\ComfyUI\`. It locks the current pip env into a constraints file, sanitizes each node's `requirements.txt` (strips torch/file-wheels/extra-index lines), clones nodes, downloads models. Flags: `/update`, `/force`, `/dryrun`, `/restore`.
- `LTX-2-3-ULTRA-COMFYUI-MANAGER_AUTO_INSTALL-V2.bat` is the full one-click install: it downloads ComfyUI portable `v0.22.0`, installs 7-Zip/Git if missing, clones the same nodes, downloads the same models, then launches ComfyUI.
- `LTX-2-3-AUTO_INSTALL-RUNPOD-V2.sh` is for Linux/RunPod. It recreates a clean venv, pins **torch 2.4.0 / torchvision 0.19.0 / torchaudio 2.4.0 / xformers 0.0.27.post2 on cu121**, transformers 4.51.3, tokenizers >=0.21,<0.22, timm 1.0.15. Pins **ComfyUI-LTXVideo to commit `cd5d371518afb07d6b3641be8012f644f25269fc`** for workflow compatibility, and verifies the LTXVideo import at the end.

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

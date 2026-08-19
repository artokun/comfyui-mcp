---
name: anima-lora-trainer
description: Train a custom anime LoRA on the ANIMA base model — Citron's local Gradio trainer (kohya sd-scripts), <6GB VRAM, character/style LoRAs; covers setup, dataset prep, training params, and using the result in the anima-base workflow
globs:
  - "**/*.py"
  - "**/*.toml"
  - "**/*.json"
---

# Citron Anima LoRA Trainer

## Overview

**Citron's Anima LoRA Trainer** (`app.py` = "🍋 Citron's Anima LoRA Trainer") is a local **Gradio** UI for training LoRA adapters on the **Anima** diffusion model using **kohya-ss/sd-scripts**. It trains on **~6GB VRAM** with the default settings — same low-VRAM profile as Anima generation.

- Created by **Citron Legacy**; UI repo: `https://github.com/citronlegacy/citron-anima-lora-trainer-ui`. The Aitrepreneur adaptive installers clone the fork `https://github.com/aitrepreneur/citron-anima-lora-trainer-ui`.
- Training backend: `kohya-ss/sd-scripts` (`https://github.com/kohya-ss/sd-scripts`), launched via `accelerate launch`.
- Trains LoRAs for **Anima DiT** (Cosmos-2B). Uses Anima's own components: DiT weights + Qwen3-0.6B text encoder + Qwen-Image VAE.
- Output: standard `.safetensors` LoRA usable directly in the **anima-base** ComfyUI workflow.

> Network module is `networks.lora_anima` and the training script is `sd-scripts/anima_train_network.py` (an Anima-specific kohya script the installer expects). Confirm these exist after the installer's `git clone` of sd-scripts — they are referenced by `app.py` but pulled from the upstream repo at install time.

## Setup

### Windows
Run `CITRON_ANIMA_LORA_TRAINER-V2.bat`. It:
1. Ensures **Git** and **Python 3.10** (via winget if missing).
2. Detects the NVIDIA GPU/driver and picks a matching **PyTorch CUDA wheel** automatically:
   - Blackwell (RTX 50xx) → cu128, bf16
   - Modern (RTX 20/30/40, etc.) → cu128/cu126/cu118 by driver, bf16 (fp16 on Turing)
   - Pascal/Maxwell (GTX 10/9xx) → cu126/cu118, **fp16**
   - Kepler/older → unsupported
3. Clones the UI repo, patches `app.py` defaults (`base_model` → `anima-preview3-base`, `mixed_precision` → detected value), writes `app_configs/accelerate_gpu.yaml`.
4. Creates `.venv`, installs PyTorch, clones+installs `sd-scripts`, installs app `requirements.txt`.
5. Downloads models into `models/anima/{dit,text_encoder,vae}/` from `https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/...`:
   - `dit/anima-base-v1.0.safetensors` (~4GB)
   - `text_encoder/qwen_3_06b_base.safetensors` (~1.19GB)
   - `vae/qwen_image_vae.safetensors` (~254MB)
6. Writes and launches `run_anima_base_windows.bat`.

### RunPod / Linux
Run `CITRON_ANIMA_LORA_TRAINER-RUNPOD-V2.sh`. Same flow into `/workspace/citron-anima-lora-trainer-ui`; patches `server_name` to `0.0.0.0`; expose **HTTP port 7860** and open `Connect → HTTP Service 7860` (or `https://${RUNPOD_POD_ID}-7860.proxy.runpod.net`).

### Launch
`app.py` runs Gradio on **`0.0.0.0:7860`** → open **http://127.0.0.1:7860**. Re-launch later with `run_anima_base_windows.bat` (Win) or `./run_anima_base_runpod.sh` (RunPod). The DiT base model **auto-downloads on first "Start Training"** if not already present (uses `wget`).

## Dataset preparation

A **flat folder** of images, each with a matching `.txt` caption of the same basename (image-side captioning, kohya style):
```
my_dataset/
  001.png      001.txt
  002.jpg      002.txt
  ...
```
- Accepted images: `.jpg .jpeg .png .webp .bmp .gif`.
- Captions are Danbooru-style tags / natural language (same prompt style as Anima generation). The trainer warns about any image missing a `.txt`.
- `caption_extension = .txt`; `shuffle_caption = false`; `caption_dropout_rate` default `0.1` (set per dataset).

The UI tab "Training" takes **Image Directory** (the flat folder above) and **Output Directory** (where the LoRA is saved). "Configure Training" validates the dataset, prints a **step estimate** (`steps_per_epoch = ceil(images × repeats / (batch × grad_accum))`, `total = spe × epochs`), then writes two TOMLs into `configs/`.

## Key training parameters (defaults from `app.py`)

### Basic
| Param | Default | Notes |
|-------|---------|-------|
| project_name | `my_lora` | also the `output_name` of the LoRA |
| base_model | `anima-base-v1.0` | dropdown: `anima-preview`, `anima-preview2`, `anima-preview3-base`, `anima-base-v1.0` (installer patches default to `anima-preview3-base`) |
| network_dim | `32` | LoRA rank |
| network_alpha | `32` | |
| learning_rate | `1e-4` | |
| max_train_epochs | `10` | |
| resolution | `768` | px; dataset bucketing 256–4096, step 64 |
| repeats | `10` | per-image repeats |
| caption_dropout | `0.1` | |

### Advanced
| Param | Default | Notes |
|-------|---------|-------|
| optimizer_type | `AdamW8bit` | choices: AdamW8bit, AdamW, Lion, SGD, Prodigy; `optimizer_args = ["weight_decay=0.1", "betas=[0.9, 0.99]"]` |
| lr_scheduler | `cosine_with_restarts` | + cosine, linear, constant, constant_with_warmup, polynomial |
| lr_scheduler_num_cycles | `1` | |
| lr_warmup_steps | `100` | |
| train_batch_size | `1` | |
| gradient_accumulation_steps | `1` | |
| max_grad_norm | `1.0` | |
| save_every_n_epochs | `1` | |
| save_last_n_epochs | `4` | keep last N checkpoints |
| mixed_precision | `bf16` | installer overrides to fp16 on older GPUs |
| gradient_checkpointing | `true` | memory saver |
| seed | `42` | |
| noise_offset | `0.03` | |
| multires_noise_discount | `0.3` | |
| timestep_sampling | `sigmoid` | + uniform, logit_normal |
| discrete_flow_shift | `1.0` | flow-matching shift |
| cache_latents | `true` | |
| cache_text_encoder_outputs | `true` | |
| vae_chunk_size | `64` | |
| vae_disable_cache | `true` | |
| num_cpu_threads_per_process | `1` | |

Fixed in the generated training TOML (not exposed): `network_module = networks.lora_anima`, `network_train_unet_only = true`, `qwen3_max_token_length = 512`, `t5_max_token_length = 512`, `save_model_as = safetensors`, `save_precision = bf16` (fp16 on older GPUs).

## Generated config files

`configs/<project>_training_<timestamp>.toml` — references the DiT (`pretrained_model_name_or_path`), `qwen3` text encoder, and `vae` paths from `models/anima/`, plus all params above.

`configs/<project>_dataset_<timestamp>.toml`:
```toml
[general]
resolution = 768
enable_bucket = true
bucket_no_upscale = false
bucket_reso_steps = 64
min_bucket_reso = 256
max_bucket_reso = 4096

[[datasets]]
resolution = 768
[[datasets.subsets]]
num_repeats = 10
image_dir = "/path/to/my_dataset"
caption_extension = ".txt"
caption_dropout_rate = 0.1
```

## The sd-scripts command

"Start Training" runs (streaming logs live to the UI and to `logs/<project>_<timestamp>.log`):
```bash
accelerate launch \
  --config_file app_configs/accelerate_gpu.yaml \
  --num_cpu_threads_per_process 1 \
  --gpu_ids 0 \
  sd-scripts/anima_train_network.py \
  --config_file  configs/<project>_training_<timestamp>.toml \
  --dataset_config configs/<project>_dataset_<timestamp>.toml
```
`accelerate_gpu.yaml` pins `use_cpu: false`, `mixed_precision: <bf16|fp16>`, single process/machine. `CUDA_VISIBLE_DEVICES` is set to the selected GPU index.

## Output & using the LoRA

- The trained LoRA is saved to your **Output Directory** as `<project_name>.safetensors` (plus per-epoch checkpoints, last `save_last_n_epochs` kept).
- Copy it into ComfyUI `models/loras/` and load it in the **anima-base** workflow via `LoraLoaderModelOnly` (or rgthree `Power Lora Loader`):
  ```json
  { "class_type": "LoraLoaderModelOnly",
    "inputs": { "model": ["<unet>", 0], "lora_name": "<project_name>.safetensors", "strength_model": 1.0 } }
  ```
- Use the same prompt style you captioned with. Typical strength 0.7–1.0; stack with the turbo LoRA for fast 12-step generation.

## VRAM & tips

- Defaults train on **~6GB VRAM** (network_dim 32, res 768, batch 1, gradient checkpointing + latent/TE caching).
- **OOM?** The trainer suggests `network_dim=8` and/or `resolution=512`. Also keep batch 1 and use AdamW8bit.
- GTX 1060 6GB works but is slow; 3GB cards are not realistic. Older-than-Pascal GPUs are unsupported.
- Step count rule of thumb: `images × repeats × epochs / (batch × grad_accum)`. The UI prints the exact estimate before you train.
- Logs stream to the UI and `logs/`. Training config + last paths persist in `config.json` so you can re-run.

## Unverified / verify before relying

- `sd-scripts/anima_train_network.py` and `networks.lora_anima` come from the kohya fork pulled at install time — present per `app.py`'s expectations but not in the local downloaded files here.
- Exact LoRA output filename is `<project_name>.safetensors` per `output_name`; confirm in your Output Directory after a run.

## Sources

- **Official:** https://github.com/citronlegacy/citron-anima-lora-trainer-ui and https://github.com/kohya-ss/sd-scripts
- **Empirical:** installer/launch notes from the pack scripts; training defaults from the UI's app.py as observed.

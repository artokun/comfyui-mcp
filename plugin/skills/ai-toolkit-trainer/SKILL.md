---
name: ai-toolkit-trainer
description: Train custom LoRAs with ostris AI-Toolkit — covers WAN 2.2/2.1 (people, styles, video motion) and Z-Image (Turbo & Base, low-VRAM image LoRAs). Use when the user wants to train a WAN or Z-Image LoRA; covers local + RunPod setup, dataset prep, key params, and using the result in a ComfyUI workflow.
globs:
  - "**/*.json"
---

# AI-Toolkit LoRA Trainer (WAN 2.2 & Z-Image)

## Overview

**AI-Toolkit** by **ostris** is "the ultimate training toolkit for finetuning diffusion models" (MIT license) — a **standalone trainer with its own web UI**, NOT a ComfyUI custom node. It runs a Node.js UI front end over a Python (`run.py`) training backend, and trains LoRAs for many model families — here we cover **WAN 2.2 / 2.1** video models and **Z-Image** (Turbo & Base).

- Repo: **`https://github.com/ostris/ai-toolkit`** (cloned by the installers).
- Backend: `python run.py config/<job>.yml`. UI: a Node.js app under `ui/` that schedules/monitors jobs (you don't have to keep the UI open while a job runs).
- Output: a standard `.safetensors` LoRA you drop into ComfyUI `models/loras/` and load with `LoraLoaderModelOnly`.

**Best for:**
- **WAN LoRAs** — a person/character, an art style, or a specific **camera/video motion** (image *or* video clip datasets). For *using* WAN see **wan-t2v-video** / **wan-flf-video**.
- **Z-Image LoRAs** — fast, **very low-VRAM** image LoRAs (faces, characters, outfits, styles) on the 6B Z-Image base/turbo. For *using* Z-Image see **z-image-base** / **z-image-turbo** (and the **z-image-xy-plot** pack to compare trained LoRAs).

For low-VRAM anime image LoRAs on a different stack (kohya `sd-scripts`), see the sibling **anima-lora-trainer**.

> **Two LoRA kinds (WAN):** a **WAN image LoRA** trains on still images (cheaper, ~24GB-class, good for identity/style); a **WAN video LoRA** trains on short clips (heavier — best on cloud — good for *motion*). **Z-Image** is image-only.

## Install

The installer comes in two generations — both clone `ostris/ai-toolkit`, set up Torch for your GPU, and launch the web UI. Put it in a folder whose **full path has NO spaces** (e.g. `C:\AI-Toolkit`).

- **V1 — `AI-TOOLKIT_AUTO_INSTALL.bat`**: expects **Git**, **Python 3.10.x**, and **Node 18+** already in PATH.
- **V2 — `AI-TOOLKIT_AUTO_INSTALL-V2.bat`** (recommended): uses an **embedded Python 3.10.11**, **auto-installs Git + Node**, builds a clean PATH without your system Python, and adds aggressive pip/curl retries — far fewer prerequisites and the more robust choice. (Used for the Z-Image Turbo LoRA training release.)

Both are CUDA-aware and select the Torch wheel by GPU generation:

| Choice | GPU | CUDA | Torch index | Torch packages |
|--------|-----|------|-------------|----------------|
| 1 | RTX 50-series (Blackwell) | **12.8** | `https://download.pytorch.org/whl/cu128` | `torch==2.7.0 torchvision==0.22.0` |
| 2 | RTX 40 / 30 / 20 and older | **12.6** | `https://download.pytorch.org/whl/cu126` | `torch==2.7.0 torchvision==0.22.0` |

Each then: clones `ostris/ai-toolkit`; downloads two launcher scripts (`LAUNCHER-TOOLKIT.bat`, `SECURE_LAUNCHER-TOOLKIT.bat`, from `https://huggingface.co/Aitrepreneur/FLX/resolve/main/`); makes the venv; installs Torch from the chosen index; `pip install -r requirements.txt`; then `cd ui && npm run build_and_start`.

### RunPod / Linux — `AI-TOOLKIT_AUTO_INSTALL-RUNPOD.sh` (and `-V2.sh`)

Installs into the persistent volume `/workspace/ai-toolkit`; **idempotent** (re-run just relaunches the UI). Use RunPod's **PyTorch 2.8.0** template, **100GB** disk. It installs apt deps, clones the repo, makes a venv, installs Torch (`torchaudio` included), installs **nvm + Node 22**, then builds/starts the UI.

| Choice | GPU | Stream | Torch spec |
|--------|-----|--------|-----------|
| 1 | RTX 5000-series (Blackwell) | `cu128` | `torch==2.7.0+cu128 torchvision==0.22.0+cu128 torchaudio==2.7.0+cu128` |
| 2 | Ada / Hopper / Ampere, older | `cu126` | `torch==2.7.0 torchvision==0.22.0 torchaudio==2.7.0` |

**Ports & auth:** UI on **8675**, Jupyter on **8888**. Set **`AI_TOOLKIT_AUTH`** (UI password) before launch. Reach it at `https://${RUNPOD_POD_ID}-8675.proxy.runpod.net`. **GPU recs:** RTX **4090/5090** for image (WAN t2i/t2v, Z-Image) LoRAs; **RTX 6000 Pro (Blackwell)** for heavy WAN video / high-res / high-rank jobs.

## Launching the web UI

- **Windows:** run `LAUNCHER-TOOLKIT.bat` (local) or `SECURE_LAUNCHER-TOOLKIT.bat` (password-protected) from the `ai-toolkit` folder.
- **RunPod:** rerun the `.sh` — it detects the install and starts the UI instantly on **:8675**.

In the UI: create a **Job**, point it at a dataset folder, pick the model (WAN variant or Z-Image), set params, start. Jobs run in the Python backend, so you can close the browser. (Or bypass the UI: copy a `config/examples/*.yml`, edit, `python run.py config/<job>.yml`.)

## Dataset preparation

AI-Toolkit pairs each sample with a same-basename `.txt` caption and auto-resizes/buckets aspect ratios (no pre-cropping).

### Image LoRA (WAN identity/style, or Z-Image)
```
my_dataset/
  001.png  001.txt
  002.jpg  002.txt
```
- Captions: natural-language; include a **unique trigger word** for a person/character.
- ~15–40 varied images for a person; more for a broad style.

### Video LoRA (WAN motion only)
Short clips + a `.txt` per clip; caption the **motion/camera move**. Per-clip frames via the job's `num_frames` (e.g. **81**). Markedly heavier — prefer cloud GPUs.

## Key training params

### WAN 2.2
WAN 2.2 14B is a Mixture-of-Experts with a **high-noise** expert (structure/motion) and a **low-noise** expert (detail). AI-Toolkit trains both via **Multi-stage**.

| Param | Default | Notes |
|-------|---------|-------|
| Linear rank / dim | **16** | 16 simple; 16–32 complex/cinematic |
| Learning rate | **5e-5** (identity) | 7e-5–1e-4 style; high LR → plasticky skin |
| Steps | **1500–2500** | stop before overbaking |
| Resolution | **512** (or 768) | bucketed; 768 costs more VRAM |
| `num_frames` (video) | **81** | per-clip frame count |
| Multi-stage | **High + Low = ON** | trains both experts |
| Switch Every | **10** | raise to 20–50 if offload swapping is slow |
| Optimizer / Quant | AdamW8bit / 4-bit ARA or float8 | fits 14B on consumer cards |

### Z-Image (Turbo & Base)
Z-Image is a ~6B **single-stream** model — **no hi/lo multi-stage** (leave Multi-stage OFF; you train one model). It's the lightest target here: the headline of the Z-Image releases is training on very low VRAM.

| Param | Starting point | Notes |
|-------|----------------|-------|
| Linear rank / dim | **16–32** | 32 for detailed characters/styles |
| Learning rate | **1e-4** | lower (5e-5) for tighter identity |
| Steps | **1500–3000** | dataset-dependent |
| Resolution | **768** (or 1024) | Z-Image's native range |
| Multi-stage | **OFF** | single-stream model, not WAN's MoE |
| Optimizer / Quant | AdamW8bit / float8 | enables sub-12GB training |

> **Train on Base, deploy anywhere.** Z-Image **Base** is the finetuning-friendly model; a LoRA trained on Base generally applies to the Turbo workflow too. Use the **z-image-xy-plot** pack to grid-compare your trained LoRAs.

> Param tables are aggregated starting points (community/training-guide sources), **not** read from the repo's `config/examples/*.yml` — open the actual WAN / Z-Image example config in your clone and tune. See "Unverified".

## VRAM / GPU guidance

- **Z-Image image LoRA:** the lightest — trainable on modest consumer GPUs with quantization (the releases tout very-low-VRAM training); a 4090 is comfortable, smaller cards work with float8 + 512–768 res.
- **WAN image LoRA (t2i/t2v):** **24GB+** locally with quantization; below that, use RunPod.
- **WAN video LoRA / high res / high rank:** heavier — cloud (RTX 5090, or RTX 6000 Pro Blackwell / H100).
- Memory savers: quantization, batch size 1, 512 res, and (WAN) raise **Switch Every**.

## Using the trained LoRA in ComfyUI

1. Copy `<your_lora>.safetensors` into ComfyUI **`models/loras/`**.
2. Load with **`LoraLoaderModelOnly`**:
   - **WAN 2.2** is **dual hi/lo** — apply the LoRA to **both** the HighNoise and LowNoise model branches (like lightning/concept LoRAs in **wan-t2v-video**). Typical strength **0.5–1.0**.
   - **Z-Image** is a **single model** — one `LoraLoaderModelOnly` on the Z-Image model path (see the **z-image-base** / **z-image-turbo** packs). Strength **0.7–1.0**.
   ```json
   { "class_type": "LoraLoaderModelOnly",
     "inputs": { "model": ["<base_model>", 0],
                 "lora_name": "<your_lora>.safetensors",
                 "strength_model": 1.0 } }
   ```
3. Prompt using the **trigger word / caption style** you trained with (for WAN motion LoRAs, describe the same camera/motion).

## Troubleshooting

- **`No module named 'torchaudio'` when starting a job (AI-Toolkit).** The venv's Torch stack is mismatched. **Fix:** activate the AI-Toolkit venv (`venv\Scripts\activate`), then `pip uninstall torch torchaudio torchvision -y` and `pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121` (or your CUDA's index). Only affects the AI-Toolkit install, not ComfyUI.
- **`self and mat2 must have the same dtype` (ComfyUI-WanVideoWrapper, WAN usage).** Re-clone `ComfyUI-WanVideoWrapper` in `custom_nodes/` and reinstall its `requirements.txt`, then restart ComfyUI.
- **5000-series (Blackwell) onnxruntime "QuickGelu" / CUDA error.** `pip install onnxruntime==1.20.1` in the affected venv.
- **Pascal/Maxwell GPUs (GTX 9xx/10xx).** Recent Torch (cu128/cu130) dropped them — reinstall the **cu126** Torch build into the venv.
- **Path with spaces (Windows).** Keep the install path space-free or the build/launch fails.
- **OOM during training.** Quantization (4-bit ARA / float8), 512 res, batch 1, (WAN) raise Switch Every, or a bigger RunPod GPU.
- **RunPod UI won't load / asks for a password.** Confirm `AI_TOOLKIT_AUTH` is set and you're on the **8675** proxy URL.

## Unverified / verify before relying

- The **param tables** (both WAN and Z-Image) are synthesized starting points, **not** read from the repo's `config/examples/*.yml`. Open the actual example config in your clone and adjust.
- **Z-Image VRAM floor** for training is described qualitatively ("very low VRAM") in the release notes — confirm against your card; quantization + 512–768 res is the lever.
- **Ports:** Windows UI port is whatever the launcher binds (the installer doesn't print it — check the launcher window). RunPod **8675**/**8888** are per the template.
- The launcher `.bat` files are downloaded from a **third-party HuggingFace repo** (`Aitrepreneur/FLX`); review before running on a security-sensitive machine.
- Model weights are fetched at job time by AI-Toolkit/HF, not by the installer — confirm the model selector lists your target WAN variant or Z-Image model before a long run.

## Sources

- **Official:** https://github.com/ostris/ai-toolkit
- **Empirical:** Windows/RunPod installer steps and VRAM notes from the pack installers, not the vendor's training guide.

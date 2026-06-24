---
name: krea2-txt2img
description: Build Krea 2 Turbo txt2img workflows — native krea2 CLIPLoader, Qwen3-VL encoder, Qwen image VAE, 8-step turbo settings, and Ideogram-style JSON prompting
globs:
  - "**/*.json"
---

# Krea 2 Text-to-Image Workflows

## Overview

Krea 2 is a **12B-parameter Diffusion Transformer** from Krea.ai (released June
2026, weights open-sourced under the Krea 2 Community License — free commercial
use up to 50 seats). Two variants:

1. **Krea 2 Raw** — the base checkpoint before extra post-training. For
   fine-tuning / maximum fidelity, more steps.
2. **Krea 2 Turbo** — post-trained + **distilled**; generates in **~8 steps at
   cfg 1**. This is what the `krea2-txt2img` pack ships.

Krea 2 has **native ComfyUI support** (`comfy/text_encoders/krea2.py`, ComfyUI ≥
v0.26.0): the `CLIPLoader` uses **`type=krea2`**, with a **Qwen3-VL 4B** text
encoder and the **Qwen image VAE**. The Qwen3-VL encoder drives strong prompt
adherence and structured-JSON prompts.

## Models (all from the `Aitrepreneur/FLX` mirror; official: `krea/Krea-2-Turbo`)

| Slot | File | Notes |
|---|---|---|
| `diffusion_models/` | `krea2_turbo_fp8.safetensors` | 12B Turbo, fp8 — RTX 4000/3000/2000 |
| `diffusion_models/` | `krea2_turbo_mxfp8.safetensors` | RTX 5000 (Blackwell) native fp8 |
| `text_encoders/` | `qwen3vl_4b_fp8_scaled.safetensors` | Qwen3-VL 4B encoder |
| `vae/` | `qwen_image_vae.safetensors` | Qwen image VAE |

## Node stack

- **core**: `UNETLoader` (krea2_turbo) → `CLIPLoader` (type=krea2) → `VAELoader`
  (qwen_image_vae), wired via KJNodes `SetNode`/`GetNode` buses into a subgraph
  (`CLIPTextEncode` → `KSampler` → `VAEDecode`, with an rgthree `Any Switch` that
  picks the manual prompt vs the JSON-builder prompt).
- **rgthree-comfy**: Power Lora Loader, Any Switch, Label, Fast Groups.
- **ComfyUI-KJNodes**: Set/Get, `Ideogram4PromptBuilderKJ`, `ImageSharpenKJ`.
- **ComfyUI-RBG-SmartSeedVariance**: `RBG_Smart_Seed_Variance` (opt-in).
- **ComfyUI-ConditioningKrea2Rebalance**: `ConditioningKrea2Rebalance` — the Krea 2
  **safety-filter bypass**. Ship it **bypassed**; the filter is intact by default.

## Settings that matter

- **steps 8, cfg 1** — Turbo is distilled; more steps/higher cfg over-cooks it.
- **sampler `er_sde`, scheduler `simple`** — the verified defaults.
- **1920×1080** default; Krea 2 handles a wide aspect range.
- The JSON prompt-builder (`Ideogram4PromptBuilderKJ`), seed-variance, and
  laplacian-sharpen post-proc ship **bypassed** — opt-in.

## JSON / area prompting

Like Ideogram 4, Krea 2's Qwen3-VL encoder reads structured prompts (per-region
desc + bounding boxes + palettes). Enable the **TEXT PROMPT BUILDER** group to
use `Ideogram4PromptBuilderKJ` instead of the plain prose prompt.

## Gotchas

- `CLIPLoader: 'krea2' not in list` → ComfyUI too old; update to ≥ v0.26.0.
- `Torch not compiled with CUDA enabled` → reinstall torch for your CUDA tag
  (`--index-url https://download.pytorch.org/whl/cu128`).

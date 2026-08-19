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
   cfg 1**. This is what the krea2 txt2img packs ship.

## Three packs (V2 — no group toggles)

Sliced from the **KREA2 ULTRA V2** monolith into standalone single-pipeline packs
— pick by how you prompt / what you want:

- **`krea2-txt2img-manual`** — plain prose prompt (the `MANUAL PROMPT` node).
- **`krea2-txt2img-json`** — Ideogram-4-style structured JSON / area prompting
  (`Ideogram4PromptBuilderKJ`).
- **`krea2-combo`** — two-pass **detail boost**: a first pass then a low-denoise
  refine (denoise 0.3), with the krea2 **turbo LoRA** @0.2 on both passes +
  (optional) the **IdeoKrea** LoRA. JSON/Ideogram-style prompting; saves both
  passes to compare.

Each pack's one prompt source is active (no prompt-mode bypass to flip).
`ImageSharpenKJ` runs before `SaveImage`. **V2** adds the `Krea2T-Enhancer` MODEL
detail-boost patch (ships **active**) and drops v1's `ConditioningKrea2Rebalance`.
`RBG_Smart_Seed_Variance` ships **bypassed** (optional, see below).

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
| `loras/` | `krea2_turbo_lora_rank_64_bf16.safetensors` | turbo LoRA — **combo** only, @0.2 both passes |
| `loras/` | `IdeoKrea-test.safetensors` | OPTIONAL Ideogram-style LoRA (`Aitrepreneur/IdeoKrea`) — combo add-in |

## Node stack

- **core**: `UNETLoader` (krea2_turbo) → `CLIPLoader` (type=krea2) → `VAELoader`
  (qwen_image_vae), wired via KJNodes `SetNode`/`GetNode` buses into a subgraph
  (`CLIPTextEncode` → `KSampler` → `VAEDecode`). An rgthree `Any Switch` sits in
  front of the encoder; in each pack only that pack's prompt source is wired to it
  (manual node in `-manual`, JSON builder in `-json`).
- **rgthree-comfy**: Power Lora Loader, Any Switch, Label, Fast Groups.
- **ComfyUI-KJNodes**: Set/Get, `Ideogram4PromptBuilderKJ`, `ImageSharpenKJ`, `INTConstant`.
- **ComfyUI-Krea2T-Enhancer** (`capitan01R`): `Krea2T-Enhancer` — **V2** MODEL→MODEL
  detail-boost patch, wired in the model path (PowerLora → Krea2T-Enhancer →
  sampler). Ships **active**; bypass to compare against the un-boosted result.
- **ComfyUI-RBG-SmartSeedVariance**: `RBG_Smart_Seed_Variance` — **optional**, ships
  **bypassed** in the positive-conditioning loop.
- **ComfyUI_essentials** (`cubiq`): `ImageResize+` — **combo** only (the two-pass
  VAE-roundtrip resize).

## Settings that matter

- **steps 8, cfg 1** — Turbo is distilled; more steps/higher cfg over-cooks it.
- **sampler `er_sde`, scheduler `simple`** — the verified defaults.
- **1920×1080** default; Krea 2 handles a wide aspect range.
- The prompt source is fixed per pack (manual node vs JSON builder) — no
  prompt-mode bypass to flip.

## V2 detail boost (`Krea2T-Enhancer`) + combo

- **`Krea2T-Enhancer`** is a MODEL→MODEL patch (the V2 "massive detail boost"). It
  sits inline in the model path and ships **active** in all three packs. Widgets
  are `[on, strength, …]`; bypass it (or toggle `on`) to A/B the boost.
- **`krea2-combo`** is the showcase: a two-pass refine — FIRST PASS (8 steps,
  `er_sde`, denoise 1) → VAE roundtrip → SECOND PASS (4 steps, `euler`, denoise
  **0.3**) — with the **turbo LoRA** @0.2 on both passes. It SAVES BOTH passes so
  you can see the boost. The **IdeoKrea** LoRA is downloaded but NOT wired by
  default — drop it into the Power Lora Loader's empty slot (start ~0.5–1.0; it's a
  test LoRA) for the turbo + IdeoKrea Ideogram-style combo.

## Optional post-proc (ships bypassed — un-bypass to use)

All packs leave `RBG_Smart_Seed_Variance` in the positive-conditioning loop
**bypassed** (passthrough). Un-bypass on the live canvas with `panel_set_node_mode`
(or in the UI) for controlled variations of the same prompt without changing the
composition — set its seed mode to `randomize` and tune the variance mode (e.g.
`🌿 Balanced`) / strength widgets. Leave bypassed for a deterministic result.

## JSON / area prompting

Like Ideogram 4, Krea 2's Qwen3-VL encoder reads structured prompts (per-region
desc + bounding boxes + palettes). For structured prompting just use the
**`krea2-txt2img-json`** pack — its `Ideogram4PromptBuilderKJ` drives the encoder
directly (no bypass to flip). After the render, VERIFY the image matches the JSON
you set (view it) BEFORE continuing; if it doesn't, a field is probably stale —
fix and rerun. Gotchas learned the hard way:

- **Set ALL the builder fields**, not just the prompt/boxes — `background`,
  `technical`, `style`, `lighting` (widgets 3/5/6/7). Leaving stale values leaks
  content (a leftover celebrity portrait bled into a tea still-life).
- **Keep palettes minimal or empty.** A rich top-level palette can render as a
  literal color-swatch strip down the edge of the image. Empty `palette: []`
  (top-level and per-box) gives a clean full-frame result.
- Add "no people / single full-frame photograph" to `style` for object/landscape
  scenes — Krea 2 follows it well.

## Verification status

- **v1 (`-manual` / `-json` core graph)**: render-verified — crisp 1920×1080 / 8
  steps / cfg 1 / er_sde (snow-leopard prose + tea-still-life JSON with each object
  in its bbox).
- **V2 additions** (the `Krea2T-Enhancer` active patch + the `krea2-combo` two-pass)
  are **statically validated** (clean slice + structural lint) but **not yet
  live-rendered** — they need the `ComfyUI-Krea2T-Enhancer` node + the turbo/IdeoKrea
  LoRAs installed and a healthy ComfyUI. Re-run `scripts/verify-render.mjs` once
  those are present.
- **Note:** the `ImageSharpenKJ` (rcas 0.55) before `SaveImage` is **active** —
  bypassing it drops the image link (a converter gap: bypass-passthrough doesn't
  cross a subgraph IMAGE output), and the contrast-adaptive sharpen suits Krea 2's
  crisp look anyway.

## Gotchas

- `CLIPLoader: 'krea2' not in list` → ComfyUI too old; update to ≥ v0.26.0.
- `Torch not compiled with CUDA enabled` → reinstall torch for your CUDA tag
  (`--index-url https://download.pytorch.org/whl/cu128`).

## Sources

- **Official:** none found.
- **Empirical:** sampler values, wiring, and prompt notes from working graphs in `packs/` and observed renders; not a vendor prompting guide.

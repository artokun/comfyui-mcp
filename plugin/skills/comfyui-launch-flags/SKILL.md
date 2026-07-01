---
name: comfyui-launch-flags
description: Pick the right ComfyUI startup flags for VRAM, attention, caching, and speed — the full decision matrix for OOM (--novram / --cache-none / --disable-smart-memory), shared-VRAM creep on Windows (--reserve-vram N), model-switching with big text encoders (--cache-none), high-VRAM throughput (--gpu-only / --highvram), and attention-backend selection (--use-sage-attention for speed, --use-pytorch-cross-attention as the highest-quality / Z-Image-safe fallback). Also the acceleration-stack + Blackwell/RTX 5000 (sm_120) notes. Use when a graph OOMs (especially long video like LTX 2 / WAN), when the GPU spills into shared VRAM and slows to a crawl, when switching between models eats all RAM, when Z-Image produces black/garbled output under Sage, or when deciding which attention backend to launch with. Flag names verified against upstream comfy/cli_args.py — see Sources.
globs:
  - "**/*.json"
  - "**/packs/**"
---

# ComfyUI launch/performance flags

## Overview

ComfyUI's runtime behavior is controlled by CLI flags passed to `main.py`
(e.g. `python main.py --reserve-vram 2 --use-sage-attention`). The three that
matter most for making a graph *run* — rather than OOM or crawl — are the
**VRAM strategy**, the **attention backend**, and the **cache mode**. This skill
is the decision matrix for choosing them.

> ⚠️ **Verification note (June 2026).** Every flag below was checked against
> upstream [`comfy/cli_args.py`](https://github.com/comfyanonymous/ComfyUI/blob/master/comfy/cli_args.py).
> ComfyUI adds/renames flags often — when in doubt run `python main.py --help`
> in the target install and prefer that over this list. One common non-upstream
> flag: **`--enable-triton-backend` is a SwarmUI backend flag, NOT a ComfyUI
> `main.py` flag** — don't pass it to ComfyUI directly.

> ℹ️ **How to apply today.** The MCP's `start_comfyui` currently *replays the
> exact argv of the previous run* — it does not compose fresh flags. So set
> these when you launch ComfyUI yourself (the `python main.py …` line, a
> `run.bat`/shell alias, or the SwarmUI backend args box), then `start_comfyui`
> will preserve them on restart. (Injecting flags through the tool is a tracked
> follow-up.)

---

## Decide first: which flag do you need?

```
Symptom                                             ▶ Flag(s) to try
─────────────────────────────────────────────────────────────────────────────
CUDA out of memory, long video (LTX 2 / WAN)        ▶ --novram  (+ --cache-none)
OOM, still want models resident when they fit       ▶ --reserve-vram N  then --disable-smart-memory
GPU slows to a crawl, spills into "shared GPU        ▶ --reserve-vram 2..4
  memory" (Windows WDDM) mid-run
RAM blows up switching between models, or a huge     ▶ --cache-none
  text encoder (FLUX 2 / Mistral) won't unload
Plenty of VRAM (48GB+), want max throughput         ▶ --gpu-only  or  --highvram
Want faster sampling on NVIDIA                       ▶ --use-sage-attention   (see caveats)
Z-Image produces BLACK / wrong output               ▶ --use-pytorch-cross-attention (NOT sage)
Sage gives black output on some models              ▶ --use-pytorch-cross-attention (or fix dtype)
```

VRAM strategy and attention backend are each **mutually exclusive groups** —
pass at most one from each. You can combine one VRAM flag + one attention flag +
one cache flag (e.g. `--novram --use-sage-attention --cache-none`).

---

## VRAM strategy (mutually exclusive)

| Flag | What it does | Use when |
|------|--------------|----------|
| `--gpu-only` | Keep everything (incl. text encoders) on GPU | 48GB+ card, single model, max speed |
| `--highvram` | Keep models resident in VRAM after use | High-VRAM card, repeated runs of one model |
| *(default)* | ComfyUI's smart offload | Most setups — try this first |
| `--lowvram` | Offload text encoders / parts to CPU | Mid card OOMing on load |
| `--novram` | Extreme offload — minimal VRAM footprint | OOM on long video / huge models; pair with `--cache-none` |
| `--cpu` | Everything on CPU (very slow) | No usable CUDA GPU only |

Modifiers (combine with the above):

- **`--reserve-vram N`** — reserve N GB for the OS / other apps. The fix for the
  Windows failure mode where the GPU quietly starts using **shared** VRAM and
  throughput collapses. Typical `2`–`4`; bump to `10` for heavy video decode.
- **`--disable-smart-memory`** — force aggressive offload to regular RAM instead
  of keeping models cached in VRAM. Reach for this when a run gets *stuck* or
  OOMs intermittently. Slightly slower, much more robust.
- **`--async-offload`** — async weight offload streams (default on where
  supported); `--disable-async-offload` to turn off if it misbehaves.

---

## Attention backend (mutually exclusive)

| Flag | Notes |
|------|-------|
| `--use-sage-attention` | Quantized SageAttention kernel, ~20–40% faster sampling. Needs the `sageattention` package installed and version-matched — see [`triton-sageattention`](../triton-sageattention/SKILL.md). |
| `--use-flash-attention` | FlashAttention kernels. Needs `flash-attn` built for your torch/CUDA. |
| `--use-pytorch-cross-attention` | PyTorch SDPA. **Highest quality, always available, no extra deps.** The safe default and the correct fallback. |
| `--use-split-cross-attention` / `--use-quad-cross-attention` | Memory-optimized math attention for older/low-VRAM cards. |

**Two gotchas worth memorizing:**

1. **Z-Image + Sage = broken.** Z-Image (Turbo/Base) does **not** sample
   correctly under `--use-sage-attention` — you get black or garbled output.
   Launch Z-Image with **`--use-pytorch-cross-attention`** instead. See
   [`z-image-txt2img`](../z-image-txt2img/SKILL.md).
2. **Sage black output on other models.** If a model outputs black *only* with
   Sage, either switch to `--use-pytorch-cross-attention`, or (SwarmUI) set
   Advanced Sampling → Preferred DType = Default (16-bit). Sage-on vs Sage-off
   also produces *slightly different* images — expect non-identical seeds.

> When a graph hard-crashes with `No module named 'sageattention'` /
> `triton: unavailable`, the fix is the sdpa / no-compile fallback in
> [`triton-sageattention`](../triton-sageattention/SKILL.md), not this flag.

---

## Cache mode (mutually exclusive)

| Flag | Effect |
|------|--------|
| *(default `--cache-ram`)* | Cache results under RAM pressure |
| `--cache-classic` | Aggressive result caching |
| `--cache-lru N` | Keep at most N node results (LRU) |
| `--cache-none` | Cache nothing — re-executes every node; **lowest RAM/VRAM**. Essential when switching between dual models or when a giant text encoder (FLUX 2's Mistral) must fully unload. |

---

## Speed / precision

- **`--fast`** — enables experimental, potentially quality-degrading
  optimizations. Accepts specific `PerformanceFeature` values:
  `fp16_accumulation`, `fp8_matrix_mult`, `cublas_ops`, `autotune`. Bare `--fast`
  turns them all on. Test output quality before committing to it.
- **UNet/VAE/text-encoder dtype casts** exist too
  (`--fp8_e4m3fn-unet`, `--fp16-unet`, `--bf16-unet`, `--fp32-unet`, …) for
  forcing a compute precision; usually the model/loader picks the right one, so
  only reach for these to work around a specific dtype error.

---

## Recommended combos (recipes)

```
Long video OOM (LTX 2 / WAN, 24GB):   --novram --cache-none
                                      (add --disable-smart-memory if it stalls)
Windows shared-VRAM creep:            --reserve-vram 3
FLUX 2 / huge text-encoder swaps:     --cache-none
High-VRAM throughput (48GB+):         --gpu-only        (or --highvram)
Fast NVIDIA sampling (most models):   --use-sage-attention
Z-Image (any):                        --use-pytorch-cross-attention
```

Cross-refs: video OOM specifics in
[`ltxv2-video`](../ltxv2-video/SKILL.md) / [`wan-t2v-video`](../wan-t2v-video/SKILL.md);
per-model VRAM math in [`troubleshooting`](../troubleshooting/SKILL.md) and
[`model-compatibility`](../model-compatibility/SKILL.md).

---

## Acceleration stack & GPU coverage (context)

The attention/compile accelerators are **version-locked to your exact
torch + CUDA + Python**. A mismatched wheel doesn't just fail to import — it can
break the torch install. A known-good, mutually-compatible stack for late-2025 /
2026 NVIDIA (including **Blackwell / RTX 5000, `sm_120`**) looks like:

| Component | Role | Notes |
|-----------|------|-------|
| Torch + CUDA | base | e.g. Torch 2.9.x on CUDA 12.8/13; use the wheel index matching your driver |
| Triton | `torch.compile` / inductor | Windows: `triton-windows` (woct0rdho) |
| SageAttention | `--use-sage-attention` | wheel matched to torch/CUDA/python |
| FlashAttention | `--use-flash-attention` | built per torch/CUDA/python |
| xFormers | memory-efficient attention | optional |
| InsightFace | FaceID / IP-Adapter / ReActor | `onnxruntime-gpu` alongside |

Operational facts worth carrying:

- **No system-wide CUDA toolkit is required** to *run* ComfyUI — an up-to-date
  NVIDIA driver + prebuilt wheels are enough. A full CUDA/MSVC/cuDNN toolchain is
  only needed to *compile* kernels yourself.
- **Broad arch coverage** when building wheels:
  `TORCH_CUDA_ARCH_LIST=7.5;8.0;8.6;8.9;9.0;10.0;12.0+PTX` spans RTX 20xx→50xx
  and datacenter (A100/H100/B200). `+PTX` lets newer archs JIT.
- **DeepSpeed has no wheels for Python 3.13**; several accel wheels lag the
  newest Python — 3.10–3.12 is the safe range for the full stack.
- **Clear the Triton cache** (`~/.triton` / `%USERPROFILE%\.triton` and temp)
  when you hit stale-kernel Triton errors after an upgrade.
- Prefer **`uv pip install`** over pip for the venv — dramatically faster
  resolves/downloads. `install_comfyui` already supports this via `preferUv`.
- **A single bad custom node can crash all of ComfyUI at startup.** Install/test
  acceleration and new node packs on a fresh/known-good install, not before a
  deadline. See [`troubleshooting`](../troubleshooting/SKILL.md).

## Quantization quick take

- **FP8-*scaled*** (per-tensor scaled) is markedly higher quality than plain
  base FP8, ~half the size of BF16, and usually faster.
- **Prefer FP8-scaled over GGUF when you have enough system RAM** — ComfyUI's
  block-swap streams from RAM, so BF16/FP8 can run on 24GB GPUs given ample RAM.
  Fall back to GGUF (Q8→Q4) only when RAM is the constraint.
- **NVFP4 / NVFP8** are markedly faster on Blackwell (RTX 5000) at near-BF16
  quality for supported models; LoRA support on NVFP4 is still partial.

---

## Sources

- ComfyUI CLI args (authoritative): <https://github.com/comfyanonymous/ComfyUI/blob/master/comfy/cli_args.py>
- ComfyUI startup flags docs: <https://docs.comfy.org/development/comfyui-server/startup-flags>
- Operational flag/stack guidance distilled from community ComfyUI auto-installer
  changelogs (SECourses) — flags cross-checked against upstream above; no
  third-party scripts, presets, or model files are reproduced here.

---
name: video-upscale
description: Upscale and restore video in ComfyUI — both the quick local path (per-frame ESRGAN like 4x_foolhardy_Remacri via ImageUpscaleWithModel + 4x→2x supersample, with its temporal-flicker tradeoff) and temporal-aware super-resolution (SeedVR2, the newer FlashVSR) with the downscale-first restore pipeline; RIFE/FILM frame interpolation via the BUILT-IN ComfyUI 0.26 FrameInterpolate (rife_v4.26 in models/frame_interpolation/) or the ComfyUI-Frame-Interpolation pack; 2x/4x scaling, VRAM tiers, VHS encode. Captures the classic downscale→SeedVR2→RIFE recipe and the current 2026 recommendation.
globs:
  - "**/*.json"
  - "**/packs/**"
---

# Video Upscaling & Restoration

## Overview

"Upscaling video" in ComfyUI splits into three jobs, and the quality win comes
from doing them in the right order:

1. **Spatial restore + upscale** — a *temporal-aware* model that increases
   resolution **and** cleans compression blocks, blur, and AI-gen mush while
   keeping frames consistent over time. This is the part a plain image upscaler
   (ESRGAN, UltimateSDUpscale per-frame) does badly — per-frame upscalers
   **flicker** because each frame is sharpened independently. Use a video model.
2. **Frame interpolation (VFI)** — synthesize in-between frames to raise fps
   (e.g. 24→48/60) for smooth motion. Do this **after** the spatial pass.
3. **Encode** — mux frames (+ original audio) back to an MP4.

The two leading temporal restorers in 2026 are **SeedVR2** (diffusion-transformer
restorer, the proven workhorse) and **FlashVSR** (newer one-step streaming VSR,
faster). Frame interpolation is **RIFE** (or FILM) via
**ComfyUI-Frame-Interpolation**.

> ⚠️ Verification note: every node/pack/model name below was confirmed against the
> GitHub repos and the ComfyUI registry / Manager as of June 2026. Where a name is
> approximate or version-dependent it is flagged. Do not substitute a node you
> can't confirm is installed — check with `list_installed_nodes` / `get_node_info`.

---

## ⭐ Recommended current pipeline (2026)

**Downscale → SeedVR2 (temporal restore+upscale) → RIFE (interpolate) → VHS encode.**
This modernizes the user's classic recipe (below) with the current SeedVR2 node
pack and is the path to ship by default. FlashVSR is the faster alternative for
the restore stage (see "FlashVSR" section) — swap it in when speed matters more
than absolute fidelity.

### Node-graph sketch

```
LoadVideo  ─► GetVideoComponents ─► (IMAGE frames, audio, fps)
                       │
                       ▼
        ImageScaleBy / ImageScale   ◄── DOWNSCALE first (e.g. 0.5×) — clean,
                       │                  small input for the restorer
                       ▼
        SeedVR2 Video Upscaler  ◄── DiT model + VAE + (block swap) + (tiling)
           ├─ "SeedVR2 (Down)Load DiT Model"
           ├─ "SeedVR2 (Down)Load VAE Model"
           └─ ["SeedVR2 Torch Compile Settings"]  (optional speedup)
                       │  (restored, high-res frames)
                       ▼
        RIFE VFI (4.0 - 4.9)   ◄── multiplier 2 (e.g. 24→48 fps)
                       │
                       ▼
        CreateVideo (fps = source × multiplier) ─► SaveVideo
        — or — VHS_VideoCombine (carries audio passthrough)
```

`LoadVideo` / `GetVideoComponents` / `CreateVideo` / `SaveVideo` are **core
ComfyUI** video nodes (same ones the official comfy.org SeedVR2 template uses).
`VHS_LoadVideo` / `VHS_VideoCombine` come from **ComfyUI-VideoHelperSuite**
(installed) and are preferred for the final encode because they pass the original
**audio** through.

### Why downscale FIRST (the load-bearing trick)

- **The restorer wants a *clean* low-res input, not a big dirty one.** SeedVR2
  (and FlashVSR) regenerate detail. Feeding them a small frame forces the model
  to *synthesize* sharp detail rather than faithfully magnifying existing
  compression artifacts/noise. Downscaling first averages away block noise →
  the restorer hallucinates clean, coherent texture.
- **VRAM + speed headroom.** Cost scales with input pixels × frames. Halving each
  dimension is ~4× fewer pixels per frame, which buys you a larger temporal
  batch (the thing that kills flicker — see below) and a bigger target multiple.
- **It turns "upscale" into "restore-and-upscale."** A 720p source downscaled to
  360p then SeedVR2'd to 1080p+ looks dramatically better than 720p→1080p
  straight, because the model rebuilds rather than stretches.
- Rule of thumb: downscale to **0.5×** (or to a ~360–480p short side) for messy /
  low-bitrate / AI-gen footage; **skip the downscale** for already-clean,
  high-bitrate sources where you just want more pixels.

---

## Quick local path (no downloads) — per-frame ESRGAN + built-in RIFE

When the user just wants a fast result on **what's already installed** (no SeedVR2 /
FlashVSR multi-GB download), use the ESRGAN upscale models most setups already have.
Check first with `list_local_models` (common ones: **`4x_foolhardy_Remacri`** — best
for realistic footage/water/skin — and **`4x-ClearRealityV1`** for clean/sharp).

- **Upscale:** `ImageUpscaleWithModel` with a 4× ESRGAN model, then `ImageScale`
  **back down to a clean 2×** (a 4×→2× **supersample**). That downscale-after step is
  the single biggest quality lever here — it averages out per-frame noise.
- **Interpolate:** the **built-in** `FrameInterpolate` with **RIFE v4.26** (see the
  Frame-interpolation section — no custom node on 0.26+).

> ⚠️ **Tradeoff — flicker.** ESRGAN upscalers are **per-frame** (no temporal
> awareness), so they can **shimmer/flicker** on video — most visible on water and
> fine detail. The 4×→2× supersample mitigates it; if it still shimmers, that's the
> signal to switch the upscale stage to a **temporal** model (**SeedVR2** / **FlashVSR**
> below) — the real fix. So: per-frame ESRGAN = quick & local; SeedVR2 = flicker-free
> & best. **Order is unchanged:** upscale the real frames first, *then* interpolate.

This is the right default for a "do it now, locally" request; reach for the temporal
restorers below when quality (or zero flicker) matters more than turnaround.

---

## SeedVR2 (recommended restore stage)

**Pack:** `ComfyUI-SeedVR2_VideoUpscaler` (author **numz**) — GitHub
`numz/ComfyUI-SeedVR2_VideoUpscaler`, installable via ComfyUI-Manager / registry
by that name. Install with `panel_install_node` or `apply_manifest`.

**Node classes (4):**

| Node | Role |
|---|---|
| **SeedVR2 (Down)Load DiT Model** | loads the diffusion-transformer restorer (auto-downloads on first use) |
| **SeedVR2 (Down)Load VAE Model** | loads `ema_vae_fp16.safetensors` |
| **SeedVR2 Torch Compile Settings** | optional — torch.compile for speed |
| **SeedVR2 Video Upscaler** | the main node: takes frames + DiT + VAE → restored frames |

**Models** (auto-download to `models/SEEDVR2/`; 3B = lighter, 7B = best quality):

| File | Tier |
|---|---|
| `seedvr2_ema_3b_fp16.safetensors` | 3B full precision |
| `seedvr2_ema_3b_fp8_e4m3fn.safetensors` | 3B fp8 (mid VRAM) |
| `seedvr2_ema_3b-Q4_K_M.gguf` / `-Q8_0.gguf` | 3B GGUF (low VRAM) |
| `seedvr2_ema_7b_fp16.safetensors` | 7B full quality |
| `seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors` | 7B fp8 |
| `seedvr2_ema_7b-Q4_K_M.gguf` (+ `_sharp` variants) | 7B GGUF |
| `ema_vae_fp16.safetensors` | shared VAE |

**Key params on "SeedVR2 Video Upscaler":**

| Param | Meaning / recommended |
|---|---|
| **resolution** | **target SHORT edge in pixels** (not a ratio). Default 1080. Set the short side of your output (e.g. 1080 for 1080p-class). |
| **batch_size** | frames processed together. **Must be `4n+1`** (1, 5, 9, 13, 17, 21…). **Higher = less temporal flicker** but more VRAM. 5 is the default; push to 13–45 if VRAM allows for smoother results. |
| **seed** | default 42; fixed for reproducibility |
| **blocks_to_swap** | 0–32 (3B) / 0–36 (7B). >0 offloads transformer blocks to CPU to cut VRAM (slower). Use max (32/36) on 8 GB. |
| **VAE tiling** | enable + set encode/decode tile size to fit the VAE step in low VRAM |

**3B vs 7B:** start with **3B fp8** — it's the speed/quality sweet spot for most
footage. Move to **7B** only when you need maximum reconstruction on faces/text
and have the VRAM (or use the 7B GGUF + block swap).

---

## FlashVSR (newer SOTA — faster restore stage)

**Pack:** `ComfyUI-FlashVSR` (author **1038lab**) — GitHub `1038lab/ComfyUI-FlashVSR`,
built on **FlashVSR V1.1** (one-step diffusion + locality-constrained sparse
attention + tiny conditional decoder). Manager name `ComfyUI-FlashVSR`. Models
auto-download from HF `1038lab/FlashVSR` to `models/FlashVSR/` on first run.

> Note: several community forks exist (`smthemex/ComfyUI_FlashVSR`,
> `lihaoyun6/ComfyUI-FlashVSR_Ultra_Fast`, `naxci1/ComfyUI-FlashVSR_Stable`).
> The `1038lab` pack is the cleanest two-node implementation; pick a fork only if
> you need its specific VRAM tricks.

**Node classes:** **`FlashVSR ⚡`** (preset: Fast / Balanced / High Quality) and
**`FlashVSR Advanced ⚡`** (`model_version` = Tiny / Tiny Long / Full,
`enable_tiling`, `speed_optimization`, `quality_boost`, `sageattention`).
Supports **2x and 4x** (4x recommended). Needs **≥21 input frames**. Variants:
**Full** (best, heavy VRAM), **Tiny** (fast), **Tiny Long** (low VRAM).
SageAttention adds ~20–30% speed.

**When to prefer FlashVSR over SeedVR2:** real-time / long clips / speed-critical
jobs, or when SeedVR2 is too slow on your hardware. **Prefer SeedVR2** when you
want the strongest restoration of badly-degraded footage and can spend the time.

---

## Frame interpolation (VFI)

### Built-in (ComfyUI 0.26+) — PREFER this, no custom node needed

Current ComfyUI ships a **core** frame interpolator — nodes
**`FrameInterpolationModelLoader`** + **`FrameInterpolate`** (RIFE/FILM) — so on
**0.26+ you do NOT install a custom node**. It auto-detects checkpoints dropped in
**`models/frame_interpolation/`** (that folder is **empty by default**, which is why
the model dropdown looks blank). Core-compatible weights live at HF
**`Comfy-Org/frame_interpolation`** (under a `frame_interpolation/` subpath):

| File | ~Size | Use |
|---|---|---|
| **`rife_v4.26.safetensors`** | 22 MB | RIFE, newest/most accurate — default for smooth small-motion fps-doubling |
| **`film_net_fp16.safetensors`** | 66 MB | FILM — large-motion gaps |

Drop a file into `models/frame_interpolation/` and **restart** so the dropdown
populates (ComfyUI caches model lists). `download_model` may not target that folder —
pull it **directly** into `models/frame_interpolation/`. Check what's there with
`list_local_models` / the core node's dropdown before installing anything.

### Custom node (more methods / pre-0.26 ComfyUI)

**Pack:** `ComfyUI-Frame-Interpolation` (author **Fannovel16**) — GitHub
`Fannovel16/ComfyUI-Frame-Interpolation`. Manager-installable by that name. Reach for
it only when you need methods the core node lacks (GMFSS, STMFNet, FLAVR, IFRNet…) or
you're on a ComfyUI older than 0.26.

**Primary node: `RIFE VFI (4.0 - 4.9)`**

| Param | Meaning / recommended |
|---|---|
| **ckpt_name** | RIFE weights `rife40`…`rife49`. **rife47 / rife49 are the recommended ones.** |
| **multiplier** | integer fps multiple. **`multiplier = target_fps / source_fps`** (24→48 = 2; 24→96 = 4). Use **2** for the standard "double the smoothness" pass. |
| **clear_cache_after_n_frames** | lower it (e.g. 10) if you OOM on long clips |
| **fast_mode** | no effect from RIFE 4.5+ (contextnet removed) — leave default |
| **ensemble** | slightly higher quality, slower |

After interpolation, set the encode node's fps to **source_fps × multiplier** so
playback speed is unchanged (only smoother).

**Alternatives in the same pack:** `FILM VFI` (Google FILM — excellent on large
motion, heavier), plus `GMFSS Fortuna VFI`, `STMFNet VFI`/`FLAVR VFI` (these last
two need **≥4 input frames**), `IFRNet`, `M2M`, `AMT`, etc. There is **no
"GIMM-VFI" node in this pack** — if a workflow asks for GIMM-VFI it's a separate
custom node; verify it's installed before citing it. Default to **RIFE**; reach
for **FILM** when RIFE smears fast motion.

### About "RIFE 56"

The user's "RIFE 56" is shorthand, **not** a RIFE model version — RIFE in this
pack tops out at **4.9** (`rife49`). It almost certainly means **RIFE targeting
~56 fps** (i.e. a multiplier chosen so the output lands near 56 fps — e.g.
24 fps × 2 ≈ 48, or a ~2.3× target), or a RIFE-resample node that takes a target
fps directly. Map it to: **`RIFE VFI (4.0 - 4.9)`, ckpt `rife47`/`rife49`,
multiplier = round(56 / source_fps)** (multiplier 2 from 24/25/30 fps). Confirm
the intended output fps with the user rather than chasing a non-existent
"RIFE 56" model.

---

## 2x vs 4x

- **2x** — safest default; pairs with the downscale-first trick (downscale 0.5×,
  then 2x back recovers original size but *restored*). Lower VRAM, fewer artifacts.
- **4x** — for genuinely small sources or when you need a big jump; FlashVSR's
  recommended factor. Costs ~4× the pixels — expect VAE tiling / block swap.
- With SeedVR2 you don't pick a literal "2x/4x"; you set the **target short-edge
  `resolution`** and the effective factor falls out of input vs target size.

---

## VRAM tiers

| VRAM | SeedVR2 | FlashVSR | Interp / encode |
|---|---|---|---|
| **8 GB or less** | 3B **GGUF Q4_K_M** + **blocks_to_swap = max** + VAE tiling; small batch (1–5) | **Tiny Long** + `enable_tiling` | RIFE multiplier 2; low `clear_cache_after_n_frames`; encode in chunks |
| **12–16 GB** | 3B/7B **fp8** + some block swap or VAE tiling; batch 5–13 | **Tiny** or Full + tiling | RIFE 2–4×; ensemble off |
| **24 GB+** | **7B fp16** (or 3B fp16), no offload; batch 13–45 for max temporal stability | **Full** at 4x | RIFE 2–4× + ensemble; FILM if needed |

General: **downscale first** to buy a bigger batch; always `clear_vram` before
switching model families; reduce frame/batch counts first when you OOM.

---

## Gotchas

- **Temporal flicker** → the #1 video-upscale failure. Cause: per-frame
  (non-temporal) upscaling **or** too-small a SeedVR2 `batch_size`. Fix: use a
  temporal model (SeedVR2/FlashVSR), raise `batch_size` (next `4n+1` up), and
  don't downscale so hard the model has nothing to lock onto frame-to-frame.
- **Frame-count constraints**: SeedVR2 `batch_size` must be **`4n+1`**;
  FlashVSR needs **≥21 frames**; STMFNet/FLAVR interp need **≥4 frames**. A clip
  shorter than the batch/min will error or degrade.
- **Color shift / brightness drift** after restore is common with diffusion
  restorers. Mitigate: don't over-downscale; if it persists, do a color-match
  pass against the source (e.g. an essentials/`ImageBlend`-style match) before
  encode, and check pixel format (`yuv420p`) at encode.
- **Audio passthrough**: core `SaveVideo`/`CreateVideo` drop audio. Use
  **`VHS_VideoCombine`** (VideoHelperSuite) and feed it the `audio` from
  `GetVideoComponents` / `VHS_LoadVideo` to keep the original track.
- **fps after interpolation**: set the encoder fps to `source_fps × multiplier`,
  not the source fps, or the video plays in slow motion.
- **ffmpeg** is required for muxing (same as the LTX skill): if `CreateVideo` /
  `SaveVideo` / `VHS_VideoCombine` error with "ffmpeg could not be found", run
  `<comfy-venv>/python -m pip install imageio-ffmpeg` and reboot.
- **Models auto-download on first run** for SeedVR2 and FlashVSR — the first
  generation stalls while it pulls multi-GB weights; that's expected.
- **Order matters**: restore/upscale BEFORE interpolation. Interpolating first
  then upscaling doubles the restorer's workload and can lock in interpolation
  smear.

---

## Classic baseline (the user's proven recipe)

The user's older, battle-tested pipeline — still solid — is:

> **DOWNSCALE the video first → SeedVR2 → RIFE ("RIFE 56").**

That is exactly the structure the **recommended 2026 pipeline above preserves**:
downscale-first to give the restorer clean input + VRAM headroom, SeedVR2 for the
temporal restore/upscale, RIFE for the fps bump. The only modernizations:

- Use the current **`ComfyUI-SeedVR2_VideoUpscaler`** node pack (4-node:
  DiT loader + VAE loader + [torch compile] + upscaler) with the **3B fp8** model
  as the default and `batch_size` raised for temporal stability.
- Read **"RIFE 56"** as *RIFE targeting ~56 fps* (a multiplier, typically **2**
  from 24/25/30 fps), using `rife47`/`rife49` — not a literal model version.
- Consider **FlashVSR** as a faster drop-in for the SeedVR2 stage when speed
  matters more than maximum fidelity.

---

## Packs

No dedicated `video-upscale` installer pack ships yet. To build one
(see the `installer-packs` skill), the manifest's `custom_nodes[]` should pull
`numz/ComfyUI-SeedVR2_VideoUpscaler`, `Fannovel16/ComfyUI-Frame-Interpolation`,
and `Kosinkadink/ComfyUI-VideoHelperSuite` (already installed), optionally
`1038lab/ComfyUI-FlashVSR`. SeedVR2 and FlashVSR weights **auto-download on first
run**, so `models[]` can be left light — note that in `pack.yaml`. Install nodes
ad-hoc with **`panel_install_node`** or apply a manifest with
**`apply_manifest`**. Offer to contribute a finished pack upstream
(`github.com/artokun/comfyui-mcp`).

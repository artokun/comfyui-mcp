---
name: video-extend
description: Extend / continue a video temporally with Pusa 2.2 in ComfyUI — temporal flowmatching (the flowmatch_pusa scheduler + WanVideoAddPusaNoise) on the WanVideoWrapper stack with WAN 2.2 T2V A14B (HIGH/LOW) models and the Pusa V1 LoRAs, conditioning on the loaded clip via WanVideoEncode so the existing motion carries into the continuation. Covers the kijai wanvideo_2_2_14B_Pusa_extension graph, model/LoRA slots + downloads, noise/length/scheduler settings, chaining multiple extensions, VRAM tiers, gotchas, and the extend→upscale handoff.
globs:
  - "**/*.json"
  - "**/packs/**"
---

# Video Extension (Pusa 2.2 — temporal flowmatching)

## Overview

**Pusa extends a video temporally** — it continues / lengthens an existing clip
rather than regenerating it from scratch. It does this on the
**ComfyUI-WanVideoWrapper** stack (kijai) using the **WAN 2.2 T2V A14B** dual
HIGH/LOW models you already have for `wan-t2v-video`, plus the small **Pusa V1
LoRAs** and a Pusa-specific sampling path: the **`flowmatch_pusa`** scheduler and
the **`WanVideoAddPusaNoise`** node. The input clip is encoded with
**`WanVideoEncode`** and injected as the *first latents* of the generation — that
is what carries the existing motion/content into the continuation.

The official reference graph is kijai's
**`wanvideo_2_2_14B_Pusa_extension_example_01.json`** (in
`ComfyUI-WanVideoWrapper/example_workflows/`). This skill is built directly from
that workflow plus the live node schemas.

> Relationship to `wan-t2v-video`: Pusa **rides on the exact same WanVideoWrapper
> stack** — same T2V A14B HIGH/LOW fp8 models, same UMT5 text encoder, same WAN
> VAE, same block-swap/torch-compile machinery. The *only* new downloads are the
> two Pusa V1 LoRAs (~1.9 GB total). Read `wan-t2v-video` first for the base
> stack; this skill is the temporal-extension delta on top of it.

> ⚠️ Verification note: every node, model, LoRA filename and setting below was
> confirmed against the live ComfyUI `/object_info` (WanVideoWrapper installed)
> and against kijai's example workflow JSON + HF repo (June 2026). Where a value
> is a starting recommendation rather than a hard requirement it's flagged. Don't
> substitute a node you can't confirm with `list_installed_nodes` /
> `get_node_info`.

---

## What "temporal flowmatching" means here (why it extends, not regenerates)

WAN is a **flow-matching** video model: sampling integrates a velocity field from
noise to a clean latent, and **every frame normally shares the same denoising
timestep**. Pusa's contribution (Vectorized Timestep Adaptation) is to make the
timestep **per-frame**: the frames you already have can be held at (or near)
*t = 0 (clean)* while the new frames start from *t = 1 (noise)*, and the model
flow-matches the noisy tail **conditioned on the clean head**.

Concretely in the graph:

1. **`WanVideoEncode`** turns the tail of your loaded clip into a clean latent.
2. That latent is placed at the **front** of an otherwise-empty embed
   (`WanVideoEmptyEmbeds` + `WanVideoAddExtraLatent`), so the generation's first
   latents *are* your real footage.
3. **`WanVideoAddPusaNoise`** assigns **small, ramping per-latent noise
   multipliers** to those conditioning latents (so they stay mostly clean) and
   full noise to the new latents — this per-frame noise schedule is the
   "vectorized timestep."
4. **`flowmatch_pusa`** on `WanVideoSampler` integrates that mixed-timestep field.

Because the conditioning latents are real (not just a single start image like
I2V), the continuation **inherits the existing motion, subject, camera and
color**, then keeps going. That's the difference from plain T2V (no memory of any
clip) and from I2V (conditions on one still frame only).

---

## ⭐ Recommended pipeline (the kijai extension graph)

```
VHS_LoadVideo (your clip)
      │ IMAGE (all frames)
      ▼
ImageResizeKJv2  ◄── resize to 832×480 (divisible by 16), get W/H
      │
      ├─► GetImageRangeFromBatch (tail N frames) ─► WanVideoEncode (vae, image)
      │                                                   │ LATENT  = clean
      │                                                   ▼   conditioning latents
      │                                          GetLatentSizeAndCount ─► count
      │                                                   │
WanVideoEmptyEmbeds (W,H, total_frames=81)                ▼
      │ WANVIDIMAGE_EMBEDS                       CreateScheduleFloatList
      └────────► WanVideoAddExtraLatent ◄────────┘ (per-latent noise multipliers,
                       │  (encoded clip latent at front)   ramp e.g. 0→0.2)
                       ▼ WANVIDIMAGE_EMBEDS
              WanVideoAddPusaNoise  ◄── noise_multipliers (list), noisy_steps
                       │
        ┌──────────────┴───────────────┐
        ▼ (pass 1, HIGH)               ▼ (pass 2, LOW)
 WanVideoSampler (HIGH model           WanVideoSampler (LOW model
   + Pusa HIGH LoRA + distill,           + Pusa LOW LoRA + distill,
   flowmatch_pusa, steps 6, cfg 1,       flowmatch_pusa, steps 6, cfg 1,
   shift 5, start 0 / end 3)             shift 5, start 3 / end -1)
        └──────────────┬───────────────┘
                       ▼ LATENT
                 WanVideoDecode (WAN VAE)
                       │ IMAGE
                       ▼
                 VHS_VideoCombine  ─► MP4 (16 fps)
```

- **`VHS_LoadVideo` / `VHS_VideoCombine`** come from **ComfyUI-VideoHelperSuite**
  (installed). `VHS_VideoCombine` is preferred for the encode (audio passthrough).
- Everything `WanVideo*` is **ComfyUI-WanVideoWrapper** (installed).
- `ImageResizeKJv2`, `GetImageRangeFromBatch`, `GetLatentSizeAndCount`,
  `CreateScheduleFloatList` are **ComfyUI-KJNodes** (installed alongside the
  wrapper). They're convenience nodes — see "Minimal wiring" if you want fewer.

### The two load-bearing nodes (confirmed schemas)

**`WanVideoAddPusaNoise`** — *"Adds latent and timestep noise multipliers when
using flowmatch_pusa."*

| Input | Type | Meaning |
|---|---|---|
| `embeds` | `WANVIDIMAGE_EMBEDS` | the embeds carrying your encoded clip latents |
| `noise_multipliers` | `FLOAT` (list) | per-input-latent noise; **0 = keep that latent fully clean**, higher = let the model change it. In the example this is a **ramp** `[0.0, 0.07, 0.13, 0.17, 0.19, 0.2]` fed from `CreateScheduleFloatList` (one value per conditioning latent), so the oldest conditioning frame stays cleanest and the seam frame gets a touch of noise for smooth blending. |
| `noisy_steps` | `INT` (default −1) | how many sampling steps the extra noise is applied for; the example uses **0 on the HIGH pass and 2 on the LOW pass**. −1 = all steps. |

It outputs `WANVIDIMAGE_EMBEDS` straight into `WanVideoSampler`'s `image_embeds`.

**`flowmatch_pusa`** — a value in `WanVideoSampler.scheduler` (confirmed present
in the dropdown: `...flowmatch_distill, flowmatch_pusa, multitalk...`). It **must
be selected** on the sampler(s) for the Pusa noise schedule to be interpreted
correctly. The example also wires explicit `WanVideoScheduler` nodes set to
`flowmatch_pusa`, steps 6, shift 5 (one per pass, split 0–3 / 3–end).

### How the input clip conditions the extension (the key wire)

`WanVideoEncode(vae, image=<tail frames of clip>) → LATENT` →
`WanVideoAddExtraLatent` (or `WanVideoEmptyEmbeds.extra_latents`, tooltip:
**"First latent to use for the Pusa -model"**). This places the **real clip's
latents at the head** of the embed window. The sampler then only has to *generate
the tail*, flow-matched onto that clean head — that is the entire trick. No
`CLIPVision`, no `WanFirstLastFrameToVideo`.

---

## In practice: load → strip → re-point (DON'T hand-build) ⭐ preferred

The kijai `wanvideo_2_2_14B_Pusa_extension_example_01.json` is a **56-node** graph
thick with `GetNode`/`SetNode` buses, `Reroute`s, and an alternate (dead) text
branch. Hand-wiring the Pusa noise / extra-latent / frame-stitch path is slow and
error-prone. The reliable flow is **load the real graph, then adapt ~7 widgets**:

1. **Stage** the example anywhere on disk (e.g. copy into the ComfyUI workflows
   folder).
2. **`panel_load_workflow(path: …)`** — drops it on the canvas server-side (no
   150KB JSON through chat).
3. **`panel_strip_workflow(path: …)`** — returns the **resolved API graph**
   (Get/Set/Reroute/bypass collapsed to real links). This is how you SEE what is
   actually wired — it exposes both the dead text branch and the silently-reset
   dropdowns below. (Raw UI JSON hides them.)

### ⚠️ TRAP 1 — the example's model paths reset to the WRONG file on load

The example references models by **subfolder** (`WanVideo\2_2\…`,
`WanVideo\Lightx2v\…`, `wanvideo\Wan2_1_VAE_bf16…`). On a flat local `models/`
layout those don't resolve, so ComfyUI **silently falls each dropdown back to the
first entry in the list** — e.g. both `WanVideoModelLoader`s land on
`Qwen_Image_Edit-Q8_0.gguf` and the `WanVideoVAELoader` on `LTX23_audio_vae_bf16`.
It *looks* wired but errors (wrong arch) or renders garbage. After loading, set
each explicitly:

| Node | Set to (local) |
|---|---|
| `WanVideoModelLoader` **HIGH** | `Wan2_2-T2V-A14B_HIGH_fp8_e4m3fn_scaled_KJ.safetensors` — note **underscore** before HIGH |
| `WanVideoModelLoader` **LOW** | `Wan2_2-T2V-A14B-LOW_fp8_e4m3fn_scaled_KJ.safetensors` — note **dash** before LOW |
| `WanVideoVAELoader` | `wan_2.1_vae.safetensors` |
| `WanVideoLoraSelectMulti` ×2, slot `lora_0` | Pusa HIGH/LOW — these DO resolve if you downloaded to `loras/WanVideo/Pusa/` |
| `WanVideoLoraSelectMulti` ×2, slot `lora_1` | `lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank128_bf16.safetensors` @ 1.0 |
| `VHS_LoadVideo` | your clip |
| `WanVideoTextEncodeCached` `positive_prompt` | your continuation prompt |

> The official HIGH-**underscore** / LOW-**dash** filename inconsistency is a real
> trap — verify each one rather than copy-pasting.

### ⚠️ TRAP 2 — the distill LoRA silently drops to `none`

The example's lightx2v path is `WanVideo\Lightx2v\…rank64_bf16_.safetensors` (note
the trailing `_`). Locally you usually have **rank128** (`…rank128_bf16`), so the
slot resets to **`none`** on load — which removes the speed LoRA, and 6-step /
cfg-1 sampling then produces mush. Re-add it to `lora_1` (strength 1.0) on **both**
`WanVideoLoraSelectMulti` nodes. Keep `merge_loras=false` on both (fp8 gotcha
above).

### ⚠️ TRAP 3 — the active prompt is on `WanVideoTextEncodeCached`, not CLIPTextEncode

The example also contains a `CLIPLoader → CLIPTextEncode → WanVideoTextEmbedBridge`
branch (the "red panda" prompt). **It is NOT wired to the samplers** — both
`WanVideoSampler.text_embeds` come from `WanVideoTextEncodeCached`
(`umt5-xxl-enc-bf16`). Edit the prompt THERE; the CLIPTextEncode pair is a decoy
that strip_workflow will show dangling.

### ⚠️ TRAP 4 — match the conditioning fps to WAN-native (16)

If your source clip was **frame-interpolated** (e.g. RIFE'd to 32/50 fps), set
**`VHS_LoadVideo.force_rate = 16`** so the conditioning frames carry motion at
WAN's native cadence. Otherwise the encoded "past" runs at 2–3× the model's pace
and you get a **velocity jump at the seam** — the exact artifact Pusa exists to
avoid. **Best practice: extend the pre-interpolation 16fps master**, then
interpolate/upscale the *combined* result afterwards, not before.

### ⚠️ TRAP 5 — the example assumes SageAttention + torch.compile (triton)

`WanVideoModelLoader` in the example sets **`attention_mode: sageattn`** and wires
a **`WanVideoTorchCompileSettings`** (inductor) into `compile_args`. Both are
optional accelerators with extra deps that a stock Windows ComfyUI usually lacks:

- `sageattn` → needs the **`sageattention`** package. Missing → the model loader
  hard-fails with `ValueError: Can't import SageAttention: No module named
  'sageattention'` **before any sampling**. Fix: set `attention_mode` → **`sdpa`**
  on **both** `WanVideoModelLoader`s (always available; a bit slower).
- inductor `torch.compile` → needs **triton** (no official Windows build).
  Missing → compile errors later. Fix: **disconnect `WanVideoTorchCompileSettings`
  from each model loader's `compile_args`** (or don't load it). Only re-enable
  these two if you've actually installed sageattention / triton-windows.

Check first with the ComfyUI startup log (it prints `Could not load
sageattention…` and `triton: unavailable`) or `list_installed_nodes`.

### Preferred end-to-end order

**generate (or Krea2→WAN/LTX i2v) → Pusa-extend at 832×480/16fps → THEN
upscale+interpolate** (hand the extended clip to the `video-upscale` block / a
saved `Upscale4x-RIFE-1080p` subgraph). Upscaling/interpolating *before* extending
wastes the work and feeds Pusa an off-cadence, harder-to-match conditioning clip.

---

## Models, LoRAs & where to get them

### UNET — WAN 2.2 T2V A14B (already installed for `wan-t2v-video`)

| Model | Loader | Notes |
|---|---|---|
| `Wan2_2-T2V-A14B-HIGH_fp8_e4m3fn_scaled_KJ.safetensors` | `WanVideoModelLoader` | HighNoise expert, fp8. Quantization `fp8_e4m3fn_scaled`. |
| `Wan2_2-T2V-A14B-LOW_fp8_e4m3fn_scaled_KJ.safetensors` | `WanVideoModelLoader` | LowNoise expert, fp8. |

Text encoder + VAE: same as `wan-t2v-video` — UMT5
(`umt5_xxl_fp8_e4m3fn_scaled` / `umt5_xxl_fp16`) via the wrapper's text-embed
path, and the WAN VAE (`wan_2.1_vae`) via `WanVideoVAELoader`. The example uses
`WanVideoTinyVAELoader` + `taew2_1.safetensors` for **fast preview decode**; use
the full WAN VAE for final-quality decode.

### Pusa V1 LoRAs — the ONLY new download (~1.9 GB)

From **kijai's HF repo `Kijai/WanVideo_comfy`, folder `Pusa/`** → place in
`models/loras/` (the example expects them under `loras/WanVideo/Pusa/`):

| LoRA file | ~Size | Applies to | Strength (example) |
|---|---|---|---|
| `Wan22_PusaV1_lora_HIGH_resized_dynamic_avg_rank_98_bf16.safetensors` | ~956 MB | **HIGH** T2V model | **1.5** |
| `Wan22_PusaV1_lora_LOW_resized_dynamic_avg_rank_98_bf16.safetensors` | ~968 MB | **LOW** T2V model | **1.4** |

> There is also a single-file `Wan21_PusaV1_LoRA_14B_rank512_bf16.safetensors`
> (~4.9 GB) in the same folder — that's the **Wan 2.1** single-model Pusa LoRA.
> For the **2.2 dual HIGH/LOW** extension graph, use the two `Wan22_...rank_98`
> files above, matched to the correct expert. Upstream weights / paper:
> `RaphaelLiu/PusaV1` on HF.

### Speed LoRA (paired with Pusa in the example)

The example also stacks the **lightx2v T2V distill** LoRA on each model via
`WanVideoLoraSelectMulti`, so 6-step low-CFG sampling works:

| LoRA | Strength | From |
|---|---|---|
| `lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16_.safetensors` | 1.0 | `Kijai/WanVideo_comfy/Lightx2v/` |

LoRAs are selected with **`WanVideoLoraSelectMulti`** (multi-slot) and fed into
each `WanVideoModelLoader`'s `lora` input — one select feeds HIGH (Pusa HIGH +
distill), one feeds LOW (Pusa LOW + distill).

### ⚠️ CRITICAL — `merge_loras=false` on fp8 models (same gotcha as `wan-t2v-video`)

Pusa loads LoRAs **onto the fp8-quantized** T2V A14B models
(`quantization=fp8_e4m3fn_scaled`). As documented in `wan-t2v-video`: when a LoRA
is applied to an fp8 model via the wrapper's LoRA select, **set `merge_loras` to
`false`**. The default `merge_loras=true` tries to bake the LoRA into the
already-quantized fp8 weights and **hard-crashes ComfyUI during LoRA loading with
no Python traceback** (looks like an unexplained restart/OOM). `false` applies
the LoRA as a runtime patch, which is fp8-safe. This applies to **both** the Pusa
LoRAs and the lightx2v distill LoRA. Use `merge_loras=true` only on
non-quantized bf16/fp16 models.

---

## Settings

### Sampler (from the example — distilled 6-step, two-pass HIGH→LOW)

| Param | HIGH pass | LOW pass | Notes |
|---|---|---|---|
| model | HIGH + Pusa HIGH (1.5) + distill (1.0) | LOW + Pusa LOW (1.4) + distill (1.0) | |
| scheduler | `flowmatch_pusa` | `flowmatch_pusa` | **required** for Pusa |
| steps | 6 | 6 | distilled; raise to ~20–30 for the non-distill path |
| cfg | 1.0 | 1.0 | distilled low-CFG; ~5–6 without distill |
| shift | 5.0 | 5.0 | flow-matching shift |
| start_step / end_step | 0 / 3 | 3 / −1 | HIGH does early steps, LOW finishes |
| `noisy_steps` (on AddPusaNoise) | 0 | 2 | extra-noise duration per pass |

If you drop the distill LoRA: use `steps` ~20–30, `cfg` ~5–6, keep
`flowmatch_pusa` and `shift` 5, single-pass `unipc`-style splitting still works
HIGH→LOW.

### Pusa noise (`WanVideoAddPusaNoise.noise_multipliers`)

This is the dial that controls **how strictly the continuation honors the input
clip vs. how free it is to diverge**:

- **Lower multipliers (→ 0)** = conditioning latents stay clean = the
  continuation **clings tightly** to the source frames (less drift, but can look
  "stuck"/repeat).
- **Higher multipliers** = more noise on the conditioning latents = the model is
  freer to **evolve** the scene (more new motion, more drift risk).
- The example **ramps** them `[0.0 … 0.2]` across the conditioning latents (one
  per encoded latent, via `CreateScheduleFloatList` driven by
  `GetLatentSizeAndCount`) so the oldest frame is locked and the **seam frame**
  gets a little noise for a smooth blend. Start there; nudge the top of the ramp
  up (~0.3) if continuations feel frozen, down if they drift.

### Seam color/saturation drift → ColorMatch the generated frames ⭐

The most common quality complaint with a Pusa extension: **the moment you cross
the seam, the color saturates / shifts.** The conditioning frames are your real
footage (near-clean latents), but the *generated* tail comes purely from the
model's prior — which biases toward higher contrast/saturation (worse with the
distill LoRA and `fp16_fast`). Motion carries fine; the **palette pops**.

Two fixes, best applied together:

1. **`base_precision: bf16`** on both `WanVideoModelLoader`s instead of
   **`fp16_fast`**. fp16_fast's reduced precision drifts over the generated tail
   and compounds the saturation; bf16 is more color-stable (small speed cost).
2. **Re-grade the generated frames to the source palette** with a **`ColorMatchV2`**
   (KJNodes) between `WanVideoDecode` and the final stitch/save:
   - `image_target` ← `WanVideoDecode` (the generated window)
   - `image_ref` ← the **resized original clip** (`ImageResizeKJv2` output — your
     real footage)
   - `method`: **`hm-mkl-hm`** (histogram→MKL→histogram; strongest at removing a
     palette jump while keeping per-frame variation), `strength` 1.0.
   - Re-route the downstream consumers (`ImageBatchMulti` / `ImageConcatMulti`'s
     `image_1`) to take the ColorMatch output instead of the raw decode.

   Tune: if under-corrected, raise `strength`; if washed/over-corrected, drop to
   ~0.6; for an even tighter temporal lock use a **single clean reference frame**
   (the last conditioning frame) instead of the whole clip. Use `ColorMatchV2`
   (not the deprecated `ColorMatch`).

This also matters for **chaining** — color-match every new segment to the
*previous* one before concat or the drift compounds hop-to-hop.

### Length, frame counts & fps

- `WanVideoEmptyEmbeds.num_frames` is the **total** window (conditioning frames +
  new frames). The example uses **81** total (the WAN-native `4n+1` length, ~5 s
  @16 fps).
- The **number of new frames added = total − conditioning frames.** With ~13
  tail frames conditioned and 81 total, you add ~68 new frames (~4 s) per pass.
- `num_frames` step is **4** in the node; keep total on the WAN `4n+1` grid
  (49 / 81 / 121 …). `frame_rate` for output is **16 fps** (WAN 2.2 native).
- Resolution: **832×480** default (divisible by 16). `ImageResizeKJv2` with
  `crop`/`center` and divisor 16 keeps the loaded clip on-grid.

---

## Chaining multiple extensions (making a long video)

Pusa adds a bounded window (~4 s) per run. To go longer, **feed the output back
in**:

0. **Stage the output clip as the next run's input** with
   **`stage_output_as_input`** (pass the rendered clip's
   `{ filename, subfolder?, type? }`); use the returned input filename in
   `VHS_LoadVideo`. **NEVER copy the output .mp4 into, or guess, a filesystem
   `input/` path** — ComfyUI's input/output dirs may be CUSTOM
   (`--input-directory` / `--output-directory`), so a guessed path makes
   `VHS_LoadVideo` fail to find/decode the file and wastes the run. The tool
   routes through the server API (`/view` → `/upload/image`), which resolves the
   real dirs correctly. (For a clip already on local disk, `upload_video`.)
1. Run the extension → decode → save (or keep the frames in-graph).
2. Take the **tail of the *new* output** (the last ~13 frames) as the next
   `WanVideoEncode` input.
3. Re-run with the same graph; the fresh tail becomes the new conditioning head.
4. Repeat. `ImageConcatMulti` / `ImageBatchMulti` (KJNodes, used in the example's
   preview) stitch the segments into one continuous clip.

Practical chaining tips:

- **Always condition on the newest frames**, not the original clip, or you'll
  "rewind."
- **Drift compounds** across hops (color/identity slowly wander). Keep
  `noise_multipliers` modest and re-state the subject in the prompt each hop.
- **Overlap a few frames** between segments and drop duplicates at concat to hide
  the seam.
- Keep the **same seed discipline** (fixed or deliberately varied) so motion
  cadence stays consistent.
- Each hop is an independent generation — `clear_vram` is not needed between
  hops, but **decode/cache** long chains to disk so you don't hold every segment
  in VRAM.

---

## VRAM tiers

Same envelope as `wan-t2v-video` (dual A14B fp8 + UMT5) — Pusa adds only ~1.9 GB
of LoRA. Use the wrapper's offload tooling.

| VRAM | Setup |
|---|---|
| **24 GB+** | Dual fp8 A14B + Pusa LoRAs + distill. `WanVideoBlockSwap` (offload some blocks) for headroom; `WanVideoTorchCompileSettings` (inductor) for speed; `sageattn`. 81 frames @832×480 fits. |
| **12–16 GB** | More aggressive `WanVideoBlockSwap`; enable **VAE tiling** on `WanVideoEncode` (`enable_vae_tiling=true`, 272/144 tiles) and on `WanVideoDecode`; drop total frames to 49; consider single-pass. |
| **8 GB** | Tight — heavy block swap + tiled VAE + 49 frames + tiny VAE preview decode. Expect slow. |

- `WanVideoModelLoader` quant `fp8_e4m3fn_scaled`, base precision `fp16_fast`,
  `offload_device`, `sageattn` (the example's settings).
- **Always `clear_vram`** before switching to this from another model family.
- Encoder VAE tiling (`WanVideoEncode`) matters here because you're VAE-encoding
  real footage in addition to decoding output.

---

## Gotchas

- **Loading the example silently resets model/VAE/distill-LoRA dropdowns** to the
  wrong first entry (subfolder paths don't resolve on a flat layout) — the #1
  cause of a Pusa run that errors or generates wrong content. See "In practice:
  load → strip → re-point" and re-point ALL of them. Use `strip_workflow` to spot
  it.
- **The prompt lives on `WanVideoTextEncodeCached`**, not the CLIPTextEncode
  "decoy" branch (which isn't wired to the samplers).
- **Interpolated source → seam speed jump** — set `VHS_LoadVideo.force_rate = 16`,
  or condition on the pre-interpolation 16 fps master.
- **`sageattn` / torch.compile errors** — the example assumes SageAttention +
  triton. On a box without them, set `attention_mode=sdpa` and disconnect
  `WanVideoTorchCompileSettings` from both model loaders (TRAP 5).
- **Saturation/color pop after the seam** — re-grade the generated frames with a
  `ColorMatchV2` (`hm-mkl-hm`) referencing the source clip, and use `bf16` not
  `fp16_fast` (see "Seam color/saturation drift").
- **Scheduler must be `flowmatch_pusa`.** Leaving it on `unipc`/`euler` ignores
  the Pusa per-latent noise schedule → the conditioning latents don't behave as
  clean anchors and you get a hard cut / regeneration instead of a smooth
  continuation.
- **`merge_loras=false` on fp8** (see CRITICAL above) — applies to the Pusa
  *and* distill LoRAs; default `true` silently kills the process.
- **Match Pusa LoRA to expert**: `...HIGH...` → HIGH model, `...LOW...` → LOW
  model. Crossing them degrades quality. Don't substitute the Wan 2.1
  single-file `rank512` LoRA into the 2.2 dual graph.
- **Frame-count grid**: keep `num_frames` on **`4n+1`** (49/81/121). Off-grid
  totals can error or pad oddly. `num_frames` UI step is 4.
- **Motion drift / "frozen" continuation**: tune `noise_multipliers`. Too low =
  stuck/looping; too high = subject/scene wanders. The `0→0.2` ramp is the safe
  middle.
- **Color/exposure drift** across chained hops is the most common long-video
  artifact. Mitigate: modest noise, restate the prompt, and optionally
  color-match each new segment to the previous before concat.
- **Audio**: WAN/Pusa generate **silent** video. The original clip's audio is
  *not* extended. Re-attach/curate audio at the end with `VHS_VideoCombine`
  (pass the source `audio` through) or in an editor — and note the new section
  has no native sound.
- **ffmpeg required** for the final mux (same as the other video skills): if
  `VHS_VideoCombine` errors `ffmpeg ... could not be found`, run
  `<comfy-venv>/python -m pip install imageio-ffmpeg` and reboot.
- **Preview vs final VAE**: `taew2_1` (TinyVAE) is for fast preview decode; decode
  the **final** with the full WAN VAE for quality.

---

## Minimal wiring (if you want fewer KJNodes)

The KJNodes (`GetImageRangeFromBatch`, `GetLatentSizeAndCount`,
`CreateScheduleFloatList`, `ImageResizeKJv2`) are conveniences. The irreducible
chain is:

```
load clip → (resize to 16-grid) → WanVideoEncode(vae, tail frames) → LATENT
WanVideoEmptyEmbeds(W,H,total) [extra_latents = that LATENT]  → embeds
embeds → WanVideoAddPusaNoise(noise_multipliers, noisy_steps) → embeds
WanVideoSampler(model+Pusa LoRA, embeds, scheduler=flowmatch_pusa, shift 5) → LATENT
WanVideoDecode(WAN VAE) → VHS_VideoCombine
```

You can hand a constant list to `noise_multipliers` instead of building a ramp;
the ramp just smooths the seam. Two-pass HIGH→LOW is recommended (matches WAN
2.2's MoE) but a single LOW-model pass works for quick tests.

---

## See also

- **`wan-t2v-video`** — the base WAN 2.2 T2V stack this builds on (model/encoder/
  VAE loading, the `merge_loras=false` fp8 gotcha in full, block-swap/VRAM).
  Read it first.
- **`video-upscale`** — the natural next step: **extend, then upscale**. Generate
  / extend at 832×480, then run the result through the
  *downscale → SeedVR2 (temporal restore+upscale) → RIFE → VHS encode* pipeline
  for a clean, higher-res, higher-fps final. Do the **extension first**, upscale
  last (upscaling then extending wastes the restorer's work and risks re-drift).
- **`ltxv2-video`** — an alternative video family with its own extender variant;
  Pusa/WAN is the path when you want to continue an existing WAN-style clip.

## Packs

No dedicated `video-extend` installer pack ships yet. Since Pusa reuses the
installed WanVideoWrapper + KJNodes + VideoHelperSuite stack, a pack only needs to
ensure those `custom_nodes[]` (kijai/ComfyUI-WanVideoWrapper,
Kijai/ComfyUI-KJNodes, Kosinkadink/ComfyUI-VideoHelperSuite) plus the two Pusa V1
LoRAs in `models[]` (from `Kijai/WanVideo_comfy/Pusa/`). The big T2V A14B models
are shared with `wan-t2v-video` — don't re-download. Install nodes ad-hoc with
`panel_install_node` or apply a manifest with `apply_manifest`. Contribute a
finished pack upstream (`github.com/artokun/comfyui-mcp`).

---
name: wan-scail-replacement
description: SCAIL-2 in-video character replacement on WAN 2.1 — WanSCAILToVideo + SCAIL2ColoredMask + SAM3, the reference-image framing→scale rule, and the tuning/compositing pitfalls
globs:
  - "**/*.json"
---

# SCAIL-2 In-Video Character Replacement (WAN 2.1)

SCAIL-2 (zai-org, on WAN 2.1 14B) replaces the person in a driving video with a
character you supply as a reference image — end-to-end, with no pose maps, and
with multi-character support. It is the successor to WAN Animate / motion
transfer for the "swap the subject, keep the motion" job. The official ComfyUI
template is **`video_wan21_scail2_character_replacement_int8`**, built around
`WanSCAILToVideo` (+ `SCAIL2ColoredMask`) with a SAM3 mask driving *where* the
character goes.

This skill documents the non-obvious behaviours that cost a full multi-minute
render to discover. It is not a from-scratch graph — start from the official
template and apply the guidance below.

## The one rule that costs a re-render: reference framing controls SCALE

**In `replacement_mode: true`, the reference image's FRAMING controls the output
character's SIZE — not just its appearance.** The SAM3 mask controls *where* the
character is placed; the reference image controls *how large*.

Measured on a 720x1280 driving clip where the subject occupied ~30% of frame
height (subject bbox 363 px):

| Reference framing | Person bbox in output | vs driving subject |
|---|---|---|
| Full-bleed portrait (person ~93% of frame) | 621 px | **1.71x oversized** |
| Reframed (person ~34% of frame) | 364 px | **1.003x — correct** |

After reframing, top/bottom registration matched the driving subject within 1 px
(the character stands on the same ground plane at the same height). Pose transfer
was correct in *both* cases — only the scale was wrong, which makes it easy to
misread as "the model works" until you A/B against the source.

**Guidance — pad/reframe the reference before you render:**

> Pad/reframe the reference image onto a canvas at the working resolution so the
> person occupies roughly the same fraction of frame height as the subject in the
> driving video. A full-bleed portrait reference against a wide-shot driving clip
> renders the character oversized in proportion to the framing mismatch.

Why it's a trap: this isn't stated in the template's on-canvas notes, and it does
not surface in the popular Civitai motion-transfer workflows — those run
*animation* mode, where the reference legitimately fills the frame.

## Tuning trade-off: distill LoRA strength / shift leaks driving-subject detail

Running the `lightx2v` distill LoRA at `0.8` with `ModelSamplingSD3 shift 5` (the
settings the popular Civitai workflow uses) improves colour and detail versus
`1.0` / `shift 8` — but it also increases adherence to the driving video enough
that **original-subject details bleed onto the replacement character.** In one
run the original golfer's neon-yellow shoe appeared on a replacement character
who wears white shoes in the reference (same seed, same reference, only those two
params changed). If you see source details you didn't ask for, raise the LoRA
strength / shift back toward `1.0` / `shift 8`.

## Don't "fix" colour with post-hoc compositing — it's a regression

The raw SCAIL-2 output shows a measurable colour error (background ~-5 per channel
from the VAE round-trip; the character loses red ~2.4x faster than green, which
reads as a slight green cast). It is tempting to composite the generated character
back over the original plate through the SAM3 mask to "correct" it. **Don't** —
it measures better but looks worse:

- The mask boundary produces an obvious halo.
- Layering the original plate's props (e.g. a golf club) over generated hands
  severs the grip relationship the model had solved coherently.

SCAIL-2 resolves colour, edges, grip and occlusion *jointly*; correcting any one
of them in isolation breaks the others. Leave the raw output alone.

## Models (reference set)

The template's int8 build was exercised with:

- `wan2.1_14B_SCAIL_2_int8_convrot` — SCAIL-2 model
- `wan2.1_SCAIL_2_DPO_lora_bf16` — DPO LoRA
- `lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16` — distill LoRA (see tuning note)
- `Wan2_1_VAE_bf16`
- `umt5_xxl_fp8_e4m3fn_scaled` — text encoder
- `clip_vision_h`
- `sam3.1_multiplex_fp16` — SAM3 mask model

VRAM: ~22.2 GB peak at 576x1024 / 81-frame chunks on a 24 GB card.

## See also

- `wan-t2v-video`, `wan-flf-video` — other WAN 2.x video pipelines
- `director` — multi-shot scene direction for video pipelines

## Sources

- **Official:** none found.
- **Empirical:** sampler values, wiring, and prompt notes from working graphs in `packs/` and observed renders; not a vendor prompting guide.

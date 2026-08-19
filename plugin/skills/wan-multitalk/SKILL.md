---
name: wan-multitalk
description: Build WAN MultiTalk audio-driven talking-avatar / lip-sync video workflows — MeiGen-AI MultiTalk on WAN 2.1 14B I2V via kijai WanVideoWrapper (portrait + audio → lip-synced video)
globs:
  - "**/*.json"
---

# WAN MultiTalk — Audio-Driven Talking Avatar

## Overview

MultiTalk (MeiGen-AI) drives a **still portrait's lip-sync and head motion from an
audio track**. It runs on WAN 2.1 14B Image-to-Video via kijai's
**ComfyUI-WanVideoWrapper**: Wav2Vec speech embeddings condition the WAN sampler so
the mouth/expression follow the speech, while the lightx2v step-distill LoRA keeps
it to a few sampling steps.

Use it for talking heads, dubbing, and single-speaker avatar clips (~10s at 480p).
It is **distinct from `wan-animate`** (pose/motion-driven character animation) — this
is *audio → lip-sync*, not reference-video motion transfer.

Pack: `wan-multitalk` (480p, ~10s). Higher-res/longer variants exist in the source
bundle (720p, long-context) as VRAM/duration knobs on the same graph.

## Pipeline (node graph)

```
LoadImage (portrait) ─┐
LoadAudio ─ AudioSeparation ─ AudioCrop ─ DownloadAndLoadWav2VecModel ─ MultiTalkWav2VecEmbeds ─┐
                                                                                                 ▼
WanVideoModelLoader (WAN 2.1 14B I2V GGUF) ─ MultiTalkModelLoader ─ WanVideoLoraSelect (lightx2v)
   + LoadWanVideoT5TextEncoder (umt5) + WanVideoTextEncode + WanVideoClipVisionEncode (clip_vision_h)
   + WanVideoVAELoader ──────────────────────────────────────────────────────────────────────────┘
                                                     ▼
                       WanVideoImageToVideoMultiTalk ─ WanVideoSampler ─ WanVideoDecode ─ VHS_VideoCombine
```

Key nodes (all kijai WanVideoWrapper unless noted):
- **DownloadAndLoadWav2VecModel** — auto-downloads the Wav2Vec speech model on first
  run (no manifest entry needed).
- **MultiTalkWav2VecEmbeds** — turns the (separated, cropped) speech into the
  embeddings that steer the mouth/expression.
- **MultiTalkModelLoader** + **WanVideoImageToVideoMultiTalk** — the MultiTalk head
  on top of the WAN I2V model.
- **AudioSeparation** — isolate the voice from music/noise before embedding (cleaner
  lip-sync). **AudioCrop** — trim to the segment you want to animate.
- **ImageResizeKJv2** (KJNodes), **VHS_VideoCombine** (VideoHelperSuite) — resize +
  mux to mp4.

## Models

| File | Loader | Folder |
|------|--------|--------|
| `Wan2.1_14b_Image_to_Video_480p_GGUF_Q8.gguf` | WanVideoModelLoader | `diffusion_models/` |
| `WanVideo_2_1_Multitalk_14B_fp32.safetensors` | MultiTalkModelLoader | `diffusion_models/` |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | LoadWanVideoT5TextEncoder | `text_encoders/` |
| `Wan2_1_VAE_bf16.safetensors` | WanVideoVAELoader | `vae/` |
| `clip_vision_h.safetensors` | CLIPVisionLoader | `clip_vision/` |
| `Wan21_I2V_14B_lightx2v_cfg_step_distill_lora_rank64_fixed.safetensors` | WanVideoLoraSelect | `loras/` |

Sources: kijai `Kijai/WanVideo_comfy`, MeiGen-AI `MeiGen-AI/MeiGen-MultiTalk`, GGUF
`city96/Wan2.1-I2V-14B-480P-gguf`. See `packs/wan-multitalk/manifest.yaml` (some URLs
are best-effort — verify per mirror). Wav2Vec auto-downloads.

## Inputs & key parameters

- **Portrait** (LoadImage): front-facing, clear face, neutral-ish expression works
  best. Resized by ImageResizeKJv2 to the target (480p).
- **Audio** (LoadAudio): the speech track. AudioSeparation isolates the voice;
  AudioCrop selects the segment (drives clip length).
- **Steps**: low (the lightx2v distill LoRA is why — typically ~4–8). Raising steps
  rarely helps and costs time.
- **BlockSwap** (WanVideoBlockSwap): trade VRAM for speed — increase blocks swapped
  to CPU on lower-VRAM cards.

## VRAM tiers (from the source bundle's variants)

| Target | Approx VRAM | Lever |
|--------|-------------|-------|
| 480p 10s | ~8–12 GB | base |
| 480p low-VRAM | ~6–8.4 GB | more BlockSwap, GGUF quant, lower quality |
| 720p 10s | ~11–16 GB | higher res |

Pair with the VRAM launch-flags guidance (see `troubleshooting`): `--use-sage-attention`
+ appropriate `--*vram` mode; MultiTalk benefits from `--reserve-vram` headroom for
the Wav2Vec + VAE round-trips.

## Gotchas

- **Audio must be voice-isolated** for good lip-sync — skipping AudioSeparation on a
  music-heavy track makes the mouth chase the wrong signal.
- **One speaker.** This graph is single-speaker; multi-speaker MultiTalk needs the
  multi-embed variant (not in this pack).
- **Wav2Vec first run** downloads a model — the first render is slower.
- If lips look under-driven, check the MultiTalk embeds are actually wired into
  `WanVideoImageToVideoMultiTalk` (not bypassed), and that the audio isn't silent
  after AudioCrop.

## Sources

- **Official:** none found.
- **Empirical:** sampler values, wiring, and prompt notes from working graphs in `packs/` and observed renders; not a vendor prompting guide.

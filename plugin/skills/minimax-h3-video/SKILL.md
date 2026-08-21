---
name: minimax-h3-video
description: Build MiniMax H3 (Hailuo) local video workflows with native T2V/I2V/R2V nodes, Comfy-Org INT8 weights, turbo LoRAs for 8GB VRAM, 15-second stereo-audio clips, and the official MiniMax prompting guides (cite by link, do not copy).
globs:
  - "**/*.json"
---

# MiniMax H3 (Hailuo) — local video

This skill teaches the **local-weights** MiniMax H3 path in ComfyUI. It is the
pilot for `#1155` (Official vs Empirical sources) because MiniMax publishes a
real prompting guide. **Cite that guide by URL. Do not copy it into this repo.**

## Two products, two cost models — pick one

They share a brand and **must not be mixed**.

| Path | Nodes | Cost | VRAM | When |
|---|---|---|---|---|
| **Local weights** (this skill) | `MiniMaxH3ImageToVideo`, `MiniMaxH3ReferenceToVideo`, `EmptyMiniMaxH3LatentAV`, `MiniMaxH3SigmaShift`, `MiniMaxH3MemoryEfficientSageAttentionPatch` | Free after download | Yes — INT8 + turbo LoRA is the 8 GB story | User wants 4–15 s stereo clips on their GPU |
| **Partner API** | `MinimaxHailuo03TextToVideoNode`, `MinimaxHailuo03FirstLastFrameNode`, `MinimaxHailuo03ReferenceNode`, `MinimaxTextToVideoNode`, `MinimaxImageToVideoNode`, `MinimaxHailuoVideoNode` | Paid per generation | None | User has a MiniMax / Hailuo API key and does not want local weights |

API nodes do not take `MiniMaxH3SigmaShift` or Sage-attention patches. Local
nodes do not spend API credits. If the user asked for Hailuo *cloud*, stop and
use the API nodes + their key; do not download 40 GB of weights.

`MiniMaxH3Director` is a **third-party** pack (`muse-collective-26/MiniMaxH3-Director`),
not core. Do not require it for T2V / I2V / R2V.

## License — cite, do not copy

Local weights and MiniMax's own documentation sit under the
[MiniMax H3 Community License](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE).
`Materials` includes the Documentation. The agreement's Applicable Territory
**excludes the United States, the EU, the UK, and South Korea**. This skill
does **not** reproduce MiniMax's `skills/h3-prompt-writing/` SKILL.md or the
prompting-guide prose. Linking to a public URL is the `#1155` requirement.

This is not legal advice. Tell a US/EU/UK/KR user that the *local* path is
territory-restricted and that the **paid API** is a separate product under
MiniMax platform terms.

## Prefer the Comfy-Org template over hand-wiring

ComfyUI ≥ **0.30.0** (templates in the 0.33 line). These are **core**
`comfyui-workflow-templates` graphs in the frontend **Template Library →
Video**, not installer packs and not custom-node `example_workflows`:

| Mode | Template Library card | File | Diffusion file |
|---|---|---|---|
| T2V / I2V / FL2VA | MiniMax H3: Text to Video / Image to Video | `video_minimax_h3_t2v.json` / `video_minimax_h3_i2v.json` | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` |
| R2V (omni-reference) | MiniMax H3: Reference to Video | `video_minimax_h3_r2v.json` | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` |

`list_packs action:"list_templates"` will **not** list them.
`enqueue_workflow action:"run_template"` will **not** resolve
`video_minimax_h3_t2v` / `_i2v` / `_r2v`. That action only loads bundled
installer packs, and there is no `packs/minimax-h3-*` yet. Do not call it
until a pack exists. `panel_load_workflow` needs `pack:`, a disk `path:`, or
an inline UI `graph`. A Template Library basename is none of those.

**Load path that works:**

1. **Preferred.** Ask the user to open **Template Library → Video → MiniMax H3:
   Text to Video** (or Image to Video / Reference to Video). Pick the local
   `video_minimax_h3_*` cards, **not** the `api_minimax_h3_*` paid partner
   templates.
2. **Agent, no UI click.** Fetch the UI JSON from
   https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_t2v.json
   (or `_i2v` / `_r2v`; raw.githubusercontent.com is the same files), save it
   with `save_workflow action:"save"` `filename:"video_minimax_h3_t2v.json"`,
   then `panel_load_workflow path:"video_minimax_h3_t2v.json"`. Same pattern as
   `video-extend` (stage on disk, then `path:`). Do not pass the GitHub URL as
   `path:` or `pack:`.

After it lands, retarget the **subgraph's exposed widgets** (prompt, duration,
`turbo_mode`, megapixels). Official T2V/I2V graphs wrap
`MiniMaxH3ImageToVideo` inside a subgraph (`type` is a UUID). Do not flatten
that interior unless you are hand-building.

Hand-building the subgraph is slower and easy to get wrong.

Comfy tutorial (wiring, not MiniMax's prompt formula):
https://docs.comfy.org/tutorials/video/minimax/minimax-h3

## Models (Comfy-Org INT8 pack)

All from `huggingface.co/Comfy-Org/MiniMax-H3`. Download with
`download_model` `action:"download"`.

| File | Folder | Role |
|---|---|---|
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `diffusion_models/` | T2V / I2V / first-last-frame |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | `diffusion_models/` | R2V only — **different UNet** |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `text_encoders/` | Qwen3-VL-32B encoder, `CLIPLoader` **type=`minimax`** |
| `minimax_h3_video_vae_fp16.safetensors` | `vae/` | Visual VAE |
| `minimax_h3_audio_vae_fp32.safetensors` | `vae/` | Stereo audio VAE (32 kHz) |

### Turbo LoRAs (4–8 steps instead of ~20)

The Comfy-Org T2V template already switches these on with `turbo_mode`:

| Steps | File | Source |
|---|---|---|
| 8 | `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` | `lightx2v/Minimax-h3-Turbo` |
| 4 | `minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors` | `Comfy-Org/MiniMax-H3` `loras/` |

Kijai conversions live at `Kijai/MiniMax-H3_comfy` (`loras/`) and experimental
W4A8 at `Kijai/MiniMax-H3-experimental`. Same job (low-step / low-VRAM). Prefer
the Comfy-Org / lightx2v filenames the template already names; only switch to a
Kijai file if that is what is on disk.

4-step is faster and softer; **6 to 8 steps** is the usual sharpness compromise.

## Output spec

| Knob | Value |
|---|---|
| Duration | 4–15 seconds |
| Frame rate | **24 fps** (`CreateVideo.fps`) |
| Audio | Native stereo, decoded by the audio VAE, muxed in `CreateVideo` |
| Short edge | 768 px native; cap **768×1344**, multiple of **32** |
| Preview size | `ResolutionSelector` megapixels **0.4** → 864×480 at 16:9 |
| Full 768p | megapixels **~0.98** → **1344×768** at 16:9 |

Duration → frame `length` (Comfy-Org template math, 17-frame blocks):

```
max(5, round(seconds * 24)) + (5 - (max(5, round(seconds * 24)) % 17)) % 17
```

That is the `17k+5` grid. Do not invent a WAN-style `4n+1` length.

## Node graph (local T2V / I2V)

From the Comfy-Org T2V subgraph (core nodes, not the Markdown notes):

```
ResolutionSelector (aspect, megapixels, multiple=32) → width, height

UNETLoader (fl2va int8)
  ├─ LoraLoaderModelOnly (turbo LoRA) ─┐
  └────────────────────────────────────┤ ComfySwitchNode (turbo_mode)
                                       ▼
                         BasicGuider + BasicScheduler + KSamplerSelect(res_multistep)
                                       ▼
CLIPLoader (type=minimax, qwen3vl 32b) → MiniMaxH3ImageToVideo
VAELoader (video vae) ─────────────────→   prompt, width, height, length
optional first_frame / last_frame ─────→   → CONDITIONING + LATENT
                                       ▼
                         SamplerCustomAdvanced → LATENT
                                       ├─ VAEDecode (video vae) → IMAGE
                                       └─ VAEDecodeAudio (audio vae) → AUDIO
                                       ▼
                         CreateVideo (fps=24) → SaveVideo
```

`MiniMaxH3ImageToVideo` **is** T2V when both image sockets are empty, I2V with
`first_frame`, FL2VA with both frames. Do not add a second T2V-only node.

R2V replaces the UNet with **ref2va** and the conditioner with
`MiniMaxH3ReferenceToVideo`. Do not load fl2va into an R2V graph.

### Local-only helpers

| Node | Role |
|---|---|
| `EmptyMiniMaxH3LatentAV` | Empty audio-video latent when you are not using `MiniMaxH3ImageToVideo`'s built-in latent |
| `MiniMaxH3SigmaShift` | Flow-matching shift on the local UNet |
| `MiniMaxH3MemoryEfficientSageAttentionPatch` | Core Sage patch; or KJNodes `Patch Sage Attention KJ` (`sage_attention=auto`) between `UNETLoader` and `BasicGuider` |

Sage roughly doubles speed. H3 has mixed dtypes, so console lines about falling
back to pytorch attention on some layers are expected.

## Sampler defaults (Comfy-Org template)

| Mode | Sampler | Scheduler | Steps |
|---|---|---|---|
| Base (no turbo) | `res_multistep` | `simple` | **20** |
| Turbo on | `res_multistep` | `simple` | **4–8** (template default turbo steps widget) |

Guider is `BasicGuider` (CFG-distilled checkpoint, so do not crank CFG). Seed via
`RandomNoise`.

## Prompting — read the vendor guide, do not paste it here

Write the prompt **in the MiniMax H3 node**, not a generic `CLIPTextEncode`.

**Official MiniMax guides** (read these; do not copy them into graphs as a
system prompt dump):

- T2VA / I2VA / FL2VA / L2VA:
  https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md
- Full-reference / R2V:
  https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md
- Vendor skill (install separately if the user wants it; we do not bundle it):
  https://github.com/MiniMax-AI/MiniMax-H3 (`npx skills add … --skill h3-prompt-writing`)

H3-Context-IR (the hosted prompt rewriter) is **not** in the open weights.
Local ComfyUI has no IR node. Either write the structured prompt yourself from
the guide, or call MiniMax's Context-IR API and paste `content.prompt` into the
local node.

Comfy-Org's own template notes (safe to follow, not MiniMax docs):

1. One block covering **look, scene, timed shots, camera, and audio** (dialogue,
   SFX, score).
2. Time shots (`[0s-1.5s] Shot 1: …`).
3. R2V: name each input in connection order (`<Picture 1>`, `<Video 1>`,
   `<Audio 1>`) and say what job each one does (identity, motion, voice).
4. R2V caps (vendor model card, not a guess): ≤9 images, ≤3 videos, ≤3 audio
   clips, ≤12 files mixed; each AV clip 2 to 15 s.

## 15-second clips and chaining

One H3 shot is **at most ~15 s**. Longer pieces are concatenated clips, not a
bigger `length`.

1. Generate clip N (up to 15 s).
2. Confirm the file with `get_image` `action:"list_outputs"` (`kind:"video"`).
   Video nodes often skip `/history`.
3. Stage the last frame (or the whole clip) with `upload_image` `action:"stage"`.
4. Clip N+1: `MiniMaxH3ImageToVideo.first_frame` = last frame of N, **or** R2V
   with `<Video 1>` as a continuation reference.
5. Concat with ffmpeg (`director` skill) or an editor.

This is **not** WAN Pusa (`video-extend`). Pusa LoRAs and `flowmatch_pusa` do
not apply to H3.

## VRAM

| Card | Practical setup |
|---|---|
| **24 GB+** | INT8 fl2va + Qwen3-VL + both VAEs; 1344×768; 10–15 s; Sage optional |
| **12–16 GB** | Same INT8 pack; drop megapixels toward 0.4–0.6; turbo LoRA on; Sage |
| **8 GB** | INT8 + turbo LoRA + Sage + short preview (0.2–0.4 MP, 4–6 s). Minutes per clip. Kijai W4A8 if INT8 still OOMs. |

Always `clear_vram` before switching to H3 from WAN / LTX / a checkpoint.

## Gotchas

- **`CLIPLoader` type must be `minimax`.** `qwen_image` / `flux` will load the
  wrong encoder layout.
- **fl2va vs ref2va.** T2V/I2V templates on ref2va (or R2V on fl2va) are garbage
  or a load error.
- **Turbo off, 4 steps.** The switch defaults off and base steps are 20. Four
  steps without the LoRA is mush.
- **API node in a local graph.** Costs money and ignores the UNet you downloaded.
- **WAN frame math.** H3 is 24 fps and `17k+5`, not 16 fps `4n+1`.
- **Verify video on disk**, then stage. Never guess `input/` paths.
- **ffmpeg** is required for `CreateVideo` / `SaveVideo` / `VHS_VideoCombine`.
- Desktop/Cloud ComfyUI lags nightly. Missing `MiniMaxH3*` nodes → update to
  ≥0.30.0 (0.33 templates) before hunting custom packs.

## See also

- `video-extend`: WAN Pusa temporal continuation (different family)
- `director`: multi-clip concat after you have 15 s H3 shots
- `prompt-engineering`: generic CLIP syntax; **H3 does not use it**
- `triton-sageattention`: installing Sage on Windows

There is no bundled `packs/minimax-h3-*` installer yet, which is why
`enqueue_workflow action:"run_template"` cannot load these graphs. Use the
Template Library (or the GitHub fetch → `save_workflow` →
`panel_load_workflow path:` path above) + `download_model` against
`Comfy-Org/MiniMax-H3`.

## Sources

- **Official:** MiniMax prompting guides https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md (T2VA/I2VA/FL2VA/L2VA) and https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md (full-reference / R2V); vendor repo https://github.com/MiniMax-AI/MiniMax-H3; ComfyUI tutorial + templates https://docs.comfy.org/tutorials/video/minimax/minimax-h3 (wiring, duration grid, INT8 filenames). MiniMax's own `skills/h3-prompt-writing` is linked, not copied, because the Community License includes Documentation.
- **Empirical:** local vs partner-API node split and 8 GB turbo-LoRA note from issue #1167 / the reporter's rig; Sage mixed-dtype fallback from the Comfy tutorial; chaining last-frame→next-clip from observed ComfyUI I/O (stage + list_outputs), not a vendor extender.

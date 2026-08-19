---
name: ernie-image
description: Build Baidu ERNIE-Image / ERNIE-Image-Turbo workflows — primarily TEXT-TO-IMAGE. Pick ERNIE when you need precise multilingual text rendering, posters/signage, manga/anime multi-panel layouts, or strong instruction following for complex multi-object scenes. Also supports denoise-based image-to-image refine (NOT instruction-grounded editing — use Qwen-Image-Edit or Flux Kontext for "change X in this photo" edits).
globs:
  - "**/*.json"
---

# ERNIE-Image / ERNIE-Image-Turbo Workflows

## What this is (read first)

**ERNIE-Image is Baidu's open-weight TEXT-TO-IMAGE model** — an ~8B single-stream Diffusion Transformer (DiT), Apache-2.0, released April 2026, repackaged for ComfyUI by Comfy-Org. It is **not** an instruction-based image editor.

- **ERNIE-Image** (base): ~50 steps for peak quality.
- **ERNIE-Image-Turbo**: distilled (Distribution Matching Distillation + RL), high-fidelity in **~8 steps, cfg 1**. The downloaded pack uses **Turbo** (`ernie-image-turbo-*.gguf`).

**Pick ERNIE when** the job is: precise text/typography rendering (multilingual, including Chinese), posters/signage/UI mockups, manga/anime storyboards and multi-panel layouts, or structured multi-object scenes from a complex prompt.
**Do NOT pick ERNIE for** "edit this photo / change the shirt / swap the background" — that is instruction-grounded editing, which ERNIE does **not** do. Use `qwen-image-edit` or Flux Kontext for those. ERNIE's "image-to-image" here is plain denoise-based refinement (style pass / detail pass), not reference-grounded editing.

> Niche vs siblings: ERNIE = best open-weight **text rendering + layout** T2I. Qwen-Image-Edit = instruction editing. Flux Kontext = reference editing. Z-Image Turbo = fast general T2I (and this same pack pairs the two — see Combo pipelines).

## Separated packs (render-verified)

The original `ernie` monolith was a single toggle-template graph (every pipeline shipped bypassed; you activated one via the rgthree group toggles). It's now split into standalone, single-purpose packs — each a clean activated graph that renders headlessly with no group-toggling:

| Pack | Use | Models | VRAM |
|------|-----|--------|------|
| `ernie-txt2img` | text-to-image (flagship) | ERNIE only (4) | <8GB |
| `ernie-img2img` | denoise refine of a source image | ERNIE only (4) | <8GB |
| `ernie-combo` | ERNIE × Z-Image-Turbo combo pipelines | ERNIE + Z-Image (7, ~32GB) | 12GB+ |

Working details verified live: the **prompt-enhancer LLM is OFF by default** (the `ENHANCE PROMPT` boolean is false; leave it off unless you want the 3B enhancer to rewrite the prompt). The grain/sharpen post-proc (`FastFilmGrain`/`FastLaplacianSharpen`, comfyui-vrgamedevgirl) needs **librosa** installed. In `ernie-combo` the Z-Image half's VAE is saved as **`z-image-ae.safetensors`** (its weights differ from Flux/ERNIE's `ae.safetensors` despite the same size — avoids a filename clash).

## Source of truth & a provenance warning

This skill is derived from the actual pack files in `C:\Users\Artokun\Downloads\`:
- `ERNIE-IMAGE-ULTRA-WORKFLOW.json` (authoritative — the ComfyUI graph)
- `ERNIE-IMAGE_ULTRA-MODELS-NODES_INSTALL.bat`, `...-COMFYUI-MANAGER_AUTO_INSTALL.bat`, `...-AUTO_INSTALL-RUNPOD.sh`

> **Installer warning (verified):** the three install scripts are copy-pasted from a **Z-Image** pack. Their headers literally say "Z-IMAGE-BASE"/"Z-IMAGE Base", and they download **both** ERNIE *and* Z-Image files. The model URLs/folders below are taken from those scripts but mirror this confusion — they pull `z_image_turbo-*.gguf`, `Qwen3-4B-*.gguf`, and `ae.safetensors` which belong to the **Z-Image** half of the combo, not ERNIE. The ERNIE-only files are flagged below. All weights come from a third-party mirror `huggingface.co/Aitrepreneur/FLX`, **not** the official `huggingface.co/Comfy-Org/ERNIE-Image` (which hosts the same filenames — see Official sources).

## Models

### ERNIE-Image (the files ERNIE actually uses)

Confirmed from the workflow's virtual wires (`Set_*`/`GetNode`): the nodes tagged **"ERNIE"** resolve to these exact files.

| Component | Node (type) | File (in workflow) | Folder | Notes |
|-----------|-------------|--------------------|--------|-------|
| **UNet (GGUF)** | `UnetLoaderGGUF` | `ernie-image-turbo-Q8_0.gguf` | `models/unet/` | Turbo DiT. Q5_K_S / Q6_K / Q8_0 quants offered by installer |
| **Text encoder** | `CLIPLoader` (type=`flux2`) | `ministral-3-3b.safetensors` | `models/text_encoders/` | **Ministral-3-3B** is ERNIE's text encoder. Loaded with CLIP type `flux2` |
| **VAE** | `VAELoader` | `flux2-vae.safetensors` | `models/vae/` | ERNIE reuses the **Flux 2 VAE** |
| **Prompt enhancer** | `CLIPLoader` (type=`flux2`) → `TextGenerate` | `ernie-image-prompt-enhancer.safetensors` | `models/text_encoders/` | 3B LLM that auto-expands a short prompt into a rich description (see Prompt enhancer). Optional, toggled per-pipeline |

> Quant guidance from the installer: **Q5_K_S** GPUs <8 GB · **Q6_K** 8–12 GB · **Q8_0** 12–16 GB+.

### Z-Image Turbo (bundled in the same pack — the "ZIT" half)

The workflow also wires a parallel Z-Image Turbo pipeline for ERNIE→ZIT / ZIT→ERNIE combos. These files are **Z-Image's, not ERNIE's** — do not confuse them:

| Component | Node | File | Folder |
|-----------|------|------|--------|
| UNet (GGUF) | `UnetLoaderGGUF` | `z_image_turbo-Q8_0.gguf` | `models/unet/` |
| Text encoder | `CLIPLoaderGGUF` (type=`lumina2`) | `Qwen3-4B-UD-Q6_K_XL.gguf` | `models/text_encoders/` |
| VAE | `VAELoader` | `ae.safetensors` | `models/vae/` |

### LoRAs (referenced in the Power Lora Loader, off by default)

`hirohiko-araki-style-ERNIE_000001250.safetensors`, `ernie-anime-v1.safetensors` — community ERNIE style LoRAs, loaded via `Power Lora Loader (rgthree)` (both toggled **off** in the shipped graph). Not in the installer; user-supplied.

### Upscalers / post (shared)

`4x-ClearRealityV1.pth`, `RealESRGAN_x4plus_anime_6B.pth` → `models/upscale_models/`.

## Installation

### Custom nodes (git clone into `ComfyUI/custom_nodes/`)

All three installers clone the same set:

| Node pack | Repo | Why it's needed |
|-----------|------|-----------------|
| ComfyUI-Manager | `https://github.com/ltdrdata/ComfyUI-Manager.git` | management |
| **ComfyUI-GGUF** | `https://github.com/city96/ComfyUI-GGUF` | `UnetLoaderGGUF`, `CLIPLoaderGGUF` |
| **rgthree-comfy** | `https://github.com/rgthree/rgthree-comfy` | `Power Lora Loader`, `Label`, `Fast Groups Bypasser`, `Image Comparer` |
| **ComfyUI-Easy-Use** | `https://github.com/yolain/ComfyUI-Easy-Use` | `easy cleanGpuUsed`, `easy clearCacheAll` |
| **ComfyUI-KJNodes** | `https://github.com/kijai/ComfyUI-KJNodes` | utility nodes |
| **ComfyUI_essentials** | `https://github.com/cubiq/ComfyUI_essentials` | `ImageResize+` |
| wlsh_nodes | `https://github.com/wallish77/wlsh_nodes` | `Upscale by Factor with Model (WLSH)` |
| comfyui-vrgamedevgirl | `https://github.com/vrgamegirl19/comfyui-vrgamedevgirl` | `FastFilmGrain`, `FastLaplacianSharpen` |
| RES4LYF | `https://github.com/ClownsharkBatwing/RES4LYF` | advanced samplers |

The graph also uses `TextGenerate`, `TextBox1`, `StringReplace`, `ComfySwitchNode`, `PreviewAny`, `SetNode`/`GetNode`, `PrimitiveBoolean`, `ModelSamplingAuraFlow`, `ConditioningZeroOut`, `EmptySD3LatentImage`, `EmptyFlux2LatentImage` — most are builtin or come from the packs above. `SetNode`/`GetNode` are from KJNodes. `TextGenerate` (runs the prompt-enhancer LLM) — verify which pack provides it via ComfyUI-Manager if it shows as missing (**unverified pack origin**).

### Model downloads (exact URLs from the installer)

Base URL `HF = https://huggingface.co/Aitrepreneur/FLX/resolve/main` (third-party mirror). `!MODEL_VERSION!` ∈ `{Q5_K_S, Q6_K, Q8_0}`.

```
# ERNIE (the files ERNIE actually uses)
unet/ernie-image-turbo-<Q>.gguf                <HF>/ernie-image-turbo-<Q>.gguf?download=true
text_encoders/ministral-3-3b.safetensors       <HF>/ministral-3-3b.safetensors?download=true
text_encoders/ernie-image-prompt-enhancer.safetensors  <HF>/ernie-image-prompt-enhancer.safetensors?download=true
vae/flux2-vae.safetensors                       <HF>/flux2-vae.safetensors?download=true

# Z-Image half (bundled; only needed for the ZIT combo pipelines)
unet/z_image_turbo-<Q>.gguf                      <HF>/z_image_turbo-<Q>.gguf?download=true
text_encoders/Qwen3-4B-UD-Q6_K_XL.gguf          <HF>/Qwen3-4B-UD-Q6_K_XL.gguf?download=true
vae/ae.safetensors                               <HF>/ae.safetensors?download=true

# Upscalers
upscale_models/4x-ClearRealityV1.pth            <HF>/4x-ClearRealityV1.pth?download=true
upscale_models/RealESRGAN_x4plus_anime_6B.pth   <HF>/RealESRGAN_x4plus_anime_6B.pth?download=true
```

### Official sources (prefer these over the mirror)

The same filenames are hosted officially at **`huggingface.co/Comfy-Org/ERNIE-Image`** (`unet|diffusion_models/`, `text_encoders/`, `vae/`). Apache-2.0. Original model: `github.com/baidu/ERNIE-Image`. Comfy day-0 docs: `docs.comfy.org/tutorials/image/ernie-image/ernie-image`. The official repo also ships non-GGUF `ernie-image.safetensors` / `ernie-image-turbo.safetensors` (load with `UNETLoader` instead of `UnetLoaderGGUF`).

## How the pipeline works (at a glance)

The big graph is a menu of group-boxed pipelines built from the same blocks. Core ERNIE-Image text-to-image flow:

```
UnetLoaderGGUF (ernie-image-turbo) ──► Power Lora Loader (rgthree) ──► ModelSamplingAuraFlow (shift=3.1) ──► MODEL
CLIPLoader (ministral-3-3b, type=flux2) ──► CLIP ──► CLIPTextEncode (positive)
                                              └──► ConditioningZeroOut  ──► negative   (cfg=1, so negative ≈ unused)
VAELoader (flux2-vae) ──► VAE
EmptySD3LatentImage (1920×1088) ──► LATENT
        │
KSampler (steps≈8–9, cfg=1, euler, simple, denoise=1) ──► VAEDecode ──► SaveImage / post
```

**Prompt enhancer path (optional):** the short user prompt + `{width}`/`{height}` are templated into a Chinese system prompt, fed to `TextGenerate` (which runs `ernie-image-prompt-enhancer`), and a `ComfySwitchNode` chooses raw prompt (switch=false) vs. enhanced prompt (switch=true) before `CLIPTextEncode`.

**Image-to-image (refine) path — NOT editing:** the graph's "ERNIE IMAGE TO IMAGE" groups take a `LoadImage → ImageResize+ (1024, keep proportion, lanczos)` and `VAEEncode` it, then run KSampler at **low denoise (0.35–0.4)** to refine/restyle. This is a denoise pass over a single source image; it does not follow edit instructions.

**About the ~5 LoadImage + ~5 VAEEncode nodes:** they are **not** multi-reference compositing. Each LoadImage feeds a *separate* pipeline variant (single-image img2img, or the combo refine stages). One source image per pipeline. The extra VAEEncodes are the encode steps for those independent img2img / two-pass refine chains.

**Combo pipelines (ERNIE↔ZIT):** group titles `ERNIE ---> ZIT COMBO`, `ZIT ---> ERNIE COMBO`, `TWO TIMES COMBO ...` chain ERNIE and Z-Image Turbo as a two-pass generate→refine, with optional film-grain (`FastFilmGrain`) or sharpening (`FastLaplacianSharpen`) finishing and `SIMPLE UPSCALE`.

## Settings (extracted from the shipped KSamplers)

| Pipeline | Steps | CFG | Sampler | Scheduler | Denoise | Shift |
|----------|-------|-----|---------|-----------|---------|-------|
| ERNIE text-to-image (Turbo) | 8–9 | 1 | euler | simple | 1.0 | 3.1 |
| ERNIE image-to-image refine | 8 | 1 | euler | simple | **0.4** | 3.1 |
| Combo refine pass (2nd stage) | 9 | 1 | euler | simple | **0.25–0.35** | 3.1 |

- **`ModelSamplingAuraFlow` shift = 3.1** is applied to the ERNIE model before sampling (flow-matching shift). Keep it.
- **CFG = 1** for Turbo → negative conditioning is effectively inert; the graph still wires a `ConditioningZeroOut` as the negative.
- **Resolution:** shipped latent is **1920×1088** (`EmptySD3LatentImage`). ERNIE is a high-res-capable DiT; 1024–2048 on the long edge is reasonable. Use `EmptySD3LatentImage` for ERNIE latents.
- Base (non-Turbo) `ernie-image`: bump steps to ~50 and raise cfg (e.g. 3.5–5) since it is not distilled.

## Prompt / instruction style

ERNIE rewards **descriptive, structured natural-language prompts**, and is unusually strong at **literal text rendering**. Write the exact text you want to appear in quotes.

```
A vintage travel poster of Kyoto in autumn, bold title text reading "KYOTO" at the top,
maple leaves, Mount fuji silhouette, clean vector layout, muted warm palette
```
```
A 3-panel manga page: panel 1 a samurai drawing his sword, panel 2 close-up of his eyes,
panel 3 a wide shot of cherry blossoms falling, black-and-white ink, speech bubble "参る"
```

- For **typography/signage**: state the literal string ("a neon sign that says 'OPEN'"), placement, and font feel.
- For **layout**: name the panel/grid structure and what goes in each region.
- Multilingual prompts (incl. Chinese) work — the built-in enhancer's system prompt is Chinese.
- This is **txt2img phrasing**, not edit phrasing. Do not write "change the…/remove the…" expecting grounded edits.

## Complete API-format workflow (ERNIE-Image-Turbo text-to-image)

Derived from the source graph, flattened to API format (no subgraphs/virtual wires). Enhancer omitted for clarity — `CLIPTextEncode` takes the prompt directly.

```json
{
  "1": { "class_type": "UnetLoaderGGUF", "inputs": { "unet_name": "ernie-image-turbo-Q8_0.gguf" } },
  "2": { "class_type": "CLIPLoader", "inputs": { "clip_name": "ministral-3-3b.safetensors", "type": "flux2", "device": "default" } },
  "3": { "class_type": "VAELoader", "inputs": { "vae_name": "flux2-vae.safetensors" } },
  "4": { "class_type": "ModelSamplingAuraFlow", "inputs": { "model": ["1", 0], "shift": 3.1 } },
  "5": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["2", 0], "text": "A vintage travel poster of Kyoto in autumn, bold title text reading \"KYOTO\" at the top, maple leaves, clean vector layout, muted warm palette" } },
  "6": { "class_type": "ConditioningZeroOut", "inputs": { "conditioning": ["5", 0] } },
  "7": { "class_type": "EmptySD3LatentImage", "inputs": { "width": 1920, "height": 1088, "batch_size": 1 } },
  "8": { "class_type": "KSampler", "inputs": {
    "model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["7", 0],
    "seed": 997032332094579, "steps": 9, "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 1
  } },
  "9": { "class_type": "VAEDecode", "inputs": { "samples": ["8", 0], "vae": ["3", 0] } },
  "10": { "class_type": "SaveImage", "inputs": { "images": ["9", 0], "filename_prefix": "ernie_image" } }
}
```

### Image-to-image (refine) variant

Replace the empty latent with an encoded source image and lower denoise. **This restyles/refines a single image; it is not instruction editing.**

```json
{
  "11": { "class_type": "LoadImage", "inputs": { "image": "source.png" } },
  "12": { "class_type": "ImageResize+", "inputs": { "image": ["11", 0], "width": 1024, "height": 1024, "interpolation": "lanczos", "method": "keep proportion", "condition": "always", "multiple_of": 0 } },
  "13": { "class_type": "VAEEncode", "inputs": { "pixels": ["12", 0], "vae": ["3", 0] } }
}
```
Then in the KSampler set `"latent_image": ["13", 0]` and `"denoise": 0.4`.

### Adding LoRAs

Insert a `Power Lora Loader (rgthree)` between the UNet loader and `ModelSamplingAuraFlow` (`model: ["1",0]` → loader → `["4"].model`). In API format you can substitute `LoraLoaderModelOnly` with `lora_name: "ernie-anime-v1.safetensors", strength_model: 0.5`.

## VRAM

- ERNIE-Image-Turbo GGUF: **Q5_K_S** <8 GB · **Q6_K** 8–12 GB · **Q8_0** 12–16 GB+ (installer's own guidance).
- Ministral-3-3B encoder + Flux2 VAE add a few GB. The graph includes `easy cleanGpuUsed` / `easy clearCacheAll` nodes between stages — keep them for the combo/two-pass pipelines so VRAM is freed before swapping models.
- Running the ERNIE↔ZIT combos loads **two** UNets; budget for both or run the single-model ERNIE group only.

## Troubleshooting

- **`UnetLoaderGGUF` / `CLIPLoaderGGUF` missing** → install **ComfyUI-GGUF** (city96).
- **`Power Lora Loader` / `Image Comparer` / `Label` missing** → install **rgthree-comfy**.
- **`ImageResize+` missing** → install **ComfyUI_essentials**.
- **`TextGenerate` missing** (prompt enhancer) → install via ComfyUI-Manager search; pack origin unverified. If unavailable, just set the `ComfySwitchNode` to use the raw prompt (switch=false) and skip enhancement.
- **CLIP type error on ministral** → ensure `CLIPLoader` `type` is **`flux2`** (not `qwen_image`/`lumina2`). The `lumina2` type belongs to the Z-Image (Qwen3) encoder, not ERNIE.
- **Wrong VAE artifacts** → ERNIE must use **`flux2-vae.safetensors`**; `ae.safetensors` is the Z-Image VAE.
- **Blurry / undercooked output** → confirm `ModelSamplingAuraFlow shift=3.1` is wired and steps ≥8 for Turbo; for base `ernie-image` use ~50 steps + higher cfg.
- **You wanted to EDIT a photo and it ignored the instruction** → expected. ERNIE is txt2img; use the `qwen-image-edit` skill or Flux Kontext for grounded edits.
- **Installer pulled Z-Image files too** → expected (the scripts are Z-Image-derived). Harmless; those files only feed the combo pipelines.

## Tips

1. Lead with the **literal text** you want rendered, in quotes — that's ERNIE's headline strength.
2. Use the **prompt enhancer** for short/lazy prompts; turn it off (`ComfySwitchNode` false) when you've written a detailed prompt yourself.
3. Use **`get_workflow (action:"analyze")`** before executing the shipped graph — it has dozens of group-boxed variants gated by `Fast Groups Bypasser (rgthree)`; the analyzer summary is far easier than reading raw JSON.
4. Most groups are **bypassed (mode 4)** by default in the source file — enable only the pipeline you want via the group bypasser, or build the clean API workflow above.
5. To choose a model: **ERNIE = text/layout T2I**, **Z-Image Turbo = fast general T2I**, **Qwen-Image-Edit / Flux Kontext = actual editing**.
```

## Sources

- **Official:** https://github.com/baidu/ERNIE-Image and https://docs.comfy.org/tutorials/image/ernie-image/ernie-image
- **Empirical:** sampler values and combo wiring from the pack graphs (see Source of truth above); installer scripts are Z-Image-derived.

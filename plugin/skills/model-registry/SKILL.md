---
name: model-registry
description: Curated download URLs and target directories for every model the comfyui-mcp skills reference — checkpoints, VAEs, text encoders, LoRAs — organized by family (Flux, WAN, LTX, Qwen, Z-Image, SD15/SDXL). Use when downloading models with download_model (action:"download" / action:"download_civitai"), when a workflow fails with a missing-model error, or when setting up a new machine.
---

# Model Registry

One table per family: filename → source URL → target subdir under
`<COMFYUI>/models/`. Use with `download_model({ action: "download", url, target_subfolder, filename })`.
This registry grows with every release — if a model you need is missing, use
`action:"search"` (HuggingFace) or `action:"download_civitai"` and consider
contributing the row.

**Conventions**
- HF "resolve" URLs download directly: `https://huggingface.co/<repo>/resolve/main/<path>`
- 🔒 = gated repo — needs `HUGGINGFACE_TOKEN` (accept the license on the HF page first)
- CivitAI model-page URLs need `download_model` `action:"download_civitai"` (resolves version → file); raw `civitai.com/api/download/...` URLs work with `action:"download"` + `CIVITAI_API_TOKEN`
- Always verify the exact filename a workflow's loader expects — `model-compatibility` skill covers which VAE/CLIP pairs with which architecture

## Shared VAEs & text encoders (download these once)

| File | Source | Target |
|---|---|---|
| `ae.safetensors` (Flux/Z-Image VAE) | `huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/ae.safetensors` (Apache, not gated) | `vae/` |
| `vae-ft-mse-840000-ema-pruned.safetensors` (SD1.5 VAE) | `huggingface.co/stabilityai/sd-vae-ft-mse-original/resolve/main/vae-ft-mse-840000-ema-pruned.safetensors` | `vae/` |
| `clip_l.safetensors` | `huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors` | `text_encoders/` |
| `t5xxl_fp8_e4m3fn.safetensors` | `huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors` | `text_encoders/` |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` (WAN) | `huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `text_encoders/` |

## Flux (see `flux-txt2img` skill for workflows)

| File | Source | Target |
|---|---|---|
| `flux1-dev.safetensors` 🔒 | `huggingface.co/black-forest-labs/FLUX.1-dev` | `diffusion_models/` |
| `flux1-schnell.safetensors` | `huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/flux1-schnell.safetensors` | `diffusion_models/` |
| `flux2-vae.safetensors` (Flux 2 Klein) | `huggingface.co/Comfy-Org/flux2-klein` — check repo for current path | `vae/` |

## WAN 2.x video (see `wan-t2v-video` / `wan-flf-video` skills)

Comfy-Org repackages everything: `huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged` under `split_files/`.

| File | Path in repo | Target |
|---|---|---|
| `wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` | `split_files/diffusion_models/` | `diffusion_models/` |
| `wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` | `split_files/diffusion_models/` | `diffusion_models/` |
| `wan_2.1_vae.safetensors` | `split_files/vae/` | `vae/` |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors` | `split_files/loras/` | `loras/` |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors` | `split_files/loras/` | `loras/` |
| Magical-morph I2V LoRAs (high/low) | `huggingface.co/NikolaSigmoid/wan2.2-i2v-loras-magical-morph` | `loras/` |
| SkinMorph Redmond I2V 14B | `civitai.com/models/2210162` (use `action:"download_civitai"`) | `loras/` |

## LTX-2 19B video (see `ltxv2-video` skill)

| File | Source | Target |
|---|---|---|
| `ltx-2-19b-distilled.safetensors` | `huggingface.co/Lightricks/LTX-2` — check repo for the bf16 distilled path | `checkpoints/` |
| `gemma_3_12B_it_fp4_mixed.safetensors` | `huggingface.co/Comfy-Org` LTX repackage | `text_encoders/` |
| `ltx-2-spatial-upscaler-x2-1.0.safetensors` | `huggingface.co/Lightricks/LTX-2` | `upscale_models/` |
| Camera-control LoRAs (`dolly-left`, distilled-384) | `huggingface.co/Lightricks/LTX-2` LoRA dir | `loras/` |

## Qwen-Image (see `qwen-txt2img` / `qwen-image-edit` skills)

| File | Source | Target |
|---|---|---|
| `qwen_image_fp8_e4m3fn.safetensors` | `huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_fp8_e4m3fn.safetensors` | `diffusion_models/` |
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` | same repo, `split_files/text_encoders/` | `text_encoders/` |
| `qwen_image_vae.safetensors` | same repo, `split_files/vae/` | `vae/` |
| `qwen_image_edit_2511_bf16.safetensors` | `huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI` — check repo | `diffusion_models/` |
| Qwen-Image 2512 Lightning LoRA | `huggingface.co/lightx2v/Qwen-Image-2512-Lightning` | `loras/` |
| Qwen-Image-Edit 2511 Lightning LoRA | `huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning` | `loras/` |
| Qwen-Image 2512 Turbo LoRA | `huggingface.co/Wuli-art/Qwen-Image-2512-Turbo-LoRA` | `loras/` |

## Z-Image (see `z-image-txt2img` skill)

| File | Source | Target |
|---|---|---|
| `z_image_turbo_bf16.safetensors` | `huggingface.co/Comfy-Org/z_image_turbo` — check repo for split_files path | `diffusion_models/` |
| `z_image_base_bf16.safetensors` | same family repo | `diffusion_models/` |
| `qwen_3_4b.safetensors` (Z-Image text encoder) | Comfy-Org repackage, `split_files/text_encoders/` | `text_encoders/` |

## SDXL / SD1.5 community checkpoints (CivitAI)

Use `download_model({ action: "download_civitai", model_id })` — it resolves the latest version and
handles auth:

| Model | CivitAI |
|---|---|
| RedCraft RedZ ImageDX | `civitai.com/models/958009` |
| Qwen Ultimate Realism v1.1 | `civitai.com/models/2027494` |
| Copax Timeless | `civitai.com/models/copaxTimeless` (search by name) |

## Failure modes

- **404 on an HF resolve URL** — the repo restructured. Open the repo page,
  find the file under "Files", and rebuild the resolve URL.
- **401/403** — gated repo: set `HUGGINGFACE_TOKEN` after accepting the
  license, or `CIVITAI_API_TOKEN` for early-access CivitAI files.
- **Wrong dropdown after download** — file landed in the wrong `models/`
  subdir; check the Target column and `model-compatibility`.
- Downloads resume automatically on retry (HTTP Range) — re-run the same
  `download_model` call after a network drop.

## Sources

- **Official:** Hugging Face resolve-URL convention https://huggingface.co/<repo>/resolve/main/<path>
- **Empirical:** the curated list and Civitai notes are ours, not a vendor catalog.

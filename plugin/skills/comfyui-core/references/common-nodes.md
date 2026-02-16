# Common ComfyUI Nodes — Quick Reference

## Checkpoint & Model Loading

### CheckpointLoaderSimple
- **Inputs**: `ckpt_name` (combo: list of .safetensors/.ckpt files)
- **Outputs**: `MODEL` (0), `CLIP` (1), `VAE` (2)
- **Notes**: Primary entry point for most workflows. Loads model, text encoder, and VAE together.

### UNETLoader
- **Inputs**: `unet_name` (combo), `weight_dtype` (combo: `"default"`, `"fp8_e4m3fn"`, `"fp8_e5m2"`)
- **Outputs**: `MODEL` (0)
- **Notes**: Load just the diffusion model without CLIP/VAE. Used for Flux and other UNET-only models.

### CLIPLoader
- **Inputs**: `clip_name` (combo), `type` (combo: `"stable_diffusion"`, `"stable_cascade"`, `"sd3"`, `"stable_audio"`, `"mochi"`, `"ltxv"`, `"pixart"`, `"cosmos"`, `"lumina2"`, `"wan"`, `"hunyuan_video"`)
- **Outputs**: `CLIP` (0)

### DualCLIPLoader
- **Inputs**: `clip_name1` (combo), `clip_name2` (combo), `type` (combo)
- **Outputs**: `CLIP` (0)
- **Notes**: For SDXL and Flux (loads both CLIP-L and CLIP-G / T5).

### VAELoader
- **Inputs**: `vae_name` (combo)
- **Outputs**: `VAE` (0)

### LoraLoader
- **Inputs**: `model` (MODEL), `clip` (CLIP), `lora_name` (combo), `strength_model` (float, default 1.0), `strength_clip` (float, default 1.0)
- **Outputs**: `MODEL` (0), `CLIP` (1)
- **Notes**: Insert between checkpoint and the rest of the pipeline to apply a LoRA.

### UpscaleModelLoader
- **Inputs**: `model_name` (combo)
- **Outputs**: `UPSCALE_MODEL` (0)

## Text Encoding

### CLIPTextEncode
- **Inputs**: `text` (string), `clip` (CLIP)
- **Outputs**: `CONDITIONING` (0)
- **Notes**: Encodes a text prompt for use with KSampler. Use one for positive, one for negative.

### CLIPSetLastLayer
- **Inputs**: `clip` (CLIP), `stop_at_clip_layer` (int, -1 to -24, default -1)
- **Outputs**: `CLIP` (0)
- **Notes**: Clip skip. -1 = use all layers, -2 = skip last layer (common for anime models).

## Latent Space

### EmptyLatentImage
- **Inputs**: `width` (int, default 512), `height` (int, default 512), `batch_size` (int, default 1)
- **Outputs**: `LATENT` (0)
- **Notes**: Starting point for txt2img. SDXL works best at 1024x1024.

### VAEEncode
- **Inputs**: `pixels` (IMAGE), `vae` (VAE)
- **Outputs**: `LATENT` (0)
- **Notes**: Encode an image to latent space for img2img or inpainting.

### VAEDecode
- **Inputs**: `samples` (LATENT), `vae` (VAE)
- **Outputs**: `IMAGE` (0)
- **Notes**: Decode latents back to pixel space after sampling.

### SetLatentNoiseMask
- **Inputs**: `samples` (LATENT), `mask` (MASK)
- **Outputs**: `LATENT` (0)
- **Notes**: Apply an inpainting mask to latents before sampling.

### LatentUpscale
- **Inputs**: `samples` (LATENT), `upscale_method` (combo: `"nearest-exact"`, `"bilinear"`, `"area"`, `"bicubic"`, `"bislerp"`), `width` (int), `height` (int), `crop` (combo: `"disabled"`, `"center"`)
- **Outputs**: `LATENT` (0)

## Sampling

### KSampler
- **Inputs**: `model` (MODEL), `seed` (int), `steps` (int, default 20), `cfg` (float, default 8.0), `sampler_name` (combo), `scheduler` (combo), `positive` (CONDITIONING), `negative` (CONDITIONING), `latent_image` (LATENT), `denoise` (float, default 1.0)
- **Outputs**: `LATENT` (0)
- **Notes**: The core sampling node. `denoise` < 1.0 for img2img. Seeds auto-randomize by enqueue_workflow.

### KSamplerAdvanced
- **Inputs**: Same as KSampler plus `add_noise` (combo: `"enable"`, `"disable"`), `noise_seed` (int), `start_at_step` (int), `end_at_step` (int), `return_with_leftover_noise` (combo: `"disable"`, `"enable"`)
- **Outputs**: `LATENT` (0)
- **Notes**: For multi-pass sampling, hi-res fix, etc.

## Image Operations

### LoadImage
- **Inputs**: `image` (combo: list of files in input directory, or filename string)
- **Outputs**: `IMAGE` (0), `MASK` (1)
- **Notes**: Load an image from ComfyUI's input directory. Also outputs the alpha channel as a mask.

### SaveImage
- **Inputs**: `images` (IMAGE), `filename_prefix` (string, default `"ComfyUI"`)
- **Outputs**: none (output node)
- **Notes**: Saves to ComfyUI's output directory. Images are also returned via the API.

### PreviewImage
- **Inputs**: `images` (IMAGE)
- **Outputs**: none (output node)
- **Notes**: Like SaveImage but for temporary previews.

### ImageUpscaleWithModel
- **Inputs**: `upscale_model` (UPSCALE_MODEL), `image` (IMAGE)
- **Outputs**: `IMAGE` (0)
- **Notes**: AI upscaling (RealESRGAN, etc.)

### ImageScale
- **Inputs**: `image` (IMAGE), `upscale_method` (combo), `width` (int), `height` (int), `crop` (combo)
- **Outputs**: `IMAGE` (0)
- **Notes**: Simple resize (not AI upscaling).

### ImageInvert
- **Inputs**: `image` (IMAGE)
- **Outputs**: `IMAGE` (0)

### ImageBatch
- **Inputs**: `image1` (IMAGE), `image2` (IMAGE)
- **Outputs**: `IMAGE` (0)
- **Notes**: Combine two images into a batch.

## ControlNet

### ControlNetLoader
- **Inputs**: `control_net_name` (combo)
- **Outputs**: `CONTROL_NET` (0)

### ControlNetApply (Apply ControlNet)
- **Inputs**: `conditioning` (CONDITIONING), `control_net` (CONTROL_NET), `image` (IMAGE), `strength` (float, default 1.0)
- **Outputs**: `CONDITIONING` (0)
- **Notes**: Apply between CLIPTextEncode and KSampler's positive conditioning.

### ControlNetApplyAdvanced (Apply ControlNet Advanced)
- **Inputs**: `positive` (CONDITIONING), `negative` (CONDITIONING), `control_net` (CONTROL_NET), `image` (IMAGE), `strength` (float), `start_percent` (float), `end_percent` (float), `vae` (VAE, optional)
- **Outputs**: `CONDITIONING` (0), `CONDITIONING` (1)
- **Notes**: More control over when the ControlNet applies during sampling.

## Conditioning

### ConditioningCombine
- **Inputs**: `conditioning_1` (CONDITIONING), `conditioning_2` (CONDITIONING)
- **Outputs**: `CONDITIONING` (0)
- **Notes**: Combine two conditioning signals (e.g., for multi-prompt).

### ConditioningSetArea
- **Inputs**: `conditioning` (CONDITIONING), `width` (int), `height` (int), `x` (int), `y` (int), `strength` (float)
- **Outputs**: `CONDITIONING` (0)
- **Notes**: Apply conditioning to a specific region for compositional generation.

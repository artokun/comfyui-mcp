---
name: troubleshooting
description: Common ComfyUI errors and fixes — OOM, missing nodes, dtype mismatches, black images, and debugging strategies
globs:
  - "**/*.json"
---

# ComfyUI Troubleshooting Guide

## Error Diagnosis Strategy

When a workflow fails, follow this systematic approach:

1. **Get the error**: Use `get_history` to retrieve the execution result with full traceback
2. **Check logs**: Use `get_logs` with keyword filters like `"error"`, `"warning"`, `"traceback"`
3. **Identify the failing node**: The history response includes the `node_id` and `node_type` that failed
4. **Cross-reference inputs**: Use `get_node_info` to verify the failing node's expected input schema
5. **Check models**: Use `list_local_models` to verify all referenced model files exist

## Out of Memory (OOM)

### Error Pattern

```
torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate X MiB.
GPU 0 has a total capacity of 24.00 GiB of which X MiB is free.
```

Or:

```
RuntimeError: CUDA error: out of memory
```

### Root Cause

The GPU does not have enough VRAM to hold the model weights, intermediate tensors, and latent images simultaneously. Common triggers:
- High resolution images (2048x2048+)
- Multiple models loaded simultaneously
- FP32 precision models on limited VRAM
- Video generation (LTXV, AnimateDiff) with many frames
- Large batch sizes

### Fixes (in order of preference)

1. **Reduce resolution**: Drop to the model's native resolution (512 for SD 1.5, 1024 for SDXL/Flux)
2. **Use FP8/FP16 quantized models**: FP8 Flux models use ~8GB vs ~24GB for FP16
   - Search for FP8 variants: `search_models("flux fp8")` or `search_models("sdxl fp8")`
3. **Use `--lowvram` flag**: ComfyUI CLI flag that offloads model parts to CPU during inference
4. **Free VRAM between generations**: ComfyUI should auto-manage, but restarting clears leaked memory
5. **Use tiled VAE decoding**: For high-resolution images, tile the VAE decode step
   - Node: `VAEDecodeTiled` instead of `VAEDecode`
   - Breaks the image into tiles, decodes each separately, and stitches them together
6. **Reduce batch size**: Set batch_size to 1 in `EmptyLatentImage`
7. **Avoid multiple models**: Don't load two full checkpoints simultaneously — use one checkpoint and LoRAs instead
8. **For LTXV/video**: Always use FP8 quantized video models on 24GB cards

### VRAM Estimates

| Model | FP32 | FP16 | FP8 |
|-------|------|------|-----|
| SD 1.5 | ~4GB | ~2GB | ~1GB |
| SDXL | ~12GB | ~6GB | ~3GB |
| Flux Dev | ~48GB | ~24GB | ~12GB |
| Flux Schnell | ~48GB | ~24GB | ~12GB |
| LTXV | ~20GB+ | ~10GB+ | ~6GB |

## Device Mismatch

### Error Pattern

```
RuntimeError: Expected all tensors to be on the same device, but found at least
two devices, cuda:0 and cpu!
```

### Root Cause

A tensor on the CPU is being combined with a tensor on the GPU. This usually happens when:
- A custom node doesn't properly move tensors to the correct device
- Model offloading placed parts of the model on CPU
- A node produces CPU tensors while downstream expects GPU tensors

### Fixes

1. Check if the error occurs with a specific custom node — update or replace that node
2. If using `--lowvram` or `--cpu`, some nodes may not support CPU offloading
3. Restart ComfyUI to reset device state
4. Check if a custom node has a newer version that fixes device handling

## Missing Nodes

### Error Pattern

```
Cannot find node class 'NodeClassName'
```

Or in the execution response:
```
"error": {"type": "node_not_found", "message": "Cannot find node class 'X'"}
```

### Root Cause

The workflow references a node type that is not installed. This happens when:
- A custom node pack is not installed
- A custom node pack is installed but failed to load (import error)
- The node was renamed or removed in a pack update

### Fixes

1. **Search for the node pack**:
   ```
   search_custom_nodes("NodeClassName")
   ```
2. **Install via ComfyUI Manager** or the registry
3. **Check logs for import errors**:
   ```
   get_logs(keyword="import")
   get_logs(keyword="error")
   ```
   Import errors often reveal missing Python dependencies
4. **Install missing Python dependencies**: If the custom node requires a pip package:
   ```bash
   pip install missing-package
   ```
5. **Restart ComfyUI** after installing any custom node — nodes are loaded at startup

## NaN Tensor Errors

### Error Pattern

```
RuntimeError: Input contains NaN
```

Or images come out as solid gray/noise with NaN warnings in logs.

### Root Cause

Numerical instability during the diffusion process. Common triggers:
- **CFG scale too high**: Values above 15-20 can cause numerical overflow
- **Corrupted model weights**: Damaged download or incompatible merge
- **FP16 overflow**: Some operations overflow at half precision
- **Incompatible LoRA**: A LoRA trained for a different base model

### Fixes

1. **Lower CFG**: Try CFG 7.0 for SD 1.5/SDXL, 1.0 for Flux
2. **Use FP32 VAE**: Some VAEs produce NaN in FP16. Switch to `vae-ft-mse-840000-ema-pruned.safetensors` (FP32)
3. **Remove LoRAs**: Test without LoRAs to isolate the cause
4. **Re-download the model**: Hash verification can detect corrupted files
5. **Check LoRA compatibility**: Ensure the LoRA matches the base model family

## Dtype Mismatches

### Error Pattern

```
RuntimeError: expected scalar type Float but found Half
```

Or:

```
RuntimeError: expected scalar type Half but found Float
```

Or:

```
RuntimeError: Input type (float) and bias type (c10::Half) should be the same
```

### Root Cause

A model component expects one precision (FP32/FP16) but receives another. Most common with:
- VAE precision mismatch (FP16 model + FP32 VAE or vice versa)
- Mixed-precision LoRAs
- Custom nodes that force a specific dtype

### Fixes

1. **Use a separate VAE**: Load an explicit FP32 VAE instead of the checkpoint's built-in VAE
   - Node: `VAELoader` with `vae-ft-mse-840000-ema-pruned.safetensors`
2. **Match precision**: If the model is FP16, use FP16-compatible nodes throughout
3. **Force FP32 VAE decode**: Some node packs offer `VAEDecodeFP32` nodes
4. **Check ComfyUI settings**: `--force-fp32` flag forces everything to FP32 (uses more VRAM)

## CLIP Token Overflow

### Error Pattern

No explicit error — the prompt is silently truncated at 77 tokens, and details mentioned late in the prompt are ignored.

### Symptoms

- Later parts of long prompts have no effect on the image
- Adding more descriptive text doesn't change the output
- Removing early tokens suddenly makes later tokens work

### Fixes

1. **Use BREAK token**: Split the prompt at natural boundaries:
   ```
   subject description, pose, clothing, setting
   BREAK
   lighting, style, quality, camera angle
   ```
2. **Use CLIPTextEncodeSDXL**: SDXL's dual-CLIP processes two 77-token chunks
3. **Prioritize important tokens**: Put the most important descriptors first
4. **Use fewer filler words**: Remove articles and prepositions where possible
5. **Use embeddings**: Condense complex concepts into single tokens with textual inversions

## Black Images

### Error Pattern

No error in the execution — the workflow "succeeds" but produces completely black or near-black images.

### Root Causes and Fixes

| Cause | Diagnosis | Fix |
|-------|-----------|-----|
| `denoise = 0` | Check KSampler inputs | Set denoise to 1.0 for txt2img, 0.5-0.8 for img2img |
| `cfg = 0` | Check KSampler inputs | Set CFG to 7.0 (SD 1.5), 1.0 (Flux) |
| `steps = 0` | Check KSampler inputs | Set steps to 20+ (standard) or 4+ (turbo) |
| Wrong VAE | VAE doesn't match model | Use the correct VAE for the model family |
| Empty prompt | CLIPTextEncode has empty text | Add a text prompt |
| Wrong scheduler | Incompatible scheduler/sampler combo | Try `"normal"` scheduler with `"euler"` sampler |
| Seed collision | Extremely rare | Change the seed value |
| FP16 VAE overflow | VAE decode produces black | Use FP32 VAE or VAEDecodeTiled |

### Quick Diagnostic Checklist

1. Check `denoise` > 0 (should be 1.0 for txt2img)
2. Check `cfg` > 0 (should be 7.0 for SD 1.5, 1.0 for Flux)
3. Check `steps` > 0 (should be 20 for standard, 4 for turbo)
4. Verify the positive prompt is not empty
5. Try a different seed
6. Try a known-working sampler/scheduler combo: `euler` + `normal`

## Connection Type Errors

### Error Pattern

```
Output type 'IMAGE' doesn't match input type 'LATENT'
```

Or:

```
Required input 'model' of type 'MODEL' but got connection of type 'CLIP'
```

### Root Cause

Connecting the wrong output slot of a node to an incompatible input. Often caused by using the wrong output index.

### Fixes

1. **Check output indices**: Use `get_node_info` to verify the exact output order
   - `CheckpointLoaderSimple` outputs: 0=MODEL, 1=CLIP, 2=VAE
   - Getting index wrong: `["1", 0]` gives MODEL, `["1", 1]` gives CLIP
2. **Verify connection format**: `["nodeId", outputIndex]` — node ID is a string, index is an integer
3. **Check data type flow**: Ensure the pipeline follows the correct type chain:
   ```
   MODEL → KSampler
   CLIP → CLIPTextEncode → CONDITIONING → KSampler
   LATENT → KSampler → LATENT → VAEDecode → IMAGE
   VAE → VAEDecode, VAEEncode
   ```

## Model Loading Errors

### Error Pattern

```
FileNotFoundError: [Errno 2] No such file or directory: 'models/checkpoints/model.safetensors'
```

Or:

```
SafetensorError: Error reading file: invalid header
```

Or:

```
RuntimeError: PytorchStreamReader failed reading zip archive
```

### Root Causes

- **File not found**: Model file doesn't exist at the referenced path
- **Corrupted download**: Incomplete or damaged file
- **Wrong format**: File is not a valid safetensors/pickle/checkpoint format

### Fixes

1. **Verify the model exists**: `list_local_models(model_type="checkpoints")`
2. **Check the exact filename**: Model names in workflows must match the filename exactly (case-sensitive)
3. **Re-download**: If hash mismatch or corruption:
   ```
   download_model(url="...", target_subfolder="checkpoints")
   ```
4. **Check file size**: A 1KB safetensors file is clearly corrupted — re-download
5. **Verify subfolder**: Models must be in the correct subfolder (`checkpoints/`, `loras/`, `vae/`, etc.)

## Torch / CUDA Version Errors

### Error Pattern

```
RuntimeError: CUDA error: no kernel image is available for execution on the device
```

Or:

```
ImportError: cannot import name 'xxx' from 'torch'
```

Or:

```
AssertionError: Torch not compiled with CUDA enabled
```

### Root Cause

PyTorch and CUDA version incompatibility, usually after:
- Updating PyTorch without matching CUDA toolkit
- Installing a custom node that downgrades/changes PyTorch
- Using pip install that pulls a CPU-only PyTorch

### Fixes

1. **Check current versions**:
   ```
   get_system_stats()  # Shows PyTorch version and CUDA version
   ```
2. **Verify CUDA availability**: In Python: `torch.cuda.is_available()`
3. **Reinstall PyTorch with CUDA**: Visit pytorch.org for the correct install command matching your CUDA version
4. **Pin PyTorch version**: After fixing, avoid running `pip install` commands that might change PyTorch
5. **Use ComfyUI's bundled venv**: ComfyUI Desktop ships with a pre-configured Python environment

## ComfyUI Desktop vs CLI Differences

### Key Differences

| Aspect | ComfyUI Desktop | ComfyUI CLI |
|--------|----------------|-------------|
| Default port | 8000 | 8188 |
| Python | Embedded (bundled) | System/venv Python |
| Install location | `AppData/Local/Programs/ComfyUI/` | Wherever you cloned it |
| Custom nodes | `Documents/ComfyUI/custom_nodes/` | `./custom_nodes/` in repo |
| Models | `Documents/ComfyUI/models/` | `./models/` in repo |
| Config | `extra_model_paths.yaml` for shared paths | Same |
| Updates | Auto-updater in the app | `git pull` |

### Common Issues

- **Wrong port**: MCP tools default to 8188 — if using Desktop, configure for port 8000
- **Path confusion**: Desktop separates user data from application files
- **Custom node pip installs**: Desktop's embedded Python may not be on PATH — install within the venv

## Error-Specific Debugging Commands

### Workflow Failed — Get Details

```
get_history()                           # Most recent execution
get_history(prompt_id="abc-123")        # Specific execution
```

The response includes:
- `status.status_str`: "success" or "error"
- `status.messages`: Timestamped execution messages
- `outputs`: Node outputs (images, etc.)
- Error traceback for failed nodes

### Check Server Health

```
get_system_stats()    # GPU info, VRAM, Python/PyTorch versions
get_queue()           # Running and pending jobs
get_logs(max_lines=50, keyword="error")  # Recent error logs
```

### Verify Node Availability

```
get_node_info(node_type="KSampler")              # Check specific node
get_node_info(node_type="ControlNetApply")        # Verify custom nodes loaded
```

### Verify Models

```
list_local_models(model_type="checkpoints")       # Installed checkpoints
list_local_models(model_type="loras")             # Installed LoRAs
list_local_models(model_type="controlnet")        # Installed ControlNets
```

## Quick Reference: Error to Fix

| Error Message (partial) | Most Likely Fix |
|--------------------------|----------------|
| `CUDA out of memory` | Reduce resolution, use FP8 model, `--lowvram` |
| `Expected all tensors on same device` | Update custom node, restart ComfyUI |
| `Cannot find node class` | Install the node pack, restart ComfyUI |
| `Input contains NaN` | Lower CFG, use FP32 VAE, remove LoRAs |
| `expected scalar type Float but found Half` | Use FP32 VAE, or `--force-fp32` |
| `No such file or directory` (model) | Check filename, re-download model |
| `invalid header` (safetensors) | Re-download — file is corrupted |
| `CUDA error: no kernel image` | Reinstall PyTorch with matching CUDA version |
| Black images, no error | Check denoise > 0, cfg > 0, steps > 0, prompt not empty |
| Image looks garbled/noisy | Wrong model+VAE combo, wrong sampler settings |
| `Connection refused` on port 8188 | ComfyUI not running, or using Desktop (port 8000) |
| `Prompt outputs failed validation` | Node inputs don't match schema — check `get_node_info` |

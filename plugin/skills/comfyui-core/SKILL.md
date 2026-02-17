---
name: comfyui-core
description: Core ComfyUI knowledge — workflow format, node types, pipeline patterns, and MCP tool usage
globs:
  - "**/*.json"
---

# ComfyUI Core Knowledge

## Workflow JSON Format (API Format)

ComfyUI workflows are JSON objects mapping **string node IDs** to node definitions:

```json
{
  "1": {
    "class_type": "CheckpointLoaderSimple",
    "inputs": { "ckpt_name": "sd_xl_base_1.0.safetensors" },
    "_meta": { "title": "Load Checkpoint" }
  },
  "2": {
    "class_type": "CLIPTextEncode",
    "inputs": { "text": "a cat", "clip": ["1", 1] },
    "_meta": { "title": "Positive Prompt" }
  }
}
```

### Key Rules

- **Node IDs** are strings of integers (`"1"`, `"2"`, etc.)
- **`class_type`** is the exact Python class name of the node
- **`inputs`** contains both widget values (scalars) and connections (arrays)
- **Connections** use the format `["sourceNodeId", outputIndex]` — a 2-element array where:
  - First element: string node ID of the source node
  - Second element: integer index into the source node's `output` list (0-based)
- **`_meta`** is optional, used for display titles only

### Connection Examples

```json
"model": ["1", 0]       // Connect to node 1's first output (MODEL)
"clip": ["1", 1]        // Connect to node 1's second output (CLIP)
"vae": ["1", 2]         // Connect to node 1's third output (VAE)
"positive": ["2", 0]    // Connect to node 2's first output (CONDITIONING)
"samples": ["5", 0]     // Connect to node 5's first output (LATENT)
"images": ["6", 0]      // Connect to node 6's first output (IMAGE)
```

### Important: API Format vs Web UI Format

- **API format** (what we use): `{ "1": { class_type, inputs }, "2": { ... } }`
- **Web UI format** (NOT what we use): `{ "nodes": [...], "links": [...] }`
- All MCP tools expect and return API format
- The web UI can export API format via "Save (API Format)" or the `/prompt` endpoint

## Data Types

ComfyUI nodes pass typed data through connections:

| Type | Description | Common Source |
|------|-------------|---------------|
| `MODEL` | Diffusion model weights | CheckpointLoaderSimple (output 0) |
| `CLIP` | Text encoder | CheckpointLoaderSimple (output 1) |
| `VAE` | Variational autoencoder | CheckpointLoaderSimple (output 2) |
| `CONDITIONING` | Encoded text prompt | CLIPTextEncode (output 0) |
| `LATENT` | Latent space tensor | EmptyLatentImage, KSampler, VAEEncode |
| `IMAGE` | Pixel image tensor (BHWC) | VAEDecode, LoadImage, SaveImage |
| `MASK` | Single-channel mask | LoadImage (output 1) |
| `UPSCALE_MODEL` | Upscaling model | UpscaleModelLoader |

## Standard Pipeline Patterns

### Text-to-Image (txt2img)

```
CheckpointLoaderSimple → MODEL, CLIP, VAE
  ├─ CLIP → CLIPTextEncode (positive) → CONDITIONING
  ├─ CLIP → CLIPTextEncode (negative) → CONDITIONING
  │
EmptyLatentImage → LATENT
  │
KSampler (model, positive, negative, latent_image) → LATENT
  │
VAEDecode (samples, vae) → IMAGE
  │
SaveImage (images)
```

Node IDs typically: 1=Checkpoint, 2=Positive, 3=Negative, 4=EmptyLatent, 5=KSampler, 6=VAEDecode, 7=SaveImage

### Image-to-Image (img2img)

Same as txt2img but replace `EmptyLatentImage` with:
```
LoadImage → IMAGE
VAEEncode (pixels, vae) → LATENT → KSampler.latent_image
```
Set `KSampler.denoise` to 0.5–0.8 (lower = closer to input image).

### Upscale

```
LoadImage → IMAGE
UpscaleModelLoader → UPSCALE_MODEL
ImageUpscaleWithModel (upscale_model, image) → IMAGE
SaveImage (images)
```

### Inpaint

```
LoadImage (image) → IMAGE → VAEEncode → LATENT
LoadImage (mask) → MASK
SetLatentNoiseMask (samples, mask) → LATENT → KSampler.latent_image
```

## MCP Tool Usage Guide

### Quick Generation

1. `create_workflow` with template `"txt2img"` and your params
2. `enqueue_workflow` with the returned JSON — returns `prompt_id` immediately
3. Poll `get_job_status` with the `prompt_id` until `done` is true
4. Use `list_output_images` (limit 1) to find the generated image, then `Read` to display it

### Inspect & Modify

- `get_node_info` — query what nodes are available and their schemas
- `modify_workflow` — patch an existing workflow (set_input, add_node, remove_node, connect, insert_between)
- `visualize_workflow` — see a workflow as a mermaid diagram

### Reverse Engineering

- `visualize_workflow` — workflow JSON → mermaid diagram
- `mermaid_to_workflow` — mermaid diagram → workflow JSON (uses `/object_info` for schema resolution)

### Model Management

- `list_local_models` — see what's installed
- `search_models` — find models on HuggingFace
- `download_model` — download to ComfyUI's models directory

**Important**: Never ask the user to manually download models. If a required model is missing, proactively search for it and download it yourself:

1. Check `list_local_models` first
2. If missing, search HuggingFace via `search_models` or CivitAI via their REST API
3. Use `download_model` to install it directly to the correct subfolder

**CivitAI API** (when `CIVITAI_API_TOKEN` env var is available):
- Search: `GET https://civitai.com/api/v1/models?query={query}&types=Checkpoint&sort=Most+Downloaded&limit=5`
- Details: `GET https://civitai.com/api/v1/models/{modelId}`
- Download: `GET https://civitai.com/api/download/models/{modelVersionId}?token={token}`

CivitAI is preferred for fine-tuned models, community-rated checkpoints, and specialized LoRAs.
HuggingFace is preferred for official/base models (SDXL, Flux, SD 1.5).

### Custom Nodes

- `search_custom_nodes` — search the ComfyUI Registry
- `get_node_pack_details` — get details about a specific pack
- `generate_node_skill` — auto-generate a skill file for a node pack

### Workflow Execution

`enqueue_workflow` submits to ComfyUI's queue and returns `prompt_id` + queue position immediately. It does NOT block.

### Background Progress Monitoring

After enqueuing one or more workflows, use a **background Bash task** to monitor progress silently:

```bash
# Single job
Bash(run_in_background: true):
node "${CLAUDE_PLUGIN_ROOT}/scripts/monitor-progress.mjs" <prompt_id>

# Multiple jobs (batch)
Bash(run_in_background: true):
node "${CLAUDE_PLUGIN_ROOT}/scripts/monitor-progress.mjs" <id1> <id2> <id3>
```

The script connects to ComfyUI's WebSocket and reports:
- Step-by-step progress (e.g., `KSampler step 12/20 (60%)`)
- Success with output filenames and timing
- Errors with node details and messages

**Standard generation pattern:**
1. `create_workflow` or build workflow JSON + `enqueue_workflow` (repeat for batch)
2. Start background monitor with all prompt_ids
3. Continue conversation — results appear when jobs finish
4. Use `list_output_images` or `Read` to display the generated images

**Do NOT** poll `get_job_status` in a loop. The background monitor replaces polling entirely.

**Fallback**: If the monitor script is unavailable, use `get_job_status` to poll until `done` is true.

### Queue Management

- `get_queue` — shows running/pending job counts and prompt_ids
- `get_job_status` — check if a specific prompt_id is running, pending, or done
- `cancel_job` — interrupt a running job (pass optional `prompt_id` to target a specific one)
- `cancel_queued_job` — remove a specific pending job from the queue by `prompt_id`
- `clear_queue` — remove all pending jobs (does NOT stop the currently running job)

**When to use queue tools:**
- To check status: `get_job_status` for a quick boolean check (prefer background monitor for ongoing tracking)
- To abort: `cancel_job` stops what's running now; `cancel_queued_job` removes a pending one
- To start fresh: `clear_queue` then optionally `cancel_job`

### Monitoring & Recovery

- `get_system_stats` — GPU, VRAM, Python version, OS details
- `get_queue` — see running/pending jobs (also listed above under Queue Management)

**When ComfyUI is unresponsive or crashed:**
1. Try `get_system_stats` — if it fails, ComfyUI is down
2. Use `restart_comfyui` to restart it (preserves launch args from prior `stop_comfyui`)
3. If restart fails (no saved process info), use `start_comfyui` or ask the user to start it manually
4. After ComfyUI is back, re-enqueue any failed/lost workflows

**When a job appears hung (monitor shows `[STALL]`):**
1. Check `get_system_stats` — look at VRAM usage (OOM causes hangs)
2. Try `cancel_job` to interrupt the stuck job
3. If cancel fails, use `restart_comfyui` to force-restart
4. Use `clear_vram` after restart to free GPU memory before retrying

## KSampler Parameters

| Parameter | Type | Common Values |
|-----------|------|---------------|
| `seed` | int | Random (0 to 2^48). Omit to auto-randomize. |
| `steps` | int | 20 (standard), 4-8 (turbo/lightning models) |
| `cfg` | float | 7-8 (SD 1.5/SDXL), 1.0 (Flux), 3.5 (turbo) |
| `sampler_name` | string | `"euler"`, `"euler_ancestral"`, `"dpmpp_2m"`, `"dpmpp_sde"` |
| `scheduler` | string | `"normal"`, `"karras"`, `"sgm_uniform"` |
| `denoise` | float | 1.0 (txt2img), 0.5-0.8 (img2img), 0.75-0.9 (inpaint) |

## Mermaid Visualization Conventions

The `visualize_workflow` tool produces mermaid flowcharts with:

- **Subgraphs** grouping nodes by category: `loading`, `conditioning`, `sampling`, `image`, `output`
- **Edge labels** showing data types: `-->|MODEL|`, `-->|CLIP|`, `-->|LATENT|`, etc.
- **Node labels** showing class_type and optionally widget values
- **Direction**: `LR` (left-to-right) by default, `TB` (top-to-bottom) for large workflows

The `mermaid_to_workflow` tool parses mermaid back into workflow JSON, using connection type labels to resolve the correct input/output slots via `/object_info` schemas.

## Common Mistakes to Avoid

1. **Wrong connection format**: Use `["1", 0]` not `[1, 0]` — node IDs are strings
2. **Web UI format**: Don't pass `{ nodes: [], links: [] }` — use API format
3. **Missing VAE**: CheckpointLoaderSimple has 3 outputs — MODEL(0), CLIP(1), VAE(2)
4. **Wrong output index**: Check the node's output list order via `get_node_info`
5. **Seed handling**: `enqueue_workflow` randomizes seeds by default unless `disable_random_seed: true`

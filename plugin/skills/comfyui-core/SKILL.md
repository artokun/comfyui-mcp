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

- **API format** (for execution/analysis): `{ "1": { class_type, inputs }, "2": { ... } }` — compact, used by `enqueue_workflow`, `create_workflow (action:"validate")`, `create_workflow (action:"modify")`, etc.
- **Web UI format** (for saving and frontend editing): `{ "nodes": [...], "links": [...] }` — includes layout positions, sizes, groups, and visual metadata so ComfyUI's canvas can open and edit it
- Execution tools expect and return **API format**
- **Save in Web UI format** so saved workflows stay readable and editable in the ComfyUI frontend. A raw API-format save is NOT canvas-editable — it "exists" in the library but loads blank in the canvas, which strands users (and tempts agents into creating yet another new workflow instead of reopening the old one). Because of this, `save_workflow` auto-converts API-format input to Web UI format with a generated layout — but prefer passing real Web UI format (from `get_workflow(action="get", filename=…, format="ui")`) since a generated layout loses the original node positions/groups <!-- API-vs-UI save-format clarification adapted from 1696762169/comfyui-mcp@3da56c9 -->
- `get_workflow` defaults to `format="api"` for analysis/execution; use `format="ui"` when loading a workflow to re-save or edit in the canvas
- Muted/bypassed nodes are preserved with `_meta.mode: "muted"` — these are inactive but visible for understanding the workflow
- Get/Set virtual wire nodes are preserved with `_meta.title` and `Constant` key for tracing data flow

### Workflow Library Tools

- **`get_workflow(action="analyze", filename=…)`** — **use this first** to understand any saved workflow. Returns a structured text summary with sections, node IDs, key settings, virtual wires, and connection graph. No raw JSON — just what you need to reason about the workflow. Supports views: summary (default), overview (mermaid), detail (section mermaid), list, flat.
- **`get_workflow (action:"list")`** — list all saved workflows in ComfyUI's user library
- **`get_workflow(action="get", filename=…)`** — load raw workflow JSON. Only use when you need the actual JSON for `enqueue_workflow`, `create_workflow (action:"modify")`, or `save_workflow`. Use `action="analyze"` instead for understanding. **When the JSON is headed back to `save_workflow`, request `format="ui"`** so the workflow stays editable in the frontend.
- **`save_workflow(action="save", filename=…, workflow=…)`** — save a workflow to the user library. **Pass Web UI format (`{ nodes, links }`)** so it keeps its real layout in ComfyUI's canvas. API-format graphs are accepted and are **auto-converted to Web UI format** (with a generated layout) precisely because a raw API-format save is not canvas-editable — the frontend cannot open it. When re-saving an existing workflow, load it with `get_workflow(action="get", filename=…, format="ui")` and edit that, so positions/groups survive.

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
2. `enqueue_workflow(action="enqueue")` with the returned JSON — returns `prompt_id` immediately
3. Poll `queue` (action:"status") with the `prompt_id` until `done` is true
4. Use `get_image (action:"list_outputs")` (limit 1) to find the generated image, then `Read` to display it

### Inspect & Modify

- `create_workflow (action:"node_info")` — query what nodes are available and their schemas
- `create_workflow (action:"modify")` — patch an existing workflow (set_input, add_node, remove_node, connect, insert_between)
- `visualize_workflow` — see a workflow as a mermaid diagram

### Reverse Engineering

- `visualize_workflow` — workflow JSON → mermaid diagram
- `visualize_workflow (action:"mermaid")` — mermaid diagram → workflow JSON (uses `/object_info` for schema resolution)

### Model Management

- `list_local_models` — see what's installed
- `download_model` `action:"search"` — find models on HuggingFace
- `download_model` — download to ComfyUI's models directory

**Important**: Never ask the user to manually download models. If a required model is missing, proactively search for it and download it yourself:

1. Check `list_local_models` first
2. If missing, search HuggingFace via `download_model` `action:"search"` or CivitAI via their REST API
3. Use `download_model` to install it directly to the correct subfolder

**CivitAI API** (when `CIVITAI_API_TOKEN` env var is available):
- Search: `GET https://civitai.com/api/v1/models?query={query}&types=Checkpoint&sort=Most+Downloaded&limit=5`
- Details: `GET https://civitai.com/api/v1/models/{modelId}`
- Download: `GET https://civitai.com/api/download/models/{modelVersionId}?token={token}`

CivitAI is preferred for fine-tuned models, community-rated checkpoints, and specialized LoRAs.
HuggingFace is preferred for official/base models (SDXL, Flux, SD 1.5).

### Custom Nodes

- `search_custom_nodes` — search the ComfyUI Registry (`action: "search"`), or get one pack's details (`action: "details"`)
- `list_packs` (`action: "generate_skill"`) — auto-generate a skill file for a node pack

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
1. `create_workflow` or build workflow JSON + `enqueue_workflow(action="enqueue")` (repeat for batch)
2. Start background monitor with all prompt_ids
3. Continue conversation — results appear when jobs finish
4. Use `get_image (action:"list_outputs")` or `Read` to display the generated images

**Do NOT** poll `queue` (action:"status") in a loop. The background monitor replaces polling entirely.

**Fallback**: If the monitor script is unavailable, use `queue` (action:"status") to poll until `done` is true.

### Queue Management

One tool, `queue`, driven by its `action` parameter:

- `queue` (action:"list") — shows running/pending job counts and prompt_ids
- `queue` (action:"status") — check if a specific prompt_id is running, pending, or done
- `queue` (action:"cancel") — interrupt a running job (pass optional `prompt_id` to target a specific one)
- `queue` (action:"cancel_queued") — remove a specific pending job from the queue by `prompt_id`
- `queue` (action:"clear") — remove all pending jobs (does NOT stop the currently running job)

**When to use queue tools:**
- To check status: `queue` (action:"status") for a quick boolean check (prefer background monitor for ongoing tracking)
- To abort: `queue` (action:"cancel") stops what's running now; `queue` (action:"cancel_queued") removes a pending one
- To start fresh: `queue` (action:"clear") then optionally `queue` (action:"cancel")

### Monitoring & Recovery

- `get_system_stats` — GPU, VRAM, Python version, OS details
- `queue` (action:"list") — see running/pending jobs (also listed above under Queue Management)

**When ComfyUI is unresponsive or crashed:**
1. Try `get_system_stats` — if it fails, ComfyUI is down
2. Use `restart_comfyui` with `action: "restart"` (preserves launch args from a prior `action: "stop"`)
3. If restart fails (no saved process info), use `restart_comfyui` with `action: "start"` or ask the user to start it manually
4. After ComfyUI is back, re-enqueue any failed/lost workflows

**When a job appears hung (monitor shows `[STALL]`):**
1. Check `get_system_stats` — look at VRAM usage (OOM causes hangs)
2. Try `queue` (action:"cancel") to interrupt the stuck job
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

The `visualize_workflow (action:"mermaid")` tool parses mermaid back into workflow JSON, using connection type labels to resolve the correct input/output slots via `/object_info` schemas.

## Common Mistakes to Avoid

1. **Wrong connection format**: Use `["1", 0]` not `[1, 0]` — node IDs are strings
2. **Web UI format**: Don't pass `{ nodes: [], links: [] }` — use API format
3. **Missing VAE**: CheckpointLoaderSimple has 3 outputs — MODEL(0), CLIP(1), VAE(2)
4. **Wrong output index**: Check the node's output list order via `create_workflow (action:"node_info")`
5. **Seed handling**: `enqueue_workflow` randomizes seeds by default unless `disable_random_seed: true`

## Sources

- **Official:** ComfyUI workflow/API conventions from https://github.com/comfyanonymous/ComfyUI and https://docs.comfy.org
- **Empirical:** MCP tool recipes and KSampler default tables are product/empirical notes, not a vendor prompting guide.

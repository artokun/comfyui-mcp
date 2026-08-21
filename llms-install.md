# comfyui-mcp — Install Guide for AI Agents

This document tells an AI agent (Cline, Claude Code, Cursor, etc.) how to
install and configure comfyui-mcp in one shot. It is a focused subset of
the project [README](./README.md); see that file for full documentation.

## What you are installing

An MCP server that lets the user's AI assistant drive
[ComfyUI](https://github.com/comfyanonymous/ComfyUI): generate images, run and
author workflows, manage models and custom nodes, and control the server.
It exposes 86 MCP tools across the categories shown in
[docs/tools/](https://comfyui-mcp.artokun.io/docs/tools/image-generation).

## Prerequisites

- Node.js 22 or newer. Confirm with `node --version`; install it from
  [nodejs.org](https://nodejs.org/) or with `nvm` if missing.
- The package is published to npm as `comfyui-mcp` and runs via `npx`, so no
  global install is required.
- The server needs a ComfyUI to talk to. There are three options; pick one with the
  user (ask if unclear):

  1. **Local ComfyUI.** The user is running ComfyUI on the same machine. The
     server auto-detects the install path and port (8188, falling back to 8000). No
     extra config needed.
  2. **Remote ComfyUI.** The user runs ComfyUI on a different host
     (RunPod, VPS, LAN box). Pass `--comfyui-url <url>` or set the
     `COMFYUI_URL` env var. When the host is non-loopback, the server skips
     local-FS auto-detection.
  3. **Comfy Cloud.** The user has a [cloud.comfy.org](https://cloud.comfy.org)
     API key. Set the `COMFYUI_API_KEY` env var. The server routes HTTP calls to
     the cloud; local-only tools throw `CLOUD_UNSUPPORTED`.

## Add to the MCP client config

### Claude Code / Claude Desktop (`~/.claude/settings.json`)

Local ComfyUI (most common):

```json
{
  "mcpServers": {
    "comfyui": {
      "command": "npx",
      "args": ["-y", "comfyui-mcp"]
    }
  }
}
```

Remote ComfyUI:

```json
{
  "mcpServers": {
    "comfyui": {
      "command": "npx",
      "args": ["-y", "comfyui-mcp", "--comfyui-url", "https://my-comfy.example.com"]
    }
  }
}
```

RunPod: expose the image's HTTP port 3000 (nginx proxies ComfyUI on
the pod's internal port 3001), then use the RunPod proxy URL:

```json
{
  "mcpServers": {
    "comfyui": {
      "command": "npx",
      "args": ["-y", "comfyui-mcp", "--comfyui-url", "https://<pod-id>-3000.proxy.runpod.net"]
    }
  }
}
```

If `comfyui-mcp` itself runs inside the pod, set `RUNPOD_POD_ID` (the image
normally provides it) so local detection uses ComfyUI's internal port 3001.
For a pod-hosted bridge or phone pairing listener, expose that listener's port
too; the startup banner will print the corresponding `wss://<pod-id>-<port>`
URL instead of an unreachable container IP. `COMFYUI_MCP_PUBLIC_URL` is an
explicit public-origin override for other reverse proxies.

Comfy Cloud:

```json
{
  "mcpServers": {
    "comfyui": {
      "command": "npx",
      "args": ["-y", "comfyui-mcp"],
      "env": {
        "COMFYUI_API_KEY": "<ask the user for their cloud.comfy.org key>"
      }
    }
  }
}
```

### Cline / Cursor / generic MCP

Use the same `command` + `args` shape. Cline expects `command` + `args` in
its `cline_mcp_settings.json`; Cursor expects the same in its MCP settings
panel.

## Optional environment variables

Set these in the `env` block above. None are required for the local-default flow.

- `COMFYUI_HOST` / `COMFYUI_PORT` override the host and port (default is auto-detect)
- `COMFYUI_MCP_PUBLIC_URL` is the public origin to print for MCP, bridge, and pairing
  URLs when the host is behind a reverse proxy
- `COMFYUI_PATH` sets an explicit ComfyUI data/base path (also the checkout for a
  conventional install; auto-detected on Mac / Linux / Windows when unset)
- `COMFYUI_CODE_PATH` is an optional checkout path for split installs whose
  `main.py` and `.venv` are separate from data/model/user state; pip/venv/core
  updates use it while pack reads/writes stay on the live `--base-directory` /
  `COMFYUI_PATH` data root
- `COMFYUI_DOWNLOAD_CACHE_DIR` sets the model download cache (default
  `~/.comfyui-mcp/cache`)
- `COMFYUI_LRU_CACHE_SIZE_GB` caps the cache; `0` disables eviction
- `CIVITAI_API_TOKEN`, `HUGGINGFACE_TOKEN`, and `GITHUB_TOKEN` unlock gated
  downloads and higher API rate limits
- `REGISTRY_ACCESS_TOKEN` is the Comfy Registry API key for `node_pack` (`action: "publish"`)
- `COMFY_API_KEY` is the comfy.org API key for hosted partner nodes (different
  from `COMFYUI_API_KEY`, which is for Comfy Cloud)
- `COMFYUI_CLOUD_URL` overrides the Comfy Cloud endpoint
  (default `https://cloud.comfy.org`)

The full reference is at [docs/configuration](https://comfyui-mcp.artokun.io/docs/configuration).

## Verify

After updating the settings file, restart the MCP client (in Claude Code, run
`/mcp` to reconnect; in Cline, toggle the server). Then ask the assistant:

> What ComfyUI tools do you have?

It should list about 86 tools across generation, workflow execution and authoring,
models, custom nodes, and more. If the user wants a quick smoke test, ask:

> Generate a 1024×1024 image of a red apple on a wooden table.

That exercises the `generate_image` tool end-to-end. It auto-selects a local
checkpoint or uses defaults, and returns an `asset_id` you can pass to
`get_image (action:"view")` to see the result.

## Common issues

- **"ComfyUI not detected on ports 8188, 8000".** ComfyUI isn't running. Tell
  the user to start it (Desktop app or `python main.py`).
- **`CLOUD_UNSUPPORTED` errors.** `COMFYUI_API_KEY` is set, so the server is
  in cloud mode and a local-only tool was called. Either unset the key (to
  use a local install) or stick to cloud-compatible tools.
- **Empty model lists.** `extra_model_paths.yaml` is misconfigured. Run
  `get_system_stats (action:"health")` for a diagnostic.

## License + repo

- License: [MIT](./LICENSE)
- Repo: https://github.com/artokun/comfyui-mcp
- npm: https://www.npmjs.com/package/comfyui-mcp
- Docs: https://comfyui-mcp.artokun.io/docs
- Issues: https://github.com/artokun/comfyui-mcp/issues

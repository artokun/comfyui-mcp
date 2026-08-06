# comfyui-mcp — Install Guide for AI Agents

This document tells an AI agent (Cline, Claude Code, Cursor, etc.) how to
install and configure **comfyui-mcp** in one shot. It is a focused subset of
the project [README](./README.md) — see that file for full documentation.

## What you are installing

An MCP server that lets the user's AI assistant drive
[ComfyUI](https://github.com/comfyanonymous/ComfyUI): generate images, run and
author workflows, manage models and custom nodes, and control the server.
**86 MCP tools** across the categories shown in
[docs/tools/](https://comfyui-mcp.artokun.io/docs/tools/image-generation).

## Prerequisites

- **Node.js ≥ 22.** Confirm with `node --version`; install via
  [nodejs.org](https://nodejs.org/) or `nvm` if missing.
- The package is published to npm as **`comfyui-mcp`** and runs via `npx` — no
  global install required.
- The server needs a ComfyUI to talk to. **Three options**, pick one with the
  user (ask if unclear):

  1. **Local ComfyUI** — the user is running ComfyUI on the same machine. The
     server auto-detects the install path and port (8188 → 8000 fallback). No
     extra config needed.
  2. **Remote ComfyUI** — the user runs ComfyUI on a different host
     (RunPod, VPS, LAN box). Pass `--comfyui-url <url>` or set
     `COMFYUI_URL` env. When the host is non-loopback, local-FS auto-detection
     is suppressed.
  3. **Comfy Cloud** — the user has a [cloud.comfy.org](https://cloud.comfy.org)
     API key. Set `COMFYUI_API_KEY` env. The server routes HTTP primitives to
     the cloud; local-only tools throw `CLOUD_UNSUPPORTED`.

## Add to the MCP client config

### Claude Code / Claude Desktop (`~/.claude/settings.json`)

**Local ComfyUI** (most common):

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

**Remote ComfyUI:**

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

**Comfy Cloud:**

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

Use the same `command` + `args` shape (Cline expects `command` + `args` in
its `cline_mcp_settings.json`; Cursor expects similar in its MCP settings
panel).

## Optional environment variables

Set in the `env` block above. None are required for the local-default flow.

- `COMFYUI_HOST` / `COMFYUI_PORT` — override host/port (defaults: auto-detect)
- `COMFYUI_PATH` — explicit ComfyUI install path (auto-detected on Mac / Linux
  / Windows when unset)
- `COMFYUI_DOWNLOAD_CACHE_DIR` — model download cache (default
  `~/.comfyui-mcp/cache`)
- `COMFYUI_LRU_CACHE_SIZE_GB` — cap the cache; `0` disables eviction
- `CIVITAI_API_TOKEN`, `HUGGINGFACE_TOKEN`, `GITHUB_TOKEN` — for gated
  downloads and higher API rate limits
- `REGISTRY_ACCESS_TOKEN` — Comfy Registry API key for `node_pack` (`action: "publish"`)
- `COMFY_API_KEY` — comfy.org API key for hosted partner nodes (different
  from `COMFYUI_API_KEY`, which is for Comfy Cloud)
- `COMFYUI_CLOUD_URL` — override the Comfy Cloud endpoint
  (default `https://cloud.comfy.org`)

Full reference: [docs/configuration](https://comfyui-mcp.artokun.io/docs/configuration).

## Verify

After updating the settings file, **restart the MCP client** (Claude Code: run
`/mcp` to reconnect; Cline: toggle the server). Then ask the assistant:

> What ComfyUI tools do you have?

It should list ~86 tools across generation, workflow execution/authoring,
models, custom nodes, etc. If the user wants a quick smoke test, ask:

> Generate a 1024×1024 image of a red apple on a wooden table.

That exercises the `generate_image` tool end-to-end (auto-selects a local
checkpoint or uses defaults; returns an `asset_id` you can `get_image (action:"view")` to
see).

## Common issues

- **"ComfyUI not detected on ports 8188, 8000"** — ComfyUI isn't running. Tell
  the user to start it (Desktop app or `python main.py`).
- **`CLOUD_UNSUPPORTED` errors** — `COMFYUI_API_KEY` is set, so the server is
  in cloud mode and a local-only tool was called. Either unset the key (to
  use a local install) or stick to cloud-compatible tools.
- **Empty model lists** — `extra_model_paths.yaml` is misconfigured. Run
  `get_system_stats (action:"health")` for a diagnostic.

## License + repo

- **License:** [MIT](./LICENSE)
- **Repo:** https://github.com/artokun/comfyui-mcp
- **npm:** https://www.npmjs.com/package/comfyui-mcp
- **Docs:** https://comfyui-mcp.artokun.io/docs
- **Issues:** https://github.com/artokun/comfyui-mcp/issues

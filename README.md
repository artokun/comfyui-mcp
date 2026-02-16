# comfyui-mcp

**MCP server + Claude Code plugin for [ComfyUI](https://github.com/comfyanonymous/ComfyUI)** — execute workflows, generate images, visualize pipelines, manage models, and explore custom nodes, all from your AI coding assistant.

[![npm version](https://img.shields.io/npm/v/comfyui-mcp)](https://www.npmjs.com/package/comfyui-mcp)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/npm/l/comfyui-mcp)](./LICENSE)

Works on **macOS**, **Linux**, and **Windows**. Auto-detects your ComfyUI installation and port.

---

## Quick Start

**1. Install ComfyUI** (if you haven't already): [ComfyUI Desktop](https://www.comfy.org/download) or [from source](https://github.com/comfyanonymous/ComfyUI)

**2. Add the MCP server** to your Claude Code config (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "comfyui": {
      "command": "npx",
      "args": ["-y", "comfyui-mcp"],
      "env": {
        "CIVITAI_API_TOKEN": ""
      }
    }
  }
}
```

**3. Start using it.** With ComfyUI running, ask Claude to generate an image:

```
> Generate an image of a sunset over mountains
```

Claude will find (or download) a checkpoint, build a workflow, execute it, and return the image.

> **Note**: This runs as a standalone MCP server — no need to clone this repo. `npx` will download and run it automatically.

---

## Claude Code Plugin

This package also ships as a **Claude Code plugin**, providing slash commands, skills, and an explorer agent on top of the MCP tools.

### Install as a plugin

```bash
claude plugin install comfyui-mcp
```

### Slash commands

| Command | Description |
|---------|-------------|
| `/comfy:gen <prompt>` | Generate an image from a text description |
| `/comfy:viz <workflow>` | Visualize a workflow as a Mermaid diagram |
| `/comfy:node-skill <pack>` | Generate a Claude skill for a custom node pack |

### Built-in skill

The **comfyui-core** skill gives Claude deep knowledge of ComfyUI's workflow format, node types, data flow patterns, and pipeline architecture — so it can build and debug workflows without guessing.

### Explorer agent

The **comfy-explorer** agent autonomously researches custom node packs: it reads documentation, queries node definitions from your running ComfyUI, finds example workflows, and generates comprehensive skill files.

---

## MCP Tools

### Workflow Execution

| Tool | Description |
|------|-------------|
| `run_workflow` | Execute a workflow (API format JSON), returns images as base64 |
| `get_job_status` | Check execution status of a running job |
| `get_queue` | View the current execution queue |
| `cancel_job` | Interrupt the currently running job |
| `get_system_stats` | Get system info (GPU, VRAM, Python version, OS) |

### Workflow Visualization

| Tool | Description |
|------|-------------|
| `visualize_workflow` | Convert a workflow to a Mermaid flowchart diagram |
| `mermaid_to_workflow` | Convert a Mermaid diagram back to executable workflow JSON |

### Workflow Composition

| Tool | Description |
|------|-------------|
| `create_workflow` | Generate a workflow from templates (txt2img, img2img, upscale, inpaint) |
| `modify_workflow` | Apply operations: set_input, add_node, remove_node, connect, insert_between |
| `get_node_info` | Query available node types from ComfyUI's `/object_info` |

### Model Management

| Tool | Description |
|------|-------------|
| `search_models` | Search HuggingFace for compatible models |
| `download_model` | Download a model to the correct ComfyUI subdirectory |
| `list_local_models` | List installed models by type (checkpoints, loras, vae, etc.) |

### Registry & Discovery

| Tool | Description |
|------|-------------|
| `search_custom_nodes` | Search the ComfyUI Registry for custom node packs |
| `get_node_pack_details` | Get full details of a custom node pack |
| `generate_node_skill` | Generate a Claude skill from a registry ID or GitHub URL |

### Diagnostics

| Tool | Description |
|------|-------------|
| `get_logs` | Get ComfyUI server logs (with optional keyword filter) |
| `get_history` | Get execution history with error details and tracebacks |

### Workflow Library

| Tool | Description |
|------|-------------|
| `list_workflows` | List saved workflows from ComfyUI's user library |
| `get_workflow` | Load a specific saved workflow |

---

## Configuration

The server auto-detects your ComfyUI installation and port. Override with environment variables if needed:

| Variable | Default | Description |
|----------|---------|-------------|
| `COMFYUI_HOST` | `127.0.0.1` | ComfyUI server address |
| `COMFYUI_PORT` | *(auto-detect)* | ComfyUI server port (tries 8188, then 8000) |
| `COMFYUI_PATH` | *(auto-detect)* | Path to ComfyUI data directory |
| `CIVITAI_API_TOKEN` | | CivitAI API token for model downloads |
| `HUGGINGFACE_TOKEN` | | HuggingFace token for higher API rate limits |
| `GITHUB_TOKEN` | | GitHub token for skill generation (avoids rate limits) |
| `LOG_LEVEL` | `info` | Logging verbosity: `debug`, `info`, `warn`, `error` |

### Auto-detection

**Port**: Probes `8188` (CLI default) then `8000` (Desktop app default) via `/system_stats`.

**Path**: Checks common locations in order:

- `~/Documents/ComfyUI` (macOS/Windows Desktop app data directory)
- `~/Library/Application Support/ComfyUI` (macOS)
- `~/AppData/Local/Programs/ComfyUI/resources/ComfyUI` (Windows Desktop app install)
- `~/AppData/Local/ComfyUI` (Windows)
- `~/ComfyUI`, `~/code/ComfyUI`, `~/projects/ComfyUI`, `~/src/ComfyUI`
- `/opt/ComfyUI`, `~/.local/share/ComfyUI` (Linux)
- Scans `~/Documents` and `~/My Documents` for any directory containing "ComfyUI"

Set `COMFYUI_PATH` to skip detection and use an explicit path.

---

## Examples

### Generate an image

```
> /comfy:gen a cyberpunk city at night with neon lights
```

Claude will:
1. Check installed checkpoints (download one if needed)
2. Build a txt2img workflow with your prompt
3. Execute it on ComfyUI
4. Return the generated image

### Visualize a workflow

```
> /comfy:viz ~/workflows/my-workflow.json
```

Produces a Mermaid diagram with nodes grouped by category:

```mermaid
flowchart LR
  subgraph Loaders
    1["CheckpointLoaderSimple"]
  end
  subgraph Conditioning
    2(["Positive Prompt"])
    3(["Negative Prompt"])
  end
  subgraph Sampling
    5{{"KSampler<br/>steps:20 cfg:8"}}
  end
  1 -->|MODEL| 5
  2 -->|CONDITIONING| 5
  3 -->|CONDITIONING| 5
```

### Manage models

```
> What checkpoints do I have installed?
> Search HuggingFace for SDXL turbo models
> Download this model to my checkpoints folder
```

### Explore custom nodes

```
> /comfy:node-skill comfyui-impact-pack
```

Generates a comprehensive skill file documenting every node, its inputs/outputs, and usage patterns.

---

## Development

### Prerequisites

- [Node.js](https://nodejs.org) >= 22.0.0
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) running locally

### Setup

```bash
git clone https://github.com/artokun/comfyui-mcp.git
cd comfyui-mcp
npm install
```

### Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Run from source with tsx (hot reload) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output |
| `npm test` | Run unit tests (vitest) |
| `npm run test:integration` | Run integration tests (requires running ComfyUI) |
| `npm run lint` | Type-check without emitting |

### Local testing with Claude Code

Point Claude Code at your local build instead of the npm package:

```json
{
  "mcpServers": {
    "comfyui": {
      "command": "node",
      "args": ["/path/to/comfyui-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

Or test the plugin directly:

```bash
claude --plugin-dir ./plugin
```

### Project structure

```
src/
  index.ts              # MCP server entry point (stdio transport)
  config.ts             # Auto-detection & environment config
  comfyui/
    client.ts           # ComfyUI WebSocket/HTTP client wrapper
    types.ts            # TypeScript interfaces
  services/
    workflow-executor.ts # Execute workflows, handle images & errors
    workflow-composer.ts # Templates (txt2img, img2img, upscale, inpaint)
    mermaid-converter.ts # Workflow -> Mermaid diagram
    mermaid-parser.ts    # Mermaid diagram -> Workflow
    model-resolver.ts    # HuggingFace search, local models, downloads
    registry-client.ts   # ComfyUI Registry API
    skill-generator.ts   # Generate node pack skill docs
  tools/                 # MCP tool registration (one file per group)
  utils/
    errors.ts            # Custom error hierarchy with MCP integration
    logger.ts            # stderr-only logging (safe for stdio transport)
    image.ts             # Base64 encoding utilities
plugin/
  .claude-plugin/        # Plugin manifest
  .mcp.json              # MCP server config for plugin
  commands/              # Slash command definitions
  skills/                # Built-in knowledge (comfyui-core)
  agents/                # Explorer agent
  hooks/                 # Hook configuration
```

---

## How It Works

The server communicates with ComfyUI through its REST API and WebSocket interface:

- **WebSocket** — enqueue workflows, receive real-time progress updates, get execution results
- **REST API** — system stats, node definitions (`/object_info`), logs, history, queue management, workflow library
- **File system** — read/write models directory, detect installation paths
- **External APIs** — HuggingFace (model search), ComfyUI Registry (custom node discovery), GitHub (skill generation), CivitAI (model downloads)

All communication with the MCP client (Claude Code) happens over **stdio** using the [Model Context Protocol](https://modelcontextprotocol.io). Logs go to stderr to avoid polluting the protocol stream.

---

## Troubleshooting

**"ComfyUI not detected on ports 8188, 8000"**
Make sure ComfyUI is running. The Desktop app uses port 8000 by default; the CLI uses 8188. Set `COMFYUI_PORT` if you're using a custom port.

**"COMFYUI_PATH is not configured"**
The auto-detection couldn't find your ComfyUI data directory. Set `COMFYUI_PATH` to the directory containing your `models/` folder (e.g., `~/Documents/ComfyUI`).

**"Multiple ComfyUI installations detected"**
This is informational — the server uses the first one found. Set `COMFYUI_PATH` to pick a specific installation.

**Model downloads fail**
For HuggingFace gated models, set `HUGGINGFACE_TOKEN`. For CivitAI, set `CIVITAI_API_TOKEN`.

**Workflow execution errors**
Use `get_history` or `get_logs` to see detailed error messages including Python tracebacks from ComfyUI.

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes and ensure `npm run lint` passes
4. Submit a pull request

---

## License

See [LICENSE](./LICENSE) for details.

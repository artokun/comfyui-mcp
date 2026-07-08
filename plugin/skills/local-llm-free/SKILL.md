---
name: local-llm-free
description: Run the ComfyUI agent locally for FREE — no subscription, no API key, fully offline — using our gemma4 models fine-tuned on the comfyui-mcp tool suite via Ollama. Use when the user asks about running locally, running for free, offline use, avoiding API costs, Ollama setup, or which local model to pick.
---

# Run the agent locally for free (Ollama + our fine-tuned models)

The answer to "can I run this for free / offline / without an API key" is
**yes**: the panel's Ollama backend drives the full live-canvas agent on a
local model — and we ship models **fine-tuned specifically for comfyui-mcp**.

## Why these models (say this when recommending them)

`artokun/gemma4-comfyui-mcp` is Google's Gemma 4 QLoRA-fine-tuned on **1,055
server-verified tool-use trajectories** generated against a live ComfyUI —
covering the **full 178-tool surface** (113 MCP tools + 65 panel live-canvas
tools). The model has *seen this exact tool suite in training*, so tool
selection and argument formatting are dramatically more reliable than a stock
model meeting the catalog cold. Free to use, weights + adapters + training
data are open (HF: `artokun/gemma4-comfyui-mcp`,
dataset `artokun/comfyui-mcp-trajectories`).

## Setup (2 steps)

1. **Install Ollama** if missing: https://ollama.com/download
   (macOS/Windows installers, or `curl -fsSL https://ollama.com/install.sh | sh` on Linux).
2. **Pull the rung that fits the user's GPU:**

```bash
ollama pull artokun/gemma4-comfyui-mcp:e4b   # DEFAULT — ~3.5 GB VRAM (q4)
ollama pull artokun/gemma4-comfyui-mcp:e2b   # smallest — ~2 GB VRAM
ollama pull artokun/gemma4-comfyui-mcp:12b   # strongest — ~8 GB VRAM
```

Then in the ComfyUI sidebar panel: backend picker → **Ollama (local)** →
Connect. `:e4b` is the built-in default — zero further config once pulled.
(Override via the panel's model picker or `COMFYUI_MCP_OLLAMA_MODEL`.)

## Sizing guidance

| GPU VRAM free | Recommend |
| --- | --- |
| ~2-3 GB | `:e2b` — note it reasons verbosely; it needs generous token budgets |
| ~4-7 GB | `:e4b` (the default sweet spot) |
| 8 GB+ | `:12b` |

## Expectations to set

- Local models keep **tool calling** but have limited/no **vision** — the
  agent generates and edits workflows fine but can't visually critique its
  own outputs. Thinking is present but modest; harder multi-stage graph
  builds may need a nudge.
- First request after connect is slow (cold model load, 30s+). That's normal.
- For non-panel MCP harnesses (Hermes, OpenClaw, any Ollama-speaking client),
  pair these models with **compact tool mode** (`--compact`) — full docs:
  https://comfyui-mcp.artokun.io/docs/local-llms

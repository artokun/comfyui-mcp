# comfyui-mcp RunPod image (DRAFT)

A custom RunPod ComfyUI image that boots **ready to be driven by the
[comfyui-mcp](https://github.com/artokun/comfyui-mcp) Agent Panel**. One-click
deploy on RunPod, run **one local command** on your laptop, and the agent drives
the pod's live ComfyUI graph from your Claude/ChatGPT subscription.

> **Status: DRAFT for owner review.** These files are authored to be correct and
> well-documented, but the image has **not** been built or pushed. A few tags/
> pins still need confirmation — see [Owner confirmations needed](#owner-confirmations-needed).

---

## TL;DR

1. **Deploy** this image on RunPod (GPU pod, e.g. RTX 5090). Expose the HTTP
   port and attach a volume (fields below).
2. On your laptop:
   ```bash
   npx -y comfyui-mcp connect https://<pod-id>-3001.proxy.runpod.net
   ```
3. Open the pod's ComfyUI in the browser, open the **Agent Panel** sidebar, hit
   **Connect**, and start driving the graph in natural language.

The agent's brain (the **panel orchestrator**) runs **locally on your machine**
on your own subscription — see [Topology](#topology-where-the-agent-actually-runs).

---

## What's baked into the image

Everything below is part of the image so a **stop/start re-uses it with zero
manual steps**:

| Layer | Detail |
|-------|--------|
| **Base** | `nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04` (CUDA 12.8 runtime + cuDNN) |
| **Python** | 3.11 venv at `/opt/venv` (deadsnakes PPA; 22.04 ships 3.10) |
| **ComfyUI** | `0.26.x` cloned to `/ComfyUI` |
| **PyTorch** | `torch torchvision torchaudio` from the **cu128** index (torch 2.11+cu128, supports **sm_120**) |
| **Attention** | xformers **omitted** (ABI/cu128); ComfyUI runs `--use-pytorch-cross-attention` |
| **ComfyUI stack** | `requirements.txt` (the modern 0.26 set: sqlalchemy, alembic, comfy-aimdo, comfy-kitchen, blake3, comfy-angle, av, …) |
| **Manager v2** | `comfyui_manager==4.2.2` (pip Manager that exposes `/v2/manager/queue/task` — the API the MCP targets) |
| **Agent Panel** | `comfyui-mcp-panel` cloned into `custom_nodes/` (registry id `comfyui-agent-panel`) |
| **Entrypoint** | `start.sh` launches ComfyUI with all required flags + writes the Manager config |
| **Optional proxy** | `nginx.conf` mirror `:3000 → :3001` (off by default) |

**Deliberately NOT in the image:** Node.js, the Claude/Codex Agent SDK, or any
LLM client. See [Topology](#topology-where-the-agent-actually-runs).

---

## Why CUDA 12.8 / cu128 (the RTX 5090 rationale)

Blackwell GPUs (RTX 5090, compute capability **sm_120**) are **not** supported by
the default PyTorch cu121 wheels — you get `no kernel image is available for
execution on the device` at first inference. The fix, verified on a live RTX 5090
pod (2026-06-30), is the whole cu128 chain:

* CUDA **12.8** runtime base image, so the userspace CUDA libs match.
* PyTorch installed from the **cu128** index:
  ```bash
  pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
  ```
  This yields **torch 2.11+cu128**, which ships sm_120 kernels.
* **xformers omitted** — its prebuilt wheels lag the cu128 ABI, so we skip it and
  launch ComfyUI with `--use-pytorch-cross-attention` (PyTorch SDPA attention),
  which needs no extra build and is fully sm_120-compatible.

Install order matters: torch is installed **before** `requirements.txt` so the
ComfyUI deps don't pull a cu-default torch from PyPI and silently downgrade you.

---

## The `--enable-manager` requirement

ComfyUI 0.26 ships a **built-in pip Manager** (`comfyui_manager`) that is the one
the comfyui-mcp MCP talks to (`/v2/manager/queue/task`). Two non-obvious rules,
both baked in here:

1. **Do NOT** also clone the classic `custom_nodes/ComfyUI-Manager` checkout —
   the legacy node and the pip Manager **conflict**. This image installs **only**
   the pip Manager.
2. ComfyUI 0.26 **gates the pip Manager behind `--enable-manager`**. Without that
   flag the `/v2/manager/...` endpoints don't exist and the agent can't install
   nodes/models. `start.sh` always passes it.

**Manager security level** (`<ComfyUI>/user/__manager/config.ini`,
`security_level`), set by `start.sh` and overridable via env:

| Value | Meaning |
|-------|---------|
| `normal-` (default) | Safe default for remote installs — lets the panel queue node/model installs while still blocking the riskiest operations. |
| `weak` | **Most permissive** (no install guardrails). Only on a pod you fully trust/control. Set `COMFY_SECURITY_LEVEL=weak`. |

---

## Topology: where the agent actually runs

This image is built for the **"agent runs locally"** model:

```
  YOUR LAPTOP                                   RUNPOD POD (this image)
  ┌───────────────────────────┐                ┌───────────────────────────────┐
  │ npx comfyui-mcp connect …  │  HTTP/WS  ───▶ │ ComfyUI 0.26 (:3001)           │
  │  └─ panel orchestrator     │                │  ├─ Manager v2 (--enable-mgr)  │
  │     (Claude/Codex Agent SDK│ ◀───  events   │  └─ Agent Panel (sidebar)      │
  │      on YOUR subscription) │                │                                │
  └───────────────────────────┘                └───────────────────────────────┘
```

The **panel orchestrator** (the autonomous agent loop, on your Claude **or**
ChatGPT subscription — no API key) runs **on your machine**, not on the pod. The
pod only needs to serve ComfyUI + Manager + the panel UI. That's why **Node.js,
the Agent SDK, and any LLM client are intentionally absent** from the image —
they'd be dead weight and would burn pod GPU-hours for nothing.

---

## Networking / ports

ComfyUI listens on `--listen 0.0.0.0 --port 3001`. RunPod's HTTP proxy needs the
container to expose the port you list as an **HTTP** port in the template; it then
gives you `https://<pod-id>-<port>.proxy.runpod.net`.

Two supported layouts:

* **Single port (default, simplest):** publish **3001** in the template. ComfyUI
  is reached directly. Leave `USE_NGINX=0`.
* **nginx mirror (optional):** publish **3000**, set `USE_NGINX=1`. `start.sh`
  starts nginx to proxy `:3000 → :3001` (the verified live-pod pattern). The
  bundled `nginx.conf` already handles WebSocket upgrade, unlimited upload size,
  and long timeouts. Use this if you want ComfyUI itself bound to an internal
  port behind a proxy.

Either way the agent connects to the **public proxy URL** of whichever port you
published.

---

## Deploy on RunPod

Create a **Pod template** (or fill these in on a one-off GPU pod):

| Template field | Value |
|----------------|-------|
| **Container image** | `<your-registry>/comfyui-mcp-runpod:<tag>` (after you build & push — see below) |
| **Container disk** | ≥ 20 GB (the baked install) |
| **Volume disk** | e.g. 100 GB+ (for models/outputs) |
| **Volume mount path** | `/workspace` |
| **Expose HTTP ports** | `3001` (or `3000` if you use the nginx mirror) |
| **Expose TCP ports** | *(none required)* |
| **GPU** | RTX 5090 / any Blackwell or Ada card (cu128 covers both) |

**Optional env** (Pod → Environment):

| Env | Default | Purpose |
|-----|---------|---------|
| `COMFY_PORT` | `3001` | Port ComfyUI binds. Match your exposed HTTP port. |
| `COMFY_SECURITY_LEVEL` | `normal-` | Manager security level (`weak` = most permissive). |
| `USE_NGINX` | `0` | `1` = run the `:3000 → :3001` nginx mirror. |
| `PUBLIC_PORT` | `3000` | Public port for the nginx mirror. |
| `PERSIST_ROOT` | *(unset)* | Set to `/workspace` to keep `models/output/input/user` on the volume (survives full pod re-create, not just stop/start). |
| `COMFY_EXTRA_ARGS` | *(empty)* | Extra ComfyUI flags appended verbatim. |

> **Persistence note:** stop/start on RunPod preserves the container disk, so the
> baked install + Manager config persist automatically. Setting
> `PERSIST_ROOT=/workspace` additionally moves the heavy/stateful dirs onto the
> network volume so they also survive a **pod re-create** (and let you swap GPUs
> without re-downloading models).

### Build & push the image (owner / maintainer)

This repo cannot build Docker, so do this on a machine with Docker + a GPU-less
build is fine (no CUDA needed at build time):

```bash
cd docker/runpod
docker build -t <your-registry>/comfyui-mcp-runpod:0.26-cu128 .
docker push <your-registry>/comfyui-mcp-runpod:0.26-cu128
```

Override any pin at build time, e.g.:

```bash
docker build \
  --build-arg COMFYUI_VERSION=v0.26.0 \
  --build-arg CUDA_IMAGE=nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04 \
  --build-arg COMFYUI_MANAGER_VERSION=4.2.2 \
  -t <your-registry>/comfyui-mcp-runpod:0.26-cu128 .
```

---

## The one-command local connect

Once the pod is up and you have its proxy URL, on your laptop:

```bash
npx -y comfyui-mcp connect https://<pod-id>-3001.proxy.runpod.net
```

This starts the comfyui-mcp panel orchestrator pointed at the pod. Then open the
pod's ComfyUI, open the **Agent Panel**, and click **Connect**.

> **DRAFT NOTE — `connect` subcommand:** the shipped CLI currently selects a
> remote target with the **`--comfyui-url`** flag, not a `connect` subcommand.
> The exact equivalents today are:
> ```bash
> # remote ComfyUI as an MCP server (for Claude Code / Desktop):
> npx -y comfyui-mcp --comfyui-url https://<pod-id>-3001.proxy.runpod.net
> # panel orchestrator (drives the sidebar agent):
> COMFYUI_URL=https://<pod-id>-3001.proxy.runpod.net npx -y comfyui-mcp --panel-orchestrator
> ```
> A thin **`connect <pod-url>`** alias that wraps `--comfyui-url` /
> `--panel-orchestrator` would give the single clean command above — **flagged
> for owner confirmation** (see below). The README documents the intended UX so
> the alias and the docs land together.

If the pod sits behind auth, set `COMFYUI_AUTH_TOKEN` (+ `COMFYUI_AUTH_HEADER` /
`COMFYUI_AUTH_SCHEME`) on the local command — those are already honored by the
client for self-hosted ComfyUI behind a proxy.

---

## Owner confirmations needed

These are **draft pins** — confirm before building/publishing:

1. **Base CUDA image tag** — `nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04` is a
   plausible real tag, but confirm the exact patch (`12.8.0` vs `12.8.1`) and that
   the `-cudnn-runtime-ubuntu22.04` variant is published for it on Docker Hub.
2. **ComfyUI pin** — `COMFYUI_VERSION=v0.26.0` is a placeholder for "0.26.x".
   Pin the exact tag verified on the live pod (e.g. the specific `v0.26.x`).
3. **`comfyui_manager` version** — `4.2.2` per the recipe; confirm it's the
   version exposing `/v2/manager/queue/task` you tested against.
4. **Manager `config.ini` schema** — `start.sh` writes `[default]` /
   `security_level = normal-`. Confirm comfyui_manager 4.2.2 uses that exact INI
   section/key (the modern manager may differ from the classic node's format).
5. **`connect` subcommand** — decide whether to add a `connect <pod-url>` CLI
   alias (wrapping `--comfyui-url` / `--panel-orchestrator`) so the documented
   one-liner works verbatim, or to change the docs to the current flags.
6. **Panel branch** — the panel is cloned from the default branch (nightly HEAD).
   Confirm whether to pin a tag for reproducible images.

---

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | The image: CUDA 12.8 → Python 3.11 venv → ComfyUI 0.26 → torch cu128 → Manager v2 → Agent Panel. |
| `start.sh` | Entrypoint: writes Manager config, optional volume wiring + nginx, launches ComfyUI with all required flags. |
| `nginx.conf` | Optional `:3000 → :3001` reverse proxy (WebSocket-aware). Used only when `USE_NGINX=1`. |
| `README.md` | This document. |

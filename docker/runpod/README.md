# comfyui-mcp RunPod image — lean + network-volume persistent (DRAFT)

A **slim**, multi-stage RunPod image that boots **ready to be driven by the
[comfyui-mcp](https://github.com/artokun/comfyui-mcp) Agent Panel**. Deploy on
RunPod, run **one local command** on your laptop, and the agent drives the pod's
live ComfyUI graph from your Claude/ChatGPT subscription.

It keeps the **ComfyUI install + venv + caches on the `/workspace` network
volume**, so the slow setup happens **once** (cold boot) and every later
stop/start is **fast**.

> **Status: DRAFT for owner review.** Authored to be correct and well-documented,
> but **not** build-tested (no Docker in the authoring env). A few pins still need
> confirmation — see [Owner confirmations needed](#owner-confirmations-needed).
> The owner builds + pushes + tests next.

---

## TL;DR

1. **Build & push** the image (a machine with Docker; no GPU needed).
   See [Build & push](#build--push).
2. **Deploy** on RunPod: GPU pod (e.g. RTX 5090), **expose HTTP 3000**, attach a
   **network volume at `/workspace`**. See [Deploy on RunPod](#deploy-on-runpod).
3. On your laptop:
   ```bash
   npx -y comfyui-mcp connect https://<pod-id>-3000.proxy.runpod.net
   ```
4. Open the pod's ComfyUI, open the **Agent Panel** sidebar, enable the
   external-orchestrator toggle, hit **Connect**, and drive the graph in natural
   language.

The agent's brain (the **panel orchestrator**) runs **locally on your machine**
on your own subscription — see [Topology](#topology-where-the-agent-runs).

---

## Why this was rewritten (the lean rationale)

The previous draft was a single-stage `FROM aitrepreneur/comfyui:2.3.5`. That
image is **~63 GB**: it bakes ~13 GB of SDXL models into every pull, sits on a
CUDA **devel** base, and carries a duplicate torch. For an image whose job is to
boot ComfyUI and be driven remotely, that is enormous.

This rewrite is a **multi-stage build on a lean recent `runpod/pytorch` base**:

* The base already provides **python3.11 + torch + JupyterLab + sshd + RunPod's
  `/start.sh` startup chain** — so SSH, key injection and Jupyter come "for free"
  and stay lean.
* ComfyUI + its venv are **baked into a seed at `/opt/ComfyUI`** and **copied to
  the `/workspace` network volume on first boot**, so they persist and restart is
  fast.
* The SDXL spotcheck model is **ARG-gated** (off → a truly slim image).
* The handful of RunPod service artifacts that the lean base lacks
  (`runpod-uploader`, `croc`, the `app-manager` web app) are **COPYed out of the
  aitrepreneur image in a throwaway build stage** — they end up in the final
  image, but the 63 GB donor does **not**.

**Estimated final image size:** ~**22–26 GB** with the spotcheck model baked
(`BAKE_SPOTCHECK_MODEL=1`), ~**15–19 GB** without it (`=0`). See
[Image size & the duplicate-torch note](#image-size--the-duplicate-torch-note)
for how to shave another ~7 GB.

---

## Architecture (multi-stage)

```
ARG BASE_IMAGE = runpod/pytorch:1.0.7-cu1281-torch280-ubuntu2404   (lean, recent)
ARG RUNPOD_SRC_IMAGE = aitrepreneur/comfyui:2.3.5                  (donor only)

┌─ STAGE A: runpod-src ───────────────────────────────────────────────┐
│  FROM aitrepreneur/comfyui:2.3.5                                     │
│  (built only so the final stage can COPY service artifacts out of it)│
└─────────────────────────────────────────────────────────────────────┘
┌─ spotcheck-0 / spotcheck-1 (alpine) ─ ARG-gated SDXL model carrier ──┐
│  spotcheck-1 = ADD sd_xl_base_1.0.safetensors ; spotcheck-0 = empty  │
└─────────────────────────────────────────────────────────────────────┘
┌─ FINAL: FROM ${BASE_IMAGE} ─────────────────────────────────────────┐
│  apt: git rsync cron nodejs … ; install code-server                 │
│  git clone ComfyUI (master) -> /opt/ComfyUI  (the SEED)             │
│  python -m venv /opt/ComfyUI/venv                                    │
│    pip cu128 torch/vision/audio  (NO xformers)                      │
│    pip -r requirements.txt ; pip comfyui_manager==4.2.2           │
│    rm classic custom_nodes/ComfyUI-Manager                          │
│  git clone comfyui-mcp-panel -> /opt/ComfyUI/custom_nodes/…         │
│  COPY config.ini  (Manager remote-install gate)                     │
│  COPY --from=spotcheck-src  -> /opt/ComfyUI-seed-models             │
│  COPY --from=runpod-src  runpod-uploader, croc, /app-manager        │
│  COPY nginx.conf (:3000->:3001), starting.html, post_start.sh       │
│  (no ENTRYPOINT/CMD override — keep the base's /start.sh chain)     │
└─────────────────────────────────────────────────────────────────────┘
```

### Boot sequence (what runs, in order)

The base image's `CMD` is **`/start.sh`** (from `runpod/containers`). On boot it:

1. `service nginx start` — reads our `/etc/nginx/nginx.conf` (**:3000 → :3001**,
   websocket-aware, with the "starting" fallback page).
2. runs `/pre_start.sh` if present (we ship none).
3. `setup_ssh` — injects RunPod's `$PUBLIC_KEY` and starts sshd.
4. `start_jupyter` — starts JupyterLab on **:8888** if `$JUPYTER_PASSWORD` is set.
5. runs **our `/post_start.sh`** — persistence + caches + the remaining services
   + ComfyUI.
6. `sleep infinity` — keeps the pod alive.

So SSH + Jupyter + nginx come from the base; **our hook adds everything else**.

---

## Network-volume persistence (the key feature)

`/post_start.sh` makes ComfyUI + venv + caches live on `/workspace` (the
persistent RunPod network volume):

| Volume state | What happens | Speed |
|--------------|--------------|-------|
| **Cold** (`/workspace/ComfyUI` absent) | `rsync -a /opt/ComfyUI/ → /workspace/ComfyUI/` (incl. the venv), then copy the spotcheck model into `models/checkpoints/`. | slow (once) |
| **Warm** (`/workspace/ComfyUI` present) | **skip the seed** → fast start. Optional version-gated re-seed if the image's `SEED_VERSION` is newer than the volume's marker (see caveat). | fast |

**Caches** are redirected to the volume so pip/HF/torch/npm downloads persist:

```
HF_HOME=/workspace/.cache/huggingface   PIP_CACHE_DIR=/workspace/.cache/pip
TORCH_HOME=/workspace/.cache/torch      XDG_CACHE_HOME=/workspace/.cache
npm_config_cache=/workspace/.cache/npm
```

ComfyUI then runs **from `/workspace/ComfyUI/venv` against `/workspace/ComfyUI`**,
so `models/` (and anything you add) lives on the volume and survives stop/start.

### Why the moved venv still works

A Python venv is **relocatable as long as you invoke its `python` by absolute
path** — `python` derives `sys.prefix` from its own location, so
`/workspace/ComfyUI/venv/bin/python` finds `/workspace/ComfyUI/venv/.../site-packages`
even though the venv was created under `/opt`. The entrypoint launches ComfyUI
with that absolute path and does **not** rely on `activate` (whose `VIRTUAL_ENV`
and console-script shebangs still point at the baked seed path).

### ⚠️ Warm-volume caveat (the existing-volume gotcha)

The version-gated re-seed uses **`rsync -u`** (skip files whose destination mtime
is **newer**). So on a **pre-existing** volume an image upgrade **may not fully
propagate** — in particular the venv. Consequences:

* **Cold / fresh volume:** everything seeds correctly. ✅
* **Warm volume + image upgrade:** bump `SEED_VERSION` to trigger the re-sync, but
  `rsync -u` can still skip individual newer files. For a clean upgrade, **deploy
  onto a fresh volume**. The Manager `config.ini` is re-asserted at boot
  regardless, but a venv that didn't sync can't be fixed retroactively.

If `/post_start.sh` can't find `/workspace/ComfyUI/venv/bin/python` it logs a
clear error and holds the pod open for debugging instead of crash-looping.

---

## Services (replicating the aitrepreneur set)

| Service | Port | Source | Notes |
|---------|------|--------|-------|
| **nginx** | **3000** (→ ComfyUI 3001) | our `nginx.conf` | websocket-aware; "starting" fallback page |
| **ComfyUI** | 3001 (internal) | seed venv | `--listen 0.0.0.0 --port 3001 --enable-manager --use-pytorch-cross-attention` |
| **sshd** | 22 | base | RunPod `$PUBLIC_KEY` injection |
| **JupyterLab** | 8888 | base | set `JUPYTER_PASSWORD` |
| **code-server** | 8081 (→ 8080) | installed at build | best-effort |
| **app-manager** | 8001 (→ 8000) | COPY from donor | Node app; best-effort (needs `node`) |
| **runpod-uploader** | — | COPY from donor | file uploader; best-effort |
| **croc / rclone** | — | COPY from donor / base | on-demand transfer |
| **cron** | — | apt | best-effort |

All ancillary services are launched **best-effort** — if a binary is absent (e.g.
you dropped the donor COPYs) the entrypoint logs `skip` and carries on, so the
image still boots ComfyUI fine.

---

## ComfyUI / Manager specifics

* **cu128 torch, no xformers.** The venv gets a clean `torch torchvision
  torchaudio` from `https://download.pytorch.org/whl/cu128` (sm_120 kernels for
  Blackwell / RTX 5090). xformers is **omitted** — its prebuilt wheels lag the
  cu128 ABI — so ComfyUI launches with `--use-pytorch-cross-attention` (PyTorch
  SDPA).
* **Manager v2 (pip), gated by `--enable-manager`.** `comfyui_manager==4.2.2`
  exposes `/v2/manager/queue/task` (the API comfyui-mcp talks to). The classic
  `custom_nodes/ComfyUI-Manager` checkout **conflicts** with it and is removed.
* **Remote-install gate** (`config.ini`, synced to `/workspace/.../user/__manager/config.ini`):

  | Key | Value | Why |
  |-----|-------|-----|
  | `network_mode` | `personal_cloud` | required — the `/v2` install gate only allows remote installs in this mode |
  | `security_level` | `normal-` | safe default; set `weak` (env `COMFY_SECURITY_LEVEL=weak`) for no guardrails, trusted pods only |

---

## Topology: where the agent runs

```
  YOUR LAPTOP                                   RUNPOD POD (this image)
  ┌───────────────────────────┐                ┌───────────────────────────────────┐
  │ npx comfyui-mcp connect …  │  HTTP/WS  ───▶ │ nginx :3000 ─▶ ComfyUI :3001        │
  │  └─ panel orchestrator     │                │   ├─ Manager v2 (--enable-manager) │
  │     (Claude/Codex Agent SDK│ ◀───  events   │   └─ Agent Panel (sidebar)         │
  │      on YOUR subscription) │                │ + sshd / jupyter / code-server     │
  └───────────────────────────┘                └───────────────────────────────────┘
```

The **panel orchestrator** (the autonomous agent loop, on your Claude **or**
ChatGPT subscription — no API key) runs **on your machine**, not the pod. The pod
only serves ComfyUI + Manager + the panel UI. That's why **Node.js for the agent,
the Agent SDK and any LLM client are intentionally absent** — they'd burn pod
GPU-hours for nothing.

---

## Deploy on RunPod

Create a **Pod template** (or fill these on a one-off GPU pod):

| Template field | Value |
|----------------|-------|
| **Container image** | `<your-registry>/comfyui-mcp-runpod:<tag>` (after build & push) |
| **Container disk** | ≥ 25 GB (the layered install) |
| **Volume disk** | e.g. 100 GB+ (the ComfyUI install + venv + your models live here) |
| **Volume mount path** | **`/workspace`** |
| **Expose HTTP ports** | **`3000`** (nginx → ComfyUI). Optionally `8081` (code-server), `8001` (app-manager), `8888` (Jupyter). |
| **Expose TCP ports** | `22` (SSH) |
| **GPU** | RTX 5090 / any Blackwell or Ada card (cu128 covers both) |

**Environment variables** (Pod → Environment):

| Env | Default | Purpose |
|-----|---------|---------|
| `JUPYTER_PASSWORD` | *(unset)* | set to enable JupyterLab on :8888 (base behavior) |
| `PUBLIC_KEY` | *(RunPod injects)* | SSH public key (base behavior) |
| `SEED_VERSION` | `1` | bump to force a version-gated re-seed onto an existing volume (see caveat) |
| `COMFY_SECURITY_LEVEL` | `normal-` | Manager security level (`weak` = most permissive) |
| `COMFY_NETWORK_MODE` | `personal_cloud` | must stay `personal_cloud` for remote installs |
| `COMFY_EXTRA_ARGS` | *(empty)* | extra ComfyUI flags appended verbatim by the entrypoint |

> **First boot is slow** (cold volume seed). Watch the pod log / the "starting"
> page; later boots are fast.

---

## Build & push

No GPU is needed at **build** time. On a machine with Docker + BuildKit:

```bash
cd docker/runpod

# Default: lean base + spotcheck model baked.
docker build -t <your-registry>/comfyui-mcp-runpod:cu128 .
docker push     <your-registry>/comfyui-mcp-runpod:cu128

# Truly slim (no baked model — the 6.9 GB layer is never downloaded):
docker build --build-arg BAKE_SPOTCHECK_MODEL=0 \
  -t <your-registry>/comfyui-mcp-runpod:cu128-slim .
```

Override pins as needed:

```bash
docker build \
  --build-arg BASE_IMAGE=runpod/pytorch:1.0.7-cu1281-torch280-ubuntu2404 \
  --build-arg COMFYUI_REF=master \
  --build-arg COMFYUI_MANAGER_VERSION=4.2.2 \
  --build-arg PANEL_REF=<tag-or-branch> \
  --build-arg SEED_VERSION=2 \
  -t <your-registry>/comfyui-mcp-runpod:cu128 .
```

### The 63 GB donor pull (and how to drop it)

`STAGE A` (`runpod-src`) pulls `aitrepreneur/comfyui:2.3.5` (~63 GB) **at build
time** purely to COPY out `runpod-uploader`, `croc` and `/app-manager`. It does
**not** ship in the final image, but it is a heavy one-time pull on your build
host. If you don't need those extras, **comment out STAGE A and the three
`COPY --from=runpod-src` lines** — the entrypoint already treats them as
best-effort, and `croc` can instead be installed from its official release. This
makes the build much faster and the build host lighter.

### Image size & the duplicate-torch note

The lean base `runpod/pytorch:…-cu1281-torch280-…` **already ships a cu128
torch**. We still create an **isolated venv and install cu128 torch into it**
(the spec — guaranteed-correct, isolated, no surprise from base drift), which
means torch exists twice (~7 GB duplicated). To shave that:

* Build the venv with `python -m venv --system-site-packages /opt/ComfyUI/venv`
  and **skip the `pip install torch …` step**, so ComfyUI reuses the base's
  cu128 torch. **Verify first** that the base torch is genuinely `+cu128`
  (`python -c "import torch;print(torch.__version__, torch.version.cuda)"`) —
  some older `cu1281` tags shipped a cu-default torch. This brings the image
  toward ~15–18 GB but couples you to the base's torch.

> **DRAFT — not build-tested.** Build once locally and watch for: (a) the base's
> `/start.sh` actually invokes `/post_start.sh` (it does in `runpod/containers`,
> but confirm for your exact tag); (b) `--enable-manager` /
> `--use-pytorch-cross-attention` are accepted by the cloned ComfyUI; (c) the
> Manager `config.ini` schema for `comfyui_manager 4.2.2`; (d) the donor paths
> `/usr/local/bin/runpod-uploader`, `/usr/local/bin/croc`, `/app-manager` exist;
> (e) the moved venv runs from `/workspace`. Then deploy and verify on a **fresh**
> volume.

---

## The one-command local connect

Once the pod is up and you have its proxy URL, on your laptop:

```bash
npx -y comfyui-mcp connect https://<pod-id>-3000.proxy.runpod.net
```

This starts the comfyui-mcp panel orchestrator pointed at the pod. Then open the
pod's ComfyUI, open the **Agent Panel**, enable the **external-orchestrator**
toggle, and click **Connect**.

If you're on a build that predates the `connect` subcommand, the equivalents are:

```bash
# remote ComfyUI as an MCP server (for Claude Code / Desktop):
npx -y comfyui-mcp --comfyui-url https://<pod-id>-3000.proxy.runpod.net
# panel orchestrator (drives the sidebar agent):
COMFYUI_URL=https://<pod-id>-3000.proxy.runpod.net npx -y comfyui-mcp --panel-orchestrator
```

If the pod sits behind auth, set `COMFYUI_AUTH_TOKEN` (+ `COMFYUI_AUTH_HEADER` /
`COMFYUI_AUTH_SCHEME`) on the local command.

---

## Owner confirmations needed

Draft pins/assumptions — confirm before building/publishing:

1. **Base tag** — `runpod/pytorch:1.0.7-cu1281-torch280-ubuntu2404` (verified on
   Docker Hub 2026-06-19). Confirm it's still current / the one you want at build
   (can't pull from the authoring env).
2. **Base `/start.sh` hook** — confirm your exact base tag's `/start.sh` runs
   `/post_start.sh` and `service nginx start` reads `/etc/nginx/nginx.conf`
   (true in `runpod/containers` `main`).
3. **Donor artifact paths** — `/usr/local/bin/runpod-uploader`,
   `/usr/local/bin/croc`, `/app-manager` in `aitrepreneur/comfyui:2.3.5`.
4. **`comfyui_manager` 4.2.2** — exposes `/v2/manager/queue/task` and reads
   `user/__manager/config.ini` with `[default] network_mode / security_level`.
5. **Launch flags** — the cloned ComfyUI (master) accepts `--enable-manager`
   and `--use-pytorch-cross-attention`.
6. **nginx port convention** — kept **3000 → 3001** (matches your existing
   `connect` flow). The lean base also ships a native ComfyUI proxy block
   (`:3001 → :3000`); we override it with our self-contained `nginx.conf`.
7. **Duplicate torch** — decide whether to keep the isolated cu128 torch
   (default, ~+7 GB) or reuse the base's via `--system-site-packages` (see size
   note).
8. **Panel ref** — cloned from the default branch (nightly HEAD). Pin
   `PANEL_REF` for reproducible images?
9. **`node` for app-manager** — apt `nodejs` (Ubuntu 24.04 → v18). Confirm it
   runs the donor's `app.js`, or drop app-manager.

---

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage: lean `runpod/pytorch` final stage; `aitrepreneur` donor stage for service artifacts; ARG-gated SDXL spotcheck stage. Bakes ComfyUI + cu128 venv + Manager v2 + Agent Panel into `/opt/ComfyUI`. |
| `post_start.sh` | Boot hook (installed as `/post_start.sh`): network-volume seed, cache redirection, Manager gate, ancillary services, ComfyUI launch. |
| `nginx.conf` | Self-contained reverse proxy (`:3000 → :3001`, websocket-aware, "starting" fallback) + code-server / app-manager fronts. Installed over the base's. |
| `starting.html` | The auto-refreshing "ComfyUI is starting…" page nginx serves until upstreams are up. |
| `config.ini` | Manager v2 seed (`network_mode = personal_cloud`, `security_level = normal-`). |
| `README.md` | This document. |

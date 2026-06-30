# comfyui-mcp RunPod image (DRAFT)

A thin layer on top of the **official RunPod ComfyUI template the owner already
runs — [`aitrepreneur/comfyui`](https://hub.docker.com/r/aitrepreneur/comfyui)**
— that boots **ready to be driven by the
[comfyui-mcp](https://github.com/artokun/comfyui-mcp) Agent Panel**. Deploy on
RunPod, run **one local command** on your laptop, and the agent drives the pod's
live ComfyUI graph from your Claude/ChatGPT subscription.

> **Status: DRAFT for owner review.** These files are authored to be correct and
> well-documented against the *real* template architecture, but the image has
> **not** been built or pushed (no Docker in the authoring env). A few pins still
> need confirmation — see [Owner confirmations needed](#owner-confirmations-needed).

---

## TL;DR

1. **Build & push** the image (one machine with Docker — no GPU needed). See
   [Build & push](#build--push-the-image-ownermaintainer).
2. **Deploy** it on RunPod (GPU pod, e.g. RTX 5090). Expose HTTP **3000** and
   attach a volume at **`/workspace`** (fields below).
3. On your laptop:
   ```bash
   npx -y comfyui-mcp connect https://<pod-id>-3000.proxy.runpod.net
   ```
4. Open the pod's ComfyUI in the browser, open the **Agent Panel** sidebar,
   enable the external-orchestrator toggle, hit **Connect**, and start driving
   the graph in natural language.

The agent's brain (the **panel orchestrator**) runs **locally on your machine**
on your own subscription — see [Topology](#topology-where-the-agent-actually-runs).

---

## Why base on `aitrepreneur/comfyui` (and not raw `nvidia/cuda`)

The first draft of this image built from raw `nvidia/cuda`. That was wrong: a
raw CUDA base lacks **all** the RunPod plumbing. `aitrepreneur/comfyui:2.3.5` is
the **proven** template the owner actually runs, and it already provides:

* **sshd + RunPod public-key injection** (so RunPod's "Connect → SSH" works)
* **nginx** reverse proxy (**:3000 → ComfyUI :3001**) — WebSocket-aware
* **jupyter lab**, **code-server**, **runpodctl**
* **CUDA 12.1** userspace + a **baked ComfyUI install on a Python venv**

> **GPU exposure is provided by RunPod's HOST nvidia container runtime** and works
> on *any* CUDA base — so we do **not** need a cu128 *base* image. We only need
> cu128 *PyTorch wheels* in the venv for Blackwell / RTX 5090 (sm_120), which we
> install on top. This is the proven setup from the live RTX 5090 pod.

### Template architecture we build on (verified on the live pod)

| Aspect | Reality |
|--------|---------|
| **Baked install** | ComfyUI + a Python venv live at **`/ComfyUI`** (incl. `/ComfyUI/venv`). |
| **Boot sync** | `/start.sh` → `/pre_start.sh` **syncs `/ComfyUI` → `/workspace/ComfyUI`** (`rsync -rlptDu` on overlay/xfs, tar-pipe on fuse), version-gated by `/workspace/ComfyUI/template.json` vs `$TEMPLATE_VERSION`. |
| **Runtime ComfyUI** | **`/workspace/ComfyUI`** (the persistent volume), seeded from the baked `/ComfyUI`. |
| **Launch leaf** | `/start_comfyui.sh`: `ARGS=("$@" --listen 0.0.0.0 --port 3001)` then `cd /workspace/ComfyUI && source venv/bin/activate && python3 main.py "${ARGS[@]}"`. The stock base passes **no** `--enable-manager` / `--use-pytorch-cross-attention`. |

We layer our changes on top **without** replacing the RunPod entrypoint chain —
`/start.sh` → `/pre_start.sh` still run for sshd/nginx/jupyter/sync.

---

## What this layer adds (all hand-verified on the live RTX 5090 pod)

| # | Change | How |
|---|--------|-----|
| 1 | **cu128 PyTorch** in the baked venv (Blackwell / sm_120) | `"/ComfyUI/venv/bin/pip" install --upgrade torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128`. xformers uninstalled/omitted (ABI) → rely on `--use-pytorch-cross-attention`. |
| 2 | **ComfyUI 0.26 requirements** satisfied in the venv | `"/ComfyUI/venv/bin/pip" install -r /ComfyUI/requirements.txt` (sqlalchemy, alembic, comfy-aimdo, comfy-kitchen, blake3, comfy-angle, av, …). Installed **after** torch so torch isn't downgraded. |
| 3 | **Manager v2** (pip) | `"/ComfyUI/venv/bin/pip" install comfyui_manager==4.2.2`; the conflicting classic `custom_nodes/ComfyUI-Manager` checkout is removed. |
| 4 | **Agent Panel** custom node | `comfyui-mcp-panel` cloned into `/ComfyUI/custom_nodes/comfyui-mcp-panel`. |
| 5 | **Launch flags** | `start_comfyui.sh` **shim** appends `--enable-manager --use-pytorch-cross-attention` to the base's `--listen 0.0.0.0 --port 3001`. |
| 6 | **Manager config seed** | `/ComfyUI/user/__manager/config.ini` with `network_mode = personal_cloud` + `security_level = normal-` (required for remote installs). |
| 7 | **`TEMPLATE_VERSION` bump** | Raised to `2.4.0` (> base `2.3.5`) so `pre_start.sh` re-syncs our baked changes onto fresh volumes. |

**Deliberately NOT added:** Node.js, the Claude/Codex Agent SDK, or any LLM
client. See [Topology](#topology-where-the-agent-actually-runs).

The old `nginx.conf` from the first draft was **removed** — the base already
provides nginx (:3000 → :3001), so shipping our own would only risk clobbering
the base's working config.

---

## Why cu128 (the RTX 5090 rationale)

Blackwell GPUs (RTX 5090, compute capability **sm_120**) are **not** supported by
the default PyTorch cu121 wheels — you get `no kernel image is available for
execution on the device` at first inference. The fix, verified on a live RTX 5090
pod, is **cu128 PyTorch in the venv** (the base's CUDA 12.1 *userspace* is
irrelevant — the kernels live in the torch wheel and the driver comes from the
RunPod host):

```bash
/ComfyUI/venv/bin/pip install --upgrade torch torchvision torchaudio \
  --index-url https://download.pytorch.org/whl/cu128
```

**xformers is omitted** — its prebuilt wheels lag the cu128 ABI — so we launch
ComfyUI with `--use-pytorch-cross-attention` (PyTorch SDPA), which needs no extra
build and is fully sm_120-compatible.

---

## The `--enable-manager` requirement

ComfyUI's modern **pip Manager** (`comfyui_manager`) exposes
`/v2/manager/queue/task` — the API comfyui-mcp talks to. Two non-obvious rules,
both baked in here:

1. **Do NOT** also keep the classic `custom_nodes/ComfyUI-Manager` checkout — the
   legacy node and the pip Manager **conflict**. This image installs **only** the
   pip Manager and removes the classic checkout if the base shipped one.
2. The pip Manager is **gated behind `--enable-manager`**. Without that flag the
   `/v2/manager/...` endpoints don't exist and the agent can't install
   nodes/models. The `start_comfyui.sh` shim always passes it.

### Manager remote-install gate (`config.ini`)

`/ComfyUI/user/__manager/config.ini` (synced to `/workspace/ComfyUI/...`):

| Key | Value | Why |
|-----|-------|-----|
| `network_mode` | `personal_cloud` | **Required** — the `/v2` install-model security gate only permits remote installs in `personal_cloud` mode (verified). |
| `security_level` | `normal-` (default) | Safe default — lets the panel queue node/model installs while blocking the riskiest ops. |
| `security_level` | `weak` | **Most permissive** (no install guardrails). Only on a pod you fully trust/control. Set `COMFY_SECURITY_LEVEL=weak`. |

---

## Topology: where the agent actually runs

This image is built for the **"agent runs locally"** model:

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
ChatGPT subscription — no API key) runs **on your machine**, not on the pod. The
pod only serves ComfyUI + Manager + the panel UI. That's why **Node.js, the
Agent SDK, and any LLM client are intentionally absent** from the image — they'd
be dead weight and would burn pod GPU-hours for nothing. This pairs with the
panel's **external-orchestrator toggle** (PR #99) and the `connect` CLI (PR #44).

---

## Networking / ports

The base runs **nginx on :3000** proxying to **ComfyUI on :3001** (WebSocket-aware).
Publish **3000** as the template's HTTP port; RunPod then gives you
`https://<pod-id>-3000.proxy.runpod.net`. ComfyUI itself stays internal on 3001.

You do **not** need to ship an nginx.conf — the base provides it.

---

## Deploy on RunPod

Create a **Pod template** (or fill these on a one-off GPU pod):

| Template field | Value |
|----------------|-------|
| **Container image** | `<your-registry>/comfyui-mcp-runpod:<tag>` (after build & push) |
| **Container disk** | ≥ 20 GB (the layered install) |
| **Volume disk** | e.g. 100 GB+ (models/outputs) |
| **Volume mount path** | **`/workspace`** (the base's runtime ComfyUI lives here) |
| **Expose HTTP ports** | **`3000`** (nginx → ComfyUI) |
| **Expose TCP ports** | `22` (optional, for SSH — the base runs sshd) |
| **GPU** | RTX 5090 / any Blackwell or Ada card (cu128 covers both) |

**Optional env** (Pod → Environment):

| Env | Default | Purpose |
|-----|---------|---------|
| `TEMPLATE_VERSION` | `2.4.0` | Must exceed the base's `2.3.5` so `pre_start.sh` re-syncs the baked changes. Bump again if you rebuild with new baked changes and want existing volumes to re-sync. |
| `COMFY_SECURITY_LEVEL` | `normal-` | Manager security level (`weak` = most permissive). |
| `COMFY_NETWORK_MODE` | `personal_cloud` | Manager network mode — must stay `personal_cloud` for remote installs. |
| `COMFY_EXTRA_ARGS` | *(empty)* | Extra ComfyUI flags appended verbatim by the shim. |

> **Persistence:** the base keeps the runtime ComfyUI on the `/workspace` volume,
> so models/outputs/custom nodes survive stop/start **and** pod re-create. The
> baked venv/Manager/panel changes reach a volume via `pre_start.sh`'s
> version-gated sync — see the caveat below.

### ⚠️ Critical caveat: the sync only reaches FRESH volumes

Our changes are baked into `/ComfyUI` (incl. `/ComfyUI/venv`). They reach the
**runtime** `/workspace/ComfyUI` **only** through `pre_start.sh`'s sync, and that
sync uses `rsync -u` (skip files whose destination is **newer**). Consequences:

* **Fresh volume (or first boot):** sync copies everything → our cu128 torch,
  0.26 requirements, Manager v2, panel and config land correctly. ✅
* **Pre-existing `/workspace` volume:** files already present with a newer mtime
  are **skipped** by `rsync -u`, so our changes **may NOT propagate**. The
  version gate (`TEMPLATE_VERSION` > `template.json`) is what triggers the
  re-sync attempt — but `rsync -u` can still skip individual newer files even
  then.

**Recommendation:** deploy onto a **fresh volume**, or bump `TEMPLATE_VERSION`
and confirm the re-sync actually replaced `venv`/`custom_nodes`. If a pre-existing
volume misbehaves, the surest fix is a new volume. The `start_comfyui.sh` shim
defensively re-asserts the Manager `config.ini` at boot, but it cannot
retroactively fix a venv that didn't sync.

### Build & push the image (owner/maintainer)

No GPU or CUDA is needed at **build** time. On a machine with Docker:

```bash
cd docker/runpod
docker build -t <your-registry>/comfyui-mcp-runpod:2.4.0-cu128 .
docker push  <your-registry>/comfyui-mcp-runpod:2.4.0-cu128
```

Override any pin at build time, e.g.:

```bash
docker build \
  --build-arg BASE_IMAGE=aitrepreneur/comfyui:2.3.5 \
  --build-arg COMFYUI_MANAGER_VERSION=4.2.2 \
  --build-arg TEMPLATE_VERSION=2.4.0 \
  -t <your-registry>/comfyui-mcp-runpod:2.4.0-cu128 .
```

> **DRAFT — not build-tested.** There is no Docker in the authoring environment,
> so this image has **not** been built. Build it once locally, watch for: (a) the
> base's actual ComfyUI path (`/ComfyUI`) and venv path (`/ComfyUI/venv`),
> (b) whether the base ships a classic `ComfyUI-Manager` to remove, (c) the
> Manager `config.ini` schema (section/keys) for `comfyui_manager 4.2.2`, and
> (d) that `--enable-manager` / `--use-pytorch-cross-attention` are accepted by
> the baked ComfyUI version. Then deploy and verify on a fresh volume.

---

## The one-command local connect

Once the pod is up and you have its proxy URL, on your laptop:

```bash
npx -y comfyui-mcp connect https://<pod-id>-3000.proxy.runpod.net
```

This starts the comfyui-mcp panel orchestrator pointed at the pod. Then open the
pod's ComfyUI, open the **Agent Panel**, enable the **external-orchestrator**
toggle, and click **Connect**.

> **`connect` subcommand:** introduced by **PR #44** (panel-connect CLI), pairing
> with the panel's external-orchestrator mode (**PR #99**). If you're on a build
> that predates it, the equivalents are:
> ```bash
> # remote ComfyUI as an MCP server (for Claude Code / Desktop):
> npx -y comfyui-mcp --comfyui-url https://<pod-id>-3000.proxy.runpod.net
> # panel orchestrator (drives the sidebar agent):
> COMFYUI_URL=https://<pod-id>-3000.proxy.runpod.net npx -y comfyui-mcp --panel-orchestrator
> ```

If the pod sits behind auth, set `COMFYUI_AUTH_TOKEN` (+ `COMFYUI_AUTH_HEADER` /
`COMFYUI_AUTH_SCHEME`) on the local command — already honored by the client for
self-hosted ComfyUI behind a proxy.

---

## Owner confirmations needed

These are **draft pins/assumptions** — confirm before building/publishing:

1. **Base image tag** — `aitrepreneur/comfyui:2.3.5`. Confirm it's the exact tag
   the live pod runs and that it's published on Docker Hub.
2. **Baked paths** — `/ComfyUI` and `/ComfyUI/venv`. Confirm these match the
   2.3.5 base (the Dockerfile uses `COMFY_HOME=/ComfyUI`).
3. **`comfyui_manager` version** — `4.2.2`. Confirm it exposes
   `/v2/manager/queue/task` and reads `user/__manager/config.ini`.
4. **Manager `config.ini` schema** — we write `[default]` / `network_mode` /
   `security_level`. Confirm the exact section + key names for `comfyui_manager
   4.2.2` (the modern Manager may differ from the classic node's INI).
5. **Classic Manager removal** — confirm whether the base ships
   `custom_nodes/ComfyUI-Manager` (we `rm -rf` it defensively).
6. **`TEMPLATE_VERSION` comparison** — we set `2.4.0` (> `2.3.5`). Confirm
   `pre_start.sh`'s comparison treats `2.4.0` as newer and forces the re-sync.
7. **`/start_comfyui.sh` is the override point** — confirm the base invokes
   `/start_comfyui.sh "$@"` (so our shim's `("$@" --listen … --port … + flags)`
   is correct) and that nothing else also adds `--listen/--port` (double flags).
8. **Launch flags accepted** — confirm the baked ComfyUI build accepts
   `--enable-manager` and `--use-pytorch-cross-attention`.
9. **Panel branch** — cloned from default branch (nightly HEAD). Pin a tag for
   reproducible images?
10. **`connect` CLI** — depends on PR #44 / #99 landing for the documented
    one-liner; otherwise use the `--comfyui-url` / `--panel-orchestrator` flags.

---

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | `FROM aitrepreneur/comfyui:2.3.5`; bakes cu128 torch + 0.26 reqs + Manager v2 + Agent Panel + config seed into the venv, shims the launch leaf, bumps `TEMPLATE_VERSION`. Keeps the base entrypoint chain. |
| `start_comfyui.sh` | Launch-leaf **shim**: appends `--enable-manager --use-pytorch-cross-attention` to the base's `--listen 0.0.0.0 --port 3001`; defensively re-asserts the Manager `config.ini`. |
| `config.ini` | Manager v2 seed (`network_mode = personal_cloud`, `security_level = normal-`). |
| `README.md` | This document. |

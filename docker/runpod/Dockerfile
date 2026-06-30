# syntax=docker/dockerfile:1
#
# comfyui-mcp RunPod image — LEAN, network-volume-persistent.
# =============================================================================
# Rewritten FROM SCRATCH (was: a single-stage FROM aitrepreneur/comfyui:2.3.5,
# which was 63 GB — it baked ~13 GB of SDXL models, a CUDA *devel* base, and a
# duplicate torch). This image is a SLIM multi-stage build on a recent, lean
# runpod/pytorch base and keeps the ComfyUI install + venv + caches on the
# /workspace NETWORK VOLUME so stop/start is FAST.
#
# TOPOLOGY (why the image is lean): the panel ORCHESTRATOR (the autonomous agent
# loop — Claude/Codex Agent SDK, on YOUR subscription) runs on the USER's laptop,
# NOT on the pod. The pod only serves ComfyUI + Manager + the panel UI. So
# Node.js for the agent, the Agent SDK and any LLM client are deliberately ABSENT.
# See ./README.md.
#
# DRAFT — NOT build-tested (no Docker in the authoring env). The owner builds +
# pushes + tests. Pins that must be confirmed at build are flagged in README.md.
# =============================================================================

# ---- Global ARGs (used in FROM lines; must precede the first FROM) -----------
# FINAL base. A recent runpod/pytorch with CUDA 12.8 (cu128 → Blackwell/RTX 5090
# sm_120) + python3.11 + torch + JupyterLab + sshd + RunPod's /start.sh chain.
# CONFIRM THE EXACT TAG AT BUILD (can't pull here). Verified to exist on Docker
# Hub 2026-06-19: runpod/pytorch:1.0.7-cu1281-torch280-ubuntu2404.
ARG BASE_IMAGE=runpod/pytorch:1.0.7-cu1281-torch280-ubuntu2404
# STAGE A "service donor": the proven aitrepreneur template. We pull it ONLY to
# COPY a few RunPod service artifacts OUT of it (it never ships in the final
# image). NOTE: this is a ~63 GB build-time pull — see README "Build" for how to
# drop it for a faster/leaner build.
ARG RUNPOD_SRC_IMAGE=aitrepreneur/comfyui:2.3.5
# Bake the SDXL base checkpoint (~6.9 GB) for a GPU spotcheck. Set to 0 for a
# truly slim image (the model layer is then never downloaded — see gate below).
ARG BAKE_SPOTCHECK_MODEL=1

# =============================================================================
# STAGE A — runpod-src: donor for RunPod service binaries/apps not in the lean
# base. Nothing is built here; the final stage does COPY --from=runpod-src.
# =============================================================================
FROM ${RUNPOD_SRC_IMAGE} AS runpod-src

# =============================================================================
# Spotcheck-model carrier stages — ARG-gated so the 6.9 GB download is SKIPPED
# entirely when BAKE_SPOTCHECK_MODEL=0 (BuildKit only builds the stage the final
# target depends on). alpine is a ~5 MB carrier; ADD <url> is fetched by the
# BuildKit frontend (no tools needed in the image).
# =============================================================================
FROM alpine:3 AS spotcheck-0
RUN mkdir -p /seed-models

FROM alpine:3 AS spotcheck-1
RUN mkdir -p /seed-models
# Only the SDXL base checkpoint, for a one-shot GPU smoke test. NO other models.
ADD https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors \
    /seed-models/sd_xl_base_1.0.safetensors

# Selector: spotcheck-src = spotcheck-0 (empty) or spotcheck-1 (with model).
FROM spotcheck-${BAKE_SPOTCHECK_MODEL} AS spotcheck-src

# =============================================================================
# FINAL STAGE — the lean runpod/pytorch base. Inherits its /start.sh CMD, which
# brings up nginx + sshd (RunPod PUBLIC_KEY injection) + JupyterLab, then runs
# /pre_start.sh and /post_start.sh. We add /post_start.sh as our boot hook.
# =============================================================================
FROM ${BASE_IMAGE} AS final

# ---- Build-time pins (override with --build-arg; confirm in README) ----------
# ComfyUI ref to bake. master = latest (must be >= 0.26 for --enable-manager +
# comfyui_manager v2). Pin a tag/commit for reproducible images.
ARG COMFYUI_REF=master
# pip Manager v2 — exposes /v2/manager/queue/task (the API comfyui-mcp targets).
ARG COMFYUI_MANAGER_VERSION=4.2.2
ARG PANEL_REPO=https://github.com/artokun/comfyui-mcp-panel.git
# Optional panel tag/branch for reproducible images (empty = default branch).
ARG PANEL_REF=
# cu128 PyTorch wheels (sm_120 kernels). The fresh venv gets a clean cu128 torch
# regardless of what the base ships (no cu121 leftovers). See README for the
# leaner "reuse the base's cu128 torch" alternative.
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu128
# Baked SEED paths (NOT on the volume). The entrypoint copies SEED_HOME ->
# /workspace/ComfyUI on first boot.
ARG SEED_HOME=/opt/ComfyUI
ARG SEED_MODELS=/opt/ComfyUI-seed-models
# Bump to force a version-gated re-seed onto EXISTING volumes (see README caveat).
ARG SEED_VERSION=1
# Manager remote-install gate (required for the agent to install models/nodes).
ARG COMFY_NETWORK_MODE=personal_cloud
ARG COMFY_SECURITY_LEVEL=normal-

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    SEED_HOME=${SEED_HOME} \
    SEED_MODELS=${SEED_MODELS} \
    SEED_VERSION=${SEED_VERSION} \
    COMFY_NETWORK_MODE=${COMFY_NETWORK_MODE} \
    COMFY_SECURITY_LEVEL=${COMFY_SECURITY_LEVEL}

# -----------------------------------------------------------------------------
# 0. OS deps the lean base may not ship.
#    rsync  — first-boot seed of SEED_HOME -> /workspace/ComfyUI
#    cron   — replicate the aitrepreneur service set
#    nodejs — runtime for the copied /app-manager Node app (:8000)
#    git/curl/ca-certificates — clone + code-server install (base usually has git)
# -----------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
      git rsync cron ca-certificates curl nodejs \
 && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# 1. code-server (browser VS Code). The lean runpod/pytorch base does not ship
#    it; install the standalone build. Best-effort — a failure here must not
#    break the image (code-server is a convenience, not required by the panel).
# -----------------------------------------------------------------------------
RUN curl -fsSL https://code-server.dev/install.sh | sh \
 || echo "WARN: code-server install failed — it will be skipped at boot"

# -----------------------------------------------------------------------------
# 2. Clone the ComfyUI SEED (baked at ${SEED_HOME}; copied to the volume at boot)
# -----------------------------------------------------------------------------
RUN git clone https://github.com/comfyanonymous/ComfyUI.git "${SEED_HOME}" \
 && cd "${SEED_HOME}" \
 && git checkout "${COMFYUI_REF}" \
 && git --no-pager log -1 --format='ComfyUI seed at %h %ci'

# -----------------------------------------------------------------------------
# 3. Dedicated venv + cu128 torch + ComfyUI requirements + Manager v2
#    The venv is created at ${SEED_HOME}/venv and copied to
#    /workspace/ComfyUI/venv on first boot. A venv is relocatable as long as it
#    is invoked by absolute path (its python derives sys.prefix from its own
#    location), which the entrypoint does — see post_start.sh.
# -----------------------------------------------------------------------------
ENV VENV=${SEED_HOME}/venv
ENV VPIP=${VENV}/bin/pip
ENV VPY=${VENV}/bin/python
RUN python3 -m venv "${VENV}" \
 && "${VPY}" -m pip install --no-cache-dir --upgrade pip wheel

# cu128 torch FIRST so the requirements resolver below can't pull a cu-default
# torch and downgrade it. xformers is intentionally NOT installed — launch uses
# --use-pytorch-cross-attention (PyTorch SDPA); its prebuilt wheels lag the
# cu128 ABI.
RUN "${VPIP}" install --no-cache-dir \
      torch torchvision torchaudio --index-url "${TORCH_INDEX_URL}"

# ComfyUI runtime requirements (cu128 index passed as a safety net so nothing
# re-resolves torch off PyPI).
RUN "${VPIP}" install --no-cache-dir --extra-index-url "${TORCH_INDEX_URL}" \
      -r "${SEED_HOME}/requirements.txt"

# Manager v2 (pip). Remove any classic custom_nodes/ComfyUI-Manager checkout —
# it CONFLICTS with the pip Manager that --enable-manager turns on.
RUN "${VPIP}" install --no-cache-dir "comfyui_manager==${COMFYUI_MANAGER_VERSION}" \
 && rm -rf "${SEED_HOME}/custom_nodes/ComfyUI-Manager" \
           "${SEED_HOME}/custom_nodes/comfyui-manager"

# -----------------------------------------------------------------------------
# 4. comfyui-mcp Agent Panel custom node (registry id: comfyui-agent-panel)
# -----------------------------------------------------------------------------
RUN git clone --depth 1 ${PANEL_REF:+--branch "${PANEL_REF}"} \
      "${PANEL_REPO}" "${SEED_HOME}/custom_nodes/comfyui-mcp-panel" \
 && if [ -f "${SEED_HOME}/custom_nodes/comfyui-mcp-panel/requirements.txt" ]; then \
      "${VPIP}" install --no-cache-dir --extra-index-url "${TORCH_INDEX_URL}" \
        -r "${SEED_HOME}/custom_nodes/comfyui-mcp-panel/requirements.txt"; \
    fi

# -----------------------------------------------------------------------------
# 5. Manager config seed (remote-install gate). Baked into the seed tree; the
#    entrypoint re-asserts it on the volume (rsync -u can skip it on a warm vol).
# -----------------------------------------------------------------------------
COPY config.ini ${SEED_HOME}/user/__manager/config.ini

# Seed version marker (the entrypoint compares it to the volume's marker).
RUN echo "${SEED_VERSION}" > "${SEED_HOME}/.seed_version"

# -----------------------------------------------------------------------------
# 6. Spotcheck model (ARG-gated — empty dir when BAKE_SPOTCHECK_MODEL=0).
#    The entrypoint copies any *.safetensors here into the volume's
#    models/checkpoints on first boot.
# -----------------------------------------------------------------------------
COPY --from=spotcheck-src /seed-models/ ${SEED_MODELS}/

# -----------------------------------------------------------------------------
# 7. RunPod service artifacts copied OUT of the donor image (not in the lean
#    base). These let us replicate the aitrepreneur service set without
#    reinstalling them: a file uploader, croc (P2P transfer) and the app-manager
#    web app (:8000). The entrypoint launches them best-effort (skipped if
#    absent), so removing these COPYs for a leaner build is safe.
# -----------------------------------------------------------------------------
COPY --from=runpod-src /usr/local/bin/runpod-uploader /usr/local/bin/runpod-uploader
COPY --from=runpod-src /usr/local/bin/croc            /usr/local/bin/croc
COPY --from=runpod-src /app-manager                   /app-manager

# -----------------------------------------------------------------------------
# 8. nginx (public HTTP :3000 -> ComfyUI :3001, websocket-aware, "starting"
#    fallback) + the entrypoint hook. We ship a SELF-CONTAINED nginx.conf rather
#    than copying the donor's (no snippet/include dependencies → robust on any
#    base). The base's /start.sh runs `service nginx start` reading this file,
#    then runs /post_start.sh.
# -----------------------------------------------------------------------------
COPY nginx.conf      /etc/nginx/nginx.conf
COPY starting.html   /usr/share/nginx/html/readme.html
COPY post_start.sh   /post_start.sh
RUN chmod +x /post_start.sh

# We deliberately do NOT set ENTRYPOINT/CMD: the base's /start.sh chain is kept
# (nginx + sshd + JupyterLab + RunPod key injection), and it invokes our
# /post_start.sh hook.

# Documentation only (RunPod exposes ports you configure on the template):
#   3000  ComfyUI via nginx (the panel/connect target)
#   8888  JupyterLab (base; set JUPYTER_PASSWORD)
#   8081  code-server (via nginx -> :8080)
#   8001  app-manager (via nginx -> :8000)
#   22    SSH (base; RunPod PUBLIC_KEY)
EXPOSE 3000 8888 8081 8001 22

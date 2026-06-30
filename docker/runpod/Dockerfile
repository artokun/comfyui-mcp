# syntax=docker/dockerfile:1
#
# comfyui-mcp RunPod image — PERSISTENT-ON-VOLUME, auto-updating software.
# =============================================================================
# DESIGN: the ComfyUI install + its venv + Manager v2 + the Agent Panel + all
# custom_nodes LIVE ON THE NETWORK VOLUME at /workspace/ComfyUI and are RUN FROM
# THERE. The image ships a pristine SEED of that tree at /opt/ComfyUI-seed.
#
#   * FIRST boot (empty volume): the seed is copied to /workspace/ComfyUI (slow,
#     one-time — a multi-GB rsync to the network drive).
#   * EVERY boot after: NO copy. We `git pull --ff-only` ComfyUI + the panel and
#     re-`pip install` ONLY if a requirements file changed (sha-marker), then
#     launch from the volume venv (~20-40s ComfyUI init).
#
# WHY ON THE VOLUME (not baked-immutable): so that custom nodes the agent /
# Manager install at runtime — AND their pip dependencies (which land in the
# venv) — SURVIVE a stop/start. A baked-in-image venv would lose those deps on
# restart, leaving installed nodes present-but-broken. Persisting the venv is the
# price of persisting working custom nodes; it also lets ComfyUI/Manager/panel
# auto-update in place.
#
# The /workspace NETWORK VOLUME holds EVERYTHING durable:
#     /workspace/ComfyUI   the app + venv + custom_nodes (git; auto-updated)
#     /workspace/user      workflows + ComfyUI settings + Manager config
#     /workspace/models    all model categories (Manager downloads land here)
#     /workspace/input     input images
#     /workspace/output    generated images
#
# TOPOLOGY (why the image is lean): the panel ORCHESTRATOR (the autonomous agent
# loop — Claude/Codex Agent SDK, on YOUR subscription) runs on the USER's laptop,
# NOT on the pod. The pod only serves ComfyUI + Manager + the panel UI. So
# Node.js for the agent, the Agent SDK and any LLM client are deliberately ABSENT.
# See ./README.md.
#
# RELOCATABLE VENV: the seed venv is built at /opt/ComfyUI-seed/venv but RUN from
# /workspace/ComfyUI/venv after the first-boot copy. We ALWAYS invoke it by
# absolute path (`$VENV/bin/python`) and use `python -m pip` (never the `pip`
# console-script, whose shebang is path-pinned), so the interpreter self-locates
# its site-packages from its own path regardless of where it was built.
# =============================================================================

# ---- Global ARGs (used in FROM lines; must precede the first FROM) -----------
# FINAL base. A recent runpod/pytorch with CUDA 12.8 (cu128 → Blackwell/RTX 5090
# sm_120) + python3.11 + torch + JupyterLab + sshd + RunPod's /start.sh chain.
# Verified to exist on Docker Hub 2026-06-19: runpod/pytorch:1.0.7-cu1281-torch280-ubuntu2404.
ARG BASE_IMAGE=runpod/pytorch:1.0.7-cu1281-torch280-ubuntu2404
# STAGE A "service donor": the proven aitrepreneur template. We pull it ONLY to
# COPY a few RunPod service artifacts OUT of it (it never ships in the final
# image). NOTE: this is a ~63 GB build-time pull — see README "Build" for how to
# drop it for a faster/leaner build.
ARG RUNPOD_SRC_IMAGE=aitrepreneur/comfyui:2.3.5
# Bake the SDXL base checkpoint (~6.9 GB) for a GPU spotcheck. Set to 0 to omit
# the baked copy entirely (the model layer is then never downloaded).
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
# ComfyUI ref to SEED. master = latest (must be recent enough for: --enable-manager
# + comfyui_manager v2, AND the per-dir launch flags --user-directory /
# --input-directory / --output-directory, AND extra_model_paths `is_default`).
# Pin a tag/commit for reproducible images. (Runtime `git pull` tracks this ref.)
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
# SEED path (IMAGE): the pristine ComfyUI tree baked into the image. Copied to
# the volume on first boot; never run from directly.
ARG SEED_HOME=/opt/ComfyUI-seed
# RUNTIME path (VOLUME): where ComfyUI actually lives + runs after first boot.
ARG COMFY_HOME=/workspace/ComfyUI
# Baked spotcheck-model dir (NOT under the ComfyUI seed — copied to
# /workspace/models/checkpoints, a separate volume location).
ARG SEED_MODELS=/opt/ComfyUI-seed-models
# Manager remote-install gate (required for the agent to install models/nodes).
ARG COMFY_NETWORK_MODE=personal_cloud
ARG COMFY_SECURITY_LEVEL=normal-

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    SEED_HOME=${SEED_HOME} \
    COMFY_HOME=${COMFY_HOME} \
    SEED_MODELS=${SEED_MODELS} \
    COMFY_NETWORK_MODE=${COMFY_NETWORK_MODE} \
    COMFY_SECURITY_LEVEL=${COMFY_SECURITY_LEVEL}

# -----------------------------------------------------------------------------
# 0. OS deps the lean base may not ship.
#    cron   — replicate the aitrepreneur service set
#    nodejs — runtime for the copied /app-manager Node app (:8000)
#    rsync  — first-boot seed copy + idempotent resume of an interrupted copy
#    git/curl/ca-certificates — clone/pull + code-server install
# -----------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
      git cron rsync ca-certificates curl nodejs \
 && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# 1. code-server (browser VS Code). The lean runpod/pytorch base does not ship
#    it; install the standalone build. Best-effort — a failure here must not
#    break the image (code-server is a convenience, not required by the panel).
# -----------------------------------------------------------------------------
RUN curl -fsSL https://code-server.dev/install.sh | sh \
 || echo "WARN: code-server install failed — it will be skipped at boot"

# -----------------------------------------------------------------------------
# 2. SEED ComfyUI at the IMAGE path ${SEED_HOME} (a git checkout — runtime pulls
#    from it). Copied to ${COMFY_HOME} on the volume at first boot.
# -----------------------------------------------------------------------------
RUN git clone https://github.com/comfyanonymous/ComfyUI.git "${SEED_HOME}" \
 && cd "${SEED_HOME}" \
 && git checkout "${COMFYUI_REF}" \
 && git --no-pager log -1 --format='ComfyUI seeded at %h %ci'

# -----------------------------------------------------------------------------
# 3. Dedicated venv + cu128 torch + ComfyUI requirements + Manager v2.
#    Built at ${SEED_HOME}/venv; RUN from ${COMFY_HOME}/venv after the first-boot
#    copy. Always invoked by ABSOLUTE PATH + `python -m pip` so it self-locates
#    after relocation (see header "RELOCATABLE VENV"). --copies (no symlinks into
#    the venv's own tree) keeps it self-contained when rsync'd to the volume.
# -----------------------------------------------------------------------------
ENV VENV=${SEED_HOME}/venv
ENV VPIP="${VENV}/bin/python -m pip"
ENV VPY=${VENV}/bin/python
RUN python3 -m venv --copies "${VENV}" \
 && ${VPY} -m pip install --no-cache-dir --upgrade pip wheel

# cu128 torch FIRST so the requirements resolver below can't pull a cu-default
# torch and downgrade it. xformers is intentionally NOT installed — launch uses
# --use-pytorch-cross-attention (PyTorch SDPA); its prebuilt wheels lag the
# cu128 ABI.
RUN ${VPIP} install --no-cache-dir \
      torch torchvision torchaudio --index-url "${TORCH_INDEX_URL}"

# ComfyUI runtime requirements (cu128 index passed as a safety net so nothing
# re-resolves torch off PyPI).
RUN ${VPIP} install --no-cache-dir --extra-index-url "${TORCH_INDEX_URL}" \
      -r "${SEED_HOME}/requirements.txt"

# Manager v2 (pip). Remove any classic custom_nodes/ComfyUI-Manager checkout —
# it CONFLICTS with the pip Manager that --enable-manager turns on.
RUN ${VPIP} install --no-cache-dir "comfyui_manager==${COMFYUI_MANAGER_VERSION}" \
 && rm -rf "${SEED_HOME}/custom_nodes/ComfyUI-Manager" \
           "${SEED_HOME}/custom_nodes/comfyui-manager"

# -----------------------------------------------------------------------------
# 4. comfyui-mcp Agent Panel custom node (registry id: comfyui-agent-panel).
#    A git checkout in the seed's custom_nodes — auto-updated at runtime.
# -----------------------------------------------------------------------------
RUN git clone --depth 1 ${PANEL_REF:+--branch "${PANEL_REF}"} \
      "${PANEL_REPO}" "${SEED_HOME}/custom_nodes/comfyui-mcp-panel" \
 && if [ -f "${SEED_HOME}/custom_nodes/comfyui-mcp-panel/requirements.txt" ]; then \
      ${VPIP} install --no-cache-dir --extra-index-url "${TORCH_INDEX_URL}" \
        -r "${SEED_HOME}/custom_nodes/comfyui-mcp-panel/requirements.txt"; \
    fi

# -----------------------------------------------------------------------------
# 5. extra_model_paths.yaml — maps EVERY model category to /workspace/models/*
#    with `is_default: true` so the volume is the PRIMARY (download) location.
#    Lives in the seed (→ copied to ${COMFY_HOME}); passed at launch via
#    --extra-model-paths-config. NO `custom_nodes:` key — custom_nodes live in
#    ${COMFY_HOME}/custom_nodes on the volume (ComfyUI's default), so they persist.
# -----------------------------------------------------------------------------
COPY extra_model_paths.yaml ${SEED_HOME}/extra_model_paths.yaml

# -----------------------------------------------------------------------------
# 6. Manager config TEMPLATE (remote-install gate). Kept at a STABLE image path
#    (not under /workspace, which the volume mount shadows). The entrypoint
#    writes/re-asserts the real config onto the volume's user dir every boot.
# -----------------------------------------------------------------------------
COPY config.ini /opt/config.ini.seed

# -----------------------------------------------------------------------------
# 7. Spotcheck model (ARG-gated — empty dir when BAKE_SPOTCHECK_MODEL=0).
#    The entrypoint copies sd_xl_base_1.0.safetensors from here into the volume's
#    models/checkpoints on first boot if it is not already present.
# -----------------------------------------------------------------------------
COPY --from=spotcheck-src /seed-models/ ${SEED_MODELS}/

# -----------------------------------------------------------------------------
# 8. RunPod service artifacts copied OUT of the donor image (not in the lean
#    base): a file uploader, croc (P2P transfer) and the app-manager web app
#    (:8000). The entrypoint launches them best-effort (skipped if absent).
# -----------------------------------------------------------------------------
COPY --from=runpod-src /usr/local/bin/runpod-uploader /usr/local/bin/runpod-uploader
COPY --from=runpod-src /usr/local/bin/croc            /usr/local/bin/croc
COPY --from=runpod-src /app-manager                   /app-manager

# -----------------------------------------------------------------------------
# 9. nginx (public HTTP :3000 -> ComfyUI :3001, websocket-aware, "starting"
#    fallback) + the entrypoint hook. Self-contained nginx.conf (no include
#    deps). The base's /start.sh runs `service nginx start` then /post_start.sh.
# -----------------------------------------------------------------------------
COPY nginx.conf      /etc/nginx/nginx.conf
COPY starting.html   /usr/share/nginx/html/readme.html
COPY post_start.sh   /post_start.sh
RUN chmod +x /post_start.sh

# -----------------------------------------------------------------------------
# 10. Volume hygiene (LAST so it doesn't bust the expensive build-layer cache).
#     Redirect the base's volume-pointing caches to the EPHEMERAL container fs so
#     runtime pip/HF downloads don't pile up on the network drive, and strip the
#     ~1.1GB pip cache the base bakes at /workspace/.cache (Docker would seed it
#     onto a fresh volume). These are runtime-only vars; they do not affect the
#     RUN steps above.
# -----------------------------------------------------------------------------
ENV PIP_CACHE_DIR=/root/.cache/pip \
    HF_HOME=/root/.cache/huggingface \
    UV_CACHE_DIR=/root/.cache/uv \
    VIRTUALENV_OVERRIDE_APP_DATA=/root/.cache/virtualenv \
    XDG_CACHE_HOME=/root/.cache
RUN rm -rf /workspace/.cache /workspace/.logs && mkdir -p /workspace

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

# syntax=docker/dockerfile:1
#
# comfyui-mcp RunPod image — FAST RESTART, image-immutable software.
# =============================================================================
# DESIGN: optimize STOP/START speed. The ComfyUI install + its venv + Manager v2
# + the Agent Panel custom node are BAKED INTO THE IMAGE at a fixed path
# (/opt/ComfyUI) and RUN DIRECTLY FROM THERE. Nothing is seeded/synced/rsync'd
# onto the network volume at boot. A warm restart does NO install/sync/seed — it
# just `mkdir -p` the user-data dirs and launches ComfyUI from the baked venv
# (~30-60s ComfyUI init).
#
# The /workspace NETWORK VOLUME holds ONLY USER DATA:
#     /workspace/user     workflows + ComfyUI settings + Manager config
#     /workspace/models   all model categories (Manager downloads land here)
#     /workspace/input    input images
#     /workspace/output   generated images
# Nothing else lives on the volume — no venv, no custom_nodes, no caches.
#
# TRADEOFF (documented in README): because custom_nodes are baked into the
# (immutable) image, custom nodes the agent / Manager install at runtime do NOT
# survive a restart — they live on the container's ephemeral disk. MODELS the
# agent / Manager download DO persist (they land on /workspace/models via
# extra_model_paths.yaml `is_default`). To add a node permanently, add it to this
# Dockerfile and rebuild.
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
# 0 skips the ~63 GB donor pull ENTIRELY (BuildKit only builds a stage the final
# target's graph actually reaches — see the runpod-extras-0/1 selector below).
# Use this for CI / small-disk build hosts; the runpod-uploader/croc/app-manager
# extras are then simply absent (the entrypoint already treats them as
# best-effort and skips them cleanly).
ARG INCLUDE_RUNPOD_EXTRAS=1
# Bake the SDXL base checkpoint (~6.9 GB) for a GPU spotcheck. Set to 0 to omit
# the baked copy entirely (the model layer is then never downloaded).
ARG BAKE_SPOTCHECK_MODEL=1

# =============================================================================
# STAGE A — runpod-donor: donor for RunPod service binaries/apps not in the lean
# base (runpod-uploader, croc, app-manager). ARG-gated exactly like the
# spotcheck-model stages below: INCLUDE_RUNPOD_EXTRAS=0 selects runpod-extras-0
# (an empty carrier), so BuildKit never reaches (or pulls) runpod-donor at all.
# =============================================================================
FROM ${RUNPOD_SRC_IMAGE} AS runpod-donor

FROM alpine:3 AS runpod-extras-0
RUN mkdir -p /extras

FROM alpine:3 AS runpod-extras-1
RUN mkdir -p /extras/usr/local/bin /extras/app-manager
COPY --from=runpod-donor /usr/local/bin/runpod-uploader /extras/usr/local/bin/runpod-uploader
COPY --from=runpod-donor /usr/local/bin/croc            /extras/usr/local/bin/croc
COPY --from=runpod-donor /app-manager/                  /extras/app-manager/

# Selector: runpod-extras = runpod-extras-0 (empty) or runpod-extras-1 (donor artifacts).
FROM runpod-extras-${INCLUDE_RUNPOD_EXTRAS} AS runpod-extras

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
# ComfyUI ref to bake. master = latest (must be recent enough for: --enable-manager
# + comfyui_manager v2, AND the per-dir launch flags --user-directory /
# --input-directory / --output-directory, AND extra_model_paths `is_default`).
# Pin a tag/commit for reproducible images.
ARG COMFYUI_REF=master
# pip Manager v2 — exposes /v2/manager/queue/task (the API comfyui-mcp targets).
ARG COMFYUI_MANAGER_VERSION=4.2.2
ARG PANEL_REPO=https://github.com/artokun/comfyui-mcp-panel.git
# Optional panel tag/branch for reproducible images (empty = default branch).
ARG PANEL_REF=
# Torch pin — DEFAULT = BROAD COMPATIBILITY (cu128). cu128 has sm_120 kernels
# (Blackwell / RTX 5090) AND runs on host driver >= 570 — the same CUDA 12.8 bar
# the runpod/pytorch base already advertises via NVIDIA_REQUIRE_CUDA, so any host
# that can START the container can also RUN torch. The cu130 stack we shipped
# briefly raised the real bar to driver >= 580 (CUDA 13), which almost no RunPod
# host meets — pods scheduled fine and then died in the driver preflight (#118).
# The fresh venv gets a clean pinned torch regardless of what the base ships.
#
# No prebuilt SageAttention/xformers in the default build: no linux cu128 wheels
# exist for this torch line, so WHEEL_SAGE/WHEEL_XFORMERS default EMPTY (the perf-
# wheel step below skips itself) and post_start.sh detects the absence and
# launches with --use-pytorch-cross-attention.
#
# CU13 PERF VARIANT (the SECourses 5090 recipe: SageAttention + xformers, abi3
# wheels, fine on the base's py3.12; flash_attn omitted — cp310-only + redundant
# with Sage). Needs host driver >= 580 — RARE on the fleet; tag it separately
# (e.g. :cu130), never :latest. Build with:
#   --build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cu130 \
#   --build-arg WHEEL_SAGE=https://huggingface.co/MonsterMMORPG/Wan_GGUF/resolve/main/sageattention-2.2.0+torch2.9.1.cuda13.1-cp39-abi3-linux_x86_64.whl \
#   --build-arg WHEEL_XFORMERS=https://huggingface.co/MonsterMMORPG/Wan_GGUF/resolve/main/xformers-0.0.34+41531cee.d20260109-cp39-abi3-linux_x86_64.whl \
#   --build-arg MIN_DRIVER_DEFAULT=580
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu128
ARG TORCH_SPEC="torch==2.9.1 torchvision torchaudio==2.9.1"
ARG WHEEL_SAGE=
ARG WHEEL_XFORMERS=
# Host-driver floor enforced by post_start.sh's preflight (override at runtime
# with MIN_DRIVER; 0 disables). 570 == CUDA 12.8 (matches the cu128 default and
# the base's own container-start gate); the cu130 variant passes 580.
ARG MIN_DRIVER_DEFAULT=570
# Fixed IMAGE path for the baked ComfyUI + its venv. RUN FROM HERE — never copied
# to the volume. Immutable software.
ARG COMFY_HOME=/opt/ComfyUI
# Baked spotcheck-model dir (NOT on the volume). The entrypoint copies the SDXL
# checkpoint from here into /workspace/models/checkpoints on first boot.
ARG SEED_MODELS=/opt/ComfyUI-seed-models
# Manager remote-install gate (required for the agent to install models/nodes).
ARG COMFY_NETWORK_MODE=personal_cloud
ARG COMFY_SECURITY_LEVEL=normal-

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    COMFY_HOME=${COMFY_HOME} \
    SEED_MODELS=${SEED_MODELS} \
    COMFY_NETWORK_MODE=${COMFY_NETWORK_MODE} \
    COMFY_SECURITY_LEVEL=${COMFY_SECURITY_LEVEL} \
    MIN_DRIVER_DEFAULT=${MIN_DRIVER_DEFAULT}

# -----------------------------------------------------------------------------
# 0. OS deps the lean base may not ship.
#    cron   — replicate the aitrepreneur service set
#    nodejs — runtime for the copied /app-manager Node app (:8000)
#    git/curl/ca-certificates — clone + code-server install (base usually has git)
#    (NOTE: rsync is GONE — we no longer seed/sync the volume.)
# -----------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
      git cron ca-certificates curl nodejs \
 && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# 1. code-server (browser VS Code). The lean runpod/pytorch base does not ship
#    it; install the standalone build. Best-effort — a failure here must not
#    break the image (code-server is a convenience, not required by the panel).
# -----------------------------------------------------------------------------
RUN curl -fsSL https://code-server.dev/install.sh | sh \
 || echo "WARN: code-server install failed — it will be skipped at boot"

# -----------------------------------------------------------------------------
# 2. Bake ComfyUI at the fixed IMAGE path ${COMFY_HOME} (run from here forever).
# -----------------------------------------------------------------------------
RUN git clone https://github.com/comfyanonymous/ComfyUI.git "${COMFY_HOME}" \
 && cd "${COMFY_HOME}" \
 && git checkout "${COMFYUI_REF}" \
 && git --no-pager log -1 --format='ComfyUI baked at %h %ci'

# -----------------------------------------------------------------------------
# 3. Dedicated venv + pinned torch (default cu128) + ComfyUI requirements + Manager v2.
#    The venv lives at ${COMFY_HOME}/venv and is invoked by absolute path. It is
#    NEVER copied to the volume — ComfyUI runs straight from the image, so import
#    is a fast local read and boot does zero sync.
# -----------------------------------------------------------------------------
ENV VENV=${COMFY_HOME}/venv
ENV VPIP=${VENV}/bin/pip
ENV VPY=${VENV}/bin/python
RUN python3 -m venv "${VENV}" \
 && "${VPY}" -m pip install --no-cache-dir --upgrade pip wheel

# Pinned torch FIRST so the requirements resolver below can't pull a different
# torch (and, on the cu130 perf variant, break the sage/xformers wheel ABI).
# shellcheck disable=SC2086
RUN "${VPIP}" install --no-cache-dir \
      ${TORCH_SPEC} --index-url "${TORCH_INDEX_URL}"

# ComfyUI runtime requirements (the torch index passed as a safety net so nothing
# re-resolves torch off PyPI).
RUN "${VPIP}" install --no-cache-dir --extra-index-url "${TORCH_INDEX_URL}" \
      -r "${COMFY_HOME}/requirements.txt"

# Manager v2 (pip). Remove any classic custom_nodes/ComfyUI-Manager checkout —
# it CONFLICTS with the pip Manager that --enable-manager turns on.
RUN "${VPIP}" install --no-cache-dir "comfyui_manager==${COMFYUI_MANAGER_VERSION}" \
 && rm -rf "${COMFY_HOME}/custom_nodes/ComfyUI-Manager" \
           "${COMFY_HOME}/custom_nodes/comfyui-manager"

# PERF wheels (cu130 variant only — see the ARG block above): SageAttention
# (used via --use-sage-attention) + xformers. The DEFAULT build pins neither, so
# this step is a no-op and post_start launches with PyTorch cross-attention.
# When set: uninstall any requirements-pulled xformers first (SECourses does the
# same) so the pinned wheel wins. A failure here must NOT break the image — Sage
# is a speedup, not required (post_start detects whether it actually imports).
RUN if [ -n "${WHEEL_SAGE}${WHEEL_XFORMERS}" ]; then \
      "${VPIP}" uninstall -y xformers >/dev/null 2>&1 || true; \
      "${VPIP}" install --no-cache-dir ${WHEEL_XFORMERS} ${WHEEL_SAGE} \
        || echo "WARN: perf wheels (sage/xformers) failed to install — will run without SageAttention"; \
    else \
      echo "broad-compat build: no perf wheels pinned — PyTorch cross-attention at launch"; \
    fi

# -----------------------------------------------------------------------------
# 4. comfyui-mcp Agent Panel custom node (registry id: comfyui-agent-panel).
#    Baked into the image's custom_nodes — see the custom_nodes tradeoff above.
# -----------------------------------------------------------------------------
# Bump PANEL_CACHEBUST (e.g. to the target panel commit SHA) to force a fresh
# panel clone WITHOUT busting the expensive torch/sage layers above. `git clone
# --branch` only accepts a ref name (not a raw SHA), so pinning is done here.
ARG PANEL_CACHEBUST=0
RUN echo "panel cachebust: ${PANEL_CACHEBUST}" \
 && git clone --depth 1 ${PANEL_REF:+--branch "${PANEL_REF}"} \
      "${PANEL_REPO}" "${COMFY_HOME}/custom_nodes/comfyui-mcp-panel" \
 && if [ -f "${COMFY_HOME}/custom_nodes/comfyui-mcp-panel/requirements.txt" ]; then \
      "${VPIP}" install --no-cache-dir --extra-index-url "${TORCH_INDEX_URL}" \
        -r "${COMFY_HOME}/custom_nodes/comfyui-mcp-panel/requirements.txt"; \
    fi

# -----------------------------------------------------------------------------
# 5. extra_model_paths.yaml — maps EVERY model category to /workspace/models/*
#    with `is_default: true` so the volume is the PRIMARY (download) location.
#    Passed at launch via --extra-model-paths-config (see post_start.sh).
#    Deliberately NO `custom_nodes:` key — custom_nodes stay in the image.
# -----------------------------------------------------------------------------
COPY extra_model_paths.yaml ${COMFY_HOME}/extra_model_paths.yaml

# -----------------------------------------------------------------------------
# 6. Manager config TEMPLATE (remote-install gate). The RUNNING ComfyUI reads its
#    Manager config UNDER the --user-directory (which is /workspace/user), at
#    user/__manager/config.ini (new ComfyUI) or user/default/ComfyUI-Manager/
#    config.ini (older). So this baked copy is only a TEMPLATE; the entrypoint
#    writes/re-asserts it onto the volume on every boot.
# -----------------------------------------------------------------------------
COPY config.ini ${COMFY_HOME}/config.ini.seed

# -----------------------------------------------------------------------------
# 7. Spotcheck model (ARG-gated — empty dir when BAKE_SPOTCHECK_MODEL=0).
#    The entrypoint copies sd_xl_base_1.0.safetensors from here into the volume's
#    models/checkpoints on first boot if it is not already present.
# -----------------------------------------------------------------------------
COPY --from=spotcheck-src /seed-models/ ${SEED_MODELS}/

# -----------------------------------------------------------------------------
# 8. RunPod service artifacts copied OUT of the donor image (not in the lean
#    base). These let us replicate the aitrepreneur service set without
#    reinstalling them: a file uploader, croc (P2P transfer) and the app-manager
#    web app (:8000). The entrypoint launches them best-effort (skipped if
#    absent) — with INCLUDE_RUNPOD_EXTRAS=0, /extras/ is empty and this COPY is a
#    no-op, so a leaner build (or CI, where the 63 GB donor pull won't fit) is
#    just a build-arg, not a hand-edit of this file.
# -----------------------------------------------------------------------------
COPY --from=runpod-extras /extras/ /

# -----------------------------------------------------------------------------
# 9. nginx (public HTTP :3000 -> ComfyUI :3001, websocket-aware, "starting"
#    fallback) + the entrypoint hook. We ship a SELF-CONTAINED nginx.conf rather
#    than copying the donor's (no snippet/include dependencies → robust on any
#    base). The base's /start.sh runs `service nginx start` reading this file,
#    then runs /post_start.sh.
# -----------------------------------------------------------------------------
COPY nginx.conf      /etc/nginx/nginx.conf
COPY starting.html   /usr/share/nginx/html/readme.html
COPY post_start.sh   /post_start.sh
RUN chmod +x /post_start.sh

# File Browser (https://filebrowser.org) — a single Go binary web file manager.
# Placed LATE so it doesn't bust the expensive torch/ComfyUI layer cache. The
# entrypoint runs it rooted at /workspace (browse/upload/download/delete), fronted
# by nginx on :8083. Best-effort install.
# PINNED release binary, NOT the project's get.sh installer — upstream deleted
# that script (404 as of 2026-07; image 1.5 silently shipped without File
# Browser because of it, #131). A pinned asset URL can't vanish out from under
# a rebuild the same way.
ARG FILEBROWSER_VERSION=v2.63.18
RUN curl -fsSL "https://github.com/filebrowser/filebrowser/releases/download/${FILEBROWSER_VERSION}/linux-amd64-filebrowser.tar.gz" \
      | tar -xz -C /usr/local/bin filebrowser \
 && chmod +x /usr/local/bin/filebrowser \
 || echo "WARN: filebrowser install failed — it will be skipped at boot"

# -----------------------------------------------------------------------------
# custom_nodes PERSISTENCE seed. Move the image's baked custom_nodes (the Agent
# Panel + ComfyUI's builtins) to a SEED dir. At boot, post_start.sh symlinks
# ${COMFY_HOME}/custom_nodes -> /workspace/custom_nodes and copies this seed into
# it — so nodes the agent/Manager install at RUNTIME live on the volume and
# SURVIVE a restart (the base ComfyUI + venv still boot fast from the image).
# Placed LATE so it doesn't bust the torch / spotcheck-model layer cache.
# -----------------------------------------------------------------------------
RUN mv "${COMFY_HOME}/custom_nodes" "${COMFY_HOME}/custom_nodes_seed"

# -----------------------------------------------------------------------------
# 10. Volume hygiene (LAST so it doesn't bust the expensive build-layer cache).
#     The runpod/pytorch base points these caches at /workspace so they "persist"
#     across restarts. With the fast-restart design ALL software is baked in the
#     image (no first-install on the volume), so these caches are pure cruft on
#     the network drive. Force them onto the EPHEMERAL container fs so /workspace
#     stays EXACTLY user/models/input/output (the "that's it" contract). These
#     are runtime-only vars; setting them here does not affect earlier RUN steps.
# -----------------------------------------------------------------------------
ENV PIP_CACHE_DIR=/root/.cache/pip \
    HF_HOME=/root/.cache/huggingface \
    UV_CACHE_DIR=/root/.cache/uv \
    VIRTUALENV_OVERRIDE_APP_DATA=/root/.cache/virtualenv \
    XDG_CACHE_HOME=/root/.cache

# The runpod/pytorch base bakes a ~1.1GB pip cache at /workspace/.cache. Docker
# SEEDS a fresh named/network volume from the image's mount-point contents, so
# that stale cache would land on every new /workspace AND violate the "that's it"
# contract. Strip it: the final image's /workspace is then empty, and post_start
# creates user/models/input/output on first boot.
RUN rm -rf /workspace/.cache /workspace/.logs && mkdir -p /workspace

# We deliberately do NOT set ENTRYPOINT/CMD: the base's /start.sh chain is kept
# (nginx + sshd + JupyterLab + RunPod key injection), and it invokes our
# /post_start.sh hook.

# Documentation only (RunPod exposes ports you configure on the template):
#   3000  ComfyUI via nginx (the panel/connect target)
#   8888  JupyterLab (base; set JUPYTER_PASSWORD)
#   8083  File Browser (via nginx -> :8082; rooted at /workspace)
#   8081  code-server (via nginx -> :8080)
#   8001  app-manager (via nginx -> :8000)
#   22    SSH (base; RunPod PUBLIC_KEY)
EXPOSE 3000 8888 8083 8081 8001 22

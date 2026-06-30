# syntax=docker/dockerfile:1
#
# Custom RunPod ComfyUI image for the comfyui-mcp Agent Panel.
# =============================================================================
# BASED ON THE OFFICIAL TEMPLATE THE OWNER ACTUALLY RUNS: aitrepreneur/comfyui.
#
# Why this base (and NOT raw nvidia/cuda):
#   The aitrepreneur/comfyui image is the proven RunPod template. It already
#   ships ALL the RunPod plumbing that a raw CUDA base lacks:
#     * sshd + RunPod public-key injection
#     * nginx reverse proxy (:3000 -> ComfyUI :3001)
#     * jupyter lab, code-server, runpodctl
#     * CUDA 12.1 userspace + a baked ComfyUI install on a Python venv
#   We do NOT need a cu128 *base* image: the GPU device + driver are provided by
#   RunPod's HOST nvidia container runtime (works on any CUDA base). We only need
#   cu128 *PyTorch wheels* in the venv to get Blackwell / RTX 5090 (sm_120)
#   kernels — and those we install on top (see below).
#
# TEMPLATE ARCHITECTURE WE BUILD ON TOP OF (verified on the live pod):
#   * The base BAKES ComfyUI + a Python venv at /ComfyUI (incl. /ComfyUI/venv).
#   * On boot /start.sh -> /pre_start.sh SYNCS /ComfyUI -> /workspace/ComfyUI
#     (rsync -rlptDu on overlay/xfs, tar-pipe on fuse), version-gated by
#     /workspace/ComfyUI/template.json vs $TEMPLATE_VERSION. So the RUNTIME
#     ComfyUI is /workspace/ComfyUI (persistent volume), seeded from /ComfyUI.
#   * /start_comfyui.sh launches: ARGS=("$@" --listen 0.0.0.0 --port 3001) then
#     cd /workspace/ComfyUI && source venv/bin/activate && python3 main.py ...
#
# WHAT WE ADD (all hand-verified on the live RTX 5090 pod):
#   1. cu128 torch/torchvision/torchaudio in the baked venv (sm_120 kernels).
#   2. ComfyUI 0.26 requirements satisfied in the venv (base may predate them).
#   3. Manager v2 (pip comfyui_manager==4.2.2); remove any classic
#      custom_nodes/ComfyUI-Manager checkout (it conflicts with the pip Manager).
#   4. The comfyui-mcp Agent Panel custom node, pre-cloned.
#   5. A /start_comfyui.sh SHIM that appends --enable-manager
#      --use-pytorch-cross-attention to the base launch (everything else the
#      base entrypoint does — sshd/nginx/jupyter/sync — is left intact).
#   6. A Manager config.ini seed (network_mode = personal_cloud) so the agent
#      can install models/nodes remotely.
#   7. TEMPLATE_VERSION bumped ABOVE 2.3.5 so pre_start.sh re-syncs our baked
#      changes onto fresh volumes.
#
# TOPOLOGY: the panel ORCHESTRATOR (Claude/Codex Agent SDK, on YOUR
# subscription) runs on the USER's machine, NOT on the pod — so Node.js / Claude
# / Codex are deliberately absent. The user connects from their laptop with one
# local command. See ./README.md.
#
# DRAFT — this image was NOT build-tested (no Docker in the authoring env).
# Build + push + deploy instructions are in ./README.md.
# =============================================================================

# Official RunPod template the owner runs. Pin the exact tag.
ARG BASE_IMAGE=aitrepreneur/comfyui:2.3.5
FROM ${BASE_IMAGE}

# ---- Pinned versions (owner-confirm the exact tags — see README) -------------
# Where the base bakes ComfyUI + its venv. Confirm against the base if it ever
# moves (the published aitrepreneur/comfyui template uses /ComfyUI).
ARG COMFY_HOME=/ComfyUI
# pip Manager v2 (exposes /v2/manager/queue/task — the API the MCP targets).
ARG COMFYUI_MANAGER_VERSION=4.2.2
ARG PANEL_REPO=https://github.com/artokun/comfyui-mcp-panel.git
# PyTorch cu128 index -> torch 2.x+cu128 with sm_120 kernels. NOT cu121.
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu128
# ComfyUI ref to update the baked tree to. The base (aitrepreneur/comfyui:2.3.5)
# ships ComfyUI from 2024-08-05 (~v0.0.2-era) which predates --enable-manager +
# the comfyui_manager v2 integration, so it MUST be updated. "master" = latest;
# pin to a tag/commit (e.g. the one your pod runs) for reproducibility.
ARG COMFYUI_REF=master
# MUST exceed the base template version (2.3.5) so /pre_start.sh re-syncs our
# baked changes onto a fresh /workspace volume. 2.4.0 is unambiguously higher
# than 2.3.5 under both lexical and semver comparison.
ARG TEMPLATE_VERSION=2.4.0
# Manager remote-install gate. network_mode MUST be personal_cloud for the agent
# to install models/nodes; security_level normal- is the safe default (weak is
# more permissive — see README).
ARG COMFY_NETWORK_MODE=personal_cloud
ARG COMFY_SECURITY_LEVEL=normal-

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    COMFY_HOME=${COMFY_HOME} \
    TEMPLATE_VERSION=${TEMPLATE_VERSION} \
    COMFY_NETWORK_MODE=${COMFY_NETWORK_MODE} \
    COMFY_SECURITY_LEVEL=${COMFY_SECURITY_LEVEL}

# The base's venv pip. We patch the BAKED venv at ${COMFY_HOME}/venv; pre_start
# syncs it to /workspace/ComfyUI/venv at boot (caveat for existing volumes: see
# README).
ENV VENV_PIP="${COMFY_HOME}/venv/bin/pip"

# -----------------------------------------------------------------------------
# 0. Update the baked ComfyUI to a modern release
# -----------------------------------------------------------------------------
# The base bakes ComfyUI from 2024-08-05 which does NOT accept --enable-manager
# and lacks the comfyui_manager v2 integration (main.py never imports/start()s
# it). Everything below (Manager v2, the cu128/0.26 requirements, the launch
# flags) needs a recent ComfyUI, so update the tree first. The base repo is a
# shallow clone — unshallow so any ref is checkout-able, then check out
# ${COMFYUI_REF}.
RUN cd "${COMFY_HOME}" \
 && (git fetch --unshallow origin 2>/dev/null || git fetch origin) \
 && git fetch --tags --force origin \
 && git checkout -f "${COMFYUI_REF}" \
 && (git reset --hard "origin/${COMFYUI_REF}" 2>/dev/null || true) \
 && git --no-pager log -1 --format='ComfyUI now at %h %ci'

# -----------------------------------------------------------------------------
# 1. cu128 PyTorch in the baked venv (Blackwell / RTX 5090, sm_120)
# -----------------------------------------------------------------------------
# The host nvidia runtime exposes the GPU regardless of the base's CUDA 12.1
# userspace; what matters for sm_120 is the TORCH wheel. cu128 wheels ship
# sm_120 kernels; the default cu121 wheels do NOT ("no kernel image is available
# for execution on the device" at first inference). xformers is intentionally
# NOT installed (its prebuilt wheels lag the cu128 ABI) — we launch ComfyUI with
# --use-pytorch-cross-attention (PyTorch SDPA) instead (see start_comfyui.sh).
# If the base shipped xformers, drop it so it can't shadow SDPA / crash on load.
RUN "${VENV_PIP}" uninstall -y xformers || true
RUN "${VENV_PIP}" install --upgrade \
      torch torchvision torchaudio --index-url "${TORCH_INDEX_URL}"

# -----------------------------------------------------------------------------
# 2. ComfyUI 0.26 runtime requirements in the venv
# -----------------------------------------------------------------------------
# The base may predate ComfyUI 0.26 (sqlalchemy, alembic, comfy-aimdo,
# comfy-kitchen, blake3, comfy-angle, av, ...). Installed AFTER torch so the
# requirement resolver does not pull a cu-default torch from PyPI and downgrade
# our cu128 build. We pass the cu128 index too as a safety net.
RUN "${VENV_PIP}" install --extra-index-url "${TORCH_INDEX_URL}" \
      -r "${COMFY_HOME}/requirements.txt"

# -----------------------------------------------------------------------------
# 3. Manager v2 (pip) + remove the conflicting classic checkout
# -----------------------------------------------------------------------------
# The modern pip Manager exposes /v2/manager/queue/task (what comfyui-mcp uses)
# and is gated behind --enable-manager (added by the start_comfyui.sh shim).
# The classic custom_nodes/ComfyUI-Manager git checkout CONFLICTS with it, so if
# the base ships one we remove it.
RUN rm -rf "${COMFY_HOME}/custom_nodes/ComfyUI-Manager" \
           "${COMFY_HOME}/custom_nodes/comfyui-manager" \
 && "${VENV_PIP}" install "comfyui_manager==${COMFYUI_MANAGER_VERSION}"

# -----------------------------------------------------------------------------
# 4. comfyui-mcp Agent Panel custom node
# -----------------------------------------------------------------------------
# Registry id "comfyui-agent-panel"; repo "comfyui-mcp-panel". Default branch
# (nightly HEAD) — owner may pin a tag for reproducible images (see README).
RUN git clone --depth 1 "${PANEL_REPO}" \
      "${COMFY_HOME}/custom_nodes/comfyui-mcp-panel" \
 && if [ -f "${COMFY_HOME}/custom_nodes/comfyui-mcp-panel/requirements.txt" ]; then \
      "${VENV_PIP}" install --extra-index-url "${TORCH_INDEX_URL}" \
        -r "${COMFY_HOME}/custom_nodes/comfyui-mcp-panel/requirements.txt"; \
    fi

# -----------------------------------------------------------------------------
# 6. Manager config seed (remote-install gate)
# -----------------------------------------------------------------------------
# Baked into the source tree so pre_start.sh syncs it to /workspace. The
# start_comfyui.sh shim ALSO re-asserts this at boot (defensive: rsync -u may
# skip it on a pre-existing volume — see README caveats).
COPY config.ini ${COMFY_HOME}/user/__manager/config.ini

# -----------------------------------------------------------------------------
# 5. Launch-flag override: shim /start_comfyui.sh
# -----------------------------------------------------------------------------
# We REPLACE only the launch leaf, not the RunPod entrypoint chain. The base's
# /start.sh -> /pre_start.sh still run first (sshd, nginx, jupyter, the
# /ComfyUI -> /workspace/ComfyUI sync). Our shim appends --enable-manager
# --use-pytorch-cross-attention to the base's --listen 0.0.0.0 --port 3001.
COPY start_comfyui.sh /start_comfyui.sh
RUN chmod +x /start_comfyui.sh

# We deliberately DO NOT set ENTRYPOINT/CMD — the base's RunPod entrypoint chain
# is preserved as-is so all of its services (sshd, nginx, jupyter, sync) come up.

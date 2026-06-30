# syntax=docker/dockerfile:1
#
# Custom RunPod ComfyUI image for the comfyui-mcp agent.
# -----------------------------------------------------------------------------
# Boots a ComfyUI that is READY to be driven by the comfyui-mcp Agent Panel:
#   * CUDA 12.8 runtime  -> PyTorch cu128 -> Blackwell / RTX 5090 (sm_120) works
#   * ComfyUI 0.26.x on a Python 3.11 venv
#   * the modern pip "Manager v2" (comfyui_manager) behind --enable-manager
#   * the comfyui-mcp Agent Panel custom node, pre-cloned
#
# TOPOLOGY (important): in the "agent runs locally" model, the panel
# ORCHESTRATOR (Claude/Codex Agent SDK, on YOUR subscription) runs on the
# USER's machine, NOT on the pod. So Node.js / Claude / Codex are deliberately
# NOT installed here — the pod only needs ComfyUI + Manager + the panel node.
# The user connects from their laptop with a single local command (see README).
#
# This image bakes the full, hard-won setup so it survives stop/start with no
# manual steps. See ./README.md for the rationale and deploy instructions.
#
# DRAFT — pin the ARGs below to confirmed tags before building (see README).
# -----------------------------------------------------------------------------

# CUDA 12.8 runtime + cuDNN on Ubuntu 22.04. Blackwell (sm_120) needs cu12.8.
# NOTE (owner-confirm): pick a REAL published tag. Candidates on Docker Hub
# nvidia/cuda: 12.8.0 / 12.8.1 with the "-cudnn-runtime-ubuntu22.04" suffix.
ARG CUDA_IMAGE=nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04
FROM ${CUDA_IMAGE}

# ---- Pinned versions (owner-confirm the exact tags — see README) -------------
ARG COMFYUI_VERSION=v0.26.0
ARG COMFYUI_MANAGER_VERSION=4.2.2
ARG PANEL_REPO=https://github.com/artokun/comfyui-mcp-panel.git
# PyTorch cu128 index (gives torch 2.11+cu128, supports sm_120). NOT cu121.
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu128

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    COMFY_HOME=/ComfyUI \
    VENV=/opt/venv \
    COMFY_PORT=3001 \
    COMFY_SECURITY_LEVEL=normal-

# ---- System deps + Python 3.11 ----------------------------------------------
# Ubuntu 22.04 ships Python 3.10; 0.26.x targets 3.11, so pull it from
# deadsnakes. nginx is included for the optional :3000 -> :3001 mirror.
RUN apt-get update && apt-get install -y --no-install-recommends \
      software-properties-common ca-certificates curl wget git git-lfs nginx \
 && add-apt-repository -y ppa:deadsnakes/ppa \
 && apt-get update && apt-get install -y --no-install-recommends \
      python3.11 python3.11-venv python3.11-dev \
 && git lfs install \
 && rm -rf /var/lib/apt/lists/*

# ---- Python 3.11 venv --------------------------------------------------------
RUN python3.11 -m venv "${VENV}"
ENV PATH=${VENV}/bin:${PATH}
RUN pip install --upgrade pip wheel setuptools

# ---- ComfyUI 0.26.x ----------------------------------------------------------
RUN git clone --depth 1 --branch "${COMFYUI_VERSION}" \
      https://github.com/comfyanonymous/ComfyUI.git "${COMFY_HOME}"
WORKDIR ${COMFY_HOME}

# ---- PyTorch cu128 (Blackwell / RTX 5090, sm_120) ---------------------------
# MUST be cu128 — the default cu121 wheels do NOT support sm_120.
# xformers is intentionally OMITTED (ABI/cu128 mismatch); ComfyUI is launched
# with --use-pytorch-cross-attention instead (see start.sh).
RUN pip install torch torchvision torchaudio --index-url "${TORCH_INDEX_URL}"

# ---- ComfyUI 0.26 runtime stack ----------------------------------------------
# The modern 0.26 requirements (sqlalchemy, alembic, comfy-aimdo, comfy-kitchen,
# blake3, comfy-angle, av, ...). Installed AFTER torch so torch is not pulled
# from PyPI (cu-default) and downgraded.
RUN pip install -r requirements.txt

# ---- Manager v2 (modern pip Manager) ----------------------------------------
# This is the pip-installed Manager that exposes the /v2/manager/queue/task API
# the comfyui-mcp MCP targets. Do NOT also clone the classic
# custom_nodes/ComfyUI-Manager checkout — the two CONFLICT. ComfyUI 0.26 gates
# this Manager behind the --enable-manager launch flag (set in start.sh).
RUN pip install "comfyui_manager==${COMFYUI_MANAGER_VERSION}"

# ---- comfyui-mcp Agent Panel custom node ------------------------------------
# Cloned so the panel is served when the user opens the pod's ComfyUI. Registry
# id "comfyui-agent-panel"; repo "comfyui-mcp-panel". Default branch = nightly.
RUN git clone --depth 1 "${PANEL_REPO}" \
      "${COMFY_HOME}/custom_nodes/comfyui-mcp-panel" \
 && if [ -f "${COMFY_HOME}/custom_nodes/comfyui-mcp-panel/requirements.txt" ]; then \
      pip install -r "${COMFY_HOME}/custom_nodes/comfyui-mcp-panel/requirements.txt"; \
    fi

# ---- Entrypoint + optional reverse proxy ------------------------------------
COPY start.sh /start.sh
COPY nginx.conf /etc/nginx/nginx.conf
RUN chmod +x /start.sh

# 3001 = ComfyUI; 3000 = optional nginx mirror (USE_NGINX=1). Expose whichever
# one your RunPod template publishes as the HTTP port.
EXPOSE 3001 3000

ENTRYPOINT ["/start.sh"]

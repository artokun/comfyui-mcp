#!/usr/bin/env bash
#
# Entrypoint for the comfyui-mcp RunPod image.
#
# Launches ComfyUI with the EXACT flag set the comfyui-mcp Agent Panel needs:
#   --listen 0.0.0.0 --port <port> --use-pytorch-cross-attention --enable-manager
#
# Everything below is idempotent so a stop/start re-uses the baked install with
# no manual steps. See ./README.md.
set -euo pipefail

COMFY_HOME="${COMFY_HOME:-/ComfyUI}"
VENV="${VENV:-/opt/venv}"
COMFY_PORT="${COMFY_PORT:-3001}"
COMFY_SECURITY_LEVEL="${COMFY_SECURITY_LEVEL:-normal-}"
COMFY_EXTRA_ARGS="${COMFY_EXTRA_ARGS:-}"

# Optional nginx mirror: publish PUBLIC_PORT and proxy to ComfyUI on COMFY_PORT.
USE_NGINX="${USE_NGINX:-0}"
PUBLIC_PORT="${PUBLIC_PORT:-3000}"

# Optional persistence: if set to a mounted volume (e.g. /workspace), keep heavy
# / stateful dirs there so they survive a full pod re-create, not just stop/start.
PERSIST_ROOT="${PERSIST_ROOT:-}"

export PATH="${VENV}/bin:${PATH}"

log() { echo "[start] $*"; }

# --- Manager v2 config (security_level) -- idempotent, survives stop/start ----
# The modern pip Manager reads <ComfyUI>/user/__manager/config.ini.
#   normal-  : safe default for remote installs (lets the panel queue node/model
#              installs while still blocking the riskiest operations).
#   weak     : MOST permissive (no install guardrails) — only on a pod you fully
#              trust and control. Set COMFY_SECURITY_LEVEL=weak to opt in.
# (Owner-confirm the exact INI schema for comfyui_manager 4.2.2 — see README.)
MANAGER_CFG_DIR="${COMFY_HOME}/user/__manager"
MANAGER_CFG="${MANAGER_CFG_DIR}/config.ini"
mkdir -p "${MANAGER_CFG_DIR}"
if [ ! -f "${MANAGER_CFG}" ]; then
  log "writing Manager config (security_level=${COMFY_SECURITY_LEVEL})"
  cat > "${MANAGER_CFG}" <<EOF
[default]
security_level = ${COMFY_SECURITY_LEVEL}
EOF
elif grep -q '^security_level' "${MANAGER_CFG}"; then
  log "syncing Manager security_level=${COMFY_SECURITY_LEVEL}"
  sed -i "s/^security_level.*/security_level = ${COMFY_SECURITY_LEVEL}/" "${MANAGER_CFG}"
fi

# --- Optional persistent-volume wiring ---------------------------------------
if [ -n "${PERSIST_ROOT}" ] && [ -d "${PERSIST_ROOT}" ]; then
  log "persisting models/output/input/user under ${PERSIST_ROOT}"
  for d in models output input user; do
    if [ ! -e "${PERSIST_ROOT}/${d}" ]; then
      # First boot with this volume: seed it from the baked dir (if any).
      if [ -d "${COMFY_HOME}/${d}" ] && [ ! -L "${COMFY_HOME}/${d}" ]; then
        mv "${COMFY_HOME}/${d}" "${PERSIST_ROOT}/${d}"
      else
        mkdir -p "${PERSIST_ROOT}/${d}"
      fi
    fi
    rm -rf "${COMFY_HOME}/${d}"
    ln -sfn "${PERSIST_ROOT}/${d}" "${COMFY_HOME}/${d}"
  done
fi

cd "${COMFY_HOME}"

# --- Optional nginx reverse proxy (PUBLIC_PORT -> COMFY_PORT) ------------------
# Use this only if your RunPod template publishes PUBLIC_PORT (3000) and you
# want ComfyUI to stay internal on COMFY_PORT (3001). Otherwise publish
# COMFY_PORT directly and leave USE_NGINX=0 (the simpler single-port path).
if [ "${USE_NGINX}" = "1" ]; then
  log "nginx mirror :${PUBLIC_PORT} -> :${COMFY_PORT}"
  nginx -g 'daemon on;'
fi

log "launching ComfyUI on 0.0.0.0:${COMFY_PORT} (cu128 / pytorch-cross-attention / manager v2)"
# shellcheck disable=SC2086
exec python main.py \
  --listen 0.0.0.0 \
  --port "${COMFY_PORT}" \
  --use-pytorch-cross-attention \
  --enable-manager \
  ${COMFY_EXTRA_ARGS}

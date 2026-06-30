#!/usr/bin/env bash
#
# /start_comfyui.sh — comfyui-mcp launch-flag SHIM for the aitrepreneur/comfyui
# RunPod base image.
# =============================================================================
# This REPLACES ONLY the base's launch leaf (/start_comfyui.sh). It does NOT
# replace the RunPod entrypoint chain: the base's /start.sh -> /pre_start.sh
# still run first and bring up sshd, nginx (:3000 -> :3001), jupyter, code-server
# and — critically — the /ComfyUI -> /workspace/ComfyUI sync. By the time this
# script runs, /workspace/ComfyUI exists and is the RUNTIME ComfyUI.
#
# What the base's original /start_comfyui.sh does (verified on the live pod):
#     ARGS=("$@" --listen 0.0.0.0 --port 3001)
#     cd /workspace/ComfyUI && source venv/bin/activate && python3 main.py "${ARGS[@]}"
#
# What we change: append the two flags the comfyui-mcp Agent Panel REQUIRES:
#     --enable-manager              (turns on the pip Manager v2 /v2 API)
#     --use-pytorch-cross-attention (SDPA attention; we ship no xformers)
# Everything else is kept identical to the base launch.
# =============================================================================
set -euo pipefail

# Runtime ComfyUI = the synced copy on the persistent volume (NOT the baked
# /ComfyUI). Overridable for non-standard bases.
COMFY_RUNTIME="${COMFY_RUNTIME:-/workspace/ComfyUI}"
COMFY_PORT="${COMFY_PORT:-3001}"
COMFY_NETWORK_MODE="${COMFY_NETWORK_MODE:-personal_cloud}"
COMFY_SECURITY_LEVEL="${COMFY_SECURITY_LEVEL:-normal-}"
# Extra ComfyUI flags appended verbatim (advanced/escape hatch).
COMFY_EXTRA_ARGS="${COMFY_EXTRA_ARGS:-}"

log() { echo "[comfyui-mcp/start_comfyui] $*"; }

# --- Defensive Manager config (remote-install gate) --------------------------
# We bake config.ini into /ComfyUI and rely on pre_start.sh to sync it to
# /workspace. BUT rsync -u skips older-mtime files, so on a PRE-EXISTING volume
# our seed may NOT have propagated. Re-assert it here so the agent can always
# install models/nodes. network_mode=personal_cloud + a permissive security
# level are REQUIRED for the /v2 install-model gate (verified).
MANAGER_CFG_DIR="${COMFY_RUNTIME}/user/__manager"
MANAGER_CFG="${MANAGER_CFG_DIR}/config.ini"
mkdir -p "${MANAGER_CFG_DIR}"
if [ ! -f "${MANAGER_CFG}" ]; then
  log "seeding Manager config (network_mode=${COMFY_NETWORK_MODE} security_level=${COMFY_SECURITY_LEVEL})"
  cat > "${MANAGER_CFG}" <<EOF
[default]
network_mode = ${COMFY_NETWORK_MODE}
security_level = ${COMFY_SECURITY_LEVEL}
EOF
else
  # Ensure the two load-bearing keys are present/current without clobbering the
  # rest of an existing config.
  if grep -q '^network_mode' "${MANAGER_CFG}"; then
    sed -i "s/^network_mode.*/network_mode = ${COMFY_NETWORK_MODE}/" "${MANAGER_CFG}"
  else
    printf '\nnetwork_mode = %s\n' "${COMFY_NETWORK_MODE}" >> "${MANAGER_CFG}"
  fi
  if grep -q '^security_level' "${MANAGER_CFG}"; then
    sed -i "s/^security_level.*/security_level = ${COMFY_SECURITY_LEVEL}/" "${MANAGER_CFG}"
  else
    printf 'security_level = %s\n' "${COMFY_SECURITY_LEVEL}" >> "${MANAGER_CFG}"
  fi
  log "synced Manager config (network_mode=${COMFY_NETWORK_MODE} security_level=${COMFY_SECURITY_LEVEL})"
fi

# --- Launch (base behavior + our two required flags) -------------------------
# Mirror the base: caller-supplied args first, then --listen/--port, then ours.
ARGS=("$@" --listen 0.0.0.0 --port "${COMFY_PORT}" \
      --enable-manager --use-pytorch-cross-attention)
# shellcheck disable=SC2206
[ -n "${COMFY_EXTRA_ARGS}" ] && ARGS+=(${COMFY_EXTRA_ARGS})

cd "${COMFY_RUNTIME}"
# shellcheck disable=SC1091
source venv/bin/activate

log "launching ComfyUI: cd ${COMFY_RUNTIME} && python3 main.py ${ARGS[*]}"
exec python3 main.py "${ARGS[@]}"

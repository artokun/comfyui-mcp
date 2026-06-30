#!/usr/bin/env bash
#
# /post_start.sh — comfyui-mcp boot hook for the LEAN runpod/pytorch base.
# =============================================================================
# The base image's CMD is /start.sh (from runpod/containers). It:
#   1. service nginx start          (reads our /etc/nginx/nginx.conf: :3000->:3001)
#   2. runs /pre_start.sh (if any)
#   3. setup_ssh (RunPod $PUBLIC_KEY injection) + start_jupyter ($JUPYTER_PASSWORD)
#   4. runs THIS /post_start.sh
#   5. sleep infinity                (keeps the pod alive)
#
# So by the time we run, nginx + sshd + JupyterLab are already up. We add the
# rest: network-volume persistence, cache redirection, the remaining services
# (cron, code-server, runpod-uploader, app-manager) and ComfyUI itself.
#
# IMPORTANT: this script must end alive-and-non-fatal. The base runs it with
# `set -e`, so if we returned non-zero the pod would die. We launch ComfyUI in
# the background and `exec tail -F` its log: that streams ComfyUI's output to the
# RunPod console AND holds the process open (== keeps the pod up) regardless of
# whether ComfyUI later crashes.
# =============================================================================
set -uo pipefail   # NOT -e: services are best-effort; we must stay alive.

log() { echo "[comfyui-mcp/post_start] $*"; }

# ---- Config (override via pod Environment) ----------------------------------
SEED_HOME="${SEED_HOME:-/opt/ComfyUI}"
SEED_MODELS="${SEED_MODELS:-/opt/ComfyUI-seed-models}"
SEED_VERSION="${SEED_VERSION:-1}"
WORKSPACE="${WORKSPACE:-/workspace}"
COMFY_HOME="${COMFY_HOME:-${WORKSPACE}/ComfyUI}"      # runtime ComfyUI (volume)
COMFY_PORT="${COMFY_PORT:-3001}"                       # nginx :3000 -> here
COMFY_NETWORK_MODE="${COMFY_NETWORK_MODE:-personal_cloud}"
COMFY_SECURITY_LEVEL="${COMFY_SECURITY_LEVEL:-normal-}"
COMFY_EXTRA_ARGS="${COMFY_EXTRA_ARGS:-}"              # extra ComfyUI flags
LOG_DIR="${WORKSPACE}/.logs"
mkdir -p "${LOG_DIR}"

# -----------------------------------------------------------------------------
# 1. Caches on the network volume (persist pip/HF/torch/npm caches across
#    stop/start, and keep them off the small container disk).
# -----------------------------------------------------------------------------
export XDG_CACHE_HOME="${WORKSPACE}/.cache"
export HF_HOME="${WORKSPACE}/.cache/huggingface"
export PIP_CACHE_DIR="${WORKSPACE}/.cache/pip"
export TORCH_HOME="${WORKSPACE}/.cache/torch"
export npm_config_cache="${WORKSPACE}/.cache/npm"
mkdir -p "${XDG_CACHE_HOME}" "${HF_HOME}" "${PIP_CACHE_DIR}" \
         "${TORCH_HOME}" "${npm_config_cache}"
# Persist these for SSH / Jupyter terminals too.
{
  echo "export XDG_CACHE_HOME=${XDG_CACHE_HOME}"
  echo "export HF_HOME=${HF_HOME}"
  echo "export PIP_CACHE_DIR=${PIP_CACHE_DIR}"
  echo "export TORCH_HOME=${TORCH_HOME}"
  echo "export npm_config_cache=${npm_config_cache}"
} > /etc/profile.d/comfyui-mcp-caches.sh 2>/dev/null || true

# -----------------------------------------------------------------------------
# 2. Seed ComfyUI + venv onto the volume (the ONLY slow step, and only on a cold
#    volume). A warm volume is skipped → FAST start.
# -----------------------------------------------------------------------------
seed_rsync() {  # $1 = extra rsync flags (e.g. "-u")
  # -a preserves the venv + symlinks; the venv runs from the volume because we
  # invoke its python by absolute path (it derives sys.prefix from its location).
  rsync -a --info=progress2 $1 "${SEED_HOME}/" "${COMFY_HOME}/"
}

copy_spotcheck_model() {
  if ls "${SEED_MODELS}"/*.safetensors >/dev/null 2>&1; then
    mkdir -p "${COMFY_HOME}/models/checkpoints"
    cp -n "${SEED_MODELS}"/*.safetensors "${COMFY_HOME}/models/checkpoints/" \
      && log "copied spotcheck model(s) into models/checkpoints"
  fi
}

if [ ! -d "${COMFY_HOME}" ]; then
  log "COLD volume: seeding ${SEED_HOME} -> ${COMFY_HOME} (first boot — slow)…"
  mkdir -p "${COMFY_HOME}"
  seed_rsync ""
  copy_spotcheck_model
  echo "${SEED_VERSION}" > "${COMFY_HOME}/.seed_version"
  log "seed complete."
else
  prev="$(cat "${COMFY_HOME}/.seed_version" 2>/dev/null || echo 0)"
  newest="$(printf '%s\n%s\n' "${prev}" "${SEED_VERSION}" | sort -V | tail -1)"
  if [ "${SEED_VERSION}" != "${prev}" ] && [ "${newest}" = "${SEED_VERSION}" ]; then
    # Image seed is newer than the volume → version-gated re-seed.
    # CAVEAT: rsync -u skips files whose destination mtime is NEWER, so an
    # existing volume may not pick up every change (esp. the venv). For a clean
    # upgrade, deploy onto a fresh volume. See README "warm-volume caveat".
    log "WARM volume: image seed v${SEED_VERSION} > volume v${prev}; re-syncing (rsync -u)…"
    seed_rsync "-u"
    copy_spotcheck_model
    echo "${SEED_VERSION}" > "${COMFY_HOME}/.seed_version"
    log "re-seed complete."
  else
    log "WARM volume: ${COMFY_HOME} present (seed v${prev}) — FAST start."
  fi
fi

# -----------------------------------------------------------------------------
# 3. Manager remote-install gate. Re-assert on the volume in case rsync -u
#    skipped the seeded config.ini. network_mode=personal_cloud + a permissive
#    security_level are REQUIRED for the /v2 install-model gate.
# -----------------------------------------------------------------------------
CFG_DIR="${COMFY_HOME}/user/__manager"
CFG="${CFG_DIR}/config.ini"
mkdir -p "${CFG_DIR}"
if [ ! -f "${CFG}" ]; then
  printf '[default]\nnetwork_mode = %s\nsecurity_level = %s\n' \
    "${COMFY_NETWORK_MODE}" "${COMFY_SECURITY_LEVEL}" > "${CFG}"
else
  if grep -q '^network_mode' "${CFG}"; then
    sed -i "s/^network_mode.*/network_mode = ${COMFY_NETWORK_MODE}/" "${CFG}"
  else
    printf '\nnetwork_mode = %s\n' "${COMFY_NETWORK_MODE}" >> "${CFG}"
  fi
  if grep -q '^security_level' "${CFG}"; then
    sed -i "s/^security_level.*/security_level = ${COMFY_SECURITY_LEVEL}/" "${CFG}"
  else
    printf 'security_level = %s\n' "${COMFY_SECURITY_LEVEL}" >> "${CFG}"
  fi
fi
log "Manager config: network_mode=${COMFY_NETWORK_MODE} security_level=${COMFY_SECURITY_LEVEL}"

# -----------------------------------------------------------------------------
# 4. Ancillary services (best-effort — skipped if the binary is absent).
# -----------------------------------------------------------------------------
service cron start >/dev/null 2>&1 && log "cron started" || log "cron not available (skip)"

if command -v code-server >/dev/null 2>&1; then
  log "starting code-server on :8080 (nginx front :8081)…"
  nohup code-server --bind-addr 0.0.0.0:8080 --auth none \
    >"${LOG_DIR}/code-server.log" 2>&1 &
else
  log "code-server not installed (skip)"
fi

if command -v runpod-uploader >/dev/null 2>&1; then
  log "starting runpod-uploader…"
  nohup runpod-uploader >"${LOG_DIR}/runpod-uploader.log" 2>&1 &
else
  log "runpod-uploader not present (skip)"
fi

if [ -f /app-manager/app.js ] && command -v node >/dev/null 2>&1; then
  log "starting app-manager on :8000 (nginx front :8001)…"
  ( cd /app-manager && nohup node app.js >"${LOG_DIR}/app-manager.log" 2>&1 & )
else
  log "app-manager not present or node missing (skip)"
fi

command -v croc >/dev/null 2>&1 && log "croc available (on-demand P2P transfer)"

# -----------------------------------------------------------------------------
# 5. Launch ComfyUI from the volume venv, against the volume tree.
#    Invoke the venv python by ABSOLUTE PATH (relocatable-venv safe — no reliance
#    on `activate`, whose VIRTUAL_ENV/shebangs still point at the baked seed path).
# -----------------------------------------------------------------------------
VPY="${COMFY_HOME}/venv/bin/python"
if [ ! -x "${VPY}" ]; then
  log "FATAL: venv python not found at ${VPY} — the seed/venv did not sync."
  log "       (warm-volume rsync -u caveat? Try a fresh volume.) Holding pod for debug."
  exec sleep infinity
fi

mkdir -p "${COMFY_HOME}/logs"
COMFY_LOG="${COMFY_HOME}/logs/comfyui.log"

ARGS=(--listen 0.0.0.0 --port "${COMFY_PORT}"
      --enable-manager --use-pytorch-cross-attention)
# shellcheck disable=SC2206
[ -n "${COMFY_EXTRA_ARGS}" ] && ARGS+=(${COMFY_EXTRA_ARGS})

cd "${COMFY_HOME}"
log "launching ComfyUI: ${VPY} main.py ${ARGS[*]}"
log "  models dir : ${COMFY_HOME}/models   (your models persist on the volume)"
log "  HTTP (nginx): :3000  ->  ComfyUI :${COMFY_PORT}"
log "  RunPod proxy: https://<pod-id>-3000.proxy.runpod.net"
nohup "${VPY}" main.py "${ARGS[@]}" >>"${COMFY_LOG}" 2>&1 &
COMFY_PID=$!
log "ComfyUI started (pid=${COMFY_PID}); streaming ${COMFY_LOG}"

# Stream ComfyUI's log to the pod console and hold the pod open. If tail is ever
# killed, the base's `sleep infinity` still keeps the pod alive.
exec tail -n +1 -F "${COMFY_LOG}"

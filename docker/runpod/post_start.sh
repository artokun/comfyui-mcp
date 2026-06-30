#!/usr/bin/env bash
#
# /post_start.sh — comfyui-mcp boot hook (FAST-RESTART design).
# =============================================================================
# The base image's CMD is /start.sh (from runpod/containers). It:
#   1. service nginx start          (reads our /etc/nginx/nginx.conf: :3000->:3001)
#   2. runs /pre_start.sh (if any)
#   3. setup_ssh (RunPod $PUBLIC_KEY injection) + start_jupyter ($JUPYTER_PASSWORD)
#   4. runs THIS /post_start.sh
#   5. sleep infinity                (keeps the pod alive)
#
# So by the time we run, nginx + sshd + JupyterLab are already up.
#
# FAST RESTART: the ComfyUI install + venv + custom_nodes are BAKED IN THE IMAGE
# at ${COMFY_HOME} (default /opt/ComfyUI) and run DIRECTLY from there. We do NOT
# seed/sync/rsync anything onto /workspace. The ONLY volume prep is a fast,
# idempotent `mkdir -p` of the user-data dirs. ComfyUI is then pointed at those
# dirs via per-directory launch flags + extra_model_paths.yaml. A warm restart
# therefore does NO install/sync/seed — just mkdir + launch (~30-60s init).
#
# WHAT PERSISTS / WHAT DOESN'T:
#   * PERSIST (on /workspace): user/ (workflows+settings+Manager config),
#     models/ (incl. Manager downloads), input/, output/.
#   * EPHEMERAL (in the container): custom_nodes, the venv, all caches. Nodes the
#     agent/Manager install at runtime DO NOT survive a restart — bake them into
#     the Dockerfile to keep them. Models DO survive (they land on the volume).
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
COMFY_HOME="${COMFY_HOME:-/opt/ComfyUI}"               # BAKED ComfyUI (image)
SEED_MODELS="${SEED_MODELS:-/opt/ComfyUI-seed-models}" # baked spotcheck model(s)
WORKSPACE="${WORKSPACE:-/workspace}"                   # network volume (USER DATA)
COMFY_PORT="${COMFY_PORT:-3001}"                        # nginx :3000 -> here
COMFY_NETWORK_MODE="${COMFY_NETWORK_MODE:-personal_cloud}"
COMFY_SECURITY_LEVEL="${COMFY_SECURITY_LEVEL:-normal-}"
COMFY_EXTRA_ARGS="${COMFY_EXTRA_ARGS:-}"              # extra ComfyUI flags
EXTRA_MODEL_PATHS="${EXTRA_MODEL_PATHS:-${COMFY_HOME}/extra_model_paths.yaml}"

# Volume user-data dirs (the ONLY things on /workspace).
USER_DIR="${WORKSPACE}/user"
MODELS_DIR="${WORKSPACE}/models"
INPUT_DIR="${WORKSPACE}/input"
OUTPUT_DIR="${WORKSPACE}/output"

# Logs go to the EPHEMERAL container fs, NOT the volume. The RunPod console
# streams them live (we `exec tail -F` below), and the fast-restart contract
# keeps /workspace EXACTLY user/models/input/output — logs are runtime cruft.
LOG_DIR="${COMFY_LOG_DIR:-/var/log/comfyui-mcp}"
mkdir -p "${LOG_DIR}"

# -----------------------------------------------------------------------------
# 1. Volume prep — the ONLY boot-time volume work. Fast + idempotent.
#    Create user/models/input/output + the model category subfolders that
#    extra_model_paths.yaml maps, so the dirs exist on a cold volume (ComfyUI /
#    Manager would create them lazily, but pre-creating keeps the UI tidy and
#    guarantees Manager has a place to download into).
#    NO caches, NO venv, NO custom_nodes are placed on the volume.
# -----------------------------------------------------------------------------
log "preparing /workspace user-data dirs (mkdir -p; no sync)…"
mkdir -p "${USER_DIR}" "${INPUT_DIR}" "${OUTPUT_DIR}"
for sub in checkpoints configs loras vae text_encoders clip diffusion_models \
           unet clip_vision style_models embeddings diffusers vae_approx \
           controlnet t2i_adapter gligen upscale_models latent_upscale_models \
           hypernetworks photomaker classifiers model_patches audio_encoders \
           background_removal frame_interpolation geometry_estimation \
           optical_flow detection; do
  mkdir -p "${MODELS_DIR}/${sub}"
done

# -----------------------------------------------------------------------------
# 2. Spotcheck model — first-boot only. If the SDXL checkpoint isn't on the
#    volume yet and a baked copy exists, copy it so it's visible AND persists.
#    (BAKE_SPOTCHECK_MODEL=0 builds omit the baked copy → this is a no-op.)
# -----------------------------------------------------------------------------
if [ ! -f "${MODELS_DIR}/checkpoints/sd_xl_base_1.0.safetensors" ] \
   && ls "${SEED_MODELS}"/*.safetensors >/dev/null 2>&1; then
  log "first boot: copying baked spotcheck model(s) into models/checkpoints…"
  cp -n "${SEED_MODELS}"/*.safetensors "${MODELS_DIR}/checkpoints/" \
    && log "spotcheck model in place." \
    || log "WARN: spotcheck copy failed (continuing)."
fi

# -----------------------------------------------------------------------------
# 3. Manager remote-install gate. The RUNNING ComfyUI reads its Manager config
#    UNDER the --user-directory (= ${USER_DIR}). Depending on the ComfyUI build,
#    comfyui_manager looks at either:
#        ${USER_DIR}/__manager/config.ini              (new: System User API)
#        ${USER_DIR}/default/ComfyUI-Manager/config.ini (older)
#    We write/re-assert BOTH on every boot so the gate is correct regardless.
#    network_mode=personal_cloud + a permissive security_level are REQUIRED for
#    the /v2 install-model gate the Agent Panel uses.
# -----------------------------------------------------------------------------
write_manager_config() {  # $1 = config.ini absolute path
  local cfg="$1" dir
  dir="$(dirname "${cfg}")"
  mkdir -p "${dir}"
  if [ ! -f "${cfg}" ]; then
    # Prefer the baked template if present, else synthesize.
    if [ -f "${COMFY_HOME}/config.ini.seed" ]; then
      cp "${COMFY_HOME}/config.ini.seed" "${cfg}"
    else
      printf '[default]\nnetwork_mode = %s\nsecurity_level = %s\n' \
        "${COMFY_NETWORK_MODE}" "${COMFY_SECURITY_LEVEL}" > "${cfg}"
    fi
  fi
  # Re-assert the two keys from env (idempotent; survives template drift).
  if grep -q '^network_mode' "${cfg}"; then
    sed -i "s/^network_mode.*/network_mode = ${COMFY_NETWORK_MODE}/" "${cfg}"
  else
    printf '\nnetwork_mode = %s\n' "${COMFY_NETWORK_MODE}" >> "${cfg}"
  fi
  if grep -q '^security_level' "${cfg}"; then
    sed -i "s/^security_level.*/security_level = ${COMFY_SECURITY_LEVEL}/" "${cfg}"
  else
    printf 'security_level = %s\n' "${COMFY_SECURITY_LEVEL}" >> "${cfg}"
  fi
}
write_manager_config "${USER_DIR}/__manager/config.ini"
write_manager_config "${USER_DIR}/default/ComfyUI-Manager/config.ini"
log "Manager config asserted: network_mode=${COMFY_NETWORK_MODE} security_level=${COMFY_SECURITY_LEVEL}"

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
# 5. Launch ComfyUI from the BAKED venv (image), pointed at the volume dirs.
#    Invoke the venv python by ABSOLUTE PATH (no `activate` needed).
#    Per-directory flags keep user/input/output on /workspace; models come from
#    extra_model_paths.yaml (is_default → volume is primary). custom_nodes are
#    NOT redirected — they stay in the image (fast-restart contract). We do NOT
#    use --base-directory because it would relocate custom_nodes onto the volume.
# -----------------------------------------------------------------------------
VPY="${COMFY_HOME}/venv/bin/python"
if [ ! -x "${VPY}" ]; then
  log "FATAL: baked venv python not found at ${VPY} — image build problem."
  log "       Holding pod open for debug (the image software did not bake)."
  exec sleep infinity
fi

COMFY_LOG="${LOG_DIR}/comfyui.log"

ARGS=(--listen 0.0.0.0 --port "${COMFY_PORT}"
      --enable-manager --use-pytorch-cross-attention
      --user-directory  "${USER_DIR}"
      --input-directory "${INPUT_DIR}"
      --output-directory "${OUTPUT_DIR}")
# Load the volume model map only if the file exists (it's baked, but be defensive).
[ -f "${EXTRA_MODEL_PATHS}" ] && ARGS+=(--extra-model-paths-config "${EXTRA_MODEL_PATHS}")
# shellcheck disable=SC2206
[ -n "${COMFY_EXTRA_ARGS}" ] && ARGS+=(${COMFY_EXTRA_ARGS})

cd "${COMFY_HOME}"
log "launching ComfyUI: ${VPY} main.py ${ARGS[*]}"
log "  software   : ${COMFY_HOME}        (image; immutable, fast local import)"
log "  user dir   : ${USER_DIR}          (volume; workflows + settings)"
log "  models     : ${MODELS_DIR}        (volume; downloads persist here)"
log "  input/out  : ${INPUT_DIR} / ${OUTPUT_DIR}  (volume)"
log "  HTTP (nginx): :3000  ->  ComfyUI :${COMFY_PORT}"
log "  RunPod proxy: https://<pod-id>-3000.proxy.runpod.net"
nohup "${VPY}" main.py "${ARGS[@]}" >>"${COMFY_LOG}" 2>&1 &
COMFY_PID=$!
log "ComfyUI started (pid=${COMFY_PID}); streaming ${COMFY_LOG}"

# Stream ComfyUI's log to the pod console and hold the pod open. If tail is ever
# killed, the base's `sleep infinity` still keeps the pod alive.
exec tail -n +1 -F "${COMFY_LOG}"

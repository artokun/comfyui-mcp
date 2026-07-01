#!/usr/bin/env bash
#
# /post_start.sh — comfyui-mcp boot hook (PERSISTENT-ON-VOLUME design).
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
# WHAT THIS DOES
#   FIRST boot (empty volume): rsync the pristine seed ${SEED_HOME} (baked in the
#     image) to ${COMFY_HOME} on the network volume — the app + venv +
#     custom_nodes. Slow, one-time.
#   EVERY boot after: NO copy. `git pull --ff-only` ComfyUI + the panel and
#     re-pip ONLY if a requirements file changed (sha marker). Then launch.
#
# WHAT PERSISTS: EVERYTHING durable is on /workspace —
#   ComfyUI/ (app+venv+custom_nodes, auto-updated), user/, models/, input/,
#   output/. Custom nodes the agent/Manager install at runtime AND their pip deps
#   (in the venv) SURVIVE a restart.
#
# RELOCATABLE VENV: built at ${SEED_HOME}/venv, run from ${COMFY_HOME}/venv. We
# invoke it by ABSOLUTE PATH and use `python -m pip` (never the path-pinned `pip`
# console-script), so the interpreter self-locates after the copy.
#
# IMPORTANT: this script must end alive-and-non-fatal. The base runs it with
# `set -e`; we use `set +e` semantics and launch ComfyUI in the background, then
# `exec tail -F` its log to hold the pod open regardless of later crashes.
# =============================================================================
set -uo pipefail   # NOT -e: every step is best-effort; we must stay alive.

log() { echo "[comfyui-mcp/post_start] $*"; }

# ---- Config (override via pod Environment) ----------------------------------
SEED_HOME="${SEED_HOME:-/opt/ComfyUI-seed}"            # baked pristine tree (image)
COMFY_HOME="${COMFY_HOME:-/workspace/ComfyUI}"         # runtime tree (VOLUME)
SEED_MODELS="${SEED_MODELS:-/opt/ComfyUI-seed-models}" # baked spotcheck model(s)
WORKSPACE="${WORKSPACE:-/workspace}"                   # network volume
COMFY_PORT="${COMFY_PORT:-3001}"                        # nginx :3000 -> here
COMFY_NETWORK_MODE="${COMFY_NETWORK_MODE:-personal_cloud}"
COMFY_SECURITY_LEVEL="${COMFY_SECURITY_LEVEL:-normal-}"
COMFY_EXTRA_ARGS="${COMFY_EXTRA_ARGS:-}"              # extra ComfyUI flags
TORCH_INDEX_URL="${TORCH_INDEX_URL:-https://download.pytorch.org/whl/cu128}"
# Auto-update toggles (per-boot). Git pulls are cheap + offline-safe. The Manager
# pip bump is ON by default so it stays in lockstep with the auto-updating panel
# ("always up to date"). COMFY_MANAGER_SPEC bounds the bump to the /v2 major line
# (>=4,<5) so an auto-update can't SILENTLY cross into a breaking API major that
# would break the panel's install-model; widen it (e.g. `comfyui_manager`) to
# track absolute latest, or set COMFY_AUTOUPDATE_MANAGER=0 to freeze.
COMFY_AUTOUPDATE="${COMFY_AUTOUPDATE:-1}"                  # git pull ComfyUI + panel
COMFY_AUTOUPDATE_MANAGER="${COMFY_AUTOUPDATE_MANAGER:-1}"  # pip -U comfyui_manager
COMFY_MANAGER_SPEC="${COMFY_MANAGER_SPEC:-comfyui_manager>=4,<5}"

USER_DIR="${WORKSPACE}/user"
MODELS_DIR="${WORKSPACE}/models"
INPUT_DIR="${WORKSPACE}/input"
OUTPUT_DIR="${WORKSPACE}/output"
VENV="${COMFY_HOME}/venv"
VPY="${VENV}/bin/python"
PANEL_DIR="${COMFY_HOME}/custom_nodes/comfyui-mcp-panel"
EXTRA_MODEL_PATHS="${COMFY_HOME}/extra_model_paths.yaml"
MARKERS="${COMFY_HOME}/.autoupdate"   # sha markers for conditional pip

# Logs on the EPHEMERAL container fs (the RunPod console streams them live below).
LOG_DIR="${COMFY_LOG_DIR:-/var/log/comfyui-mcp}"
mkdir -p "${LOG_DIR}"

# -----------------------------------------------------------------------------
# 1. Volume user-data dirs (fast, idempotent). ComfyUI runs FROM ${COMFY_HOME}
#    but its user/models/input/output are pointed at the volume root via launch
#    flags + extra_model_paths.yaml, so pre-create them.
# -----------------------------------------------------------------------------
log "preparing /workspace user-data dirs…"
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
# 2. FIRST BOOT: seed ComfyUI onto the volume. We key off the venv python: if
#    it's missing/non-executable the volume copy is absent or incomplete, so
#    rsync the seed (rsync resumes a partial copy idempotently).
# -----------------------------------------------------------------------------
FIRST_BOOT=0
if [ ! -x "${VPY}" ]; then
  FIRST_BOOT=1
  if [ ! -x "${SEED_HOME}/venv/bin/python" ]; then
    log "FATAL: seed venv missing at ${SEED_HOME}/venv — image build problem."
    log "       Holding pod open for debug."
    exec sleep infinity
  fi
  log "FIRST BOOT: copying seed ${SEED_HOME} -> ${COMFY_HOME} (one-time; multi-GB)…"
  mkdir -p "${COMFY_HOME}"
  if rsync -a --info=progress2 "${SEED_HOME}/" "${COMFY_HOME}/"; then
    log "seed copy complete."
  else
    log "WARN: rsync returned non-zero — verifying venv anyway."
  fi
  if [ ! -x "${VPY}" ]; then
    log "FATAL: ${VPY} still missing after seed copy — holding pod open for debug."
    exec sleep infinity
  fi
fi

# -----------------------------------------------------------------------------
# 3. AUTO-UPDATE (skipped on first boot — the freshly-seeded tree is already at
#    the baked ref). Git pulls are best-effort + offline-safe; pip only re-runs
#    when a requirements file's sha changes.
# -----------------------------------------------------------------------------
git_pull() {  # $1 = repo dir, $2 = label
  [ -d "$1/.git" ] || { log "${2}: not a git checkout (skip pull)"; return 0; }
  log "${2}: git pull --ff-only…"
  if git -C "$1" pull --ff-only >>"${LOG_DIR}/autoupdate.log" 2>&1; then
    log "${2}: $(git -C "$1" --no-pager log -1 --format='at %h %ci')"
  else
    log "WARN: ${2} pull failed (offline or non-fast-forward) — continuing on current checkout."
  fi
}

maybe_pip_reqs() {  # $1 = requirements file, $2 = marker name
  local reqs="$1" marker="${MARKERS}/$2" sum
  [ -f "${reqs}" ] || return 0
  mkdir -p "${MARKERS}"
  sum="$(sha256sum "${reqs}" 2>/dev/null | awk '{print $1}')"
  if [ "$(cat "${marker}" 2>/dev/null || true)" != "${sum}" ]; then
    log "requirements changed (${2}) → pip install…"
    if "${VPY}" -m pip install --extra-index-url "${TORCH_INDEX_URL}" -r "${reqs}" \
         >>"${LOG_DIR}/autoupdate.log" 2>&1; then
      echo "${sum}" > "${marker}"
      log "pip install (${2}) ok."
    else
      log "WARN: pip install (${2}) failed — see ${LOG_DIR}/autoupdate.log."
    fi
  fi
}

if [ "${FIRST_BOOT}" -eq 0 ] && [ "${COMFY_AUTOUPDATE}" = "1" ]; then
  log "auto-update: pulling ComfyUI + panel (set COMFY_AUTOUPDATE=0 to skip)…"
  git_pull "${COMFY_HOME}" "ComfyUI"
  git_pull "${PANEL_DIR}"  "panel"
  maybe_pip_reqs "${COMFY_HOME}/requirements.txt"            "comfyui-reqs"
  maybe_pip_reqs "${PANEL_DIR}/requirements.txt"             "panel-reqs"
  if [ "${COMFY_AUTOUPDATE_MANAGER}" = "1" ]; then
    log "auto-update: pip -U '${COMFY_MANAGER_SPEC}' (COMFY_AUTOUPDATE_MANAGER=1)…"
    "${VPY}" -m pip install -U "${COMFY_MANAGER_SPEC}" >>"${LOG_DIR}/autoupdate.log" 2>&1 \
      && log "comfyui_manager: $("${VPY}" -m pip show comfyui_manager 2>/dev/null | awk '/^Version:/{print $2}')" \
      || log "WARN: comfyui_manager update failed — continuing on installed version."
  fi
else
  [ "${FIRST_BOOT}" -eq 1 ] && log "first boot: skipping auto-update (tree is freshly seeded)."
fi

# Ensure the conditional-pip markers are seeded on FIRST boot so we don't re-pip
# unchanged requirements on the 2nd boot.
if [ "${FIRST_BOOT}" -eq 1 ]; then
  mkdir -p "${MARKERS}"
  for pair in "${COMFY_HOME}/requirements.txt:comfyui-reqs" "${PANEL_DIR}/requirements.txt:panel-reqs"; do
    f="${pair%%:*}"; m="${pair##*:}"
    [ -f "${f}" ] && sha256sum "${f}" 2>/dev/null | awk '{print $1}' > "${MARKERS}/${m}"
  done
fi

# -----------------------------------------------------------------------------
# 4. Spotcheck model — first-boot only. Copy the baked SDXL checkpoint onto the
#    volume if absent (BAKE_SPOTCHECK_MODEL=0 builds → no-op).
# -----------------------------------------------------------------------------
if [ ! -f "${MODELS_DIR}/checkpoints/sd_xl_base_1.0.safetensors" ] \
   && ls "${SEED_MODELS}"/*.safetensors >/dev/null 2>&1; then
  log "copying baked spotcheck model(s) into models/checkpoints…"
  cp -n "${SEED_MODELS}"/*.safetensors "${MODELS_DIR}/checkpoints/" \
    && log "spotcheck model in place." || log "WARN: spotcheck copy failed (continuing)."
fi

# -----------------------------------------------------------------------------
# 5. Manager remote-install gate. The RUNNING ComfyUI reads its Manager config
#    UNDER --user-directory (= ${USER_DIR}), at one of:
#        ${USER_DIR}/__manager/config.ini               (new: System User API)
#        ${USER_DIR}/default/ComfyUI-Manager/config.ini (older)
#    Write/re-assert BOTH every boot. network_mode=personal_cloud + a permissive
#    security_level are REQUIRED for the /v2 install-model gate the Panel uses.
# -----------------------------------------------------------------------------
write_manager_config() {  # $1 = config.ini absolute path
  local cfg="$1" dir; dir="$(dirname "${cfg}")"
  mkdir -p "${dir}"
  if [ ! -f "${cfg}" ]; then
    if [ -f /opt/config.ini.seed ]; then cp /opt/config.ini.seed "${cfg}"; else
      printf '[default]\nnetwork_mode = %s\nsecurity_level = %s\n' \
        "${COMFY_NETWORK_MODE}" "${COMFY_SECURITY_LEVEL}" > "${cfg}"; fi
  fi
  if grep -q '^network_mode' "${cfg}"; then
    sed -i "s/^network_mode.*/network_mode = ${COMFY_NETWORK_MODE}/" "${cfg}"
  else printf '\nnetwork_mode = %s\n' "${COMFY_NETWORK_MODE}" >> "${cfg}"; fi
  if grep -q '^security_level' "${cfg}"; then
    sed -i "s/^security_level.*/security_level = ${COMFY_SECURITY_LEVEL}/" "${cfg}"
  else printf 'security_level = %s\n' "${COMFY_SECURITY_LEVEL}" >> "${cfg}"; fi
}
write_manager_config "${USER_DIR}/__manager/config.ini"
write_manager_config "${USER_DIR}/default/ComfyUI-Manager/config.ini"
log "Manager config asserted: network_mode=${COMFY_NETWORK_MODE} security_level=${COMFY_SECURITY_LEVEL}"

# -----------------------------------------------------------------------------
# 6. Ancillary services (best-effort — skipped if the binary is absent).
# -----------------------------------------------------------------------------
service cron start >/dev/null 2>&1 && log "cron started" || log "cron not available (skip)"
if command -v code-server >/dev/null 2>&1; then
  log "starting code-server on :8080 (nginx front :8081)…"
  nohup code-server --bind-addr 0.0.0.0:8080 --auth none >"${LOG_DIR}/code-server.log" 2>&1 &
else log "code-server not installed (skip)"; fi
if command -v runpod-uploader >/dev/null 2>&1; then
  log "starting runpod-uploader…"
  nohup runpod-uploader >"${LOG_DIR}/runpod-uploader.log" 2>&1 &
else log "runpod-uploader not present (skip)"; fi
if [ -f /app-manager/app.js ] && command -v node >/dev/null 2>&1; then
  log "starting app-manager on :8000 (nginx front :8001)…"
  ( cd /app-manager && nohup node app.js >"${LOG_DIR}/app-manager.log" 2>&1 & )
else log "app-manager not present or node missing (skip)"; fi
command -v croc >/dev/null 2>&1 && log "croc available (on-demand P2P transfer)"

# -----------------------------------------------------------------------------
# 7. Launch ComfyUI from the VOLUME venv, pointed at the volume user-data dirs.
#    custom_nodes are NOT redirected — they live in ${COMFY_HOME}/custom_nodes
#    (ComfyUI's default), which is on the volume, so they persist.
# -----------------------------------------------------------------------------
COMFY_LOG="${LOG_DIR}/comfyui.log"
ARGS=(--listen 0.0.0.0 --port "${COMFY_PORT}"
      --enable-manager --use-pytorch-cross-attention
      --user-directory  "${USER_DIR}"
      --input-directory "${INPUT_DIR}"
      --output-directory "${OUTPUT_DIR}")
[ -f "${EXTRA_MODEL_PATHS}" ] && ARGS+=(--extra-model-paths-config "${EXTRA_MODEL_PATHS}")
# shellcheck disable=SC2206
[ -n "${COMFY_EXTRA_ARGS}" ] && ARGS+=(${COMFY_EXTRA_ARGS})

cd "${COMFY_HOME}"
log "launching ComfyUI: ${VPY} main.py ${ARGS[*]}"
log "  app+venv   : ${COMFY_HOME}        (volume; auto-updated, deps persist)"
log "  user dir   : ${USER_DIR}          (volume; workflows + settings)"
log "  models     : ${MODELS_DIR}        (volume; downloads persist here)"
log "  input/out  : ${INPUT_DIR} / ${OUTPUT_DIR}  (volume)"
log "  HTTP (nginx): :3000  ->  ComfyUI :${COMFY_PORT}"
nohup "${VPY}" main.py "${ARGS[@]}" >>"${COMFY_LOG}" 2>&1 &
COMFY_PID=$!
log "ComfyUI started (pid=${COMFY_PID}); streaming ${COMFY_LOG}"

# Stream ComfyUI's log to the pod console and hold the pod open.
exec tail -n +1 -F "${COMFY_LOG}"

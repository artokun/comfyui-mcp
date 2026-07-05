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
#     models/ (incl. Manager downloads), input/, output/, and — since §4.5 below —
#     custom_nodes/ too (symlinked onto the volume; nodes the agent/Manager
#     install at runtime NOW SURVIVE a restart). The image's baked nodes (incl.
#     the Agent Panel) are seeded/refreshed onto the volume every boot without
#     clobbering nodes the user installed themselves.
#   * EPHEMERAL (in the container): the ComfyUI install + venv + all caches —
#     still baked/fast per the fast-restart design above.
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
# "weak" so the Agent Panel can install custom nodes from ARBITRARY git URLs
# (Manager classes those high-risk and silently skips them at "normal-", while
# registry-id installs pass — a confusing half-working state). This is a
# single-user pod whose entire premise is agent-driven installs; set
# COMFY_SECURITY_LEVEL=normal- to restore the guardrails.
COMFY_SECURITY_LEVEL="${COMFY_SECURITY_LEVEL:-weak}"
COMFY_EXTRA_ARGS="${COMFY_EXTRA_ARGS:-}"              # extra ComfyUI flags
EXTRA_MODEL_PATHS="${EXTRA_MODEL_PATHS:-${COMFY_HOME}/extra_model_paths.yaml}"
# Pull the latest Agent Panel release on every boot (git fetch + reset --hard,
# BEFORE ComfyUI launches — see §4.5b) instead of waiting for a new pod image.
# Automatically a no-op for a PANEL_REF-pinned build (detached HEAD — pinning
# means the user wants reproducibility, not drift). Set to 0 to disable outright.
PANEL_AUTO_UPDATE="${PANEL_AUTO_UPDATE:-1}"

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

# Minimum host NVIDIA driver. Baked per image variant by the Dockerfile
# (MIN_DRIVER_DEFAULT env: 570 for the default cu128 build — the same CUDA 12.8
# bar the runpod/pytorch base's container-start gate already enforces — 580 for
# the cu130 perf variant, which needs CUDA 13). Override at runtime with
# MIN_DRIVER, or set MIN_DRIVER=0 to disable the check.
MIN_DRIVER="${MIN_DRIVER:-${MIN_DRIVER_DEFAULT:-570}}"

# -----------------------------------------------------------------------------
# 0. GPU DRIVER PREFLIGHT. The host NVIDIA driver is NOT upgradable from inside the
#    container, so a too-old driver (common when the scheduler drops a new GPU on a
#    stale host) makes torch fail to init CUDA and ComfyUI crash-loops with a cryptic
#    error. Detect it UP FRONT (before launching ComfyUI) and hold the pod open with a
#    clear "redeploy on a newer host" message instead of looping.
# -----------------------------------------------------------------------------
if [ "${MIN_DRIVER}" != "0" ] && command -v nvidia-smi >/dev/null 2>&1; then
  GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"
  DRV="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)"
  DRV_MAJOR="${DRV%%.*}"
  log "GPU: ${GPU_NAME:-unknown} | driver: ${DRV:-unknown} (this image needs driver >= ${MIN_DRIVER})"
  if [ -n "${DRV_MAJOR}" ] && [ "${DRV_MAJOR}" -lt "${MIN_DRIVER}" ] 2>/dev/null; then
    log "============================================================================"
    log "FATAL: host NVIDIA driver ${DRV} is TOO OLD for this image (needs >= ${MIN_DRIVER})."
    log "  Your ${GPU_NAME:-GPU} (esp. RTX 50xx / Blackwell) needs a newer driver, and the"
    log "  HOST driver CANNOT be upgraded from inside a pod — torch would fail to init CUDA."
    log "  FIX: TERMINATE this pod and REDEPLOY on a host with driver >= ${MIN_DRIVER}"
    log "       (filter by 'CUDA Version' on the RunPod deploy screen). Verify with: nvidia-smi"
    log "  Holding the pod open (no crash-loop) so you can inspect it. Set MIN_DRIVER=0 to bypass."
    log "============================================================================"
    exec sleep infinity
  fi
else
  [ "${MIN_DRIVER}" = "0" ] && log "driver preflight disabled (MIN_DRIVER=0)." \
    || log "WARNING: nvidia-smi not found — skipping GPU driver preflight."
fi

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

# File Browser — web file manager for /workspace (browse/upload/download/delete),
# fronted by nginx on :8083. noauth (parity with code-server --auth none — the
# RunPod proxy URL is the boundary; set FILEBROWSER_PASSWORD for a login). The DB
# is EPHEMERAL (re-init each boot) so it never clutters /workspace.
if command -v filebrowser >/dev/null 2>&1; then
  FB_DB=/var/lib/comfyui-mcp/filebrowser.db
  mkdir -p /var/lib/comfyui-mcp
  rm -f "${FB_DB}"                       # fresh DB each boot (ephemeral, idempotent)
  filebrowser -d "${FB_DB}" config init >>"${LOG_DIR}/filebrowser.log" 2>&1
  filebrowser -d "${FB_DB}" config set --root /workspace >>"${LOG_DIR}/filebrowser.log" 2>&1
  if [ -n "${FILEBROWSER_PASSWORD:-}" ]; then
    filebrowser -d "${FB_DB}" config set --auth.method=json >>"${LOG_DIR}/filebrowser.log" 2>&1
    filebrowser -d "${FB_DB}" users add admin "${FILEBROWSER_PASSWORD}" --perm.admin \
      >>"${LOG_DIR}/filebrowser.log" 2>&1 || true
    log "starting filebrowser on :8082 (nginx front :8083; login admin/\$FILEBROWSER_PASSWORD)…"
  else
    filebrowser -d "${FB_DB}" config set --auth.method=noauth >>"${LOG_DIR}/filebrowser.log" 2>&1
    log "starting filebrowser on :8082 (nginx front :8083; NO auth — set FILEBROWSER_PASSWORD to lock)…"
  fi
  nohup filebrowser -d "${FB_DB}" -r /workspace -a 0.0.0.0 -p 8082 \
    >>"${LOG_DIR}/filebrowser.log" 2>&1 &
else
  log "filebrowser not installed (skip)"
fi

# HuggingFace auth for gated downloads: huggingface_hub (used by ComfyUI + many
# custom nodes) reads HF_TOKEN. Accept our MCP's HUGGINGFACE_TOKEN name as an
# alias so setting EITHER on the pod works. Exported here so the ComfyUI launch
# below (and Manager) inherit it.
export HF_TOKEN="${HF_TOKEN:-${HUGGINGFACE_TOKEN:-}}"
[ -n "${HF_TOKEN}" ] && log "HF_TOKEN present — gated HuggingFace downloads authenticated."

# -----------------------------------------------------------------------------
# 4.5 CUSTOM NODES → the VOLUME (so runtime-installed nodes SURVIVE a restart).
#     The base ComfyUI + venv stay in the image (fast boot), but custom_nodes live
#     on /workspace — the #1 user complaint with a pure image-baked custom_nodes
#     was losing them on stop/start. Mechanism:
#       (a) symlink ${COMFY_HOME}/custom_nodes -> /workspace/custom_nodes, so
#           ComfyUI AND Manager read/write the volume with zero path changes;
#       (b) seed/refresh the image's baked nodes (panel + ComfyUI builtins) into it
#           every boot — image upgrades push a fresh panel while USER nodes persist;
#       (b.1) fast-forward the Agent Panel specifically to its latest release via
#           git, independent of the baked image (see below) — so a panel release
#           reaches pods without waiting for a new image build;
#       (c) reinstall each node's Python deps into the (ephemeral, image) venv from
#           a PERSISTENT pip cache on the volume — required because the venv is in
#           the image: node CODE persists on the volume, its DEPS must be
#           re-materialized into the venv each boot (fast after the first time).
# -----------------------------------------------------------------------------
CN_VOL="${WORKSPACE}/custom_nodes"
CN_LINK="${COMFY_HOME}/custom_nodes"
CN_SEED="${COMFY_HOME}/custom_nodes_seed"
export PIP_CACHE_DIR="${WORKSPACE}/.cache/pip"
mkdir -p "${CN_VOL}" "${PIP_CACHE_DIR}"

# (a) Point the image's custom_nodes at the volume. Replace whatever is there — a
#     real dir on a fresh container, or a stale symlink — with a link to the vol.
if [ ! -L "${CN_LINK}" ] || [ "$(readlink -f "${CN_LINK}")" != "$(readlink -f "${CN_VOL}")" ]; then
  rm -rf "${CN_LINK}"
  ln -s "${CN_VOL}" "${CN_LINK}"
  log "custom_nodes -> ${CN_VOL} (symlinked; installs now persist on the volume)"
fi

# (b) Seed/refresh the baked nodes (panel + builtins) onto the volume. cp -rf
#     overwrites the image-owned copies (keeps them current on an image upgrade)
#     but never deletes the user's OWN nodes already on the volume.
if [ -d "${CN_SEED}" ]; then
  cp -rf "${CN_SEED}/." "${CN_VOL}/" 2>/dev/null \
    && log "seeded/refreshed baked custom_nodes (panel + builtins) onto the volume" \
    || log "WARN: custom_nodes seed refresh had errors (continuing)"
fi

# (b.1) PANEL AUTO-UPDATE — decouples "get the latest Agent Panel" from "wait for
#     a new pod image". (a)+(b) above only refresh the volume from what THIS
#     IMAGE baked at build time; a panel release between image builds otherwise
#     needs a full image rebuild to reach a pod. Since the panel's checkout is a
#     plain git clone (see the Dockerfile), fast-forward it in place before
#     ComfyUI launches (so no restart is needed for the update to take effect —
#     unlike driving this through Manager's install/update API, which only
#     applies on ComfyUI's NEXT launch).
#
#     Skips itself (git symbolic-ref fails) when HEAD is DETACHED — i.e. a build
#     pinned PANEL_REF to a tag/commit for reproducibility, which we must not
#     silently override. Best-effort: any failure (offline pod, rate limit, a
#     force-pushed history) logs a warning and keeps the existing checkout.
PANEL_DIR="${CN_VOL}/comfyui-mcp-panel"
if [ "${PANEL_AUTO_UPDATE}" = "1" ] && [ -d "${PANEL_DIR}/.git" ]; then
  PANEL_BRANCH="$(git -C "${PANEL_DIR}" symbolic-ref -q --short HEAD 2>/dev/null || true)"
  if [ -n "${PANEL_BRANCH}" ]; then
    log "checking for a newer Agent Panel release (branch: ${PANEL_BRANCH})…"
    if git -C "${PANEL_DIR}" fetch --depth 1 origin "${PANEL_BRANCH}" \
         >>"${LOG_DIR}/panel-update.log" 2>&1 \
       && git -C "${PANEL_DIR}" reset --hard "origin/${PANEL_BRANCH}" \
         >>"${LOG_DIR}/panel-update.log" 2>&1; then
      log "Agent Panel up to date: $(git -C "${PANEL_DIR}" rev-parse --short HEAD 2>/dev/null)"
    else
      log "WARN: Agent Panel update check failed — keeping the existing copy (see panel-update.log)"
    fi
  else
    log "Agent Panel checkout is pinned (detached HEAD) — skipping auto-update, as intended"
  fi
elif [ "${PANEL_AUTO_UPDATE}" != "1" ]; then
  log "Agent Panel auto-update disabled (PANEL_AUTO_UPDATE=${PANEL_AUTO_UPDATE})"
fi

# (c) Reinstall custom-node Python deps into the venv from the persistent cache.
#     Runs every boot (the venv is ephemeral); the cache makes it fast. Best-effort
#     per node — a broken requirements.txt must not take the whole pod down.
VPIP="${COMFY_HOME}/venv/bin/pip"
if [ -x "${VPIP}" ]; then
  cn_count=0
  for req in "${CN_VOL}"/*/requirements.txt; do
    [ -f "${req}" ] || continue          # literal glob when no matches → skip
    node_name="$(basename "$(dirname "${req}")")"
    log "custom-node deps: installing ${node_name} requirements…"
    if "${VPIP}" install --no-input --disable-pip-version-check -r "${req}" \
         >>"${LOG_DIR}/custom-node-deps.log" 2>&1; then
      cn_count=$((cn_count + 1))
    else
      log "WARN: deps for ${node_name} failed (see custom-node-deps.log; node may not load)"
    fi
  done
  log "custom-node deps: processed ${cn_count} node requirement set(s) (cache: ${PIP_CACHE_DIR})"
else
  log "WARN: venv pip not found at ${VPIP} — skipping custom-node dep install"
fi

# -----------------------------------------------------------------------------
# 5. Launch ComfyUI from the BAKED venv (image), pointed at the volume dirs.
#    Invoke the venv python by ABSOLUTE PATH (no `activate` needed).
#    Per-directory flags keep user/input/output on /workspace; models come from
#    extra_model_paths.yaml (is_default → volume is primary). custom_nodes are
#    symlinked onto the volume in §4.5 above (so runtime installs persist); we do
#    NOT use --base-directory (it would relocate the whole tree, incl. the venv).
# -----------------------------------------------------------------------------
VPY="${COMFY_HOME}/venv/bin/python"
if [ ! -x "${VPY}" ]; then
  log "FATAL: baked venv python not found at ${VPY} — image build problem."
  log "       Holding pod open for debug (the image software did not bake)."
  exec sleep infinity
fi

COMFY_LOG="${LOG_DIR}/comfyui.log"

# ComfyUI 0.27's sqlite DB defaults to <base>/user/comfyui.db (= ${COMFY_HOME}/user),
# computed from the BASE dir — NOT --user-directory — and that dir isn't in the
# image, so init fails ("unable to open database file"). Create it so the DB
# initializes cleanly (local, ephemeral index; re-created per boot).
mkdir -p "${COMFY_HOME}/user"

# --enable-cors-header is REQUIRED for RunPod-proxy access. ComfyUI's
# origin_only_middleware (server.py) returns 403 for any request whose
# `Sec-Fetch-Site: cross-site` — exactly what a browser sends when it reaches
# ComfyUI THROUGH the RunPod proxy (cross-origin to the proxy domain). That 403s
# the whole UI ("won't render") even though curl (no Sec-Fetch headers) works.
# --enable-cors-header swaps that middleware for the CORS one, letting the
# proxied browser through.
# PERF: attention backend PROBED, not assumed — the cu130 perf variant bakes
# SageAttention 2.2 (+ triton backend) but the default cu128 build ships neither
# (no linux cu128 wheels exist for this torch line). Passing --use-sage-attention
# without the package would crash ComfyUI at startup, so import-check the venv
# and pick the matching flags. Override either way via COMFY_EXTRA_ARGS.
if "${COMFY_HOME}/venv/bin/python" -c "import sageattention" >/dev/null 2>&1; then
  ATTN_ARGS=(--use-sage-attention --enable-triton-backend)
  log "SageAttention baked in this image — launching with --use-sage-attention"
else
  ATTN_ARGS=(--use-pytorch-cross-attention)
  log "no SageAttention in this image (cu128 broad-compat build) — using PyTorch cross-attention"
fi
ARGS=(--listen 0.0.0.0 --port "${COMFY_PORT}"
      --enable-manager --enable-cors-header
      "${ATTN_ARGS[@]}"
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

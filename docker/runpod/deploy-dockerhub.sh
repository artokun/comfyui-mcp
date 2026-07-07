#!/usr/bin/env bash
#
# deploy-dockerhub.sh — gated Docker Hub release for the comfyui-mcp RunPod
# image. Refuses to push anything that hasn't passed test_image.sh (static +
# boot suite), then verifies what the registry ACTUALLY serves post-push.
#
#   ./deploy-dockerhub.sh <version> [<local-image-ref>]
#
#   <version>          e.g. 1.6  (also moves :latest)
#   <local-image-ref>  default: artokun/comfyui-mcp-runpod:build
#
# Typical flow:
#   docker build -t artokun/comfyui-mcp-runpod:build docker/runpod
#   docker/runpod/deploy-dockerhub.sh 1.6
#
# After pushing, PIN THE RUNPOD TEMPLATE to the new VERSION tag (not :latest):
# RunPod hosts cache images per-tag, so a template on :latest can silently serve
# a stale build — a version tag forces every new pod onto the bits you tested.
set -euo pipefail

VERSION="${1:?usage: deploy-dockerhub.sh <version> [<local-image-ref>]}"
SRC="${2:-artokun/comfyui-mcp-runpod:build}"
REPO="artokun/comfyui-mcp-runpod"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[deploy] gate 1/2: test_image.sh (static + boot suite) on ${SRC}…"
"${HERE}/test_image.sh" "${SRC}"

echo "[deploy] tagging ${SRC} -> ${REPO}:${VERSION} + ${REPO}:latest"
docker tag "${SRC}" "${REPO}:${VERSION}"
docker tag "${SRC}" "${REPO}:latest"

echo "[deploy] pushing ${REPO}:${VERSION}…"
docker push "${REPO}:${VERSION}"
echo "[deploy] pushing ${REPO}:latest…"
docker push "${REPO}:latest"

echo "[deploy] gate 2/2: verifying what the registry actually serves…"
PY="$(command -v python3 || command -v python)"
"${PY}" "${HERE}/verify_image_remote.py" "docker.io/${REPO}:${VERSION}"

cat <<EOF
[deploy] DONE: ${REPO}:${VERSION} (+ :latest) pushed and registry-verified.
[deploy] NEXT: pin the RunPod template image to  ${REPO}:${VERSION}
[deploy]       (console.runpod.io -> Templates; do NOT leave it on :latest).
EOF

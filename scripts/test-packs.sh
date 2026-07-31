#!/usr/bin/env bash
# Dry-run validator for every pack's install-runpod.sh (git/curl stubbed — no
# real clones or downloads) plus the LTX kornia fix. Asserts the first run
# stages custom nodes + model files, and a second run is a no-op (idempotent).
# Used by CI (.github/workflows/packs.yml); also runnable locally on any bash
# (Linux / WSL / Git Bash). Set PYTHON to override the interpreter.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKS="$REPO/packs"
PYBIN="${PYTHON:-python3}"
fail=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- stub git + curl so nothing is fetched for real ---
BIN="$WORK/bin"; mkdir -p "$BIN"
cat > "$BIN/git" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "clone" ]; then
  dest=""; for a in "$@"; do dest="$a"; done
  mkdir -p "$dest/.git"; echo "[git] cloned $dest"
fi
exit 0
EOF
cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="${2:-}"; shift 2;; *) shift;; esac; done
if [ -n "$out" ]; then mkdir -p "$(dirname "$out")"; printf stub > "$out"; echo "[curl] wrote $out"; fi
exit 0
EOF
chmod +x "$BIN/git" "$BIN/curl"

for dir in "$PACKS"/*/; do
  sh="${dir%/}/install-runpod.sh"
  [ -f "$sh" ] || continue
  name="$(basename "$dir")"
  root="$WORK/$name"; mkdir -p "$root/custom_nodes" "$root/models"

  echo "== $name: first run =="
  ( cd "$root" && PATH="$BIN:$PATH" bash "$sh" ) > "$WORK/r1.log" 2>&1
  nodes=$(find "$root/custom_nodes" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
  models=$(find "$root/models" -type f | wc -l | tr -d ' ')
  # Expected node count is derived from the generated installer itself (one
  # `clone` invocation per custom_nodes entry). A pack may legitimately declare
  # zero custom nodes (all nodes native to core ComfyUI) — assert the installer
  # staged exactly what it declares rather than a blanket >=1.
  want_nodes=$(grep -cE '^clone ' "$sh" || true)
  echo "   nodes=$nodes/$want_nodes models=$models"
  if [ "$nodes" -ne "$want_nodes" ] || [ "$models" -lt 1 ]; then
    echo "   [FAIL] expected $want_nodes node(s) and >=1 model staged"; fail=1
  fi

  echo "== $name: second run (idempotency) =="
  ( cd "$root" && PATH="$BIN:$PATH" bash "$sh" ) > "$WORK/r2.log" 2>&1
  redo=$(grep -cE '^\[(git|curl)\]' "$WORK/r2.log" || true)
  if [ "$redo" -ne 0 ]; then
    echo "   [FAIL] second run re-did $redo actions (expected 0)"; fail=1
  else
    echo "   OK no-op"
  fi
done

# --- LTX kornia fix ---
fix="$PACKS/ltx-2.3/fix-ltxvideo-kornia.sh"
if [ -f "$fix" ]; then
  echo "== ltx-2.3 kornia fix =="
  ltx="$WORK/kornia/custom_nodes/ComfyUI-LTXVideo"; mkdir -p "$ltx"
  cat > "$ltx/pyramid_blending.py" <<'EOF'
import torch
import torch.nn.functional as F
from kornia.geometry.transform.pyramid import (
    build_pyramid,
    pad,
    upscale_double,
)
EOF
  ( cd "$WORK/kornia" && PYTHON="$PYBIN" bash "$fix" ) > /dev/null
  if ! grep -q 'pad = F.pad' "$ltx/pyramid_blending.py"; then
    echo "   [FAIL] pad = F.pad not added"; fail=1
  fi
  if grep -qE '^[[:space:]]*pad,[[:space:]]*$' "$ltx/pyramid_blending.py"; then
    echo "   [FAIL] broken kornia pad import still present"; fail=1
  fi
  ( cd "$WORK/kornia" && PYTHON="$PYBIN" bash "$fix" ) > /dev/null  # must be idempotent
  echo "   OK"
fi

if [ "$fail" -ne 0 ]; then echo "PACK TESTS FAILED"; exit 1; fi
echo "ALL PACK TESTS PASSED"

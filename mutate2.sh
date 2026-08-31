#!/usr/bin/env bash
# Mutation battery, round 2 -- against the post-codex-revision implementation.
# Each mutation is applied ALONE, tests run, tree restored from the commit.
set -u
H=src/services/workflow-health.ts
V=src/tools/workflow-validate.ts
FILES="src/__tests__/services/workflow-health.test.ts src/__tests__/services/workflow-validator.test.ts src/__tests__/tools/workflow-validate-render.test.ts"

run() {
  local name="$1"
  local out code line
  out=$(npx vitest run $FILES 2>&1); code=$?
  line=$(printf '%s\n' "$out" | grep -E "^ +Tests +" | tail -1)
  echo "### $name"
  echo "    exit=$code | $line"
  printf '%s\n' "$out" | grep -E "^ +[x×] " | sed 's/^/    /' | head -12
  git checkout -- "$H" "$V" 2>/dev/null
}

echo "=== BASELINE ==="
run "baseline (all mutations reverted)"

python - <<'PY'
import io
p="src/services/workflow-health.ts"; s=io.open(p,encoding="utf-8").read()
i=s.index("  // --- 6. Partial denoise fed by an empty latent"); j=s.index("  // --- Summary ---")
io.open(p,"w",encoding="utf-8",newline="").write(s[:i]+s[j:]); print("M1 applied")
PY
run "M1 delete the entire heuristic"

# M2: the exact regression codex caught -- revert to the naive threshold.
python - <<'PY'
import io
p="src/services/workflow-health.ts"; s=io.open(p,encoding="utf-8").read()
old="""  if (typeof steps !== "number" || !Number.isFinite(steps) || steps <= 0) return false;
  // Python's int() truncates toward zero; both operands are positive here.
  return Math.trunc(steps / denoise) > steps;"""
new="""  return true;"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="").write(s.replace(old,new)); print("M2 applied")
PY
run "M2 naive denoise<=0.9999, ignoring steps (the codex finding)"

# M3: off-by-one in the truncation comparison.
python - <<'PY'
import io
p="src/services/workflow-health.ts"; s=io.open(p,encoding="utf-8").read()
old="  return Math.trunc(steps / denoise) > steps;"
new="  return Math.trunc(steps / denoise) >= steps;"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="").write(s.replace(old,new)); print("M3 applied")
PY
run "M3 truncation comparison >= instead of >"

# M4: drop the denoise<=0 empty-schedule case.
python - <<'PY'
import io
p="src/services/workflow-health.ts"; s=io.open(p,encoding="utf-8").read()
old="  if (denoise <= 0) return true;"
new="  if (denoise <= 0) return false;"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="").write(s.replace(old,new)); print("M5 applied")
PY
run "M4 denoise<=0 no longer treated as degenerate"

# M5: name-only empty check -- drop the "consumes no links" requirement.
python - <<'PY'
import io
p="src/services/workflow-health.ts"; s=io.open(p,encoding="utf-8").read()
old="  return !Object.values(node.inputs ?? {}).some(isConnection);"
new="  return true;"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="").write(s.replace(old,new)); print("M5 applied")
PY
run "M5 empty-latent source no longer required to be link-free"

# M6: narrow the family regex.
python - <<'PY'
import io
p="src/services/workflow-health.ts"; s=io.open(p,encoding="utf-8").read()
old="const EMPTY_LATENT_RE = /^Empty[A-Za-z0-9_]*Latent/i;"
new="const EMPTY_LATENT_RE = /^EmptyLatentImage$/;"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="").write(s.replace(old,new)); print("M6 applied")
PY
run "M6 regex narrowed to EmptyLatentImage only"

# M7: drop the literal-widget guard.
python - <<'PY'
import io
p="src/services/workflow-health.ts"; s=io.open(p,encoding="utf-8").read()
old='    if (typeof denoise !== "number" || !Number.isFinite(denoise)) continue;'
new='    if (denoise === undefined) continue;'
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="").write(s.replace(old,new)); print("M7 applied")
PY
run "M7 literal-widget guard removed"

# M8: drop the empty-latent source check entirely (breaks the FP controls).
python - <<'PY'
import io
p="src/services/workflow-health.ts"; s=io.open(p,encoding="utf-8").read()
old="    if (!producesEmptyLatent(sourceNode)) continue;"
new="    if (!sourceNode) continue;"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="").write(s.replace(old,new)); print("M8 applied")
PY
run "M8 empty-latent source check removed"

# M9: revert the renderer verdict-line fix.
python - <<'PY'
import io
p="src/tools/workflow-validate.ts"; s=io.open(p,encoding="utf-8").read()
i=s.index("        ? healthWarnings > 0"); j=s.index('        : "No errors were surfaced')
io.open(p,"w",encoding="utf-8",newline="").write(s[:i]+'        ? "No issues found. The workflow is ready to execute."\n'+s[j:])
print("M9 applied")
PY
run "M9 renderer verdict-line fix reverted"

echo "=== FINAL TREE STATE ==="
git status --porcelain

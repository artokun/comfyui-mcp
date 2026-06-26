---
name: triton-sageattention
description: Install Triton + SageAttention to accelerate ComfyUI (the sageattn attention_mode and inductor torch.compile used by WanVideoWrapper / many video graphs) — Windows-first (triton-windows + woct0rdho prebuilt SageAttention wheels matched to torch/CUDA/python into the RIGHT python), plus Linux (official triton + build) and Mac (N/A → sdpa/MPS). Critically also covers the SAFE sdpa / no-compile fallback so an example that assumes sageattn + torch.compile still runs when these aren't installed (video-extend TRAP 5). Use when a loader crashes with "No module named 'sageattention'" / "triton: unavailable", when asked to speed up Wan/video workflows, or when deciding whether to install acceleration vs. fall back.
globs:
  - "**/*.json"
  - "**/packs/**"
---

# Triton + SageAttention (ComfyUI acceleration)

## Overview

Two **optional accelerators** that many modern video graphs (especially kijai's
**ComfyUI-WanVideoWrapper**) reference by default:

- **SageAttention** (`import sageattention`) — a quantized attention kernel.
  Selected via a node's `attention_mode = sageattn` (WanVideoWrapper) or ComfyUI's
  `--use-sage-attention` startup flag. ~20–40% faster sampling on supported NVIDIA
  GPUs.
- **Triton** — the GPU kernel compiler that **inductor `torch.compile`** needs.
  WanVideoWrapper's `WanVideoTorchCompileSettings` (and any `torch.compile`/
  inductor node) compiles the model through Triton for another speedup.

> ⚠️ **The risk.** Both are **version-locked to your exact torch + CUDA + python**.
> A wrong wheel doesn't just fail to install — it can **break the torch install**
> (mismatched CUDA DLLs, `ImportError`, or silent NaNs). And the *failure mode of
> not having them* is a **hard crash before any sampling**:
> `ValueError: Can't import SageAttention: No module named 'sageattention'`, or
> compile errors / `triton: unavailable` in the startup log. This is exactly the
> [`video-extend`](../video-extend/SKILL.md) **TRAP 5**.

> ✅ **Therefore the default is: get a working render FIRST with the
> [sdpa / no-compile fallback](#the-safe-sdpa--no-compile-fallback-do-this-first),
> then OFFER to install acceleration for speed.** Never silently run a
> torch-breaking install to "fix" a workflow — fall back, render, *then* ask.

> ⚠️ **Verification note (June 2026).** Wheel sources, the triton↔torch table, and
> the live `attention_mode` enum below were verified against
> `woct0rdho/triton-windows`, `woct0rdho/SageAttention` releases, and
> WanVideoWrapper's nodes (see [Sources](#sources)). Versions move fast — **always
> re-read the live torch/CUDA/python first** (commands below) and pick the wheel
> that matches; flag anything you can't confirm rather than guessing.

---

## Decide first: do you even need them?

```
Workflow crashes "No module named 'sageattention'"  ──┐
  or "triton: unavailable" / torch.compile error     ─┤
                                                       ▼
              1. APPLY THE SDPA / NO-COMPILE FALLBACK  → render works now
                                                       ▼
              2. OFFER acceleration:
                 "Want me to install Triton + SageAttention for ~20–40%
                  faster sampling? It's a version-matched install that
                  touches your torch env — I'll verify torch/CUDA/python
                  first and can roll back."
                                                       ▼
              3. Only on YES → install per-OS below → verify → re-enable
                 sageattn + torch.compile in the workflow.
```

Mac (no CUDA): **skip the install entirely**, the answer is always sdpa/MPS.

---

## The safe sdpa / no-compile fallback (DO THIS FIRST)

When Triton/SageAttention aren't installed, make the workflow run **unaccelerated
but correct** by switching attention to **sdpa** (PyTorch's built-in scaled
dot-product attention — always available, no extra deps) and removing the
`torch.compile`/inductor wiring.

**WanVideoWrapper (the common case):**

1. On **every** `WanVideoModelLoader` set `attention_mode` → **`sdpa`**.
   - Confirmed enum values: `sdpa`, `flash_attn_2`, `flash_attn_3`, `sageattn`,
     `sparse_sage_attention`. The examples ship with `sageattn`; `sdpa` is the
     universal safe one.
2. **Disconnect `WanVideoTorchCompileSettings`** from each loader's `compile_args`
   input (or delete/bypass the node). No compile = no Triton needed.
3. (If present) bypass any `WanVideoSetRadialAttention` /
   `sparse_sage_attention` node — those also route through SageAttention.

**Generic ComfyUI:** don't launch with `--use-sage-attention`; bypass any
`TorchCompileModel` / inductor node.

This costs you speed, not quality. Use `modify_workflow` / the panel's
strip-and-re-point flow to flip the widget and drop the link, then enqueue. Once
it renders, offer the install.

> Cross-ref: [`video-extend`](../video-extend/SKILL.md) documents this exact fix
> as TRAP 5 for the Pusa extension graph (both `WanVideoModelLoader`s →
> `attention_mode=sdpa`, disconnect `WanVideoTorchCompileSettings`).

---

## Windows install (the priority)

Windows has **no official Triton or SageAttention build**. You use community
prebuilt wheels, and **they must match torch + CUDA + python exactly**. The panel
agent has a shell (Bash for Claude / `exec` for Codex) — use it to run these in
the **correct python**, never the system `python`.

### Step 1 — find the RIGHT python (NOT system python)

ComfyUI on Windows comes in three flavors; each has its own python whose `pip` you
must target:

| Variant | Where its python lives | How to invoke pip |
|---|---|---|
| **Desktop (standalone)** | a `standalone-env\` (or `venv`) beside the install, e.g. `C:\Users\<you>\ComfyUI-Installs\ComfyUI\standalone-env\python.exe` | `"<install>\standalone-env\python.exe" -m pip ...` |
| **Portable** | `ComfyUI_windows_portable\python_embeded\python.exe` | `"<...>\python_embeded\python.exe" -m pip ...` |
| **Manual venv** | the venv you created (`venv\Scripts\python.exe`) | activate it, then `python -m pip ...` |

Detect it from the **live server** — the surest way to hit the same python ComfyUI
runs on:

- `get_environment` / `get_system_stats` report `embedded_python` (true →
  Portable), the python version and the `pytorch_version` (e.g. `2.10.0+cu130`).
- Inspect the running process's `argv` (from `get_system_stats`) — the path to
  `main.py` reveals the install root; its sibling `standalone-env` / `python_embeded`
  holds the python.
- Last resort, ask the user for their ComfyUI folder.

> ⚠️ Installing into the wrong python (e.g. a global `pip install`) is the #1
> Windows mistake: the package lands somewhere ComfyUI never imports from, so the
> loader still crashes "No module named 'sageattention'". Always use
> `"<that python>" -m pip`.

### Step 2 — read the installed torch + CUDA + python

Run with the python you just found:

```bash
"<python>" -c "import sys, torch; print(sys.version.split()[0], torch.__version__, torch.version.cuda)"
```

Example live output on this machine: `3.13.12 2.10.0+cu130 13.0` →
**python 3.13, torch 2.10, CUDA line cu130**. You'll pick wheels for that triple.

### Step 3 — install **triton-windows** (matched to torch)

Source: **`woct0rdho/triton-windows`** (the canonical Windows Triton fork; also on
PyPI as `triton-windows`). The pin is just an upper bound — pip resolves the right
build for your torch:

```bash
"<python>" -m pip install -U "triton-windows<3.7"
```

**Why `<3.7`:** each torch minor pins a Triton minor. Verified table:

| PyTorch | triton-windows | constraint to use |
|---|---|---|
| 2.7 | 3.3 | `"triton-windows<3.4"` |
| 2.8 | 3.4 | `"triton-windows<3.5"` |
| 2.9 | 3.5 | `"triton-windows<3.6"` |
| **2.10** | **3.6** | **`"triton-windows<3.7"`** |

(torch 2.6 or older → triton 3.2 or earlier.) Pick the row for *your* torch.

- **CUDA toolkit:** since `triton-windows 3.2.0.post11` a minimal CUDA toolchain
  is **bundled in the wheel** — you do NOT need a separate CUDA Toolkit install for
  Triton itself. (Triton 3.3–3.6 bundle the CUDA 12.8 line; works against cu12x/
  cu13x torch.)
- **MSVC / vcredist:** Triton compiles C++ at runtime, so it needs the **MSVC
  toolchain + "Visual C++ Redistributable 2015–2022"** present. A TinyCC is
  bundled (since 3.2.0.post13) which covers many cases, but installing the
  **Visual Studio Build Tools (C++ workload)** + latest vcredist is the reliable
  fix if you hit compiler errors (see Traps).
- **Embedded/Portable python only:** the embedded distro ships without C headers,
  so Triton can't compile. Download the matching `python_<ver>_include_libs.zip`
  from the triton-windows releases and copy its **`include`** and **`libs`**
  (note: `libs`, not `lib`) folders into `python_embeded\`. The Desktop
  `standalone-env` usually already has these.

### Step 4 — install **SageAttention** (prebuilt wheel, matched to torch+CUDA)

**Strongly prefer the prebuilt wheel** — building from source needs the full CUDA
Toolkit (`nvcc`) + MSVC and frequently fails on Windows. Source:
**`woct0rdho/SageAttention` releases** (Windows wheels; v2 = SageAttention 2.x).

Latest verified tag: **`v2.2.0-windows.post5`**, with these four wheels (all
`cp310-abi3` → work on **python 3.10 through 3.13+** via the stable ABI; one wheel
covers all those pythons):

| Wheel filename | For |
|---|---|
| `sageattention-2.2.0+cu128torch2.9.1.post5-cp310-abi3-win_amd64.whl` | CUDA 12.8 line, torch 2.9.x |
| `sageattention-2.2.0+cu128torch2.10.0andhigher.post5-cp310-abi3-win_amd64.whl` | CUDA 12.8 line, torch ≥2.10 |
| `sageattention-2.2.0+cu130torch2.9.1.post5-cp310-abi3-win_amd64.whl` | CUDA 13.0 line, torch 2.9.x |
| `sageattention-2.2.0+cu130torch2.10.0andhigher.post5-cp310-abi3-win_amd64.whl` | **CUDA 13.0 line, torch ≥2.10** |

Pick by your **CUDA line** (`cu128` vs `cu130` — from `torch.version.cuda`: `12.8`
→ cu128, `13.0` → cu130) and **torch minor**. For the live machine above
(torch 2.10.0+cu130, py3.13) → the **last** wheel. Install by full URL:

```bash
"<python>" -m pip install "https://github.com/woct0rdho/SageAttention/releases/download/v2.2.0-windows.post5/sageattention-2.2.0+cu130torch2.10.0andhigher.post5-cp310-abi3-win_amd64.whl"
```

- The `cpXXX-abi3` tag means **one wheel works across python ≥ its base** (3.10+),
  so py3.13 is covered even though there's no `cp313`-specific wheel — this is
  expected, not a mismatch.
- **Always check the releases page for a newer tag** than `.post5` and newer torch
  variants — the filename pattern is stable (`+cu<line>torch<minor>...abi3`).
- **Don't build from source** unless no wheel matches your torch/CUDA at all (then
  you need CUDA Toolkit + MSVC; flag the cost to the user first).

### Step 5 — verify (Windows)

```bash
"<python>" -c "import triton; print('triton', triton.__version__)"
"<python>" -c "import sageattention; print('sageattention OK')"
"<python>" -c "import torch; print('torch still ok', torch.__version__, torch.cuda.is_available())"
```

All three must succeed **and torch must still import with CUDA** — if the third
line now fails, the install clobbered torch (see Traps → roll back). Then restart
ComfyUI and confirm the startup log no longer prints `Could not load
sageattention` / `triton: unavailable`. Finally re-enable in the workflow:
`WanVideoModelLoader.attention_mode = sageattn` and reconnect
`WanVideoTorchCompileSettings`, enqueue, and confirm it samples (a torch.compile
node will spend extra time on the **first** run compiling — that's normal).

---

## Linux install

Official builds exist here — much simpler:

```bash
# Triton: official, pip-installable; torch usually already pulls a matching triton.
pip install -U triton          # or let torch's pinned triton stand; match torch minor

# SageAttention: pip, or build from source for your GPU arch
pip install sageattention      # if a matching wheel exists for your torch/CUDA
```

- **Use the python that runs ComfyUI** (its venv/conda env) — same rule as Windows.
- **Version matching still applies:** torch pins a triton minor (e.g. torch 2.9.x
  ↔ triton 3.5.x, torch 2.10 ↔ 3.6); patch versions within a minor are
  interchangeable. Don't `pip install triton` blindly if it would upgrade past
  what your torch pins.
- **Build deps (if building SageAttention from source):** the **CUDA Toolkit with
  `nvcc`** (matching your torch CUDA line), `gcc/g++`, and the torch headers. If
  CUDA is in a nonstandard path, `export PATH=/usr/local/cuda-<ver>/bin:$PATH` so
  the right `nvcc` is found. Building is GPU-arch specific and slow — prefer a
  matching prebuilt wheel when one exists.
- Verify exactly as in Windows Step 5 (`import triton`, `import sageattention`,
  torch still imports with CUDA).

---

## Mac

**Triton and SageAttention are N/A on Mac — there is no CUDA.** Do not attempt to
install them. Use **PyTorch sdpa** attention (the fallback above is the permanent
answer), which on Apple Silicon runs on the **MPS** backend. Set any
`attention_mode` to `sdpa`, never load `torch.compile`/inductor (Triton) nodes,
and run unaccelerated. If a workflow hard-requires `sageattn`, edit it to `sdpa`
rather than trying to satisfy the dependency.

---

## Verification checklist (any OS)

1. `import triton` succeeds and prints a version matching your torch (table above).
2. `import sageattention` succeeds.
3. **torch STILL imports** and `torch.cuda.is_available()` is `True` (the install
   didn't break the env).
4. ComfyUI startup log: no `Could not load sageattention`, no `triton: unavailable`.
5. In the graph: `attention_mode = sageattn` loads without the `No module named
   'sageattention'` ValueError; a `torch.compile`/`WanVideoTorchCompileSettings`
   node completes its (slow) first-run compile and then samples.
6. A real render completes and looks correct (SageAttention can rarely introduce
   NaN/noise on some GPUs — if output degrades vs. sdpa, fall back to sdpa).

---

## Traps

- **Wrong python / global pip.** Installing into system python (or the wrong
  venv) means ComfyUI never imports it — the loader still crashes. Always
  `"<that exact python>" -m pip`; for Portable that's `python_embeded\python.exe`,
  for Desktop the `standalone-env\python.exe`. Verify with `pip show sageattention`
  run by *that* python.
- **torch / CUDA / python wheel mismatch breaks torch.** Installing a `cu128` wheel
  on a `cu130` torch (or a torch2.9 wheel on torch2.10) can drag in mismatched CUDA
  DLLs and break `import torch` itself, or surface as a runtime DLL error. Match
  `cu128`↔`12.x` / `cu130`↔`13.0` and the torch minor exactly. **Pin and verify:**
  before installing, record `pip freeze | grep -i torch`; after, confirm torch
  still imports with CUDA. If broken, **roll back** (`pip install
  torch==<old>+cu<line> --index-url https://download.pytorch.org/whl/cu<line>`,
  or uninstall the bad wheel) and re-apply the sdpa fallback.
- **MSVC missing (Windows Triton).** `torch.compile`/Triton errors like "Microsoft
  Visual C++ ... required", `cl.exe not found`, or `PY_SSIZE_T_CLEAN`/DLL load
  failures usually mean no MSVC toolchain. Install **Visual Studio Build Tools (C++
  workload)** + the latest **"Visual C++ Redistributable 2015–2022"**; copying
  `msvcp140.dll`/`vcruntime140*.dll` into the python folder is the documented
  last-resort fix.
- **Embedded python has no headers.** Portable's `python_embeded` lacks
  `include`/`libs`, so Triton can't compile and `torch.compile` fails. Copy the
  matching `python_<ver>_include_libs.zip` `include` + **`libs`** (not `lib`)
  folders from the triton-windows releases into `python_embeded\`.
- **py3.13 "no wheel" panic.** SageAttention's Windows wheels are `cp310-abi3` —
  one wheel covers **py3.10–3.13+**. The absence of a `cp313` filename is *normal*;
  do not conclude "no wheel for 3.13." (Source builds, by contrast, can genuinely
  lag on the newest python — another reason to use the abi3 wheel.) Triton-windows
  does ship py3.13-specific builds.
- **CUDA line confusion.** `torch.version.cuda` is the source of truth: `12.8` →
  pick `cu128` wheels, `13.0` → `cu130`. Don't read the *system* CUDA driver
  version — match what **torch** was built against.
- **"Install can break torch."** Treat every acceleration install as risky to the
  env: get a working sdpa render first, capture the torch version, install,
  re-verify torch, and be ready to roll back. Never leave the user with a broken
  torch and no render.
- **SageAttention numerical artifacts.** On some GPUs (reported on H100/Hopper)
  `sageattn` produces noise that `sdpa` doesn't. If a render looks worse than the
  sdpa version, switch that workflow back to `sdpa` — correctness over speed.
- **First torch.compile run is slow.** Inductor compiles on the first sample
  (tens of seconds to minutes); that's expected, not a hang. Subsequent runs are
  fast. Don't "fix" it by ripping out compile unless it actually errors.

---

## See also

- [`video-extend`](../video-extend/SKILL.md) — **TRAP 5** is the canonical
  example: the Pusa graph ships with `attention_mode=sageattn` +
  `WanVideoTorchCompileSettings`; this skill is how you either satisfy or safely
  fall back from that. Read its TRAP 5 for the exact node-by-node sdpa fix.
- [`troubleshooting`](../troubleshooting/SKILL.md) — "Torch / CUDA Version Errors"
  and "Missing Nodes" sections for diagnosing a torch env that an install broke.
- [`installer-packs`](../installer-packs/SKILL.md) — packs note SageAttention/
  Triton requirements in `pack.yaml` `notes`/`post_install`; acceleration is an
  opt-in post-install step, never baked into a model download.

## Sources

Verified June 2026 against:

- **triton-windows** — `github.com/woct0rdho/triton-windows` (install command
  `pip install -U "triton-windows<3.7"`, the torch↔triton table, bundled CUDA
  toolchain, MSVC/vcredist + embedded `include`/`libs` requirements).
- **SageAttention Windows wheels** — `github.com/woct0rdho/SageAttention/releases`
  tag `v2.2.0-windows.post5` (the four `cu128/cu130 × torch2.9.1/2.10 cp310-abi3`
  filenames; import name `sageattention`).
- **WanVideoWrapper** — kijai `ComfyUI-WanVideoWrapper` nodes: `attention_mode`
  enum `{sdpa, flash_attn_2, flash_attn_3, sageattn, sparse_sage_attention}` and
  the `No module named 'sageattention'` loader crash.
- **Live env** — `get_environment`/`get_system_stats` on this machine:
  py3.13.12, torch 2.10.0+cu130, RTX 4090, Desktop standalone (non-embedded).

**Unverified / caveats:** the exact `.post` suffix and any newer torch variant
will drift — re-check the releases page for a tag past `.post5` and a wheel for
your torch minor before installing. Linux `pip install sageattention` wheel
availability depends on your torch/CUDA combo; if no wheel matches, building needs
CUDA Toolkit + nvcc (flag the cost). Always confirm the chosen wheel's
`cu<line>`/`torch<minor>` against the live `torch.__version__`/`torch.version.cuda`
rather than trusting this doc's pinned examples.

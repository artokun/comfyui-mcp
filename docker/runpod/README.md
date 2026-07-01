# comfyui-mcp RunPod image — PERSISTENT-ON-VOLUME (auto-updating software)

A RunPod image that boots **ready to be driven by the
[comfyui-mcp](https://github.com/artokun/comfyui-mcp) Agent Panel**. Deploy on
RunPod, run **one local command** on your laptop, and the agent drives the pod's
live ComfyUI graph from your Claude/ChatGPT subscription.

Everything durable lives **on the network volume** and is **run from there**.
The image ships a pristine **seed** of the whole ComfyUI tree — ComfyUI + its
venv + `comfyui_manager` v2 + the Agent Panel custom node — at
`/opt/ComfyUI-seed`. On the **first** boot the entrypoint copies that seed to
`/workspace/ComfyUI` (a slow, one-time, multi-GB `rsync` to the network drive).
On **every boot after** there is **no copy**: it `git pull`s ComfyUI + the panel,
re-`pip install`s only when a requirements file actually changed, and launches
ComfyUI **from the volume venv** (warm restart ~**20-40s**).

The point of living on the volume: **custom nodes the agent or Manager install at
runtime — and their pip dependencies, which land in the venv — survive a
stop/start**, and ComfyUI/Manager/panel can auto-update in place. See
[The persistent-on-volume model](#the-persistent-on-volume-model-what-changed-and-why).

---

## TL;DR

1. **Build & push** the image (a machine with Docker; no GPU needed).
   See [Build & push](#build--push).
2. **Deploy** on RunPod: GPU pod (e.g. RTX 5090), **expose HTTP 3000**, attach a
   **network volume at `/workspace`**. See [Deploy on RunPod](#deploy-on-runpod).
3. On your laptop:
   ```bash
   npx -y comfyui-mcp connect https://<pod-id>-3000.proxy.runpod.net
   ```
4. Open the pod's ComfyUI, open the **Agent Panel** sidebar, enable the
   external-orchestrator toggle, hit **Connect**, and drive the graph in natural
   language.

The agent's brain (the **panel orchestrator**) runs **locally on your machine**
on your own subscription — see [Topology](#topology-where-the-agent-runs).

> The image has been **built and boot-tested locally on an RTX 4090** (cu128
> torch, ComfyUI 0.26.x, Manager v2 `/v2/manager/queue/status` → 200).

---

## The persistent-on-volume model (what changed and why)

A previous design **baked** ComfyUI + its venv + Manager + the panel into the
immutable image at `/opt/ComfyUI` and ran from there, with `/workspace` holding
**only** data. That booted fast (~7s), but custom nodes installed at runtime —
and their venv dependencies — were **lost on the next restart**, leaving installed
nodes present-but-broken.

This design **inverts** that: the software lives on the volume and is run from
there.

| Concern | Where it lives | Persists a restart? |
|---------|----------------|---------------------|
| ComfyUI install + venv | **volume** `/workspace/ComfyUI` (+ `/venv`) — git, auto-updated | **Yes** |
| `custom_nodes` (incl. Agent Panel, Manager v2 pip pkg) | **volume** `/workspace/ComfyUI/custom_nodes` (+ venv deps) | **Yes** |
| `user/` (workflows + settings + Manager config) | **volume** `/workspace/user` | **Yes** |
| `models/` (incl. Manager downloads) | **volume** `/workspace/models` | **Yes** |
| `input/` | **volume** `/workspace/input` | **Yes** |
| `output/` | **volume** `/workspace/output` | **Yes** |
| Caches (HF / pip / torch) | **container** ephemeral disk | No — ephemeral |
| pristine **seed** of the ComfyUI tree | **image** `/opt/ComfyUI-seed` | n/a (re-pulled with the image; only used to seed an empty volume) |

* **FIRST boot (empty volume):** the entrypoint `rsync`s the seed
  `/opt/ComfyUI-seed` → `/workspace/ComfyUI` (the app + venv + custom_nodes).
  Slow, one-time, multi-GB to the network drive. `rsync` resumes a partial copy
  idempotently, so an interrupted first boot just continues where it left off.
* **EVERY boot after:** **no copy.** `git pull --ff-only` on `/workspace/ComfyUI`
  (ComfyUI) and on `/workspace/ComfyUI/custom_nodes/comfyui-mcp-panel` (the
  panel), re-`pip install` **only** when a requirements file's sha256 changed
  (markers under `/workspace/ComfyUI/.autoupdate/`), then launch from the
  **volume venv**.

### ✅ The tradeoff (read this — it's the inverse of the old one)

Custom nodes the agent/Manager install at runtime **DO persist**, together with
their pip dependencies in the venv, and ComfyUI/Manager/panel **auto-update in
place**. The price you pay for that:

* **Slower first boot.** The one-time seed copy is a multi-GB `rsync` to the
  network drive.
* **Slower warm restart (~20-40s)** vs. the old ~7s baked boot. ComfyUI now runs
  off the network drive, and each boot does a fast (usually no-op) `git pull` +
  sha-checked pip step before launch.
* **More volume space.** The whole app + venv now live on the network volume, not
  just your data.

Models persist too — Manager's install-model writes to `/workspace/models` via
`extra_model_paths.yaml` (`is_default: true`), so downloads survive restarts.

---

## Architecture (multi-stage)

```
ARG BASE_IMAGE = runpod/pytorch:1.0.7-cu1281-torch280-ubuntu2404   (lean, recent)
ARG RUNPOD_SRC_IMAGE = aitrepreneur/comfyui:2.3.5                  (donor only)

┌─ STAGE A: runpod-src ───────────────────────────────────────────────┐
│  FROM aitrepreneur/comfyui:2.3.5                                     │
│  (built only so the final stage can COPY service artifacts out of it)│
└─────────────────────────────────────────────────────────────────────┘
┌─ spotcheck-0 / spotcheck-1 (alpine) ─ ARG-gated SDXL model carrier ──┐
│  spotcheck-1 = ADD sd_xl_base_1.0.safetensors ; spotcheck-0 = empty  │
└─────────────────────────────────────────────────────────────────────┘
┌─ FINAL: FROM ${BASE_IMAGE} ─────────────────────────────────────────┐
│  apt: git cron rsync nodejs … ; install code-server                 │
│  git clone ComfyUI (master) -> /opt/ComfyUI-seed   (SEED, not run)  │
│  python -m venv --copies /opt/ComfyUI-seed/venv                     │
│    pip cu128 torch/vision/audio  (NO xformers)                      │
│    pip -r requirements.txt ; pip comfyui_manager==4.2.2           │
│    rm classic custom_nodes/ComfyUI-Manager                          │
│  git clone comfyui-mcp-panel -> /opt/ComfyUI-seed/custom_nodes/…    │
│  COPY extra_model_paths.yaml -> /opt/ComfyUI-seed/…                  │
│  COPY config.ini -> /opt/config.ini.seed   (Manager gate template)  │
│  COPY --from=spotcheck-src  -> /opt/ComfyUI-seed-models             │
│  COPY --from=runpod-src  runpod-uploader, croc, /app-manager        │
│  COPY nginx.conf (:3000->:3001), starting.html, post_start.sh       │
│  (no ENTRYPOINT/CMD override — keep the base's /start.sh chain)     │
└─────────────────────────────────────────────────────────────────────┘
```

The seed at `/opt/ComfyUI-seed` is **never run from directly** — it exists only
to populate `/workspace/ComfyUI` on the first boot.

### Boot sequence (what runs, in order)

The base image's `CMD` is **`/start.sh`** (from `runpod/containers`). On boot it:

1. `service nginx start` — reads our `/etc/nginx/nginx.conf` (**:3000 → :3001**,
   websocket-aware, with the "starting" fallback page).
2. runs `/pre_start.sh` if present (we ship none).
3. `setup_ssh` — injects RunPod's `$PUBLIC_KEY` and starts sshd.
4. `start_jupyter` — starts JupyterLab on **:8888** if `$JUPYTER_PASSWORD` is set.
5. runs **our `/post_start.sh`** — `mkdir` the volume data dirs; **first-boot**
   `rsync` of the seed onto the volume (skipped on later boots); **auto-update**
   (git pull + sha-checked pip) on later boots; assert the Manager gate; start the
   ancillary services; and **launch ComfyUI from the volume venv**.
6. `sleep infinity` — keeps the pod alive.

So SSH + Jupyter + nginx come from the base; **our hook adds everything else**.

`/post_start.sh` keys "first boot" off the **volume venv python**: if
`/workspace/ComfyUI/venv/bin/python` is missing or non-executable, the volume copy
is absent or incomplete, so it (re-)runs the `rsync`. On later boots that python
exists, so it skips straight to the auto-update + launch path. The script is
best-effort throughout (`set +e` semantics) and ends by `exec tail -F`-ing the
ComfyUI log to hold the pod open regardless of later crashes.

---

## ComfyUI launch command (the exact flags)

`/post_start.sh` launches (from `cd /workspace/ComfyUI`, with the **volume** venv
python):

```bash
/workspace/ComfyUI/venv/bin/python main.py \
  --listen 0.0.0.0 --port 3001 \
  --enable-manager \
  --use-pytorch-cross-attention \
  --user-directory   /workspace/user \
  --input-directory  /workspace/input \
  --output-directory /workspace/output \
  --extra-model-paths-config /workspace/ComfyUI/extra_model_paths.yaml
```

* **`--user-directory /workspace/user`** — workflows, ComfyUI settings, AND the
  Manager config (see [Manager gate](#manager-remote-install-gate)) on the volume.
* **`--input-directory` / `--output-directory`** — inputs and generated images on
  the volume.
* **`--extra-model-paths-config`** — points every model category at
  `/workspace/models` (see below). Models persist on the volume.
* **`custom_nodes` are NOT redirected.** They live in
  `/workspace/ComfyUI/custom_nodes` — ComfyUI's **default** location, which is now
  on the volume — so they persist with no extra flag.
* **We deliberately do NOT use `--base-directory`.** It would relocate
  `custom_nodes` and `temp` to unexpected places; we don't need it, because the
  whole ComfyUI tree (custom_nodes included) already lives on the volume, and the
  per-dir flags + `extra_model_paths.yaml` cover the rest.

### Relocatable venv (how the volume venv works)

The seed venv is **built** at `/opt/ComfyUI-seed/venv` (with
`python3 -m venv --copies`, so it carries no symlinks into its own tree) but
**run** from `/workspace/ComfyUI/venv` after the first-boot copy. It keeps working
after relocation because the entrypoint **always** invokes it by **absolute path**
(`$VENV/bin/python`) and uses **`python -m pip`** — never the path-pinned `pip`
console-script, whose shebang would still point at the build-time seed path. A
Python interpreter self-locates its `site-packages` from its **own** path, so an
absolute-path invocation finds the right environment regardless of where the venv
was originally built.

---

## Auto-update (per-boot)

On every boot **after** the first, the entrypoint refreshes the on-volume software
before launching. Two env toggles control it:

| Env | Default | Effect |
|-----|---------|--------|
| `COMFY_AUTOUPDATE` | `1` (on) | `git pull --ff-only` on `/workspace/ComfyUI` **and** the panel checkout, then re-`pip install` each `requirements.txt` **only if its sha256 changed** (markers in `/workspace/ComfyUI/.autoupdate/`). Set `0` to skip all of it. |
| `COMFY_AUTOUPDATE_MANAGER` | `1` (on) | Also `pip install -U "$COMFY_MANAGER_SPEC"` in the volume venv, so Manager stays in lockstep with the auto-updating panel. Set `0` to freeze. |
| `COMFY_MANAGER_SPEC` | `comfyui_manager>=4,<5` | The upgrade target/bound for the Manager bump. Defaults to the `/v2` major line so an auto-update can't silently cross into a breaking major. Widen to `comfyui_manager` to track absolute latest. |

* The git pulls are best-effort and offline-safe — a failed or non-fast-forward
  pull just logs a warning and keeps the current checkout.
* The pip step is **conditional**: it only runs when a requirements file's
  sha256 differs from the recorded marker, so an unchanged tree is a fast no-op.
  The markers are seeded on the first boot so the second boot doesn't needlessly
  re-pip an unchanged tree.
* **Manager auto-updates by default, but within the `/v2` major.** `comfyui_manager`'s
  `/v2` API is the contract the Agent Panel depends on for install-model /
  install-node. `COMFY_MANAGER_SPEC` defaults to `>=4,<5` so you get patches +
  minor updates automatically while a breaking `5.x` major can't land silently and
  break the gate — bump the bound deliberately when you're ready to move majors.

---

## Model paths (`extra_model_paths.yaml`)

`extra_model_paths.yaml` lives in the seed (→ copied to
`/workspace/ComfyUI/extra_model_paths.yaml`) and is loaded via
`--extra-model-paths-config`. It maps **every** model category to a subfolder
under `/workspace/models`, with `is_default: true` so the volume is the
**primary** (download) location — i.e. Manager's install-model writes there and
the files persist.

```yaml
comfyui_mcp_volume:
    base_path: /workspace
    is_default: true            # insert these paths at the FRONT → default target

    checkpoints: models/checkpoints/
    configs: models/configs/
    loras: models/loras/
    vae: models/vae/
    text_encoders: |            # ComfyUI key "text_encoders" (a.k.a. CLIP)
        models/text_encoders/
        models/clip/
    diffusion_models: |         # a.k.a. UNet
        models/diffusion_models/
        models/unet/
    clip_vision: models/clip_vision/
    style_models: models/style_models/
    embeddings: models/embeddings/
    diffusers: models/diffusers/
    vae_approx: models/vae_approx/
    controlnet: |
        models/controlnet/
        models/t2i_adapter/
    gligen: models/gligen/
    upscale_models: models/upscale_models/
    latent_upscale_models: models/latent_upscale_models/
    hypernetworks: models/hypernetworks/
    photomaker: models/photomaker/
    classifiers: models/classifiers/
    model_patches: models/model_patches/
    audio_encoders: models/audio_encoders/
    background_removal: models/background_removal/
    frame_interpolation: models/frame_interpolation/
    geometry_estimation: models/geometry_estimation/
    optical_flow: models/optical_flow/
    detection: models/detection/
```

Notes:

* **`is_default: true`** is the load-bearing line. ComfyUI's
  `add_model_folder_path(..., is_default=True)` **inserts** the path at the front
  of each category's list, so `/workspace/models/<cat>` becomes the default
  download target and Manager downloads persist.
* **No `custom_nodes:` key** — on purpose, and for a different reason than before.
  `custom_nodes` already live on the volume at `/workspace/ComfyUI/custom_nodes`
  (ComfyUI's default path), so there's nothing to redirect.
* `base_path: /workspace` with `models/...` relative subpaths mirrors ComfyUI's
  own `extra_model_paths.yaml.example` convention.
* The category **keys** match ComfyUI's `folder_names_and_paths` keys. The list
  mirrors the example's full set; harmless if a future ComfyUI renames one.
* `/post_start.sh` pre-creates the matching subfolders under `/workspace/models`
  so they exist on a cold volume.

---

## Manager (remote-install gate)

* **Manager v2 (pip), gated by `--enable-manager`.** `comfyui_manager==4.2.2`
  exposes the `/v2` Manager API (`/v2/manager/queue/status` → 200, the API
  comfyui-mcp talks to). It's installed into the venv; the classic
  `custom_nodes/ComfyUI-Manager` checkout **conflicts** with it and is removed
  from the seed.
* **Where the config lives.** With `--user-directory /workspace/user`,
  `comfyui_manager` reads its `config.ini` from **under the user dir**:
  * new ComfyUI (System User API): `…/user/__manager/config.ini`
  * older ComfyUI: `…/user/default/ComfyUI-Manager/config.ini`

  Because that's on the **volume**, the gate persists. `/post_start.sh` writes/re-
  asserts **both** locations on every boot (idempotent), seeding from
  `/opt/config.ini.seed` if absent, so it's correct on either Manager build.
* **Gate values** (`config.ini`):

  | Key | Value | Why |
  |-----|-------|-----|
  | `network_mode` | `personal_cloud` | required — the `/v2` install gate only allows remote installs in this mode |
  | `security_level` | `normal-` | safe default; set `weak` (env `COMFY_SECURITY_LEVEL=weak`) for no guardrails, trusted pods only |

---

## ComfyUI / torch specifics

* **cu128 torch, no xformers.** The seed venv gets a clean `torch torchvision
  torchaudio` from `https://download.pytorch.org/whl/cu128` (torch 2.11.0+cu128 /
  CUDA 12.8 — sm_120 kernels for Blackwell / RTX 5090). xformers is **omitted** —
  its prebuilt wheels lag the cu128 ABI — so ComfyUI launches with
  `--use-pytorch-cross-attention` (PyTorch SDPA).
* **Verified on the built image:** base
  `runpod/pytorch:1.0.7-cu1281-torch280-ubuntu2404`; torch 2.11.0+cu128 / CUDA
  12.8 (covers the RTX 5090's sm_120 and Ada cards); ComfyUI **0.26.x**; Manager
  **v2** (`/v2/manager/queue/status` → 200).
* **Caches are ephemeral (in the container), by design.** The image redirects
  HF/pip/torch caches off the volume (`/root/.cache/...`) so runtime downloads
  don't pile up on the network drive. The durable things — the venv, custom nodes,
  and model weights — already live on the volume, which is the persistence that
  matters.

---

## Services (replicating the aitrepreneur set)

| Service | Port | Source | Notes |
|---------|------|--------|-------|
| **nginx** | **3000** (→ ComfyUI 3001) | our `nginx.conf` | websocket-aware; "starting" fallback page |
| **ComfyUI** | 3001 (internal) | **volume** venv | launched from `/workspace/ComfyUI`; see [launch flags](#comfyui-launch-command-the-exact-flags) |
| **sshd** | 22 | base | RunPod `$PUBLIC_KEY` injection |
| **JupyterLab** | 8888 | base | set `JUPYTER_PASSWORD` |
| **code-server** | 8081 (→ 8080) | installed at build | best-effort |
| **app-manager** | 8001 (→ 8000) | COPY from donor | Node app; best-effort (needs `node`) |
| **runpod-uploader** | — | COPY from donor | file uploader; best-effort |
| **croc** | — | COPY from donor | on-demand P2P transfer |
| **cron** | — | apt | best-effort |

All ancillary services are launched **best-effort** — if a binary is absent (e.g.
you dropped the donor COPYs) the entrypoint logs `skip` and carries on, so the
image still boots ComfyUI fine.

---

## Topology: where the agent runs

```
  YOUR LAPTOP                                   RUNPOD POD (this image)
  ┌───────────────────────────┐                ┌───────────────────────────────────┐
  │ npx comfyui-mcp connect …  │  HTTP/WS  ───▶ │ nginx :3000 ─▶ ComfyUI :3001        │
  │  └─ panel orchestrator     │                │   ├─ Manager v2 (--enable-manager) │
  │     (Claude/Codex Agent SDK│ ◀───  events   │   └─ Agent Panel (sidebar)         │
  │      on YOUR subscription) │                │ + sshd / jupyter / code-server     │
  └───────────────────────────┘                └───────────────────────────────────┘
```

The **panel orchestrator** (the autonomous agent loop, on your Claude **or**
ChatGPT subscription — no API key) runs **on your machine**, not the pod. The pod
only serves ComfyUI + Manager + the panel UI. That's why **Node.js for the agent,
the Agent SDK and any LLM client are intentionally absent** — they'd burn pod
GPU-hours for nothing.

---

## Deploy on RunPod

Create a **Pod template** (or fill these on a one-off GPU pod):

| Template field | Value |
|----------------|-------|
| **Container image** | `<your-registry>/comfyui-mcp-runpod:<tag>` (after build & push) |
| **Container disk** | ≥ 30 GB (the baked **seed** tree + cu128 torch live in the image; runtime caches are ephemeral here) |
| **Volume disk** | e.g. 150 GB+ (now holds the **whole app + venv + custom_nodes** AND your models + workflows + I/O — size larger than the old data-only design) |
| **Volume mount path** | **`/workspace`** |
| **Expose HTTP ports** | **`3000`** (nginx → ComfyUI). Optionally `8081` (code-server), `8001` (app-manager), `8888` (Jupyter). |
| **Expose TCP ports** | `22` (SSH) |
| **GPU** | RTX 5090 / any Blackwell or Ada card (cu128 covers both) |

**Environment variables** (Pod → Environment):

| Env | Default | Purpose |
|-----|---------|---------|
| `JUPYTER_PASSWORD` | *(unset)* | set to enable JupyterLab on :8888 (base behavior) |
| `PUBLIC_KEY` | *(RunPod injects)* | SSH public key (base behavior) |
| `COMFY_AUTOUPDATE` | `1` | `git pull` ComfyUI + panel + sha-checked pip each boot; `0` to skip |
| `COMFY_AUTOUPDATE_MANAGER` | `1` | `pip -U` comfyui_manager within `COMFY_MANAGER_SPEC` each boot; `0` to freeze (see [Auto-update](#auto-update-per-boot)) |
| `COMFY_MANAGER_SPEC` | `comfyui_manager>=4,<5` | Upgrade bound for the Manager bump — defaults to the `/v2` major line |
| `COMFY_SECURITY_LEVEL` | `normal-` | Manager security level (`weak` = most permissive) |
| `COMFY_NETWORK_MODE` | `personal_cloud` | must stay `personal_cloud` for remote installs |
| `COMFY_EXTRA_ARGS` | *(empty)* | extra ComfyUI flags appended verbatim by the entrypoint |
| `COMFY_HOME` | `/workspace/ComfyUI` | runtime ComfyUI path on the volume (rarely overridden) |
| `SEED_HOME` | `/opt/ComfyUI-seed` | baked seed path in the image (rarely overridden) |
| `WORKSPACE` | `/workspace` | network-volume mount (rarely overridden) |

> **First boot vs warm restart:** the **first** boot on an empty volume runs the
> one-time multi-GB seed `rsync` (slow) plus the spotcheck-model copy; **warm
> restarts** skip the copy and just do a fast `git pull` + sha-checked pip, then
> launch from the volume venv (~20-40s ComfyUI init). Watch the pod log / the
> "starting" page.

---

## Build & push

No GPU is needed at **build** time. On a machine with Docker + BuildKit:

```bash
cd docker/runpod

# Default: seed tree + spotcheck model.
docker build -t <your-registry>/comfyui-mcp-runpod:cu128 .
docker push     <your-registry>/comfyui-mcp-runpod:cu128

# Omit the baked spotcheck model (the 6.9 GB layer is never downloaded):
docker build --build-arg BAKE_SPOTCHECK_MODEL=0 \
  -t <your-registry>/comfyui-mcp-runpod:cu128-nospot .
```

Override pins as needed:

```bash
docker build \
  --build-arg BASE_IMAGE=runpod/pytorch:1.0.7-cu1281-torch280-ubuntu2404 \
  --build-arg COMFYUI_REF=master \
  --build-arg COMFYUI_MANAGER_VERSION=4.2.2 \
  --build-arg PANEL_REF=<tag-or-branch> \
  -t <your-registry>/comfyui-mcp-runpod:cu128 .
```

`COMFYUI_REF` / `PANEL_REF` pin the **seed**; the runtime `git pull` then tracks
that ref forward on the volume. Pin them for reproducible images; leave
`COMFYUI_REF=master` to seed latest.

### GPU spotcheck

`BAKE_SPOTCHECK_MODEL=1` (default) bakes the SDXL base checkpoint (~6.9 GB) into
the image; the entrypoint copies it onto the volume's `models/checkpoints` on the
first boot if absent, for a one-shot GPU smoke test. Build with
`--build-arg BAKE_SPOTCHECK_MODEL=0` to omit the model layer entirely.

### The 63 GB donor pull (and how to drop it)

`STAGE A` (`runpod-src`) pulls `aitrepreneur/comfyui:2.3.5` (~63 GB) **at build
time** purely to COPY out `runpod-uploader`, `croc` and `/app-manager`. It does
**not** ship in the final image, but it is a heavy one-time pull on your build
host. If you don't need those extras, **comment out STAGE A and the three
`COPY --from=runpod-src` lines** — the entrypoint already treats them as
best-effort, and `croc` can instead be installed from its official release.

### Image size note

The image carries a full **seed** copy of the ComfyUI tree + cu128 torch. The lean
base `runpod/pytorch:…-cu1281-torch280-…` already ships a cu128 torch, yet the
seed venv installs cu128 torch again (~7 GB duplicated) for a guaranteed-correct,
isolated environment that survives being `rsync`'d to the volume. To shave that,
build the seed venv with `--system-site-packages` and skip the explicit
`pip install torch …` — but **verify first** that the base torch is genuinely
`+cu128` (`python -c "import torch;print(torch.__version__, torch.version.cuda)"`);
some older `cu1281` tags shipped a cu-default torch. Note that a
`--system-site-packages` venv reuses the **image's** torch, which is **not** on
the volume — fine for torch (re-supplied by the image each boot), but the point of
the on-volume venv is that **custom-node** deps persist.

---

## The one-command local connect

Once the pod is up and you have its proxy URL, on your laptop:

```bash
npx -y comfyui-mcp connect https://<pod-id>-3000.proxy.runpod.net
```

This starts the comfyui-mcp panel orchestrator pointed at the pod. Then open the
pod's ComfyUI, open the **Agent Panel**, enable the **external-orchestrator**
toggle, and click **Connect**.

If you're on a build that predates the `connect` subcommand, the equivalents are:

```bash
# remote ComfyUI as an MCP server (for Claude Code / Desktop):
npx -y comfyui-mcp --comfyui-url https://<pod-id>-3000.proxy.runpod.net
# panel orchestrator (drives the sidebar agent):
COMFYUI_URL=https://<pod-id>-3000.proxy.runpod.net npx -y comfyui-mcp --panel-orchestrator
```

If the pod sits behind auth, set `COMFYUI_AUTH_TOKEN` (+ `COMFYUI_AUTH_HEADER` /
`COMFYUI_AUTH_SCHEME`) on the local command.

---

## Adding a custom node permanently

You generally don't need to — nodes the agent/Manager install at runtime now
**persist on the volume** and auto-update. If you want a node present on **every
fresh volume** from the start, add it to the **seed**: a `git clone` into
`/opt/ComfyUI-seed/custom_nodes/<node>` + its `pip install` into the seed venv in
the `Dockerfile`, then **rebuild the image**. Existing volumes already carry
whatever was installed at runtime.

---

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage: lean `runpod/pytorch` final stage; `aitrepreneur` donor stage for service artifacts; ARG-gated SDXL spotcheck stage. Bakes a pristine **seed** of ComfyUI + cu128 venv (`--copies`) + Manager v2 + Agent Panel at `/opt/ComfyUI-seed` (copied to the volume on first boot; never run from directly). |
| `post_start.sh` | Boot hook (installed as `/post_start.sh`): `mkdir` the `/workspace` data dirs; **first-boot** `rsync` of the seed → `/workspace/ComfyUI`; per-boot **auto-update** (git pull + sha-checked pip); first-boot spotcheck-model copy; Manager-gate write; ancillary services; and ComfyUI launch from the **volume** venv with the per-dir flags. |
| `extra_model_paths.yaml` | Maps every model category to `/workspace/models/<cat>` with `is_default: true` (volume is the primary/download location). No `custom_nodes:` key (custom_nodes already live on the volume via ComfyUI's default path). |
| `nginx.conf` | Self-contained reverse proxy (`:3000 → :3001`, websocket-aware, "starting" fallback) + code-server / app-manager fronts. Installed over the base's. |
| `starting.html` | The auto-refreshing "ComfyUI is starting…" page nginx serves until upstreams are up. |
| `config.ini` | Manager v2 gate template (`network_mode = personal_cloud`, `security_level = normal-`), seeded to `/opt/config.ini.seed` and written onto the volume user dir at boot. |
| `README.md` | This document. |

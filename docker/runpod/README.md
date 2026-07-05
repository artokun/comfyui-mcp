# comfyui-mcp RunPod image — FAST RESTART (image-immutable software) (DRAFT)

A RunPod image that boots **ready to be driven by the
[comfyui-mcp](https://github.com/artokun/comfyui-mcp) Agent Panel**. Deploy on
RunPod, run **one local command** on your laptop, and the agent drives the pod's
live ComfyUI graph from your Claude/ChatGPT subscription.

It is optimized for **fast stop/start**. All the software — ComfyUI + its venv +
`comfyui_manager` v2 + the Agent Panel custom node — is **baked into the
(immutable) image** at `/opt/ComfyUI` and **run directly from there**. The
`/workspace` network volume holds **only your data** (`user/`, `models/`,
`input/`, `output/`). A warm restart does **no install, no sync, no seed** — it
just `mkdir -p` the data dirs and launches ComfyUI (~**30-60s** ComfyUI init).

> **Status: DRAFT for owner review.** Authored to be correct and well-documented,
> but **not** build-tested (no Docker in the authoring env). A few pins still need
> confirmation — see [Owner confirmations needed](#owner-confirmations-needed).
> The owner builds + pushes + tests next.

---

## TL;DR

1. **Build & push** the image (a machine with Docker; no GPU needed).
   See [Build & push](#build--push).
2. **Deploy** on RunPod: GPU pod (e.g. RTX 5090), **expose HTTP 3000**, attach a
   **network volume at `/workspace`**. See [Deploy on RunPod](#deploy-on-runpod).
3. On your laptop:
   ```bash
   npx -y comfyui-mcp@latest connect https://<pod-id>-3000.proxy.runpod.net
   ```
4. Open the pod's ComfyUI, open the **Agent Panel** sidebar, enable the
   external-orchestrator toggle, hit **Connect**, and drive the graph in natural
   language.

The agent's brain (the **panel orchestrator**) runs **locally on your machine**
on your own subscription — see [Topology](#topology-where-the-agent-runs).

---

## The fast-restart model (what changed and why)

The previous design **seeded/synced** ComfyUI + its venv onto `/workspace` on the
first boot and re-synced on upgrades. That made the volume the source of truth for
software, which is slow to sync, fragile to upgrade (the `rsync -u` venv caveat),
and couples software to the data volume.

This design **inverts** that:

| Concern | Where it lives | Persists a restart? |
|---------|----------------|---------------------|
| ComfyUI install + venv | **image** `/opt/ComfyUI` (immutable) | n/a (re-pulled with the image) |
| `custom_nodes` (Agent Panel + your installs) | **volume** `/workspace/custom_nodes` (symlinked; image nodes seeded each boot) | **Yes** |
| ComfyUI-Manager | **image** venv (pip package) | n/a (in the image) |
| Custom-node pip cache | **volume** `/workspace/.cache/pip` | **Yes** |
| Other caches (HF / torch / npm) | **container** ephemeral disk | **No** — ephemeral |
| `user/` (workflows + settings + Manager config) | **volume** `/workspace/user` | **Yes** |
| `models/` (incl. Manager downloads) | **volume** `/workspace/models` | **Yes** |
| `input/` | **volume** `/workspace/input` | **Yes** |
| `output/` | **volume** `/workspace/output` | **Yes** |

**Result:** the base ComfyUI + venv boot fast from the immutable image; only your
data **and your custom nodes** live on the volume. A restart is `mkdir -p` the
user-data dirs, symlink + seed `custom_nodes`, reinstall node deps from the
persistent cache, and launch from the baked venv. No full install/sync/seed.

### Custom nodes persist on the volume

`custom_nodes` is **symlinked to `/workspace/custom_nodes`**, so **custom nodes the
agent or Manager install at runtime survive a restart** — while the base ComfyUI +
venv still boot fast from the immutable image.

* **How it works (each boot).** The entrypoint symlinks
  `/opt/ComfyUI/custom_nodes` → `/workspace/custom_nodes`, seeds/refreshes the
  image's baked nodes (Agent Panel + ComfyUI builtins) into it — so an image
  upgrade always ships a current panel while **your** installed nodes are preserved
  — then reinstalls each node's `requirements.txt` into the venv from a
  **persistent pip cache** on the volume (fast after the first time).
* **Models DO persist** — Manager's install-model writes to `/workspace/models`
  (see [Model paths](#model-paths-extra_model_pathsyaml)).
* **First install of a node** downloads its Python deps into the persistent cache;
  every restart after re-materializes them from cache (the venv lives in the image,
  so its packages are refreshed on boot). Compiled/CUDA-linked deps may rebuild
  rather than unpack. To bake a node so it needs **zero** boot-time work, still add
  it to the `Dockerfile` and rebuild.

---

## Architecture (multi-stage)

```
ARG BASE_IMAGE = runpod/pytorch:1.0.7-cu1281-torch280-ubuntu2404   (lean, recent)
ARG RUNPOD_SRC_IMAGE = aitrepreneur/comfyui:2.3.5                  (donor only)

┌─ STAGE A: runpod-donor ── ARG-gated (INCLUDE_RUNPOD_EXTRAS) ─────────┐
│  FROM aitrepreneur/comfyui:2.3.5                                     │
│  (built only so runpod-extras-1 can COPY service artifacts out of it;│
│   INCLUDE_RUNPOD_EXTRAS=0 -> runpod-extras-0 (empty), and BuildKit   │
│   never builds/pulls this stage at all)                             │
└─────────────────────────────────────────────────────────────────────┘
┌─ spotcheck-0 / spotcheck-1 (alpine) ─ ARG-gated SDXL model carrier ──┐
│  spotcheck-1 = ADD sd_xl_base_1.0.safetensors ; spotcheck-0 = empty  │
└─────────────────────────────────────────────────────────────────────┘
┌─ FINAL: FROM ${BASE_IMAGE} ─────────────────────────────────────────┐
│  apt: git cron nodejs … ; install code-server                       │
│  git clone ComfyUI (master) -> /opt/ComfyUI  (BAKED, run from here) │
│  python -m venv /opt/ComfyUI/venv                                    │
│    pip cu128 torch/vision/audio  (NO xformers)                      │
│    pip -r requirements.txt ; pip comfyui_manager==4.2.2           │
│    rm classic custom_nodes/ComfyUI-Manager                          │
│  git clone comfyui-mcp-panel -> /opt/ComfyUI/custom_nodes/…         │
│  COPY extra_model_paths.yaml -> /opt/ComfyUI/extra_model_paths.yaml │
│  COPY config.ini -> /opt/ComfyUI/config.ini.seed  (Manager gate)   │
│  COPY --from=spotcheck-src  -> /opt/ComfyUI-seed-models             │
│  COPY --from=runpod-extras /extras/ /  (uploader, croc, app-manager)│
│  COPY nginx.conf (:3000->:3001), starting.html, post_start.sh       │
│  (no ENTRYPOINT/CMD override — keep the base's /start.sh chain)     │
└─────────────────────────────────────────────────────────────────────┘
```

### Boot sequence (what runs, in order)

The base image's `CMD` is **`/start.sh`** (from `runpod/containers`). On boot it:

1. `service nginx start` — reads our `/etc/nginx/nginx.conf` (**:3000 → :3001**,
   websocket-aware, with the "starting" fallback page).
2. runs `/pre_start.sh` if present (we ship none).
3. `setup_ssh` — injects RunPod's `$PUBLIC_KEY` and starts sshd.
4. `start_jupyter` — starts JupyterLab on **:8888** if `$JUPYTER_PASSWORD` is set.
5. runs **our `/post_start.sh`** — `mkdir` the volume data dirs, assert the
   Manager gate, start the ancillary services, and **launch ComfyUI from the
   baked venv**.
6. `sleep infinity` — keeps the pod alive.

So SSH + Jupyter + nginx come from the base; **our hook adds everything else**.

---

## ComfyUI launch command (the exact flags)

`/post_start.sh` launches (from `cd /opt/ComfyUI`, with the baked venv python):

```bash
/opt/ComfyUI/venv/bin/python main.py \
  --listen 0.0.0.0 --port 3001 \
  --enable-manager \
  --use-pytorch-cross-attention \
  --user-directory   /workspace/user \
  --input-directory  /workspace/input \
  --output-directory /workspace/output \
  --extra-model-paths-config /opt/ComfyUI/extra_model_paths.yaml
```

* **`--user-directory /workspace/user`** — workflows, ComfyUI settings, AND the
  Manager config (see [Manager gate](#manager-remote-install-gate)) live on the
  volume.
* **`--input-directory` / `--output-directory`** — inputs and generated images on
  the volume.
* **`--extra-model-paths-config`** — points every model category at
  `/workspace/models` (see below). MODELS persist on the volume.
* **We deliberately do NOT use `--base-directory`.** It would relocate
  `custom_nodes` (and temp) onto the volume too — but we want `custom_nodes` to
  stay **in the image**. The per-dir flags + `extra_model_paths.yaml` give us
  exactly the split we want (data on the volume, software in the image).

> **Flag verification.** These flag names were verified against ComfyUI `master`
> (`comfy/cli_args.py`): `--user-directory`, `--input-directory`,
> `--output-directory`, `--base-directory`, and `--extra-model-paths-config` all
> exist with these exact spellings, and `--base-directory`'s own help text states
> it sets the base for "models, custom_nodes, input, output, temp, and user
> directories" — confirming why we avoid it. **Assumption to confirm at build:**
> the *pinned* `COMFYUI_REF` you bake actually ships these flags (they are present
> on recent `master`; an old pin may not have them). Run
> `"/opt/ComfyUI/venv/bin/python" /opt/ComfyUI/main.py --help` in the built image
> to confirm before publishing.

---

## Model paths (`extra_model_paths.yaml`)

`extra_model_paths.yaml` is baked at `/opt/ComfyUI/extra_model_paths.yaml` and
loaded via `--extra-model-paths-config`. It maps **every** model category to a
subfolder under `/workspace/models`, with `is_default: true` so the volume is the
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
  download target. Without it, the image's `/opt/ComfyUI/models/<cat>` (ephemeral)
  would stay first and Manager downloads would **not** persist.
* **No `custom_nodes:` key** — on purpose. Mapping `custom_nodes` to the volume
  would break the fast-restart contract.
* `base_path: /workspace` with `models/...` relative subpaths mirrors ComfyUI's
  own `extra_model_paths.yaml.example` convention.
* The category **keys** match ComfyUI's `folder_names_and_paths` keys (verified
  against `master`'s `folder_paths.py`). The category list mirrors the example's
  full set; harmless if a future ComfyUI renames one.
* `/post_start.sh` pre-creates the matching subfolders under `/workspace/models`
  so they exist on a cold volume.

### Warm model volume (skip the cold HF pull)

A **fresh** network volume has an empty `models/` tree — the first time the
agent (or you) needs a checkpoint, it's a cold download from HuggingFace, which
can be tens of GB and the slowest part of getting a new pod usable.

The fix is the same idea as the image itself: **build once, reuse many times.**

1. **Build a seed volume once.** Spin up a pod with this image + a network
   volume, download the checkpoints/LoRAs/VAEs you use most (the exact same
   files the [installer packs](../../packs) already fetch — `packs/*/install-runpod.sh`
   lists the HF URLs per pack) into that volume's `models/<category>/` tree
   matching the layout in `extra_model_paths.yaml` above, then stop the pod.
   That volume is now your **warm seed** — keep it around, don't delete it.
2. **Reuse it for new pods**, by whichever mechanism your RunPod plan supports:
   - **Volume snapshot/clone** (if available on your account) — instantly fork
     a new volume from the seed's current contents instead of attaching the
     same volume serially.
   - **Attach the seed volume directly** to a new pod deployment (stop any pod
     currently using it first) — simplest, but one pod at a time.
   - **A shared object store + boot-time sync** — the most portable option, and
     the only one that supports many pods pulling concurrently: keep the seed
     models in an S3-compatible bucket (RunPod's own network storage, or any
     S3-compatible provider) and add an `rclone sync` (or `aws s3 sync`) step to
     `post_start.sh` before the model-subfolder `mkdir -p` block, pulling only
     what's missing on that pod's volume. This also composes cleanly with
     `PANEL_AUTO_UPDATE` above — both are "pull what's missing/changed at boot,
     skip what's already there" patterns.

None of this requires a new mechanism in the image itself — `extra_model_paths.yaml`
already treats `/workspace/models` as the single source of truth regardless of
*how* files got there, so a warm volume (or a boot-time sync into one) is
transparent to ComfyUI and the agent.

---

## Manager (remote-install gate)

* **Manager v2 (pip), gated by `--enable-manager`.** `comfyui_manager==4.2.2`
  exposes `/v2/manager/queue/task` (the API comfyui-mcp talks to). The classic
  `custom_nodes/ComfyUI-Manager` checkout **conflicts** with it and is removed.
* **Where the config lives.** With `--user-directory /workspace/user`,
  `comfyui_manager` reads its `config.ini` from **under the user dir** — verified
  against the Manager source (`manager_migration.get_manager_path(user_dir)`):
  * new ComfyUI (System User API): `…/user/__manager/config.ini`
  * older ComfyUI: `…/user/default/ComfyUI-Manager/config.ini`

  Because that's on the **volume**, the gate persists. `/post_start.sh` writes/re-
  asserts **both** locations on every boot (idempotent), so it's correct on either
  Manager build.
* **Gate values** (`config.ini`):

  | Key | Value | Why |
  |-----|-------|-----|
  | `network_mode` | `personal_cloud` | required — the `/v2` install gate only allows remote installs in this mode |
  | `security_level` | `normal-` | safe default; set `weak` (env `COMFY_SECURITY_LEVEL=weak`) for no guardrails, trusted pods only |

---

## ComfyUI / torch specifics

* **cu128 torch, no xformers.** The venv gets a clean `torch torchvision
  torchaudio` from `https://download.pytorch.org/whl/cu128` (sm_120 kernels for
  Blackwell / RTX 5090). xformers is **omitted** — its prebuilt wheels lag the
  cu128 ABI — so ComfyUI launches with `--use-pytorch-cross-attention` (PyTorch
  SDPA).
* **Caches are ephemeral (in the container), by design.** We do **not** redirect
  HF/pip/torch/npm caches to `/workspace`. Model downloads via Manager go to
  `/workspace/models` and persist — that's the only persistence we need. (First
  use after a restart may re-download small ancillary files into the ephemeral
  cache; the big model weights stay on the volume.)

---

## Services (replicating the aitrepreneur set)

| Service | Port | Source | Notes |
|---------|------|--------|-------|
| **nginx** | **3000** (→ ComfyUI 3001) | our `nginx.conf` | websocket-aware; "starting" fallback page |
| **ComfyUI** | 3001 (internal) | baked image venv | launched from `/opt/ComfyUI`; see [launch flags](#comfyui-launch-command-the-exact-flags) |
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
| **Container disk** | ≥ 30 GB (the baked ComfyUI + venv + cu128 torch + any runtime-installed nodes/caches, which are ephemeral) |
| **Volume disk** | e.g. 100 GB+ (your **models + workflows + I/O** live here; size for your models) |
| **Volume mount path** | **`/workspace`** |
| **Expose HTTP ports** | **`3000`** (nginx → ComfyUI). Optionally `8081` (code-server), `8001` (app-manager), `8888` (Jupyter). |
| **Expose TCP ports** | `22` (SSH) |
| **GPU** | RTX 5090 / any Blackwell or Ada card (cu128 covers both) |
| **Host driver** | >= 570 (CUDA 12.8) for the default image; >= 580 (CUDA 13) for the `:cu130` perf variant. The entrypoint preflights this (`MIN_DRIVER`) and holds the pod open with a clear message instead of crash-looping. |

**Environment variables** (Pod → Environment):

| Env | Default | Purpose |
|-----|---------|---------|
| `JUPYTER_PASSWORD` | *(unset)* | set to enable JupyterLab on :8888 (base behavior) |
| `PUBLIC_KEY` | *(RunPod injects)* | SSH public key (base behavior) |
| `COMFY_SECURITY_LEVEL` | `normal-` | Manager security level (`weak` = most permissive) |
| `COMFY_NETWORK_MODE` | `personal_cloud` | must stay `personal_cloud` for remote installs |
| `COMFY_EXTRA_ARGS` | *(empty)* | extra ComfyUI flags appended verbatim by the entrypoint |
| `COMFY_HOME` | `/opt/ComfyUI` | baked ComfyUI path (rarely overridden) |
| `WORKSPACE` | `/workspace` | network-volume mount (rarely overridden) |
| `PANEL_AUTO_UPDATE` | `1` | fast-forward the Agent Panel to its latest release on every boot (git fetch + reset --hard, before ComfyUI launches) — reaches pods without a new image build. Automatically a no-op on a `PANEL_REF`-pinned build (detached HEAD). Set `0` to disable. |

> **First boot vs warm restart:** both are fast. First boot additionally creates
> the volume data dirs and copies the spotcheck model (if baked); warm restart
> skips even those. Watch the pod log / the "starting" page; ComfyUI init is
> ~30-60s either way.

---

## Build & push

No GPU is needed at **build** time. On a machine with Docker + BuildKit:

```bash
cd docker/runpod

# Default: baked software + spotcheck model.
docker build -t <your-registry>/comfyui-mcp-runpod:cu128 .
docker push     <your-registry>/comfyui-mcp-runpod:cu128

# Omit the baked spotcheck model (the 6.9 GB layer is never downloaded):
docker build --build-arg BAKE_SPOTCHECK_MODEL=0 \
  -t <your-registry>/comfyui-mcp-runpod:cu128-noseed .
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

### The 63 GB donor pull (and how to drop it)

`STAGE A` (`runpod-donor`) pulls `aitrepreneur/comfyui:2.3.5` (~63 GB) **at build
time** purely to copy out `runpod-uploader`, `croc` and `/app-manager`. It does
**not** ship in the final image, but it is a heavy one-time pull on your build
host — and won't fit on a disk-constrained CI runner. If you don't need those
extras:

```bash
docker build --build-arg INCLUDE_RUNPOD_EXTRAS=0 \
  -t <your-registry>/comfyui-mcp-runpod:cu128-lean .
```

BuildKit only builds a stage the final target's dependency graph actually
reaches, so `INCLUDE_RUNPOD_EXTRAS=0` skips the donor pull **entirely** — not
just its `COPY` (see `runpod-extras-0`/`runpod-extras-1` in the Dockerfile,
which mirror the `BAKE_SPOTCHECK_MODEL` selector pattern below). The entrypoint
already treats `runpod-uploader`/`croc`/`app-manager` as best-effort and skips
them cleanly when absent; `croc` can instead be installed from its official
release if you want it back without the donor pull.

### Image size note (the duplicate-torch tradeoff)

Because the software is now baked, the image is **larger** than the volume-seed
design — that's the deliberate fast-restart tradeoff (first-pull/image-size no
longer matters per the spec). The lean base `runpod/pytorch:…-cu1281-torch280-…`
**already ships a cu128 torch**, yet we install cu128 torch again into the
isolated venv (~7 GB duplicated) for a guaranteed-correct, isolated environment.
To shave that:

* Build the venv with `python -m venv --system-site-packages /opt/ComfyUI/venv`
  and **skip the `pip install torch …` step**, so ComfyUI reuses the base's
  cu128 torch. **Verify first** that the base torch is genuinely `+cu128`
  (`python -c "import torch;print(torch.__version__, torch.version.cuda)"`) —
  some older `cu1281` tags shipped a cu-default torch.

> **DRAFT — not build-tested.** Build once locally and watch for: (a) the base's
> `/start.sh` actually invokes `/post_start.sh` (it does in `runpod/containers`,
> but confirm for your exact tag); (b) `main.py --help` lists `--user-directory`,
> `--input-directory`, `--output-directory`, `--extra-model-paths-config`,
> `--enable-manager`, `--use-pytorch-cross-attention` for your pinned
> `COMFYUI_REF`; (c) `comfyui_manager 4.2.2` reads the gate from the volume user
> dir (`user/__manager/config.ini` or `user/default/ComfyUI-Manager/config.ini`);
> (d) Manager install-model writes to `/workspace/models/<cat>` (i.e. `is_default`
> took effect); (e) the donor paths `/usr/local/bin/runpod-uploader`,
> `/usr/local/bin/croc`, `/app-manager` exist. Then deploy and verify a real
> stop/start is fast.

---

## The one-command local connect

Once the pod is up and you have its proxy URL, on your laptop:

```bash
npx -y comfyui-mcp@latest connect https://<pod-id>-3000.proxy.runpod.net
```

This starts the comfyui-mcp panel orchestrator pointed at the pod. Because the pod
page is served over `https://`, `connect` automatically opens a secure, token-gated
**`wss://` tunnel** (via Cloudflare) to the agent bridge on your machine and hands
the pod's panel that URL — so the HTTPS page reaches your local agent with **no
browser prompt, in any browser** (a secure page can't open a plain `ws://` socket
to your box). Then open the pod's ComfyUI, open the **Agent Panel**, enable the
**external-orchestrator** toggle, and click **Connect**. (Add **`--insecure-bridge`**
to force the plain `ws://127.0.0.1:9180` loopback instead — e.g. when you reach the
pod via an SSH port-forward.)

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

## Owner confirmations needed

Draft pins/assumptions — confirm before building/publishing:

1. **Base tag** — `runpod/pytorch:1.0.7-cu1281-torch280-ubuntu2404` (verified on
   Docker Hub 2026-06-19). Confirm it's still the one you want at build.
2. **Base `/start.sh` hook** — confirm your exact base tag's `/start.sh` runs
   `/post_start.sh` and `service nginx start` reads `/etc/nginx/nginx.conf`
   (true in `runpod/containers` `main`).
3. **Launch flags on the pinned ComfyUI** — `--user-directory`,
   `--input-directory`, `--output-directory`, `--extra-model-paths-config`,
   `--enable-manager`, `--use-pytorch-cross-attention`. Verified present on
   `master`; confirm for whatever `COMFYUI_REF` you bake (`main.py --help`).
4. **`is_default` write behavior** — confirm Manager install-model actually lands
   in `/workspace/models/<cat>` (it should, since `is_default` front-inserts the
   volume paths).
5. **`comfyui_manager` 4.2.2 config path** — reads
   `user/__manager/config.ini` (new) or `user/default/ComfyUI-Manager/config.ini`
   (older) under `--user-directory`. We write both; confirm one is honored.
6. **Donor artifact paths** — `/usr/local/bin/runpod-uploader`,
   `/usr/local/bin/croc`, `/app-manager` in `aitrepreneur/comfyui:2.3.5`.
7. **nginx port convention** — kept **3000 → 3001** (matches your `connect`
   flow). We override the base's native ComfyUI proxy block with our
   self-contained `nginx.conf`.
8. **Duplicate torch** — keep the isolated cu128 torch (default, ~+7 GB) or reuse
   the base's via `--system-site-packages` (see size note).
9. **Panel ref** — cloned from the default branch (nightly HEAD). Pin `PANEL_REF`
   for reproducible images?
10. **custom_nodes tradeoff** — confirm you accept that runtime-installed nodes
    don't survive a restart (models do). Permanent nodes go in the Dockerfile.

---

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage: lean `runpod/pytorch` final stage; `aitrepreneur` donor stage for service artifacts; ARG-gated SDXL spotcheck stage. **Bakes** ComfyUI + cu128 venv + Manager v2 + Agent Panel into `/opt/ComfyUI` (run from there; never synced to the volume). |
| `post_start.sh` | Boot hook (installed as `/post_start.sh`): `mkdir` the `/workspace` data dirs, first-boot spotcheck-model copy, Manager-gate write, ancillary services, and ComfyUI launch from the baked venv with the per-dir flags. |
| `extra_model_paths.yaml` | Maps every model category to `/workspace/models/<cat>` with `is_default: true` (volume is the primary/download location). No `custom_nodes:` key (nodes stay in the image). |
| `nginx.conf` | Self-contained reverse proxy (`:3000 → :3001`, websocket-aware, "starting" fallback) + code-server / app-manager fronts. Installed over the base's. |
| `starting.html` | The auto-refreshing "ComfyUI is starting…" page nginx serves until upstreams are up. |
| `config.ini` | Manager v2 gate template (`network_mode = personal_cloud`, `security_level = normal-`), copied to the volume user dir at boot. |
| `README.md` | This document. |

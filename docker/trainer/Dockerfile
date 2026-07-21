# Headless GPU LoRA-training image — runs ostris ai-toolkit's `run.py` directly.
#
# Derived from ai-toolkit's own Dockerfile (same CUDA base, torch, arch list) but
# STRIPPED of the Next.js UI: we drive training via the CLI + a generated YAML
# config, so no Node/UI layers. One image, two future targets — local `docker run`
# now, the same image on a RunPod pod later.
#
# Build (from repo root):
#   docker build -t comfyui-mcp-trainer:latest \
#     --build-arg AI_TOOLKIT_REF=<commit-or-tag> docker/trainer
#
# Run (bind config + dataset + output + HF cache; --gpus all is required):
#   docker run --rm --gpus all \
#     -v /path/config.yml:/config.yml:ro \
#     -v /path/dataset:/dataset \
#     -v /path/output:/output \
#     -v $HOME/.cache/huggingface:/root/.cache/huggingface \
#     -e HF_TOKEN=$HF_TOKEN \
#     comfyui-mcp-trainer:latest /config.yml
#
# The config's training_folder must be /output and datasets[].folder_path /dataset
# (the driver in src/services/ai-toolkit.ts wires these paths). /dataset must be
# writable: ai-toolkit caches (.aitk_size.json, latents) inside it.

FROM nvidia/cuda:12.8.1-devel-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_ENABLE_HF_TRANSFER=1 \
    # Ampere (30xx) through Blackwell (50xx/GB) — 8.9 = RTX 4090.
    TORCH_CUDA_ARCH_LIST="8.0 8.6 8.9 9.0 10.0 12.0"

# 1) System packages (heaviest, most cache-stable layer).
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-venv python3-pip python3-dev \
        git git-lfs cmake build-essential ffmpeg libgl1 libglib2.0-0 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/local/bin/python

# 2) PyTorch (cu128) — pinned to ai-toolkit's tested versions, before source so a
#    code bump doesn't re-download torch.
RUN pip install --break-system-packages --no-cache-dir \
        torch==2.9.1 torchvision==0.24.1 torchaudio==2.9.1 \
        --index-url https://download.pytorch.org/whl/cu128 \
    && pip install --break-system-packages --no-cache-dir hf_transfer

# 3) ai-toolkit source (pinned to the E2E-proven commit for reproducible
#    builds — train_build_image passes no ref by default, so the default MUST
#    be the commit we validated; independent review finding #3) + its
#    requirements. Requirements are installed from the cloned file so they layer
#    after torch.
ARG AI_TOOLKIT_REPO=https://github.com/ostris/ai-toolkit.git
# Pinned to the commit the P1 end-to-end run was validated against (200-step
# character LoRA on a 4090). `main` moves, so an unpinned default silently
# rebuilds a DIFFERENT trainer than the one we tested — override with
# --build-arg AI_TOOLKIT_REF=<sha> to move deliberately.
ARG AI_TOOLKIT_REF=a0224793cef5d5073c8ed0b8cdb838a84fd1cba0
WORKDIR /opt
RUN git clone --recurse-submodules "${AI_TOOLKIT_REPO}" ai-toolkit \
    && cd ai-toolkit \
    && git checkout "${AI_TOOLKIT_REF}" \
    && git submodule update --init --recursive \
    && pip install --break-system-packages --no-cache-dir -r requirements.txt

WORKDIR /opt/ai-toolkit

# Fail fast + loud if the container is started without a GPU.
# run.py takes the config path as its single positional arg.
ENTRYPOINT ["python", "run.py"]

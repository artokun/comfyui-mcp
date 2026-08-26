---
name: train-character-lora
description: Train a character/identity LoRA locally on FLUX.1-dev via the comfyui-mcp train_* tools (GPU Docker + ostris ai-toolkit). Use when the user wants to train a LoRA of a person/character from their photos on the local GPU. Covers dataset prep, launch, monitoring, and using the result in ComfyUI. For WAN/Z-Image training via the ai-toolkit UI see ai-toolkit-trainer.
globs:
  - "**/*.json"
---

# Train a Character LoRA (local, Flux.1-dev)

## Overview

The trainer runs ostris ai-toolkit's `run.py` inside a headless GPU Docker container,
driven through the three `train_*` MCP tools. You (the LLM) are the UI. Each takes
an `action`: `train_prepare_dataset` owns the datasets, `train_start` owns the jobs, and
`train_doctor` owns the trainer itself. You generate the dataset, launch the job, watch
progress, and the finished LoRA lands in ComfyUI `models/loras/` and the LoRA catalog
without further steps.

- Base model: FLUX.1-dev (the best proven character consistency; needs ~24GB VRAM with
  quantization, RTX 4090 class).
- Phase-1 scope: character LoRAs only. Style/slider/edit and other bases come later.

## The flow (tool sequence)

1. `train_doctor {action:"doctor"}`. Preflight once per session. Checks docker daemon,
   `--gpus all` GPU passthrough, trainer image, HF_TOKEN. If `image:false`, run
   `train_doctor {action:"build_image"}` (one-time, several minutes, since it builds CUDA
   plus torch plus ai-toolkit). If `hfTokenSet:false`, warn the user: the first run
   downloads FLUX.1-dev (gated HF repo) and needs `HF_TOKEN` in the MCP server env.
2. `train_prepare_dataset {action:"prepare"}`. Stage the images. See "Dataset" below.
3. `train_start {action:"start"}`. Launch. Returns a job id at once; training runs
   detached.
4. `train_start {action:"status", id}`. Poll progress (`progress.step/totalSteps/loss`,
   recent `samples`, `log` tail). Poll on a slow cadence (every few minutes). A 2000-step
   run is roughly an hour on a 4090. Don't block on it.
5. Done. `status:"completed"` means the `.safetensors` was copied to
   `models/loras/<name>.safetensors` and upserted into the LoRA catalog (`result` has the
   paths and catalog id). Verify by loading it in a Flux workflow (`LoraLoaderModelOnly`,
   strength 1.0) with the trigger word in the prompt.

## Dataset guidance

Call `train_prepare_dataset {action:"prepare"}` with `name`, `items: [{path, caption?}, ...]`
and a `defaultCaption`.

- 10 to 30 varied images of the subject: different angles, expressions, lighting,
  backgrounds, distances (close-up, half-body, full-body). Variety beats count.
- Trigger word: pick something rare and stable (e.g. `ohwx`, `zxc_person`), NOT a
  real word. Use it as `defaultCaption` and pass it as `trigger` to `train_start`.
- Captions: describe what changes between images (pose, setting, clothing,
  expression); the model learns the constant identity from the images themselves. Start
  each caption with the trigger word, e.g. `ohwx person sitting in a cafe, laughing, natural
  light`. Keep them short and factual. When in doubt, the trigger word alone
  (`defaultCaption`) is a workable baseline.
- Images are copied and renamed `img_00001.<ext>` etc. Source files are never modified.

## Params (sane defaults — override sparingly)

| Param | Default | When to change |
|-------|---------|----------------|
| steps | 2000 | 200 for a smoke test; 1500–3000 real runs. More ≠ better (overbake = plasticky). |
| lr | 1e-4 | 5e-5 for a tighter/subtler identity. |
| rank | 16 | 32 for very detailed characters. |
| resolution | [512,768,1024] | [512] if VRAM-constrained. |
| quantize | true | Keep true on 24GB. |
| saveEvery / sampleEvery | 250 | Lower (100) to watch early progress. |

## Monitoring & judgement

- `train_start {action:"status"}`'s `progress.samples` are host paths. Look at them.
  (ai-toolkit prints no saved-sample lines, so they populate at finalize from the output
  dir; mid-run you can look directly in the job's `output/<name>/samples/` folder.)
  Identity should be recognizable by ~1/3 of the run; if samples stay generic past
  halfway, the run will likely underfit. Cancel (`train_start {action:"cancel", id}`) and
  check captions and trigger.
- Loss should trend down and stabilize (~0.1 to 0.3); wild spikes usually mean lr too high.
- Checkpoints save every `saveEvery` steps under the job's `output/` dir, so a cancelled
  run isn't a total loss.

## Failure modes

- `no_docker` / `no_image` from `train_start {action:"start"}`: run
  `train_doctor {action:"doctor"}`, follow its hints.
- OOM / CUDA errors in the log tail: drop `resolution` to `[512]`, keep `quantize:true`,
  batch stays 1.
- `handoff failed` in job error: training itself finished; the LoRA is still under the
  job's `output/<name>/` dir. Copy it into `models/loras/` manually and upsert the catalog.
- First run is slow before step 1. FLUX.1-dev download (~24GB) plus latent caching. As
  long as the log tail moves, it's fine. The HF cache persists across runs.

## Sources

- **Official:** none found.
- **Empirical:** sampler values, wiring, and prompt notes from working graphs in `packs/` and observed renders; not a vendor prompting guide.

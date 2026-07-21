import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildTrainerImage,
  dockerAvailable,
  trainerDoctor,
  trainerImageExists,
  TRAINER_IMAGE,
} from "../services/ai-toolkit.js";
import { DEFAULT_PARAMS } from "../services/training-config.js";
import {
  cancelJob,
  getJob,
  hfCacheRoot,
  listJobs,
  prepareDataset,
  startTrainingJob,
  trainingRoot,
} from "../services/training-jobs.js";
import { errorToToolResult } from "../utils/errors.js";
import { isRemoteMode } from "../config.js";

function textEnvelope(envelope: unknown) {
  const failed = typeof envelope === "object" && envelope !== null && "ok" in envelope && envelope.ok === false;
  return {
    ...(failed ? { isError: true } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
  };
}

/** Package root — dist/tools/train.js → ../../ (ships docker/trainer). */
function packageRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

function trainerContextDir(): string {
  return join(packageRoot(), "docker", "trainer");
}

/** Resolve the pod for a pod-targeted train call: explicit pod_id, else the
 *  connector's connected/watched pod. Returns the pod record or an error string. */
async function resolvePodForTraining(podId?: string): Promise<import("../services/runpod-client.js").RunpodPod | string> {
  const { getPod } = await import("../services/runpod-client.js");
  const { getRunpodWatcher } = await import("../services/runpod-watch.js");
  const id = podId ?? getRunpodWatcher()?.watchedPodId() ?? undefined;
  if (!id) {
    return "No pod selected: pass pod_id, or runpod_pod_connect to a pod first (runpod_list_pods shows yours).";
  }
  const pod = await getPod(id);
  if (!pod) return `No pod ${id} on this RunPod account (runpod_list_pods).`;
  if (pod.desiredStatus !== "RUNNING") {
    return `Pod ${pod.id} is ${pod.desiredStatus}, not RUNNING — start it first (runpod_pod_start).`;
  }
  return pod;
}

const paramsSchema = z
  .object({
    steps: z.number().int().min(1).optional().describe("Total training steps (200 = smoke test, 1500-3000 real)."),
    lr: z.number().positive().optional().describe("Learning rate."),
    rank: z.number().int().min(1).optional().describe("LoRA rank (16 simple, 16-32 detailed)."),
    resolution: z.array(z.number().int().positive()).min(1).optional().describe("Resolution buckets, e.g. [512,768,1024]."),
    batchSize: z.number().int().min(1).optional(),
    saveEvery: z.number().int().min(1).optional().describe("Checkpoint cadence (steps)."),
    sampleEvery: z.number().int().min(1).optional().describe("Sample-image cadence (steps)."),
    quantize: z.boolean().optional().describe("8-bit mixed precision — needed to fit Flux on 24GB."),
  })
  .optional();

export function registerTrainTools(server: McpServer): void {
  server.tool(
    "train_list_flows",
    "List the LoRA training flows and base models the local trainer supports (phase 1: character LoRA on FLUX.1-dev), with the default training params. Read-only — call this first to see what train_start accepts.",
    {},
    async () => {
      try {
        return textEnvelope({
          ok: true,
          flows: [
            {
              id: "character",
              kind: "image",
              description: "Character/identity LoRA from ~10-30 images with captions + a unique trigger word.",
              models: [
                {
                  id: "flux1-dev",
                  hfRepo: "black-forest-labs/FLUX.1-dev",
                  vram: "24GB with quantize=true (RTX 4090 class)",
                  notes: "Proven character-consistency base (ai-toolkit presets tuned for it).",
                },
              ],
            },
          ],
          defaultParams: DEFAULT_PARAMS,
          image: TRAINER_IMAGE,
        });
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );

  server.tool(
    "train_prepare_dataset",
    "Stage training images + captions into a dataset dir the trainer consumes. Each item is an image path with an optional caption (a missing caption falls back to defaultCaption — typically the trigger word). Returns the datasetPath to pass to train_start. Character LoRA guidance: 10-30 varied images; caption what changes between images, keep the trigger word constant.",
    {
      name: z.string().min(1).describe("Dataset name (becomes the staging dir name)."),
      items: z
        .array(
          z.object({
            path: z.string().min(1).describe("Absolute path to a source image (png/jpg/jpeg/webp)."),
            caption: z.string().optional().describe("Caption for this image."),
          }),
        )
        .min(1),
      defaultCaption: z.string().optional().describe("Fallback caption for items without one — usually the trigger word."),
    },
    async (args) => {
      try {
        const prepared = await prepareDataset({ name: args.name, items: args.items, defaultCaption: args.defaultCaption });
        return textEnvelope({ ok: true, ...prepared });
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );

  server.tool(
    "train_start",
    "Start a LoRA training job: target 'local' builds the config and launches the GPU trainer container (docker run --gpus all); target 'pod' ssh-drives pod-native training on a connected RunPod pod (pod_id, or the connector's currently connected pod). Returns a job id for train_status/train_cancel. Long-running — returns immediately; poll train_status. On completion the LoRA is delivered per deliverTo (pod/local/both) and cataloged when local. Run train_doctor first if unsure the image/docker/GPU (local) or bootstrap (pod) are ready.",
    {
      name: z.string().min(1).describe("Job name — becomes the output .safetensors basename (e.g. 'aria_character')."),
      flow: z.enum(["character"]).optional().default("character"),
      model: z.enum(["flux1-dev"]).optional().default("flux1-dev"),
      datasetPath: z.string().min(1).describe("Dataset dir from train_prepare_dataset (images + same-basename .txt captions)."),
      trigger: z.string().optional().describe("Unique trigger word (e.g. 'ohwx person') — injected as trigger_word and usable in prompts."),
      params: paramsSchema,
      device: z.string().optional().describe("GPU selector, default cuda:0."),
      target: z.enum(["local", "pod"]).optional().default("local").describe("'local' = docker on this rig; 'pod' = pod-native over ssh on a RunPod pod."),
      pod_id: z.string().optional().describe("RunPod pod to train on (target 'pod'). Default: the connector's currently connected/watched pod."),
      deliverTo: z.enum(["pod", "local", "both"]).optional().default("both").describe("Pod jobs only: where the finished LoRA lands."),
      model_path: z.string().optional().describe("Override the base model path AS THE TRAINER SEES IT (pod path for target 'pod', container path for 'local') — e.g. a pre-uploaded local HF snapshot dir when the default HF repo id is gated/unreachable."),
    },
    async (args) => {
      try {
        let podEndpoint: import("../services/runpod-ssh.js").PodSshEndpoint | undefined;
        if (args.target === "pod") {
          const pod = await resolvePodForTraining(args.pod_id);
          if (typeof pod === "string") return textEnvelope({ ok: false, error: { code: "no_pod", message: pod } });
          const { podSshEndpoint } = await import("../services/runpod-ssh.js");
          const ep = podSshEndpoint(pod);
          if (!ep) {
            return textEnvelope({ ok: false, error: { code: "no_ssh", message: `Pod ${pod.id} has no public SSH endpoint (not running, or the template doesn't expose port 22/tcp).` } });
          }
          podEndpoint = ep;
        } else {
          if (!(await dockerAvailable())) {
            return textEnvelope({ ok: false, error: { code: "no_docker", message: "Docker daemon not reachable — start Docker Desktop / the docker engine, then re-run. See train_doctor." } });
          }
          if (!(await trainerImageExists())) {
            return textEnvelope({ ok: false, error: { code: "no_image", message: `Trainer image ${TRAINER_IMAGE} not built yet — run train_build_image once (several minutes), then re-run train_start.` } });
          }
        }
        const job = await startTrainingJob({
          name: args.name,
          flow: args.flow,
          model: args.model,
          datasetPath: args.datasetPath,
          trigger: args.trigger,
          params: args.params,
          device: args.device,
          target: args.target,
          podEndpoint,
          deliverTo: args.deliverTo,
          modelPath: args.model_path,
        });
        return textEnvelope({ ok: true, job });
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );

  server.tool(
    "train_bootstrap",
    "Set up the NATIVE (dockerless) trainer on this machine or a pod: clone ai-toolkit at the pinned commit, create its venv, install torch + requirements. One-time per machine/pod (~10 min fresh, idempotent; a pod's /workspace persists it across restarts). Needed before target 'pod' train_start on a fresh pod (no docker there).",
    {
      target: z.enum(["local", "pod"]).optional().default("local"),
      pod_id: z.string().optional().describe("Pod to bootstrap (target 'pod'). Default: the connected pod."),
    },
    async (args) => {
      try {
        if (args.target === "pod") {
          const pod = await resolvePodForTraining(args.pod_id);
          if (typeof pod === "string") return textEnvelope({ ok: false, error: { code: "no_pod", message: pod } });
          const { podSshEndpoint, sshExec } = await import("../services/runpod-ssh.js");
          const ep = podSshEndpoint(pod);
          if (!ep) return textEnvelope({ ok: false, error: { code: "no_ssh", message: `Pod ${pod.id} has no public SSH endpoint.` } });
          const script = [
            "set -e",
            "mkdir -p /workspace/training && cd /workspace/training",
            "[ -d ai-toolkit/.git ] || git clone --recurse-submodules https://github.com/ostris/ai-toolkit.git ai-toolkit",
            "cd ai-toolkit && git fetch --all && git checkout a0224793cef5d5073c8ed0b8cdb838a84fd1cba0 && git submodule update --init --recursive",
            "[ -x venv/bin/python ] || python3 -m venv venv",
            "./venv/bin/python -m pip install --no-cache-dir torch==2.9.1 torchvision==0.24.1 torchaudio==2.9.1 --index-url https://download.pytorch.org/whl/cu128",
            "./venv/bin/python -m pip install --no-cache-dir hf_transfer",
            "./venv/bin/python -m pip install --no-cache-dir -r requirements.txt",
            "echo BOOTSTRAP_OK",
          ].join(" && ");
          const r = await sshExec(ep, script, 1_800_000);
          if (r.code !== 0 || !r.stdout.includes("BOOTSTRAP_OK")) {
            return textEnvelope({ ok: false, error: { code: "bootstrap_failed", message: `pod bootstrap failed (exit ${r.code})`, stderr: (r.stderr || r.stdout).slice(-2000) } });
          }
          return textEnvelope({ ok: true, pod: pod.id, note: "ai-toolkit installed at /workspace/training/ai-toolkit (persists across pod restarts)" });
        }
        const { bootstrapToolkit } = await import("../services/trainer-bootstrap.js");
        const lines: string[] = [];
        const result = await bootstrapToolkit({ onLog: (l) => lines.push(l) });
        return textEnvelope({ ...result, log_tail: lines.slice(-20) });
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );

  server.tool(
    "train_status",
    "Check training progress: pass an id for one job (step/total, loss, recent samples, log tail, result paths when done) or omit for all jobs newest-first.",
    {
      id: z.string().optional().describe("Job id from train_start. Omit to list all jobs."),
    },
    async (args) => {
      try {
        if (args.id) {
          const job = await getJob(args.id);
          if (!job) throw new Error(`no training job ${args.id}`);
          return textEnvelope({ ok: true, job });
        }
        const jobs = await listJobs();
        return textEnvelope({ ok: true, count: jobs.length, jobs });
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );

  server.tool(
    "train_cancel",
    "Stop a running training job (docker stop) and mark it cancelled. Checkpoints already saved stay in the job's output dir; no LoRA is handed off to models/loras. Returns ok:false when the container could not be confirmed stopped (the job reverts to running).",
    {
      id: z.string().min(1).describe("Job id from train_start."),
    },
    async (args) => {
      try {
        const job = await cancelJob(args.id);
        // A failed cancel returns the job as RUNNING with an error — that must
        // not surface as a successful cancellation (codex finding): clients
        // keying on the envelope/isError would think the GPU is free.
        if (job.status !== "cancelled") {
          return textEnvelope({ ok: false, error: { code: "cancel_failed", message: job.error ?? `job is ${job.status}` }, job });
        }
        return textEnvelope({ ok: true, job });
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );

  server.tool(
    "train_build_image",
    `Build the headless GPU trainer image (${TRAINER_IMAGE}) from docker/trainer/Dockerfile — one-time, several minutes (CUDA + torch + ai-toolkit). Requires a reachable docker daemon. aiToolkitRef pins the ai-toolkit commit/tag for reproducibility.`,
    {
      aiToolkitRef: z.string().optional().describe("ai-toolkit git ref (commit/tag) to build against. Default: the Dockerfile's pinned ref."),
    },
    async (args) => {
      try {
        if (!(await dockerAvailable())) {
          return textEnvelope({ ok: false, error: { code: "no_docker", message: "Docker daemon not reachable — start Docker Desktop / the docker engine first." } });
        }
        const contextDir = trainerContextDir();
        if (!existsSync(join(contextDir, "Dockerfile"))) {
          return textEnvelope({ ok: false, error: { code: "no_dockerfile", message: `Trainer Dockerfile not found at ${contextDir} — the docker/ dir may not be shipped in this install.` } });
        }
        const result = await buildTrainerImage({ contextDir, aiToolkitRef: args.aiToolkitRef });
        return textEnvelope(result);
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );

  server.tool(
    "train_doctor",
    "Preflight the local trainer: docker daemon reachable, `--gpus all` GPU passthrough working (NVIDIA Container Toolkit), trainer image built. Returns per-check booleans + setup hints. Also reports the training data root and whether HF_TOKEN is set (needed to download FLUX.1-dev on first run).",
    {},
    async () => {
      try {
        const doctor = await trainerDoctor();
        const { bootstrapStatus } = await import("../services/trainer-bootstrap.js");
        const native = await bootstrapStatus();
        // Connected pod (if any): enough for the wizard's Local/Pod switch.
        let pod: Record<string, unknown> | null = null;
        try {
          const { getRunpodWatcher } = await import("../services/runpod-watch.js");
          const { getPod } = await import("../services/runpod-client.js");
          const { podSshEndpoint, sshEndpointWorks } = await import("../services/runpod-ssh.js");
          const id = getRunpodWatcher()?.watchedPodId();
          if (id) {
            const p = await getPod(id);
            if (p) {
              const ep = podSshEndpoint(p);
              pod = {
                id: p.id,
                name: p.name,
                status: p.desiredStatus,
                gpu: p.machine?.gpuDisplayName ?? null,
                ssh: ep ? await sshEndpointWorks(ep) : false,
              };
            }
          }
        } catch { /* pod reporting is best-effort */ }
        return textEnvelope({
          ...doctor,
          data: {
            ...doctor.data,
            trainingRoot: trainingRoot(),
            hfCache: hfCacheRoot(),
            hfTokenSet: !!process.env.HF_TOKEN?.trim(),
            // Dataset staging + the LoRA handoff need a LOCAL ComfyUI filesystem
            // on this MCP's machine — false in remote mode, so panel/mobile can
            // warn before a doomed launch instead of failing at staging.
            localFs: !isRemoteMode(),
            // Native (dockerless) trainer bootstrap status — the pod path.
            native: { dir: native.dir, cloned: native.cloned, venv: native.venv, ready: native.ready, ref: native.ref },
            pod,
          },
        });
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );
}

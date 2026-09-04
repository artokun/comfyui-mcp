import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { resolveInputDir, resolveOutputDir } from "../services/output-dir.js";
import {
  buildTrainerImage,
  dockerAvailable,
  trainerDoctor,
  trainerImageExists,
  TRAINER_COMMAND,
  TRAINER_IMAGE,
} from "../services/ai-toolkit.js";
import { DEFAULT_PARAMS } from "../services/training-config.js";
import {
  cancelJob,
  deleteJob,
  getJob,
  hfCacheRoot,
  listJobs,
  prepareDataset,
  startTrainingJob,
  trainingRoot,
} from "../services/training-jobs.js";
import { getDataset, getJobConfig, listDatasets, previewConfig, readTrainingFile, deleteDataset, updateDataset } from "../services/training-datasets.js";
import { captionDataset, captionImage } from "../services/train-caption.js";
import { errorToToolResult } from "../utils/errors.js";
import { config, isRemoteMode } from "../config.js";

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
    return 'No pod selected: pass pod_id, or runpod action:"connect" to a pod first (runpod action:"list" shows yours).';
  }
  const pod = await getPod(id);
  if (!pod) return `No pod ${id} on this RunPod account (runpod action:"list").`;
  if (pod.desiredStatus !== "RUNNING") {
    return `Pod ${pod.id} is ${pod.desiredStatus}, not RUNNING — start it first (runpod action:"start").`;
  }
  return pod;
}

/** Map tool items (path | ComfyUI ref) to host-absolute DatasetItems. Refs
 *  resolve against the connected ComfyUI's output/input root with containment:
 *  the filename must be a plain basename and the resolved path must stay INSIDE
 *  the root — otherwise a crafted ref could stage ANY host file into a dataset
 *  (path traversal). prepareDataset then verifies existence/type per item. */
async function resolveDatasetItems(
  items: Array<{
    path?: string;
    ref?: { filename: string; subfolder?: string; type?: "output" | "input" };
    caption?: string;
  }>,
): Promise<Array<{ path: string; caption?: string }>> {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  return Promise.all(
    items.map(async (it) => {
      // An explicit host path always wins over a ref (both are allowed so a
      // caller can attach a ref for traceability).
      if (it.path) return { path: it.path, caption: it.caption };
      // Refs resolve on the ORCHESTRATOR's filesystem — against a remote
      // ComfyUI (pod/LAN) the root would come from that machine's stats while
      // prepareDataset checks/copies locally (codex finding). Reject honestly.
      if (isRemoteMode()) {
        throw new Error("ref items need a LOCAL ComfyUI (the orchestrator must share its filesystem) — pass absolute paths, or fetch the remote outputs first");
      }
      const { filename, subfolder, type } = it.ref!;
      if (filename !== basename(filename)) {
        throw new Error(`ref filename must be a plain basename, got "${filename}"`);
      }
      const kind = type ?? "output";
      const root = resolve(kind === "input" ? await resolveInputDir() : await resolveOutputDir());
      const candidate = resolve(root, subfolder ?? "", filename);
      // Containment on REAL paths — a symlinked subfolder/file pointing outside
      // the root must not smuggle the copy across (codex finding). A missing
      // target keeps its lexical path; prepareDataset reports it not-found.
      const realRoot = await realpath(root).catch(() => root);
      const realCandidate = await realpath(candidate).catch(() => candidate);
      if (norm(realCandidate) !== norm(realRoot) && !norm(realCandidate).startsWith(norm(realRoot) + sep)) {
        throw new Error(`ref "${subfolder ?? ""}/${filename}" escapes the ${kind} dir`);
      }
      return { path: realCandidate, caption: it.caption };
    }),
  );
}

const paramsSchema = z
  .object({
    // Upper bounds (panel #104): the Custom preset is free-form, and a typo
    // like steps=10^9 / rank=100000 / resolution=100000 starts a doomed,
    // OOM, BILLED run. Ceilings are generous but sane; the panel wizard
    // mirrors them client-side.
    steps: z.number().int().min(1).max(100_000).optional().describe("Total training steps (200 = smoke test, 1500-3000 real; max 100000)."),
    lr: z.number().positive().max(1).optional().describe("Learning rate (max 1)."),
    rank: z.number().int().min(1).max(1024).optional().describe("LoRA rank (16 simple, 16-32 detailed; max 1024)."),
    resolution: z.array(z.number().int().min(64).max(4096)).min(1).optional().describe("Resolution buckets, e.g. [512,768,1024] (each 64-4096)."),
    batchSize: z.number().int().min(1).optional(),
    saveEvery: z.number().int().min(1).optional().describe("Checkpoint cadence (steps)."),
    sampleEvery: z.number().int().min(1).optional().describe("Sample-image cadence (steps)."),
    quantize: z.boolean().optional().describe("8-bit mixed precision — needed to fit Flux on 24GB."),
  })
  .optional();

/**
 * The eighteen train_* tools collapsed into three action-parameterized tools,
 * split by WORK-DOMAIN rather than by convenience (0.50.0 surface
 * consolidation, slice 10):
 *
 *   train_prepare_dataset — the DATASETS (images + captions) a run consumes
 *   train_start           — the JOBS that consume them
 *   train_doctor          — the TRAINER ITSELF (preflight, setup, image build)
 *
 * SHAPE: each is a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required, because a field required
 * by one action is meaningless to another (`id` is required by cancel/delete/
 * job_config, OPTIONAL by status, and unused by list_flows). Every VALUE
 * constraint the old tools carried stays at the zod layer; the handlers enforce
 * per-action PRESENCE and name the missing field — the one deliberate
 * behavioural difference a flat enum permits. Each branch calls the same
 * service function the old tool called, with the same arguments, and returns
 * the identical content block.
 *
 * TWO `delete` ACTIONS, TWO BLAST RADII. `train_start action:"delete"` destroys
 * a training JOB (keyed by `id`); `train_prepare_dataset action:"delete"`
 * destroys a staged DATASET (keyed by `name`) — hand-curated images that cannot
 * be recovered. They are deliberately keyed by DIFFERENT fields, and each
 * description names the other explicitly, so a model that reaches for the wrong
 * one gets a missing-field error rather than a destroyed artifact.
 */
export function registerTrainTools(server: McpServer): void {
  // ── Datasets: the images + captions a run consumes ────────────────────────
  server.tool(
    "train_prepare_dataset",
    "Stage and curate the training DATASETS a LoRA run consumes — the images and their captions. Datasets are keyed by `name`; the jobs that train on them live in the separate `train_start` tool and are keyed by `id`. Driven by the `action` parameter:\n" +
      '- action:"prepare" — Stage training images + captions into a dataset dir the trainer consumes. Each item is an image (absolute `path`, OR a ComfyUI `ref` {filename,subfolder?,type?} resolved against the connected ComfyUI\'s output/input dirs — how phone/panel pickers hand over selections) with an optional caption (a missing caption falls back to defaultCaption — typically the trigger word). Requires `name` + `items`. Returns the datasetPath to pass to train_start (action:"start"). Character LoRA guidance: 10-30 varied images; caption what changes between images, keep the trigger word constant.\n' +
      '- action:"list" — List staged datasets, newest-first, with image/caption counts. Read-only, takes no other parameters. Pair with action:"detail" to see one dataset\'s images + captions.\n' +
      '- action:"detail" — Show ONE staged dataset by `name`: its dir (datasetPath — reusable as train_start\'s datasetPath) and every image with its caption (null when uncaptioned). Images render via action:"file". Read-only.\n' +
      '- action:"update" — Edit a staged dataset by `name`: set/replace per-image captions (`setCaptions`) and/or delete individual images with their caption files (`deleteImages`). Refuses while a running/queued job trains from it. Returns per-file warnings for unknown files. This is the SURGICAL edit — it removes only the filenames you list, leaving the dataset itself in place.\n' +
      '- action:"delete" — DESTROY a whole staged DATASET by `name`: every image and every caption under it. Irreversible, and the images are typically hand-curated and unrecoverable — confirm with the user first. Refuses while a running/queued job trains from it. THIS DELETES A DATASET, NOT A TRAINING JOB: to delete a finished job\'s record and checkpoints use the separate `train_start` tool with action:"delete", which is keyed by `id` rather than `name`. To remove only SOME images, use action:"update" with `deleteImages`.\n' +
      '- action:"file" — Fetch an image under the training root (dataset image, job sample) by absolute `path` as an inline image — the tunnel-safe way for a phone/panel to render training files it can\'t reach over /view. Bounded: image files only, ≤ 2MB.\n' +
      '- action:"caption_image" — Caption ONE image by absolute `path` with the user\'s own Claude subscription (one vision turn through the Agent SDK — not a paid API). Returns the bare caption and does NOT write it — review, then save with action:"update", or use action:"caption_dataset" to write directly. Optional `guide` steers the style; optional `trigger` is prepended by the model.\n' +
      '- action:"caption_dataset" — Caption a whole staged dataset by `name` (or the `only` subset) with the user\'s own Claude subscription and WRITE the captions into its .txt files (one vision turn per image, sequential). Captioning ALWAYS runs through Claude (Agent SDK) regardless of the panel\'s active backend, so it needs a logged-in Claude Code session (or ANTHROPIC_API_KEY). Use after gathering images, before train_start (action:"start"). Per-file transient failures are reported without stopping the batch, but a persistent auth/credential failure stops immediately with an actionable error rather than failing every image. Optional `guide` steers all captions; optional `trigger` is prepended to each.',
    {
      action: z
        .enum(["prepare", "list", "detail", "update", "delete", "file", "caption_image", "caption_dataset"])
        .describe(
          'Which dataset operation to perform. "list" takes no other parameters; "prepare" requires `name` + `items`; "detail", "update", "delete" and "caption_dataset" require `name`; "file" and "caption_image" require `path`. NOTE "delete" here destroys a DATASET (images + captions) — deleting a training JOB is train_start action:"delete".',
        ),
      name: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Dataset name — the staging dir name. REQUIRED for actions "prepare" (it is created), "detail", "update", "delete" and "caption_dataset" (from action:"list"). This is a DATASET name, never a training job id.',
        ),
      items: z
        .array(
          z
            .object({
              path: z.string().min(1).optional().describe("Absolute path to a source image (png/jpg/jpeg/webp)."),
              ref: z
                .object({
                  filename: z.string().min(1).describe("Basename only — no path separators."),
                  subfolder: z.string().optional().describe("Subfolder under the root (default top level)."),
                  type: z.enum(["output", "input"]).optional().default("output").describe("Which ComfyUI dir to resolve against (default output)."),
                })
                .optional()
                .describe("ComfyUI file ref (e.g. from get_image (action:\"list_outputs\") format:json) — resolved server-side with containment checks. Give path OR ref."),
              caption: z.string().optional().describe("Caption for this image."),
            })
            .refine((it) => !!it.path || !!it.ref, { message: "each item needs path or ref" }),
        )
        .min(1)
        .optional()
        .describe('action:"prepare" — the images to stage. REQUIRED for that action.'),
      defaultCaption: z
        .string()
        .optional()
        .describe('action:"prepare" — fallback caption for items without one; usually the trigger word.'),
      setCaptions: z
        .record(z.string(), z.string())
        .optional()
        .describe('action:"update" — {filename: caption} pairs to write (replaces existing captions).'),
      deleteImages: z
        .array(z.string())
        .optional()
        .describe('action:"update" — image filenames to delete from the dataset (caption files go too). Removes only these files; action:"delete" removes the whole dataset.'),
      path: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Absolute path of a file under the training root. REQUIRED for action:"file" (a dataset image or job sample, from action:"detail"\'s datasetPath or train_start action:"status"\'s samples) and for action:"caption_image" (the image to caption).',
        ),
      guide: z
        .string()
        .optional()
        .describe('actions "caption_image"/"caption_dataset" — extra style guidance for the captioner (e.g. \'focus on outfits and backgrounds\').'),
      trigger: z
        .string()
        .optional()
        .describe('actions "caption_image"/"caption_dataset" — trigger word to prepend to the caption(s).'),
      only: z
        .array(z.string())
        .optional()
        .describe('action:"caption_dataset" — subset of filenames to caption (default: all images).'),
    },
    async (args) => {
      try {
        // `name` and `path` cannot be schema-required in a flat shape, so the
        // handler enforces per-action presence and names the missing field —
        // the same information the old per-tool schemas gave a caller.
        //
        // ABSENCE only, never falsiness: both fields keep the .min(1) the old
        // tools carried, so an explicitly EMPTY string is still rejected at the
        // zod boundary exactly as before rather than being re-diagnosed here.
        const requireName = (action: string, what: string): string => {
          if (args.name === undefined) {
            throw new Error(`train_prepare_dataset action:"${action}" requires \`name\` — ${what}.`);
          }
          return args.name;
        };
        const requirePath = (action: string, what: string): string => {
          if (args.path === undefined) {
            throw new Error(`train_prepare_dataset action:"${action}" requires \`path\` — ${what}.`);
          }
          return args.path;
        };

        switch (args.action) {
          case "prepare": {
            const name = requireName("prepare", "the dataset name to stage these images into");
            if (args.items === undefined) {
              throw new Error(
                'train_prepare_dataset action:"prepare" requires `items` — at least one image, each with a `path` or a ComfyUI `ref`.',
              );
            }
            const items = await resolveDatasetItems(args.items);
            const prepared = await prepareDataset({ name, items, defaultCaption: args.defaultCaption });
            return textEnvelope({ ok: true, ...prepared });
          }
          case "list":
            return textEnvelope({ ok: true, datasets: listDatasets() });
          case "detail":
            return textEnvelope({ ok: true, ...getDataset(requireName("detail", "the dataset to show")) });
          case "update":
            return textEnvelope({
              ok: true,
              ...(await updateDataset(requireName("update", "the dataset to edit"), {
                setCaptions: args.setCaptions,
                deleteImages: args.deleteImages,
              })),
            });
          case "delete": {
            // The DATASET delete. Its sibling train_start action:"delete"
            // destroys a JOB — different tool, different key (`id`).
            await deleteDataset(requireName("delete", "the dataset to destroy (images + captions)"));
            return textEnvelope({ ok: true });
          }
          case "file": {
            const { data, mimeType } = readTrainingFile(requirePath("file", "the image under the training root to inline"));
            return { content: [{ type: "image" as const, data, mimeType }] };
          }
          case "caption_image": {
            const caption = await captionImage({
              imagePath: requirePath("caption_image", "the image to caption"),
              guide: args.guide,
              trigger: args.trigger,
            });
            return textEnvelope({ ok: true, caption });
          }
          case "caption_dataset":
            return textEnvelope({
              ok: true,
              ...(await captionDataset(requireName("caption_dataset", "the dataset to caption"), {
                guide: args.guide,
                trigger: args.trigger,
                only: args.only,
              })),
            });
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown train_prepare_dataset action "${String(exhaustive)}". Expected one of: prepare, list, detail, update, delete, file, caption_image, caption_dataset.`,
            );
          }
        }
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );

  // ── Jobs: launching, polling, stopping and inspecting training runs ───────
  server.tool(
    "train_start",
    "Run and inspect LoRA training JOBS — launch a run, poll it, stop it, delete it, and read back the settings behind it. Jobs are keyed by `id`; the datasets they train on live in the separate `train_prepare_dataset` tool and are keyed by `name`. Driven by the `action` parameter:\n" +
      '- action:"start" — Start a LoRA training job: target \'local\' builds the config and launches the GPU trainer container (docker run --gpus all); target \'pod\' ssh-drives pod-native training on a connected RunPod pod (pod_id, or the connector\'s currently connected pod). Requires `name` + `datasetPath`. Returns a job id for action:"status"/action:"cancel". Long-running — returns immediately; poll action:"status". On completion the LoRA is delivered per deliverTo (pod/local/both) and cataloged when local. Run train_doctor first if unsure the image/docker/GPU (local) or bootstrap (pod) are ready.\n' +
      '- action:"status" — Check training progress: pass an `id` for one job (step/total, loss, recent samples, log tail, result paths when done) or OMIT `id` for all jobs newest-first. Read-only.\n' +
      '- action:"cancel" — STOP a RUNNING job (docker stop) by `id` and mark it cancelled. Nothing is erased: checkpoints already saved stay in the job\'s output dir; no LoRA is handed off to models/loras, so the run can be inspected afterwards. Returns ok:false when the container could not be confirmed stopped (the job reverts to running). This is the RECOVERABLE stop — use action:"delete" only when you also want the artifacts gone.\n' +
      '- action:"delete" — DESTROY a finished job by `id`: its record AND its output dir with checkpoints/samples, unless keep_outputs is true. Irreversible — confirm with the user first. The delivered LoRA in models/loras is NOT removed. Running/queued jobs must be cancelled first (action:"cancel"). THIS DELETES A JOB, NOT A DATASET: to delete the staged images and captions a run consumed use the separate `train_prepare_dataset` tool with action:"delete", which is keyed by `name` rather than `id`.\n' +
      '- action:"list_flows" — List the LoRA training flows and base models the local trainer supports (phase 1: character LoRA on FLUX.1-dev), with the default training params. Read-only, takes no other parameters — call this first to see what action:"start" accepts.\n' +
      '- action:"job_config" — Show the effective settings a job ran with by `id` (steps/lr/rank/resolution/batch/saveEvery/sampleEvery/quantize), read back from the ai-toolkit config.yml it consumed, plus flow/model/trigger/datasetPath — everything needed to run the job again with tweaks. Read-only.\n' +
      '- action:"preview_config" — Show the RAW ai-toolkit config.yml action:"start" WOULD write for these settings (the ostris-UI \'raw config\' view) — no side effects, nothing is written or started. Requires `name` + `datasetPath`. Use it to review a run before launching; pass the same params to action:"start" to execute.',
    {
      action: z
        .enum(["start", "status", "cancel", "delete", "list_flows", "job_config", "preview_config"])
        .describe(
          'Which training-job operation to perform. "list_flows" takes no other parameters; "status" takes an OPTIONAL `id` (omit for all jobs); "cancel", "delete" and "job_config" require `id`; "start" and "preview_config" require `name` + `datasetPath`. NOTE "delete" here destroys a training JOB — deleting a staged DATASET is train_prepare_dataset action:"delete".',
        ),
      // No .min(1) here, deliberately: action:"status" reads an empty id as "no
      // id" and lists every job, which its retired tool did too. The three
      // actions whose old schemas DID carry .min(1) re-apply it in the handler
      // (see requireId), so each action's accept/reject set is unchanged.
      id: z
        .string()
        .optional()
        .describe(
          'Training job id, as returned by action:"start" (e.g. "t8f3k2ab") — NEVER a dataset name. REQUIRED and must be non-empty for actions "cancel", "delete" and "job_config". OPTIONAL for action:"status": omit it (or pass an empty string) to list every job newest-first. Unused by "start", "list_flows" and "preview_config".',
        ),
      name: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Job name — becomes the output .safetensors basename (e.g. \'aria_character\'). REQUIRED for actions "start" and "preview_config". This names the RUN, not the dataset it reads.',
        ),
      flow: z.enum(["character"]).optional().default("character").describe('action:"start" — training flow (see action:"list_flows").'),
      model: z.enum(["flux1-dev"]).optional().default("flux1-dev").describe('action:"start" — base model (see action:"list_flows").'),
      datasetPath: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Dataset dir from train_prepare_dataset (images + same-basename .txt captions). REQUIRED for actions "start" and "preview_config".',
        ),
      trigger: z.string().optional().describe("Unique trigger word (e.g. 'ohwx person') — injected as trigger_word and usable in prompts."),
      // ONE tool, ONE `params` field, so it takes ONE schema — and it is the
      // typed one. The retired standalone preview tool accepted an untyped
      // record while the launcher carried the #104 ceilings; the alternative (an untyped
      // record shared by both) would have hidden all eight documented parameters
      // from the model AND moved start's ceilings out of the schema, which is
      // the direction this consolidation exists to avoid. The narrowing is
      // confined to action:"preview_config" refusing values action:"start" would
      // also refuse — a preview of settings that cannot start is not a preview
      // of anything. Unknown keys were never emitted into the config either way
      // (buildTrainingConfig reads only these eight), so nothing is silently
      // dropped.
      params: paramsSchema.describe(
        'Training param overrides for actions "start" and "preview_config" (steps/lr/rank/resolution/batchSize/saveEvery/sampleEvery/quantize). Omitted keys fall back to the defaults from action:"list_flows". action:"preview_config" enforces the SAME bounds action:"start" does, so a preview always reflects a run that could actually launch.',
      ),
      device: z.string().optional().describe('action:"start" — GPU selector, default cuda:0.'),
      target: z.enum(["local", "pod"]).optional().default("local").describe('action:"start" — \'local\' = docker on this rig; \'pod\' = pod-native over ssh on a RunPod pod.'),
      pod_id: z.string().optional().describe('action:"start" — RunPod pod to train on (target \'pod\'). Default: the connector\'s currently connected/watched pod.'),
      deliverTo: z.enum(["pod", "local", "both"]).optional().default("both").describe('action:"start", pod jobs only: where the finished LoRA lands.'),
      model_path: z.string().optional().describe('action:"start" — override the base model path AS THE TRAINER SEES IT (pod path for target \'pod\', container path for \'local\') — e.g. a pre-uploaded local HF snapshot dir when the default HF repo id is gated/unreachable.'),
      keep_outputs: z.boolean().optional().describe('action:"delete" — keep the job\'s output dir (checkpoints/samples) and delete only the record.'),
    },
    async (args) => {
      try {
        // `id`, `name` and `datasetPath` cannot be schema-required in a flat
        // shape, so the handler enforces per-action presence and names the
        // missing field — the same information the old per-tool schemas gave.
        //
        // ABSENCE and EMPTINESS are two different answers, never one falsiness
        // check. `id` cannot carry .min(1) on the shared field: action:"status"
        // treats an empty id as "no id" (see its branch), so a schema-level
        // .min(1) would turn a formerly-valid list-all call into an error. But
        // the OLD per-tool schemas behind cancel, delete and job_config DID
        // carry .min(1), so those three must keep rejecting an explicitly empty
        // id rather than passing it to the service. Hence two distinct errors
        // here — a missing `id` names the field, an empty `id` names the
        // constraint — which is exactly what a single `!args.id` guard would
        // collapse into one piece of generic text.
        // `name`/`datasetPath` keep their .min(1) on the schema itself, so an
        // empty string is still rejected at the zod boundary exactly as before.
        const requireId = (action: string, what: string): string => {
          if (args.id === undefined) {
            throw new Error(`train_start action:"${action}" requires \`id\` — ${what}.`);
          }
          if (args.id === "") {
            throw new Error(
              `train_start action:"${action}" requires a NON-EMPTY \`id\` — ${what}. (Only action:"status" accepts an empty id, where it means "list every job".)`,
            );
          }
          return args.id;
        };
        const requireName = (action: string): string => {
          if (args.name === undefined) {
            throw new Error(`train_start action:"${action}" requires \`name\` — the job name (becomes the output .safetensors basename).`);
          }
          return args.name;
        };
        const requireDatasetPath = (action: string): string => {
          if (args.datasetPath === undefined) {
            throw new Error(
              `train_start action:"${action}" requires \`datasetPath\` — a staged dataset dir from train_prepare_dataset (action:"prepare" or action:"detail").`,
            );
          }
          return args.datasetPath;
        };

        switch (args.action) {
          case "start": {
            const name = requireName("start");
            const datasetPath = requireDatasetPath("start");
            let podEndpoint: import("../services/runpod-ssh.js").PodSshEndpoint | undefined;
            let podId: string | undefined;
            let nativeLocal = false;
            if (args.target === "pod") {
              const pod = await resolvePodForTraining(args.pod_id);
              if (typeof pod === "string") return textEnvelope({ ok: false, error: { code: "no_pod", message: pod } });
              const { podSshEndpoint } = await import("../services/runpod-ssh.js");
              const ep = podSshEndpoint(pod);
              if (!ep) {
                return textEnvelope({ ok: false, error: { code: "no_ssh", message: `Pod ${pod.id} has no public SSH endpoint (not running, or the template doesn't expose port 22/tcp).` } });
              }
              podEndpoint = ep;
              podId = pod.id;
            } else {
              // Local: docker preferred; the NATIVE (dockerless) trainer is the
              // fallback when docker/image is missing but train_doctor
              // (action:"bootstrap") already prepared the local venv (issue
              // #275 — native bootstrap used to be a dead end: ready, but
              // starting a job still demanded docker).
              const dockerOk = (await dockerAvailable()) && (await trainerImageExists());
              if (!dockerOk) {
                const { nativeToolkitReady } = await import("../services/ai-toolkit.js");
                if (await nativeToolkitReady()) {
                  // model_path was documented as the CONTAINER-visible path — under
                  // the native fallback it must be a HOST-absolute, EXISTING path;
                  // a container-style value (/root/.cache/…) would silently not
                  // exist for the host process (codex).
                  if (args.model_path) {
                    const isWin = process.platform === "win32";
                    const hostAbsolute = isWin ? /^[a-zA-Z]:[\\/]|^[\\/]{2}/.test(args.model_path) : args.model_path.startsWith("/");
                    const { existsSync } = await import("node:fs");
                    if (!hostAbsolute || !existsSync(args.model_path)) {
                      return textEnvelope({ ok: false, error: { code: "model_path_native", message: `model_path "${args.model_path}" ${hostAbsolute ? "does not exist on this machine" : "isn't a HOST-absolute path"} — the native (dockerless) fallback runs locally, so supply an existing absolute host path${isWin ? " (e.g. C:/...)" : ""} or omit it to use the default HF repo.` } });
                    }
                  }
                  nativeLocal = true;
                } else if (!(await dockerAvailable())) {
                  return textEnvelope({ ok: false, error: { code: "no_docker", message: "No docker daemon AND no native trainer — either start docker + run train_doctor (action:\"build_image\"), or run train_doctor (action:\"bootstrap\", target local) for the dockerless trainer. See train_doctor (action:\"doctor\")." } });
                } else {
                  return textEnvelope({ ok: false, error: { code: "no_image", message: `Trainer image ${TRAINER_IMAGE} not built and no native trainer ready — run train_doctor (action:"build_image") for docker or train_doctor (action:"bootstrap", target local) for native, then re-run train_start (action:"start").` } });
                }
              }
            }
            const job = await startTrainingJob({
              name,
              flow: args.flow,
              model: args.model,
              datasetPath,
              trigger: args.trigger,
              params: args.params,
              device: args.device,
              target: args.target,
              podEndpoint,
              podId,
              native: nativeLocal,
              deliverTo: args.deliverTo,
              modelPath: args.model_path,
            });
            return textEnvelope({ ok: true, job });
          }
          case "status": {
            // Truthiness, NOT `!== undefined`, and deliberately so: the old
            // per-tool status schema left `id` optional with no .min(1), and its
            // handler read `if (args.id)`. An empty id therefore meant "list
            // them all". Preserving that is behaviour preservation; tightening
            // it here would turn a working call into an error.
            if (args.id) {
              const job = await getJob(args.id);
              if (!job) throw new Error(`no training job ${args.id}`);
              return textEnvelope({ ok: true, job });
            }
            const jobs = await listJobs();
            return textEnvelope({ ok: true, count: jobs.length, jobs });
          }
          case "cancel": {
            const job = await cancelJob(requireId("cancel", "the running job to stop"));
            // A failed cancel returns the job as RUNNING with an error — that must
            // not surface as a successful cancellation (codex finding): clients
            // keying on the envelope/isError would think the GPU is free.
            if (job.status !== "cancelled") {
              return textEnvelope({ ok: false, error: { code: "cancel_failed", message: job.error ?? `job is ${job.status}` }, job });
            }
            return textEnvelope({ ok: true, job });
          }
          case "delete": {
            // The JOB delete. Its sibling train_prepare_dataset action:"delete"
            // destroys a DATASET — different tool, different key (`name`).
            await deleteJob(requireId("delete", "the finished job whose record and outputs to destroy"), {
              keepOutputs: args.keep_outputs,
            });
            return textEnvelope({ ok: true });
          }
          case "list_flows":
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
          case "job_config":
            return textEnvelope({ ok: true, ...(await getJobConfig(requireId("job_config", "the job whose settings to read back"))) });
          case "preview_config":
            return textEnvelope({
              ok: true,
              ...previewConfig({
                name: requireName("preview_config"),
                datasetPath: requireDatasetPath("preview_config"),
                trigger: args.trigger,
                params: args.params,
              }),
            });
          default: {
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown train_start action "${String(exhaustive)}". Expected one of: start, status, cancel, delete, list_flows, job_config, preview_config.`,
            );
          }
        }
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );

  // ── The trainer itself: preflight and one-time setup ──────────────────────
  server.tool(
    "train_doctor",
    "Preflight and set up the TRAINER ITSELF — the docker/GPU/venv machinery every training job needs. Touches no dataset and no job. Driven by the `action` parameter:\n" +
      '- action:"doctor" — Preflight the local trainer: docker daemon reachable, `--gpus all` GPU passthrough working (NVIDIA Container Toolkit), trainer image built. Read-only, takes no other parameters. Returns per-check booleans + setup hints. Also reports the training data root and whether HF_TOKEN is set (needed to download FLUX.1-dev on first run), the native (dockerless) bootstrap status, and the connected pod. Run this first when a training start fails.\n' +
      '- action:"bootstrap" — Set up the NATIVE (dockerless) trainer on this machine (`target` \'local\', the default) or on a pod (`target` \'pod\', optional `pod_id`): clone ai-toolkit at the pinned commit, create its venv, install torch + requirements. One-time per machine/pod (~10 min fresh, idempotent; a pod\'s /workspace persists it across restarts). Needed before a target \'pod\' train_start on a fresh pod (no docker there). Long-running.\n' +
      `- action:"build_image" — Build the headless GPU trainer image (${TRAINER_IMAGE}) from docker/trainer/Dockerfile — one-time, several minutes (CUDA + torch + ai-toolkit). ASYNC: returns a build id immediately and keeps building in the background, because the build outlasts any tool-call timeout (#2723). Poll action:"doctor" — it reports the build under \`image_build\` and flips \`image\` true when the tag lands. Re-issuing while one runs ADOPTS it rather than starting a second. Requires a reachable docker daemon. \`aiToolkitRef\` pins the ai-toolkit commit/tag for reproducibility. The docker alternative to action:"bootstrap".`,
    {
      action: z
        .enum(["doctor", "bootstrap", "build_image"])
        .describe(
          'Which trainer-setup operation to perform. "doctor" is read-only and takes no other parameters; "bootstrap" takes `target` (+ `pod_id` for target \'pod\'); "build_image" takes an optional `aiToolkitRef`. None of them touches a dataset or a job.',
        ),
      target: z
        .enum(["local", "pod"])
        .optional()
        .default("local")
        .describe('action:"bootstrap" — where to install the native trainer. Default local.'),
      pod_id: z.string().optional().describe('action:"bootstrap" — pod to bootstrap (target \'pod\'). Default: the connected pod.'),
      aiToolkitRef: z
        .string()
        .optional()
        .describe('action:"build_image" — ai-toolkit git ref (commit/tag) to build against. Default: the Dockerfile\'s pinned ref.'),
    },
    async (args) => {
      try {
        switch (args.action) {
          case "doctor": {
            const doctor = await trainerDoctor();
            const { bootstrapStatus } = await import("../services/trainer-bootstrap.js");
            const native = await bootstrapStatus();
            const { trainerImageBuildStatus, trainerImageBuildLooksStalled } = await import(
              "../services/trainer-image-build.js"
            );
            const liveBuild = trainerImageBuildStatus();
            // A detached build that hangs pins the slot: every later build_image
            // adopts it instead of starting one. Say so rather than reporting
            // "running" forever, which is indistinguishable from progress.
            const imageBuild =
              liveBuild && trainerImageBuildLooksStalled(liveBuild)
                ? {
                    ...liveBuild,
                    looks_stalled: true,
                    note:
                      `This build has been running far longer than a docker build of this image takes. ` +
                      `It is most likely wedged (a stalled base-image pull, or a hung daemon). While it ` +
                      `is in this state every build_image call ADOPTS it rather than starting a new one. ` +
                      `Check \`docker ps\` for the build container; restarting the orchestrator clears ` +
                      `the slot.`,
                  }
                : liveBuild;
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
                hfTokenSet: !!config.huggingfaceToken?.trim(),
                // Dataset staging + the LoRA handoff need a LOCAL ComfyUI filesystem
                // on this MCP's machine — false in remote mode, so panel/mobile can
                // warn before a doomed launch instead of failing at staging.
                localFs: !isRemoteMode(),
                // Native (dockerless) trainer bootstrap status — the pod path.
                native: { dir: native.dir, cloned: native.cloned, venv: native.venv, ready: native.ready, ref: native.ref },
                pod,
                // #2723 — doctor is the surface a caller polls after build_image,
                // and it is the one the reporter polled. `image:false` with a
                // build RUNNING, `image:false` with one that ERRORED, and
                // `image:false` with nothing ever attempted are three different
                // situations that used to render identically.
                image_build: imageBuild,
              },
            });
          }
          case "bootstrap": {
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
          }
          case "build_image": {
            if (!(await dockerAvailable())) {
              return textEnvelope({ ok: false, error: { code: "no_docker", message: "Docker daemon not reachable — start Docker Desktop / the docker engine first." } });
            }
            const contextDir = trainerContextDir();
            if (!existsSync(join(contextDir, "Dockerfile"))) {
              return textEnvelope({ ok: false, error: { code: "no_dockerfile", message: `Trainer Dockerfile not found at ${contextDir} — the docker/ dir may not be shipped in this install.` } });
            }
            // #2723 — do NOT await it. This is a CUDA + torch + ai-toolkit image
            // build, documented as several minutes, and the panel's call_tool
            // transport hard-times out at 300s: awaiting it meant the call ALWAYS
            // returned "timed out awaiting tools/call after 300s" and a follow-up
            // doctor still said image:false. Local Docker training was unreachable,
            // not slow. Return a handle and let doctor report it — the same shape
            // download_model and enqueue_workflow already use.
            const { startTrainerImageBuild } = await import("../services/trainer-image-build.js");
            const { build, adopted, refMismatch } = startTrainerImageBuild({
              contextDir,
              aiToolkitRef: args.aiToolkitRef,
            });
            if (refMismatch) {
              // Adopting across a different `aiToolkitRef` would report success for
              // an image built from another commit — silently defeating the one
              // thing that parameter is for.
              return textEnvelope({
                ok: false,
                error: {
                  code: "build_ref_mismatch",
                  message:
                    `A build of ${refMismatch.image} is already running (${refMismatch.id}) from ` +
                    `ai-toolkit ref ${refMismatch.ai_toolkit_ref ?? "(default)"}, and this call asked for ` +
                    `${args.aiToolkitRef ?? "(default)"}. It was NOT adopted: the tag that lands would be ` +
                    `the running build's, not the one requested. Two docker builds against one tag race ` +
                    `for the layer cache, so a second was not started either. Poll train_doctor ` +
                    `(action:"doctor") until that build settles, then re-issue with the ref you want.`,
                },
                data: { running_build: refMismatch, requested_ai_toolkit_ref: args.aiToolkitRef ?? null },
              });
            }
            return textEnvelope({
              ok: true,
              command: TRAINER_COMMAND.buildImage,
              data: {
                build,
                // Adoption rather than a second build: two `docker build` runs
                // against one tag race for the layer cache. A caller who
                // re-issues after the old 300s timeout must not start another.
                adopted,
                note: adopted
                  ? `A build of ${build.image} was already running (${build.id}); this call adopted it rather than starting a second one. Poll train_doctor (action:"doctor") — it reports this build under \`image_build\`.`
                  : `Started building ${build.image} in the background (${build.id}). This takes several minutes on a cold cache. It is NOT tied to this call, so poll train_doctor (action:"doctor") — it reports progress under \`image_build\` and \`image\` flips true when the tag lands.`,
              },
            });
          }
          default: {
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown train_doctor action "${String(exhaustive)}". Expected one of: doctor, bootstrap, build_image.`,
            );
          }
        }
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );
}

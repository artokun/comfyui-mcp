// Drives the headless GPU trainer container (docker/trainer/Dockerfile) that runs
// ostris ai-toolkit's `run.py`. This is the runtime half of the trainer: preflight
// docker + GPU, build the image once, then `docker run --gpus all` a generated
// config and stream ai-toolkit's progress back out.
//
// Modeled on src/services/comfy-cli.ts (external-CLI wrapper): quick probes via
// execFile, the long training run via spawn with streamed stdout, and results
// normalized into a small envelope so callers/tools get a uniform shape.

import childProcess from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../utils/logger.js";

/** Uniform result shape for trainer operations (mirrors the comfy-cli envelope). */
export interface TrainerEnvelope<T = unknown> {
  ok: boolean;
  command: string;
  data?: T;
  error?: { code: string; message: string };
  stderr?: string;
}

/** Image tag we build/run. */
export const TRAINER_IMAGE = process.env.COMFYUI_MCP_TRAINER_IMAGE?.trim() || "comfyui-mcp-trainer:latest";

/** The ai-toolkit commit every trainer surface pins to — the one the P1 E2E
 *  run was validated against. Single source of truth (Dockerfile ARG mirrors
 *  it; the bootstrap service clones it). */
export const AI_TOOLKIT_REF = "a0224793cef5d5073c8ed0b8cdb838a84fd1cba0";
export const AI_TOOLKIT_REPO = "https://github.com/ostris/ai-toolkit.git";

/** Docker executable — env override, else PATH. */
export function resolveDocker(): string {
  return process.env.COMFYUI_MCP_DOCKER?.trim() || "docker";
}

function ok<T>(command: string, data?: T): TrainerEnvelope<T> {
  return { ok: true, command, data };
}
function fail(command: string, code: string, message: string, stderr?: string): TrainerEnvelope<never> {
  return { ok: false, command, error: { code, message }, stderr };
}

/** Run a short docker command, capturing stdout/stderr. Never throws. */
function execDocker(args: string[], timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    childProcess.execFile(
      resolveDocker(),
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

/** Is the docker daemon reachable? */
export async function dockerAvailable(): Promise<boolean> {
  const r = await execDocker(["version", "--format", "{{.Server.Version}}"]);
  return r.code === 0 && r.stdout.trim().length > 0;
}

/** Is `--gpus all` usable (NVIDIA Container Toolkit present)? Runs a tiny CUDA
 *  image's `nvidia-smi`; slower, so callers cache the result. */
export async function gpuDockerAvailable(): Promise<boolean> {
  const r = await execDocker(
    ["run", "--rm", "--gpus", "all", "nvidia/cuda:12.8.1-base-ubuntu24.04", "nvidia-smi", "-L"],
    120_000,
  );
  return r.code === 0 && /GPU \d+/.test(r.stdout);
}

/** Does our trainer image exist locally? */
export async function trainerImageExists(): Promise<boolean> {
  const r = await execDocker(["image", "inspect", TRAINER_IMAGE]);
  return r.code === 0;
}

/**
 * Preflight report for `train_doctor`: docker daemon, GPU passthrough, image
 * presence. Returns an envelope with a per-check breakdown so the UI/LLM can
 * give the user precise setup guidance instead of a cryptic run failure.
 */
export async function trainerDoctor(): Promise<TrainerEnvelope<{
  docker: boolean;
  gpu: boolean;
  image: boolean;
  image_tag: string;
  hints: string[];
}>> {
  const docker = await dockerAvailable();
  const hints: string[] = [];
  if (!docker) {
    hints.push("Docker daemon not reachable — install/start Docker Desktop (Windows) or the docker engine.");
    return ok("train_doctor", { docker, gpu: false, image: false, image_tag: TRAINER_IMAGE, hints });
  }
  const [gpu, image] = await Promise.all([gpuDockerAvailable(), trainerImageExists()]);
  if (!gpu) hints.push("`docker run --gpus all` failed — install the NVIDIA Container Toolkit and enable GPU support in Docker.");
  if (!image) hints.push(`Trainer image ${TRAINER_IMAGE} not built yet — run train_build_image (one-time, several minutes).`);
  return ok("train_doctor", { docker, gpu, image, image_tag: TRAINER_IMAGE, hints });
}

/**
 * Build the trainer image from docker/trainer/Dockerfile. Long-running; streams
 * build output via onLog. `contextDir` is the docker/trainer dir.
 */
export function buildTrainerImage(opts: {
  contextDir: string;
  aiToolkitRef?: string;
  onLog?: (line: string) => void;
}): Promise<TrainerEnvelope<{ image: string }>> {
  const args = ["build", "-t", TRAINER_IMAGE];
  if (opts.aiToolkitRef) args.push("--build-arg", `AI_TOOLKIT_REF=${opts.aiToolkitRef}`);
  args.push(opts.contextDir);
  return streamDocker(args, opts.onLog).then((r) =>
    r.code === 0 ? ok("train_build_image", { image: TRAINER_IMAGE }) : fail("train_build_image", "build_failed", `docker build exited ${r.code}`, r.tail),
  );
}

/** Handle to a running training container. */
export interface TrainingHandle {
  /** `--name` we assigned (also used to stop it). */
  containerName: string;
  /** The spawned `docker run` child (resolves when training exits). */
  done: Promise<{ code: number; tail: string }>;
  child: childProcess.ChildProcess;
}

/** A parsed progress tick from ai-toolkit's training stdout. */
export interface TrainingProgress {
  step?: number;
  totalSteps?: number;
  loss?: number;
  /** A saved sample-image path/line, when seen. */
  sample?: string;
  /** The raw line (always present). */
  raw: string;
}

/**
 * Parse one stdout line from ai-toolkit into a progress tick. ai-toolkit prints a
 * tqdm-style bar with the job name, `<step>/<total>` and a `loss: <n>` postfix,
 * e.g. `my_lora:  12%|#2 | 240/2000 [01:03<07:41, ... loss: 3.9e-01]`.
 *
 * A bare `<n>/<total>` is NOT trusted as training progress: ai-toolkit also
 * prints dataset-scan / download / weight-loading bars (e.g. `6/6`) that would
 * otherwise masquerade as steps (found by the first real E2E run). Step/total
 * is only assigned when the line also carries a loss reading.
 */
export function parseTrainingProgress(line: string): TrainingProgress | null {
  const raw = line.trim();
  if (!raw) return null;
  const stepMatch = raw.match(/(\d+)\s*\/\s*(\d+)/);
  const lossMatch = raw.match(/loss[:=]\s*([\d.eE+-]+)/);
  const sampleMatch = raw.match(/(?:saved|sample).*?([^\s'"]+\.(?:png|jpg|jpeg))/i);
  if (!stepMatch && !lossMatch && !sampleMatch) return null;
  const tick: TrainingProgress = { raw };
  if (stepMatch && lossMatch) {
    tick.step = Number(stepMatch[1]);
    tick.totalSteps = Number(stepMatch[2]);
  }
  if (lossMatch) {
    const n = Number(lossMatch[1]);
    if (Number.isFinite(n)) tick.loss = n;
  }
  if (sampleMatch) tick.sample = sampleMatch[1];
  // A line with ONLY a bare step/total (no loss, no sample) is not progress.
  if (tick.step === undefined && tick.loss === undefined && tick.sample === undefined) return null;
  return tick;
}

/**
 * Start a training run: `docker run --gpus all` with the config/dataset/output/HF
 * mounts. Returns immediately with a handle; caller awaits `handle.done`. Progress
 * ticks are delivered via onProgress. Paths are host paths; the container sees the
 * fixed mount points `/config.yml`, `/dataset`, `/output`.
 */
export function startTraining(opts: {
  containerName: string;
  configPath: string;
  datasetPath: string;
  outputDir: string;
  hfCacheDir?: string;
  hfToken?: string;
  onProgress?: (p: TrainingProgress) => void;
  onLog?: (line: string) => void;
}): TrainingHandle {
  const args = [
    "run", "--rm", "--gpus", "all", "--name", opts.containerName,
    "-v", `${opts.configPath}:/config.yml:ro`,
    // Dataset is mounted READ-WRITE: ai-toolkit writes cache files into it
    // (.aitk_size.json, latent caches) — a read-only mount fails the run
    // ([Errno 30] on .aitk_size.json, found by the first real E2E run).
    "-v", `${opts.datasetPath}:/dataset`,
    "-v", `${opts.outputDir}:/output`,
  ];
  if (opts.hfCacheDir) args.push("-v", `${opts.hfCacheDir}:/root/.cache/huggingface`);
  if (opts.hfToken) args.push("-e", `HF_TOKEN=${opts.hfToken}`);
  args.push(TRAINER_IMAGE, "/config.yml");

  return spawnTrainer(opts.containerName, resolveDocker(), args, { ...process.env } as Record<string, string>, opts);
}

// ---- native (dockerless) mode --------------------------------------------------
// Pods (RunPod) can't nest docker — the pod IS the container — and some Linux
// rigs have no docker at all. Native mode spawns ai-toolkit's run.py directly
// with the same streamed progress + handle shape, so the registry/finalize/
// cancel machinery is identical either way (P4).

/** The ai-toolkit checkout to run in native mode (bootstrap service populates
 *  it). Env override for development. */
export function resolveAiToolkitDir(): string {
  return (
    process.env.COMFYUI_MCP_AI_TOOLKIT_DIR?.trim() ||
    join(process.env.COMFYUI_MCP_DATA_DIR?.trim() || join(homedir(), ".comfyui-mcp"), "training", "ai-toolkit")
  );
}

/** The python of the ai-toolkit venv (bootstrap creates it). */
export function resolveAiToolkitPython(): string {
  if (process.env.COMFYUI_MCP_AI_TOOLKIT_PYTHON?.trim()) return process.env.COMFYUI_MCP_AI_TOOLKIT_PYTHON.trim();
  const dir = resolveAiToolkitDir();
  return process.platform === "win32"
    ? join(dir, "venv", "Scripts", "python.exe")
    : join(dir, "venv", "bin", "python");
}

/** Is a native training environment present (checkout + venv python)? */
export async function nativeToolkitReady(): Promise<boolean> {
  try {
    const { existsSync } = await import("node:fs");
    return existsSync(join(resolveAiToolkitDir(), "run.py")) && existsSync(resolveAiToolkitPython());
  } catch {
    return false;
  }
}

/**
 * Native training run: `<venv-python> run.py config.yml` with cwd at the
 * ai-toolkit checkout. Config paths (dataset/output) are REAL host paths —
 * unlike docker mode, no mount-point rewrite. HF cache goes via HF_HOME.
 */
export function startNativeTraining(opts: {
  containerName: string; // kept for handle/registry compatibility (no container exists)
  configPath: string;
  datasetPath: string; // unused by the spawn (config already points here) — kept for parity
  outputDir: string;
  hfCacheDir?: string;
  hfToken?: string;
  onProgress?: (p: TrainingProgress) => void;
  onLog?: (line: string) => void;
}): TrainingHandle {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PYTHONUNBUFFERED: "1",
    PYTHONUTF8: "1",
    HF_HUB_ENABLE_HF_TRANSFER: "1",
  };
  if (opts.hfCacheDir) env.HF_HOME = opts.hfCacheDir;
  if (opts.hfToken) env.HF_TOKEN = opts.hfToken;
  return spawnTrainer(opts.containerName, resolveAiToolkitPython(), ["run.py", opts.configPath], env, opts, resolveAiToolkitDir());
}

/** Stop a NATIVE training process (the handle's child). Best-effort group kill:
 *  SIGTERM the process group on posix, taskkill /T on Windows. Honest envelope
 *  like stopTraining. */
export async function stopNativeTraining(child: childProcess.ChildProcess): Promise<TrainerEnvelope<{ stopped: string }>> {
  try {
    if (process.platform === "win32" && child.pid) {
      childProcess.execSync(`taskkill /PID ${child.pid} /T /F`, { timeout: 10_000, windowsHide: true });
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        process.kill(child.pid, "SIGTERM");
      }
    }
    return ok("train_cancel", { stopped: String(child.pid ?? "unknown") });
  } catch (err) {
    return fail("train_cancel", "stop_failed", `could not stop native training (pid ${child.pid}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Shared spawn+stream+tail for docker and native trainers. */
function spawnTrainer(
  name: string,
  executable: string,
  args: string[],
  env: Record<string, string>,
  opts: {
    onProgress?: (p: TrainingProgress) => void;
    onLog?: (line: string) => void;
  },
  cwd?: string,
): TrainingHandle {
  // detached on posix so stopNativeTraining can kill the whole process group.
  const child = childProcess.spawn(executable, args, {
    windowsHide: true,
    env,
    cwd,
    detached: process.platform !== "win32",
  });
  const tailLines: string[] = [];
  const pushTail = (s: string) => {
    tailLines.push(s);
    if (tailLines.length > 200) tailLines.shift();
  };
  const onLine = (line: string) => {
    pushTail(line);
    opts.onLog?.(line);
    const tick = parseTrainingProgress(line);
    if (tick && opts.onProgress) opts.onProgress(tick);
  };
  lineStream(child.stdout, onLine);
  lineStream(child.stderr, onLine);

  const done = new Promise<{ code: number; tail: string }>((resolve) => {
    child.on("close", (code) => resolve({ code: code ?? 0, tail: tailLines.slice(-40).join("\n") }));
    child.on("error", (err) => {
      logger.debug(`[ai-toolkit] trainer spawn error: ${err instanceof Error ? err.message : String(err)}`);
      resolve({ code: 1, tail: tailLines.slice(-40).join("\n") });
    });
  });
  return { containerName: name, done, child };
}

/** Stop a running training container. The envelope is honest about failure:
 *  a non-zero `docker stop` (daemon down, timeout) yields ok:false so callers
 *  don't report a container as stopped while it keeps burning GPU. An
 *  already-gone container counts as stopped. */
export async function stopTraining(containerName: string): Promise<TrainerEnvelope<{ stopped: string }>> {
  const r = await execDocker(["stop", "-t", "10", containerName], 30_000);
  if (r.code !== 0 && !/no such (object|container)/i.test(r.stderr)) {
    return fail("train_cancel", "stop_failed", `docker stop ${containerName} failed: ${r.stderr.trim() || `exit ${r.code}`}`, r.stderr);
  }
  return ok("train_cancel", { stopped: containerName });
}

/** Is this training container currently running? `false` when it definitively
 *  does not exist, `null` when we can't tell (docker daemon down, etc.) — the
 *  registry uses this to avoid mis-marking a live foreign-process job failed. */
export async function containerRunning(containerName: string): Promise<boolean | null> {
  const r = await execDocker(["inspect", "-f", "{{.State.Running}}", containerName]);
  if (r.code === 0) return r.stdout.trim() === "true";
  if (/no such (object|container)/i.test(r.stderr)) return false;
  return null;
}

// ---- helpers ---------------------------------------------------------------

/** Spawn a docker command, streaming output through onLog, resolving on close. */
function streamDocker(
  args: string[],
  onLog?: (line: string) => void,
): Promise<{ code: number; tail: string }> {
  const child = childProcess.spawn(resolveDocker(), args, { windowsHide: true, env: { ...process.env } });
  const tail: string[] = [];
  const onLine = (line: string) => {
    tail.push(line);
    if (tail.length > 200) tail.shift();
    onLog?.(line);
  };
  lineStream(child.stdout, onLine);
  lineStream(child.stderr, onLine);
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code: code ?? 0, tail: tail.slice(-40).join("\n") }));
    child.on("error", () => resolve({ code: 1, tail: tail.slice(-40).join("\n") }));
  });
}

/** Split a readable stream into trimmed lines. */
function lineStream(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return;
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    // ai-toolkit's tqdm bar uses \r; treat both \r and \n as line breaks.
    const parts = buf.split(/\r\n|\r|\n/);
    buf = parts.pop() ?? "";
    for (const line of parts) if (line.trim()) onLine(line);
  });
  stream.on("end", () => {
    if (buf.trim()) onLine(buf);
  });
}

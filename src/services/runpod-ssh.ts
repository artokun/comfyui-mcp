// SSH transport for pod-native training (P4). The local orchestrator drives
// ai-toolkit on a RunPod pod over plain ssh/rsync — the pod template sets sshd
// up with the user's $PUBLIC_KEY (docker/runpod/post_start.sh), so access is
// key-only and non-interactive (BatchMode).
//
// Convention: a pod job's `containerName` is NOT a docker container — it's
// `pod|<user@host>|<port>` — so the containerName-based stop/liveness/registry
// plumbing (proven in #237) works unchanged for pod jobs: the pod variants of
// stop/probe parse the endpoint back out of the name.

import childProcess from "node:child_process";
import { logger } from "../utils/logger.js";
import type { RunpodPod } from "./runpod-client.js";
import type { TrainerEnvelope, TrainingHandle, TrainingProgress } from "./ai-toolkit.js";
import { parseTrainingProgress } from "./ai-toolkit.js";

export interface PodSshEndpoint {
  /** user@host, e.g. "root@203.0.113.10". */
  userHost: string;
  port: number;
}

/** The pod-side training root (persistent volume on the template). */
export const POD_TRAINING_ROOT = "/workspace/training";

/** Resolve a pod's SSH endpoint from its runtime ports (privatePort 22/tcp →
 *  public ip:port). Null when the pod isn't running or exposes no ssh. */
export function podSshEndpoint(pod: RunpodPod, user = "root"): PodSshEndpoint | null {
  const p = (pod.runtime?.ports ?? []).find((x) => x.privatePort === 22 && x.type === "tcp" && x.isIpPublic);
  if (!p || !p.ip) return null;
  return { userHost: `${user}@${p.ip}`, port: p.publicPort };
}

/** The `pod|user@host|port` container-name encoding. */
export function encodePodContainerName(ep: PodSshEndpoint): string {
  return `pod|${ep.userHost}|${ep.port}`;
}
export function decodePodContainerName(name: string): PodSshEndpoint | null {
  const m = name.match(/^pod\|([^|]+)\|(\d+)$/);
  if (!m) return null;
  return { userHost: m[1], port: Number(m[2]) };
}

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"];

/** Remote paths for one pod job (under the persistent volume). */
export function podJobPaths(jobId: string, jobName: string): {
  jobDir: string;
  configPath: string;
  datasetDir: string;
  outputDir: string;
  hfCacheDir: string;
  lorasDir: string;
} {
  const jobDir = `${POD_TRAINING_ROOT}/jobs/${jobId}`;
  return {
    jobDir,
    configPath: `${jobDir}/config.yml`,
    datasetDir: `${POD_TRAINING_ROOT}/datasets/${jobName}`,
    outputDir: `${jobDir}/output`,
    hfCacheDir: `${POD_TRAINING_ROOT}/hf-cache`,
    lorasDir: "/workspace/models/loras",
  };
}

function ok<T>(command: string, data?: T): TrainerEnvelope<T> {
  return { ok: true, command, data };
}
function fail(command: string, code: string, message: string, stderr?: string): TrainerEnvelope<never> {
  return { ok: false, command, error: { code, message }, stderr };
}

function exec(cmd: string, args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    childProcess.execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** Is ssh usable at all (binary present + endpoint answers BatchMode auth)? */
export async function sshEndpointWorks(ep: PodSshEndpoint): Promise<boolean> {
  const r = await exec("ssh", [...SSH_OPTS, "-p", String(ep.port), ep.userHost, "true"], 20_000);
  return r.code === 0;
}

/** Run a short command on the pod. */
export function sshExec(ep: PodSshEndpoint, remoteCmd: string, timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return exec("ssh", [...SSH_OPTS, "-p", String(ep.port), ep.userHost, remoteCmd], timeoutMs);
}

/** The self-match-proof process pattern: a bracketed first letter keeps the
 *  probe's own shell cmdline (which contains the literal text) from matching
 *  (codex finding: pgrep/pkill -f 'run.py' matched the invoking shell). */
export const RUNPY_PATTERN = "[r]un.py";

/** Pipe helper: spawn producer, stream its stdout into consumer's stdin,
 *  resolve with both exit codes. The transport behind the rsync-replacements
 *  below (Windows rigs have tar+ssh but no rsync — codex/E2E finding).
 *  Every settle path kills BOTH children: a dead consumer (e.g. ssh auth
 *  failure) must not leave tar writing into a closed pipe, and a dead
 *  producer must not leave ssh waiting on stdin forever (codex finding:
 *  EPIPE on cons.stdin is an uncaught stream error that kills the MCP
 *  process). */
function pipe(producer: { cmd: string; args: string[] }, consumer: { cmd: string; args: string[] }, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const prod = childProcess.spawn(producer.cmd, producer.args, { windowsHide: true });
    const cons = childProcess.spawn(consumer.cmd, consumer.args, { windowsHide: true });
    const errTail: string[] = [];
    const outTail: string[] = [];
    const grab = (s: NodeJS.ReadableStream | null, into: string[]) => {
      if (!s) return;
      s.setEncoding("utf8");
      s.on("data", (chunk: string) => {
        into.push(chunk);
        if (into.length > 40) into.shift();
      });
    };
    grab(prod.stderr, errTail);
    grab(cons.stdout, outTail);
    grab(cons.stderr, errTail);
    let settled = false;
    const settle = (result: { code: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { prod.kill("SIGKILL"); } catch { /* already exited */ }
      try { cons.kill("SIGKILL"); } catch { /* already exited */ }
      resolve(result);
    };
    const timer = setTimeout(() => {
      settle({ code: 124, stdout: outTail.join(""), stderr: `pipe timed out after ${timeoutMs}ms\n${errTail.join("")}` });
    }, timeoutMs);
    // Stream errors (EPIPE when the peer dies mid-transfer) are expected
    // failure noise — record them, never let them crash the process. The
    // child 'close' handlers do the actual settling.
    prod.stdout?.on("error", (e) => { errTail.push(`producer stdout: ${e.message}\n`); });
    cons.stdin?.on("error", (e) => { errTail.push(`consumer stdin: ${e.message}\n`); });
    prod.stdout?.pipe(cons.stdin ?? process.stdin);
    // Settle only when BOTH exit codes are known (codex finding: consumer can
    // close cleanly while the producer is still finishing — e.g. remote tar
    // exits nonzero AFTER closing stdout; resolving on consumer-close alone
    // would report success with the initial producer code and kill the
    // producer before its real status arrives). A NONZERO consumer close
    // settles immediately — no point waiting for a producer whose output is
    // already unconsumable; settle() kills it.
    let prodCode: number | null = null;
    let consCode: number | null = null;
    const maybeSettle = () => {
      if (consCode === null) return;
      if (consCode !== 0) {
        settle({ code: consCode, stdout: outTail.join(""), stderr: errTail.join("") });
        return;
      }
      if (prodCode === null) return;
      settle({ code: prodCode !== 0 ? prodCode : consCode, stdout: outTail.join(""), stderr: errTail.join("") });
    };
    prod.on("error", (e) => {
      settle({ code: 1, stdout: "", stderr: `${producer.cmd} failed to start: ${e.message}` });
    });
    prod.on("close", (code) => {
      prodCode = code ?? 1;
      try { cons.stdin?.end(); } catch { /* consumer already gone */ }
      maybeSettle();
    });
    cons.on("error", (e) => {
      settle({ code: 1, stdout: "", stderr: `${consumer.cmd} failed to start: ${e.message}` });
    });
    cons.on("close", (code) => {
      consCode = code ?? 1;
      maybeSettle();
    });
  });
}

function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Upload a local dir's CONTENTS to a pod dir (rsync trailing-slash semantics,
 *  via tar-over-ssh — no rsync binary needed on either side). The remote dir
 *  is DELETED+recreated first (`rsync --delete` semantics): its content is
 *  keyed by job/dataset name, so a re-staged dataset must not inherit files
 *  removed locally since the last run (codex finding). */
export function rsyncToPod(ep: PodSshEndpoint, localDir: string, remoteDir: string, timeoutMs = 300_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const src = toForwardSlashes(localDir.replace(/[\\/]$/, ""));
  const remote = remoteDir.replace(/'/g, "'\\''");
  return pipe(
    { cmd: "tar", args: ["-C", src, "-czf", "-", "."] },
    { cmd: "ssh", args: [...SSH_OPTS, "-p", String(ep.port), ep.userHost, `rm -rf '${remote}' && mkdir -p '${remote}' && tar --no-same-owner --no-same-permissions -xzf - -C '${remote}'`] },
    timeoutMs,
  );
}

/** rsync one FILE up to a pod path (parent created remotely first). Honors
 *  copy-to-PATH semantics: the payload lands at the exact remotePath even
 *  when the local basename differs (e.g. ai-toolkit's `name_N.safetensors` →
 *  requested `name.safetensors`). Extraction happens in a same-dir mktemp
 *  staging dir so a differing local basename can never clobber an unrelated
 *  existing remote file mid-transfer, and the final mv is a same-filesystem
 *  rename (codex finding). The tar wrapper keeps truncated transfers
 *  detectable (remote tar exits nonzero on a short archive). */
export async function rsyncFileToPod(ep: PodSshEndpoint, localFile: string, remotePath: string, timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const parent = remotePath.slice(0, remotePath.lastIndexOf("/"));
  const parentQ = parent.replace(/'/g, "'\\''");
  const mk = await sshExec(ep, `mkdir -p '${parentQ}'`, 30_000);
  if (mk.code !== 0) return mk;
  const base = toForwardSlashes(localFile);
  const dir = base.slice(0, base.lastIndexOf("/")) || ".";
  const name = base.slice(base.lastIndexOf("/") + 1);
  const nameQ = name.replace(/'/g, "'\\''");
  const remote = remotePath.replace(/'/g, "'\\''");
  const extract = `tmp=$(mktemp -d '${parentQ}/.xfer.XXXXXX') && trap 'rm -rf "$tmp"' EXIT && tar --no-same-owner --no-same-permissions -xzf - -C "$tmp" && mv -f -- "$tmp"/'${nameQ}' '${remote}' && test -f '${remote}'`;
  return pipe(
    { cmd: "tar", args: ["-C", dir, "-czf", "-", "--", name] },
    { cmd: "ssh", args: [...SSH_OPTS, "-p", String(ep.port), ep.userHost, extract] },
    timeoutMs,
  );
}

/** Download a pod dir's CONTENTS to a local dir (created if missing). */
export async function rsyncFromPod(ep: PodSshEndpoint, remoteDir: string, localDir: string, timeoutMs = 600_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const remote = remoteDir.replace(/'/g, "'\\''");
  const dst = toForwardSlashes(localDir.replace(/[\\/]$/, ""));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dst, { recursive: true });
  return pipe(
    { cmd: "ssh", args: [...SSH_OPTS, "-p", String(ep.port), ep.userHost, `tar -C '${remote}' -czf - .`] },
    { cmd: "tar", args: ["-xzf", "-", "-C", dst] },
    timeoutMs,
  );
}

/**
 * Start pod-native training: `<venv>/bin/python run.py <remote config>` over
 * ssh, streamed EXACTLY like the local drivers (same progress parse). Killing
 * the local ssh child drops the connection; stopSshTraining pkills the remote
 * run.py by its config path.
 */
export function startSshTraining(opts: {
  containerName: string; // encodePodContainerName(ep)
  remoteConfigPath: string;
  hfCacheDir?: string;
  hfToken?: string;
  aiToolkitDir?: string; // default POD_TRAINING_ROOT/ai-toolkit
  onProgress?: (p: TrainingProgress) => void;
  onLog?: (line: string) => void;
}): TrainingHandle | { error: string } {
  const ep = decodePodContainerName(opts.containerName);
  if (!ep) return { error: `not a pod container name: ${opts.containerName}` };
  const toolkitDir = opts.aiToolkitDir ?? `${POD_TRAINING_ROOT}/ai-toolkit`;
  const env: string[] = ["PYTHONUNBUFFERED=1", "PYTHONUTF8=1", "HF_HUB_ENABLE_HF_TRANSFER=1"];
  if (opts.hfCacheDir) env.push(`HF_HOME=${opts.hfCacheDir}`);
  // HF_TOKEN travels the ssh command line — acceptable on a single-user pod
  // (its process list is the user's own). Never logged here.
  if (opts.hfToken) env.push(`HF_TOKEN='${opts.hfToken.replace(/'/g, "'\\''")}'`);
  const remote = `cd ${toolkitDir} && ${env.join(" ")} ./venv/bin/python run.py ${opts.remoteConfigPath}`;

  const child = childProcess.spawn("ssh", [...SSH_OPTS, "-p", String(ep.port), ep.userHost, remote], {
    windowsHide: true,
    env: { ...process.env },
  });
  const tailLines: string[] = [];
  const onLine = (line: string) => {
    tailLines.push(line);
    if (tailLines.length > 200) tailLines.shift();
    opts.onLog?.(line);
    const tick = parseTrainingProgress(line);
    if (tick) opts.onProgress?.(tick);
  };
  for (const s of [child.stdout, child.stderr]) {
    if (!s) continue;
    s.setEncoding("utf8");
    let buf = "";
    s.on("data", (chunk: string) => {
      buf += chunk;
      const parts = buf.split(/\r\n|\r|\n/);
      buf = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) onLine(line);
    });
    s.on("end", () => {
      if (buf.trim()) onLine(buf);
    });
  }
  const done = new Promise<{ code: number; tail: string }>((resolve) => {
    child.on("close", (code) => resolve({ code: code ?? 1, tail: tailLines.slice(-40).join("\n") }));
    child.on("error", (err) => {
      logger.debug(`[runpod-ssh] ssh spawn error: ${err instanceof Error ? err.message : String(err)}`);
      resolve({ code: 1, tail: tailLines.slice(-40).join("\n") });
    });
  });
  return { containerName: opts.containerName, done, child };
}

/** Stop a pod job: pkill the remote run.py by its config path (idempotent).
 *  The pattern is bracketed so the invoking shell can't self-match. */
export async function stopSshTraining(containerName: string, remoteConfigPath?: string): Promise<TrainerEnvelope<{ stopped: string }>> {
  const ep = decodePodContainerName(containerName);
  if (!ep) return fail("train_cancel", "not_pod", `not a pod container name: ${containerName}`);
  const pattern = remoteConfigPath ? `${RUNPY_PATTERN} ${remoteConfigPath}` : RUNPY_PATTERN;
  const r = await sshExec(ep, `pkill -f '${pattern.replace(/'/g, "'\\''")}' || true`, 30_000);
  if (r.code !== 0) {
    return fail("train_cancel", "stop_failed", `remote pkill on ${ep.userHost} failed: ${r.stderr.trim() || `exit ${r.code}`}`, r.stderr);
  }
  return ok("train_cancel", { stopped: containerName });
}

/** Is a pod job's run.py still alive? false = definitively not running,
 *  null = can't tell (ssh unreachable). Bracketed against self-match. */
export async function sshProcessRunning(containerName: string): Promise<boolean | null> {
  const ep = decodePodContainerName(containerName);
  if (!ep) return null;
  const r = await sshExec(ep, `pgrep -f '${RUNPY_PATTERN}' >/dev/null && echo RUNNING || echo GONE`, 20_000);
  if (r.code !== 0) return null; // ssh itself failed (pod down / network)
  return r.stdout.includes("RUNNING");
}

/** Run the trainer bootstrap ON the pod (clone+venv+deps, idempotent). */
export async function bootstrapToolkitOnPod(
  ep: PodSshEndpoint,
  bootstrapCmd: string,
  timeoutMs = 1_800_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return sshExec(ep, bootstrapCmd, timeoutMs);
}

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
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
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

// ---- verified pod-dir download (codex #263 blocker) --------------------------
// A 172MB LoRA pull that dies mid-stream must never publish a truncated file,
// and a pod-controlled archive must never plant a symlink/traversal entry that
// a later copyFileSync follows. The pull is therefore: remote size+sha256
// manifest → archive downloaded to a temp FILE (ssh exit code authoritative) →
// entries validated BEFORE extraction → extracted into a temp STAGE dir →
// every manifest file verified (size, and sha256 when the pod emitted one) →
// atomic same-dir rename into place. Any failure leaves the destination
// untouched and cleans the temps.

/** Sentinel between the size section and the sha256 section of the manifest. */
const MANIFEST_SUMS_SENTINEL = "__CMCP_SUMS__";

/** Reject unsafe tar entry NAMES: absolute, drive-letter, backslash, or a
 *  `..` path component (exported for tests). */
export function validateArchiveEntryNames(names: string[]): string | null {
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    if (name.includes("\\")) return `unsafe archive entry (backslash in name): ${name}`;
    if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return `unsafe archive entry (absolute path): ${name}`;
    if (name.split("/").includes("..")) return `unsafe archive entry (path traversal): ${name}`;
  }
  return null;
}

/** Reject unsafe tar entry TYPES from a `tar -tvf` listing: a symlink at the
 *  expected .safetensors name would be FOLLOWED by the handoff's copyFileSync
 *  (codex #263); hardlinks and device/fifo/socket entries have no business in
 *  a training output dir either (exported for tests). */
export function findUnsafeArchiveType(tvListing: string): string | null {
  for (const line of tvListing.split(/\r?\n/)) {
    const t = line.charAt(0);
    if (t === "l" || t === "h" || t === "c" || t === "b" || t === "p" || t === "s") {
      return `unsafe archive entry (type '${t}'): ${line.trim()}`;
    }
  }
  return null;
}

/** Parse the remote manifest: `<size>\t<path>` lines, the sentinel, then
 *  optional `sha256sum` lines. Paths are normalized without the `./` prefix. */
function parsePodManifest(stdout: string): { sizes: Map<string, number>; sums: Map<string, string> } {
  const sizes = new Map<string, number>();
  const sums = new Map<string, string>();
  let inSums = false;
  for (const line of stdout.split("\n")) {
    const s = line.replace(/\r$/, "");
    if (s === MANIFEST_SUMS_SENTINEL) { inSums = true; continue; }
    if (!s) continue;
    if (!inSums) {
      const i = s.indexOf("\t");
      if (i < 0) continue;
      const n = Number(s.slice(0, i));
      if (Number.isFinite(n)) sizes.set(s.slice(i + 1).replace(/^\.\//, ""), n);
    } else {
      const m = s.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
      if (m) sums.set(m[2].replace(/^\.\//, ""), m[1].toLowerCase());
    }
  }
  return { sizes, sums };
}

function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(p);
    s.on("error", reject);
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

/** Spawn ssh and stream its stdout into a local file; the ssh EXIT CODE is
 *  the transfer's truth (a mid-stream death is nonzero — the old streaming
 *  pipe extracted whatever arrived and could look successful). */
function downloadToFile(args: string[], outFile: string, timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = childProcess.spawn("ssh", args, { windowsHide: true });
    const ws = createWriteStream(outFile);
    const errTail: string[] = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => {
      errTail.push(c);
      if (errTail.length > 40) errTail.shift();
    });
    let settled = false;
    let childCode: number | null = null;
    let streamClosed = false;
    let streamErr: string | null = null;
    const settle = () => {
      if (settled || childCode === null || !streamClosed) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: streamErr ? childCode || 1 : childCode, stderr: (streamErr ? `${streamErr}\n` : "") + errTail.join("") });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      ws.destroy();
      resolve({ code: 124, stderr: `download timed out after ${timeoutMs}ms\n${errTail.join("")}` });
    }, timeoutMs);
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.destroy();
      resolve({ code: 1, stderr: `ssh failed to start: ${e.message}` });
    });
    ws.on("error", (e) => {
      streamErr = `write ${outFile}: ${e.message}`;
      streamClosed = true;
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      settle();
    });
    ws.on("close", () => {
      streamClosed = true;
      settle();
    });
    child.stdout?.pipe(ws);
    child.on("close", (code) => {
      childCode = code ?? 1;
      settle();
    });
  });
}

/** Download a pod dir's CONTENTS to a local dir — VERIFIED (see block comment
 *  above). On success `localDir` holds exactly the verified content; on ANY
 *  failure it is left untouched (pre-existing content survives) and the
 *  return code is nonzero. */
export async function rsyncFromPod(ep: PodSshEndpoint, remoteDir: string, localDir: string, timeoutMs = 600_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const remote = remoteDir.replace(/'/g, "'\\''");
  const dst = localDir.replace(/[\\/]$/, "");
  const stamp = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const archive = `${dst}.dl-${stamp}.tgz`;
  const stage = `${dst}.x-${stamp}`;
  const failCleanup = (code: number, stderr: string) => {
    try { rmSync(archive, { force: true }); } catch { /* best effort */ }
    try { rmSync(stage, { recursive: true, force: true }); } catch { /* best effort */ }
    return { code: code || 1, stdout: "", stderr };
  };
  try {
    mkdirSync(dirname(dst), { recursive: true });
  } catch (err) {
    return { code: 1, stdout: "", stderr: `could not create ${dirname(dst)}: ${err instanceof Error ? err.message : String(err)}` };
  }
  // 1) Remote manifest: sizes always; sha256 when the pod has sha256sum.
  const man = await sshExec(
    ep,
    `cd '${remote}' && find . -type f -printf '%s\\t%p\\n' && printf '${MANIFEST_SUMS_SENTINEL}\\n' && { find . -type f -exec sha256sum -- {} + 2>/dev/null || true; }`,
    Math.min(timeoutMs, 300_000),
  );
  if (man.code !== 0) return failCleanup(man.code, `pod output manifest failed (exit ${man.code}): ${man.stderr}`);
  const { sizes, sums } = parsePodManifest(man.stdout);
  // 2) Archive → temp FILE; the ssh exit code is the transfer's truth.
  const dl = await downloadToFile([...SSH_OPTS, "-p", String(ep.port), ep.userHost, `tar -C '${remote}' -czf - .`], archive, timeoutMs);
  if (dl.code !== 0) return failCleanup(dl.code, `pod output download failed (exit ${dl.code}): ${dl.stderr}`);
  // 3) Validate entries BEFORE extraction (types, then names).
  const tv = await exec("tar", ["-tvf", archive], 300_000);
  if (tv.code !== 0) return failCleanup(tv.code, `archive listing failed (truncated download?): ${tv.stderr}`);
  const badType = findUnsafeArchiveType(tv.stdout);
  if (badType) return failCleanup(1, badType);
  const tl = await exec("tar", ["-tf", archive], 300_000);
  if (tl.code !== 0) return failCleanup(tl.code, `archive listing failed: ${tl.stderr}`);
  const badName = validateArchiveEntryNames(tl.stdout.split(/\r?\n/));
  if (badName) return failCleanup(1, badName);
  // 4) Extract into a temp STAGE dir next to the destination.
  try {
    mkdirSync(stage, { recursive: true });
  } catch (err) {
    return failCleanup(1, `could not create staging dir: ${err instanceof Error ? err.message : String(err)}`);
  }
  const ex = await exec("tar", ["--no-same-owner", "--no-same-permissions", "-xzf", archive, "-C", stage], timeoutMs);
  if (ex.code !== 0) return failCleanup(ex.code, `archive extraction failed (exit ${ex.code}): ${ex.stderr}`);
  // 5) Verify every manifest file (size, and sha256 when present).
  for (const [rel, size] of sizes) {
    const p = join(stage, rel);
    let st;
    try {
      st = statSync(p);
    } catch {
      return failCleanup(1, `verification failed: ${rel} missing after extraction`);
    }
    if (st.size !== size) {
      return failCleanup(1, `verification failed: ${rel} is ${st.size} bytes locally but ${size} on the pod (truncated transfer)`);
    }
    const want = sums.get(rel);
    if (want) {
      const got = await sha256File(p).catch(() => "");
      if (got !== want) return failCleanup(1, `verification failed: sha256 mismatch on ${rel}`);
    }
  }
  // 6) Promote: the pre-existing destination is replaced only NOW, by a
  //    same-dir rename of fully verified content. Recoverable — a prior dst is
  //    moved aside to a .bak first and restored if the promote rename fails, so
  //    a failed promote leaves the previously-verified destination intact
  //    (delete-then-rename would lose it if the rename threw; codex finding).
  const bak = `${dst}.bak-${process.pid}-${Date.now()}`;
  let backedUp = false;
  try {
    if (existsSync(dst)) {
      renameSync(dst, bak);
      backedUp = true;
    }
    renameSync(stage, dst);
  } catch (err) {
    if (backedUp) {
      // Restore the prior destination we moved aside.
      try { rmSync(dst, { recursive: true, force: true }); } catch { /* best effort */ }
      try { renameSync(bak, dst); } catch { /* best effort */ }
    }
    return failCleanup(1, `could not promote verified output into place: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (backedUp) { try { rmSync(bak, { recursive: true, force: true }); } catch { /* best effort */ } }
  try { rmSync(archive, { force: true }); } catch { /* best effort */ }
  return { code: 0, stdout: "", stderr: "" };
}

/** Build the ssh invocation for a training run — exported for tests. The HF
 *  token must NEVER appear in the argv or the remote command string: local
 *  argv is visible to any process lister on the rig, and the remote command
 *  lands in the pod's /proc cmdline (codex #263 security finding). When a
 *  token is present it travels over the encrypted ssh channel's STDIN and the
 *  remote shell reads it into the environment before exec'ing the trainer. */
export function buildSshTrainingInvocation(opts: {
  ep: PodSshEndpoint;
  remoteConfigPath: string;
  hfCacheDir?: string;
  hfToken?: string;
  aiToolkitDir?: string;
}): { args: string[]; remote: string; stdinPayload: string | null } {
  const toolkitDir = opts.aiToolkitDir ?? `${POD_TRAINING_ROOT}/ai-toolkit`;
  const env: string[] = ["PYTHONUNBUFFERED=1", "PYTHONUTF8=1", "HF_HUB_ENABLE_HF_TRANSFER=1"];
  if (opts.hfCacheDir) env.push(`HF_HOME=${opts.hfCacheDir}`);
  let remote = `cd ${toolkitDir} && ${env.join(" ")} ./venv/bin/python run.py ${opts.remoteConfigPath}`;
  let stdinPayload: string | null = null;
  const token = opts.hfToken?.replace(/[\r\n]/g, "");
  if (token) {
    // First stdin line = the token. `read` strips the newline; export makes it
    // visible to run.py without ever touching a command line on either side.
    // `;` (not `&&`) after read: an empty line still starts the trainer — it
    // just runs untokened, which fails loudly on gated models instead of
    // silently blocking the launch.
    remote = `IFS= read -r HF_TOKEN; export HF_TOKEN; ${remote}`;
    stdinPayload = `${token}\n`;
  }
  return { args: [...SSH_OPTS, "-p", String(opts.ep.port), opts.ep.userHost, remote], remote, stdinPayload };
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
  const inv = buildSshTrainingInvocation({
    ep,
    remoteConfigPath: opts.remoteConfigPath,
    hfCacheDir: opts.hfCacheDir,
    hfToken: opts.hfToken,
    aiToolkitDir: opts.aiToolkitDir,
  });

  const child = childProcess.spawn("ssh", inv.args, {
    windowsHide: true,
    env: { ...process.env },
  });
  // Deliver the token (if any) over stdin — never argv (see the builder). A
  // stdin error (remote died before the write) is failure noise; the exit
  // code surfaces it.
  child.stdin?.on("error", (e) => {
    logger.debug(`[runpod-ssh] ssh stdin: ${e.message}`);
  });
  if (inv.stdinPayload) child.stdin?.write(inv.stdinPayload);
  child.stdin?.end();
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
 *  null = can't tell (ssh unreachable). Bracketed against self-match.
 *
 *  MUST be scoped to the SAME job config path the kill uses (stopSshTraining):
 *  an unscoped `run.py` probe reports RUNNING when ANY unrelated ai-toolkit run
 *  (another registry, a manual launch) is alive on the pod, which would make a
 *  successful cancel of THIS job falsely revert its record to "running" — and a
 *  false-active record keeps suppressing the connector's pod idle-stop (codex
 *  finding). Passing the config path greps `run.py <config>`, matching the
 *  pkill pattern, so it reports running only when THIS job's process survives. */
export async function sshProcessRunning(containerName: string, remoteConfigPath?: string): Promise<boolean | null> {
  const ep = decodePodContainerName(containerName);
  if (!ep) return null;
  const pattern = remoteConfigPath ? `${RUNPY_PATTERN} ${remoteConfigPath}` : RUNPY_PATTERN;
  const r = await sshExec(ep, `pgrep -f '${pattern.replace(/'/g, "'\\''")}' >/dev/null && echo RUNNING || echo GONE`, 20_000);
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

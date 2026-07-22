// Training job registry for the LoRA trainer — the state layer between the
// train_* MCP tools and the ai-toolkit container driver.
//
// A job ties together: a dataset dir (staged by prepareDataset), a generated
// ai-toolkit config (training-config.ts), and a running docker container
// (ai-toolkit.ts). Jobs persist a small JSON record under
// <trainingRoot>/jobs/<id>.json so `train_status`/`train_cancel` still work
// after an MCP restart (the container keeps running; we re-read the record).
//
// On success the final `.safetensors` is copied into ComfyUI models/loras/ and
// upserted into the LoRA catalog (trigger keyword + base model) so it shows in
// the mobile LoRA hub immediately. Live step/loss progress is also mirrored
// onto the cross-process download-progress channel for the panel/mobile tray.

import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import {
  containerRunning,
  startTraining,
  stopTraining,
  type TrainingHandle,
  type TrainingProgress,
} from "./ai-toolkit.js";
import {
  decodePodContainerName,
  encodePodContainerName,
  podJobPaths,
  rsyncFileToPod,
  rsyncFromPod,
  rsyncToPod,
  sshEndpointWorks,
  sshExec,
  sshProcessRunning,
  startSshTraining,
  stopSshTraining,
  type PodSshEndpoint,
} from "./runpod-ssh.js";
import {
  buildTrainingConfig,
  sanitizeJobName,
  type TrainParams,
  type TrainerFlow,
  type TrainerModel,
} from "./training-config.js";
import { reportDownloadProgress } from "./download-progress.js";
import { getLoraCatalog } from "./lora-catalog.js";
import { resolveModelSubfolder } from "./model-resolver.js";
import { getInstanceSlug } from "../config.js";
import { logger } from "../utils/logger.js";

export type TrainingJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface TrainingJob {
  id: string;
  /** Job/LoRA name — becomes the output folder + .safetensors basename. */
  name: string;
  flow: TrainerFlow;
  model: TrainerModel;
  trigger?: string;
  status: TrainingJobStatus;
  progress: {
    step?: number;
    totalSteps?: number;
    loss?: number;
    /** Host paths of the most recent sample images (max 4). */
    samples: string[];
  };
  containerName?: string;
  /** Where the job runs. "local" = docker on this rig; "pod" = ssh-driven
   *  pod-native training (containerName is the `pod|user@host|port` encoding).
   *  Absent on pre-P4 records → local. */
  target?: "local" | "pod";
  /** Pod jobs: where the finished LoRA is delivered (default "both"). */
  deliverTo?: "pod" | "local" | "both";
  /** RunPod pod id this job runs on (target "pod"). Lets the idle auto-stop
   *  scope "is a pod busy training?" to the SPECIFIC watched pod — a run on
   *  pod A must not suppress the idle-stop of pod B (codex #274). Absent on
   *  pre-#274 records → treated as busy-for-any-pod (cost-safe). */
  podId?: string;
  /** Pid of the MCP process that launched the container — the ONLY process
   *  allowed to finalize it. Other processes may recover an orphaned job only
   *  when this owner is provably dead (train_status stays side-effect-free for
   *  healthy-owner states; independent review finding #1). */
  ownerPid?: number;
  /** Host dataset dir mounted at /dataset (writable — ai-toolkit caches into it). */
  datasetPath: string;
  /** Per-job dir holding config.yml, train.log, output/. */
  jobDir: string;
  /** Host output dir mounted at /output. */
  outputDir: string;
  /** Recent log lines (ring buffer, max 50) for train_status. */
  log: string[];
  error?: string;
  /** models/loras dir resolved at START — persisted so a mid-run ComfyUI
   *  retarget can't redirect the handoff to the wrong instance. */
  lorasDir?: string;
  /** ComfyUI instance slug at START — the catalog upsert is skipped when the
   *  active instance at handoff time differs (retargeted mid-run). */
  instanceSlug?: string;
  result?: {
    /** Absolute path of the LoRA copied into models/loras/ (local delivery),
     *  or the pod path / pulled path for pod-only delivery. */
    loraPath: string;
    /** models/-relative path, e.g. "loras/my_lora.safetensors". */
    loraRelPath: string;
    /** Absent when the catalog upsert was skipped (instance changed mid-run
     *  or pod-only delivery). */
    catalogId?: string;
    previewFile?: string;
    /** Pod jobs: path inside the pod's models/loras (when delivered there). */
    podLoraPath?: string;
  };
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

/** Injectable seams so tests can run without docker / a ComfyUI install. */
export interface TrainingJobDeps {
  startTraining?: typeof startTraining;
  stopTraining?: typeof defaultTrainingStop;
  /** Container liveness probe (false = definitively gone, null = unknown).
   *  The optional 2nd arg scopes pod probes to a job's config path (see
   *  defaultContainerProbe); docker probes ignore it. */
  containerRunning?: (name: string, remoteConfigPath?: string) => Promise<boolean | null>;
  /** Pod seams (target "pod" jobs): ssh preflight, uploads, runner, downloads. */
  sshWorks?: typeof sshEndpointWorks;
  rsyncToPod?: typeof rsyncToPod;
  rsyncFileToPod?: typeof rsyncFileToPod;
  rsyncFromPod?: typeof rsyncFromPod;
  startSshTraining?: typeof startSshTraining;
  /** Where the finished LoRA is copied. Default: ComfyUI models/loras. */
  lorasDir?: () => string;
  catalog?: Pick<ReturnType<typeof getLoraCatalog>, "upsert" | "setPreview">;
  now?: () => number;
  /** Lock-acquisition budget override (ms) for tests. */
  lockBudgetMs?: number;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const LOG_RING = 50;
/** Container-side mount points (must match ai-toolkit.ts startTraining). */
const CONTAINER_DATASET = "/dataset";
const CONTAINER_OUTPUT = "/output";

/** Case-fold decision for a root, probed against the REAL volume semantics
 *  (APFS can be case-sensitive; NTFS is conventionally insensitive — codex
 *  finding: don't assume by platform). Cached per root. */
const caseFoldCache = new Map<string, boolean>();
function volumeCaseInsensitive(root: string): boolean {
  const key = resolve(root);
  const cached = caseFoldCache.get(key);
  if (cached !== undefined) return cached;
  let insensitive = process.platform === "win32"; // platform default if the probe fails
  try {
    mkdirSync(key, { recursive: true });
    const probe = join(key, `.cmcp-caseprobe-${process.pid}-${persistTmpSeq++}`);
    writeFileSync(probe, "");
    // Uppercase the BASENAME ONLY (codex finding: uppercasing the full path
    // also flips case-sensitive ANCESTORS of a mounted insensitive volume).
    insensitive = existsSync(join(key, basename(probe).toUpperCase()));
    rmSync(probe, { force: true });
  } catch { /* keep the platform default */ }
  caseFoldCache.set(key, insensitive);
  return insensitive;
}

/** Case-fold a path when its ROOT's volume is case-insensitive. */
function pathKey(root: string, p: string): string {
  return volumeCaseInsensitive(root) ? resolve(p).toLowerCase() : resolve(p);
}

/** Is `target` the same dir as `root` or inside it, honoring the volume's real
 *  case semantics? Both sides are canonicalized (realpath — a symlink/junction
 *  under `root` can't smuggle in an external dir; codex finding). Roots that
 *  don't exist yet fall back to lexical resolution. */
function pathWithin(root: string, target: string): boolean {
  let r: string;
  let t: string;
  try {
    r = realpathSync(root);
  } catch {
    r = resolve(root);
  }
  try {
    t = realpathSync(target);
  } catch {
    t = resolve(target);
  }
  const rk = pathKey(root, r);
  const tk = pathKey(root, t);
  return tk === rk || tk.startsWith(rk + sep);
}

// ---- paths -----------------------------------------------------------------

function dataBaseDir(): string {
  return process.env.COMFYUI_MCP_DATA_DIR?.trim() || join(homedir(), ".comfyui-mcp");
}

/** Root for datasets, job dirs, and the shared HF cache. */
export function trainingRoot(): string {
  return process.env.COMFYUI_MCP_TRAINING_DIR?.trim() || join(dataBaseDir(), "training");
}

export function datasetsRoot(): string {
  return join(trainingRoot(), "datasets");
}

export function jobsRoot(): string {
  return join(trainingRoot(), "jobs");
}

/** Shared HF cache mounted into every training container (models persist
 *  across runs so Flux isn't re-downloaded each job). */
export function hfCacheRoot(): string {
  return join(trainingRoot(), "hf-cache");
}

// ---- registry ---------------------------------------------------------------

const jobs = new Map<string, TrainingJob>();
const handles = new Map<string, TrainingHandle>();
/** Jobs with a cancel IN FLIGHT: concurrent cancels JOIN the in-flight promise
 *  instead of acting on a marked-but-unpersisted state (codex finding: a
 *  second caller could take the already-cancelled path, stop the container,
 *  then watch the first acquisition time out and the job publish anyway).
 *  onProgress also consults this to avoid reconciling memory back to running. */
const pendingCancels = new Map<string, Promise<TrainingJob>>();
/** Throttle for persisting live progress (codex finding: cross-process readers
 *  only see what's on disk, so running jobs must snapshot, not just finalize). */
const lastProgressPersistAt = new Map<string, number>();
const PROGRESS_PERSIST_MS = 5000;

function jobFile(id: string): string {
  return join(jobsRoot(), `${id}.json`);
}

/**
 * Persist a job record ATOMICALLY (unique tmp + rename): a crash mid-write
 * must never leave a truncated record, and concurrent writers (an unlocked
 * progress snapshot racing a lock-holding finalizer) must never share a tmp
 * path (codex finding). Returns success — startTrainingJob refuses to launch
 * a container it can't track (independent review finding #5).
 */
let persistTmpSeq = 0;
function persist(job: TrainingJob): boolean {
  try {
    mkdirSync(jobsRoot(), { recursive: true });
    const file = jobFile(job.id);
    const tmp = `${file}.tmp-${process.pid}-${persistTmpSeq++}`;
    writeFileSync(tmp, JSON.stringify(job, null, 2));
    renameSync(tmp, file);
    return true;
  } catch (err) {
    logger.warn(`[training-jobs] could not persist ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ---- per-job CAS lock ---------------------------------------------------------
// Recovery (owner-dead handoff), owner finalization, and cancel all mutate the
// same record across processes. Without a lock, a mobile train_status poll and
// the owner's finalize can both hand off, and a cancel can land between a
// finalizer's cancel-check and its handoff (independent review findings #1/#2).
// The lock is a file created exclusively; holders re-read the record inside it.
//
// Codex-hardened: the creating fd is always closed; a stale lock is only
// broken when its HOLDER PID is dead (a live 5-minute handoff copy is never
// broken into); budgets are per-call-site so a cancel can't time out into
// writing outside the lock, and a finalize retries past a dead holder.

const LOCK_STALE_MS = 5 * 60_000; // fallback age for an UNREADABLE holder pid
const LOCK_WAIT_MS = 15_000;

function lockFile(id: string): string {
  return join(jobsRoot(), `${id}.lock`);
}

/** Cross-platform pid liveness (signal-0 probe). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockHolderPid(file: string): number | null {
  try {
    const pid = parseInt(readFileSync(file, "utf-8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Locks THIS process currently holds: file → ownership token. A lockfile
 *  whose token I don't know is not mine — even when its pid matches mine
 *  (a previous dead life with a recycled pid) — and is reclaimable (codex
 *  finding: pid reuse). The token also makes RELEASE safe: a preempted-and-
 *  resumed holder can never delete a successor's fresh lock, because the
 *  contents won't match (codex finding). */
const heldLocks = new Map<string, string>();
let lockTokenSeq = 0;
/** Even a LIVE holder's critical section is capped: no handoff copy
 *  legitimately runs this long, so beyond it the lock is reclaimable
 *  regardless of pid liveness (covers pid-reuse with an unrelated live pid). */
const LOCK_MAX_AGE_MS = 30 * 60_000;

function newLockToken(): string {
  return `${process.pid}:${Date.now()}:${lockTokenSeq++}`;
}

/** The lockfile's {pid, raw} — raw is the full ownership token text. */
function readLockContent(file: string): { pid: number | null; raw: string } {
  try {
    const raw = readFileSync(file, "utf-8").trim();
    const pid = parseInt(raw.split(":")[0], 10);
    return { pid: Number.isFinite(pid) && pid > 0 ? pid : null, raw };
  } catch {
    return { pid: null, raw: "" };
  }
}

/** The token's timestamp (pid:ts:seq) — used to tell a DEAD previous life of
 *  this pid (token predates my process start) from another LIVE module
 *  instance of this running process (token is newer; must not be reclaimed).
 *  Codex finding: same-pid module instances (vitest query-imports) broke the
 *  live-lock CAS; production pid-recycling needs exactly this distinction. */
function lockTokenTs(raw: string): number {
  const ts = Number(raw.split(":")[1]);
  return Number.isFinite(ts) ? ts : 0;
}

/** This process's start time (uptime-derived; identical across module instances). */
function processStartMs(): number {
  return Date.now() - process.uptime() * 1000;
}

/** Acquire a lockfile (exclusive-create). Retries within `budgetMs`; returns
 *  false on timeout (caller MUST NOT mutate unlocked).
 *
 *  Stale takeover protocol: the stale lock is deleted ONLY through a claim
 *  channel — an exclusive-create `.claim` file, itself TTL-bounded — and only
 *  when its contents still EXACTLY match the stale observation. A rival's
 *  FRESH lock always carries a different token, so it can never be deleted by
 *  a stale observation (codex finding: check-then-unlink and rename takeover
 *  were not atomic). Mutual exclusion of the critical section itself is
 *  always decided by the exclusive `wx` create. */
const CLAIM_TTL_MS = 60_000; // a claim is a sub-second operation; older = presumed dead

async function acquireLock(file: string, budgetMs = LOCK_WAIT_MS, maxAgeMs = LOCK_MAX_AGE_MS): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    // Honor the claim channel from BOTH sides (codex finding): while a
    // takeover claim is active, no fresh lock may be created — otherwise the
    // breaker's content-check → rm can delete that fresh lock. An expired
    // claim is presumed dead and swept.
    const claim = `${file}.claim`;
    try {
      const st = statSync(claim);
      if (Date.now() - st.mtimeMs > CLAIM_TTL_MS) {
        // Expired claim: sweep ONLY the exact instance observed (mtime match) —
        // a fresh claim created between our stat and rm must survive (codex
        // finding). Worst case of a missed sweep: the TTL reaper gets it next.
        try {
          const st2 = statSync(claim);
          if (st2.mtimeMs === st.mtimeMs) rmSync(claim, { force: true });
        } catch { /* gone or replaced — leave it */ }
      } else {
        // Active takeover in progress — treat as contended.
        if (Date.now() - start > budgetMs) return false;
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
    } catch { /* no claim — proceed */ }
    try {
      mkdirSync(dirname(file), { recursive: true }); // lock may live in a not-yet-created dir
      const token = newLockToken();
      const fd = openSync(file, "wx");
      try {
        writeFileSync(fd, token);
      } catch (writeErr) {
        // Created but couldn't record the holder (e.g. transient disk-full) —
        // remove OUR empty lock so the next attempt isn't stalled for minutes
        // on an unreadable holder (codex finding).
        try {
          rmSync(file, { force: true });
        } catch { /* best effort */ }
        throw writeErr;
      } finally {
        // writeFileSync does NOT close caller-supplied fds (leak finding).
        closeSync(fd);
      }
      heldLocks.set(file, token);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // Only EEXIST means contention. A create that fails on a read-only/full/
      // corrupt volume must surface NOW, not burn the caller's budget (codex
      // finding: finalize would otherwise retry for 30 minutes).
      if (code && code !== "EEXIST") throw err;
      // Lock exists — evaluate staleness.
      const observed = readLockContent(file);
      const breakable = (() => {
        // A DEAD previous life of this pid: token predates MY process start.
        // A lock from another LIVE instance of this running process (module
        // reload / query-import) has a newer token and must NOT be reclaimed.
        if (observed.pid === process.pid && !heldLocks.has(file) && lockTokenTs(observed.raw) < processStartMs()) return true;
        if (observed.pid !== null && observed.pid !== process.pid && !pidAlive(observed.pid)) return true;
        try {
          const st = statSync(file);
          const age = Date.now() - st.mtimeMs;
          if (observed.pid === null && age > LOCK_STALE_MS) return true;
          if (age > maxAgeMs) return true;
        } catch { /* vanished — loop re-evaluates */ }
        return false;
      })();
      if (breakable) {
        const cleared = await breakStaleLock(file, observed.raw, budgetMs - (Date.now() - start));
        if (cleared) continue; // path free — the wx create decides who wins
        // Couldn't clear (claim busy or file changed): fall THROUGH to the
        // budget check + delay — never spin without it (codex finding).
      }
      if (Date.now() - start > budgetMs) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** Delete `file` only if its contents still equal `expectedRaw`, serialized
 *  through a claim channel so concurrent reclaimers can't double-act. An EMPTY
 *  lock (crash between create and token write) older than the stale threshold
 *  is broken by construction. The claim wait honors the CALLER's remaining
 *  budget (codex finding: a fresh claim could otherwise stall a 300ms/15s
 *  acquisition for the full 60s TTL). Returns true when the path was cleared
 *  (or was already free). */
async function breakStaleLock(file: string, expectedRaw: string, budgetMs: number): Promise<boolean> {
  const claim = `${file}.claim`;
  const start = Date.now();
  const claimBudget = Math.max(0, Math.min(CLAIM_TTL_MS, budgetMs));
  for (;;) {
    try {
      const fd = openSync(claim, "wx");
      closeSync(fd);
      break; // claim held
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // A claim CREATE that fails for non-contention reasons (read-only/full/
      // corrupt volume) surfaces immediately — never a synchronous tight loop
      // or a frozen MCP process (codex finding).
      if (code && code !== "EEXIST") return false;
      // Claim exists: honor its TTL — a claim older than the cap is presumed
      // dead (its operation is sub-second). Deleting it can at worst cause a
      // redundant, content-guarded rm attempt of the SAME stale lock — never
      // the deletion of a fresh lock (codex-safe by construction).
      let expired = false;
      try {
        const st = statSync(claim);
        expired = Date.now() - st.mtimeMs > CLAIM_TTL_MS;
      } catch {
        expired = true; // vanished
      }
      if (expired) {
        try {
          rmSync(claim, { force: true });
        } catch { /* someone else cleared it */ }
        if (Date.now() - start > claimBudget) return false; // caller's budget, not the full TTL
        continue;
      }
      if (Date.now() - start > claimBudget) return false; // caller's budget, not the full TTL
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    const current = readLockContent(file);
    if (current.raw && current.raw === expectedRaw) {
      try {
        rmSync(file, { force: true });
        return true;
      } catch {
        // Could NOT delete (permissions, volume) — the path is NOT clear;
        // report false so the caller hits its budget instead of looping
        // forever (codex finding).
        return false;
      }
    }
    if (!current.raw) {
      // Empty lock (crashed between create and token write): break it once
      // it's old — never loop on it (codex finding).
      try {
        const st = statSync(file);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try {
            rmSync(file, { force: true });
            return true;
          } catch {
            return false; // couldn't delete — not cleared (see above)
          }
        }
      } catch {
        return true; // vanished
      }
    }
    return false;
  } finally {
    try {
      rmSync(claim, { force: true });
    } catch { /* best effort */ }
  }
}

/** Acquire the per-job lock. */
async function acquireJobLock(id: string, budgetMs = LOCK_WAIT_MS): Promise<boolean> {
  try {
    mkdirSync(jobsRoot(), { recursive: true });
  } catch { /* the create attempt reports it */ }
  return acquireLock(lockFile(id), budgetMs);
}

/** Cross-process reservation lock keyed by a POD ENDPOINT (codex #273). Held
 *  across the one-run-per-pod scan→persist→launch in startTrainingJob so two
 *  MCP processes can't both pass the disk scan and double-launch run.py on the
 *  same pod. The endpoint encoding (`pod|user@host|port`) is sanitized into a
 *  filename-safe key. */
function podReservationLockFile(endpoint: PodSshEndpoint): string {
  const key = encodePodContainerName(endpoint).replace(/[^A-Za-z0-9._-]+/g, "_");
  return join(jobsRoot(), `.pod-reserve-${key}.lock`);
}

/** Release a lock — delete the file only if it still carries OUR token, and
 *  only through the SAME claim channel stale takeover uses (codex finding: a
 *  preempted-and-resumed holder's token-check → rm otherwise races a takeover
 *  and can delete the successor's active lock). Best-effort: a release that
 *  can't claim leaves the lock for the age/pid reclaim paths. */
function releaseLock(file: string): void {
  const token = heldLocks.get(file);
  heldLocks.delete(file);
  if (!token) return; // never ours (already released / never acquired)
  const claim = `${file}.claim`;
  let claimed = false;
  try {
    const fd = openSync(claim, "wx");
    claimed = true;
    try {
      const current = readLockContent(file);
      if (current.raw === token) rmSync(file, { force: true });
    } finally {
      closeSync(fd);
    }
  } catch { /* couldn't claim/delete — the stale reclaim paths will get it */ }
  // Only remove the claim WE created — never a rival's active claim (codex
  // finding: unconditional cleanup broke takeover exclusion).
  if (claimed) {
    try {
      rmSync(claim, { force: true });
    } catch { /* best effort */ }
  }
}

function releaseJobLock(id: string): void {
  releaseLock(lockFile(id));
}

/** Read a job record straight from disk (no cache, no merging). */
function readJobRecord(id: string): TrainingJob | null {
  try {
    const job = JSON.parse(readFileSync(jobFile(id), "utf-8")) as TrainingJob;
    return job && typeof job.id === "string" ? job : null;
  } catch {
    return null;
  }
}

/** Is the process that OWNS this job (can finalize it) still alive? */
function ownerAlive(job: TrainingJob): boolean {
  // An in-flight cancel owns the outcome as surely as a live handle (codex
  // finding: handle removed + pending cancel + dead container looked like an
  // orphan, so status-driven recovery could race the cancel's marker).
  if (pendingCancels.has(job.id)) return true;
  // A finalizer that exhausted every lock cycle relinquishes ownership via an
  // ADDITIVE marker file (create-if-absent — never races a terminal write).
  if (existsSync(ownerReleaseFile(job.id))) return false;
  if (!job.ownerPid) return false; // pre-owner records: unknown → treat as dead
  if (job.ownerPid === process.pid) return handles.has(job.id); // same proc: owner only while we hold the handle
  return pidAlive(job.ownerPid);
}

function ownerReleaseFile(id: string): string {
  return join(jobsRoot(), `${id}.owner-released`);
}

/** The owner's liveness LEASE: while running, the owner persists progress/log
 *  snapshots every few seconds. A live owner that stopped updating (crashed
 *  between handle-loss and finalize, or hung) is indistinguishable from dead
 *  for recovery purposes — pid liveness alone can't see a handleless owner
 *  (codex finding). The window is generous: a HEALTHY owner finalizes seconds
 *  after container exit, so 10 minutes of silence + a dead container is the
 *  genuinely-hung case — shorter windows misclassify quiet-but-alive owners
 *  (codex finding). */
const OWNER_LEASE_MS = 10 * 60_000;
function ownerLeaseStale(job: TrainingJob): boolean {
  const t = Date.parse(job.updatedAt ?? "");
  return !Number.isFinite(t) || Date.now() - t > OWNER_LEASE_MS;
}

/** True when the ON-DISK record says cancelled — i.e. another process issued a
 *  cancel this process hasn't seen (its memory still says running). */
function diskCancelled(job: TrainingJob): boolean {
  return readJobRecord(job.id)?.status === "cancelled";
}

/** True when the ON-DISK record is in ANY terminal state (cancelled/completed/
 *  failed) — a live snapshot must never overwrite a terminal record (codex
 *  finding: a racing progress persist could resurrect "running" over them). */
function diskTerminal(job: TrainingJob): boolean {
  const s = readJobRecord(job.id)?.status;
  return s === "cancelled" || s === "completed" || s === "failed";
}

/**
 * Schedule a live progress/log snapshot. The terminal check and the write run
 * TOGETHER under the per-job lock (codex finding: an unlocked check-then-write
 * can overwrite a terminal record persisted by another process in between).
 * Scheduled (not awaited) from the sync stream callbacks, serialized per job
 * so snapshots can't interleave with themselves.
 */
const livePersistChain = new Map<string, Promise<void>>();

function scheduleLivePersist(job: TrainingJob): void {
  const prev = livePersistChain.get(job.id) ?? Promise.resolve();
  const next = prev
    .then(() => persistLiveStateLocked(job))
    .catch((err) => {
      logger.debug(`[training-jobs] live persist ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
    });
  livePersistChain.set(job.id, next);
  // GC the chain entry when it settles (it's the tail by construction).
  void next.finally(() => {
    if (livePersistChain.get(job.id) === next) livePersistChain.delete(job.id);
  });
}

async function persistLiveStateLocked(job: TrainingJob): Promise<void> {
  if (job.status === "cancelled") return;
  if (!(await acquireJobLock(job.id, 5_000))) return; // busy — a fresher write is coming from the holder
  try {
    if (diskCancelled(job)) {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      return;
    }
    if (diskTerminal(job)) return; // finalized elsewhere — never resurrect "running"
    job.updatedAt = new Date().toISOString();
    persist(job);
  } finally {
    releaseJobLock(job.id);
  }
}

/**
 * Merge the on-disk records into the in-memory map. Runs on EVERY read: the
 * orchestrator's long-lived in-process client (mobile `train_status`) is a
 * different process from the one running `train_start`, so a load-once
 * registry would show stale/empty state forever (codex finding #1).
 *
 * Merge rules:
 *  - A job with a live in-process handle is authoritative in memory (fresher
 *    than disk between throttled persists) — disk never overwrites it.
 *  - Anything else takes the disk record (new, updated, or absent in memory).
 *  - A record persisted as running/queued with NO live handle here belongs to
 *    another process (or a crashed one): probe the container. Definitively
 *    gone → mark failed; running or unknown → report as recorded, never
 *    mislabel a live foreign job as failed (codex finding #2).
 */
/**
 * Merge the on-disk records into the in-memory map. Runs on EVERY read: the
 * orchestrator's long-lived in-process client (mobile `train_status`) is a
 * different process from the one running `train_start`, so a load-once
 * registry would show stale/empty state forever (codex finding #1).
 *
 * Merge rules:
 *  - A job with a live in-process handle is authoritative in memory (fresher
 *    than disk between throttled persists) — disk never overwrites it.
 *  - Anything else takes the disk record (new, updated, or absent in memory).
 *  - A record persisted as running/queued with NO live handle here: probe the
 *    container. Running/unknown → report as recorded, never mislabel a live
 *    foreign job (codex finding #2).
 *  - Container gone: hand off/fail ONLY when the OWNER process is provably
 *    dead (independent review finding #1). A healthy owner sits in exactly
 *    this state between docker-exit and its own finalizeJob — a "read" must
 *    never trigger the handoff or race that finalization, so we just report
 *    the record as-is and let the owner persist its terminal state.
 *  - Recovery (owner dead) runs under the per-job CAS lock and re-reads the
 *    record inside, so two processes can't both hand off.
 */
async function refreshRegistry(deps: TrainingJobDeps = {}): Promise<void> {
  let files: string[] = [];
  try {
    files = readdirSync(jobsRoot()).filter((f) => f.endsWith(".json"));
  } catch {
    return; // no jobs dir yet
  }
  for (const f of files) {
    const job = readJobRecord(f.replace(/\.json$/, ""));
    if (!job) continue;
    if (handles.has(job.id)) { jobs.set(job.id, jobs.get(job.id) ?? job); continue; } // live here — memory wins
    if ((job.status === "running" || job.status === "queued") && job.containerName) {
      const probe = deps.containerRunning ?? defaultContainerProbe;
      const running = await probe(job.containerName, jobProbeConfigPath(job)).catch(() => null);
      if (running === false && (!ownerAlive(job) || ownerLeaseStale(job))) {
        // Container gone AND (owner provably dead OR its liveness lease
        // expired): recover. A HEALTHY owner between docker-exit and its own
        // finalizeJob has a fresh lease — we report as-is and let it persist
        // its terminal state (read path stays side-effect-free for it).
        await recoverOrphanedJob(job.id, deps);
        const recovered = readJobRecord(job.id);
        jobs.set(job.id, recovered ?? job);
        continue;
      }
      // running / unknown / container-gone-but-owner-alive: report as recorded.
    }
    jobs.set(job.id, job);
  }
}

/** Pod jobs: pull the produced output (checkpoints + samples + LoRA) back to
 *  the rig so findSamples/findProducedLora/recoveredSuccessfully see it
 *  (samples mirror to panel/mobile through the same rig-local paths). Used by
 *  finalize AND owner-dead recovery (codex finding: recovery judged a pod job
 *  from the rig-local output dir alone and failed a successful run).
 *
 *  Codex #263 BLOCKER: the transport pulls into a TEMP dir and only a
 *  fully-successful transfer (exit 0 — the verified transport also checks
 *  entry safety + size/sha256 against the pod) is atomically promoted into
 *  the final output dir. A failed/partial transfer leaves NO local artifact,
 *  so a truncated LoRA can never be published as "completed" or re-uploaded
 *  over the good pod-side copy. Callers must honor `ok`. */
async function pullPodOutput(job: TrainingJob, deps: TrainingJobDeps): Promise<{ ok: boolean; error?: string }> {
  if (job.target !== "pod" || !job.containerName) return { ok: true };
  const ep = decodePodContainerName(job.containerName);
  if (!ep) return { ok: false, error: `unparseable pod container name: ${job.containerName}` };
  const finalDir = join(job.outputDir, job.name);
  const tmpDir = `${finalDir}.pull-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    pushLog(job, "[pod] pulling output back from the pod (verified tar-over-ssh)…");
    const down = await (deps.rsyncFromPod ?? rsyncFromPod)(ep, `${podJobPaths(job.id, job.name).outputDir}/${job.name}`, tmpDir);
    if (down.code !== 0) {
      const msg = `pod output transfer failed (exit ${down.code}): ${down.stderr.trim().slice(0, 300)}`;
      logger.warn(`[training-jobs] ${msg} (job ${job.id})`);
      return { ok: false, error: msg };
    }
    // Promote only a complete, verified pull (same-dir rename). Recoverable:
    // a prior finalDir is moved aside to a .bak first and restored if the
    // promote rename throws, so a failed promote leaves the previously-verified
    // destination intact (delete-then-rename would lose it; codex finding).
    const bak = `${finalDir}.bak-${process.pid}-${Date.now()}`;
    let backedUp = false;
    try {
      if (existsSync(finalDir)) {
        renameSync(finalDir, bak);
        backedUp = true;
      }
      renameSync(tmpDir, finalDir);
    } catch (promoteErr) {
      if (backedUp) {
        try { rmSync(finalDir, { recursive: true, force: true }); } catch { /* best effort */ }
        try { renameSync(bak, finalDir); } catch { /* best effort */ }
      }
      throw promoteErr;
    }
    if (backedUp) { try { rmSync(bak, { recursive: true, force: true }); } catch { /* best effort */ } }
    return { ok: true };
  } catch (err) {
    const msg = `pod output transfer error: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn(`[training-jobs] ${msg} (job ${job.id})`);
    return { ok: false, error: msg };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true }); // no-op after a successful rename
  }
}
/**
 * Owner-dead recovery under the per-job lock: re-read inside the lock (a
 * concurrent process may have finalized while we waited), then complete a
 * proven-finished run (final save present) or fail it honestly.
 */
async function recoverOrphanedJob(id: string, deps: TrainingJobDeps): Promise<void> {
  if (!(await acquireJobLock(id, deps.lockBudgetMs))) return; // someone else is finalizing — the next read retries
  try {
    const job = readJobRecord(id);
    if (!job || (job.status !== "running" && job.status !== "queued")) return;
    // Pod jobs: pull the pod-side output BEFORE judging success from the
    // rig-local dir (codex finding: a finished pod run looked like a failure).
    const pulled = await pullPodOutput(job, deps);
    try {
      if (!pulled.ok) {
        // #263 blocker: a failed/partial transfer must never publish. The
        // artifacts (if any) are still intact on the pod.
        job.status = "failed";
        job.error = `owner-dead recovery could not pull the pod output — not publishing a partial artifact: ${pulled.error}. Any produced files are still on the pod under ${podJobPaths(job.id, job.name).outputDir}.`;
      } else if (recoveredSuccessfully(job)) {
        await handoffToComfyUI(job, deps);
        job.status = "completed";
        const samples = findSamples(job.outputDir, job.name, 4);
        if (samples.length > 0) job.progress.samples = samples;
        if (job.progress.totalSteps !== undefined) job.progress.step = job.progress.totalSteps;
      } else {
        job.status = "failed";
        job.error = "training container is no longer running (the MCP process that started it exited or the container died); any output (checkpoints, samples) is under the job's output/ dir.";
      }
    } catch (err) {
      job.status = "failed";
      job.error = `recovered output but handoff failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    persist(job);
  } finally {
    releaseJobLock(id);
  }
}

export async function getJob(id: string, deps: TrainingJobDeps = {}): Promise<TrainingJob | null> {
  await refreshRegistry(deps);
  return jobs.get(id) ?? null;
}

export async function listJobs(deps: TrainingJobDeps = {}): Promise<TrainingJob[]> {
  await refreshRegistry(deps);
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The default container liveness probe, pod-aware: `pod|…` names go over ssh.
 *  The probe MUST be scoped to the job's own config path (same as the stop),
 *  or an unrelated `run.py` alive on the pod makes this job's cancel falsely
 *  report still-running (codex finding). */
export function defaultContainerProbe(name: string, remoteConfigPath?: string): Promise<boolean | null> {
  return name.startsWith("pod|") ? sshProcessRunning(name, remoteConfigPath) : containerRunning(name);
}

/** The remote config path a pod job's kill AND liveness probe must both scope
 *  to (undefined for docker jobs, which ignore it). Keeps the probe and the
 *  stop pointed at the SAME `run.py <config>` so a cancel can't be fooled by an
 *  unrelated run.py on the pod. */
function jobProbeConfigPath(job: TrainingJob): string | undefined {
  return job.containerName?.startsWith("pod|") ? podJobPaths(job.id, job.name).configPath : undefined;
}

/** The default stop, pod-aware. Pod stops are SCOPED to the job's own config
 *  path (pkill 'run.py <config>'): an unscoped pattern kills EVERY ai-toolkit
 *  run.py on the pod — including runs from other registries/processes (codex
 *  finding). */
export function defaultTrainingStop(name: string, remoteConfigPath?: string): ReturnType<typeof stopTraining> {
  return name.startsWith("pod|") ? stopSshTraining(name, remoteConfigPath) : stopTraining(name);
}

/** Any job currently running/queued — FILE SCAN ONLY, no liveness probes (ssh
 *  probes are far too slow for the 15s idle-stop tick). `target` "pod" matches
 *  ssh-driven jobs; the connector's idle-stop must NEVER fire while one of
 *  those is alive (the pod is busy training even when the ComfyUI queue is
 *  empty). Stale records err toward "busy" (pod stays up — the cost-safe
 *  direction for a false negative would be the expensive one). */
export function hasActiveTrainingJob(target?: "pod", podId?: string): boolean {
  return scanJobRecords().some((j) => {
    if (j.status !== "running" && j.status !== "queued") return false;
    if (!target) return true;
    const isPodJob = j.target === "pod" || j.containerName?.startsWith("pod|") === true;
    if (!isPodJob) return false;
    // Scope to a SPECIFIC pod when the caller names one AND this record knows
    // its pod (codex #274): a run on pod A must not suppress pod B's idle-stop.
    // A record with no podId (pre-#274) can't be attributed to a pod, so it
    // errs toward "busy" for every pod — the cost-safe direction (never stop a
    // maybe-live training run mid-flight).
    if (podId && j.podId) return j.podId === podId;
    return true;
  });
}

/** Money guard (codex #263): a running/queued record whose OWNER process died
 *  mid-run stays "running" on disk forever if nobody calls train_status —
 *  and hasActiveTrainingJob (a blind file scan, above) then suppresses the
 *  pod idle auto-stop indefinitely, billing the pod until a human notices.
 *  This reconciler probes ONLY dead-owner / stale-lease records (a healthy
 *  run costs nothing) and routes provably-dead ones through the same locked
 *  owner-dead recovery the read path uses, so they terminalize honestly and
 *  stop counting as active. Called periodically by the orchestrator.
 *  Returns how many records were reconciled to a terminal state. */
export async function reconcileStaleTrainingJobs(deps: TrainingJobDeps = {}): Promise<number> {
  let reconciled = 0;
  for (const job of scanJobRecords()) {
    if (job.status !== "running" && job.status !== "queued") continue;
    if (!job.containerName) continue;
    if (handles.has(job.id)) continue; // live in THIS process — the owner is us
    if (ownerAlive(job) && !ownerLeaseStale(job)) continue; // healthy owner — not ours to touch
    const probe = deps.containerRunning ?? defaultContainerProbe;
    const running = await probe(job.containerName, jobProbeConfigPath(job)).catch(() => null);
    if (running !== false) continue; // alive or unknown → err toward "busy" (never stop a live run)
    await recoverOrphanedJob(job.id, deps);
    const after = readJobRecord(job.id);
    if (after && after.status !== "running" && after.status !== "queued") reconciled++;
  }
  return reconciled;
}

/** Probe-free read of every persisted job record (shares no state with the
 *  in-memory map; used by the idle-stop guard and the per-pod busy check). */
function scanJobRecords(): TrainingJob[] {
  let files: string[] = [];
  try {
    files = readdirSync(jobsRoot()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: TrainingJob[] = [];
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(jobsRoot(), f), "utf-8")) as TrainingJob;
      if (j && typeof j.id === "string") out.push(j);
    } catch {
      // skip a garbled record
    }
  }
  return out;
}

// ---- dataset staging ----------------------------------------------------------

export interface DatasetItem {
  /** Host path to a source image. */
  path: string;
  /** Caption text. Falls back to defaultCaption (usually the trigger word). */
  caption?: string;
}

export interface PreparedDataset {
  datasetPath: string;
  imageCount: number;
  captionedCount: number;
  warnings: string[];
}

function sanitizeDirName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!cleaned || /^\.+$/.test(cleaned)) return "dataset";
  return cleaned;
}

/**
 * Stage images + same-basename .txt captions into a dataset dir ai-toolkit can
 * consume. Images are copied in as img_00001.<ext> etc. (stable, caption-safe
 * names); a missing caption falls back to defaultCaption, and if that's also
 * absent the image is staged uncaptioned with a warning (ai-toolkit trains on
 * it with an empty caption).
 *
 * Re-staging the same name REPLACES the old dir — but refuses when a
 * non-terminal job currently trains from it (the dir is bind-mounted into the
 * running container; wiping it mid-run would corrupt the job — codex finding).
 */
export async function prepareDataset(opts: {
  name: string;
  items: DatasetItem[];
  defaultCaption?: string;
}, deps: TrainingJobDeps = {}): Promise<PreparedDataset> {
  if (!Array.isArray(opts.items) || opts.items.length === 0) {
    throw new Error("dataset needs at least one image");
  }
  const dir = join(datasetsRoot(), sanitizeDirName(opts.name));
  const resolvedDir = resolve(dir);
  // Same-name concurrent prepares would share the staging dir and the
  // check-then-replace sequence (independent review finding #6) — guarded in
  // two layers: the in-memory set (in-process fast path) AND a filesystem
  // lockfile (cross-process, codex finding: two MCP processes each have their
  // own set and could both destroy-and-swap the dir).
  if (preparingNames.has(dir)) {
    throw new Error(`dataset "${opts.name}" is already being prepared — wait for that call to finish`);
  }
  // Populate BOTH guards before the first await yields (another call can only
  // interleave at an await — codex finding).
  preparingNames.add(dir);
  const prepLock = `${dir}.prep-lock`;
  // Dataset prep can legitimately run long (large copies off slow storage), so
  // the generic 30-min age cap would break a LIVE preparation — pass a 12h cap
  // instead (codex finding); pid-liveness still reclaims dead holders.
  const PREP_LOCK_MAX_AGE_MS = 12 * 60 * 60_000;
  try {
    if (!(await acquireLock(prepLock, deps.lockBudgetMs ?? LOCK_WAIT_MS, PREP_LOCK_MAX_AGE_MS))) {
      throw new Error(`dataset "${opts.name}" is being prepared by another process — wait for it to finish`);
    }
  } catch (err) {
    // Clear the in-process guard on ANY acquisition failure (contention or a
    // thrown filesystem error) — a stuck entry rejects every later same-name
    // prepare forever (codex finding).
    preparingNames.delete(dir);
    throw err;
  }
  try {
  const active = await listJobs(deps);
  const inUse = active.find(
    (j) => (j.status === "running" || j.status === "queued") && pathKey(resolvedDir, j.datasetPath) === pathKey(resolvedDir, resolvedDir),
  );
  if (inUse) {
    throw new Error(`dataset "${opts.name}" is in use by ${inUse.status} job ${inUse.id} — pick another name or cancel the job first`);
  }
  // Validate EVERY item first and stage into a temp sibling, then swap — an
  // invalid item or a copy failure must not destroy the previously valid
  // dataset or leave a partial replacement (codex finding).
  const resolvedItems = opts.items.map((item) => {
    const src = item.path?.trim();
    if (!src || !existsSync(src)) throw new Error(`image not found: ${item.path}`);
    const ext = extname(src).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) throw new Error(`not a supported image (${[...IMAGE_EXTS].join("/")}): ${src}`);
    return { src, ext, caption: (item.caption ?? opts.defaultCaption)?.trim() };
  });
  const tmp = `${dir}.staging-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const warnings: string[] = [];
  let captionedCount = 0;
  try {
    resolvedItems.forEach((item, i) => {
      const base = `img_${String(i + 1).padStart(5, "0")}`;
      copyFileSync(item.src, join(tmp, `${base}${item.ext}`));
      if (item.caption) {
        writeFileSync(join(tmp, `${base}.txt`), item.caption);
        captionedCount++;
      } else {
        warnings.push(`${basename(item.src)}: no caption (defaultCaption not set)`);
      }
    });
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return { datasetPath: dir, imageCount: resolvedItems.length, captionedCount, warnings };
  } finally {
    preparingNames.delete(dir);
    releaseLock(prepLock);
  }
}

/** Datasets currently being staged (same-name race guard). */
const preparingNames = new Set<string>();

// ---- job lifecycle ------------------------------------------------------------

export interface StartJobInput {
  name: string;
  flow: TrainerFlow;
  model: TrainerModel;
  /** Host dataset dir (images + .txt captions). */
  datasetPath: string;
  trigger?: string;
  params?: Partial<TrainParams>;
  device?: string;
  /** Where to run (default "local"). "pod" requires podEndpoint. */
  target?: "local" | "pod";
  /** SSH endpoint of the target pod (target "pod"). */
  podEndpoint?: PodSshEndpoint;
  /** RunPod pod id (target "pod") — persisted so the idle auto-stop can scope
   *  "busy training" to this exact pod (codex #274). */
  podId?: string;
  /** Pod jobs: where the finished LoRA lands (default "both"). */
  deliverTo?: "pod" | "local" | "both";
  /** Override for the base model path as the trainer sees it (e.g. a pod-local
   *  HF snapshot dir) — bypasses downloading the default HF repo id. */
  modelPath?: string;
}

function countDatasetImages(datasetPath: string): number {
  try {
    return readdirSync(datasetPath).filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase())).length;
  } catch {
    return 0;
  }
}

function pushLog(job: TrainingJob, line: string): void {
  job.log.push(line);
  if (job.log.length > LOG_RING) job.log.shift();
  try {
    const file = join(job.jobDir, "train.log");
    appendFileSync(file, line + "\n");
    // Rotate: an hours-long run's tqdm spam is unbounded otherwise. The
    // cadence is tracked PER LOG FILE (codex finding: a module-global counter
    // starves whichever job doesn't emit the 500th aggregate line).
    const n = (logAppends.get(file) ?? 0) + 1;
    logAppends.set(file, n % 500);
    if (n % 500 === 0) rotateTrainingLog(file);
  } catch {
    // log file is best-effort
  }
}

const logAppends = new Map<string, number>();
const TRAIN_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Keep the tail of an over-large train.log (~2MB), discarding the oldest. */
function rotateTrainingLog(file: string): void {
  try {
    const st = statSync(file);
    if (st.size <= TRAIN_LOG_MAX_BYTES) return;
    const keep = 2 * 1024 * 1024;
    const buf = readFileSync(file);
    const tail = buf.subarray(buf.length - keep);
    const firstNl = tail.indexOf(0x0a);
    writeFileSync(file, `[rotated ${new Date().toISOString()} — kept last 2MB]\n` + tail.subarray(firstNl >= 0 ? firstNl + 1 : 0).toString("utf-8"));
  } catch {
    // best effort
  }
}

/** Map a container-side /output path (from a sample line) back to its host path. */
function toHostOutputPath(job: TrainingJob, p: string): string {
  if (p.startsWith(CONTAINER_OUTPUT + "/")) return join(job.outputDir, p.slice(CONTAINER_OUTPUT.length + 1));
  return p;
}

function reportProgress(job: TrainingJob, status: "downloading" | "done" | "error", force = false): void {
  reportDownloadProgress(
    {
      id: `train-${job.id}`,
      name: `LoRA ${job.name}`,
      downloaded: job.progress.step ?? 0,
      total: job.progress.totalSteps ?? 0,
      bytes_per_sec: 0,
      status,
    },
    force,
  );
}

/** Pick the LoRA ai-toolkit produced: the exact <name>.safetensors final save,
 *  else the highest-step <name>_NNNNNNN.safetensors checkpoint. */
export function findProducedLora(outputDir: string, jobName: string): string | null {
  const dir = join(outputDir, jobName);
  if (!existsSync(dir)) return null;
  const finalPath = join(dir, `${jobName}.safetensors`);
  if (existsSync(finalPath)) return finalPath;
  let best: { step: number; path: string } | null = null;
  for (const f of readdirSync(dir)) {
    const m = f.match(new RegExp(`^${jobName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(\\d+)\\.safetensors$`));
    if (m) {
      const step = Number(m[1]);
      if (!best || step > best.step) best = { step, path: join(dir, f) };
    }
  }
  return best?.path ?? null;
}

/**
 * Durable proof an owner-less job actually FINISHED training: the FINAL save
 * (<name>.safetensors) exists. ai-toolkit writes it only after the training
 * loop completes — periodic <name>_NNNN.safetensors checkpoints prove nothing
 * (a crash leaves those too), and stdout markers can't help: after the owner
 * process dies, nothing appends its end-of-run summary to train.log (codex
 * finding). The residual risk — a crash in the sampling phase AFTER the final
 * save — still yields a complete LoRA, so handing it off is correct.
 */
export function recoveredSuccessfully(job: TrainingJob): boolean {
  return existsSync(join(job.outputDir, job.name, `${job.name}.safetensors`));
}

/** Latest sample images from <output>/<name>/samples/, newest first. */
function findSamples(outputDir: string, jobName: string, limit = 4): string[] {
  const dir = join(outputDir, jobName, "samples");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map((x) => join(dir, x.f));
  } catch {
    return [];
  }
}

/**
 * Success handoff: copy the produced LoRA into models/loras/ and upsert the
 * catalog (trigger as keyword, base model from the trained arch) so the LoRA
 * is immediately usable in workflows and visible in the mobile LoRA hub.
 * Pod jobs ALSO deliver onto the pod's models/loras (via ssh) per deliverTo.
 */
async function handoffToComfyUI(job: TrainingJob, deps: TrainingJobDeps): Promise<void> {
  const produced = findProducedLora(job.outputDir, job.name);
  if (!produced) {
    throw new Error(`training exited cleanly but no .safetensors found under ${join(job.outputDir, job.name)}`);
  }
  const deliverTo = job.deliverTo ?? "both";
  let dest: string | undefined;
  if (deliverTo !== "pod") {
    // The destination resolved at job START wins (codex finding): if the ComfyUI
    // target changed mid-run, re-resolving now would copy the LoRA to the new
    // instance's models dir.
    const lorasDir = job.lorasDir ?? (deps.lorasDir ? deps.lorasDir() : resolveModelSubfolder("loras"));
    mkdirSync(lorasDir, { recursive: true });
    dest = join(lorasDir, `${job.name}.safetensors`);
    // Atomic publish (codex #268): a straight copyFileSync onto dest lets
    // ComfyUI's models/loras scan observe a HALF-WRITTEN file, and a same-name
    // collision clobbers an existing LoRA silently. Copy to a tmp sibling on the
    // SAME volume, then rename over dest — rename is atomic (libuv uses
    // MOVEFILE_REPLACE_EXISTING on Windows), so a reader sees either the old or
    // the complete new file, never a partial one. Overwriting an existing name
    // (a legit retrain) is allowed but logged so it's not silent.
    if (existsSync(dest)) {
      logger.warn(`[training-jobs] overwriting existing LoRA ${dest} (retrain of "${job.name}")`);
    }
    const tmpDest = join(lorasDir, `.${job.name}.safetensors.tmp-${process.pid}-${Date.now()}`);
    copyFileSync(produced, tmpDest);
    try {
      renameSync(tmpDest, dest);
    } catch (err) {
      try { rmSync(tmpDest, { force: true }); } catch { /* best effort */ }
      throw err;
    }
  }

  // Pod-side delivery: the LoRA lands in the pod's own models/loras so it's
  // usable on the pod immediately (that's the point of training there).
  let podLoraPath: string | undefined;
  if (job.target === "pod" && deliverTo !== "local" && job.containerName) {
    const ep = decodePodContainerName(job.containerName);
    if (ep) {
      const remotePath = `${podJobPaths(job.id, job.name).lorasDir}/${job.name}.safetensors`;
      const up = await (deps.rsyncFileToPod ?? rsyncFileToPod)(ep, dest ?? produced, remotePath);
      if (up.code !== 0) {
        throw new Error(`LoRA delivery to the pod's models/loras failed (rsync exit ${up.code}): ${up.stderr.trim().slice(0, 300)}`);
      }
      podLoraPath = remotePath;
      pushLog(job, `[pod] LoRA delivered → ${remotePath}`);
    }
  }

  // The catalog is per-instance: after a mid-run retarget, upserting here
  // would register the LoRA in the WRONG instance's catalog. Copy still
  // happened (into the original dir, above); skip the catalog honestly.
  // Pod-only delivery skips the rig catalog too (no local file to point at).
  if (deliverTo === "pod" || (job.instanceSlug && job.instanceSlug !== getInstanceSlug())) {
    if (deliverTo !== "pod") {
      logger.warn(
        `[training-jobs] ComfyUI instance changed mid-run (${job.instanceSlug} → ${getInstanceSlug()}); ` +
          `LoRA copied to ${dest} but the catalog upsert was skipped — re-run lora_catalog_upsert on the original instance.`,
      );
    }
    job.result = { loraPath: dest ?? podLoraPath ?? produced, loraRelPath: `loras/${job.name}.safetensors`, podLoraPath };
    return;
  }

  const catalog = deps.catalog ?? getLoraCatalog();
  const entry = catalog.upsert({
    relPath: `loras/${job.name}.safetensors`,
    displayName: job.name.replace(/_/g, " "),
    description: `Character LoRA trained ${job.target === "pod" ? "on a RunPod pod" : "locally"} on FLUX.1-dev via ostris ai-toolkit (comfyui-mcp trainer, job ${job.id}).`,
    setupInstructions:
      "Load with LoraLoaderModelOnly on a FLUX.1-dev checkpoint" +
      (job.trigger ? ` and include the trigger word "${job.trigger}" in the prompt.` : "."),
    keywords: job.trigger ? [job.trigger] : [],
    baseModels: ["FLUX.1-dev"],
    strengthDefault: 1.0,
    tags: ["trained-locally", "character", ...(job.target === "pod" ? ["trained-on-pod"] : [])],
    // Explicitly clear the flag — retraining a LoRA whose entry was marked
    // missing must become visible again (upsert otherwise preserves it).
    missing: false,
  });

  // Best-effort: newest sample image becomes the catalog preview.
  let previewFile: string | undefined;
  const samples = findSamples(job.outputDir, job.name, 1);
  if (samples.length > 0) {
    try {
      previewFile = catalog.setPreview(entry.id, samples[0]).previewFile;
    } catch (err) {
      logger.debug(`[training-jobs] preview copy skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  job.result = { loraPath: dest!, loraRelPath: `loras/${job.name}.safetensors`, catalogId: entry.id, previewFile, podLoraPath };
}

async function finalizeJob(job: TrainingJob, code: number, tail: string, deps: TrainingJobDeps): Promise<void> {
  // The whole cancel-check → handoff → persist sequence runs under the per-job
  // CAS lock: a cancel landing between the check and the handoff must not end
  // with the LoRA published anyway (independent review finding #2). The budget
  // spans a DEAD holder's lock-breaking window — a live holder serializes us
  // behind it. If it STILL can't be acquired after several cycles, ownership
  // is relinquished on disk so orphan recovery (owner-pid gate) can take over
  // instead of the job being stuck "running" forever (codex finding).
  const MAX_CYCLES = 5;
  let acquired = false;
  for (let cycle = 0; cycle < MAX_CYCLES && !acquired; cycle++) {
    acquired = await acquireJobLock(job.id, deps.lockBudgetMs ?? LOCK_STALE_MS + 60_000);
    if (!acquired) {
      logger.warn(`[training-jobs] finalize ${job.id}: lock held too long (cycle ${cycle + 1}/${MAX_CYCLES}) — retrying`);
    }
  }
  if (!acquired) {
    // Relinquish ownership with an ADDITIVE marker (create-if-absent): mutating
    // the record here without the lock could overwrite a terminal state the
    // holder just wrote (codex finding). ownerAlive() honors the marker, so
    // orphan recovery can take over from here.
    try {
      mkdirSync(jobsRoot(), { recursive: true });
      const fd = openSync(ownerReleaseFile(job.id), "wx");
      closeSync(fd);
    } catch { /* already released — fine */ }
    logger.warn(`[training-jobs] finalize ${job.id}: relinquished ownership after ${MAX_CYCLES} failed lock cycles`);
    return;
  }
  try {
    // A cancel marks the job before the container exits — don't overwrite it.
    // Check BOTH this process's memory and the on-disk record (re-read inside
    // the lock): a cancel from another process only shows up on disk.
    if (job.status === "cancelled") {
      // An in-flight cancel (registered but not yet lock-persisted) must WIN
      // over this finalize — treating it as a rollback because the disk hasn't
      // caught up publishes a cancelled run (codex finding).
      if (pendingCancels.has(job.id)) return;
      const disk = readJobRecord(job.id);
      if (disk?.status === "cancelled") return;
      // Memory says cancelled but disk doesn't: the cancel was rolled back
      // after a failed stop — reconcile and finalize normally.
      job.status = "running";
      job.finishedAt = undefined;
      job.error = undefined;
    }
    const disk = readJobRecord(job.id);
    if (disk?.status === "cancelled") {
      job.status = "cancelled";
      job.finishedAt = disk.finishedAt ?? new Date().toISOString();
      job.updatedAt = job.finishedAt;
      return;
    }
    if (disk && (disk.status === "completed" || disk.status === "failed")) {
      // Another process already finalized (e.g. owner-dead recovery won the
      // lock) — adopt its complete record instead of copying fields (codex
      // finding: selective copies dropped finalized progress/samples/log).
      jobs.set(job.id, disk);
      return;
    }
    job.finishedAt = new Date().toISOString();
    // Pod jobs: pull the produced output (checkpoints + samples + LoRA) back to
    // the rig BEFORE the usual handoff so findSamples/findProducedLora see it
    // (samples mirror to panel/mobile through the same rig-local paths).
    const pulled = await pullPodOutput(job, deps);
    // Surface the generated samples in train_status regardless of outcome —
    // ai-toolkit prints only "Generating Images" bars (no saved-file lines), so
    // onProgress never sees sample paths (codex finding; confirmed by the E2E).
    const samples = findSamples(job.outputDir, job.name, 4);
    if (samples.length > 0) job.progress.samples = samples;
    if (code === 0) {
      if (!pulled.ok) {
        // #263 BLOCKER: a failed/partial transfer must never mark the job
        // completed — before this gate a truncated 172MB pull could be
        // published locally AND (deliverTo pod/both) re-uploaded over the
        // good pod-side artifact. The pod copy is intact; fail honestly.
        job.status = "failed";
        job.error = `training succeeded on the pod but the output transfer failed — not publishing a partial LoRA: ${pulled.error}. The finished artifacts are still on the pod under ${podJobPaths(job.id, job.name).outputDir}.`;
        reportProgress(job, "error", true);
      } else {
        try {
          await handoffToComfyUI(job, deps);
          job.status = "completed";
          // The last training bar can read e.g. 199/200 before the final save +
          // sampling phases — normalize so a completed job shows a complete count.
          if (job.progress.totalSteps !== undefined) job.progress.step = job.progress.totalSteps;
          reportProgress(job, "done", true);
        } catch (err) {
          job.status = "failed";
          job.error = `output handoff failed: ${err instanceof Error ? err.message : String(err)}`;
          reportProgress(job, "error", true);
        }
      }
    } else {
      job.status = "failed";
      job.error = `training container exited ${code}${tail ? ` — last output:\n${tail}` : ""}`;
      reportProgress(job, "error", true);
    }
    job.updatedAt = new Date().toISOString();
    persist(job);
  } finally {
    releaseJobLock(job.id);
  }
}

/**
 * Build the config, launch the container, and register the job. Returns as
 * soon as the container is up; completion is handled by the handle's `done`
 * promise (finalizeJob). Preflight (docker/image) belongs to the caller — the
 * train_start tool runs trainerDoctor checks first.
 *
 * The LoRA handoff destination is resolved BEFORE launch (codex finding): in
 * remote mode / with no local workspace, resolveModelSubfolder throws — better
 * here than after an hours-long run.
 */
export async function startTrainingJob(input: StartJobInput, deps: TrainingJobDeps = {}): Promise<TrainingJob> {
  // Pod reservation lock (codex #273): held from the one-run-per-pod scan
  // through the launch so a second process can't double-launch on this pod.
  // Released on EVERY exit path by the finally at the end of the function.
  let podReserveLock: string | null = null;
  try {
  const start = deps.startTraining ?? startTraining;
  const now = deps.now ?? (() => Date.now());
  const datasetPath = resolve(input.datasetPath);
  if (!existsSync(datasetPath)) throw new Error(`dataset not found: ${input.datasetPath}`);
  const imageCount = countDatasetImages(datasetPath);
  if (imageCount === 0) throw new Error(`dataset has no images (${[...IMAGE_EXTS].join("/")}): ${datasetPath}`);
  // The dataset is bind-mounted READ-WRITE into the container (ai-toolkit
  // caches into it), so it must live UNDER datasetsRoot() — arbitrary host
  // dirs are not exposed to container writes (independent review finding #4).
  // Stage datasets with train_prepare_dataset; it lands them there.
  if (!pathWithin(datasetsRoot(), datasetPath)) {
    throw new Error(`dataset must be staged under ${resolve(datasetsRoot())} — use train_prepare_dataset (the container mounts it read-write)`);
  }
  const target = input.target ?? "local";
  // A local job has no pod to deliver TO — this combination used to sail
  // through and complete with a loraRelPath for a file never installed
  // anywhere (codex finding).
  if (target === "local" && input.deliverTo === "pod") {
    throw new Error(`deliverTo "pod" is only valid for pod jobs — a local run has no pod to deliver to (use "local" or "both")`);
  }
  if (target === "pod") {
    if (!input.podEndpoint) throw new Error('target "pod" requires a pod SSH endpoint');
    const sshWorks = deps.sshWorks ?? sshEndpointWorks;
    if (!(await sshWorks(input.podEndpoint))) {
      throw new Error(`pod SSH unreachable at ${input.podEndpoint.userHost}:${input.podEndpoint.port} (key-only auth must be set up — the pod template injects $PUBLIC_KEY at boot)`);
    }
    // Cross-process serialization (codex #273): acquire a pod-scoped lock BEFORE
    // the scan and hold it through persist+launch, so two MCP processes can't
    // both pass the disk scan (scan→persist has no in-process yield, so the race
    // is purely cross-process) and double-launch run.py on this pod.
    const reserveFile = podReservationLockFile(input.podEndpoint);
    if (!(await acquireLock(reserveFile, deps.lockBudgetMs ?? LOCK_WAIT_MS))) {
      throw new Error(`another train_start is already reserving pod ${input.podEndpoint.userHost}:${input.podEndpoint.port} — retry in a moment`);
    }
    podReserveLock = reserveFile;
    // One training run per pod at a time (its GPU saturates; a second run.py
    // would also make the remote pkill pattern ambiguous). Probe-free DISK
    // scan scoped to THIS pod's endpoint — a restart or a second MCP process
    // can't defeat it (codex findings: memory-only scan, and it was global
    // instead of per-pod).
    const myName = encodePodContainerName(input.podEndpoint);
    for (const j of scanJobRecords()) {
      if ((j.status === "running" || j.status === "queued") && j.containerName === myName) {
        throw new Error(`pod already has an active training job (${j.id}) — one run per pod`);
      }
    }
  }
  // Pre-launch handoff check — throws early when no local ComfyUI is resolvable.
  const lorasDir = deps.lorasDir ?? (() => resolveModelSubfolder("loras"));
  const resolvedLorasDir = target === "pod" && input.deliverTo === "pod" ? "" : lorasDir();
  const effDeps: TrainingJobDeps = { ...deps, lorasDir };

  const id = `t${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const jobDir = join(jobsRoot(), id);
  const outputDir = join(jobDir, "output");
  mkdirSync(outputDir, { recursive: true });

  const isPod = target === "pod";
  // Config paths: docker sees CONTAINER mount points; a pod-native run sees
  // REAL pod paths (no mount rewrite) — built from the SANITIZED job name
  // (raw input could traverse or break the pod fs layout; codex finding).
  const podPaths = isPod ? podJobPaths(id, sanitizeJobName(input.name)) : null;
  const built = buildTrainingConfig({
    name: input.name,
    flow: input.flow,
    model: input.model,
    datasetPath: isPod ? podPaths!.datasetDir : CONTAINER_DATASET,
    outputDir: isPod ? podPaths!.outputDir : CONTAINER_OUTPUT,
    trigger: input.trigger,
    device: input.device,
    params: input.params,
    modelPath: input.modelPath,
  });
  const configPath = join(jobDir, "config.yml");
  writeFileSync(configPath, built.yaml);

  const job: TrainingJob = {
    id,
    name: built.jobName,
    flow: input.flow,
    model: input.model,
    trigger: input.trigger,
    status: "queued",
    progress: { samples: [] },
    containerName: isPod ? encodePodContainerName(input.podEndpoint!) : `comfyui-train-${id}`,
    target,
    deliverTo: input.deliverTo ?? "both",
    podId: input.podId,
    ownerPid: process.pid,
    datasetPath,
    jobDir,
    outputDir,
    log: [],
    lorasDir: resolvedLorasDir,
    instanceSlug: getInstanceSlug(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  // Never launch a container we failed to register — it would be unfindable
  // and uncancellable after this process dies (independent review finding #5).
  if (!persist(job)) {
    jobs.delete(id);
    throw new Error(`could not persist the job record under ${jobsRoot()} — refusing to launch an untracked container`);
  }

  // Pod staging: dataset + config must exist ON the pod before run.py starts.
  if (isPod) {
    const ep = input.podEndpoint!;
    pushLog(job, `[pod] staging dataset → ${ep.userHost}:${podPaths!.datasetDir}`);
    persist(job);
    const up = await (deps.rsyncToPod ?? rsyncToPod)(ep, datasetPath, podPaths!.datasetDir);
    if (up.code !== 0) {
      // Terminalize, don't orphan (codex finding: a deleted-but-persisted
      // queued record suppressed idle auto-stop forever).
      job.status = "failed";
      job.error = `dataset upload to the pod failed (rsync exit ${up.code}): ${up.stderr.trim().slice(0, 300)}`;
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      persist(job);
      throw new Error(job.error);
    }
    const cfg = await (deps.rsyncFileToPod ?? rsyncFileToPod)(ep, configPath, podPaths!.configPath);
    if (cfg.code !== 0) {
      job.status = "failed";
      job.error = `config upload to the pod failed (rsync exit ${cfg.code}): ${cfg.stderr.trim().slice(0, 300)}`;
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      persist(job);
      throw new Error(job.error);
    }
    pushLog(job, "[pod] staged — starting run.py over ssh");
  }

  let handle: TrainingHandle;
  // Driver-agnostic handlers — the local docker driver and the pod ssh runner
  // feed the SAME progress/log plumbing (that's the point of the shared parse).
  const onProgress = (p: TrainingProgress) => {
    // Terminal jobs ignore ticks — a progress line arriving while a cancel's
    // docker stop is in flight must not resurrect the job (codex finding).
    if (job.status === "cancelled") {
      // …but a FOREIGN cancel can be rolled back: the cancelling process
      // reverts the disk record to running when its docker stop fails. If the
      // disk no longer says cancelled, resume — otherwise stay cancelled
      // (codex finding: permanent adoption suppressed a later completion).
      // While a cancel is IN FLIGHT (this process hasn't persisted it yet),
      // the disk still says running legitimately — never reconcile that.
      if (pendingCancels.has(job.id)) return;
      if (!diskCancelled(job)) {
        job.status = "running";
        job.finishedAt = undefined;
        job.error = undefined;
      } else {
        return;
      }
    }
    if (job.status === "completed" || job.status === "failed") return;
    if (job.status !== "running") {
      job.status = "running";
      reportProgress(job, "downloading", true);
    }
    if (p.step !== undefined) job.progress.step = p.step;
    if (p.totalSteps !== undefined) job.progress.totalSteps = p.totalSteps;
    if (p.loss !== undefined) job.progress.loss = p.loss;
    if (p.sample) {
      job.progress.samples.unshift(toHostOutputPath(job, p.sample));
      job.progress.samples = job.progress.samples.slice(0, 4);
    }
    job.updatedAt = new Date().toISOString();
    reportProgress(job, "downloading");
    // Throttled disk snapshot so OTHER processes (orchestrator call_tool
    // client → mobile train_status) see live progress, not just the final
    // state (codex finding: progress was memory-only until finalize).
    const last = lastProgressPersistAt.get(id) ?? 0;
    if (Date.now() - last >= PROGRESS_PERSIST_MS) {
      lastProgressPersistAt.set(id, Date.now());
      scheduleLivePersist(job);
    }
  };
  const onLog = (line: string) => {
    pushLog(job, line);
    // Refresh the owner liveness lease on log-only activity too (codex
    // finding: a >60s log-only phase made the owner look stale). updatedAt
    // rides out on the throttled persist below.
    job.updatedAt = new Date().toISOString();
    // Log lines also snapshot (same throttle): during the long first-run
    // model download there are NO progress ticks, so without this a
    // cross-process train_status sees an empty, apparently stalled record
    // (codex finding).
    const last = lastProgressPersistAt.get(id) ?? 0;
    if (Date.now() - last >= PROGRESS_PERSIST_MS) {
      lastProgressPersistAt.set(id, Date.now());
      scheduleLivePersist(job);
    }
  };
  try {
    if (isPod) {
      const h = (deps.startSshTraining ?? startSshTraining)({
        containerName: job.containerName!,
        remoteConfigPath: podPaths!.configPath,
        hfCacheDir: podPaths!.hfCacheDir,
        hfToken: process.env.HF_TOKEN?.trim() || undefined,
        onProgress,
        onLog,
      });
      if ("error" in h) throw new Error(h.error);
      handle = h;
    } else {
      handle = start({
        containerName: job.containerName!,
        configPath,
        datasetPath,
        outputDir,
        hfCacheDir: hfCacheRoot(),
        hfToken: process.env.HF_TOKEN?.trim() || undefined,
        onProgress,
        onLog,
      });
    }
  } catch (err) {
    // startTraining threw before the container was up — the job must not sit
    // queued forever with a live-but-handleless owner (codex finding).
    job.status = "failed";
    job.error = `could not start the training container: ${err instanceof Error ? err.message : String(err)}`;
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    persist(job);
    throw err;
  }
  handles.set(id, handle);

  handle.done
    .then(({ code, tail }) => finalizeJob(job, code, tail, effDeps))
    .catch((err) => {
      logger.warn(`[training-jobs] finalize ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      handles.delete(id);
      lastProgressPersistAt.delete(id);
      // NOTE: the terminal download-progress row is intentionally NOT cleared —
      // the orchestrator watcher lingers done/error rows ~8s (so completion is
      // visible in the tray) and then prunes them itself (codex finding).
    });

  job.status = "running";
  job.updatedAt = new Date().toISOString();
  persist(job);
  return job;
  } finally {
    if (podReserveLock) releaseLock(podReserveLock);
  }
}

/** Stop the container and mark the job cancelled. Idempotent. Works
 *  cross-process: the container name is persisted, so a cancel from another
 *  process (orchestrator call_tool) still reaches `docker stop`.
 *
 *  Ordering matters (codex findings): the cancelled state is persisted BEFORE
 *  awaiting `docker stop` — otherwise a clean-exit container can finalize
 *  (handoff + catalog) while the stop is in flight. After the stop we verify
 *  with a liveness probe; if the container is genuinely still alive the job
 *  reverts to running with an error instead of lying about being cancelled. */
export async function cancelJob(id: string, deps: TrainingJobDeps = {}): Promise<TrainingJob> {
  const job = await getJob(id, deps);
  if (!job) throw new Error(`no training job ${id}`);
  // A cancel is already IN FLIGHT for this job (in-process): JOIN it instead
  // of acting on the marked-but-unpersisted state (codex finding: a second
  // caller could take the already-cancelled path and stop the container, then
  // the first acquisition times out, reverts, and the job finalizes anyway).
  const pending = pendingCancels.get(id);
  if (pending) return pending;
  if (job.status === "completed" || job.status === "failed") return job;
  if (job.status === "cancelled") {
    // Already cancelled (persisted) — but if a previous cancel died between
    // persisting the state and finishing `docker stop`, the container may
    // still be alive. Retry the stop instead of blindly returning.
    if (!job.containerName) return job;
    const probe = deps.containerRunning ?? defaultContainerProbe;
    const cfgPath = jobProbeConfigPath(job);
    const alive = await probe(job.containerName, cfgPath).catch(() => null);
    // Only a definitive "gone" short-circuits; unknown (daemon temporarily
    // unreachable) still attempts the stop so a live container can't keep
    // burning GPU behind a stale cancelled record (codex finding).
    if (alive === false) return job;
    const stop = deps.stopTraining ?? defaultTrainingStop;
    const res = await stop(job.containerName, cfgPath);
    // Always probe after a stop attempt: a CLI timeout can fire AFTER the
    // daemon honored the stop (codex finding). Only when liveness is unknown
    // do we fall back to the stop command's own result. The probe is scoped to
    // THIS job's config path so an unrelated run.py can't fake still-running.
    const probed = await probe(job.containerName, cfgPath).catch(() => null);
    const stillRunning = probed ?? res.ok === false;
    if (stillRunning === true) {
      job.status = "running";
      job.finishedAt = undefined;
      job.updatedAt = new Date().toISOString();
      job.error = `cancel retry failed — container ${job.containerName} is still running${res.error ? `: ${res.error.message}` : ""}`;
      persist(job);
    }
    return job;
  }

  // Register the pending cancel SYNCHRONOUSLY (before any await) so every
  // concurrent caller joins it instead of racing us.
  const p = cancelJobBody(id, job, deps);
  pendingCancels.set(id, p);
  try {
    return await p;
  } finally {
    pendingCancels.delete(id);
  }
}

/** The cancel body: mark → lock-persist → stop → verify. */
async function cancelJobBody(id: string, job: TrainingJob, deps: TrainingJobDeps): Promise<TrainingJob> {
  // Persist the cancelled state UNDER THE LOCK (independent review finding #2):
  // a finalizer holds the same lock across its cancel-check → handoff, so a
  // cancel can no longer slip in between and get published anyway. On timeout
  // we do NOT write unlocked (codex finding) — the cancel is reported as
  // failed-to-confirm and can be retried.
  const prevStatus = job.status;
  job.status = "cancelled";
  job.finishedAt = new Date().toISOString();
  job.updatedAt = job.finishedAt;
  job.error = undefined;
  if (!(await acquireJobLock(id, deps.lockBudgetMs ?? 90_000))) {
    job.status = prevStatus;
    job.finishedAt = undefined;
    job.updatedAt = new Date().toISOString();
    job.error = "could not confirm the cancel — a finalize is in progress on this job; retry in a few seconds";
    return job;
  }
  try {
    const disk = readJobRecord(id);
    if (disk && (disk.status === "completed" || disk.status === "failed")) {
      // Finalized while we waited for the lock — adopt the COMPLETE finalized
      // record (codex finding: copying selected fields into the stale pre-wait
      // object and persisting it overwrote the final progress/samples/log).
      // Nothing to persist: the disk record is already the truth.
      jobs.set(id, disk);
      return disk;
    }
    if (disk && disk.status === "cancelled") {
      // A cross-process cancel landed while we waited. Adopt the record — by
      // MERGING into the live job object (codex finding: replacing the map
      // entry made the registry report cancelled while the rest of this
      // cancel kept mutating — and could persist — the OLD object as running).
      // And CONTINUE to the stop path: the other process may have died between
      // persisting the marker and its docker stop.
      Object.assign(job, disk);
    } else {
      // Re-apply the cancelled state INSIDE the lock: the wait may have lasted
      // long enough for memory to have been perturbed — the persisted marker is
      // what the finalizer honors (codex finding).
      job.status = "cancelled";
      job.finishedAt = job.finishedAt ?? new Date().toISOString();
      job.updatedAt = new Date().toISOString();
      persist(job);
    }
  } finally {
    releaseJobLock(id);
  }

  if (job.containerName) {
    const stop = deps.stopTraining ?? defaultTrainingStop;
    const cfgPath = jobProbeConfigPath(job);
    const res = await stop(job.containerName, cfgPath);
    const probe = deps.containerRunning ?? defaultContainerProbe;
    // Probe after the stop regardless of its exit status (see above), scoped to
    // THIS job's config path so an unrelated run.py can't fake still-running.
    const probed = await probe(job.containerName, cfgPath).catch(() => null);
    const stillRunning = probed ?? res.ok === false;
    if (stillRunning === true) {
      // Stop genuinely failed — the container is still training.
      job.status = "running";
      job.finishedAt = undefined;
      job.updatedAt = new Date().toISOString();
      job.error = `cancel failed — container ${job.containerName} is still running${res.error ? `: ${res.error.message}` : ""}`;
      persist(job);
      return job;
    }
  }
  reportProgress(job, "error", true);
  persist(job);
  return job;
}

/** Public, JSON-safe view of a job (drops nothing — TrainingJob is already
 *  plain data; exposed so tools/tests have one obvious shape). */
export function toJobSummary(job: TrainingJob): TrainingJob {
  return job;
}

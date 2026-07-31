/**
 * Background registry for model downloads.
 *
 * `download_model` used to await the whole transfer before returning anything.
 * On a multi-GB checkpoint that left the agent's tool call pending for minutes:
 * the turn stayed alive burning tokens with nothing to say, and when the user
 * forced a message to break the apparent hang, the pending call was cancelled —
 * so the agent reported the download as not done. The stream kept writing to
 * disk regardless, which is the worst version of the bug: the file arrives and
 * the agent tells you it didn't. (Reported in Discord; issue #290.)
 *
 * This registry lets the tool hand back a handle instead of blocking forever,
 * mirroring the move generation already made from a blocking `run_workflow` to
 * `enqueue_workflow` + `get_job_status`.
 */

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  downloadModel,
  resolveDownloadTarget,
  shouldDispatchDownloadToManager,
} from "./model-resolver.js";
import type { DownloadAuth } from "./download-auth.js";
import type { ResumeDiagnostic } from "./download-resume-diag.js";
import { ModelError } from "../utils/errors.js";
import {
  persistDownloadJob,
  readPersistedDownloadJob,
  listPersistedDownloadJobs,
  findPersistedDownloadJob,
  clearDownloadProgress,
  persistedRecordsEnabled,
  PERSIST_OWNER,
  PERSISTED_INFLIGHT_STALE_MS,
  type PersistedDownloadJob,
} from "./download-progress.js";
import { logger } from "../utils/logger.js";

export interface DownloadJob {
  /** DISTINCT public id, derived from URL AND destination, so the same URL
   *  fetched to two different targets is two separately-pollable jobs
   *  (download_status(id) resolves each independently). Also the registry key. */
  id: string;
  /** The panel tray / progress-file id — a hash of the ORIGINAL source URL only.
   *  STABLE for the life of the job and used to ADOPT this download by URL after a
   *  reconnect (#529): findDownloadJob({url}) hashes the same original URL. Kept
   *  separate from `id` so distinct-destination jobs still map to their URL. */
  trayId: string;
  /** The id the PHYSICAL progress rows are actually written under — a hash of the
   *  POST-auth/post-HF-rewrite request URL, reported by the writer (#515). Differs
   *  from `trayId` only for query-auth or HF_ENDPOINT-rewritten URLs; equals it for
   *  the common case. download_status byte display and cancel cleanup key on THIS id
   *  (falling back to trayId when unset). Never used for URL adoption (that needs the
   *  stable original-URL trayId). */
  progressId?: string;
  /** This job's OWN resume decision (#467), reported by its physical download via
   *  a callback and stored here — so download_status surfaces exactly this job's
   *  outcome and never a stale/other job's. Absent when no resumable download ran
   *  (Manager dispatch, cache hit, a job that coalesced onto another's stream, or
   *  a failure before streaming). */
  resume?: ResumeDiagnostic;
  url: string;
  target_subfolder: string;
  filename?: string;
  /** "cancelled" is a user-requested abort (#515): the stream was aborted, no
   *  false-complete is reported, and the resumable .partial is left on disk. */
  status: "downloading" | "done" | "error" | "cancelled";
  /** Absolute path once the file has landed. */
  path?: string;
  error?: string;
  started_at: number;
  finished_at?: number;
  /** The auth-free destination key (local targetPath or canonical remote id) this
   *  job serializes/persists under — surfaced so a reconnecting session can adopt
   *  the same in-flight download by destination without starting a duplicate (#529). */
  destKey?: string;
  /** The ROUTE-INDEPENDENT request key (url+subfolder+filename+auth) — the SAME whether
   *  the download routed to local disk or the remote Manager (#420). Persisted so
   *  cross-session adoption matches a reconnect whose route flipped local↔Manager (which
   *  changes the public `id` from a destination hash to a request hash) — otherwise the
   *  reissue would miss the in-flight record and start a second writer. */
  reqKey?: string;
  /** True when this download is DISPATCHED to a remote ComfyUI-Manager (server-side
   *  fetch) rather than streamed to local disk. A "done" viaManager job means the
   *  dispatch was ACCEPTED — NOT that the file has verifiably landed (Manager reports
   *  its queue task done even on failure), and a cancel can't recall the server task.
   *  download_status renders it as "dispatched (not verified here)" so it isn't
   *  mistaken for a validated local completion. */
  viaManager?: boolean;
  /** Lines produced by post-download work (trigger words, sidecar paths,
   *  not-a-model warnings). These used to be returned inline by the tool; once a
   *  download outlives its tool call they have to survive somewhere the agent
   *  can still read them, or handing back a handle would silently drop them. */
  notes?: string[];
}

interface Entry {
  job: DownloadJob;
  settled: Promise<void>;
  /** Every registry key this entry is indexed under (request key, and the
   *  destination key when locally resolvable). Kept so a superseding job can
   *  unregister ALL of a stale entry's keys — no orphaned index rows. */
  keys: string[];
  /** Per-download abort handle (#515). Its `signal` is threaded through
   *  downloadModel → the fetch + stream pipeline, so `cancel_download` can abort
   *  exactly THIS job's transfer without touching any other in-flight download. */
  controller: AbortController;
  /** While in flight, periodically re-persists the record so its `updated` stamp
   *  acts as a liveness heartbeat — letting ANOTHER session tell a live download from
   *  a crashed one when deciding whether to preserve a shared tray row (#515/#529). */
  heartbeat?: ReturnType<typeof setInterval>;
}

/** How often an in-flight job re-persists its record (liveness heartbeat). Must stay
 *  comfortably below PERSISTED_INFLIGHT_STALE_MS so a live download is always fresh. */
const HEARTBEAT_MS = 15_000;
/** Cap on heartbeat retries of a transiently-failing TERMINAL persist. Chosen so the
 *  total window (attempts × HEARTBEAT_MS) exceeds PERSISTED_INFLIGHT_STALE_MS — by then
 *  the last-successful (in-flight) record has already aged out via the stale reap, so
 *  giving up can't leave a fresh, adoptable record. Prevents a permanently-unwritable
 *  progress store from keeping a COMPLETED job's interval doing filesystem work forever. */
const TERMINAL_PERSIST_MAX_ATTEMPTS = 6; // 6 × 15s = 90s > 60s stale window

// The in-flight registry is indexed under MULTIPLE keys per job so dedup is
// ROUTE-INDEPENDENT: a repeated request finds the in-flight job whether or not the
// Manager↔local route flipped between calls (#420 codex round 2). One Entry object
// is shared by all its keys.
const jobs = new Map<string, Entry>();

// Per-DESTINATION-PATH serialization chain (#467 P1-C). Two concurrent jobs for
// the SAME on-disk destination with DIFFERENT auth are (correctly) distinct jobs
// with distinct representations — but they both materialize to that ONE path, and
// each runs post-download work (onComplete) against it. Running them concurrently
// lets one job's writer replace the destination WHILE the other's onComplete reads
// it — so Alice's callback could process Bob's bytes. We serialize by the auth-free
// destination so each job's download+materialize+onComplete sees ITS OWN bytes
// uninterrupted; the final on-disk file is deterministically the last-started job's
// (inherent: one path can hold one file). Keyed by the realpath-collapsed,
// case-normalized LOCAL targetPath, OR a canonical remote:<subfolder>/<name> for
// Manager-dispatched jobs (which write ONE server-side file per subfolder+name).
const destChains = new Map<string, Promise<void>>();

/** Canonicalize a LOCAL destination key for the serialization chain. Case-
 *  insensitive filesystems (Windows always; macOS by default) alias `Checkpoints/m`
 *  and `checkpoints/m` to ONE physical file, so lower-case the key there to
 *  serialize those too (#467 P1-C). POSIX (Linux) is case-sensitive — leave exact. */
function normalizeLocalDestKey(key: string): string {
  return process.platform === "win32" || process.platform === "darwin"
    ? key.toLowerCase()
    : key;
}

/** realpath the DEEPEST EXISTING ANCESTOR of `p` and re-append the not-yet-created
 *  tail. `realpath(p)` alone fails (and falls back to the lexical path) whenever any
 *  descendant is absent — but the writer mkdir's the tree later, so a symlink/
 *  junction in the EXISTING prefix must still be collapsed (#467 P1-C). Walking up
 *  to the deepest existing dir collapses that prefix regardless of the missing tail. */
async function realpathDeepestExisting(p: string): Promise<string> {
  const tail: string[] = [];
  let current = p;
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // Only ABSENCE walks upward. An existing-but-unresolvable ancestor (EIO,
      // EACCES, ELOOP, …) must NOT be treated as absent — walking past it would
      // reconstruct the un-collapsed lexical ALIAS and defeat serialization (wrong-
      // bytes race). Fail CLOSED: propagate so the job errors rather than risk it
      // (#467). A transient error here is far rarer than the corruption it guards.
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = dirname(current);
      if (parent === current) return p; // reached the root without resolving — give up
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** The LOCAL serialization key: collapse symlinks/junctions in the destination path
 *  (via the deepest existing ancestor), then case-normalize — so two aliased
 *  subfolders resolving to ONE physical file share a chain (#467 P1-C). */
async function localSerializeKey(targetPath: string): Promise<string> {
  const real = await realpathDeepestExisting(targetPath);
  return normalizeLocalDestKey(real);
}

/** The REMOTE serialization key. The Manager writes ONE server-side file per
 *  (subfolder, name); derive the name the way the resolve/Manager path does
 *  (URL pathname basename when no explicit filename) and normalize separators so
 *  `a//b` == `a/b` and query variants collapse. The remote host's case-sensitivity
 *  is UNKNOWN here, so lower-case unconditionally — over-serializing is safe, under-
 *  serializing (concurrent same-file writes) is not (#467 P1-C). */
function remoteSerializeKey(url: string, targetSubfolder: string, filename?: string): string {
  let name = filename;
  if (!name) {
    try {
      name = basename(new URL(url).pathname);
    } catch {
      name = url.split(/[/?#]/).filter(Boolean).pop();
    }
  }
  // Mirror the Manager writer's trim() then separator-normalize so ` loras/sub `,
  // `loras/sub`, and `loras//sub` all canonicalize to one key (#467 P1-C).
  const sub = String(targetSubfolder ?? "")
    .trim()
    .split(/[/\\]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");
  return `remote:${sub}/${(name || "model").trim()}`.toLowerCase();
}

/**
 * Point `key` at `entry`, ENTRY-SCOPED (#420 codex round 3, rule 2/3): never clobber
 * a row currently owned by a DIFFERENT, still-in-flight writer — that would orphan a
 * live download's index. Records the key on the entry so it can be retired later.
 */
function registerKey(entry: Entry, key: string): void {
  const cur = jobs.get(key);
  if (cur && cur !== entry && cur.job.status === "downloading") return;
  if (!entry.keys.includes(key)) entry.keys.push(key);
  jobs.set(key, entry);
}

/**
 * Retire a superseded (done/error) entry, ENTRY-SCOPED (#420 codex round 3, rule 2):
 * only delete an index row that STILL points at THIS entry, so retiring an older job
 * can never delete a key that has since been reassigned to a newer/live entry.
 */
function retireEntry(entry: Entry): void {
  for (const key of entry.keys) {
    if (jobs.get(key) === entry) jobs.delete(key);
  }
}

/** The tray keys rows on a hash of the SOURCE URL; match it so both agree. */
export function downloadIdFor(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/**
 * The download's DISTINCT public id — a hash of the given identity string. Callers
 * pass the canonical resolved on-disk `targetPath` PLUS an auth discriminator
 * (#467 P1-A), so identity is the DESTINATION *and representation*: two requests
 * that resolve to the SAME file with the SAME auth are one job/one writer (even
 * from different URLs), but the SAME file with DIFFERENT auth are DIFFERENT
 * downloads (a different representation) and must not dedup. Requests to different
 * destinations are separately pollable via download_status.
 */
export function downloadJobIdFor(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

/**
 * ROUTE-INDEPENDENT request key: a canonical, collision-safe JSON-encoded tuple of
 * {url, trimmed subfolder, filename}. Derived ONLY from the request inputs — never
 * from the resolved destination or the chosen route — so a repeated call for the
 * SAME request adopts the in-flight job regardless of a Manager↔local reachability
 * flip between calls (#420 codex round 2). Every job is indexed under this key; a
 * locally-resolvable job is ALSO indexed under its destination key (below) so the
 * "two different URLs → one local destination → one writer" dedup still holds.
 */
/** A stable per-request discriminator for the caller's auth/representation. The
 *  JOB layer dedups BEFORE the header-aware cache layer is reached, and it is
 *  otherwise auth-blind — so without this, two concurrent same-URL+same-dest
 *  calls with DIFFERENT bearer/custom headers would adopt the FIRST job and the
 *  second caller would get the first's bytes AND resume callback (#467 P1-A). The
 *  `auth` param is the per-caller differentiator (config-global tokens are
 *  identical across concurrent calls, so they need not enter the key). Two auth
 *  encodings that transmit the SAME headers may still be split here — harmless:
 *  they then coalesce correctly at the cache layer (same representation). */
function authIdentity(auth?: DownloadAuth): string {
  return auth ? createHash("sha256").update(JSON.stringify(auth)).digest("hex").slice(0, 12) : "";
}

function requestDownloadKey(
  url: string,
  targetSubfolder: string,
  filename?: string,
  auth?: DownloadAuth,
): string {
  const canonical = JSON.stringify([
    url,
    String(targetSubfolder ?? "").trim(),
    filename ?? null,
    authIdentity(auth),
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Start a download, or adopt one already running for the same on-disk destination.
 *
 * The adoption case matters: the visible symptom of the old bug was "the agent
 * looks stuck", and the natural user response is to ask again. Without this,
 * the second ask starts a SECOND stream onto the same target path — two writers,
 * one file. Returning the in-flight job makes a repeated request harmless.
 *
 * Async because the destination is resolved by the SAME code the write uses
 * (resolveDownloadTarget), so the job is keyed by the exact `targetPath` the file
 * lands at — any two inputs resolving to one file are one job — and an INVALID
 * input (blank / path-ful filename, escaping subfolder) is REJECTED here, up
 * front, exactly as the download itself would reject it (never basename'd into a
 * collision with a valid request). REMOTE mode still resolves a canonical
 * server-side targetPath for identity even though the bytes are fetched by the
 * Manager, so duplicate remote dispatches to one destination also dedupe.
 */
export async function startDownloadJob(
  url: string,
  targetSubfolder: string,
  filename?: string,
  auth?: DownloadAuth,
  /** Post-download work (sidecars, type checks). Its lines land on `job.notes`
   *  so they reach the user even when the download outlives the tool call. */
  onComplete?: (path: string) => Promise<string[]>,
): Promise<Entry> {
  // Identity depends on mode. LOCAL: resolve the canonical on-disk destination
  // with the SAME resolver the write uses (throws on an invalid filename/subfolder
  // — surfaced immediately, matching downloadModel's own rejection — and keys by
  // the exact targetPath so identity is the destination, not the URL). REMOTE:
  // there is NO local filesystem — downloadModel short-circuits to the Manager
  // dispatch, so resolving a local models dir would wrongly THROW (COMFYUI_PATH
  // unset). Key by a canonical remote identity instead and let downloadModel take
  // the Manager path. shouldDispatchDownloadToManager() also covers the #420
  // reconnect case: a nominally-local session whose effective base was lost still
  // routes through the connected Manager (and must NOT try to resolve a local
  // targetPath, which would throw), keying by the same canonical remote identity.
  //
  // CRITICAL: evaluate the route EXACTLY ONCE and thread it into downloadModel
  // below. The predicate awaits live /system_stats and reads mutable base config,
  // so a reconnect/reachability flip between two evaluations would split the job —
  // Manager-key + local-writer (or a duplicate job) for one request (#420 codex
  // round 1). One decision keys the identity AND drives the writer.
  const dispatchToManager = await shouldDispatchDownloadToManager();

  // DEDUP INDEX (route-independent) vs WRITER ROUTE (the single decision above) are
  // deliberately separated (#420 codex round 2). The in-flight lookup/registration
  // is keyed by the REQUEST (url+subfolder+filename), which NEVER changes with the
  // route — so two separate calls for one request with a Manager↔local flip between
  // them still resolve to ONE job (no same-file double-write). When the request is
  // locally resolvable we ALSO index the destination-path key, preserving the
  // "two different URLs → same local destination → one writer" dedup (WS-4). An
  // invalid filename/subfolder is REJECTED here (by resolveDownloadTarget), up
  // front, exactly as the write would reject it.
  const reqKey = requestDownloadKey(url, targetSubfolder, filename, auth);
  let destKey: string | undefined;
  // The key jobs SERIALIZE on (#467 P1-C) — the physical destination, AUTH-FREE and
  // normalized for case-insensitive filesystems, so two different-auth (or
  // different-cased) requests to the same file run one-at-a-time and each callback
  // sees its own bytes. LOCAL: the resolved on-disk targetPath. REMOTE: a canonical
  // "remote:<subfolder>/<name>" — the Manager writes ONE server-side file per
  // (subfolder, name), so overlapping different-auth dispatches to it are serialized
  // too (the local callback race is inherently local, but this keeps the server
  // write single-writer and the last-started result deterministic).
  let serializeKey: string;
  if (!dispatchToManager) {
    const target = await resolveDownloadTarget(url, targetSubfolder, filename);
    // Fold auth into the destination key too (#467 P1-A): two concurrent calls to
    // the SAME on-disk destination with DIFFERENT auth are DIFFERENT downloads
    // (different representations) and must NOT dedup to one writer/one job.
    destKey = downloadJobIdFor(`${target.targetPath}\n${authIdentity(auth)}`);
    serializeKey = await localSerializeKey(target.targetPath);
  } else {
    serializeKey = remoteSerializeKey(url, targetSubfolder, filename);
  }
  // The PUBLIC id (download_status handle): the destination key when we have one
  // (so distinct destinations are separately pollable), else the request key.
  const id = destKey ?? reqKey;
  // This call's keys: the route-independent request key, plus the destination key
  // when locally resolvable (two-URLs-one-dest dedup).
  const lookupKeys = destKey ? [reqKey, destKey] : [reqKey];
  const trayId = downloadIdFor(url);

  // ADOPT ONLY AN IN-FLIGHT ENTRY (#420 codex round 3, rule 3): a FINISHED entry
  // under any key is treated as absent — it must never shadow a currently-downloading
  // writer reachable under another key, nor cause a retire that overwrites a live row.
  // Scan every key and prefer an in-flight match.
  let adopted: Entry | undefined;
  for (const k of lookupKeys) {
    const e = jobs.get(k);
    if (e && e.job.status === "downloading") {
      adopted = e;
      break;
    }
  }
  if (adopted) {
    // Re-index THIS call's keys onto the adopted entry (#420 codex round 3, rule 1):
    // when URL B adopts URL A's in-flight job by destination, B's request key must
    // now point at the same entry too — otherwise a later repeat of B (especially
    // after a local→Manager flip that drops the destination key) would miss it and
    // start a second writer onto one file. Entry-scoped, so it can't steal a live row.
    for (const k of lookupKeys) registerKey(adopted, k);
    logger.info(`Download already in flight, adopting it: ${adopted.job.id}`, {
      url,
      target_subfolder: targetSubfolder,
      filename,
    });
    return adopted;
  }

  // #529 double-writer guard: no in-flight job in THIS process, but ANOTHER session may
  // already be running this EXACT download (same public id) — e.g. a reconnect reissued
  // the same URL/destination. Adopt its persisted in-flight record instead of starting a
  // SECOND physical writer for one file. Only a FRESH in-flight record from a DIFFERENT
  // owner counts (the scan below filters stale via the heartbeat window; and a terminal
  // record — done/cancelled — is NOT "downloading", so a finished/failed prior download
  // correctly falls through to a fresh re-download). This
  // process's own live jobs were already checked above. The adopted view is READ-ONLY (we
  // hold no handle on the other session's writer): it is NOT registered in this registry,
  // runs no writer/heartbeat/AbortController, and its `settled` resolves immediately — the
  // tool then reports it as in-flight and the caller polls download_status (which reads
  // the live persisted record) for the resolved state.
  //
  // SCOPE: this dedup is BEST-EFFORT and covers the reported case — a SEQUENTIAL reconnect
  // that reissues after another session already published its record. It is a
  // filesystem-level read-then-start, NOT an atomic cross-process claim, so two DISTINCT
  // processes reissuing the SAME download at the SAME instant (both reading before either
  // publishes) can still both start writers. That is not a regression (it is the
  // pre-existing behavior the adoption improves for the common case) and is NON-CORRUPTING:
  // the #467 machinery materializes each writer through its OWN O_EXCL temp + atomic rename
  // (last-writer-wins on the destination only, never a shared cache inode) and validates
  // the payload (#473), so the only cost of that rare race is a duplicate download — never
  // a corrupt file. A full distributed lease is deliberately out of scope (its stale-claim
  // / crash-cleanup failure modes would be worse than a rare duplicate transfer).
  // Scan ROUTE-INDEPENDENTLY (#420): match a foreign fresh in-flight record by the public
  // `id` OR the route-independent request key `reqKey`, so a reconnect whose route flipped
  // local↔Manager (which changes the id from a destination hash to a request hash) still
  // finds the in-flight record instead of starting a second writer. Require the SAME source
  // URL (trayId): a foreign live download of a DIFFERENT url to the same dest+auth (same
  // id, different trayId) is a distinct logical download whose bytes may differ — adopting
  // it would report the WRONG job, so it is declined (we proceed with our own request). A
  // reqKey match already implies the same url (reqKey embeds it), so trayId is consistent.
  const nowForAdopt = Date.now();
  const foreign = listPersistedDownloadJobs().find(
    (rec) =>
      rec.owner !== PERSIST_OWNER &&
      rec.status === "downloading" &&
      nowForAdopt - (rec.updated ?? 0) < PERSISTED_INFLIGHT_STALE_MS &&
      rec.trayId === trayId &&
      (rec.id === id || (rec.req_key !== undefined && rec.req_key === reqKey)),
  );
  if (foreign) {
    logger.info(`Adopting a cross-session in-flight download (no second writer): ${foreign.id}`, {
      url,
      target_subfolder: targetSubfolder,
      filename,
    });
    return {
      job: jobFromPersisted(foreign),
      settled: Promise.resolve(),
      keys: [],
      controller: new AbortController(),
    };
  }

  // No in-flight match. Retire any superseded (done/error) entries shadowing our keys
  // — entry-scoped, so we only clear rows still pointing at that finished entry and
  // never delete a row now owned by a different, live writer (rule 2).
  const retired = new Set<Entry>();
  for (const k of lookupKeys) {
    const e = jobs.get(k);
    if (e && !retired.has(e)) {
      retireEntry(e);
      retired.add(e);
    }
  }

  const job: DownloadJob = {
    id,
    trayId,
    url,
    target_subfolder: targetSubfolder,
    filename,
    status: "downloading",
    started_at: Date.now(),
    destKey: serializeKey,
    reqKey,
    viaManager: dispatchToManager,
  };

  // Per-download abort handle (#515). The signal is threaded through downloadModel
  // into the fetch + stream pipeline, so cancel_download aborts exactly THIS job.
  const controller = new AbortController();

  // The liveness heartbeat timer (assigned below, after the settled closure). Hoisted
  // here so the settled closure's finally can clear it once the terminal state is durably
  // persisted. Runs async — assigned before it ever fires or the finally runs.
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  // Serialize behind any in-flight job writing the SAME destination (#467 P1-C) so
  // this job's download+materialize+onComplete run without a concurrent different-
  // auth writer swapping the destination out from under its callback.
  const priorSameDest = destChains.get(serializeKey);

  // The promise is stored, never left dangling — an unhandled rejection here
  // would take down the process on a simple 404.
  // The physical download reports its resume decision straight onto THIS job — no
  // shared keyed map, so it can never be misattributed to another job (#467).
  // Commit the DONE state. Invoked SYNCHRONOUSLY the instant the file is renamed into
  // its destination (via the onLanded callback below) — before any later await — so
  // there is NO window where the file exists at the destination yet the job still reads
  // "downloading" (which a cancel would otherwise flip to "cancelled"). Idempotent and
  // only advances a still-"downloading" job, so it never overrides a real terminal
  // state. Reads status as the full union to dodge the closure's "downloading" narrowing.
  const commitDone = (landedPath: string): void => {
    if ((job.status as DownloadJob["status"]) !== "downloading") return;
    job.path = landedPath;
    job.status = "done";
    job.finished_at = Date.now();
    persistJobRecord(job);
  };
  const settled = (async () => {
    // Wait for the prior same-destination job to fully finish (never fail THIS job
    // because that one errored — swallow its result).
    if (priorSameDest) await priorSameDest.catch(() => undefined);
    try {
      // A cancel that arrived before (or while waiting for) our turn makes downloadModel
      // throw at its up-front abort guard → the catch records the cancellation. So there
      // is no separate pre-start branch: the download either runs to a materialized file
      // (done) or is aborted before the file lands (cancelled).
      const path = await downloadModel(
        url,
        targetSubfolder,
        filename,
        auth,
        dispatchToManager,
        (d) => {
          job.resume = d;
        },
        controller.signal,
        (progressId) => {
          // Record the id the tray rows are ACTUALLY written under (post-auth/HF
          // rewrite) as job.progressId — WITHOUT touching job.trayId, which must stay
          // the stable original-URL hash so URL reconnect adoption (#529) still
          // resolves. download_status byte display and cancel cleanup key on
          // progressId (falling back to trayId); it only differs for query-auth /
          // mirror-rewritten URLs. Persist so a reconnecting session reads live bytes.
          if (progressId && progressId !== job.progressId) {
            job.progressId = progressId;
            persistJobRecord(job);
          }
        },
        // onLanded: fires the moment the local file is renamed into place → commit done
        // synchronously, closing the rename→return window.
        commitDone,
      );
      // Local paths already committed done via onLanded at the rename. The remote Manager
      // dispatch has no local rename, so commit done here when it returns (dispatch
      // accepted — the viaManager flag marks it as unverified in the tools). Idempotent.
      commitDone(path);
      if (onComplete) {
        // Post-processing must not turn a landed file into a failed download —
        // the bytes are on disk either way, and reporting "error" here would
        // reproduce the very bug this registry exists to fix.
        try {
          job.notes = await onComplete(path);
        } catch (err) {
          job.notes = [
            `(post-download step failed: ${err instanceof Error ? err.message : String(err)} — the file itself downloaded fine)`,
          ];
        }
      }
    } catch (err: unknown) {
      // If the file ALREADY landed (onLanded committed done) a later throw — e.g. an LRU
      // eviction hiccup after the rename — must NOT override a real completed download.
      if ((job.status as DownloadJob["status"]) === "done") {
        // keep done
      } else if (controller.signal.aborted) {
        // An abort that stopped the transfer BEFORE the file landed surfaces here as a
        // rejected fetch/pipeline (or a guard throw) — a clean cancellation, never an
        // "error" and never a false success.
        finalizeCancelled(job);
        // …but if the cancellation cleanup threw a recovery-critical ModelError (e.g. the
        // Windows backup of the PREVIOUS destination file could not be restored, so it's
        // preserved under a random .bak path), surface that message on the job so
        // download_status shows the recoverable path instead of masking it behind a plain
        // "cancelled, resumable partial". (Ordinary cancellation throws an AbortError,
        // which is NOT a ModelError, so it never sets this.)
        if (err instanceof ModelError) job.error = err.message;
      } else {
        job.status = "error";
        job.error = err instanceof Error ? err.message : String(err);
        job.finished_at = Date.now();
      }
    } finally {
      // Persist the terminal state so a reconnecting session sees the resolved
      // outcome (#529) instead of a forever-"downloading" record. If this atomic
      // replace transiently fails (rare), the heartbeat below KEEPS retrying until the
      // terminal state is durable — so a done/cancelled job can't linger as a
      // fresh-and-adoptable "downloading" record (beyond the stale reap that already
      // bounds it). Only once the terminal record is durable does the heartbeat stop.
      if (persistJobRecord(job) && heartbeat) clearInterval(heartbeat);
    }
  })();

  // Make THIS job the tail of its destination's serialization chain, and prune the
  // chain entry once it's the last one to settle (bounded map).
  destChains.set(serializeKey, settled);
  void settled.finally(() => {
    if (destChains.get(serializeKey) === settled) destChains.delete(serializeKey);
  });

  // Index under EVERY key (deduped) so any of them adopts this one writer. Uses the
  // entry-scoped registerKey guard so a fresh registration can never overwrite a row
  // still owned by a different, live writer (rule 3).
  const entry: Entry = { job, settled, keys: [], controller };
  for (const k of new Set(lookupKeys)) registerKey(entry, k);
  // Persist the (downloading) record so a session that reconnects while this is in
  // flight can still resolve/adopt it by id or URL/destination (#529).
  persistJobRecord(job);
  // Liveness heartbeat: while in flight, refresh the persisted record's `updated`
  // stamp so ANOTHER session can distinguish this LIVE download from a crashed one
  // (its heartbeat stops) when deciding whether to preserve a shared tray row. Cheap
  // (a small write every 15s, only under the panel where persistence is active) and
  // unref'd so it never keeps the process alive.
  // Only run the heartbeat when the persisted store is actually active (panel). Without a
  // channel dir there is nothing to persist and no reader to serve — an interval there
  // would just leak, retrying a no-op forever (persistJobRecord returns false, so the
  // terminal cleanup below would never clear it). Plain non-panel downloads install none.
  if (persistedRecordsEnabled()) {
    let terminalPersistAttempts = 0;
    heartbeat = setInterval(() => {
      // In-flight: refresh liveness so another session can tell this live download from a
      // crashed one. Terminal (only reached when the settled finally's terminal persist
      // transiently FAILED to atomically replace): keep retrying until it's durable, then
      // stop — so a done/cancelled job never lingers as a fresh, adoptable "downloading".
      const durable = persistJobRecord(job);
      if (job.status !== "downloading") {
        // Stop the interval once the terminal state is durable, OR the retry budget is
        // spent (by which point the stale record is already reaped), OR persistence went
        // inactive — never let a completed job's interval do filesystem work forever.
        if (
          (durable ||
            ++terminalPersistAttempts >= TERMINAL_PERSIST_MAX_ATTEMPTS ||
            !persistedRecordsEnabled()) &&
          heartbeat
        ) {
          clearInterval(heartbeat);
        }
      }
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
    entry.heartbeat = heartbeat;
  }
  return entry;
}

/** Mark a job cancelled: never a false-complete, and drop its tray row. The
 *  resumable .partial is deliberately LEFT on disk (a later download resumes it). */
function finalizeCancelled(job: DownloadJob): void {
  job.status = "cancelled";
  if (job.finished_at === undefined) job.finished_at = Date.now();
  // Remove the panel tray row so a cancelled download doesn't linger — but clear it
  // ONLY when this job exclusively owns that physical row. Two subtleties:
  //  - A job with no progressId never wrote a row (the writer reports progressId
  //    BEFORE the first row), so there is nothing to clear.
  //  - Same-URL siblings can SHARE one physical stream/row: a coalesced consumer (same
  //    URL+auth, different destination) or a serialized same-auth sibling observes the
  //    OWNER's progressId. Clearing it while ANOTHER in-flight job still uses it would
  //    wipe that active job's live display. So skip the clear when any other in-flight
  //    job shares this progressId; the last one out clears it. (trayId is deliberately
  //    NOT a fallback — it's the original-URL hash siblings share even more broadly.)
  if (!job.progressId) return;
  const sharedByLocal = [...new Set(jobs.values())].some(
    (e) =>
      e.job !== job && e.job.status === "downloading" && e.job.progressId === job.progressId,
  );
  // Also honor a live sibling in ANOTHER session (#529): a persisted in-flight record
  // written by a DIFFERENT session (owner ≠ this process's PERSIST_OWNER) that shares
  // this progressId is another session's active download of the same URL — its tray row
  // must not be wiped. Comparing by OWNER (not id) catches the case two sessions run the
  // SAME logical download (identical deterministic id): they persist distinct
  // owner-scoped files, so the other session's record is still seen here. This process's
  // OWN persisted records (same owner) are excluded — they always correspond to an
  // in-memory job already covered by the local scan above. If any live sibling exists in
  // either store, leave the row for the last one out (or the orchestrator's dead-writer
  // prune) to clear.
  const now = Date.now();
  const sharedByPersisted = listPersistedDownloadJobs().some(
    (rec) =>
      rec.owner !== PERSIST_OWNER &&
      rec.status === "downloading" &&
      rec.progressId === job.progressId &&
      // Only a FRESH record counts as a live sibling — a crashed session's heartbeat
      // stops, so its record goes stale and must NOT permanently suppress this sole
      // job's cleanup (its tray row would otherwise linger). Bounded by the heartbeat
      // interval so a genuinely-live foreign download is always seen as fresh.
      now - (rec.updated ?? 0) < PERSISTED_INFLIGHT_STALE_MS,
  );
  if (!sharedByLocal && !sharedByPersisted) clearDownloadProgress(job.progressId);
}

/** Persist a job record to the cross-session store (progress dir), redacting the
 *  URL. No-op outside the panel. Keeps the persisted copy in step with the job.
 *  Returns whether the record was DURABLY replaced (so the heartbeat can retry a
 *  transiently-failing terminal persist). */
function persistJobRecord(job: DownloadJob): boolean {
  return persistDownloadJob({
    id: job.id,
    trayId: job.trayId,
    progressId: job.progressId,
    url: job.url,
    target_subfolder: job.target_subfolder,
    filename: job.filename,
    status: job.status,
    path: job.path,
    error: job.error,
    started_at: job.started_at,
    finished_at: job.finished_at,
    notes: job.notes,
    dest_key: job.destKey,
    req_key: job.reqKey,
    via_manager: job.viaManager,
    resume: job.resume,
  });
}

/** Rebuild an in-memory DownloadJob view from a persisted record (#529 adoption
 *  after a reconnect). It is a read-only snapshot — there is no live AbortController
 *  in THIS process for a job another/previous session started, so it can be polled
 *  by download_status but not cancelled from here. */
function jobFromPersisted(rec: PersistedDownloadJob): DownloadJob {
  return {
    id: rec.id,
    trayId: rec.trayId,
    progressId: rec.progressId,
    url: rec.url,
    target_subfolder: rec.target_subfolder,
    filename: rec.filename,
    status: rec.status,
    path: rec.path,
    error: rec.error,
    started_at: rec.started_at,
    finished_at: rec.finished_at,
    notes: rec.notes,
    destKey: rec.dest_key,
    reqKey: rec.req_key,
    viaManager: rec.via_manager,
    resume: rec.resume as ResumeDiagnostic | undefined,
  };
}

/** True when a FRESH foreign in-flight persisted record shares `id` but carries a
 *  DIFFERENT trayId — a distinct concurrent physical download in ANOTHER session (two
 *  distinct URLs resolving to the same dest+auth). The id alone can't disambiguate, so
 *  a by-id lookup/cancel must decline rather than silently act on the local one.
 *  Excludes this process's own records (same owner) and stale/dead ones (heartbeat). */
function hasAmbiguousForeignSibling(id: string, localTrayId: string): boolean {
  const now = Date.now();
  return listPersistedDownloadJobs().some(
    (rec) =>
      rec.id === id &&
      rec.trayId !== localTrayId &&
      rec.owner !== PERSIST_OWNER &&
      rec.status === "downloading" &&
      now - (rec.updated ?? 0) < PERSISTED_INFLIGHT_STALE_MS,
  );
}

export function getDownloadJob(id: string): DownloadJob | undefined {
  // The registry indexes each job under its request key and (when local) its
  // destination key; the public id is one of those, so a direct get resolves it.
  const live = jobs.get(id)?.job;
  // A LIVE in-flight job in THIS process is authoritative (it's actively writing here) —
  // but decline if a concurrent live FOREIGN session shares the id with a different trayId.
  if (live && live.status === "downloading") {
    if (hasAmbiguousForeignSibling(id, live.trayId)) return undefined;
    return live;
  }
  // Otherwise resolve across this session's TERMINAL in-memory record AND the persisted
  // store (#529), honoring the INTEGRITY TRUTH: a validated DONE (file landed) — from
  // ANY session, in-memory or persisted — must WIN over a cancelled/error record for the
  // same id. A cancel/error never lands a file, so it must never mask another session's
  // validated-complete file (cancelled-over-complete), and this holds whether the
  // cancelled/error record is in-memory or persisted.
  if (live && live.status === "done") return live;
  const now = Date.now();
  const matches = listPersistedDownloadJobs().filter((r) => r.id === id);
  const persistedDone = matches
    .filter((r) => r.status === "done")
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0];
  if (persistedDone) return jobFromPersisted(persistedDone);
  // No DONE anywhere. Prefer a fresh live foreign in-flight download (it's still running
  // elsewhere) — declining if ambiguous by trayId — then this session's own terminal
  // record, then the newest persisted terminal.
  const foreignLive = matches.filter(
    (r) => r.status === "downloading" && now - (r.updated ?? 0) < PERSISTED_INFLIGHT_STALE_MS,
  );
  if (foreignLive.length > 0) {
    if (new Set(foreignLive.map((r) => r.trayId)).size > 1) return undefined; // ambiguous live
    return jobFromPersisted(foreignLive.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0]);
  }
  if (live) return live; // this session's terminal (cancelled/error), no DONE to prefer
  const terminal = matches.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0];
  return terminal ? jobFromPersisted(terminal) : undefined;
}

/** Adopt an in-flight download by URL or destination after a reconnect (#529) —
 *  so a caller can confirm a download is still running (and not start a duplicate)
 *  even without the id. Prefers a LIVE in-memory job, then the persisted store.
 *
 *  URL matching is EXACT (query included): in-memory by raw url, persisted by the
 *  trayId hash of the full url — so two distinct signed/versioned URLs are never
 *  conflated (the persisted url is credential-redacted and can't be compared safely). */
export function findDownloadJob(query: { url?: string; destKey?: string }): DownloadJob | undefined {
  const trayId = query.url ? downloadIdFor(query.url) : undefined;
  const destKey = query.destKey;
  if (!trayId && !destKey) return undefined;

  // Gather candidate IN-FLIGHT jobs from BOTH this process's registry AND the cross-
  // session persisted store, deduped by id (a live in-memory copy wins over its
  // persisted snapshot). The ambiguity guard must span BOTH stores: one session's live
  // job for URL→destA plus another session's persisted in-flight job for URL→destB are
  // two DISTINCT jobs for the same URL, and adopting either by URL alone would be a
  // guess — so decline (the caller must use the exact id).
  // Key candidates by (id, trayId): two distinct URLs to one dest+auth share an id but
  // differ in trayId (distinct physical downloads), so id alone would wrongly collapse
  // them and mask the ambiguity. A live in-memory copy wins over its persisted snapshot
  // (same id+trayId key).
  const keyOf = (id: string, tray: string): string => `${id}\n${tray}`;
  const now = Date.now();
  const inflightByKey = new Map<string, DownloadJob>();
  for (const e of new Set(jobs.values())) {
    if (e.job.status !== "downloading") continue;
    if ((query.url && e.job.url === query.url) || (destKey && e.job.destKey === destKey)) {
      inflightByKey.set(keyOf(e.job.id, e.job.trayId), e.job);
    }
  }
  for (const rec of listPersistedDownloadJobs()) {
    // Only FRESH in-flight records count as live candidates — a stale/dead record
    // (crashed session, never reaped) must not inflate the ambiguity count and force a
    // false "no download" (matching the persisted helpers' fresh-in-flight rule).
    if (rec.status !== "downloading" || now - (rec.updated ?? 0) >= PERSISTED_INFLIGHT_STALE_MS) {
      continue;
    }
    const key = keyOf(rec.id, rec.trayId);
    if (inflightByKey.has(key)) continue;
    if ((trayId && rec.trayId === trayId) || (destKey && rec.dest_key === destKey)) {
      inflightByKey.set(key, jobFromPersisted(rec));
    }
  }
  if (inflightByKey.size > 1) return undefined; // ambiguous across both stores
  if (inflightByKey.size === 1) return [...inflightByKey.values()][0];

  // No in-flight match anywhere — fall back to a single unambiguous SETTLED persisted
  // record (for status reporting); findPersistedDownloadJob declines if ambiguous.
  const persisted = findPersistedDownloadJob({ trayId, destKey });
  return persisted ? jobFromPersisted(persisted) : undefined;
}

export function listDownloadJobs(): DownloadJob[] {
  // One Entry is indexed under multiple keys — dedup by identity so a job appears once
  // regardless of how many keys point at it. Identity is (id, trayId), NOT id alone:
  // two distinct URLs to one dest+auth share an id but are distinct physical downloads
  // (different trayId), and both must be listed — download_status with no selector
  // promises EVERY tracked download.
  const seen = new Set<Entry>();
  const keyOf = (j: DownloadJob): string => `${j.id}\n${j.trayId}`;
  const byKey = new Map<string, DownloadJob>();
  for (const e of jobs.values()) {
    if (seen.has(e)) continue;
    seen.add(e);
    const cur = byKey.get(keyOf(e.job));
    // Among this process's own entries for one key (rare), prefer a DONE.
    if (!cur || (e.job.status === "done" && cur.status !== "done")) byKey.set(keyOf(e.job), e.job);
  }
  // #529: fold in persisted records for jobs THIS session's registry doesn't hold
  // (started before a reconnect), so download_status still lists in-flight downloads.
  // INTEGRITY TRUTH: a validated DONE (file landed) WINS over a cancelled/error record for
  // the SAME (id, trayId) — whether that other record is a persisted counterpart OR this
  // session's own in-memory cancelled/error. So a persisted DONE overrides any current
  // entry that is neither DONE nor a LIVE in-memory download (which stays visible as the
  // user's active action). The list never shows a cancelled in place of a validated file.
  for (const rec of listPersistedDownloadJobs()) {
    const job = jobFromPersisted(rec);
    const k = keyOf(job);
    const cur = byKey.get(k);
    if (!cur) {
      byKey.set(k, job);
    } else if (job.status === "done" && cur.status !== "done" && cur.status !== "downloading") {
      byKey.set(k, job);
    }
  }
  return [...byKey.values()].sort((a, b) => b.started_at - a.started_at);
}

/**
 * Cancel an in-flight download by id (#515): abort its stream and mark it
 * cancelled. The abort unwinds the fetch + pipeline; the .partial is left on disk
 * (resumable) and NEVER renamed to the destination, so nothing is reported as
 * complete. Idempotent — cancelling an already-settled job just reports its state.
 * Returns the resulting status plus whether this call performed the abort.
 *
 * Only a download owned by THIS process can be aborted (its AbortController lives
 * here). A job resolvable only via the persisted store (started by another/previous
 * session after a reconnect) cannot be aborted from here — reported as not-owned.
 */
export function cancelDownloadJob(id: string): {
  found: boolean;
  owned: boolean;
  aborted: boolean;
  /** The id denotes MORE than one concurrent physical download (a live foreign
   *  session shares it with a different trayId) — declined, nothing was aborted. */
  ambiguous?: boolean;
  status?: DownloadJob["status"];
  job?: DownloadJob;
} {
  const entry = jobs.get(id);
  if (entry) {
    const { job, controller } = entry;
    // Cross-session ambiguity: a live foreign download shares this id with a DIFFERENT
    // trayId. Aborting by id could act on the wrong logical download — decline so a
    // cancel-by-id can never hit an unintended concurrent download (a #515 invariant).
    if (job.status === "downloading" && hasAmbiguousForeignSibling(id, job.trayId)) {
      return { found: true, owned: true, aborted: false, ambiguous: true, status: job.status, job };
    }
    if (job.status !== "downloading") {
      // Already settled (done/error/cancelled) — idempotent no-op.
      return { found: true, owned: true, aborted: false, status: job.status, job };
    }
    // Request the abort ONLY — do NOT set a synchronous terminal state here. The FINAL
    // state is decided by the settled closure based on what actually happened on disk:
    //   - the file already landed (its destination rename completed, so onLanded →
    //     commitDone marks it DONE) — a validated complete file must never read
    //     "cancelled"; OR
    //   - the transfer was stopped before the file landed (downloadModel THROWS via the
    //     stream abort / pre-materialize / pre-rename guards → the catch marks it
    //     CANCELLED and cleans up the tray row + resumable partial).
    // Setting "cancelled" synchronously here would LOSE the race where a rename has
    // physically completed but its promise continuation (→ onLanded) hasn't run yet:
    // commitDone only advances a still-"downloading" job, so a synchronous "cancelled"
    // would strand a landed file as cancelled (#515 codex). The tool reports this as a
    // best-effort request and points the caller at download_status for the resolved state.
    if (!controller.signal.aborted) controller.abort();
    return { found: true, owned: true, aborted: true, status: "downloading", job };
  }
  // Not in THIS process's registry. It may still exist in the persisted store
  // (another/previous session owns the AbortController), which we can't abort here.
  const persisted = readPersistedDownloadJob(id);
  if (persisted) {
    return {
      found: true,
      owned: false,
      aborted: false,
      status: persisted.status,
      job: jobFromPersisted(persisted),
    };
  }
  return { found: false, owned: false, aborted: false };
}

/** Test seam — the registry is process-global otherwise. */
export function resetDownloadJobs(): void {
  for (const e of new Set(jobs.values())) {
    if (e.heartbeat) clearInterval(e.heartbeat);
  }
  jobs.clear();
  destChains.clear();
}

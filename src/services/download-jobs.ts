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
 * `enqueue_workflow` + polling job status (`queue` action:"status").
 */

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  downloadModel,
  liveListingHasEntry,
  resolveDownloadTarget,
  shouldDispatchDownloadToManager,
  verifyLandedModel,
} from "./model-resolver.js";
import type { DownloadAuth } from "./download-auth.js";
import type { ResumeDiagnostic } from "./download-resume-diag.js";
import { ModelError } from "../utils/errors.js";
import {
  persistDownloadJob,
  readPersistedDownloadJob,
  listPersistedDownloadJobs,
  findPersistedDownloadJob,
  removePersistedDownloadJobFor,
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
   *  (download_model action:"status"(id) resolves each independently). Also the registry key. */
  id: string;
  /** The panel tray / progress-file id — a hash of the ORIGINAL source URL only.
   *  STABLE for the life of the job and used to ADOPT this download by URL after a
   *  reconnect (#529): findDownloadJob({url}) hashes the same original URL. Kept
   *  separate from `id` so distinct-destination jobs still map to their URL. */
  trayId: string;
  /** The id the PHYSICAL progress rows are actually written under — a hash of the
   *  POST-auth/post-HF-rewrite request URL, reported by the writer (#515). Differs
   *  from `trayId` only for query-auth or HF_ENDPOINT-rewritten URLs; equals it for
   *  the common case. download_model action:"status" byte display and cancel cleanup key on THIS id
   *  (falling back to trayId when unset). Never used for URL adoption (that needs the
   *  stable original-URL trayId). */
  progressId?: string;
  /** This job's OWN resume decision (#467), reported by its physical download via
   *  a callback and stored here — so download_model action:"status" surfaces exactly this job's
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
   *  download_model action:"status" renders it as "dispatched (not verified here)" so it isn't
   *  mistaken for a validated local completion. */
  viaManager?: boolean;
  /** Lines produced by post-download work (trigger words, sidecar paths,
   *  not-a-model warnings). These used to be returned inline by the tool; once a
   *  download outlives its tool call they have to survive somewhere the agent
   *  can still read them, or handing back a handle would silently drop them. */
  notes?: string[];
  /**
   * Post-landing verification against the LIVE server (#369). A local download is
   * only honestly "done" if the bytes are on disk AND the connected ComfyUI reads
   * from where they landed — reporting the INTENDED path is what let a 4.88 GB
   * model be announced as a success from a stale install the server never read.
   *
   * "visible"     = the server lists the file — the ONLY value that licenses the
   *                 word "successfully".
   * "not-visible" = it does not (the file exists but is unusable there).
   * "unknown"     = the check ran and could not conclude.
   * "pending"     = the file has landed but the check has not finished yet. Set
   *                 SYNCHRONOUSLY with `done`, so there is no window in which a
   *                 renderer sees a completed job with no verification field and
   *                 mistakes that for success (codex gate, round 1).
   * undefined     = a pre-fix persisted record, or a Manager dispatch. Treated
   *                 exactly like "pending" by every renderer: unconfirmed.
   */
  live_visible?: "visible" | "not-visible" | "unknown" | "pending";
  /** Why, for anything other than a plain "visible". Surfaced verbatim. */
  verify_note?: string;
  /** The live models root the placement verdict was made against. When the
   *  CONNECTED server later reads a DIFFERENT root, the verdict is STALE and must
   *  not be re-asserted as current success (codex gate, round 11). */
  verified_root?: string;
  /** Was the file CONFIRMED present on disk by the post-landing check? False when
   *  the stat failed (deleted or unreadable between the rename and the check), in
   *  which case no renderer may claim "verified on disk" for `job.path`. */
  disk_verified?: boolean;
  /** A persisted in-flight record missed its owner heartbeat. It stays visible
   *  because this is not proof the physical transfer stopped (#761). */
  staleInflight?: boolean;
  /** Age of the missing persisted heartbeat, used only for status diagnostics. */
  staleForMs?: number;
  /** This "cancelled" record was written by a LATER session reclaiming a stale
   *  in-flight record whose writer was PROVEN dead (#858) — no live transfer was
   *  aborted, so no renderer may claim a resumable partial was deliberately left. */
  reclaimedDead?: boolean;
  /** #1148 — this terminal record was carried forward from a dead orchestrator's
   *  channel dir. The transfer stopped because its PROCESS exited, not because the
   *  server or URL failed. */
  interruptedByRestart?: boolean;
}

interface Entry {
  job: DownloadJob;
  settled: Promise<void>;
  /** Every registry key this entry is indexed under (request key, and the
   *  destination key when locally resolvable). Kept so a superseding job can
   *  unregister ALL of a stale entry's keys — no orphaned index rows. */
  keys: string[];
  /** Per-download abort handle (#515). Its `signal` is threaded through
   *  downloadModel → the fetch + stream pipeline, so `download_model action:"cancel"` can abort
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
/** Cap on heartbeat retries of a transiently-failing TERMINAL persist. Once this
 *  bounded retry window ends the completed job stops touching the filesystem; its
 *  last in-flight snapshot remains non-adoptable after the freshness window and is
 *  reaped only by the long persisted-record retention bound (#761). */
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
 * destinations are separately pollable via download_model action:"status".
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
  /** Did the live server ALREADY list this exact entry before we started? Captured
   *  HERE, before any bytes are written, so the post-landing check can tell "the
   *  server sees it BECAUSE we wrote it" from "it already knew that name" (#369). */
  let listedBefore: boolean | undefined;
  if (!dispatchToManager) {
    const target = await resolveDownloadTarget(url, targetSubfolder, filename);
    try {
      listedBefore = await liveListingHasEntry(targetSubfolder, target.filename);
    } catch {
      listedBefore = undefined; // unknowable → the check stays conservative
    }
    // Fold auth into the destination key too (#467 P1-A): two concurrent calls to
    // the SAME on-disk destination with DIFFERENT auth are DIFFERENT downloads
    // (different representations) and must NOT dedup to one writer/one job.
    destKey = downloadJobIdFor(`${target.targetPath}\n${authIdentity(auth)}`);
    serializeKey = await localSerializeKey(target.targetPath);
  } else {
    serializeKey = remoteSerializeKey(url, targetSubfolder, filename);
  }
  // The PUBLIC id (download_model action:"status" handle): the destination key when we have one
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
  // tool then reports it as in-flight and the caller polls download_model action:"status" (which reads
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
      (rec.id === id || (rec.req_key !== undefined && rec.req_key === reqKey)) &&
      // A FRESH HEARTBEAT IS NOT A LIVE WRITER. The heartbeat is written every
      // 15s and only goes stale after 60, so a process that died a moment ago
      // leaves a record that still looks current for up to a minute. Adopting it
      // hands the caller a job nobody is running: the tool reports "in flight"
      // and the poll never settles, which is worse than starting a second
      // writer — the outcome adoption exists to avoid — because nothing
      // downloads at all.
      //
      // PROVEN gone only (ESRCH). `undefined` means the probe could not tell —
      // no pid on a pre-#858 record, or the probe itself failed — and refusing
      // to adopt on that would treat "could not determine" as "dead", which is
      // this codebase's own recurring defect (#796) pointed the other way: it
      // would start a SECOND writer for a download that is genuinely running.
      writerProcessGone(rec) !== true,
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
  // into the fetch + stream pipeline, so download_model action:"cancel" aborts exactly THIS job.
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
    // A LOCAL landing is not yet a verified placement. Mark it PENDING in the SAME
    // synchronous step that publishes "done" (and in the same persisted record), so
    // no reader — this session's tool call inside its grace window, or another
    // session reading the record — can ever see a completed local download with no
    // verification field and render it as confirmed success (#369, codex gate).
    if (!dispatchToManager) job.live_visible = "pending";
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
          // resolves. download_model action:"status" byte display and cancel cleanup key on
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
      // VERIFY, don't assume (#369). A LOCAL download is reported with the path we
      // confirmed on disk, plus whether the connected ComfyUI actually reads from
      // there. This runs INSIDE `settled`, so a small download that finishes within
      // download_model's grace window is already verified when the tool answers.
      // Never allowed to demote a completed download: verifyLandedModel never throws
      // and the catch below keeps `done`.
      if (!dispatchToManager && (job.status as DownloadJob["status"]) === "done") {
        try {
          const verdict = await verifyLandedModel(path, targetSubfolder, { listedBefore });
          if (verdict.verifiedPath) job.path = verdict.verifiedPath;
          job.verified_root = verdict.verifiedAgainstRoot;
          // No verifiedPath means the on-disk stat did NOT succeed — the file was
          // removed or became unreadable between the rename and this check. Record
          // that so no renderer claims "verified on disk" for the retained path.
          job.disk_verified = !!verdict.verifiedPath;
          job.live_visible = verdict.liveVisible;
          job.verify_note = verdict.note;
        } catch (err) {
          // Verification is a REPORT, never a gate: the bytes are on disk either
          // way. Record that we could not confirm placement and carry on to the
          // post-download hook — swallowing this must not skip onComplete. The
          // on-disk check did not complete either, so nothing may claim it did.
          job.disk_verified = false;
          job.live_visible = "unknown";
          job.verify_note = `Placement could not be verified: ${err instanceof Error ? err.message : String(err)}`;
        }
        persistJobRecord(job);
      }
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
        // download_model action:"status" shows the recoverable path instead of masking it behind a plain
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
      // fresh-and-adoptable "downloading" record. The freshness window excludes it from
      // adoption immediately; long retention later bounds the persisted record. Only once
      // the terminal record is durable does the heartbeat stop.
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
        // spent (after which the snapshot is non-adoptable), OR persistence went inactive
        // — never let a completed job's interval do filesystem work forever.
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
    live_visible: job.live_visible,
    verify_note: job.verify_note,
    disk_verified: job.disk_verified,
    verified_root: job.verified_root,
    reclaimed_dead: job.reclaimedDead,
  });
}

/** Rebuild an in-memory DownloadJob view from a persisted record (#529 adoption
 *  after a reconnect). It is a read-only snapshot — there is no live AbortController
 *  in THIS process for a job another/previous session started, so it can be polled
 *  by download_model action:"status" but not cancelled from here. */
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
    live_visible: rec.live_visible,
    verify_note: rec.verify_note,
    disk_verified: rec.disk_verified,
    verified_root: rec.verified_root,
    staleInflight: rec.staleInflight,
    staleForMs: rec.staleForMs,
    reclaimedDead: rec.reclaimed_dead,
    interruptedByRestart: rec.interrupted_by_restart,
  };
}

/** True when a FRESH foreign in-flight persisted record shares `id` but carries a
 *  DIFFERENT trayId — a distinct concurrent physical download in ANOTHER session (two
 *  distinct URLs resolving to the same dest+auth). The id alone can't disambiguate, so
 *  a by-id lookup/cancel must decline rather than silently act on the local one.
 *  Excludes this process's own records (same owner) and heartbeat-stale ones. */
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

/**
 * What we ACTUALLY know about where a completed download landed (#369).
 *
 * This is THE single placement policy — every tool that renders a finished job
 * (`download_model`, `download_model action:"status"`, `download_model action:"download_civitai"`, `apply_manifest`)
 * must go through it, or the wording drifts and one of them starts claiming a
 * success nobody verified. That is precisely how a 4.88 GB model in a stale install
 * came back as "downloaded successfully".
 *
 * `confirmed` is true for EXACTLY ONE state: the connected ComfyUI listed the file.
 * A Manager dispatch, a still-pending check, an inconclusive check, and a pre-fix
 * persisted record are all UNCONFIRMED — never successes.
 */
export interface PlacementReport {
  /** True only when the running ComfyUI actually listed the landed file. */
  confirmed: boolean;
  /** True when the file exists on disk but the live server will NOT read it. */
  wrongPlace: boolean;
  /** How to introduce the path. "landed at" is reserved for a CONFIRMED placement —
   *  an unverified state must not borrow the settled-sounding phrase (codex gate). */
  pathLabel: string;
  /** Parenthetical for the path line, e.g. "(verified on disk, and the connected …)". */
  pathQualifier: string;
  /** The explanatory line to surface when `confirmed` is false. */
  warning?: string;
}

/** " (verified on disk)" only when the post-landing stat actually succeeded. A job
 *  whose file vanished between the rename and the check keeps its path but must not
 *  carry a disk-verification claim (codex gate, round 9). */
/** Do two absolute root paths name the same directory? Windows paths are
 *  case-insensitive and mix separators, so `C:\ComfyUI\models` and
 *  `c:/comfyui/models` are the SAME install — comparing them raw produced a false
 *  "a DIFFERENT install" downgrade of a correct verdict (codex gate, round 17). */
function sameRoot(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (s: string): string => {
    const slashed = s.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  return norm(a) === norm(b);
}

function diskQualifier(job: DownloadJob): string {
  return job.disk_verified === false ? " (NOT found on disk when checked)" : " (verified on disk)";
}

export function describePlacement(
  job: DownloadJob,
  /** The models root the CONNECTED server reads right now (currentLiveModelsRoot()).
   *  A stored `visible` verdict may ONLY be re-asserted when this is present and
   *  names the same root the verdict was made against — see below. */
  ctx?: { liveModelsDir?: string },
): PlacementReport {
  if (
    !job.viaManager &&
    job.live_visible === "visible" &&
    !sameRoot(ctx?.liveModelsDir, job.verified_root)
  ) {
    // A CONFIRMED rendering requires the READER to have re-established the verdict,
    // so every way of failing to do that lands here (codex gate, rounds 11, 16, 18):
    //  - the verdict names a DIFFERENT root than the server now reads;
    //  - the verdict carries NO root (made against a destination only local
    //    configuration could vouch for);
    //  - and — the inversion this closes — there is NO current observation at all,
    //    because the probe transiently failed or resolved non-authoritatively.
    // That last case previously fell through to "confirmed", reading a MISSING
    // observation as "no contradiction". It is not: nothing verified that the server
    // answering NOW can read this file. Absence of evidence renders as unverified.
    return {
      confirmed: false,
      wrongPlace: false,
      pathLabel: "written to",
      pathQualifier: diskQualifier(job),
      warning: !ctx?.liveModelsDir
        ? "this download was confirmed earlier, but the connected ComfyUI could not be asked " +
          "just now which models directory it reads, so that confirmation cannot be re-established " +
          "for the server you are connected to. Re-check with download_model action:\"status\", or confirm with " +
          "list_local_models."
        : job.verified_root
        ? `this download was verified against a ComfyUI reading "${job.verified_root}", but the ` +
          `connected server now reads "${ctx.liveModelsDir}" — a DIFFERENT install. The earlier ` +
          "confirmation does not apply to it; check list_local_models against the server you are " +
          "connected to now."
        : "this download's placement was confirmed against a models directory that could only be " +
          `inferred from local configuration, and the connected server now reports "${ctx.liveModelsDir}" ` +
          "as the directory it reads. The earlier confirmation cannot be re-asserted for it; " +
          "check list_local_models against the server you are connected to now.",
    };
  }
  if (job.viaManager) {
    return {
      confirmed: false,
      wrongPlace: false,
      pathLabel: "requested destination",
      pathQualifier: "",
      warning:
        "the dispatch was ACCEPTED, NOT verified as landed — ComfyUI-Manager reports its queue " +
        "task 'done' even on failure, so this does not guarantee the file is present. Confirm " +
        "with list_local_models before relying on it.",
    };
  }
  switch (job.live_visible) {
    case "visible":
      return {
        confirmed: true,
        wrongPlace: false,
        pathLabel: "landed at",
        pathQualifier: " (verified on disk, and the connected ComfyUI lists it)",
      };
    case "not-visible":
      return {
        confirmed: false,
        wrongPlace: true,
        pathLabel: "written to",
        pathQualifier: diskQualifier(job),
        warning:
          `NOT VISIBLE to the connected ComfyUI — ${job.verify_note ?? "the running server does not list this file."}`,
      };
    case "unknown":
      return {
        confirmed: false,
        wrongPlace: false,
        pathLabel: "written to",
        pathQualifier: diskQualifier(job),
        warning:
          `visibility to the connected ComfyUI is UNCONFIRMED${job.verify_note ? ` — ${job.verify_note}` : ""}. Check list_local_models before relying on it.`,
      };
    default:
      // "pending" and undefined (pre-fix record) alike: the file landed, the check
      // has not concluded. Never rendered as a confirmed success.
      return {
        confirmed: false,
        wrongPlace: false,
        pathLabel: "written to",
        pathQualifier: "",
        warning:
          "the file was materialized locally, but placement has NOT been confirmed yet — the " +
          "check against the connected ComfyUI has not completed. Re-check with download_model action:\"status\", " +
          "or confirm with list_local_models.",
      };
  }
}

/**
 * Every DISTINCT tracked download that answers to `id`, across this process's
 * registry AND the persisted store, deduped by the TRUE composite identity
 * (id, trayId) — the same key `listDownloadJobs`/`findDownloadJob` already use.
 *
 * `id` is derived from destination+auth, so two different SOURCE URLs landing on
 * one file deliberately share it (#467 P1-A dedup). That makes `id` a
 * DESTINATION handle, not a job handle — and #822 is the consequence: an
 * identifier that can name two rows cannot select either. This function is what
 * lets every id-keyed operation SAY SO — listing the candidates a caller must
 * choose between — instead of silently acting on one or reporting "not found".
 *
 * Newest-started first, so a caller printing candidates leads with the live one.
 */
export function listDownloadJobCandidates(id: string): DownloadJob[] {
  const keyOf = (j: DownloadJob): string => `${j.id}\n${j.trayId}`;
  const byKey = new Map<string, DownloadJob>();
  for (const e of new Set(jobs.values())) {
    if (e.job.id !== id) continue;
    const cur = byKey.get(keyOf(e.job));
    if (!cur || (e.job.status === "done" && cur.status !== "done")) byKey.set(keyOf(e.job), e.job);
  }
  // `trayId` is a hash of the URL, so it does NOT separate sessions: this
  // session's SETTLED record for a URL and ANOTHER session's still-running
  // download of the same URL to the same destination collapse to one key. Which
  // one is reported matters — showing the local "cancelled" row while a foreign
  // transfer is live would hide a running download behind a stale verdict, and
  // that is worse than the ambiguity this function exists to surface.
  const now = Date.now();
  const isLive = (r: PersistedDownloadJob): boolean =>
    r.status === "downloading" && now - (r.updated ?? 0) < PERSISTED_INFLIGHT_STALE_MS;
  for (const rec of listPersistedDownloadJobs()) {
    if (rec.id !== id) continue;
    const job = jobFromPersisted(rec);
    const k = keyOf(job);
    const cur = byKey.get(k);
    if (!cur) {
      byKey.set(k, job);
      continue;
    }
    // Precedence, most authoritative first:
    //  1. a validated DONE — the file landed, and no later verdict undoes that;
    //  2. a LIVE transfer — still happening, so it is what the caller needs to know;
    //  3. anything settled.
    // (A live IN-MEMORY job is this process's own and already sits in `byKey`, so
    // it is never displaced by a merely-settled persisted record.)
    if (job.status === "done" && cur.status !== "done" && cur.status !== "downloading") {
      byKey.set(k, job);
    } else if (isLive(rec) && cur.status !== "done" && cur.status !== "downloading") {
      byKey.set(k, job);
    }
  }
  // #1208 — a DETERMINISTIC tiebreak. started_at is a millisecond timestamp, so
  // two jobs begun in the same millisecond compared equal and the order fell back
  // to Map insertion order: stable locally, evidently not on a loaded CI runner.
  // "lists newest first" failed on all THREE platforms at once and went green on
  // an unchanged re-run — and a flake that fails everywhere simultaneously reads
  // like a regression, which is what it costs to rule out.
  //
  // trayId is the right tiebreak: it is unique per physical download (two URLs
  // sharing an id differ there), so equal timestamps order identically on every
  // run and in every process.
  return [...byKey.values()].sort(
    (a, b) => b.started_at - a.started_at || compareTrayIds(a.trayId, b.trayId),
  );
}

/**
 * Resolve ONE download.
 *
 * `trayId` is the DISAMBIGUATOR (#822): with it the lookup keys on the full
 * composite identity (id, trayId) and can always name exactly one row. Without
 * it, an id that denotes more than one download still resolves to nothing —
 * but callers can now distinguish that from "no such download" by asking
 * {@link listDownloadJobCandidates}, which is the difference between an
 * actionable "say which one" and a false "it never existed".
 */
export function getDownloadJob(id: string, trayId?: string): DownloadJob | undefined {
  if (trayId) {
    return listDownloadJobCandidates(id).find((j) => j.trayId === trayId);
  }
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

/**
 * Why a by-id lookup came back empty — when the answer is NOT "it is gone" (#1183).
 *
 * A reporter polled a live 26.5GB local download for ~30 minutes (20% → 95%) and
 * then got, for ONE poll:
 *
 *   No download matching id `cb43b8c206bec9b1`. It has either finished long ago
 *   … or never started
 *
 * The file existed nowhere on disk and nothing had been cancelled. Re-issuing the
 * same URL immediately re-adopted the SAME id at 97% — the job was alive in
 * process the entire time.
 *
 * getDownloadJob DECLINES in several places rather than guessing, and those
 * declines are correct: two concurrent physical transfers sharing an id must not
 * be resolved by picking one. What is not correct is rendering a decline as an
 * ABSENCE. "I will not choose between two" and "there is nothing here" are
 * different facts, and only the second justifies telling a user their download
 * vanished — which is what invites a redundant multi-gigabyte re-download.
 *
 * So: when the lookup misses, ask the cheaper question it never asked — is there
 * a LIVE record for this id at all? Returns undefined when there genuinely is
 * not, so a real "not found" keeps its existing wording.
 */
export function describeUnresolvedDownload(id: string): string | undefined {
  const now = Date.now();
  const liveInMemory = jobs.get(id)?.job;
  const inFlight = listPersistedDownloadJobs().filter(
    (r) => r.id === id && r.status === "downloading",
  );
  const livePersisted = inFlight.filter(
    (r) => now - (r.updated ?? 0) < PERSISTED_INFLIGHT_STALE_MS,
  );
  // A STALE in-flight record counts here, hedged — and getting that wrong is
  // what would have left the REPORTED case uncovered.
  //
  // This function first used the same freshness window the lookup uses, which
  // means it went silent in exactly the situation most likely to have produced a
  // one-poll miss during a 26GB transfer: a heartbeat delayed past 60s while the
  // writer was busy. The codebase already states the right rule one file over
  // (#761): "a missed heartbeat is only a liveness hint, not proof the transfer
  // stopped" — which is why an in-flight record is retained for 6h rather than
  // reaped at 60s. Declining to mention such a record would repeat the very fold
  // this fix exists to remove, one level down.
  const stalePersisted = inFlight.filter(
    (r) => now - (r.updated ?? 0) >= PERSISTED_INFLIGHT_STALE_MS,
  );
  const inMemoryLive = liveInMemory?.status === "downloading";
  if (!inMemoryLive && livePersisted.length === 0 && stalePersisted.length === 0) {
    return undefined;
  }

  // Only a stale record to go on: say what is known and what is not, rather than
  // asserting either "running" or "gone".
  if (!inMemoryLive && livePersisted.length === 0) {
    const newest = stalePersisted.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0];
    const ageS = Math.round((now - (newest?.updated ?? now)) / 1000);
    return (
      `A download with id \`${id}\` has an IN-FLIGHT record that stopped reporting ` +
      `${ageS}s ago — this lookup declined to answer for it, which is NOT the same as it ` +
      `being gone. A missed heartbeat is a liveness HINT, not proof the transfer stopped: ` +
      `the bytes may still be streaming while persistence was interrupted (a reconnect, or ` +
      `a busy writer). Check the panel download tray, or re-run with no selector to list ` +
      `every tracked download, BEFORE re-downloading — a second transfer would duplicate ` +
      `a multi-gigabyte file.`
    );
  }

  const trays = [
    ...new Set([
      ...(inMemoryLive && liveInMemory ? [liveInMemory.trayId] : []),
      ...livePersisted.map((r) => r.trayId).filter((t): t is string => typeof t === "string"),
    ]),
  ];
  const several = trays.length > 1;
  return (
    `A download with id \`${id}\` IS still running — this lookup declined to answer for it, ` +
    `which is NOT the same as it being gone. ` +
    (several
      ? `TWO OR MORE live transfers share that id (tray ids: ${trays.join(", ")}), so answering ` +
        `by id alone would have picked one arbitrarily. Re-run with \`tray_id\` to select the one ` +
        `you mean, or omit the selector to list them all.`
      : `Its record could not be matched by id alone in this session. Re-run with no selector to ` +
        `list every tracked download, or pass \`tray_id\`${trays[0] ? ` (\`${trays[0]}\`)` : ""}.`) +
    ` Do NOT re-download: the transfer is in flight and a second one would duplicate it.`
  );
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
    // Only FRESH in-flight records count as live candidates — a heartbeat-stale record
    // may still stream, but must not inflate the ambiguity count and force a false
    // "no download" (matching the persisted helpers' fresh-in-flight rule).
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

/**
 * The ordering tiebreak for two jobs that share a millisecond (#1208).
 *
 * RAW comparison, not localeCompare (codex review). localeCompare is
 * locale-aware by definition and its collation depends on the runtime's ICU
 * build, so `tray-B` vs `tray-a` can order differently on Windows and Linux —
 * which would have traded a timing flake for a portability flake, in a function
 * whose whole job here is to be identical on every machine.
 *
 * A missing trayId sorts LAST rather than colliding on the string "undefined":
 * two absent ids still compare equal (nothing can separate them), but an absent
 * one never displaces a present one, so the order stays stable as far as the
 * data allows.
 */
export function compareTrayIds(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function listDownloadJobs(): DownloadJob[] {
  // One Entry is indexed under multiple keys — dedup by identity so a job appears once
  // regardless of how many keys point at it. Identity is (id, trayId), NOT id alone:
  // two distinct URLs to one dest+auth share an id but are distinct physical downloads
  // (different trayId), and both must be listed — download_model action:"status" with no selector
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
  // (started before a reconnect), so download_model action:"status" still lists in-flight downloads.
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
  // #1208 — a DETERMINISTIC tiebreak. started_at is a millisecond timestamp, so
  // two jobs begun in the same millisecond compared equal and the order fell back
  // to Map insertion order: stable locally, evidently not on a loaded CI runner.
  // "lists newest first" failed on all THREE platforms at once and went green on
  // an unchanged re-run — and a flake that fails everywhere simultaneously reads
  // like a regression, which is what it costs to rule out.
  //
  // trayId is the right tiebreak: it is unique per physical download (two URLs
  // sharing an id differ there), so equal timestamps order identically on every
  // run and in every process.
  return [...byKey.values()].sort(
    (a, b) => b.started_at - a.started_at || compareTrayIds(a.trayId, b.trayId),
  );
}

/**
 * Is the process that wrote this persisted record GONE? (#858)
 *
 * A stale heartbeat only says PERSISTENCE stopped — a reconnect can interrupt
 * the heartbeat while the HTTP stream keeps writing (#761), so staleness alone
 * never licenses touching another session's record. What proves the writer dead
 * is that no process answers to the pid stamped on the record: the transfer
 * lives in that process, so a dead pid means a dead writer.
 *
 *   true      — ESRCH: no such process exists. PROVEN gone.
 *   false     — a process answers to the pid. (It could be an unrelated process
 *               reusing the pid — that direction only ever refuses, never
 *               destroys, so the error is safe.)
 *   undefined — cannot tell: no pid recorded (pre-#858 record) or the probe
 *               itself failed. Absence of evidence is NOT evidence of absence.
 */
function writerProcessGone(rec: PersistedDownloadJob): boolean | undefined {
  // Our own record belongs to THIS very process — alive by definition.
  if (rec.owner === PERSIST_OWNER) return false;
  const pid = rec.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0); // signal 0: existence probe, nothing is signalled
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ESRCH" ? true : undefined;
  }
}

/**
 * Close a STALE in-flight persisted record whose writer is PROVEN gone (#858) —
 * the recovery the jammed cancel in #858 needed: the record is rewritten as a
 * terminal "cancelled" owned by THIS session, the dead owner's record file is
 * removed, and the dead writer's panel tray row is cleared unless a live job
 * still shares it. The download can then be safely re-issued (it resumes from
 * whatever .partial the dead writer left, or restarts cleanly).
 *
 * Order is deliberate (report before you destroy): the replacement terminal
 * record is made durable FIRST, so a transient persistence failure leaves the
 * stale record untouched — never a download with no record at all.
 *
 * Nothing here fabricates a cancellation of live work: it only runs once the
 * writer is proven dead, which means the physical transfer had ALREADY stopped
 * on its own. The record is marked `reclaimed_dead` so renderers disclose that
 * instead of narrating an abort that never happened.
 */
function reclaimDeadPersistedDownload(
  rec: PersistedDownloadJob,
): {
  reclaimed: boolean;
  denied?: "owner-alive" | "owner-unknown" | "persist-failed";
  /** The replacement terminal record is durable, but the dead owner's original
   *  record file could not be deleted — the caller must DISCLOSE the leftover,
   *  not claim a clean close (codex gate, round 2). */
  staleRecordLeft?: boolean;
} {
  const gone = writerProcessGone(rec);
  if (gone !== true) {
    return { reclaimed: false, denied: gone === false ? "owner-alive" : "owner-unknown" };
  }
  const durable = persistDownloadJob({
    ...rec,
    // The staleness diagnostics are read-only annotations and are never persisted.
    staleInflight: undefined,
    staleForMs: undefined,
    status: "cancelled",
    finished_at: rec.finished_at ?? Date.now(),
    reclaimed_dead: true,
  });
  if (!durable) return { reclaimed: false, denied: "persist-failed" };
  const removed = removePersistedDownloadJobFor(rec.id, rec.owner ?? "");
  // The dead writer's tray row would linger in the panel otherwise. Clear it
  // ONLY when no possibly-live job could share it. Rows are keyed by the
  // writer-reported progressId, but a job whose writer has not reported yet is
  // identifiable only by trayId, so count BOTH ids of every candidate. And a
  // STALE foreign record is counted too: a stale heartbeat is not proof its
  // writer stopped (#761) — only THIS record's death has been proven (it is
  // already removed by this point, or the failure is reported via
  // staleRecordLeft). Over-counting only ever skips a clear (safe), never wipes
  // a live row (the #515 invariant).
  const rowIds = new Set(
    [rec.progressId, rec.trayId].filter((x): x is string => typeof x === "string" && x.length > 0),
  );
  if (rowIds.size > 0) {
    const liveRowIds = new Set<string>();
    for (const e of new Set(jobs.values())) {
      if (e.job.status !== "downloading") continue;
      if (e.job.progressId) liveRowIds.add(e.job.progressId);
      liveRowIds.add(e.job.trayId);
    }
    for (const r of listPersistedDownloadJobs()) {
      if (r.status !== "downloading") continue;
      if (r.progressId) liveRowIds.add(r.progressId);
      if (r.trayId) liveRowIds.add(r.trayId);
    }
    for (const rowId of rowIds) {
      if (!liveRowIds.has(rowId)) clearDownloadProgress(rowId);
    }
  }
  return { reclaimed: true, staleRecordLeft: !removed };
}

/**
 * Cancel an in-flight download by id (#515): abort its stream and mark it
 * cancelled. The abort unwinds the fetch + pipeline; the .partial is left on disk
 * (resumable) and NEVER renamed to the destination, so nothing is reported as
 * complete. Idempotent — cancelling an already-settled job just reports its state.
 * Returns the resulting status plus whether this call performed the abort.
 *
 * Only a download owned by THIS process can be aborted (its AbortController lives
 * here). A job resolvable only via the persisted store belongs to another
 * session: while that session may still be alive the cancel REFUSES (#761) — but
 * a stale in-flight record whose writer is PROVEN gone (its process no longer
 * exists) is reclaimed instead (#858): closed as cancelled so the user is no
 * longer wedged between a status that says "do not re-issue" and a cancel that
 * says "not yours".
 */
export function cancelDownloadJob(
  id: string,
  /** #822 disambiguator: the tray id of the SPECIFIC download to cancel, when the
   *  public `id` denotes more than one (two source URLs → one destination). With
   *  it the composite identity (id, trayId) selects exactly one row, which is what
   *  made the stale job in #822 unselectable — and therefore unstoppable. */
  trayId?: string,
): {
  found: boolean;
  owned: boolean;
  aborted: boolean;
  /** The id denotes MORE than one concurrent physical download (a live foreign
   *  session shares it with a different trayId) — declined, nothing was aborted.
   *  Pass `trayId` to resolve it. */
  ambiguous?: boolean;
  /** A stale foreign in-flight record whose writer was PROVEN gone was closed as
   *  cancelled (#858). No live transfer was aborted — there was none left. */
  reclaimed?: boolean;
  /** The reclaim's terminal record is durable, but the dead owner's original
   *  record file could not be deleted — disclose the leftover, don't claim a
   *  clean close. */
  staleRecordLeft?: boolean;
  /** Why a stale foreign record was NOT reclaimed: the owning process is still
   *  alive (the transfer may still be writing), its death cannot be proven from
   *  here (no writer identity on the record), or closing the record failed
   *  transiently (retry). */
  reclaimDenied?: "owner-alive" | "owner-unknown" | "persist-failed";
  /** Every download the id answers to — so an ambiguity refusal can NAME the
   *  choices instead of leaving the caller with no next move. */
  candidates?: DownloadJob[];
  status?: DownloadJob["status"];
  job?: DownloadJob;
} {
  if (trayId) {
    // Explicit selection: find the ONE local entry with this composite identity.
    // Scanning entries (rather than jobs.get(id)) matters because the registry's
    // id row holds only one of several same-destination jobs.
    const entry = [...new Set(jobs.values())].find(
      (e) => e.job.id === id && e.job.trayId === trayId,
    );
    if (entry) {
      const { job, controller } = entry;
      // No ambiguity check here: the caller named the exact download, which is
      // precisely the information the by-id refusal was missing. A foreign
      // same-id sibling is a DIFFERENT trayId and is untouched by this abort.
      if (job.status !== "downloading") {
        return { found: true, owned: true, aborted: false, status: job.status, job };
      }
      if (!controller.signal.aborted) controller.abort();
      return { found: true, owned: true, aborted: true, status: "downloading", job };
    }
    // Not ours. It may be another session's (persisted). A LIVE one is reportable,
    // not abortable — but a STALE one whose writer is proven gone is reclaimed
    // (#858): closed as cancelled so the download can be safely re-issued.
    const foreign = listDownloadJobCandidates(id).find((j) => j.trayId === trayId);
    if (foreign) {
      if (foreign.status === "downloading" && foreign.staleInflight) {
        const rec = listPersistedDownloadJobs().find(
          (r) => r.id === id && r.trayId === trayId && r.status === "downloading",
        );
        if (rec) {
          const re = reclaimDeadPersistedDownload(rec);
          if (re.reclaimed) {
            return {
              found: true,
              owned: false,
              aborted: false,
              reclaimed: true,
              staleRecordLeft: re.staleRecordLeft,
              status: "cancelled",
              job: { ...jobFromPersisted(rec), status: "cancelled", reclaimedDead: true },
            };
          }
          return {
            found: true,
            owned: false,
            aborted: false,
            reclaimDenied: re.denied,
            status: foreign.status,
            job: foreign,
          };
        }
      }
      return { found: true, owned: false, aborted: false, status: foreign.status, job: foreign };
    }
    return { found: false, owned: false, aborted: false, candidates: listDownloadJobCandidates(id) };
  }

  const entry = jobs.get(id);
  if (entry) {
    const { job, controller } = entry;
    // Cross-session ambiguity: a live foreign download shares this id with a DIFFERENT
    // trayId. Aborting by id could act on the wrong logical download — decline so a
    // cancel-by-id can never hit an unintended concurrent download (a #515 invariant).
    if (job.status === "downloading" && hasAmbiguousForeignSibling(id, job.trayId)) {
      return {
        found: true,
        owned: true,
        aborted: false,
        ambiguous: true,
        candidates: listDownloadJobCandidates(id),
        status: job.status,
        job,
      };
    }
    // NOTE (#822 vs #761): a STALE foreign record sharing this id deliberately does
    // NOT refuse here. A dead session's leftover row must never permanently jam the
    // live download this process owns (#761), and the live local job is
    // unambiguously the one a by-id cancel means. What #822 was missing is not more
    // refusals — it is the ability to NAME the other row, which `trayId` above now
    // provides. So: by-id keeps acting on the job we own; the stale sibling is
    // selectable by its tray id (and reported as not-abortable-from-here, which is
    // the truth — its AbortController died with its session).
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
    // best-effort request and points the caller at download_model action:"status" for the resolved state.
    if (!controller.signal.aborted) controller.abort();
    return { found: true, owned: true, aborted: true, status: "downloading", job };
  }
  // Not in THIS process's registry. It may still exist in the persisted store
  // (another/previous session owns the AbortController), which we can't abort here.
  // #822: with no local job to prefer, picking one of several persisted records to
  // report on would be a guess. Refuse and NAME them — the caller re-issues with the
  // tray id of the one they mean. Only STILL-DOWNLOADING records create that
  // ambiguity: a settled record cannot be cancelled wrongly (the call is a no-op
  // report either way), so it must not block the one row that could be acted on.
  const persistedCandidates = listDownloadJobCandidates(id);
  if (persistedCandidates.filter((c) => c.status === "downloading").length > 1) {
    return {
      found: true,
      owned: false,
      aborted: false,
      ambiguous: true,
      candidates: persistedCandidates,
      status: persistedCandidates[0].status,
      job: persistedCandidates[0],
    };
  }
  const persisted = readPersistedDownloadJob(id);
  if (persisted) {
    // A STALE in-flight record whose writer is proven gone is reclaimed (#858);
    // a live or unprovable one stays refused exactly as before (#761).
    if (persisted.status === "downloading" && persisted.staleInflight) {
      const re = reclaimDeadPersistedDownload(persisted);
      if (re.reclaimed) {
        return {
          found: true,
          owned: false,
          aborted: false,
          reclaimed: true,
          staleRecordLeft: re.staleRecordLeft,
          status: "cancelled",
          job: { ...jobFromPersisted(persisted), status: "cancelled", reclaimedDead: true },
        };
      }
      return {
        found: true,
        owned: false,
        aborted: false,
        reclaimDenied: re.denied,
        status: persisted.status,
        job: jobFromPersisted(persisted),
      };
    }
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

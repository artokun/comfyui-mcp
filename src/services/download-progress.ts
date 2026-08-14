// Cross-process download-progress channel.
//
// Model downloads run INSIDE the panel agent's comfyui MCP subprocess, but the
// panel bridge that renders the download tray lives in the ORCHESTRATOR process.
// To bridge them without a socket, the subprocess writes a small per-download
// progress JSON into COMFYUI_MCP_PROGRESS_DIR; the orchestrator watches that dir
// and broadcasts the rows to the panel (see src/orchestrator/index.ts).
//
// This no-ops entirely when COMFYUI_MCP_PROGRESS_DIR is unset — i.e. for every
// normal (non-panel) use of the MCP — so it costs nothing outside the panel.

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Per-PROCESS owner nonce (#515/#529). Distinguishes THIS session's persisted job
 *  records from another concurrent session's — even when both run the SAME logical
 *  download (identical deterministic job id from the same URL/dest/auth). Each session
 *  writes its OWN record file (…-<owner>.json) instead of clobbering a shared one, so a
 *  cross-session sibling check can tell two live sessions apart by owner rather than id. */
export const PERSIST_OWNER = randomBytes(8).toString("hex");

/** A persisted in-flight record whose `updated` is older than this is treated as a
 *  crashed/dead session (its liveness heartbeat stopped). Such records neither block
 *  resolution/adoption nor count as a live sibling — only FRESH in-flight records do.
 *  Must exceed the writer's heartbeat interval by a generous margin. */
export const PERSISTED_INFLIGHT_STALE_MS = 60_000;

export interface DownloadProgress {
  /** Stable id for this download (a hash of the source URL). */
  id: string;
  /** Human-friendly file name shown in the tray. */
  name: string;
  /** Bytes written so far. */
  downloaded: number;
  /** Total bytes (0 when the server didn't send Content-Length). */
  total: number;
  /** Instantaneous throughput, bytes/sec. */
  bytes_per_sec: number;
  /** Lifecycle. */
  status: "downloading" | "done" | "error";
  /** Attempt generation/epoch (panel#489): the epoch-ms at which THIS download
   *  ATTEMPT began. The tray/progress id is URL-derived (deterministic), so a retry
   *  of the same URL reuses the SAME id — attempt N and attempt N+1 are otherwise
   *  indistinguishable. Stamping each attempt's start epoch lets the orchestrator
   *  DROP a late terminal (failed/done) row from a SUPERSEDED attempt when a newer
   *  attempt for the same id is already progressing, instead of firing a stale
   *  "download FAILED" event that contradicts the live transfer. Absent on pre-fix
   *  rows and non-model reporters — such rows are treated conservatively (never
   *  suppressed, and never used to suppress). */
  attempt?: number;
  /** Epoch ms of this snapshot (set on write). */
  updated: number;
  /** The ComfyUI target this download serves (the writer's own COMFYUI_URL at
   *  write time — self-scoping, no reporter changes needed). The pod idle-stop
   *  veto counts ONLY rows for the watched pod: a local download must not
   *  disable a pod's auto-stop, nor vice versa (#269). Absent on pre-fix rows. */
  target?: string;
  /** The panel tab whose agent started this download (the writer's own
   *  COMFYUI_MCP_TAB at write time — self-scoping, exactly like `target`), so the
   *  orchestrator notifies EXACTLY that tab's agent when the download settles
   *  instead of waking every tab (#547). Absent for non-panel/in-process callers
   *  and pre-fix rows — the orchestrator then falls back to the single live agent. */
  tab?: string;
}

const PROGRESS_DIR = process.env.COMFYUI_MCP_PROGRESS_DIR || "";
/** Late-bound by the ORCHESTRATOR at startup (its own process has no env var —
 *  codex finding: the control channel was dead for in-process direct/mobile
 *  tool calls). progressEnabled() stays env-only on purpose: runpod.ts uses it
 *  as the spawned-child discriminator, and the orchestrator is NOT a child. */
let lateBoundDir = "";
export function setProgressDir(dir: string): void {
  lateBoundDir = dir;
}
/**
 * A STABLE per-user directory for persisted job records, used when nothing else
 * set one (#1148).
 *
 * Without it, a plain stdio MCP server — no panel, no orchestrator, no
 * COMFYUI_MCP_PROGRESS_DIR — had NO channel dir, so `persistedRecordsEnabled()`
 * was false and not one job record was ever written. Every cross-restart
 * mechanism built for #1148 was inert in that configuration, while
 * `download_model action:"status"` went on promising that an interrupted
 * download stays resolvable by id. A reporter lost a 5 GB transfer to exactly
 * that gap and was told "No download matching id".
 *
 * DELIBERATELY NOT UNDER tmpdir. The orchestrator nonces its progress dir per
 * start and REAPS earlier ones there — the very deletion #1148's carry-over
 * exists to survive. A records dir a later orchestrator start could sweep would
 * reintroduce the bug from the other side.
 *
 * SAFE ONLY BECAUSE ADOPTION IS LIVENESS-CHECKED (#1275). Enabling the store
 * also enables cross-session adoption, and before that fix a record left behind
 * by a crashed process was adoptable for up to a minute — a new download would
 * take over a job nobody was running. Turning this on without that guard traded
 * one silent failure for a worse one.
 *
 * Created lazily and memoized: `channelDir()` runs on every persist, and a
 * failure to create it degrades to "no persistence" — the previous behaviour —
 * rather than throwing inside a download.
 */
let defaultRecordsDir: string | undefined;
let defaultRecordsDirTried = false;

function stableRecordsDir(): string {
  if (defaultRecordsDirTried) return defaultRecordsDir ?? "";
  defaultRecordsDirTried = true;
  try {
    const dir = join(
      process.env.COMFYUI_MCP_DATA_DIR?.trim() || join(homedir(), ".comfyui-mcp"),
      "download-records",
    );
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    defaultRecordsDir = dir;
  } catch {
    defaultRecordsDir = undefined;
  }
  return defaultRecordsDir ?? "";
}

/** Test seam: forget the memoized default so a case can point it somewhere else. */
export function __resetStableRecordsDir(): void {
  defaultRecordsDir = undefined;
  defaultRecordsDirTried = false;
}

function channelDir(): string {
  return PROGRESS_DIR || lateBoundDir;
}

/**
 * Where the persisted JOB RECORDS live — the channel dir when there is one, else
 * the stable per-user default (#1148).
 *
 * Deliberately SEPARATE from `channelDir()`, which also drives the control
 * channel (the MCP child's target-change requests, read by an orchestrator).
 * Falling back for that one too would switch on a channel with nobody at the
 * other end: a plain stdio server has no orchestrator to read it, and a test
 * asserting the control channel is inactive without a progress dir caught
 * exactly that over-reach.
 *
 * Only the RECORD store needs somewhere to write regardless of transport,
 * because only it has to survive a restart.
 */
function recordsDir(): string {
  return channelDir() || stableRecordsDir();
}
const lastWriteAt = new Map<string, number>();

/**
 * Carry a dead orchestrator's IN-FLIGHT job records into the new channel dir as
 * terminal "interrupted" records, instead of deleting them (#1148).
 *
 * The persisted store exists so a session that reconnects can still resolve an
 * in-flight download by id (#529), and download_model's own status text promises
 * exactly that. But the orchestrator nonces its progress dir per start and reaps
 * every earlier dir for the port — so an orchestrator restart deleted the store
 * that promise depends on. A reporter's 12GB transfer answered "No download
 * matching id" and "No downloads are being tracked", with no file and no partial
 * on disk and no error event: 40 minutes gone, invisibly, while the documented
 * contract told their agent to keep waiting rather than re-issue.
 *
 * What this does NOT do is decide whether the transfer is dead — the original
 * framing, and WRONG for the case that matters. A download DISPATCHED to
 * ComfyUI-Manager is a server-side fetch: the ComfyUI HOST is doing the work and
 * a restart here does not touch it, so it is very likely still running, and
 * telling that caller to re-issue writes a second copy to the same destination —
 * a corrupt model (#1197). This function reads neither the `pid` nor the `owner`
 * it persists, and `writerProcessGone()` exists to answer exactly the question it
 * skips, so it is in no position to assert death for EITHER route.
 *
 * What it fixes is the SILENCE: a record saying we stopped WATCHING, which
 * `status` can find by the id the caller was handed — worded per route, which is
 * why `via_manager` has to survive the copy.
 *
 * Only `downloading` records migrate. A terminal record's outcome was already
 * delivered, and re-landing it would replay a settled event. Fields are copied
 * INDIVIDUALLY rather than spread: this reads a file written by a process that
 * is gone, and the new record must be a record we constructed.
 *
 * Best-effort throughout — a failure here must never block startup.
 */
export function migrateInFlightJobs(fromDir: string, toDir: string): number {
  let migrated = 0;
  let files: string[];
  try {
    files = readdirSync(fromDir).filter((f) => f.startsWith(JOB_PREFIX) && f.endsWith(".json"));
  } catch {
    return 0;
  }
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(fromDir, f), "utf8")) as Record<string, unknown>;
      if (!raw || typeof raw !== "object") continue;
      if (typeof raw.id !== "string" || raw.status !== "downloading") continue;
      const str = (k: string): string | undefined =>
        typeof raw[k] === "string" ? (raw[k] as string) : undefined;
      const num = (k: string): number | undefined =>
        typeof raw[k] === "number" ? (raw[k] as number) : undefined;
      // WHO was transferring decides what this record may say, so the flag has to
      // survive the migration (#1197). A Manager dispatch is a server-side fetch:
      // the ComfyUI HOST is doing the work and a restart here does not touch it.
      // Dropping `via_manager` is what made the old text dangerous — it rendered
      // as a plain local interruption, so a live 12 GB host transfer was reported
      // stopped and the caller was told to re-issue, which writes a SECOND copy to
      // the same destination and corrupts the model (node-management.ts:971-979).
      const viaManager = raw.via_manager === true;
      // TYPED, not inferred: an annotated object literal gets excess-property
      // checking, so a key that is NOT on PersistedDownloadJob is a COMPILE
      // error. The five dead keys that lived here for months (`name`, `dest`,
      // `target`, `total`, `received` — from the tray-row interface) are caught
      // this way. `persistDownloadJob` cannot help: it spreads a variable, which
      // defeats the check.
      //
      // The type gate and the round-trip test's key-set assertion are
      // COMPLEMENTARY, and an earlier version of this comment wrongly said the
      // type was "the only thing that catches this class":
      //   - the TYPE catches a key that is not on the interface at all;
      //   - the TEST catches a key that IS on the interface but that the writer
      //     never emits (e.g. `notes`), which the type cannot see.
      // What is true, and worth stating precisely, is that no assertion on the
      // PERSISTED record can see a dead key: it is always `undefined` and
      // JSON.stringify drops it before it reaches disk. An assertion on the
      // literal itself would see it.
      const rec: PersistedDownloadJob = {
        id: raw.id,
        status: "error" as const,
        url: str("url") ?? "",
        dest_key: str("dest_key"),
        req_key: str("req_key"),
        // Carried so the record stays USABLE, not just readable: without trayId a
        // caller passing the tray_id they were handed gets "not found" on a record
        // that exists, the row renders `(tray undefined)`, and an absent
        // started_at prints `NaN s ago` in the candidate listing.
        // `trayId`, NOT `tray_id` — this record's one camelCase key (line ~631),
        // and the ONLY one url lookup matches on. Getting it wrong yields a
        // silent `undefined` that a fixture using the same wrong key would not
        // catch, which is precisely how a test passes for the wrong reason.

        // Required by the interface. A source record missing one is already
        // unusable for lookup; an empty string keeps the record VALID and
        // findable by id rather than emitting a malformed one.
        trayId: str("trayId") ?? "",
        filename: str("filename"),
        target_subfolder: str("target_subfolder") ?? "",
        started_at: num("started_at") ?? Date.now(),
        pid: num("pid"),
        via_manager: viaManager,
        // Real keys that were also being dropped. `resume` is what a re-issue
        // needs to continue a partial rather than restart it, and `progressId`
        // links the record back to its tray row.
        progressId: str("progressId"),
        resume: raw.resume,
        updated: Date.now(),
        interrupted_by_restart: true,
        // NEITHER branch asserts the transfer died. This function reads neither
        // the `pid` nor the `owner` it persists, and `writerProcessGone()` exists
        // to answer exactly that question — the cancel path refuses to close a
        // stale record until that probe returns ESRCH (#761/#858). What is
        // observed is only that we stopped watching.
        error: viaManager
          ? `This download is no longer being WATCHED, and it was DISPATCHED to ` +
            `ComfyUI-Manager — the fetch runs on the ComfyUI host, which the restart ` +
            `here did not touch, so it is very likely STILL RUNNING. Do NOT re-issue ` +
            `it: a second dispatch writes another copy to the same destination and ` +
            `CORRUPTS the model. The file is not listed until it COMPLETES (which can ` +
            `be hours for a multi-GB model), so an empty list_local_models proves ` +
            `nothing and a timer is not a test — check the ComfyUI host's own logs or ` +
            `disk if you need to know where it is.`
          : `This download is no longer being WATCHED: the orchestrator process that ` +
            `was streaming it exited, so nothing here is writing those bytes and no ` +
            `further progress will be reported. Any partial file may have been ` +
            `discarded. Re-issue the download — it picks up a resumable .partial where ` +
            `one survives, and otherwise restarts from zero.`,
      };
      writeFileSync(
        join(toDir, `${JOB_PREFIX}${sanitizeIdPart(raw.id)}-${PERSIST_OWNER}.json`),
        JSON.stringify(rec),
        { mode: 0o600 },
      );
      migrated += 1;
    } catch {
      /* one unreadable record must not stop the rest */
    }
  }
  return migrated;
}

/** True when running under the panel orchestrator (progress channel is active). */
export function progressEnabled(): boolean {
  return !!PROGRESS_DIR;
}

/** True when the cross-session persisted job store is active (a channel dir exists,
 *  from the env var OR the orchestrator's late binding). Unlike progressEnabled(), this
 *  honors the late-bound dir — so the job registry only runs its persistence heartbeat
 *  when there is actually somewhere to persist/adopt (avoids a leaked no-op interval on
 *  plain non-panel downloads). */
export function persistedRecordsEnabled(): boolean {
  return !!recordsDir();
}

function fileFor(id: string, target?: string, attempt?: number): string {
  // The id is a hex hash from callers, but stay defensive about the filename.
  // Include a TARGET discriminator (codex finding: the same URL downloaded for
  // local AND pod concurrently shared one file — the last writer's target won
  // the per-pod idle veto and a pod could be auto-stopped mid-transfer).
  const disc = createHash("sha1")
    .update(target ?? `pid:${process.pid}`)
    .digest("hex")
    .slice(0, 8);
  // Per-ATTEMPT file (panel#489): the id is URL-derived, so attempt N and a retry N+1
  // share id AND target. Giving each attempt its OWN file (by its start epoch) means a
  // retry can NEVER clobber the still-live row of the attempt it replaced — both rows
  // coexist on disk, so the orchestrator deterministically drops the SUPERSEDED
  // attempt's terminal instead of racing a shared-file overwrite. Readers scan the
  // shared `${id}-` prefix, so readDownloadProgress/clearDownloadProgress still see
  // every variant. Absent on rows with no attempt epoch (pre-fix / non-model reporters
  // — they keep the single-file name, unchanged).
  const attemptSeg = Number.isFinite(attempt) ? `-a${attempt}` : "";
  // Per-PROCESS owner segment (codex finding): the attempt epoch alone is not guaranteed
  // unique across DIFFERENT processes (two children starting the same download in the
  // same millisecond could tie), which would put two live writers on ONE file and let a
  // late terminal clobber the other's live row. Owner-scoping the filename — the same
  // per-process nonce the persisted job store already uses (#515/#529) — makes two
  // processes write distinct files (barring a ~2^-64 owner-nonce collision), so a
  // clobber is effectively impossible regardless of any epoch tie. (Supersession
  // ordering for a genuinely simultaneous same-ms cross-process
  // double-start is inherently undefined, but it is non-corrupting: #467/#473 O_EXCL temp
  // + atomic rename + payload validation, and #529 in-flight adoption normally prevents a
  // second writer in the first place.)
  return join(
    PROGRESS_DIR,
    `${id.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${disc}${attemptSeg}-o${PERSIST_OWNER}.json`,
  );
}

/** Credential-free form of a target URL for persisted rows / control files:
 *  strips userinfo (https://user:pass@host) before anything hits disk or a
 *  bridge frame (codex finding — raw COMFYUI_URL was being broadcast). */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    // Query/fragment can carry credentials too (?token=secret) — the contract
    // is credential-free before disk/broadcast (codex finding).
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return raw.split("@").pop() ?? raw; // unparseable — drop anything before the last @
  }
}

/**
 * Write a progress snapshot for one download. The in-flight "downloading" state
 * is throttled to ~3/sec to avoid hammering the disk; terminal states
 * (done/error) always write so the final row is accurate.
 */
export function reportDownloadProgress(
  p: Omit<DownloadProgress, "updated">,
  force = false,
): void {
  if (!PROGRESS_DIR) return;
  const now = Date.now();
  if (!force && p.status === "downloading") {
    if (now - (lastWriteAt.get(p.id) ?? 0) < 300) return;
  }
  lastWriteAt.set(p.id, now);
  try {
    mkdirSync(PROGRESS_DIR, { recursive: true });
    // Stamp the writer's OWN target (the spawned MCP child's COMFYUI_URL): the
    // idle-stop veto scopes by it, and after a retarget the respawned child
    // reports against the new host while stale rows age out (codex finding:
    // a process-wide count let any download disable any pod's auto-stop).
    // Redacted — target URLs can carry userinfo (codex finding).
    const rawTarget = p.target ?? (process.env.COMFYUI_URL?.trim() || undefined);
    const target = rawTarget ? redactUrl(rawTarget) : undefined;
    // Stamp the panel tab that started this download (the spawned MCP child's own
    // COMFYUI_MCP_TAB) so the orchestrator can wake EXACTLY that tab's agent when
    // the download settles (#547), the same self-scoping trick `target` uses.
    const tab = p.tab ?? (process.env.COMFYUI_MCP_TAB?.trim() || undefined);
    // Per-attempt file (panel#489): a retry of the same URL/target writes its OWN file
    // (keyed by attempt epoch), so it can never overwrite the still-live row of the
    // attempt it superseded. The orchestrator sees both and drops the superseded one.
    writeFileSync(fileFor(p.id, target, p.attempt), JSON.stringify({ ...p, target, tab, updated: now }));
  } catch {
    // best-effort — progress is cosmetic, never fail a download over it
  }
}

/**
 * Read back one download's latest snapshot, so `download_model action:"status"` can report
 * bytes/throughput instead of a bare "still going". Progress files are
 * TARGET-SCOPED ({id}-{disc}.json — the same URL can download for local AND a
 * pod at once), so scan every variant for this id and return the most recently
 * updated snapshot. Returns null when progress reporting is off (no
 * COMFYUI_MCP_PROGRESS_DIR) or nothing has been written yet — callers must
 * treat byte counts as decoration, never as the source of truth for whether a
 * download finished.
 */
export function readDownloadProgress(id: string): DownloadProgress | null {
  if (!PROGRESS_DIR) return null;
  try {
    const prefix = `${id.replace(/[^a-zA-Z0-9_.-]/g, "_")}-`;
    let best: DownloadProgress | null = null;
    for (const f of readdirSync(PROGRESS_DIR)) {
      if (!f.startsWith(prefix) || !f.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(PROGRESS_DIR, f), "utf8")) as DownloadProgress;
        if (parsed && typeof parsed === "object" && typeof parsed.updated === "number") {
          if (!best || parsed.updated > best.updated) best = parsed;
        }
      } catch {
        // skip an absent/mid-write variant
      }
    }
    return best;
  } catch {
    return null; // absent or mid-write — not an error
  }
}

// ── Attempt-supersession (panel#489) ────────────────────────────────────────
// The tray/progress id is a deterministic hash of the source URL, so a RETRY of
// the same URL reuses the SAME id: attempt N and attempt N+1 share an id but are
// distinct transfers. When attempt N fails (poison-partial discard, network drop)
// AFTER attempt N+1 for the same id has begun, attempt N's TERMINAL (error/done)
// row is a LATE artifact of an abandoned attempt — firing a "download FAILED"
// event off it contradicts the live progress of attempt N+1. These helpers let
// the orchestrator's tray poll detect and drop such superseded terminals, and the
// WRITER-side guard (reportDownloadProgress) stops a superseded terminal from ever
// clobbering the shared on-disk row of a newer attempt for the same (id, target).

interface AttemptRowLike {
  id?: unknown;
  status?: unknown;
  attempt?: unknown;
  target?: unknown;
}

/** Supersession scope key: (id, target). Two downloads with the SAME URL-derived id
 *  but DIFFERENT targets — e.g. the SAME model streamed to LOCAL and to a POD at once
 *  (#269) — are INDEPENDENT transfers, not retries of each other, so a terminal from
 *  one must NEVER be treated as superseded by the other. Attempts of the same logical
 *  download share id AND target. Returns null when the row carries no usable id. A
 *  missing target (in-process caller / no COMFYUI_URL) collapses to "" — two such
 *  attempts still share a scope, which is correct (same logical local destination). */
export function downloadAttemptKey(row: AttemptRowLike): string | null {
  const id = typeof row?.id === "string" ? row.id : undefined;
  if (!id) return null;
  const target = typeof row?.target === "string" ? row.target : "";
  return `${id}\n${target}`;
}

/**
 * Flag each settled FAILURE whose FILENAME is being downloaded right now (#1150).
 *
 * The supersession key above is (id, target), and it is right to be: it answers
 * "is this the same transfer?", where a filename cannot. But a 404 retried with a
 * CORRECTED URL is a different id writing the same filename, so the eviction
 * cannot see it — and a reporter was woken with "Model download FAILED" for two
 * files that `download_model action:"status"` showed streaming at 20% and 13%
 * seconds later.
 *
 * This asks a different, narrower question: "is the thing I am about to call
 * failed currently arriving?" For the human or agent reading that sentence, the
 * NAME is the identity, so the name is the right key here even though it is the
 * wrong key there. A false positive costs a hedge on a genuinely dead download; a
 * false negative is the reported bug.
 *
 * Mutates and returns `settled` — the caller passes rows it just built.
 */
export function markSupersededByLive<T extends { name: string; status: string; supersededByLive?: boolean }>(
  settled: T[],
  liveRows: ReadonlyArray<{ name?: unknown; status?: unknown }>,
): T[] {
  const liveNames = new Set(
    liveRows
      .filter((r) => r?.status === "downloading")
      .map((r) => (typeof r?.name === "string" ? r.name : ""))
      .filter((n) => n !== ""),
  );
  for (const s of settled) {
    if (s.status !== "done" && liveNames.has(s.name)) s.supersededByLive = true;
  }
  return settled;
}

/** Newest attempt epoch per (id, target) across the given rows (ANY status — a
 *  superseding newer attempt may itself be downloading OR already terminal). Rows
 *  missing an `attempt` epoch (pre-fix writer / non-model reporter) are ignored —
 *  they never establish supersession. The caller passes rows that have survived the
 *  dead-writer freshness filter so a crashed attempt's stale row can't shadow a real
 *  terminal. */
export function newestAttemptEpochs(rows: AttemptRowLike[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const attempt = typeof r?.attempt === "number" ? r.attempt : undefined;
    const k = downloadAttemptKey(r);
    if (!k || attempt === undefined) continue;
    const cur = out.get(k);
    if (cur === undefined || attempt > cur) out.set(k, attempt);
  }
  return out;
}

/** True when `row` belongs to a SUPERSEDED attempt — a strictly-newer attempt for the
 *  SAME (id, target) exists (panel#489). Applies to ANY status: a superseded attempt's
 *  late TERMINAL (error/done) must not fire a stale panel event, and its abandoned
 *  "downloading" row must not linger as a duplicate tray/idle-veto row beside the live
 *  retry. Both `row` AND the newer attempt must carry `attempt` epochs for a
 *  supersession to be provable; otherwise returns false (conservative — a genuine
 *  current row still shows, and pre-fix rows are unaffected). Strictly-greater, so an
 *  attempt's OWN rows (equal epoch) never suppress themselves. */
export function isSupersededAttempt(row: AttemptRowLike, newest: Map<string, number>): boolean {
  const attempt = typeof row?.attempt === "number" ? row.attempt : undefined;
  const k = downloadAttemptKey(row);
  if (!k || attempt === undefined) return false;
  const n = newest.get(k);
  return n !== undefined && n > attempt;
}

/** Remove a download's progress file(s) (e.g. on cancel). Target-scoped files
 *  share the id prefix, so clear every variant for the logical download. */
export function clearDownloadProgress(id: string): void {
  if (!PROGRESS_DIR) return;
  lastWriteAt.delete(id);
  try {
    const prefix = `${id.replace(/[^a-zA-Z0-9_.-]/g, "_")}-`;
    for (const f of readdirSync(PROGRESS_DIR)) {
      if (f.startsWith(prefix) && f.endsWith(".json")) rmSync(join(PROGRESS_DIR, f), { force: true });
    }
  } catch {
    // ignore
  }
}

// ── Control channel (MCP child → orchestrator) ──────────────────────────────
// runpod_* tools invoked by a panel AGENT run in the spawned stdio MCP child:
// setComfyuiTarget / getRunpodWatcher() there affect only that child — the
// orchestrator's QueueMonitor, watcher, host indicator and agent envs would
// stay on the old target while the tool result claims "connected + watched"
// (#269, codex). This one-file request channel reuses the proven progress-dir
// plumbing: the child stamps a target request; the orchestrator's 700ms
// poll loop applies it through the SAME applyComfyuiUrl fan-out as a panel
// hello. Self-healing (a stale request is ignored after its TTL) and idempotent
// (in-process callers already applied the change — re-applying dedupes).

export interface TargetChangeRequest {
  /** Retarget the orchestrator here (omit for a watch/unwatch-only request). */
  url?: string;
  /** Generation guard for URL retargets (codex finding): apply ONLY when the
   *  orchestrator's CURRENT target still equals what the child saw at write
   *  time — a newer direct choice made during the poll delay must not be
   *  overwritten by a stale queued request. */
  expectedCurrentUrl?: string;
  /** Retarget to the orchestrator's OWN resolved local fallback — the child
   *  must not guess it: a child spawned AFTER a pod connect has no memory of
   *  the LAN rig, and would wrongly overwrite it with 127.0.0.1 (codex). */
  local?: boolean;
  /** Only retarget local when the orchestrator's CURRENT target is this pod —
   *  a stale child (left on pod A after another tab moved to B) stopping A
   *  must not drag the authoritative target off B (codex finding). The ack
   *  still reports the resulting URL so the stale child ALIGNS to it. */
  onlyIfTarget?: string;
  /** A pod the caller just STOPPED — the orchestrator clears its recorded
   *  auto-connect failure (a spawned child's stop otherwise leaves the
   *  "still billing" warning up forever — codex finding). */
  stoppedPodId?: string;
  /** Wait for this pod's ComfyUI to become READY (stats+queue), THEN retarget
   *  + watch — the ORCHESTRATOR waits, so the tool call returns inside the
   *  MCP 60s request lifetime instead of blocking for minutes (codex). */
  connectWhenReady?: { url: string; podId: string };
  /** Pod to watch (status broadcast + idle auto-stop) after the retarget. */
  watchPodId?: string;
  /** Stop watching entirely (local switch). */
  unwatch?: boolean;
  /** Scope the unwatch to THIS pod (stop-fallback): the orchestrator unwatches
   *  only when it's actually watching this one — an unrelated watched pod must
   *  survive a different pod's stop (codex finding). */
  unwatchPodId?: string;
  /** Set when the requester will block on awaitTargetApplied — the orchestrator
   *  writes an applied-ack ONLY for these (fire-and-forget requests would leak
   *  ack files nobody consumes — codex finding). */
  wantAck?: boolean;
  updated: number;
}

const CONTROL_TTL_MS = 60_000; // a request older than this is stale — ignore
/** Per-request control files are prefixed so the orchestrator consumes EXACTLY
 *  the file it read (no read-then-delete race between agent children, and no
 *  timestamp-collision identity problems — codex finding). Kept OUT of
 *  pollDownloads' tray rows via the "control-" prefix (applied-acks too). */
export const CONTROL_PREFIX = "control-";
const REQUEST_PREFIX = `${CONTROL_PREFIX}target-`;
const APPLIED_PREFIX = `${CONTROL_PREFIX}applied-`;
let controlSeq = 0;

function controlDirPath(dir: string = channelDir()): string | null {
  return dir || null;
}

/** Ask the orchestrator to retarget (+ optionally watch a pod). Returns the
 *  request file path (for awaitTargetApplied), or null when the channel is
 *  inactive (no progress dir). */
export function requestTargetChange(req: Omit<TargetChangeRequest, "updated">): string | null {
  const dir = controlDirPath();
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true });
    // Redact any credential-bearing target URL before it touches disk (codex).
    const safe: Omit<TargetChangeRequest, "updated"> = {
      ...req,
      ...(req.url ? { url: redactUrl(req.url) } : {}),
      ...(req.connectWhenReady ? { connectWhenReady: { ...req.connectWhenReady, url: redactUrl(req.connectWhenReady.url) } } : {}),
    };
    // Unique-per-request file: consumption deletes exactly this name — a second
    // child's request can never be clobbered by the first's delete.
    const file = join(dir, `${REQUEST_PREFIX}${process.pid}-${Date.now()}-${controlSeq++}.json`);
    writeFileSync(file, JSON.stringify({ ...safe, updated: Date.now() }));
    return file;
  } catch {
    return null; // best-effort — the caller's own retarget still happened
  }
}

/** The ack file the orchestrator writes after applying a given request file. */
function appliedFileFor(requestFile: string): string {
  return join(dirname(requestFile), `${APPLIED_PREFIX}${basename(requestFile).slice(REQUEST_PREFIX.length)}`);
}

/** Child side: wait for the orchestrator to apply our request and report the
 *  RESULTING target (its own remembered LAN fallback included — the child
 *  can't compute it, codex finding). Returns the ack, or null on timeout —
 *  callers must then report honestly rather than guess 127.0.0.1. */
export async function awaitTargetApplied(requestFile: string, timeoutMs = 4_000): Promise<{ url: string; applied: boolean } | null> {
  const ack = appliedFileFor(requestFile);
  const start = Date.now();
  for (;;) {
    try {
      const raw = JSON.parse(readFileSync(ack, "utf-8")) as { url?: string; applied?: boolean };
      if (typeof raw?.url === "string") {
        rmSync(ack, { force: true }); // consumed — don't leak it into a later poll
        return { url: raw.url, applied: raw.applied !== false };
      }
    } catch {
      // not applied yet
    }
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
}

export interface PendingTargetChange {
  req: TargetChangeRequest;
  file: string;
}

/** Orchestrator side: all fresh pending requests (within TTL), oldest first.
 *  The dir is EXPLICIT: the orchestrator computes progressDir itself while the
 *  module-level env capture is unset in its own process (codex finding — the
 *  channel was write-only: children stamped, nobody read). */
export function listTargetChangeRequests(dir: string): PendingTargetChange[] {
  const out: PendingTargetChange[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith(REQUEST_PREFIX) && f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const file = join(dir, f);
      const raw = JSON.parse(readFileSync(file, "utf-8")) as TargetChangeRequest;
      if (typeof raw?.updated !== "number") continue;
      if (!raw.url && !raw.local && !raw.watchPodId && !raw.unwatch && !raw.connectWhenReady && !raw.stoppedPodId) continue;
      if (Date.now() - raw.updated > CONTROL_TTL_MS) {
        rmSync(file, { force: true }); // reap stale requests while we're here
        continue;
      }
      out.push({ req: raw, file });
    } catch {
      // mid-write or corrupt — retry next tick
    }
  }
  return out.sort((a, b) => a.req.updated - b.req.updated);
}

/** Orchestrator side: after applying a request, ack it with the RESULTING
 *  target so the requesting child can align its own process to the TRUE
 *  fallback/target (it can't compute the orchestrator's remembered LAN URL —
 *  codex finding). `applied` reports whether a guarded (onlyIfTarget) request
 *  was actually applied — a guarded-out request must not read as a successful
 *  local switch (codex finding). Best-effort; the child times out gracefully. */
export function ackTargetChange(requestFile: string, url: string, applied = true): void {
  try {
    writeFileSync(appliedFileFor(requestFile), JSON.stringify({ url, applied, updated: Date.now() }));
  } catch {
    // ignore
  }
}

/** Orchestrator side: consume one applied request file (exactly the file that
 *  was read — never a newer replacement, since each request is its own file). */
export function consumeTargetChange(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // ignore
  }
}

// ── Persisted download-job records (cross-session adoption, #529) ─────────────
// The in-memory download-job registry (download-jobs.ts) is process-global, so a
// sidebar/tool-session RECONNECT — which respawns the MCP child — starts with an
// EMPTY registry and `download_model action:"status"(id)` can no longer resolve an id returned by
// a previous session ("Downloads are tracked per server session"). The live download
// itself keeps running and keeps writing its progress row, so the STATE exists on
// disk; it just isn't discoverable by the new session's registry.
//
// This persists a small per-job record into the SAME progress dir the tray already
// uses, so any session can rediscover (adopt) an in-flight job by its public id — or
// by URL/destination — after a reconnect. The record is prefixed with CONTROL_PREFIX
// so the orchestrator's tray poll (pollDownloads skips CONTROL_PREFIX) and its
// control-request reader (listTargetChangeRequests only reads REQUEST_PREFIX) both
// ignore it. No-ops entirely without a progress dir, exactly like reportDownloadProgress.
const JOB_PREFIX = `${CONTROL_PREFIX}job-`;

export interface PersistedDownloadJob {
  id: string;
  trayId: string;
  /** The id the physical progress rows are written under (post-auth/HF-rewrite);
   *  differs from trayId only for query-auth / mirror URLs. Optional/back-compat. */
  progressId?: string;
  url: string;
  target_subfolder: string;
  filename?: string;
  status: "downloading" | "done" | "error" | "cancelled";
  path?: string;
  error?: string;
  started_at: number;
  finished_at?: number;
  notes?: string[];
  /** The auth-free destination key (local targetPath or canonical remote id) — lets
   *  a caller adopt by DESTINATION as well as by URL, without a duplicate download. */
  dest_key?: string;
  /** The route-independent request key (url+subfolder+filename+auth) — the SAME across a
   *  local↔Manager route flip, so cross-session adoption matches a reconnect even when
   *  the route (and thus the public id) changed. */
  req_key?: string;
  /** True when dispatched to a remote ComfyUI-Manager (server-side fetch), not streamed
   *  to local disk — a "done" record then means dispatch-accepted, not verified landed. */
  via_manager?: boolean;
  /** The writing session's per-process owner nonce (PERSIST_OWNER). Two sessions
   *  running the same logical download share an `id` but differ here, so a sibling
   *  check can distinguish them. Absent on pre-fix records. */
  owner?: string;
  /** The writing process's pid (#858). A stale heartbeat only says PERSISTENCE
   *  stopped — the transfer may still be streaming (#761). What proves the writer
   *  dead is that no process answers to this pid (the HTTP stream lives in the
   *  process that wrote the record), which is what lets a later session reclaim a
   *  stale in-flight record instead of refusing forever. Absent on pre-fix
   *  records: those stay UNPROVABLE and are never reclaimed. */
  pid?: number;
  /** Set on a terminal record written by a LATER session that reclaimed a stale
   *  in-flight record whose writer was proven dead (#858). The "cancelled" state
   *  is then administrative — no live transfer was aborted — so renderers must
   *  not claim a resumable partial was deliberately left by a cancel. */
  reclaimed_dead?: boolean;
  resume?: unknown;
  /** Post-landing live-server verification (#369): whether the CONNECTED ComfyUI
   *  actually lists the landed file, so a reconnecting session still sees the
   *  "downloaded but invisible to the running server" warning instead of a bare
   *  "done". Absent on pre-fix records. */
  live_visible?: "visible" | "not-visible" | "unknown" | "pending";
  /** The verification explanation, surfaced verbatim by download_model action:"status". */
  verify_note?: string;
  /** Whether the post-landing on-disk stat succeeded. False = the file was NOT
   *  found when checked, so no renderer may claim "verified on disk". */
  disk_verified?: boolean;
  /** The live models root the placement verdict was made against, so a reconnect can
   *  tell a still-current verdict from one made against a DIFFERENT server. */
  verified_root?: string;
  /** Epoch ms of this snapshot (set on write). */
  updated: number;
  /** Set on a terminal record MIGRATED from a dead orchestrator's channel dir
   *  (#1148). The transfer stopped because the process it streamed inside exited,
   *  not because the server or the URL failed — so renderers say that, and never
   *  imply a resumable partial was deliberately left behind. */
  interrupted_by_restart?: boolean;
  /**
   * Read-only diagnostics added when an in-flight record missed the liveness
   * heartbeat. These are never persisted: a stale heartbeat is not proof that
   * the physical transfer stopped, so callers must keep the record visible.
   */
  staleInflight?: boolean;
  staleForMs?: number;
}

function sanitizeIdPart(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/** THIS session's record file for a job id — owner-scoped, so a second session running
 *  the same id writes a DIFFERENT file rather than clobbering ours. */
function jobFileFor(id: string): string {
  return join(recordsDir(), `${JOB_PREFIX}${sanitizeIdPart(id)}-${PERSIST_OWNER}.json`);
}

let persistSeq = 0;

/** Persist (or update) a job record so another session can adopt it after a
 *  reconnect (#529). URL is redacted before it touches disk (it can carry query
 *  auth), matching the rest of this channel. Best-effort — a persistence failure
 *  never fails a download. No-op without a progress dir.
 *
 *  ATOMIC: writes to a unique temp then renames it over the target, so a concurrent
 *  reader (another session polling for adoption, or this session's heartbeat) NEVER sees
 *  a half-written/truncated record and treats a live download as absent — which would let
 *  a reconnect-reissue start a SECOND writer (torn-write double-writer race). fs.rename
 *  atomically replaces on POSIX and on Windows (libuv MoveFileEx REPLACE_EXISTING). The
 *  `.tmp` name ends in `.tmp` (not `.json`) so no scanner ever picks up a temp.
 *
 *  Returns TRUE iff the record was DURABLY replaced (the atomic rename succeeded), so the
 *  caller (the heartbeat) can keep retrying a transiently-failing TERMINAL persist until
 *  the terminal state is durable — otherwise a done/cancelled job could linger as a fresh
 *  "downloading" record (bounded by long record retention, but this recovers it sooner). Returns
 *  false when there is no channel dir (nothing to persist) or the replace didn't happen. */
/**
 * Delays between the atomic-replace retries, in ms (#1545).
 *
 * The escalation is intent, not a guarantee: MEASURED on Windows, the platform
 * timer granularity floors every sleep at ~15 ms, so this schedule totals ~73 ms
 * while a flat [2,2,2,2] totals ~62 ms — nearly the same. What actually matters
 * here is that a delay EXISTS at all (the loop previously had none, so all five
 * attempts collided with one reader open) and that there are several of them.
 * The ordering still helps where timers are finer-grained, and costs nothing.
 */
const RENAME_BACKOFF_MS = [2, 5, 10, 20];

/**
 * Sleep without yielding the event loop.
 *
 * `commitDone` publishes the terminal status and persists it in ONE synchronous
 * step precisely so no reader can observe a landed file with a "downloading"
 * job, so this path may not await. `Atomics.wait` on a throwaway buffer is the
 * supported way to block a Node thread; a busy spin would burn a core for the
 * same delay. Falls back to a bounded spin where `Atomics.wait` is disallowed
 * (it throws on the main thread in some embeddings).
 */
function sleepSyncMs(ms: number): void {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // performance.now() is MONOTONIC; Date.now() is not. A backward wall-clock
    // adjustment (NTP step, DST on some platforms) during this loop would make
    // the exit condition unreachable and freeze the event loop in the very
    // fallback meant to be safe (review finding). The iteration cap is a second
    // belt: even a pathological clock cannot make this run forever.
    const until = performance.now() + ms;
    for (let i = 0; performance.now() < until && i < 5_000_000; i++) {
      /* bounded spin — only reached where Atomics.wait is unavailable */
    }
  }
}

export function persistDownloadJob(job: Omit<PersistedDownloadJob, "updated">): boolean {
  const dir = recordsDir();
  if (!dir) return false;
  try {
    mkdirSync(dir, { recursive: true });
    const safe: PersistedDownloadJob = {
      ...job,
      owner: PERSIST_OWNER,
      pid: process.pid,
      url: job.url ? redactUrl(job.url) : job.url,
      updated: Date.now(),
    };
    const body = JSON.stringify(safe);
    const finalPath = jobFileFor(job.id);
    const tmpPath = `${finalPath}.${process.pid}-${persistSeq++}.tmp`;
    writeFileSync(tmpPath, body);
    // Atomic replace, retried a few times for a TRANSIENT Windows sharing violation (a
    // reader briefly holding the target open during its own readFileSync). We must NEVER
    // fall back to an in-place writeFileSync(finalPath): that truncate+rewrite is exactly
    // the torn-read that lets another process see the record as absent and start a SECOND
    // writer. On persistent failure we KEEP the prior COMPLETE record untouched and drop
    // the temp; the next ~15s heartbeat retries the atomic replace (self-healing). A
    // terminal persist that can't replace ages out via long record retention instead
    // of ever corrupting the scanned .json.
    // #1545 — the retries need to be SPREAD OUT to be retries at all. This loop
    // had no delay, so all five attempts completed within microseconds of each
    // other and lost to the same reader's `readFileSync` open: "retried a few
    // times" was effectively one attempt. A reporter polling
    // `download_model action:"status"` — i.e. opening this exact file — while a
    // download completed saw the terminal record fail to land, and `status` kept
    // answering "downloading" from the prior record until the ~15s heartbeat.
    //
    // The backoff is SYNCHRONOUS on purpose: `commitDone` publishes the terminal
    // state and persists it in one step with no await in between, so nothing may
    // yield here. Worst case is ~37 ms, and only under actual contention — the
    // first attempt is unchanged and does not sleep.
    let renamed = false;
    for (let attempt = 0; attempt < 5 && !renamed; attempt++) {
      if (attempt > 0) sleepSyncMs(RENAME_BACKOFF_MS[attempt - 1] ?? 20);
      try {
        renameSync(tmpPath, finalPath); // readers see old or new complete record, never torn
        renamed = true;
      } catch {
        /* transient (e.g. Windows sharing violation) — retry */
      }
    }
    if (!renamed) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        /* ignore — a stray temp is never scanned (ends in .tmp) */
      }
    }
    return renamed;
  } catch {
    // best-effort — adoption is a convenience, never fail a download over it
    return false;
  }
}

/** Remove a persisted job record (e.g. once it's fully retired). Best-effort. */
export function removePersistedDownloadJob(id: string): void {
  const dir = recordsDir();
  if (!dir) return;
  try {
    rmSync(jobFileFor(id), { force: true });
  } catch {
    // ignore
  }
}

/** Remove a SPECIFIC session's persisted record, named by its owner nonce — the
 *  reclaim half of #858. This is the ONE destructive operation on another
 *  session's state: call it only for a record whose writer is PROVEN dead (see
 *  cancelDownloadJob), and only after the replacement terminal record is durable,
 *  so a failure here never leaves the download with no record at all.
 *
 *  Returns TRUE only when the file is gone. A transient Windows sharing violation
 *  (a reader briefly holding the file) is retried, mirroring the persist rename;
 *  a persistent failure is reported to the caller so it can DISCLOSE the leftover
 *  instead of claiming a clean close it did not observe (codex gate, round 2). */
export function removePersistedDownloadJobFor(id: string, owner: string): boolean {
  const dir = recordsDir();
  if (!dir || !owner) return false;
  const path = join(dir, `${JOB_PREFIX}${sanitizeIdPart(id)}-${sanitizeIdPart(owner)}.json`);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(path, { force: true });
      return true;
    } catch {
      /* transient — retry */
    }
  }
  return false;
}

// A missed heartbeat is only a liveness hint, not proof the transfer stopped:
// an orchestrator/session reconnect can interrupt persistence while the HTTP
// stream continues. Keep in-flight records for the same bounded retention as
// terminal records so read paths cannot delete a live owner's state (#761).
const PERSISTED_JOB_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function parseJobFile(dir: string, f: string): PersistedDownloadJob | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as PersistedDownloadJob;
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
    const age = typeof raw.updated === "number" ? Date.now() - raw.updated : 0;
    // This parser backs read paths (including download_model action:"status"). A heartbeat gap
    // beyond the short freshness window is not sufficient evidence to destructively
    // delete a potentially live transfer; adoption/cancel freshness checks below
    // still treat it as non-live. Reap only after the bounded long retention.
    if (age > PERSISTED_JOB_TTL_MS) {
      try {
        rmSync(join(dir, f), { force: true });
      } catch {
        /* ignore */
      }
      return null;
    }
    if (raw.status === "downloading" && age > PERSISTED_INFLIGHT_STALE_MS) {
      return { ...raw, staleInflight: true, staleForMs: age };
    }
    return raw;
  } catch {
    return null; // absent / mid-write / corrupt — skip
  }
}

/** Read the best persisted record for a public id, or null when absent/expired. More
 *  than one record can exist for one id — one per session that ran it (owner-scoped
 *  files) — so scan all matches and prefer an in-flight one, then the most recent. */
export function readPersistedDownloadJob(id: string): PersistedDownloadJob | null {
  const matches = listPersistedDownloadJobs().filter((j) => j.id === id);
  if (matches.length === 0) return null;
  const now = Date.now();
  // A LIVE download is a FRESH in-flight record (heartbeat recent). Ambiguity that
  // matters is >1 distinct trayId among LIVE records — two distinct URLs resolving to
  // the same dest+auth are distinct concurrent physical downloads the id can't
  // disambiguate. Dead in-flight records are already reaped in parseJobFile, so
  // `matches` holds only fresh in-flight and terminal records; the freshness filter
  // here is defense-in-depth against a record that aged out between scan and use.
  const live = matches.filter(
    (j) => j.status === "downloading" && now - (j.updated ?? 0) < PERSISTED_INFLIGHT_STALE_MS,
  );
  if (live.length > 0) {
    if (new Set(live.map((j) => j.trayId)).size > 1) return null; // ambiguous live download
    return live.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0];
  }
  // No live download. INTEGRITY TRUTH (cross-session): a terminal DONE means a validated
  // file landed at the destination. It must WIN over a later cancelled/error record for
  // the SAME id — a cancel/error never lands a file, so it must NEVER override another
  // session's validated-complete file (cancelled-over-complete). Prefer the most-recent
  // DONE; only if there is none do we report the most-recent terminal record.
  const done = matches.filter((j) => j.status === "done");
  const pool = done.length > 0 ? done : matches;
  return pool.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0];
}

/** Every persisted job record (freshest not guaranteed; caller sorts). Used to
 *  list in-flight downloads after a reconnect and to look one up by URL/destination. */
/**
 * When was THIS session's record store created, and where is it? (#1420)
 *
 * The store is nonced per orchestrator start and earlier ones are reaped, so a
 * restart or reconnect gives a session a brand-new, EMPTY store while transfers
 * begun under the old one keep streaming inside the processes that own them. An
 * empty listing therefore says as much about the store's age as about the world,
 * and a reader deserves to be told which.
 *
 * `createdMs` is undefined when the directory cannot be stat'd — unknown, which is
 * reported as unknown rather than as "old".
 */
/**
 * The creation time of a record store, from its stat — or UNDEFINED (#1420).
 *
 * BIRTHTIME ONLY. ctime was written as a fallback and removed: where birthtime is
 * unavailable, ctime moves whenever a record is written into the directory — which
 * is constantly, since that is what the directory is for — so a long-lived store
 * would report itself as seconds old, and the sentence built on it ("anything
 * started before then was never in it") would be FALSE exactly when it is most
 * load-bearing. Unknown is reported as unknown.
 *
 * Extracted so the rule is testable: on a filesystem that supplies birthtime — as
 * this project's own does — no test could otherwise reach the fallback, and a
 * mutation putting ctime back survived because of it.
 */
export function storeCreatedFrom(st: { birthtimeMs: number; ctimeMs: number }): number | undefined {
  const born = st.birthtimeMs;
  return Number.isFinite(born) && born > 0 ? born : undefined;
}

export function describeRecordStore(): { dir: string; createdMs?: number } {
  const dir = recordsDir();
  if (!dir) return { dir: "" };
  try {
    return { dir, createdMs: storeCreatedFrom(statSync(dir)) };
  } catch {
    return { dir };
  }
}

export function listPersistedDownloadJobs(): PersistedDownloadJob[] {
  const dir = recordsDir();
  if (!dir) return [];
  const out: PersistedDownloadJob[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith(JOB_PREFIX) && f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files) {
    const rec = parseJobFile(dir, f);
    if (rec) out.push(rec);
  }
  return out;
}

/** Find a persisted job by TRAY id or by destination key — so a caller can adopt an
 *  in-flight download after a reconnect WITHOUT starting a duplicate (#529).
 *
 *  Matching is on `trayId` (a hash of the FULL raw source URL, query included — the
 *  caller derives it via downloadIdFor), NOT the persisted `url` string: the persisted
 *  url is credential-redacted (query stripped), so comparing it would conflate two
 *  distinct signed/versioned URLs that differ only by query. Hashing the raw url keeps
 *  the match exact AND credential-free. Prefers an in-flight ("downloading") match,
 *  then the most recently updated (a niche same-exact-URL-two-destinations case is
 *  inherently ambiguous from a URL alone — the id selector disambiguates it). */
export function findPersistedDownloadJob(query: { trayId?: string; destKey?: string }): PersistedDownloadJob | null {
  const { trayId, destKey } = query;
  if (!trayId && !destKey) return null;
  const matches = listPersistedDownloadJobs().filter(
    (j) => (trayId && j.trayId === trayId) || (destKey && j.dest_key === destKey),
  );
  if (matches.length === 0) return null;
  // AMBIGUITY GUARD: one URL can legitimately drive TWO jobs to different destinations
  // (they share a trayId), and one auth-free destination can back two different-auth
  // jobs (they share a dest_key). Adopting by URL/destination alone then can't tell them
  // apart — so REFUSE to guess when more than one DISTINCT LIVE job matches; the caller
  // must use the exact id. Distinctness is (id, trayId). Ambiguity is judged over LIVE
  // (fresh in-flight) records ONLY: a heartbeat-stale record may still be streaming,
  // but must not block adoption or force a false decline.
  const distinctKey = (j: PersistedDownloadJob): string => `${j.id}\n${j.trayId}`;
  const now = Date.now();
  const live = matches.filter(
    (j) => j.status === "downloading" && now - (j.updated ?? 0) < PERSISTED_INFLIGHT_STALE_MS,
  );
  if (live.length > 0) {
    if (new Set(live.map(distinctKey)).size > 1) return null; // ambiguous live download
    return live.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0];
  }
  // No live download. INTEGRITY TRUTH: a terminal DONE (validated file landed) must WIN
  // over a later cancelled/error record for the same destination — never override a
  // validated-complete file. Prefer the most-recent DONE, else the most-recent terminal.
  const done = matches.filter((j) => j.status === "done");
  const pool = done.length > 0 ? done : matches;
  return pool.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0];
}

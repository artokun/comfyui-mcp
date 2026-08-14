// Connected-panel origins, ORCHESTRATOR → spawned MCP child (#1415).
//
// #952 built the drift comparison (describeTargetDrift, comfyui/fetch.ts): when a
// ComfyUI call fails at the network layer, say whether a CONNECTED panel is on a
// different ComfyUI than the address that failed. The orchestrator installs its
// source from the bridge (orchestrator/index.ts, setConnectedPanelOrigins).
//
// But the orchestrator is not where those calls happen. Every headless comfyui
// tool — `list_packs (action:"list_templates")` among them — runs in the SPAWNED
// stdio child (`node dist/index.js`), which loads orchestrator/index.js never
// (boot.ts imports it only for --panel-orchestrator) and has no bridge. So the
// source was null there, the comparison returned "", and #1415's reporter got the
// generic "a CONNECTED sidebar panel does not imply this address is reachable"
// while the orchestrator was sitting on the exact answer: their panel was on
// :8188 and the call went to the dead COMFYUI_URL.
//
// This is the missing HALF of that channel, and it reuses the plumbing the
// control channel already proved (services/download-progress.ts): a small JSON
// file in COMFYUI_MCP_PROGRESS_DIR, which the orchestrator shares with every
// child it spawns. Named with the same `control-` prefix, so the tray poll and
// the target-change reader both skip it.
//
// LEVEL-TRIGGERED, not event-driven: the orchestrator re-publishes the CURRENT
// set on its existing 700ms poll tick and writes only when it changed. A tab that
// goes away therefore blanks the file within ONE TICK — so the worst case is a
// failure raised inside that window quoting a panel that disconnected up to
// ~700ms ago, not an unbounded stale claim. (An earlier version of this comment
// said the child "can never" quote a disconnected panel. It can, for that
// window; the bound is what makes it acceptable, so the bound is what is
// written down. Review, finding 2.)
//
// ## Staleness across an orchestrator's DEATH (review, finding 1)
//
// The tick only blanks the file while the orchestrator is alive to run it. Kill
// it — crash, task manager, a machine losing power — and the last record stays
// on disk indefinitely, describing panels that are long gone. The progress dir
// outlives the process, so the next orchestrator's children can read it before
// its own first tick republishes.
//
// A plain `updated` comparison cannot fix that, because writes are CHANGE-ONLY:
// a record that is legitimately unchanged for an hour is not stale, and a TTL
// alone would expire it. So the record carries the publisher's `pid` and is
// refreshed on a slow HEARTBEAT independent of change, and the reader requires
// BOTH:
//
//   - the publishing process is still alive (`process.kill(pid, 0)`), which
//     catches the death case immediately rather than after a timeout; and
//   - the record was refreshed recently, which catches the case a bare pid check
//     cannot — the OS reusing a dead orchestrator's pid for something unrelated.
//
// Either alone leaves a hole; together the failure mode is "says nothing", which
// is the pre-#952 behaviour and costs a diagnostic sentence rather than
// producing a wrong one.
//
// ### What this still does NOT close, stated rather than implied
//
// Both remaining holes are the SAME shape — a dead publisher whose record is
// younger than PANEL_ORIGINS_MAX_AGE_MS — and both are bounded by it:
//
//   - PID REUSE inside the window. The orchestrator crashes, the OS hands its
//     pid to something unrelated that is alive, and the record has not yet aged
//     out. Both checks pass for the remainder of the window.
//   - A ZOMBIE publisher on Linux. A terminated-but-unreaped process still has a
//     pid that `kill(pid, 0)` answers for, so liveness says yes while the
//     orchestrator is gone. The heartbeat stopped when it died, so this expires
//     on the same clock.
//
// Neither is closed by more checking of the same kind — a pid cannot prove it is
// the same process that wrote, and only a lock or a handle the reader can
// interrogate would settle it. That is not worth building here: the payload is a
// DIAGNOSTIC SENTENCE, the worst outcome is naming an origin that stopped being
// connected up to two minutes ago, it self-heals on the next read, and the
// realistic path needs a child that outlived its own parent orchestrator (a live
// one republishes within 30s, and within 700ms of starting). Recorded so the
// next reader does not have to re-derive it — and so the bound is a number
// somebody chose, not one that fell out.
//
// No-ops entirely when COMFYUI_MCP_PROGRESS_DIR is unset — a plain (non-panel)
// MCP server keeps the pre-#952 "" exactly as before.

import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * The open flags, resolved at CALL time and defensively.
 *
 * Destructuring `constants` at module scope broke ten unrelated suites: this
 * module is pulled in transitively by comfyui/fetch.ts, and a partial
 * `vi.mock("node:fs")` that does not re-export `constants` makes the destructure
 * throw during IMPORT — every test in the file then collects zero tests, with an
 * error that names this line rather than the mock. Reading it inside the
 * function means a mocked fs is simply a mocked fs.
 *
 * Falls back to the "r" string flag when the numbers are unavailable, so the
 * open still happens; O_NONBLOCK is undefined on Windows, where the FIFO case it
 * guards does not arise.
 */
function readFlags(): number | string {
  const rd = constants?.O_RDONLY;
  if (typeof rd !== "number") return "r";
  const nonblock = constants?.O_NONBLOCK;
  return rd | (typeof nonblock === "number" ? nonblock : 0);
}

/** File name inside the progress dir. The `control-` prefix is load-bearing:
 *  pollDownloads and listTargetChangeRequests both filter on it, so this file is
 *  never mistaken for a download row or a target-change request. Kept as a
 *  literal (not an import of CONTROL_PREFIX) so this module stays a leaf that
 *  comfyui/fetch.ts can depend on; a test pins the two together. */
export const PANEL_ORIGINS_FILE = "control-panel-origins.json";

/** Read at CALL time, not at module load: a test can point the channel at a temp
 *  dir, and nothing in production changes it after spawn anyway. */
function channelFile(dir?: string): string | null {
  const base = dir ?? process.env.COMFYUI_MCP_PROGRESS_DIR ?? "";
  return base ? join(base, PANEL_ORIGINS_FILE) : null;
}

/** Last payload written by THIS process, so the 700ms tick writes only on a
 *  change rather than once per tick forever. */
let lastPublished: string | null = null;
/** When this process last wrote the file, for the heartbeat below. */
let lastWriteAt = 0;
/** Distinguishes concurrent temp files from this process. */
let publishSeq = 0;

/**
 * A temp path no other writer can be using.
 *
 * pid + sequence alone is not unique: Node worker threads share `process.pid`
 * and each initialises its own module state, so two workers both start at
 * sequence 0 and pick the same name — one then renames the other's payload
 * (review r3). Only one publisher exists today, which is exactly why this is
 * worth making unconditional rather than relying on that staying true.
 *
 * NOT covered by a test, and mutation testing says so: stripping the entropy
 * kills nothing, because a single-publisher suite cannot observe a collision.
 * Kept as cheap insurance against a condition the tests cannot create, and
 * recorded here so the next reader does not mistake the survivor for dead code.
 */
function tempPathFor(file: string): string {
  const entropy = Math.random().toString(36).slice(2, 10);
  return `${file}.${process.pid}-${publishSeq++}-${entropy}.tmp`;
}

/** Refresh the record at least this often even when the set is UNCHANGED, so a
 *  reader can tell "still true" from "nobody has touched this since the
 *  orchestrator died". 30s against a 700ms tick is ~2 writes a minute — the
 *  change-only rule is what this exists to preserve, so it stays far away from
 *  the per-tick write it replaced. */
export const PANEL_ORIGINS_HEARTBEAT_MS = 30_000;

/** How stale a record may be before the reader stops trusting it. Generous
 *  against the heartbeat (4x) so ordinary scheduling jitter, a busy event loop,
 *  or a slow disk never expires a live orchestrator's record — the cost of
 *  expiring a good one is a lost diagnostic, but flapping would be worse. */
export const PANEL_ORIGINS_MAX_AGE_MS = 120_000;

/** A malformed or hostile-sized file must not delay the network error it is
 *  being read to DESCRIBE (review, finding 3). The real payload is a handful of
 *  origins; anything past this is not the file we wrote. */
const MAX_CHANNEL_BYTES = 64 * 1024;

/**
 * Read the channel file with a hard byte bound, through a single descriptor.
 *
 * Throws on anything unreadable, which the caller's catch turns into [] — the
 * "say nothing" answer.
 *
 * O_NONBLOCK is part of the OPEN, not a detail of the read. A FIFO at this path
 * blocks `openSync` itself until a writer arrives, so an fstat-based "is this a
 * regular file?" check placed after the open can never run — the process is
 * already parked, inside the error path, forever. (Written the other way first,
 * with a comment claiming the fstat covered it. It did not.) Undefined on
 * Windows, where the case does not arise, so it falls back to 0.
 */
function readChannelFile(file: string): string {
  const fd = openSync(file, readFlags());
  try {
    const stat = fstatSync(fd);
    // NOT covered by a portable test, and deliberately kept anyway. On Windows
    // `openSync` already rejects a directory, and mkfifo does not exist there, so
    // nothing this suite can build reaches this line — mutation testing correctly
    // reports deleting it as killing no test. It states the POSIX case (a FIFO
    // survives the non-blocking open and is not something to read), which is the
    // reason the guard exists rather than an accident of the file layout.
    if (!stat.isFile()) throw new Error("panel-origins channel is not a regular file");
    if (stat.size > MAX_CHANNEL_BYTES) throw new Error("panel-origins channel is oversized");
    // Sized from the fstat above, NOT re-clamped. A `Math.min(size, MAX)` here
    // was removed: it is unreachable behind the check on the previous line, and
    // worse, it MASKED it — an oversized file was truncated into a parse error,
    // so the suite passed with either guard deleted and neither was proven.
    const buf = Buffer.allocUnsafe(stat.size);
    const read = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, read).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/** Is the process that published this record still running?
 *
 *  `process.kill(pid, 0)` sends no signal — it only asks. EPERM means the pid
 *  exists but belongs to another user, which still answers "alive". Anything
 *  unreadable answers false, because this gates a claim and an unanswerable
 *  question must not grant it. */
function publisherAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Orchestrator side: publish the origins the connected tabs actually front.
 *
 * `dir` is EXPLICIT because the orchestrator's own COMFYUI_MCP_PROGRESS_DIR is
 * unset — it computes progressDir itself and only the children inherit it (the
 * same reason listTargetChangeRequests takes a dir).
 *
 * Best-effort: a failed write leaves the child on the previous value or on "",
 * which costs a diagnostic sentence and never a wrong one.
 */
export function publishConnectedPanelOrigins(
  dir: string,
  origins: readonly string[],
  now: number = Date.now(),
): void {
  const file = channelFile(dir);
  if (!file) return;
  // What actually gets published: filtered, deduped, ordered. The comparison and
  // the payload are both built from THIS, so they cannot disagree.
  const published = [...new Set(origins.filter((o) => typeof o === "string" && o !== ""))].sort();
  // Compare WITHOUT the timestamp — otherwise every tick differs and this writes
  // 86k files an hour to say nothing changed.
  //
  // …and compare the SET, not the caller's array. The key used to be
  // `JSON.stringify(origins)` while the payload was the filtered list, so two
  // ticks reporting the same connected panels in a different order — or with a
  // duplicate, or with an empty string appearing and vanishing — rewrote the
  // file to say exactly the same thing (review r2). `connectedServerOrigins()`
  // walks a live socket collection, so ordering is not something to assume.
  const key = JSON.stringify(published);
  // …but DO write when the heartbeat is due, even unchanged: an unrefreshed
  // record is exactly what a dead orchestrator leaves behind, so "unchanged" and
  // "nobody is home" have to be distinguishable on disk.
  const changed = key !== lastPublished;
  const heartbeatDue = now - lastWriteAt >= PANEL_ORIGINS_HEARTBEAT_MS;
  if (!changed && !heartbeatDue) return;
  const payload = JSON.stringify({
    origins: published,
    updated: now,
    pid: process.pid,
  });
  try {
    mkdirSync(dir, { recursive: true });
    // Write-then-rename, NOT an in-place rewrite. `writeFileSync(file, …)`
    // truncates and refills, so a child reading during that window sees a
    // partial record, fails to parse, and answers [] — dropping every live
    // origin at exactly the moment it is formatting the error those origins
    // explain (review r2). A rename makes readers see the old record or the new
    // one, never a torn one.
    //
    // Same shape as persistDownloadJob (download-progress.ts), including its
    // reason for retrying: on Windows a reader briefly holding the target open
    // makes rename fail transiently. On persistent failure the PRIOR complete
    // record is left untouched and the temp dropped — the next tick retries, so
    // this self-heals rather than degrading to a torn write.
    const tmp = tempPathFor(file);
    let renamed = false;
    try {
      writeFileSync(tmp, payload);
      for (let attempt = 0; attempt < 5 && !renamed; attempt++) {
        try {
          renameSync(tmp, file);
          renamed = true;
        } catch {
          /* transient (e.g. Windows sharing violation) — retry */
        }
      }
    } finally {
      // In a `finally`, so a THROWING write is cleaned up too. With the removal
      // sitting after the loop instead, a `writeFileSync` that failed partway —
      // a full disk is the ordinary cause — left its partial temp behind and
      // added another on every tick thereafter (review r3).
      if (!renamed) {
        try {
          rmSync(tmp, { force: true });
        } catch {
          /* ignore — a stray .tmp is not the channel file and is never read */
        }
      }
    }
    if (!renamed) return; // do NOT record it as published; the next tick retries
    lastPublished = key;
    lastWriteAt = now;
  } catch {
    // ignore — retried on the next tick
  }
}

/** Test/shutdown hook: forget what this process last published, so the next
 *  publish writes unconditionally. */
export function resetPublishedPanelOrigins(): void {
  lastPublished = null;
  lastWriteAt = 0;
}

/**
 * Child side: the origins the orchestrator last published, or `[]` when there is
 * no channel (a plain MCP server), nothing has been published yet, or the file is
 * mid-write. `[]` means UNKNOWN and the caller must say nothing about drift —
 * never "there is no drift".
 */
export function readPublishedPanelOrigins(now: number = Date.now()): string[] {
  const file = channelFile();
  if (!file) return [];
  try {
    // Bounded read through ONE descriptor. `statSync` then `readFileSync` names
    // the path twice, so the thing measured need not be the thing read — the
    // file can grow or be replaced in between, and the bound applies to neither
    // (review r2). Opening once and asking that fd for its size closes the gap,
    // and reading into a fixed buffer bounds the work even if the answer is a
    // lie. This runs while formatting a network failure; it must not delay the
    // error it exists to explain.
    const raw = JSON.parse(readChannelFile(file)) as {
      origins?: unknown;
      updated?: unknown;
      pid?: unknown;
    };
    if (!Array.isArray(raw?.origins)) return [];
    // A record whose publisher is gone describes panels that are gone with it.
    // Both checks, for the reasons in the header: liveness catches the death,
    // freshness catches a reused pid.
    if (!publisherAlive(raw.pid)) return [];
    // A missing or non-numeric stamp becomes 0, which the age comparison below
    // rejects on its own — `now - 0` is ~55 years. An explicit `updated <= 0`
    // guard was written here and removed: mutation testing showed deleting it
    // killed nothing, because it is unreachable behind that arithmetic for any
    // clock later than 1970. Redundant code that looks load-bearing is its own
    // hazard.
    const updated = typeof raw.updated === "number" ? raw.updated : 0;
    // `updated > now` (a clock step, or a future-dated write) is NOT freshness
    // evidence — without this it would read as maximally fresh, forever.
    if (updated > now || now - updated > PANEL_ORIGINS_MAX_AGE_MS) return [];
    return raw.origins.filter((o): o is string => typeof o === "string" && o !== "");
  } catch {
    return [];
  }
}

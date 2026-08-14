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
// No-ops entirely when COMFYUI_MCP_PROGRESS_DIR is unset — a plain (non-panel)
// MCP server keeps the pre-#952 "" exactly as before.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  // Compare WITHOUT the timestamp — otherwise every tick differs and this writes
  // 86k files an hour to say nothing changed.
  const key = JSON.stringify(origins);
  // …but DO write when the heartbeat is due, even unchanged: an unrefreshed
  // record is exactly what a dead orchestrator leaves behind, so "unchanged" and
  // "nobody is home" have to be distinguishable on disk.
  const changed = key !== lastPublished;
  const heartbeatDue = now - lastWriteAt >= PANEL_ORIGINS_HEARTBEAT_MS;
  if (!changed && !heartbeatDue) return;
  const payload = JSON.stringify({
    origins: origins.filter((o) => typeof o === "string" && o !== ""),
    updated: now,
    pid: process.pid,
  });
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, payload);
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
    // Size FIRST. This runs while formatting a network failure, so a file that
    // is huge (or is not our file at all) must not delay the error it exists to
    // explain (review, finding 3).
    if (statSync(file).size > MAX_CHANNEL_BYTES) return [];
    const raw = JSON.parse(readFileSync(file, "utf-8")) as {
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

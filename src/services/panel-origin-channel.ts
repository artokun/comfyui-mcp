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
// goes away therefore blanks the file within one tick, so the child can never
// quote a panel that has disconnected — the one direction where being wrong
// would be worse than saying nothing.
//
// No-ops entirely when COMFYUI_MCP_PROGRESS_DIR is unset — a plain (non-panel)
// MCP server keeps the pre-#952 "" exactly as before.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
export function publishConnectedPanelOrigins(dir: string, origins: readonly string[]): void {
  const file = channelFile(dir);
  if (!file) return;
  const payload = JSON.stringify({
    origins: origins.filter((o) => typeof o === "string" && o !== ""),
    updated: Date.now(),
  });
  // Compare WITHOUT the timestamp — otherwise every tick differs and this writes
  // 86k files an hour to say nothing changed.
  const key = JSON.stringify(origins);
  if (key === lastPublished) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, payload);
    lastPublished = key;
  } catch {
    // ignore — retried on the next tick
  }
}

/** Test/shutdown hook: forget what this process last published, so the next
 *  publish writes unconditionally. */
export function resetPublishedPanelOrigins(): void {
  lastPublished = null;
}

/**
 * Child side: the origins the orchestrator last published, or `[]` when there is
 * no channel (a plain MCP server), nothing has been published yet, or the file is
 * mid-write. `[]` means UNKNOWN and the caller must say nothing about drift —
 * never "there is no drift".
 */
export function readPublishedPanelOrigins(): string[] {
  const file = channelFile();
  if (!file) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as { origins?: unknown };
    if (!Array.isArray(raw?.origins)) return [];
    return raw.origins.filter((o): o is string => typeof o === "string" && o !== "");
  } catch {
    return [];
  }
}

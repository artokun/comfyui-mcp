// The stall threshold, as ONE source of truth.
//
// #2684 — this lived as a private pair of functions inside orchestrator/index.ts,
// which meant the only consumer that could read it was the turn-start stall note.
// The queue-busy notes in panel-tools.ts describe the SAME belief about the SAME
// server and could not see it, so they were free to disagree with the stall note
// about whether ComfyUI was answering — and did, in the reported session: an
// "appears STALLED" notice (which fires off the LAPSE of the liveness heartbeat)
// arrived alongside a flat assertion that a specific prompt "is still running".
//
// Sharing the number is what makes that contradiction unrepresentable, so it is
// deliberately a module, not a duplicated constant: a second copy would drift the
// moment either default moved.

/** Live stall threshold (seconds) pushed from the panel setting via a `set_config`
 *  frame — applies WITHOUT a reconnect. null = not set, fall back to env then the
 *  built-in default. Process-global: one ComfyUI per orchestrator. */
let liveStallSeconds: number | null = null;

export function setLiveStallSeconds(v: unknown): void {
  const n = Number(v);
  liveStallSeconds = Number.isFinite(n) && n > 0 ? Math.min(3600, Math.max(15, Math.round(n))) : null;
}

/** The live setting's current value in seconds, or null when unset. Exposed only
 *  so the orchestrator can log a CHANGE without keeping its own shadow copy. */
export function liveStallSecondsValue(): number | null {
  return liveStallSeconds;
}

/** Stall threshold (ms): a running job with no node/progress advance for this long
 *  is treated as stalled. Video steps are legitimately slow, so the DEFAULT is high
 *  (180s). Precedence: live panel setting (set_config) → COMFYUI_MCP_STALL_S env
 *  (spawn value) → 180s default. */
export function stallThresholdMs(): number {
  if (liveStallSeconds != null) return liveStallSeconds * 1000;
  const s = Number(process.env.COMFYUI_MCP_STALL_S);
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 180000;
}

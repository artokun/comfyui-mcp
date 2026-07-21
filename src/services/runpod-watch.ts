// Live RunPod pod status broadcast + idle auto-stop.
//
// Mirrors the queue-status / download-progress broadcasters: a poller turns the
// watched pod's live state into a `runpod_status` bridge frame so the panel and
// mobile control panels update in real time, change-only (an unchanged frame is
// not re-sent). RunPod's API is rate-limited, so we poll on a SLOW interval
// (default 15s) — unlike the 1s local ComfyUI queue tick.
//
// Idle auto-stop (gpu-cli parity): while the connected pod's ComfyUI queue is
// empty AND nothing is running, we accumulate idle time; once it crosses the
// configured timeout the pod is stopped automatically (pods bill per running
// GPU-second even when doing nothing). Off when idleStopMinutes <= 0.

import { getPod, stopPod, comfyuiPortExposed, runpodProxyUrl, type RunpodPod } from "./runpod-client.js";
import { logger } from "../utils/logger.js";

/** Wire shape of one live pod-status broadcast (panel/mobile control panels). */
export interface RunpodStatusFrame extends Record<string, unknown> {
  type: "runpod_status";
  /** Are we actively watching a pod? false → the rest is a cleared/idle frame. */
  watching: boolean;
  pod_id: string | null;
  name: string | null;
  /** RUNNING | EXITED | TERMINATED | … (null when not watching). */
  status: string | null;
  gpu: string | null;
  cost_per_hr: number | null;
  uptime_seconds: number | null;
  gpu_util: number | null;
  vram_util: number | null;
  /** The pod's ComfyUI proxy URL when running + exposed (else null). */
  comfyui_url: string | null;
  /** How long the pod's ComfyUI has been idle (queue empty, nothing running). */
  idle_seconds: number | null;
  /** Configured idle-stop timeout in minutes (null when disabled). */
  autostop_minutes: number | null;
  /** Seconds until auto-stop fires (null when disabled / not idle / not running). */
  autostop_in_seconds: number | null;
  /** True when an idle auto-stop ATTEMPT failed — the pod is still running (and
   *  billing); the watcher keeps watching and retries next tick. */
  autostop_failed?: boolean;
}

const CLEARED_FRAME: RunpodStatusFrame = {
  type: "runpod_status",
  watching: false,
  pod_id: null,
  name: null,
  status: null,
  gpu: null,
  cost_per_hr: null,
  uptime_seconds: null,
  gpu_util: null,
  vram_util: null,
  comfyui_url: null,
  idle_seconds: null,
  autostop_minutes: null,
  autostop_in_seconds: null,
};

export interface RunpodWatcherDeps {
  /** Broadcast a frame to all panel/mobile tabs (the bridge's fire-and-forget push). */
  push: (frame: Record<string, unknown>) => void;
  /** True when the ACTIVE ComfyUI target's queue is empty and nothing is running. */
  comfyuiIdle: () => boolean;
  /** True only when comfyui-mcp is CURRENTLY rendering on this pod (its ComfyUI is
   *  the active target). Idle auto-stop applies ONLY then — a pod we merely watch
   *  (e.g. while it boots, before connect) must never be stopped on the LOCAL
   *  ComfyUI's idleness, which comfyuiIdle() reports when we haven't connected. */
  renderingOnPod: (podId: string) => boolean;
  /** Idle-stop timeout in minutes; <= 0 disables auto-stop. */
  idleStopMinutes: number;
  /** Poll interval in ms (default 15000). */
  pollMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface RunpodWatcher {
  /** Start (or switch to) watching a pod — its status broadcasts live. */
  watch(podId: string): void;
  /** Stop watching; broadcasts a cleared frame. */
  unwatch(): void;
  /** The pod currently watched, or null. */
  watchedPodId(): string | null;
  /** The last frame sent (for seeding a tab that just connected). */
  current(): RunpodStatusFrame;
  /** Poll once now (also driven internally by the interval). Exposed for tests. */
  poll(): Promise<void>;
  /** Begin the poll interval. */
  start(): void;
  /** Stop the interval (does not unwatch). */
  stop(): void;
}

// ── Process-wide singleton ──────────────────────────────────────────────────
// The orchestrator owns the watcher (it has the bridge push + the ComfyUI queue
// monitor). The runpod_* tools run in the same process and reach it here; in a
// bare MCP-only setup (no orchestrator) it's null and watch/unwatch are no-ops
// (the one-shot runpod_pod_status tool still works).
let singleton: RunpodWatcher | null = null;
export function initRunpodWatcher(deps: RunpodWatcherDeps): RunpodWatcher {
  singleton?.stop();
  singleton = createRunpodWatcher(deps);
  singleton.start();
  return singleton;
}
export function getRunpodWatcher(): RunpodWatcher | null {
  return singleton;
}

export function createRunpodWatcher(deps: RunpodWatcherDeps): RunpodWatcher {
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 15000;
  const idleStopMs = deps.idleStopMinutes > 0 ? deps.idleStopMinutes * 60_000 : 0;

  let podId: string | null = null;
  let last: RunpodStatusFrame = CLEARED_FRAME;
  let idleSinceMs: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let autoStopping = false;

  function pushIfChanged(frame: RunpodStatusFrame): void {
    if (JSON.stringify(frame) === JSON.stringify(last)) return;
    last = frame;
    deps.push(frame);
  }

  function frameFor(pod: RunpodPod, idleSeconds: number | null, autostopIn: number | null): RunpodStatusFrame {
    const g = pod.runtime?.gpus?.[0];
    return {
      type: "runpod_status",
      watching: true,
      pod_id: pod.id,
      name: pod.name,
      status: pod.desiredStatus,
      gpu: pod.machine?.gpuDisplayName ?? null,
      cost_per_hr: pod.costPerHr ?? null,
      uptime_seconds: pod.runtime?.uptimeInSeconds ?? null,
      gpu_util: g?.gpuUtilPercent ?? null,
      vram_util: g?.memoryUtilPercent ?? null,
      comfyui_url: comfyuiPortExposed(pod) ? runpodProxyUrl(pod.id) : null,
      idle_seconds: idleSeconds,
      autostop_minutes: idleStopMs > 0 ? deps.idleStopMinutes : null,
      autostop_in_seconds: autostopIn,
    };
  }

  // In-flight guard: on a hung network a slow poll must not stack up under the
  // interval — a tick that lands while the previous poll is still running JOINS
  // it (no second concurrent RunPod request) instead of starting an overlap.
  let inflight: Promise<void> | null = null;

  function poll(): Promise<void> {
    if (inflight) return inflight;
    inflight = pollOnce().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function pollOnce(): Promise<void> {
    // Capture the watched pod at poll START (the "generation"). A watch(other) or
    // unwatch() can land while we await getPod/stopPod below; if the target moved
    // off `target` before we resolve, this poll's result is STALE and must be
    // dropped — otherwise it would republish pod A's status (or null out podId)
    // after pod B was already selected, leaving B silently unwatched.
    const target = podId;
    if (!target || autoStopping) return;
    let pod: RunpodPod | null;
    try {
      pod = await getPod(target);
    } catch (err) {
      // Transient RunPod API blip — keep the last frame, try again next tick.
      logger.debug(`[runpod-watch] poll failed for ${target}: ${err instanceof Error ? err.message : err}`);
      return;
    }
    if (podId !== target) return; // target changed while awaiting → stale, drop
    if (!pod) {
      // Pod vanished (terminated) — stop watching.
      logger.info(`[runpod-watch] pod ${target} no longer exists — unwatching`);
      unwatch();
      return;
    }

    // Idle tracking: only accrue idle time (and thus auto-stop) when comfyui-mcp
    // is ACTUALLY RENDERING ON THIS POD. A watched-but-unconnected pod (e.g. one
    // still booting) must never be stopped on the LOCAL ComfyUI's idleness —
    // comfyuiIdle() reports the active target, which is local until we connect.
    const running = pod.desiredStatus === "RUNNING" && !!pod.runtime;
    let idleSeconds: number | null = null;
    let autostopIn: number | null = null;
    if (running && deps.renderingOnPod(target) && deps.comfyuiIdle()) {
      if (idleSinceMs == null) idleSinceMs = now();
      idleSeconds = Math.floor((now() - idleSinceMs) / 1000);
      if (idleStopMs > 0) {
        const remainMs = idleStopMs - (now() - idleSinceMs);
        autostopIn = Math.max(0, Math.ceil(remainMs / 1000));
        if (remainMs <= 0) {
          // Fire auto-stop once; broadcast the reason so the UI can show it.
          autoStopping = true;
          logger.info(`[runpod-watch] pod ${target} idle ${idleSeconds}s ≥ ${deps.idleStopMinutes}m — auto-stopping to save cost`);
          try {
            await stopPod(target);
          } catch (err) {
            // MONEY SAFETY: the stop FAILED — the pod is still RUNNING and still
            // BILLING. Do NOT pretend it exited and do NOT stop watching: broadcast
            // the TRUE status with an autostop_failed hint so the UI can warn, keep
            // the idle clock (remainMs stays ≤ 0), and retry the stop next tick.
            logger.warn(`[runpod-watch] auto-stop of ${target} FAILED — pod still running/billing, will retry next tick: ${err instanceof Error ? err.message : err}`);
            autoStopping = false;
            if (podId === target) pushIfChanged({ ...frameFor(pod, idleSeconds, 0), autostop_failed: true });
            return;
          }
          autoStopping = false;
          if (podId !== target) return; // switched target mid-stop → don't touch B
          const stopped: RunpodStatusFrame = {
            ...frameFor(pod, idleSeconds, 0),
            status: "EXITED",
            autostop_in_seconds: 0,
          };
          pushIfChanged(stopped);
          // Stop watching WITHOUT clearing — the panel keeps showing the pod as
          // EXITED (so the user can restart it) instead of the card vanishing.
          podId = null;
          idleSinceMs = null;
          return;
        }
      }
    } else {
      idleSinceMs = null; // active or not-running → reset the idle clock
    }

    pushIfChanged(frameFor(pod, idleSeconds, autostopIn));
  }

  function watch(id: string): void {
    const switching = podId !== id;
    podId = id;
    idleSinceMs = null;
    // Kick an immediate poll so the panel doesn't wait a full interval. If a poll
    // for the PREVIOUS target is still in flight, don't overlap it — chain a fresh
    // poll after it settles (that stale poll drops its own result via the
    // generation guard), so the NEW target is polled promptly and correctly.
    if (inflight) {
      if (switching) void inflight.then(() => { if (podId === id) void poll(); });
    } else {
      void poll();
    }
  }

  function unwatch(): void {
    podId = null;
    idleSinceMs = null;
    pushIfChanged(CLEARED_FRAME);
  }

  return {
    watch,
    unwatch,
    watchedPodId: () => podId,
    current: () => last,
    poll,
    start() {
      if (timer) return;
      timer = setInterval(() => void poll(), pollMs);
      if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref: () => void }).unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

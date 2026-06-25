import { mkdir, writeFile, readdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getClient,
  ensureConnected,
  getHistory,
  type HistoryEntry,
} from "../comfyui/client.js";
import {
  getCloudUrl,
  getComfyUIBaseUrl,
  isCloudMode,
} from "../config.js";
import { attachExecutionListeners } from "../comfyui/events.js";
import { logger } from "../utils/logger.js";
import { AssetRegistry } from "./asset-registry.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import {
  analyzeHistoryEntry,
  normalizeHistoryMessages,
  type ExecutionStats,
  type ExecutionErrorDetails,
} from "./job-history.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface MediaOutput {
  filename: string;
  subfolder: string;
  type: string;
  url: string;
}

export interface CompletionNotification {
  prompt_id: string;
  status: "success" | "error" | "interrupted";
  duration_ms: number;
  timestamp: string;
  error?: {
    node_id: string;
    node_type: string;
    exception_message: string;
    exception_type?: string;
    traceback?: string;
    traceback_truncated?: boolean;
    current_inputs?: unknown;
    is_oom?: boolean;
  };
  outputs: Array<{
    node_id: string;
    images: Array<{
      filename: string;
      subfolder: string;
      type: string;
      url: string;
      asset_id?: string;
    }>;
  }>;
  // Video outputs (SaveVideo, CreateVideo, VHS_VideoCombine, LTX/Wan nodes).
  // Adapted from jcd315's fork (jcd315/comfyui-mcp-muse, commit e13342ec).
  video_outputs: Array<{
    node_id: string;
    videos: MediaOutput[];
  }>;
  cached_nodes: string[];
  execution_stats?: ExecutionStats;
}

interface WatcherState {
  promptId: string;
  startTime: number;
  completed: boolean;
  workflow?: WorkflowJSON;
  wsCleanup?: () => void;
  pollTimer?: ReturnType<typeof setInterval>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

// ── Constants ──────────────────────────────────────────────────────────

const COMPLETIONS_DIR = join(tmpdir(), "comfyui-mcp-completions");
const HISTORY_FLUSH_DELAY_MS = 500;
const REPORTED_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// Job-watch timeout + poll cadence are env-tunable: long video renders
// (LTX / WAN can take 15+ min) were getting killed by the previous
// hardcoded 10-minute ceiling. Defaults: 30-minute timeout, 2 s poll.
// Read at call time (not module load) so tests and long-lived servers
// can adjust without a restart. Gap flagged by josephoibrahim/comfy-cozy.
export function watcherTimeoutMs(): number {
  const raw = Number(process.env.COMFYUI_JOB_TIMEOUT_S ?? "1800");
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : 1800 * 1000;
}

export function pollIntervalMs(): number {
  const raw = Number(process.env.COMFYUI_JOB_POLL_INTERVAL_S ?? "2");
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : 2000;
}

// ── Module-level state ─────────────────────────────────────────────────

const activeWatchers = new Map<string, WatcherState>();

// ── Private helpers ────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureCompletionsDir(): Promise<void> {
  await mkdir(COMPLETIONS_DIR, { recursive: true });
}

function buildImageUrl(
  filename: string,
  subfolder: string,
  type: string,
): string {
  const params = new URLSearchParams({ filename, subfolder, type });
  if (isCloudMode()) {
    const base = getCloudUrl().replace(/\/+$/, "");
    return `${base}/api/view?${params.toString()}`;
  }
  return `${getComfyUIBaseUrl()}/view?${params.toString()}`;
}

export function buildCompletionNotification(
  promptId: string,
  entry: HistoryEntry,
  startTime: number,
): CompletionNotification {
  const messages = normalizeHistoryMessages(entry);
  const analysis = analyzeHistoryEntry(entry);

  // Timing
  const startMsg = messages.find((m) => m[0] === "execution_start");
  const endMsg = messages.find(
    (m) => m[0] === "execution_success" || m[0] === "execution_error",
  );
  const startTs = (startMsg?.[1] as { timestamp?: number })?.timestamp;
  const endTs = (endMsg?.[1] as { timestamp?: number })?.timestamp;
  const durationMs =
    analysis.execution_stats?.total_duration_ms ??
    (startTs && endTs
      ? (endTs - startTs) * 1000 // ComfyUI timestamps are seconds
      : Date.now() - startTime);

  // Status
  const errorMsg = messages.find((m) => m[0] === "execution_error");
  const interruptMsg = messages.find((m) => m[0] === "execution_interrupted");
  let status: CompletionNotification["status"] = "success";
  if (errorMsg) status = "error";
  else if (interruptMsg) status = "interrupted";

  // Error details
  const error: ExecutionErrorDetails | undefined = errorMsg
    ? analysis.error
    : undefined;

  // Cached nodes
  const cachedMsg = messages.find((m) => m[0] === "execution_cached");
  const cachedNodesRaw = cachedMsg?.[1].nodes;
  const cachedNodes = Array.isArray(cachedNodesRaw)
    ? cachedNodesRaw.map((node) => String(node))
    : [];

  // Output images and videos
  const outputs: CompletionNotification["outputs"] = [];
  const video_outputs: CompletionNotification["video_outputs"] = [];

  for (const [nodeId, nodeOutput] of Object.entries(entry.outputs || {})) {
    if (!nodeOutput || typeof nodeOutput !== "object") continue;
    const out = nodeOutput as Record<string, unknown>;

    // Extract image outputs (SaveImage, PreviewImage)
    if (Array.isArray(out.images)) {
      const images = (
        out.images as Array<{
          filename: string;
          subfolder?: string;
          type?: string;
        }>
      ).map((img) => ({
        filename: img.filename,
        subfolder: img.subfolder ?? "",
        type: img.type ?? "output",
        url: buildImageUrl(
          img.filename,
          img.subfolder ?? "",
          img.type ?? "output",
        ),
      }));
      if (images.length > 0) {
        outputs.push({ node_id: nodeId, images });
      }
    }

    // Extract video outputs (SaveVideo, CreateVideo, VHS_VideoCombine).
    // These nodes emit under 'videos', 'video', or 'gifs' keys. Accumulate all
    // keys into a single entry per node, mirroring how images group once.
    // Adapted from jcd315's fork (jcd315/comfyui-mcp-muse, commit e13342ec).
    const videos: MediaOutput[] = [];
    for (const videoKey of ["videos", "video", "gifs"] as const) {
      const videoData = out[videoKey];
      if (!Array.isArray(videoData)) continue;
      for (const vid of videoData as Array<{
        filename: string;
        subfolder?: string;
        type?: string;
      }>) {
        videos.push({
          filename: vid.filename,
          subfolder: vid.subfolder ?? "",
          type: vid.type ?? "output",
          url: buildImageUrl(
            vid.filename,
            vid.subfolder ?? "",
            vid.type ?? "output",
          ),
        });
      }
    }
    if (videos.length > 0) {
      video_outputs.push({ node_id: nodeId, videos });
    }
  }

  return {
    prompt_id: promptId,
    status,
    duration_ms: Math.round(durationMs),
    timestamp: new Date().toISOString(),
    error,
    outputs,
    video_outputs,
    cached_nodes: cachedNodes,
    execution_stats: analysis.execution_stats,
  };
}

async function handleCompletion(
  promptId: string,
  state: WatcherState,
  detectedBy: "ws" | "poll",
): Promise<void> {
  // Race guard: only first detector proceeds
  if (state.completed) return;
  state.completed = true;

  logger.info(`Completion detected via ${detectedBy}`, { prompt_id: promptId });

  // Stop both monitoring tracks
  cleanup(state);

  // Wait for history to flush (WS fires before outputs are written)
  if (detectedBy === "ws") {
    await sleep(HISTORY_FLUSH_DELAY_MS);
  }

  // Fetch history — retry once if not found
  let entry: HistoryEntry | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const history = await getHistory(promptId);
      entry = history[promptId];
      if (entry?.status.completed) break;
    } catch (err) {
      logger.warn(`History fetch attempt ${attempt + 1} failed`, {
        prompt_id: promptId,
        error: err instanceof Error ? err.message : err,
      });
    }
    if (attempt === 0) await sleep(500);
  }

  if (!entry) {
    logger.error("Could not fetch history for completed job", {
      prompt_id: promptId,
    });
    activeWatchers.delete(promptId);
    return;
  }

  // Build and write notification
  try {
    const notification = buildCompletionNotification(promptId, entry, state.startTime);

    // Register outputs with the AssetRegistry so they can be referenced by
    // asset_id for view_image / regenerate. Only register on successful
    // completion with a stored workflow snapshot.
    if (notification.status === "success" && state.workflow) {
      try {
        const records = AssetRegistry.register({
          promptId,
          workflow: state.workflow,
          outputs: notification.outputs.map((o) => ({
            node_id: o.node_id,
            images: o.images.map((img) => ({
              filename: img.filename,
              subfolder: img.subfolder,
              type: img.type,
              url: img.url,
            })),
          })),
        });
        const idByKey = new Map(
          records.map((r) => [`${r.nodeId}|${r.filename}|${r.subfolder}|${r.type}`, r.assetId]),
        );
        for (const output of notification.outputs) {
          for (const img of output.images) {
            const key = `${output.node_id}|${img.filename}|${img.subfolder}|${img.type}`;
            const id = idByKey.get(key);
            if (id) img.asset_id = id;
          }
        }
      } catch (regErr) {
        logger.warn("AssetRegistry.register failed", {
          prompt_id: promptId,
          error: regErr instanceof Error ? regErr.message : regErr,
        });
      }
    }

    await ensureCompletionsDir();
    const filePath = join(COMPLETIONS_DIR, `${promptId}.json`);
    await writeFile(filePath, JSON.stringify(notification, null, 2), "utf-8");
    logger.info("Completion file written", {
      prompt_id: promptId,
      status: notification.status,
      duration_ms: notification.duration_ms,
      images: notification.outputs.reduce((n, o) => n + o.images.length, 0),
      videos: notification.video_outputs.reduce(
        (n, o) => n + o.videos.length,
        0,
      ),
    });
  } catch (err) {
    logger.error("Failed to write completion file", {
      prompt_id: promptId,
      error: err instanceof Error ? err.message : err,
    });
  }

  activeWatchers.delete(promptId);
}

function cleanup(state: WatcherState): void {
  if (state.wsCleanup) {
    try {
      state.wsCleanup();
    } catch {
      // Ignore cleanup errors
    }
    state.wsCleanup = undefined;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = undefined;
  }
  if (state.timeoutTimer) {
    clearTimeout(state.timeoutTimer);
    state.timeoutTimer = undefined;
  }
}

// ── Public API ─────────────────────────────────────────────────────────

export const JobWatcher = {
  /**
   * Start monitoring a prompt_id for completion via WS + polling dual-track.
   * Optionally pass the submitted workflow so completed outputs can be
   * registered with the AssetRegistry for view_image / regenerate.
   */
  watch(promptId: string, workflow?: WorkflowJSON): void {
    // Don't double-watch
    if (activeWatchers.has(promptId)) {
      logger.warn("Already watching prompt", { prompt_id: promptId });
      return;
    }

    const state: WatcherState = {
      promptId,
      startTime: Date.now(),
      completed: false,
      workflow,
    };
    activeWatchers.set(promptId, state);

    // ── WebSocket track (best-effort, local/remote only) ──
    // Comfy Cloud has no WebSocket; rely on the HTTP polling track instead.
    const skipWs = isCloudMode();
    if (skipWs) {
      logger.info("Cloud mode — skipping WS attach, polling-only", {
        prompt_id: promptId,
      });
    }
    if (!skipWs) try {
      const client = getClient();
      if (!client.closed) {
        state.wsCleanup = attachExecutionListeners(client, promptId, {
          onComplete: () => {
            handleCompletion(promptId, state, "ws").catch((err) =>
              logger.error("WS completion handler error", {
                prompt_id: promptId,
                error: err instanceof Error ? err.message : err,
              }),
            );
          },
          onError: () => {
            handleCompletion(promptId, state, "ws").catch((err) =>
              logger.error("WS error handler error", {
                prompt_id: promptId,
                error: err instanceof Error ? err.message : err,
              }),
            );
          },
        });
        logger.info("WS listeners attached", { prompt_id: promptId });
      } else {
        logger.info("WS not connected, polling-only mode", {
          prompt_id: promptId,
        });
        // Try to connect in background for future use
        ensureConnected().then(
          (client) => {
            if (!state.completed) {
              state.wsCleanup = attachExecutionListeners(client, promptId, {
                onComplete: () => {
                  handleCompletion(promptId, state, "ws").catch(() => {});
                },
                onError: () => {
                  handleCompletion(promptId, state, "ws").catch(() => {});
                },
              });
              logger.info("Late WS listeners attached", {
                prompt_id: promptId,
              });
            }
          },
          () => {
            // WS connection failed — polling will handle it
          },
        );
      }
    } catch {
      logger.info("WS setup failed, polling-only mode", {
        prompt_id: promptId,
      });
    }

    // ── Polling track ──
    state.pollTimer = setInterval(() => {
      if (state.completed) return;
      getHistory(promptId)
        .then((history) => {
          const entry = history[promptId];
          if (entry?.status.completed) {
            handleCompletion(promptId, state, "poll").catch((err) =>
              logger.error("Poll completion handler error", {
                prompt_id: promptId,
                error: err instanceof Error ? err.message : err,
              }),
            );
          }
        })
        .catch((err) => {
          logger.warn("Poll getHistory error", {
            prompt_id: promptId,
            error: err instanceof Error ? err.message : err,
          });
        });
    }, pollIntervalMs());

    // ── Timeout ──
    state.timeoutTimer = setTimeout(() => {
      if (!state.completed) {
        logger.warn("Watcher timeout, cleaning up", {
          prompt_id: promptId,
          elapsed_ms: Date.now() - state.startTime,
          timeout_ms: watcherTimeoutMs(),
        });
        cleanup(state);
        activeWatchers.delete(promptId);
      }
    }, watcherTimeoutMs());

    logger.info("Job watcher started", { prompt_id: promptId });
  },

  /**
   * Stop monitoring a prompt_id.
   */
  unwatch(promptId: string): void {
    const state = activeWatchers.get(promptId);
    if (state) {
      cleanup(state);
      activeWatchers.delete(promptId);
      logger.info("Job watcher stopped", { prompt_id: promptId });
    }
  },

  /**
   * List actively watched prompt_ids.
   */
  listActive(): string[] {
    return [...activeWatchers.keys()];
  },

  /**
   * Clean up old .reported completion files (called on startup).
   */
  async cleanupOldFiles(): Promise<void> {
    try {
      const files = await readdir(COMPLETIONS_DIR);
      const now = Date.now();
      let cleaned = 0;

      for (const file of files) {
        if (!file.endsWith(".reported")) continue;
        const filePath = join(COMPLETIONS_DIR, file);
        try {
          const info = await stat(filePath);
          if (now - info.mtimeMs > REPORTED_MAX_AGE_MS) {
            await unlink(filePath);
            cleaned++;
          }
        } catch {
          // File may have been deleted concurrently
        }
      }

      if (cleaned > 0) {
        logger.info(`Cleaned up ${cleaned} old completion files`);
      }
    } catch {
      // Directory doesn't exist yet — nothing to clean
    }
  },

  /** Exposed for testing/debugging */
  get COMPLETIONS_DIR() {
    return COMPLETIONS_DIR;
  },
};

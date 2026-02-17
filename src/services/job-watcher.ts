import { mkdir, writeFile, readdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getClient,
  ensureConnected,
  getHistory,
  type HistoryEntry,
} from "../comfyui/client.js";
import { getComfyUIApiHost } from "../config.js";
import { attachExecutionListeners } from "../comfyui/events.js";
import { logger } from "../utils/logger.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface CompletionNotification {
  prompt_id: string;
  status: "success" | "error" | "interrupted";
  duration_ms: number;
  timestamp: string;
  error?: {
    node_id: string;
    node_type: string;
    exception_message: string;
    traceback?: string;
  };
  outputs: Array<{
    node_id: string;
    images: Array<{
      filename: string;
      subfolder: string;
      type: string;
      url: string;
    }>;
  }>;
  cached_nodes: string[];
}

interface WatcherState {
  promptId: string;
  startTime: number;
  completed: boolean;
  wsCleanup?: () => void;
  pollTimer?: ReturnType<typeof setInterval>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

// ── Constants ──────────────────────────────────────────────────────────

const COMPLETIONS_DIR = join(tmpdir(), "comfyui-mcp-completions");
const POLL_INTERVAL_MS = 2000;
const WATCHER_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const HISTORY_FLUSH_DELAY_MS = 500;
const REPORTED_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

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
  const host = getComfyUIApiHost();
  const params = new URLSearchParams({ filename, subfolder, type });
  return `http://${host}/view?${params.toString()}`;
}

function buildNotification(
  promptId: string,
  entry: HistoryEntry,
  startTime: number,
): CompletionNotification {
  const messages = entry.status.messages || [];

  // Timing
  const startMsg = messages.find((m) => m[0] === "execution_start");
  const endMsg = messages.find(
    (m) => m[0] === "execution_success" || m[0] === "execution_error",
  );
  const startTs = (startMsg?.[1] as { timestamp?: number })?.timestamp;
  const endTs = (endMsg?.[1] as { timestamp?: number })?.timestamp;
  const durationMs =
    startTs && endTs
      ? (endTs - startTs) * 1000 // ComfyUI timestamps are seconds
      : Date.now() - startTime;

  // Status
  const errorMsg = messages.find((m) => m[0] === "execution_error");
  const interruptMsg = messages.find((m) => m[0] === "execution_interrupted");
  let status: CompletionNotification["status"] = "success";
  if (errorMsg) status = "error";
  else if (interruptMsg) status = "interrupted";

  // Error details
  let error: CompletionNotification["error"];
  if (errorMsg) {
    const d = errorMsg[1] as Record<string, unknown>;
    error = {
      node_id: (d.node_id as string) ?? "",
      node_type: (d.node_type as string) ?? "",
      exception_message: (d.exception_message as string) ?? "",
      traceback: Array.isArray(d.traceback)
        ? d.traceback.join("")
        : undefined,
    };
  }

  // Cached nodes
  const cachedMsg = messages.find((m) => m[0] === "execution_cached");
  const cachedNodes = cachedMsg
    ? ((cachedMsg[1] as { nodes: string[] }).nodes ?? [])
    : [];

  // Output images
  const outputs: CompletionNotification["outputs"] = [];
  for (const [nodeId, nodeOutput] of Object.entries(entry.outputs || {})) {
    const out = nodeOutput as Record<string, unknown>;
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
  }

  return {
    prompt_id: promptId,
    status,
    duration_ms: Math.round(durationMs),
    timestamp: new Date().toISOString(),
    error,
    outputs,
    cached_nodes: cachedNodes,
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
    const notification = buildNotification(promptId, entry, state.startTime);
    await ensureCompletionsDir();
    const filePath = join(COMPLETIONS_DIR, `${promptId}.json`);
    await writeFile(filePath, JSON.stringify(notification, null, 2), "utf-8");
    logger.info("Completion file written", {
      prompt_id: promptId,
      status: notification.status,
      duration_ms: notification.duration_ms,
      images: notification.outputs.reduce((n, o) => n + o.images.length, 0),
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
   */
  watch(promptId: string): void {
    // Don't double-watch
    if (activeWatchers.has(promptId)) {
      logger.warn("Already watching prompt", { prompt_id: promptId });
      return;
    }

    const state: WatcherState = {
      promptId,
      startTime: Date.now(),
      completed: false,
    };
    activeWatchers.set(promptId, state);

    // ── WebSocket track (best-effort) ──
    try {
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
    }, POLL_INTERVAL_MS);

    // ── Timeout ──
    state.timeoutTimer = setTimeout(() => {
      if (!state.completed) {
        logger.warn("Watcher timeout, cleaning up", {
          prompt_id: promptId,
          elapsed_ms: Date.now() - state.startTime,
        });
        cleanup(state);
        activeWatchers.delete(promptId);
      }
    }, WATCHER_TIMEOUT_MS);

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

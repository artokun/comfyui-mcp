import { Client } from "@stable-canvas/comfyui-client";
import { config, getComfyUIApiHost } from "../config.js";
import { logger } from "../utils/logger.js";
import { ConnectionError } from "../utils/errors.js";
import type { ObjectInfo, SystemStats, QueueStatus } from "./types.js";

let clientInstance: Client | null = null;

export function getClient(): Client {
  if (!clientInstance) {
    clientInstance = new Client({
      api_host: getComfyUIApiHost(),
      // Node 22+ provides global WebSocket
    });
    logger.info("ComfyUI client created", {
      host: getComfyUIApiHost(),
    });
  }
  return clientInstance;
}

export async function connectClient(): Promise<Client> {
  const client = getClient();
  try {
    await client.connect();
    logger.info("Connected to ComfyUI via WebSocket");
    return client;
  } catch (err) {
    throw new ConnectionError(
      `Failed to connect to ComfyUI at ${getComfyUIApiHost()}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Ensures WebSocket is connected, auto-reconnecting if stale.
 * Only needed before WebSocket-dependent operations (enqueue with progress tracking).
 */
export async function ensureConnected(): Promise<Client> {
  const client = getClient();

  // If the socket looks healthy, return immediately
  if (!client.closed) {
    return client;
  }

  // Socket is stale — reset and reconnect
  logger.info("WebSocket stale (closed=true), reconnecting...");
  resetClient();

  try {
    return await connectClient();
  } catch {
    // First attempt failed — reset singleton completely and retry once
    logger.warn("Reconnect failed, resetting client and retrying...");
    resetClient();
    try {
      return await connectClient();
    } catch (err) {
      throw new ConnectionError(
        `Failed to reconnect to ComfyUI after retry: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

export async function getSystemStats(): Promise<SystemStats> {
  const client = getClient();
  const stats = await client.getSystemStats();
  return stats as unknown as SystemStats;
}

export async function getObjectInfo(): Promise<ObjectInfo> {
  const client = getClient();
  const info = await client.getNodeDefs();
  return info as unknown as ObjectInfo;
}

export async function getQueue(): Promise<QueueStatus> {
  const client = getClient();
  const queue = await client.getQueue() as Record<string, unknown>;
  return {
    queue_running: (queue.Running ?? queue.queue_running ?? []) as QueueStatus["queue_running"],
    queue_pending: (queue.Pending ?? queue.queue_pending ?? []) as QueueStatus["queue_pending"],
  };
}

export async function interrupt(promptId?: string): Promise<void> {
  const client = getClient();
  await client.interrupt(promptId ?? null);
}

/**
 * Fire-and-forget: enqueue a prompt via HTTP POST (no WebSocket needed).
 * Returns prompt_id and queue position immediately.
 */
export async function enqueuePrompt(
  workflow: Record<string, unknown>,
): Promise<{ prompt_id: string; queue_remaining?: number }> {
  const client = getClient();
  const result = await client._enqueue_prompt(workflow);
  return {
    prompt_id: result.prompt_id,
    queue_remaining: result.exec_info?.queue_remaining,
  };
}

/**
 * Remove a specific pending job from the queue by prompt_id.
 */
export async function deleteQueueItem(id: string): Promise<void> {
  const client = getClient();
  await client.deleteItem("queue", id);
}

/**
 * Clear all pending jobs from the queue (doesn't affect running job).
 */
export async function clearQueue(): Promise<void> {
  const client = getClient();
  await client.clearItems("queue");
}

export async function getSamplers(): Promise<string[]> {
  const client = getClient();
  return client.getSamplers();
}

export async function getSchedulers(): Promise<string[]> {
  const client = getClient();
  return client.getSchedulers();
}

export async function getCheckpoints(): Promise<string[]> {
  const client = getClient();
  return client.getSDModels();
}

export async function getLoRAs(): Promise<string[]> {
  const client = getClient();
  return client.getLoRAs();
}

export async function getVAEs(): Promise<string[]> {
  const client = getClient();
  return client.getVAEs();
}

export async function getUpscaleModels(): Promise<string[]> {
  const client = getClient();
  return client.getUpscaleModels();
}

export function resetClient(): void {
  if (clientInstance) {
    try {
      clientInstance.close();
    } catch {
      // Ignore close errors — process may already be dead
    }
    clientInstance = null;
    logger.info("ComfyUI client reset");
  }
}

export function getComfyUIPath(): string | undefined {
  return config.comfyuiPath;
}

export async function getLogs(): Promise<string[]> {
  const client = getClient();
  const res = await client.fetchApi("/internal/logs");
  const text = await res.text();

  // ComfyUI returns logs as a JSON-encoded string with \n separators,
  // or as raw text depending on version. Handle both.
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") {
      return parsed.split("\n").filter(Boolean);
    }
  } catch {
    // Not JSON — treat as raw text
  }
  return text.split("\n").filter(Boolean);
}

export interface HistoryEntry {
  prompt: Record<string, unknown>;
  outputs: Record<string, unknown>;
  status: {
    status_str: string;
    completed: boolean;
    messages: Array<[string, Record<string, unknown>]>;
  };
  meta?: Record<string, unknown>;
}

export async function getHistory(
  promptId?: string,
): Promise<Record<string, HistoryEntry>> {
  const client = getClient();
  const path = promptId ? `/history/${promptId}` : "/history";
  const res = await client.fetchApi(path);
  return res.json() as Promise<Record<string, HistoryEntry>>;
}

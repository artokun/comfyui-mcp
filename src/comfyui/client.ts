import { Client, HttpError } from "@stable-canvas/comfyui-client";
import { config, getComfyUIApiHost } from "../config.js";
import { logger } from "../utils/logger.js";
import { ConnectionError, WorkflowExecutionError } from "../utils/errors.js";
import type { ObjectInfo, SystemStats, QueueStatus } from "./types.js";

let clientInstance: Client | null = null;

export function getClient(): Client {
  if (!clientInstance) {
    clientInstance = new Client({
      api_host: getComfyUIApiHost(),
      clientId: "comfyui-mcp",
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
  try {
    const result = await client._enqueue_prompt(workflow);
    return {
      prompt_id: result.prompt_id,
      queue_remaining: result.exec_info?.queue_remaining,
    };
  } catch (err) {
    // The library's fetchApi throws HttpError with a generic message but
    // stores ComfyUI's detailed response (node_errors, etc.) in .json
    if (err instanceof HttpError && err.json) {
      const details = err.json as Record<string, unknown>;
      const parts: string[] = [];
      if (details.error) parts.push(String(details.error));
      if (details.node_errors && Object.keys(details.node_errors as object).length > 0) {
        parts.push(`Node errors: ${JSON.stringify(details.node_errors, null, 2)}`);
      }
      throw new WorkflowExecutionError(
        parts.length > 0 ? parts.join("\n") : err.message,
        details,
      );
    }
    throw err;
  }
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

/**
 * Fetch an image from ComfyUI's /view endpoint as a base64 string.
 * Works over HTTP — no local filesystem access needed.
 */
export async function fetchImage(
  filename: string,
  type: "output" | "input" | "temp" = "output",
  subfolder = "",
): Promise<{ base64: string; mimeType: string }> {
  const client = getClient();
  const params = new URLSearchParams({ filename, type, subfolder });
  const res = await client.fetchApi(`/view?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`ComfyUI /view returned ${res.status} for "${filename}"`);
  }
  const contentType = res.headers.get("content-type") ?? "image/png";
  const mimeType = contentType.split(";")[0].trim();
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return { base64, mimeType };
}

/**
 * Upload an image to ComfyUI's input/ directory via HTTP multipart POST.
 * Works over HTTP — no local filesystem access needed.
 */
export async function uploadImageHttp(
  filename: string,
  data: Buffer,
  mimeType = "image/png",
): Promise<{ name: string; subfolder: string; type: string }> {
  const client = getClient();
  const formData = new FormData();
  const blob = new Blob([data], { type: mimeType });
  formData.append("image", blob, filename);
  formData.append("type", "input");
  formData.append("overwrite", "true");
  const res = await client.fetchApi("/upload/image", {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ComfyUI /upload/image returned ${res.status}: ${text}`);
  }
  return res.json() as Promise<{ name: string; subfolder: string; type: string }>;
}

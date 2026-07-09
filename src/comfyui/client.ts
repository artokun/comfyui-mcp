import { Client } from "@stable-canvas/comfyui-client";
import {
  config,
  getComfyUIApiHost,
  getComfyUIBasePath,
  getComfyUIBaseUrl,
  isCloudMode,
  isRemoteMode,
} from "../config.js";
import { logger } from "../utils/logger.js";
import { ComfyUIError, ConnectionError } from "../utils/errors.js";
import { comfyuiFetch } from "./fetch.js";
import * as cloudClient from "./cloud-client.js";
import type { ObjectInfo, SystemStats, QueueStatus } from "./types.js";

// Functions that fundamentally require a local ComfyUI process (WebSocket-bound
// session, local `client.fetchApi` paths, etc.) throw via this guard when the
// server is configured for Comfy Cloud — there is no WebSocket to attach to
// and no local socket to call. Dispatcher pattern from @picoSols
// (picoSols/comfyui-cloud-mcp@7a812069).
function requireLocalMode(op: string): void {
  if (isCloudMode()) {
    throw new ComfyUIError(
      `This tool needs a direct ComfyUI session (${op}) and is not available in Comfy Cloud mode. ` +
        `Unset COMFYUI_API_KEY to target a local or remote ComfyUI instance.`,
      "CLOUD_UNSUPPORTED",
    );
  }
}

/**
 * Assert that we are in pure local mode (not cloud, not remote) and that
 * `config.comfyuiPath` is available. Unlike `requireLocalMode` which only
 * blocks cloud mode, this also throws when `--comfyui-url` points at a
 * non-loopback host (remote mode). Tools that spawn OS processes or read/write
 * the local ComfyUI filesystem MUST call this guard.
 */
function requireLocalComfyUI(op: string): void {
  requireLocalMode(op);
  if (isRemoteMode()) {
    throw new ComfyUIError(
      `This operation (${op}) requires a local ComfyUI installation and is not available ` +
        `when targeting a remote instance via --comfyui-url. Unset --comfyui-url or ` +
        `point it at a local address to use this tool.`,
      "REMOTE_UNSUPPORTED",
    );
  }
  if (!config.comfyuiPath) {
    throw new ComfyUIError(
      `This operation (${op}) requires a local ComfyUI installation but COMFYUI_PATH ` +
        `is not set. Set the COMFYUI_PATH environment variable to the ComfyUI root directory.`,
      "NO_LOCAL_PATH",
    );
  }
}

let clientInstance: Client | null = null;

export function getClient(): Client {
  requireLocalMode("getClient");
  if (!clientInstance) {
    clientInstance = new Client({
      api_host: getComfyUIApiHost(),
      // Path prefix for reverse-proxied / gateway'd ComfyUI (e.g. "/comfyapi").
      api_base: getComfyUIBasePath(),
      ssl: config.comfyuiSsl,
      clientId: "comfyui-mcp",
      // Inject generic auth headers (COMFYUI_AUTH_*) on the library's own HTTP
      // calls; a no-op when unset. Node 22+ provides global WebSocket.
      fetch: comfyuiFetch,
    });
    logger.info("ComfyUI client created", {
      host: getComfyUIApiHost(),
    });
  }
  return clientInstance;
}

export async function connectClient(): Promise<Client> {
  requireLocalMode("connectClient");
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
  requireLocalMode("ensureConnected");
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
  if (isCloudMode()) return cloudClient.getSystemStats();
  const client = getClient();
  const stats = await client.getSystemStats();
  return stats as unknown as SystemStats;
}

// /object_info is large (~MBs) and slow (300-800 ms) but only changes when
// ComfyUI restarts or a custom node is (un)installed. Memoize it for the
// life of the server process; restartComfyUI()/stopComfyUI() reset it.
// In-flight coalescing prevents a thundering herd on the first fetch.
// Perf gap flagged by josephoibrahim/comfy-cozy (re-validate ~7 s → ~0.5 s).
let objectInfoCache: ObjectInfo | null = null;
let objectInfoInflight: Promise<ObjectInfo> | null = null;

export async function getObjectInfo(): Promise<ObjectInfo> {
  if (isCloudMode()) return cloudClient.getObjectInfo();
  if (objectInfoCache) return objectInfoCache;
  if (objectInfoInflight) return objectInfoInflight;

  objectInfoInflight = (async () => {
    const client = getClient();
    const info = (await client.getNodeDefs()) as unknown as ObjectInfo;
    objectInfoCache = info;
    return info;
  })();

  try {
    return await objectInfoInflight;
  } finally {
    objectInfoInflight = null;
  }
}

/**
 * Drop the memoized /object_info so the next call refetches. Called after
 * ComfyUI restarts (node packs may have changed) and available for tools
 * that mutate the node set mid-session.
 */
export function resetObjectInfoCache(): void {
  objectInfoCache = null;
  logger.debug("object_info cache reset");
}

/**
 * Some custom nodes register individually (`/object_info/<Type>` returns a schema)
 * but are absent from the bulk `/object_info` response — seen with controlnet_aux's
 * `DWPreprocessor`. The converter would then skip the node and silently drop its
 * connections. Backfill the schemas for the given node types missing from
 * `objectInfo` by fetching each one individually, and return a merged copy.
 */
export async function backfillObjectInfo(
  objectInfo: ObjectInfo,
  nodeTypes: string[],
): Promise<ObjectInfo> {
  if (isCloudMode()) return objectInfo;
  const oi = objectInfo as unknown as Record<string, unknown>;
  const missing = [...new Set(nodeTypes)].filter((t) => t && !(t in oi));
  if (missing.length === 0) return objectInfo;

  const base = `${getComfyUIBaseUrl()}/object_info`;
  const merged = { ...oi };
  await Promise.all(
    missing.map(async (t) => {
      try {
        const res = await comfyuiFetch(`${base}/${encodeURIComponent(t)}`);
        if (!res.ok) return;
        const def = (await res.json()) as Record<string, unknown>;
        if (def && def[t]) {
          merged[t] = def[t];
          logger.info(`Backfilled object_info for '${t}' (missing from bulk /object_info)`);
        }
      } catch {
        // Leave it missing — the converter skips + warns as before.
      }
    }),
  );
  return merged as unknown as ObjectInfo;
}

export async function getQueue(): Promise<QueueStatus> {
  if (isCloudMode()) return cloudClient.getQueue();
  const client = getClient();
  const queue = await client.getQueue() as Record<string, unknown>;
  return {
    queue_running: (queue.Running ?? queue.queue_running ?? []) as QueueStatus["queue_running"],
    queue_pending: (queue.Pending ?? queue.queue_pending ?? []) as QueueStatus["queue_pending"],
  };
}

export async function interrupt(promptId?: string): Promise<void> {
  if (isCloudMode()) return cloudClient.interrupt(promptId);
  const client = getClient();
  await client.interrupt(promptId ?? null);
}

/**
 * POST /free — unload resident models and/or free cached memory. Used by
 * clear_vram and by the cancel escalation (a wedged sampler step can ignore an
 * interrupt; freeing VRAM under it sometimes shakes it loose). No-op on cloud.
 */
export async function freeMemory(opts: { unload_models?: boolean; free_memory?: boolean }): Promise<void> {
  if (isCloudMode()) return;
  const client = getClient();
  await client.fetchApi("/free", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      unload_models: !!opts.unload_models,
      free_memory: !!opts.free_memory,
    }),
  });
}

/**
 * Fire-and-forget: enqueue a prompt via HTTP POST (no WebSocket needed).
 * Returns prompt_id and queue position immediately.
 */
export async function enqueuePrompt(
  workflow: Record<string, unknown>,
  extraData?: Record<string, unknown>,
  opts?: { front?: boolean },
): Promise<{ prompt_id: string; queue_remaining?: number }> {
  if (isCloudMode()) return cloudClient.enqueuePrompt(workflow, extraData);
  const client = getClient();

  // The SDK's _enqueue_prompt does not forward `extra_data`, which is how
  // comfy.org API-node credentials (api_key_comfy_org / auth_token_comfy_org)
  // must travel to the server. It also cannot enqueue at the front. When either
  // is needed, POST /prompt directly.
  if ((extraData && Object.keys(extraData).length > 0) || opts?.front) {
    const url = `${getComfyUIBaseUrl()}/prompt`;
    const res = await comfyuiFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: workflow,
        client_id: "comfyui-mcp",
        ...(extraData ? { extra_data: extraData } : {}),
        ...(opts?.front ? { front: true } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ConnectionError(
        `ComfyUI /prompt returned ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
      );
    }
    const data = (await res.json()) as { prompt_id: string; number?: number };
    return { prompt_id: data.prompt_id, queue_remaining: data.number };
  }

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
  if (isCloudMode()) return cloudClient.deleteQueueItem(id);
  const client = getClient();
  await client.deleteItem("queue", id);
}

/**
 * Clear all pending jobs from the queue (doesn't affect running job).
 */
export async function clearQueue(): Promise<void> {
  if (isCloudMode()) return cloudClient.clearQueue();
  const client = getClient();
  await client.clearItems("queue");
}

export async function getSamplers(): Promise<string[]> {
  if (isCloudMode()) return cloudClient.getSamplers();
  const client = getClient();
  return client.getSamplers();
}

export async function getSchedulers(): Promise<string[]> {
  if (isCloudMode()) return cloudClient.getSchedulers();
  const client = getClient();
  return client.getSchedulers();
}

export async function getCheckpoints(): Promise<string[]> {
  if (isCloudMode()) return cloudClient.getCheckpoints();
  const client = getClient();
  return client.getSDModels();
}

export async function getLoRAs(): Promise<string[]> {
  if (isCloudMode()) return cloudClient.getLoRAs();
  const client = getClient();
  return client.getLoRAs();
}

export async function getVAEs(): Promise<string[]> {
  if (isCloudMode()) return cloudClient.getVAEs();
  const client = getClient();
  return client.getVAEs();
}

export async function getUpscaleModels(): Promise<string[]> {
  if (isCloudMode()) return cloudClient.getUpscaleModels();
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
  if (isCloudMode()) return cloudClient.getComfyUIPath();
  return config.comfyuiPath;
}

export async function getLogs(): Promise<string[]> {
  if (isCloudMode()) return cloudClient.getLogs();
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

/**
 * ComfyUI frontend per-user settings, served by the frontend user manager:
 *   GET  /settings         → every stored setting as one JSON object
 *   GET  /settings/{id}    → one setting's raw stored value
 *   POST /settings/{id}    → persist one setting (JSON body is the raw value)
 *
 * These are the ComfyUI *frontend* UI settings (`Comfy.*` ids) and are entirely
 * unrelated to our own get_defaults/set_defaults SQLite store. Local and remote
 * (`--comfyui-url`) both work over plain REST and inherit `comfyuiFetch` auth
 * headers. Comfy Cloud exposes no per-user settings store, so these throw
 * CLOUD_UNSUPPORTED via `requireLocalMode`.
 *
 * Multi-user note: a `--multi-user` ComfyUI keys settings by a `comfy-user`
 * header; set `COMFYUI_AUTH_COMFY_USER` (any COMFYUI_AUTH_* header is injected
 * by `comfyuiFetch`) or requests may 404 or read/write another user's store.
 */
function settingsVersionDriftError(): ComfyUIError {
  return new ComfyUIError(
    "This ComfyUI version/config does not expose the user settings API " +
      "(requires the standard frontend user manager). If this is a --multi-user " +
      "server, set COMFYUI_AUTH_COMFY_USER so requests carry a comfy-user header.",
    "SETTINGS_UNSUPPORTED",
  );
}

/** GET /settings — every stored frontend setting as a raw `id: value` object. */
export async function getSettings(): Promise<Record<string, unknown>> {
  requireLocalMode("settings");
  const client = getClient();
  const res = await client.fetchApi("/settings");
  if (res.status === 404) throw settingsVersionDriftError();
  const text = await res.text();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON body — fall through to empty.
  }
  return {};
}

/**
 * GET /settings/{id} — one setting's raw stored value. Returns `undefined` for
 * an unset key: ComfyUI returns an empty body or `null` for unset ids on
 * different versions, and some builds 404 the per-id route, so empty / `null` /
 * 404 / parse-failure are all treated uniformly as "unset (frontend default
 * applies)". Stored values are passed through verbatim — never coerced, so an
 * older frontend's `"true"` string surfaces as a string.
 */
export async function getSetting(id: string): Promise<unknown> {
  requireLocalMode("settings");
  const client = getClient();
  const res = await client.fetchApi(`/settings/${encodeURIComponent(id)}`);
  if (res.status === 404) return undefined;
  const text = await res.text();
  if (text.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed === null ? undefined : parsed;
  } catch {
    return undefined;
  }
}

/**
 * POST /settings/{id} — persist one setting. The value is sent as-is (raw JSON
 * body); it is stored verbatim and never coerced. A 404 here means the settings
 * route is absent (version drift), not an unknown id — unknown ids are stored
 * verbatim and ignored by the UI.
 */
export async function setSetting(id: string, value: unknown): Promise<void> {
  requireLocalMode("settings");
  const client = getClient();
  const res = await client.fetchApi(`/settings/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (res.status === 404) throw settingsVersionDriftError();
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ConnectionError(
      `ComfyUI /settings/${id} returned ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
    );
  }
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
  if (isCloudMode()) return cloudClient.getHistory(promptId);
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
  if (isCloudMode()) return cloudClient.fetchImage(filename, type, subfolder);
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
  if (isCloudMode()) return cloudClient.uploadImageHttp(filename, data, mimeType);
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

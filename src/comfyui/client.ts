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
import { ComfyUIError, ConnectionError, WorkflowExecutionError } from "../utils/errors.js";
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
// ComfyUI restarts or a custom node is (un)installed. Memoize it, but only for a
// bounded FRESHNESS WINDOW rather than the whole process lifetime: an out-of-band
// ComfyUI restart/install (Desktop Manager reboot, a manual restart, a node pack
// installed outside an mcp tool) never calls resetObjectInfoCache(), so a
// lifetime cache serves the PRE-restart schema forever — get_node_info /
// check_workflow_runtime / validate_workflow all report the new nodes as unknown
// (#528). A TTL bounds that staleness: within the window we serve the cached
// snapshot (so a burst of validations stays ~0.5 s, the perf win flagged by
// josephoibrahim/comfy-cozy), and the FIRST call after the window does a single
// coalesced refetch that picks up whatever the live server now exposes. No cheap
// per-call probe is added — ComfyUI's /object_info has no ETag/Last-Modified and
// no node-set-identity endpoint, so a TTL is the lightest mechanism that both
// self-heals after an out-of-band change and never fetches the heavy payload on
// every call. Managed restart/install paths still call resetObjectInfoCache() for
// an immediate refresh; the TTL is the backstop for the out-of-band case.
//
// Override with COMFYUI_MCP_OBJECT_INFO_TTL_MS (0 disables caching entirely; a
// large value restores the old lifetime behavior for latency-sensitive setups).
const OBJECT_INFO_TTL_MS = (() => {
  const raw = process.env.COMFYUI_MCP_OBJECT_INFO_TTL_MS;
  if (raw === undefined || raw.trim() === "") return 30_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
})();

let objectInfoCache: ObjectInfo | null = null;
let objectInfoCachedAt = 0;
let objectInfoInflight: Promise<ObjectInfo> | null = null;
// Invalidation epoch. resetObjectInfoCache() bumps it; a fetch that STARTED under
// an older epoch must not commit its result to the cache — otherwise a request
// in flight when a restart invalidates the cache can resolve afterward and
// repopulate it with the PRE-restart schema, and future callers would await that
// stale value (codex WS-3 finding #1).
let objectInfoEpoch = 0;

function objectInfoCacheFresh(): boolean {
  if (objectInfoCache === null) return false;
  const age = Date.now() - objectInfoCachedAt;
  // A NEGATIVE age means the system clock moved backward since we cached (manual
  // correction, VM snapshot restore, NTP step). Without this guard the snapshot
  // would read "fresh" until wall time catches back up — a 1 h rollback would
  // extend a 30 s TTL by ~an hour, so an out-of-band restart stays stale far past
  // the window (#528 review P2). Treat a backward jump as EXPIRED: the next call
  // refetches and re-stamps objectInfoCachedAt against the corrected clock, so
  // normal within-window caching resumes immediately after the single refetch.
  return age >= 0 && age < OBJECT_INFO_TTL_MS;
}

export async function getObjectInfo(): Promise<ObjectInfo> {
  if (isCloudMode()) return cloudClient.getObjectInfo();
  // Serve from cache only while still inside the freshness window; once it lapses
  // we fall through to a refetch so an out-of-band restart/install is picked up.
  if (objectInfoCacheFresh()) return objectInfoCache as ObjectInfo;
  if (objectInfoInflight) return objectInfoInflight;

  const startEpoch = objectInfoEpoch;
  // Commit to the shared cache ONLY if no invalidation happened while we were
  // fetching. Awaiters of this promise still get the value (they asked before
  // the reset), but the cache is not poisoned for callers that arrive after.
  const commit = (info: ObjectInfo): ObjectInfo => {
    if (objectInfoEpoch === startEpoch) {
      objectInfoCache = info;
      objectInfoCachedAt = Date.now();
    }
    return info;
  };

  const inflight = (async () => {
    // Capture the client this request runs on so the catch only resets THIS one.
    const startClient = getClient();
    try {
      return commit((await startClient.getNodeDefs()) as unknown as ObjectInfo);
    } catch (err) {
      // A managed restart/reboot leaves the cached client bound to a socket that
      // was torn down, so the first call after it surfaces a bare "fetch failed"
      // (issue #376). Drop the stale client and retry once against a fresh one
      // before giving up — this is exactly the reconnect the caller expects.
      // Only reset if OUR client is still current: a concurrent reset may have
      // already installed a newer client we must not close.
      logger.warn("getObjectInfo failed; resetting client and retrying once", {
        error: err instanceof Error ? err.message : String(err),
      });
      resetClientIfCurrent(startClient);
      return commit((await getClient().getNodeDefs()) as unknown as ObjectInfo);
    }
  })();
  objectInfoInflight = inflight;

  try {
    return await inflight;
  } finally {
    // Only clear the shared slot if it's still ours — a concurrent reset may have
    // already abandoned it and a newer fetch may have taken the slot.
    if (objectInfoInflight === inflight) objectInfoInflight = null;
  }
}

/**
 * Drop the memoized /object_info so the next call refetches. Called after
 * ComfyUI restarts (node packs may have changed) and available for tools
 * that mutate the node set mid-session. Bumps the invalidation epoch and
 * abandons any in-flight fetch so a fetch started before the reset can never
 * commit a pre-restart result to the cache.
 */
export function resetObjectInfoCache(): void {
  objectInfoCache = null;
  objectInfoCachedAt = 0;
  objectInfoInflight = null;
  objectInfoEpoch++;
  logger.debug("object_info cache reset", { epoch: objectInfoEpoch });
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
        if (!def || typeof def !== "object") return;
        // `/object_info/<Type>` returns the schema keyed by the node's LIVE
        // registration name — which can differ from the string we asked for in
        // case, namespace prefix, or display-vs-class name (#404,
        // `DetectorForNSFW`). Honor whatever key(s) ComfyUI actually returns
        // rather than narrowing to an exact `def[t]` match (which silently
        // dropped the node and made get_node_info report "no match" for a node
        // the server clearly registers). Prefer the exact key when present,
        // otherwise merge every returned definition.
        if (def[t]) {
          merged[t] = def[t];
          logger.info(`Backfilled object_info for '${t}' (missing from bulk /object_info)`);
        } else {
          const keys = Object.keys(def);
          if (keys.length === 0) return;
          for (const k of keys) merged[k] = def[k];
          logger.info(
            `Backfilled object_info for '${t}' under live registration key(s) [${keys.join(", ")}] (missing from bulk /object_info)`,
          );
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

  // POST /prompt directly (rather than the SDK's _enqueue_prompt) for two
  // reasons: (1) the SDK does not forward `extra_data` — how comfy.org API-node
  // credentials must travel — nor can it enqueue at the front; and (2) on an
  // HTTP 400 the SDK throws a generic "Endpoint Bad Request" that discards
  // ComfyUI's authoritative prompt-validation body (`node_errors`), so callers
  // never learn which node/input was invalid (#485). Going direct lets us read
  // and surface that body. `comfyuiFetch` applies the same auth headers the SDK
  // would (CF Access / COMFYUI_AUTH_*).
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
    throw await buildEnqueueError(res);
  }
  const data = (await res.json()) as { prompt_id: string; number?: number };
  // NB: `data.number` is ComfyUI's monotonic priority counter (and is NEGATIVE
  // for front-inserted jobs) — NOT the remaining queue depth. The old SDK path
  // returned exec_info.queue_remaining; to preserve an accurate count now that
  // we POST directly, read /queue for the authoritative running+pending total.
  // Fall back to undefined (never the misleading counter) if that read fails.
  return { prompt_id: data.prompt_id, queue_remaining: await queueRemainingCount() };
}

/**
 * Authoritative "jobs still in the queue" count (running + pending) via a direct
 * /queue read. Returns undefined if the queue can't be read, so callers never
 * surface ComfyUI's monotonic `number` counter as a remaining-count. Only
 * reachable on the local/remote path — enqueuePrompt returns early in cloud mode.
 */
async function queueRemainingCount(): Promise<number | undefined> {
  try {
    const res = await comfyuiFetch(`${getComfyUIBaseUrl()}/queue`);
    if (!res.ok) return undefined;
    const q = (await res.json()) as {
      queue_running?: unknown[];
      queue_pending?: unknown[];
      Running?: unknown[];
      Pending?: unknown[];
    };
    const running = (q.queue_running ?? q.Running ?? []).length;
    const pending = (q.queue_pending ?? q.Pending ?? []).length;
    return running + pending;
  } catch {
    return undefined;
  }
}

/**
 * Turn a non-OK /prompt response into a rich error. On the HTTP 400 that
 * ComfyUI returns when prompt validation fails, the JSON body carries the
 * authoritative diagnosis:
 *   {
 *     error: { type, message, details, extra_info },
 *     node_errors: { "<id>": { class_type, errors: [{ message, details, ... }] } }
 *   }
 * We format the top-level message plus one line per offending node
 * (`ClassType (node <id>): <message>`), and stash the raw payload in `details`.
 * Falls back to the generic HTTP status only when the body is empty or is not
 * the expected validation JSON (#485).
 */
async function buildEnqueueError(res: Response): Promise<ComfyUIError> {
  const bodyText = await res.text().catch(() => "");
  const generic = `ComfyUI /prompt returned ${res.status} ${res.statusText}`;

  let parsed: unknown;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    parsed = undefined;
  }

  if (parsed && typeof parsed === "object") {
    const payload = parsed as {
      error?: { message?: string; details?: string };
      node_errors?: Record<
        string,
        { class_type?: string; errors?: Array<{ message?: string; details?: string }> }
      >;
    };
    const nodeErrors = payload.node_errors ?? {};
    const lines: string[] = [];
    for (const [nodeId, info] of Object.entries(nodeErrors)) {
      const cls = info?.class_type ?? "node";
      const errs = Array.isArray(info?.errors) ? info.errors : [];
      if (errs.length === 0) {
        lines.push(`- ${cls} (node ${nodeId}): validation failed`);
        continue;
      }
      for (const e of errs) {
        const detail = e?.details ? ` (${e.details})` : "";
        lines.push(`- ${cls} (node ${nodeId}): ${e?.message ?? "validation failed"}${detail}`);
      }
    }

    const headline = payload.error?.message
      ? `ComfyUI rejected the workflow (${res.status}): ${payload.error.message}`
      : `ComfyUI rejected the workflow (${res.status})`;

    if (lines.length > 0 || payload.error?.message) {
      const message =
        lines.length > 0 ? `${headline}\n${lines.join("\n")}` : headline;
      return new WorkflowExecutionError(message, {
        status: res.status,
        error: payload.error,
        node_errors: nodeErrors,
      });
    }
  }

  // Empty or unexpected body: fall back to the generic HTTP status, but keep
  // any raw text so nothing is silently dropped.
  return new ConnectionError(
    bodyText ? `${generic}: ${bodyText.slice(0, 500)}` : generic,
  );
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

/**
 * Reset the singleton ONLY if it is still the client the caller was using. A
 * failing request captures its client at start and passes it here in its catch;
 * if a concurrent reset (resetObjectInfoCache abandons the in-flight slot) already
 * spun up a NEW client in the meantime, we must not close that newer client + its
 * fresh WebSocket out from under whoever created it (codex WS-3 round-2 finding).
 * Returns true if it actually reset. A null argument never resets.
 */
export function resetClientIfCurrent(client: Client | null): boolean {
  if (!client || clientInstance !== client) return false;
  resetClient();
  return true;
}

export function getComfyUIPath(): string | undefined {
  if (isCloudMode()) return cloudClient.getComfyUIPath();
  return config.comfyuiPath;
}

export async function getLogs(): Promise<string[]> {
  if (isCloudMode()) return cloudClient.getLogs();

  // A managed/panel restart or Manager reboot leaves the cached client bound to
  // a socket that was torn down, so the first /internal/logs call after it
  // surfaces a bare "fetch failed" (issue #399) — regardless of any keyword the
  // caller passed, since filtering happens after this fetch. Mirror the
  // getObjectInfo reset-and-retry: drop the stale client and retry once against
  // a fresh one before giving up, and surface the underlying error if it still
  // fails so callers see more than "fetch failed".
  let text: string;
  // Capture the client this request runs on so the catch only resets THIS one
  // (not a newer client a concurrent reset may have installed).
  const startClient = getClient();
  try {
    text = await startClient.fetchApi("/internal/logs").then((r) => r.text());
  } catch (err) {
    logger.warn("getLogs failed; resetting client and retrying once", {
      error: err instanceof Error ? err.message : String(err),
    });
    resetClientIfCurrent(startClient);
    try {
      text = await getClient().fetchApi("/internal/logs").then((r) => r.text());
    } catch (err2) {
      const detail = err2 instanceof Error ? err2.message : String(err2);
      throw new ConnectionError(
        `Failed to fetch ComfyUI logs after reconnect retry: ${detail}`,
      );
    }
  }

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
    const where = subfolder ? `${type}/${subfolder}` : type;
    throw new ComfyUIError(
      `ComfyUI /view returned ${res.status} for "${filename}" (${where}). ` +
        (res.status === 404
          ? `No such file in the ComfyUI ${type} directory` +
            (subfolder ? ` under subfolder "${subfolder}"` : "") +
            `. Check the filename/subfolder (e.g. via list_output_images or get_history).`
          : `The ComfyUI server rejected the request.`),
      res.status === 404 ? "IMAGE_NOT_FOUND" : "VIEW_ERROR",
      { status: res.status, filename, type, subfolder },
    );
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

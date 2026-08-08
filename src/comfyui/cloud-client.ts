// Comfy Cloud client — mirrors the surface of ./client.ts (`getSystemStats`,
// `getQueue`, `enqueuePrompt`, `getHistory`, `interrupt`, `fetchImage`,
// `uploadImageHttp`, etc.) but talks to https://cloud.comfy.org over HTTPS
// authenticated with `X-API-Key`. WebSocket / `/internal/logs` /
// `/object_info` have no cloud equivalents — those throw `CLOUD_UNSUPPORTED`
// so callers can degrade gracefully.
//
// Architecture (isCloudMode() dispatch + parallel cloud-client.ts) was
// originally shipped by @picoSols in `picoSols/comfyui-cloud-mcp@7a812069`
// (2026-03-25). This is a port adapted to our config helpers + error types,
// with `fetchImage` / `uploadImageHttp` added so our existing image tools
// keep working in cloud mode.

import { getApiKey, getCloudUrl } from "../config.js";
// Shared with the headless client on purpose: one ceiling, one delivery-doubt
// rule. The cloud client is a parallel implementation, and the last two rounds of
// hardening (the 0.50.11 timeout ceiling, the delivery-doubt disclosure) reached
// only its twin — which is exactly how a parallel implementation rots.
import {
  comfyHttpTimeoutSeconds,
  defaultComfyTimeoutSignal,
  deliveryDoubt,
  isTimeoutAbort,
} from "./fetch.js";
import { ComfyUIError, ConnectionError, describeFetchFailure } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { HistoryEntry } from "./client.js";
import type { ObjectInfo, QueueStatus, SystemStats } from "./types.js";

function cloudUrl(path: string): string {
  const base = getCloudUrl().replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "X-API-Key": getApiKey(), ...extra };
}

async function cloudFetch(
  path: string,
  init?: RequestInit & { skipJsonContentType?: boolean },
): Promise<Response> {
  const url = cloudUrl(path);
  const baseHeaders: Record<string, string> = init?.skipJsonContentType
    ? {}
    : { "Content-Type": "application/json" };
  const headers = {
    ...authHeaders(baseHeaders),
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  const method = String(init?.method ?? "GET").toUpperCase();
  // A CEILING, not a policy — the same one comfyuiFetch got in 0.50.11, which this
  // client never inherited. Without it a cloud request that never answers hangs the
  // tool call forever: no timeout, no error, nothing for the caller to act on. A
  // caller's own signal always wins.
  const signal = init?.signal ?? defaultComfyTimeoutSignal();
  try {
    const res = await fetch(url, { ...init, headers, signal });
    if (!res.ok) {
      // unknown-ok: "" is interpolated into an ERROR MESSAGE and nothing else — the
      // HTTP status is reported either way, so an unreadable body costs detail in the
      // text, never a wrong conclusion. Verified there is no branch on this value.
      const body = await res.text().catch(() => "");
      throw new ComfyUIError(
        `Cloud API error: ${res.status} ${res.statusText} — ${body.slice(0, 500)}`,
        "CLOUD_API_ERROR",
        { url, status: res.status },
      );
    }
    return res;
  } catch (err) {
    if (err instanceof ComfyUIError) throw err;
    // Our own ceiling firing is not the same event as a caller's abort, and must
    // not be reported as one. Only rewrite when WE supplied the signal.
    if (init?.signal === undefined && isTimeoutAbort(err)) {
      throw new ConnectionError(
        `No reply from Comfy Cloud within ${comfyHttpTimeoutSeconds()}s — while requesting ` +
          `${url} (${method}).` +
          deliveryDoubt(undefined, method) +
          ` Raise COMFYUI_MCP_HTTP_TIMEOUT_S if the cloud is simply slow.`,
      );
    }
    // "Failed to reach" was a claim, not an observation. A transport error on a
    // POST to /api/prompt does not establish that the submission never landed —
    // and a blind retry there bills a SECOND cloud render. Same three states as
    // the headless client: delivered, definitely not delivered, unknown.
    const { message, code } = describeFetchFailure(err);
    const wrapped = new ConnectionError(
      `Could not complete the ${method} to Comfy Cloud at ${url}: ${message}.` +
        deliveryDoubt(code, method),
    );
    if (code) (wrapped as { code?: string }).code = code;
    throw wrapped;
  }
}

export interface CloudJobStatus {
  status: "pending" | "in_progress" | "completed" | "failed";
  prompt_id?: string;
  error?: string;
}

export async function enqueuePrompt(
  workflow: Record<string, unknown>,
  extraData?: Record<string, unknown>,
): Promise<{ prompt_id: string; queue_remaining?: number }> {
  logger.info("Cloud: submitting workflow to Comfy Cloud");
  const body: Record<string, unknown> = { prompt: workflow };
  if (extraData && Object.keys(extraData).length > 0) {
    body.extra_data = extraData;
  }
  const res = await cloudFetch("/api/prompt", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { prompt_id: string; number?: number };
  logger.info("Cloud: workflow submitted", { prompt_id: data.prompt_id });
  return { prompt_id: data.prompt_id, queue_remaining: data.number };
}

export async function getHistory(
  promptId?: string,
): Promise<Record<string, HistoryEntry>> {
  if (!promptId) {
    logger.warn("Cloud: getHistory() without prompt_id returns {} (no global history endpoint)");
    return {};
  }
  const res = await cloudFetch(`/api/history_v2/${promptId}`);
  const data = await res.json();
  if (data && typeof data === "object") {
    if ((data as Record<string, unknown>)[promptId]) {
      return data as Record<string, HistoryEntry>;
    }
    return { [promptId]: data as HistoryEntry };
  }
  return {};
}

/** HTTP statuses that mean "this cloud has no such endpoint" rather than "the
 *  request failed". Only these may fall back to the placeholder. */
const ENDPOINT_ABSENT_STATUSES = new Set([404, 405, 501]);

/**
 * #1070 — the catch here used to swallow EVERYTHING and return an invented
 * device, so an expired API key, a 402, a DNS failure, a timeout and a network
 * partition all came back looking like a successful health check.
 *
 * That mattered more than a mislabelled outcome usually does, for two reasons.
 * `get_system_stats (action:"health")` is the remedy our own error messages send
 * people to — it is named in describeComfyFetchFailure, in the timeout text, and
 * in this file's messages — so in cloud mode the remedy could not return a
 * negative result. And health-check.ts / local-models-fallback.ts both call this
 * as a REACHABILITY PROBE, which the placeholder answered "yes" to unconditionally.
 *
 * It also fabricated data rather than merely mislabelling it: `vram_total: 0` is
 * not a reading, and a caller sizing a job against it is reading an invention.
 *
 * Three states now, not two:
 *   - answered              → return what the endpoint said
 *   - endpoint ABSENT (404) → the placeholder, which is the case this was written
 *                             for, but named so a reader can see it is not a reading
 *   - could not ask         → propagate, because that is a real failure
 */
export async function getSystemStats(): Promise<SystemStats> {
  try {
    const res = await cloudFetch("/system_stats");
    return (await res.json()) as unknown as SystemStats;
  } catch (err) {
    const status =
      err instanceof ComfyUIError && err.details && typeof err.details === "object"
        ? (err.details as { status?: unknown }).status
        : undefined;
    if (typeof status !== "number" || !ENDPOINT_ABSENT_STATUSES.has(status)) {
      // Auth, billing, transport, timeout — a real failure. The caller asked
      // whether the cloud is reachable; inventing a GPU is not an answer.
      throw err;
    }
    logger.info("Cloud: /system_stats not implemented by this cloud, returning placeholder", {
      status,
    });
    return {
      system: {
        os: "cloud",
        python_version: "cloud",
        embedded_python: false,
        comfyui_version: "cloud",
      },
      devices: [
        {
          // Named, not silent: these are placeholders, not measurements. The
          // "Comfy Cloud GPU" prefix is kept so anything matching on it still does.
          name: "Comfy Cloud GPU (no stats endpoint — values below are placeholders, not readings)",
          type: "cloud",
          index: 0,
          vram_total: 0,
          vram_free: 0,
          torch_vram_total: 0,
          torch_vram_free: 0,
        },
      ],
    };
  }
}

export async function getQueue(): Promise<QueueStatus> {
  return { queue_running: [], queue_pending: [] };
}

export async function interrupt(promptId?: string): Promise<void> {
  if (!promptId) {
    throw new ComfyUIError(
      "Cancel requires a prompt_id in Comfy Cloud mode (no concept of 'current job').",
      "CLOUD_UNSUPPORTED",
    );
  }
  await cloudFetch(`/api/job/${promptId}/cancel`, { method: "POST" });
  logger.info("Cloud: job cancelled", { prompt_id: promptId });
}

export async function deleteQueueItem(_id: string): Promise<void> {
  throw new ComfyUIError(
    "delete_queue_item is not supported in Comfy Cloud mode. Use queue (action:\"cancel\") with a prompt_id.",
    "CLOUD_UNSUPPORTED",
  );
}

export async function clearQueue(): Promise<void> {
  throw new ComfyUIError(
    "queue (action:\"clear\") is not supported in Comfy Cloud mode.",
    "CLOUD_UNSUPPORTED",
  );
}

export async function getJobStatus(promptId: string): Promise<CloudJobStatus> {
  const res = await cloudFetch(`/api/job/${promptId}/status`);
  return (await res.json()) as CloudJobStatus;
}

export async function getObjectInfo(): Promise<ObjectInfo> {
  throw new ComfyUIError(
    "create_workflow (action:\"node_info\"), which reads /object_info, is not available in Comfy Cloud mode.",
    "CLOUD_UNSUPPORTED",
  );
}

const COMMON_SAMPLERS = [
  "euler", "euler_ancestral", "heun", "heunpp2", "dpm_2", "dpm_2_ancestral",
  "lms", "dpm_fast", "dpm_adaptive", "dpmpp_2s_ancestral", "dpmpp_sde",
  "dpmpp_sde_gpu", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_2m_sde_gpu",
  "dpmpp_3m_sde", "dpmpp_3m_sde_gpu", "ddpm", "lcm", "ddim", "uni_pc",
  "uni_pc_bh2",
];

const COMMON_SCHEDULERS = [
  "normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform",
  "beta",
];

export async function getSamplers(): Promise<string[]> {
  return [...COMMON_SAMPLERS];
}

export async function getSchedulers(): Promise<string[]> {
  return [...COMMON_SCHEDULERS];
}

export async function getCheckpoints(): Promise<string[]> {
  throw new ComfyUIError(
    "Listing local checkpoints is not supported in Comfy Cloud mode.",
    "CLOUD_UNSUPPORTED",
  );
}

export async function getLoRAs(): Promise<string[]> {
  throw new ComfyUIError(
    "Listing local LoRAs is not supported in Comfy Cloud mode.",
    "CLOUD_UNSUPPORTED",
  );
}

export async function getVAEs(): Promise<string[]> {
  throw new ComfyUIError(
    "Listing local VAEs is not supported in Comfy Cloud mode.",
    "CLOUD_UNSUPPORTED",
  );
}

export async function getUpscaleModels(): Promise<string[]> {
  throw new ComfyUIError(
    "Listing local upscale models is not supported in Comfy Cloud mode.",
    "CLOUD_UNSUPPORTED",
  );
}

export async function getLogs(): Promise<string[]> {
  throw new ComfyUIError(
    "Server logs are not available in Comfy Cloud mode.",
    "CLOUD_UNSUPPORTED",
  );
}

export async function fetchImage(
  filename: string,
  type: "output" | "input" | "temp" = "output",
  subfolder = "",
): Promise<{ base64: string; mimeType: string }> {
  const params = new URLSearchParams({ filename, type, subfolder });
  const url = cloudUrl(`/api/view?${params.toString()}`);
  // /api/view returns either bytes or a 302 to a signed URL, which is why this
  // does NOT go through cloudFetch: it needs redirect-following and raw bytes
  // rather than the JSON envelope. That exemption is also how it kept the bare,
  // signal-less `fetch` that #1069 removed from cloudFetch one call over — a
  // download from a wedged cloud hung the tool call with nothing to act on.
  let res: Response;
  try {
    res = await fetch(url, {
      headers: authHeaders(),
      redirect: "follow",
      signal: defaultComfyTimeoutSignal(),
    });
  } catch (err) {
    if (isTimeoutAbort(err)) {
      throw new ConnectionError(
        `No reply from Comfy Cloud within ${comfyHttpTimeoutSeconds()}s while downloading ` +
          `"${filename}" — ${url} (GET). Nothing was learned about the image from this: a ` +
          `timeout is not a "not found". Raise COMFYUI_MCP_HTTP_TIMEOUT_S if the cloud is ` +
          `simply slow.`,
      );
    }
    // A read, so no delivery doubt applies — re-requesting an image is safe.
    const { message, code } = describeFetchFailure(err);
    const wrapped = new ConnectionError(
      `Could not download "${filename}" from Comfy Cloud at ${url}: ${message}.`,
    );
    if (code) (wrapped as { code?: string }).code = code;
    throw wrapped;
  }
  if (!res.ok) {
    throw new ComfyUIError(
      `Cloud /api/view ${res.status} for "${filename}"`,
      "CLOUD_API_ERROR",
      { status: res.status },
    );
  }
  const contentType = res.headers.get("content-type") ?? "image/png";
  const mimeType = contentType.split(";")[0].trim();
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return { base64, mimeType };
}

export async function uploadImageHttp(
  filename: string,
  data: Buffer,
  mimeType = "image/png",
): Promise<{ name: string; subfolder: string; type: string }> {
  const formData = new FormData();
  const blob = new Blob([data], { type: mimeType });
  formData.append("image", blob, filename);
  formData.append("type", "input");
  formData.append("overwrite", "true");
  // multipart sets its own Content-Type; skip the JSON header.
  const res = await cloudFetch("/upload/image", {
    method: "POST",
    body: formData,
    skipJsonContentType: true,
  });
  return res.json() as Promise<{ name: string; subfolder: string; type: string }>;
}

export function getComfyUIPath(): string | undefined {
  return undefined;
}

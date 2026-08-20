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
import {
  ComfyUIError,
  ConnectionError,
  WorkflowExecutionError,
} from "../utils/errors.js";
import { comfyuiFetch, isTimeoutAbort, raceAbort } from "./fetch.js";
import {
  bodyPrefixOf,
  classifyNonJson,
  describeStatus,
  fetchComfyJson,
  guardClientFetch,
  isNonJsonResponseError,
  looksLikeHtmlParsedAsJson,
  NonJsonResponseError,
  noteComfyApiRootValidated,
  provesNonJsonAnswer,
  readComfyJson,
  redactErrorMessage,
  rethrowWithJsonDiagnosis,
  scrubLogLines,
  scrubSecretShapedText,
  uploadTooLargeError,
} from "./json-guard.js";
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
      //
      // Wrapped so the library's non-2xx path — which calls `res.json()` on the
      // ERROR body and lets a bare SyntaxError replace its own error, losing the
      // status and the URL with it — reports what actually answered instead
      // (#828, #1160). See guardClientFetch.
      fetch: guardClientFetch(comfyuiFetch),
    });
    logger.info("ComfyUI client created", {
      host: getComfyUIApiHost(),
    });
  }
  return clientInstance;
}

/**
 * `client.fetchApi`, minus the part that makes a status branch unreachable (#385).
 *
 * `Client.fetchApi` THROWS for every status outside [200, 400) — it never returns
 * a 4xx response. So every `if (!res.ok)` / `if (res.status === 404)` written
 * after a `fetchApi` call is dead code, and the endpoint-specific answers behind
 * those checks have never once run. That is not a theoretical concern:
 *
 *   - `fetchImage`'s IMAGE_NOT_FOUND — added by #435 for issue #385 itself, naming
 *     the filename and pointing at the listing tool — never fired for a missing
 *     output file.
 *   - `getSetting` treats a 404 as "unset (frontend default applies)", because
 *     some ComfyUI builds 404 the per-id settings route. Those builds threw.
 *   - `loadLockFromLibrary` treats a 404 as "no lock present", which is the
 *     ORDINARY case for an unlocked workflow. It threw.
 *
 * This keeps the library's URL and header construction verbatim — `apiURL` adds
 * the api_base prefix and the clientId, `apiHeaders` adds comfy-user and merges
 * the caller's — so a proxied, prefixed or multi-user target resolves exactly as
 * before. The ONLY difference is that the Response comes back instead of being
 * turned into an exception, which is what lets the caller classify it.
 *
 * `userdataFetch` in services/userdata-library.ts arrived at this same shape
 * independently for one route (panel #202); this is that fix generalised.
 *
 * Not a replacement for `comfyuiFetch`: use that when you are composing the URL
 * yourself (as `getSystemStats` and `enqueuePrompt` do). Use this when you want
 * the library's routing and a Response you can read.
 */
export async function comfyApiFetch(route: string, init: RequestInit = {}): Promise<Response> {
  const client = getClient();
  return await client.fetch(client.apiURL(route), {
    ...init,
    headers: client.apiHeaders(init),
  });
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

/** True when a decoded /system_stats body has the recognizable ComfyUI shape (a
 *  `system` object and/or a `devices` array). A bare 2xx carrying an API
 *  gateway's own JSON envelope is NOT ComfyUI and must not be handed on as
 *  stats — the same predicate the panel's reboot certification uses. */
function looksLikeSystemStats(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as { system?: unknown; devices?: unknown };
  return (b.system != null && typeof b.system === "object") || Array.isArray(b.devices);
}

/** Budget for the /system_stats probe. Short on purpose: this is a liveness
 *  read, and a ComfyUI mid-decode will not answer in time. Exported so the
 *  call_tool timeout test can shrink only THIS deadline. */
export const SYSTEM_STATS_TIMEOUT_MS = 15_000;

export async function getSystemStats(): Promise<SystemStats> {
  if (isCloudMode()) return cloudClient.getSystemStats();
  requireLocalMode("getSystemStats");
  // Fetched directly (not via the client library) so a non-JSON answer can be
  // DIAGNOSED rather than surfacing as "Unexpected token '<', "<!DOCTYPE "..."
  // (#828). comfyuiFetch carries the same auth headers the library would, and
  // getComfyUIBaseUrl() carries the same path prefix, so a proxied/prefixed
  // remote resolves identically.
  const url = `${getComfyUIBaseUrl()}/system_stats`;
  // The 15s signal used to sit only on `fetch`. Headers arriving before the
  // deadline left `readComfyJson` (`res.text()` + `JSON.parse`) unbounded, so
  // the abort fired, the nested call reported "The operation was aborted due
  // to timeout", and the enclosing call_tool stayed pending until something
  // killed it (#1672). Race the WHOLE fetch+decode against the same signal.
  const signal = AbortSignal.timeout(SYSTEM_STATS_TIMEOUT_MS);
  try {
    const stats = await raceAbort(signal, () =>
      fetchComfyJson<SystemStats>(url, {
        init: { signal },
        expectShape: looksLikeSystemStats,
        shapeHint:
          "a ComfyUI /system_stats document (it has no `system` object and no `devices` array)",
      }),
    );
    // Shape-valid /system_stats is the in-session proof that this base URL is a
    // ComfyUI API root. A later empty 502 must not be reported as a misconfigured
    // URL (#1670). A timeout is not that proof — do not stamp on the abort path.
    noteComfyApiRootValidated(getComfyUIBaseUrl());
    return stats;
  } catch (err) {
    if (!isTimeoutAbort(err)) throw err;
    // Structured, not the raw AbortSignal.timeout string: call_tool must
    // settle with a result the caller can act on, not hang and not dump
    // "The operation was aborted due to timeout" with no endpoint.
    throw new ComfyUIError(
      `No reply from ComfyUI within ${SYSTEM_STATS_TIMEOUT_MS / 1000}s — while requesting ${url} (GET). ` +
        `Nothing was learned about the server from this — a timeout is not a refusal and not a "not found". ` +
        `The connection was accepted but the body never finished, which is common while a long decode ` +
        `occupies the server. The request was aborted; retry after the current job finishes.`,
      "COMFYUI_HTTP_TIMEOUT",
      { endpoint: "/system_stats", timeout_ms: SYSTEM_STATS_TIMEOUT_MS },
    );
  }
}

// /object_info is large (~MBs) and slow (300-800 ms) but only changes when
// ComfyUI restarts or a custom node is (un)installed. Memoize it, but only for a
// bounded FRESHNESS WINDOW rather than the whole process lifetime: an out-of-band
// ComfyUI restart/install (Desktop Manager reboot, a manual restart, a node pack
// installed outside an mcp tool) never calls resetObjectInfoCache(), so a
// lifetime cache serves the PRE-restart schema forever — create_workflow's
// node_info and validate actions, and list_packs (action:"check_runtime"), all report the new nodes as unknown
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
      // The library's parse errors QUOTE the body they choked on, and a gateway
      // that reflects the request can have put our ComfyUI credential in that
      // body — so this message goes through the same redaction as any body text
      // before it reaches the log (codex gate, round 5, finding 5).
      logger.warn("getObjectInfo failed; resetting client and retrying once", {
        error: redactErrorMessage(err),
      });
      resetClientIfCurrent(startClient);
      try {
        return commit((await getClient().getNodeDefs()) as unknown as ObjectInfo);
      } catch (retryErr) {
        // The client library parses JSON itself, so an HTML body reaches us as a
        // bare "Unexpected token '<'" naming neither the URL nor the responder
        // (#828). Re-probe the endpoint ONCE to say what actually answered; if
        // the probe is inconclusive the original error is rethrown untouched —
        // an unproven cause must never be presented as the cause.
        //
        // Report whichever attempt PROVED a non-JSON answer. When the first
        // request got HTML and the retry merely hit a transport blip, surfacing
        // only the retry would downgrade a known #828 diagnosis to "server
        // unavailable" and send the user to check whether ComfyUI is running
        // (codex gate, round 8, finding 2).
        //
        // `provesNonJsonAnswer`, not `looksLikeHtmlParsedAsJson`: since
        // guardClientFetch the library's parse failure arrives as a
        // NonJsonResponseError carrying no parser text, so the old predicate
        // answered "no" for the strongest evidence available and this picker
        // fell through to `retryErr` every time — reintroducing the very
        // downgrade round 8 fixed.
        const toReport = provesNonJsonAnswer(retryErr) ? retryErr : provesNonJsonAnswer(err) ? err : retryErr;
        return await rethrowWithJsonDiagnosis(toReport, `${getComfyUIBaseUrl()}/object_info`);
      }
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
        // dropped the node and made the node_info lookup report "no match" for a node
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

/**
 * /queue, but a read that is allowed to FAIL.
 *
 * `getQueue()` above cannot say "I could not look". It goes through the
 * vendored client, whose failure path resolves a document with no Running or
 * Pending key — and the `?? []` normalizer then turns that into an EMPTY
 * QUEUE. Measured against a real HTTP server: a 500, a 502 HTML proxy page, a
 * 200 `{}`, and a dead port (ECONNREFUSED) ALL resolve
 * `{queue_running:[],queue_pending:[]}`. Nothing throws.
 *
 * That collapse is harmless for a summary — an unreachable ComfyUI has no jobs
 * to list — and fatal for any caller that must tell "this job is not queued"
 * from "I could not check", because those are the same bytes. #1632 is exactly
 * that mistake one level up: reporting a job as removed without looking.
 *
 * So this takes the guarded JSON path every other verifying read here uses.
 * A network error, a non-2xx, an HTML body, and a JSON document that is not a
 * queue all THROW; only a real /queue document resolves. Callers that must not
 * confuse absence with ignorance use this one.
 */
export async function getQueueVerified(): Promise<QueueStatus> {
  requireLocalMode("getQueueVerified");
  const res = await comfyApiFetch("/queue");
  const queue = await readComfyJson<Record<string, unknown>>(res, {
    url: "/queue",
    // Both halves must be present. Accepting a bare `{}` would reinstate the
    // very collapse this function exists to avoid — silently, and now wearing
    // the word "verified".
    expectShape: (v) =>
      typeof v === "object" && v !== null && !Array.isArray(v) &&
      ("queue_running" in v || "Running" in v) &&
      ("queue_pending" in v || "Pending" in v),
    shapeHint: "a ComfyUI /queue document (queue_running + queue_pending)",
  });
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
/**
 * Human-readable account of output branches ComfyUI REFUSED while accepting the
 * prompt, or undefined when it accepted everything.
 *
 * Shape from ComfyUI: { "<nodeId>": { class_type, errors: [{ type, message,
 * details, extra_info: { input_name } }] } }. Only what is actually present is
 * stated — a node that carries no readable error still gets named, because "this
 * branch will not run" is the load-bearing fact and it does not depend on our
 * being able to parse the reason.
 */
function describeRejectedOutputs(nodeErrors: unknown): string | undefined {
  if (!nodeErrors || typeof nodeErrors !== "object") return undefined;
  const entries = Object.entries(nodeErrors as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  const parts = entries.map(([nodeId, raw]) => {
    const rec = (raw ?? {}) as { class_type?: unknown; errors?: unknown };
    const cls = typeof rec.class_type === "string" ? ` (${rec.class_type})` : "";
    const errs = Array.isArray(rec.errors) ? rec.errors : [];
    const reasons = errs
      .map((e) => {
        const er = (e ?? {}) as { message?: unknown; extra_info?: { input_name?: unknown } };
        const msg = typeof er.message === "string" ? er.message : null;
        const input =
          er.extra_info && typeof er.extra_info.input_name === "string"
            ? er.extra_info.input_name
            : null;
        if (msg && input) return `${msg} (${input})`;
        return msg ?? (input ? `problem with input "${input}"` : null);
      })
      .filter((r): r is string => !!r);
    return `node ${nodeId}${cls}${reasons.length ? `: ${reasons.join("; ")}` : ""}`;
  });
  return (
    `The prompt was QUEUED, but ComfyUI REJECTED ${parts.length} output branch` +
    `${parts.length === 1 ? "" : "es"} at validation and will not run ${
      parts.length === 1 ? "it" : "them"
    } — ${parts.join(" | ")}. Everything upstream of the ACCEPTED outputs still ` +
    `runs, so this prompt can complete and report success while producing nothing ` +
    `from the rejected branch${parts.length === 1 ? "" : "es"}. Fix the named ` +
    `input(s) and re-queue if you expected output from ${
      parts.length === 1 ? "it" : "them"
    }.`
  );
}

export async function enqueuePrompt(
  workflow: Record<string, unknown>,
  extraData?: Record<string, unknown>,
  opts?: { front?: boolean },
): Promise<{ prompt_id: string; queue_remaining?: number; rejectedOutputs?: string }> {
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
  // A bare res.json() here is the worst place in the codebase for one, and the
  // same family as #1149/#1160/#828. This is a MUTATING POST that already
  // succeeded at the HTTP layer: if the body will not parse, the prompt may well
  // be queued and running, and `Unexpected end of JSON input` says nothing about
  // that — a caller reads it as "the run failed" and re-submits, queueing the
  // render twice.
  //
  // So: classify what actually answered (readComfyJson names the URL, status,
  // content type and body prefix), and state the delivery doubt explicitly. The
  // expectShape check is what catches the shape that matters — a gateway's own
  // JSON error envelope is valid JSON with no prompt_id, and reading
  // `data.prompt_id` off it would hand back `undefined` as a prompt id and let
  // every downstream poll chase a job that was never queued.
  let data: { prompt_id: string; number?: number; node_errors?: Record<string, unknown> };
  try {
    data = await readComfyJson<{
      prompt_id: string;
      number?: number;
      node_errors?: Record<string, unknown>;
    }>(res, {
      url: "/prompt",
      expectShape: (v: unknown) =>
        !!v && typeof v === "object" && typeof (v as { prompt_id?: unknown }).prompt_id === "string",
      shapeHint: "the enqueue result ({ prompt_id, … })",
    });
  } catch (err) {
    throw new ComfyUIError(
      `${err instanceof Error ? err.message : String(err)} ` +
        `OUTCOME UNDETERMINED: the POST to /prompt was accepted (HTTP ${res.status}) and the ` +
        `workflow MAY ALREADY BE QUEUED — this is not proof it failed. Check queue ` +
        `(action:"status") or get_history BEFORE re-submitting; a blind retry can run the ` +
        `same workflow twice.`,
      "ENQUEUE_UNVERIFIED",
    );
  }
  // NB: `data.number` is ComfyUI's monotonic priority counter (and is NEGATIVE
  // for front-inserted jobs) — NOT the remaining queue depth. The old SDK path
  // returned exec_info.queue_remaining; to preserve an accurate count now that
  // we POST directly, read /queue for the authoritative running+pending total.
  // Fall back to undefined (never the misleading counter) if that read fails.
  // A 200 does NOT mean every output was accepted. ComfyUI validates each output
  // branch independently: if SOME validate it queues those and returns 200 with a
  // prompt_id, carrying `node_errors` for the ones it REJECTED (execution.py
  // returns (True, None, good_outputs, node_errors); it only 400s when NO output
  // is good). Those branches then never run — ComfyUI logs "Output will be
  // ignored" — and the prompt still completes, so the run reports success while
  // producing nothing from them.
  //
  // That is exactly how #1037 reached a user: a required nested input was missing
  // on one node, its output branch was dropped, and queue(action:"status") said
  // success with no video. This function already goes direct to /prompt SO THAT
  // node_errors can be read (#485) — but only the 400 path read them.
  //
  // Reported, never swallowed and never fatal: the run WAS queued and the
  // accepted branches will produce output, so this is a disclosure attached to a
  // success, not a failure.
  const rejectedOutputs = describeRejectedOutputs(data.node_errors);
  return {
    prompt_id: data.prompt_id,
    queue_remaining: await queueRemainingCount(),
    ...(rejectedOutputs ? { rejectedOutputs } : {}),
  };
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
/**
 * One field of a STRUCTURED /prompt error, made safe to interpolate (#1191,
 * codex review).
 *
 * The fix for #1191 redacted the raw-body FALLBACK and stopped there — but the
 * structured branch runs FIRST and copied `error.message`, each node's
 * `class_type`, and every `errors[].message` / `.details` verbatim into the
 * result. A hostile or reflecting gateway can answer with JSON shaped exactly
 * like a ComfyUI validation failure, so a credential echoed in any of those
 * fields reached the agent while the "redacted" path never ran.
 *
 * scrubSecretShapedText returns null when it cannot substitute safely; that is a
 * FAIL-CLOSED signal, so the field is withheld rather than passed through. The
 * #485 diagnosis survives because a genuine ComfyUI validation message contains
 * no credential and is returned unchanged.
 */
function safeField(v: unknown): string {
  if (typeof v !== "string" || v === "") return "";
  const scrubbed = scrubSecretShapedText(v);
  return scrubbed === null ? "(withheld: contains a configured credential)" : scrubbed;
}

async function buildEnqueueError(res: Response): Promise<ComfyUIError> {
  // unknown-ok: "" only routes to the GENERIC status message, which reports the
  // HTTP status and claims nothing about node errors. An unread body and an empty
  // body get the same honest fallback rather than a fabricated validation result.
  const bodyText = await res.text().catch(() => "");
  // #1191 — statusText is attacker-influenceable on a hostile proxy and lands in
  // a message the agent reads, so it gets the same scrub the body does.
  // describeStatus drops a standard reason phrase entirely (it adds nothing),
  // clips a long one, and falls back to the bare status if it cannot scrub.
  const generic = `ComfyUI /prompt returned ${describeStatus(res.status, res.statusText)}`;

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
        lines.push(`- ${safeField(cls)} (node ${safeField(nodeId)}): validation failed`);
        continue;
      }
      for (const e of errs) {
        const detail = e?.details ? ` (${safeField(e.details)})` : "";
        lines.push(
          `- ${safeField(cls)} (node ${safeField(nodeId)}): ` +
            `${safeField(e?.message) || "validation failed"}${detail}`,
        );
      }
    }

    const headline = payload.error?.message
      ? `ComfyUI rejected the workflow (${res.status}): ${safeField(payload.error.message)}`
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

  // Empty or unexpected body: fall back to the generic HTTP status, but keep a
  // REDACTED prefix of the text so nothing is silently dropped.
  //
  // #1191 — this used to interpolate 500 RAW bytes. A gateway that reflects the
  // request can echo our own credential in the body it answers with, and this
  // string goes straight into a tool result the agent reads and users paste into
  // bug reports. /prompt is the worst endpoint to have that on: it is the call
  // every render makes, so this is the error path most likely to be hit and
  // shared. bodyPrefixOf redacts by SHAPE as well as by known value, and
  // withholds the prefix entirely when it cannot substitute safely.
  return new ConnectionError(
    bodyText ? `${generic}: ${bodyPrefixOf(bodyText)}` : generic,
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

/**
 * Which lines the caller wants — applied to the RAW log, before redaction.
 * See `selectAndScrubLogLines` for why this cannot be the caller's job (#1223).
 */
export interface GetLogsOptions {
  /** Case-insensitive substring the line must contain. */
  keyword?: string;
  /** Keep only the last N matching lines. */
  maxLines?: number;
}

export async function getLogs(opts?: GetLogsOptions): Promise<string[]> {
  // Cloud mode has no /internal/logs equivalent; this always throws
  // CLOUD_UNSUPPORTED, so there is nothing to select or scrub.
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
      // A DIAGNOSED non-JSON answer is not a connection failure — the server (or
      // whatever is in front of it) replied, and the diagnosis already names the
      // endpoint, the status and what answered. Wrapping it in a ConnectionError
      // titled "Failed to fetch" contradicted its own contents and sent readers
      // to check whether ComfyUI was up when it demonstrably was (#828).
      if (isNonJsonResponseError(err2)) throw err2;
      const detail = err2 instanceof Error ? err2.message : String(err2);
      throw new ConnectionError(
        `Failed to fetch ComfyUI logs after reconnect retry: ${detail}`,
      );
    }
  }

  // ComfyUI returns logs as a JSON-encoded string with \n separators,
  // or as raw text depending on version. Handle both.
  let lines: string[];
  try {
    const parsed = JSON.parse(text);
    lines = (typeof parsed === "string" ? parsed : text).split("\n").filter(Boolean);
  } catch {
    // Not JSON — treat as raw text
    lines = text.split("\n").filter(Boolean);
  }
  return selectAndScrubLogLines(lines, opts);
}

/**
 * Select the requested lines, THEN scrub them (#1223).
 *
 * The order is the whole point, and getting it backwards is a false ABSENCE:
 * `get_system_stats action:"logs"` filtered by keyword AFTER this function had
 * already redacted, so a keyword matching redacted text — `keyword:"ltxvideo"`,
 * `keyword:"LTXLoopingSampler"` — reported "No log lines found" while the
 * matching lines sat in the log. Reporting nothing found is much worse than
 * reporting a redacted match: the caller stops looking.
 *
 * Selection lives HERE rather than in the caller so the raw text never leaves
 * this function. Callers get scrubbed lines and cannot filter on anything else,
 * which is what makes the ordering a property of the code rather than a rule
 * every future call site has to remember.
 */
function selectAndScrubLogLines(lines: string[], opts?: GetLogsOptions): string[] {
  let selected = lines;
  if (opts?.keyword) {
    const kw = opts.keyword.toLowerCase();
    selected = selected.filter((line) => line.toLowerCase().includes(kw));
  }
  // Tail before scrubbing: strictly less work, and identical output either way.
  if (typeof opts?.maxLines === "number" && selected.length > opts.maxLines) {
    selected = selected.slice(-opts.maxLines);
  }
  return scrubLogLines(selected);
}


/**
 * ComfyUI frontend per-user settings, served by the frontend user manager:
 *   GET  /settings         → every stored setting as one JSON object
 *   GET  /settings/{id}    → one setting's raw stored value
 *   POST /settings/{id}    → persist one setting (JSON body is the raw value)
 *
 * These are the ComfyUI *frontend* UI settings (`Comfy.*` ids) and are entirely
 * unrelated to our own generation-defaults store, which `get_defaults` reads and
 * writes with action:"get"/"set". Local and remote
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

/**
 * GET /settings — every stored frontend setting as a raw `id: value` object.
 *
 * An UNREADABLE answer is not an empty one (#796). This used to fall through to
 * `{}` on any non-JSON body, and `get_defaults action:"get_ui"` renders that as
 * `count: 0` beside a note saying only explicitly-stored settings appear — i.e.
 * "you have no settings", asserted from a body nobody could parse. The realistic
 * trigger is the one this repo keeps meeting: an auth proxy answering with a
 * sign-in page, or a different service on the host.
 *
 * readComfyJson is the vetted path for exactly this — it names the URL and what
 * actually answered, and scrubs secret-shaped text — and was already imported
 * here; these two functions simply hand-rolled `res.text()` + `JSON.parse`
 * instead. `expectShape` also rejects a 200 that parses as JSON but is not a map
 * (an API gateway's own error envelope), which the old truthiness check accepted
 * as long as it was any object — including an array.
 */
export async function getSettings(): Promise<Record<string, unknown>> {
  requireLocalMode("settings");
  const client = getClient();
  const res = await comfyApiFetch("/settings");
  if (res.status === 404) throw settingsVersionDriftError();
  return await readComfyJson<Record<string, unknown>>(res, {
    url: "/settings",
    expectShape: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
    shapeHint: "the settings map",
  });
}

/**
 * GET /settings/{id} — one setting's raw stored value. Returns `undefined` for
 * an unset key: ComfyUI returns an empty body or `null` for unset ids on
 * different versions, and some builds 404 the per-id route, so empty / `null` /
 * 404 are treated uniformly as "unset (frontend default applies)". Stored values
 * are passed through verbatim — never coerced, so an older frontend's `"true"`
 * string surfaces as a string.
 *
 * PARSE FAILURE IS NOT IN THAT LIST ANY MORE (#796). Empty, `null` and 404 are
 * things a ComfyUI build actually SAYS to mean "unset"; a non-empty body that is
 * not JSON is something else answering — a proxy sign-in page, a gateway error
 * envelope — and reporting it as unset is a claim nobody observed. It reached the
 * caller as `value: null, note: "unset (frontend default applies)"`, and worse,
 * `set_ui` reports `previous: null` from this same call, so a user who then set a
 * value was told the old one was unset and could not restore it.
 */
export async function getSetting(id: string): Promise<unknown> {
  requireLocalMode("settings");
  const client = getClient();
  const url = `/settings/${encodeURIComponent(id)}`;
  const res = await comfyApiFetch(url);
  if (res.status === 404) return undefined;
  // ONLY 404 means "unset". Every other error status must throw (review finding 1).
  //
  // This branch could not run before #385 made it reachable, and without it the
  // function reopens the exact hole its own docstring says was closed: a 403 or
  // 500 carrying a gateway's JSON error envelope parses fine and is RETURNED AS
  // THE STORED VALUE, and a 502 with an empty body reports "unset (frontend
  // default applies)" for a setting nobody read. `set_ui` echoes this call as
  // `previous:`, so a user who then writes a value is told the old one was unset
  // and cannot restore it.
  if (!res.ok) {
    throw new ComfyUIError(
      `ComfyUI ${url} answered ${describeStatus(res.status, res.statusText)}, so this setting could ` +
        `NOT be read. That is not a report that it is unset — nothing was read. Only a 404 means ` +
        `"unset (frontend default applies)" on builds that 404 the per-id route.`,
      "HTTP_ERROR",
    );
  }
  const text = await res.text();
  if (text.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed === null ? undefined : parsed;
  } catch {
    // Classified rather than swallowed. Same machinery readComfyJson uses, so the
    // message names the URL and the responder and is secret-scrubbed; it cannot
    // use readComfyJson directly because an EMPTY body must stay "unset" here and
    // that helper (correctly) treats an unparseable body as a failure.
    throw new NonJsonResponseError(
      classifyNonJson({
        url,
        status: res.status,
        statusText: res.statusText,
        contentType: res.headers.get("content-type") ?? "",
        body: text,
      }),
    );
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
  const res = await comfyApiFetch(`/settings/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (res.status === 404) throw settingsVersionDriftError();
  if (!res.ok) {
    // unknown-ok: "" is interpolated into an ERROR MESSAGE and nothing else — the
    // HTTP status is reported either way, so an unreadable body costs detail in the
    // text, never a wrong conclusion. Verified there is no branch on this value.
    //
    // #385 made this branch REACHABLE, and it was printing 500 raw bytes. A
    // reflecting gateway answers `invalid token: Bearer <ours>` and that went
    // straight into a tool result (review finding 2). Body and reason phrase both
    // go through the scrubbers now, as everywhere else.
    const body = await res.text().catch(() => "");
    throw new ConnectionError(
      `ComfyUI /settings/${id} returned ${describeStatus(res.status, res.statusText)}: ${bodyPrefixOf(body)}`,
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
  const res = await comfyApiFetch(path);
  // #1149 — this was a bare res.json(), the last unguarded parse on the media
  // read paths. A reporter on a remote H100 got `Unexpected end of JSON input`
  // from get_history and get_image after a completed video render, which
  // get_image then wrapped as HISTORY_UNREADABLE: a raw parser message standing
  // in for a diagnosis, naming no endpoint and no status, for a render that had
  // demonstrably succeeded.
  //
  // readComfyJson is what every sibling read already uses (#918/#946/#952): it
  // names the URL, the status, the content type and a body prefix, so an empty
  // body, an auth gate's login page and a proxy's HTML are each said out loud
  // rather than collapsing into one parser error.
  //
  // No expectShape: /history's value is an object keyed by prompt id, and `{}`
  // is a perfectly valid EMPTY history. Asserting a shape here would turn a
  // legitimately empty answer into a fabricated failure — the opposite defect.
  return readComfyJson<Record<string, HistoryEntry>>(res, { url: path });
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
  const res = await comfyApiFetch(`/view?${params.toString()}`);
  if (!res.ok) {
    const where = subfolder ? `${type}/${subfolder}` : type;
    throw new ComfyUIError(
      `ComfyUI /view returned ${res.status} for "${filename}" (${where}). ` +
        (res.status === 404
          ? `No such file in the ComfyUI ${type} directory` +
            (subfolder ? ` under subfolder "${subfolder}"` : "") +
            `. Check the filename/subfolder (e.g. via get_image (action:"list_outputs") or get_history).`
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
  // #946 — a `filename` carrying a path ("assets/clip.mp4") is a SUBFOLDER
  // request, and ComfyUI's /upload/image takes that as its own form field, not
  // as a slash inside the multipart filename. Sending the whole path as the
  // filename put it somewhere between the transport and ComfyUI's handler and
  // came back as a bare `Unexpected non-whitespace character after JSON at
  // position 4` — no upload, no usable error. Split it and use the field the
  // API actually has, which is also what the caller was asking for.
  const { subfolder, name } = splitUploadTarget(filename);
  const formData = new FormData();
  const blob = new Blob([data], { type: mimeType });
  formData.append("image", blob, name);
  formData.append("type", "input");
  formData.append("overwrite", "true");
  if (subfolder) formData.append("subfolder", subfolder);
  const res = await comfyApiFetch("/upload/image", {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    // This branch only became REACHABLE with #385, and reaching it must not cost
    // the #1160 diagnosis. An auth gate answering 401 with a sign-in page is the
    // reported case, and "returned 401: <!DOCTYPE html>…" is strictly worse than
    // naming the gate and saying which layer wants the credential.
    //
    // It must also not dump a RAW body: a gateway that reflects the request can
    // put our own credential in it, which is exactly what bodyPrefixOf exists to
    // prevent. Both problems are solved by classifying rather than interpolating.
    // unknown-ok: "" only means an unreadable body, which classifyNonJson reports
    // as an empty one — a loss of detail, never a wrong conclusion.
    const text = await res.text().catch(() => "");
    // #1905 — HTTP 413 is a size limit. Classifying it as NON_JSON_RESPONSE
    // (plain-text aiohttp body) then recommended checking the ComfyUI base URL,
    // even when /system_stats was healthy JSON. Name the limit before any parse.
    const tooLarge = uploadTooLargeError({
      url: "/upload/image",
      status: res.status,
      statusText: res.statusText,
      body: text,
    });
    if (tooLarge) throw tooLarge;
    throw new NonJsonResponseError(
      classifyNonJson({
        url: "/upload/image",
        status: res.status,
        statusText: res.statusText,
        contentType: res.headers.get("content-type") ?? "",
        body: text,
      }),
    );
  }
  // Never let a parser message stand in for a diagnosis: a proxy or a
  // still-starting server answering 200 with HTML used to surface as a raw
  // SyntaxError with no mention of what was requested (#946, and the same class
  // as #918/#952).
  return readComfyJson<{ name: string; subfolder: string; type: string }>(res, {
    url: "/upload/image",
    expectShape: (v: unknown) => !!v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string",
    shapeHint: 'the upload result ({ name, subfolder, type })',
  });
}

/**
 * Split an upload target into ComfyUI's two fields (#946).
 *
 * The implementation lives in ./upload-target.js so BOTH upload clients can
 * share it (cloud-client.ts cannot import from here without a circular
 * import); re-exported so existing imports keep working.
 */
import { splitUploadTarget } from "./upload-target.js";
export { splitUploadTarget };

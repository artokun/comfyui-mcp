import {
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:fs";
import { lstat, open, opendir, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/**
 * The only production path for a /view retry when the configured headless
 * ComfyUI target is unreachable. The child writes a reference-only request;
 * the orchestrator resolves the requester to a live panel and performs the
 * authenticated bridge command. No URL, origin, or server claim crosses this
 * channel.
 */
export const PANEL_IMAGE_RELAY_VERSION = 1;
export const PANEL_IMAGE_RELAY_MAX_BYTES = 32 * 1024 * 1024;
export const PANEL_IMAGE_RELAY_TIMEOUT_MS = 8_000;
export const PANEL_IMAGE_RELAY_STALE_MS = 15_000;
export const PANEL_IMAGE_RELAY_MAX_REQUEST_FILE_BYTES = 16 * 1024;
export const PANEL_IMAGE_RELAY_MAX_RESPONSE_FILE_BYTES = 48 * 1024 * 1024;
export const PANEL_IMAGE_RELAY_MAX_CONCURRENT = 4;
export const PANEL_IMAGE_RELAY_MAX_REQUESTS_PER_TICK = 4;
export const PANEL_IMAGE_RELAY_MAX_DIRECTORY_ENTRIES_PER_TICK = 128;
export const PANEL_IMAGE_RELAY_MAX_PENDING_REQUESTS = 16;
export const PANEL_IMAGE_RELAY_MAX_PENDING_RESPONSES = 4;

export const PANEL_IMAGE_RELAY_REQUEST_PREFIX = "control-image-request-";
export const PANEL_IMAGE_RELAY_RESPONSE_PREFIX = "control-image-response-";
const RELAY_ID_RE = /^[A-Za-z0-9_-]{16,80}$/;
const IMAGE_TYPES = new Set<PanelImageType>(["output", "input", "temp"]);
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}$/;

export type PanelImageType = "output" | "input" | "temp";

export interface PanelImageRelayRequest {
  version: typeof PANEL_IMAGE_RELAY_VERSION;
  requestId: string;
  requester: string;
  filename: string;
  subfolder: string;
  type: PanelImageType;
  createdAt: number;
  deadlineAt: number;
}

export interface PanelImageRelaySuccess {
  base64: string;
  mimeType: string;
  bytes: number;
}

interface PanelImageRelayResponseFailure {
  version: typeof PANEL_IMAGE_RELAY_VERSION;
  requestId: string;
  ok: false;
  error: string;
  updated: number;
}

interface PanelImageRelayResponseSuccess extends PanelImageRelaySuccess {
  version: typeof PANEL_IMAGE_RELAY_VERSION;
  requestId: string;
  ok: true;
  updated: number;
}

type PanelImageRelayResponse =
  | PanelImageRelayResponseSuccess
  | PanelImageRelayResponseFailure;

export interface PanelImageRelayBridge {
  canReach(tabId: string): boolean;
  resolveFailure?: (tabId: string) => "ambiguous" | "unresolved" | undefined;
  send(
    command: { cmd: "fetch_image"; filename: string; subfolder: string; type: PanelImageType },
    options: { tabId: string; timeoutMs: number },
  ): Promise<unknown>;
}

export class PanelImageRelayError extends Error {
  readonly code: string;
  readonly unavailable: boolean;

  constructor(message: string, code: string, unavailable = false) {
    super(message);
    this.name = "PanelImageRelayError";
    this.code = code;
    this.unavailable = unavailable;
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSafeText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    ![...value].some((char) => {
      const code = char.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  );
}

/** Strict wire-level validation. Keep this stricter than the legacy tool path. */
export function isSafePanelImageRef(
  filename: unknown,
  subfolder: unknown,
  type: unknown,
): filename is string {
  if (!isSafeText(filename, 4096) || !isSafeText(subfolder, 4096) && subfolder !== "") return false;
  if (typeof type !== "string" || !IMAGE_TYPES.has(type as PanelImageType)) return false;
  if (
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes(":") ||
    filename.includes("?") ||
    filename.includes("#")
  ) return false;
  if (subfolder === "") return true;
  if (
    subfolder.startsWith("/") ||
    subfolder.startsWith("\\") ||
    /^[A-Za-z]:/.test(subfolder) ||
    subfolder.includes("\\") ||
    subfolder.includes("?") ||
    subfolder.includes("#")
  ) return false;
  const segments = subfolder.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isSafeRequester(value: unknown): value is string {
  return isSafeText(value, 1024) && value.trim() === value;
}

function isSafeRelayId(value: unknown): value is string {
  return typeof value === "string" && RELAY_ID_RE.test(value);
}

function requestPath(dir: string, requestId: string): string {
  return join(dir, `${PANEL_IMAGE_RELAY_REQUEST_PREFIX}${requestId}.json`);
}

function responsePath(dir: string, requestId: string): string {
  return join(dir, `${PANEL_IMAGE_RELAY_RESPONSE_PREFIX}${requestId}.json`);
}

const noFollowFlag = (constants as unknown as Record<string, unknown>).O_NOFOLLOW;
const safeReadFlags = constants.O_RDONLY | (typeof noFollowFlag === "number" ? noFollowFlag : 0);

/** Read one bounded regular file through one descriptor; never stat then reopen. */
async function readBoundedJson(path: string, maxBytes: number): Promise<unknown> {
  const linkStat = await lstat(path);
  if (!linkStat.isFile()) throw new Error("relay input is not a regular file");
  const handle = await open(path, safeReadFlags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("file exceeds the relay safety limit");
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.byteLength) {
      const { bytesRead } = await handle.read(data, offset, data.byteLength - offset, null);
      if (bytesRead === 0) throw new Error("relay input ended before its declared size");
      offset += bytesRead;
    }
    const finalStat = await handle.stat();
    if (!finalStat.isFile() || finalStat.size !== stat.size) {
      throw new Error("relay input changed while it was being read");
    }
    return JSON.parse(data.toString("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

function writeJsonAtomically(path: string, value: unknown, maxBytes: number): void {
  const data = Buffer.from(JSON.stringify(value), "utf8");
  if (data.byteLength > maxBytes) throw new Error("relay response exceeds the safety limit");
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      // best effort cleanup
    }
  }
}

function canonicalBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function validateImagePayload(
  value: unknown,
): PanelImageRelaySuccess | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    !hasOwn(record, "base64") ||
    !hasOwn(record, "mimeType") ||
    !hasOwn(record, "bytes") ||
    !hasOnlyKeys(record, ["base64", "mimeType", "bytes"])
  ) return undefined;
  if (!canonicalBase64(record.base64) || !isSafeText(record.mimeType, 128) || !MIME_RE.test(record.mimeType)) return undefined;
  const bytes = record.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > PANEL_IMAGE_RELAY_MAX_BYTES) return undefined;
  const actualBytes = Buffer.byteLength(record.base64, "base64");
  if (actualBytes !== bytes) return undefined;
  return { base64: record.base64, mimeType: record.mimeType, bytes };
}

function validateRequest(value: unknown, requestId: string): PanelImageRelayRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const createdAt = record.createdAt;
  const deadlineAt = record.deadlineAt;
  if (
    !hasOnlyKeys(record, ["version", "requestId", "requester", "filename", "subfolder", "type", "createdAt", "deadlineAt"]) ||
    record.version !== PANEL_IMAGE_RELAY_VERSION ||
    record.requestId !== requestId ||
    !isSafeRequester(record.requester) ||
    !isSafePanelImageRef(record.filename, record.subfolder, record.type) ||
    typeof createdAt !== "number" ||
    typeof deadlineAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    !Number.isSafeInteger(deadlineAt) ||
    deadlineAt < createdAt ||
    deadlineAt - createdAt > PANEL_IMAGE_RELAY_TIMEOUT_MS
  ) return undefined;
  return record as unknown as PanelImageRelayRequest;
}

function validateResponse(value: unknown, requestId: string): PanelImageRelayResponse {
  if (!value || typeof value !== "object") throw new PanelImageRelayError("The panel returned a malformed image relay reply.", "MALFORMED_REPLY");
  const record = value as Record<string, unknown>;
  if (
    record.version !== PANEL_IMAGE_RELAY_VERSION ||
    record.requestId !== requestId ||
    !hasOwn(record, "ok") ||
    !Number.isSafeInteger(record.updated)
  ) throw new PanelImageRelayError("The panel returned a malformed image relay reply.", "MALFORMED_REPLY");
  const updated = record.updated;
  if (typeof updated !== "number") throw new PanelImageRelayError("The panel returned a malformed image relay reply.", "MALFORMED_REPLY");
  if (record.ok === true) {
    const payload = validateImagePayload({
      base64: record.base64,
      mimeType: record.mimeType,
      bytes: record.bytes,
    });
    if (
      !payload ||
      !hasOwn(record, "updated") ||
      !hasOnlyKeys(record, ["version", "requestId", "ok", "base64", "mimeType", "bytes", "updated"])
    ) throw new PanelImageRelayError("The panel returned a malformed image relay reply.", "MALFORMED_REPLY");
    return { ...payload, version: PANEL_IMAGE_RELAY_VERSION, requestId, ok: true, updated };
  }
  if (
    record.ok === false &&
    typeof record.error === "string" &&
    record.error.length <= 160 &&
    isSafeText(record.error, 160) &&
    hasOnlyKeys(record, ["version", "requestId", "ok", "error", "updated"])
  ) {
    return record as unknown as PanelImageRelayResponseFailure;
  }
  throw new PanelImageRelayError("The panel returned a malformed image relay reply.", "MALFORMED_REPLY");
}

function failureResponse(requestId: string, error: string): PanelImageRelayResponseFailure {
  return {
    version: PANEL_IMAGE_RELAY_VERSION,
    requestId,
    ok: false,
    error,
    updated: Date.now(),
  };
}

function responseFailureMessage(response: PanelImageRelayResponseFailure): never {
  throw new PanelImageRelayError("The connected panel could not fetch that image.", "PANEL_FETCH_FAILED");
}

function channelDir(): string {
  return process.env.COMFYUI_MCP_PROGRESS_DIR?.trim() ?? "";
}

/** Child-side request writer and bounded response waiter. */
export async function requestPanelImage(
  filename: string,
  type: PanelImageType,
  subfolder: string,
): Promise<PanelImageRelaySuccess | undefined> {
  const dir = channelDir();
  const requester = process.env.COMFYUI_MCP_TAB;
  if (!dir || !isSafeRequester(requester)) return undefined;
  if (!isSafePanelImageRef(filename, subfolder, type)) {
    throw new PanelImageRelayError("The image reference is unsafe and was refused.", "UNSAFE_REFERENCE");
  }
  let dirStat;
  try {
    dirStat = await lstat(dir);
  } catch {
    return undefined;
  }
  if (!dirStat.isDirectory()) return undefined;

  const requestId = `${Date.now().toString(36)}-${process.pid.toString(36)}-${randomBytes(8).toString("hex")}`;
  const createdAt = Date.now();
  const request: PanelImageRelayRequest = {
    version: PANEL_IMAGE_RELAY_VERSION,
    requestId,
    requester,
    filename,
    subfolder,
    type,
    createdAt,
    deadlineAt: createdAt + PANEL_IMAGE_RELAY_TIMEOUT_MS,
  };
  const requestFile = requestPath(dir, requestId);
  const responseFile = responsePath(dir, requestId);
  try {
    writeJsonAtomically(requestFile, request, PANEL_IMAGE_RELAY_MAX_REQUEST_FILE_BYTES);
  } catch {
    throw new PanelImageRelayError("The connected panel relay is unavailable.", "REQUEST_WRITE_FAILED", true);
  }

  const deadline = request.deadlineAt;
  try {
    while (Date.now() < deadline) {
      let responsePresent = false;
      try {
        const responseStat = await lstat(responseFile);
        if (!responseStat.isFile()) {
          try { await unlink(responseFile); } catch { /* best effort */ }
          throw new PanelImageRelayError("The panel returned a malformed image relay reply.", "MALFORMED_REPLY");
        }
        responsePresent = true;
      } catch (error) {
        if (error instanceof PanelImageRelayError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new PanelImageRelayError("The panel returned a malformed image relay reply.", "MALFORMED_REPLY");
        }
      }
      if (responsePresent) {
        if (Date.now() >= deadline) {
          try { await unlink(responseFile); } catch { /* best effort */ }
          throw new PanelImageRelayError("The connected panel image relay timed out.", "TIMEOUT");
        }
        let response: PanelImageRelayResponse;
        try {
          response = validateResponse(
            await readBoundedJson(responseFile, PANEL_IMAGE_RELAY_MAX_RESPONSE_FILE_BYTES),
            requestId,
          );
        } catch (error) {
          try { unlinkSync(responseFile); } catch { /* best effort */ }
          if (error instanceof PanelImageRelayError) throw error;
          throw new PanelImageRelayError("The panel returned a malformed image relay reply.", "MALFORMED_REPLY");
        }
        try { unlinkSync(responseFile); } catch { /* best effort */ }
        if (Date.now() >= deadline) {
          throw new PanelImageRelayError("The connected panel image relay timed out.", "TIMEOUT");
        }
        if (response.ok === false) responseFailureMessage(response);
        if (
          response.updated < request.createdAt ||
          response.updated > request.deadlineAt ||
          Date.now() - response.updated > PANEL_IMAGE_RELAY_STALE_MS
        ) {
          throw new PanelImageRelayError("The panel returned a stale image relay reply.", "STALE_REPLY");
        }
        return { base64: response.base64, mimeType: response.mimeType, bytes: response.bytes };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new PanelImageRelayError("The connected panel image relay timed out.", "TIMEOUT");
  } finally {
    try { unlinkSync(requestFile); } catch { /* orchestrator may already have consumed it */ }
  }
}

async function matchingFiles(dir: string, prefix: string, limit: number): Promise<string[]> {
  let handle;
  try {
    handle = await opendir(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  let scanned = 0;
  try {
    while (scanned < PANEL_IMAGE_RELAY_MAX_DIRECTORY_ENTRIES_PER_TICK && files.length < limit) {
      const entry = await handle.read();
      if (!entry) break;
      scanned += 1;
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(prefix.length, -".json".length);
      if (isSafeRelayId(id)) files.push(entry.name);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return files;
}

async function reapStaleResponseFiles(dir: string, now: number): Promise<void> {
  const files = await matchingFiles(dir, PANEL_IMAGE_RELAY_RESPONSE_PREFIX, PANEL_IMAGE_RELAY_MAX_REQUESTS_PER_TICK);
  for (const name of files) {
    const path = join(dir, name);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > PANEL_IMAGE_RELAY_MAX_RESPONSE_FILE_BYTES || now - stat.mtimeMs > PANEL_IMAGE_RELAY_STALE_MS) {
        await unlink(path);
      }
    } catch {
      // A child may be atomically replacing or consuming the response.
    }
  }
}

async function processOneRequest(
  dir: string,
  file: string,
  bridge: PanelImageRelayBridge,
  resolvePanelTab: (agentKey: string) => string | undefined,
): Promise<void> {
  const requestId = file.slice(PANEL_IMAGE_RELAY_REQUEST_PREFIX.length, -".json".length);
  const fullPath = join(dir, file);
  let request: PanelImageRelayRequest | undefined;
  try {
    request = validateRequest(await readBoundedJson(fullPath, PANEL_IMAGE_RELAY_MAX_REQUEST_FILE_BYTES), requestId);
  } catch {
    request = undefined;
  }
  if (!request) {
    try {
      writeJsonAtomically(responsePath(dir, requestId), failureResponse(requestId, "MALFORMED_REQUEST"), PANEL_IMAGE_RELAY_MAX_RESPONSE_FILE_BYTES);
    } catch { /* child will time out safely */ }
    try { unlinkSync(fullPath); } catch { /* best effort */ }
    return;
  }
  const now = Date.now();
  const age = now - request.createdAt;
  if (age < -5_000 || age > PANEL_IMAGE_RELAY_STALE_MS || now >= request.deadlineAt) {
    try {
      writeJsonAtomically(responsePath(dir, requestId), failureResponse(requestId, now >= request.deadlineAt ? "TIMEOUT" : "STALE_REQUEST"), PANEL_IMAGE_RELAY_MAX_RESPONSE_FILE_BYTES);
    } catch { /* best effort */ }
    try { unlinkSync(fullPath); } catch { /* best effort */ }
    return;
  }

  let response: PanelImageRelayResponse;
  const panelTab = resolvePanelTab(request.requester);
  if (!panelTab || !bridge.canReach(panelTab)) {
    const failure = bridge.resolveFailure?.(panelTab ?? request.requester);
    response = failureResponse(
      requestId,
      failure === "ambiguous" ? "AMBIGUOUS_REQUESTER" : "NO_LIVE_PANEL",
    );
  } else {
    const remainingMs = request.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      response = failureResponse(requestId, "TIMEOUT");
      } else {
        try {
          const reply = await bridge.send(
            { cmd: "fetch_image", filename: request.filename, subfolder: request.subfolder, type: request.type },
            { tabId: panelTab, timeoutMs: Math.min(PANEL_IMAGE_RELAY_TIMEOUT_MS, remainingMs) },
          );
          const payload =
            reply && typeof reply === "object"
              ? validateImagePayload({
                  base64: (reply as Record<string, unknown>).base64,
                  mimeType: (reply as Record<string, unknown>).mimeType,
                  bytes: (reply as Record<string, unknown>).bytes,
                })
              : undefined;
          const replyRecord = reply && typeof reply === "object" ? reply as Record<string, unknown> : undefined;
          if (Date.now() >= request.deadlineAt) {
            response = failureResponse(requestId, "TIMEOUT");
          } else if (
            replyRecord?.ok === false &&
            hasOnlyKeys(replyRecord, ["ok", "error"]) &&
            isSafeText(replyRecord.error, 160)
          ) {
            response = failureResponse(requestId, "PANEL_FETCH_FAILED");
          } else if (
            !replyRecord ||
            replyRecord.ok !== true ||
            !payload ||
            !hasOnlyKeys(replyRecord, ["ok", "base64", "mimeType", "bytes"])
          ) {
            response = failureResponse(requestId, "MALFORMED_REPLY");
          } else {
            response = {
              version: PANEL_IMAGE_RELAY_VERSION,
              requestId,
              ok: true,
              ...payload,
              updated: Date.now(),
            };
          }
        } catch {
          response = failureResponse(requestId, Date.now() >= request.deadlineAt ? "TIMEOUT" : "PANEL_FETCH_FAILED");
        }
    }
  }
  try {
    writeJsonAtomically(responsePath(dir, requestId), response, PANEL_IMAGE_RELAY_MAX_RESPONSE_FILE_BYTES);
  } catch {
    // A bounded response that cannot be written is a failed relay; never retry
    // the request with a different target or fall back to a child-supplied URL.
  }
  try { unlinkSync(fullPath); } catch { /* best effort */ }
}

export interface ProcessPanelImageRequestsOptions {
  dir: string;
  bridge: PanelImageRelayBridge;
  /** Resolve both shared agent keys and real-tab agent keys to a live panel tab. */
  resolvePanelTab: (agentKey: string) => string | undefined;
  inFlight?: Set<string>;
}

function rejectQueuedRequest(dir: string, file: string): void {
  const requestId = file.slice(PANEL_IMAGE_RELAY_REQUEST_PREFIX.length, -".json".length);
  try {
    writeJsonAtomically(
      responsePath(dir, requestId),
      failureResponse(requestId, "BACKLOG_FULL"),
      PANEL_IMAGE_RELAY_MAX_RESPONSE_FILE_BYTES,
    );
  } catch {
    // The child will time out safely if the bounded failure cannot be published.
  }
  try { unlinkSync(join(dir, file)); } catch { /* best effort */ }
}

/** Orchestrator-side poll worker. Requests are consumed exactly once. */
export async function processPanelImageRequests({
  dir,
  bridge,
  resolvePanelTab,
  inFlight = new Set<string>(),
}: ProcessPanelImageRequestsOptions): Promise<void> {
  if (!dir) return;
  let dirStat;
  try {
    dirStat = await lstat(dir);
  } catch {
    return;
  }
  if (!dirStat.isDirectory()) return;
  await reapStaleResponseFiles(dir, Date.now());
  const pendingResponseCount = (
    await matchingFiles(dir, PANEL_IMAGE_RELAY_RESPONSE_PREFIX, PANEL_IMAGE_RELAY_MAX_PENDING_RESPONSES + 1)
  ).length;
  const responseCapacity = Math.max(0, PANEL_IMAGE_RELAY_MAX_PENDING_RESPONSES - pendingResponseCount);

  const candidates = await matchingFiles(
    dir,
    PANEL_IMAGE_RELAY_REQUEST_PREFIX,
    PANEL_IMAGE_RELAY_MAX_DIRECTORY_ENTRIES_PER_TICK,
  );
  const pending = candidates.filter((file) => !inFlight.has(file));
  const pendingCapacity = Math.max(0, PANEL_IMAGE_RELAY_MAX_PENDING_REQUESTS - inFlight.size);
  for (const file of pending.slice(pendingCapacity)) rejectQueuedRequest(dir, file);

  const available = Math.min(
    PANEL_IMAGE_RELAY_MAX_REQUESTS_PER_TICK,
    PANEL_IMAGE_RELAY_MAX_CONCURRENT - inFlight.size,
    pendingCapacity,
    responseCapacity,
  );
  const work = pending.slice(0, Math.max(0, available)).map(async (file) => {
      inFlight.add(file);
      try {
        await processOneRequest(dir, file, bridge, resolvePanelTab);
      } finally {
        inFlight.delete(file);
      }
    });
  await Promise.all(work);
}

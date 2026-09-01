import {
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, mkdtemp, open, opendir, rename, rmdir, unlink } from "node:fs/promises";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The only production path for a /view retry when the configured headless
 * ComfyUI target is unreachable. The child writes a reference-only request;
 * the orchestrator resolves an in-memory capability to a live panel and
 * performs the authenticated bridge command. The child supplies only the
 * canonical target identity it was spawned for; the orchestrator compares it
 * with its current target before and after the bridge command. No origin or
 * file-supplied tab identity crosses this channel.
 */
export const PANEL_IMAGE_RELAY_VERSION = 1;
export const PANEL_IMAGE_RELAY_MAX_BYTES = 32 * 1024 * 1024;
export const PANEL_IMAGE_RELAY_TIMEOUT_MS = 8_000;
export const PANEL_IMAGE_RELAY_STALE_MS = 15_000;
export const PANEL_IMAGE_RELAY_MAX_REQUEST_FILE_BYTES = 16 * 1024;
export const PANEL_IMAGE_RELAY_MAX_RESPONSE_FILE_BYTES = 48 * 1024 * 1024;
export const PANEL_COMFYUI_READ_MAX_BYTES = 16 * 1024 * 1024;
export const PANEL_COMFYUI_READ_OBJECT_INFO_MAX_BYTES = 32 * 1024 * 1024;
export const PANEL_COMFYUI_READ_OBJECT_INFO_TIMEOUT_MS = 30_000;
export const PANEL_IMAGE_RELAY_MAX_CONCURRENT = 4;
export const PANEL_IMAGE_RELAY_MAX_REQUESTS_PER_TICK = 4;
export const PANEL_IMAGE_RELAY_MAX_DIRECTORY_ENTRIES_PER_TICK = 128;
export const PANEL_IMAGE_RELAY_MAX_PENDING_REQUESTS = 16;
export const PANEL_IMAGE_RELAY_MAX_PENDING_RESPONSES = 4;
export const PANEL_IMAGE_RELAY_HTTP_PATH = "/__comfyui_mcp_panel_image_relay";
export const PANEL_IMAGE_RELAY_MAX_HTTP_REQUEST_BYTES = 16 * 1024;
export const PANEL_IMAGE_RELAY_MAX_HTTP_RESPONSE_BYTES = 48 * 1024 * 1024;

export const PANEL_IMAGE_RELAY_REQUEST_PREFIX = "control-image-request-";
export const PANEL_IMAGE_RELAY_RESPONSE_PREFIX = "control-image-response-";
const RELAY_ID_RE = /^[A-Za-z0-9_-]{16,80}$/;
const RELAY_CAPABILITY_RE = /^[a-f0-9]{64}$/;
const RELAY_SECRET_RE = /^[a-f0-9]{64}$/;
const IMAGE_TYPES = new Set<PanelImageType>(["output", "input", "temp"]);
const FIXED_READ_OPERATIONS = new Set<string>(["history", "system_stats", "logs", "object_info", "models"]);
const MODELS_FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}$/;

export type PanelImageType = "output" | "input" | "temp";
export type PanelComfyUIReadOperation =
  | "history"
  | "system_stats"
  | "logs"
  | "object_info"
  | "models"
  | `models/${string}`;

/** Closed allowlist: the four diagnostics reads, `/models`, or `/models/<folder>`. */
export function isPanelComfyUIReadOperation(value: string): value is PanelComfyUIReadOperation {
  if (FIXED_READ_OPERATIONS.has(value)) return true;
  if (!value.startsWith("models/")) return false;
  return MODELS_FOLDER_RE.test(value.slice("models/".length));
}

export interface PanelImageRelayRequest {
  version: typeof PANEL_IMAGE_RELAY_VERSION;
  requestId: string;
  capability: string;
  /** Target identity captured by the child at spawn time. */
  targetUrl: string;
  targetGeneration: number;
  filename: string;
  subfolder: string;
  type: PanelImageType;
  createdAt: number;
  deadlineAt: number;
}

export interface PanelComfyUIReadRelayRequest {
  version: typeof PANEL_IMAGE_RELAY_VERSION;
  requestId: string;
  capability: string;
  /** Target identity captured by the child at spawn time. */
  targetUrl: string;
  targetGeneration: number;
  operation: PanelComfyUIReadOperation;
  createdAt: number;
  deadlineAt: number;
}

export type PanelRelayRequest = PanelImageRelayRequest | PanelComfyUIReadRelayRequest;

export interface PanelImageRelayTarget {
  url: string;
  generation: number;
}

export type PanelImageRelayAuthInput = Pick<
  PanelImageRelayRequest,
  "requestId" | "targetUrl" | "targetGeneration" | "filename" | "subfolder" | "type" | "createdAt" | "deadlineAt"
>;

export interface PanelImageRelaySuccess {
  base64: string;
  mimeType: string;
  bytes: number;
}

export interface PanelComfyUIReadSuccess {
  operation: PanelComfyUIReadOperation;
  body: string;
  contentType: string | null;
  bytes: number;
}

/** The Panel dispatcher appends this witness to successful object results.
 * It is context metadata, not relay authorization: the HMAC and resolved tab
 * remain the authority. The relay validates this known shape, then drops it
 * while normalizing the four-field ComfyUI read contract. */
interface PanelComfyUIReadViewingWitness {
  scope: "root" | "subgraph";
  owner_node_id?: number | string | null;
  title?: string;
  workflow_uuid?: string;
  graph_identity?: string;
}

interface PanelImageRelayResponseFailure {
  version: typeof PANEL_IMAGE_RELAY_VERSION;
  requestId: string;
  ok: false;
  error: string;
  updated: number;
  /** #2703 - WHY the panel could not answer, when the code alone cannot say.
   *  Carried only for PANEL_FETCH_FAILED, the one code that stands for a whole
   *  family of distinct panel-side causes. Signed with the rest of the response;
   *  see panelFailureReason for what may appear here. */
  reason?: string;
}

interface PanelImageRelayResponseSuccess extends PanelImageRelaySuccess {
  version: typeof PANEL_IMAGE_RELAY_VERSION;
  requestId: string;
  ok: true;
  updated: number;
}

interface PanelComfyUIReadRelayResponseSuccess extends PanelComfyUIReadSuccess {
  version: typeof PANEL_IMAGE_RELAY_VERSION;
  requestId: string;
  ok: true;
  updated: number;
}

type PanelImageRelayResponse =
  | PanelImageRelayResponseSuccess
  | PanelImageRelayResponseFailure;

type PanelRelayResponse =
  | PanelImageRelayResponseSuccess
  | PanelComfyUIReadRelayResponseSuccess
  | PanelImageRelayResponseFailure;

type PanelImageRelayTransportResponse = PanelRelayResponse & { responseMac: string };

export interface PanelImageRelayBridge {
  canReach(tabId: string): boolean;
  resolveFailure?: (tabId: string) => "ambiguous" | "unresolved" | undefined;
  send(
    command:
      | { cmd: "fetch_image"; filename: string; subfolder: string; type: PanelImageType }
      | { cmd: "fetch_comfyui_read"; operation: PanelComfyUIReadOperation },
    options: { tabId: string; timeoutMs: number },
  ): Promise<unknown>;
}

export class PanelImageRelayError extends Error {
  readonly code: string;
  readonly unavailable: boolean;
  /** #2703 - the panel-side cause behind a PANEL_FETCH_FAILED, when one was
   *  carried. DIAGNOSTIC PROSE ONLY: nothing branches on it. */
  readonly reason?: string;

  constructor(message: string, code: string, unavailable = false, reason?: string) {
    super(message);
    this.name = "PanelImageRelayError";
    this.code = code;
    this.unavailable = unavailable;
    if (reason !== undefined) this.reason = reason;
  }
}

export class PanelComfyUIReadRelayError extends Error {
  readonly code: string;
  readonly unavailable: boolean;
  /** #2703 - see PanelImageRelayError.reason. */
  readonly reason?: string;

  constructor(message: string, code: string, unavailable = false, reason?: string) {
    super(message);
    this.name = "PanelComfyUIReadRelayError";
    this.code = code;
    this.unavailable = unavailable;
    if (reason !== undefined) this.reason = reason;
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

/**
 * How much of a panel-side failure cause may ride back with the code (#2703).
 *
 * 200 rather than the 160 used for `error`: `error` is a fixed token from a
 * closed set, while this is a sentence. The panel's longest shipped message
 * ("fetch_comfyui_read response exceeds the 16777216-byte limit") fits well
 * inside it, and a bound this size cannot be used to move a payload.
 */
const PANEL_FAILURE_REASON_MAX = 200;

/**
 * Turn the rejected bridge send into ONE sentence naming what actually went
 * wrong (#2703).
 *
 * WHY THIS EXISTS. `PANEL_FETCH_FAILED` is the answer for every non-timeout
 * throw out of `bridge.send`, and that is a whole family of distinct,
 * differently-actionable causes: the panel's own `too_large` (the read exceeded
 * its byte ceiling), `timeout`, `network_error`, `http_error` with a status,
 * `invalid_origin`, `redirect_error`, `api_unavailable`, the workflow-reload
 * guard, and an "Unknown command" from a panel that predates the read relay.
 * The code separates NONE of them, so the reporter on #2703 was told
 * "the connected panel ComfyUI read fallback failed safely (PANEL_FETCH_FAILED)"
 * - true, and unactionable. The error this catch is already holding says which
 * one it was; it was simply being dropped on the floor.
 *
 * TRUST. This is panel-authored prose reaching an agent, so it is treated the
 * way the image path already treats a panel-authored `error` string: bounded,
 * control characters removed, and gated on `isSafeText`. Nothing parses it and
 * nothing branches on it - it is one sentence appended to an error message.
 * There is no credential-reflection surface behind it either: the panel's read
 * helper builds its messages from a FIXED route, a status number, a byte count
 * and the browser's own fetch error, never from a response body (the class of
 * leak #385 hit). Anything that fails the guard is dropped whole rather than
 * repaired, so the worst case is exactly the pre-#2703 bare code.
 */
function panelFailureReason(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  // Control characters are folded to spaces rather than rejecting the whole
  // string: a message that merely wraps a line still carries its cause, and
  // dropping it would put us back at the bare code this exists to replace.
  const flattened = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!flattened) return undefined;
  const clipped =
    flattened.length > PANEL_FAILURE_REASON_MAX
      ? `${flattened.slice(0, PANEL_FAILURE_REASON_MAX - 1)}\u2026`
      : flattened;
  return isSafeText(clipped, PANEL_FAILURE_REASON_MAX) ? clipped : undefined;
}

/**
 * ABSENT or a bounded safe string - never anything else (#2703).
 *
 * Written as absent-OR-valid rather than folded into the `hasOnlyKeys` list
 * alone, because those two say different things: the key list decides which
 * fields MAY appear, and this decides what the field is allowed to contain. A
 * `reason` present but malformed is a malformed reply, not a reply with the
 * field quietly ignored - the MAC covers it, so a value we would not accept is
 * a value the writer and reader disagree about.
 */
function validFailureReason(record: Record<string, unknown>): boolean {
  if (!hasOwn(record, "reason")) return true;
  return isSafeText(record.reason, PANEL_FAILURE_REASON_MAX);
}

/** The one rendering of a carried reason, shared by both readers. */
function reasonSuffix(reason: string | undefined): string {
  return reason ? ` The panel reported: ${reason}` : "";
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

function isSafeRelayCapability(value: unknown): value is string {
  return typeof value === "string" && RELAY_CAPABILITY_RE.test(value);
}

function isSafeRelaySecret(value: unknown): value is string {
  return typeof value === "string" && RELAY_SECRET_RE.test(value);
}

const RELAY_TARGET_URL_MAX_LENGTH = 4_096;

/** Keep only the identity-bearing, non-secret parts of a ComfyUI URL. */
function canonicalRelayTargetUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > RELAY_TARGET_URL_MAX_LENGTH) return undefined;
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) return undefined;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

function relayTargetFromEnv(): PanelImageRelayTarget | undefined {
  const url = canonicalRelayTargetUrl(process.env.COMFYUI_URL);
  const rawGeneration = process.env.COMFYUI_MCP_TARGET_GENERATION?.trim();
  if (!url || !rawGeneration || !/^\d+$/.test(rawGeneration)) return undefined;
  const generation = Number(rawGeneration);
  if (!Number.isSafeInteger(generation) || generation < 0) return undefined;
  return { url, generation };
}

function relayTargetMatches(request: PanelRelayRequest, target: PanelImageRelayTarget | undefined): boolean {
  return !!target &&
    canonicalRelayTargetUrl(request.targetUrl) === canonicalRelayTargetUrl(target.url) &&
    request.targetGeneration === target.generation;
}

function currentRelayTarget(options: PanelImageRelayServerOptions): PanelImageRelayTarget | undefined {
  try {
    const target = options.resolveCurrentTarget();
    if (
      !target ||
      typeof target.url !== "string" ||
      !Number.isSafeInteger(target.generation) ||
      target.generation < 0 ||
      !canonicalRelayTargetUrl(target.url)
    ) return undefined;
    return target;
  } catch {
    return undefined;
  }
}

function currentPanelRelayTarget(
  options: PanelImageRelayServerOptions,
  tabId: string,
): PanelImageRelayTarget | undefined {
  try {
    const target = options.resolvePanelTarget(tabId);
    if (
      !target ||
      typeof target.url !== "string" ||
      !Number.isSafeInteger(target.generation) ||
      target.generation < 0 ||
      !canonicalRelayTargetUrl(target.url)
    ) return undefined;
    return target;
  } catch {
    return undefined;
  }
}

function relayTargetsMatch(
  options: PanelImageRelayServerOptions,
  request: PanelRelayRequest,
  panelTab: string,
): boolean {
  return relayTargetMatches(request, currentRelayTarget(options)) &&
    relayTargetMatches(request, currentPanelRelayTarget(options, panelTab));
}

function relayAuthPayload(input: PanelImageRelayAuthInput): string {
  return JSON.stringify([
    input.requestId,
    input.targetUrl,
    input.targetGeneration,
    input.filename,
    input.subfolder,
    input.type,
    input.createdAt,
    input.deadlineAt,
  ]);
}

export function makePanelImageRelayCapability(
  secret: string,
  input: PanelImageRelayAuthInput,
): string {
  return createHmac("sha256", secret).update(relayAuthPayload(input)).digest("hex");
}

export function verifyPanelImageRelayCapability(
  secret: string,
  request: PanelImageRelayRequest,
): boolean {
  if (!isSafeRelaySecret(secret) || !isSafeRelayCapability(request.capability)) return false;
  const expected = makePanelImageRelayCapability(secret, request);
  return timingSafeEqual(Buffer.from(request.capability, "hex"), Buffer.from(expected, "hex"));
}

function readRelayAuthPayload(input: Pick<PanelComfyUIReadRelayRequest, "requestId" | "targetUrl" | "targetGeneration" | "operation" | "createdAt" | "deadlineAt">): string {
  return JSON.stringify([
    "fetch_comfyui_read",
    input.requestId,
    input.targetUrl,
    input.targetGeneration,
    input.operation,
    input.createdAt,
    input.deadlineAt,
  ]);
}

export function makePanelComfyUIReadRelayCapability(
  secret: string,
  input: Pick<PanelComfyUIReadRelayRequest, "requestId" | "targetUrl" | "targetGeneration" | "operation" | "createdAt" | "deadlineAt">,
): string {
  return createHmac("sha256", secret).update(readRelayAuthPayload(input)).digest("hex");
}

export function verifyPanelComfyUIReadRelayCapability(
  secret: string,
  request: PanelComfyUIReadRelayRequest,
): boolean {
  if (
    !isSafeRelaySecret(secret) ||
    !isSafeRelayCapability(request.capability) ||
    !isPanelComfyUIReadOperation(request.operation)
  ) return false;
  const expected = makePanelComfyUIReadRelayCapability(secret, request);
  return timingSafeEqual(Buffer.from(request.capability, "hex"), Buffer.from(expected, "hex"));
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

function sameFileIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Read one bounded regular file through one descriptor; never stat then reopen. */
async function readBoundedJson(path: string, maxBytes: number): Promise<unknown> {
  const linkStat = await lstat(path);
  if (!linkStat.isFile() || linkStat.isSymbolicLink()) throw new Error("relay input is not a regular file");
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !sameFileIdentity(linkStat, stat) || stat.size > maxBytes) {
      throw new Error("relay input is not the handed-off regular file");
    }
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

async function createPrivateStagingDir(): Promise<string | undefined> {
  try {
    return await mkdtemp(join(tmpdir(), "comfyui-mcp-image-relay-"));
  } catch {
    return undefined;
  }
}

/** Move the untrusted directory entry without opening or following it. */
async function handoffRequest(dir: string, file: string, stagingDir: string): Promise<string | undefined> {
  const source = join(dir, file);
  const destination = join(stagingDir, file);
  try {
    await rename(source, destination);
    return destination;
  } catch {
    return undefined;
  }
}

async function handoffResponse(dir: string, requestId: string, stagingDir: string): Promise<string | undefined> {
  const file = `${PANEL_IMAGE_RELAY_RESPONSE_PREFIX}${requestId}.json`;
  const source = join(dir, file);
  const destination = join(stagingDir, file);
  try {
    await rename(source, destination);
    return destination;
  } catch {
    return undefined;
  }
}

async function removeStagedEntry(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await rmdir(path).catch(() => undefined);
    } else {
      await unlink(path).catch(() => undefined);
    }
  } catch {
    // The entry may already have been removed during shutdown or cleanup.
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

function validateReadPayload(value: unknown): PanelComfyUIReadSuccess | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(record, ["operation", "body", "contentType", "bytes", "viewing"]) ||
    typeof record.operation !== "string" ||
    !isPanelComfyUIReadOperation(record.operation) ||
    typeof record.body !== "string" ||
    (record.contentType !== null &&
      (typeof record.contentType !== "string" || !isSafeText(record.contentType, 128)))
  ) return undefined;
  const operation = record.operation;
  if (hasOwn(record, "viewing")) {
    const viewing = record.viewing;
    if (!viewing || typeof viewing !== "object" || Array.isArray(viewing)) return undefined;
    const witness = viewing as PanelComfyUIReadViewingWitness & Record<string, unknown>;
    if (
      !hasOnlyKeys(witness, ["scope", "owner_node_id", "title", "workflow_uuid", "graph_identity"]) ||
      (witness.scope !== "root" && witness.scope !== "subgraph")
    ) return undefined;
    if (hasOwn(witness, "owner_node_id")) {
      const owner = witness.owner_node_id;
      if (
        owner !== null &&
        !(typeof owner === "number" && Number.isSafeInteger(owner)) &&
        !(typeof owner === "string" && isSafeText(owner, 256))
      ) return undefined;
    }
    if (hasOwn(witness, "title") && !isSafeText(witness.title, 256)) return undefined;
    if (hasOwn(witness, "workflow_uuid") && !isSafeText(witness.workflow_uuid, 256)) return undefined;
    if (hasOwn(witness, "graph_identity") && !isSafeText(witness.graph_identity, 256)) return undefined;
  }
  const bytes = record.bytes;
  if (
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > readMaxBytes(operation) ||
    Buffer.byteLength(record.body, "utf8") !== bytes
  ) return undefined;
  const contentType = record.contentType === null ? null : record.contentType;
  if (contentType !== null && typeof contentType !== "string") return undefined;
  return {
    operation,
    body: record.body,
    contentType,
    bytes,
  };
}

function validateRequest(value: unknown, requestId: string): PanelImageRelayRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const capability = record.capability;
  const createdAt = record.createdAt;
  const deadlineAt = record.deadlineAt;
  if (
    !hasOnlyKeys(record, ["version", "requestId", "capability", "targetUrl", "targetGeneration", "filename", "subfolder", "type", "createdAt", "deadlineAt"]) ||
    record.version !== PANEL_IMAGE_RELAY_VERSION ||
    record.requestId !== requestId ||
    !isSafeRelayCapability(capability) ||
    !canonicalRelayTargetUrl(record.targetUrl) ||
    typeof record.targetGeneration !== "number" ||
    !Number.isSafeInteger(record.targetGeneration) ||
    record.targetGeneration < 0 ||
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

function validateReadRequest(value: unknown, requestId: string): PanelComfyUIReadRelayRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const capability = record.capability;
  const createdAt = record.createdAt;
  const deadlineAt = record.deadlineAt;
  if (
    !hasOnlyKeys(record, ["version", "requestId", "capability", "targetUrl", "targetGeneration", "operation", "createdAt", "deadlineAt"]) ||
    record.version !== PANEL_IMAGE_RELAY_VERSION ||
    record.requestId !== requestId ||
    !isSafeRelayCapability(capability) ||
    !canonicalRelayTargetUrl(record.targetUrl) ||
    typeof record.targetGeneration !== "number" ||
    !Number.isSafeInteger(record.targetGeneration) ||
    record.targetGeneration < 0 ||
    typeof record.operation !== "string" ||
    !isPanelComfyUIReadOperation(record.operation) ||
    typeof createdAt !== "number" ||
    typeof deadlineAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    !Number.isSafeInteger(deadlineAt) ||
    deadlineAt < createdAt ||
    deadlineAt - createdAt > readTimeoutMs(record.operation)
  ) return undefined;
  return record as unknown as PanelComfyUIReadRelayRequest;
}

function isReadRelayRequest(request: PanelRelayRequest): request is PanelComfyUIReadRelayRequest {
  return "operation" in request;
}

function readTimeoutMs(operation: PanelComfyUIReadOperation): number {
  return operation === "object_info" ? PANEL_COMFYUI_READ_OBJECT_INFO_TIMEOUT_MS : PANEL_IMAGE_RELAY_TIMEOUT_MS;
}

function readMaxBytes(operation: PanelComfyUIReadOperation): number {
  return operation === "object_info" ? PANEL_COMFYUI_READ_OBJECT_INFO_MAX_BYTES : PANEL_COMFYUI_READ_MAX_BYTES;
}

function requestTimeoutMs(request: PanelRelayRequest): number {
  return isReadRelayRequest(request) ? readTimeoutMs(request.operation) : PANEL_IMAGE_RELAY_TIMEOUT_MS;
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
    validFailureReason(record) &&
    hasOnlyKeys(record, ["version", "requestId", "ok", "error", "updated", "reason"])
  ) {
    return record as unknown as PanelImageRelayResponseFailure;
  }
  throw new PanelImageRelayError("The panel returned a malformed image relay reply.", "MALFORMED_REPLY");
}

function failureResponse(
  requestId: string,
  error: string,
  updated = Date.now(),
  reason?: string,
): PanelImageRelayResponseFailure {
  return {
    version: PANEL_IMAGE_RELAY_VERSION,
    requestId,
    ok: false,
    error,
    updated,
    // Omitted rather than set to undefined: the far side validates the KEY SET
    // with hasOnlyKeys, and JSON.stringify drops an explicit undefined anyway -
    // which would leave the two sides disagreeing about the shape they signed.
    ...(reason === undefined ? {} : { reason }),
  };
}

function responseFailureMessage(response: PanelImageRelayResponseFailure): never {
  const known = new Set([
    "AMBIGUOUS_REQUESTER",
    "BACKLOG_FULL",
    "MALFORMED_REPLY",
    "NO_LIVE_PANEL",
    "PANEL_FETCH_FAILED",
    "STALE_TARGET",
    "STALE_REQUEST",
    "TIMEOUT",
  ]);
  const code = known.has(response.error) ? response.error : "PANEL_FETCH_FAILED";
  // #2703 - only trust the reason on the code it was minted for. An unknown
  // `error` is remapped to PANEL_FETCH_FAILED above, and attaching a reason to
  // THAT would attribute a sentence to a code the writer never sent.
  const reason = response.error === code ? response.reason : undefined;
  throw new PanelImageRelayError(
    code === "PANEL_FETCH_FAILED"
      ? `The connected panel could not fetch that image.${reasonSuffix(reason)}`
      : `The connected panel image relay failed (${code}).`,
    code,
    false,
    reason,
  );
}

function responseMacPayload(response: PanelRelayResponse): string {
  if (!response.ok) {
    // `reason` is part of the SIGNED payload. A field the MAC does not cover is
    // a field the reader may not rely on, and this one is read out loud to the
    // user - an unauthenticated sentence attributed to the panel is worse than
    // no sentence at all. `?? null` keeps "no reason" a distinct signed value,
    // so a reasonless failure and a reasoned one never digest the same.
    return JSON.stringify([
      response.version,
      response.requestId,
      false,
      response.error,
      response.updated,
      response.reason ?? null,
    ]);
  }
  if ("operation" in response) {
    return JSON.stringify([
      response.version,
      response.requestId,
      true,
      response.operation,
      response.body,
      response.contentType,
      response.bytes,
      response.updated,
    ]);
  }
  return JSON.stringify([
    response.version,
    response.requestId,
    true,
    response.base64,
    response.mimeType,
    response.bytes,
    response.updated,
  ]);
}

function addResponseMac(secret: string, response: PanelRelayResponse): PanelImageRelayTransportResponse {
  return {
    ...response,
    responseMac: createHmac("sha256", secret).update(responseMacPayload(response)).digest("hex"),
  };
}

function validateReadResponse(
  value: unknown,
  requestId: string,
  operation: PanelComfyUIReadOperation,
): PanelComfyUIReadRelayResponseSuccess | PanelImageRelayResponseFailure {
  if (!value || typeof value !== "object") {
    throw new PanelComfyUIReadRelayError("The panel returned a malformed ComfyUI read reply.", "MALFORMED_REPLY");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== PANEL_IMAGE_RELAY_VERSION ||
    record.requestId !== requestId ||
    !hasOwn(record, "ok") ||
    !Number.isSafeInteger(record.updated)
  ) throw new PanelComfyUIReadRelayError("The panel returned a malformed ComfyUI read reply.", "MALFORMED_REPLY");
  if (record.ok === false) {
    if (
      typeof record.error === "string" &&
      record.error.length <= 160 &&
      isSafeText(record.error, 160) &&
      validFailureReason(record) &&
      hasOnlyKeys(record, ["version", "requestId", "ok", "error", "updated", "reason"])
    ) return record as unknown as PanelImageRelayResponseFailure;
    throw new PanelComfyUIReadRelayError("The panel returned a malformed ComfyUI read reply.", "MALFORMED_REPLY");
  }
  const payload = validateReadPayload({
    operation: record.operation,
    body: record.body,
    contentType: record.contentType,
    bytes: record.bytes,
  });
  if (
    record.ok !== true ||
    !payload ||
    payload.operation !== operation ||
    !hasOnlyKeys(record, ["version", "requestId", "ok", "operation", "body", "contentType", "bytes", "updated"])
  ) throw new PanelComfyUIReadRelayError("The panel returned a malformed ComfyUI read reply.", "MALFORMED_REPLY");
  return { ...payload, version: PANEL_IMAGE_RELAY_VERSION, requestId, ok: true, updated: record.updated as number };
}

function validateReadTransportResponse(
  value: unknown,
  requestId: string,
  secret: string,
  operation: PanelComfyUIReadOperation,
): PanelComfyUIReadRelayResponseSuccess | PanelImageRelayResponseFailure {
  if (!value || typeof value !== "object") {
    throw new PanelComfyUIReadRelayError("The panel returned a malformed ComfyUI read reply.", "MALFORMED_REPLY");
  }
  const record = value as Record<string, unknown>;
  const responseMac = record.responseMac;
  if (!isSafeRelayCapability(responseMac) || !hasOwn(record, "responseMac")) {
    throw new PanelComfyUIReadRelayError("The panel returned an unauthenticated ComfyUI read reply.", "MALFORMED_REPLY");
  }
  const { responseMac: ignored, ...unsigned } = record;
  const response = validateReadResponse(unsigned, requestId, operation);
  const expected = createHmac("sha256", secret).update(responseMacPayload(response)).digest("hex");
  if (!timingSafeEqual(Buffer.from(responseMac, "hex"), Buffer.from(expected, "hex"))) {
    throw new PanelComfyUIReadRelayError("The panel returned an unauthenticated ComfyUI read reply.", "MALFORMED_REPLY");
  }
  return response;
}

function validateTransportResponse(
  value: unknown,
  requestId: string,
  secret: string,
): PanelImageRelayResponse {
  if (!value || typeof value !== "object") {
    throw new PanelImageRelayError("The panel returned a malformed image relay reply.", "MALFORMED_REPLY");
  }
  const record = value as Record<string, unknown>;
  const responseMac = record.responseMac;
  if (!isSafeRelayCapability(responseMac) || !hasOwn(record, "responseMac")) {
    throw new PanelImageRelayError("The panel returned an unauthenticated image relay reply.", "MALFORMED_REPLY");
  }
  const { responseMac: ignored, ...unsigned } = record;
  const response = validateResponse(unsigned, requestId);
  const expected = createHmac("sha256", secret).update(responseMacPayload(response)).digest("hex");
  if (!timingSafeEqual(Buffer.from(responseMac, "hex"), Buffer.from(expected, "hex"))) {
    throw new PanelImageRelayError("The panel returned an unauthenticated image relay reply.", "MALFORMED_REPLY");
  }
  return response;
}

function relayEndpoint(): URL | undefined {
  const raw = process.env.COMFYUI_MCP_RELAY_URL?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      Number(url.port) < 1 ||
      Number(url.port) > 65535 ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== PANEL_IMAGE_RELAY_HTTP_PATH
    ) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

async function readHttpResponseBounded(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      throw new PanelImageRelayError("The panel relay response exceeded its safety limit.", "RESPONSE_TOO_LARGE");
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new PanelImageRelayError("The panel relay response exceeded its safety limit.", "RESPONSE_TOO_LARGE");
    }
    return JSON.parse(text) as unknown;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PanelImageRelayError("The panel relay response exceeded its safety limit.", "RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
}

function requestDeadline(request: PanelRelayRequest): number {
  return Math.min(request.deadlineAt, request.createdAt + requestTimeoutMs(request));
}

function errorCodeFromHttpBody(value: unknown, status: number): string {
  if (value && typeof value === "object" && typeof (value as Record<string, unknown>).error === "string") {
    const error = (value as Record<string, unknown>).error as string;
    if (/^[A-Z_]{3,40}$/.test(error)) return error;
  }
  if (status === 400) return "MALFORMED_REQUEST";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 429) return "BACKLOG_FULL";
  return "RELAY_UNAVAILABLE";
}

function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = req.headers["content-length"];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      return Promise.reject(new PanelImageRelayError("The relay request exceeded its safety limit.", "REQUEST_TOO_LARGE"));
    }
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error: Error | undefined, value?: Buffer) => {
      if (settled) return;
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAborted);
      req.setTimeout(0);
      if (error) reject(error);
      else resolve(value ?? Buffer.alloc(0));
    };
    const onData = (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += data.byteLength;
      if (total > maxBytes) {
        req.destroy();
        finish(new PanelImageRelayError("The relay request exceeded its safety limit.", "REQUEST_TOO_LARGE"));
        return;
      }
      chunks.push(data);
    };
    const onEnd = () => finish(undefined, Buffer.concat(chunks, total));
    const onError = () => finish(new PanelImageRelayError("The relay request was interrupted.", "RELAY_UNAVAILABLE", true));
    const onAborted = () => finish(new PanelImageRelayError("The relay request was interrupted.", "RELAY_UNAVAILABLE", true));
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
    req.setTimeout(PANEL_IMAGE_RELAY_TIMEOUT_MS + 1_000, () => {
      req.destroy();
      finish(new PanelImageRelayError("The relay request timed out.", "TIMEOUT"));
    });
  });
}

function writeHttpJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength > PANEL_IMAGE_RELAY_MAX_HTTP_RESPONSE_BYTES) {
    res.writeHead(500, { "content-type": "application/json", "content-length": "0" });
    res.end();
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.byteLength),
    connection: "close",
  });
  res.end(body);
}

async function withinDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new PanelImageRelayError("The panel image relay timed out.", "TIMEOUT");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new PanelImageRelayError("The panel image relay timed out.", "TIMEOUT")), remaining);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface PanelImageRelayResolvedAgent {
  agentKey: string;
  secret: string;
}

export interface PanelImageRelayServerOptions {
  bridge: PanelImageRelayBridge;
  resolvePanelAgent: (request: PanelRelayRequest) => PanelImageRelayResolvedAgent | undefined;
  resolvePanelTab: (agentKey: string) => string | undefined;
  /** The orchestrator's authoritative target and monotonic generation. */
  resolveCurrentTarget: () => PanelImageRelayTarget;
  /** The exact target identity currently proven for the selected live panel tab. */
  resolvePanelTarget: (tabId: string) => PanelImageRelayTarget | undefined;
}

export interface PanelImageRelayServer {
  endpointUrl: string;
  close(): Promise<void>;
}

/**
 * The production child/orchestrator channel. It binds only to IPv4 loopback,
 * authenticates the reference before resolving an agent, and never reads the
 * shared progress directory. The file poller below is retained solely for
 * legacy/unit coverage and is not wired into the orchestrator.
 */
export async function startPanelImageRelayServer(
  options: PanelImageRelayServerOptions,
): Promise<PanelImageRelayServer> {
  let active = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== PANEL_IMAGE_RELAY_HTTP_PATH) {
        writeHttpJson(res, 404, { ok: false, error: "NOT_FOUND" });
        return;
      }
      if (active >= PANEL_IMAGE_RELAY_MAX_CONCURRENT) {
        writeHttpJson(res, 429, { ok: false, error: "BACKLOG_FULL" });
        return;
      }
      active += 1;
      try {
        let body: Buffer;
        try {
          body = await readRequestBody(req, PANEL_IMAGE_RELAY_MAX_HTTP_REQUEST_BYTES);
        } catch (error) {
          const status = error instanceof PanelImageRelayError && error.code === "REQUEST_TOO_LARGE" ? 413 : 408;
          writeHttpJson(res, status, { ok: false, error: error instanceof PanelImageRelayError ? error.code : "MALFORMED_REQUEST" });
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(body.toString("utf8")) as unknown;
        } catch {
          writeHttpJson(res, 400, { ok: false, error: "MALFORMED_REQUEST" });
          return;
        }
        const rawRecord = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
        const requestId = rawRecord?.requestId;
        const request = isSafeRelayId(requestId)
          ? rawRecord && hasOwn(rawRecord, "operation")
            ? validateReadRequest(raw, requestId)
            : validateRequest(raw, requestId)
          : undefined;
        if (!request) {
          writeHttpJson(res, 400, { ok: false, error: "MALFORMED_REQUEST" });
          return;
        }
        const auth = options.resolvePanelAgent(request);
        if (!auth || !isSafeRelaySecret(auth.secret)) {
          writeHttpJson(res, 401, { ok: false, error: "UNAUTHORIZED" });
          return;
        }
        const now = Date.now();
        const age = now - request.createdAt;
        let response: PanelRelayResponse;
        if (age < -5_000 || age > PANEL_IMAGE_RELAY_STALE_MS || now >= requestDeadline(request)) {
          response = failureResponse(
            request.requestId,
            now >= requestDeadline(request) ? "TIMEOUT" : "STALE_REQUEST",
            now >= requestDeadline(request) ? requestDeadline(request) : now,
          );
        } else if (!relayTargetMatches(request, currentRelayTarget(options))) {
          // A child can remain on the previous target while its agent turn drains
          // across a retarget. Never let that authenticated child address the new
          // live panel: the capability proves ownership, not target freshness.
          response = failureResponse(request.requestId, "STALE_TARGET");
        } else {
          const panelTab = options.resolvePanelTab(auth.agentKey);
          if (!panelTab || !options.bridge.canReach(panelTab)) {
            response = failureResponse(
              request.requestId,
              options.bridge.resolveFailure?.(auth.agentKey) === "ambiguous" ? "AMBIGUOUS_REQUESTER" : "NO_LIVE_PANEL",
            );
          } else if (!relayTargetsMatch(options, request, panelTab)) {
            // The global target fence does not prove that this particular tab
            // fronts the child target. Missing, stale, or ambiguous tab proof
            // must refuse before the targetless bridge command is dispatched.
            response = failureResponse(request.requestId, "STALE_TARGET");
          } else {
            const remainingMs = requestDeadline(request) - Date.now();
            if (remainingMs <= 0) {
              response = failureResponse(request.requestId, "TIMEOUT", requestDeadline(request));
            } else if (!relayTargetsMatch(options, request, panelTab)) {
              response = failureResponse(request.requestId, "STALE_TARGET");
            } else {
              try {
                const reply = await withinDeadline(
                  options.bridge.send(
                    isReadRelayRequest(request)
                      ? { cmd: "fetch_comfyui_read", operation: request.operation }
                      : { cmd: "fetch_image", filename: request.filename, subfolder: request.subfolder, type: request.type },
                    { tabId: panelTab, timeoutMs: Math.min(requestTimeoutMs(request), remainingMs) },
                  ),
                  requestDeadline(request),
                );
                const replyRecord = reply && typeof reply === "object" ? reply as Record<string, unknown> : undefined;
                const imagePayload = !isReadRelayRequest(request) && replyRecord
                  ? validateImagePayload({ base64: replyRecord.base64, mimeType: replyRecord.mimeType, bytes: replyRecord.bytes })
                  : undefined;
                if (!relayTargetsMatch(options, request, panelTab)) {
                  response = failureResponse(request.requestId, "STALE_TARGET");
                } else if (Date.now() >= requestDeadline(request)) {
                  response = failureResponse(request.requestId, "TIMEOUT", requestDeadline(request));
                } else if (isReadRelayRequest(request)) {
                  const payload = replyRecord ? validateReadPayload(replyRecord) : undefined;
                  if (!payload || payload.operation !== request.operation) {
                    response = failureResponse(request.requestId, "MALFORMED_REPLY");
                  } else {
                    response = {
                      version: PANEL_IMAGE_RELAY_VERSION,
                      requestId: request.requestId,
                      ok: true,
                      ...payload,
                      updated: Date.now(),
                    };
                  }
                } else if (replyRecord?.ok === false && hasOnlyKeys(replyRecord, ["ok", "error"]) && isSafeText(replyRecord.error, 160)) {
                  response = failureResponse(request.requestId, "PANEL_FETCH_FAILED");
                } else if (!replyRecord || replyRecord.ok !== true || !imagePayload || !hasOnlyKeys(replyRecord, ["ok", "base64", "mimeType", "bytes"])) {
                  response = failureResponse(request.requestId, "MALFORMED_REPLY");
                } else {
                  response = { version: PANEL_IMAGE_RELAY_VERSION, requestId: request.requestId, ok: true, ...imagePayload, updated: Date.now() };
                }
              } catch (error) {
                const timedOut = error instanceof PanelImageRelayError && error.code === "TIMEOUT";
                response = failureResponse(
                  request.requestId,
                  timedOut ? "TIMEOUT" : "PANEL_FETCH_FAILED",
                  timedOut ? requestDeadline(request) : Date.now(),
                  // #2703 - TIMEOUT already says what happened and by when; only
                  // PANEL_FETCH_FAILED is the code that stands for many causes,
                  // so only it needs the sentence.
                  timedOut ? undefined : panelFailureReason(error),
                );
              }
            }
          }
        }
        writeHttpJson(res, 200, addResponseMac(auth.secret, response));
      } catch {
        if (!res.headersSent) writeHttpJson(res, 503, { ok: false, error: "RELAY_UNAVAILABLE" });
      } finally {
        active -= 1;
      }
    })();
  });
  server.headersTimeout = 2_000;
  server.requestTimeout = PANEL_COMFYUI_READ_OBJECT_INFO_TIMEOUT_MS + 1_000;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port: 0 });
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1" || !address.port) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("panel image relay did not bind to IPv4 loopback");
  }
  return {
    endpointUrl: `http://127.0.0.1:${address.port}${PANEL_IMAGE_RELAY_HTTP_PATH}`,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
    }),
  };
}

/** Child-side production request over the authenticated loopback HTTP channel. */
export async function requestPanelImage(
  filename: string,
  type: PanelImageType,
  subfolder: string,
): Promise<PanelImageRelaySuccess | undefined> {
  if (!isSafePanelImageRef(filename, subfolder, type)) {
    throw new PanelImageRelayError("The image reference is unsafe and was refused.", "UNSAFE_REFERENCE");
  }
  const endpoint = relayEndpoint();
  const secret = process.env.COMFYUI_MCP_RELAY_SECRET;
  if (!endpoint || !isSafeRelaySecret(secret)) return undefined;
  const target = relayTargetFromEnv();
  if (!target) return undefined;
  const createdAt = Date.now();
  const request: PanelImageRelayRequest = {
    version: PANEL_IMAGE_RELAY_VERSION,
    requestId: `${Date.now().toString(36)}-${process.pid.toString(36)}-${randomBytes(8).toString("hex")}`,
    capability: "",
    targetUrl: target.url,
    targetGeneration: target.generation,
    filename,
    subfolder,
    type,
    createdAt,
    deadlineAt: createdAt + PANEL_IMAGE_RELAY_TIMEOUT_MS,
  };
  request.capability = makePanelImageRelayCapability(secret, request);
  const body = Buffer.from(JSON.stringify(request), "utf8");
  if (body.byteLength > PANEL_IMAGE_RELAY_MAX_HTTP_REQUEST_BYTES) {
    throw new PanelImageRelayError("The relay request exceeded its safety limit.", "REQUEST_TOO_LARGE");
  }
  let httpResponse: Response;
  try {
    httpResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.byteLength) },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(PANEL_IMAGE_RELAY_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof PanelImageRelayError) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new PanelImageRelayError("The connected panel image relay timed out.", "TIMEOUT");
    }
    throw new PanelImageRelayError("The connected panel relay is unavailable.", "RELAY_UNAVAILABLE", true);
  }
  let decoded: unknown;
  try {
    decoded = await readHttpResponseBounded(httpResponse, PANEL_IMAGE_RELAY_MAX_HTTP_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof PanelImageRelayError) throw error;
    throw new PanelImageRelayError("The panel returned a malformed image relay reply.", "MALFORMED_REPLY");
  }
  if (!httpResponse.ok) {
    const code = errorCodeFromHttpBody(decoded, httpResponse.status);
    throw new PanelImageRelayError(
      code === "RELAY_UNAVAILABLE" ? "The connected panel relay is unavailable." : `The connected panel image relay failed (${code}).`,
      code,
      httpResponse.status >= 500,
    );
  }
  const response = validateTransportResponse(decoded, request.requestId, secret);
  const responseAge = Date.now() - response.updated;
  const authenticatedTimeout = response.ok === false && response.error === "TIMEOUT";
  if (
    !authenticatedTimeout &&
    (response.updated < request.createdAt ||
      response.updated > request.deadlineAt ||
      responseAge < -5_000 ||
      responseAge > PANEL_IMAGE_RELAY_STALE_MS)
  ) {
    throw new PanelImageRelayError("The panel returned a stale image relay reply.", "STALE_REPLY");
  }
  if (response.ok === false) responseFailureMessage(response);
  return { base64: response.base64, mimeType: response.mimeType, bytes: response.bytes };
}

/** Child-side production request for one fixed ComfyUI read over the same
 * authenticated loopback channel as the image relay. */
export async function requestPanelComfyUIRead(
  operation: PanelComfyUIReadOperation,
): Promise<PanelComfyUIReadSuccess | undefined> {
  if (!isPanelComfyUIReadOperation(operation)) {
    throw new PanelComfyUIReadRelayError("The ComfyUI read operation was refused.", "UNSAFE_OPERATION");
  }
  const endpoint = relayEndpoint();
  const secret = process.env.COMFYUI_MCP_RELAY_SECRET;
  if (!endpoint || !isSafeRelaySecret(secret)) return undefined;
  const target = relayTargetFromEnv();
  if (!target) return undefined;
  const createdAt = Date.now();
  const timeoutMs = readTimeoutMs(operation);
  const request: PanelComfyUIReadRelayRequest = {
    version: PANEL_IMAGE_RELAY_VERSION,
    requestId: `${Date.now().toString(36)}-${process.pid.toString(36)}-${randomBytes(8).toString("hex")}`,
    capability: "",
    targetUrl: target.url,
    targetGeneration: target.generation,
    operation,
    createdAt,
    deadlineAt: createdAt + timeoutMs,
  };
  request.capability = makePanelComfyUIReadRelayCapability(secret, request);
  const body = Buffer.from(JSON.stringify(request), "utf8");
  if (body.byteLength > PANEL_IMAGE_RELAY_MAX_HTTP_REQUEST_BYTES) {
    throw new PanelComfyUIReadRelayError("The relay request exceeded its safety limit.", "REQUEST_TOO_LARGE");
  }
  let httpResponse: Response;
  try {
    httpResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.byteLength) },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof PanelComfyUIReadRelayError) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new PanelComfyUIReadRelayError("The connected panel read relay timed out.", "TIMEOUT");
    }
    throw new PanelComfyUIReadRelayError("The connected panel read relay is unavailable.", "RELAY_UNAVAILABLE", true);
  }
  let decoded: unknown;
  try {
    decoded = await readHttpResponseBounded(httpResponse, PANEL_IMAGE_RELAY_MAX_HTTP_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof PanelComfyUIReadRelayError) throw error;
    throw new PanelComfyUIReadRelayError("The panel returned a malformed ComfyUI read reply.", "MALFORMED_REPLY");
  }
  if (!httpResponse.ok) {
    const code = errorCodeFromHttpBody(decoded, httpResponse.status);
    throw new PanelComfyUIReadRelayError(
      code === "RELAY_UNAVAILABLE" ? "The connected panel read relay is unavailable." : `The connected panel read relay failed (${code}).`,
      code,
      httpResponse.status >= 500,
    );
  }
  const response = validateReadTransportResponse(decoded, request.requestId, secret, operation);
  const responseAge = Date.now() - response.updated;
  const authenticatedTimeout = response.ok === false && response.error === "TIMEOUT";
  if (
    !authenticatedTimeout &&
    (response.updated < request.createdAt ||
      response.updated > request.deadlineAt ||
      responseAge < -5_000 ||
      responseAge > PANEL_IMAGE_RELAY_STALE_MS)
  ) {
    throw new PanelComfyUIReadRelayError("The panel returned a stale ComfyUI read reply.", "STALE_REPLY");
  }
  if (response.ok === false) {
    const known = new Set([
      "AMBIGUOUS_REQUESTER",
      "BACKLOG_FULL",
      "MALFORMED_REPLY",
      "NO_LIVE_PANEL",
      "PANEL_FETCH_FAILED",
      "STALE_TARGET",
      "STALE_REQUEST",
      "TIMEOUT",
    ]);
    const code = known.has(response.error) ? response.error : "PANEL_FETCH_FAILED";
    // #2703 - see responseFailureMessage: a remapped code keeps no reason.
    const reason = response.error === code ? response.reason : undefined;
    throw new PanelComfyUIReadRelayError(
      code === "PANEL_FETCH_FAILED"
        ? `The connected panel could not read ComfyUI.${reasonSuffix(reason)}`
        : `The connected panel ComfyUI read relay failed (${code}).`,
      code,
      false,
      reason,
    );
  }
  return {
    operation: response.operation,
    body: response.body,
    contentType: response.contentType,
    bytes: response.bytes,
  };
}

/** Legacy file-channel request writer, retained for focused/unit coverage only. */
export async function requestPanelImageFromFileChannel(
  filename: string,
  type: PanelImageType,
  subfolder: string,
): Promise<PanelImageRelaySuccess | undefined> {
  const dir = process.env.COMFYUI_MCP_PROGRESS_DIR?.trim() ?? "";
  const secret = process.env.COMFYUI_MCP_RELAY_SECRET;
  if (!dir || !isSafeRelaySecret(secret)) return undefined;
  const target = relayTargetFromEnv();
  if (!target) return undefined;
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
    capability: "",
    targetUrl: target.url,
    targetGeneration: target.generation,
    filename,
    subfolder,
    type,
    createdAt,
    deadlineAt: createdAt + PANEL_IMAGE_RELAY_TIMEOUT_MS,
  };
  request.capability = makePanelImageRelayCapability(secret, request);
  const requestFile = requestPath(dir, requestId);
  const responseStagingDir = await createPrivateStagingDir();
  if (!responseStagingDir) {
    throw new PanelImageRelayError("The connected panel relay is unavailable.", "REQUEST_WRITE_FAILED", true);
  }
  try {
    writeJsonAtomically(requestFile, request, PANEL_IMAGE_RELAY_MAX_REQUEST_FILE_BYTES);
  } catch {
    await removeStagedEntry(responseStagingDir);
    throw new PanelImageRelayError("The connected panel relay is unavailable.", "REQUEST_WRITE_FAILED", true);
  }

  const deadline = request.deadlineAt;
  try {
    while (Date.now() < deadline) {
      const stagedResponsePath = await handoffResponse(dir, requestId, responseStagingDir);
      if (stagedResponsePath) {
        if (Date.now() >= deadline) {
          await removeStagedEntry(stagedResponsePath);
          throw new PanelImageRelayError("The connected panel image relay timed out.", "TIMEOUT");
        }
        let response: PanelImageRelayResponse;
        try {
          response = validateResponse(
            await readBoundedJson(stagedResponsePath, PANEL_IMAGE_RELAY_MAX_RESPONSE_FILE_BYTES),
            requestId,
          );
        } catch (error) {
          await removeStagedEntry(stagedResponsePath);
          if (error instanceof PanelImageRelayError) throw error;
          throw new PanelImageRelayError("The panel returned a malformed image relay reply.", "MALFORMED_REPLY");
        }
        await removeStagedEntry(stagedResponsePath);
        if (Date.now() >= deadline) {
          throw new PanelImageRelayError("The connected panel image relay timed out.", "TIMEOUT");
        }
        const responseAge = Date.now() - response.updated;
        if (
          response.updated < request.createdAt ||
          response.updated > request.deadlineAt ||
          responseAge < -5_000 ||
          responseAge > PANEL_IMAGE_RELAY_STALE_MS
        ) {
          throw new PanelImageRelayError("The panel returned a stale image relay reply.", "STALE_REPLY");
        }
        if (response.ok === false) responseFailureMessage(response);
        return { base64: response.base64, mimeType: response.mimeType, bytes: response.bytes };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new PanelImageRelayError("The connected panel image relay timed out.", "TIMEOUT");
  } finally {
    try { unlinkSync(requestFile); } catch { /* orchestrator may already have consumed it */ }
    await removeStagedEntry(responseStagingDir);
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
  stagingDir: string,
  resolvePanelAgentKey: (request: PanelImageRelayRequest) => string | undefined,
  resolvePanelTab: (agentKey: string) => string | undefined,
): Promise<void> {
  const requestId = file.slice(PANEL_IMAGE_RELAY_REQUEST_PREFIX.length, -".json".length);
  const stagedPath = await handoffRequest(dir, file, stagingDir);
  if (!stagedPath) return;
  let request: PanelImageRelayRequest | undefined;
  try {
    request = validateRequest(await readBoundedJson(stagedPath, PANEL_IMAGE_RELAY_MAX_REQUEST_FILE_BYTES), requestId);
  } catch {
    request = undefined;
  }
  if (!request) {
    try {
      writeJsonAtomically(responsePath(dir, requestId), failureResponse(requestId, "MALFORMED_REQUEST"), PANEL_IMAGE_RELAY_MAX_RESPONSE_FILE_BYTES);
    } catch { /* child will time out safely */ }
    await removeStagedEntry(stagedPath);
    return;
  }
  const now = Date.now();
  const age = now - request.createdAt;
  if (age < -5_000 || age > PANEL_IMAGE_RELAY_STALE_MS || now >= request.deadlineAt) {
    try {
      writeJsonAtomically(responsePath(dir, requestId), failureResponse(requestId, now >= request.deadlineAt ? "TIMEOUT" : "STALE_REQUEST"), PANEL_IMAGE_RELAY_MAX_RESPONSE_FILE_BYTES);
    } catch { /* best effort */ }
    await removeStagedEntry(stagedPath);
    return;
  }

  let response: PanelImageRelayResponse;
  const agentKey = resolvePanelAgentKey(request);
  const panelTab = agentKey ? resolvePanelTab(agentKey) : undefined;
  if (!panelTab || !bridge.canReach(panelTab)) {
    const failure = agentKey ? bridge.resolveFailure?.(agentKey) : undefined;
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
  await removeStagedEntry(stagedPath);
}

export interface ProcessPanelImageRequestsOptions {
  dir: string;
  bridge: PanelImageRelayBridge;
  /** Verify the request MAC and resolve it to the owning agent key. */
  resolvePanelAgentKey: (request: PanelImageRelayRequest) => string | undefined;
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
  resolvePanelAgentKey,
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
  if (available <= 0) return;
  const stagingDir = await createPrivateStagingDir();
  if (!stagingDir) return;
  try {
    const work = pending.slice(0, available).map(async (file) => {
        inFlight.add(file);
        try {
          await processOneRequest(dir, file, bridge, stagingDir, resolvePanelAgentKey, resolvePanelTab);
        } finally {
          inFlight.delete(file);
        }
      });
    await Promise.all(work);
  } finally {
    await removeStagedEntry(stagingDir);
  }
}

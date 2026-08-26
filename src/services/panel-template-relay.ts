import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Authenticated loopback relay for the read-only workflow-template index.
 *
 * The list_packs child cannot reach the panel bridge directly. It sends only a
 * capability-bound request to the orchestrator; the orchestrator resolves the
 * live panel tab and fetches the fixed /api/workflow_templates route from that
 * tab's server-observed origin, but only when it is the current ComfyUI target.
 * No configured ComfyUI credentials or caller-supplied URL crosses this
 * boundary.
 */
export const PANEL_TEMPLATE_RELAY_VERSION = 1;
export const PANEL_TEMPLATE_RELAY_TIMEOUT_MS = 8_000;
export const PANEL_TEMPLATE_RELAY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const PANEL_TEMPLATE_RELAY_MAX_REQUEST_BYTES = 16 * 1024;
export const PANEL_TEMPLATE_RELAY_MAX_CONCURRENT = 4;
export const PANEL_TEMPLATE_RELAY_STALE_MS = 15_000;
export const PANEL_TEMPLATE_RELAY_HTTP_PATH = "/__comfyui_mcp_panel_template_relay";

const ID_RE = /^[A-Za-z0-9_-]{16,80}$/;
const HEX_RE = /^[a-f0-9]{64}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export interface PanelTemplateRelayRequest {
  version: typeof PANEL_TEMPLATE_RELAY_VERSION;
  requestId: string;
  capability: string;
  createdAt: number;
  deadlineAt: number;
}

export interface PanelTemplateRelaySuccess {
  index: Record<string, unknown>;
}

type Failure = {
  version: typeof PANEL_TEMPLATE_RELAY_VERSION;
  requestId: string;
  ok: false;
  error: string;
  updated: number;
};

type Success = {
  version: typeof PANEL_TEMPLATE_RELAY_VERSION;
  requestId: string;
  ok: true;
  body: string;
  updated: number;
};

type ResponseBody = Failure | Success;
type TransportResponse = ResponseBody & { responseMac: string };

export interface PanelTemplateRelayBridge {
  canReach(tabId: string): boolean;
  resolveFailure?: (tabId: string) => "ambiguous" | "unresolved" | undefined;
}

export interface PanelTemplateRelayResolvedAgent {
  agentKey: string;
  secret: string;
}

export interface PanelTemplateRelayTarget {
  url: string;
  generation: number;
}

export interface PanelTemplateRelayServerOptions {
  bridge: PanelTemplateRelayBridge;
  resolvePanelAgent: (request: PanelTemplateRelayRequest) => PanelTemplateRelayResolvedAgent | undefined;
  resolvePanelTab: (agentKey: string) => string | undefined;
  /** Captures the authoritative target identity for this request. */
  resolveCurrentTarget: () => PanelTemplateRelayTarget;
  resolvePanelUrl: (tabId: string, currentTarget: string) => string | undefined;
  /** Must return undefined unless the tab's origin is authorized for currentTarget. */
  resolveAllowedPanelOrigin: (tabId: string, currentTarget: string) => string | undefined;
}

export interface PanelTemplateRelayServer {
  endpointUrl: string;
  close(): Promise<void>;
}

export class PanelTemplateRelayError extends Error {
  readonly code: string;
  readonly unavailable: boolean;

  constructor(message: string, code: string, unavailable = false) {
    super(message);
    this.name = "PanelTemplateRelayError";
    this.code = code;
    this.unavailable = unavailable;
  }
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

function isSecret(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}

function authPayload(request: Pick<PanelTemplateRelayRequest, "requestId" | "createdAt" | "deadlineAt">): string {
  return JSON.stringify([request.requestId, request.createdAt, request.deadlineAt]);
}

export function makePanelTemplateRelayCapability(
  secret: string,
  request: Pick<PanelTemplateRelayRequest, "requestId" | "createdAt" | "deadlineAt">,
): string {
  return createHmac("sha256", secret).update(authPayload(request)).digest("hex");
}

export function verifyPanelTemplateRelayCapability(secret: string, request: PanelTemplateRelayRequest): boolean {
  if (!isSecret(secret) || !HEX_RE.test(request.capability)) return false;
  const expected = makePanelTemplateRelayCapability(secret, request);
  return timingSafeEqual(Buffer.from(request.capability, "hex"), Buffer.from(expected, "hex"));
}

function validateRequest(value: unknown, requestId: string): PanelTemplateRelayRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(record, ["version", "requestId", "capability", "createdAt", "deadlineAt"]) ||
    record.version !== PANEL_TEMPLATE_RELAY_VERSION ||
    record.requestId !== requestId ||
    !ID_RE.test(requestId) ||
    !isSecret(record.capability) ||
    typeof record.createdAt !== "number" ||
    typeof record.deadlineAt !== "number" ||
    !Number.isSafeInteger(record.createdAt) ||
    !Number.isSafeInteger(record.deadlineAt) ||
    record.deadlineAt < record.createdAt ||
    record.deadlineAt - record.createdAt > PANEL_TEMPLATE_RELAY_TIMEOUT_MS
  ) return undefined;
  return record as unknown as PanelTemplateRelayRequest;
}

function requestDeadline(request: PanelTemplateRelayRequest): number {
  return Math.min(request.deadlineAt, request.createdAt + PANEL_TEMPLATE_RELAY_TIMEOUT_MS);
}

function failureResponse(requestId: string, error: string, updated = Date.now()): Failure {
  return { version: PANEL_TEMPLATE_RELAY_VERSION, requestId, ok: false, error, updated };
}

function responseMacPayload(response: ResponseBody): string {
  return response.ok
    ? JSON.stringify([response.version, response.requestId, true, response.body, response.updated])
    : JSON.stringify([response.version, response.requestId, false, response.error, response.updated]);
}

function addResponseMac(secret: string, response: ResponseBody): TransportResponse {
  return {
    ...response,
    responseMac: createHmac("sha256", secret).update(responseMacPayload(response)).digest("hex"),
  } as TransportResponse;
}

function validateResponse(value: unknown, requestId: string, secret: string): ResponseBody {
  if (!value || typeof value !== "object") {
    throw new PanelTemplateRelayError("The panel template relay returned a malformed reply.", "MALFORMED_REPLY");
  }
  const record = value as Record<string, unknown>;
  const responseMac = record.responseMac;
  if (!isSecret(responseMac)) {
    throw new PanelTemplateRelayError("The panel template relay returned an unauthenticated reply.", "MALFORMED_REPLY");
  }
  const body = { ...record } as Record<string, unknown>;
  delete body.responseMac;
  if (!timingSafeEqual(Buffer.from(responseMac, "hex"), Buffer.from(createHmac("sha256", secret).update(responseMacPayload(body as ResponseBody)).digest("hex"), "hex"))) {
    throw new PanelTemplateRelayError("The panel template relay returned an unauthenticated reply.", "MALFORMED_REPLY");
  }
  if (
    record.version !== PANEL_TEMPLATE_RELAY_VERSION ||
    record.requestId !== requestId ||
    typeof record.updated !== "number" ||
    !Number.isSafeInteger(record.updated)
  ) {
    throw new PanelTemplateRelayError("The panel template relay returned a malformed reply.", "MALFORMED_REPLY");
  }
  if (
    record.ok === true &&
    typeof record.body === "string" &&
    record.body.length <= PANEL_TEMPLATE_RELAY_MAX_RESPONSE_BYTES &&
    hasOnlyKeys(record, ["version", "requestId", "ok", "body", "updated", "responseMac"])
  ) {
    return { version: PANEL_TEMPLATE_RELAY_VERSION, requestId, ok: true, body: record.body, updated: record.updated };
  }
  if (
    record.ok === false &&
    typeof record.error === "string" &&
    isSafeText(record.error, 160) &&
    hasOnlyKeys(record, ["version", "requestId", "ok", "error", "updated", "responseMac"])
  ) {
    return record as unknown as Failure;
  }
  throw new PanelTemplateRelayError("The panel template relay returned a malformed reply.", "MALFORMED_REPLY");
}

function errorMessage(error: string): string {
  const known = new Set([
    "AMBIGUOUS_REQUESTER",
    "BACKLOG_FULL",
    "HTTP_ERROR",
    "MALFORMED_REPLY",
    "NO_LIVE_PANEL",
    "NO_PANEL_ORIGIN",
    "PANEL_FETCH_FAILED",
    "STALE_REQUEST",
    "STALE_TARGET",
    "TIMEOUT",
  ]);
  return known.has(error) ? error : "PANEL_FETCH_FAILED";
}

function responseFailureMessage(response: Failure): never {
  const code = errorMessage(response.error);
  throw new PanelTemplateRelayError(
    code === "PANEL_FETCH_FAILED"
      ? "The connected panel could not fetch the workflow-template index."
      : `The connected panel template relay failed (${code}).`,
    code,
  );
}

function endpointFromEnv(): URL | undefined {
  const raw = process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== PANEL_TEMPLATE_RELAY_HTTP_PATH
    ) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      throw new PanelTemplateRelayError("The panel template relay response exceeded its safety limit.", "RESPONSE_TOO_LARGE");
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new PanelTemplateRelayError("The panel template relay response exceeded its safety limit.", "RESPONSE_TOO_LARGE");
    }
    return JSON.parse(text) as unknown;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PanelTemplateRelayError("The panel template relay response exceeded its safety limit.", "RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) throw new Error("response too large");
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("response too large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("response too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function withinDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new PanelTemplateRelayError("The panel template relay timed out.", "TIMEOUT");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new PanelTemplateRelayError("The panel template relay timed out.", "TIMEOUT")), remaining);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function writeHttpJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.byteLength),
    connection: "close",
  });
  res.end(body);
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const declared = req.headers["content-length"];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > PANEL_TEMPLATE_RELAY_MAX_REQUEST_BYTES) {
      return Promise.reject(new PanelTemplateRelayError("The relay request exceeded its safety limit.", "REQUEST_TOO_LARGE"));
    }
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const finish = (error?: Error) => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, total));
    };
    const onData = (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += data.byteLength;
      if (total > PANEL_TEMPLATE_RELAY_MAX_REQUEST_BYTES) {
        req.destroy();
        finish(new PanelTemplateRelayError("The relay request exceeded its safety limit.", "REQUEST_TOO_LARGE"));
        return;
      }
      chunks.push(data);
    };
    const onEnd = () => finish();
    const onError = () => finish(new PanelTemplateRelayError("The relay request was interrupted.", "RELAY_UNAVAILABLE", true));
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
  });
}

function parsedHttpOrigin(raw: string | undefined): { origin: string; protocol: string; host: string; port: string } | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
    return {
      origin: url.origin,
      protocol: url.protocol,
      host: url.hostname.toLowerCase().replace(/^\[|\]$/g, ""),
      port: url.port,
    };
  } catch {
    return undefined;
  }
}

function httpOrigin(raw: string | undefined): string | undefined {
  return parsedHttpOrigin(raw)?.origin;
}

/**
 * A panel origin is usable only when it is a loopback listener and corroborates
 * the current target. The server-observed Origin is metadata, not authentication:
 * a native client can forge it on the tokenless loopback bridge. Keeping the
 * fetch destination loopback-only prevents that metadata, or the client-steerable
 * active target, from authorizing a remote fetch. URL.origin also canonicalizes
 * default ports and host casing.
 */
export function currentPanelTemplateOrigin(
  panelOrigin: string | undefined,
  currentTarget: string | undefined,
): string | undefined {
  const observed = parsedHttpOrigin(panelOrigin);
  const target = parsedHttpOrigin(currentTarget);
  if (!observed || !target) return undefined;
  const exactLoopbackOrigin =
    LOOPBACK_HOSTS.has(observed.host) &&
    LOOPBACK_HOSTS.has(target.host) &&
    observed.protocol === target.protocol &&
    observed.port === target.port &&
    observed.origin === target.origin;
  return exactLoopbackOrigin ? observed.origin : undefined;
}

function safePanelTemplateUrl(raw: string | undefined, allowedOrigin: string | undefined): URL | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const normalizedAllowedOrigin = allowedOrigin === undefined ? undefined : httpOrigin(allowedOrigin);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith("/api/workflow_templates") ||
      !normalizedAllowedOrigin ||
      url.origin !== normalizedAllowedOrigin
    ) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

async function fetchPanelIndex(url: URL, deadlineAt: number): Promise<string> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new PanelTemplateRelayError("The panel template relay timed out.", "TIMEOUT");
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(remaining),
    });
  } catch {
    throw new PanelTemplateRelayError("The connected panel could not fetch the workflow-template index.", "PANEL_FETCH_FAILED");
  }
  if (response.url) {
    const finalUrl = safePanelTemplateUrl(response.url, url.origin);
    if (!finalUrl || finalUrl.origin !== url.origin || finalUrl.pathname !== url.pathname) {
      throw new PanelTemplateRelayError("The panel template relay refused a response from another origin.", "PANEL_FETCH_FAILED");
    }
  }
  if (response.status >= 300 && response.status < 400) {
    throw new PanelTemplateRelayError("The panel template relay refused a redirect.", "PANEL_FETCH_FAILED");
  }
  if (!response.ok) throw new PanelTemplateRelayError("The connected panel returned an HTTP error.", "HTTP_ERROR");
  const body = await readResponseText(response, PANEL_TEMPLATE_RELAY_MAX_RESPONSE_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PanelTemplateRelayError("The connected panel returned a non-JSON template index.", "PANEL_FETCH_FAILED");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PanelTemplateRelayError("The connected panel returned a malformed template index.", "PANEL_FETCH_FAILED");
  }
  return body;
}

export async function startPanelTemplateRelayServer(
  options: PanelTemplateRelayServerOptions,
): Promise<PanelTemplateRelayServer> {
  let active = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== PANEL_TEMPLATE_RELAY_HTTP_PATH) {
        writeHttpJson(res, 404, { ok: false, error: "NOT_FOUND" });
        return;
      }
      if (active >= PANEL_TEMPLATE_RELAY_MAX_CONCURRENT) {
        writeHttpJson(res, 429, { ok: false, error: "BACKLOG_FULL" });
        return;
      }
      active += 1;
      try {
        let body: Buffer;
        try {
          body = await readRequestBody(req);
        } catch (error) {
          writeHttpJson(res, error instanceof PanelTemplateRelayError && error.code === "REQUEST_TOO_LARGE" ? 413 : 408, {
            ok: false,
            error: error instanceof PanelTemplateRelayError ? error.code : "MALFORMED_REQUEST",
          });
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(body.toString("utf8")) as unknown;
        } catch {
          writeHttpJson(res, 400, { ok: false, error: "MALFORMED_REQUEST" });
          return;
        }
        const requestId = raw && typeof raw === "object" ? (raw as Record<string, unknown>).requestId : undefined;
        const request = typeof requestId === "string" ? validateRequest(raw, requestId) : undefined;
        if (!request) {
          writeHttpJson(res, 400, { ok: false, error: "MALFORMED_REQUEST" });
          return;
        }
        const auth = options.resolvePanelAgent(request);
        if (!auth || !isSecret(auth.secret) || !verifyPanelTemplateRelayCapability(auth.secret, request)) {
          writeHttpJson(res, 401, { ok: false, error: "UNAUTHORIZED" });
          return;
        }
        let response: ResponseBody;
        const now = Date.now();
        if (now - request.createdAt < -5_000 || now - request.createdAt > PANEL_TEMPLATE_RELAY_STALE_MS || now >= requestDeadline(request)) {
          response = failureResponse(request.requestId, now >= requestDeadline(request) ? "TIMEOUT" : "STALE_REQUEST");
        } else {
          const targetAtStart = options.resolveCurrentTarget();
          const panelTab = options.resolvePanelTab(auth.agentKey);
          const panelReachable = panelTab ? options.bridge.canReach(panelTab) : false;
          const allowedOrigin = panelTab && panelReachable
            ? options.resolveAllowedPanelOrigin(panelTab, targetAtStart.url)
            : undefined;
          const panelUrl = panelTab && panelReachable
            ? safePanelTemplateUrl(options.resolvePanelUrl(panelTab, targetAtStart.url), allowedOrigin)
            : undefined;
          if (!panelTab || !panelReachable) {
            response = failureResponse(
              request.requestId,
              options.bridge.resolveFailure?.(auth.agentKey) === "ambiguous" ? "AMBIGUOUS_REQUESTER" : "NO_LIVE_PANEL",
            );
          } else if (!panelUrl) {
            response = failureResponse(request.requestId, "NO_PANEL_ORIGIN");
          } else {
            try {
              const body = await withinDeadline(fetchPanelIndex(panelUrl, requestDeadline(request)), requestDeadline(request));
              const targetNow = options.resolveCurrentTarget();
              if (targetNow.url !== targetAtStart.url || targetNow.generation !== targetAtStart.generation) {
                throw new PanelTemplateRelayError(
                  "The ComfyUI target changed while the panel template index was being fetched.",
                  "STALE_TARGET",
                );
              }
              response = {
                version: PANEL_TEMPLATE_RELAY_VERSION,
                requestId: request.requestId,
                ok: true,
                body,
                updated: Date.now(),
              };
            } catch (error) {
              response = failureResponse(
                request.requestId,
                error instanceof PanelTemplateRelayError ? error.code : "PANEL_FETCH_FAILED",
                error instanceof PanelTemplateRelayError && error.code === "TIMEOUT" ? requestDeadline(request) : Date.now(),
              );
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
  server.requestTimeout = PANEL_TEMPLATE_RELAY_TIMEOUT_MS + 1_000;
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
    throw new Error("panel template relay did not bind to IPv4 loopback");
  }
  return {
    endpointUrl: `http://127.0.0.1:${address.port}${PANEL_TEMPLATE_RELAY_HTTP_PATH}`,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
    }),
  };
}

/** Child-side request. Undefined means this MCP child has no panel relay. */
export async function requestPanelTemplateIndex(): Promise<Record<string, unknown> | undefined> {
  const endpoint = endpointFromEnv();
  const secret = process.env.COMFYUI_MCP_RELAY_SECRET;
  if (!endpoint || !isSecret(secret)) return undefined;
  const createdAt = Date.now();
  const request: PanelTemplateRelayRequest = {
    version: PANEL_TEMPLATE_RELAY_VERSION,
    requestId: `${Date.now().toString(36)}-${process.pid.toString(36)}-${randomBytes(8).toString("hex")}`,
    capability: "",
    createdAt,
    deadlineAt: createdAt + PANEL_TEMPLATE_RELAY_TIMEOUT_MS,
  };
  request.capability = makePanelTemplateRelayCapability(secret, request);
  const body = Buffer.from(JSON.stringify(request), "utf8");
  let httpResponse: Response;
  try {
    httpResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.byteLength) },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(PANEL_TEMPLATE_RELAY_TIMEOUT_MS),
    });
  } catch {
    throw new PanelTemplateRelayError("The connected panel template relay is unavailable.", "RELAY_UNAVAILABLE", true);
  }
  let decoded: unknown;
  try {
    decoded = await readBoundedJson(httpResponse, PANEL_TEMPLATE_RELAY_MAX_RESPONSE_BYTES + 8_192);
  } catch {
    throw new PanelTemplateRelayError("The panel template relay returned a malformed reply.", "MALFORMED_REPLY");
  }
  if (!httpResponse.ok) {
    const code = decoded && typeof decoded === "object" && typeof (decoded as Record<string, unknown>).error === "string"
      ? String((decoded as Record<string, unknown>).error)
      : "RELAY_UNAVAILABLE";
    throw new PanelTemplateRelayError("The connected panel template relay is unavailable.", code, httpResponse.status >= 500);
  }
  const response = validateResponse(decoded, request.requestId, secret);
  if (response.ok === false) responseFailureMessage(response);
  const age = Date.now() - response.updated;
  if (
    response.updated < request.createdAt ||
    response.updated > request.deadlineAt ||
    age < -5_000 ||
    age > PANEL_TEMPLATE_RELAY_STALE_MS
  ) throw new PanelTemplateRelayError("The panel template relay returned a stale reply.", "STALE_REPLY");
  let index: unknown;
  try {
    index = JSON.parse(response.body);
  } catch {
    throw new PanelTemplateRelayError("The panel template relay returned invalid JSON.", "MALFORMED_REPLY");
  }
  if (!index || typeof index !== "object" || Array.isArray(index)) {
    throw new PanelTemplateRelayError("The panel template relay returned a malformed index.", "MALFORMED_REPLY");
  }
  return index as Record<string, unknown>;
}

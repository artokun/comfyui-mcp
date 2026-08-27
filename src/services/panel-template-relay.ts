import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookupCb } from "node:dns";
import { promisify } from "node:util";
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
// Hosts that may AUTHORIZE a relay origin. `localhost` is included, but it is
// never fetched as a name — see LOOPBACK_LITERALS and pinnedLoopbackUrls.
//
// #2382 is the reason this needs saying. `localhost` names an address family,
// not a listener, so an exact origin match does not prove that a later
// `fetch(url)` reaches the socket the browser is on: Node >=20 connects with
// Happy Eyeballs, so the name can land on either loopback family. #2385
// answered that by dropping `localhost` from this set, which took `list_packs
// action:"list_templates"` from working to erroring for every user whose
// ComfyUI is served at `http://localhost:<port>` — an ordinary setup, since the
// panel Origin is the browser's — and the caller is fail-closed once a panel
// route exists, so nothing caught it.
//
// The refusal was not the only option, and it was not the right one. The
// ambiguity lives in the SECOND name resolution, not in the origin check, so it
// is removed rather than refused: the destination is resolved once, here, and
// every request goes to a literal address. Where a name resolves to more than
// one loopback address the candidates must AGREE, which is the property that
// actually matters and is checkable, unlike listener identity, which is not.
//
// Not falling through to the headless COMFYUI_URL path on a refusal is
// deliberate and stays that way (#2387): a mid-turn child keeps the PREVIOUS
// target across a retarget (#1429, retargetAllForMcpEnv), so it can list a
// stale server's index. Fetching here, under the relay's own generation fence,
// is what prevents that.
//
// A mixed pair (`localhost` observed vs `127.0.0.1` configured, or the reverse)
// is still refused by the exact-origin equality below.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// Relay fetches only ever go to a LITERAL loopback address. `localhost` may
// authorize an origin (above), but it is never a fetch destination: see
// pinnedLoopbackUrls, which resolves it to these before any request is made.
const LOOPBACK_LITERALS = new Set(["127.0.0.1", "::1"]);

// Promisified so the single resolution happens in ONE place we control.
const dnsLookup = promisify(dnsLookupCb) as (
  hostname: string,
  options: { all: true; verbatim: boolean },
) => Promise<Array<{ address: string; family: number }>>;
const AMBIGUOUS_LOOPBACK_NAMES = new Set(["localhost"]);

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
    "AMBIGUOUS_PANEL_LISTENER",
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
  // An ambiguous NAME is authorized over cleartext only. Over TLS the address
  // cannot be pinned without breaking verification of a certificate issued to
  // the name, which leaves the fetch re-resolving it -- so `https://localhost`
  // stays refused, exactly as it is on main today. Nothing regresses by
  // declining to restore it, and the http case is the reported one (#2382).
  const ambiguousName = AMBIGUOUS_LOOPBACK_NAMES.has(observed.host) || AMBIGUOUS_LOOPBACK_NAMES.has(target.host);
  if (ambiguousName && observed.protocol !== "http:") return undefined;
  return exactLoopbackOrigin ? observed.origin : undefined;
}

function safePanelTemplateUrl(raw: string | undefined, allowedOrigin: string | undefined): URL | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const parsedUrlOrigin = parsedHttpOrigin(url.origin);
    const parsedAllowedOrigin = parsedHttpOrigin(allowedOrigin);
    const normalizedAllowedOrigin = parsedAllowedOrigin?.origin;
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith("/api/workflow_templates") ||
      !normalizedAllowedOrigin ||
      !parsedUrlOrigin ||
      !LOOPBACK_HOSTS.has(parsedUrlOrigin.host) ||
      !LOOPBACK_HOSTS.has(parsedAllowedOrigin.host) ||
      url.origin !== normalizedAllowedOrigin
    ) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/**
 * Expands a relay URL into the literal-address URLs that will actually be
 * fetched, so `fetch` never performs a second, independent name resolution
 * (#2382).
 *
 * A literal host is returned unchanged. An ambiguous NAME is resolved once,
 * here, and every resolved address must be loopback — which also closes a hole
 * that existed before this function: a hosts-file entry pointing `localhost`
 * off-box would previously have been fetched, because only the ORIGIN STRING
 * was ever checked against the loopback set, never the address it resolves to.
 */
async function pinnedLoopbackUrls(url: URL): Promise<URL[]> {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK_LITERALS.has(host)) return [url];
  // Only a cleartext ambiguous name gets here: currentPanelTemplateOrigin
  // refuses the TLS case, because pinning and certificate verification cannot
  // both hold. Re-checked rather than assumed -- this function is what decides
  // where a request is actually sent.
  if (!AMBIGUOUS_LOOPBACK_NAMES.has(host) || url.protocol !== "http:") {
    throw new PanelTemplateRelayError("The panel template relay refused a non-loopback destination.", "NO_PANEL_ORIGIN");
  }
  let resolved: Array<{ address: string }>;
  try {
    resolved = await dnsLookup(host, { all: true, verbatim: true });
  } catch {
    throw new PanelTemplateRelayError("The connected panel could not fetch the workflow-template index.", "PANEL_FETCH_FAILED");
  }
  const literals: string[] = [];
  for (const { address } of resolved) {
    const literal = address.toLowerCase();
    // A name that resolves ANYWHERE off loopback is refused whole rather than
    // partially honoured. Before pinning, only the ORIGIN STRING was ever
    // checked, so a `localhost` pointed off-box by a hosts entry was fetched.
    if (!LOOPBACK_LITERALS.has(literal)) {
      throw new PanelTemplateRelayError("The panel template relay refused a non-loopback destination.", "NO_PANEL_ORIGIN");
    }
    if (!literals.includes(literal)) literals.push(literal);
  }
  if (literals.length === 0) {
    throw new PanelTemplateRelayError("The connected panel could not fetch the workflow-template index.", "PANEL_FETCH_FAILED");
  }
  return literals.map((literal) => {
    const pinned = new URL(url.href);
    pinned.hostname = literal.includes(":") ? `[${literal}]` : literal;
    return pinned;
  });
}

/**
 * Fetches the template index over pinned literal addresses.
 *
 * When a name resolves to more than one loopback address we cannot know which
 * socket the browser reached — the Origin header does not carry the family, and
 * probing cannot tell a dual-stack listener bound to `::` apart from two
 * separate processes. So identity is not what we establish. We fetch every
 * candidate and require them to AGREE: if each reachable address returns the
 * same index, the answer is the same whichever one the panel is on, which is
 * the property that actually matters. Disagreement is the real ambiguity, and
 * is refused rather than resolved by guessing.
 */
async function fetchPinnedPanelIndex(url: URL, deadlineAt: number): Promise<string> {
  const candidates = await pinnedLoopbackUrls(url);
  if (candidates.length === 1) return fetchPanelIndex(candidates[0], deadlineAt);
  const settled = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        return { state: "ok" as const, body: await fetchPanelIndex(candidate, deadlineAt) };
      } catch (error) {
        // A REFUSED CONNECTION IS THE ONLY SAFE THING TO IGNORE. It proves
        // nothing is listening on that address, so it cannot be the panel. Any
        // other failure means something IS there and merely answered badly --
        // possibly the real panel returning 503 -- and preferring whichever
        // address happened to succeed would then serve the OTHER listener's
        // index, which is the defect this function exists to prevent.
        return isConnectionRefused(error)
          ? { state: "absent" as const }
          : { state: "failed" as const, error };
      }
    }),
  );
  const present = settled.filter((r) => r.state !== "absent");
  if (present.length === 0) {
    throw new PanelTemplateRelayError("The connected panel could not fetch the workflow-template index.", "PANEL_FETCH_FAILED");
  }
  // Exactly one listener exists, so there is nothing for it to disagree with:
  // report its outcome verbatim, success or failure.
  if (present.length === 1) {
    const only = present[0];
    if (only.state === "ok") return only.body;
    throw only.error;
  }
  // More than one listener answered the panel's address. Every one of them must
  // have produced the SAME index, or we cannot say what the panel would see.
  const bodies: string[] = [];
  for (const result of present) {
    if (result.state !== "ok") {
      throw new PanelTemplateRelayError(
        "Another loopback listener answered the panel's address and could not be read.",
        "AMBIGUOUS_PANEL_LISTENER",
      );
    }
    bodies.push(result.body);
  }
  if (bodies.some((body) => body !== bodies[0])) {
    throw new PanelTemplateRelayError(
      "Two different loopback listeners answered the panel's address with different template indexes.",
      "AMBIGUOUS_PANEL_LISTENER",
    );
  }
  return bodies[0];
}

/** True only for a refused CONNECTION, i.e. nothing is listening on that address. */
function isConnectionRefused(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    // ECONNREFUSED is the loopback case. The rest cover a resolvable address
    // with no route -- equally "nothing is listening here".
    if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EADDRNOTAVAIL") return true;
    const aggregate = (current as { errors?: unknown }).errors;
    if (Array.isArray(aggregate) && aggregate.some((inner) => isConnectionRefused(inner))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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
  } catch (error) {
    const failure = new PanelTemplateRelayError("The connected panel could not fetch the workflow-template index.", "PANEL_FETCH_FAILED");
    // Preserve the connect-level cause so a multi-address fetch can tell "no
    // listener" from "a listener that failed" -- see fetchPinnedPanelIndex.
    (failure as { cause?: unknown }).cause = error;
    throw failure;
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
            // Any configured relay refusal is authoritative. Returning a
            // sentinel here would let the child fall through to a stale
            // getComfyUIBaseUrl() target after a mid-turn retarget.
            response = failureResponse(request.requestId, "NO_PANEL_ORIGIN");
          } else {
            try {
              const body = await withinDeadline(fetchPinnedPanelIndex(panelUrl, requestDeadline(request)), requestDeadline(request));
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
  // `undefined` is reserved for a child with no authenticated relay environment.
  // Once a relay is configured, an unauthorizable panel origin is a refusal, not
  // permission to fall through to getComfyUIBaseUrl(): during a target retarget
  // that URL can still name stale target A while the relay has already observed
  // target B. Keep this failure typed so the list_packs caller returns an honest
  // unknown/error result without issuing a second fetch.
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

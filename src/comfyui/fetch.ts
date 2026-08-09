import { getComfyUIAuthHeaders } from "../config.js";
import { describeFetchFailure, isBareFetchFailure } from "../utils/errors.js";

/** The request target, for the diagnostic. Never throws on an odd input. */
export function targetOf(input: string | URL | Request): string {
  try {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return (input as Request).url ?? String(input);
  } catch {
    return String(input);
  }
}

/** The request's HTTP method, uppercased. `init.method` wins over a Request's own,
 *  matching what fetch itself does when both are supplied. */
function methodOf(input: string | URL | Request, init: RequestInit): string {
  return String(init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

/**
 * What the CONNECTED panels front, for the drift comparison below (#952).
 *
 * Injected by the orchestrator at startup rather than imported: this module is
 * the bottom of the stack and must not depend on the bridge. Unset (the plain
 * MCP server, tests, any process with no bridge) simply means the comparison is
 * skipped — never that there is no drift.
 *
 * Origins here must be the SERVER-OBSERVED handshake Origin (UiBridge's
 * `tabServerOrigin`), not the client-supplied `hello.comfyui_url`: the browser
 * sets the former and blocks page JS from forging it, so it is the trustworthy
 * answer to "which ComfyUI is this tab actually on".
 */
let connectedPanelOrigins: (() => string[]) | null = null;

/** Install the panel-origin source. Pass null to clear (tests, shutdown). */
export function setConnectedPanelOrigins(fn: (() => string[]) | null): void {
  connectedPanelOrigins = fn;
}

/** Origin (scheme://host:port) of a request target, or undefined if unparsable. */
function originOf(target: string): string | undefined {
  try {
    return new URL(target).origin;
  } catch {
    return undefined;
  }
}

/**
 * Name the drift instead of asking the reader to go and check for it (#952).
 *
 * The shipped message told the user a connected panel "does not imply this
 * address is reachable" and pointed them at install_comfyui(action:"environment")
 * to compare the two by hand. We can usually just do the comparison — the bridge
 * knows what each connected tab fronts — and saying which of the three cases
 * holds is worth far more than the instruction to go and find out:
 *
 *   - DIFFERENT   → that is very likely the whole answer.
 *   - THE SAME    → drift is RULED OUT. Worth stating plainly, because it stops
 *                   the reader chasing the explanation the old text volunteered.
 *                   The panel reaches it from the browser; this process does not
 *                   (a firewall, a container boundary, a bound interface).
 *   - UNKNOWN     → no panel connected, no origin source installed, or the
 *                   handshake carried no usable Origin. Say nothing about drift;
 *                   an absent comparison is not a negative result.
 */
export function describeTargetDrift(target: string): string {
  const origins = (() => {
    try {
      return connectedPanelOrigins?.() ?? [];
    } catch {
      return []; // a broken source must never replace the real network error
    }
  })();
  if (origins.length === 0) return "";
  const want = originOf(target);
  if (!want) return "";
  const distinct = [...new Set(origins)];
  if (distinct.includes(want)) {
    return (
      ` A connected panel is on this same origin, so this is NOT a wrong-address problem: ` +
      `the browser can reach ${want} and this process cannot (a firewall, a container ` +
      `boundary, or a server bound to one interface).`
    );
  }
  return (
    ` A connected panel is on ${distinct.join(", ")} — a DIFFERENT address, which is why ` +
    `the panel works while this call does not. Point COMFYUI_URL at that origin if it is the ` +
    `server you meant.`
  );
}

/**
 * Turn a network-layer throw into a diagnostic that says WHAT was attempted.
 *
 * `TypeError: fetch failed` was reaching tool results verbatim: #954 saw it from
 * the workflow-templates listing (now `list_packs` action:"list_templates") and
 * could not tell which host was tried, and #952 saw it from the readonly tools
 * while the panel bridge was working fine — reading it, reasonably, as "the tool
 * is broken" when the headless target was simply a different (unreachable)
 * address than the one the panel is bound to.
 *
 * The two ARE separate targets by design: the panel talks to whichever ComfyUI
 * the browser is on, while these calls go to the configured COMFYUI_URL. That is
 * not a bug, but it is invisible unless the failure names the address — and,
 * where the bridge can tell us, says whether the two actually differ.
 *
 * Header for the three pieces below: the never-delivered code set, the delivery
 * doubt it gates, and describeComfyFetchFailure itself.
 */
/**
 * Failure codes that prove the request was NEVER DELIVERED.
 *
 * Each one fires before any byte of the request could reach the application: the
 * connection was refused, the name never resolved, the TLS handshake failed, or
 * the URL was rejected locally. On these the server cannot have acted, so saying
 * so is accurate and a retry is safe.
 *
 * Everything else is deliberately NOT listed. ECONNRESET, EPIPE, "socket hang up"
 * and UND_ERR_SOCKET all fire on an ESTABLISHED connection, which is precisely the
 * case where ComfyUI may have received and acted on the request before the socket
 * died. The default for an unrecognised code is therefore "may have been
 * delivered": a spurious "verify first" costs one extra read, while a spurious
 * "it never arrived" costs a duplicate render.
 */
const NEVER_DELIVERED_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ERR_INVALID_URL",
  "ERR_UNSUPPORTED_PROTOCOL",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * The transport-failure twin of describeComfyTimeout's OUTCOME UNKNOWN.
 *
 * A timeout on a POST already warned that /prompt may have queued the render
 * before the reply was lost. A CONNECTION ERROR on that same POST carries the
 * identical risk — an ECONNRESET after the server accepted and enqueued the
 * prompt is indistinguishable, at this layer, from one before it — yet the
 * message said only "confirm the server is up", which reads as "it never got
 * there". The caller retries and the render is queued twice, on the single most
 * expensive operation this client makes.
 *
 * Only suppressed when the code POSITIVELY proves non-delivery, or the method is
 * a read. See NEVER_DELIVERED_CODES for why the default runs the other way.
 */
export function deliveryDoubt(code: string | undefined, method: string): string {
  if (method === "GET" || method === "HEAD") return "";
  if (code !== undefined && NEVER_DELIVERED_CODES.has(code)) return "";
  // Says only what is known. Claiming "the connection was established" would be an
  // overclaim for an unrecognised code — the same folding this function exists to
  // undo, merely pointed the other way.
  return (
    ` This ${method} may already have been received and acted on: a transport failure ` +
    `does not establish that the request never arrived. Do NOT blindly re-issue it; ` +
    `check the server's state first (for a queued prompt, queue (action:"list") and ` +
    `get_history (action:"list")).`
  );
}

function describeComfyFetchFailure(err: unknown, target: string, method: string): Error {
  const { message, code } = describeFetchFailure(err);
  const wrapped = new Error(
    `${message} — while requesting ${target} (${method}).` +
      deliveryDoubt(code, method) +
      ` ` +
      `That is the headless ComfyUI target (COMFYUI_URL); a CONNECTED sidebar panel does not imply this address is reachable, ` +
      `because the panel talks to whichever ComfyUI its browser tab is on.` +
      describeTargetDrift(target) +
      ` Check the target with install_comfyui (action:"environment"), and confirm the server is up with get_system_stats (action:"health").`,
    { cause: err },
  );
  if (code) (wrapped as { code?: string }).code = code;
  return wrapped;
}

/**
 * A last-resort ceiling on a ComfyUI HTTP call that brought no budget of its own.
 *
 * `comfyuiFetch` passed `init` straight to `fetch`, so a call with no signal had
 * NO time limit at all: a host that accepts the connection and then never
 * answers — a stalled reverse proxy, a black-holed route, a ComfyUI wedged
 * mid-request — left it pending forever. Thirteen of the twenty-five call sites
 * were in that state, including `/prompt`, `/queue`, `/object_info` and the
 * Manager API. This is the same defect #1026 hit in the skill generator; that
 * fix bounded three calls, and this bounds the rest.
 *
 * DELIBERATELY GENEROUS. Every caller that knows its own budget already passes a
 * signal (8s for the template listing, and so on) and keeps it — `init.signal`
 * always wins. This value only has to be shorter than "forever" and longer than
 * any healthy request: `/object_info` on a large custom-node install is
 * legitimately slow, and a ceiling that fires on a working server would be a
 * worse bug than the one being fixed.
 *
 * SAFE TO APPLY BROADLY because of what does NOT come through here: uploads and
 * `/view` go through the client library's own `fetchApi`, and model downloads
 * have their own streaming path. Every comfyuiFetch site is a small JSON API
 * request.
 */
const DEFAULT_COMFY_HTTP_TIMEOUT_S = 120;

export function comfyHttpTimeoutSeconds(): number {
  const raw = Number(process.env.COMFYUI_MCP_HTTP_TIMEOUT_S);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COMFY_HTTP_TIMEOUT_S;
}

export function defaultComfyTimeoutSignal(): AbortSignal {
  return AbortSignal.timeout(Math.round(comfyHttpTimeoutSeconds() * 1000));
}

/** True for an abort raised by AbortSignal.timeout (not a caller's own abort). */
export function isTimeoutAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/**
 * Say what the ceiling did and did NOT establish.
 *
 * The critical distinction is the METHOD. A GET that times out learned nothing
 * about the server's state. A POST that times out is OUTCOME UNKNOWN — `/prompt`
 * may well have queued the render before the reply was lost — and reporting that
 * as a failure would invite a retry that queues it twice. Neither may be
 * described as "the server is down".
 */
function describeComfyTimeout(input: string | URL | Request, init: RequestInit): Error {
  const target = targetOf(input);
  const method = methodOf(input, init);
  const seconds = comfyHttpTimeoutSeconds();
  const mutating = method !== "GET" && method !== "HEAD";
  const err = new Error(
    `No reply from ComfyUI within ${seconds}s — while requesting ${target} (${method}). ` +
      (mutating
        ? `OUTCOME UNKNOWN: this request may already have been received and acted on, so do NOT ` +
          `blindly re-issue it — check the server's state first (for a queued prompt, queue ` +
          `(action:"list") and get_history (action:"list")). `
        : `Nothing was learned about the server from this — a timeout is not a refusal and not a ` +
          `"not found". `) +
      `The connection was accepted but no answer arrived in time, which points at the server or ` +
      `something between it and here rather than at the request. Confirm it is up with ` +
      `get_system_stats (action:"health"), and raise COMFYUI_MCP_HTTP_TIMEOUT_S if this server is ` +
      `simply slow.`,
  );
  (err as { code?: string }).code = "COMFYUI_HTTP_TIMEOUT";
  return err;
}

/**
 * `fetch` wrapper for ComfyUI HTTP requests that injects the configured generic
 * auth header(s) (COMFYUI_AUTH_* — for self-hosted ComfyUI behind a reverse
 * proxy / API gateway). A no-op when no auth is configured. Explicit headers on
 * the call always win, so it never clobbers a per-request `Content-Type`.
 *
 * Use this instead of the global `fetch` for every call to the user's ComfyUI
 * server. Non-ComfyUI requests (HuggingFace, Civitai, Comfy Cloud) keep using
 * plain `fetch` — Comfy Cloud has its own X-API-Key path in cloud-client.ts.
 */
export async function comfyuiFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const auth = getComfyUIAuthHeaders();
  // A CEILING, not a policy. Callers that know their own budget pass a signal
  // and it always wins — this only covers the ones that passed none, which
  // otherwise wait forever.
  const signal = init.signal ?? defaultComfyTimeoutSignal();
  let request: Promise<Response>;
  if (Object.keys(auth).length === 0) {
    request = fetch(input, { ...init, signal });
  } else {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(auth)) {
      if (!headers.has(name)) headers.set(name, value);
    }
    request = fetch(input, { ...init, headers, signal });
  }
  try {
    return await request;
  } catch (err) {
    // Our own ceiling firing is not the same event as a caller's abort, and it
    // must not be reported as one. Only rewrite when WE supplied the signal.
    if (init.signal === undefined && isTimeoutAbort(err)) {
      throw describeComfyTimeout(input, init);
    }
    // ONLY the opaque undici failure is rewritten. An AbortError, a timeout with
    // its own message, or anything else already says what happened, and
    // replacing that text would be a downgrade.
    if (!isBareFetchFailure(err)) throw err;
    throw describeComfyFetchFailure(err, targetOf(input), methodOf(input, init));
  }
}

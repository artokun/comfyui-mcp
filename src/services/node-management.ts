import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { config, getComfyUIBaseUrl, isRemoteMode } from "../config.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { resetObjectInfoCache } from "../comfyui/client.js";
import { progressEnabled, reportDownloadProgress } from "./download-progress.js";
import { parsePyproject } from "./node-authoring.js";
import {
  type ManagerApi,
  cacheManagerApi,
  dialectRecheckSuppressed,
  getCachedManagerApi,
  managerApiCacheStamp,
  managerApiEpoch,
  resetManagerApiCache,
  setManagerApiCacheForTests,
  suppressDialectRecheck,
} from "./manager-api-cache.js";
export type { ManagerApi } from "./manager-api-cache.js";
import { resolveEffectiveComfyUIBase, resolveInstallInterpreter } from "./workspace-env.js";
import {
  assertComfyCliOk,
  getComfyCliVersion,
  isSupportedComfyCliVersion,
  resolveComfyCliExecutable,
  runComfyCliSync,
} from "./comfy-cli.js";
import { withPanelPinGuard } from "./panel-pin-guard.js";
import { ComfyUIError, ProcessControlError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { managerBodyClause } from "./manager-error-body.js";

// ---------------------------------------------------------------------------
// Custom-node management — ports `comfy-cli node install|update|reinstall|fix|
// show|uv-sync` to MCP tools.
//
// Strategy (hybrid, confirmed with maintainer):
//   1. Prefer the ComfyUI-Manager HTTP API (works against remote instances).
//      TWO API GENERATIONS exist in the wild (issue #116), auto-detected per
//      target by detectManagerApi():
//        • v4 lineage (pip `comfyui_manager` ≥4.x, the `manager-v4` branch —
//          what the RunPod image bakes): unified queue — POST one task
//          envelope to /v2/manager/queue/task, then /v2/manager/queue/start,
//          then poll /v2/manager/queue/status until the queue drains.
//        • RELEASED Manager 3.x (`main`, the registry default): same queue
//          engine under /manager/queue/* with PER-OPERATION routes
//          (install/uninstall/update/fix/disable/install_model/update-all)
//          and different body shapes — see legacyTaskRequest().
//   2. Fall back to the cm-cli.py subprocess (against config.comfyuiPath) for
//      anything the HTTP API can't do, or when the user forces it (local
//      installs only — cm-cli needs the filesystem).
//
// API contract verified against the current Comfy-Org/ComfyUI-Manager (the
// `glob` server, codegen'd from openapi.yaml). Every operation now flows through
// ONE endpoint:
//   POST /v2/manager/queue/task   body: { ui_id, client_id, kind, params }
// where `kind` is an OperationType (install | uninstall | update | fix |
// enable | disable | update-comfyui | install-model) and `params` is the
// matching Pydantic model:
//   install  → InstallPackParams { id, version, selected_version, repository?,
//                                  pip?, mode, channel, skip_post_install? }
//              (do_install only reads `id` + `selected_version` → resolve_node_spec)
//   update   → UpdatePackParams  { node_name, node_ver? }
//   fix      → FixPackParams     { node_name, node_ver }
//   uninstall→ UninstallPackParams { node_name, is_unknown? }
//   disable  → DisablePackParams { node_name, is_unknown? }
//   enable   → EnablePackParams  { cnr_id }
// Dedicated (non-task) routes still exist for: /v2/manager/queue/update_all,
// /v2/manager/queue/start, /v2/manager/queue/status, /v2/customnode/installed.
// There is NO `reinstall` kind — reinstall is modeled as uninstall + install.
//
// NOTE: modern ComfyUI-Manager ships as the pip package `comfyui_manager`
// (site-packages), NOT a custom_nodes/ checkout, so it does not provide
// cm-cli.py. The cm-cli fallback therefore only works on legacy layouts; the
// HTTP API above covers every operation and is the primary path.
// ---------------------------------------------------------------------------

/** client_id reported to ComfyUI-Manager's task queue for our requests. */
const MANAGER_CLIENT_ID = "comfyui-mcp";

export class NodeManagementError extends ComfyUIError {
  constructor(message: string, details?: unknown) {
    super(message, "NODE_MANAGEMENT_ERROR", details);
    this.name = "NodeManagementError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstallSource = "registry" | "git" | "auto";
export type ManagerMode = "remote" | "local" | "cache";

export interface InstalledNode {
  /** Custom-node module/folder name (the key Manager uses internally). */
  module: string;
  /** ComfyUI Node Registry id, if the pack is CNR-registered. */
  cnrId?: string;
  /** GitHub/aux id for git-based packs. */
  auxId?: string;
  /** Installed version (semver, commit hash, "nightly", or "unknown"). */
  version?: string;
  /**
   * Whether the pack is currently enabled. UNDEFINED when Manager reported no
   * enabled/is_disabled flag at all — an unreported state is unknown, NOT
   * enabled: collapsing it to a definite value lets a verification claim a
   * state nobody observed (codex gate on #775).
   */
  enabled?: boolean;
}

export interface NodeOpResult {
  /** Which mechanism handled the request. */
  mechanism: "manager-http" | "comfy-cli" | "git-clone";
  /** Human-readable summary. */
  message: string;
  /** Raw queue status (HTTP path) or subprocess output (cm-cli path). */
  details?: unknown;
  /**
   * The ComfyUI-Manager base the op targeted (manager-http path), captured at
   * invocation — post-op verification (e.g. the #724 dialect probe) must aim
   * at the SAME server even if the global target was retargeted in between.
   */
  managerBase?: string;
}

export interface ParsedGitUrl {
  baseUrl: string;
  ref: string | null;
}

interface QueueStatus {
  total_count: number;
  done_count: number;
  in_progress_count: number;
  /** Present on the v2 status endpoint; not required by the drain logic. */
  pending_count?: number;
  is_processing: boolean;
}

/** OperationType values accepted by /v2/manager/queue/task. */
export type ManagerTaskKind =
  | "install"
  | "uninstall"
  | "update"
  | "fix"
  | "enable"
  | "disable"
  | "install-model";

// ---------------------------------------------------------------------------
// Manager HTTP helper (local to this unit — do NOT extract to a shared client)
// ---------------------------------------------------------------------------

function managerBaseUrl(): string {
  return getComfyUIBaseUrl();
}

interface ManagerFetchOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /**
   * Call-scoped ComfyUI target. Manager mutations capture this before their first
   * await so a concurrent panel retarget cannot send a retry/drain to a different
   * ComfyUI instance.
   */
  base?: string;
  /** Treat a non-2xx response as a soft failure (return undefined) instead of throwing. */
  soft?: boolean;
}

/**
 * #1089 — a Manager 403 already SAYS why; we were dropping it.
 *
 * ComfyUI-Manager gates privileged routes behind its own security level and
 * answers with a machine-readable body (glob/manager_server.py):
 *
 *     def security_403_response(flag_token=None):
 *         if not manager_migration.has_system_user_api():
 *             return web.json_response({"error": "comfyui_outdated"}, status=403)
 *         if flag_token is not None:
 *             return web.json_response({"error": flag_token}, status=403)
 *         return web.json_response({"error": "security_level"}, status=403)
 *
 * Three causes, three different remedies — and the caller saw only
 * "ComfyUI-Manager API 403 Forbidden for /v2/manager/queue/update_all". The
 * reporter had to ask which permission was even involved.
 *
 * install_comfyui (action:"update_all") specifically needs is_allowed_security_level("middle"), which passes
 * only for security_level in weak / normal / normal-. That is a Manager SETTING,
 * not a credential and not a consequence of being remote.
 *
 * NAMES NO REMEDY IT CANNOT SUPPORT. An unrecognised token is reported as the
 * flag Manager named, with no invented advice — a specific install flag denied it
 * and only that flag can say more. Guessing here would be the same defect as the
 * status blaming the filename in a userdata 400.
 */
export function explainManagerForbidden(status: number, body: string): string {
  if (status !== 403) return "";
  let reason: string | null = null;
  try {
    const parsed: unknown = JSON.parse(body);
    const e = (parsed as { error?: unknown } | null)?.error;
    if (typeof e === "string" && e.trim()) reason = e.trim();
  } catch {
    // Not JSON — Manager always sends JSON here, so an unparseable body means
    // something else answered (a proxy, an auth gate). Say nothing rather than
    // attribute a Manager reason to a response Manager may not have sent.
    return "";
  }
  if (reason === "security_level") {
    return (
      " — ComfyUI-Manager REFUSED this on its own security level, not on credentials and not" +
      " because the server is remote. Privileged Manager routes (its update-all, install and" +
      " snapshot-removal endpoints)" +
      " require Manager config security_level to be weak, normal or normal-; anything stricter" +
      " refuses. Change it in ComfyUI-Manager settings (or its config.ini) and restart ComfyUI." +
      " Loosening it decides who may reach that server, so it is a deliberate choice: the" +
      " alternative is to run the update from a shell on the machine itself."
    );
  }
  if (reason === "comfyui_outdated") {
    return (
      " — ComfyUI-Manager reports this ComfyUI as too OLD for the route: it predates the" +
      " system-user API that Manager checks first, before it ever consults security_level." +
      " Update ComfyUI itself; changing Manager settings will not clear this."
    );
  }
  if (reason) {
    return (
      ` — ComfyUI-Manager denied this via a specific install flag it names as "${reason}".` +
      " That flag, not the general security level, is what governs this route; consult" +
      " ComfyUI-Manager for what it controls."
    );
  }
  return "";
}

async function managerFetch<T>(
  path: string,
  options: ManagerFetchOptions = {},
): Promise<T | undefined> {
  const { method = "GET", body, base = managerBaseUrl(), soft = false } = options;
  const url = `${base}${path}`;
  logger.debug("Manager API request", { url, method });

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await comfyuiFetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (soft) return undefined;
    throw new NodeManagementError(
      `ComfyUI-Manager API unreachable at ${url}. Is ComfyUI running with ComfyUI-Manager installed? (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }

  if (!res.ok) {
    if (soft) return undefined;
    // unknown-ok: "" is interpolated into an ERROR MESSAGE and nothing else — the
    // HTTP status is reported either way, so an unreadable body costs detail in the
    // text, never a wrong conclusion. Verified there is no branch on this value.
    const text = await res.text().catch(() => "");
    throw new NodeManagementError(
      `ComfyUI-Manager API ${res.status} ${res.statusText} for ${path}` +
        explainManagerForbidden(res.status, text) +
        // #1397 — SHOW THE BODY. It was already being captured into `details` below
        // and only surfaced for 403, so a task-queue failure reported a bare status
        // line while the serialized exception naming the cause sat one layer down.
        // Bounded and truncation-marked; see manager-error-body.ts for why a
        // passthrough is not an option here.
        managerBodyClause(text),
      { url, status: res.status, body: text },
    );
  }

  // Some endpoints return empty bodies (e.g. queue ops). Parse defensively.
  const raw = await res.text();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as unknown as T;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The HTTP status carried on a NodeManagementError from a non-2xx Manager
 *  response (managerFetch stores { url, status, body } in `details`). */
function errorStatus(err: unknown): number | undefined {
  if (err instanceof NodeManagementError && err.details && typeof err.details === "object") {
    const s = (err.details as { status?: unknown }).status;
    return typeof s === "number" ? s : undefined;
  }
  return undefined;
}

/** Does a fetched body look like ComfyUI's SPA catchall page (an HTML document)
 *  rather than a real Manager response? The frontend catchall answers an
 *  UNREGISTERED GET path with 200 + a page of HTML, so a 200 alone is not proof a
 *  route exists. A genuine queue-control GET returns an empty (or small non-HTML)
 *  body. */
function looksLikeHtml(body: unknown): boolean {
  return typeof body === "string" && /^\s*<(?:!doctype\b|html\b|!--)/i.test(body);
}

/**
 * POST to a Manager queue CONTROL route (e.g. `${prefix}/start`), negotiating the
 * HTTP method on a 405.
 *
 * Some legacy Manager 3.x builds register `/manager/queue/start` (and peers) as
 * GET-only, so our POST comes back HTTP 405 Method Not Allowed (#551). On a
 * Manager route a 405 means "wrong method for THIS endpoint on THIS build" — NOT
 * "the Manager is unreachable" and NOT "this is a different Manager generation".
 * So retry the SAME path once with GET before giving up; a GET-only build then
 * starts its queue instead of failing the whole install.
 *
 * The GET retry is itself guarded against ComfyUI's frontend catchall: an
 * UNREGISTERED start path 405s the POST but 200s the GET with a page of HTML, and
 * that HTML must NOT be mistaken for a successful queue start (codex review). If
 * the GET yields a catchall HTML page, the route genuinely doesn't accept our
 * request — surface the original method error. Any non-405 error, or a
 * non-2xx GET, propagates unchanged.
 */
async function managerQueueControl(path: string, base: string): Promise<void> {
  try {
    await managerFetch(path, { method: "POST", base });
  } catch (err) {
    if (errorStatus(err) === 405) {
      // GET-only legacy build — negotiate the method rather than declare failure.
      logger.debug("Manager queue control 405 on POST; retrying as GET", { path });
      const body = await managerFetch<unknown>(path, { base }); // throws on a non-2xx GET
      if (looksLikeHtml(body)) throw err; // catchall page — not a real GET-only start
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Manager API generation detection (issue #116)
//
// The /v2/manager/* routes exist ONLY on the Manager v4 lineage (the
// `manager-v4` branch / pip package, ≥4.x — what the RunPod image bakes).
// The RELEASED ComfyUI-Manager (3.x `main`, what ComfyUI-Manager installs by
// default) serves the same queue engine under /manager/* with PER-OPERATION
// routes and different body shapes. Probe once per target and adapt.
// ---------------------------------------------------------------------------

// Three dialects in the wild (issue #116 found the second; #235 the third):
//   "v2"       pip comfyui_manager (Manager v4) in its NORMAL mode — the
//              unified POST /v2/manager/queue/task envelope.
//   "v2-batch" pip comfyui_manager started with --enable-manager-legacy-ui
//              (what e.g. the yanwk/comfyui-boot images hardcode): the pip
//              package loads its BUNDLED 3.x server under the /v2 prefix.
//              GET /v2/manager/queue/status exists, but POST .../task does NOT
//              — mutations go through POST /v2/manager/queue/batch with 3.x
//              body shapes ({install:[body], uninstall:[body], ...}). And
//              because ComfyUI's frontend catchall matches every path for GET,
//              an unregistered POST returns 405 (never 404) — the exact
//              symptom of #235.
//   "legacy"   the 3.x custom-node Manager: per-operation /manager/queue/*.
//
// The detected dialect is cached by ./manager-api-cache.ts — URL-keyed AND
// TTL-bounded, and invalidated by the restart lifecycle, so a ComfyUI restart at
// the SAME URL (a Manager 3.x→4.x upgrade, dropping --enable-manager-legacy-ui)
// can no longer pin the pre-restart dialect forever (#646).

/** @internal — test hook so suites can pin/clear the detected generation. */
export function resetManagerApiCacheForTests(api?: ManagerApi): void {
  setManagerApiCacheForTests(managerBaseUrl(), api);
}

/**
 * Re-classify the cached Manager dialect to "v2-batch" after the unified
 * /v2/manager/queue/task route answered 405 AND a batch retry then SUCCEEDED.
 * The /v2 queue surface is real (it answered a status during detection), so the
 * build is the bundled 3.x server under /v2 whose `is_legacy_manager_ui` probe
 * didn't identify it (#464). Pin the corrected dialect so subsequent operations
 * skip the dead task route. Caller must only invoke this once the batch enqueue
 * has actually succeeded, so a transient/proxy 405 can't poison the cache.
 *
 * `startEpoch` is the invalidation epoch from before the operation began: if
 * ComfyUI restarted while the enqueue was in flight, this conclusion describes
 * the OLD server and must not be pinned over the fresh invalidation (#646).
 */
function demoteManagerApiToV2Batch(base: string, startEpoch: number): void {
  // Guarded on the invalidation epoch ONLY (not the write counter): this verdict
  // is backed by an enqueue that actually SUCCEEDED, so it legitimately
  // supersedes a probe-derived classification that landed during the operation.
  cacheManagerApi(base, "v2-batch", { epoch: startEpoch });
}

/** A real queue/status payload — guards detection against servers that answer
 *  200 with HTML/junk for unknown GETs (SPA fallbacks, index catchalls). Accepts
 *  any of the queue-count fields the Manager reports: `total_count`/`is_processing`
 *  (both generations) plus `pending_count` (the v4-style field, issue #555) — so a
 *  v4 status shape is recognized authoritatively rather than falling through to a
 *  legacy conclusion. HTML/SPA bodies carry none of these, so they still fail. */
function looksLikeQueueStatus(s: unknown): boolean {
  if (!s || typeof s !== "object") return false;
  const q = s as QueueStatus;
  return (
    typeof q.total_count === "number" ||
    typeof q.is_processing === "boolean" ||
    typeof q.pending_count === "number" ||
    typeof q.done_count === "number"
  );
}

/**
 * Authoritative Manager MAJOR-version probe (issue #555). The two Manager
 * generations expose their version string on DISJOINT paths and nowhere else:
 *   • v4 (pip comfyui-manager) → GET /v2/manager/version   → text "V4.2.2"
 *   • released 3.x             → GET /manager/version      → text "V3.41"
 * (v4 registers NO bare /manager/version; 3.x registers NO /v2/* — verified
 * against both upstream sources.) Both return a BARE version string, so this is
 * an authoritative version signal that a 405/route-shape is NOT: a 405 means
 * "wrong method for THIS endpoint", never "old Manager". Returns the major int,
 * or undefined when neither answers with a plausible version string.
 *
 * The parse is deliberately strict (short, `V?<digits>.<digits>…`) so ComfyUI's
 * SPA catchall — which 200s unknown GETs with a page of HTML — can never be
 * mistaken for a version string.
 */
function parseManagerMajor(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (t.length === 0 || t.length > 16) return undefined; // reject HTML/SPA bodies
  const m = t.match(/^v?(\d+)(?:\.\d+)*$/i);
  return m ? Number(m[1]) : undefined;
}

async function probeManagerMajor(base: string): Promise<number | undefined> {
  // v4's /v2/manager/version is the strongest signal; check it first.
  const v4 = parseManagerMajor(
    await managerFetch<string>("/v2/manager/version", { base, soft: true }),
  );
  if (v4 !== undefined) return v4;
  return parseManagerMajor(
    await managerFetch<string>("/manager/version", { base, soft: true }),
  );
}

/**
 * Given that the /v2 queue surface answered, decide between the two pip-Manager
 * (v4) dialects. Both normal-v4 and legacy-UI mode register
 * GET /v2/manager/is_legacy_manager_ui and answer truthfully; a missing route
 * (older pip) means the normal v4 server → unified task dialect.
 */
async function resolveV2SubDialect(base: string): Promise<ManagerApi> {
  const legacyUi = await managerFetch<{ is_legacy_manager_ui?: boolean }>(
    "/v2/manager/is_legacy_manager_ui",
    { base, soft: true },
  );
  return legacyUi && typeof legacyUi === "object" && legacyUi.is_legacy_manager_ui === true
    ? "v2-batch"
    : "v2";
}

/**
 * In-flight detection, shared by every caller that misses the cache for the same
 * base under the same epoch. Without this, N operations arriving just after the
 * window lapses each fire their own probe round — a thundering herd against a
 * server that is often exactly the one that just restarted (#646 review).
 *
 * The EPOCH is part of the join key: a detection that started before an
 * invalidation is probing the pre-restart server, so a caller arriving after the
 * reset must start its own rather than inherit that reading.
 */
let detectInflight: { base: string; epoch: number; promise: Promise<ManagerApi> } | null = null;

/** How many times a detection will re-probe when it is invalidated mid-probe
 *  before giving the caller its latest reading anyway. A restart storm must not
 *  spin here; three readings is far past any real restart. */
const DETECT_INVALIDATION_RETRIES = 2;

export async function detectManagerApi(base = managerBaseUrl()): Promise<ManagerApi> {
  for (let attempt = 0; ; attempt++) {
    const cached = getCachedManagerApi(base);
    if (cached !== undefined) return cached;

    const epochAtStart = managerApiEpoch();
    let entry = detectInflight;
    let created = false;
    if (!(entry && entry.base === base && entry.epoch === epochAtStart)) {
      entry = { base, epoch: epochAtStart, promise: probeManagerApi(base) };
      detectInflight = entry;
      created = true;
    }
    let api: ManagerApi;
    try {
      api = await entry.promise;
    } finally {
      // Only the caller that STARTED this probe clears the slot, and only if it
      // is still ours — a joiner finishing early must not free the slot out from
      // under a probe others could still share.
      if (created && detectInflight === entry) detectInflight = null;
    }

    // The commit was already dropped if something invalidated the cache while we
    // probed — but the VALUE is just as stale, and returning it would route the
    // caller's mutation at the server that just went away (#646 review). Probe
    // again against whatever is there now.
    if (managerApiEpoch() === epochAtStart) return api;
    if (attempt >= DETECT_INVALIDATION_RETRIES) {
      // Every reading so far described a server that was already gone. Handing
      // the last one back would send a mutation on a dialect we KNOW is stale, so
      // refuse instead — nothing has been sent at this point, which makes this the
      // one moment where failing is completely free.
      throw new NodeManagementError(
        "ComfyUI-Manager's API generation could not be determined: the connected ComfyUI kept " +
          "being restarted (or retargeted) while comfyui-mcp was probing it, so every reading " +
          "described a server that was already gone. NOTHING was sent to the Manager. Wait for " +
          "ComfyUI to settle, then retry.",
      );
    }
    logger.debug("Manager dialect detection invalidated mid-probe — re-probing", {
      base,
      dropped: api,
      attempt,
    });
  }
}

async function probeManagerApi(base: string): Promise<ManagerApi> {
  // Stamp the cache state BEFORE probing: if ComfyUI is restarted — or another
  // probe commits a fresher verdict — while these probes are in flight, this
  // conclusion describes a server that may be gone and must not be pinned over
  // the newer state (#646).
  const stamp = managerApiCacheStamp();
  const v2 = await managerFetch<QueueStatus>("/v2/manager/queue/status", { base, soft: true });
  if (looksLikeQueueStatus(v2)) {
    const api = await resolveV2SubDialect(base);
    cacheManagerApi(base, api, stamp);
    return api;
  }
  const legacy = await managerFetch<QueueStatus>("/manager/queue/status", { base, soft: true });
  if (looksLikeQueueStatus(legacy)) {
    // /manager/queue/status answering ALMOST always means the released 3.x
    // custom-node Manager — but do NOT brand it "legacy 3.x" (and speak 3.x
    // grammar, and tell the user to upgrade) on the route shape alone (#555). A
    // v4 host reached only through a proxy/back-compat shim could also answer
    // here; CONFIRM the generation with the authoritative version string first.
    // A 405/route-shape is NEVER the version signal — /v2/manager/version ("V4.x")
    // vs /manager/version ("V3.x") is.
    const major = await probeManagerMajor(base);
    if (major !== undefined && major >= 4) {
      // Version says v4 — but only speak v4 if its queue surface ACTUALLY
      // validates now (re-probe): routing to v2 when /v2/manager/queue/status is
      // unreachable would enqueue work we then can't poll → a false timeout and a
      // duplicate on retry (codex review). If the v4 surface still doesn't answer,
      // keep the proven, WORKING legacy classification (we hold a validated
      // /manager queue endpoint) rather than route to a dead v4 surface.
      const v2Retry = await managerFetch<QueueStatus>("/v2/manager/queue/status", {
        base,
        soft: true,
      });
      if (looksLikeQueueStatus(v2Retry)) {
        const api = await resolveV2SubDialect(base);
        cacheManagerApi(base, api, stamp);
        return api;
      }
    }
    cacheManagerApi(base, "legacy", stamp);
    return "legacy";
  }
  throw new NodeManagementError(
    "ComfyUI-Manager's queue API is not reachable (neither /v2/manager/queue/status " +
      "nor /manager/queue/status answered with a queue status). Is ComfyUI-Manager " +
      "installed and enabled on the connected ComfyUI? The pip comfyui_manager " +
      "package only activates when ComfyUI is started with --enable-manager.",
  );
}

/** Queue route prefix for a dialect ("v2-batch" serves status/start under the
 *  /v2 prefix too — only the mutation routes differ). */
function managerQueuePrefixFor(api: ManagerApi): string {
  return api === "legacy" ? "/manager/queue" : "/v2/manager/queue";
}

/** Prefix for non-queue Manager routes.  The two pip-Manager dialects both
 * serve their custom-node/config surface under /v2; only the standalone 3.x
 * Manager uses unprefixed paths. */
export function managerApiPrefixFor(api: ManagerApi): string {
  return api === "legacy" ? "" : "/v2";
}

/** Appended to every legacy-Manager operation failure so users know they're on
 *  the partial feature set and how to get off it. */
const MANAGER_UPGRADE_HINT =
  "NOTE: this ComfyUI runs the LEGACY ComfyUI-Manager 3.x. comfyui-mcp is optimized " +
  "for Manager v4+ — on 3.x some operations degrade or are unavailable (notably " +
  "arbitrary-URL model downloads, which 3.x whitelist-gates). RECOVERY — migrate to " +
  "Manager v4 (one time, on the ComfyUI host): " +
  "1) in ComfyUI's python env run `pip install -U comfyui_manager`; " +
  "2) disable the old custom_nodes/ComfyUI-Manager clone so it no longer shadows the " +
  "pip package (rename it to ComfyUI-Manager.disabled, or delete it); " +
  "3) restart ComfyUI with --enable-manager, then retry the operation. " +
  "See https://comfyui-mcp.artokun.io/docs/troubleshooting";

/** Appended to v2-batch (pip Manager in legacy-UI mode) failures. */
const MANAGER_LEGACY_UI_HINT =
  "NOTE: this ComfyUI runs Manager v4 (pip comfyui_manager) in LEGACY-UI mode " +
  "(--enable-manager-legacy-ui), which serves the older 3.x API — some operations " +
  "degrade (notably arbitrary-URL model downloads, which the 3.x code whitelist-gates). " +
  "For the full v4 API, start ComfyUI without --enable-manager-legacy-ui (for " +
  "yanwk/comfyui-boot images that flag is hardcoded in the entrypoint). " +
  "See https://comfyui-mcp.artokun.io/docs/troubleshooting";

/**
 * #1326 — what an install-model failure on legacy Manager is allowed to CLAIM.
 *
 * The sentence below used to be appended to every `install-model` failure on 3.x,
 * unconditionally: "Arbitrary-URL model installs REQUIRE Manager v4+". For the URL
 * whitelist that is right, and it is the common case. For a security_level refusal, a
 * 404 URL, a full disk or a Manager bug it is a confident answer to a question nobody
 * asked — and it sends the reader through a Manager migration that will not fix it.
 *
 * The reporter of #1326 saw exactly the ambiguous form: a bare
 * `ComfyUI-Manager API 500 Internal Server Error for /manager/queue/install_model`,
 * with our v4 sentence attached. Manager's own response body — the one thing that
 * would have said which it was — was captured in `details.body` and never shown.
 *
 * So: three states, not two (#796). Say WHICH when the evidence decides it, offer the
 * candidates when it does not, and show Manager's own words either way.
 */
function whitelistVerdict(details: unknown): "proven" | "excluded" | "unknown" {
  const d = details as { status?: unknown; body?: unknown } | undefined;
  const status = typeof d?.status === "number" ? d.status : undefined;
  const body = typeof d?.body === "string" ? d.body : "";
  // A security_level refusal is a DIFFERENT fault with a different fix (a Manager
  // config setting, not a migration), and explainManagerForbidden already spells it
  // out. Offering the whitelist beside it would give two causes for one failure.
  //
  // Keyed on the marker, not on the bare 403: a proxy or auth gate in front of ComfyUI
  // also answers 403, and that is not Manager speaking at all.
  if (status === 403 && /"error"\s*:\s*"security_level"/.test(body)) return "excluded";
  // Manager 3.x names the model-list check when it rejects one. Only these positively
  // establish it — anything else stays "unknown" rather than defaulting to the guess.
  //
  // Not applied to an HTML page: a proxy error or a framework traceback can contain the
  // words "model list" without being Manager's rejection, and "proven" is the one branch
  // that speaks with certainty. Manager answers JSON/plain text here.
  if (/^\s*<|<html/i.test(body)) return "unknown";
  if (/model[- _]?list|whitelist|not (?:in|found in) the model list|invalid model/i.test(body))
    return "proven";
  return "unknown";
}

/**
 * Strip credentials out of text that is about to be shown to a user.
 *
 * Redacting only the values from `details.url` is NOT enough here, and getting that
 * wrong would have leaked a token. `details.url` is the Manager ENDPOINT
 * (`…/manager/queue/install_model`) — the MODEL url, which is the one carrying a
 * Hugging Face / CivitAI token, travels in the POST BODY. Manager echoes that url back
 * when the download fails ("failed fetching <url>"), so the secret arrives through a
 * path an endpoint-only redaction never sees.
 *
 * So every url found in the text has its query VALUES redacted, whatever its origin,
 * plus a few token shapes that travel outside a query string. Keys are kept: the reader
 * still needs to see that a token was present.
 */
function redactCredentialsForDisplay(text: string, endpointUrl?: string): string {
  let out = text;
  const redactUrlValues = (raw: string): void => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return; // not a parseable url — nothing known to redact
    }
    for (const value of url.searchParams.values()) {
      // Short values are structural (page=2, type=vae), not secrets.
      if (!value || value.length < 12) continue;
      for (const form of new Set([value, encodeURIComponent(value)])) {
        out = out.split(form).join("«redacted»");
      }
    }
  };
  if (endpointUrl) redactUrlValues(endpointUrl);
  for (const found of text.match(/https?:\/\/[^\s"'<>)\\]+/gi) ?? []) redactUrlValues(found);
  // Token shapes that are not query values (an Authorization header echoed into a
  // traceback, a bare token in a message).
  out = out
    .replace(/\b(hf_|sk-|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{8,}/g, "«redacted»")
    .replace(/\b([Bb]earer\s+)[A-Za-z0-9._~+/-]{12,}=*/g, "$1«redacted»");
  return out;
}

/** Manager's own response body, bounded and stripped of credentials. This is the
 *  evidence #1326 lost. */
function managerBodyExcerpt(details: unknown): string {
  const d = details as { body?: unknown; url?: unknown } | undefined;
  const raw = typeof d?.body === "string" ? d.body.trim() : "";
  if (!raw) return "";
  const body = redactCredentialsForDisplay(raw, typeof d?.url === "string" ? d.url : undefined);
  const MAX = 600;
  const clipped = body.length > MAX ? `${body.slice(0, MAX)}… (truncated)` : body;
  return ` ComfyUI-Manager said: ${clipped}`;
}

/** Wrap a legacy-Manager failure with the upgrade guidance (keeps details). */
function annotateLegacyError(
  err: unknown,
  kind: ManagerTaskKind,
  hint: string = MANAGER_UPGRADE_HINT,
): NodeManagementError {
  const base = err instanceof Error ? err.message : String(err);
  const details = err instanceof NodeManagementError ? err.details : undefined;
  let extra = "";
  if (kind === "install-model") {
    switch (whitelistVerdict(details)) {
      case "proven":
        extra =
          " Arbitrary-URL model installs REQUIRE Manager v4+ (3.x only accepts whitelisted catalog models).";
        break;
      case "excluded":
        // Deliberately silent: the 403 explanation is the answer, and adding the
        // whitelist sentence beside it would offer a second, wrong cause.
        break;
      case "unknown":
        // Still LEADS with the whitelist and keeps the upgrade path: on 3.x that is the
        // usual cause and the migration below is the fix, which is real value (#553) and
        // must not be hedged away. What changes is only the certainty — Manager did not
        // say so here, and three other faults fail identically. Naming them costs a
        // sentence; omitting them cost the reporter of #1326 a diagnosis.
        extra =
          " On Manager 3.x the usual cause is its model-list whitelist: arbitrary-URL model" +
          " installs REQUIRE Manager v4+ (3.x only accepts whitelisted catalog models), and" +
          " the recovery below is that upgrade. Manager did NOT say so explicitly here," +
          " though — a security_level refusal, an unreachable URL, or no space on the host" +
          " fail the same way. If the upgrade does not resolve it, the ComfyUI server log" +
          " names which.";
        break;
    }
    extra += managerBodyExcerpt(details);
  }
  return new NodeManagementError(`${base}${extra}\n${hint}`, details);
}

/** #1326 — the cause-attribution above is the whole user-visible product of a failed
 *  install-model, and it is reached only through a live Manager. Exposed so it can be
 *  asserted against real error shapes rather than through a mocked HTTP stack. */
export const __managerCauseTestHooks = {
  annotateLegacyError,
  whitelistVerdict,
  managerBodyExcerpt,
  NodeManagementError,
};

/**
 * Translate one unified-task call into the legacy per-operation route + body.
 * Body shapes verified against ComfyUI-Manager 3.41 glob/manager_server.py:
 * install/uninstall/update/fix/disable key on `version` ('unknown' → treat
 * `files[0]` as a git URL / folder name), and install (unlike v4) accepts a
 * REAL git URL natively via { version:'unknown', files:[url] }.
 */
function legacyTaskRequest(
  kind: ManagerTaskKind,
  params: Record<string, unknown>,
  uiId: string,
): { path: string; body: Record<string, unknown> } {
  const nodeName = (params.node_name ?? params.id) as string | undefined;
  const version = (params.node_ver as string) || (params.selected_version as string) || "latest";
  switch (kind) {
    case "install":
      return {
        path: "/manager/queue/install",
        body: {
          ui_id: uiId,
          id: params.id,
          version: params.version ?? version,
          selected_version: params.selected_version ?? version,
          ...(params.files ? { files: params.files } : {}),
          ...(params.repository ? { repository: params.repository } : {}),
          ...(params.pip ? { pip: params.pip } : {}),
          channel: params.channel ?? "default",
          mode: params.mode ?? "cache",
          ...(params.skip_post_install !== undefined
            ? { skip_post_install: params.skip_post_install }
            : {}),
        },
      };
    case "enable":
      // Legacy has no enable route — the UI re-installs with skip_post_install.
      return {
        path: "/manager/queue/install",
        body: {
          ui_id: uiId,
          id: nodeName,
          version,
          selected_version: version,
          skip_post_install: true,
          channel: "default",
          mode: "cache",
        },
      };
    case "uninstall":
      return {
        path: "/manager/queue/uninstall",
        body: { ui_id: uiId, id: nodeName, version },
      };
    case "update":
      return {
        path: "/manager/queue/update",
        body: { ui_id: uiId, id: nodeName, version },
      };
    case "fix":
      return {
        path: "/manager/queue/fix",
        body: { ui_id: uiId, id: nodeName, version },
      };
    case "disable":
      return {
        path: "/manager/queue/disable",
        body: { ui_id: uiId, id: nodeName, version },
      };
    case "install-model":
      // Same model-item body — but 3.x validates it against the model-list
      // whitelist, so arbitrary-URL installs are rejected (v4-only feature).
      return { path: "/manager/queue/install_model", body: { ...params, ui_id: uiId } };
  }
}

/**
 * Tunable timing for queue polling. Defaults are production values; tests
 * shrink these via setQueueTimingForTests to keep the suite fast.
 */
const queueTiming = {
  pollIntervalMs: 1500,
  // The worker thread is spawned asynchronously by /manager/queue/start, so a
  // poll taken immediately afterward can read is_processing=false /
  // in_progress_count=0 while the queued item is still pending (total_count
  // counts queued items). Give the worker a grace window to spin up before
  // treating an idle-looking status as "done".
  startupGraceMs: 8000,
  // Budget for node installs/updates/fixes: bounded by how long `pip install`
  // and a git clone plausibly take.
  timeoutMs: 600_000,
  /**
   * Budget for an `install-model` task (#817). A model download is NOT the same
   * shape of work as a node install: 600s is a hard guarantee of failure for any
   * multi-GB file on a normal link (a 15 GB file at 25 MB/s needs 600s just for
   * the bytes, before any CDN slowness), and #817 is exactly that — the queue
   * timing out at 600s every time.
   *
   * We cannot make the REMOTE transfer resumable — ComfyUI-Manager fetches
   * server-side and exposes no per-task progress or byte count — so unlike the
   * local path (#470) there is nothing here to bound an attempt AGAINST. All we
   * can honestly do is stop declaring failure while the host is still working.
   * The value is deliberately generous rather than tuned; the timeout's job is to
   * stop us waiting forever, not to police the download.
   */
  modelTimeoutMs: 4 * 60 * 60_000,
};

/** Per-kind queue budget. Only `install-model` gets the large one — a node
 *  install that hangs for four hours is a real failure worth reporting. */
function queueTimeoutFor(kind?: ManagerTaskKind): number {
  if (kind !== "install-model") return queueTiming.timeoutMs;
  const raw = process.env.COMFYUI_MANAGER_DOWNLOAD_TIMEOUT_S;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      return Math.min(24 * 60 * 60_000, Math.max(60_000, Math.round(n) * 1000));
    }
    logger.warn(
      `Ignoring COMFYUI_MANAGER_DOWNLOAD_TIMEOUT_S="${raw}" — not a positive number of seconds.`,
    );
  }
  return queueTiming.modelTimeoutMs;
}

/** @internal — test hook to shrink polling timings; not part of the tool API. */
export function setQueueTimingForTests(
  overrides: Partial<typeof queueTiming>,
): void {
  Object.assign(queueTiming, overrides);
}

/** Queue counts for honest before/after reporting around a queue reset. */
export interface ManagerQueueCounts {
  /** Tasks still WAITING to run — v4's `pending_count` directly, else the 3.x
   *  arithmetic total−done−in_progress (3.x defines total that way exactly). */
  pending: number;
  /** Tasks already dequeued by the worker — these a queue reset CANNOT stop. */
  inProgress: number;
  /** Manager's worker-alive flag (falls back to inProgress > 0 when absent). */
  processing: boolean;
}

/**
 * Extract counts from a queue/status payload. Returns undefined when required
 * fields are missing or the counts are incoherent (negative pending — the
 * #639 stale-3.x signature), so callers report "could not verify" instead of
 * guessing.
 */
function countsFromStatus(status: unknown): ManagerQueueCounts | undefined {
  if (!status || typeof status !== "object") return undefined;
  const s = status as QueueStatus;
  const inProgress = typeof s.in_progress_count === "number" ? s.in_progress_count : undefined;
  if (inProgress === undefined) return undefined;
  let pending: number;
  if (typeof s.pending_count === "number") {
    pending = s.pending_count; // v4 reports it directly
  } else {
    // 3.x: total_count = done + in_progress + queued exactly.
    if (typeof s.total_count !== "number" || typeof s.done_count !== "number") {
      return undefined;
    }
    pending = s.total_count - s.done_count - inProgress;
    if (pending < 0) return undefined; // incoherent counts — cannot verify anything
  }
  return {
    pending,
    inProgress,
    processing: typeof s.is_processing === "boolean" ? s.is_processing : inProgress > 0,
  };
}

/**
 * Read the Manager queue counts ONCE, in the detected dialect — the measuring
 * stick for the pin-write cancellation path (#689), which must report what a
 * queue reset actually dropped rather than claim the panel was saved.
 *
 * These are SHARED, queue-wide counts: they can never say whether OUR task is
 * among the pending ones (that needs fetchManagerClientQueueCounts /
 * fetchManagerTaskHistoryEntry on v4).
 *
 * Returns undefined whenever the state cannot be PROVEN: detection failed,
 * the status endpoint did not answer with queue counts, required fields are
 * missing, or the counts are incoherent. The caller reports "could not
 * verify" and keeps the pending-op marker rather than guessing in either
 * direction.
 */
export async function fetchManagerQueueCounts(
  base = managerBaseUrl(),
): Promise<ManagerQueueCounts | undefined> {
  let api: ManagerApi;
  try {
    api = await detectManagerApi(base);
  } catch {
    return undefined;
  }
  const status = await managerFetch<QueueStatus>(`${managerQueuePrefixFor(api)}/status`, {
    base,
    soft: true,
  });
  return countsFromStatus(status);
}

/**
 * v4-only: queue counts for tasks THIS orchestrator enqueued (every enqueue
 * carries client_id "comfyui-mcp"). This is what separates "the update-all is
 * still queued" from "UNRELATED tasks are queued" on a shared Manager — the
 * distinction a proven cancel needs (#689 round 3).
 *
 * Returns undefined on any non-v4 dialect: the 3.x and legacy-UI (v2-batch)
 * status handlers IGNORE the client_id parameter and answer GLOBAL counts,
 * which would impersonate our tasks. Also undefined when unreadable or
 * incoherent.
 */
export async function fetchManagerClientQueueCounts(
  base = managerBaseUrl(),
): Promise<ManagerQueueCounts | undefined> {
  let api: ManagerApi;
  try {
    api = await detectManagerApi(base);
  } catch {
    return undefined;
  }
  if (api !== "v2") return undefined;
  const status = await managerFetch<QueueStatus>(
    `/v2/manager/queue/status?client_id=${encodeURIComponent(MANAGER_CLIENT_ID)}`,
    { base, soft: true },
  );
  return countsFromStatus(status);
}

export interface ManagerTaskHistoryEntry {
  uiId: string;
  kind?: string;
  result?: string;
}

/**
 * v4-only: look up ONE completed task in the Manager's queue history by exact
 * ui_id (GET /v2/manager/queue/history?ui_id=…). Returns the entry when found,
 * null when the Manager provably has NO such completed task ({}), and
 * undefined when the answer cannot be trusted — non-v4 dialect (the legacy-UI
 * history route knows only the file-based ?id= form, so it would not answer
 * the question asked) or an unreadable response.
 */
export async function fetchManagerTaskHistoryEntry(
  uiId: string,
  base = managerBaseUrl(),
): Promise<ManagerTaskHistoryEntry | null | undefined> {
  let api: ManagerApi;
  try {
    api = await detectManagerApi(base);
  } catch {
    return undefined;
  }
  if (api !== "v2") return undefined;
  const res = await managerFetch<{ history?: unknown }>(
    `/v2/manager/queue/history?ui_id=${encodeURIComponent(uiId)}`,
    { base, soft: true },
  );
  if (!res || typeof res !== "object" || !("history" in res)) return undefined;
  const history = (res as { history: unknown }).history;
  if (!history || typeof history !== "object" || Array.isArray(history)) return undefined;
  const h = history as Record<string, unknown>;
  if (typeof h.ui_id !== "string") {
    // {"history": {}} is the provable "no such completed task". Anything else
    // shaped wrong is not an answer we can act on.
    return Object.keys(h).length === 0 ? null : undefined;
  }
  // STRICT id check: an entry for a DIFFERENT task (a rewriting proxy, a
  // Manager variant that ignores ui_id and answers with something else's
  // history) must never prove anything about OUR task — least of all clear
  // its marker as already-drained (#689 round 4).
  if (h.ui_id !== uiId) return undefined;
  return {
    uiId: h.ui_id,
    kind: typeof h.kind === "string" ? h.kind : undefined,
    result: typeof h.result === "string" ? h.result : undefined,
  };
}

/**
 * Kick off the Manager queue worker and poll until it drains.
 * Returns the final queue status.
 *
 * `api` is REQUIRED and must be the dialect the caller ACTUALLY enqueued with.
 * Re-deriving the prefix from the cache here could start and poll a different
 * generation's queue than the one holding our task (after a self-heal retry, or
 * when a concurrent detection lands mid-operation), reporting a false failure for
 * work that is really running — and inviting a caller retry that double-executes
 * it (#646).
 */
async function runManagerQueue(
  api: ManagerApi,
  base: string,
  /** Selects the queue budget — a model download gets a far larger one than a
   *  node install (#817). Omitted ⇒ the node-install budget. */
  kind?: ManagerTaskKind,
): Promise<QueueStatus> {
  const prefix = managerQueuePrefixFor(api);
  const timeoutMs = queueTimeoutFor(kind);
  // queue/start returns 200 (worker started) or 201 (already running) — both
  // are 2xx, so managerFetch accepts either. Same on both generations. Some
  // legacy 3.x builds expose start as GET-only, so negotiate POST→GET on a 405
  // (#551) rather than failing the queue on a method mismatch.
  await managerQueueControl(`${prefix}/start`, base);

  const start = Date.now();
  let lastStatus: QueueStatus | undefined;
  while (Date.now() - start < timeoutMs) {
    await sleep(queueTiming.pollIntervalMs);
    const status = await managerFetch<QueueStatus>(`${prefix}/status`, {
      base,
      soft: true,
    });
    if (status) {
      lastStatus = status;
      // Manager defines total_count = done + in_progress + queued. The queue
      // is fully drained only once nothing is processing AND every item that
      // was ever queued has completed (done_count >= total_count, which also
      // implies in_progress_count === 0 and no queued items remain).
      const drained =
        !status.is_processing && status.done_count >= status.total_count;
      if (drained && Date.now() - start >= queueTiming.startupGraceMs) {
        return status;
      }
    }
  }
  // TIMED OUT. Be precise about what that does and does NOT mean (#817): we
  // stopped WAITING; the ComfyUI host's queue worker was never told to stop and,
  // for a model download, is very likely still streaming. Reporting this as a
  // plain failure is what led #817's reporter to re-issue — starting a SECOND
  // server-side fetch of the same file, which is how the destination ended up
  // truncated and failing safetensors shape checks. There is no Manager API to
  // recall a queued task, so the only honest remedy is: look, don't re-issue.
  throw new NodeManagementError(
    `ComfyUI-Manager queue did not finish within ${Math.round(timeoutMs / 1000)}s. ` +
      (kind === "install-model"
        ? `This is the WAIT giving up, NOT proof the download failed — ComfyUI-Manager fetches the file ` +
          `server-side and there is no API to stop or inspect an individual task, so the host is probably ` +
          `still downloading. Do NOT re-issue the download: a second server-side fetch writes the SAME ` +
          `destination file concurrently, and the interleaved result is a corrupt model (that is the ` +
          `"shape is invalid for input of size N" failure). Instead, wait and check list_local_models on ` +
          `the connected server until the file appears and its size stops changing. If your files are ` +
          `genuinely larger than this budget, raise COMFYUI_MANAGER_DOWNLOAD_TIMEOUT_S (seconds), or ` +
          `download to a LOCAL ComfyUI, where the transfer is streamed here — resumable, retried ` +
          `automatically, and size-verified before anything is reported as landed.`
        : `The Manager worker may still be running the task on the host; check its state before retrying.`),
    lastStatus,
  );
}

/**
 * Enqueue one operation on ComfyUI-Manager's unified task queue and drain it.
 * Wraps the caller's per-kind `params` in the QueueTaskItem envelope the v2
 * endpoint validates ({ ui_id, client_id, kind, params }) and returns the final
 * queue status. `ui_id` is also threaded into params (Manager's models carry an
 * optional ui_id for correlation).
 */
async function queueManagerTask(
  kind: ManagerTaskKind,
  params: ManagerTaskParams,
  base = managerBaseUrl(),
): Promise<QueueStatus> {
  // Normalize to a resolver so every attempt builds its body for the dialect it
  // is about to speak — a few operations (git installs) have dialect-specific
  // params, and a self-heal retry must rebuild them, not just re-route them.
  const resolve: ManagerParamsResolver =
    typeof params === "function" ? params : () => params;
  // This is a mutation transaction, so freeze its target before the first await.
  // A later setComfyuiTarget() selects where NEW calls go; it must not redirect a
  // retry, queue start, or verification of a request the user already made.
  const used = await enqueueWithDialectSelfHeal(kind, (api, epoch) =>
    enqueueManagerTask(api, kind, resolve, randomUUID(), base, epoch),
    base,
  );
  // Thread the kind so a model download gets the model budget, not the node one (#817).
  return runManagerQueue(used, base, kind);
}

/** Params for a Manager task: a fixed body, or a resolver invoked with the
 *  dialect the request is about to be sent in (for dialect-specific bodies). */
type ManagerParamsResolver = (api: ManagerApi) => Record<string, unknown>;
type ManagerTaskParams = Record<string, unknown> | ManagerParamsResolver;

/**
 * Run ONE enqueue against the detected Manager dialect, healing a stale
 * classification (#646). `enqueue` must only ENQUEUE — never drain — because a
 * re-send is sound only while nothing has been queued yet; it is handed the
 * dialect to speak and the invalidation epoch the operation started under.
 *
 * EVERY operation routed through here is a MUTATION (install, uninstall, update,
 * fix, enable/disable, install-model, update-all, Manager self-update) and Manager
 * has no idempotency key, so a re-sent request is a genuinely second operation.
 * The enqueue is therefore re-sent ONLY when the failure PROVES nothing ran — a
 * 404/405 route rejection — and only when a fresh probe shows the dialect really
 * changed. It is called at most twice, never recursively.
 *
 * On an AMBIGUOUS failure that also indicates a dialect change (a 400: possibly a
 * validation rejection, possibly a handler that already acted) the classification
 * is still refreshed, but the operation is NOT re-sent — the caller gets an
 * actionable error and decides. See AMBIGUOUS_MISMATCH_STATUSES.
 */
async function enqueueWithDialectSelfHeal(
  label: string,
  enqueue: (api: ManagerApi, startEpoch: number) => Promise<ManagerApi | void>,
  base = managerBaseUrl(),
): Promise<ManagerApi> {
  const api = await detectManagerApi(base);
  // Epoch snapshot taken AFTER detection, i.e. spanning exactly the enqueue whose
  // outcome a conclusion would be based on. Taking it earlier would also cover the
  // detection — and since a detection invalidated mid-probe now re-probes and
  // returns a POST-restart dialect, that stale epoch would then veto a perfectly
  // good conclusion drawn from it (the #464 v2→v2-batch demotion would never
  // re-pin, leaving every later op to 405 on /queue/task first — #646 review).
  const startEpoch = managerApiEpoch();
  try {
    return (await enqueue(api, startEpoch)) ?? api;
  } catch (err) {
    const fresh = await redetectAfterDialectMismatch(api, label, err, base);
    if (fresh === undefined) throw err;
    if (!ROUTE_MISMATCH_STATUSES.has(errorStatus(err) as number)) {
      // The dialect DID change, but this failure doesn't prove the request went
      // unexecuted, so re-sending it could run the mutation twice. Refuse, and
      // hand the user everything needed to decide (#646 review).
      throw dialectChangedError(label, api, fresh, err);
    }
    // A route-level rejection: no handler ran, so nothing was enqueued —
    // re-enqueue ONCE in the dialect the live server actually speaks.
    return (await enqueue(fresh, managerApiEpoch())) ?? fresh;
  }
}

/**
 * Enqueue a task without draining the Manager queue.  This is the small shared
 * seam for tools that deliberately batch several mutations before starting the
 * worker.  It retains the same cached-dialect self-heal as queueManagerTask:
 * only a 404/405 route rejection is re-sent, never an ambiguous handler error.
 */
export async function enqueueManagerTaskForExternal(
  kind: ManagerTaskKind,
  params: Record<string, unknown> | ((api: ManagerApi) => Record<string, unknown>),
  base = managerBaseUrl(),
): Promise<ManagerApi> {
  return enqueueWithDialectSelfHeal(
    kind,
    (api, epoch) => enqueueManagerTask(
      api,
      kind,
      typeof params === "function" ? params : () => params,
      randomUUID(),
      base,
      epoch,
    ),
    base,
  );
}

/** Start the queue that received an externally enqueued task. */
export async function startManagerQueueForExternal(api: ManagerApi, base = managerBaseUrl()): Promise<void> {
  await managerQueueControl(`${managerQueuePrefixFor(api)}/start`, base);
}

/**
 * The classification was stale AND the failure can't be proven pre-execution, so
 * the operation was deliberately not re-sent. Say exactly that: which dialect we
 * spoke, which one the server actually speaks now, that the classification is
 * already corrected, and that the previous attempt's effect is UNKNOWN — so the
 * user verifies before reissuing rather than blindly repeating a mutation.
 */
function dialectChangedError(
  label: string,
  was: ManagerApi,
  now: ManagerApi,
  cause: unknown,
): NodeManagementError {
  const base = cause instanceof Error ? cause.message : String(cause);
  return new NodeManagementError(
    `${base}\nThe ComfyUI-Manager API dialect CHANGED under this connection: the request ` +
      `was sent as "${was}", but the live server now answers as "${now}" (ComfyUI was ` +
      `restarted with a different Manager generation at the same URL). comfyui-mcp has ` +
      `re-detected the dialect, so the next call routes correctly. The "${label}" request ` +
      `was NOT retried automatically: this failure does not prove the server left it ` +
      `unexecuted, and Manager offers no idempotency key, so an automatic retry could run ` +
      `it TWICE. VERIFY whether it took effect (install_custom_node (action:"list") / list_local_models, ` +
      `or the ComfyUI server log), then reissue it if it did not.`,
    cause instanceof NodeManagementError ? cause.details : undefined,
  );
}

/**
 * ROUTE-level rejections: the request never reached a handler, so the operation
 * PROVABLY did not run and re-sending it cannot double-execute anything. On a
 * Manager route this is exactly 404/405 — ComfyUI's frontend catchall answers an
 * unregistered POST with 405 (never 404), and both mean "no such route on this
 * build", never "the Manager is unreachable". These are the ONLY statuses that
 * may trigger an automatic re-enqueue.
 */
const ROUTE_MISMATCH_STATUSES = new Set([404, 405]);

/**
 * A 400 is AMBIGUOUS. It can mean a stale dialect — a v4 Manager rejecting a
 * 3.x-shaped install_model body is the #646 report itself — but it can equally
 * come from a handler that already did the work and failed afterwards, or from a
 * proxy on the response path. Manager exposes no idempotency key, so a re-sent
 * mutation is a genuinely SECOND operation; there is no way to make that safe.
 *
 * So a 400 refreshes the CLASSIFICATION but never re-sends the request: if the
 * re-probe shows the dialect really did change, the caller gets an actionable
 * error naming both dialects and is left to decide whether to reissue. Refusing
 * is always correct here; guessing is not.
 *
 * Everything else (403 security_level gating, 5xx, transport failures, queue-drain
 * timeouts) is not a dialect signal at all and triggers neither.
 */
const AMBIGUOUS_MISMATCH_STATUSES = new Set([400]);

/**
 * Decide whether a failed enqueue was the CACHED DIALECT being stale, and if so
 * return the dialect the live server actually speaks now (undefined = no dialect
 * news; the caller surfaces its original failure).
 *
 * A restart at the same URL can swap the Manager generation underneath a cached
 * classification (#646). The explicit restart-lifecycle invalidation and the TTL
 * cover the common paths; this is the per-call backstop so ONE stale entry heals
 * itself instead of failing every subsequent Manager operation. It only reports
 * the change — whether the operation may be re-sent is the caller's decision,
 * made from the STATUS (see ROUTE_MISMATCH_STATUSES vs AMBIGUOUS_*).
 *
 * Three guards keep this cheap and non-looping:
 *   • only the two mismatch-capable status classes get here at all; 403/5xx and
 *     transport failures never cost a probe;
 *   • a verdict of "unchanged" (or an unreachable Manager) ARMS A COOLDOWN, so an
 *     endpoint that fails the same way on every call cannot buy a probe per call —
 *     without it, each re-check resets the entry the previous one repopulated;
 *   • the cooldown is cleared by any resetManagerApiCache(), i.e. by every real
 *     lifecycle event, so it can never delay reacting to an actual restart.
 */
/**
 * In-flight "reset + re-detect" transaction, shared per base URL. The re-check is
 * NOT just a detection: it resets the cache first, which bumps the epoch — so
 * without sharing, N concurrent failures would each reset (invalidating each
 * other's in-flight probe, since the detector joins only on a matching epoch) and
 * each run a full probe round. One transaction serves them all (#646 review).
 */
let recheckInflight: {
  base: string;
  promise: Promise<{ fresh: ManagerApi | undefined; epoch: number }>;
} | null = null;

async function sharedDialectRecheck(
  base: string,
  label: string,
  status: number,
  used: ManagerApi,
): Promise<{ fresh: ManagerApi | undefined; epoch: number }> {
  const joined = recheckInflight;
  if (joined?.base === base) return joined.promise;

  const run = async (): Promise<{ fresh: ManagerApi | undefined; epoch: number }> => {
    resetManagerApiCache(`manager ${label} enqueue failed ${status} on the "${used}" dialect`);
    const epoch = managerApiEpoch();
    try {
      return { fresh: await detectManagerApi(base), epoch };
    } catch {
      // Manager isn't answering at all — that's not a dialect mismatch; the
      // caller surfaces its own (more informative) failure. Don't re-probe on
      // every subsequent call while it stays down, unless a lifecycle event has
      // since told us something new.
      if (managerApiEpoch() === epoch) {
        suppressDialectRecheck(base, "manager unreachable during re-check");
      }
      return { fresh: undefined, epoch };
    }
  };

  const entry = { base, promise: run() };
  recheckInflight = entry;
  try {
    return await entry.promise;
  } finally {
    if (recheckInflight === entry) recheckInflight = null;
  }
}

async function redetectAfterDialectMismatch(
  used: ManagerApi,
  label: string,
  err: unknown,
  base = managerBaseUrl(),
): Promise<ManagerApi | undefined> {
  const status = errorStatus(err);
  if (
    status === undefined ||
    !(ROUTE_MISMATCH_STATUSES.has(status) || AMBIGUOUS_MISMATCH_STATUSES.has(status))
  ) {
    return undefined;
  }
  if (dialectRecheckSuppressed(base)) {
    logger.debug("Skipping Manager dialect re-check (cooldown)", { op: label, status });
    return undefined;
  }
  const { fresh, epoch: epochAfterReset } = await sharedDialectRecheck(base, label, status, used);
  if (fresh === undefined) return undefined;
  if (fresh === used) {
    // Nothing changed, so this failure was never about the dialect. Arm the
    // cooldown — but only if no lifecycle event landed since the re-check began,
    // otherwise a stale continuation would suppress re-checks against a server
    // we now know nothing about (#646 review).
    if (managerApiEpoch() === epochAfterReset) {
      suppressDialectRecheck(base, `dialect confirmed unchanged ("${used}") after a ${status}`);
    }
    return undefined;
  }
  logger.info("Manager API dialect changed under a cached classification", {
    op: label,
    was: used,
    now: fresh,
    status,
    // A route-level rejection proves nothing ran, so the caller re-sends once;
    // anything else is refused rather than risking a double-execute.
    resend: ROUTE_MISMATCH_STATUSES.has(status),
  });
  return fresh;
}

/**
 * ENQUEUE one operation in the given dialect, WITHOUT draining the queue.
 *
 * The split matters twice over. For #424, it lets a caller tell an ENQUEUE
 * failure apart from a later queue-control/drain failure: a 405 raised by
 * `${prefix}/start` inside runManagerQueue says nothing about whether the
 * OPERATION's own route exists, so it must never be read as "this build doesn't
 * register that route". For #646, it is what makes the dialect self-heal sound:
 * queueManagerTask retries this step and only this step, and a retry is only safe
 * while nothing has been queued yet. Draining happens once, afterwards.
 *
 * Returns the dialect the enqueue ACTUALLY spoke, so the drain polls the queue
 * that holds the task.
 */
async function enqueueManagerTask(
  api: ManagerApi,
  kind: ManagerTaskKind,
  resolveParams: ManagerParamsResolver,
  uiId: string,
  base: string,
  startEpoch: number,
): Promise<ManagerApi> {
  if (api === "legacy") {
    await enqueueLegacyTask(kind, resolveParams("legacy"), uiId, base);
    return "legacy";
  }
  if (api === "v2-batch") {
    await enqueueV2BatchTask(kind, resolveParams("v2-batch"), uiId, base);
    return "v2-batch";
  }
  // v2 unified task envelope (normal-mode pip Manager v4).
  try {
    await managerFetch("/v2/manager/queue/task", {
      method: "POST",
      base,
      body: {
        ui_id: uiId,
        client_id: MANAGER_CLIENT_ID,
        kind,
        params: { ...resolveParams("v2"), ui_id: uiId },
      },
    });
  } catch (err) {
    if (errorStatus(err) === 405) {
      // Detection chose the unified /v2 task dialect (the /v2 queue surface
      // answered a real status during detectManagerApi), yet THIS build 405s a
      // POST to /v2/manager/queue/task. That is the bundled 3.x server served
      // under /v2 — a legacy-UI pip Manager whose `is_legacy_manager_ui` probe
      // did NOT answer truthfully, so resolveV2SubDialect defaulted to "v2"
      // (#464: panel_update_node → "Manager …/queue/task: HTTP 405" on a
      // legacy-dialect Manager). A 405 on a Manager route is a method/route
      // signal, never "unreachable" — mirror the queue/start POST→GET
      // negotiation (#551/#586) by retrying via the v2-batch envelope instead
      // of surfacing the raw 405.
      logger.debug(
        "Manager /v2/manager/queue/task 405 — retrying via the v2-batch envelope",
        { kind },
      );
      // Rebuild the body for the dialect we are downgrading TO: this build runs
      // the 3.x handlers under /v2, so a dialect-specific body (a git install)
      // must be its 3.x shape, not the v2 one we just tried.
      await enqueueV2BatchTask(kind, resolveParams("v2-batch"), uiId, base);
      // Pin the corrected dialect ONLY after the batch enqueue actually
      // succeeded, so a transient/proxy 405 on a genuine v4 host (task 405 but
      // batch also unavailable) never poisons the cache: enqueueV2BatchTask
      // throws on a batch failure, leaving the cache as "v2" so the next op
      // re-probes the unified task route (codex review).
      demoteManagerApiToV2Batch(base, startEpoch);
      return "v2-batch";
    }
    throw err;
  }
  return "v2";
}

/**
 * Enqueue one operation on the released Manager 3.x per-operation routes
 * (issue #116 — the unified /v2 task route 405s there). Does NOT drain.
 */
async function enqueueLegacyTask(
  kind: ManagerTaskKind,
  params: Record<string, unknown>,
  uiId: string,
  base: string,
): Promise<void> {
  const { path, body } = legacyTaskRequest(kind, params, uiId);
  try {
    await managerFetch(path, { method: "POST", body, base });
  } catch (err) {
    throw annotateLegacyError(err, kind);
  }
}

/**
 * Enqueue one operation on the v2-batch dialect — pip Manager in legacy-UI mode
 * (issue #235): the /v2 prefix serves the BUNDLED 3.x server, which has no
 * unified task route (a POST there 405s via the frontend catchall). Mutations
 * take 3.x body shapes wrapped in the batch envelope {<op>: [body, ...]}; the
 * batch runs its items synchronously and reports failures as {failed: [id, ...]}.
 * install-model keeps its dedicated route (same path as v4, 3.x whitelist
 * semantics). Does NOT drain.
 */
async function enqueueV2BatchTask(
  kind: ManagerTaskKind,
  params: Record<string, unknown>,
  uiId: string,
  base: string,
): Promise<void> {
  const { path, body } = legacyTaskRequest(kind, params, uiId);
  try {
    if (kind === "install-model") {
      await managerFetch("/v2/manager/queue/install_model", { method: "POST", body, base });
    } else {
      // legacyTaskRequest's path is "/manager/queue/<op>"; the batch key is
      // that trailing op ("enable" maps to an install body → key "install").
      const op = path.split("/").pop() as string;
      const res = await managerFetch<{ failed?: unknown[] }>("/v2/manager/queue/batch", {
        method: "POST",
        body: { [op]: [body] },
        base,
      });
      const failed = Array.isArray(res?.failed) ? res.failed : [];
      if (failed.length && (body.id === undefined || failed.includes(body.id))) {
        throw new NodeManagementError(
          `ComfyUI-Manager batch reported the ${op} of "${String(body.id ?? "?")}" as failed ` +
            "(check the ComfyUI server log for the underlying error — security_level " +
            "gating is a common cause).",
        );
      }
    }
  } catch (err) {
    throw annotateLegacyError(err, kind, MANAGER_LEGACY_UI_HINT);
  }
}

// ---------------------------------------------------------------------------
// Official comfy-cli subprocess helper
// ---------------------------------------------------------------------------

const COMFY_CLI_TIMEOUT = 600_000;
// A real custom-node repo clones well under this; with prompts disabled a
// missing/private repo fails in ~1s rather than blocking the whole timeout.
const GIT_CLONE_TIMEOUT = 180_000;

/** Env for git network ops that must NEVER block on an interactive credential
 *  prompt. Without this, `git clone`/`fetch` of a missing or private repo waits
 *  on a stdin username/password prompt and hangs until the timeout (observed as a
 *  multi-minute "thinking" stall on a bad URL). GIT_ASKPASS=echo + the prompt
 *  flags make git fail fast instead. GITHUB_TOKEN is passed through when set. */
export function nonInteractiveGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
    GCM_INTERACTIVE: "never",
    ...(config.githubToken ? { GITHUB_TOKEN: config.githubToken } : {}),
  };
}

/**
 * Run an official `comfy node` subcommand. Returns normalized JSON data.
 * Throws ProcessControlError when no local workspace is available (remote
 * mode). `workspace` is the CALL-SCOPED local ComfyUI root, captured by the
 * caller BEFORE its first await — a retarget mid-operation must not send the
 * CLI at a different install than the pre/post checks described.
 */
function runCmCli(args: string[], workspace?: string): string {
  // THE CHOKE-POINT (codex gate P0). An earlier fix put this guard in
  // `comfyCliUnavailableReason`, which install/enable/disable/uninstall consult —
  // but `update`, `reinstall`, `fix all` and dependency sync call the CLI without
  // going through it, so a stale local COMFYUI_PATH was still mutable in remote
  // mode by four other routes. Every comfy-cli invocation passes through HERE, so
  // this is where the refusal belongs. Nothing has run yet at this point, which is
  // what makes refusing the right shape.
  if (isRemoteMode()) {
    throw new ProcessControlError(
      "This session targets a REMOTE ComfyUI (--comfyui-url), and comfy-cli only acts on a " +
        "LOCAL install" +
        (workspace ?? config.comfyuiPath
          ? ` — running it would modify ${workspace ?? config.comfyuiPath}, which is NOT the ` +
            `server you are connected to`
          : "") +
        ". Nothing was run. Use the ComfyUI-Manager HTTP path, which addresses the server you " +
        "are actually connected to, or run comfy-cli on the machine the install lives on.",
    );
  }
  const ws = workspace ?? config.comfyuiPath;
  if (!ws) {
    throw new ProcessControlError(
      "This operation requires a local ComfyUI install. Set COMFYUI_PATH or a " +
        "default workspace (workspace action 'set_default'), or use the Manager HTTP API.",
    );
  }
  logger.info("Running comfy-cli", { args: ["node", ...args].join(" ") });
  try {
    const envelope = assertComfyCliOk(
      runComfyCliSync(["node", ...args], {
        workspace: ws,
        timeoutMs: COMFY_CLI_TIMEOUT,
        env: config.githubToken ? { GITHUB_TOKEN: config.githubToken } : undefined,
      }),
    );
    return JSON.stringify(envelope.data ?? {}, null, 2);
  } catch (error) {
    const processError = error as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string };
    if (processError.code === "ENOENT") {
      throw new ProcessControlError(
        "The comfy-cli executable could not be started. Check COMFY_CLI_PATH and PATH.",
      );
    }
    throw new NodeManagementError(`comfy-cli node ${args[0]} failed: ${processError.message}`, {
      stdout: processError.stdout?.toString() ?? "",
      stderr: processError.stderr?.toString() ?? "",
    });
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Normalize the /customnode/installed response into InstalledNode[].
 * Manager returns an object keyed by module name (see manager_core
 * get_installed_node_packs), each value carrying { ver, cnr_id, aux_id, enabled }.
 * Older/variant builds may return an array; handle both.
 */
function parseInstalled(raw: unknown): InstalledNode[] {
  if (!raw || typeof raw !== "object") return [];

  const toNode = (module: string, v: Record<string, unknown>): InstalledNode => ({
    module,
    cnrId:
      typeof v.cnr_id === "string" && v.cnr_id.length > 0 ? v.cnr_id : undefined,
    auxId:
      typeof v.aux_id === "string" && v.aux_id.length > 0 ? v.aux_id : undefined,
    version: typeof v.ver === "string" ? v.ver : undefined,
    // `enabled` is reported as a boolean on current builds; an explicit
    // is_disabled flag is honored too. When NEITHER is present the state is
    // UNKNOWN — left undefined, never defaulted to a definite value.
    enabled:
      typeof v.enabled === "boolean"
        ? v.enabled
        : typeof v.is_disabled === "boolean"
          ? !v.is_disabled
          : undefined,
  });

  if (Array.isArray(raw)) {
    return raw
      .filter((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === "object"),
      )
      .map((entry) => {
        const module =
          (typeof entry.title === "string" && entry.title) ||
          (typeof entry.module === "string" && entry.module) ||
          (typeof entry.cnr_id === "string" && entry.cnr_id) ||
          "unknown";
        return toNode(module, entry);
      });
  }

  return Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => Boolean(v && typeof v === "object"))
    .map(([module, v]) => toNode(module, v as Record<string, unknown>));
}

function stripUrlSuffix(value: string): string {
  return value.replace(/[?#].*$/, "").replace(/\/+$/, "");
}

/**
 * Is this version string the "newest, whatever that is" SENTINEL (#1254)?
 *
 * Exported for the registry path's own translation of the same word, so the two
 * cannot drift into disagreeing about what "latest" means. Case- and
 * whitespace-insensitive because it arrives from a tool argument, not from git.
 */
export function isLatestSentinel(version: unknown): boolean {
  return typeof version === "string" && version.trim().toLowerCase() === "latest";
}

/**
 * #1470 — "nightly" IS NOT A GIT REF EITHER. It is this tool's name for the git-HEAD
 * channel, and one of our own code paths MINTS it: a git-URL install with an absent or
 * "latest" version is rewritten to `version: "nightly"` on purpose, because
 * ComfyUI-Manager rejects a registry "latest" for a repository-style entry.
 *
 * Two pieces, each right on its own, made the bug: that site means "git HEAD" by the word,
 * and the ref resolver read the same word as a ref — so a direct Git URL with
 * version:"nightly" reached `git checkout --detach --end-of-options nightly` and died. The
 * clone is then discarded as a husk, which is exactly the reported experience: cloned
 * successfully, failed, clone removed.
 *
 * Deliberately SEPARATE from `isLatestSentinel` rather than folded into it: that helper is
 * also the test at the git-URL normalisation site, where "latest" and "nightly" mean
 * different things (one is the input being translated, the other is the result). Widening
 * it there would make the translation match its own output.
 *
 * And it is applied to `version` ONLY. An explicit `ref:"nightly"` still checks out a ref:
 * a repository may genuinely have a branch or tag by that name, and silently ignoring the
 * caller's explicit ref would be a new bug in place of this one.
 */
export function isGitHeadChannel(version: unknown): boolean {
  return typeof version === "string" && version.trim().toLowerCase() === "nightly";
}

/**
 * Which git ref an install should check out, or undefined for "leave the clone
 * where it landed" (#1254).
 *
 * "latest" IS NOT A GIT REF. It is this tool's own word for "whatever is
 * newest", and `version` defaults to it — so a plain
 * install_custom_node(source:"git", version:"latest") fell straight through to
 * `git checkout --detach --end-of-options latest` and failed. Worse than a
 * failed command: the checkout failure discards the clone as a husk, so a clone
 * that had already succeeded left a partially installed node behind.
 *
 * A fresh clone is ALREADY on the default branch, which is exactly what "latest"
 * means for a git source, so the answer is to check out nothing. That also
 * restores the shallow clone — the full history is fetched only because a
 * concrete ref might need it.
 *
 * AN EXPLICIT ref is honoured LITERALLY, sentinel word or not. `ref` and a
 * `#ref` in the URL are the caller naming a ref, and repositories do carry tags
 * called `latest`; ignoring one would check out a different commit than the one
 * asked for — a wrong answer, where the bug this fixes was only a failure.
 *
 * A separate exported function rather than an expression inline, so the rule can
 * be tested as behaviour instead of asserted against source text.
 */
export function gitRefForInstall(opts: {
  /** An explicitly requested ref. */
  ref?: string;
  /** A `#ref` parsed out of the repository URL. `null` is how parseGitUrl
   *  reports "no fragment", and it must read as absent, not as a ref. */
  urlRef?: string | null;
  /** The version selector, which defaults to the "latest" sentinel. */
  version?: string;
}): string | undefined {
  // `??` already collapses parseGitUrl's `null` "no fragment" into undefined, so
  // there is no separate null check here — one would read as load-bearing and
  // never fire.
  const explicit = opts.ref ?? opts.urlRef ?? undefined;
  if (explicit !== undefined) return explicit;
  // A CHANNEL is not a ref (#1254 for "latest", #1470 for "nightly"). Only `version` is
  // collapsed here — `ref`/`urlRef` returned above are the caller's explicit git refs.
  return isLatestSentinel(opts.version) || isGitHeadChannel(opts.version)
    ? undefined
    : opts.version;
}

function validateGitRef(ref: string): string {
  if (ref.length === 0) {
    throw new ValidationError("Git ref must be a non-empty string.");
  }
  if (ref.startsWith("-")) {
    throw new ValidationError("Git ref cannot start with '-'.");
  }
  if (/[\x00-\x1F\x7F]/.test(ref)) {
    throw new ValidationError("Git ref cannot contain ASCII control characters.");
  }
  if (/\s/.test(ref)) {
    throw new ValidationError("Git ref cannot contain whitespace.");
  }
  if (/[~^:?*[\\]/.test(ref)) {
    throw new ValidationError(
      "Git ref contains characters that are not valid in git refs.",
    );
  }
  if (
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.includes("//") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref === "@" ||
    ref.endsWith(".") ||
    ref.endsWith(".lock")
  ) {
    throw new ValidationError("Git ref is not a valid git ref name.");
  }
  return ref;
}

function stripGitUrlRef(
  value: string,
  patterns: Array<{ re: RegExp; rejectSlashRef?: boolean }>,
): ParsedGitUrl | undefined {
  const normalized = stripUrlSuffix(value);
  for (const pattern of patterns) {
    const match = normalized.match(pattern.re);
    if (match) {
      const ref = decodeURIComponent(match[2]);
      if (pattern.rejectSlashRef && ref.includes("/")) {
        throw new ValidationError(
          "Ambiguous git tree URL contains a path after the ref. Pass the repository URL and explicit `ref` instead.",
        );
      }
      return { baseUrl: match[1], ref: validateGitRef(ref) };
    }
  }
  return undefined;
}

export function parseGitUrl(url: string): ParsedGitUrl {
  const input = url.trim();
  const withoutSuffix = stripUrlSuffix(input);

  // npm/pip style: repo@ref or repo.git@ref. Avoid treating the user part of
  // scp-like SSH URLs (git@github.com:owner/repo.git) as a ref.
  const atRef = withoutSuffix.match(/^(.+)@([^@/]+)$/);
  if (atRef && (!/^[^@]+@[^/:]+:/.test(withoutSuffix) || atRef[1].includes("@"))) {
    return { baseUrl: atRef[1], ref: validateGitRef(decodeURIComponent(atRef[2])) };
  }

  const matched = stripGitUrlRef(withoutSuffix, [
    { re: /^(.+?)\/-\/tree\/(.+)$/, rejectSlashRef: true },
    { re: /^(.+?)\/-\/commit\/(.+)$/ },
    { re: /^(.+?)\/tree\/(.+)$/, rejectSlashRef: true },
    { re: /^(.+?)\/commit\/(.+)$/ },
    { re: /^(.+?)\/releases\/tag\/(.+)$/ },
    { re: /^(.+?)\/src\/([^/]+)(?:\/.*)?$/ },
    { re: /^(.+?)\/commits\/(.+)$/ },
  ]);
  if (matched) return matched;

  return { baseUrl: input, ref: null };
}

function looksLikeGitUrl(id: string): boolean {
  return /^(https?:\/\/|git@|git\+)/i.test(id) || id.endsWith(".git");
}

function gitCheckoutDir(baseUrl: string): string {
  const pathPart = baseUrl.includes(":") && !baseUrl.includes("://")
    ? baseUrl.slice(baseUrl.lastIndexOf(":") + 1)
    : baseUrl;
  const clean = stripUrlSuffix(pathPart);
  return basename(clean).replace(/\.git$/i, "");
}

function runGitCheckout(baseUrl: string, ref: string, basePath?: string): void {
  // basePath is the CALL-SCOPED local ComfyUI root (apply_manifest threads an
  // adopted saved-default/live root WITHOUT mutating global config); fall back to
  // config.comfyuiPath. Either may be unset in remote mode → clear error.
  const comfyuiBase = basePath ?? config.comfyuiPath;
  if (!comfyuiBase) {
    throw new ProcessControlError(
      "Checking out a custom-node git ref requires a local ComfyUI install, " +
        "but no ComfyUI path is set.",
    );
  }

  // SECURITY: this is also reached by the forced-cm-cli git path, NOT just the
  // clone fallback, so validate here too before baseUrl / the derived dir reach
  // git or the filesystem (option injection + path traversal). Mirrors
  // cloneCustomNodeFallback's checks.
  assertSafeGitUrl(baseUrl);
  const repoName = gitCheckoutDir(baseUrl);
  assertSafeRepoName(repoName);
  const customNodesRoot = resolve(comfyuiBase, "custom_nodes");
  const nodeDir = resolve(customNodesRoot, repoName);
  const rel = relative(customNodesRoot, nodeDir);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ValidationError(
      `Refusing to check out: resolved path "${nodeDir}" escapes ${customNodesRoot}.`,
    );
  }
  logger.info("Checking out custom-node git ref", {
    repository: baseUrl,
    ref,
    nodeDir,
  });

  try {
    execFileSync("git", ["-C", nodeDir, "fetch", "--all", "--tags"], {
      cwd: comfyuiBase,
      encoding: "utf-8",
      timeout: GIT_CLONE_TIMEOUT,
      env: nonInteractiveGitEnv(),
    });
    execFileSync("git", ["-C", nodeDir, "checkout", "--detach", "--end-of-options", ref], {
      cwd: comfyuiBase,
      encoding: "utf-8",
      timeout: GIT_CLONE_TIMEOUT,
      env: nonInteractiveGitEnv(),
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string };
    throw new NodeManagementError(
      `Failed to check out git ref "${ref}" for custom node "${baseUrl}": ${e.message}`,
      {
        stdout: e.stdout ? e.stdout.toString() : "",
        stderr: e.stderr ? e.stderr.toString() : "",
      },
    );
  }
}

/**
 * Does an installed node match the wanted id/url? Mirrors manifest.ts's private
 * nodeAlreadyInstalled, but kept local to this unit. Normalizes (lowercase) and
 * matches an installed node's module/cnrId/auxId (and the basename of each — aux
 * ids are typically "owner/repo") against the wanted value and, when the wanted
 * value is a git URL, its derived repo name. This is how we VERIFY a Manager
 * install actually landed on disk (Manager marks the queue "done" even when it
 * resolved nothing).
 */
function nodeInstalledMatches(
  idOrUrl: string,
  installed: InstalledNode[],
): boolean {
  return findInstalledNode(idOrUrl, installed) !== undefined;
}

/**
 * The installed-list entry matching the wanted id/url, if any — the same
 * matching nodeInstalledMatches applies, but returning the node so callers can
 * also inspect its enabled flag / version (disable/uninstall post-state
 * verification, #775).
 */
function findInstalledNode(
  idOrUrl: string,
  installed: InstalledNode[],
): InstalledNode | undefined {
  const wanted = idOrUrl.trim().toLowerCase();
  const repoName = looksLikeGitUrl(idOrUrl)
    ? gitCheckoutDir(parseGitUrl(idOrUrl).baseUrl).toLowerCase()
    : wanted;
  return installed.find((node) => {
    const candidates: string[] = [];
    for (const v of [node.module, node.cnrId, node.auxId]) {
      if (!v) continue;
      const norm = v.trim().toLowerCase();
      candidates.push(norm);
      candidates.push(basename(norm));
    }
    return candidates.includes(wanted) || candidates.includes(repoName);
  });
}

// ---------------------------------------------------------------------------
// On-disk presence evidence (#797)
//
// The Manager installed-list is keyed on what the MANAGER tracks. A pack
// installed as a Comfy Registry zip (no .git) or copied into custom_nodes by
// hand is present on disk while the list says nothing about it — and a gate
// that only asks the list has no basis for asserting "not installed locally".
// The disk check below answers the SAME question the list was asked ("is this
// pack here?") against the filesystem, keeping the three outcomes distinct:
// found / scanned-and-not-there / could-not-look.
// ---------------------------------------------------------------------------

/** Directory names a pack could plausibly be installed under for `id`. */
function packDirNameCandidates(id: string): Set<string> {
  const wanted = id.trim().toLowerCase();
  const names = new Set<string>([wanted, basename(wanted)]);
  if (looksLikeGitUrl(id)) {
    names.add(gitCheckoutDir(parseGitUrl(id).baseUrl).toLowerCase());
  }
  return names;
}

export type DiskPackPresence =
  | { state: "found"; dir: string }
  /** custom_nodes was enumerated and the pack is not in it. */
  | { state: "not-found"; scanned: string }
  /** The disk could not answer (no dir, unreadable, …) — NOT absence. */
  | { state: "unreadable"; reason: string };

/**
 * Look for a pack on disk under <comfyuiBase>/custom_nodes. A directory counts
 * when its name matches (a Manager-disabled "<name>.disabled" suffix is still
 * the pack — disabled is not uninstalled) or its pyproject.toml [project].name
 * matches (the registry-id identity a zip install keeps even when the folder
 * was renamed). An unrelated pack's unreadable pyproject simply does not vouch
 * for that directory; it never turns the whole scan into a failure.
 */
export function findPackOnDisk(id: string, comfyuiBase: string): DiskPackPresence {
  const customNodes = join(comfyuiBase, "custom_nodes");
  let entries: import("node:fs").Dirent[];
  try {
    if (!existsSync(customNodes)) {
      return {
        state: "unreadable",
        reason: `${customNodes} does not exist (is ${comfyuiBase} a ComfyUI install root?)`,
      };
    }
    entries = readdirSync(customNodes, { withFileTypes: true });
  } catch (err) {
    return {
      state: "unreadable",
      reason: `could not enumerate ${customNodes}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const wanted = packDirNameCandidates(id);
  for (const entry of entries) {
    if (!(entry.isDirectory() || entry.isSymbolicLink())) continue;
    if (entry.name.startsWith(".")) continue;
    const dirName = entry.name.toLowerCase().replace(/\.disabled$/, "");
    let pyprojectName: string | undefined;
    const pyproject = join(customNodes, entry.name, "pyproject.toml");
    try {
      if (existsSync(pyproject)) {
        pyprojectName = parsePyproject(readFileSync(pyproject, "utf-8"))
          .projectName?.trim()
          .toLowerCase();
      }
    } catch {
      // An unreadable/corrupt pyproject means THIS directory cannot vouch by
      // identity — it does not make the whole scan unreadable.
    }
    if (wanted.has(dirName) || (pyprojectName !== undefined && wanted.has(pyprojectName))) {
      return { state: "found", dir: join(customNodes, entry.name) };
    }
  }
  return { state: "not-found", scanned: customNodes };
}

export type PackPresence =
  | { state: "manager-listed"; node?: InstalledNode }
  /**
   * On disk, and a READABLE Manager list does not track it (registry zip /
   * manual copy). When the list could not be read (managerListReadable false)
   * the tracking claim is unknown — callers must not assert "Manager does not
   * track it" or that a queued op resolved to nothing.
   */
  | { state: "on-disk"; dir: string; managerListReadable: boolean; listError?: string }
  /** Every source that could be consulted agrees the pack is not there. */
  | { state: "absent"; evidence: "manager-only" | "manager+disk"; scanned?: string }
  /** No consulted source could answer — never reported as absence. */
  | { state: "unverifiable"; reason: string };

/**
 * The disk half of a presence answer, captured at OPERATION ENTRY. Every
 * presence check of one logical operation (pre-resolve, post-verify) must use
 * the SAME context: computing it later from mutable global mode/config lets a
 * mid-op retarget pair Manager A's answer with disk B (or no disk at all) —
 * false "present on disk", false absence, false REMOVED (codex gate round 11).
 */
export interface PackPresenceContext {
  /** The remote/local classification at entry. */
  remote: boolean;
  /** The local root captured at entry (undefined when remote or none exists). */
  diskRoot?: string;
}

/** Capture the presence context for one operation, before its first await. */
export function capturePackPresenceContext(diskRoot?: string): PackPresenceContext {
  const remote = isRemoteMode();
  return {
    remote,
    diskRoot: remote ? undefined : (diskRoot ?? resolveEffectiveComfyUIBase()),
  };
}

/**
 * Answer "is this pack present?" across BOTH sources of truth, keeping
 * "could not determine" distinct from "determined absent" (#797, #796's
 * defect class):
 *   1. ComfyUI-Manager's installed list (works remotely, covers tracked packs);
 *   2. the on-disk custom_nodes scan — LOCAL sessions only. In remote mode the
 *      disk we could read is not the server's, so it is never consulted.
 * The Manager list matching always wins; disk evidence is what keeps a
 * Manager-untracked zip install from reading as "not installed".
 *
 * `ctx` is the operation's entry-captured context (capturePackPresenceContext).
 * When omitted it is captured here — still before this call's first await, so
 * single-shot callers stay correct.
 */
export async function resolvePackPresence(
  id: string,
  base: string,
  ctx?: PackPresenceContext,
): Promise<PackPresence> {
  const context = ctx ?? capturePackPresenceContext();
  const diskBase = context.remote ? undefined : context.diskRoot;

  let installed: InstalledNode[] | undefined;
  let listError: string | undefined;
  try {
    installed = await listInstalledNodesAt(base);
  } catch (err) {
    listError = err instanceof Error ? err.message : String(err);
  }
  if (installed) {
    const node = findInstalledNode(id, installed);
    if (node) return { state: "manager-listed", node };
  }

  const disk = diskBase ? findPackOnDisk(id, diskBase) : undefined;
  if (disk?.state === "found") {
    return {
      state: "on-disk",
      dir: disk.dir,
      managerListReadable: installed !== undefined,
      listError,
    };
  }

  if (!installed) {
    // The Manager list could not be read — "absent" is off the table no matter
    // what the disk says: a pack Manager tracks but the disk missed (an
    // adopted/extra-paths root) would be falsely condemned.
    const diskNote =
      disk?.state === "not-found"
        ? ` The disk check found no matching pack under ${disk.scanned} either, but with the Manager list unreadable that still does not prove absence.`
        : disk?.state === "unreadable"
          ? ` The disk check was inconclusive too (${disk.reason}).`
          : " No local disk check was possible in this session.";
    return {
      state: "unverifiable",
      reason:
        `ComfyUI-Manager's installed-pack list could not be read (${listError}).` + diskNote,
    };
  }
  if (disk?.state === "not-found") {
    return { state: "absent", evidence: "manager+disk", scanned: disk.scanned };
  }
  if (disk?.state === "unreadable") {
    return {
      state: "unverifiable",
      reason:
        `"${id}" is not in ComfyUI-Manager's installed-pack list, and the on-disk ` +
        `check could not answer (${disk.reason}).`,
    };
  }
  // Remote session: only the Manager list could be consulted at all.
  return { state: "absent", evidence: "manager-only" };
}

/**
 * Resolve the ComfyUI venv python for installing a cloned node's deps. Prefers
 * the install's own `.venv` (Windows Scripts/ or POSIX bin/), falling back to a
 * bare "python" on PATH. `basePath` is the CALL-SCOPED install root (apply_manifest
 * threads an adopted saved-default/live root without mutating global config); when
 * omitted it falls back to config.comfyuiPath. Passing it matters: otherwise a
 * cloned node's requirements.txt / install.py would run under a BARE system python
 * for an adopted workspace, corrupting/ missing the real ComfyUI environment while
 * the node is still reported installed (#463 codex review).
 */
async function resolveVenvPython(basePath?: string) {
  return resolveInstallInterpreter(basePath ?? config.comfyuiPath);
}

/**
 * Validate a git URL before it is handed to `git clone` as an argument.
 * Rejects an arg-injection vector (a URL parsed as a git option) and anything
 * that isn't a recognized git URL shape.
 */
function assertSafeGitUrl(gitId: string): void {
  if (gitId.startsWith("-")) {
    throw new ValidationError(
      `Refusing to clone git URL "${gitId}": it starts with '-' and would be ` +
        `interpreted as a git option.`,
    );
  }
  if (/[\x00-\x1F\x7F]/.test(gitId)) {
    throw new ValidationError("Git URL cannot contain ASCII control characters.");
  }
  if (!looksLikeGitUrl(gitId)) {
    throw new ValidationError(
      `Refusing to clone "${gitId}": not a recognized git URL (expected ` +
        `https://, ssh://, git@…, git+…, or a .git URL).`,
    );
  }
}

/**
 * Validate the repo name derived from a git URL before it is used as a
 * filesystem path segment under custom_nodes. Rejects empty, '.'/'..', names
 * starting with '-', and names containing path separators or control chars —
 * any of which could escape custom_nodes or be parsed as a git option.
 */
export function assertSafeRepoName(repoName: string): void {
  if (
    repoName.length === 0 ||
    repoName === "." ||
    repoName === ".." ||
    repoName.startsWith("-") ||
    /[/\\]/.test(repoName) ||
    /[\x00-\x1F\x7F]/.test(repoName)
  ) {
    throw new ValidationError(
      `Refusing to use "${repoName}" as a custom_nodes directory name (empty, ` +
        `'.'/'..', starts with '-', or contains a path separator/control char).`,
    );
  }
}

/**
 * Direct-clone fallback for an unregistered git repo the Manager can't resolve.
 * Clones into custom_nodes/<repoName>, checks out a ref if given, then makes a
 * best-effort attempt at installing python deps (requirements.txt + install.py).
 * Dep failures DON'T fail the install (clone succeeded) — they're surfaced as
 * warnings. A clone failure throws NodeManagementError.
 */
/**
 * Does this directory hold something ComfyUI could actually load?
 *
 * A clone that git created and then abandoned leaves a directory containing only
 * `.git`. ComfyUI loads DIRECTORIES, so it will try to import that on every
 * start and fail — forever, silently, long after whoever ran the install has
 * forgotten about it (#900). "The directory exists" was never the question.
 */
function looksLikeAPack(dir: string): boolean {
  try {
    return readdirSync(dir).some((entry) => entry !== ".git");
  } catch {
    // Unreadable is not a finding either way; let the caller's other checks
    // speak rather than condemning a pack we could not look at.
    return true;
  }
}

/**
 * Remove a clone directory THIS call created, after the clone failed.
 *
 * Returns a sentence to append to the error — a leftover nobody was told about
 * is how the husk in #900 survived a month.
 *
 * `alreadyPresent` is a PRECONDITION, not live logic: every call site today sits
 * inside `if (!alreadyPresent)`, so it is always false here and the guard below
 * cannot fire. It is kept, and named, because the rule it encodes is the one that
 * would do real damage if a later caller broke it — an existing pack is the
 * user's, and a failed operation must never take it away. Being explicit about
 * its unreachability is deliberate: an unreachable check that reads like live
 * protection is worse than one that says what it is.
 */
function discardFailedClone(nodeDir: string, alreadyPresent: boolean): string {
  if (alreadyPresent) return ""; // precondition — see above; unreachable today
  if (!existsSync(nodeDir)) return ""; // git cleaned up after itself
  try {
    rmSync(nodeDir, { recursive: true, force: true });
    return "";
  } catch (rmErr) {
    return (
      ` NOTE: the partial clone at ${nodeDir} could NOT be removed ` +
      `(${rmErr instanceof Error ? rmErr.message : String(rmErr)}). ComfyUI will try to ` +
      `import it on every start and log an error — delete that directory by hand.`
    );
  }
}

/**
 * Did ComfyUI-Manager REFUSE the enqueue outright, before queueing anything? (#1129)
 *
 * A git-URL install is gated server-side by `security_level` and
 * `allow_git_url_install`, and a legacy 3.x host that does not serve the route at
 * all answers the same way. All three arrive as a status on the POST itself:
 *
 *   403 — "A security error has occurred" (the policy gate)
 *   404 — the route is not registered on this build
 *
 * 405 is deliberately NOT here. On this API it is the DIALECT-MISMATCH signal
 * (ComfyUI's frontend catchall answering a route registered under the other
 * generation), and the self-heal retry in #646 already owns it — diverting to a
 * clone would pre-empt a Manager install that is about to succeed on the right
 * route.
 *
 * What matters is not which one, but that the response describes the REQUEST
 * rather than a task: nothing was queued, so nothing is running, so a direct
 * clone afterwards cannot race a Manager install writing to the same directory.
 * That is the whole warrant for continuing — and it is why 5xx is excluded, where
 * a task may well have been accepted before the handler fell over.
 *
 * Returns the status, or undefined when the failure is anything else (a transport
 * error, a timeout, a 500) and must keep propagating.
 */
function managerEnqueueRefusal(err: unknown): number | undefined {
  if (!(err instanceof NodeManagementError)) return undefined;
  const status = (err.details as { status?: unknown } | undefined)?.status;
  if (typeof status !== "number") return undefined;
  return status === 403 || status === 404 ? status : undefined;
}

async function cloneCustomNodeFallback(
  gitId: string,
  repoName: string,
  gitRef: string | undefined,
  managerStatus: unknown,
  basePath?: string,
  /**
   * #1129 — why we are here, when it was NOT "the pack is unregistered". The
   * refusal messages below name that reason by default, and stating it for a
   * policy refusal would be a wrong explanation for a correct action; the caller
   * that knows better passes its own.
   */
  opts?: { managerRefusalNote?: string },
): Promise<NodeOpResult> {
  const because =
    opts?.managerRefusalNote ?? `"${repoName}" is not in the ComfyUI-Manager registry`;
  // basePath is the CALL-SCOPED local ComfyUI root (apply_manifest threads an
  // adopted saved-default/live root here WITHOUT mutating global config, so a
  // panel-connected local session with no COMFYUI_PATH can still clone an
  // unregistered git pack); fall back to config.comfyuiPath.
  const comfyuiBase = basePath ?? config.comfyuiPath;
  // Same hazard as the CLI paths (codex gate P0): the guard below catches "no
  // path", but the dangerous case is HAVING one while connected elsewhere. A
  // clone into a stale local tree would report a successful install of a pack the
  // connected server will never see.
  if (isRemoteMode()) {
    throw new ProcessControlError(
      `${because}. Cloning it would write to a ` +
        `LOCAL install` +
        (comfyuiBase ? ` (${comfyuiBase})` : "") +
        ` — but this session targets a REMOTE ComfyUI (--comfyui-url), so that is not the ` +
        `server you are connected to. Nothing was cloned. Install it on the ComfyUI host, or ` +
        `pass a registered pack id the Manager can resolve there.`,
    );
  }
  if (!comfyuiBase) {
    throw new ProcessControlError(
      `${because}, and cloning it ` +
        `requires a local ComfyUI install, but no ComfyUI path is set. ` +
        `Install it on the ComfyUI host, or pass a registered pack id.`,
    );
  }

  // SECURITY: validate before either value becomes a `git clone` arg or a path
  // segment. gitId is checked for option-injection; repoName for path traversal.
  assertSafeGitUrl(gitId);
  assertSafeRepoName(repoName);

  // Resolve the target and ASSERT it stays inside <comfyuiBase>/custom_nodes,
  // mirroring manifest.ts's isWithinRoot containment check (defense in depth on
  // top of the repoName validation above).
  const customNodesRoot = resolve(comfyuiBase, "custom_nodes");
  const nodeDir = resolve(customNodesRoot, repoName);
  const rel = relative(customNodesRoot, nodeDir);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ValidationError(
      `Refusing to clone: resolved path "${nodeDir}" escapes ${customNodesRoot}.`,
    );
  }

  const warnings: string[] = [];
  const alreadyPresent = existsSync(nodeDir);

  if (!alreadyPresent) {
    // A concrete ref needs the full history reachable; otherwise shallow-clone.
    // `--end-of-options` ensures gitId/nodeDir are never parsed as git options.
    const cloneArgs = gitRef
      ? ["clone", "--end-of-options", gitId, nodeDir]
      : ["clone", "--depth", "1", "--end-of-options", gitId, nodeDir];
    logger.info("Cloning unregistered custom node", { gitId, nodeDir, gitRef });
    try {
      execFileSync("git", cloneArgs, {
        cwd: comfyuiBase,
        encoding: "utf-8",
        timeout: GIT_CLONE_TIMEOUT,
        env: nonInteractiveGitEnv(),
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stdout?: Buffer | string;
        stderr?: Buffer | string;
      };
      const leftover = discardFailedClone(nodeDir, alreadyPresent);
      throw new NodeManagementError(
        `Failed to clone "${gitId}" into custom_nodes/${repoName}: ${e.message}${leftover}`,
        {
          stdout: e.stdout ? e.stdout.toString() : "",
          stderr: e.stderr ? e.stderr.toString() : "",
        },
      );
    }
    if (gitRef) {
      // The checkout is part of producing the pack, so its failure leaves the
      // same husk as a failed clone — and the clone directory is ours either way.
      try {
        runGitCheckout(gitId, gitRef, comfyuiBase);
      } catch (err) {
        const leftover = discardFailedClone(nodeDir, alreadyPresent);
        throw new NodeManagementError(
          `Cloned "${gitId}" but could not check out "${gitRef}": ` +
            `${err instanceof Error ? err.message : String(err)}${leftover}`,
        );
      }
    }
  }

  // VERIFY the clone produced a PACK, not merely a directory (#900).
  //
  // `existsSync(nodeDir)` passed for a directory containing nothing but `.git` —
  // which is exactly what a clone killed by the timeout leaves behind. One such
  // husk sat in a user's custom_nodes for over a month, and ComfyUI logged an
  // import failure for it on EVERY boot, because ComfyUI loads directories and
  // does not care what we think we installed.
  //
  // Worse than useless: to any later reader — including our own disk-presence
  // checks — it is indistinguishable from a pack the user installed on purpose
  // that is now broken.
  if (!existsSync(nodeDir)) {
    throw new NodeManagementError(
      `Clone of "${gitId}" reported success but ${nodeDir} is missing.`,
    );
  }
  if (!alreadyPresent && !looksLikeAPack(nodeDir)) {
    const leftover = discardFailedClone(nodeDir, alreadyPresent);
    throw new NodeManagementError(
      `Clone of "${gitId}" reported success but produced no loadable pack in ` +
        `custom_nodes/${repoName} — the directory holds nothing but git metadata, which ` +
        `ComfyUI cannot import and would log an error for on every start.${leftover}`,
    );
  }

  // Best-effort python deps. Don't fail the install if these don't.
  const requirements = join(nodeDir, "requirements.txt");
  const installScript = join(nodeDir, "install.py");
  if (existsSync(requirements) || existsSync(installScript)) {
    const resolved = await resolveVenvPython(comfyuiBase);
    if (!resolved.python) {
      warnings.push(
        `Python dependencies were NOT installed. ${resolved.reason} Set COMFYUI_PYTHON to the interpreter ComfyUI runs with, or restart ComfyUI through this MCP server and retry.`,
      );
    } else if (existsSync(requirements)) {
      const python = resolved.python;
      try {
        execFileSync(python, ["-m", "pip", "install", "-r", requirements], {
          cwd: nodeDir,
          encoding: "utf-8",
          timeout: COMFY_CLI_TIMEOUT,
        });
      } catch (err) {
        const e = err as Error;
        warnings.push(
          `Python dependencies (requirements.txt) failed to install (${e.message}); install them manually with "${python} -m pip install -r requirements.txt".`,
        );
      }
    }
    if (resolved.python && existsSync(installScript)) {
      const python = resolved.python;
      try {
        execFileSync(python, [installScript], {
          cwd: nodeDir,
          encoding: "utf-8",
          timeout: COMFY_CLI_TIMEOUT,
        });
      } catch (err) {
        const e = err as Error;
        warnings.push(
          `install.py failed to run (${e.message}); the node may need manual setup.`,
        );
      }
    }
  }

  const base = alreadyPresent
    ? `"${repoName}" already exists in custom_nodes (${repoName}) — left it in place.`
    : `${because} — cloned it directly into custom_nodes (${repoName}).`;
  const warn = warnings.length ? ` ${warnings.join(" ")}` : "";
  return {
    mechanism: "git-clone",
    message: `${base}${warn} RESTART ComfyUI to load it.`,
    details: { nodeDir, warnings, managerStatus },
  };
}

// ---------------------------------------------------------------------------
// Public API — install
// ---------------------------------------------------------------------------

export interface InstallOptions {
  id: string;
  source?: InstallSource;
  version?: string;
  /** Git ref (commit, branch, or tag) to check out for git URL installs. */
  ref?: string;
  mode?: ManagerMode;
  channel?: string;
  /** Force the official comfy-cli subprocess instead of the HTTP API. */
  useCmCli?: boolean;
  /** CALL-SCOPED local ComfyUI root for the git-clone / ref-checkout fallback,
   *  threaded by callers (e.g. apply_manifest) that resolve an adopted
   *  saved-default/live root WITHOUT mutating global config.comfyuiPath. Falls
   *  back to config.comfyuiPath when omitted. */
  comfyuiPath?: string;
}

/**
 * Installing/updating/reinstalling/repairing a pack changes which node classes
 * this ComfyUI can register, so the orchestrator's memoized /object_info snapshot
 * (getObjectInfo) is now stale — create_workflow's validate and node_info
 * actions, and get_history (action:"diagnose"),
 * would keep reporting the just-installed types as `missing_node_type` in their
 * top-level summaries until some later reboot bumped the epoch (#444, the residual
 * of the #235/#247/#352/#364 staleness cluster). Drop the cache the moment a
 * mutation succeeds so the next read refetches the live registry. Applied via a
 * single choke point (rather than at every early return) so every install branch —
 * cm-cli, Manager HTTP, and the git clone fallback — is covered.
 */
async function withObjectInfoInvalidation<T>(op: () => Promise<T>): Promise<T> {
  const result = await op();
  resetObjectInfoCache();
  return result;
}

// NOTE on `async`: these wrappers are declared async purely so the PIN GUARD's
// throw surfaces as a REJECTED PROMISE rather than a synchronous exception.
// Callers rely on that — apply_manifest does `installCustomNode(...).then().catch()`
// and documents that it never rejects, which a sync throw would walk straight past.

export async function installCustomNode(opts: InstallOptions): Promise<NodeOpResult> {
  // PIN GUARD (see panel-pin-guard.ts). The panel is an ordinary node pack, so
  // these generic mutations are a second door into the same ComfyUI-Manager
  // operation that install_comfyui(action:'panel') drives. Guarding here — where the TARGET is
  // known — covers every caller, including a bulk "all". The check and the
  // mutation are atomic under the panel mutation lock (withPanelPinGuard).
  return withPanelPinGuard("install", opts.id, () =>
    withObjectInfoInvalidation(() => installCustomNodeImpl(opts)),
  );
}

/**
 * Why the comfy-cli subprocess path cannot run against `workspace`, or
 * undefined when it can. Probed BEFORE anything is submitted (#808): an
 * explicit useCmCli on a host without a usable CLI must fall back to Manager
 * HTTP, not die with NODE_MANAGEMENT_ERROR after the tool description promised
 * a fallback. `workspace` is the caller's captured local root — COMFYUI_PATH,
 * an adopted root, or the saved default workspace, which the CLI layer
 * supports natively (comfy-cli.ts defaultWorkspace).
 */
function comfyCliUnavailableReason(workspace: string | undefined): string | undefined {
  // REMOTE MODE FIRST (codex gate P0). comfy-cli runs against a LOCAL install,
  // while every check around these calls — the pre-state, the post-verify — talks
  // to the Manager on the REMOTE server. With a stale local COMFYUI_PATH the two
  // describe different machines: the CLI uninstalls or disables a pack here, the
  // verification reports on a pack over there, and the local destructive action is
  // never disclosed at all.
  //
  // `workspace` is non-empty in exactly that case, which is why this cannot be
  // folded into the check below: having a path is what makes it dangerous.
  if (isRemoteMode()) {
    return (
      "this session targets a REMOTE ComfyUI (--comfyui-url), and comfy-cli only acts on a " +
      "LOCAL install" +
      (workspace
        ? ` — running it would modify ${workspace}, which is NOT the server you are connected to`
        : "") +
      ". Run it on the machine the install lives on"
    );
  }
  if (!workspace) {
    return "no local ComfyUI install path is available (COMFYUI_PATH unset and no saved default workspace), which the comfy-cli subprocess needs";
  }
  const executable = resolveComfyCliExecutable({ workspace });
  if (!executable) {
    return "comfy-cli was not found on PATH or in the workspace's .venv (install comfy-cli>=1.11.1, set COMFY_CLI_PATH, or install it into the workspace venv)";
  }
  const version = getComfyCliVersion({ workspace });
  if (!isSupportedComfyCliVersion(version)) {
    return `comfy-cli >=1.11.1 is required; found ${version ?? "an unrecognized version"}`;
  }
  return undefined;
}

async function installCustomNodeImpl(
  opts: InstallOptions,
): Promise<NodeOpResult> {
  const { id, version, mode = "remote", channel = "default" } = opts;
  const parsedGit = parseGitUrl(id);
  const gitId = parsedGit.baseUrl;
  const gitRefCandidate = gitRefForInstall({
    ref: opts.ref,
    urlRef: parsedGit.ref,
    version,
  });
  const source =
    opts.source && opts.source !== "auto"
      ? opts.source
      : looksLikeGitUrl(gitId)
        ? "git"
        : "registry";
  const gitRef =
    source === "git" && gitRefCandidate
      ? validateGitRef(gitRefCandidate)
      : gitRefCandidate;

  // SECURITY: validate a git URL ONCE, up front, before it can reach ANY install
  // path — cm-cli (`cm-cli install <url>`), the Manager queue, or the clone
  // fallback. Rejects option-injection (leading "-") / non-git / control chars.
  // The repo-name + custom_nodes-containment checks live where the on-disk dir is
  // actually used (runGitCheckout, cloneCustomNodeFallback).
  if (source === "git") assertSafeGitUrl(gitId);

  // Keep the mutation, its post-queue verification, AND any local filesystem
  // work on the target selected for this invocation — captured NOW, before the
  // first await: a panel retarget in between must not split them across two
  // installs. cliWorkspace covers COMFYUI_PATH, an adopted root, and the saved
  // default workspace (the CLI layer supports all three); the CLI probe, the
  // ref checkout, and the clone fallback all take this ONE root, so a git
  // install with a ref can never install into the workspace and then fail the
  // checkout for want of a path (codex gate rounds 5-6).
  const managerBase = managerBaseUrl();
  const cliWorkspace = opts.comfyuiPath ?? resolveEffectiveComfyUIBase();
  const presenceCtx = capturePackPresenceContext(cliWorkspace);
  // THE PRE-STATE, OBSERVED BEFORE THE OPERATION (codex gate P0). The "already
  // installed" verdict below used to be inferred from POST-op disk state alone:
  // a pack that was absent before the call and installed as a registry ZIP —
  // which Manager does not track — creates a directory the post-check then reads
  // as "it was already there", telling the user nothing happened when their pack
  // had just been installed. A pre-state cannot be recovered afterwards; it has
  // to be taken now.
  const diskBefore = presenceCtx.diskRoot
    ? findPackOnDisk(id, presenceCtx.diskRoot)
    : undefined;

  // #808 — a requested comfy-cli that is not usable is a FALLBACK, not a fatal
  // error: the probe runs before anything is submitted, so dropping to Manager
  // HTTP cannot double-run anything, and the git path below keeps its own
  // direct-clone fallback for an unregistered repo. The note is prepended to
  // whichever result the HTTP path produces, so the mechanism switch is
  // disclosed rather than silent.
  let cliFallbackNote: string | undefined;
  if (opts.useCmCli) {
    const cliProblem = comfyCliUnavailableReason(cliWorkspace);
    if (cliProblem === undefined) {
      // cm-cli install accepts registry ids and git urls alike.
      const installId = source === "git" ? gitId : id;
      const out = runCmCli(["install", installId, "--mode", mode, "--channel", channel], cliWorkspace);
      if (source === "git" && gitRef) {
        runGitCheckout(gitId, gitRef, cliWorkspace);
      }
      return {
        mechanism: "comfy-cli",
        message: `Installed "${id}" via official comfy-cli.`,
        details: out.trim(),
      };
    }
    logger.info("comfy-cli requested (useCmCli) but unavailable — falling back to Manager HTTP", {
      reason: cliProblem,
    });
    cliFallbackNote =
      `comfy-cli was requested (useCmCli) but is not usable here: ${cliProblem}. ` +
      `NOTHING was run through comfy-cli — the install below used ComfyUI-Manager instead.`;
  }
  const withCliNote = (result: NodeOpResult): NodeOpResult =>
    cliFallbackNote
      ? { ...result, message: `${cliFallbackNote} ${result.message}` }
      : result;

  if (source === "git") {
    const repoName = gitCheckoutDir(gitId);
    // A git install's PARAMS are dialect-specific, not just its route, so they
    // are built per-attempt from the dialect actually being spoken. Precomputing
    // them from the cached dialect would let a self-heal retry (#646) resend
    // 3.x-shaped params to a v4 server (or the reverse) and install the wrong
    // thing — the retry has to rebuild the body, not just re-route it.
    // #1129 — A REFUSED ENQUEUE IS NOT THE END OF THE ROAD.
    //
    // The 3.x git-URL install is gated by security_level + allow_git_url_install,
    // and a host that does not serve the route answers the same way. Both come
    // back as a status on the POST, which throws — so the direct-clone fallback
    // twenty lines below, which needs no Manager at all and is exactly what the
    // user would do by hand, was unreachable in the one case it exists for. A
    // reporter on legacy 3.x got "ComfyUI-Manager not reachable", then a 404 with
    // "A security error has occurred", and was left with no install path on a
    // machine whose custom_nodes directory was sitting right there.
    //
    // Only a PRE-QUEUE refusal diverts (see managerEnqueueRefusal): the response
    // describes the request, so nothing is running and the clone cannot race a
    // Manager task writing to the same directory. Everything else rethrows.
    let refusedBy: number | undefined;
    const enqueue = async (): Promise<unknown> =>
      await queueManagerTask(
      "install",
      (api) =>
        api !== "v2"
        ? // 3.x SEMANTICS (both the custom-node Manager AND pip Manager in
          // legacy-UI mode, whose /v2 batch runs the same 3.x handlers — codex
          // review on #235): a REAL git URL installs natively via
          // { version:'unknown', files:[url] }, cloning it as an unregistered
          // pack. (Gated server-side by security_level + allow_git_url_install
          // config — a rejection surfaces as a 403/404 from the queue route.)
          {
            id: repoName,
            version: "unknown",
            selected_version: "unknown",
            files: [gitId],
            channel: opts.channel ?? "default",
            mode: opts.mode ?? "cache",
          }
        : // Manager v4: REGISTRY-FIRST, CLONE FALLBACK. The v4 backend resolves
          // an install by the pack's REPO NAME / CNR id — NOT a full git URL
          // (do_install splits `${id}@${selected_version}` and looks the result
          // up in its DB; a full URL matches nothing and the queue silently
          // marks the task "done"). So we mirror the frontend UI: id = repo
          // name, selected_version = ref or "nightly" (the git-HEAD channel for
          // unclaimed packs), channel "dev", mode "cache".
          {
            id: repoName,
            version: gitRef ?? "nightly",
            selected_version: gitRef ?? "nightly",
            channel: opts.channel ?? "dev",
            mode: opts.mode ?? "cache",
          },
      managerBase,
    );

    let status: unknown;
    try {
      status = await enqueue();
    } catch (err) {
      refusedBy = managerEnqueueRefusal(err);
      // A remote target keeps the original error: the clone would write to a
      // LOCAL tree that is not the server we are connected to, so "the Manager
      // refused" is the honest and complete answer there.
      if (refusedBy === undefined || isRemoteMode()) throw err;
      logger.info("Manager refused the git install enqueue — cloning directly", {
        status: refusedBy,
        gitId,
      });
      return withCliNote(
        await cloneCustomNodeFallback(gitId, repoName, gitRef, { manager_refused: refusedBy }, cliWorkspace, {
          managerRefusalNote:
            `ComfyUI-Manager REFUSED the git-URL install (HTTP ${refusedBy}) — on a legacy 3.x ` +
            `host that is its security_level / allow_git_url_install gate, or a build that does ` +
            `not serve the route. Nothing was queued there.`,
        }),
      );
    }

    // VERIFY: /v2/customnode/installed reflects on-disk custom_nodes, so a
    // freshly-cloned pack shows up even before a reboot. If the Manager actually
    // installed it, we're done; otherwise it's unregistered → clone it directly.
    const installed = await listInstalledNodesAt(managerBase).catch(
      () => [] as InstalledNode[],
    );
    if (nodeInstalledMatches(gitId, installed)) {
      return withCliNote({
        mechanism: "manager-http",
        message: `Installed "${repoName}" via ComfyUI-Manager. Restart may be required to load new nodes.`,
        details: status,
      });
    }
    return withCliNote(await cloneCustomNodeFallback(gitId, repoName, gitRef, status, cliWorkspace));
  }

  // Registry (plain CNR id). Keep the prior defaults channel "default" /
  // mode "remote" (overridable via opts) — forcing "dev"/"cache" risks resolving
  // a different build or failing for default-only packs. The UI-style
  // "dev"/"cache" is used ONLY for the git registry-first lookup above. Then
  // VERIFY the pack actually landed — a non-URL id can't be cloned, so an absent
  // pack is a hard error rather than a silent no-op.
  const status = await queueManagerTask("install", {
    id,
    version: version ?? "latest",
    selected_version: version ?? "latest",
    channel,
    mode,
  }, managerBase);
  // #797: verify across BOTH sources (Manager list + local disk) and keep
  // "could not determine" distinct from "determined absent" — an unreadable
  // Manager list collapsed to [] used to read as "not found in the registry".
  const presence = await resolvePackPresence(id, managerBase, presenceCtx);
  switch (presence.state) {
    case "manager-listed":
      return withCliNote({
        mechanism: "manager-http",
        message: `Installed "${id}" via ComfyUI-Manager. Restart may be required to load new nodes.`,
        details: status,
      });
    case "on-disk":
      if (!presence.managerListReadable) {
        // Present on disk, but the Manager list could not be read — claiming
        // "already installed, nothing new happened" would assert an outcome
        // nobody observed.
        return withCliNote({
          mechanism: "manager-http",
          message:
            `"${id}" is present on disk at ${presence.dir}. Whether the queued install ` +
            `changed anything could NOT be verified: ComfyUI-Manager's installed-pack ` +
            `list could not be read (${presence.listError}). NOT claiming a fresh install ` +
            `— check install_custom_node (action:"list").`,
          details: status,
        });
      }
      // The Manager install resolved to nothing and the pack IS on disk. WHICH of
      // those two stories it is depends entirely on the PRE-state, which is why
      // it is read here and not inferred.
      if (diskBefore?.state === "not-found") {
        // It was NOT there before and it is now: the install worked. Reporting
        // "already installed" here hid a successful install behind a no-op.
        // STATES THE OBSERVATION, NOT A CAUSE (codex gate P1). `diskBefore` is a
        // filesystem snapshot with nothing binding it to this operation, so under
        // two concurrent agents on one rig — which is in scope — the pack could
        // have been created by the OTHER agent between our pre-check and our
        // post-check. "It was absent before and is present now" is exactly what we
        // saw; "this call installed it" is an inference the evidence does not
        // support, and it is the same bucket-narrated-as-cause fold this cluster
        // is about. The user's next action (restart to load it) is identical
        // either way, so the weaker claim costs them nothing.
        return withCliNote({
          mechanism: "manager-http",
          message:
            `"${id}" is now present on disk at ${presence.dir}, and was NOT there before ` +
            `this call — so it was installed, though ComfyUI-Manager does not track it (a ` +
            `Comfy Registry zip install is not in its installed-pack list). If another agent ` +
            `is working on this ComfyUI, it may have been the one that installed it. Restart ` +
            `ComfyUI to load it.`,
          details: status,
        });
      }
      if (diskBefore?.state === "found") {
        return withCliNote({
          mechanism: "manager-http",
          message:
            `"${id}" is present on disk at ${presence.dir}, but ComfyUI-Manager does not ` +
            `track it (a Comfy Registry zip install or a manual copy), and it was ALREADY ` +
            `there before this call — so the queued registry install resolved to nothing ` +
            `new. Restart ComfyUI if it was just added.`,
          details: status,
        });
      }
      // No usable pre-state (no disk root, or the pre-check was unreadable). The
      // pack is on disk NOW; whether this call put it there is undetermined, and
      // saying either would be a guess dressed as a finding.
      return withCliNote({
        mechanism: "manager-http",
        message:
          `"${id}" is present on disk at ${presence.dir}, and ComfyUI-Manager does not ` +
          `track it (a Comfy Registry zip install or a manual copy). Whether THIS call ` +
          `installed it could not be determined — the pack's state before the call was ` +
          `${diskBefore?.state === "unreadable" ? `unreadable (${diskBefore.reason})` : "not observable in this session"}. ` +
          `Restart ComfyUI if it was just added.`,
        details: status,
      });
    case "absent":
      throw new NodeManagementError(
        presence.evidence === "manager+disk"
          ? `"${id}" was queued but is not present afterward — it is in neither the ` +
            `ComfyUI-Manager installed-pack list NOR on disk under ${presence.scanned}. ` +
            `It was not found in the ComfyUI-Manager registry. Check the pack id, or pass ` +
            `a git URL to clone it directly.`
          : `"${id}" was queued but is not present afterward — it was not found in the ` +
            `ComfyUI-Manager registry. Check the pack id, or pass a git URL to clone ` +
            `it directly.`,
        status,
      );
    case "unverifiable":
      throw new NodeManagementError(
        `"${id}" was queued, but whether it landed could NOT be verified: ${presence.reason} ` +
          `NOT reporting success on an unverified install. Check install_custom_node (action:"list"), ` +
          `then retry if it is genuinely absent.`,
        status,
      );
  }
}

/**
 * Post-op presence gate for update/reinstall (#730) — the same fail-closed
 * check install got in #232, reusing the same helpers (listInstalledNodesAt +
 * nodeInstalledMatches). A drained Manager queue proves NOTHING about whether
 * work happened: for an id that resolves nowhere the enqueue is a silent no-op
 * and the drain passes trivially (total_count 0 while done_count increments),
 * which is how update/reinstall reported "Queued + updated/reinstalled" for
 * packs that do not exist. So re-read the installed list afterward —
 * /customnode/installed reflects the on-disk custom_nodes — and require the
 * pack to resolve SOMEWHERE before claiming success.
 *
 * A pack that IS installed but not in the registry (git-cloned) still matches —
 * nodeInstalledMatches covers the module/auxId spellings — so that path is
 * unaffected; only an id that resolves NOWHERE fails.
 */
/**
 * Thrown by assertPackPresentAfterOp ONLY when absence was actually observed
 * (every consulted source agrees the pack is gone). An unverifiable post-state
 * throws a plain NodeManagementError instead, so a caller wrapping failures —
 * the reinstall path, which CAN truthfully say "left the pack REMOVED" for an
 * observed absence but not for an unreadable one — can tell them apart
 * (codex gate round 10).
 */
export class PackAbsentAfterOpError extends NodeManagementError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = "PackAbsentAfterOpError";
  }
}

async function assertPackPresentAfterOp(
  id: string,
  op: "update" | "reinstall",
  base: string,
  status: QueueStatus,
  ctx?: PackPresenceContext,
): Promise<void> {
  // #771 — SAY WHAT WE ACTUALLY CHECKED; #797 — CHECK THE DISK TOO. This gate
  // consults up to TWO sources: the Manager's installed list AND (in a local
  // session) the on-disk custom_nodes scan. The Manager list alone never sees a
  // Comfy Registry zip install or a manual copy, so a list-only miss is NOT
  // proof the pack "is not installed locally" — for the sidebar panel installed
  // as a zip, that assertion was flatly false while install_comfyui(action:'panel', panel_action:'status')
  // reported the same pack at a concrete directory and version.
  //
  // The three outcomes stay distinct (this fold is #796's recurring defect):
  // present (either source), absent (BOTH consulted sources agree), and
  // unverifiable (a source that could not answer — an unreadable list or an
  // unenumerable directory is never treated as absence).
  const presence = await resolvePackPresence(id, base, ctx);
  switch (presence.state) {
    case "manager-listed":
      return;
    case "on-disk":
      if (!presence.managerListReadable) {
        // The pack IS on disk, but Manager's list could not be read — so whether
        // Manager tracked it, and whether the queued op did anything, are both
        // UNKNOWN. Asserting "resolved to nothing" would be a guess.
        throw new NodeManagementError(
          `"${id}" was queued for ${op}. The pack IS present on disk at ${presence.dir}, ` +
            `but ComfyUI-Manager's installed-pack list could not be read (${presence.listError}), ` +
            `so whether the ${op} took effect could NOT be verified. NOT reporting success ` +
            `on an unverified ${op}. Check that ComfyUI-Manager is reachable, then retry.`,
          status,
        );
      }
      // The pack IS installed — the op still resolved to nothing, because
      // Manager can only update/reinstall packs IT tracks. Refuse, but with the
      // truth: where the pack is and why Manager could not touch it.
      throw new NodeManagementError(
        `"${id}" was queued for ${op}, which resolved to NOTHING: the pack is present ` +
          `on disk at ${presence.dir} but ComfyUI-Manager does not track it (a Comfy ` +
          `Registry zip install or a manual copy), and Manager can only ${op} packs in ` +
          `its own installed list. ` +
          `The pack was NOT ${op === "update" ? "updated" : "reinstalled"}. To move it, reinstall it from its ` +
          `registry id or repository URL (install_custom_node action:"install" / action:"reinstall"), ` +
          `or — when ${presence.dir} is a git checkout — pull it there directly.`,
        status,
      );
    case "absent":
      if (presence.evidence === "manager+disk") {
        throw new PackAbsentAfterOpError(
          `"${id}" was queued for ${op} but is not present afterward — it is in neither ` +
            `ComfyUI-Manager's installed-pack list NOR on disk under ${presence.scanned} — ` +
            `so the ${op} resolved to nothing. Check the pack id with install_custom_node (action:"list"), ` +
            `or find the right id with search_custom_nodes.`,
          status,
        );
      }
      // Remote session: only the Manager list could be consulted. Say exactly that.
      throw new PackAbsentAfterOpError(
        `"${id}" was queued for ${op} but is not present afterward in ` +
          `ComfyUI-Manager's installed-pack list, so the ${op} resolved to nothing. NOTE: this ` +
          `check reads ComfyUI-Manager's registry/installed list ONLY — it does not ` +
          `inspect custom_nodes, so a pack that IS on disk but unknown to the Manager ` +
          `(a Comfy Registry zip install, or a manual copy) reaches here too. Check ` +
          `the pack id with install_custom_node (action:"list"), and for the sidebar panel use ` +
          `install_comfyui(action:'panel', panel_action:'status'), which reads the directory itself.`,
        status,
      );
    case "unverifiable":
      throw new NodeManagementError(
        `"${id}" was queued for ${op}, but whether it landed could NOT be verified: ` +
          `${presence.reason} NOT reporting success on an unverified ${op}. Check that ` +
          `ComfyUI-Manager is reachable on the host, then retry.`,
        status,
      );
  }
}

/**
 * Pre-op resolution for update/reinstall (#730's gate moved BEFORE the queue,
 * codex gate round 8): the queued task must name the pack's MANAGER module
 * name — a caller's registry id can differ from it ("comfyui-impact-pack" vs
 * "ComfyUI-Impact-Pack"), and the legacy routes resolve by module, so an
 * update enqueued under the registry id no-ops while the post-check still
 * matches the pre-existing record by cnr_id and reports "updated". Resolving
 * first also means a target that resolves nowhere is refused with NOTHING
 * queued rather than after a meaningless queue cycle. Returns the tracked
 * entry; throws the truthful refusal otherwise.
 */
async function resolveTrackedForOp(
  id: string,
  op: "update" | "reinstall",
  base: string,
  ctx?: PackPresenceContext,
): Promise<InstalledNode> {
  const presence = await resolvePackPresence(id, base, ctx);
  switch (presence.state) {
    case "manager-listed":
      return presence.node as InstalledNode;
    case "on-disk":
      throw new NodeManagementError(
        presence.managerListReadable
          ? `"${id}" is present on disk at ${presence.dir} but ComfyUI-Manager does not ` +
            `track it (a Comfy Registry zip install or a manual copy), so Manager cannot ` +
            `${op} it and NOTHING was queued. To move it, reinstall it from its registry id ` +
            `or repository URL (install_custom_node action:"install" / action:"reinstall"), or — when ` +
            `${presence.dir} is a git checkout — pull it there directly.`
          : `"${id}" is present on disk at ${presence.dir}, but ComfyUI-Manager's ` +
            `installed-pack list could not be read (${presence.listError}), so whether ` +
            `Manager can ${op} it could NOT be determined and NOTHING was queued. Check ` +
            `that ComfyUI-Manager is reachable, then retry.`,
      );
    case "absent":
      throw new NodeManagementError(
        presence.evidence === "manager+disk"
          ? `"${id}" is not installed — it is in neither ComfyUI-Manager's installed-pack ` +
            `list NOR on disk under ${presence.scanned} — so there is nothing to ${op} ` +
            `and NOTHING was queued. Check the pack id with install_custom_node (action:"list"), or find ` +
            `the right id with search_custom_nodes.`
          : `"${id}" is not in ComfyUI-Manager's installed-pack list, so there is nothing ` +
            `to ${op} and NOTHING was queued. NOTE: this check reads the Manager list only ` +
            `(remote session — no disk check possible). Check the pack id with ` +
            `install_custom_node (action:"list").`,
      );
    case "unverifiable":
      throw new NodeManagementError(
        `Whether "${id}" is installed could not be determined (${presence.reason}), so ` +
          `the ${op} was NOT queued — a ${op} queued blind would drain silently whether ` +
          `or not it did anything. Check that ComfyUI-Manager is reachable, then retry.`,
      );
  }
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

export interface UpdateOptions {
  /** Registry id / module name, or "all" to update every installed pack. */
  id: string;
  mode?: ManagerMode;
  channel?: string;
  useCmCli?: boolean;
}

/** Does this update target refer to ComfyUI-Manager itself (any spelling)? */
function isManagerSelfTarget(id: string): boolean {
  const norm = basename(id.trim().toLowerCase()).replace(/[_\s]+/g, "-");
  return norm === "comfyui-manager" || norm === "comfy-manager";
}

/**
 * Actionable terminal error for a Manager build that does not register its own
 * self-update route. This is the ONLY outcome of that case — see updateManagerSelf
 * for why there is deliberately no local-git fallback.
 */
function managerSelfUpdateUnsupported(api: ManagerApi, cause?: unknown): NodeManagementError {
  const dialect =
    api === "legacy"
      ? "the LEGACY ComfyUI-Manager 3.x queue API"
      : api === "v2-batch"
        ? "this Manager's legacy-UI (3.x-under-/v2) queue API"
        : "this Manager's queue API";
  return new NodeManagementError(
    `Updating ComfyUI-Manager ITSELF is not supported by ${dialect} on this build — ` +
      `its self-update route answered HTTP 405, i.e. the route is not registered. ` +
      `NOTHING WAS UPDATED. Update ComfyUI-Manager on the ComfyUI HOST instead — for a ` +
      `custom_nodes checkout: \`git -C custom_nodes/ComfyUI-Manager pull\`; for the pip ` +
      `package: \`pip install -U comfyui_manager\` — then restart ComfyUI. ` +
      `(comfyui-mcp will not git-pull a checkout on ITS OWN machine for you here: it cannot ` +
      `prove that checkout is the one the connected server actually loaded — a loopback URL ` +
      `can be a container or an SSH port-forward — and pulling the wrong copy would report a ` +
      `fix that never reached your ComfyUI.) ` +
      `See https://comfyui-mcp.artokun.io/docs/troubleshooting`,
    cause instanceof NodeManagementError ? cause.details : undefined,
  );
}

/**
 * Update ComfyUI-Manager ITSELF (#424).
 *
 * The released Manager 3.x DOES support this through its ordinary per-operation
 * route — POST /manager/queue/update with { id: "comfyui-manager", version } —
 * verified against ComfyUI-Manager 3.41 glob/manager_server.py + manager_core.py:
 * `unified_update` has NO comfyui-manager guard (unlike install/enable/disable/
 * uninstall, which explicitly refuse it), and /manager/queue/update_all itself
 * enqueues 'comfyui-manager' as an update task. The original #424 HTTP 405 came
 * from posting the v4-only unified envelope path (…/queue/task) at a 3.x server,
 * where an UNREGISTERED POST is answered 405 by ComfyUI's frontend catchall —
 * not from any per-pack refusal. So: route the self-update at the real endpoint
 * for the detected dialect first.
 *
 * When THAT route also answers 405 (genuinely unregistered on this build) the ONLY
 * outcome is the explicit "not supported here, update it on the host via X" error.
 *
 * There is deliberately NO local-git fallback. The previous implementation pulled
 * `config.comfyuiPath`'s custom_nodes/ComfyUI-Manager checkout, which is only ever
 * correct if that checkout is the one the CONNECTED server actually loaded — and
 * that cannot be established over HTTP. Successive review rounds killed one
 * wrong-target hole after another (remote host; --force-remote over a forwarded
 * loopback port; a second local instance on another port; finally a loopback
 * container or SSH forward whose reported install root string coincides with a
 * DIFFERENT host path — /system_stats argv reports a path in the SERVER's
 * filesystem namespace, which we cannot compare to ours). Each hole ends the same
 * way: git-pull a checkout the running Manager never loads, then report it as the
 * fix. shouldDispatchDownloadToManager (model-resolver.ts) hits the same wall and
 * settles for an existsSync probe only because ITS failure mode is a stray
 * directory; here it would be a fabricated success, which this issue exists to
 * eliminate. Refusing with the exact host-side command is always correct; guessing
 * is not. (The primary path above is the real #424 fix — released Manager 3.x
 * registers the route, so this branch is for builds that genuinely lack it.)
 */
async function updateManagerSelf(id: string): Promise<NodeOpResult> {
  // Keep this self-update on the ComfyUI instance selected at invocation. A
  // panel retarget during the dialect recheck must not update another instance.
  const base = managerBaseUrl();
  const api = await detectManagerApi(base);
  // ONLY the enqueue is inspected for the 405 signal. A 405 raised later, while
  // draining (e.g. `${prefix}/start`), says nothing about whether the update route
  // exists, so it must propagate as itself rather than be reported as "unsupported"
  // (codex review) — hence enqueue and drain are called separately here.
  //
  // The enqueue goes through the dialect self-heal (#646) first: a 405 can ALSO
  // mean we spoke a dialect the server no longer runs (a Manager upgrade + restart
  // at the same URL), and telling that user "your build doesn't support this" would
  // be flatly wrong. Only a 405 that survives a re-probe — the route really is
  // unregistered on the live dialect — reaches the unsupported verdict.
  let used: ManagerApi;
  // The verdict must name the dialect of the attempt that ACTUALLY 405'd — after a
  // re-probe that can differ from the dialect detected on entry, and the message is
  // dialect-specific ("the LEGACY 3.x queue API" vs the legacy-UI one).
  let lastTried = api;
  try {
    used = await enqueueWithDialectSelfHeal("update", (dialect, epoch) => {
      lastTried = dialect;
      return enqueueManagerTask(
        dialect,
        "update",
        () => ({ node_name: id }),
        randomUUID(),
        base,
        epoch,
      );
    }, base);
  } catch (err) {
    if (errorStatus(err) !== 405) throw err;
    // 405 = the update route is not registered on this build (#424).
    logger.debug("Manager self-update route 405 — reporting unsupported", { api: lastTried });
    throw managerSelfUpdateUnsupported(lastTried, err);
  }
  const status = await runManagerQueue(used, base);
  return {
    mechanism: "manager-http",
    message:
      `Queued ComfyUI-Manager's own update via ComfyUI-Manager (${id}) and the queue drained. ` +
      `Manager marks a task done even when the underlying git/registry update was a no-op or ` +
      `failed, and a Manager self-update only takes effect after a RESTART — restart ComfyUI, ` +
      `then confirm the Manager version actually changed.`,
    details: status,
  };
}

/**
 * ENQUEUE update-all on its dedicated route in the detected dialect, WITHOUT
 * draining the queue. Shared by updateCustomNode({id:"all"}) (which drains) and
 * the update-all tool's fire-and-forget path (queueUpdateAllCustomNodes), so
 * both inherit dialect selection, cache invalidation, and the 404/405-only
 * re-send discipline from enqueueWithDialectSelfHeal — a 400 re-detects but is
 * never re-sent, so update-all can never run twice (#656).
 *
 * Returns the dialect the enqueue ACTUALLY spoke (so the caller starts/polls
 * the queue holding the task), the route's raw response body, and the ui_id
 * of the attempt that LANDED (a self-heal retry mints a fresh one — only the
 * last one's tasks exist, so only it correlates with v4 queue history, #689).
 */
async function enqueueUpdateAll(
  mode: string,
  base: string,
): Promise<{ used: ManagerApi; response: unknown; uiId: string }> {
  let response: unknown;
  let uiId = "";
  const used = await enqueueWithDialectSelfHeal("update-all", async (api) => {
    // The v4 backend reads UpdateAllQueryParams from the QUERY STRING
    // (manager_server.py), NOT the JSON body — a body-only request leaves mode
    // defaulting to 'remote' and drops client_id/ui_id. Send them as URL query
    // params. A fresh ui_id per attempt keeps the two attempts distinguishable.
    const attemptUiId = randomUUID();
    if (api === "legacy") {
      // 3.x reads {mode} from the JSON BODY (and ignores client_id/ui_id).
      response = await managerFetch("/manager/queue/update_all", {
        method: "POST",
        body: { mode, ui_id: attemptUiId },
        base,
      });
    } else {
      const query = new URLSearchParams({
        mode,
        client_id: MANAGER_CLIENT_ID,
        ui_id: attemptUiId,
      }).toString();
      response = await managerFetch(`/v2/manager/queue/update_all?${query}`, {
        method: "POST",
        base,
      });
    }
    // Only reached when the enqueue did NOT throw — this attempt's id is the
    // one whose tasks are actually on the queue.
    uiId = attemptUiId;
  }, base);
  return { used, response, uiId };
}

export async function updateCustomNode(opts: UpdateOptions): Promise<NodeOpResult> {
  // PIN GUARD — covers id="comfyui-agent-panel", the repo-name and git-URL
  // spellings, and id="all" (a bulk update moves the panel too). The check and
  // the mutation are atomic under the panel mutation lock: update-all waits on
  // the Manager queue, and a pin written in that window must block the NEXT
  // op, not land inside this one (withPanelPinGuard).
  return withPanelPinGuard("update", opts.id, () =>
    withObjectInfoInvalidation(() => updateCustomNodeImpl(opts)),
  );
}

async function updateCustomNodeImpl(
  opts: UpdateOptions,
): Promise<NodeOpResult> {
  const { id, mode = "remote", channel = "default" } = opts;
  const all = id.trim().toLowerCase() === "all";

  if (opts.useCmCli) {
    const out = runCmCli(["update", id, "--mode", mode, "--channel", channel]);
    return {
      mechanism: "comfy-cli",
      message: all
        ? "Updated all installed node packs via official comfy-cli."
        : `Updated "${id}" via official comfy-cli.`,
      details: out.trim(),
    };
  }

  // Updating ComfyUI-Manager ITSELF is its own routing problem (#424): it has a
  // real endpoint on every dialect, but a build that doesn't register it answers
  // 405 (ComfyUI's catchall) and the in-panel 3.x→v4 upgrade path deadlocks.
  // updateManagerSelf routes at the right endpoint for the detected dialect, and
  // on a 405 there reports an explicit "not supported here, run X on the host".
  if (!all && isManagerSelfTarget(id)) return updateManagerSelf(id);

  let status: QueueStatus;
  // Freeze the target BEFORE the first await (queueManagerTask does the same):
  // a mid-op retarget must not split the enqueue and the post-op verification
  // across two servers. The base travels back on the result so callers (the
  // #724 panel fallback's dialect probe) verify against the SAME Manager.
  const base = managerBaseUrl();
  // Captured with the target, before any await: the pre-resolve AND the
  // post-drain gate must read the SAME disk context (codex gate round 11).
  const presenceCtx = capturePackPresenceContext();
  if (all) {
    // update-all keeps its own dedicated route (so it does NOT go through
    // queueManagerTask), but it is just as dialect-dependent — route it through
    // the same enqueue-only self-heal so a stale classification can't wedge it
    // either (#646). Enqueue here, drain once below.
    const { used } = await enqueueUpdateAll(mode, base);
    status = await runManagerQueue(used, base);
  } else {
    // Resolve the target BEFORE queueing (codex gate round 8): the update body
    // must name the pack's MANAGER module name — a caller's registry id can
    // differ from it, a legacy route resolves by module, and a no-op update
    // would still pass a post-check that matches by cnr_id. A target that
    // resolves nowhere is refused with NOTHING queued.
    const tracked = await resolveTrackedForOp(id, "update", base, presenceCtx);
    // Single-pack update → unified task; UpdatePackParams uses node_name/node_ver.
    status = await queueManagerTask("update", { node_name: tracked.module }, base);
    // VERIFY (#730): the drain passes trivially for an id Manager never
    // enqueued (total_count 0 — the "Queued + updated" lie in the issue).
    // Require the pack to resolve SOMEWHERE post-op before claiming success.
    await assertPackPresentAfterOp(id, "update", base, status, presenceCtx);
  }
  return {
    mechanism: "manager-http",
    message: all
      ? "Queued update-all with ComfyUI-Manager. Completion and the sidebar panel's on-disk version are not verified yet."
      : `Queued + updated "${id}" via ComfyUI-Manager.`,
    details: status,
    managerBase: base,
  };
}

/**
 * Result of the update-all tool's fire-and-forget path (queueUpdateAllCustomNodes).
 */
export interface QueueUpdateAllResult {
  /** The update-all route the enqueue actually used (dialect-dependent). */
  endpoint: string;
  /** Whether the queue worker was confirmed started. */
  queueStarted: boolean;
  /** Raw update-all response body, when the route produced one. */
  managerResponse?: unknown;
  /** The ComfyUI base the enqueue actually targeted (captured at invocation,
   *  so a later cancel can aim at the same server — #689). */
  base: string;
  /** The ui_id of the enqueue attempt that landed; v4 derives each per-pack
   *  task id as `${uiId}_${pack}`, so this correlates with queue history. */
  uiId: string;
}

/**
 * The update-all MCP tool's path (#656): enqueue update-all in the DETECTED
 * dialect and kick the queue worker, then return WITHOUT draining — the tool
 * reports "queued + started" and the updates run asynchronously (unlike
 * updateCustomNode({id:"all"}), which drains the queue). Routed through the
 * same detectManagerApi + enqueue-with-self-heal machinery as every other
 * Manager mutation, so it inherits dialect selection, cache invalidation, and
 * the no-double-execute discipline rather than assuming the legacy 3.x route.
 *
 * No object_info invalidation here: the queued updates only take effect after
 * a ComfyUI RESTART, and the restart lifecycle already drops that cache.
 */
export async function queueUpdateAllCustomNodes(): Promise<QueueUpdateAllResult> {
  // One pinned target for the whole operation — detection, the enqueue, any
  // self-heal retry, and the queue start all stay on the instance selected at
  // invocation, even if the panel retargets mid-call.
  const base = managerBaseUrl();
  const { used, response, uiId } = await enqueueUpdateAll("remote", base);
  const prefix = managerQueuePrefixFor(used);
  let queueStarted = true;
  try {
    await managerQueueControl(`${prefix}/start`, base);
  } catch (err) {
    // The update-all IS queued — a start failure must not fail the whole call;
    // report it so the user can kick the queue manually.
    queueStarted = false;
    logger.warn("Queued update-all but failed to start the queue worker", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return {
    endpoint: `${prefix}/update_all`,
    queueStarted,
    managerResponse: response,
    base,
    uiId,
  };
}

// ---------------------------------------------------------------------------
// reinstall
// ---------------------------------------------------------------------------

export interface ReinstallOptions {
  id: string;
  version?: string;
  mode?: ManagerMode;
  channel?: string;
  useCmCli?: boolean;
}

export async function reinstallCustomNode(opts: ReinstallOptions): Promise<NodeOpResult> {
  // PIN GUARD — same door as install/update, and check + mutation are likewise
  // atomic under the panel mutation lock (withPanelPinGuard).
  return withPanelPinGuard("reinstall", opts.id, () =>
    withObjectInfoInvalidation(() => reinstallCustomNodeImpl(opts)),
  );
}

async function reinstallCustomNodeImpl(
  opts: ReinstallOptions,
): Promise<NodeOpResult> {
  const { id, version, mode = "remote", channel = "default" } = opts;

  if (opts.useCmCli) {
    const out = runCmCli(["reinstall", id, "--mode", mode, "--channel", channel]);
    return {
      mechanism: "comfy-cli",
      message: `Reinstalled "${id}" via official comfy-cli.`,
      details: out.trim(),
    };
  }

  // The unified queue has no `reinstall` kind, so model it as uninstall + a
  // fresh install of the same target. Each is its own drained queue cycle, but
  // the TWO cycles are one logical operation and must share ONE pinned target:
  // captured once, up front, so a panel retarget after the uninstall drains
  // cannot send the install to a different ComfyUI — which would leave the
  // user's server uninstalled while reporting success for another.
  const base = managerBaseUrl();
  const presenceCtx = capturePackPresenceContext();
  // Resolve BEFORE the uninstall half (codex gate round 8): it must name the
  // Manager module name, and a nowhere-resolving id is refused with NOTHING
  // queued — previously both cycles no-op'd and the post-check could still
  // match a pre-existing record by cnr_id.
  const tracked = await resolveTrackedForOp(id, "reinstall", base, presenceCtx);
  await queueManagerTask("uninstall", { node_name: tracked.module }, base);
  // The install half must name an identity the registry can actually RESOLVE
  // (codex gate round 9): when the caller passed the module/folder spelling,
  // installing it back under that spelling resolves nowhere — the pack would
  // be removed and not restored. The tracked record's CNR id is the stable
  // identity; a git/aux pack without one keeps the caller's spelling (the v4
  // backend also resolves repo names), as before.
  const reinstallId = tracked.cnrId ?? id;
  const status = await queueManagerTask("install", {
    id: reinstallId,
    version: version ?? "latest",
    selected_version: version ?? "latest",
    channel,
    mode,
  }, base);
  // VERIFY (#730): same queue-drain trust hole as update — for an id that
  // resolves nowhere BOTH cycles no-op and both drains pass trivially. Require
  // the pack to be present afterward before claiming a reinstall. An OBSERVED
  // post-op absence gets the reinstall-specific truth (the uninstall half
  // already ran — the pack is REMOVED, not untouched); an UNVERIFIABLE
  // post-state keeps the gate's own "could not verify" message.
  try {
    await assertPackPresentAfterOp(id, "reinstall", base, status, presenceCtx);
  } catch (err) {
    // "Left the pack REMOVED" is only true when absence was OBSERVED — an
    // unverifiable post-state (unreadable list, inconclusive disk) establishes
    // neither removal nor a failed install, and keeps its own message
    // (codex gate round 10).
    if (err instanceof PackAbsentAfterOpError) {
      throw new NodeManagementError(
        `The reinstall of "${id}" left the pack REMOVED: the uninstall half drained, ` +
          `but the install half did not restore it. Install it again with ` +
          `install_custom_node ("${reinstallId}"). Underlying detail: ${err.message}`,
        err.details,
      );
    }
    throw err;
  }
  return {
    mechanism: "manager-http",
    message: `Queued + reinstalled "${id}" (uninstall + install) via ComfyUI-Manager. A restart may be required.`,
    details: status,
  };
}

// ---------------------------------------------------------------------------
// fix
// ---------------------------------------------------------------------------

export interface FixOptions {
  /** Registry id / module name, or "all". */
  id: string;
  mode?: ManagerMode;
  channel?: string;
  useCmCli?: boolean;
}

export async function fixCustomNode(opts: FixOptions): Promise<NodeOpResult> {
  // `fix` reinstalls the pack's dependencies and can pull the pack itself, and
  // it accepts "all" — same door, same guard, same lock (withPanelPinGuard).
  return withPanelPinGuard("fix", opts.id, () =>
    withObjectInfoInvalidation(() => fixCustomNodeImpl(opts)),
  );
}

async function fixCustomNodeImpl(opts: FixOptions): Promise<NodeOpResult> {
  const { id, mode = "remote", channel = "default" } = opts;
  const all = id.trim().toLowerCase() === "all";

  // The HTTP API has no "fix all"; cm-cli supports it. Route accordingly.
  if (opts.useCmCli || all) {
    const out = runCmCli(["fix", id, "--mode", mode, "--channel", channel]);
    return {
      mechanism: "comfy-cli",
      message: all
        ? "Repaired all installed node packs via official comfy-cli."
        : `Repaired "${id}" via official comfy-cli.`,
      details: out.trim(),
    };
  }

  // FixPackParams requires node_ver; "" lets Manager resolve the installed
  // version (do_fix looks the pack up by name).
  const status = await queueManagerTask("fix", { node_name: id, node_ver: "" });
  return {
    mechanism: "manager-http",
    message: `Queued + repaired "${id}" via ComfyUI-Manager.`,
    details: status,
  };
}

// ---------------------------------------------------------------------------
// disable / enable / uninstall (#775)
//
// The cleanup surface was install/update/reinstall/fix only — there was no
// reversible "take this pack out of the running install" action at all, so a
// safe cleanup audit meant hand-moving directories. Manager has native
// disable/enable/uninstall task kinds on every dialect (legacyTaskRequest maps
// them for 3.x); these wrap them with post-state verification against the
// installed list, because a drained queue is not proof the state changed.
// ---------------------------------------------------------------------------

export interface NodeStateOptions {
  /** Registry id / module name of an INSTALLED pack. */
  id: string;
  useCmCli?: boolean;
}

/**
 * The post-op verdict for disable/enable, read back from the Manager installed
 * list — shared by the HTTP path (after the queue drain) and the comfy-cli
 * path (after the CLI's own success report, which is a CLAIM, not an
 * observation). Three outcomes, reported as what they are: applied /
 * not-applied / could-not-verify (unreadable list, pack vanished from it, or
 * no enabled flag reported at all).
 */
type EnabledVerdict =
  | { state: "applied" }
  | { state: "not-applied"; reported: "enabled" | "disabled" }
  | { state: "inconclusive"; reason: string };

async function readEnabledVerdict(
  id: string,
  expectEnabled: boolean,
  base: string,
): Promise<EnabledVerdict> {
  let installed: InstalledNode[] | undefined;
  let listError: string | undefined;
  try {
    installed = await listInstalledNodesAt(base);
  } catch (err) {
    listError = err instanceof Error ? err.message : String(err);
  }
  if (!installed) {
    return {
      state: "inconclusive",
      reason: `ComfyUI-Manager's installed-pack list could not be read (${listError})`,
    };
  }
  const node = findInstalledNode(id, installed);
  if (!node) {
    return {
      state: "inconclusive",
      reason: `"${id}" no longer appears in ComfyUI-Manager's installed-pack list`,
    };
  }
  if (node.enabled === undefined) {
    return {
      state: "inconclusive",
      reason: `ComfyUI-Manager did not report an enabled/disabled flag for "${id}"`,
    };
  }
  if (node.enabled === !expectEnabled) {
    return { state: "not-applied", reported: node.enabled ? "enabled" : "disabled" };
  }
  return { state: "applied" };
}

async function setCustomNodeEnabled(
  opts: NodeStateOptions,
  enable: boolean,
): Promise<NodeOpResult> {
  const { id } = opts;
  const op = enable ? "enable" : "disable";
  const base = managerBaseUrl();
  // Pinned with the target: the CLI must run against the SAME local install
  // the pre/post checks describe, even if config.comfyuiPath is retargeted
  // during an await below (codex gate round 5).
  const cliWorkspace = resolveEffectiveComfyUIBase();
  const presenceCtx = capturePackPresenceContext(cliWorkspace);

  // CLI availability probe FIRST (#808 fallback discipline), but NO subprocess
  // runs yet: the presence pre-check below comes before either mechanism,
  // because a CLI run of an already-satisfied/no-such-pack request reports a
  // pre-existing state as a fresh transition exactly like a queued no-op.
  const cliProblem = opts.useCmCli ? comfyCliUnavailableReason(cliWorkspace) : undefined;
  const useCli = opts.useCmCli === true && cliProblem === undefined;
  let cliFallbackNote: string | undefined;
  if (opts.useCmCli && !useCli) {
    logger.info(`comfy-cli requested (useCmCli) but unavailable — falling back to Manager HTTP for ${op}`, {
      reason: cliProblem,
    });
    cliFallbackNote =
      `comfy-cli was requested (useCmCli) but is not usable here: ${cliProblem}. ` +
      `NOTHING was run through comfy-cli — ComfyUI-Manager was used for what follows instead.`;
  }

  // Pre-op validation: a disable/enable for an id Manager never heard of is a
  // silent no-op (queue or CLI alike), and the LEGACY dialects key the body on
  // the pack's REAL installed version (node-bisect's controller does the same
  // — "never send 'unknown' for an installed pack"). Both need the installed
  // list read up front.
  const presence = await resolvePackPresence(id, base, presenceCtx);
  if (
    presence.state === "on-disk" &&
    // A READABLE list that doesn't track the pack: refuse — neither mechanism
    // can verify the op through it. An UNREADABLE list with the pack on disk
    // only blocks the HTTP path; comfy-cli works on the local install directly,
    // so it proceeds below with the uncertainty disclosed.
    (presence.managerListReadable || !useCli)
  ) {
    throw new NodeManagementError(
      presence.managerListReadable
        ? `"${id}" is present on disk at ${presence.dir} but ComfyUI-Manager does not ` +
          `track it (a Comfy Registry zip install or a manual copy), so Manager cannot ` +
          `${op} it and NOTHING was queued. To ${op} it yourself, ${
            enable
              ? `remove any ".disabled" suffix from that directory's name`
              : `rename that directory with a ".disabled" suffix (Manager's own convention)`
          }, then restart ComfyUI.`
        : `"${id}" is present on disk at ${presence.dir}, but ComfyUI-Manager's ` +
          `installed-pack list could not be read (${presence.listError}), so whether ` +
          `Manager can ${op} it could NOT be determined and NOTHING was queued. Check ` +
          `that ComfyUI-Manager is reachable, then retry.`,
    );
  }
  if (presence.state === "absent") {
    throw new NodeManagementError(
      presence.evidence === "manager+disk"
        ? `"${id}" is not installed — it is in neither ComfyUI-Manager's installed-pack ` +
          `list NOR on disk under ${presence.scanned} — so there is nothing to ${op} ` +
          `and NOTHING was queued. Check the id with install_custom_node (action:"list").`
        : `"${id}" is not in ComfyUI-Manager's installed-pack list, so there is ` +
          `nothing to ${op} and NOTHING was queued. NOTE: this check reads the Manager ` +
          `list only (remote session — no disk check possible). Check the id with ` +
          `install_custom_node (action:"list").`,
    );
  }
  if (presence.state === "unverifiable" && !useCli) {
    // The HTTP path cannot validate or verify without the Manager list. The
    // comfy-cli path CAN still act (it works on the local install directly) —
    // it proceeds below, disclosing that the pre-state was never established.
    throw new NodeManagementError(
      `Whether "${id}" is installed could not be determined (${presence.reason}), so ` +
        `the ${op} was NOT queued — a ${op} queued blind would drain silently whether ` +
        `or not it did anything. Check that ComfyUI-Manager is reachable, then retry.`,
    );
  }

  // Already in the requested state: running anything would be a no-op whose
  // post-op read-back would "verify" a state that predates the call. Say so
  // and do nothing. (An UNREPORTED enabled flag is not this case: proceed and
  // let the post-op verdict be inconclusive if it stays unreported.)
  if (presence.state === "manager-listed" && presence.node?.enabled === enable) {
    return {
      mechanism: useCli ? "comfy-cli" : "manager-http",
      message:
        `"${id}" is already ${enable ? "enabled" : "disabled"} in ComfyUI-Manager's ` +
        `installed-pack list — NOTHING was run.` +
        (cliFallbackNote ? ` ${cliFallbackNote}` : ""),
    };
  }

  if (useCli) {
    const preStateReason =
      presence.state === "unverifiable"
        ? presence.reason
        : presence.state === "on-disk"
          ? `ComfyUI-Manager's installed-pack list could not be read (${presence.listError}); the pack is present on disk at ${presence.dir}`
          : undefined;
    const out = runCmCli([op, id], cliWorkspace);
    // comfy-cli's exit is its OWN claim — verify against the Manager list
    // when it can be read rather than reporting the claim as the state.
    const verdict = await readEnabledVerdict(id, enable, base);
    if (verdict.state === "not-applied") {
      return {
        mechanism: "comfy-cli",
        message:
          `comfy-cli reported the ${op} of "${id}" successful, but ComfyUI-Manager ` +
          `still reports the pack as ${verdict.reported} — the ${op} did NOT take ` +
          `effect. Check the ComfyUI server log for the underlying error.`,
        details: out.trim(),
      };
    }
    return {
      mechanism: "comfy-cli",
      message:
        (verdict.state === "applied"
          ? `${enable ? "Enabled" : "Disabled"} "${id}" via official comfy-cli ` +
            `(verified against ComfyUI-Manager's installed-pack list)`
          : `${enable ? "Enabled" : "Disabled"} "${id}" via official comfy-cli ` +
            `(comfy-cli's own report — the post-state could not be independently ` +
            `verified: ${verdict.reason})`) +
        (preStateReason
          ? `. NOTE: the pre-operation state was never established (${preStateReason}), so this is not a verified transition`
          : "") +
        `. A ComfyUI restart is required for the change to take effect.`,
      details: out.trim(),
    };
  }

  if (presence.state !== "manager-listed") {
    // Unreachable by construction (absent/on-disk threw; unverifiable without a
    // usable CLI threw; unverifiable WITH one returned inside the CLI branch) —
    // a guard, not a load-bearing check.
    throw new NodeManagementError(
      `Whether "${id}" is installed could not be determined, so the ${op} was NOT queued.`,
    );
  }
  const tracked = presence.node as InstalledNode;

  const status = await queueManagerTask(
    op,
    // The body is dialect-specific: v2 keys enable on cnr_id / disable on
    // node_name; the legacy 3.x bodies key on node_name + the REAL installed
    // version (legacyTaskRequest maps node_ver → version). node_name is the
    // MANAGER'S module/folder name (tracked.module), never the caller's id —
    // a registry id ("comfyui-impact-pack") and the module name
    // ("ComfyUI-Impact-Pack") can differ, and the 3.x routes resolve by module
    // (codex gate round 7).
    (api) =>
      api === "v2"
        ? enable
          ? { cnr_id: tracked.cnrId ?? id, node_name: tracked.module }
          : { node_name: tracked.module, is_unknown: false }
        : { node_name: tracked.module, node_ver: tracked.version ?? "unknown" },
    base,
  );
  const verdict = await readEnabledVerdict(id, enable, base);
  const result: NodeOpResult =
    verdict.state === "applied"
      ? {
          mechanism: "manager-http",
          message:
            `${enable ? "Enabled" : "Disabled"} "${id}" via ComfyUI-Manager (verified ` +
            `against its installed-pack list). A ComfyUI restart is required for the ` +
            `change to take effect.`,
          details: status,
        }
      : verdict.state === "not-applied"
        ? {
            mechanism: "manager-http",
            message:
              `The ${op} of "${id}" was queued and the queue drained, but ComfyUI-Manager ` +
              `still reports the pack as ${verdict.reported} — the ${op} did NOT take ` +
              `effect. Check the ComfyUI server log for the underlying error.`,
            details: status,
          }
        : {
            mechanism: "manager-http",
            message:
              `The ${op} of "${id}" was queued and the queue drained, but the result ` +
              `could NOT be verified: ${verdict.reason}. NOT claiming it took effect — ` +
              `check install_custom_node (action:"list").`,
            details: status,
          };
  return cliFallbackNote
    ? { ...result, message: `${cliFallbackNote} ${result.message}` }
    : result;
}

/**
 * Disable an installed pack WITHOUT removing it — the reversible cleanup step
 * (#775). Verified against the Manager installed list afterwards; a restart is
 * required for the change to take effect.
 */
export async function disableCustomNode(opts: NodeStateOptions): Promise<NodeOpResult> {
  // PIN GUARD — disabling the panel kills the agent's own UI; a pinned panel
  // must not be moved through this door either (withPanelPinGuard).
  return withPanelPinGuard("disable", opts.id, () =>
    withObjectInfoInvalidation(() => setCustomNodeEnabled(opts, false)),
  );
}

/** Re-enable a pack previously disabled with install_custom_node (action:"disable") (#775). */
export async function enableCustomNode(opts: NodeStateOptions): Promise<NodeOpResult> {
  return withPanelPinGuard("enable", opts.id, () =>
    withObjectInfoInvalidation(() => setCustomNodeEnabled(opts, true)),
  );
}

/**
 * Uninstall an installed pack (#775). Irreversible through this tool — prefer
 * disableCustomNode for a cleanup audit. The pack must be one ComfyUI-Manager
 * TRACKS: a pre-queue check refuses an id that resolves nowhere (nothing would
 * be uninstalled, and a drained queue would look exactly like success), naming
 * the on-disk directory when the pack is present but unmanaged so the caller
 * can remove it themselves. Post-op, the installed list is re-read and the
 * pack must be GONE before anything claims "uninstalled".
 */
export async function uninstallCustomNode(opts: NodeStateOptions): Promise<NodeOpResult> {
  // PIN GUARD — same door as install/update (withPanelPinGuard).
  return withPanelPinGuard("uninstall", opts.id, () =>
    withObjectInfoInvalidation(() => uninstallCustomNodeImpl(opts)),
  );
}

async function uninstallCustomNodeImpl(opts: NodeStateOptions): Promise<NodeOpResult> {
  const { id } = opts;
  const base = managerBaseUrl();
  // Pinned with the target, same as in setCustomNodeEnabled (codex gate round 5).
  const cliWorkspace = resolveEffectiveComfyUIBase();
  const presenceCtx = capturePackPresenceContext(cliWorkspace);

  // CLI availability probe FIRST (#808 fallback discipline) — but nothing runs
  // until the presence pre-check below has answered what there is to remove.
  const cliProblem = opts.useCmCli ? comfyCliUnavailableReason(cliWorkspace) : undefined;
  const useCli = opts.useCmCli === true && cliProblem === undefined;
  let cliFallbackNote: string | undefined;
  if (opts.useCmCli && !useCli) {
    logger.info("comfy-cli requested (useCmCli) but unavailable — falling back to Manager HTTP for uninstall", {
      reason: cliProblem,
    });
    cliFallbackNote =
      `comfy-cli was requested (useCmCli) but is not usable here: ${cliProblem}. ` +
      `NOTHING was run through comfy-cli — ComfyUI-Manager was used for what follows instead.`;
  }

  // Pre-op: an uninstall of an id that resolves nowhere is a silent no-op —
  // via Manager (drained queue) or comfy-cli (exit 0) alike — and reading
  // absence afterwards would "verify" a state that predated the call. Refuse
  // with the reason that is actually true.
  const presence = await resolvePackPresence(id, base, presenceCtx);
  if (
    presence.state === "on-disk" &&
    // A READABLE list that doesn't track the pack: refuse. An UNREADABLE list
    // with the pack on disk only blocks the HTTP path — comfy-cli works on the
    // local install directly, and its postcondition is verified on disk below.
    (presence.managerListReadable || !useCli)
  ) {
    throw new NodeManagementError(
      presence.managerListReadable
        ? `"${id}" is present on disk at ${presence.dir} but ComfyUI-Manager does not track ` +
          `it (a Comfy Registry zip install or a manual copy), so Manager cannot uninstall ` +
          `it and NOTHING was queued. To remove it, delete or move that directory yourself ` +
          `(moving it into a custom_nodes/.disabled folder keeps it reversible), then ` +
          `restart ComfyUI.`
        : `"${id}" is present on disk at ${presence.dir}, but ComfyUI-Manager's ` +
          `installed-pack list could not be read (${presence.listError}), so whether ` +
          `Manager can uninstall it could NOT be determined and NOTHING was queued. ` +
          `Check that ComfyUI-Manager is reachable, then retry.`,
    );
  }
  if (presence.state === "absent") {
    throw new NodeManagementError(
      presence.evidence === "manager+disk"
        ? `"${id}" is not installed — it is in neither ComfyUI-Manager's installed-pack ` +
          `list NOR on disk under ${presence.scanned} — so there is nothing to uninstall ` +
          `and NOTHING was queued. Check the id with install_custom_node (action:"list").`
        : `"${id}" is not in ComfyUI-Manager's installed-pack list, so there is nothing ` +
          `for Manager to uninstall and NOTHING was queued. NOTE: this check reads the ` +
          `Manager list only (remote session — no disk check possible); a pack present on ` +
          `disk but unknown to Manager must be removed on the ComfyUI host. Check the id ` +
          `with install_custom_node (action:"list").`,
    );
  }
  if (presence.state === "unverifiable" && !useCli) {
    // The HTTP path cannot validate or verify without the Manager list. The
    // comfy-cli path can still act on the local install — it proceeds below,
    // with the postcondition checked on disk instead.
    throw new NodeManagementError(
      `Whether "${id}" is installed could not be determined (${presence.reason}), so the ` +
        `uninstall was NOT queued — an uninstall queued blind would drain silently whether ` +
        `or not it did anything. Check that ComfyUI-Manager is reachable, then retry.`,
    );
  }

  if (useCli) {
    const out = runCmCli(["uninstall", id], cliWorkspace);
    // comfy-cli's exit is its OWN claim. "Uninstalled" requires BOTH an
    // observed pre-op presence (manager-listed, or on-disk) AND observed
    // post-op absence — absence alone may predate the call (codex gate rounds
    // 8-9). A pack still discoverable afterwards means the uninstall did NOT
    // take effect — disclose it.
    const preObserved =
      presence.state === "manager-listed" || presence.state === "on-disk";
    const preUnknownNote =
      presence.state === "unverifiable"
        ? `whether the pack was installed beforehand could NOT be established (${presence.reason})`
        : undefined;
    // The disk postcondition applies to EVERY CLI uninstall (a CLI session is
    // always a local one), and for a pack that was never Manager-tracked
    // (on-disk pre-state) it is the ONLY meaningful one. Checked against the
    // ENTRY-captured workspace, never a recomputed one: a retarget during the
    // awaits must not verify against a different install (codex gate round 6).
    const diskAfter = cliWorkspace ? findPackOnDisk(id, cliWorkspace) : undefined;
    if (diskAfter?.state === "found") {
      return {
        mechanism: "comfy-cli",
        message:
          `comfy-cli reported the uninstall of "${id}" successful, but the pack ` +
          `directory still exists at ${diskAfter.dir} — the uninstall did NOT take ` +
          `effect. Check the ComfyUI server log for the underlying error.`,
        details: out.trim(),
      };
    }

    let installed: InstalledNode[] | undefined;
    let listError: string | undefined;
    try {
      installed = await listInstalledNodesAt(base);
    } catch (err) {
      listError = err instanceof Error ? err.message : String(err);
    }
    if (installed && findInstalledNode(id, installed)) {
      return {
        mechanism: "comfy-cli",
        message:
          `comfy-cli reported the uninstall of "${id}" successful, but the pack is ` +
          `STILL in ComfyUI-Manager's installed-pack list — the uninstall did NOT ` +
          `take effect. Check the ComfyUI server log for the underlying error.`,
        details: out.trim(),
      };
    }
    const listGone = installed !== undefined; // readable AND not in it
    const diskGone = diskAfter?.state === "not-found";
    if (preObserved && (listGone || diskGone)) {
      const evidence: string[] = [];
      if (listGone) evidence.push("the pack is absent from ComfyUI-Manager's installed-pack list");
      if (diskGone) {
        evidence.push(
          `no matching directory remains under ${(diskAfter as { scanned: string }).scanned}`,
        );
      }
      return {
        mechanism: "comfy-cli",
        message:
          `Uninstalled "${id}" via official comfy-cli (verified: ${evidence.join(" and ")}). ` +
          `A ComfyUI restart is required to unload it fully.`,
        details: out.trim(),
      };
    }
    // Either the pre-state was never observed (absence may predate the call)
    // or nothing could be read post-op — disclose, never claim the removal.
    return {
      mechanism: "comfy-cli",
      message:
        `comfy-cli reported the uninstall of "${id}" successful, but the removal ` +
        `could NOT be verified: ` +
        (preUnknownNote ??
          `ComfyUI-Manager's installed-pack list could not be read (${listError})` +
            (diskAfter?.state === "unreadable"
              ? ` and the disk check was inconclusive (${diskAfter.reason})`
              : "")) +
        `. NOT claiming an uninstall happened; if the pack was never there, nothing ` +
        `needed removing — otherwise check install_custom_node (action:"list") / custom_nodes yourself.`,
      details: out.trim(),
    };
  }

  const withCliNote = (result: NodeOpResult): NodeOpResult =>
    cliFallbackNote
      ? { ...result, message: `${cliFallbackNote} ${result.message}` }
      : result;

  if (presence.state !== "manager-listed") {
    // Unreachable by construction (absent/on-disk threw; unverifiable without a
    // usable CLI threw; unverifiable WITH one returned inside the CLI branch) —
    // a guard, not a load-bearing check.
    throw new NodeManagementError(
      `Whether "${id}" is installed could not be determined, so the uninstall was NOT queued.`,
    );
  }
  const status = await queueManagerTask(
    "uninstall",
    // Legacy 3.x keys the body on node_name + the REAL installed version
    // (legacyTaskRequest maps node_ver → version); v2 needs only node_name.
    // node_name is the Manager's module name (presence.node.module), which can
    // differ from the caller's registry-id spelling (codex gate round 7).
    (api) =>
      api === "v2"
        ? { node_name: presence.node?.module ?? id }
        : {
            node_name: presence.node?.module ?? id,
            node_ver: presence.node?.version ?? "unknown",
          },
    base,
  );

  // Post-op: the pack must be GONE from the installed list. A drained queue is
  // not proof (#639); "still there" is disclosed, never reported as removed.
  let installed: InstalledNode[] | undefined;
  let listError: string | undefined;
  try {
    installed = await listInstalledNodesAt(base);
  } catch (err) {
    listError = err instanceof Error ? err.message : String(err);
  }
  if (!installed) {
    return withCliNote({
      mechanism: "manager-http",
      message:
        `The uninstall of "${id}" was queued and the queue drained, but the result could ` +
        `NOT be verified: ComfyUI-Manager's installed-pack list could not be read ` +
        `(${listError}). NOT claiming the pack was uninstalled — check install_custom_node (action:"list").`,
      details: status,
    });
  }
  if (findInstalledNode(id, installed)) {
    return withCliNote({
      mechanism: "manager-http",
      message:
        `The uninstall of "${id}" was queued and the queue drained, but the pack is STILL ` +
        `in ComfyUI-Manager's installed-pack list — the uninstall did NOT take effect. ` +
        `Check the ComfyUI server log for the underlying error.`,
      details: status,
    });
  }
  // MANAGER'S LIST IS NOT THE DISK (codex gate P0). A partial uninstall can drop
  // the tracking entry and leave `custom_nodes/<pack>` in place — and ComfyUI
  // loads directories, not Manager's bookkeeping, so the pack comes back on the
  // next restart while we have already called it uninstalled. A destructive
  // postcondition deserves the strongest evidence available, not the most
  // convenient, and this branch has the disk check the rest of this file uses.
  const diskAfter = presenceCtx.diskRoot ? findPackOnDisk(id, presenceCtx.diskRoot) : undefined;
  // `findPackOnDisk` accepts a matching SYMLINK without following it, so a
  // dangling link would be reported as a pack that survived the uninstall
  // (codex gate P2). ComfyUI cannot load a dead link, so calling that an
  // incomplete removal is a false alarm on a destructive operation — the one
  // place a spurious warning does real damage, because it sends the user to
  // delete something by hand. `existsSync` follows the link, which is exactly
  // the question: is there anything at the other end?
  const diskAfterReal = diskAfter?.state === "found" && existsSync(diskAfter.dir);
  if (diskAfterReal) {
    return withCliNote({
      mechanism: "manager-http",
      message:
        `The uninstall of "${id}" removed it from ComfyUI-Manager's installed-pack list, ` +
        `but the pack directory is STILL on disk at ${diskAfter.dir}. ComfyUI loads ` +
        `directories, not Manager's list, so it will load again on the next restart — ` +
        `this is NOT a completed uninstall. Remove the directory manually, or re-run the ` +
        `uninstall, and check the ComfyUI server log for the underlying error.`,
      details: status,
    });
  }
  const diskNote =
    diskAfter?.state === "found"
      ? ` and gone from disk (a dangling symlink remains at ${diskAfter.dir}, which ComfyUI ` +
        `cannot load — remove it at your leisure)`
      : diskAfter?.state === "not-found"
      ? " and gone from disk"
      : diskAfter?.state === "unreadable"
        ? `; the disk check was inconclusive (${diskAfter.reason}), so the directory may ` +
          `still be present`
        : "; no disk check was possible in this session";
  return withCliNote({
    mechanism: "manager-http",
    message:
      `Uninstalled "${id}" via ComfyUI-Manager (verified absent from its installed-pack ` +
      `list afterwards${diskNote}). A ComfyUI restart is required to unload it fully.`,
    details: status,
  });
}

// ---------------------------------------------------------------------------
// panel_install_node argument normalization (#789)
// ---------------------------------------------------------------------------

export interface GitUrlInstallArgs {
  id?: string;
  repository?: string;
  version?: string;
}

export interface NormalizedGitUrlInstallArgs extends GitUrlInstallArgs {
  /** Human-facing disclosure of any rewrite, for the tool result. */
  note?: string;
  /** Set when the call names two targets; the caller must REFUSE, not pick one. */
  conflict?: string;
}

/**
 * #789 — panel_search_nodes can return a REPOSITORY URL as a pack's `id` (the
 * Manager's legacy/repository-style entries). Feeding that URL back as `id`
 * with the default version "latest" asks the Manager to resolve
 * `<RepoName>@latest` as a REGISTRY install, which it rejects ("not available
 * node: ComfyUI-Impact-Pack@8.28.3") — while the same URL passed as
 * `repository` with version "nightly" installs fine. So when the effective
 * target is a git URL:
 *   - carry it as `repository` (the from-source install path), and
 *   - translate an absent or "latest" version to "nightly" (git HEAD — the only
 *     channel a from-source install can resolve).
 * An explicit non-"latest" version is the caller's own choice and passes
 * through untouched; the rewrite is always disclosed in `note`.
 *
 * `id` AND `repository` together name TWO targets (the schema presents them as
 * alternatives); that is a conflict to refuse, not a precedence to pick.
 */
/**
 * The route that still works when the Manager has no route at all (#789, recurrence).
 *
 * Rerouting a git URL to a from-source "nightly" install fixed the ORIGINAL report,
 * where the pack was registered and only the version spec was wrong. It cannot fix
 * the recurrence, because that pack is not in the registry:
 *
 *   Node 'ComfyUI-MiniMaxH3-FirstBlockCache@nightly' not found
 *     — ManagerChannel.dev, ManagerDatabaseSource.remote
 *
 * Manager v4's do_install resolves a pack by its registry ID, never by URL (the
 * 3.x `files:[url]` clone path does not exist there), so on a v4 host an
 * unregistered repository has NO Manager route by any spelling. The panel cannot
 * clone either — it is browser JS.
 *
 * `install_custom_node` can: it tries the Manager first and then clones the URL
 * directly into custom_nodes, verifying the result is a real pack. That is the
 * one tool that finishes this job, and the reporter had to find it by hand after
 * being left at "not found". Naming it here costs a sentence.
 *
 * Stated up front rather than on the failure: the failure text comes back from
 * the panel and matching on it would be brittle, and an agent that reads this
 * when the install is queued needs one fewer round trip than one that reads it
 * after the queue drains.
 */
function unregisteredPackEscapeHatch(): string {
  return (
    `If this comes back "not found" / "not available node", the pack is not in the ` +
    `Manager's registry at all — on Manager v4 that leaves NO Manager route for a ` +
    `repository URL, by any spelling. Use install_custom_node (source:"git") instead: ` +
    `it clones the URL directly into custom_nodes and verifies a real pack landed. ` +
    `Requires a LOCAL ComfyUI, since the clone writes to its filesystem.`
  );
}

export function normalizeGitUrlInstallArgs(
  args: GitUrlInstallArgs,
): NormalizedGitUrlInstallArgs {
  if (args.id && args.repository) {
    return {
      conflict:
        `panel_install_node was given BOTH id ("${args.id}") and repository ` +
        `("${args.repository}") — those are two different ways to name the target and ` +
        `they may not name the same pack. Pass exactly one: the registry id, or the ` +
        `git repository URL.`,
    };
  }
  const gitTarget =
    args.repository && looksLikeGitUrl(args.repository)
      ? args.repository
      : args.id && looksLikeGitUrl(args.id)
        ? args.id
        : undefined;
  if (!gitTarget) return {};
  const version = args.version?.trim();
  // The URL travels as `repository` ONLY: a URL that arrived as `id` is not
  // forwarded as both (routing off the id path is the whole point), and
  // id+repository together were refused above.
  const out: NormalizedGitUrlInstallArgs = { repository: gitTarget };
  // #1254 — the same sentinel test the git path uses, so "latest" cannot come to
  // mean one thing here and another there. This site already trimmed; the helper
  // trims too, which makes " Latest " behave like "latest" on both paths.
  if (version === undefined || version.length === 0 || isLatestSentinel(version)) {
    out.version = "nightly";
    out.note =
      `"${gitTarget}" is a git repository URL, so this was queued as a from-source ` +
      `install with version "nightly" (git HEAD): ComfyUI-Manager cannot resolve a ` +
      `registry "latest" for a repository-style entry and rejects it ("not available ` +
      `node: <repo>@<version>"). Pass an explicit version/ref to override. ` +
      unregisteredPackEscapeHatch();
  } else {
    out.version = args.version;
  }
  return out;
}

/**
 * The FINAL dispatch fields for the panel's `nodes_install` command, after
 * #789 normalization. Built here — not by `??`-merging with the raw args at
 * the call site — because a rerouted git URL must DROP `id`, and a
 * `norm.id ?? args.id` merge silently restores it (codex gate round 4).
 */
export function nodesInstallCommandArgs(args: {
  id?: string;
  repository?: string;
  version?: string;
  channel?: string;
  mode?: string;
}): {
  id?: string;
  repository?: string;
  version?: string;
  channel?: string;
  mode?: string;
  note?: string;
  conflict?: string;
} {
  const norm = normalizeGitUrlInstallArgs(args);
  if (norm.conflict) return { conflict: norm.conflict };
  const rerouted = norm.repository !== undefined;
  return {
    id: rerouted ? norm.id : args.id,
    repository: rerouted ? norm.repository : args.repository,
    version: rerouted ? norm.version : args.version,
    channel: args.channel,
    mode: args.mode,
    ...(norm.note ? { note: norm.note } : {}),
  };
}

// ---------------------------------------------------------------------------
// list installed
// ---------------------------------------------------------------------------

export interface ListInstalledOptions {
  mode?: "default" | "imported";
  useCmCli?: boolean;
}

async function listInstalledNodesAt(
  base: string,
  opts: ListInstalledOptions = {},
): Promise<InstalledNode[]> {
  const { mode = "default" } = opts;

  if (opts.useCmCli) {
    // cm-cli `show installed` prints a formatted table — return raw lines as
    // pseudo-nodes since structured data is HTTP-only. `enabled` is left
    // undefined: the table does not report it, so claiming a value would be
    // inventing state.
    const out = runCmCli(["show", "installed"]);
    const lines = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    return lines.map((line) => ({
      module: line,
      version: undefined,
    }));
  }

  // Both pip-Manager modes serve /v2/customnode/installed (the legacy-UI
  // module registers it too); only the 3.x custom-node Manager lacks /v2.
  const prefix = (await detectManagerApi(base)) === "legacy" ? "" : "/v2";
  const raw = await managerFetch<unknown>(
    `${prefix}/customnode/installed?mode=${encodeURIComponent(mode)}`,
    { base },
  );
  // A 200 with an empty or non-JSON body parses to undefined / a raw string in
  // managerFetch, and an ERROR ENVELOPE parses to an object whose values are
  // scalars ({"error": "…"}) or an object keyed by "error"/"detail"
  // ({"error": {"message": …}}, FastAPI's {"detail": …}) — parseInstalled
  // would silently turn ALL of these into an empty or junk list, which
  // downstream gates read as "the pack is absent". An unreadable payload is
  // NOT an empty list: refuse to answer from it. ({} is a legitimate
  // "nothing installed"; a module literally named "error" is the pathological
  // case accepted as collateral.)
  let readable = false;
  if (Array.isArray(raw)) {
    // parseInstalled only understands entry OBJECTS — a bare string element
    // (["temporary failure"]) would be silently dropped, reading as empty.
    readable = raw.every(
      (el) => el !== null && typeof el === "object" && !Array.isArray(el),
    );
  } else if (raw !== undefined && raw !== null && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    readable =
      !("error" in rec) &&
      !("detail" in rec) &&
      Object.values(rec).every(
        (v) => v !== null && typeof v === "object" && !Array.isArray(v),
      );
  }
  if (!readable) {
    throw new NodeManagementError(
      `ComfyUI-Manager's installed-pack list returned an unreadable payload ` +
        `(expected a JSON object of pack records or an array, got ${
          raw === undefined ? "an empty body" : `a ${typeof raw}`
        }) — treating the list as UNREADABLE, not as empty.`,
    );
  }
  return parseInstalled(raw);
}

export async function listInstalledNodes(
  opts: ListInstalledOptions = {},
): Promise<InstalledNode[]> {
  return listInstalledNodesAt(managerBaseUrl(), opts);
}

// ---------------------------------------------------------------------------
// sync dependencies (comfy-cli `node uv-sync` analogue)
// ---------------------------------------------------------------------------

export interface SyncDepsResult {
  mechanism: "comfy-cli";
  message: string;
  details?: unknown;
}

/**
 * Reconcile installed-node Python dependencies. comfy-cli exposes this as
 * `node uv-sync`, but ComfyUI-Manager has no `uv-sync` subcommand or HTTP
 * endpoint; the equivalent reconciliation is cm-cli `restore-dependencies`,
 * which reinstalls each installed pack's requirements. Subprocess-only.
 */
export async function syncNodeDependencies(): Promise<SyncDepsResult> {
  const out = runCmCli(["restore-dependencies"]);
  return {
    mechanism: "comfy-cli",
    message:
      "Reconciled installed-node Python dependencies via official comfy-cli node restore-dependencies.",
    details: out.trim(),
  };
}

// ---------------------------------------------------------------------------
// install model (ComfyUI-Manager `install-model` task)
// ---------------------------------------------------------------------------

/**
 * Parameters for the ComfyUI-Manager `install-model` task. This mirrors the
 * Manager-side InstallModelParams Pydantic model used by
 * /v2/manager/queue/task (do_install_model): the backend downloads `url` to
 * `<models_dir>/<save_path or type>/<filename>` server-side. Because the
 * download happens ON THE COMFYUI HOST, this is the remote-mode equivalent of
 * our local downloadModel() — no local filesystem is touched.
 */
export interface InstallModelParams {
  /**
   * Display name for the model. REQUIRED, non-empty: Manager 4.2.2's
   * do_install_model reads `json_data['name']`. When omitted/blank we fall back
   * to `filename`. (Verified live: omitting this is a silent no-op.)
   */
  name: string;
  /** Direct download URL for the model file. */
  url: string;
  /** Saved filename under the target directory. */
  filename: string;
  /**
   * ComfyUI-Manager model `type` — MUST be a key in Manager's
   * `model_dir_name_map` (e.g. "checkpoints", "lora", "vae", "controlnet",
   * "clip_vision", "upscale", "embeddings", "text_encoders"/"clip",
   * "diffusion_model", "unet", "gligen", "unclip"). When `save_path` is
   * "default" Manager resolves the destination folder from this; an arbitrary
   * value (e.g. "vae_approx") resolves to None and the install silently no-ops.
   * Use managerModelDestination() to derive a valid value from our categories.
   */
  type: string;
  /**
   * Save path relative to models/. ALWAYS sent to Manager (defaults to the
   * literal "default" when blank). Manager's get_model_dir does
   * `if data["save_path"] != "default": <use it verbatim>` else it resolves the
   * folder from `type`; a missing/None save_path makes it bail (→ nothing
   * installs). Pass an explicit relative path (e.g. "loras/sub") for a nested
   * destination, or "default" for type-based resolution.
   */
  save_path?: string;
  /**
   * OUR canonical folder-paths category (e.g. "diffusion_models", "vae") —
   * used ONLY for panel download-tray progress. When set and the panel
   * progress channel is active, a background watcher reports an indeterminate
   * tray row until the file shows up in the server's /models/<category>
   * listing (in-progress files are hidden there, so "listed" = landed).
   */
  trayCategory?: string;
}

// Remote (Manager-dispatched) downloads run server-side: the queue reports
// "done" at dispatch/aria2-handoff while the host still streams gigabytes, so
// tray progress can't come from bytes we never see (issue #143). Instead, poll
// the server's /models/<category> listing — verified live: an in-progress file
// is NOT listed; it appears when the download completes.
const REMOTE_LANDING_POLL_MS = 5_000;
const REMOTE_LANDING_TIMEOUT_MS = 4 * 60 * 60 * 1000; // generous: multi-GB on slow links

/**
 * Background tray reporter for a server-side model download. Writes an
 * indeterminate "downloading" row immediately (and as a heartbeat, so the
 * orchestrator's 60s dead-writer sweep doesn't prune long downloads), then a
 * terminal "done" when the filename appears in /models/<category>, or "error"
 * if it never shows within the timeout. Fire-and-forget: the tool call returns
 * at dispatch; this keeps the tray honest afterwards. No-op outside the panel
 * (progress channel disabled).
 *
 * `base` is the ComfyUI the download was DISPATCHED to: the file lands there,
 * so the poll must stay there even if the panel retargets mid-download —
 * following the new target would watch a server the file never lands on and
 * eventually report a false "error".
 */
export function watchRemoteModelLanding(
  category: string,
  filename: string,
  url: string,
  base = getComfyUIBaseUrl(),
): void {
  if (!progressEnabled()) return;
  const id = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const row = { id, name: filename, downloaded: 0, total: 0, bytes_per_sec: 0 };
  reportDownloadProgress({ ...row, status: "downloading" }, true);
  const started = Date.now();
  const timer = setInterval(() => {
    void (async () => {
      let listed = false;
      try {
        const res = await comfyuiFetch(
          `${base}/models/${encodeURIComponent(category)}`,
        );
        if (res.ok) {
          const names = (await res.json()) as unknown;
          // Entries are relative paths ("file.safetensors" or "sub/file.safetensors").
          listed =
            Array.isArray(names) &&
            names.some(
              (n) =>
                typeof n === "string" &&
                (n === filename || n.endsWith(`/${filename}`) || n.endsWith(`\\${filename}`)),
            );
        }
      } catch {
        // Server briefly unreachable (e.g. mid-reboot) — keep waiting.
      }
      if (listed) {
        clearInterval(timer);
        reportDownloadProgress({ ...row, status: "done" }, true);
      } else if (Date.now() - started > REMOTE_LANDING_TIMEOUT_MS) {
        clearInterval(timer);
        reportDownloadProgress({ ...row, status: "error" }, true);
      } else {
        reportDownloadProgress({ ...row, status: "downloading" }, true);
      }
    })();
  }, REMOTE_LANDING_POLL_MS);
  timer.unref?.();
}

/**
 * Install a model on the connected ComfyUI host via ComfyUI-Manager's unified
 * task queue (`install-model` kind). Wraps the same queue task + drain
 * (start → poll status) flow that custom-node installs use, so it works against
 * a REMOTE ComfyUI where the MCP has no local filesystem. The Manager backend
 * fetches `url` server-side into the target model directory.
 */
export async function installModelViaManager(
  params: InstallModelParams,
): Promise<NodeOpResult> {
  // Build the ModelMetadata params exactly as Manager 4.2.2 expects. ALL of
  // name/type/url/filename/save_path are load-bearing (verified live against a
  // RunPod pod): `name` and `save_path` were the two missing fields that made
  // the task dispatch but silently install nothing.
  const name =
    params.name && params.name.trim().length > 0 ? params.name : params.filename;
  const save_path =
    params.save_path && params.save_path.trim().length > 0
      ? params.save_path
      : "default";
  const taskParams: Record<string, unknown> = {
    name,
    url: params.url,
    filename: params.filename,
    type: params.type,
    save_path,
  };
  // One pinned target for the whole operation — the dispatch, its self-heal
  // retry/drain, AND the landing watcher (the file lands on the server the task
  // was dispatched to, so that is the only server worth polling).
  const base = managerBaseUrl();
  const status = await queueManagerTask("install-model", taskParams, base);
  // NOTE: the Manager queue reports the task "done" once it DRAINS, even when
  // the underlying OperationResult failed (e.g. a 404 download, or Manager's
  // security gate rejecting a network fetch) — and with an aria2 sidecar
  // (COMFYUI_MANAGER_ARIA2_SERVER) it drains at HANDOFF, while the host is
  // still streaming gigabytes. The v2 queue/status endpoint only exposes
  // aggregate counts (no per-task result), so a clean drain here does NOT
  // prove the file landed — phrase the result as "dispatched", not
  // "installed", and leave final verification to a list on the pod.
  //
  // DEPLOYMENT: remote model install requires the pod's ComfyUI-Manager to be
  // in network_mode=personal_cloud (or loopback) with permissive security; a
  // stricter security_level rejects the server-side download.
  if (params.trayCategory) {
    watchRemoteModelLanding(params.trayCategory, params.filename, params.url, base);
  }
  return {
    mechanism: "manager-http",
    message:
      `Dispatched model "${name}" (${params.filename}) to install into ` +
      `${params.type} on the connected ComfyUI via ComfyUI-Manager. The queue ` +
      `drained, but that only means the download was HANDED OFF (with an aria2 ` +
      `sidecar the host keeps streaming after the queue drains), and Manager ` +
      `reports tasks "done" even on failure with no per-task result — so ` +
      `success is NOT guaranteed. The file appears in the server's ` +
      `/models/<category> listing only once the download COMPLETES (in-progress ` +
      `files are hidden), and Manager may store it under its own type dir ` +
      `(e.g. unet/, clip/) which ComfyUI aliases to diffusion_models/` +
      `text_encoders — an empty canonical folder mid-download is NORMAL, not a ` +
      `failure. Wait and re-check before re-dispatching (duplicates waste ` +
      `bandwidth); a restart may be required for loaders to see the file. If ` +
      `nothing ever lands, confirm Manager runs with ` +
      `network_mode=personal_cloud (or loopback) and a permissive security ` +
      `level so server-side downloads aren't blocked.`,
    details: status,
  };
}

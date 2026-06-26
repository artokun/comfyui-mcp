import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { config, getComfyUIBaseUrl } from "../config.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { ComfyUIError, ProcessControlError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Custom-node management — ports `comfy-cli node install|update|reinstall|fix|
// show|uv-sync` to MCP tools.
//
// Strategy (hybrid, confirmed with maintainer):
//   1. Prefer the ComfyUI-Manager HTTP API (works against remote instances).
//      Manager uses a unified queue model: POST a single task envelope to
//      /v2/manager/queue/task, then POST /v2/manager/queue/start to begin
//      processing, then poll /v2/manager/queue/status until the queue drains.
//   2. Fall back to the cm-cli.py subprocess (against config.comfyuiPath) for
//      anything the HTTP API can't do, or when the user forces it.
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
  /** Whether the pack is currently enabled. */
  enabled: boolean;
}

export interface NodeOpResult {
  /** Which mechanism handled the request. */
  mechanism: "manager-http" | "cm-cli";
  /** Human-readable summary. */
  message: string;
  /** Raw queue status (HTTP path) or subprocess output (cm-cli path). */
  details?: unknown;
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
type ManagerTaskKind =
  | "install"
  | "uninstall"
  | "update"
  | "fix"
  | "enable"
  | "disable";

// ---------------------------------------------------------------------------
// Manager HTTP helper (local to this unit — do NOT extract to a shared client)
// ---------------------------------------------------------------------------

function managerBaseUrl(): string {
  return getComfyUIBaseUrl();
}

interface ManagerFetchOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Treat a non-2xx response as a soft failure (return undefined) instead of throwing. */
  soft?: boolean;
}

async function managerFetch<T>(
  path: string,
  options: ManagerFetchOptions = {},
): Promise<T | undefined> {
  const { method = "GET", body, soft = false } = options;
  const url = `${managerBaseUrl()}${path}`;
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
    const text = await res.text().catch(() => "");
    throw new NodeManagementError(
      `ComfyUI-Manager API ${res.status} ${res.statusText} for ${path}`,
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
  timeoutMs: 600_000,
};

/** @internal — test hook to shrink polling timings; not part of the tool API. */
export function setQueueTimingForTests(
  overrides: Partial<typeof queueTiming>,
): void {
  Object.assign(queueTiming, overrides);
}

/**
 * Kick off the Manager queue worker and poll until it drains.
 * Returns the final queue status.
 */
async function runManagerQueue(): Promise<QueueStatus> {
  // /v2/manager/queue/start returns 200 (worker started) or 201 (already
  // running) — both are 2xx, so managerFetch accepts either.
  await managerFetch("/v2/manager/queue/start", { method: "POST" });

  const start = Date.now();
  let lastStatus: QueueStatus | undefined;
  while (Date.now() - start < queueTiming.timeoutMs) {
    await sleep(queueTiming.pollIntervalMs);
    const status = await managerFetch<QueueStatus>("/v2/manager/queue/status", {
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
  throw new NodeManagementError(
    `ComfyUI-Manager queue did not finish within ${queueTiming.timeoutMs / 1000}s`,
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
  params: Record<string, unknown>,
): Promise<QueueStatus> {
  const uiId = randomUUID();
  await managerFetch("/v2/manager/queue/task", {
    method: "POST",
    body: {
      ui_id: uiId,
      client_id: MANAGER_CLIENT_ID,
      kind,
      params: { ...params, ui_id: uiId },
    },
  });
  return runManagerQueue();
}

// ---------------------------------------------------------------------------
// cm-cli subprocess helper
// ---------------------------------------------------------------------------

const CM_CLI_TIMEOUT = 600_000;

function resolveCmCliPath(): string {
  if (!config.comfyuiPath) {
    throw new ProcessControlError(
      "This operation requires a local ComfyUI install, but config.comfyuiPath " +
        "is not set (running in remote --comfyui-url mode). Set COMFYUI_PATH or " +
        "use the ComfyUI-Manager HTTP API instead.",
    );
  }
  const cmCli = join(
    config.comfyuiPath,
    "custom_nodes",
    "ComfyUI-Manager",
    "cm-cli.py",
  );
  if (!existsSync(cmCli)) {
    throw new NodeManagementError(
      `cm-cli.py not found at ${cmCli}. Modern ComfyUI-Manager ships as the pip ` +
        `package 'comfyui_manager' (no cm-cli.py), so the subprocess fallback is ` +
        `unavailable on this install. Retry without useCmCli — the HTTP API covers ` +
        `install/update/fix/uninstall/enable/disable.`,
    );
  }
  return cmCli;
}

/**
 * Run a cm-cli.py subcommand. Returns combined stdout.
 * Throws ProcessControlError if comfyuiPath is undefined (remote mode).
 */
function runCmCli(args: string[]): string {
  const cmCli = resolveCmCliPath();
  const pythonExe = process.env.COMFYUI_PYTHON || "python";
  logger.info("Running cm-cli", { args: [cmCli, ...args].join(" ") });

  try {
    const out = execFileSync(pythonExe, [cmCli, ...args], {
      cwd: config.comfyuiPath,
      encoding: "utf-8",
      timeout: CM_CLI_TIMEOUT,
      env: {
        ...process.env,
        ...(config.githubToken ? { GITHUB_TOKEN: config.githubToken } : {}),
      },
    });
    return out;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = e.stdout ? e.stdout.toString() : "";
    const stderr = e.stderr ? e.stderr.toString() : "";
    if (e.code === "ENOENT") {
      throw new ProcessControlError(
        `Python executable "${pythonExe}" not found. Set COMFYUI_PYTHON to the ` +
          `python interpreter for your ComfyUI install.`,
      );
    }
    throw new NodeManagementError(
      `cm-cli ${args[0]} failed: ${e.message}`,
      { stdout, stderr },
    );
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
    // `enabled` may be absent on some builds; treat missing as enabled,
    // but honor an explicit is_disabled flag if present.
    enabled:
      typeof v.enabled === "boolean"
        ? v.enabled
        : v.is_disabled === true
          ? false
          : true,
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

function runGitCheckout(baseUrl: string, ref: string): void {
  if (!config.comfyuiPath) {
    throw new ProcessControlError(
      "Checking out a custom-node git ref requires a local ComfyUI install, " +
        "but config.comfyuiPath is not set.",
    );
  }

  const nodeDir = join(config.comfyuiPath, "custom_nodes", gitCheckoutDir(baseUrl));
  logger.info("Checking out custom-node git ref", {
    repository: baseUrl,
    ref,
    nodeDir,
  });

  try {
    execFileSync("git", ["-C", nodeDir, "fetch", "--all", "--tags"], {
      cwd: config.comfyuiPath,
      encoding: "utf-8",
      timeout: CM_CLI_TIMEOUT,
    });
    execFileSync("git", ["-C", nodeDir, "checkout", "--detach", "--end-of-options", ref], {
      cwd: config.comfyuiPath,
      encoding: "utf-8",
      timeout: CM_CLI_TIMEOUT,
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
  /** Force the cm-cli subprocess instead of the HTTP API. */
  useCmCli?: boolean;
}

export async function installCustomNode(
  opts: InstallOptions,
): Promise<NodeOpResult> {
  const { id, version, mode = "remote", channel = "default" } = opts;
  const parsedGit = parseGitUrl(id);
  const gitId = parsedGit.baseUrl;
  const gitRefCandidate = opts.ref ?? parsedGit.ref ?? version;
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

  if (opts.useCmCli) {
    // cm-cli install accepts registry ids and git urls alike.
    const installId = source === "git" ? gitId : id;
    const out = runCmCli(["install", installId, "--mode", mode, "--channel", channel]);
    if (source === "git" && gitRef) {
      runGitCheckout(gitId, gitRef);
    }
    return {
      mechanism: "cm-cli",
      message: `Installed "${id}" via cm-cli.`,
      details: out.trim(),
    };
  }

  let params: Record<string, unknown>;
  if (source === "git") {
    // Git install via the unified task. do_install only consumes `id` +
    // `selected_version` (it resolves `${id}@${selected_version}` through
    // resolve_node_spec), so we pass the repo URL as the id and the ref as the
    // selected version. `repository` is included because InstallPackParams marks
    // it required for nightly. A concrete ref pins the branch/tag/commit; with
    // none we fall back to "nightly" (the registry's git-HEAD channel).
    // NOTE: live-unverified against this Manager build — registry installs are
    // verified; flag if a git-URL install regresses.
    const selected = gitRef ?? "nightly";
    params = {
      id: gitId,
      version: selected,
      selected_version: selected,
      repository: gitId,
      pip: [],
      channel,
      mode,
    };
  } else {
    params = {
      id,
      version: version ?? "latest",
      selected_version: version ?? "latest",
      channel,
      mode,
    };
  }

  const status = await queueManagerTask("install", params);
  return {
    mechanism: "manager-http",
    message: `Queued + installed "${id}" (${source}) via ComfyUI-Manager. A restart may be required to load new nodes.`,
    details: status,
  };
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

export async function updateCustomNode(
  opts: UpdateOptions,
): Promise<NodeOpResult> {
  const { id, mode = "remote", channel = "default" } = opts;
  const all = id.trim().toLowerCase() === "all";

  if (opts.useCmCli) {
    const out = runCmCli(["update", id, "--mode", mode, "--channel", channel]);
    return {
      mechanism: "cm-cli",
      message: all
        ? "Updated all installed node packs via cm-cli."
        : `Updated "${id}" via cm-cli.`,
      details: out.trim(),
    };
  }

  let status: QueueStatus;
  if (all) {
    // update_all keeps its own dedicated route; its params carry client_id.
    await managerFetch("/v2/manager/queue/update_all", {
      method: "POST",
      body: { mode, client_id: MANAGER_CLIENT_ID },
    });
    status = await runManagerQueue();
  } else {
    // Single-pack update → unified task; UpdatePackParams uses node_name/node_ver.
    status = await queueManagerTask("update", { node_name: id });
  }
  return {
    mechanism: "manager-http",
    message: all
      ? "Queued + updated all installed node packs via ComfyUI-Manager."
      : `Queued + updated "${id}" via ComfyUI-Manager.`,
    details: status,
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

export async function reinstallCustomNode(
  opts: ReinstallOptions,
): Promise<NodeOpResult> {
  const { id, version, mode = "remote", channel = "default" } = opts;

  if (opts.useCmCli) {
    const out = runCmCli(["reinstall", id, "--mode", mode, "--channel", channel]);
    return {
      mechanism: "cm-cli",
      message: `Reinstalled "${id}" via cm-cli.`,
      details: out.trim(),
    };
  }

  // The unified queue has no `reinstall` kind, so model it as uninstall + a
  // fresh install of the same target. Each is its own drained queue cycle.
  await queueManagerTask("uninstall", { node_name: id });
  const status = await queueManagerTask("install", {
    id,
    version: version ?? "latest",
    selected_version: version ?? "latest",
    channel,
    mode,
  });
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
  const { id, mode = "remote", channel = "default" } = opts;
  const all = id.trim().toLowerCase() === "all";

  // The HTTP API has no "fix all"; cm-cli supports it. Route accordingly.
  if (opts.useCmCli || all) {
    const out = runCmCli(["fix", id, "--mode", mode, "--channel", channel]);
    return {
      mechanism: "cm-cli",
      message: all
        ? "Repaired all installed node packs via cm-cli."
        : `Repaired "${id}" via cm-cli.`,
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
// list installed
// ---------------------------------------------------------------------------

export interface ListInstalledOptions {
  mode?: "default" | "imported";
  useCmCli?: boolean;
}

export async function listInstalledNodes(
  opts: ListInstalledOptions = {},
): Promise<InstalledNode[]> {
  const { mode = "default" } = opts;

  if (opts.useCmCli) {
    // cm-cli `show installed` prints a formatted table — return raw lines as
    // pseudo-nodes since structured data is HTTP-only.
    const out = runCmCli(["show", "installed"]);
    const lines = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    return lines.map((line) => ({
      module: line,
      enabled: true,
      version: undefined,
    }));
  }

  const raw = await managerFetch<unknown>(
    `/v2/customnode/installed?mode=${encodeURIComponent(mode)}`,
  );
  return parseInstalled(raw);
}

// ---------------------------------------------------------------------------
// sync dependencies (comfy-cli `node uv-sync` analogue)
// ---------------------------------------------------------------------------

export interface SyncDepsResult {
  mechanism: "cm-cli";
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
    mechanism: "cm-cli",
    message:
      "Reconciled installed-node Python dependencies via cm-cli restore-dependencies.",
    details: out.trim(),
  };
}

import type { WorkflowJSON, ObjectInfo } from "../comfyui/types.js";
import { getObjectInfo } from "../comfyui/client.js";
import { getComfyUIBaseUrl } from "../config.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { ComfyUIError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/**
 * Workflow dependency analysis & installation.
 *
 * Mirrors `comfy-cli node deps-in-workflow` and `node install-deps`.
 *
 * Strategy (hybrid, confirmed against Comfy-Org/ComfyUI-Manager):
 *  - Map workflow class_types -> owning custom node pack using two sources:
 *      1. ComfyUI-Manager `/customnode/getmappings` (works remotely; covers
 *         not-yet-installed packs).
 *      2. `/object_info` node defs' `python_module` field (authoritative for
 *         packs that ARE installed; format `custom_nodes.<pack_dir>` or
 *         `nodes`/`comfy_extras` for built-ins).
 *  - Install via the Manager queue flow: POST `/manager/queue/install` per
 *    pack, POST `/manager/queue/start`, then poll `/manager/queue/status`.
 *
 * Built-in nodes (core ComfyUI) require no pack and are reported as such.
 */

/** Manager getmappings response: { repoOrId: [ [classNames...], { title?, ... } ] } */
type ManagerMappings = Record<
  string,
  [string[], { title?: string; nodename_pattern?: string }]
>;

/** A single node pack entry from `/customnode/getlist`. */
export interface ManagerNodePack {
  id?: string;
  title?: string;
  reference?: string;
  files?: string[];
  install_type?: string;
  state?: string; // "installed" | "not-installed" | "disabled" | ...
  active_version?: string;
  version?: string;
  channel?: string;
  mode?: string;
}

/** getlist response shape (Manager returns { channel, node_packs: {...} }). */
type ManagerListResponse = {
  channel?: string;
  node_packs?: Record<string, ManagerNodePack>;
};

export interface NodeDependency {
  /** The workflow node class_type. */
  class_type: string;
  /** Resolved owning node pack id/title, or null if unknown. */
  pack: string | null;
  /** True when the class_type is a core/built-in ComfyUI node (no pack needed). */
  builtin: boolean;
  /** True when the node is currently installed/available on the server. */
  installed: boolean;
  /** How the pack was resolved (for transparency). */
  source: "object_info" | "manager_mappings" | "unresolved";
}

export interface ExtractDepsResult {
  /** Distinct class_types found in the workflow. */
  classTypes: string[];
  /** Per-class_type resolution. */
  dependencies: NodeDependency[];
  /** Distinct non-builtin pack identifiers required. */
  requiredPacks: string[];
  /** Packs that are required but not installed. */
  missingPacks: string[];
  /** class_types that could not be mapped to any pack. */
  unresolved: string[];
}

export interface InstallDepsResult {
  /** Packs that were queued for install. */
  installed: string[];
  /** Packs that were already present. */
  alreadyInstalled: string[];
  /** Required class_types whose pack could not be resolved (cannot install). */
  unresolved: string[];
  /** Queue status after processing, if available. */
  queue?: ManagerQueueStatus;
}

export interface ManagerQueueStatus {
  total_count?: number;
  done_count?: number;
  in_progress_count?: number;
  is_processing?: boolean;
}

/**
 * Injectable dependencies for testability. Production callers use the
 * defaults wired in the tool layer.
 */
export interface WorkflowDepsDeps {
  /** Fetch /object_info node defs (class_type -> def incl. python_module). */
  fetchObjectInfo: () => Promise<ObjectInfo>;
  /** GET the Manager class_type -> pack mappings. */
  fetchManagerMappings: () => Promise<ManagerMappings>;
  /**
   * GET the Manager custom node list. Returns the resolved channel (top-level
   * in the Manager response) alongside pack metadata, so installs are queued
   * against the same channel the list came from.
   */
  fetchManagerList: () => Promise<{ channel?: string; packs: ManagerNodePack[] }>;
  /** POST a single pack install task to the Manager queue (against `channel`). */
  queueInstall: (pack: ManagerNodePack, channel: string) => Promise<void>;
  /** POST to reset the Manager queue (clears stale pending tasks before a run). */
  resetQueue: () => Promise<void>;
  /** POST to start the Manager install queue worker. */
  startQueue: () => Promise<void>;
  /** GET the Manager queue status. */
  queueStatus: () => Promise<ManagerQueueStatus>;
}

const managerBase = (): string => getComfyUIBaseUrl();

/**
 * Minimal local fetch wrapper for ComfyUI-Manager endpoints.
 * Kept inside this service per project convention (no shared manager-client).
 */
async function managerFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `${managerBase()}${path}`;
  logger.debug("Manager API request", { url, method: init?.method ?? "GET" });
  let res: Response;
  try {
    res = await comfyuiFetch(url, init);
  } catch (err) {
    throw new ComfyUIError(
      `Failed to reach ComfyUI-Manager at ${url}: ${err instanceof Error ? err.message : err}. ` +
        `Ensure ComfyUI is running and ComfyUI-Manager is installed.`,
      "MANAGER_UNREACHABLE",
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ComfyUIError(
      `ComfyUI-Manager ${path} returned ${res.status} ${res.statusText}`,
      "MANAGER_ERROR",
      { url, status: res.status, body: body.slice(0, 500) },
    );
  }
  return res;
}

/** Default dependency wiring backed by live HTTP + the ComfyUI client. */
export function defaultWorkflowDepsDeps(): WorkflowDepsDeps {
  return {
    fetchObjectInfo: () => getObjectInfo(),
    fetchManagerMappings: async () => {
      const res = await managerFetch("/customnode/getmappings?mode=nickname");
      return (await res.json()) as ManagerMappings;
    },
    fetchManagerList: async () => {
      // skip_update=true avoids slow per-pack git checks; we only need metadata.
      const res = await managerFetch("/customnode/getlist?mode=cache&skip_update=true");
      const data = (await res.json()) as ManagerListResponse | ManagerNodePack[];
      if (Array.isArray(data)) return { packs: data };
      const packs = data.node_packs ?? {};
      return {
        channel: data.channel,
        // Fold the dict key into each entry's id when missing.
        packs: Object.entries(packs).map(([key, p]) => ({ id: p.id ?? key, ...p })),
      };
    },
    queueInstall: async (pack, channel) => {
      // A plain/non-registry pack (git URL, no registry version) must route on
      // version === "unknown"; a registry pack installs its catalog version.
      const isUnknown = !pack.version || pack.version === "unknown";
      await managerFetch("/manager/queue/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: pack.id,
          version: isUnknown ? "unknown" : pack.version,
          selected_version:
            pack.active_version ?? (isUnknown ? undefined : pack.version),
          repository: pack.reference,
          files: pack.files,
          channel: pack.channel ?? channel,
          mode: pack.mode ?? "cache",
          ui_id: pack.id ?? pack.title ?? pack.reference,
        }),
      });
    },
    resetQueue: async () => {
      await managerFetch("/manager/queue/reset", { method: "POST" });
    },
    startQueue: async () => {
      await managerFetch("/manager/queue/start", { method: "POST" });
    },
    queueStatus: async () => {
      const res = await managerFetch("/manager/queue/status");
      return (await res.json()) as ManagerQueueStatus;
    },
  };
}

/**
 * Collect the distinct, sorted class_types referenced by a workflow. Handles
 * both the API format (object keyed by node id, each `{ class_type }`) and the
 * UI/"full" format (a `nodes` array whose entries carry a `type` field).
 */
export function collectClassTypes(
  workflow: WorkflowJSON | { nodes?: unknown },
): string[] {
  const set = new Set<string>();
  const uiNodes = (workflow as { nodes?: unknown }).nodes;
  if (Array.isArray(uiNodes)) {
    for (const node of uiNodes) {
      const t = (node as { type?: unknown } | null)?.type;
      if (typeof t === "string" && t) set.add(t);
    }
    return [...set].sort();
  }
  for (const node of Object.values(workflow as WorkflowJSON)) {
    if (node && typeof node.class_type === "string" && node.class_type) {
      set.add(node.class_type);
    }
  }
  return [...set].sort();
}

/**
 * Determine whether a python_module string denotes a core/built-in node
 * rather than a custom node pack. ComfyUI reports built-ins as `nodes` or
 * `comfy_extras(.*)`; custom packs are `custom_nodes.<pack_dir>`.
 */
function packFromPythonModule(pythonModule: string | undefined): {
  builtin: boolean;
  pack: string | null;
} {
  if (!pythonModule) return { builtin: false, pack: null };
  if (pythonModule === "nodes" || pythonModule.startsWith("comfy_extras")) {
    return { builtin: true, pack: null };
  }
  const prefix = "custom_nodes.";
  if (pythonModule.startsWith(prefix)) {
    // custom_nodes.<pack_dir>.<maybe.submodule> -> take the pack_dir segment.
    const rest = pythonModule.slice(prefix.length);
    const packDir = rest.split(".")[0];
    return { builtin: false, pack: packDir || null };
  }
  // Unknown module form: treat as a non-builtin pack named by its root segment.
  return { builtin: false, pack: pythonModule.split(".")[0] || null };
}

/** Build a class_type -> pack lookup from Manager mappings (incl. regex patterns). */
function buildMappingIndex(mappings: ManagerMappings): {
  exact: Map<string, string>;
  patterns: Array<{ re: RegExp; pack: string }>;
} {
  const exact = new Map<string, string>();
  const patterns: Array<{ re: RegExp; pack: string }> = [];
  for (const [repoOrId, value] of Object.entries(mappings)) {
    if (!Array.isArray(value)) continue;
    const [classNames, meta] = value;
    const pack = (meta && meta.title) || repoOrId;
    if (Array.isArray(classNames)) {
      for (const cn of classNames) {
        if (typeof cn === "string" && !exact.has(cn)) exact.set(cn, pack);
      }
    }
    const pattern = meta?.nodename_pattern;
    if (typeof pattern === "string" && pattern) {
      try {
        patterns.push({ re: new RegExp(pattern), pack });
      } catch {
        // Ignore malformed patterns from the Manager DB.
      }
    }
  }
  return { exact, patterns };
}

function resolveFromMappings(
  classType: string,
  index: { exact: Map<string, string>; patterns: Array<{ re: RegExp; pack: string }> },
): string | null {
  const exact = index.exact.get(classType);
  if (exact) return exact;
  for (const { re, pack } of index.patterns) {
    if (re.test(classType)) return pack;
  }
  return null;
}

/**
 * Extract the custom node packs a workflow depends on.
 *
 * Works in remote mode (no local path) since it relies solely on HTTP:
 * `/object_info` for installed-node detection and Manager `/getmappings`
 * for the class_type -> pack mapping (which also covers uninstalled packs).
 */
export async function extractWorkflowDependencies(
  workflow: WorkflowJSON,
  deps: WorkflowDepsDeps,
): Promise<ExtractDepsResult> {
  const classTypes = collectClassTypes(workflow);

  const objectInfo = await deps.fetchObjectInfo();

  // Manager mappings are best-effort: extraction must still work if Manager
  // is absent, falling back to object_info's python_module for installed nodes.
  let mappingIndex: ReturnType<typeof buildMappingIndex> = {
    exact: new Map(),
    patterns: [],
  };
  try {
    mappingIndex = buildMappingIndex(await deps.fetchManagerMappings());
  } catch (err) {
    logger.warn("ComfyUI-Manager mappings unavailable; relying on /object_info only", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const dependencies: NodeDependency[] = [];
  for (const classType of classTypes) {
    const def = objectInfo[classType];
    const installed = Boolean(def);

    if (def) {
      const { builtin, pack } = packFromPythonModule(def.python_module);
      if (builtin) {
        dependencies.push({ class_type: classType, pack: null, builtin: true, installed: true, source: "object_info" });
        continue;
      }
      // Installed custom node: prefer Manager's friendly pack name when available,
      // otherwise use the python_module-derived directory name.
      const mappedPack = resolveFromMappings(classType, mappingIndex);
      dependencies.push({
        class_type: classType,
        pack: mappedPack ?? pack,
        builtin: false,
        installed: true,
        source: mappedPack ? "manager_mappings" : "object_info",
      });
      continue;
    }

    // Not installed: only the Manager mapping can tell us the owning pack.
    const mappedPack = resolveFromMappings(classType, mappingIndex);
    dependencies.push({
      class_type: classType,
      pack: mappedPack,
      builtin: false,
      installed: false,
      source: mappedPack ? "manager_mappings" : "unresolved",
    });
  }

  const requiredPackSet = new Set<string>();
  const missingPackSet = new Set<string>();
  const unresolved: string[] = [];

  for (const dep of dependencies) {
    if (dep.builtin) continue;
    if (dep.pack) {
      requiredPackSet.add(dep.pack);
      if (!dep.installed) missingPackSet.add(dep.pack);
    } else if (!dep.installed) {
      unresolved.push(dep.class_type);
    }
  }

  return {
    classTypes,
    dependencies,
    requiredPacks: [...requiredPackSet].sort(),
    missingPacks: [...missingPackSet].sort(),
    unresolved: unresolved.sort(),
  };
}

/**
 * Resolve and install the node packs a workflow needs via ComfyUI-Manager.
 *
 * Installs go through the Manager HTTP queue, which runs server-side on the
 * ComfyUI instance this MCP server is connected to (local OR a remote
 * --comfyui-url target). It does NOT depend on a local filesystem path — the
 * local install dir is irrelevant to where Manager writes packs.
 */
export async function installWorkflowDependencies(
  workflow: WorkflowJSON,
  deps: WorkflowDepsDeps,
): Promise<InstallDepsResult> {
  const analysis = await extractWorkflowDependencies(workflow, deps);

  if (analysis.missingPacks.length === 0) {
    return {
      installed: [],
      alreadyInstalled: analysis.requiredPacks,
      unresolved: analysis.unresolved,
    };
  }

  // Match missing packs to concrete Manager list entries for install payloads,
  // capturing the channel the list resolved against.
  const { channel = "default", packs } = await deps.fetchManagerList();
  const byKey = new Map<string, ManagerNodePack>();
  for (const p of packs) {
    for (const key of [p.id, p.title, p.reference]) {
      if (key && !byKey.has(key)) byKey.set(key, p);
    }
  }

  const toInstall: ManagerNodePack[] = [];
  const installed: string[] = [];
  const unresolved = [...analysis.unresolved];

  for (const pack of analysis.missingPacks) {
    const entry = byKey.get(pack);
    if (!entry) {
      unresolved.push(pack);
      continue;
    }
    toInstall.push(entry);
    installed.push(pack);
  }

  let queue: ManagerQueueStatus | undefined;
  if (toInstall.length > 0) {
    // Clear any stale/pending Manager tasks first so starting the worker runs
    // only the installs we just queued, not unrelated leftover work.
    await deps.resetQueue();
    for (const entry of toInstall) {
      await deps.queueInstall(entry, channel);
    }
    await deps.startQueue();
    try {
      queue = await deps.queueStatus();
    } catch (err) {
      logger.warn("Could not read Manager queue status after starting installs", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Already-installed = required packs that were never in the missing set.
  // (A missing pack that failed to resolve goes to `unresolved`, not here.)
  const missingSet = new Set(analysis.missingPacks);
  return {
    installed: installed.sort(),
    alreadyInstalled: analysis.requiredPacks.filter((p) => !missingSet.has(p)),
    unresolved: [...new Set(unresolved)].sort(),
    queue,
  };
}

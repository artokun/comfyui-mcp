import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config, getComfyUIBaseUrl } from "../config.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { NodeBisectError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BisectStatus = "idle" | "running" | "resolved";

/**
 * Bisection session state. Mirrors comfy-cli's `BisectState`:
 *  - `all`     — every installed custom node at session start (stable order)
 *  - `range`   — the candidate set still believed to contain the culprit
 *  - `active`  — the subset enabled for the CURRENT test round
 *  - `culprit` — set once the search converges to a single node
 */
export interface BisectState {
  status: BisectStatus;
  all: string[];
  range: string[];
  active: string[];
  culprit: string | null;
}

/** One installed custom node and whether it is currently enabled. */
export interface InstalledNodeInfo {
  id: string;
  enabled: boolean;
}

/**
 * Side-effecting operations the state machine needs. Abstracted so the
 * bisection logic can be unit-tested deterministically without touching the
 * network or filesystem, and so the Manager-API vs filesystem mechanism is
 * swappable behind one interface.
 */
export interface NodeController {
  /**
   * List installed custom nodes with their current enabled-state, in a stable
   * order. Bisect ranges only over nodes ENABLED at session start, so it never
   * re-enables packs the user had disabled beforehand.
   */
  listNodes(): Promise<InstalledNodeInfo[]>;
  /** Apply enabled/disabled state for the given partition. */
  setEnabledStates(enabled: string[], disabled: string[]): Promise<void>;
}

interface ApplyResult {
  state: BisectState;
  message: string;
}

// ---------------------------------------------------------------------------
// Module-level session state — persists between MCP tool calls in a session.
// (Same pattern as `lastProcessInfo` in services/process-control.ts.)
// ---------------------------------------------------------------------------

let session: BisectState | null = null;

const IDLE_STATE: BisectState = {
  status: "idle",
  all: [],
  range: [],
  active: [],
  culprit: null,
};

function snapshot(state: BisectState): BisectState {
  return {
    status: state.status,
    all: [...state.all],
    range: [...state.range],
    active: [...state.active],
    culprit: state.culprit,
  };
}

// ---------------------------------------------------------------------------
// Pure bisection math — no side effects, fully unit-testable.
// ---------------------------------------------------------------------------

/**
 * Pick the active subset for a fresh `range`: the upper half.
 * Matches comfy-cli: `active = new_range[len(new_range) // 2 :]`.
 */
export function pickActive(range: string[]): string[] {
  return range.slice(Math.floor(range.length / 2));
}

/** The complement of `active` within `all`. */
function inactiveOf(state: BisectState): string[] {
  const activeSet = new Set(state.active);
  return state.all.filter((n) => !activeSet.has(n));
}

/**
 * Compute the next state after marking the current `active` set GOOD
 * (problem absent from the enabled subset → culprit is among the disabled
 * candidates). `new_range = range - active`.
 */
export function reduceGood(state: BisectState): BisectState {
  const activeSet = new Set(state.active);
  const newRange = state.range.filter((n) => !activeSet.has(n));
  return advance(state, newRange);
}

/**
 * Compute the next state after marking the current `active` set BAD
 * (problem present in the enabled subset → culprit is within active).
 * `new_range = active`.
 */
export function reduceBad(state: BisectState): BisectState {
  const newRange = [...state.active];
  return advance(state, newRange);
}

/**
 * Shared tail of good/bad: if the candidate range has collapsed to a single
 * node (or fewer) the search is resolved; otherwise pick the next active half.
 */
function advance(state: BisectState, newRange: string[]): BisectState {
  if (newRange.length <= 1) {
    return {
      status: "resolved",
      all: state.all,
      range: newRange,
      active: [],
      culprit: newRange[0] ?? null,
    };
  }
  return {
    status: "running",
    all: state.all,
    range: newRange,
    active: pickActive(newRange),
    culprit: null,
  };
}

// ---------------------------------------------------------------------------
// Manager HTTP API controller (preferred — works against remote ComfyUI too)
// ---------------------------------------------------------------------------

function managerBase(): string {
  return getComfyUIBaseUrl();
}

/** Small local fetch helper for the ComfyUI-Manager API. */
async function managerFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 15000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await comfyuiFetch(`${managerBase()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new NodeBisectError(
      `ComfyUI-Manager request to ${path} failed: ${msg}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the ComfyUI-Manager API is reachable. Used to decide between the
 * HTTP controller and the filesystem fallback.
 */
export async function isManagerAvailable(): Promise<boolean> {
  try {
    const res = await managerFetch(
      "/customnode/installed?mode=default",
      { method: "GET" },
      4000,
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Per-module metadata captured from /customnode/installed, needed to build
 * correct disable/enable payloads — Manager keys these on the pack id plus its
 * installed version (registry packs by cnr_id@version).
 */
interface ManagerNodeDescriptor {
  cnrId?: string;
  version?: string;
}
const managerDescriptors = new Map<string, ManagerNodeDescriptor>();

/**
 * Controller backed by the ComfyUI-Manager HTTP API (used for remote installs).
 *
 * Endpoints (verified against Comfy-Org/ComfyUI-Manager glob/manager_server.py):
 *  - GET  /customnode/installed   → { "<module>": { ver, cnr_id, aux_id, enabled }, ... }
 *  - POST /manager/queue/disable  → { id, version, ui_id }  (version != "unknown"
 *                                    → Manager uses `id` as the node name)
 *  - POST /manager/queue/install  → re-enable a disabled pack via the synchronous
 *                                    unified_enable path: { id, version,
 *                                    selected_version, skip_post_install:true, ui_id }
 *  - POST /manager/queue/start    → execute queued tasks
 *
 * Payloads carry each pack's REAL installed version (and cnr_id when registry-
 * backed). Sending version:"unknown" wrongly forces Manager's git/"unknown"
 * branch (which then needs a `files` array) and fails for registry packs.
 */
export const managerController: NodeController = {
  async listNodes(): Promise<InstalledNodeInfo[]> {
    const res = await managerFetch("/customnode/installed?mode=default", {
      method: "GET",
    });
    if (!res.ok) {
      throw new NodeBisectError(
        `ComfyUI-Manager /customnode/installed returned HTTP ${res.status}`,
      );
    }
    const data = (await res.json()) as Record<
      string,
      { ver?: string; cnr_id?: string; enabled?: boolean }
    >;
    managerDescriptors.clear();
    const nodes: InstalledNodeInfo[] = [];
    for (const [id, v] of Object.entries(data)) {
      managerDescriptors.set(id, {
        cnrId: v.cnr_id && v.cnr_id.length > 0 ? v.cnr_id : undefined,
        version: typeof v.ver === "string" ? v.ver : undefined,
      });
      // Manager marks disabled packs with enabled:false; treat missing as enabled.
      nodes.push({ id, enabled: v.enabled !== false });
    }
    // Stable, deterministic order so successive rounds are reproducible.
    return nodes.sort((a, b) => a.id.localeCompare(b.id));
  },

  async setEnabledStates(
    enabled: string[],
    disabled: string[],
  ): Promise<void> {
    // Build the payload from the cached descriptor: prefer the registry id + the
    // pack's real installed version; fall back to the module id + its commit
    // hash. Never send "unknown" for an installed pack.
    const payloadFor = (id: string): Record<string, unknown> => {
      const d = managerDescriptors.get(id);
      return {
        id: d?.cnrId ?? id,
        version: d?.version ?? "unknown",
        ui_id: id,
      };
    };

    let queued = 0;
    for (const id of disabled) {
      const res = await managerFetch("/manager/queue/disable", {
        method: "POST",
        body: JSON.stringify(payloadFor(id)),
      });
      if (!res.ok) {
        throw new NodeBisectError(
          `Failed to queue disable for "${id}": HTTP ${res.status}`,
        );
      }
      queued++;
    }
    for (const id of enabled) {
      const p = payloadFor(id);
      const res = await managerFetch("/manager/queue/install", {
        method: "POST",
        // skip_post_install routes Manager to the synchronous unified_enable
        // path: it moves the pack out of .disabled/ without reinstalling.
        body: JSON.stringify({
          ...p,
          selected_version: p.version,
          skip_post_install: true,
        }),
      });
      if (!res.ok) {
        throw new NodeBisectError(
          `Failed to queue enable for "${id}": HTTP ${res.status}`,
        );
      }
      queued++;
    }
    if (queued > 0) {
      const res = await managerFetch("/manager/queue/start", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        throw new NodeBisectError(
          `Failed to start ComfyUI-Manager task queue: HTTP ${res.status}`,
        );
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Filesystem fallback controller — toggles `.disabled` directory suffixes.
// Requires a local install (config.comfyuiPath); errors clearly in remote mode.
// ---------------------------------------------------------------------------

function customNodesDir(): string {
  if (!config.comfyuiPath) {
    throw new NodeBisectError(
      "ComfyUI-Manager API is unavailable and no local ComfyUI path is configured " +
        "(remote mode). Cannot toggle custom nodes via the filesystem. Set COMFYUI_PATH " +
        "or ensure ComfyUI-Manager is installed and reachable.",
    );
  }
  return join(config.comfyuiPath, "custom_nodes");
}

/** Strip a trailing ".disabled" to get the canonical node id. */
function canonicalName(entry: string): string {
  return entry.endsWith(".disabled")
    ? entry.slice(0, -".disabled".length)
    : entry;
}

export const filesystemController: NodeController = {
  async listNodes(): Promise<InstalledNodeInfo[]> {
    const dir = customNodesDir();
    if (!existsSync(dir)) {
      throw new NodeBisectError(`custom_nodes directory not found: ${dir}`);
    }
    // A pack is disabled when its directory carries the ".disabled" suffix
    // (ComfyUI-Manager's own convention). If both "foo" and "foo.disabled"
    // exist, treat the pack as enabled.
    const enabledById = new Map<string, boolean>();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      // Skip bookkeeping dirs (note: "foo.disabled" does not start with ".").
      if (name === "__pycache__" || name.startsWith(".")) continue;
      const id = canonicalName(name);
      const isEnabled = !name.endsWith(".disabled");
      enabledById.set(id, (enabledById.get(id) ?? false) || isEnabled);
    }
    return [...enabledById.entries()]
      .map(([id, enabled]) => ({ id, enabled }))
      .sort((a, b) => a.id.localeCompare(b.id));
  },

  async setEnabledStates(
    enabled: string[],
    disabled: string[],
  ): Promise<void> {
    const dir = customNodesDir();
    const enableSet = new Set(enabled);
    const disableSet = new Set(disabled);

    for (const id of disableSet) {
      const active = join(dir, id);
      const off = join(dir, `${id}.disabled`);
      if (existsSync(active) && !existsSync(off)) {
        renameSync(active, off);
      }
    }
    for (const id of enableSet) {
      const active = join(dir, id);
      const off = join(dir, `${id}.disabled`);
      if (existsSync(off) && !existsSync(active)) {
        renameSync(off, active);
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Controller selection
// ---------------------------------------------------------------------------

/**
 * Choose the node controller: prefer the Manager HTTP API (works remotely),
 * fall back to filesystem `.disabled` toggling for local installs.
 */
export async function resolveController(): Promise<NodeController> {
  // Bisect toggles enable/disable for arbitrary packs. The filesystem
  // ".disabled" rename is exactly Manager's own mechanism and works uniformly
  // for every pack type, so prefer it whenever a local install path is known.
  // Use the Manager HTTP API only for remote (--comfyui-url) targets.
  if (config.comfyuiPath) {
    logger.info("node-bisect: using filesystem controller (local install)");
    return filesystemController;
  }
  if (await isManagerAvailable()) {
    logger.info("node-bisect: remote target — using ComfyUI-Manager HTTP API");
    return managerController;
  }
  // No local path and Manager unreachable — filesystemController throws a clear
  // remote-mode error when invoked.
  return filesystemController;
}

// ---------------------------------------------------------------------------
// Public service API — thin orchestration over the pure state machine + a
// controller. `deps.controller` is injectable for tests.
// ---------------------------------------------------------------------------

interface BisectDeps {
  controller?: NodeController;
}

async function controllerFor(deps?: BisectDeps): Promise<NodeController> {
  return deps?.controller ?? (await resolveController());
}

function describe(state: BisectState): string {
  if (state.status === "resolved") {
    return state.culprit
      ? `Resolved: the problematic custom node is "${state.culprit}".`
      : "Resolved: no candidate nodes remain (problem not attributable to a single node).";
  }
  if (state.status === "idle") {
    return "No bisect session is active. Run bisect_start to begin.";
  }
  return (
    `Round in progress: ${state.range.length} candidate node(s) remain. ` +
    `${state.active.length} enabled this round, ${state.all.length - state.active.length} disabled. ` +
    `Reproduce your problem now, then call bisect_good (problem gone) or bisect_bad (problem persists).`
  );
}

/**
 * Begin a bisect session over all installed custom nodes. Enables the upper
 * half and disables the rest for the first test round.
 */
export async function bisectStart(deps?: BisectDeps): Promise<ApplyResult> {
  const controller = await controllerFor(deps);
  const installed = await controller.listNodes();
  // Range only over nodes that are ENABLED right now. Packs the user disabled
  // before starting are left untouched and are never re-enabled by bisect.
  const all = installed.filter((n) => n.enabled).map((n) => n.id);
  const skipped = installed.length - all.length;
  const skippedNote =
    skipped > 0 ? ` (${skipped} already-disabled pack(s) left as-is)` : "";

  if (all.length === 0) {
    throw new NodeBisectError(
      "No enabled custom nodes were found to bisect" +
        (installed.length > 0
          ? " (every installed pack is already disabled)."
          : "."),
    );
  }
  if (all.length === 1) {
    // Nothing to bisect — the lone node is trivially the only candidate.
    session = {
      status: "resolved",
      all,
      range: [...all],
      active: [],
      culprit: all[0],
    };
    return {
      state: snapshot(session),
      message:
        `Only one enabled custom node ("${all[0]}")${skippedNote}. ` +
        "It is the sole candidate; nothing to bisect.",
    };
  }

  const range = [...all];
  const active = pickActive(range);
  session = { status: "running", all, range, active, culprit: null };

  await controller.setEnabledStates(active, inactiveOf(session));

  return {
    state: snapshot(session),
    message:
      `Started bisect over ${all.length} enabled custom node(s)${skippedNote}. ` +
      `${describe(session)} ` +
      "A ComfyUI restart may be required for node changes to take effect.",
  };
}

function requireRunning(): BisectState {
  if (!session || session.status !== "running") {
    throw new NodeBisectError(
      "No bisect session is in progress. Run bisect_start first.",
    );
  }
  return session;
}

async function transition(
  reducer: (s: BisectState) => BisectState,
  deps?: BisectDeps,
): Promise<ApplyResult> {
  const current = requireRunning();
  const controller = await controllerFor(deps);
  const next = reducer(current);
  session = next;

  if (next.status === "resolved") {
    // Search done — re-enable everything so the install is left usable.
    await controller.setEnabledStates(next.all, []);
    return {
      state: snapshot(next),
      message: `${describe(next)} All custom nodes have been re-enabled.`,
    };
  }

  await controller.setEnabledStates(next.active, inactiveOf(next));
  return {
    state: snapshot(next),
    message:
      `${describe(next)} A ComfyUI restart may be required for node changes to take effect.`,
  };
}

/** Mark the current active set GOOD (problem absent) and narrow the search. */
export async function bisectGood(deps?: BisectDeps): Promise<ApplyResult> {
  return transition(reduceGood, deps);
}

/** Mark the current active set BAD (problem present) and narrow the search. */
export async function bisectBad(deps?: BisectDeps): Promise<ApplyResult> {
  return transition(reduceBad, deps);
}

/** Re-enable all custom nodes and clear the session. */
export async function bisectReset(deps?: BisectDeps): Promise<ApplyResult> {
  if (!session) {
    return {
      state: snapshot(IDLE_STATE),
      message: "No bisect session was active; nothing to reset.",
    };
  }
  const controller = await controllerFor(deps);
  // Restore ONLY the nodes this session ranged over (all were enabled at start).
  // Packs the user had already disabled are deliberately left disabled — they
  // were never recorded in `all`.
  const toRestore = session.all;
  session = null;
  if (toRestore.length > 0) {
    await controller.setEnabledStates(toRestore, []);
  }
  return {
    state: snapshot(IDLE_STATE),
    message:
      toRestore.length > 0
        ? `Bisect session cleared. Re-enabled ${toRestore.length} custom node(s) that bisect had toggled. ` +
          "A ComfyUI restart may be required for node changes to take effect."
        : "Bisect session cleared.",
  };
}

/** Report the current session state and remaining candidate set. */
export function bisectStatus(): ApplyResult {
  const state = session ? snapshot(session) : snapshot(IDLE_STATE);
  return { state, message: describe(state) };
}

/** Test-only: reset module-level session state. */
export function __resetSessionForTests(): void {
  session = null;
}

import type { WorkflowJSON, ObjectInfo } from "../comfyui/types.js";
import { getObjectInfo } from "../comfyui/client.js";
import { getComfyUIBaseUrl } from "../config.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { ComfyUIError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import {
  detectManagerApi,
  enqueueManagerTaskForExternal,
  managerApiPrefixFor,
  startManagerQueueForExternal,
  type ManagerApi,
} from "./node-management.js";
import { targetsPanelPackExactly, withPanelPinGuard } from "./panel-pin-guard.js";
import {
  MANAGER_CATALOGUE_CURRENCY_CAVEAT,
  managerCatalogueCurrencyUnverified,
} from "./manager-catalogue-currency.js";
import { extractWorkflowClassTypes } from "./api-nodes.js";

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
  /**
   * How the pack was resolved (for transparency).
   *
   * `manager_pattern` is the weak one (#2765): a catalogue `nodename_pattern`
   * matched, which is a heuristic published by whoever wrote the entry rather
   * than a publisher naming its own class. It is only ever used for a node that
   * is NOT installed, since an installed one has its loaded module to go on.
   */
  source: "object_info" | "manager_mappings" | "manager_pattern" | "unresolved";
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
  /**
   * #1136 — set when the Manager MAPPINGS lookup did not actually answer, which
   * makes `unresolved` unsafe to read as "not known to ComfyUI-Manager".
   *
   * Stronger evidence than the getlist case: there we infer from an empty list,
   * here we caught a real exception and logged it, then asserted absence anyway.
   */
  mappings_unavailable?: string;
  /**
   * panel#890 — set when `unresolved` came from a Manager catalogue whose CURRENCY
   * could not be established, which is every populated one: Manager serves a copy
   * bundled in its own package when the registry is unreachable, and does not report
   * which source answered. Weaker than the two fields above — they report an OBSERVED
   * failure; this reports the absence of evidence — so it is set only when neither of
   * those is.
   */
  catalogue_currency_unverified?: string;
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
  /**
   * #1136 — set when the Manager catalogue came back EMPTY on a non-local
   * channel, which makes `unresolved` unsafe to read as "these packs do not
   * exist". Callers rendering `unresolved` must surface this instead of, or
   * alongside, "not found in ComfyUI-Manager".
   */
  catalogue_unavailable?: string;
  /** panel#890 — see the same field on WorkflowDepsAnalysis. */
  catalogue_currency_unverified?: string;
  /**
   * panel#890 (codex round 4) — the analysis's `mappings_unavailable`, carried through.
   *
   * It had nowhere to live on this shape, so an install whose MAPPINGS lookup threw
   * emitted `unresolved` with no caveat of any kind: the strong one could not be
   * represented, and the currency caveat deliberately yields to it. Yielding to a
   * caveat that never arrives is the worst of both — it suppresses the weaker
   * disclosure AND loses the stronger one, so the reader sees a bare list in the case
   * we know the most about.
   */
  mappings_unavailable?: string;
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
  fetchManagerList: () => Promise<{ channel?: string; packs: ManagerNodePack[]; directInstall?: boolean }>;
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
  base = managerBase(),
): Promise<Response> {
  const url = `${base}${path}`;
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
    // unknown-ok: "" is interpolated into an ERROR MESSAGE and nothing else — the
    // HTTP status is reported either way, so an unreadable body costs detail in the
    // text, never a wrong conclusion. Verified there is no branch on this value.
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
  // installWorkflowDependencies invokes reset → N enqueues → start → status as
  // one Manager transaction. Keep that entire sequence on the target selected
  // by reset, including a dialect self-heal, so a panel retarget cannot split
  // a queue across two ComfyUI instances (#670).
  let queueOperation: { base: string; api?: ManagerApi } | undefined;
  return {
    fetchObjectInfo: () => getObjectInfo(),
    fetchManagerMappings: async () => {
      const base = managerBase();
      const api = await detectManagerApi(base);
      const res = await managerFetch(`${managerApiPrefixFor(api)}/customnode/getmappings?mode=nickname`, undefined, base);
      return (await res.json()) as ManagerMappings;
    },
    fetchManagerList: async () => {
      // skip_update=true avoids slow per-pack git checks; we only need metadata.
      const base = managerBase();
      const api = await detectManagerApi(base);
      // v4 deliberately dropped getlist; its registry-first install task does
      // not need the legacy catalog descriptor.  Keep the legacy list path for
      // 3.x and let callers resolve against Manager mappings on v4.
      if (api !== "legacy") return { packs: [], directInstall: true };
      const res = await managerFetch("/customnode/getlist?mode=cache&skip_update=true", undefined, base);
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
      const base = queueOperation?.base ?? managerBase();
      const used = await enqueueManagerTaskForExternal("install", {
          id: pack.id,
          version: isUnknown ? "unknown" : pack.version,
          selected_version:
            pack.active_version ?? (isUnknown ? undefined : pack.version),
          repository: pack.reference,
          files: pack.files,
          channel: pack.channel ?? channel,
          mode: pack.mode ?? "cache",
          ui_id: pack.id ?? pack.title ?? pack.reference,
      }, base);
      if (queueOperation) queueOperation.api = used;
    },
    resetQueue: async () => {
      const base = managerBase();
      const api = await detectManagerApi(base);
      await managerFetch(`${managerApiPrefixFor(api)}/manager/queue/reset`, { method: "POST" }, base);
      queueOperation = { base, api };
    },
    startQueue: async () => {
      const base = queueOperation?.base ?? managerBase();
      const api = queueOperation?.api ?? await detectManagerApi(base);
      // Some legacy Manager 3.x builds expose /manager/queue/start as GET-only,
      // returning HTTP 405 to our POST (#551). A 405 on a Manager route is a
      // METHOD mismatch for this endpoint, not an unreachable Manager — retry the
      // same path with GET before failing so GET-only builds still start. Guard
      // the GET against ComfyUI's frontend catchall, which 200s an UNREGISTERED
      // GET with a page of HTML: that HTML is NOT a real queue start (codex
      // review), so treat it as the route not accepting our request.
      await startManagerQueueForExternal(api, base);
    },
    queueStatus: async () => {
      const base = queueOperation?.base ?? managerBase();
      const api = queueOperation?.api ?? await detectManagerApi(base);
      try {
        const res = await managerFetch(`${managerApiPrefixFor(api)}/manager/queue/status`, undefined, base);
        return (await res.json()) as ManagerQueueStatus;
      } finally {
        queueOperation = undefined;
      }
    },
  };
}

/**
 * Collect the distinct, sorted class_types referenced by a workflow. Handles
 * both the API format (object keyed by node id, each `{ class_type }`) and the
 * UI/"full" format (a `nodes` array whose entries carry a `type` field).
 *
 * Subgraph-aware via extractWorkflowClassTypes: a UI node whose `type` is a
 * subgraph definition id is an instance, not a class_type, and inner nodes
 * from `definitions.subgraphs[].nodes` are walked instead.
 */
export function collectClassTypes(
  workflow: WorkflowJSON | { nodes?: unknown },
): string[] {
  return extractWorkflowClassTypes(workflow).sort();
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

/** A `nodename_pattern` entry, plus the two verdicts #2765 needs about it. */
interface PatternClaim {
  re: RegExp;
  pack: string;
  /** The regex source, which is how a claim published twice is recognised. */
  source: string;
  /** Two different packs publish this same regex, so it selects neither. */
  contested?: boolean;
  /** Memoised isOverBroad verdict; undefined until first asked. */
  overBroad?: boolean;
}

interface MappingIndex {
  /** class_type -> pack, first writer wins (the lookup). */
  exact: Map<string, string>;
  /** class_type -> EVERY pack that exactly lists it (used to judge patterns). */
  owners: Map<string, Set<string>>;
  patterns: PatternClaim[];
}

/** Which pack claimed a class_type, and on what evidence. */
interface MappingHit {
  pack: string;
  /** `exact`: the publisher listed this class name. `pattern`: a regex matched. */
  via: "exact" | "pattern";
}

/**
 * Build a class_type -> pack lookup from Manager mappings.
 *
 * TWO KINDS OF CLAIM, and #2765 is what happens when they are treated as one.
 * An entry's `nodename_pattern` is a regex any publisher may put in the catalogue;
 * an entry's class-name list is that publisher naming its own classes. The first
 * is a heuristic, the second is a statement. They were being consulted as equals.
 *
 * `owners` exists only to judge the patterns: it records EVERY pack that exactly
 * lists a class name, not just the first (which is what `exact` keeps, and what
 * makes `exact` unusable for this — a pack losing the first-writer race would
 * look like a stranger to its own nodes).
 */
function buildMappingIndex(mappings: ManagerMappings): MappingIndex {
  const exact = new Map<string, string>();
  const owners = new Map<string, Set<string>>();
  const patterns: PatternClaim[] = [];
  const bySource = new Map<string, Set<string>>();
  for (const [repoOrId, value] of Object.entries(mappings)) {
    if (!Array.isArray(value)) continue;
    const [classNames, meta] = value;
    const pack = (meta && meta.title) || repoOrId;
    if (Array.isArray(classNames)) {
      for (const cn of classNames) {
        if (typeof cn !== "string") continue;
        if (!exact.has(cn)) exact.set(cn, pack);
        let set = owners.get(cn);
        if (!set) owners.set(cn, (set = new Set()));
        set.add(pack);
      }
    }
    const pattern = meta?.nodename_pattern;
    if (typeof pattern === "string" && pattern) {
      try {
        patterns.push({ re: new RegExp(pattern), pack, source: pattern });
        let packs = bySource.get(pattern);
        if (!packs) bySource.set(pattern, (packs = new Set()));
        packs.add(pack);
      } catch {
        // Ignore malformed patterns from the Manager DB.
      }
    }
  }
  // A regex published by two different packs cannot select between them, so it
  // selects nothing. Measured against the live catalogue this drops three:
  // `_jru$`, `Inspire$` and `- Ostris$` are each claimed twice.
  for (const p of patterns) p.contested = (bySource.get(p.source)?.size ?? 1) > 1;
  return { exact, owners, patterns };
}

/**
 * Is this pattern claiming mostly OTHER packs' nodes?
 *
 * A per-pack pattern (` \(rgthree\)$`, ` \[Crystools\]$`) matches names its own
 * pack owns. A pattern that mostly matches names some OTHER entry explicitly
 * lists is not describing a namespace — it is capturing one. Measured against the
 * live catalogue (40,656 known class names, 39 patterns), four are that shape,
 * and they are not marginal: `Hunyuan` takes 182 of the 188 names it matches from
 * other packs, and one entry's `Inspire$` takes all 101 of Inspire Pack's.
 *
 * MIN_JUDGED exists because a majority of one is not evidence. rgthree's pattern
 * matches exactly one known name, and that name went to another pack in the
 * first-writer race above; judging it on that would refuse a good pattern for a
 * bookkeeping artefact.
 *
 * Lazy and memoised: the scan is patterns x known-names, and it only ever runs
 * for a pattern that actually matched a class_type the caller asked about.
 */
function isOverBroad(p: PatternClaim, index: MappingIndex): boolean {
  if (p.overBroad !== undefined) return p.overBroad;
  const MIN_JUDGED = 5;
  let total = 0;
  let foreign = 0;
  for (const [name, packs] of index.owners) {
    if (!p.re.test(name)) continue;
    total += 1;
    if (!packs.has(p.pack)) foreign += 1;
  }
  return (p.overBroad = total >= MIN_JUDGED && foreign * 2 > total);
}

/**
 * Which pack claims this class_type, and on what evidence.
 *
 * Exact first, and an exact hit ends it — a publisher naming its own class beats
 * every regex. Otherwise the usable patterns vote, and they must be unanimous:
 * two packs matching one name is a question this cannot answer, and answering it
 * anyway is #2765 (four unrelated nodes came back owned by one pack, and the
 * readiness result then said that pack was missing — one step from installing
 * unrelated third-party code).
 */
function resolveFromMappings(classType: string, index: MappingIndex): MappingHit | null {
  const exact = index.exact.get(classType);
  if (exact) return { pack: exact, via: "exact" };
  const packs = new Set<string>();
  for (const p of index.patterns) {
    if (p.contested) continue;
    if (!p.re.test(classType)) continue;
    if (isOverBroad(p, index)) continue;
    packs.add(p.pack);
  }
  if (packs.size !== 1) return null;
  return { pack: [...packs][0], via: "pattern" };
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
  let mappingIndex: MappingIndex = {
    exact: new Map(),
    owners: new Map(),
    patterns: [],
  };
  // #1136 — this catch used to be the whole story: log at warn, carry on, and
  // let every unmapped class_type render as "neither installed nor known to
  // ComfyUI-Manager". We KNOW Manager was never consulted -- we are holding the
  // exception -- and we asserted absence anyway. A warn line is not a user-
  // facing answer; the caller reads the tool result.
  let mappingsUnavailable: string | undefined;
  try {
    const raw = await deps.fetchManagerMappings();
    mappingIndex = buildMappingIndex(raw);
    if (mappingIndex.exact.size === 0 && mappingIndex.patterns.length === 0) {
      // A 200 carrying nothing is the same situation with no exception to hold:
      // Manager answered, but with no mappings to match against.
      // Distinguish "the response was empty" from "we could not read it".
      // buildMappingIndex skips any entry whose value is not an Array, so a v4
      // shape difference yields an empty index from a NON-empty body -- and
      // calling that "came back EMPTY" asserts something about the response we
      // never checked, which is this issue's own defect class one endpoint over.
      const empty = !raw || typeof raw !== "object" || Object.keys(raw).length === 0;
      mappingsUnavailable = empty
        ? "The ComfyUI-Manager node mappings came back EMPTY, so nothing below was matched against " +
          "the catalogue. This is NOT evidence that these node types are unknown to Manager."
        : "The ComfyUI-Manager node mappings response carried no usable entries, so nothing below " +
          "was matched against the catalogue. This is NOT evidence that these node types are " +
          "unknown to Manager.";
    }
  } catch (err) {
    logger.warn("ComfyUI-Manager mappings unavailable; relying on /object_info only", {
      error: err instanceof Error ? err.message : String(err),
    });
    mappingsUnavailable =
      `The ComfyUI-Manager node mappings could not be fetched (${err instanceof Error ? err.message : String(err)}), ` +
      `so nothing below was matched against the catalogue. This is NOT evidence that these node types ` +
      `are unknown to Manager -- only /object_info was consulted. Manager reaches the registry from the ` +
      `ComfyUI host, so a blocked or filtered network there looks exactly like "not found" here.`;
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
      // Installed custom node. #2765 — /object_info's python_module names the pack
      // whose code is ACTUALLY LOADED, which is the strongest evidence available
      // about ownership, and it was being overwritten by a catalogue guess. An
      // EXACT catalogue entry may still supply the friendlier name, because that is
      // the publisher naming its own class; a regex may not, because it is a
      // heuristic owned by whoever published it and the loaded module is not.
      const hit = resolveFromMappings(classType, mappingIndex);
      const named = hit?.via === "exact" ? hit.pack : null;
      dependencies.push({
        class_type: classType,
        pack: named ?? pack,
        builtin: false,
        installed: true,
        source: named ? "manager_mappings" : "object_info",
      });
      continue;
    }

    // Not installed: only the Manager mapping can tell us the owning pack, and
    // there is no python_module to check it against. Report WHICH kind of claim
    // answered — a regex match is materially weaker than a publisher listing its
    // own class name, and install_deps acts on this.
    const hit = resolveFromMappings(classType, mappingIndex);
    dependencies.push({
      class_type: classType,
      pack: hit?.pack ?? null,
      builtin: false,
      installed: false,
      source: hit ? (hit.via === "exact" ? "manager_mappings" : "manager_pattern") : "unresolved",
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
    ...(mappingsUnavailable && unresolved.length > 0
      ? { mappings_unavailable: mappingsUnavailable }
      : {}),
    // panel#890 — the third state. The two caveats above fire on an OBSERVED failure
    // (empty list, caught exception); a catalogue served from Manager's bundled copy
    // presents as success, so neither fires and `unresolved` used to go out bare.
    ...(managerCatalogueCurrencyUnverified({
      unresolvedCount: unresolved.length,
      mappingsUnavailable,
    })
      ? { catalogue_currency_unverified: MANAGER_CATALOGUE_CURRENCY_CAVEAT }
      : {}),
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
      // panel#890 (codex round 2, P1) — this early return emits `unresolved` too, and
      // it used to emit it BARE. Nothing is installed on this path, so it reads as the
      // most settled answer of the three, and "not found in ComfyUI-Manager" with no
      // qualification is exactly the reading the caveat exists to prevent. Carried over
      // from the analysis rather than recomputed: the analysis is where the catalogue
      // was actually consulted.
      ...(analysis.catalogue_currency_unverified
        ? { catalogue_currency_unverified: analysis.catalogue_currency_unverified }
        : {}),
      // The STRONGER caveat too (codex round 4). The currency one yields to it, so
      // dropping it here left this path with neither.
      ...(analysis.mappings_unavailable
        ? { mappings_unavailable: analysis.mappings_unavailable }
        : {}),
    };
  }

  // A dependency install can name the panel exactly like a generic node tool.
  // Hold the shared guard across the entire queue transaction whenever that is
  // true: a one-off assert here would reopen the same check-then-queue race the
  // generic mutation services fixed. Non-panel workflows intentionally do not
  // take this lock, so ordinary dependency installs do not contend with pins.
  const panelTarget = analysis.missingPacks.find(targetsPanelPackExactly);
  if (panelTarget) {
    return withPanelPinGuard("install workflow dependencies including", panelTarget, () =>
      installWorkflowDependenciesForAnalysis(analysis, deps),
    );
  }
  return installWorkflowDependenciesForAnalysis(analysis, deps);
}

export async function installWorkflowDependenciesForAnalysis(
  analysis: ExtractDepsResult,
  deps: WorkflowDepsDeps,
): Promise<InstallDepsResult> {

  // Match missing packs to concrete Manager list entries for install payloads,
  // capturing the channel the list resolved against.
  const { channel = "default", packs, directInstall = false } = await deps.fetchManagerList();
  // #1136 — an EMPTY legacy catalogue is not "these packs do not exist".
  //
  // Manager's /customnode/getlist returns dict(channel, node_packs) with no
  // error and no staleness field, and it is called with mode=cache +
  // skip_update=true, so a user whose registry is blocked or filtered gets a
  // healthy HTTP 200 carrying an empty cache. We cannot see their DNS failure:
  // it happened inside ComfyUI's process.
  //
  // What we CAN see is that a healthy legacy catalogue carries thousands of
  // entries, so zero on a non-local channel is a strong local signal. Without
  // this, every pack falls to `unresolved` and renders as "neither installed
  // nor known to ComfyUI-Manager" / "Not found in ComfyUI-Manager" -- the
  // reported harm verbatim, in the surface the reporting user was sent to
  // three times.
  //
  // Deliberately NOT phrased as a diagnosis of their network. We do not know
  // it is blocked; we know the catalogue is empty and that this is not the
  // same fact as absence.
  const catalogueEmpty = !directInstall && channel !== "local" && packs.length === 0;
  const byKey = new Map<string, ManagerNodePack>();
  for (const p of packs) {
    for (const key of [p.id, p.title, p.reference]) {
      if (key && !byKey.has(key)) byKey.set(key, p);
    }
  }

  const toInstall: ManagerNodePack[] = [];
  const installed: string[] = [];
  const unresolved = [...analysis.unresolved];
  // The sidebar panel pack NEVER goes through this transaction. The Manager
  // target resolved for a workflow dependency may differ from the local root
  // used to establish which panel the browser serves; accepting either one as
  // proof would permit an unverified update or fabricate success. Keep it
  // unresolved and require install_comfyui(action:'panel') on the selected ComfyUI host instead.
  const panelTargets: string[] = [];
  const panelNotes: string[] = [];
  for (const pack of analysis.missingPacks) {
    if (targetsPanelPackExactly(pack)) {
      panelTargets.push(pack);
      unresolved.push(pack);
      continue;
    }
    const entry = byKey.get(pack);
    if (!entry) {
      // Manager v4 removed the legacy getlist catalog endpoint. Its task API
      // resolves a registry/repository id directly, so an empty catalog is the
      // v4 signal to enqueue that id rather than falsely claim it is unresolved.
      if (directInstall) {
        toInstall.push({ id: pack, version: "latest" });
        installed.push(pack);
        continue;
      }
      unresolved.push(pack);
      continue;
    }
    toInstall.push(entry);
    installed.push(pack);
  }

  // Even under the outer pin guard, this workflow transaction cannot bind its
  // Manager target to a served-panel root. Do not re-add panel targets to the
  // generic queue (especially in remote mode), and do not inspect/mutate the
  // process-global panel root for a possibly different Manager target.
  for (const pack of panelTargets) {
    panelNotes.push(
      `"${pack}" is the sidebar panel pack: workflow dependency installation does not queue or mutate it ` +
        `because this Manager transaction cannot prove the same served-panel target. ` +
        `Use install_comfyui(action:'panel') on the selected ComfyUI host.`,
    );
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
    // Gated on there being something to mislead about. Round 3 caught a comment
    // here claiming this gate existed when it did not -- the field's own
    // docblock says callers rendering `unresolved` must surface it, so setting
    // it with an empty `unresolved` contradicts the contract.
    ...(catalogueEmpty && unresolved.length > 0
      ? {
          catalogue_unavailable:
            `The ComfyUI-Manager catalogue came back EMPTY (channel "${channel}"), so nothing below ` +
            `was actually looked up. A healthy catalogue carries thousands of entries, so this is ` +
            `almost certainly a catalogue that could not be refreshed -- NOT evidence that these ` +
            `packs do not exist. Manager fetches the registry from the ComfyUI host itself, so a ` +
            `blocked or filtered network there looks exactly like an empty result here. Refresh the ` +
            `Manager list on that host before concluding anything from "not found".`,
        }
      : {}),
    ...(managerCatalogueCurrencyUnverified({
      unresolvedCount: unresolved.length,
      catalogueUnavailable: catalogueEmpty ? "empty" : undefined,
      mappingsUnavailable: analysis.mappings_unavailable,
    })
      ? { catalogue_currency_unverified: MANAGER_CATALOGUE_CURRENCY_CAVEAT }
      : {}),
    // Same gap on this path: the analysis's mappings failure never reached the reply.
    ...(analysis.mappings_unavailable
      ? { mappings_unavailable: analysis.mappings_unavailable }
      : {}),
    ...(panelNotes.length ? { panel_notes: panelNotes } : {}),
  };
}

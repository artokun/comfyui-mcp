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
  /** The key `/customnode/getlist` filed this entry under (absent for an array-shaped list). */
  listKey?: string;
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
  /**
   * How the pack was resolved (for transparency). `manager_mappings` means a catalogue
   * entry LISTS this class by name; `manager_pattern` means only a pack's
   * `nodename_pattern` matched it — a naming convention, inferred rather than listed.
   */
  source: "object_info" | "manager_mappings" | "manager_pattern" | "unresolved";
  /**
   * #2765 — the catalogue key (repository URL or registry id) the Manager resolution
   * named. This, not `pack` (a display name), is what install_deps binds the install to.
   * Absent when ownership came from /object_info or was not resolved.
   */
  repository?: string;
  /**
   * #2765 — set when the catalogue names more than one repository for this class and
   * nothing here can tell which is right. `pack` is then null: picking one would be a guess.
   */
  claimants?: string[];
}

/** #2765 — a class_type the catalogue attributes to several repositories. */
export interface AmbiguousOwnership {
  class_type: string;
  /** Catalogue keys (repository URL or registry id) of every claimant, sorted. */
  claimants: string[];
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
   * #2765 — the subset of `unresolved` that IS known to the catalogue, but to more than
   * one repository. Present only when non-empty.
   */
  ambiguous?: AmbiguousOwnership[];
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
  /** #2765 — the analysis's `ambiguous`, carried through: claimed by several repositories, so not queued. */
  ambiguous?: AmbiguousOwnership[];
  /** #2765 — missing packs (also in `unresolved`) that were not bound to exactly one install target, and why. */
  target_refusals?: Array<{ pack: string; reason: string }>;
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

/**
 * The install task the default adapter sends for one Manager list entry. Shared with
 * installTargetRefusal so the target that is validated is the one that is sent.
 */
export function managerInstallParams(pack: ManagerNodePack, channel: string) {
  // A plain/non-registry pack (git URL, no registry version) must route on
  // version === "unknown"; a registry pack installs its catalog version.
  const isUnknown = !pack.version || pack.version === "unknown";
  return {
    id: pack.id,
    version: isUnknown ? "unknown" : pack.version,
    selected_version: pack.active_version ?? (isUnknown ? undefined : pack.version),
    repository: pack.reference,
    files: pack.files,
    channel: pack.channel ?? channel,
    mode: pack.mode ?? "cache",
    ui_id: pack.id ?? pack.title ?? pack.reference,
  };
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
        // Fold the dict key into each entry's id when missing, and keep the key itself:
        // Manager resolves an unknown-version install through it (#2765).
        packs: Object.entries(packs).map(([key, p]) => ({ id: p.id ?? key, ...p, listKey: key })),
      };
    },
    queueInstall: async (pack, channel) => {
      const base = queueOperation?.base ?? managerBase();
      const used = await enqueueManagerTaskForExternal("install", managerInstallParams(pack, channel), base);
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

/**
 * #2765 — a `nodename_pattern` is a naming convention a pack publishes, not an ownership
 * record: anyone may publish one about anyone. One catalogue entry published `.*` with no
 * listed classes and was named the owner of every class the catalogue did not list.
 *
 * A pattern is discarded when it visibly constrains nothing: it has no literal letter or
 * digit outside character classes and escapes (`.*`, `^[^\x00]+$`, `\w+`), or it matches
 * one of these generic probes (`Foo|.*`, `(?:Foo)?`). This is a HEURISTIC that removes the
 * forms known to attribute everything; passing it proves nothing about ownership. Nor does
 * resolveFromMappings prove it: naming an owner only when no other repository claims the
 * class stops a choice among competing claims, but an uncontested claim can still be wrong.
 * That is why a pattern-only answer is labelled `manager_pattern`.
 */
const GENERIC_PROBES = ["", "\u0000comfyui-mcp:no-pack-names-this\u0000", "x", "KSampler", "Load Image", "ノード"];

/** True when `source` has a literal letter/digit outside character classes, class escapes and group syntax. */
function hasLiteralWord(source: string): boolean {
  let literal = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      const n = source[i + 1] ?? "";
      if ((n === "p" || n === "P") && source[i + 2] === "{") {
        i = source.indexOf("}", i);
        if (i < 0) return false;
      } else if (n === "k" && source[i + 2] === "<") {
        i = source.indexOf(">", i);
        if (i < 0) return false;
      } else if (n === "x") i += 3;
      else if (n === "u") i += 5;
      else if (n === "c") i += 2;
      else if (/[dDwWsSbBnrtfv0-9]/.test(n)) i += 1;
      else {
        literal += n;
        i += 1;
      }
    } else if (c === "[") {
      // Skip the whole class, honouring escapes inside it.
      for (i++; i < source.length && source[i] !== "]"; i++) if (source[i] === "\\") i++;
    } else if (c === "(" && source[i + 1] === "?") {
      // (?: (?= (?! (?<= (?<! and (?<name> — group syntax, not content.
      if (source[i + 2] === "<" && source[i + 3] !== "=" && source[i + 3] !== "!") {
        i = source.indexOf(">", i);
        if (i < 0) return false;
      } else i += source[i + 2] === "<" ? 3 : 2;
    } else if (c === "{" && /^\{\d*,?\d*\}/.test(source.slice(i))) {
      i = source.indexOf("}", i);
    } else literal += c;
  }
  return /[\p{L}\p{N}]/u.test(literal);
}

function constrainsNothing(re: RegExp): boolean {
  return !hasLiteralWord(re.source) || GENERIC_PROBES.some((probe) => re.test(probe));
}

/** Class_type -> claimant lookup from Manager mappings, keyed by catalogue key (repo URL or registry id). */
interface MappingIndex {
  /** class_type -> every catalogue key that LISTS it. */
  exact: Map<string, Set<string>>;
  patterns: Array<{ re: RegExp; repo: string; overBroad?: boolean }>;
  /**
   * catalogue key -> the pack name this module reports: the Manager title when no other
   * entry shares it or uses it as a key, otherwise the key itself, so two repositories
   * are never reported (or installed) under one name.
   */
  names: Map<string, string>;
}

function buildMappingIndex(mappings: ManagerMappings): MappingIndex {
  const exact = new Map<string, Set<string>>();
  const patterns: MappingIndex["patterns"] = [];
  const titles = new Map<string, string>();
  for (const [repoOrId, value] of Object.entries(mappings)) {
    if (!Array.isArray(value)) continue;
    const [classNames, meta] = value;
    titles.set(repoOrId, (meta && meta.title) || repoOrId);
    if (Array.isArray(classNames)) {
      for (const cn of classNames) {
        if (typeof cn !== "string") continue;
        const owners = exact.get(cn) ?? new Set<string>();
        owners.add(repoOrId);
        exact.set(cn, owners);
      }
    }
    const pattern = meta?.nodename_pattern;
    if (typeof pattern === "string" && pattern) {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        // Ignore malformed patterns from the Manager DB.
        continue;
      }
      if (!constrainsNothing(re)) patterns.push({ re, repo: repoOrId });
    }
  }
  const uses = new Map<string, number>();
  for (const [key, title] of titles) {
    uses.set(title, (uses.get(title) ?? 0) + 1);
    if (title !== key) uses.set(key, (uses.get(key) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  for (const [key, title] of titles) names.set(key, uses.get(title) === 1 ? title : key);
  return { exact, patterns, names };
}

/**
 * Manager applies patterns as a SEARCH (`regex.test` in its missing-node finder,
 * `re.search` in its workflow scan), so `" \(rgthree\)$"` stays a suffix convention.
 *
 * HEURISTIC, not an ownership proof: a pattern matching classes that two or more OTHER
 * repositories list is treated as too broad to be one pack's convention and contributes
 * no claim (`Hunyuan` matched 185 classes of 45 other packs). A pattern with a single
 * foreign collision is kept, so that collision surfaces as ambiguity in
 * resolveFromMappings instead of being settled here. A class the pattern's own
 * repository also lists still counts: co-listing does not make the other listers less
 * foreign. Computed lazily: only patterns that match a workflow class are measured.
 */
function isOverBroad(p: MappingIndex["patterns"][number], index: MappingIndex): boolean {
  if (p.overBroad !== undefined) return p.overBroad;
  const foreign = new Set<string>();
  for (const [cn, owners] of index.exact) {
    if (!p.re.test(cn)) continue;
    for (const o of owners) if (o !== p.repo) foreign.add(o);
    if (foreign.size >= 2) break;
  }
  p.overBroad = foreign.size >= 2;
  return p.overBroad;
}

type MappingResolution =
  | { kind: "none" }
  | { kind: "owner"; repo: string; via: "exact" | "pattern" }
  | { kind: "ambiguous"; claimants: string[] };

/**
 * #2765 — name an owner only when exactly one repository claims the class, counting every
 * listing and every retained pattern. Any second claimant, listed or pattern-only, with
 * an identical pattern or a different one, makes the result ambiguous: nothing here can
 * tell which claim is right, and a repository adding a pattern that matches its own
 * listing is not independent evidence. Never first-wins; independent of catalogue order.
 */
function resolveFromMappings(classType: string, index: MappingIndex): MappingResolution {
  const listed = index.exact.get(classType) ?? new Set<string>();
  const claimants = new Set(listed);
  for (const p of index.patterns) {
    if (p.re.test(classType) && !isOverBroad(p, index)) claimants.add(p.repo);
  }
  const sorted = [...claimants].sort();
  if (sorted.length === 0) return { kind: "none" };
  if (sorted.length > 1) return { kind: "ambiguous", claimants: sorted };
  return { kind: "owner", repo: sorted[0], via: listed.has(sorted[0]) ? "exact" : "pattern" };
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
  let mappingIndex: MappingIndex = { exact: new Map(), patterns: [], names: new Map() };
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
      if (pack) {
        // #2765 — the directory the node loaded from is what /object_info proves, and the
        // one fact the catalogue cannot launder (Manager's getmappings appends installed-
        // but-unlisted classes to every pack whose pattern matches them). It names a
        // directory, not a repository, so no catalogue entry is bound to it here.
        dependencies.push({
          class_type: classType,
          pack,
          builtin: false,
          installed: true,
          source: "object_info",
        });
        continue;
      }
      // Installed, but /object_info gave no usable python_module: the catalogue is all
      // there is, under the same rules as a node that is not installed.
    }

    const resolution = resolveFromMappings(classType, mappingIndex);
    const fallback = installed ? "object_info" : "unresolved";
    dependencies.push({
      class_type: classType,
      pack: resolution.kind === "owner" ? (mappingIndex.names.get(resolution.repo) ?? resolution.repo) : null,
      builtin: false,
      installed,
      source:
        resolution.kind === "owner"
          ? resolution.via === "exact" ? "manager_mappings" : "manager_pattern"
          : fallback,
      ...(resolution.kind === "owner" ? { repository: resolution.repo } : {}),
      ...(resolution.kind === "ambiguous" ? { claimants: resolution.claimants } : {}),
    });
  }

  const requiredPackSet = new Set<string>();
  const missingPackSet = new Set<string>();
  const unresolved: string[] = [];
  const ambiguous: AmbiguousOwnership[] = [];

  for (const dep of dependencies) {
    if (dep.builtin) continue;
    if (dep.pack) {
      requiredPackSet.add(dep.pack);
      if (!dep.installed) missingPackSet.add(dep.pack);
    } else if (!dep.installed) {
      unresolved.push(dep.class_type);
      if (dep.claimants) ambiguous.push({ class_type: dep.class_type, claimants: dep.claimants });
    }
  }

  return {
    classTypes,
    dependencies,
    requiredPacks: [...requiredPackSet].sort(),
    missingPacks: [...missingPackSet].sort(),
    unresolved: unresolved.sort(),
    // dependencies follow the sorted classTypes, so this is already in class_type order.
    ...(ambiguous.length > 0 ? { ambiguous } : {}),
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
      ...(analysis.ambiguous ? { ambiguous: analysis.ambiguous } : {}),
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
  const panelTarget =
    analysis.missingPacks.find(targetsPanelPackExactly) ??
    [...missingPackRepositories(analysis).values()].flat().find(targetsPanelPackExactly);
  if (panelTarget) {
    return withPanelPinGuard("install workflow dependencies including", panelTarget, () =>
      installWorkflowDependenciesForAnalysis(analysis, deps),
    );
  }
  return installWorkflowDependenciesForAnalysis(analysis, deps);
}

/** #2765 — missing pack name -> the distinct catalogue keys the analysis resolved it to. */
function missingPackRepositories(analysis: ExtractDepsResult): Map<string, string[]> {
  const byPack = new Map<string, Set<string>>();
  for (const dep of analysis.dependencies) {
    if (dep.installed || !dep.pack || !dep.repository) continue;
    const repos = byPack.get(dep.pack) ?? new Set<string>();
    repos.add(dep.repository);
    byPack.set(dep.pack, repos);
  }
  return new Map([...byPack].map(([pack, repos]) => [pack, [...repos].sort()]));
}

function isRepositoryUrl(key: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(key) || key.startsWith("git@");
}

/**
 * #2765 — check what a legacy Manager would actually install for `entry` against the
 * resolved repository `repo`. A matching `id`, `reference` or `files` member only selects
 * the entry. The target is set by the task managerInstallParams sends and by how the
 * /manager/queue/install worker reads it (Comfy-Org/ComfyUI-Manager glob/manager_server.py
 * _queue_node_install, glob/manager_core.py install_by_id / get_custom_nodes):
 *  - version "unknown" (git): the worker takes basename(files[0]), looks that name up among
 *    its own getlist keys (case-insensitively) and clones that entry's files[0].
 *  - otherwise (registry, nightly included): it installs registry id `id`. Manager itself
 *    gave the entry that id from its single `files` URL (get_cnr_by_repo), which is the
 *    binding accepted when `repo` is a URL rather than the id.
 * An entry naming several repositories is refused in every mode. Returns the reason the
 * entry must not be queued, or null when its install target is `repo`.
 */
function installTargetRefusal(
  entry: ManagerNodePack,
  repo: string,
  packs: ManagerNodePack[],
  channel: string,
): string | null {
  const files = entry.files ?? [];
  if (files.length > 1)
    return `its Manager install descriptor names ${files.length} repositories (${files.join(", ")}), so none was queued`;
  const task = managerInstallParams(entry, channel);
  const gitInstall = task.version === "unknown";
  // Where the descriptor is bound to `repo` by URL, a reference naming another repository
  // contradicts it. (A registry-id binding is unaffected: its reference is registry metadata.)
  if ((gitInstall || files[0] === repo) && task.repository !== undefined && task.repository !== repo)
    return `its Manager install descriptor names both ${files[0] ?? "no clone URL"} and ${task.repository}, so it was not queued`;
  if (gitInstall) {
    if (files[0] !== repo)
      return `its Manager install descriptor would clone ${files[0] ?? "nothing"}, not ${repo}, so it was not queued`;
    const name = (repo.split("/").pop() ?? "").trim().toLowerCase();
    const resolvedBy = packs.filter((p) => (p.listKey ?? p.id ?? "").trim().toLowerCase() === name);
    if (resolvedBy.length !== 1 || resolvedBy[0] !== entry)
      return `Manager resolves this git install by the name "${name}", which does not select exactly this descriptor, so it was not queued`;
    return null;
  }
  if (task.id === repo) return null;
  if (isRepositoryUrl(repo) && files[0] === repo) return null;
  return `its Manager install descriptor installs registry id ${task.id ?? "(none)"}, which is not bound to ${repo}, so it was not queued`;
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
  const targets = missingPackRepositories(analysis);

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
  const targetRefusals: Array<{ pack: string; reason: string }> = [];
  for (const pack of analysis.missingPacks) {
    const repos = targets.get(pack) ?? [];
    if (targetsPanelPackExactly(pack) || repos.some(targetsPanelPackExactly)) {
      panelTargets.push(pack);
      unresolved.push(pack);
      continue;
    }
    // #2765 — install exactly the repository the analysis resolved. `pack` is a display
    // name; looking it up by name let a different entry sharing that title (or using it
    // as an id) be queued instead, first one wins.
    if (repos.length !== 1) {
      unresolved.push(pack);
      targetRefusals.push({
        pack,
        reason:
          repos.length === 0
            ? "no resolved repository identity, so it was not queued"
            : `resolved to several repositories (${repos.join(", ")}), so none was queued`,
      });
      continue;
    }
    const [repo] = repos;
    if (directInstall) {
      // Manager v4 removed the legacy getlist catalog endpoint; its task API resolves a
      // registry id directly. A full git URL is not one — v4 looks it up, matches
      // nothing and marks the task done — so a URL-keyed pack is left unresolved.
      if (isRepositoryUrl(repo)) {
        unresolved.push(pack);
        targetRefusals.push({
          pack,
          reason:
            `known only by its repository URL (${repo}); Manager v4 installs by registry id, so it was ` +
            `not queued. Install it from that repository instead`,
        });
        continue;
      }
      toInstall.push({ id: repo, version: "latest" });
      installed.push(pack);
      continue;
    }
    const matches = packs.filter((p) => p.id === repo || p.reference === repo || (p.files ?? []).includes(repo));
    if (matches.length !== 1) {
      unresolved.push(pack);
      targetRefusals.push({
        pack,
        reason:
          matches.length === 0
            ? `no Manager install descriptor names ${repo}, so it was not queued`
            : `${repo} matches ${matches.length} Manager list entries, so none was queued`,
      });
      continue;
    }
    // Matching selected the descriptor; it does not show what the descriptor installs.
    const refusal = installTargetRefusal(matches[0], repo, packs, channel);
    if (refusal) {
      unresolved.push(pack);
      targetRefusals.push({ pack, reason: refusal });
      continue;
    }
    if (!toInstall.includes(matches[0])) toInstall.push(matches[0]);
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
    ...(analysis.ambiguous ? { ambiguous: analysis.ambiguous } : {}),
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
    ...(targetRefusals.length ? { target_refusals: targetRefusals } : {}),
  };
}

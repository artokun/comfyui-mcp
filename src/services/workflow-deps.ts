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
  source: "object_info" | "manager_mappings" | "ambiguous" | "unresolved";
  /**
   * #2765 — every pack the Manager catalogue claims owns this class_type, set
   * only when `source` is "ambiguous". `pack` stays null in that case: naming
   * one of several claimants is the defect, not the answer.
   */
  candidates?: string[];
}

/** #2765 — a class_type the catalogue attributes to more than one pack. */
export interface AmbiguousDependency {
  class_type: string;
  /** Catalogue KEYS of every claimant — the identity, not the display title. */
  candidates: string[];
  /**
   * Whether the node is already present on the server. An ambiguous node can be
   * INSTALLED (its /object_info entry carries no python_module, so only the
   * catalogue can name its pack) — telling that reader to go install something
   * is wrong, since nothing needs installing (codex gate round 4).
   */
  installed: boolean;
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
   * #2765 — class_types the catalogue attributes to SEVERAL packs. Distinct from
   * `unresolved`, which is rendered as "neither installed nor known to
   * ComfyUI-Manager" — a sentence that is false for these: Manager knows them
   * too well, by more than one owner. Never auto-installed.
   */
  ambiguous: AmbiguousDependency[];
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
  /**
   * #2765 — class_types with several claimant packs. NOT installed: picking one
   * of several unrelated repositories is exactly the harm reported. The caller
   * is given the candidates and must choose.
   */
  ambiguous: AmbiguousDependency[];
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

/**
 * #2765 — strings no ComfyUI node pack can own, used to detect a
 * `nodename_pattern` that is not actually a test for anything. A pattern that
 * matches one of these matches everything.
 *
 * Measured against the live catalogue: this rejects `.*`, `.+`, `.`, `^`,
 * `(?:)`, `a|.*`, `\w*` and `[\s\S]*`, and rejects NONE of the 39 real
 * `nodename_pattern` entries — so it removes catch-alls at no cost to genuine
 * resolution. The NUL probe must stay written as a \u0000 ESCAPE, never as the
 * byte itself: a raw control byte in a tracked source file trips the repo's own
 * no-stray-control-bytes gate.
 */
const OWNERSHIP_PROBES = [
  "\u0000",
  "\u0000zz-comfyui-mcp-ownership-probe-zz",
  "zz-comfyui-mcp-ownership-probe-zz",
  // Shaped like real ComfyUI class names — PascalCase, snake_case, and the two
  // tag conventions. A pattern broad enough to match a name it has never seen is
  // broad by SHAPE, and this catches it WITHOUT consulting the catalogue, which
  // is what makes it work when the catalogue is too thin to be a control: against
  // a near-empty catalogue the foreign-owner veto below has nothing to compare
  // with, and absence of evidence was reading as evidence of narrowness.
  // Rejects ^[A-Z] and its relatives; keeps all 39 real catalogue patterns.
  "ZzqxOwnershipProbeNode",
  "zzqx_ownership_probe_node",
  "Zzqx Ownership Probe (zzqx)",
  "Zzqx Ownership Probe [zzqx]",
];

interface MappingIndex {
  /** class_type -> pack, for names claimed by exactly ONE catalogue entry. */
  exact: Map<string, string>;
  /**
   * class_type -> EVERY catalogue key that exactly lists it, not just the first.
   *
   * `exact` keeps only the first writer, which makes it unusable for judging a
   * pattern: a pack that lost the first-writer race would look like a stranger
   * to its own node, and a name claimed by two rivals would present as one
   * (codex gate round 4 — a pattern matching two repositories was accepted
   * because only one of them had been recorded).
   */
  owners: Map<string, Set<string>>;
  /**
   * `key` is the catalogue key (repository identity); `pack` is only the label.
   * Claimants must be counted by KEY — two distinct repositories can carry the
   * same `title`, and deduping on the label would silently merge them back into
   * one "unambiguous" owner.
   *
   * `broad` is the memoized verdict from `patternIsBroad`, computed lazily
   * because most analyses never reach a pattern at all.
   */
  patterns: Array<{ re: RegExp; pack: string; key: string; broad?: boolean }>;
}

/**
 * #2765 — is this `nodename_pattern` describing a TOPIC rather than an owner?
 *
 * A tag pattern (` \(mtb\)$`, `^ttN `, ` \[Crystools\]$`) matches its own pack's
 * nodes and nobody else's. A substring pattern (`Hunyuan`) sweeps up whatever
 * the ecosystem happens to have named that way.
 *
 * The separator is the number of DISTINCT other packs whose exactly-owned class
 * names the pattern captures, and on the live catalogue it separates perfectly:
 *
 *   0 foreign owners: 29 patterns — every well-formed tag pattern
 *   1 foreign owner:   7 patterns — each a fork/sibling by the SAME author
 *                                   (`_jru$`, `- Ostris$`, ` \(rgthree\)$`)
 *   2+ foreign owners: 3 patterns — `Inspire$` from connection-helper (101
 *                                   names), `PulidFlux` (13), `Hunyuan` (182)
 *
 * So "2+ independent owners" is not a tuned threshold: one collision is a fork
 * of the same project, two or more is a claim staked across the ecosystem. It
 * also catches the shapes the probe cannot, such as `^[A-Z][A-Za-z0-9_()]*$` —
 * a pattern that looks like a class name and matches thousands of them.
 *
 * Counting stops at the second owner, so a broad pattern is rejected early.
 */
function patternIsBroad(
  entry: { re: RegExp; key: string },
  owners: Map<string, Set<string>>,
): boolean {
  const foreign = new Set<string>();
  for (const [className, claimants] of owners) {
    // A name the pattern's OWN pack lists is its namespace, not a capture —
    // even when a fork lists it too.
    if (claimants.has(entry.key)) continue;
    if (!entry.re.test(className)) continue;
    for (const claimant of claimants) {
      foreign.add(claimant);
      if (foreign.size > 1) return true;
    }
  }
  return false;
}

/** Build a class_type -> pack lookup from Manager mappings (incl. regex patterns). */
function buildMappingIndex(mappings: ManagerMappings): MappingIndex {
  const exact = new Map<string, string>();
  // Claimant IDENTITY is the catalogue key, not the display name: two distinct
  // repositories can carry the same `title`, and deduping on the display name
  // would merge them and hide the conflict.
  const owners = new Map<string, Set<string>>();
  const patterns: MappingIndex["patterns"] = [];
  for (const [repoOrId, value] of Object.entries(mappings)) {
    if (!Array.isArray(value)) continue;
    const [classNames, meta] = value;
    const pack = (meta && meta.title) || repoOrId;
    if (Array.isArray(classNames)) {
      for (const cn of classNames) {
        if (typeof cn !== "string" || !cn) continue;
        // A Set keyed on the catalogue key, so one entry listing the same name
        // twice is not a conflict and two entries always are.
        const claimants = owners.get(cn);
        if (claimants) claimants.add(repoOrId);
        else owners.set(cn, new Set([repoOrId]));
        if (!exact.has(cn)) exact.set(cn, pack);
      }
    }
    const pattern = meta?.nodename_pattern;
    if (typeof pattern === "string" && pattern) {
      try {
        const re = new RegExp(pattern);
        // #2765 — a pattern that matches a string NO pack could own does not
        // discriminate, so a hit from it is not evidence of anything. `.*`,
        // `.+`, `^`, `(?:)` and `a|.*` are all rejected here; every one of the
        // 39 patterns in the live catalogue survives, so this costs no real
        // resolution. Without it a single catch-all entry silently owns every
        // class_type the catalogue does not name — one unrelated repository
        // standing in for several distinct packs, which is this issue.
        //
        // Deliberately NOT anchored to Manager's own `re.match` semantics:
        // measured against the live catalogue, anchoring disables every
        // suffix-tag pattern — ` \(rgthree\)$`, ` \[Crystools\]$`, `\(mtb\)$`,
        // ` \(lab\)$` — i.e. precisely the well-formed ones this issue expects
        // to keep working, while `Hunyuan` still over-claims 96 names.
        if (OWNERSHIP_PROBES.some((probe) => re.test(probe))) continue;
        patterns.push({ re, pack, key: repoOrId });
      } catch {
        // Ignore malformed patterns from the Manager DB.
      }
    }
  }
  return { exact, owners, patterns };
}

/**
 * The outcome of asking the Manager catalogue who owns a class_type.
 *
 * #2765 — `ambiguous` exists because the previous `string | null` could not
 * express "several packs claim this", so the resolver silently returned
 * whichever one `Object.entries` happened to enumerate first. That is not a
 * cosmetic loss: `install_deps` feeds this name straight to the Manager task
 * API, so an arbitrary pick installs unrelated third-party code.
 */
type MappingResolution =
  | { kind: "resolved"; pack: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

function resolveFromMappings(classType: string, index: MappingIndex): MappingResolution {
  const claimants = index.owners.get(classType);
  if (claimants && claimants.size > 1) {
    // Candidates are the catalogue KEYS, not the display titles. The point of
    // listing them is that the reader can pick the right repository, and two
    // repositories can publish the same `title` — collapsing to it hands back
    // `["Same"]` and no way to choose (codex gate round 4).
    return { kind: "ambiguous", candidates: [...claimants].sort() };
  }
  const exact = index.exact.get(classType);
  if (exact) return { kind: "resolved", pack: exact };
  // A `nodename_pattern` is a naming CONVENTION, not an ownership record, so
  // two packs matching one name is a real conflict rather than a tie to break.
  // `Inspire$`, `_jru$` and `- Ostris$` are each declared by two different
  // packs in the live catalogue today.
  // #2765 (codex gate round 3) — the gate asked for a pattern-only resolution to
  // be refused when the exact index is too small for `patternIsBroad` to be a
  // real test (its repro: a one-entry catalogue declaring `Krea`, no exact names
  // at all). Deliberately NOT done, for two measured reasons:
  //
  //  - It is not a reachable production state. The live catalogue carries 40,656
  //    exactly-owned class names, so the corpus is never thin; and the case where
  //    the catalogue genuinely answers nothing is already covered upstream by
  //    `mappings_unavailable`.
  //  - It would break pattern-only packs, which are normal: 7 of the 39 packs
  //    declaring a `nodename_pattern` list NO exact class names at all, and one
  //    of them is `ComfyUI-Crystools` (` \[Crystools\]$`) — a pack this very
  //    issue names as an expected owner. Refusing to certify a pattern against a
  //    thin corpus un-resolves it.
  //
  // A bare literal like `Krea` is the catalogue author asserting their own naming
  // convention, with no rival claiming otherwise; against a real corpus the
  // foreign-owner veto below is what tests that assertion, and the shape probes
  // above catch the patterns that are broad regardless of corpus size.
  const hits = new Map<string, string>();
  for (const entry of index.patterns) {
    if (!entry.re.test(classType)) continue;
    // Lazy, memoized: most analyses never reach a pattern, and only a pattern
    // that actually matched is worth the scan.
    entry.broad ??= patternIsBroad(entry, index.owners);
    if (entry.broad) continue;
    hits.set(entry.key, entry.pack);
  }
  if (hits.size === 0) return { kind: "none" };
  if (hits.size > 1) {
    return { kind: "ambiguous", candidates: [...new Set(hits.values())].sort() };
  }
  return { kind: "resolved", pack: [...hits.values()][0] as string };
}

/** #2765 — render a catalogue answer as a dependency, refusing to pick a winner. */
function fromMapping(
  classType: string,
  resolution: MappingResolution,
  installed: boolean,
): NodeDependency {
  if (resolution.kind === "resolved") {
    return {
      class_type: classType,
      pack: resolution.pack,
      builtin: false,
      installed,
      source: "manager_mappings",
    };
  }
  if (resolution.kind === "ambiguous") {
    return {
      class_type: classType,
      pack: null,
      builtin: false,
      installed,
      source: "ambiguous",
      candidates: resolution.candidates,
    };
  }
  return {
    class_type: classType,
    pack: null,
    builtin: false,
    installed,
    source: "unresolved",
  };
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
      // #2765 — for an INSTALLED node, /object_info's python_module is ground
      // truth: it is the pack directory this class was actually imported from,
      // on the very server we are reporting about. It was previously discarded
      // in favour of a Manager match "for a friendlier name", which let a loose
      // catalogue entry rename a pack the server had already identified.
      //
      // That override is also the only defence against an amplification we
      // cannot otherwise see: Manager's own /customnode/getmappings appends
      // every installed-but-unmapped class name onto the class list of EVERY
      // pack whose nodename_pattern matches it, so an over-broad pattern is
      // laundered into an apparently-exact mapping before it reaches us. The
      // directory name cannot be laundered — it is what is on disk.
      if (pack) {
        dependencies.push({
          class_type: classType,
          pack,
          builtin: false,
          installed: true,
          source: "object_info",
        });
        continue;
      }
      // No usable python_module (some builds omit it): Manager is all we have,
      // under the same refuse-when-ambiguous rule as the not-installed path.
      dependencies.push(
        fromMapping(classType, resolveFromMappings(classType, mappingIndex), true),
      );
      continue;
    }

    // Not installed: only the Manager mapping can tell us the owning pack.
    dependencies.push(
      fromMapping(classType, resolveFromMappings(classType, mappingIndex), false),
    );
  }

  const requiredPackSet = new Set<string>();
  const missingPackSet = new Set<string>();
  const unresolved: string[] = [];
  const ambiguous: AmbiguousDependency[] = [];

  for (const dep of dependencies) {
    if (dep.builtin) continue;
    if (dep.pack) {
      requiredPackSet.add(dep.pack);
      if (!dep.installed) missingPackSet.add(dep.pack);
    } else if (dep.source === "ambiguous") {
      // #2765 — reported whether or not the node is installed: an installed
      // node whose owner we cannot pin down is still a thing we must not name.
      ambiguous.push({
        class_type: dep.class_type,
        candidates: dep.candidates ?? [],
        installed: dep.installed,
      });
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
    ambiguous: ambiguous.sort((a, b) => a.class_type.localeCompare(b.class_type)),
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
      // #2765 — carried on both return paths. An ambiguous class_type produces no
      // missing pack (we refuse to name one), so this early return is exactly the
      // path a fully-ambiguous workflow takes; dropping it here would make "no
      // packs needed installation" the whole answer.
      ambiguous: analysis.ambiguous,
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
  // #2765 — a pack name resolves to a catalogue entry here, and this is the last
  // step before an install is queued. First-wins meant an entry could be selected
  // by a key it SHARES with another entry: two unrelated repositories publishing
  // the same `title` collapsed into whichever `/getlist` listed first, and the
  // other one got installed. Refuse a colliding key instead of picking, exactly
  // as the mapping resolver now does — a name that identifies two repositories
  // identifies neither.
  const byKey = new Map<string, ManagerNodePack>();
  const collidingKeys = new Set<string>();
  for (const p of packs) {
    // Within ONE entry the three keys may legitimately repeat (id === title);
    // only a collision ACROSS entries is ambiguous.
    for (const key of new Set([p.id, p.title, p.reference])) {
      if (!key) continue;
      const seen = byKey.get(key);
      if (seen === undefined) byKey.set(key, p);
      else if (seen !== p) collidingKeys.add(key);
    }
  }
  for (const key of collidingKeys) byKey.delete(key);

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
    ambiguous: analysis.ambiguous,
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

import { createHash } from "node:crypto";
import type { WorkflowJSON } from "../comfyui/types.js";

export interface AssetImage {
  filename: string;
  subfolder: string;
  type: string;
  url: string;
}

export interface AssetOutput {
  node_id: string;
  images: AssetImage[];
}

/**
 * Provenance of a record: "watched" means this process saw the prompt complete
 * (JobWatcher); "history-reconcile" means the record was recovered from
 * ComfyUI's /history after the fact (render dispatched by the panel, an earlier
 * session, or before a server restart — see issue #751).
 */
export type AssetSource = "watched" | "history-reconcile";

/** The only directory types that ComfyUI's /view consumer can address. */
export type AssetType = "output" | "input" | "temp";

/**
 * Provenance of a record's createdAt: "history" means the run's recorded
 * execution_success timestamp; "observed" means the moment this process
 * observed the finish (the live watch's detection, or the registry clock
 * fallback) — a real observation, but not ComfyUI's recorded time.
 */
export type CreatedAtSource = "history" | "observed";

export interface AssetRecord {
  assetId: string;
  promptId: string;
  nodeId: string;
  filename: string;
  subfolder: string;
  type: string;
  url: string;
  workflow: WorkflowJSON;
  createdAt: number;
  createdAtSource: CreatedAtSource;
  source: AssetSource;
}

export interface RegisterArgs {
  promptId: string;
  workflow: WorkflowJSON;
  outputs: AssetOutput[];
  /** Defaults to "watched". */
  source?: AssetSource;
  /** ms epoch. Callers pass a REAL time — the run's recorded completion
   *  timestamp or their own observed finish time. Defaults to the registry
   *  clock (itself an observation). */
  createdAt?: number;
  /** Provenance of createdAt. Defaults to "observed" — pass "history" only
   *  when createdAt is the entry's recorded execution_success timestamp. */
  createdAtSource?: CreatedAtSource;
}

/**
 * Canonicalize an externally supplied ComfyUI directory type before it can
 * participate in asset identity. Unknown values are unsafe to preserve: the
 * /view consumer only accepts these three types, so they deliberately fall
 * back to output just as the history consumer does.
 */
export function normalizeAssetType(type: unknown): AssetType {
  return type === "input" || type === "temp" || type === "output" ? type : "output";
}

/**
 * Return an asset ref with one canonical type and a matching public URL.
 * Invalid test/downtime URLs are retained; the production URL builder always
 * supplies an absolute URL and gets its type query corrected here.
 */
export function normalizeAssetImage(
  img: AssetImage,
): AssetImage & { type: AssetType } {
  const type = normalizeAssetType(img.type);
  let url = img.url;
  try {
    const parsed = new URL(img.url);
    parsed.searchParams.set("type", type);
    url = parsed.toString();
  } catch {
    // The registry does not fetch this URL. Keep opaque test/custom URLs
    // usable while still canonicalizing their identity metadata.
  }
  return { ...img, type, url };
}

export interface ListArgs {
  limit?: number;
  since?: number;
}

interface RegistryConfig {
  ttlMs: number;
  now: () => number;
}

const DEFAULT_TTL_MS =
  (() => {
    const raw = process.env.COMFYUI_ASSET_TTL_HOURS;
    const hours = raw ? Number(raw) : 24;
    return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  })();

const state = {
  records: new Map<string, AssetRecord>(),
  config: { ttlMs: DEFAULT_TTL_MS, now: Date.now } as RegistryConfig,
};

function makeAssetId(
  promptId: string,
  img: Pick<AssetImage, "filename" | "subfolder" | "type">,
): string {
  const type = normalizeAssetType(img.type);
  const hash = createHash("sha256")
    .update(`${promptId}\0${img.filename}\0${img.subfolder}\0${type}`)
    .digest("hex");
  return `a_${hash.slice(0, 8)}`;
}

function deepCloneWorkflow(wf: WorkflowJSON): WorkflowJSON {
  return JSON.parse(JSON.stringify(wf)) as WorkflowJSON;
}

function isExpired(record: AssetRecord): boolean {
  return state.config.now() - record.createdAt >= state.config.ttlMs;
}

function sourcePriority(source: AssetSource): number {
  // A live observation by this process is stronger provenance than a later
  // best-effort recovery from /history. This is the arbitration rule for the
  // async reconcile/watch race; equal sources are first-writer-wins.
  return source === "watched" ? 2 : 1;
}

export const AssetRegistry = {
  /**
   * Register all images produced by a completed prompt.
   * Returns records newly inserted or upgraded by this call. Existing records
   * win ties, and watched provenance wins a history-reconcile attempt for the
   * same canonical identity.
   */
  register({ promptId, workflow, outputs, source, createdAt, createdAtSource }: RegisterArgs): AssetRecord[] {
    const snapshot = deepCloneWorkflow(workflow);
    const registered: AssetRecord[] = [];
    const recordSource = source ?? "watched";
    for (const output of outputs) {
      for (const img of output.images) {
        const normalizedImg = normalizeAssetImage(img);
        const assetId = makeAssetId(promptId, normalizedImg);
        const existing = state.records.get(assetId);
        if (existing && !isExpired(existing) && sourcePriority(existing.source) >= sourcePriority(recordSource)) {
          continue;
        }
        const record: AssetRecord = {
          assetId,
          promptId,
          nodeId: output.node_id,
          filename: normalizedImg.filename,
          subfolder: normalizedImg.subfolder,
          type: normalizedImg.type,
          url: normalizedImg.url,
          workflow: snapshot,
          createdAt: createdAt ?? state.config.now(),
          createdAtSource: createdAtSource ?? "observed",
          source: recordSource,
        };
        state.records.set(assetId, record);
        registered.push(record);
      }
    }
    return registered;
  },

  /** True when a live (unexpired) record exists for this prompt + image. */
  has(
    promptId: string,
    img: Pick<AssetImage, "filename" | "subfolder" | "type">,
  ): boolean {
    const record = state.records.get(makeAssetId(promptId, img));
    return record !== undefined && !isExpired(record);
  },

  /** Look up a live record by the canonical prompt + image reference. */
  find(
    promptId: string,
    img: Pick<AssetImage, "filename" | "subfolder" | "type">,
  ): AssetRecord | undefined {
    const assetId = makeAssetId(promptId, img);
    const record = state.records.get(assetId);
    if (!record) return undefined;
    if (isExpired(record)) {
      state.records.delete(assetId);
      return undefined;
    }
    return record;
  },

  /** Look up a record by id. Returns undefined for missing or expired. */
  get(assetId: string): AssetRecord | undefined {
    const record = state.records.get(assetId);
    if (!record) return undefined;
    if (isExpired(record)) {
      state.records.delete(assetId);
      return undefined;
    }
    return record;
  },

  /** List records newest-first. */
  list({ limit, since }: ListArgs = {}): AssetRecord[] {
    const all = [...state.records.values()].filter((r) => !isExpired(r));
    const filtered = since !== undefined ? all.filter((r) => r.createdAt >= since) : all;
    filtered.sort((a, b) => b.createdAt - a.createdAt);
    return limit !== undefined ? filtered.slice(0, limit) : filtered;
  },

  /** Remove expired records. Returns number pruned. */
  prune(): number {
    let count = 0;
    for (const [id, record] of state.records) {
      if (isExpired(record)) {
        state.records.delete(id);
        count++;
      }
    }
    return count;
  },

  /** Test/diagnostic helper — wipe all records. */
  clear(): void {
    state.records.clear();
  },

  /** Test/diagnostic helper — override ttl and clock. */
  configure(opts: Partial<RegistryConfig>): void {
    if (opts.ttlMs !== undefined) state.config.ttlMs = opts.ttlMs;
    if (opts.now !== undefined) state.config.now = opts.now;
  },

  /** Inspect current size (debug only). */
  size(): number {
    return state.records.size;
  },
};

/**
 * Apply a flat override map to every node input in a workflow.
 * For each (key, value) in overrides, sets node.inputs[key] = value on any node
 * that already has that input. Returns a new workflow; does not mutate input.
 *
 * Example: { cfg: 8, seed: 12345 } → updates KSampler-style nodes only.
 */
export function applyOverrides(
  workflow: WorkflowJSON,
  overrides: Record<string, unknown> | undefined,
): WorkflowJSON {
  const next = deepCloneWorkflow(workflow);
  if (!overrides) return next;
  for (const node of Object.values(next)) {
    if (!node.inputs) continue;
    for (const [key, value] of Object.entries(overrides)) {
      if (key in node.inputs) {
        node.inputs[key] = value;
      }
    }
  }
  return next;
}

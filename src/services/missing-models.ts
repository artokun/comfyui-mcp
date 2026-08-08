// Missing-model resolution: figure out which model files a workflow wants but
// this ComfyUI doesn't have, then find installable candidates for them.
//
// WHY THIS EXISTS: `list_packs` action:"extract_deps" / action:"install_deps"
// resolve the custom NODE PACKS a workflow needs — they never touch the missing
// MODEL side of the same problem. So "open this Template and make it runnable"
// took two manual hops: the agent had to infer which checkpoint/VAE/LoRA was
// missing, then find it itself. Reported in the help channel (seanmcmagic).
//
// DETECTION: we do NOT hardcode widget names. ComfyUI publishes every model
// selector as a COMBO whose options are the server's ACTUAL filenames:
//
//   CheckpointLoaderSimple.input.required.ckpt_name = [["a.safetensors", …], {…}]
//
// So a workflow value that is a model-looking filename and is NOT in its combo's
// option list is missing — which covers every model type, including ones from
// custom packs we've never heard of, with no per-node mapping to maintain.
//
// SIZE IS NOT VRAM: weights are the floor, not the ceiling (activations, latents
// and context sit on top), so `fitVerdict` deliberately reserves headroom rather
// than pretending file size == requirement.

/** Weight-file extensions. Used to tell a model value from an ordinary enum. */
const MODEL_EXTS = new Set([".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft", ".onnx"]);

/** Widget name → models/ subdirectory. Only used to say WHERE a download should
 *  land; detection never depends on it, so an unknown widget degrades to
 *  `undefined` rather than dropping the missing model. */
const DIR_BY_WIDGET: Record<string, string> = {
  ckpt_name: "checkpoints",
  lora_name: "loras",
  vae_name: "vae",
  control_net_name: "controlnet",
  controlnet_name: "controlnet",
  unet_name: "diffusion_models",
  model_name: "upscale_models",
  clip_name: "text_encoders",
  clip_name1: "text_encoders",
  clip_name2: "text_encoders",
  style_model_name: "style_models",
  embedding_name: "embeddings",
  gligen_name: "gligen",
  hypernetwork_name: "hypernetworks",
  ipadapter_file: "ipadapter",
};

export type Precision = "fp32" | "fp16" | "bf16" | "fp8" | "gguf" | "nf4" | "unknown";

export interface MissingModel {
  node_id: string;
  node_type: string;
  widget: string;
  /** The filename the workflow asks for. */
  name: string;
  /** Best-guess models/ subdirectory for a download, when we can infer one. */
  directory?: string;
}

export interface PrecisionInfo {
  precision: Precision;
  /** GGUF quantisation tag when present, e.g. "Q4_K_M". */
  quant?: string;
  /** GGUF needs a loader node that core ComfyUI does not ship. */
  requiresPack?: string;
}

export type FitVerdict = "fits" | "tight" | "too_big" | "unknown";

export type MatchQuality = "exact" | "stem" | "fuzzy";

/** Strip directory + extension, lowercase — the comparable identity of a model. */
export function fileStem(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  return base.replace(/\.[^.]+$/, "").toLowerCase();
}

function hasModelExt(name: string): boolean {
  const base = name.split(/[/\\]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  return MODEL_EXTS.has(base.slice(dot).toLowerCase());
}

/**
 * Read the precision / quantisation out of a weight filename.
 *
 * This is what makes a fuzzy match set useful instead of opaque: the same model
 * ships as fp16 / fp8 / several GGUF quants at wildly different sizes, and on a
 * constrained GPU the quantised one is the whole answer.
 *
 * GGUF is checked FIRST: a name can contain both "gguf" and a dtype-looking
 * token, and the container is what decides whether it loads at all.
 */
export function classifyPrecision(filename: string): PrecisionInfo {
  const n = filename.toLowerCase();
  if (/\.gguf$|[-_.]gguf\b/.test(n)) {
    // Q4_K_M, Q6_K, Q8_0, IQ3_XXS …
    const m = n.match(/\b(iq|q)(\d+)(_[a-z0-9]+)*\b/);
    return {
      precision: "gguf",
      quant: m ? m[0].toUpperCase() : undefined,
      requiresPack: "ComfyUI-GGUF",
    };
  }
  if (/\bnf4\b/.test(n)) return { precision: "nf4" };
  // fp8_e4m3fn / fp8_e5m2 / float8
  if (/\bfp8\b|\bfloat8\b|e4m3|e5m2/.test(n)) return { precision: "fp8" };
  if (/\bbf16\b|\bbfloat16\b/.test(n)) return { precision: "bf16" };
  if (/\bfp16\b|\bfloat16\b|\bhalf\b/.test(n)) return { precision: "fp16" };
  if (/\bfp32\b|\bfloat32\b|\bfull\b/.test(n)) return { precision: "fp32" };
  return { precision: "unknown" };
}

/**
 * Can this file plausibly run on a card with `vramBytes` of VRAM?
 *
 * Weights are the floor, not the ceiling — activations/latents/context also live
 * in VRAM — so we reserve headroom instead of claiming a 15.9 GB file "fits" a
 * 16 GB card. Anything above 80% of VRAM is reported as `tight`, not `fits`.
 */
export function fitVerdict(sizeBytes: number | undefined, vramBytes: number | undefined): FitVerdict {
  if (!sizeBytes || !vramBytes || sizeBytes <= 0 || vramBytes <= 0) return "unknown";
  const ratio = sizeBytes / vramBytes;
  if (ratio > 1) return "too_big";
  if (ratio > 0.8) return "tight";
  return "fits";
}

/** How well does `candidate` answer the request for `wanted`? */
export function matchQuality(wanted: string, candidate: string): MatchQuality {
  const w = (wanted.split(/[/\\]/).pop() ?? wanted).toLowerCase();
  const c = (candidate.split(/[/\\]/).pop() ?? candidate).toLowerCase();
  if (w === c) return "exact";
  if (fileStem(wanted) === fileStem(candidate)) return "stem";
  return "fuzzy";
}

const MATCH_RANK: Record<MatchQuality, number> = { exact: 0, stem: 1, fuzzy: 2 };
const FIT_RANK: Record<FitVerdict, number> = { fits: 0, tight: 1, unknown: 2, too_big: 3 };

/**
 * Order candidates the way a human would pick: closest name first, then what
 * actually fits the card, then larger (higher-quality) files before smaller.
 * Stable — equal candidates keep their input order.
 */
export function rankCandidates<T extends { filename: string; size_bytes?: number; fit?: FitVerdict }>(
  wanted: string,
  candidates: T[],
): Array<T & { match: MatchQuality }> {
  return candidates
    .map((c, i) => ({ ...c, match: matchQuality(wanted, c.filename), _i: i }))
    .sort((a, b) => {
      const m = MATCH_RANK[a.match] - MATCH_RANK[b.match];
      if (m !== 0) return m;
      const f = FIT_RANK[a.fit ?? "unknown"] - FIT_RANK[b.fit ?? "unknown"];
      if (f !== 0) return f;
      const s = (b.size_bytes ?? 0) - (a.size_bytes ?? 0);
      if (s !== 0) return s;
      return a._i - b._i;
    })
    .map(({ _i, ...rest }) => rest as T & { match: MatchQuality });
}

/** The subset of /object_info we need: class → input name → spec. */
export type ObjectInfoLike = Record<
  string,
  { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } } | undefined
>;

/** A workflow node in API format. */
interface ApiNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
}

/** The combo option list for an input spec, or null when it isn't a combo. */
function comboOptions(spec: unknown): string[] | null {
  if (!Array.isArray(spec) || spec.length === 0) return null;
  const first = spec[0];
  if (!Array.isArray(first)) return null;
  return first.filter((o): o is string => typeof o === "string");
}

/**
 * Find every model a workflow references that this server does not have.
 *
 * A value counts as a missing model when its input is a COMBO (so the server
 * published the set it actually has) and the value is a model-looking filename
 * absent from that set. Connections (`[nodeId, slot]` arrays) and non-model
 * enums are ignored.
 *
 * `directory` is a best-effort hint for where a download should land; it is
 * never required, so an unrecognised widget still reports its missing model.
 */
export function findMissingModels(
  workflow: Record<string, unknown>,
  objectInfo: ObjectInfoLike,
): MissingModel[] {
  const missing: MissingModel[] = [];
  const seen = new Set<string>();

  for (const [nodeId, rawNode] of Object.entries(workflow)) {
    if (!rawNode || typeof rawNode !== "object") continue;
    const node = rawNode as ApiNode;
    const classType = node.class_type;
    if (!classType || !node.inputs) continue;

    const def = objectInfo[classType];
    if (!def?.input) continue;
    const specs = { ...(def.input.required ?? {}), ...(def.input.optional ?? {}) };

    for (const [widget, value] of Object.entries(node.inputs)) {
      // A wired connection, not a widget value.
      if (Array.isArray(value)) continue;
      if (typeof value !== "string" || value.length === 0) continue;

      const options = comboOptions(specs[widget]);
      if (!options) continue; // not a combo → not a model selector
      if (options.includes(value)) continue; // present on this server

      // Only claim "missing MODEL" when it looks like a weight file — otherwise
      // it's an ordinary enum drift and not ours to fix.
      if (!hasModelExt(value) && !options.some(hasModelExt)) continue;

      const key = `${value.toLowerCase()}|${widget}`;
      if (seen.has(key)) continue;
      seen.add(key);

      missing.push({
        node_id: nodeId,
        node_type: classType,
        widget,
        name: value,
        directory: DIR_BY_WIDGET[widget],
      });
    }
  }
  return missing;
}

// ── Candidate resolution ────────────────────────────────────────────────────
// Deps are INJECTED so the ranking/annotation logic is unit-testable without
// touching CivitAI, HuggingFace, or a running ComfyUI.

export interface ModelCandidate {
  filename: string;
  source: "civitai" | "huggingface";
  /** Where to get it: a direct URL (HF) or a civitai model/version id. */
  url?: string;
  civitai_model_id?: number;
  civitai_version_id?: number;
  size_bytes?: number;
  precision: Precision;
  quant?: string;
  /** Set when the file needs a loader node core ComfyUI doesn't ship (GGUF). */
  requires_pack?: string;
  base_model?: string;
  fit?: FitVerdict;
  match?: MatchQuality;
}

export interface ResolveDeps {
  /** CivitAI keyword search, already type-filtered by the caller. */
  searchCivitai: (
    query: string,
    types: string[] | undefined,
  ) => Promise<Array<{ name: string; model_id: number; version_id?: number; size_mb?: number; base_model?: string }>>;
  /** HuggingFace repo search. */
  searchHf: (query: string) => Promise<Array<{ id: string }>>;
  /** Expand an HF repo into its weight files (filename + size). */
  hfRepoFiles: (repoId: string) => Promise<Array<{ filename: string; size_bytes?: number }>>;
  /** Total VRAM in bytes, or undefined when unknown (remote/cloud). */
  vramBytes: () => Promise<number | undefined>;
}

/** models/ subdir → CivitAI `types` filter, so a LoRA hunt can't return checkpoints. */
const CIVITAI_TYPE_BY_DIR: Record<string, string[]> = {
  checkpoints: ["Checkpoint"],
  loras: ["LORA", "LoCon"],
  vae: ["VAE"],
  controlnet: ["Controlnet"],
  embeddings: ["TextualInversion"],
  upscale_models: ["Upscaler"],
};

const MB = 1024 * 1024;

export interface CandidateLookup {
  candidates: ModelCandidate[];
  /**
   * Providers whose LOOKUP FAILED — distinct from "answered with nothing".
   * An empty `candidates` with failures here is "could not look", and saying
   * "no candidates found" for it is the confident-wrong-negative fold.
   */
  failedProviders: string[];
}

/**
 * Find installable candidates for ONE missing model, annotated with precision,
 * size and whether it fits this GPU, best first — AND which providers failed
 * to answer at all.
 *
 * Deliberately does NOT auto-pick: the same filename ships across quants and
 * base models, so we return a ranked, annotated list and let the caller decide.
 * Network failures degrade to fewer candidates rather than failing the lookup —
 * a partial answer beats none when one provider is down — but the failures are
 * REPORTED, so an empty list is never read as "nothing exists" when the search
 * itself failed.
 */
export async function resolveCandidatesDetailed(
  missing: MissingModel,
  deps: ResolveDeps,
  opts: { limit?: number } = {},
): Promise<CandidateLookup> {
  const limit = opts.limit ?? 8;
  const query = fileStem(missing.name);
  // unknown-ok: undefined means "VRAM unknown" and is carried as such — it never
  // becomes a zero that would filter every candidate out. Compare the CivitAI call
  // immediately below, which records its failure in failedProviders for the same reason.
  const vram = await deps.vramBytes().catch(() => undefined);
  const out: ModelCandidate[] = [];
  const failedProviders: string[] = [];

  const civitaiTypes = missing.directory ? CIVITAI_TYPE_BY_DIR[missing.directory] : undefined;
  const hits = await deps.searchCivitai(query, civitaiTypes).catch(() => {
    failedProviders.push("CivitAI");
    return [];
  });
  for (const h of hits) {
    const size = typeof h.size_mb === "number" ? Math.round(h.size_mb * MB) : undefined;
    const p = classifyPrecision(h.name);
    out.push({
      filename: h.name,
      source: "civitai",
      civitai_model_id: h.model_id,
      civitai_version_id: h.version_id,
      size_bytes: size,
      precision: p.precision,
      quant: p.quant,
      requires_pack: p.requiresPack,
      base_model: h.base_model,
      fit: fitVerdict(size, vram),
    });
  }

  // Expand generously: the QUANTISED repo (e.g. city96/FLUX.1-dev-gguf) is
  // routinely ranked below the official one, and on a constrained GPU it is the
  // only candidate that actually helps — slicing too tightly drops exactly the
  // answer the user needs.
  const repos = await deps.searchHf(query).catch(() => {
    failedProviders.push("HuggingFace");
    return [];
  });
  for (const repo of repos.slice(0, 6)) {
    const files = await deps.hfRepoFiles(repo.id).catch(() => {
      failedProviders.push(`HuggingFace repo ${repo.id}`);
      return [];
    });
    for (const f of files) {
      const p = classifyPrecision(f.filename);
      out.push({
        filename: f.filename,
        source: "huggingface",
        url: `https://huggingface.co/${repo.id}/resolve/main/${f.filename}`,
        size_bytes: f.size_bytes,
        precision: p.precision,
        quant: p.quant,
        requires_pack: p.requiresPack,
        fit: fitVerdict(f.size_bytes, vram),
      });
    }
  }

  return {
    candidates: rankCandidates(missing.name, dedupeCandidates(out)).slice(0, limit),
    failedProviders,
  };
}

/** The candidate list alone — see `resolveCandidatesDetailed` for the contract. */
export async function resolveCandidates(
  missing: MissingModel,
  deps: ResolveDeps,
  opts: { limit?: number } = {},
): Promise<ModelCandidate[]> {
  return (await resolveCandidatesDetailed(missing, deps, opts)).candidates;
}

/**
 * Collapse the same file offered by several repos/providers into one row.
 *
 * Popular weights are mirrored widely, so an un-deduped list wastes most of its
 * slots showing `flux1-dev.safetensors` three times instead of the fp8 and GGUF
 * variants that are the actual reason to look. Keyed on filename + precision +
 * quant so genuinely different builds stay distinct; the entry that knows its
 * size wins, since size drives the fit verdict.
 */
export function dedupeCandidates(candidates: ModelCandidate[]): ModelCandidate[] {
  const best = new Map<string, ModelCandidate>();
  for (const c of candidates) {
    const key = `${(c.filename.split(/[/\\]/).pop() ?? c.filename).toLowerCase()}|${c.precision}|${c.quant ?? ""}`;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, c);
      continue;
    }
    const prevKnows = typeof prev.size_bytes === "number" && prev.size_bytes > 0;
    const nextKnows = typeof c.size_bytes === "number" && c.size_bytes > 0;
    if (!prevKnows && nextKnows) best.set(key, c);
  }
  return [...best.values()];
}

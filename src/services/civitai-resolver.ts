import { config } from "../config.js";
import { ModelError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { htmlToMarkdown } from "../utils/html-to-markdown.js";
import { civitaiDisabled, CIVITAI_DISABLED_MESSAGE } from "./model-resolver.js";

const CIVITAI_API_BASE = "https://civitai.com/api/v1";

/**
 * Subset of the CivitAI model-version file object.
 * See https://developer.civitai.com (Public REST API v1).
 */
interface CivitaiFile {
  name?: string;
  downloadUrl?: string;
  primary?: boolean;
  type?: string;
  sizeKB?: number;
}

/** An example image/video shown in the model's gallery, with generation params. */
interface CivitaiImage {
  url?: string;
  width?: number;
  height?: number;
  nsfwLevel?: number;
  type?: string; // "image" | "video"
  hash?: string;
  meta?: Record<string, unknown> | null;
}

interface CivitaiModelVersion {
  id: number;
  name?: string;
  baseModel?: string;
  description?: string;
  trainedWords?: string[];
  downloadUrl?: string;
  files?: CivitaiFile[];
  images?: CivitaiImage[];
  // Present on GET /model-versions/{id} (not on the nested versions of /models/{id}).
  model?: { name?: string; type?: string };
}

interface CivitaiModel {
  id: number;
  name?: string;
  type?: string;
  description?: string;
  tags?: string[];
  creator?: { username?: string };
  modelVersions?: CivitaiModelVersion[];
}

/** One example generation captured from a model's gallery, for the recipe. */
export interface CivitaiExample {
  url?: string;
  type?: string; // image | video
  width?: number;
  height?: number;
  nsfwLevel?: number;
  meta?: Record<string, unknown> | null;
}

/**
 * Rich, human/agent-facing metadata about a downloaded CivitAI model, written
 * as a sidecar next to the file so the panel agent can read usage docs, trigger
 * words, and example generation params without re-querying CivitAI.
 */
export interface CivitaiMetadata {
  modelId?: number;
  modelName?: string;
  modelType?: string;
  creator?: string;
  tags?: string[];
  modelDescriptionHtml?: string;
  versionId: number;
  versionName?: string;
  versionDescriptionHtml?: string;
  baseModel?: string;
  trainedWords: string[];
  fileName?: string;
  fileSizeKB?: number;
  /** Canonical CivitAI page URL for this model/version. */
  sourceUrl: string;
  examples: CivitaiExample[];
}

export interface CivitaiResolved {
  /**
   * Direct download URL. No credentials are embedded — `downloadModel` attaches
   * the CivitAI token as an `Authorization` request header, so the token never
   * leaks into logs, error messages, or redirect URLs.
   */
  downloadUrl: string;
  /** Suggested filename from CivitAI metadata, when available. */
  filename?: string;
  /** Resolved model-version id. */
  versionId: number;
  /** Model name, when resolvable. */
  modelName?: string;
  /** Rich metadata for the download sidecar (best-effort; undefined if unbuildable). */
  metadata?: CivitaiMetadata;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.civitaiApiToken) {
    headers["Authorization"] = `Bearer ${config.civitaiApiToken}`;
  }
  return headers;
}

/**
 * Ceiling on any single CivitAI request. Without it a hung connection wedges
 * the tool forever — the worst outcome of all (neither a surfaced error nor an
 * honest empty). Mirrors the 10s guard the provenance hash-lookup already uses;
 * a touch longer here because search/model reads can be heavier.
 */
const CIVITAI_TIMEOUT_MS = 15000;

/**
 * Translate a raw (non-HTTP) transport failure into a DISTINCT, actionable
 * ModelError, distinguishing our own timeout/abort from a connection-level
 * network error. Shared by the initial fetch AND the body read, because an
 * AbortError/connection reset can fire at EITHER point (after headers arrive
 * but before the body is drained) and must be labelled the same way — never
 * misread as a bot-gate/non-JSON page.
 * Returns null when `err` is not a transport failure (e.g. a JSON SyntaxError),
 * so the caller can fall through to its own classification.
 */
function transportError(err: unknown, url: string): ModelError | null {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new ModelError(
      `CivitAI request timed out after ${CIVITAI_TIMEOUT_MS / 1000}s ` +
        `(civitai.com slow or unreachable) — try again shortly.`,
      { url, timeout: true },
    );
  }
  if (err instanceof TypeError) {
    return new ModelError(
      `CivitAI is unreachable (network error: ${err.message}) — ` +
        `check connectivity and try again.`,
      { url, network: true },
    );
  }
  return null;
}

/**
 * Perform the fetch and translate every non-HTTP failure mode (DNS/connection
 * down, TLS, or our own timeout abort) into a DISTINCT, actionable ModelError.
 * A bare `fetch` rejects with an opaque `TypeError: fetch failed` (or a
 * `TimeoutError`) that, once caught upstream, is indistinguishable from any
 * other crash — exactly the "silently swallowed" failure WS-6 set out to kill.
 */
async function civitaiFetch(
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  try {
    return await fetch(url, {
      headers,
      signal: AbortSignal.timeout(CIVITAI_TIMEOUT_MS),
    });
  } catch (err) {
    throw (
      transportError(err, url) ??
      new ModelError(
        `CivitAI is unreachable (network error: ` +
          `${err instanceof Error ? err.message : String(err)}) — ` +
          `check connectivity and try again.`,
        { url, network: true },
      )
    );
  }
}

/**
 * Turn a non-OK HTTP status into a DISTINCT, actionable ModelError so an
 * auth/rate-limit/upstream failure is never conflated with each other — or,
 * worse, with a genuine empty result. Callers handle 404 themselves (a 404 is
 * "resource absent", a definitive answer, not a fault).
 *
 * `tokenSent` reflects whether THIS request actually carried a bearer token —
 * NOT whether one is configured globally. The tRPC leaderboard deliberately
 * sends none, so a bot-gate 401 there must read as "auth required", never
 * "your configured token is invalid".
 */
async function throwForCivitaiStatus(
  res: Response,
  url: string,
  tokenSent: boolean,
): Promise<never> {
  const body = await res.text().catch(() => "");
  const status = res.status;
  let message: string;
  if (status === 401) {
    message = tokenSent
      ? `CivitAI rejected the API token (401 Unauthorized) — it is invalid or ` +
        `expired; refresh CIVITAI_API_TOKEN.`
      : `CivitAI requires authentication for this request (401 Unauthorized) — ` +
        `set CIVITAI_API_TOKEN.`;
  } else if (status === 403) {
    message =
      `CivitAI refused the request (403 Forbidden) — the token lacks ` +
      `permission, or access is region-blocked.`;
  } else if (status === 429) {
    message =
      `CivitAI rate-limited the request (429 Too Many Requests) — ` +
      `wait a moment and retry.`;
  } else if (status >= 500) {
    message =
      `CivitAI upstream error (${status} ${res.statusText}) — the site is ` +
      `having trouble; this is transient, retry shortly.`;
  } else {
    message = `CivitAI API ${status}: ${res.statusText}`;
  }
  throw new ModelError(message, { url, status, body });
}

/**
 * Parse a response body as JSON, converting a non-JSON 2xx (e.g. a Cloudflare
 * challenge or HTML interstitial served with a 200) into a distinct error
 * rather than an opaque SyntaxError that reads as an empty/garbage result.
 */
async function parseCivitaiJson<T>(res: Response, url: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    // An abort/timeout or connection reset can surface HERE (headers arrived,
    // body drain failed). Classify it as the transport failure it is — only a
    // genuine parse failure (SyntaxError) is the bot-gate/non-JSON case.
    const transport = transportError(err, url);
    if (transport) throw transport;
    throw new ModelError(
      `CivitAI returned a non-JSON response (HTTP ${res.status}) — likely a ` +
        `bot-gate or interstitial page rather than the API; try again shortly.`,
      { url, status: res.status, nonJson: true },
    );
  }
}

async function civitaiGet<T>(path: string): Promise<T> {
  // User-initiated Civitai actions fail FAST with the config explanation when
  // the kill-switch is set (issue #127) — never a hang against a blocked host.
  if (civitaiDisabled()) {
    throw new ModelError(CIVITAI_DISABLED_MESSAGE);
  }
  const url = `${CIVITAI_API_BASE}${path}`;
  logger.debug("CivitAI API request", { url });

  const headers = authHeaders();
  const res = await civitaiFetch(url, headers);
  if (res.status === 404) {
    throw new ModelError(`CivitAI resource not found: ${path}`, {
      url,
      status: 404,
    });
  }
  if (!res.ok) {
    await throwForCivitaiStatus(res, url, "Authorization" in headers);
  }
  return parseCivitaiJson<T>(res, url);
}

/** Pick the best file from a version's file list: primary first, else the first. */
function pickFile(version: CivitaiModelVersion): CivitaiFile | undefined {
  const files = version.files ?? [];
  return files.find((f) => f.primary) ?? files[0];
}

/** Max example generations captured into the sidecar (those carrying params first). */
const MAX_EXAMPLES = 8;

function buildExamples(version: CivitaiModelVersion): CivitaiExample[] {
  const imgs = version.images ?? [];
  // Prefer examples that actually carry generation params (a usable recipe).
  const withMeta = imgs.filter((i) => i.meta && Object.keys(i.meta).length > 0);
  const ordered = [...withMeta, ...imgs.filter((i) => !withMeta.includes(i))];
  return ordered.slice(0, MAX_EXAMPLES).map((i) => ({
    url: i.url,
    type: i.type,
    width: i.width,
    height: i.height,
    nsfwLevel: i.nsfwLevel,
    meta: i.meta ?? null,
  }));
}

function buildMetadata(
  version: CivitaiModelVersion,
  file: CivitaiFile | undefined,
  model?: CivitaiModel,
): CivitaiMetadata {
  const modelId = model?.id;
  const sourceUrl = modelId
    ? `https://civitai.com/models/${modelId}?modelVersionId=${version.id}`
    : `https://civitai.com/model-versions/${version.id}`;
  return {
    modelId,
    modelName: model?.name ?? version.model?.name,
    modelType: model?.type ?? version.model?.type,
    creator: model?.creator?.username,
    tags: model?.tags,
    modelDescriptionHtml: model?.description,
    versionId: version.id,
    versionName: version.name,
    versionDescriptionHtml: version.description,
    baseModel: version.baseModel,
    trainedWords: version.trainedWords ?? [],
    fileName: file?.name,
    fileSizeKB: file?.sizeKB,
    sourceUrl,
    examples: buildExamples(version),
  };
}

function resolveFromVersion(
  version: CivitaiModelVersion,
  model?: CivitaiModel,
): CivitaiResolved {
  const file = pickFile(version);
  const downloadUrl =
    file?.downloadUrl ??
    version.downloadUrl ??
    `https://civitai.com/api/download/models/${version.id}`;

  return {
    downloadUrl,
    filename: file?.name,
    versionId: version.id,
    modelName: model?.name ?? version.model?.name,
    metadata: buildMetadata(version, file, model),
  };
}

/**
 * Resolve a CivitAI model-version id directly to a download URL.
 * Uses GET /api/v1/model-versions/{id}.
 */
export async function resolveCivitaiModelVersion(
  versionId: number,
): Promise<CivitaiResolved> {
  const version = await civitaiGet<CivitaiModelVersion>(
    `/model-versions/${versionId}`,
  );
  return resolveFromVersion(version);
}

/**
 * Render a CivitAI metadata bundle as agent-readable Markdown for the sidecar.
 * Usage docs (trigger words, base model, descriptions) up top; a compact
 * "example recipes" section from the gallery's generation params below.
 */
export function buildCivitaiMarkdown(m: CivitaiMetadata): string {
  const lines: string[] = [];
  lines.push(`# ${m.modelName ?? "CivitAI model"}`);
  const facts: string[] = [];
  if (m.modelType) facts.push(`**Type:** ${m.modelType}`);
  if (m.baseModel) facts.push(`**Base model:** ${m.baseModel}`);
  if (m.versionName) facts.push(`**Version:** ${m.versionName}`);
  if (m.creator) facts.push(`**Creator:** ${m.creator}`);
  if (facts.length) lines.push("", facts.join("  \n"));
  lines.push("", `Source: ${m.sourceUrl}`);

  if (m.trainedWords.length) {
    lines.push("", "## Trigger words", "");
    lines.push(m.trainedWords.map((w) => `\`${w}\``).join(", "));
  }

  const modelMd = htmlToMarkdown(m.modelDescriptionHtml);
  if (modelMd) lines.push("", "## Description", "", modelMd);

  const versionMd = htmlToMarkdown(m.versionDescriptionHtml);
  if (versionMd) lines.push("", "## Version notes", "", versionMd);

  const recipes = m.examples.filter(
    (e) => e.meta && Object.keys(e.meta).length > 0,
  );
  if (recipes.length) {
    lines.push("", "## Example recipes", "");
    lines.push(
      "Generation params pulled from the model's gallery — reuse the seed to replicate, or vary it to remix.",
    );
    recipes.forEach((e, i) => {
      lines.push("", `### Example ${i + 1}`);
      if (e.url) lines.push(`Image: ${e.url}`);
      lines.push("", "```", formatMeta(e.meta!), "```");
    });
  }

  return lines.join("\n") + "\n";
}

/** Flatten a CivitAI image `meta` object into readable `key: value` lines,
 *  surfacing the params that matter for reproduction first. */
function formatMeta(meta: Record<string, unknown>): string {
  const order = [
    "prompt",
    "negativePrompt",
    "seed",
    "steps",
    "sampler",
    "cfgScale",
    "Size",
    "Model",
    "Denoising strength",
    "Clip skip",
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (k: string, v: unknown) => {
    if (v === undefined || v === null || v === "") return;
    if (typeof v === "object") return; // skip nested (resources/hashes) here
    out.push(`${k}: ${v}`);
    seen.add(k);
  };
  for (const k of order) if (k in meta) push(k, meta[k]);
  for (const [k, v] of Object.entries(meta)) if (!seen.has(k)) push(k, v);
  return out.join("\n");
}

/**
 * Resolve a CivitAI model id to a download URL.
 * Uses GET /api/v1/models/{id} and picks a model version.
 * If `versionId` is supplied, that specific version is used; otherwise the
 * latest (first listed) version is chosen.
 */
export async function resolveCivitaiModel(
  modelId: number,
  versionId?: number,
): Promise<CivitaiResolved> {
  const model = await civitaiGet<CivitaiModel>(`/models/${modelId}`);
  const versions = model.modelVersions ?? [];

  if (versions.length === 0) {
    throw new ModelError(
      `CivitAI model ${modelId} has no downloadable versions.`,
      { modelId },
    );
  }

  let version: CivitaiModelVersion | undefined;
  if (versionId !== undefined) {
    version = versions.find((v) => v.id === versionId);
    if (!version) {
      throw new ValidationError(
        `Model ${modelId} has no version with id ${versionId}. ` +
          `Available versions: ${versions.map((v) => v.id).join(", ")}.`,
      );
    }
  } else {
    version = versions[0];
  }

  return resolveFromVersion(version, model);
}

// ---------------------------------------------------------------------------
// Keyword search (native — replaces the previously-bundled Civitai MCP for the
// search→download loop). GET /api/v1/models works UNAUTHENTICATED with query,
// type, and base-model filters, and each hit carries exactly what
// download_civitai_model consumes (model id + version id) plus the trigger
// words the prompt will need. Field driver: a local-model user asked to "find
// a good Flux LoRA on Civitai" and there was no tool that could.
// ---------------------------------------------------------------------------

export interface CivitaiSearchHit {
  model_id: number;
  name: string;
  type?: string;
  creator?: string;
  downloads?: number;
  thumbs_up?: number;
  nsfw?: boolean;
  /** Latest version — the one download_civitai_model fetches by default. */
  version_id?: number;
  version_name?: string;
  base_model?: string;
  trained_words?: string[];
  /** Approximate primary-file size, MB (when the API reports it). */
  size_mb?: number;
}

const CIVITAI_SORTS = ["Highest Rated", "Most Downloaded", "Newest"] as const;
export type CivitaiSort = (typeof CIVITAI_SORTS)[number];

export interface CivitaiSearchOptions {
  types?: string[];
  /** Civitai base-model labels, e.g. "Flux.1 D", "SDXL 1.0", "SD 1.5", "Pony", "Illustrious". */
  baseModels?: string[];
  sort?: CivitaiSort;
  nsfw?: boolean;
  limit?: number;
  /** Only models by this CivitAI creator (exact username). Sent as the API's
   *  `username` param; any keyword query is applied client-side because the
   *  API returns an empty page when `query` and `username` are combined
   *  (live-verified quirk). */
  creator?: string;
}

type CivitaiSearchItem = CivitaiModel & {
  nsfw?: boolean;
  stats?: { downloadCount?: number; thumbsUpCount?: number };
};

interface CivitaiSearchResponse {
  items?: CivitaiSearchItem[];
  metadata?: { nextCursor?: string };
}

export interface CivitaiSearchResult {
  hits: CivitaiSearchHit[];
  /** Creator+keyword mode only: how many of the creator's models the
   *  client-side keyword filter scanned. */
  scanned?: number;
  /** Creator+keyword mode only: true when the bounded scan stopped at the
   *  page cap with pages left AND fewer than `limit` matches — matching
   *  models past the cap may exist but were not seen. */
  scanCapped?: boolean;
  /** Creator+keyword mode only: set when a PAGE AFTER THE FIRST failed
   *  (upstream/timeout/rate-limit) mid-scan. The returned `hits` are a partial
   *  result from the pages that did load, NOT a definitive answer — the miss of
   *  any absent match is unattributable. (A first-page failure throws instead,
   *  so a broken scan is never mistaken for a genuine empty.) */
  scanError?: string;
}

/**
 * CivitAI `nsfwLevel` ladder: 1 None · 2 Soft (PG-13) · 4 Mature · 8 Explicit ·
 * 16 X · 32 Blocked. SFW search surfaces nothing above PG-13.
 */
const MAX_SFW_NSFW_LEVEL = 2;

/** True when every preview of this version is at/below PG-13 (or it has none). */
function versionIsSfw(version: CivitaiModelVersion): boolean {
  return (version.images ?? []).every(
    (img) => (img.nsfwLevel ?? 1) <= MAX_SFW_NSFW_LEVEL,
  );
}

function toSearchHit(
  m: CivitaiSearchItem,
  opts: { nsfw?: boolean } = {},
): CivitaiSearchHit {
  const versions = m.modelVersions ?? [];
  // The API gates only the MODEL-level nsfw flag — a model flagged SFW can
  // still front a version with mature/explicit previews and adult trigger
  // words (#664). In SFW mode prefer the newest version whose previews stay
  // at/below PG-13; when none qualifies, keep the latest version for the
  // download handoff but don't vouch for its trigger words.
  const clean = opts.nsfw ? undefined : versions.find(versionIsSfw);
  const v = clean ?? versions[0];
  const file = v ? pickFile(v) : undefined;
  const sizeKb = (file as { sizeKB?: number } | undefined)?.sizeKB;
  return {
    model_id: m.id,
    name: m.name ?? `model ${m.id}`,
    type: m.type,
    creator: m.creator?.username,
    downloads: m.stats?.downloadCount,
    thumbs_up: m.stats?.thumbsUpCount,
    nsfw: m.nsfw,
    version_id: v?.id,
    version_name: v?.name,
    base_model: v?.baseModel,
    trained_words:
      opts.nsfw || clean ? v?.trainedWords?.slice(0, 6) : undefined,
    ...(sizeKb ? { size_mb: Math.round(sizeKb / 1024) } : {}),
  };
}

/** Creator+keyword mode: pages of 100 scanned client-side, and how many pages
 *  to follow before giving up (4 → up to 400 of the creator's models). */
const CREATOR_SCAN_PAGE_SIZE = 100;
const CREATOR_SCAN_MAX_PAGES = 4;

export async function searchCivitaiModels(
  query: string,
  opts: CivitaiSearchOptions = {},
): Promise<CivitaiSearchResult> {
  const creator = opts.creator?.trim();
  const keyword = query.trim();
  if (!creator && !keyword) {
    throw new ValidationError("Provide a query, a creator, or both.");
  }
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  const params = new URLSearchParams();
  params.set("sort", opts.sort ?? "Highest Rated");
  // Civitai defaults to including NSFW for authed accounts — pin it explicitly
  // so results are SFW unless the caller opted in.
  params.set("nsfw", opts.nsfw ? "true" : "false");
  for (const t of opts.types ?? []) params.append("types", t);
  for (const b of opts.baseModels ?? []) params.append("baseModels", b);

  if (!creator || !keyword) {
    // Single-page modes: a plain keyword search, or ALL of a creator's models.
    if (creator) {
      params.set("username", creator);
    } else {
      params.set("query", keyword);
    }
    params.set("limit", String(limit));
    const data = await civitaiGet<CivitaiSearchResponse>(`/models?${params.toString()}`);
    return { hits: (data.items ?? []).slice(0, limit).map((m) => toSearchHit(m, opts)) };
  }

  // Creator + keyword: `query` + `username` together return an EMPTY page
  // (live-verified), so send only `username` and apply the keyword client-side
  // — following cursor pagination (bounded) so a prolific creator's matching
  // model past the first page is still found.
  params.set("username", creator);
  params.set("limit", String(CREATOR_SCAN_PAGE_SIZE));
  const q = keyword.toLowerCase();
  const matches: CivitaiSearchItem[] = [];
  const seenIds = new Set<number>();
  // Every cursor already followed — refuses ANY cycle (immediate repeat AND
  // longer A→B→A loops), not just the previous cursor.
  const seenCursors = new Set<string>();
  let scanned = 0;
  let cursor: string | undefined;
  // True when the scan stopped with pages plausibly unseen: the page cap was
  // hit with a next cursor remaining, or the API handed back a degenerate
  // (cycling) cursor we refuse to follow.
  let stoppedEarly = false;
  // Set when a page AFTER the first fails: we keep the partial matches gathered
  // so far but flag them as non-definitive. A FIRST-page failure is left to
  // throw (no partial data exists yet), so a broken scan never looks empty.
  let scanError: string | undefined;
  for (let page = 0; page < CREATOR_SCAN_MAX_PAGES; page++) {
    if (cursor !== undefined) params.set("cursor", cursor);
    let data: CivitaiSearchResponse;
    try {
      data = await civitaiGet<CivitaiSearchResponse>(`/models?${params.toString()}`);
    } catch (err) {
      if (page === 0) throw err; // nothing gathered yet — surface the failure
      scanError = err instanceof Error ? err.message : String(err);
      stoppedEarly = true; // pages remained unscanned → the result is partial
      break;
    }
    // Dedupe across pages by model id — a misbehaving cursor that replays a
    // page must not double-count `scanned` or fill `limit` with duplicates.
    const items = (data.items ?? []).filter((m) => !seenIds.has(m.id));
    for (const m of items) seenIds.add(m.id);
    scanned += items.length;
    matches.push(
      ...items.filter(
        (m) =>
          (m.name ?? "").toLowerCase().includes(q) ||
          (m.tags ?? []).some((t) => t.toLowerCase().includes(q)),
      ),
    );
    // Falsy (missing OR empty-string) cursor → the catalog is exhausted; a
    // cursor we ALREADY followed (immediate repeat or a longer cycle) would
    // page in circles forever → treat as stuck.
    const next = data.metadata?.nextCursor || undefined;
    if (!next) break;
    if (seenCursors.has(next)) {
      stoppedEarly = true; // cycling cursor: pages may remain unseen
      break;
    }
    seenCursors.add(next);
    cursor = next;
    if (matches.length >= limit) break;
    if (page === CREATOR_SCAN_MAX_PAGES - 1) stoppedEarly = true; // page cap, more remained
  }
  return {
    hits: matches.slice(0, limit).map((m) => toSearchHit(m, opts)),
    scanned,
    scanCapped: stoppedEarly && matches.length < limit,
    ...(scanError ? { scanError } : {}),
  };
}

// ---------------------------------------------------------------------------
// Creator search + top-creators leaderboard. Field driver: a mobile-beta user
// asked to "search posts by top creators, similar to the leaderboard on the
// actual website" (Discord). Two backends, one hit shape:
//   • GET /api/v1/creators           — username search (documented public API)
//   • tRPC leaderboard.getLeaderboard — the website's ranked creator boards;
//     the v1 API exposes NO leaderboard ordering (/creators is join-date
//     ordered), so this mirrors the site's own request. Civitai's bot gate
//     401s a plain fetch UA ("Please use the public API instead"), so the
//     request carries browser-shaped headers — same approach the mobile app
//     already uses for its tRPC calls.
// ---------------------------------------------------------------------------

export interface CivitaiCreatorHit {
  username: string;
  /** civitai.com profile page for the creator. */
  profile_url: string;
  /** Number of published models (username-search mode; API omits it for 0). */
  model_count?: number;
  /** Leaderboard rank, 1-based (top-creators mode only). */
  position?: number;
  /** Leaderboard score (top-creators mode only). */
  score?: number;
  downloads?: number;
  thumbs_up?: number;
  generations?: number;
  /** Models counted into the leaderboard score (top-creators mode only). */
  entries?: number;
}

const CIVITAI_LEADERBOARDS = [
  "overall",
  "overall_90",
  "overall_nsfw",
  "new_creators",
] as const;
export type CivitaiLeaderboard = (typeof CIVITAI_LEADERBOARDS)[number];

function creatorProfileUrl(username: string): string {
  return `https://civitai.com/user/${encodeURIComponent(username)}`;
}

interface CivitaiCreatorsResponse {
  items?: Array<{ username?: string; modelCount?: number; link?: string }>;
  metadata?: { totalItems?: number };
}

/**
 * Search CivitAI creators by (partial) username via GET /api/v1/creators.
 * Returns matching creators plus the API's total match count.
 */
export async function searchCivitaiCreators(
  query: string,
  opts: { limit?: number } = {},
): Promise<{ hits: CivitaiCreatorHit[]; total?: number }> {
  const params = new URLSearchParams();
  params.set("query", query);
  params.set("limit", String(Math.min(Math.max(opts.limit ?? 10, 1), 50)));
  const data = await civitaiGet<CivitaiCreatorsResponse>(
    `/creators?${params.toString()}`,
  );
  const hits = (data.items ?? [])
    .filter((c): c is { username: string; modelCount?: number } => !!c.username)
    .map((c) => ({
      username: c.username,
      profile_url: creatorProfileUrl(c.username),
      model_count: c.modelCount ?? 0,
    }));
  return { hits, total: data.metadata?.totalItems };
}

/** Browser-shaped headers for the tRPC leaderboard request (see section note). */
const TRPC_BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Referer: "https://civitai.com/",
};

interface CivitaiLeaderboardEntry {
  position?: number;
  score?: number;
  user?: { username?: string; deletedAt?: string | null };
  metrics?: Array<{ type?: string; value?: number }>;
}

/**
 * Fetch a CivitAI creator leaderboard (the site's civitai.com/leaderboard
 * ranking). `board` picks which one: "overall" (default), "overall_90",
 * "overall_nsfw", or "new_creators".
 */
export async function fetchCivitaiTopCreators(
  opts: { board?: CivitaiLeaderboard; limit?: number } = {},
): Promise<CivitaiCreatorHit[]> {
  if (civitaiDisabled()) {
    throw new ModelError(CIVITAI_DISABLED_MESSAGE);
  }
  const board = opts.board ?? "overall";
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
  const input = encodeURIComponent(JSON.stringify({ json: { id: board } }));
  const url = `https://civitai.com/api/trpc/leaderboard.getLeaderboard?input=${input}`;
  logger.debug("CivitAI leaderboard request", { url });

  // No bearer token here: the leaderboard is public and the API token belongs
  // to the documented v1 surface, not the site's tRPC endpoints. Shares the
  // timeout + distinct network/status/non-JSON error surfacing of civitaiGet.
  // tokenSent: false — the leaderboard request intentionally carries no bearer
  // token, so a bot-gate 401 must NOT blame the configured v1 API token.
  const res = await civitaiFetch(url, TRPC_BROWSER_HEADERS);
  if (!res.ok) {
    await throwForCivitaiStatus(res, url, false);
  }
  const data = await parseCivitaiJson<{
    result?: { data?: { json?: CivitaiLeaderboardEntry[] } };
  }>(res, url);
  const entries = data.result?.data?.json ?? [];
  const metric = (e: CivitaiLeaderboardEntry, type: string) =>
    e.metrics?.find((m) => m.type === type)?.value;
  return entries
    .filter((e) => e.user?.username && !e.user.deletedAt)
    .slice(0, limit)
    .map((e) => ({
      username: e.user!.username!,
      profile_url: creatorProfileUrl(e.user!.username!),
      position: e.position,
      score: e.score,
      downloads: metric(e, "downloadCount"),
      thumbs_up: metric(e, "thumbsUpCount"),
      generations: metric(e, "generationCount"),
      entries: metric(e, "entries"),
    }));
}

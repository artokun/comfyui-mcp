import { getComfyUIBaseUrl } from "../config.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { detectManagerApi, managerApiPrefixFor, type ManagerMode } from "./node-management.js";

/** Same cap as panel_search_nodes / the panel's SEARCH_LIMIT_CAP (#1287). */
export const SEARCH_LIMIT_CAP = 40;

export type MappingsMode = ManagerMode;

export interface NodeSearchHit {
  id: string;
  title: string;
  description: string;
}

export interface NodeSearchResult {
  count: number;
  results: NodeSearchHit[];
  catalogue_size?: number;
  limit_cap?: number;
  /** Mode that actually produced the catalogue, when we had to leave cache. */
  requested_mode?: MappingsMode;
  degraded_from?: "cache";
  manager_outage?: boolean;
  supported?: boolean;
  query?: string;
  reason?: string;
  message?: string;
  source?: "host_http";
  note?: string;
}

export const HOST_HTTP_SEARCH_NOTE =
  "Searched via ComfyUI-Manager HTTP because the panel's browser request to " +
  "Manager getmappings did not complete. Live canvas reads still work; this is a " +
  "panel-origin transport failure, not a Manager outage or a missing pack.";

export type FetchMappings = (mode: MappingsMode) => Promise<unknown>;

const MODES: MappingsMode[] = ["cache", "remote", "local"];

let fetchMappingsOverride: FetchMappings | undefined;

/** Test seam — restore with `undefined` in afterEach. */
export function setFetchMappingsForTests(fn: FetchMappings | undefined): void {
  fetchMappingsOverride = fn;
}

function queryTerms(query: string): string[] {
  return String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function matchesAllTerms(hay: string, terms: string[]): boolean {
  return terms.every((t) => hay.includes(t));
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    const rec = value as { content?: Array<{ text?: string }>; message?: unknown };
    if (Array.isArray(rec.content)) {
      return rec.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
    }
    if (typeof rec.message === "string") return rec.message;
  }
  return "";
}

/** HTTP 5xx from Manager's getmappings — a Manager outage, not a missing pack. */
export function isManagerMappingsServerError(value: unknown): boolean {
  const text = extractText(value);
  return /getmappings/i.test(text) && /HTTP\s*5\d\d\b/.test(text);
}

/**
 * Panel wrap from comfyui-mcp-panel#1130 / comfyui-mcp#1472: the browser's
 * Manager `fetch` never completed, so there is no HTTP status or body.
 *
 * Anchored on the wrap + a transport cause at the START of that cause.
 * A Manager-originated rejection that merely mentions "Failed to fetch" or
 * "NetworkError" mid-sentence is not this. AbortError is the caller's own
 * cancellation. Mutating Manager routes (install/queue) do not inherit the
 * read-only host-HTTP fallback this predicate gates.
 */
export function isManagerTransportFetchFailure(value: unknown): boolean {
  const text = extractText(value).replace(/^(?:Error:\s*)+/i, "").trim();
  if (!text) return false;
  const match = /^ComfyUI-Manager request to (\S+) did not complete:\s*([\s\S]+)$/i.exec(text);
  if (!match) return false;
  const path = match[1] ?? "";
  const cause = (match[2] ?? "").trim();
  if (!/\/(?:v2\/)?customnode\/(?:getmappings|installed)(?:\?|$)/i.test(path)) return false;
  if (/^AbortError\b/i.test(cause)) return false;
  if (/\bHTTP\s*\d{3}\b/.test(cause)) return false;
  return (
    /^(?:TypeError:\s*)?Failed to fetch\b/i.test(cause) ||
    /^fetch failed\.?$/i.test(cause) ||
    /^NetworkError\b/i.test(cause)
  );
}

export function dualCauseSearchFailure(
  query: string,
  panelErr: unknown,
  hostErr: unknown,
): NodeSearchResult {
  const panel = extractText(panelErr) || "panel Manager request did not complete";
  const host = extractText(hostErr) || "host Manager HTTP failed";
  return {
    supported: false,
    count: 0,
    results: [],
    query: query == null ? "" : String(query),
    reason: panel,
    message:
      "Node-registry search could not complete: the panel's ComfyUI-Manager request " +
      "did not complete (Failed to fetch), and host Manager HTTP mappings also failed. " +
      `Panel: ${panel} Host: ${host} ` +
      "That is not a Manager outage inferred from a transport-only fetch failure, and " +
      "not proof the pack is missing. Retry after Manager recovers, or search with " +
      'search_custom_nodes action:"search" (queries api.comfy.org directly, not through Manager).',
  };
}

export function catalogueSize(data: unknown): number {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") return Object.keys(data).length;
  return 0;
}

/**
 * Normalize a ComfyUI-Manager `/customnode/getmappings` payload into
 * `{ count, results:[{id,title,description}] }`. Mirrors the panel parser
 * (array or repo-key map). `id` is cnr/reference or the map key — never title.
 */
export function parseNodeMappings(data: unknown, query: string, limit?: number): NodeSearchResult {
  const terms = queryTerms(query);
  const out: NodeSearchHit[] = [];
  const push = (id: unknown, title: unknown, desc: unknown, classNames?: unknown) => {
    if (id == null || id === "") return;
    const idStr = String(id);
    const titleStr = title == null ? idStr : String(title);
    const descStr = String(desc ?? "").slice(0, 160);
    const classes = Array.isArray(classNames) ? classNames.map(String).join(" ") : "";
    const hay = `${idStr} ${titleStr} ${descStr} ${classes}`.toLowerCase();
    if (matchesAllTerms(hay, terms)) {
      out.push({ id: idStr, title: titleStr, description: descStr });
    }
  };
  if (Array.isArray(data)) {
    for (const p of data) {
      if (!p || typeof p !== "object") continue;
      const pack = p as {
        id?: unknown;
        reference?: unknown;
        title?: unknown;
        title_aux?: unknown;
        description?: unknown;
        nodename?: unknown;
      };
      push(pack.id ?? pack.reference ?? pack.title, pack.title ?? pack.title_aux, pack.description, pack.nodename);
    }
  } else if (data && typeof data === "object") {
    for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
      const classes = Array.isArray(val) && Array.isArray(val[0]) ? val[0] : undefined;
      const meta = Array.isArray(val) ? val[1] : val;
      const m =
        meta && typeof meta === "object"
          ? (meta as { id?: unknown; reference?: unknown; title?: unknown; title_aux?: unknown; description?: unknown })
          : {};
      push(m.id ?? m.reference ?? key, m.title ?? m.title_aux, m.description, classes);
    }
  }
  const requested = Number(limit) || 15;
  const max = Math.min(requested, SEARCH_LIMIT_CAP);
  const result: NodeSearchResult = {
    count: out.length,
    results: out.slice(0, max),
    catalogue_size: catalogueSize(data),
  };
  if (requested > SEARCH_LIMIT_CAP) result.limit_cap = SEARCH_LIMIT_CAP;
  return result;
}

export function managerMappingsOutageResult(query: string, err: unknown): NodeSearchResult {
  const reason = extractText(err) || "ComfyUI-Manager mappings HTTP 500";
  return {
    supported: false,
    manager_outage: true,
    count: 0,
    results: [],
    query: query == null ? "" : String(query),
    reason,
    message:
      "Node-registry search could not complete: ComfyUI-Manager's mappings endpoint is " +
      "returning HTTP 5xx. That is a Manager outage, not proof this pack is missing. " +
      "Retry after Manager recovers, or search with search_custom_nodes action:\"search\" " +
      "(queries api.comfy.org directly, not through Manager).",
  };
}

async function defaultFetchMappings(mode: MappingsMode): Promise<unknown> {
  const base = getComfyUIBaseUrl();
  const api = await detectManagerApi(base);
  const path = `${managerApiPrefixFor(api)}/customnode/getmappings?mode=${encodeURIComponent(mode)}`;
  const res = await comfyuiFetch(`${base}${path}`);
  if (!res.ok) {
    throw Object.assign(new Error(`Manager customnode/getmappings?mode=${mode}: HTTP ${res.status}`), {
      status: res.status,
    });
  }
  return res.json();
}

function resolveFetch(fn?: FetchMappings): FetchMappings {
  return fn ?? fetchMappingsOverride ?? defaultFetchMappings;
}

/**
 * Search installable packs via Manager getmappings.
 *
 * Cache is tried first (what the panel asks for). An HTTP 5xx from that
 * endpoint is a Manager outage on one source, not a missing pack: retry
 * remote, then local. If every mode 5xxs, return a structured outage —
 * never throw a "not found" and never fail the whole search.
 */
export async function searchNodesViaMappings(opts: {
  query: string;
  limit?: number;
  fetchMappings?: FetchMappings;
}): Promise<NodeSearchResult> {
  const fetchMappings = resolveFetch(opts.fetchMappings);
  let lastErr: unknown;
  let data: unknown;
  let usedMode: MappingsMode | undefined;
  let sawServerError = false;

  for (const mode of MODES) {
    try {
      data = await fetchMappings(mode);
      usedMode = mode;
      break;
    } catch (err) {
      lastErr = err;
      if (isManagerMappingsServerError(err)) {
        sawServerError = true;
        continue;
      }
      if (sawServerError) continue;
      throw err;
    }
  }

  if (usedMode === undefined) {
    return managerMappingsOutageResult(opts.query, lastErr);
  }

  const parsed = parseNodeMappings(data, opts.query, opts.limit);
  if (usedMode === "cache") return parsed;
  return {
    ...parsed,
    requested_mode: usedMode,
    degraded_from: "cache",
    message:
      `ComfyUI-Manager's cache mappings endpoint returned HTTP 5xx; searched via ` +
      `mode=${usedMode} instead. That 500 is a Manager outage on the cache source, ` +
      `not proof the pack is missing.`,
  };
}

async function hostSearchAfterTransport(
  opts: {
    query: string;
    limit?: number;
    fetchMappings?: FetchMappings;
  },
  panelErr: unknown,
): Promise<NodeSearchResult> {
  try {
    const parsed = await searchNodesViaMappings(opts);
    if (parsed.manager_outage) {
      return {
        ...dualCauseSearchFailure(opts.query, panelErr, parsed.reason ?? parsed.message),
        manager_outage: true,
      };
    }
    return { ...parsed, source: "host_http", note: HOST_HTTP_SEARCH_NOTE };
  } catch (hostErr) {
    return dualCauseSearchFailure(opts.query, panelErr, hostErr);
  }
}

function shouldHostSearch(value: unknown): boolean {
  return isManagerTransportFetchFailure(value) || isManagerMappingsServerError(value);
}

/**
 * Panel nodes_search first. If the panel surfaces a mappings HTTP 5xx
 * (throw or fail() ToolResult), degrade to searchNodesViaMappings.
 * If the panel's Manager fetch never completed (`Failed to fetch` wrap),
 * the same host-HTTP search is used — that is a panel-origin transport
 * failure, not a Manager outage and not a missing pack.
 */
export async function searchPanelNodes(opts: {
  panelSearch: () => Promise<unknown>;
  query: string;
  limit?: number;
  fetchMappings?: FetchMappings;
}): Promise<{ via: "panel"; value: unknown } | { via: "fallback"; value: NodeSearchResult }> {
  try {
    const value = await opts.panelSearch();
    if (!shouldHostSearch(value)) return { via: "panel", value };
    if (isManagerTransportFetchFailure(value)) {
      return { via: "fallback", value: await hostSearchAfterTransport(opts, value) };
    }
    return { via: "fallback", value: await searchNodesViaMappings(opts) };
  } catch (err) {
    if (!shouldHostSearch(err)) throw err;
    if (isManagerTransportFetchFailure(err)) {
      return { via: "fallback", value: await hostSearchAfterTransport(opts, err) };
    }
    return { via: "fallback", value: await searchNodesViaMappings(opts) };
  }
}

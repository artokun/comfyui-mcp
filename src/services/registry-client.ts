import { RegistryError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const REGISTRY_BASE = "https://api.comfy.org";

export interface RegistrySearchResult {
  id: string;
  name: string;
  description: string;
  author: string;
  repository: string;
  latest_version?: string;
  total_install: number;
  tags?: string[];
}

export interface NodePackDetails extends RegistrySearchResult {
  versions: Array<{ version: string; changelog?: string }>;
  nodes: string[];
  license?: string;
  created_at: string;
  updated_at: string;
}

/**
 * The ComfyUI Registry returns `latest_version` (and `versions[]` entries) as
 * OBJECTS — e.g. `{ version: "8.28.3", changelog, createdAt, ... }` — not as
 * the bare version string. Naively rendering the object yields "[object
 * Object]", and passing it where a string is expected throws
 * "value.toLowerCase is not a function". Coerce to the version string here so
 * every consumer (search/details renderers, skill cache) gets a clean string.
 */
export function extractVersionString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object") {
    const v = (value as { version?: unknown }).version;
    if (typeof v === "string") return v.trim() || undefined;
  }
  return undefined;
}

export interface SearchNodesOptions {
  page?: number;
  limit?: number;
  tags?: string[];
}

async function registryFetch<T>(path: string): Promise<T> {
  const url = `${REGISTRY_BASE}${path}`;
  logger.debug("Registry API request", { url });

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new RegistryError(
      `Registry API ${res.status}: ${res.statusText}`,
      { url, status: res.status, body },
    );
  }
  return res.json() as Promise<T>;
}

export async function searchNodes(
  query: string,
  options: SearchNodesOptions = {},
): Promise<RegistrySearchResult[]> {
  const { page = 1, limit = 10 } = options;

  // Upstream bug: api.comfy.org/nodes accepts a `search` query param but
  // ignores it server-side, always returning the default paginated list.
  // Workaround: fetch a larger window and rank-filter client-side by query
  // against id / name / description / author, boosting by total_install so
  // canonical packs win over obscure substring matches.
  // Originally diagnosed and patched by João Lucas (github.com/joaolvivas)
  // in joaolvivas/comfyui-mcp-byjlucas@f066b597 (2026-05-12).
  const fetchLimit = 100;
  const lowerQuery = query.trim().toLowerCase();

  const params = new URLSearchParams({
    page: "1",
    limit: String(fetchLimit),
  });
  // Still pass the param in case upstream fixes the filter eventually.
  if (lowerQuery) params.set("search", query);

  const data = await registryFetch<{ nodes?: RegistrySearchResult[] }>(
    `/nodes?${params}`,
  );
  const allNodes = Array.isArray(data) ? data : (data.nodes ?? []);

  const matchScore = (n: RegistrySearchResult): number => {
    if (!lowerQuery) return 0;
    const id = (n.id ?? "").toLowerCase();
    const name = (n.name ?? "").toLowerCase();
    const desc = (n.description ?? "").toLowerCase();
    const author = (n.author ?? "").toLowerCase();
    let score = 0;
    if (id === lowerQuery) score += 1000;
    else if (id.includes(lowerQuery)) score += 500;
    if (name === lowerQuery) score += 800;
    else if (name.includes(lowerQuery)) score += 300;
    if (author.includes(lowerQuery)) score += 200;
    if (desc.includes(lowerQuery)) score += 100;
    if (score === 0) return 0; // no textual match — drop, do NOT inflate via popularity
    if (typeof n.total_install === "number" && n.total_install > 0) {
      score += Math.min(50, Math.floor(Math.log10(n.total_install + 1) * 10));
    }
    return score;
  };

  const filtered = lowerQuery
    ? allNodes
        .map((n) => ({ node: n, score: matchScore(n) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .map(({ node }) => node)
    : allNodes;

  const start = (page - 1) * limit;
  const paged = filtered.slice(start, start + limit);
  logger.info(
    `Registry search "${query}": fetched ${allNodes.length}, matched ${filtered.length}, returning ${paged.length} (page ${page}, limit ${limit})`,
  );
  return paged.map(normalizeSearchResult);
}

/** Coerce the registry's object-shaped `latest_version` into a string. */
function normalizeSearchResult(node: RegistrySearchResult): RegistrySearchResult {
  return {
    ...node,
    latest_version: extractVersionString(
      (node as { latest_version?: unknown }).latest_version,
    ),
  };
}

export async function getNodePackDetails(
  id: string,
): Promise<NodePackDetails> {
  const data = await registryFetch<NodePackDetails>(`/nodes/${encodeURIComponent(id)}`);
  logger.info(`Fetched details for node pack "${id}"`);
  const rawVersions = (data as { versions?: unknown }).versions;
  const versions: Array<{ version: string; changelog?: string }> = [];
  if (Array.isArray(rawVersions)) {
    for (const v of rawVersions) {
      const version = extractVersionString((v as { version?: unknown })?.version);
      if (version) {
        versions.push({ version, changelog: (v as { changelog?: string })?.changelog });
      }
    }
  }
  return {
    ...data,
    latest_version: extractVersionString(
      (data as { latest_version?: unknown }).latest_version,
    ),
    versions,
  };
}

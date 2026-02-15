import { RegistryError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const REGISTRY_BASE = "https://api.comfy.org";

export interface RegistrySearchResult {
  id: string;
  name: string;
  description: string;
  author: string;
  repository: string;
  latest_version: string;
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
  const params = new URLSearchParams({
    search: query,
    page: String(page),
    limit: String(limit),
  });

  const data = await registryFetch<{ nodes?: RegistrySearchResult[] }>(
    `/nodes?${params}`,
  );

  // The API may wrap results in a `nodes` array or return them directly
  const results = Array.isArray(data) ? data : (data.nodes ?? []);
  logger.info(`Registry search for "${query}" returned ${results.length} results`);
  return results;
}

export async function getNodePackDetails(
  id: string,
): Promise<NodePackDetails> {
  const data = await registryFetch<NodePackDetails>(`/nodes/${encodeURIComponent(id)}`);
  logger.info(`Fetched details for node pack "${id}"`);
  return data;
}

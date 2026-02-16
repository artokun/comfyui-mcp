import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { FileHasher } from "./file-hasher.js";

export interface CivitaiModelVersion {
  id: number;
  modelId: number;
  name: string;
  model?: {
    name: string;
    type: string;
  };
}

/**
 * Look up a model/LoRA on CivitAI by its AutoV2 hash.
 * Updates the file_hashes cache with the result.
 */
export async function lookupByHash(
  hasher: FileHasher,
  filename: string,
  autov2: string,
): Promise<CivitaiModelVersion | null> {
  const url = `https://civitai.com/api/v1/model-versions/by-hash/${autov2}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.civitaiApiToken) {
    headers["Authorization"] = `Bearer ${config.civitaiApiToken}`;
  }

  try {
    logger.debug(`CivitAI lookup: ${autov2} (${filename})`);
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });

    if (res.status === 404) {
      // Not found on CivitAI — private or unlisted model
      hasher.updateCivitaiInfo(filename, null, null, null);
      logger.debug(`CivitAI: ${filename} not found (private/unlisted)`);
      return null;
    }

    if (!res.ok) {
      logger.warn(`CivitAI API error: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = (await res.json()) as CivitaiModelVersion;

    hasher.updateCivitaiInfo(
      filename,
      data.id,
      data.model?.name ?? data.name,
      data.modelId,
    );

    logger.info(
      `CivitAI match: ${filename} → ${data.model?.name ?? data.name} (version ${data.id})`,
    );
    return data;
  } catch (err) {
    logger.warn(`CivitAI lookup failed for ${filename}`, {
      error: err instanceof Error ? err.message : err,
    });
    return null;
  }
}

/**
 * Batch-check multiple files against CivitAI.
 * Only checks files that haven't been looked up yet.
 */
export async function batchLookup(
  hasher: FileHasher,
  files: Array<{ filename: string; autov2: string }>,
): Promise<Map<string, CivitaiModelVersion | null>> {
  const results = new Map<string, CivitaiModelVersion | null>();

  for (const file of files) {
    if (!hasher.needsCivitaiCheck(file.filename)) {
      const cached = hasher.getCached(file.filename);
      if (cached?.civitaiId) {
        results.set(file.filename, {
          id: cached.civitaiId,
          modelId: cached.civitaiModelId ?? 0,
          name: cached.civitaiName ?? file.filename,
        });
      } else {
        results.set(file.filename, null);
      }
      continue;
    }

    // Rate-limit: 1 request per 500ms to be polite
    const result = await lookupByHash(hasher, file.filename, file.autov2);
    results.set(file.filename, result);
    await new Promise((r) => setTimeout(r, 500));
  }

  return results;
}

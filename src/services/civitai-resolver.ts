import { config } from "../config.js";
import { ModelError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
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
}

interface CivitaiModelVersion {
  id: number;
  name?: string;
  downloadUrl?: string;
  files?: CivitaiFile[];
}

interface CivitaiModel {
  id: number;
  name?: string;
  type?: string;
  modelVersions?: CivitaiModelVersion[];
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
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.civitaiApiToken) {
    headers["Authorization"] = `Bearer ${config.civitaiApiToken}`;
  }
  return headers;
}

async function civitaiGet<T>(path: string): Promise<T> {
  // User-initiated Civitai actions fail FAST with the config explanation when
  // the kill-switch is set (issue #127) — never a hang against a blocked host.
  if (civitaiDisabled()) {
    throw new ModelError(CIVITAI_DISABLED_MESSAGE);
  }
  const url = `${CIVITAI_API_BASE}${path}`;
  logger.debug("CivitAI API request", { url });

  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 404) {
    throw new ModelError(`CivitAI resource not found: ${path}`, {
      url,
      status: 404,
    });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ModelError(`CivitAI API ${res.status}: ${res.statusText}`, {
      url,
      status: res.status,
      body,
    });
  }
  return (await res.json()) as T;
}

/** Pick the best file from a version's file list: primary first, else the first. */
function pickFile(version: CivitaiModelVersion): CivitaiFile | undefined {
  const files = version.files ?? [];
  return files.find((f) => f.primary) ?? files[0];
}

function resolveFromVersion(
  version: CivitaiModelVersion,
  modelName?: string,
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
    modelName,
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

  return resolveFromVersion(version, model.name);
}

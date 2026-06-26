import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { generateSkill } from "./skill-generator.js";
import { getNodePackDetails } from "./registry-client.js";
import { logger } from "../utils/logger.js";

const DEFAULT_CACHE_DIR = join(homedir(), ".comfyui-mcp", "skill-cache");
const HASH_CHARS = 12;

export interface SkillCacheMetadata {
  source: string;
  version: string;
  cachedAt: string;
  contentHash: string;
}

export interface GenerateSkillCachedOptions {
  refresh?: boolean;
}

export interface GenerateSkillCachedResult {
  markdown: string;
  cacheHit: boolean;
  cacheDir: string;
  safeKey: string;
  metadata: SkillCacheMetadata;
}

export interface SkillCacheDeps {
  generate: (source: string) => Promise<string>;
  getDetails: typeof getNodePackDetails;
  now: () => Date;
}

const defaultDeps: SkillCacheDeps = {
  generate: generateSkill,
  getDetails: getNodePackDetails,
  now: () => new Date(),
};

function cacheDir(): string {
  return resolve(process.env.COMFYUI_SKILL_CACHE_DIR || DEFAULT_CACHE_DIR);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, HASH_CHARS);
}

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeSkillSource(source: string): string {
  const trimmed = source.trim();
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function safeSegment(value: string): string {
  const segment = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return segment || "source";
}

export function buildSkillCacheKey(source: string, version: string): string {
  const normalized = normalizeSkillSource(source);
  return `${safeSegment(normalized)}-${safeSegment(version)}-${shortHash(`${normalized}\0${version}`)}`;
}

async function resolveVersion(
  source: string,
  deps: SkillCacheDeps,
): Promise<string> {
  const normalized = normalizeSkillSource(source);
  if (!normalized.includes("github.com")) {
    try {
      const details = await deps.getDetails(normalized);
      // The registry's version fields can be objects, not strings; only accept
      // an actual string so safeSegment()'s .toLowerCase() never sees an object
      // (the "value.toLowerCase is not a function" crash on a bare registry id).
      const candidate = details.latest_version ?? details.versions?.[0]?.version;
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate;
      }
    } catch (err) {
      logger.warn("Could not resolve node pack version for skill cache; using source hash", {
        source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return `source-${shortHash(normalized)}`;
}

function parseMetadata(raw: string): SkillCacheMetadata | undefined {
  try {
    const data = JSON.parse(raw) as Partial<SkillCacheMetadata>;
    if (
      typeof data.source === "string" &&
      typeof data.version === "string" &&
      typeof data.cachedAt === "string" &&
      typeof data.contentHash === "string"
    ) {
      return {
        source: data.source,
        version: data.version,
        cachedAt: data.cachedAt,
        contentHash: data.contentHash,
      };
    }
  } catch {
    // Ignore corrupt cache entries.
  }
  return undefined;
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

async function readCachedSkill(
  source: string,
  version: string,
  dir: string,
  safeKey: string,
): Promise<GenerateSkillCachedResult | undefined> {
  const normalized = normalizeSkillSource(source);
  const entryDir = join(dir, safeKey);
  let metadataRaw: string;
  try {
    metadataRaw = await readFile(join(entryDir, "metadata.json"), "utf-8");
  } catch (err) {
    if (isNotFoundError(err)) return undefined;
    throw err;
  }

  const metadata = parseMetadata(metadataRaw);
  if (
    !metadata ||
    normalizeSkillSource(metadata.source) !== normalized ||
    metadata.version !== version
  ) {
    return undefined;
  }

  let markdown: string;
  try {
    markdown = await readFile(join(entryDir, "SKILL.md"), "utf-8");
  } catch (err) {
    if (isNotFoundError(err)) return undefined;
    throw err;
  }

  if (contentHash(markdown) !== metadata.contentHash) {
    return undefined;
  }

  return { markdown, cacheHit: true, cacheDir: dir, safeKey, metadata };
}

async function writeCachedSkill(
  dir: string,
  safeKey: string,
  markdown: string,
  metadata: SkillCacheMetadata,
): Promise<void> {
  const entryDir = join(dir, safeKey);
  const suffix = `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const skillPath = join(entryDir, "SKILL.md");
  const metadataPath = join(entryDir, "metadata.json");
  const tempSkillPath = join(entryDir, `SKILL.md${suffix}`);
  const tempMetadataPath = join(entryDir, `metadata.json${suffix}`);

  await mkdir(entryDir, { recursive: true });
  await writeFile(tempSkillPath, markdown, "utf-8");
  await writeFile(tempMetadataPath, JSON.stringify(metadata, null, 2), "utf-8");
  await rename(tempSkillPath, skillPath);
  await rename(tempMetadataPath, metadataPath);
}

export async function generateSkillCached(
  source: string,
  options: GenerateSkillCachedOptions = {},
  deps: SkillCacheDeps = defaultDeps,
): Promise<GenerateSkillCachedResult> {
  const dir = cacheDir();
  const version = await resolveVersion(source, deps);
  const safeKey = buildSkillCacheKey(source, version);

  if (!options.refresh) {
    try {
      const cached = await readCachedSkill(source, version, dir, safeKey);
      if (cached) return cached;
    } catch (err) {
      logger.warn("Skill cache read failed; generating without cache hit", {
        source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const markdown = await deps.generate(source);
  const metadata: SkillCacheMetadata = {
    source,
    version,
    cachedAt: deps.now().toISOString(),
    contentHash: contentHash(markdown),
  };

  try {
    await writeCachedSkill(dir, safeKey, markdown, metadata);
  } catch (err) {
    logger.warn("Skill cache write failed; returning generated skill without caching", {
      source,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { markdown, cacheHit: false, cacheDir: dir, safeKey, metadata };
}

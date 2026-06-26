import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The product resolves COMFYUI_SKILL_CACHE_DIR via path.resolve(), which on
// Windows adds a drive prefix (e.g. "/cache" -> "C:\\cache"). Build the test's
// cache root the same way so mock keys and assertions match the product's
// computed paths on the current OS.
const CACHE_ROOT = resolve("/cache");

const fsMock = vi.hoisted(() => ({
  dirs: new Set<string>(),
  files: new Map<string, string>(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  writeFile: vi.fn(),
}));

const generateSkillMock = vi.hoisted(() => vi.fn());
const getNodePackDetailsMock = vi.hoisted(() => vi.fn());
const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: fsMock.mkdir,
  readdir: fsMock.readdir,
  readFile: fsMock.readFile,
  rename: fsMock.rename,
  writeFile: fsMock.writeFile,
}));

vi.mock("../../services/skill-generator.js", () => ({
  generateSkill: generateSkillMock,
}));

vi.mock("../../services/registry-client.js", () => ({
  getNodePackDetails: getNodePackDetailsMock,
}));

vi.mock("../../utils/logger.js", () => ({
  logger: loggerMock,
}));

import { generateSkillCached } from "../../services/skill-cache.js";

function ensureDir(path: string): void {
  if (path === dirname(path)) {
    fsMock.dirs.add(path);
    return;
  }
  ensureDir(dirname(path));
  fsMock.dirs.add(path);
}

function resetFs(): void {
  fsMock.dirs.clear();
  fsMock.files.clear();
  // Seed the platform filesystem root (e.g. "C:\\" on Windows) so dirname()
  // chains from CACHE_ROOT terminate at a known directory.
  fsMock.dirs.add(resolve("/"));
  fsMock.mkdir.mockImplementation(async (path: string) => {
    ensureDir(path);
  });
  fsMock.readdir.mockImplementation(async (path: string) => {
    if (!fsMock.dirs.has(path)) throw new Error(`ENOENT: ${path}`);
    return [...fsMock.dirs]
      .filter((dir) => dir !== path && dirname(dir) === path)
      .map((dir) => ({
        name: dir.slice(path.endsWith("/") ? path.length : path.length + 1),
        isDirectory: () => true,
      }));
  });
  fsMock.readFile.mockImplementation(async (path: string) => {
    const data = fsMock.files.get(path);
    if (data === undefined) {
      const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return data;
  });
  fsMock.writeFile.mockImplementation(async (path: string, data: string) => {
    if (!fsMock.dirs.has(dirname(path))) throw new Error(`ENOENT: ${dirname(path)}`);
    fsMock.files.set(path, data);
  });
  fsMock.rename.mockImplementation(async (oldPath: string, newPath: string) => {
    const data = fsMock.files.get(oldPath);
    if (data === undefined) throw new Error(`ENOENT: ${oldPath}`);
    if (!fsMock.dirs.has(dirname(newPath))) throw new Error(`ENOENT: ${dirname(newPath)}`);
    fsMock.files.set(newPath, data);
    fsMock.files.delete(oldPath);
  });
}

beforeEach(() => {
  process.env.COMFYUI_SKILL_CACHE_DIR = CACHE_ROOT;
  vi.clearAllMocks();
  resetFs();
  generateSkillMock.mockResolvedValue("# Generated Skill");
  getNodePackDetailsMock.mockResolvedValue({
    latest_version: "1.2.3",
    versions: [],
  });
});

describe("generateSkillCached", () => {
  it("writes on cache miss and returns the cached SKILL.md on repeat calls", async () => {
    const first = await generateSkillCached("comfyui-impact-pack");
    expect(first.cacheHit).toBe(false);
    expect(first.metadata.version).toBe("1.2.3");
    expect(generateSkillMock).toHaveBeenCalledTimes(1);
    expect(getNodePackDetailsMock).toHaveBeenCalledTimes(1);
    expect(fsMock.files.has(join(CACHE_ROOT, first.safeKey, "SKILL.md"))).toBe(true);
    expect(fsMock.files.has(join(CACHE_ROOT, first.safeKey, "metadata.json"))).toBe(true);

    generateSkillMock.mockResolvedValue("# Should Not Regenerate");
    const second = await generateSkillCached("comfyui-impact-pack");
    expect(second.cacheHit).toBe(true);
    expect(second.markdown).toBe("# Generated Skill");
    expect(generateSkillMock).toHaveBeenCalledTimes(1);
    expect(getNodePackDetailsMock).toHaveBeenCalledTimes(2);
  });

  it("regenerates when the resolved version changes", async () => {
    getNodePackDetailsMock
      .mockResolvedValueOnce({ latest_version: "1.2.3", versions: [] })
      .mockResolvedValueOnce({ latest_version: "1.2.4", versions: [] });
    generateSkillMock
      .mockResolvedValueOnce("# Version 1.2.3")
      .mockResolvedValueOnce("# Version 1.2.4");

    const first = await generateSkillCached("comfyui-impact-pack");
    const second = await generateSkillCached("comfyui-impact-pack");

    expect(first.cacheHit).toBe(false);
    expect(first.metadata.version).toBe("1.2.3");
    expect(second.cacheHit).toBe(false);
    expect(second.metadata.version).toBe("1.2.4");
    expect(second.markdown).toBe("# Version 1.2.4");
    expect(second.safeKey).not.toBe(first.safeKey);
    expect(generateSkillMock).toHaveBeenCalledTimes(2);
    expect(getNodePackDetailsMock).toHaveBeenCalledTimes(2);
  });

  it("ignores cached entries whose markdown does not match metadata hash", async () => {
    const first = await generateSkillCached("comfyui-impact-pack");
    fsMock.files.set(join(CACHE_ROOT, first.safeKey, "SKILL.md"), "# Partial Skill");
    generateSkillMock.mockResolvedValueOnce("# Regenerated Skill");

    const second = await generateSkillCached("comfyui-impact-pack");

    expect(second.cacheHit).toBe(false);
    expect(second.markdown).toBe("# Regenerated Skill");
    expect(generateSkillMock).toHaveBeenCalledTimes(2);
  });

  it("bypasses and overwrites the cache when refresh is true", async () => {
    generateSkillMock.mockResolvedValueOnce("# Old Skill");
    const first = await generateSkillCached("comfyui-impact-pack");
    expect(first.cacheHit).toBe(false);

    generateSkillMock.mockResolvedValueOnce("# Refreshed Skill");
    const refreshed = await generateSkillCached("comfyui-impact-pack", { refresh: true });
    expect(refreshed.cacheHit).toBe(false);
    expect(refreshed.markdown).toBe("# Refreshed Skill");
    expect(generateSkillMock).toHaveBeenCalledTimes(2);

    const hit = await generateSkillCached("comfyui-impact-pack");
    expect(hit.cacheHit).toBe(true);
    expect(hit.markdown).toBe("# Refreshed Skill");
  });

  it("does not crash on a bare registry id when latest_version is an object (the 'value.toLowerCase is not a function' bug)", async () => {
    // Simulate the raw registry shape leaking through: latest_version as an
    // object. resolveVersion must not pass a non-string into safeSegment().
    getNodePackDetailsMock.mockResolvedValue({
      latest_version: { version: "8.28.3", changelog: "" },
      versions: [{ version: "8.28.3" }],
    });

    const result = await generateSkillCached("comfyui-impact-pack");

    expect(result.cacheHit).toBe(false);
    expect(result.markdown).toBe("# Generated Skill");
    // The key point: a usable string version, never an object stringified to
    // "[object Object]", and no thrown TypeError.
    expect(typeof result.metadata.version).toBe("string");
    expect(result.metadata.version).not.toContain("[object Object]");
    expect(typeof result.safeKey).toBe("string");
  });

  it("falls back to normal generation when cache reads or writes fail", async () => {
    fsMock.readFile.mockRejectedValueOnce(new Error("read denied"));
    fsMock.writeFile.mockRejectedValue(new Error("write denied"));

    const result = await generateSkillCached("https://github.com/acme/nodes");

    expect(result.cacheHit).toBe(false);
    expect(result.markdown).toBe("# Generated Skill");
    expect(generateSkillMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalled();
  });
});

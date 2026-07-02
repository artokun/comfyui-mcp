import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homeState = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => homeState.dir || actual.homedir() };
});

// generation-tracker.ts pulls in config.ts (top-level await for port detect), so
// each test re-evaluates both with a fresh process.env via vi.resetModules().
const OLD_ENV = process.env;
const OLD_ARGV = process.argv;

describe("GenerationTracker default DB path", () => {
  const tmpDirs: string[] = [];
  const tmp = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...OLD_ENV };
    process.argv = [...OLD_ARGV];
    process.env.COMFYUI_API_KEY = "";
    process.env.COMFYUI_URL = "";
    process.env.COMFYUI_PATH = "";
    process.env.COMFYUI_HOST = "";
    process.env.COMFYUI_PORT = "8188"; // skip port auto-detect
    process.env.COMFYUI_MCP_FORCE_REMOTE = "";
    process.env.COMFYUI_MCP_DATA_DIR = "";
    homeState.dir = "";
  });

  afterEach(() => {
    process.env = OLD_ENV;
    process.argv = OLD_ARGV;
    vi.restoreAllMocks();
    while (tmpDirs.length) {
      try {
        rmSync(tmpDirs.pop()!, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("remote mode: writes the DB under the data dir scoped by instance, NOT cwd", async () => {
    const dataDir = tmp("gt-data-");
    process.env.COMFYUI_URL = "http://192.168.1.50:8188";
    process.env.COMFYUI_MCP_DATA_DIR = dataDir;
    const { GenerationTracker } = await import("../../services/generation-tracker.js");
    const t = new GenerationTracker();
    const expected = join(dataDir, "instances", "192.168.1.50_8188", "generations.db");
    expect(existsSync(expected)).toBe(true);
    t.close();
  });

  it("force-remote loopback: scoped under the data dir, not cwd", async () => {
    const dataDir = tmp("gt-data-");
    process.env.COMFYUI_URL = "http://127.0.0.1:8188";
    process.env.COMFYUI_MCP_FORCE_REMOTE = "1";
    process.env.COMFYUI_MCP_DATA_DIR = dataDir;
    const { GenerationTracker } = await import("../../services/generation-tracker.js");
    const t = new GenerationTracker();
    const expected = join(dataDir, "instances", "localhost_8188", "generations.db");
    expect(existsSync(expected)).toBe(true);
    t.close();
  });

  it("defaults the base dir to <home>/.comfyui-mcp when COMFYUI_MCP_DATA_DIR is unset", async () => {
    const fakeHome = tmp("gt-home-");
    homeState.dir = fakeHome;
    process.env.COMFYUI_URL = "http://192.168.1.50:8188";
    const { GenerationTracker } = await import("../../services/generation-tracker.js");
    const t = new GenerationTracker();
    const expected = join(fakeHome, ".comfyui-mcp", "instances", "192.168.1.50_8188", "generations.db");
    expect(existsSync(expected)).toBe(true);
    t.close();
  });

  it("explicit dbPath argument still wins over the default", async () => {
    const dataDir = tmp("gt-data-");
    const dbFile = join(dataDir, "custom", "explicit.db");
    const { GenerationTracker } = await import("../../services/generation-tracker.js");
    const t = new GenerationTracker(dbFile);
    expect(existsSync(dbFile)).toBe(true);
    t.close();
  });

  it("local install: DB stays inside the install's comfyui-mcp dir (unchanged)", async () => {
    const install = tmp("gt-install-");
    process.env.COMFYUI_PATH = install;
    const { GenerationTracker } = await import("../../services/generation-tracker.js");
    const t = new GenerationTracker();
    const expected = join(install, "comfyui-mcp", "generations.db");
    expect(existsSync(expected)).toBe(true);
    t.close();
  });
});

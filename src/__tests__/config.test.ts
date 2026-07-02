import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts has top-level await (port auto-detect). Use vi.resetModules() so
// each test re-evaluates it with a fresh process.env.
const OLD_ENV = process.env;
const OLD_ARGV = process.argv;

describe("config mode detection", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...OLD_ENV };
    process.argv = [...OLD_ARGV];
    // dotenv.config() in config.ts won't override an already-set value, even
    // if it's empty. Setting to "" instead of deleting prevents the package
    // root .env file from re-injecting these.
    process.env.COMFYUI_API_KEY = "";
    process.env.COMFYUI_URL = "";
    process.env.COMFYUI_PATH = "";
    process.env.COMFYUI_HOST = "";
    process.env.COMFYUI_PORT = "8188";
    process.env.COMFYUI_MCP_FORCE_REMOTE = "";
  });

  afterEach(() => {
    process.env = OLD_ENV;
    process.argv = OLD_ARGV;
    vi.restoreAllMocks();
  });

  it("isCloudMode() is true when COMFYUI_API_KEY is set", async () => {
    process.env.COMFYUI_API_KEY = "test-key";
    process.env.COMFYUI_PORT = "8188"; // skip auto-detect
    const mod = await import("../config.js");
    expect(mod.isCloudMode()).toBe(true);
    expect(mod.isRemoteMode()).toBe(false);
    expect(mod.isLocalMode()).toBe(false);
    expect(mod.getApiKey()).toBe("test-key");
    expect(mod.config.comfyuiPath).toBeUndefined();
  });

  it("smart-detect skips COMFYUI_PATH auto-detection for a non-loopback URL", async () => {
    process.env.COMFYUI_URL = "http://192.168.1.50:8188";
    const mod = await import("../config.js");
    expect(mod.isRemoteMode()).toBe(true);
    expect(mod.isCloudMode()).toBe(false);
    expect(mod.config.comfyuiPath).toBeUndefined();
  });

  it("loopback URL is treated as local (auto-detect allowed)", async () => {
    process.env.COMFYUI_URL = "http://127.0.0.1:8188";
    const mod = await import("../config.js");
    expect(mod.isRemoteMode()).toBe(false);
    expect(mod.isCloudMode()).toBe(false);
    expect(mod.isLocalMode()).toBe(true);
  });

  it("--force-remote overrides a loopback COMFYUI_URL into remote mode", async () => {
    process.env.COMFYUI_URL = "http://localhost:8188";
    process.argv = [...OLD_ARGV, "--force-remote"];
    const mod = await import("../config.js");
    expect(mod.isForceRemoteFlagSet()).toBe(true);
    expect(mod.isRemoteMode()).toBe(true);
    expect(mod.isLocalMode()).toBe(false);
    expect(mod.config.comfyuiPath).toBeUndefined();
  });

  it("COMFYUI_MCP_FORCE_REMOTE=1 overrides a loopback COMFYUI_URL into remote mode", async () => {
    process.env.COMFYUI_URL = "http://127.0.0.1:8188";
    process.env.COMFYUI_MCP_FORCE_REMOTE = "1";
    const mod = await import("../config.js");
    expect(mod.isRemoteMode()).toBe(true);
  });

  it("--force-remote with no COMFYUI_URL is a no-op (still local)", async () => {
    process.argv = [...OLD_ARGV, "--force-remote"];
    const mod = await import("../config.js");
    expect(mod.isForceRemoteFlagSet()).toBe(true);
    expect(mod.isRemoteMode()).toBe(false);
    expect(mod.isLocalMode()).toBe(true);
  });

  it("without --force-remote, a non-loopback URL is still remote (unaffected)", async () => {
    process.env.COMFYUI_URL = "http://192.168.1.50:8188";
    const mod = await import("../config.js");
    expect(mod.isForceRemoteFlagSet()).toBe(false);
    expect(mod.isRemoteMode()).toBe(true);
  });

  it("explicit COMFYUI_PATH always wins over smart-detect", async () => {
    process.env.COMFYUI_URL = "http://10.0.0.5:8188";
    process.env.COMFYUI_PATH = "/explicit/local/comfy";
    const mod = await import("../config.js");
    expect(mod.config.comfyuiPath).toBe("/explicit/local/comfy");
  });

  it("getApiKey() throws when not configured (local mode)", async () => {
    process.env.COMFYUI_PORT = "8188";
    const mod = await import("../config.js");
    expect(() => mod.getApiKey()).toThrow(/COMFYUI_API_KEY/);
  });

  it("getInstanceSlug() derives a filesystem-safe host_port for a remote URL", async () => {
    process.env.COMFYUI_URL = "http://192.168.1.50:8188";
    const mod = await import("../config.js");
    expect(mod.getInstanceSlug()).toBe("192.168.1.50_8188");
  });

  it("getInstanceSlug() keeps dots/hyphens for a RunPod-style https host", async () => {
    process.env.COMFYUI_URL = "https://abcd-8188.proxy.runpod.net";
    const mod = await import("../config.js");
    expect(mod.getInstanceSlug()).toBe("abcd-8188.proxy.runpod.net_443");
  });

  it("getInstanceSlug() is 'comfy-cloud' in cloud mode", async () => {
    process.env.COMFYUI_API_KEY = "test-key";
    process.env.COMFYUI_PORT = "8188";
    const mod = await import("../config.js");
    expect(mod.getInstanceSlug()).toBe("comfy-cloud");
  });
});

describe("remote self-hosted: path prefix + generic auth (#52)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...OLD_ENV };
    process.argv = [...OLD_ARGV];
    process.env.COMFYUI_API_KEY = "";
    process.env.COMFYUI_URL = "";
    process.env.COMFYUI_PATH = "";
    process.env.COMFYUI_HOST = "";
    process.env.COMFYUI_PORT = "8188";
    process.env.COMFYUI_AUTH_HEADER = "";
    process.env.COMFYUI_AUTH_SCHEME = "";
    process.env.COMFYUI_AUTH_TOKEN = "";
  });

  afterEach(() => {
    process.env = OLD_ENV;
    process.argv = OLD_ARGV;
    vi.restoreAllMocks();
  });

  it("preserves a path prefix from COMFYUI_URL into the base URL", async () => {
    process.env.COMFYUI_URL = "https://host.example.com/comfyapi";
    const mod = await import("../config.js");
    expect(mod.isRemoteMode()).toBe(true);
    expect(mod.getComfyUIBasePath()).toBe("/comfyapi");
    expect(mod.getComfyUIBaseUrl()).toBe("https://host.example.com:443/comfyapi");
  });

  it("no prefix → base URL has no trailing path", async () => {
    process.env.COMFYUI_URL = "http://192.168.1.50:8188";
    const mod = await import("../config.js");
    expect(mod.getComfyUIBasePath()).toBe("");
    expect(mod.getComfyUIBaseUrl()).toBe("http://192.168.1.50:8188");
  });

  it("no auth configured → empty headers", async () => {
    const mod = await import("../config.js");
    expect(mod.getComfyUIAuthHeaders()).toEqual({});
  });

  it("COMFYUI_AUTH_TOKEN defaults to Authorization: Bearer", async () => {
    process.env.COMFYUI_AUTH_TOKEN = "abc123";
    const mod = await import("../config.js");
    expect(mod.getComfyUIAuthHeaders()).toEqual({ Authorization: "Bearer abc123" });
  });

  it("custom header with no scheme → raw token (X-API-Key)", async () => {
    process.env.COMFYUI_AUTH_HEADER = "X-API-Key";
    process.env.COMFYUI_AUTH_TOKEN = "abc123";
    const mod = await import("../config.js");
    expect(mod.getComfyUIAuthHeaders()).toEqual({ "X-API-Key": "abc123" });
  });

  it("custom scheme on Authorization", async () => {
    process.env.COMFYUI_AUTH_SCHEME = "Token";
    process.env.COMFYUI_AUTH_TOKEN = "abc123";
    const mod = await import("../config.js");
    expect(mod.getComfyUIAuthHeaders()).toEqual({ Authorization: "Token abc123" });
  });

  it("generic auth does NOT enable Comfy Cloud mode", async () => {
    process.env.COMFYUI_URL = "https://host.example.com/comfyapi";
    process.env.COMFYUI_AUTH_TOKEN = "abc123";
    const mod = await import("../config.js");
    expect(mod.isCloudMode()).toBe(false);
    expect(mod.isRemoteMode()).toBe(true);
  });
});

describe("COMFYUI_PATH nested/wrapper self-heal (doubled-path bug)", () => {
  const tmpDirs: string[] = [];

  function makeRoot(dir: string): string {
    // Minimal markers _looks_like_comfyui_root / looksLikeComfyUIRoot check.
    writeFileSync(join(dir, "main.py"), "# fake comfyui entrypoint\n");
    mkdirSync(join(dir, "output"), { recursive: true });
    return dir;
  }

  function tmp(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  }

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...OLD_ENV };
    process.argv = [...OLD_ARGV];
    process.env.COMFYUI_API_KEY = "";
    process.env.COMFYUI_URL = "";
    process.env.COMFYUI_PATH = "";
    process.env.COMFYUI_HOST = "";
    process.env.COMFYUI_PORT = "8188"; // skip port auto-detect
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

  it("(a) a path that IS already a root → returned unchanged (no-op)", async () => {
    const root = makeRoot(tmp("cfg-root-"));
    process.env.COMFYUI_PATH = root;
    const mod = await import("../config.js");
    expect(mod.config.comfyuiPath).toBe(root);
  });

  it("(b) a wrapper whose nested ComfyUI/ is the real root → descends", async () => {
    const wrapper = tmp("cfg-wrap-");
    const nested = join(wrapper, "ComfyUI");
    mkdirSync(nested, { recursive: true });
    makeRoot(nested);
    process.env.COMFYUI_PATH = wrapper;
    const mod = await import("../config.js");
    expect(mod.config.comfyuiPath).toBe(nested);
  });

  it("(c) a path with neither marker nor nested root → returned as-is (no throw)", async () => {
    const empty = tmp("cfg-empty-");
    process.env.COMFYUI_PATH = empty;
    const mod = await import("../config.js");
    expect(mod.config.comfyuiPath).toBe(empty);
  });

  it("looksLikeComfyUIRoot + descendToNestedRoot helpers behave correctly", async () => {
    const mod = await import("../config.js");
    const root = makeRoot(tmp("cfg-helper-root-"));
    expect(mod.looksLikeComfyUIRoot(root)).toBe(true);

    const empty = tmp("cfg-helper-empty-");
    expect(mod.looksLikeComfyUIRoot(empty)).toBe(false);
    // No nested root → unchanged.
    expect(mod.descendToNestedRoot(empty)).toBe(empty);
    // Already a root → unchanged (strict no-op).
    expect(mod.descendToNestedRoot(root)).toBe(root);

    const wrapper = tmp("cfg-helper-wrap-");
    const nested = join(wrapper, "ComfyUI");
    mkdirSync(nested, { recursive: true });
    makeRoot(nested);
    expect(mod.descendToNestedRoot(wrapper)).toBe(nested);
    // Never doubles past one level.
    expect(mod.descendToNestedRoot(nested)).toBe(nested);
  });
});

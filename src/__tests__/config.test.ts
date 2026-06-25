import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

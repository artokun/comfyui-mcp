import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "manager-root-2893-")));
const CONNECTED = join(SANDBOX, "comfy");
mkdirSync(join(CONNECTED, "custom_nodes"), { recursive: true });
mkdirSync(join(CONNECTED, "models"), { recursive: true });
writeFileSync(join(CONNECTED, "main.py"), "# ComfyUI\n");
const WORKSPACE_JSON = join(SANDBOX, "workspace.json");
writeFileSync(WORKSPACE_JSON, JSON.stringify({ defaultWorkspace: CONNECTED }));

const cfg = vi.hoisted(() => ({
  comfyuiPath: undefined as string | undefined,
  comfyuiCodePath: undefined as string | undefined,
  resolvedPort: 8188,
  comfyuiHost: "127.0.0.1",
  comfyuiSsl: false,
  githubToken: undefined as string | undefined,
}));
vi.mock("../../config.js", () => ({
  config: cfg,
  getComfyUIBaseUrl: () => `http://${cfg.comfyuiHost}:${cfg.resolvedPort}`,
  getComfyuiTargetGeneration: () => 0,
  getComfyUIAuthHeaders: () => ({}),
  isLoopbackHost: (host: string | undefined) =>
    !host || ["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"].includes(host),
  isForceRemoteFlagSet: () => false,
  isRemoteMode: () => false,
  isLocalMode: () => true,
  isCloudMode: () => false,
}));

const live = vi.hoisted(() => ({
  argv: [] as string[],
  reachable: true,
}));
vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: async () => {
    if (!live.reachable) throw new Error("connect ECONNREFUSED 127.0.0.1:8188");
    return { system: { argv: live.argv } };
  },
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

vi.mock("../../services/live-interpreter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/live-interpreter.js")>();
  return { ...actual, observeLiveServerProcess: () => undefined };
});

const manager = vi.hoisted(() => ({
  /** Body served at /v2/customnode/installed. Manager serves the object-keyed
   *  shape; the ARRAY shape is `parseInstalled`'s other branch, which is where a
   *  human `title` can end up standing in for the module key. */
  installed: {} as Record<string, unknown> | unknown[],
  calls: [] as string[],
  listFails: false,
  installPack: false,
  emptyAck: false,
}));
vi.mock("../../comfyui/fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../comfyui/fetch.js")>();
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return {
    ...actual,
    comfyuiFetch: async (url: string) => {
      manager.calls.push(url);
      const { pathname } = new URL(url);
      if (pathname === "/v2/manager/queue/task") {
        if (manager.installPack) makePackDir(REPO_NAME, { "__init__.py": "NODE_CLASS_MAPPINGS = {}\n" });
        return manager.emptyAck ? new Response("", { status: 200 }) : json({ ui_id: "queued" });
      }
      if (pathname === "/v2/manager/queue/start") return json({});
      if (pathname === "/v2/manager/queue/status") {
        return json({ is_processing: false, done_count: 2, total_count: 2 });
      }
      if (pathname === "/v2/customnode/installed") {
        if (manager.listFails) throw new Error("listing unavailable");
        return json(manager.installed);
      }
      return new Response("no such route", { status: 404, statusText: "Not Found" });
    },
  };
});

const git = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("node:child_process", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    execFile: vi.fn(),
    spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
    execFileSync: vi.fn((file: string, args: string[]) => {
      git.calls.push([file, ...args]);
      if (file === "git" && args[0] === "clone") {
        const dest = args[args.length - 1];
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, "__init__.py"), "NODE_CLASS_MAPPINGS = {}\n");
      }
      return "";
    }),
  };
});

const { installCustomNode, setQueueTimingForTests } = await import(
  "../../services/node-management.js"
);
const { configureWorkspace, resetWorkspaceConfig } = await import(
  "../../services/workspace-env.js"
);
const { setManagerApiCacheForTests } = await import("../../services/manager-api-cache.js");
setQueueTimingForTests({ pollIntervalMs: 1, startupGraceMs: 0, timeoutMs: 5_000 });

/** The reporter's own repository, verbatim from the issue. */
const REPO = "https://github.com/Fannovel16/comfyui_controlnet_aux";
const REPO_NAME = "comfyui_controlnet_aux";
const PACK_DIR = join(CONNECTED, "custom_nodes", REPO_NAME);

/** The Manager entry that vouches for the pack — keyed by folder name, as v4 serves it. */
const LISTED_BY_REPO_NAME = {
  [REPO_NAME]: { ver: "nightly", aux_id: "Fannovel16/comfyui_controlnet_aux", enabled: true },
};

function clonedInto(): string | undefined {
  const clone = git.calls.find((c) => c[0] === "git" && c[1] === "clone");
  return clone?.[clone.length - 1];
}

/** Create a directory under custom_nodes with the given top-level entries. */
function makePackDir(name: string, entries: Record<string, string>): string {
  const dir = join(CONNECTED, "custom_nodes", name);
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(entries)) {
    const target = join(dir, file);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, body);
  }
  return dir;
}

async function install(
  opts: Parameters<typeof installCustomNode>[0],
): Promise<{ ok?: { mechanism: string; message: string }; error?: string }> {
  try {
    return { ok: (await installCustomNode(opts)) as { mechanism: string; message: string } };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

let priorEnvPath: string | undefined;

beforeEach(() => {
  git.calls = [];
  manager.calls = [];
  manager.installed = LISTED_BY_REPO_NAME;
  manager.listFails = false;
  manager.installPack = true;
  manager.emptyAck = false;
  live.reachable = true;
  live.argv = [join(OTHER, "main.py"), "--base-directory", CONNECTED, "--port", "8188"];
  cfg.comfyuiPath = undefined;
  priorEnvPath = process.env.COMFYUI_PATH;
  process.env.COMFYUI_PATH = OTHER;
  cfg.comfyuiPath = OTHER;
  configureWorkspace({ configPath: WORKSPACE_JSON });
  setManagerApiCacheForTests("http://127.0.0.1:8188", "v2");
});

afterEach(() => {
  resetWorkspaceConfig();
  if (priorEnvPath === undefined) delete process.env.COMFYUI_PATH;
  else process.env.COMFYUI_PATH = priorEnvPath;
  rmSync(join(CONNECTED, "custom_nodes"), { recursive: true, force: true });
  mkdirSync(join(CONNECTED, "custom_nodes"), { recursive: true });
});

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

const OTHER = join(SANDBOX, "configured-other");
mkdirSync(join(OTHER, "custom_nodes"), { recursive: true });
mkdirSync(join(OTHER, "models"), { recursive: true });
writeFileSync(join(OTHER, "main.py"), "# another ComfyUI\n");

describe("#2893 Manager outcomes use the connected root", () => {
  for (const source of ["git", "registry"] as const) {
    it(`verifies a ${source} install on the live root despite a different configured root`, async () => {
      const result = await install({ id: source === "git" ? REPO : REPO_NAME, source });
      expect(result.error).toBeUndefined();
      expect(result.ok?.mechanism).toBe("manager-http");
      expect(result.ok?.message).not.toMatch(/NOTHING was written|not present afterward/);
      expect(existsSync(join(PACK_DIR, "__init__.py"))).toBe(true);
      expect(clonedInto()).toBeUndefined();
    });
    it(`observes an unlisted ${source} pack in the live root`, async () => {
      manager.installed = {};
      const result = await install({ id: source === "git" ? REPO : REPO_NAME, source });
      expect(result.error).toBeUndefined();
      expect(result.ok?.message).toContain(PACK_DIR);
      expect(result.ok?.message).not.toMatch(/ALREADY|NOTHING was written/);
      expect(clonedInto()).toBeUndefined();
    });
  }
  it("does not replay or deny Manager writes when its listing cannot be read", async () => {
    manager.listFails = true;
    manager.installPack = false;
    const result = await install({ id: REPO, source: "git" });
    expect(result.error).toMatch(/UNKNOWN/);
    expect(result.error).not.toMatch(/NOTHING was written/);
    expect(clonedInto()).toBeUndefined();
  });
  it("does not clone into the wrong root when an accepted install remains absent", async () => {
    manager.installed = {};
    manager.installPack = false;
    const result = await install({ id: REPO, source: "git" });
    expect(result.error).toMatch(/UNKNOWN/);
    expect(result.error).toContain("Verify the pack");
    expect(clonedInto()).toBeUndefined();
  });
  it("does not use a pack in the configured root to verify a registry install", async () => {
    manager.installed = {};
    manager.installPack = false;
    const decoy = join(OTHER, "custom_nodes", REPO_NAME);
    mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, "__init__.py"), "NODE_CLASS_MAPPINGS = {}\n");
    try {
      const result = await install({ id: REPO_NAME, source: "registry" });
      expect(result.ok).toBeUndefined();
      expect(result.error).toContain(CONNECTED);
      expect(clonedInto()).toBeUndefined();
    } finally { rmSync(decoy, { recursive: true, force: true }); }
  });
  it("keeps the failed Manager listing as evidence for an unknown result", async () => {
    manager.listFails = true;
    manager.installPack = false;
    await expect(installCustomNode({ id: REPO, source: "git" })).rejects.toMatchObject({
      details: { kind: "manager-install-unverified-target-mismatch", managerListError: expect.stringContaining("listing unavailable"), liveRoot: CONNECTED },
    });
  });
  it("retains unknown empty-acknowledgement handling without a local replay", async () => {
    manager.emptyAck = true;
    manager.installed = {};
    manager.installPack = false;
    const result = await install({ id: REPO, source: "git", allowLocalFallbackAfterEmptyV2Enqueue: false });
    expect(result.error).toMatch(/UNKNOWN/);
    expect(clonedInto()).toBeUndefined();
  });
});

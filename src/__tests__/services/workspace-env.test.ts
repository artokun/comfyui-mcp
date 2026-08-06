import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const IS_WIN = platform() === "win32";
/** Create a venv interpreter on disk under `root`, returning its absolute path. */
async function makeVenvPython(root: string): Promise<string> {
  const bin = IS_WIN ? join(root, ".venv", "Scripts") : join(root, ".venv", "bin");
  await mkdir(bin, { recursive: true });
  const exe = join(bin, IS_WIN ? "python.exe" : "python3");
  await writeFile(exe, "", "utf-8");
  return exe;
}

// ---------------------------------------------------------------------------
// Mocks for modules with side effects / network at load time
// ---------------------------------------------------------------------------

type ExecResult = { stdout?: string; stderr?: string } | Error;

// Shared mutable state created via vi.hoisted so the vi.mock factories (which
// are hoisted to the top of the module) can safely reference it.
const h = vi.hoisted(() => {
  return {
    mockConfig: { comfyuiPath: undefined as string | undefined, resolvedPort: 8188 },
    mockGetSystemStats: vi.fn(),
    remoteMode: { value: false },
    // GROUND TRUTH seam (#401): undefined = "we could not observe the interpreter",
    // which is the default and must always degrade to unknown.
    mockLiveInterpreter: vi.fn(() => undefined as unknown),
    execFileResponder: (() => new Error("not configured")) as (
      cmd: string,
      args: string[],
    ) => ExecResult,
  };
});

vi.mock("../../config.js", () => ({
  config: h.mockConfig,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
  // resolveComfyuiPython → resolveEffectiveComfyUIBase + getEnvironment consult this.
  isRemoteMode: () => h.remoteMode.value,
}));

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: () => h.mockGetSystemStats(),
}));

vi.mock("../../services/live-interpreter.js", () => ({
  resolveLiveInterpreter: (...args: unknown[]) => h.mockLiveInterpreter(...(args as [])),
}));

// execFile is wrapped by promisify() at module load. The mock invokes the
// node-style callback so promisify resolves/rejects accordingly. Tests set
// h.execFileResponder to control responses, keyed loosely by command/args.
vi.mock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void,
  ) => {
    const result = h.execFileResponder(cmd, args);
    if (result instanceof Error) {
      cb(result);
    } else {
      cb(null, { stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
    }
  },
}));

const mockConfig = h.mockConfig;
const mockGetSystemStats = h.mockGetSystemStats;
function setExecFileResponder(
  fn: (cmd: string, args: string[]) => ExecResult,
): void {
  h.execFileResponder = fn;
}

import {
  configureWorkspace,
  markLocalComfyUILaunched,
  resetLocalComfyUILaunchState,
  resetWorkspaceConfig,
  getWorkspace,
  setDefaultWorkspace,
  listWorkspaces,
  getEnvironment,
  liveRootFromArgv,
  liveScriptFromArgv,
  resolveComfyuiPython,
  resolveEffectiveComfyUIBase,
  resolveLocalWorkspaceBase,
  resolveInstallInterpreter,
  resolveLiveComfyUIBase,
  resolveLiveServerRoot,
  resolveRootInterpreter,
} from "../../services/workspace-env.js";

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "comfyui-ws-"));
}

beforeEach(() => {
  mockConfig.comfyuiPath = undefined;
  mockConfig.resolvedPort = 8188;
  h.remoteMode.value = false;
  h.mockLiveInterpreter.mockReset();
  h.mockLiveInterpreter.mockReturnValue(undefined); // no observation by default
  mockGetSystemStats.mockReset();
  setExecFileResponder(() => new Error("not configured"));
  resetWorkspaceConfig();
  delete process.env.COMFYUI_PATH;
});

afterEach(() => {
  resetWorkspaceConfig();
  resetLocalComfyUILaunchState();
});

describe("resolveInstallInterpreter (#651)", () => {
  it("refuses a live Desktop-style bundle with two possible environments", async () => {
    const base = await tmpDir();
    try {
      const serverRoot = join(base, "ComfyUI");
      await mkdir(serverRoot, { recursive: true });
      await writeFile(join(serverRoot, "main.py"), "", "utf-8");
      await makeVenvPython(base);
      await makeVenvPython(serverRoot);
      mockGetSystemStats.mockResolvedValue({
        system: { argv: [join("ComfyUI", "main.py")] },
      });

      const result = await resolveInstallInterpreter(base);

      expect(result.source).toBe("undetermined");
      expect(result.python).toBeUndefined();
      expect(result.reason).toContain("sys.executable");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses when no server is reachable rather than installing into a layout guess", async () => {
    const root = await tmpDir();
    try {
      await makeVenvPython(root);
      mockGetSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await resolveInstallInterpreter(root);

      expect(result.source).toBe("undetermined");
      expect(result.python).toBeUndefined();
      expect(result.reason).toContain("Cannot verify the running server's interpreter");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat a single discovered venv as the externally launched server", async () => {
    const root = await tmpDir();
    try {
      await writeFile(join(root, "main.py"), "", "utf-8");
      await makeVenvPython(root);
      mockGetSystemStats.mockResolvedValue({ system: { argv: [join(root, "main.py")] } });

      const result = await resolveInstallInterpreter(root);
      expect(result.source).toBe("undetermined");
      expect(result).not.toHaveProperty("python");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses rather than falling back to the requested path when live ComfyUI is another install", async () => {
    const parent = await tmpDir();
    try {
      const requested = join(parent, "requested");
      const live = join(parent, "live");
      await mkdir(live, { recursive: true });
      await writeFile(join(live, "main.py"), "", "utf-8");
      await makeVenvPython(requested);
      mockGetSystemStats.mockResolvedValue({ system: { argv: [join(live, "main.py")] } });

      const result = await resolveInstallInterpreter(requested);

      expect(result.source).toBe("undetermined");
      expect(result).not.toHaveProperty("python");
      expect(result.reason).toContain("different install");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("does NOT trust an unvalidated launch mark — a stale record must not direct installs (#401)", async () => {
    // The old workspace-env launch record answered here with no process-identity
    // proof: our child could be dead, its PID recycled, and another server now on
    // the port under the SAME install root with a recreated/different venv — yet
    // pip/update work would have been sent to the OLD interpreter while the result
    // claimed to be exact. After unification the only launch record is
    // live-interpreter.ts (PID + creation time), so when the observation channel
    // cannot validate the process the resolver REFUSES — env-trust (#633) is not
    // interpreter-identity.
    const root = await tmpDir();
    try {
      await writeFile(join(root, "main.py"), "", "utf-8");
      await makeVenvPython(root);
      mockGetSystemStats.mockResolvedValue({ system: { argv: [join(root, "main.py")] } });
      markLocalComfyUILaunched(); // env-trust mark only — NOT an interpreter record
      h.mockLiveInterpreter.mockReturnValue(undefined); // identity NOT confirmed

      const result = await resolveInstallInterpreter(root);

      expect(result.source).toBe("undetermined");
      expect(result).not.toHaveProperty("python");
    } finally {
      resetLocalComfyUILaunchState();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the OS-OBSERVED interpreter when the port owner corroborates the server argv (#401)", async () => {
    const root = await tmpDir();
    try {
      await writeFile(join(root, "main.py"), "", "utf-8");
      await makeVenvPython(root);
      mockGetSystemStats.mockResolvedValue({ system: { argv: [join(root, "main.py")] } });
      h.mockLiveInterpreter.mockReturnValue({
        python: "D:/ComfyUI/.venv/Scripts/python.exe",
        source: "process-table",
        pid: 777,
      });

      await expect(resolveInstallInterpreter(root)).resolves.toMatchObject({
        python: "D:/ComfyUI/.venv/Scripts/python.exe",
        source: "observed",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps an identity-confirmed launch record from the observation channel to source launched", async () => {
    const root = await tmpDir();
    try {
      await writeFile(join(root, "main.py"), "", "utf-8");
      await makeVenvPython(root);
      mockGetSystemStats.mockResolvedValue({ system: { argv: [join(root, "main.py")] } });
      h.mockLiveInterpreter.mockReturnValue({
        python: "D:/ComfyUI/.venv/Scripts/python.exe",
        source: "launched-by-us",
        pid: 4242,
      });

      await expect(resolveInstallInterpreter(root)).resolves.toMatchObject({
        python: "D:/ComfyUI/.venv/Scripts/python.exe",
        source: "launched",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("trusts a validated launched-by-us record even when argv names no resolvable main.py", async () => {
    // We KNOW what we spawned: a PID + creation-time-validated launch record is
    // authoritative without an argv-derived root to corroborate (#651 semantics,
    // now carried by the validated channel).
    const root = await tmpDir();
    try {
      await makeVenvPython(root);
      mockGetSystemStats.mockResolvedValue({ system: { argv: ["--port", "8188"] } });
      h.mockLiveInterpreter.mockReturnValue({
        python: "D:/ComfyUI/.venv/Scripts/python.exe",
        source: "launched-by-us",
        pid: 4242,
      });

      await expect(resolveInstallInterpreter(root)).resolves.toMatchObject({
        python: "D:/ComfyUI/.venv/Scripts/python.exe",
        source: "launched",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a validated launched-by-us record bypass the different-install refusal", async () => {
    const parent = await tmpDir();
    try {
      const requested = join(parent, "requested");
      const live = join(parent, "live");
      await mkdir(live, { recursive: true });
      await writeFile(join(live, "main.py"), "", "utf-8");
      await makeVenvPython(requested);
      mockGetSystemStats.mockResolvedValue({ system: { argv: [join(live, "main.py")] } });
      h.mockLiveInterpreter.mockReturnValue({
        python: "D:/elsewhere/python.exe",
        source: "launched-by-us",
        pid: 4242,
      });

      const result = await resolveInstallInterpreter(requested);

      expect(result.source).toBe("undetermined");
      expect(result).not.toHaveProperty("python");
      expect(result.reason).toContain("different install");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("refuses in remote mode even when an observation is available (ladder order)", async () => {
    const root = await tmpDir();
    try {
      await makeVenvPython(root);
      h.remoteMode.value = true;
      h.mockLiveInterpreter.mockReturnValue({
        python: "D:/ComfyUI/.venv/Scripts/python.exe",
        source: "launched-by-us",
        pid: 4242,
      });

      const result = await resolveInstallInterpreter(root);

      expect(result.source).toBe("undetermined");
      expect(result.python).toBeUndefined();
      expect(result.reason).toContain("remote");
    } finally {
      h.remoteMode.value = false;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let an observation bypass the different-install refusal", async () => {
    const parent = await tmpDir();
    try {
      const requested = join(parent, "requested");
      const live = join(parent, "live");
      await mkdir(live, { recursive: true });
      await writeFile(join(live, "main.py"), "", "utf-8");
      await makeVenvPython(requested);
      mockGetSystemStats.mockResolvedValue({ system: { argv: [join(live, "main.py")] } });
      h.mockLiveInterpreter.mockReturnValue({
        python: "D:/elsewhere/python.exe",
        source: "process-table",
        pid: 777,
      });

      const result = await resolveInstallInterpreter(requested);

      expect(result.source).toBe("undetermined");
      expect(result).not.toHaveProperty("python");
      expect(result.reason).toContain("different install");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("does not let an observation bypass the no-resolvable-main.py refusal", async () => {
    const root = await tmpDir();
    try {
      await makeVenvPython(root);
      mockGetSystemStats.mockResolvedValue({ system: { argv: ["--port", "8188"] } });
      h.mockLiveInterpreter.mockReturnValue({
        python: "D:/elsewhere/python.exe",
        source: "process-table",
        pid: 777,
      });

      const result = await resolveInstallInterpreter(root);

      expect(result.source).toBe("undetermined");
      expect(result.python).toBeUndefined();
      expect(result.reason).toContain("main.py");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses in remote mode: a local install would not affect the remote server", async () => {
    const root = await tmpDir();
    try {
      await makeVenvPython(root);
      h.remoteMode.value = true;

      const result = await resolveInstallInterpreter(root);

      expect(result.source).toBe("undetermined");
      expect(result.python).toBeUndefined();
      expect(result.reason).toContain("remote");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses when the running server does not report a resolvable main.py location", async () => {
    const root = await tmpDir();
    try {
      await makeVenvPython(root);
      mockGetSystemStats.mockResolvedValue({ system: { argv: ["--port", "8188"] } });

      const result = await resolveInstallInterpreter(root);

      expect(result.source).toBe("undetermined");
      expect(result.python).toBeUndefined();
      expect(result.reason).toContain("main.py");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors an explicit COMFYUI_PYTHON override even when nothing is reachable", async () => {
    const root = await tmpDir();
    try {
      process.env.COMFYUI_PYTHON = "C:/explicit/python.exe";
      mockGetSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(resolveInstallInterpreter(root)).resolves.toMatchObject({
        python: "C:/explicit/python.exe",
        source: "override",
      });
    } finally {
      delete process.env.COMFYUI_PYTHON;
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// workspace action:"set_default" / action:"get" round-trip
// ---------------------------------------------------------------------------

describe("setDefaultWorkspace + getWorkspace round-trip", () => {
  it("persists the default workspace to the config file and reads it back", async () => {
    const dir = await tmpDir();
    const cfgPath = join(dir, "workspace.json");
    try {
      configureWorkspace({ configPath: cfgPath });

      const result = await setDefaultWorkspace("/some/ComfyUI");
      expect(result.saved).toBe(true);
      expect(result.default_workspace).toBe("/some/ComfyUI");
      expect(result.config_path).toBe(cfgPath);

      // File on disk has the value
      const raw = JSON.parse(await readFile(cfgPath, "utf-8"));
      expect(raw.defaultWorkspace).toBe("/some/ComfyUI");

      // getWorkspace() reads it back; no comfyuiPath so source is default-config
      const ws = await getWorkspace();
      expect(ws.default_workspace).toBe("/some/ComfyUI");
      expect(ws.workspace_path).toBe("/some/ComfyUI");
      expect(ws.workspace_source).toBe("default-config");
      expect(ws.api_target).toBe("http://127.0.0.1:8188");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates the parent directory when persisting to a missing path", async () => {
    const dir = await tmpDir();
    const cfgPath = join(dir, "nested", "deep", "workspace.json");
    try {
      configureWorkspace({ configPath: cfgPath });
      await setDefaultWorkspace("/x/ComfyUI");
      const raw = JSON.parse(await readFile(cfgPath, "utf-8"));
      expect(raw.defaultWorkspace).toBe("/x/ComfyUI");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("trims whitespace and rejects empty paths", async () => {
    const dir = await tmpDir();
    const cfgPath = join(dir, "workspace.json");
    try {
      configureWorkspace({ configPath: cfgPath });
      const r = await setDefaultWorkspace("  /trim/me  ");
      expect(r.default_workspace).toBe("/trim/me");
      await expect(setDefaultWorkspace("   ")).rejects.toThrow(/non-empty/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports source 'env' when COMFYUI_PATH is set and 'auto-detected' otherwise", async () => {
    const dir = await tmpDir();
    const cfgPath = join(dir, "workspace.json");
    try {
      configureWorkspace({ configPath: cfgPath });
      mockConfig.comfyuiPath = "/active/ComfyUI";

      // auto-detected (no env var)
      let ws = await getWorkspace();
      expect(ws.workspace_path).toBe("/active/ComfyUI");
      expect(ws.workspace_source).toBe("auto-detected");

      // env-driven
      process.env.COMFYUI_PATH = "/active/ComfyUI";
      ws = await getWorkspace();
      expect(ws.workspace_source).toBe("env");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports source 'none' when nothing is configured", async () => {
    const dir = await tmpDir();
    try {
      configureWorkspace({ configPath: join(dir, "missing.json") });
      const ws = await getWorkspace();
      expect(ws.workspace_path).toBeUndefined();
      expect(ws.workspace_source).toBe("none");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores a malformed config file and treats it as empty", async () => {
    const dir = await tmpDir();
    const cfgPath = join(dir, "workspace.json");
    try {
      await writeFile(cfgPath, "{ not json", "utf-8");
      configureWorkspace({ configPath: cfgPath });
      const ws = await getWorkspace();
      expect(ws.default_workspace).toBeUndefined();
      expect(ws.workspace_source).toBe("none");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores a non-string defaultWorkspace (shape validation)", async () => {
    const dir = await tmpDir();
    const cfgPath = join(dir, "workspace.json");
    try {
      await writeFile(cfgPath, JSON.stringify({ defaultWorkspace: 123 }), "utf-8");
      configureWorkspace({ configPath: cfgPath });
      const ws = await getWorkspace();
      expect(ws.default_workspace).toBeUndefined();
      expect(ws.workspace_source).toBe("none");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// workspace action:"list"
// ---------------------------------------------------------------------------

describe("listWorkspaces", () => {
  it("includes the active path and saved default and marks them", async () => {
    const dir = await tmpDir();
    const cfgPath = join(dir, "workspace.json");
    // Build a real valid-looking install so looks_valid is true for the active.
    const activeInstall = join(dir, "ActiveComfyUI");
    await mkdir(join(activeInstall, "models"), { recursive: true });
    try {
      configureWorkspace({ configPath: cfgPath });
      mockConfig.comfyuiPath = activeInstall;
      await setDefaultWorkspace("/saved/default/ComfyUI");

      const list = await listWorkspaces();
      expect(list.active_workspace).toBe(activeInstall);
      expect(list.default_workspace).toBe("/saved/default/ComfyUI");

      const active = list.workspaces.find((w) => w.path === activeInstall);
      expect(active?.active).toBe(true);
      expect(active?.looks_valid).toBe(true);

      const def = list.workspaces.find(
        (w) => w.path === "/saved/default/ComfyUI",
      );
      expect(def?.is_default).toBe(true);
      // Nonexistent path → not valid
      expect(def?.looks_valid).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// install_comfyui (action:"environment")
// ---------------------------------------------------------------------------

describe("resolveEffectiveComfyUIBase vs resolveLocalWorkspaceBase (#490)", () => {
  // Two different questions that shared one answer. "Where is the user's local install?"
  // was being read as "which install does this operation act on?", and the resolver
  // returned config.comfyuiPath BEFORE looking at the mode — so a remote session with a
  // stale local COMFYUI_PATH (the ordinary local configuration) got that unrelated
  // install as its target. Read-only callers got a wrong answer; comfy-cli uninstall and
  // named-snapshot save acted on it.
  it("does NOT return COMFYUI_PATH as the operation target in remote mode", async () => {
    const dir = await tmpDir();
    try {
      configureWorkspace({ configPath: join(dir, "workspace.json") });
      mockConfig.comfyuiPath = dir; // a stale local path, exactly as reported
      h.remoteMode.value = true;

      expect(resolveEffectiveComfyUIBase()).toBeUndefined();
      // …while the LOCAL-machine question still answers, because that is a different
      // question and a legitimate one. Collapsing them is the bug; deleting one is not
      // the fix.
      expect(resolveLocalWorkspaceBase()).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still returns COMFYUI_PATH as the target in a local session", async () => {
    // The over-strict direction would be its own bug: every filesystem-backed tool
    // depends on this answer.
    const dir = await tmpDir();
    try {
      configureWorkspace({ configPath: join(dir, "workspace.json") });
      mockConfig.comfyuiPath = dir;
      h.remoteMode.value = false;

      expect(resolveEffectiveComfyUIBase()).toBe(dir);
      expect(resolveLocalWorkspaceBase()).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls through to the saved default workspace locally, and refuses it remotely", async () => {
    const dir = await tmpDir();
    const install = join(dir, "Saved");
    await mkdir(install, { recursive: true });
    try {
      configureWorkspace({ configPath: join(dir, "workspace.json") });
      await setDefaultWorkspace(install);
      mockConfig.comfyuiPath = undefined;

      h.remoteMode.value = false;
      expect(resolveEffectiveComfyUIBase()).toBe(install);

      h.remoteMode.value = true;
      expect(resolveEffectiveComfyUIBase()).toBeUndefined();
      expect(resolveLocalWorkspaceBase()).toBe(install);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("getEnvironment", () => {
  it("reports running instance from system_stats and degrades local probes when no path", async () => {
    const dir = await tmpDir();
    try {
      configureWorkspace({ configPath: join(dir, "workspace.json") });
      mockConfig.comfyuiPath = undefined;
      mockGetSystemStats.mockResolvedValueOnce({
        system: {
          os: "posix",
          python_version: "3.12.1",
          embedded_python: false,
          comfyui_version: "0.3.10",
        },
        devices: [
          {
            name: "NVIDIA RTX 4090",
            type: "cuda",
            index: 0,
            vram_total: 24 * 1024 * 1024 * 1024,
            vram_free: 20 * 1024 * 1024 * 1024,
            torch_vram_total: 0,
            torch_vram_free: 0,
          },
        ],
      });

      const env = await getEnvironment();
      expect(env.running_instance.reachable).toBe(true);
      expect(env.running_instance.os).toBe("posix");
      expect(env.running_instance.comfyui_version).toBe("0.3.10");
      expect(env.running_instance.devices?.[0]).toMatchObject({
        name: "NVIDIA RTX 4090",
        type: "cuda",
        vram_total_mb: 24 * 1024,
      });

      // No local path → probes skipped, note present, no python/git
      expect(env.local.workspace_path).toBeUndefined();
      expect(env.local.python).toBeUndefined();
      expect(env.local.git).toBeUndefined();
      expect(env.local.note).toMatch(/No local ComfyUI path/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the saved default workspace for local probes when COMFYUI_PATH is unset", async () => {
    const dir = await tmpDir();
    const cfgPath = join(dir, "workspace.json");
    const install = join(dir, "DefaultComfyUI");
    await mkdir(install, { recursive: true });
    try {
      configureWorkspace({ configPath: cfgPath });
      mockConfig.comfyuiPath = undefined; // no active path
      await setDefaultWorkspace(install); // but a saved default
      mockGetSystemStats.mockRejectedValueOnce(new Error("offline"));
      setExecFileResponder((_cmd, args) => {
        if (args.includes("--version")) return { stdout: "Python 3.12.0\n" };
        return new Error("nope");
      });

      const env = await getEnvironment();
      // Local probes ran against the saved default rather than being skipped.
      expect(env.local.workspace_path).toBe(install);
      expect(env.local.python?.version).toBe("3.12.0");
      expect(env.local.note).toMatch(/saved default workspace/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("captures the unreachable error and still returns local probes for a real workspace venv", async () => {
    const dir = await tmpDir();
    const install = join(dir, "ComfyUI");
    await mkdir(install, { recursive: true });
    // A real workspace venv on disk → resolved.verified, so an unreachable server's
    // packages are still reported (#401 round 3: only a VERIFIED interpreter is
    // trusted when unreachable, never a bare PATH fallback).
    await makeVenvPython(install);
    try {
      configureWorkspace({ configPath: join(dir, "workspace.json") });
      mockConfig.comfyuiPath = install;
      mockGetSystemStats.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      // python --version succeeds; pip show returns one package; git fails
      setExecFileResponder((cmd, args) => {
        if (args.includes("--version")) {
          return { stdout: "Python 3.11.5\n" };
        }
        if (args.includes("pip")) {
          return {
            stdout:
              "Name: torch\nVersion: 2.3.1\n---\nName: numpy\nVersion: 1.26.4\n",
          };
        }
        // git rev-parse — no .git dir so probeGitRev returns early anyway,
        // but guard with an error to be safe.
        return new Error("not a git repo");
      });

      const env = await getEnvironment();
      expect(env.running_instance.reachable).toBe(false);
      expect(env.running_instance.error).toMatch(/ECONNREFUSED/);

      expect(env.local.workspace_path).toBe(install);
      expect(env.local.python?.version).toBe("3.11.5");
      // The server is DOWN, so no process exists to observe: the interpreter shown is
      // a layout guess and its package list is withheld (#401 terminating rule).
      expect(env.local.python_probe_source).toBe("layout-guess");
      expect(env.local.python_probe_trusted).toBe(false);
      expect(env.local.packages).toBeUndefined();
      // No .git directory created → git omitted
      expect(env.local.git).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("notes when python is unavailable in a configured workspace", async () => {
    const dir = await tmpDir();
    const install = join(dir, "ComfyUI");
    await mkdir(install, { recursive: true });
    try {
      configureWorkspace({ configPath: join(dir, "workspace.json") });
      mockConfig.comfyuiPath = install;
      mockGetSystemStats.mockRejectedValueOnce(new Error("offline"));
      // Every subprocess fails (no python on PATH)
      setExecFileResponder(() => new Error("command not found"));

      const env = await getEnvironment();
      expect(env.local.python).toBeUndefined();
      expect(env.local.note).toMatch(/Python interpreter not found/i);
      expect(env.local.packages).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads ComfyUI-Manager version from pyproject.toml and git rev when present", async () => {
    const dir = await tmpDir();
    const install = join(dir, "ComfyUI");
    await mkdir(join(install, "custom_nodes", "ComfyUI-Manager"), {
      recursive: true,
    });
    await writeFile(
      join(install, "custom_nodes", "ComfyUI-Manager", "pyproject.toml"),
      '[project]\nname = "comfyui-manager"\nversion = "3.10.1"\n',
      "utf-8",
    );
    await mkdir(join(install, ".git"), { recursive: true });
    try {
      configureWorkspace({ configPath: join(dir, "workspace.json") });
      mockConfig.comfyuiPath = install;
      mockGetSystemStats.mockRejectedValueOnce(new Error("offline"));

      setExecFileResponder((cmd, args) => {
        if (cmd === "git" && args.includes("--short")) {
          return { stdout: "abc1234\n" };
        }
        if (cmd === "git" && args.includes("--abbrev-ref")) {
          return { stdout: "master\n" };
        }
        if (args.includes("--version")) return { stdout: "Python 3.12.0\n" };
        if (args.includes("pip")) return new Error("no pip");
        return new Error("unexpected");
      });

      const env = await getEnvironment();
      expect(env.local.comfyui_manager_version).toBe("3.10.1");
      expect(env.local.git).toEqual({ rev: "abc1234", branch: "master" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // #401 — the TERMINATING RULE. An interpreter is authoritative only when we
  // OBSERVED it (we launched the process, or the OS told us what it is running).
  // Layout inference selects what to PROBE and nothing more.
  // -------------------------------------------------------------------------

  /** Stage a workspace whose layout GUESS resolves to a venv on disk. */
  async function stageWorkspace(dir: string): Promise<string> {
    const install = join(dir, "ComfyUI");
    await mkdir(install, { recursive: true });
    const exe = await makeVenvPython(install);
    configureWorkspace({ configPath: join(dir, "workspace.json") });
    mockConfig.comfyuiPath = install;
    return exe;
  }

  function statsReachable(python = "3.12.11"): void {
    mockGetSystemStats.mockResolvedValueOnce({
      system: {
        os: "nt",
        python_version: python,
        comfyui_version: "0.27.1",
        embedded_python: false,
        argv: [],
      },
      devices: [],
    });
  }

  it("reports UNKNOWN (never a package list) when the interpreter was not observed", async () => {
    const dir = await tmpDir();
    await stageWorkspace(dir);
    try {
      statsReachable();
      h.mockLiveInterpreter.mockReturnValue(undefined); // could not observe the process
      setExecFileResponder((_cmd, args) => {
        if (args.includes("--version")) return { stdout: "Python 3.12.11\n" };
        // Even a PERFECTLY matching python must not unlock this list.
        if (args.includes("pip")) return { stdout: "Name: torch\nVersion: 2.5.0\n" };
        return new Error("nope");
      });

      const env = await getEnvironment();
      expect(env.local.python_probe_source).toBe("layout-guess");
      expect(env.local.python_probe_trusted).toBe(false);
      expect(env.local.packages).toBeUndefined();
      expect(env.local.python_probe_reason).toMatch(/BEST GUESS/);
      expect(env.local.note).toMatch(/#401/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("trusts the interpreter WE launched ComfyUI with", async () => {
    const dir = await tmpDir();
    const exe = await stageWorkspace(dir);
    try {
      statsReachable("3.12.11");
      h.mockLiveInterpreter.mockReturnValue({
        python: exe,
        source: "launched-by-us",
        pid: 4242,
      });
      setExecFileResponder((_cmd, args) => {
        if (args.includes("--version")) return { stdout: "Python 3.12.11\n" };
        if (args.includes("pip")) return { stdout: "Name: torch\nVersion: 2.5.0\n" };
        return new Error("nope");
      });

      const env = await getEnvironment();
      expect(env.local.python?.executable).toBe(exe);
      expect(env.local.python_probe_source).toBe("launched-by-us");
      expect(env.local.python_probe_trusted).toBe(true);
      expect(env.local.packages?.torch).toBe("2.5.0");
      expect(env.local.python_probe_reason).toMatch(/launched ComfyUI/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("trusts the interpreter the OS reports for the process on our port", async () => {
    const dir = await tmpDir();
    await stageWorkspace(dir);
    // The OS names an interpreter the layout guess would NEVER have found — which is
    // the whole point: observation beats inference.
    const elsewhere = join(dir, "somewhere-else", "python.exe");
    await mkdir(join(dir, "somewhere-else"), { recursive: true });
    await writeFile(elsewhere, "", "utf-8");
    try {
      statsReachable("3.13.12");
      h.mockLiveInterpreter.mockReturnValue({
        python: elsewhere,
        source: "process-table",
        pid: 777,
      });
      setExecFileResponder((cmd, args) => {
        if (args.includes("--version"))
          return { stdout: cmd === elsewhere ? "Python 3.13.12\n" : "Python 3.10.0\n" };
        if (args.includes("pip"))
          return {
            stdout:
              cmd === elsewhere ? "Name: torch\nVersion: 9.1.0\n" : "Name: torch\nVersion: 0.0.1\n",
          };
        return new Error("nope");
      });

      const env = await getEnvironment();
      expect(env.local.python?.executable).toBe(elsewhere);
      expect(env.local.python_probe_source).toBe("process-table");
      expect(env.local.python_probe_trusted).toBe(true);
      expect(env.local.packages?.torch).toBe("9.1.0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("degrades to UNKNOWN when an OBSERVED interpreter contradicts the running python", async () => {
    const dir = await tmpDir();
    const exe = await stageWorkspace(dir);
    try {
      statsReachable("3.13.12"); // server says 3.13.12 …
      h.mockLiveInterpreter.mockReturnValue({ python: exe, source: "process-table", pid: 99 });
      setExecFileResponder((_cmd, args) => {
        if (args.includes("--version")) return { stdout: "Python 3.11.9\n" }; // … probe says 3.11.9
        if (args.includes("pip")) return { stdout: "Name: torch\nVersion: 9.9.9\n" };
        return new Error("nope");
      });

      const env = await getEnvironment();
      expect(env.local.python_probe_trusted).toBe(false);
      expect(env.local.packages).toBeUndefined();
      expect(env.local.python_probe_reason).toMatch(/does not match the running ComfyUI python/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says the comparison could NOT BE MADE, not that it failed, when the server reports no python", async () => {
    // `pythonVersionsAgree` returns false when EITHER side is missing, so an unreported
    // server python fell into the mismatch branch and the reason read "does not match the
    // running ComfyUI python (unreported)" — asserting a disagreement nobody observed.
    // One verdict, two causes, and the message named the wrong one; a user reading it
    // would go hunting for a version conflict that does not exist.
    const dir = await tmpDir();
    const exe = await stageWorkspace(dir);
    try {
      mockGetSystemStats.mockResolvedValueOnce({
        system: { os: "nt", comfyui_version: "0.27.1", embedded_python: false, argv: [] },
        devices: [],
      });
      h.mockLiveInterpreter.mockReturnValue({ python: exe, source: "process-table", pid: 77 });
      setExecFileResponder((_cmd, args) => {
        if (args.includes("--version")) return { stdout: "Python 3.13.12\n" };
        if (args.includes("pip")) return { stdout: "Name: torch\nVersion: 9.9.9\n" };
        return new Error("nope");
      });

      const env = await getEnvironment();
      // Still fail-closed — an unverified match is not a verified one.
      expect(env.local.python_probe_trusted).toBe(false);
      expect(env.local.packages).toBeUndefined();
      // …but the REASON must describe what actually happened. Asserting only the state
      // would pass on the old, wrong message too.
      expect(env.local.python_probe_reason).toMatch(/could\s+NOT be compared/);
      expect(env.local.python_probe_reason).toMatch(/unverified match, not a mismatch/);
      expect(env.local.python_probe_reason).not.toMatch(/does not match the running/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("trusts a launched-by-us interpreter even when no cross-check was possible", async () => {
    // The other direction. We CHOSE this interpreter and spawned the process; a
    // corroboration we never needed being unavailable is not a reason to withhold a
    // package list we genuinely know.
    const dir = await tmpDir();
    const exe = await stageWorkspace(dir);
    try {
      mockGetSystemStats.mockResolvedValueOnce({
        system: { os: "nt", comfyui_version: "0.27.1", embedded_python: false, argv: [] },
        devices: [],
      });
      h.mockLiveInterpreter.mockReturnValue({ python: exe, source: "launched-by-us", pid: 78 });
      setExecFileResponder((_cmd, args) => {
        if (args.includes("--version")) return { stdout: "Python 3.13.12\n" };
        if (args.includes("pip")) return { stdout: "Name: torch\nVersion: 2.9.0\n" };
        return new Error("nope");
      });

      const env = await getEnvironment();
      expect(env.local.python_probe_trusted).toBe(true);
      expect(env.local.packages?.torch).toBe("2.9.0");
      expect(env.local.python_probe_reason).toMatch(/no\s+cross-check was possible/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes 'pip answered, nothing installed' from 'pip never answered'", async () => {
    // An empty package map has two causes and the note used to assert one of them. On a
    // uv-created venv — which frequently has NO pip at all — the "pip did not answer"
    // case is the common one, and calling it "none of these are installed" would be a
    // false capability report of exactly the kind #401 is about.
    const dir = await tmpDir();
    const exe = await stageWorkspace(dir);
    try {
      statsReachable("3.13.12");
      h.mockLiveInterpreter.mockReturnValue({ python: exe, source: "process-table", pid: 12 });
      setExecFileResponder((_cmd, args) => {
        if (args.includes("--version") && !args.includes("pip")) {
          return { stdout: "Python 3.13.12\n" };
        }
        // pip's OWN full-miss output, from the SAME invocation. It EXITS 1 and warns on
        // stderr, so the rejection carries the evidence — a separate later
        // `pip --version` would prove only that pip can start now, never that this
        // query ran.
        if (args.includes("pip")) {
          return Object.assign(new Error("Command failed: exit 1"), {
            stdout: "",
            stderr: "WARNING: Package(s) not found: torch, numpy\n",
          });
        }
        return new Error("nope");
      });

      const env = await getEnvironment();
      expect(env.local.python_probe_trusted).toBe(true);
      expect(env.local.packages).toBeUndefined();
      expect(env.local.note).toMatch(/pip answered and none of/);
      expect(env.local.note).not.toMatch(/did not answer at all/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says the query FAILED when pip itself does not answer (uv venvs often have no pip)", async () => {
    const dir = await tmpDir();
    const exe = await stageWorkspace(dir);
    try {
      statsReachable("3.13.12");
      h.mockLiveInterpreter.mockReturnValue({ python: exe, source: "process-table", pid: 13 });
      setExecFileResponder((_cmd, args) => {
        if (args.includes("--version") && !args.includes("pip")) {
          return { stdout: "Python 3.13.12\n" };
        }
        if (args.includes("pip")) return new Error("No module named pip");
        return new Error("nope");
      });

      const env = await getEnvironment();
      expect(env.local.packages).toBeUndefined();
      expect(env.local.note).toMatch(/pip did not answer at all/);
      expect(env.local.note).toMatch(/NOT evidence that these packages are missing/);
      expect(env.local.note).not.toMatch(/pip answered and none of/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the packages pip DID find when other requested ones are missing", async () => {
    // `pip show a b c` exits 1 whenever ANY name is missing, and KEY_PACKAGES contains
    // xformers and diffusers — absent on most real machines. The shared `probe()` helper
    // discards everything on a non-zero exit, so the records pip HAD produced (torch
    // among them) were thrown away and install_comfyui (action:"environment") reported no packages at all on
    // installs that plainly had them.
    const dir = await tmpDir();
    const exe = await stageWorkspace(dir);
    try {
      statsReachable("3.13.12");
      h.mockLiveInterpreter.mockReturnValue({ python: exe, source: "process-table", pid: 15 });
      setExecFileResponder((_cmd, args) => {
        if (args.includes("--version") && !args.includes("pip")) {
          return { stdout: "Python 3.13.12\n" };
        }
        if (args.includes("pip")) {
          return Object.assign(new Error("Command failed: exit 1"), {
            stdout: "Name: torch\nVersion: 2.9.0\n---\nName: numpy\nVersion: 2.1.0\n",
            stderr: "WARNING: Package(s) not found: xformers, diffusers\n",
          });
        }
        return new Error("nope");
      });

      const env = await getEnvironment();
      expect(env.local.packages?.torch).toBe("2.9.0");
      expect(env.local.packages?.numpy).toBe("2.1.0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not accept a stray mention of the phrase as pip's not-found warning", async () => {
    // The evidence has to be pip's STRUCTURED line. A traceback or wrapper that merely
    // quotes "Package(s) not found" would otherwise license the "none of these are
    // installed" claim off a `pip show` that never ran.
    const dir = await tmpDir();
    const exe = await stageWorkspace(dir);
    try {
      statsReachable("3.13.12");
      h.mockLiveInterpreter.mockReturnValue({ python: exe, source: "process-table", pid: 16 });
      setExecFileResponder((_cmd, args) => {
        if (args.includes("--version") && !args.includes("pip")) {
          return { stdout: "Python 3.13.12\n" };
        }
        if (args.includes("pip")) {
          return Object.assign(new Error("Command failed: exit 1"), {
            stdout: "",
            stderr:
              "Traceback (most recent call last):\n" +
              '  File "<frozen importlib>", line 1, in <module>\n' +
              "RuntimeError: broken plugin said Package(s) not found somewhere\n",
          });
        }
        return new Error("nope");
      });

      const env = await getEnvironment();
      expect(env.local.packages).toBeUndefined();
      expect(env.local.note).toMatch(/pip did not answer at all/);
      expect(env.local.note).not.toMatch(/pip answered and none of/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not treat a KILLED pip show as a completed no-match", async () => {
    // The shortcut this replaced: `pip show` dies on the 8s timeout, a follow-up
    // `pip --version` answers instantly, and the silence of the FIRST query gets
    // vouched for by the SECOND — reporting "none of these are installed" about a
    // question that was never answered. Only evidence inside the failed invocation
    // itself can settle it, and there is none here.
    const dir = await tmpDir();
    const exe = await stageWorkspace(dir);
    try {
      statsReachable("3.13.12");
      h.mockLiveInterpreter.mockReturnValue({ python: exe, source: "process-table", pid: 14 });
      setExecFileResponder((_cmd, args) => {
        if (args.includes("--version") && !args.includes("pip")) {
          return { stdout: "Python 3.13.12\n" };
        }
        // `pip show` killed by the timeout: no output at all, no warning.
        if (args.includes("show")) return new Error("Command failed: timed out, SIGTERM");
        // A LATER `pip --version` would succeed — and must not be consulted.
        if (args.includes("pip")) return { stdout: "pip 24.0 from …\n" };
        return new Error("nope");
      });

      const env = await getEnvironment();
      expect(env.local.packages).toBeUndefined();
      expect(env.local.note).toMatch(/pip did not answer at all/);
      expect(env.local.note).not.toMatch(/pip answered and none of/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("compares the FULL python version, not just major.minor", async () => {
    const dir = await tmpDir();
    const exe = await stageWorkspace(dir);
    try {
      // Same 3.13 major.minor, different patch → a contradiction we now catch.
      statsReachable("3.13.12 (main, Feb 12 2026, 00:38:53) [MSC v.1944 64 bit (AMD64)]");
      h.mockLiveInterpreter.mockReturnValue({ python: exe, source: "process-table", pid: 5 });
      setExecFileResponder((_cmd, args) => {
        if (args.includes("--version")) return { stdout: "Python 3.13.4\n" };
        if (args.includes("pip")) return { stdout: "Name: torch\nVersion: 1.0.0\n" };
        return new Error("nope");
      });

      const env = await getEnvironment();
      expect(env.local.python_probe_trusted).toBe(false);
      expect(env.local.packages).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still SELECTS the server venv for a Desktop-style relative argv (selection survives)", async () => {
    // Selection is still layout-driven and still lands on the right interpreter —
    // that is what makes a POSITIVE capability finding possible. It just cannot
    // authorize a package list without an observation.
    const dir = await tmpDir();
    const base = join(dir, "Desktop");
    const server = join(base, "ComfyUI");
    await mkdir(server, { recursive: true });
    await writeFile(join(server, "main.py"), "", "utf-8");
    const wrongExe = await makeVenvPython(base);
    const rightExe = await makeVenvPython(server);
    try {
      configureWorkspace({ configPath: join(dir, "workspace.json") });
      mockConfig.comfyuiPath = base;
      mockGetSystemStats.mockResolvedValueOnce({
        system: {
          os: "nt",
          python_version: "3.13.12",
          comfyui_version: "0.27.1",
          embedded_python: false,
          argv: [IS_WIN ? "ComfyUI\\main.py" : "ComfyUI/main.py"],
        },
        devices: [],
      });
      h.mockLiveInterpreter.mockReturnValue(undefined);
      setExecFileResponder((_cmd, args) => {
        if (args.includes("--version")) return { stdout: "Python 3.13.12\n" };
        if (args.includes("pip")) return { stdout: "Name: torch\nVersion: 2.9.0\n" };
        return new Error("nope");
      });

      const env = await getEnvironment();
      expect(env.local.python?.executable).toBe(rightExe);
      expect(env.local.python?.executable).not.toBe(wrongExe);
      expect(env.local.python_probe_trusted).toBe(false);
      expect(env.local.packages).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never trusts anything for a REMOTE server (#401 / #433 round 3)", async () => {
    const dir = await tmpDir();
    const rootB = join(dir, "B");
    await mkdir(rootB, { recursive: true });
    await makeVenvPython(rootB);
    try {
      configureWorkspace({ configPath: join(dir, "workspace.json") });
      h.remoteMode.value = true;
      mockConfig.comfyuiPath = undefined;
      mockGetSystemStats.mockResolvedValueOnce({
        system: {
          os: "nt",
          python_version: "3.12.11",
          comfyui_version: "0.27.1",
          argv: [join(rootB, "main.py")],
        },
        devices: [],
      });
      h.mockLiveInterpreter.mockReturnValue(undefined); // remote → never observable
      setExecFileResponder((_cmd, args) => {
        if (args.includes("--version")) return { stdout: "Python 3.12.11\n" };
        if (args.includes("pip")) return { stdout: "Name: torch\nVersion: 9.9.9\n" };
        return new Error("nope");
      });

      const env = await getEnvironment();
      expect(env.local.python_probe_trusted).toBe(false);
      expect(env.local.packages).toBeUndefined();
      expect(env.local.python_probe_reason).toMatch(/REMOTE/i);
      expect(env.local.note).toMatch(/#401/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});


describe("liveRootFromArgv (#401 / #433 — robust argv parsing)", () => {
  it("returns the absolute dir of an absolute main.py", () => {
    const root = IS_WIN ? "C:\\Comfy\\ComfyUI" : "/opt/ComfyUI";
    const argv = [join(root, "main.py"), "--port", "8188"];
    expect(liveRootFromArgv(argv)).toBe(root);
  });

  it("strips surrounding quotes on the main.py path", () => {
    const root = IS_WIN ? "C:\\Comfy\\ComfyUI" : "/opt/ComfyUI";
    const argv = [`"${join(root, "main.py")}"`];
    expect(liveRootFromArgv(argv)).toBe(root);
  });

  it("resolves a RELATIVE main.py against the server cwd when available, else UNRESOLVED", () => {
    const cwd = IS_WIN ? "C:\\portable" : "/portable";
    const rel = IS_WIN ? "ComfyUI\\main.py" : "ComfyUI/main.py";
    expect(liveRootFromArgv([rel], cwd)).toBe(join(cwd, "ComfyUI"));
    // No cwd → cannot resolve to an absolute dir → UNRESOLVED (not a bogus rel root).
    expect(liveRootFromArgv([rel])).toBeUndefined();
  });

  it("treats a bare 'main.py' as cwd (when absolute) or UNRESOLVED", () => {
    const cwd = IS_WIN ? "C:\\here" : "/here";
    expect(liveRootFromArgv(["main.py"], cwd)).toBe(cwd);
    expect(liveRootFromArgv(["main.py"])).toBeUndefined();
  });

  it("ignores non-main.py args and returns undefined when there is no main.py", () => {
    expect(liveRootFromArgv(["python", "--port", "8188"])).toBeUndefined();
    // A boundary check: 'notmain.py' must NOT be treated as main.py.
    expect(liveRootFromArgv([IS_WIN ? "C:\\x\\notmain.py" : "/x/notmain.py"])).toBeUndefined();
  });

  it("a main.py-shaped FLAG VALUE is never the launch script (#648 review)", () => {
    const root = IS_WIN ? "C:\\Comfy\\ComfyUI" : "/opt/ComfyUI";
    // A main-less `python -m comfyui …` launch whose --extra-model-paths-config value
    // happens to END in main.py: accepting that value as the script would let the config
    // path self-prove the server's locality and then be read/written as a host file.
    expect(
      liveRootFromArgv(["python", "-m", "comfyui", "--extra-model-paths-config", join(root, "main.py")]),
    ).toBeUndefined();
    // The --flag=value spelling is an option token too.
    expect(
      liveRootFromArgv(["python", "-m", "comfyui", `--extra-model-paths-config=${join(root, "main.py")}`]),
    ).toBeUndefined();
    // A main.py-shaped token AFTER any flag is an argument, not the positional script.
    expect(liveRootFromArgv(["--port", "8188", join(root, "main.py")])).toBeUndefined();
    // …but the interpreter name before the script stays tolerated (positional scan).
    expect(liveRootFromArgv(["python", join(root, "main.py"), "--port", "8188"])).toBe(root);
  });

  it("returns undefined for missing/empty argv", () => {
    expect(liveRootFromArgv(undefined)).toBeUndefined();
    expect(liveRootFromArgv([])).toBeUndefined();
  });
});

/**
 * liveScriptFromArgv is the same parse returning the main.py FILE (needed to follow a
 * symlink — ComfyUI reads the config next to os.path.realpath(__file__)). Both functions
 * share the script-TOKEN extraction (scriptTokenFromArgv: a positional token before the
 * first option, never a flag's value); liveRootFromArgv keeps its OWN return shaping for
 * the #633 download-authorization path, so this cross-check is what stops the two return
 * shapes from drifting apart.
 */
describe("liveScriptFromArgv agrees with liveRootFromArgv on every argv shape", () => {
  const winCwd = "C:\\here";
  const nixCwd = "/here";
  const cwd = IS_WIN ? winCwd : nixCwd;
  const root = IS_WIN ? "C:\\Comfy\\ComfyUI" : "/opt/ComfyUI";
  const rel = IS_WIN ? "ComfyUI\\main.py" : "ComfyUI/main.py";
  const unnormalizedCwd = IS_WIN ? "C:\\x\\." : "/x/.";

  const shapes: Array<[name: string, argv: string[] | undefined, cwd?: string]> = [
    ["absolute main.py", [join(root, "main.py"), "--port", "8188"]],
    ["quoted absolute main.py", [`"${join(root, "main.py")}"`]],
    ["single-quoted main.py", [`'${join(root, "main.py")}'`]],
    ["absolute main.pyw", [join(root, "main.pyw")]],
    ["relative main.py with cwd", [rel], cwd],
    ["relative main.py without cwd", [rel]],
    ["bare main.py with cwd", ["main.py"], cwd],
    ["bare main.py with UNNORMALIZED cwd", ["main.py"], unnormalizedCwd],
    ["bare main.py without cwd", ["main.py"]],
    ["unnormalized absolute", [IS_WIN ? "C:\\x\\.\\main.py" : "/x/./main.py"]],
    ["several candidates (first wins)", [join(root, "main.py"), join(cwd, "main.py")]],
    ["non-string entries", [42 as unknown as string, join(root, "main.py")]],
    ["no main.py", ["python", "--port", "8188"]],
    ["notmain.py boundary", [IS_WIN ? "C:\\x\\notmain.py" : "/x/notmain.py"]],
    // #648 review: a main.py-shaped token after an option is a flag VALUE / argument,
    // never the launch script — on both functions.
    [
      "main.py only as a --extra-model-paths-config VALUE",
      ["python", "-m", "comfyui", "--extra-model-paths-config", join(root, "main.py")],
    ],
    [
      "main.py only as a --flag=value",
      ["python", "-m", "comfyui", `--extra-model-paths-config=${join(root, "main.py")}`],
    ],
    ["main.py only AFTER the flags", ["--port", "8188", join(root, "main.py")]],
    ["empty argv", []],
    ["missing argv", undefined],
  ];

  for (const [name, argv, argCwd] of shapes) {
    it(name, () => {
      const root_ = liveRootFromArgv(argv, argCwd);
      const script = liveScriptFromArgv(argv, argCwd);
      if (root_ === undefined) {
        expect(script).toBeUndefined();
        return;
      }
      expect(script).toBeDefined();
      // The script must be main.py[w] inside that root — equal after normalization, which
      // is all any caller relies on (every one of them resolve()s the value).
      expect(basename(script as string)).toMatch(/^main\.pyw?$/i);
      expect(resolve(dirname(script as string))).toBe(resolve(root_));
    });
  }
});

describe("resolveRootInterpreter (portable + venv layouts)", () => {
  it("finds the install's own .venv interpreter on disk", async () => {
    const root = await tmpDir();
    try {
      const py = await makeVenvPython(root);
      expect(resolveRootInterpreter(root)).toBe(py);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers a portable python_embeded layout on Windows", async () => {
    if (!IS_WIN) return; // python_embeded candidates are Windows-only
    const root = await tmpDir();
    try {
      const embDir = join(root, "python_embeded");
      await mkdir(embDir, { recursive: true });
      const emb = join(embDir, "python.exe");
      await writeFile(emb, "", "utf-8");
      expect(resolveRootInterpreter(root)).toBe(emb);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does NOT follow a nested ComfyUI/ venv — installs keep targeting the root's own python", async () => {
    // resolveComfyuiPython follows <base>/ComfyUI (verified against the live server),
    // but this resolver picks the interpreter pip INSTALLS run under and has nothing
    // live to check against. Preferring a nested venv here would be an unverifiable
    // guess in a mutating path, so the root's own interpreter must still win.
    const root = await tmpDir();
    try {
      const nested = join(root, "ComfyUI");
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, "main.py"), "", "utf-8");
      await makeVenvPython(nested);
      const own = await makeVenvPython(root);
      expect(resolveRootInterpreter(root)).toBe(own);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to a bare platform python when nothing is on disk / root is undefined", async () => {
    const root = await tmpDir();
    try {
      expect(resolveRootInterpreter(root)).toBe(IS_WIN ? "python.exe" : "python3");
      expect(resolveRootInterpreter(undefined)).toBe(IS_WIN ? "python.exe" : "python3");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolveLiveComfyUIBase (#490 / #463 — live connected install root)", () => {
  it("derives the live root from the running server's main.py argv", async () => {
    const root = IS_WIN ? "C:\\live\\ComfyUI" : "/live/ComfyUI";
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [join(root, "main.py"), "--listen"] },
    });
    expect(await resolveLiveComfyUIBase()).toBe(root);
  });

  it("returns undefined in remote mode (the live root is on the remote host)", async () => {
    h.remoteMode.value = true;
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [IS_WIN ? "C:\\remote\\main.py" : "/remote/main.py"] },
    });
    expect(await resolveLiveComfyUIBase()).toBeUndefined();
    // Never even probes /system_stats when remote.
    expect(mockGetSystemStats).not.toHaveBeenCalled();
  });

  it("returns undefined (never throws) when the server is unreachable", async () => {
    mockGetSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(resolveLiveComfyUIBase()).resolves.toBeUndefined();
  });
});

describe("resolveComfyuiPython live-first (#401 / #433)", () => {
  it("prefers the live argv root over the pinned COMFYUI_PATH, both with venvs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "comfyui-resolve-"));
    try {
      const rootA = join(dir, "A");
      const rootB = join(dir, "B");
      await mkdir(rootA, { recursive: true });
      await mkdir(rootB, { recursive: true });
      await makeVenvPython(rootA);
      const exeB = await makeVenvPython(rootB);

      const res = resolveComfyuiPython(rootA, [join(rootB, "main.py")]);
      expect(res.python).toBe(exeB);
      expect(res.liveRoot).toBe(rootB);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("in REMOTE mode, a coincident local live path is NOT marked live and is not probed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "comfyui-resolve-"));
    try {
      const rootB = join(dir, "B");
      await mkdir(rootB, { recursive: true });
      const exeB = await makeVenvPython(rootB);

      const res = resolveComfyuiPython(undefined, [join(rootB, "main.py")], { remote: true });
      // Live root is still reported for provenance, but the coincident local install
      // is NOT probed — it is not the remote server's.
      expect(res.python).not.toBe(exeB);
      expect(res.python).toBe(IS_WIN ? "python.exe" : "python3");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// resolveLiveServerRoot (#369) — the ONE notion of "the live server's install
// root". The bug it exists to end: ComfyUI Desktop and the Windows portable
// bundle both report a RELATIVE `main.py` with no cwd, argv resolution returns
// nothing, and the download destination silently fell through to COMFYUI_PATH —
// a DIFFERENT install the running server never reads from.
// ---------------------------------------------------------------------------
describe("resolveLiveServerRoot (#369)", () => {
  // Build the relative argv with join(), NEVER a hardcoded "ComfyUI\\main.py".
  // node's path.dirname only treats "\" as a separator on Windows, so a backslash
  // literal parses as the single filename "ComfyUI\main.py" on POSIX — relDir comes
  // back "." and the entire shape under test evaporates. These passed locally on
  // Windows and failed on the macOS CI leg for exactly that reason. join() produces
  // the form each platform's ComfyUI actually reports.
  /** Portable Windows bundle: <root>/python_embeded/python.exe + <root>/ComfyUI/main.py */
  async function makePortableBundle(
    base: string,
  ): Promise<{ python: string; serverRoot: string }> {
    const embedded = join(base, "python_embeded");
    await mkdir(embedded, { recursive: true });
    const python = join(embedded, IS_WIN ? "python.exe" : "python3");
    await writeFile(python, "", "utf-8");
    const serverRoot = join(base, "ComfyUI");
    await mkdir(serverRoot, { recursive: true });
    await writeFile(join(serverRoot, "main.py"), "", "utf-8");
    return { python, serverRoot };
  }

  it("resolves from argv when the script path is absolute", async () => {
    const dir = await tmpDir();
    try {
      const res = resolveLiveServerRoot([join(dir, "main.py"), "--listen"]);
      expect(res.source).toBe("argv");
      expect(res.root).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("anchors a RELATIVE main.py on the interpreter the OS observes — live wins over a stale COMFYUI_PATH", async () => {
    const dir = await tmpDir();
    try {
      // Two installs, exactly as in the reopened report: the portable bundle is
      // LIVE, and COMFYUI_PATH points at an unrelated second checkout.
      const live = join(dir, "ComfyUI_windows_portable2");
      const stale = join(dir, "Documents", "ComfyUI");
      await mkdir(stale, { recursive: true });
      await writeFile(join(stale, "main.py"), "", "utf-8");
      const { python, serverRoot } = await makePortableBundle(live);
      mockConfig.comfyuiPath = stale;

      const res = resolveLiveServerRoot(
        [join("ComfyUI", "main.py"), "--windows-standalone-build"],
        undefined,
        { observedPython: python },
      );
      expect(res.source).toBe("observed-process");
      expect(res.root).toBe(serverRoot);
      expect(res.root).not.toBe(stale);
      expect(res.relDir).toBe("ComfyUI");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("anchors a Desktop-style nested venv interpreter on its own server root", async () => {
    const dir = await tmpDir();
    try {
      const serverRoot = join(dir, "ComfyUI");
      await mkdir(serverRoot, { recursive: true });
      await writeFile(join(serverRoot, "main.py"), "", "utf-8");
      const python = await makeVenvPython(serverRoot);

      const res = resolveLiveServerRoot([join("ComfyUI", "main.py")], undefined, {
        observedPython: python,
      });
      expect(res.source).toBe("observed-process");
      expect(res.root).toBe(serverRoot);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves a BARE main.py against the observed interpreter's own root", async () => {
    const dir = await tmpDir();
    try {
      await writeFile(join(dir, "main.py"), "", "utf-8");
      const python = await makeVenvPython(dir);
      const res = resolveLiveServerRoot(["main.py"], undefined, { observedPython: python });
      expect(res.source).toBe("observed-process");
      expect(res.root).toBe(dir);
      expect(res.relDir).toBe(".");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stays UNRESOLVED when nothing observes the process — never a layout guess", () => {
    h.mockLiveInterpreter.mockReturnValue(undefined);
    const res = resolveLiveServerRoot([join("ComfyUI", "main.py")]);
    expect(res.source).toBe("unresolved");
    expect(res.root).toBeUndefined();
    expect(res.relDir).toBe("ComfyUI");
  });

  it("never adopts an unrelated install above a SYSTEM interpreter (codex gate r3)", async () => {
    const dir = await tmpDir();
    try {
      // `C:\Python311\python.exe` runs `ComfyUI\main.py` from a cwd it never reports,
      // and an UNRELATED `<dir>/ComfyUI/main.py` happens to sit beside the python.
      // Walking up must NOT adopt it: nothing ties that install to the interpreter.
      const stale = join(dir, "ComfyUI");
      await mkdir(stale, { recursive: true });
      await writeFile(join(stale, "main.py"), "", "utf-8");
      const sysDir = join(dir, "Python311");
      await mkdir(sysDir, { recursive: true });
      const python = join(sysDir, IS_WIN ? "python.exe" : "python3");
      await writeFile(python, "", "utf-8");

      const res = resolveLiveServerRoot([join("ComfyUI", "main.py")], undefined, {
        observedPython: python,
      });
      expect(res.source).toBe("unresolved");
      expect(res.root).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never adopts a stale sibling install from a GENERIC venv beside it (codex gate r13)", async () => {
    const dir = await tmpDir();
    try {
      // The live server runs D:\Live\ComfyUI\main.py from an EXTERNAL venv at
      // <dir>/venv, and an unrelated <dir>/ComfyUI/main.py sits beside that venv.
      // A generic venv says nothing about which install it serves.
      const stale = join(dir, "ComfyUI");
      await mkdir(stale, { recursive: true });
      await writeFile(join(stale, "main.py"), "", "utf-8");
      const python = await makeVenvPython(join(dir, "external"));
      // Move it so the venv is a SIBLING of the stale install, not inside it.
      const sibling = IS_WIN ? join(dir, "venv", "Scripts") : join(dir, "venv", "bin");
      await mkdir(sibling, { recursive: true });
      const siblingPython = join(sibling, basename(python));
      await writeFile(siblingPython, "", "utf-8");

      const res = resolveLiveServerRoot([join("ComfyUI", "main.py")], undefined, {
        observedPython: siblingPython,
      });
      expect(res.source).toBe("unresolved");
      expect(res.root).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stays UNRESOLVED when the observed interpreter is not inside an install tree", async () => {
    const dir = await tmpDir();
    try {
      // A system python with no ComfyUI anywhere above it.
      const python = join(dir, IS_WIN ? "python.exe" : "python3");
      await writeFile(python, "", "utf-8");
      const res = resolveLiveServerRoot([join("ComfyUI", "main.py")], undefined, {
        observedPython: python,
      });
      expect(res.source).toBe("unresolved");
      expect(res.observedPython).toBe(python);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never probes the process table in REMOTE mode (its paths are on another host)", async () => {
    const dir = await tmpDir();
    try {
      const { python } = await makePortableBundle(dir);
      const res = resolveLiveServerRoot([join("ComfyUI", "main.py")], undefined, {
        observedPython: python,
        remote: true,
      });
      expect(res.source).toBe("unresolved");
      expect(res.root).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #490 (reopened). `resolveEffectiveComfyUIBase` returns `config.comfyuiPath`
// BEFORE it consults remote mode, against its own docstring — so with
// --comfyui-url and a stale local COMFYUI_PATH it hands back an install that has
// nothing to do with the connected server. That resolver has twelve callers and
// is not being changed here; `resolveLocalMutationTarget` is what destructive
// paths use instead, and it must refuse rather than hand back the wrong tree.
//
// The consumer suites mock this function, which proves they HONOUR a refusal but
// not that the production resolver ever ISSUES one (codex gate). This exercises
// the real thing.

describe("resolveLocalMutationTarget — refuses what it cannot identify", () => {
  beforeEach(() => {
    h.remoteMode.value = false;
    h.mockConfig.comfyuiPath = undefined;
  });

  it("REFUSES in remote mode even when COMFYUI_PATH is set — the dangerous case", async () => {
    const { resolveLocalMutationTarget, resolveEffectiveComfyUIBase } = await import(
      "../../services/workspace-env.js"
    );
    h.remoteMode.value = true;
    h.mockConfig.comfyuiPath = "/stale/local/ComfyUI";

    // #490 IS NOW FIXED (by #835): the shared resolver checks remote mode before
    // it returns `config.comfyuiPath`, so it no longer hands back a local install
    // that has nothing to do with the connected server. This assertion used to
    // pin the bug — it was written to start failing on the day the resolver was
    // repaired, and it did exactly that on the rebase.
    expect(resolveEffectiveComfyUIBase()).toBeUndefined();
    // The mutation target still refuses, and still names why. Now defence in
    // depth rather than the only defence: a destructive path must be able to say
    // WHY it will not act, which an `undefined` cannot.
    const target = resolveLocalMutationTarget();
    expect(target.base).toBeUndefined();
    expect(target.refusal).toMatch(/REMOTE ComfyUI/i);
    expect(target.refusal).toMatch(/stale\/local\/ComfyUI/);
    expect(target.refusal).toMatch(/DIFFERENT install/i);
  });

  // The third case — no path establishable at all — is deliberately NOT tested
  // here: with COMFYUI_PATH unset this resolver falls through to the machine's
  // SAVED DEFAULT WORKSPACE, so on any developer rig that has one the assertion
  // depends on the host rather than the code. The consumer suites cover it with
  // that lookup mocked.
  it("returns the base in LOCAL mode — the refusal must not swallow the normal case", async () => {
    const { resolveLocalMutationTarget } = await import("../../services/workspace-env.js");
    h.mockConfig.comfyuiPath = "/local/ComfyUI";
    const target = resolveLocalMutationTarget();
    expect(target.base).toBe("/local/ComfyUI");
    expect(target.refusal).toBeUndefined();
  });

});

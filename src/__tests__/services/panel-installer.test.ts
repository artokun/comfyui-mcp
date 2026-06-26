import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";

// Mock config so importing panel-installer doesn't trigger real port detection.
// (We drive comfyuiPath via the injected deps, not the mocked config, but the
// import graph still pulls config in.)
vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined as string | undefined },
}));

import {
  detectPanelInstall,
  ensurePanelInstalled,
  panelStatus,
  runPanelAction,
  PanelInstallError,
  PANEL_REGISTRY_ID,
  PANEL_VERSION,
  type PanelInstallerDeps,
} from "../../services/panel-installer.js";

const COMFY = "/fake/comfy";
const CUSTOM_NODES = join(COMFY, "custom_nodes");

function pyproject(name: string, version = "1.2.3"): string {
  return `[project]\nname = "${name}"\nversion = "${version}"\n`;
}

interface Harness {
  deps: PanelInstallerDeps;
  installs: Array<{ id: string; version?: string }>;
  updates: Array<{ id: string }>;
  reinstalls: Array<{ id: string; version?: string }>;
}

function makeDeps(opts: {
  comfyuiPath?: string;
  local?: boolean; // isLocalMode() — defaults to true
  env?: NodeJS.ProcessEnv;
  files?: Record<string, string>; // path -> pyproject contents
  dirs?: string[]; // custom_nodes subdir names
  symlinks?: string[]; // absolute dir paths that are symlinks
  reachable?: boolean;
} = {}): Harness {
  const files = opts.files ?? {};
  const dirs = opts.dirs ?? [];
  const symlinks = new Set(opts.symlinks ?? []);
  const installs: Harness["installs"] = [];
  const updates: Harness["updates"] = [];
  const reinstalls: Harness["reinstalls"] = [];

  const deps: PanelInstallerDeps = {
    isLocalMode: () => opts.local ?? true,
    comfyuiPath: () => opts.comfyuiPath,
    env: () => opts.env ?? {},
    existsSync: (p) => p === CUSTOM_NODES || p in files,
    isSymlink: (p) => symlinks.has(p),
    readdir: (p) => (p === CUSTOM_NODES ? dirs : []),
    readFile: (p) => files[p] ?? "",
    isReachable: async () => opts.reachable ?? true,
    install: async (o) => {
      installs.push(o);
      return { mechanism: "manager-http", message: "installed" };
    },
    update: async (o) => {
      updates.push(o);
      return { mechanism: "manager-http", message: "updated" };
    },
    reinstall: async (o) => {
      reinstalls.push(o);
      return { mechanism: "manager-http", message: "reinstalled" };
    },
  };
  return { deps, installs, updates, reinstalls };
}

describe("detectPanelInstall", () => {
  it("returns not-applicable when no local ComfyUI (remote/cloud mode)", async () => {
    const { deps } = makeDeps({ comfyuiPath: undefined });
    const d = await detectPanelInstall(deps);
    expect(d.applicable).toBe(false);
    expect(d.installed).toBe(false);
    expect(d.isDevSymlink).toBe(false);
  });

  it("matches by pyproject name in the repo-named fast-path dir", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      files: { [join(dir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "2.0.0") },
    });
    const d = await detectPanelInstall(deps);
    expect(d.installed).toBe(true);
    expect(d.dir).toBe(dir);
    expect(d.version).toBe("2.0.0");
    expect(d.isDevSymlink).toBe(false);
  });

  it("matches by pyproject name even in an arbitrarily-named dir (scan)", async () => {
    const dir = join(CUSTOM_NODES, "weird-folder-name");
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: ["weird-folder-name", "some-other-node"],
      files: {
        [join(dir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "3.1.4"),
        [join(CUSTOM_NODES, "some-other-node", "pyproject.toml")]: pyproject("other-pack"),
      },
    });
    const d = await detectPanelInstall(deps);
    expect(d.installed).toBe(true);
    expect(d.dir).toBe(dir);
    expect(d.version).toBe("3.1.4");
  });

  it("detects a dev symlink via lstat", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      files: { [join(dir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID) },
      symlinks: [dir],
    });
    const d = await detectPanelInstall(deps);
    expect(d.installed).toBe(true);
    expect(d.isDevSymlink).toBe(true);
  });

  it("P1a: a known panel dir that is a junction with NO pyproject is still dev", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    // No pyproject file at all — only the symlink exists.
    const { deps } = makeDeps({ comfyuiPath: COMFY, symlinks: [dir] });
    const d = await detectPanelInstall(deps);
    expect(d.installed).toBe(true);
    expect(d.isDevSymlink).toBe(true);
    expect(d.dir).toBe(dir);
    expect(d.version).toBeUndefined();
  });

  it("P1a: a known panel dir that is a junction with CORRUPT pyproject is still dev", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-agent-panel");
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      symlinks: [dir],
      files: { [join(dir, "pyproject.toml")]: "this is not valid toml {{{" },
    });
    const d = await detectPanelInstall(deps);
    expect(d.installed).toBe(true);
    expect(d.isDevSymlink).toBe(true);
  });

  it("P1b: not-applicable in remote mode even when COMFYUI_PATH is set", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      local: false,
      files: { [join(dir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID) },
    });
    const d = await detectPanelInstall(deps);
    expect(d.applicable).toBe(false);
    expect(d.installed).toBe(false);
  });

  it("reports not-installed when no pyproject name matches", async () => {
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: ["unrelated"],
      files: { [join(CUSTOM_NODES, "unrelated", "pyproject.toml")]: pyproject("unrelated") },
    });
    const d = await detectPanelInstall(deps);
    expect(d.applicable).toBe(true);
    expect(d.installed).toBe(false);
  });
});

describe("ensurePanelInstalled policy matrix", () => {
  it("missing → installs nightly (restart required)", async () => {
    const h = makeDeps({ comfyuiPath: COMFY });
    const res = await ensurePanelInstalled({ deps: h.deps });
    expect(res.action).toBe("installed");
    expect(res.restartRequired).toBe(true);
    expect(h.installs).toEqual([{ id: PANEL_REGISTRY_ID, version: PANEL_VERSION }]);
  });

  it("present → up-to-date (no churn on load, no install call)", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [join(dir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "1.0.0") },
    });
    const res = await ensurePanelInstalled({ deps: h.deps });
    expect(res.action).toBe("up-to-date");
    expect(res.installedVersion).toBe("1.0.0");
    expect(h.installs).toEqual([]);
  });

  it("dev symlink → skipped-dev (never touches it)", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [join(dir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID) },
      symlinks: [dir],
    });
    const res = await ensurePanelInstalled({ deps: h.deps });
    expect(res.action).toBe("skipped-dev");
    expect(h.installs).toEqual([]);
    expect(h.updates).toEqual([]);
  });

  it("no COMFYUI_PATH → unavailable (local-only)", async () => {
    const h = makeDeps({ comfyuiPath: undefined });
    const res = await ensurePanelInstalled({ deps: h.deps });
    expect(res.action).toBe("unavailable");
    expect(h.installs).toEqual([]);
  });

  it("P1b: remote mode with COMFYUI_PATH → unavailable (no mutation)", async () => {
    const h = makeDeps({ comfyuiPath: COMFY, local: false });
    const res = await ensurePanelInstalled({ deps: h.deps });
    expect(res.action).toBe("unavailable");
    expect(h.installs).toEqual([]);
  });

  it("P1a: dev junction with NO pyproject → skipped-dev (no install)", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const h = makeDeps({ comfyuiPath: COMFY, symlinks: [dir] });
    const res = await ensurePanelInstalled({ deps: h.deps });
    expect(res.action).toBe("skipped-dev");
    expect(h.installs).toEqual([]);
  });

  it("not reachable → unavailable", async () => {
    const h = makeDeps({ comfyuiPath: COMFY, reachable: false });
    const res = await ensurePanelInstalled({ deps: h.deps });
    expect(res.action).toBe("unavailable");
    expect(h.installs).toEqual([]);
  });

  it("opt-out env (COMFYUI_MCP_PANEL_AUTOINSTALL=0) → skipped", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      env: { COMFYUI_MCP_PANEL_AUTOINSTALL: "0" },
    });
    const res = await ensurePanelInstalled({ deps: h.deps });
    expect(res.action).toBe("skipped");
    expect(h.installs).toEqual([]);
  });

  it("opt-out env 'false' → skipped", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      env: { COMFYUI_MCP_PANEL_AUTOINSTALL: "false" },
    });
    const res = await ensurePanelInstalled({ deps: h.deps });
    expect(res.action).toBe("skipped");
  });

  it("swallows errors and returns unavailable", async () => {
    const h = makeDeps({ comfyuiPath: COMFY });
    h.deps.install = async () => {
      throw new Error("manager down");
    };
    const res = await ensurePanelInstalled({ deps: h.deps });
    expect(res.action).toBe("unavailable");
    expect(res.reason).toContain("manager down");
  });
});

describe("runPanelAction", () => {
  it("install targets nightly and flags restart required", async () => {
    const h = makeDeps({ comfyuiPath: COMFY });
    const r = await runPanelAction("install", h.deps);
    expect(r.action).toBe("install");
    expect(r.restartRequired).toBe(true);
    expect(r.message).toMatch(/RESTART ComfyUI/);
    expect(h.installs).toEqual([{ id: PANEL_REGISTRY_ID, version: PANEL_VERSION }]);
  });

  it("update calls updateCustomNode for the panel", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [join(dir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID) },
    });
    const r = await runPanelAction("update", h.deps);
    expect(r.action).toBe("update");
    expect(h.updates).toEqual([{ id: PANEL_REGISTRY_ID }]);
  });

  it("reinstall targets nightly", async () => {
    const h = makeDeps({ comfyuiPath: COMFY });
    const r = await runPanelAction("reinstall", h.deps);
    expect(h.reinstalls).toEqual([{ id: PANEL_REGISTRY_ID, version: PANEL_VERSION }]);
    expect(r.message).toMatch(/RESTART ComfyUI/);
  });

  it("REFUSES on a dev symlink", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [join(dir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID) },
      symlinks: [dir],
    });
    await expect(runPanelAction("update", h.deps)).rejects.toBeInstanceOf(
      PanelInstallError,
    );
    expect(h.updates).toEqual([]);
  });

  it("REFUSES when no COMFYUI_PATH (local-only)", async () => {
    const h = makeDeps({ comfyuiPath: undefined });
    await expect(runPanelAction("install", h.deps)).rejects.toBeInstanceOf(
      PanelInstallError,
    );
    expect(h.installs).toEqual([]);
  });

  it("P1a: REFUSES reinstall over a junction with NO pyproject (no clobber)", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const h = makeDeps({ comfyuiPath: COMFY, symlinks: [dir] });
    await expect(runPanelAction("reinstall", h.deps)).rejects.toBeInstanceOf(
      PanelInstallError,
    );
    expect(h.reinstalls).toEqual([]);
    expect(h.installs).toEqual([]);
  });

  it("P1b: REFUSES mutation in remote mode even with COMFYUI_PATH set", async () => {
    const h = makeDeps({ comfyuiPath: COMFY, local: false });
    await expect(runPanelAction("install", h.deps)).rejects.toBeInstanceOf(
      PanelInstallError,
    );
    await expect(runPanelAction("update", h.deps)).rejects.toBeInstanceOf(
      PanelInstallError,
    );
    await expect(runPanelAction("reinstall", h.deps)).rejects.toBeInstanceOf(
      PanelInstallError,
    );
    expect(h.installs).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(h.reinstalls).toEqual([]);
  });
});

describe("panelStatus", () => {
  it("never throws and reports not-applicable in remote/cloud mode", async () => {
    const { deps } = makeDeps({ comfyuiPath: undefined });
    const s = await panelStatus(deps);
    expect(s.applicable).toBe(false);
    expect(s.installed).toBe(false);
    expect(s.note).toMatch(/local-only/i);
  });

  it("P1b: remote mode note even with COMFYUI_PATH set (never errors)", async () => {
    const { deps } = makeDeps({ comfyuiPath: COMFY, local: false });
    const s = await panelStatus(deps);
    expect(s.applicable).toBe(false);
    expect(s.note).toMatch(/remote\/cloud mode/i);
  });

  it("reports installed version and dev-symlink note", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      files: { [join(dir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "4.5.6") },
      symlinks: [dir],
    });
    const s = await panelStatus(deps);
    expect(s.installed).toBe(true);
    expect(s.installedVersion).toBe("4.5.6");
    expect(s.isDevSymlink).toBe(true);
    expect(s.note).toMatch(/symlink/i);
  });

  it("notes install instructions when missing", async () => {
    const { deps } = makeDeps({ comfyuiPath: COMFY });
    const s = await panelStatus(deps);
    expect(s.installed).toBe(false);
    expect(s.targetVersion).toBe(PANEL_VERSION);
    expect(s.note).toMatch(/install/i);
  });
});

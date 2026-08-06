import { afterAll, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Panel mutations take a FILE lock (panel-pin-guard). Point it at a temp path so
// the suite never touches ~/.comfyui-mcp, and so parallel vitest workers get
// their own lock instead of serializing on one shared file.
process.env.COMFYUI_MCP_PANEL_LOCK = join(
  tmpdir(),
  `cmcp-lock-installer-${process.pid}.lock`,
);

// Mock config so importing panel-installer doesn't trigger real port detection.
// (We drive comfyuiPath via the injected deps, not the mocked config, but the
// import graph still pulls config in.)
vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined as string | undefined },
  isLocalMode: () => true,
}));

// #700: panel management must use the same saved-default workspace resolution
// as install_comfyui (action:"environment") when COMFYUI_PATH itself is unset.
const workspace = vi.hoisted(() => ({ base: undefined as string | undefined }));
vi.mock("../../services/workspace-env.js", () => ({
  resolveEffectiveComfyUIBase: () => workspace.base,
  // Panel management asks the LOCAL-MACHINE question (it gates on isLocalMode itself),
  // which #490 split out from the operation-target one. Same stub: in a local session
  // the two agree, and these tests are a local session.
  resolveLocalWorkspaceBase: () => workspace.base,
}));

import {
  detectPanelInstall,
  ensurePanelInstalled,
  panelStatus,
  runPanelAction,
  classifyPanelUpdate,
  resolveGitRevision,
  looksLikeManagerNoOp,
  findPanelShadows,
  looksLikePanelBackupName,
  readQueueCounts,
  isProvenQuiescentQueue,
  PanelInstallError,
  PANEL_REGISTRY_ID,
  PANEL_VERSION,
  defaultDeps,
  type PanelInstallerDeps,
} from "../../services/panel-installer.js";
import type { PanelPinState } from "../../services/panel-settings.js";

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
  /** Dirs the #724 git-fallback mock was called on. */
  gitPulls: string[];
  /** Live call counts for the stubs that answer in sequence. */
  counters: { liveQueueProbes: number };
}

function makeDeps(opts: {
  comfyuiPath?: string;
  local?: boolean; // isLocalMode() — defaults to true
  env?: NodeJS.ProcessEnv;
  files?: Record<string, string>; // path -> pyproject contents
  dirs?: string[]; // custom_nodes subdir names
  symlinks?: string[]; // absolute dir paths that are symlinks
  nonDirEntries?: string[]; // custom_nodes entries that are FILES, not dirs
  realPaths?: Record<string, string>; // path -> canonical realpath (else undefined)
  reachable?: boolean;
  /** Active panel-version pin the deps report (defaults to unpinned). */
  pin?: PanelPinState;
  /** Raw ComfyUI-Manager queue status the `update` mock returns as details. */
  updateDetails?: unknown;
  /** Queue status the `install`/`reinstall` mocks return as details. */
  installDetails?: unknown;
  reinstallDetails?: unknown;
  /** Per-dir git-HEAD sha (absolute dir path -> sha). Read via gitRevision. */
  revs?: Record<string, string>;
  /**
   * Side effect the `update` mock runs against the live `files`/`revs` maps to
   * simulate what actually landed on disk (advance/remove pyproject or sha).
   */
  onUpdate?: (ctx: { files: Record<string, string>; revs: Record<string, string> }) => void;
  /** Side effect the `install` mock runs to simulate the pack landing. */
  onInstall?: (ctx: { files: Record<string, string>; revs: Record<string, string> }) => void;
  /** Side effect the `reinstall` mock runs to simulate the pack landing. */
  onReinstall?: (ctx: { files: Record<string, string>; revs: Record<string, string> }) => void;
  /**
   * Side effect the #724 git-fallback mock (the pinned `merge --ff-only`) runs against
   * the live `files`/`revs` maps, returning git's output. When omitted the mock
   * THROWS — the persona has no working git fallback (git itself errors).
   */
  onGitPull?: (ctx: { files: Record<string, string>; revs: Record<string, string> }) => string;
  /**
   * `git status --porcelain` output the cleanliness-gate mock returns for the
   * panel dir ("" = clean, the default). Anything non-empty is a dirty
   * worktree and must refuse the fallback BEFORE any pull is attempted.
   */
  gitStatus?: string;
  /** What gitWorktreeRoot returns (defaults to the dir itself = proven root). */
  gitRoot?: string;
  /** When set, gitWorktreeRoot throws this — the "cannot prove" refusal path. */
  gitRootError?: string;
  /** Upstream sha override (default: the dir's HEAD — HEAD === upstream). */
  upstreamRev?: string;
  /** When set, gitUpstreamRev throws "no upstream configured". */
  noUpstream?: boolean;
  /** Manager API dialect the probe reports ("unproven" -> undefined). Defaults to "legacy". */
  dialect?: "v2" | "v2-batch" | "legacy" | "unproven";
  /** Ignored-file collisions the fallback gate reports (default: none). */
  ignoredConflicts?: string[];
  /** When set, the Manager `update` mock throws this — the #771 direct path. */
  updateThrows?: string;
  /**
   * #824 concurrency bracket — the answers the LIVE Manager queue re-probe
   * gives, in call order (`undefined` = the probe could not read the queue at
   * all). Once exhausted, and by default, every probe reports a proven-idle
   * queue, so cases that are not ABOUT the bracket stay hermetic from it.
   */
  liveQueue?: Array<{ pending: number; inProgress: number; processing: boolean } | undefined>;
  /**
   * `git status --porcelain` outputs in call order — how a case models a
   * worktree that changes UNDER the gates (the fallback reads it at the
   * cleanliness gate, again as the pre-merge CAS, and again after the merge).
   * Falls back to `gitStatus` once exhausted.
   */
  gitStatusSeq?: string[];
  /**
   * Zero-based `git status --porcelain` call index at which the mock THROWS —
   * how a case models a checkout that cannot be read at all at one specific
   * point (the guard is itself an operation that can fail). Index 2 is the
   * fallback's post-merge re-read.
   */
  gitStatusThrowsAt?: number;
  /**
   * Fires from the ignored-file gate — the LAST read the fallback takes before
   * its pre-merge compare-and-swap. How a case models a concurrent writer
   * acting inside exactly the window the CAS exists to catch.
   */
  onBeforeMerge?: (ctx: { files: Record<string, string>; revs: Record<string, string> }) => void;
} = {}): Harness {
  const files = opts.files ?? {};
  const revs = opts.revs ?? {};
  const dirs = opts.dirs ?? [];
  const symlinks = new Set(opts.symlinks ?? []);
  const nonDirs = new Set((opts.nonDirEntries ?? []).map((n) => join(CUSTOM_NODES, n)));
  const installs: Harness["installs"] = [];
  const updates: Harness["updates"] = [];
  const reinstalls: Harness["reinstalls"] = [];
  const gitPulls: Harness["gitPulls"] = [];
  // Call counters the sequenced stubs above index into, and that #824 cases
  // assert on (the live re-probe must actually have been taken).
  const counters: Harness["counters"] = { liveQueueProbes: 0 };
  let statusCalls = 0;

  const deps: PanelInstallerDeps = {
    isLocalMode: () => opts.local ?? true,
    comfyuiPath: () => opts.comfyuiPath,
    env: () => opts.env ?? {},
    existsSync: (p) => p === CUSTOM_NODES || p in files,
    // Files map holds regular files (pyproject, web assets) — CUSTOM_NODES is a dir.
    probeFile: (p) => p in files,
    isSymlink: (p) => symlinks.has(p),
    isDirectory: (p) => !nonDirs.has(p),
    realPath: (p) => opts.realPaths?.[p],
    readdir: (p) => (p === CUSTOM_NODES ? dirs : []),
    readFile: (p) => files[p] ?? "",
    gitRevision: (dir) => revs[dir],
    gitStatusPorcelain: () => {
      if (statusCalls === opts.gitStatusThrowsAt) {
        statusCalls++;
        throw new Error("fatal: not a git repository (or any parent up to mount point)");
      }
      return statusCalls < (opts.gitStatusSeq?.length ?? 0)
        ? (opts.gitStatusSeq as string[])[statusCalls++]
        : ((statusCalls++, opts.gitStatus) ?? "");
    },
    fetchLiveQueueCounts: async () => {
      const i = counters.liveQueueProbes++;
      const seq = opts.liveQueue;
      if (seq && i < seq.length) return seq[i];
      return { pending: 0, inProgress: 0, processing: false };
    },
    gitWorktreeRoot: (dir) => {
      if (opts.gitRootError) throw new Error(opts.gitRootError);
      return opts.gitRoot ?? dir;
    },
    gitUpstreamRev: (dir) => {
      if (opts.noUpstream) throw new Error("fatal: no upstream configured");
      return opts.upstreamRev ?? revs[dir];
    },
    detectManagerDialect: async () =>
      opts.dialect === "unproven" ? undefined : (opts.dialect ?? "legacy"),
    gitIgnoredPullConflicts: () => {
      opts.onBeforeMerge?.({ files, revs });
      return opts.ignoredConflicts ?? [];
    },
    gitFetch: () => {},
    // Records the pinned merge --ff-only call (the rev is the fetched upstream sha).
    gitMergeFfOnly: (dir) => {
      gitPulls.push(dir);
      if (opts.onGitPull) return opts.onGitPull({ files, revs });
      throw new Error("remote: Repository not found / no upstream (persona has no working git fallback)");
    },
    // Default: NOT pinned. Pin behaviour has its own suite (panel-sync.test.ts);
    // injecting it here keeps every existing case hermetic from the developer's
    // real ~/.comfyui-mcp/panel-settings.json.
    readPin: () => opts.pin ?? { pinned: false, source: "none" as const },
    isReachable: async () => opts.reachable ?? true,
    install: async (o) => {
      installs.push(o);
      opts.onInstall?.({ files, revs });
      return { mechanism: "manager-http", message: "installed", details: opts.installDetails };
    },
    update: async (o) => {
      updates.push(o);
      if (opts.updateThrows) throw new Error(opts.updateThrows);
      // Mutate the on-disk view BEFORE returning, so the post-update re-read in
      // runPanelAction sees exactly what "landed" (or didn't).
      opts.onUpdate?.({ files, revs });
      return {
        mechanism: "manager-http",
        message: "updated",
        details: opts.updateDetails,
      };
    },
    reinstall: async (o) => {
      reinstalls.push(o);
      opts.onReinstall?.({ files, revs });
      return { mechanism: "manager-http", message: "reinstalled", details: opts.reinstallDetails };
    },
  };
  return { deps, installs, updates, reinstalls, gitPulls, counters };
}

describe("detectPanelInstall", () => {
  it("#700: default deps inspect the saved local workspace when COMFYUI_PATH is unset", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmcp-panel-saved-workspace-"));
    try {
      workspace.base = root;
      const panelDir = join(root, "custom_nodes", "comfyui-mcp-panel");
      mkdirSync(panelDir, { recursive: true });
      writeFileSync(join(panelDir, "pyproject.toml"), pyproject(PANEL_REGISTRY_ID, "0.8.0"));

      const detected = await detectPanelInstall(defaultDeps);
      expect(detected).toMatchObject({
        applicable: true,
        installed: true,
        dir: panelDir,
        version: "0.8.0",
      });
    } finally {
      workspace.base = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

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
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const h = makeDeps({
      comfyuiPath: COMFY,
      // Simulate the pack landing so the new post-install verification passes.
      onInstall: ({ files }) => {
        files[join(dir, "pyproject.toml")] = pyproject(PANEL_REGISTRY_ID, "0.11.32");
      },
    });
    const res = await ensurePanelInstalled({ deps: h.deps });
    expect(res.action).toBe("installed");
    expect(res.restartRequired).toBe(true);
    expect(res.installedVersion).toBe("0.11.32");
    expect(h.installs).toEqual([{ id: PANEL_REGISTRY_ID, version: PANEL_VERSION }]);
  });

  it("#639: missing → install does NOT land → unavailable (not fabricated 'installed')", async () => {
    // No onInstall → Manager 'queued' but nothing on disk.
    const h = makeDeps({ comfyuiPath: COMFY });
    const res = await ensurePanelInstalled({ deps: h.deps });
    expect(res.action).toBe("unavailable");
    expect(res.reason).toMatch(/could not be verified|no-op/i);
    expect(h.installs).toEqual([{ id: PANEL_REGISTRY_ID, version: PANEL_VERSION }]);
  });

  it("#641: missing → install lands but a shadow exists → 'shadowed', not 'installed'", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const bak = ".comfyui-agent-panel.bak-0.11.28";
    const h = makeDeps({
      comfyuiPath: COMFY,
      dirs: [bak],
      files: { [join(CUSTOM_NODES, bak, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.28") },
      onInstall: ({ files }) => {
        files[join(dir, "pyproject.toml")] = pyproject(PANEL_REGISTRY_ID, "0.11.32");
      },
    });
    const res = await ensurePanelInstalled({ deps: h.deps });
    expect(res.action).toBe("shadowed");
    expect(res.reason).toMatch(/shadow/i);
  });

  it("#639: unreliable pre-scan (readdir fails) → unavailable, does NOT auto-install blind", async () => {
    // Panel exists in a non-fast-path dir; enumeration fails so detection can't
    // see it. Auto-install must NOT run (would create a duplicate) nor fabricate.
    const h = makeDeps({ comfyuiPath: COMFY });
    h.deps.readdir = () => {
      throw new Error("EACCES: scandir");
    };
    const res = await ensurePanelInstalled({ deps: h.deps });
    expect(res.action).toBe("unavailable");
    expect(res.reason).toMatch(/enumerate|confirm the panel is missing/i);
    expect(h.installs).toEqual([]);
  });

  it("#641: on-load install NO-OPs but a served shadow exists → 'shadowed', not 'unavailable'", async () => {
    const bak = ".comfyui-agent-panel.bak-0.11.28";
    const h = makeDeps({
      comfyuiPath: COMFY,
      dirs: [bak],
      files: {
        // A served backup copy is present; the canonical install never lands.
        [join(CUSTOM_NODES, bak, "web", "js", "comfyui-mcp-panel.js")]: "// old panel",
      },
      // No onInstall → Manager no-op, canonical dir never appears.
    });
    const res = await ensurePanelInstalled({ deps: h.deps });
    expect(res.action).toBe("shadowed");
    expect(res.reason).toMatch(/shadow/i);
  });

  it("#641: present WITH a shadow → 'shadowed' (surfaces the trap on load)", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const bak = ".comfyui-agent-panel.bak-0.11.28";
    const h = makeDeps({
      comfyuiPath: COMFY,
      dirs: [bak],
      files: {
        [join(dir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.32"),
        [join(CUSTOM_NODES, bak, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.28"),
      },
    });
    const res = await ensurePanelInstalled({ deps: h.deps });
    expect(res.action).toBe("shadowed");
    expect(h.installs).toEqual([]); // never re-installs a present panel
  });

  it("present → present (no churn on load, no install call)", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [join(dir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "1.0.0") },
    });
    const res = await ensurePanelInstalled({ deps: h.deps });
    expect(res.action).toBe("present");
    expect(res.installedVersion).toBe("1.0.0");
    expect(h.installs).toEqual([]);
  });

  // #806 — the on-load ensure NEVER compares versions (it is install-if-missing),
  // so its verdict may not carry a currency word. The user in #806 read
  // `{"action":"up-to-date","installedVersion":"0.11.36"}` as "you are on the
  // latest panel" while 0.11.38 was published with the fix for the bug he was
  // chasing. Assert the CLAIM, not just the branch: the old name is gone and the
  // result says what it actually established.
  it("the present verdict never claims currency, and says what it did check", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [join(dir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.36") },
    });
    const res = await ensurePanelInstalled({ deps: h.deps });
    expect(res.action).not.toBe("up-to-date");
    expect(JSON.stringify(res)).not.toContain("up-to-date");
    expect(res.reason).toMatch(/does not compare versions/i);
    expect(res.reason).toMatch(/not a statement that the panel is current/i);
    // And it names a next step that moves someone who IS behind.
    expect(res.reason).toContain("install_comfyui(action:'panel', panel_action:'update')");
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
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const h = makeDeps({
      comfyuiPath: COMFY,
      // Simulate the pack landing on disk so the post-op presence check passes.
      onInstall: ({ files }) => {
        files[join(dir, "pyproject.toml")] = pyproject(PANEL_REGISTRY_ID, "0.11.32");
      },
    });
    const r = await runPanelAction("install", h.deps);
    expect(r.action).toBe("install");
    expect(r.restartRequired).toBe(true);
    expect(r.message).toMatch(/RESTART ComfyUI/);
    expect(h.installs).toEqual([{ id: PANEL_REGISTRY_ID, version: PANEL_VERSION }]);
  });

  it("#639: install where the pack never lands → throws, not silent success", async () => {
    // No onInstall → Manager "queued" but nothing on disk.
    const h = makeDeps({ comfyuiPath: COMFY });
    await expect(runPanelAction("install", h.deps)).rejects.toBeInstanceOf(
      PanelInstallError,
    );
    expect(h.installs).toEqual([{ id: PANEL_REGISTRY_ID, version: PANEL_VERSION }]);
  });

  it("update calls updateCustomNode for the panel (version moves → success)", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const pyPath = join(dir, "pyproject.toml");
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.28") },
      updateDetails: {
        total_count: 1,
        done_count: 1,
        in_progress_count: 0,
        pending_count: 0,
        is_processing: false,
      },
      // Simulate the pack actually advancing on disk.
      onUpdate: ({ files }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.32");
      },
    });
    const r = await runPanelAction("update", h.deps);
    expect(r.action).toBe("update");
    expect(h.updates).toEqual([{ id: PANEL_REGISTRY_ID }]);
    expect(r.previousVersion).toBe("0.11.28");
    expect(r.installedVersion).toBe("0.11.32");
    expect(r.restartRequired).toBe(true);
    expect(r.message).toMatch(/0\.11\.28.*0\.11\.32/);
  });

  it("#639: git-HEAD advances WITHOUT a version bump (nightly) → updated + restart", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const pyPath = join(dir, "pyproject.toml");
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      updateDetails: { total_count: 1, done_count: 1, is_processing: false },
      // Version string stays, but the commit sha advances.
      onUpdate: ({ revs }) => {
        revs[dir] = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      },
    });
    const r = await runPanelAction("update", h.deps);
    expect(r.installedVersion).toBe("0.11.32");
    expect(r.restartRequired).toBe(true);
    expect(r.message).toMatch(/updated/i);
  });

  // #639 — the core silent-fabricate-success regression guard.
  it("#639: Manager reports done but on-disk version UNCHANGED → throws, not success", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const pyPath = join(dir, "pyproject.toml");
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.28") },
      // Real installs are git checkouts — exercise that path with an UNCHANGED
      // HEAD, which must NOT be mistaken for "already current".
      revs: { [dir]: "dddddddddddddddddddddddddddddddddddddddd" },
      // The exact stale-3.x no-op signature from the issue: total_count 0 yet
      // done_count 2 — the queue "drains" trivially while nothing is enqueued.
      updateDetails: {
        total_count: 0,
        done_count: 2,
        in_progress_count: 0,
        pending_count: 0,
        is_processing: false,
      },
      // No onUpdate → nothing changes on disk.
    });
    await expect(runPanelAction("update", h.deps)).rejects.toBeInstanceOf(
      PanelInstallError,
    );
    // The update was actually attempted (not short-circuited).
    expect(h.updates).toEqual([{ id: PANEL_REGISTRY_ID }]);
    // And the diagnostic names the stale-Manager cause + the still-installed version.
    await expect(runPanelAction("update", h.deps)).rejects.toThrow(
      /did NOT apply|stale ComfyUI-Manager|0\.11\.28/,
    );
  });

  it("#639: unchanged version AND unchanged git-HEAD + coherent counts → fails closed (not success)", async () => {
    // An unchanged LOCAL git-HEAD is NOT proof of being at the upstream tip — it
    // only proves nothing was pulled, which is exactly the no-op. So even a git
    // checkout with identical pre/post HEAD and coherent-looking counts must NOT
    // report success.
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const pyPath = join(dir, "pyproject.toml");
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: "cccccccccccccccccccccccccccccccccccccccc" },
      updateDetails: { total_count: 1, done_count: 1, is_processing: false },
      // No onUpdate → version AND git-HEAD both unchanged.
    });
    await expect(runPanelAction("update", h.deps)).rejects.toBeInstanceOf(
      PanelInstallError,
    );
    await expect(runPanelAction("update", h.deps)).rejects.toThrow(
      /could not verify|did not change/i,
    );
  });

  it("#639: version unchanged, NO git identity, 'coherent' counts → fails closed (not success)", async () => {
    // Queue counts are queue-WIDE drain counters, NOT task-correlated, so
    // coherent-looking counts alone must NOT be treated as proof of work.
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const pyPath = join(dir, "pyproject.toml");
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.28") },
      // No revs → gitRevision returns undefined for the dir.
      updateDetails: { total_count: 1, done_count: 1, is_processing: false },
    });
    await expect(runPanelAction("update", h.deps)).rejects.toBeInstanceOf(
      PanelInstallError,
    );
    await expect(runPanelAction("update", h.deps)).rejects.toThrow(
      /could not verify|did not change/i,
    );
  });

  it("#639: post-update version UNREADABLE → fail-closed, not silent success", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const pyPath = join(dir, "pyproject.toml");
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.28") },
      updateDetails: {
        total_count: 1,
        done_count: 1,
        in_progress_count: 0,
        pending_count: 0,
        is_processing: false,
      },
      // Simulate the pack dir becoming unreadable after the op (pyproject gone).
      // NOTE: destructure `files` from the ctx wrapper so we mutate the real map.
      onUpdate: ({ files }) => {
        delete files[pyPath];
      },
    });
    await expect(runPanelAction("update", h.deps)).rejects.toBeInstanceOf(
      PanelInstallError,
    );
    await expect(runPanelAction("update", h.deps)).rejects.toThrow(
      /could not verify|NOT reporting success/i,
    );
  });

  it("reinstall targets nightly (verifies pack landed)", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const h = makeDeps({
      comfyuiPath: COMFY,
      onReinstall: ({ files }) => {
        files[join(dir, "pyproject.toml")] = pyproject(PANEL_REGISTRY_ID, "0.11.32");
      },
    });
    const r = await runPanelAction("reinstall", h.deps);
    expect(h.reinstalls).toEqual([{ id: PANEL_REGISTRY_ID, version: PANEL_VERSION }]);
    expect(r.message).toMatch(/RESTART ComfyUI/);
    expect(r.installedVersion).toBe("0.11.32");
  });

  it("#639: reinstall where the pack never lands → throws, not silent success", async () => {
    // The panel-layer post-op check is what fails this closed (the generic
    // reinstallCustomNode gained its own presence gate later, in #730 — but the
    // deps here are injected, so this exercises the panel's own check).
    const h = makeDeps({ comfyuiPath: COMFY });
    await expect(runPanelAction("reinstall", h.deps)).rejects.toBeInstanceOf(
      PanelInstallError,
    );
    expect(h.reinstalls).toEqual([{ id: PANEL_REGISTRY_ID, version: PANEL_VERSION }]);
  });

  it("#639: reinstall on a PRE-EXISTING panel + stale no-op counts → throws (present ≠ executed)", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const pyPath = join(dir, "pyproject.toml");
    // Panel already present; Manager reports the stale-3.x no-op (total 0/done 2)
    // and never actually reinstalls. Presence alone must NOT be read as success.
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.28") },
      reinstallDetails: { total_count: 0, done_count: 2, is_processing: false },
    });
    await expect(runPanelAction("reinstall", h.deps)).rejects.toThrow(
      /did NOT execute|stale ComfyUI-Manager/,
    );
  });

  it("#639: install on a PRE-EXISTING panel + stale no-op counts → throws (present ≠ executed)", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const pyPath = join(dir, "pyproject.toml");
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.28") },
      installDetails: { total_count: 0, done_count: 2, is_processing: false },
    });
    await expect(runPanelAction("install", h.deps)).rejects.toThrow(
      /did NOT execute|stale ComfyUI-Manager/,
    );
  });

  it("#639: reinstall that ACTUALLY moves the version SUCCEEDS despite stale queue-wide counts", async () => {
    // Movement is proven on disk; the queue-wide { total:0, done:2 } must NOT
    // veto a change the disk already proves.
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const pyPath = join(dir, "pyproject.toml");
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.28") },
      reinstallDetails: { total_count: 0, done_count: 2, is_processing: false },
      onReinstall: ({ files }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.32");
      },
    });
    const r = await runPanelAction("reinstall", h.deps);
    expect(r.installedVersion).toBe("0.11.32");
    expect(r.restartRequired).toBe(true);
  });

  it("#639: unreliable PRE-op scan must NOT be read as absent→present (no fabricated fresh install)", async () => {
    // Panel already present in a NON-fast-path dir. The pre-op enumeration fails
    // (transient), so detection can't see it; a no-op reinstall leaves it as-is.
    // The reliability guard must refuse to infer a fresh install.
    const weird = "weird-panel-dir";
    const pyPath = join(CUSTOM_NODES, weird, "pyproject.toml");
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.28") },
      reinstallDetails: { total_count: 1, done_count: 1, is_processing: false },
    });
    let calls = 0;
    h.deps.readdir = (p) => {
      calls += 1;
      if (calls === 1) throw new Error("EAGAIN transient scandir failure");
      return p === CUSTOM_NODES ? [weird] : [];
    };
    await expect(runPanelAction("reinstall", h.deps)).rejects.toBeInstanceOf(
      PanelInstallError,
    );
  });

  it("#639: pre-op pyproject READ failure (present-but-unreadable) → not absent→present", async () => {
    // Pre-existing canonical panel whose FIRST pyproject read throws (transient),
    // SECOND succeeds; Manager does a stale no-op. The read failure must make the
    // pre-op absence inconclusive so the tool does NOT fabricate a fresh install.
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const pyPath = join(dir, "pyproject.toml");
    const contents = pyproject(PANEL_REGISTRY_ID, "0.11.28");
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: contents },
      reinstallDetails: { total_count: 1, done_count: 1, is_processing: false },
    });
    let reads = 0;
    h.deps.readFile = (p) => {
      if (p === pyPath) {
        reads += 1;
        if (reads === 1) throw new Error("EBUSY transient read failure");
      }
      return contents;
    };
    await expect(runPanelAction("reinstall", h.deps)).rejects.toBeInstanceOf(
      PanelInstallError,
    );
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

describe("runPanelAction #724 git fallback (legacy Manager 3.x no-op)", () => {
  const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
  const pyPath = join(dir, "pyproject.toml");
  const REV_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const REV_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  /** A THIRD sha — what a concurrent writer leaves HEAD on (#824 CAS). */
  const REV_C = "cccccccccccccccccccccccccccccccccccccccc";
  // The exact queue signature from the #724 report: the legacy 3.x Manager
  // accepted the update but never enqueued it (done 0 / total 0).
  const LEGACY_NOOP = {
    total_count: 0,
    done_count: 0,
    in_progress_count: 0,
    pending_count: 0,
    is_processing: false,
  };

  it("git checkout with HEAD UNREADABLE after the Manager call → unverified, fallback does NOT fire", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: LEGACY_NOOP,
      onUpdate: ({ revs }) => {
        delete revs[dir]; // HEAD unreadable post-op — version alone can't prove nothing moved
      },
      onGitPull: () => "Updating d806619..675ace8\nFast-forward",
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect(String(err?.message ?? err)).not.toMatch(/already at the upstream tip/);
    // The git fallback must NOT fire on a movement state it cannot prove.
    expect(h.gitPulls).toEqual([]);
  });

  it("dialect v2 (Manager 4.x host) + empty queue -> fallback REFUSED, no pull (outage is not the 3.x signature)", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: LEGACY_NOOP,
      dialect: "v2",
      onGitPull: () => "Updating d806619..675ace8\nFast-forward",
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect(String(err?.message ?? err)).toMatch(/did NOT apply/);
    expect(String(err?.message ?? err)).toMatch(/v2/);
    // On a non-legacy host an empty queue is an outage/failed enqueue: no git mutation.
    expect(h.updates).toEqual([{ id: PANEL_REGISTRY_ID }]);
    expect(h.gitPulls).toEqual([]);
  });

  it("dialect UNPROVEN + empty queue -> fallback REFUSED, no pull (fail closed)", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: LEGACY_NOOP,
      dialect: "unproven",
      onGitPull: () => "Updating d806619..675ace8\nFast-forward",
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect(String(err?.message ?? err)).toMatch(/did NOT apply|unproven/);
    expect(h.gitPulls).toEqual([]);
  });

  it("ignored local file collides with an incoming path -> fallback REFUSED before any pull (silent-overwrite guard)", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: LEGACY_NOOP,
      ignoredConflicts: ["web/local-notes.txt"],
      onGitPull: () => "Updating d806619..675ace8\nFast-forward",
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect(String(err?.message ?? err)).toMatch(/IGNORED|SILENTLY OVERWRITTEN|local-notes/);
    expect(h.gitPulls).toEqual([]);
  });

  it("#824: incoherent-but-idle queue signature (done>total) + HEAD at upstream → verified already-current, no stale-3.x claim", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: { total_count: 0, done_count: 2, in_progress_count: 0, pending_count: 0, is_processing: false },
      onGitPull: () => "Already up to date.",
    });
    const r = await runPanelAction("update", h.deps);
    // The pinned merge ran and found nothing to do — that IS the verification.
    expect(h.gitPulls).toEqual([dir]);
    expect(r.restartRequired).toBe(false);
    expect(r.message).toMatch(/already at the upstream tip/);
    // The cause named must be the incoherent counts, never the unproven stale-3.x no-op.
    expect(r.message).toMatch(/incoherent/);
    expect(r.message).not.toMatch(/stale legacy 3\.x/);
    expect(r.result.message).toBe(r.message);
  });

  it("#824: the report's exact signature (total 0, done 1) + HEAD BEHIND upstream → pinned ff-only applies the update, verified", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      // The queue signature from the #824 report.
      updateDetails: { total_count: 0, done_count: 1, in_progress_count: 0, pending_count: 0, is_processing: false },
      upstreamRev: REV_B,
      onGitPull: ({ files, revs }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.35");
        revs[dir] = REV_B;
        return "Updating aaaaaaaa..bbbbbbbb\nFast-forward";
      },
    });
    const r = await runPanelAction("update", h.deps);
    expect(h.updates).toEqual([{ id: PANEL_REGISTRY_ID }]);
    expect(h.gitPulls).toEqual([dir]);
    expect(r.previousVersion).toBe("0.11.32");
    expect(r.installedVersion).toBe("0.11.35");
    expect(r.restartRequired).toBe(true);
    expect(r.message).toMatch(/git merge --ff-only/);
    expect(r.message).toMatch(/incoherent/);
    expect(r.message).not.toMatch(/stale legacy 3\.x/);
  });

  it("#824: incoherent-but-idle signature on a v2 (Manager 4.x) host → verification still fires (its warrant is git's proof, not the Manager signature)", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: { total_count: 0, done_count: 1, in_progress_count: 0, pending_count: 0, is_processing: false },
      dialect: "v2",
      upstreamRev: REV_B,
      onGitPull: ({ files, revs }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.35");
        revs[dir] = REV_B;
        return "Updating aaaaaaaa..bbbbbbbb\nFast-forward";
      },
    });
    const r = await runPanelAction("update", h.deps);
    expect(h.gitPulls).toEqual([dir]);
    expect(r.installedVersion).toBe("0.11.35");
  });

  it("#824: partial-but-idle status (done_count ABSENT, live fields clear) → verifies, and names the status partial, NOT incoherent", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      // total 0 reads as a no-op, but the historical done counter is MISSING —
      // the status is partial, not contradictory. The live fields prove idle.
      updateDetails: { total_count: 0, pending_count: 0, in_progress_count: 0, is_processing: false },
      onGitPull: () => "Already up to date.",
    });
    const r = await runPanelAction("update", h.deps);
    expect(r.restartRequired).toBe(false);
    expect(r.message).toMatch(/already at the upstream tip/);
    expect(r.message).toMatch(/partial/);
    expect(r.message).not.toMatch(/incoherent/);
    expect(r.message).not.toMatch(/stale legacy 3\.x/);
  });

  it("#824: malformed historical counter (done_count: \"1\") with live fields clear → verifies, named missing-or-malformed, never incoherent", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      // done_count is PRESENT but invalid — the message must not call it missing.
      updateDetails: { total_count: 0, done_count: "1", pending_count: 0, in_progress_count: 0, is_processing: false },
      onGitPull: () => "Already up to date.",
    });
    const r = await runPanelAction("update", h.deps);
    expect(r.restartRequired).toBe(false);
    expect(r.message).toMatch(/already at the upstream tip/);
    expect(r.message).toMatch(/missing or malformed/);
    expect(r.message).not.toMatch(/incoherent/);
    expect(r.message).not.toMatch(/stale legacy 3\.x/);
  });

  it("#824: incoherent signature with live work NOT disproven (pending 1) → verification REFUSED, no git mutation", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: { total_count: 0, done_count: 1, in_progress_count: 0, pending_count: 1, is_processing: false },
      onGitPull: () => "merge output",
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect(String(err?.message ?? err)).toMatch(/did NOT apply/);
    expect(String(err?.message ?? err)).toMatch(/not disproven|provably idle/);
    expect(h.gitPulls).toEqual([]);
  });

  it("#824: incoherent-but-idle signature + DIRTY checkout → verification REFUSED before any pull", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: { total_count: 0, done_count: 1, in_progress_count: 0, pending_count: 0, is_processing: false },
      gitStatus: " M web/js/comfyui-mcp-panel.js",
      onGitPull: () => "merge output",
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect(String(err?.message ?? err)).toMatch(/UNCOMMITTED|dirty checkout/);
    // The refusal must not assert the stale-3.x cause it cannot prove.
    expect(String(err?.message ?? err)).toMatch(/incoherent/);
    expect(String(err?.message ?? err)).not.toMatch(/stale legacy 3\.x/);
    expect(h.gitPulls).toEqual([]);
  });

  // ---- #824 concurrency bracket -----------------------------------------
  // The quiescence that authorizes this fallback is a SNAPSHOT of the counts
  // the update call returned. These cases are the ones that snapshot cannot
  // decide on its own: the indicators read clear, and a Manager operation is
  // live against the checkout anyway. Without the bracket every one of them
  // merges destructively and reports success.
  //
  // The queue signature below is IDENTICAL to the verified-current case above
  // (total 0, done 1, every live indicator clear) — the only difference is
  // what is true at the moment of the mutation. That is the whole point.
  const IDLE_SNAPSHOT = {
    total_count: 0,
    done_count: 1,
    in_progress_count: 0,
    pending_count: 0,
    is_processing: false,
  };
  const BUSY = { pending: 1, inProgress: 0, processing: false };
  const WORKING = { pending: 0, inProgress: 1, processing: true };
  const FF = "Updating aaaaaaaa..bbbbbbbb\nFast-forward";

  it("#824 P0: clear indicators but a Manager op is LIVE at the merge -> REFUSED, no git mutation", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      // The snapshot that authorizes the fallback says idle ...
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_B,
      // ... and the live re-probe taken against the mutation says otherwise.
      liveQueue: [BUSY],
      onGitPull: ({ files, revs }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.35");
        revs[dir] = REV_B;
        return FF;
      },
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);
    // Assert the REASON, not merely that it threw: the snapshot was re-probed.
    expect(msg).toMatch(/re-probed immediately before the merge/);
    expect(msg).toMatch(/pending=1/);
    // Scoped to what was observed: this fallback did not merge. It must NOT
    // extend that to the Manager call, whose own effect is exactly what its
    // incoherent status could not report.
    expect(msg).toMatch(/NO git mutation was made/);
    expect(msg).toMatch(/whether the Manager call itself changed anything/);
    expect(h.gitPulls).toEqual([]);
    expect(h.counters.liveQueueProbes).toBe(1);
  });

  it("#824 P0: the live re-probe cannot READ the queue -> REFUSED (unknown is never idle)", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_B,
      liveQueue: [undefined], // Manager unreachable / unreadable status
      onGitPull: () => FF,
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);
    expect(msg).toMatch(/could not be read at all/);
    expect(msg).toMatch(/NO git mutation was made/);
    expect(h.gitPulls).toEqual([]);
  });

  it("#824 P0: HEAD moves between the safety gates and the merge -> REFUSED, no git mutation", async () => {
    // Every gate above passed against REV_A; a third party then advances HEAD.
    // The queue counts never change, so only a tree-level CAS catches this.
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_B,
      onBeforeMerge: ({ revs }) => {
        revs[dir] = REV_C; // someone else's commit lands after every gate passed
      },
      onGitPull: () => FF,
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);
    expect(msg).toMatch(/CHANGED between the safety gates/);
    expect(msg).toMatch(/HEAD moved/);
    expect(msg).toMatch(/NO git mutation was made by this fallback/);
    expect(h.gitPulls).toEqual([]);
  });

  it("#824: HEAD becomes UNREADABLE before the merge -> REFUSED as undetermined, not as 'HEAD moved'", async () => {
    // `gitRevision` reports an unresolvable HEAD as undefined rather than by
    // throwing. Refusing is right — an unverifiable tree does not license a
    // merge — but the refusal must say the comparison could not be MADE, not
    // that the checkout changed. "Could not determine" is not "determined not".
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_B,
      onBeforeMerge: ({ revs }) => {
        delete revs[dir]; // git can no longer resolve HEAD at all
      },
      onGitPull: () => FF,
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);
    expect(msg).toMatch(/UNREADABLE HEAD \(git resolved no revision/);
    expect(msg).toMatch(/could NOT be determined/);
    expect(msg).toMatch(/NOT proof that anything changed/);
    // The claims the "it moved" arm is allowed to make, and this one is not.
    expect(msg).not.toMatch(/HEAD moved/);
    expect(msg).not.toMatch(/evidently DID change/);
    expect(msg).toMatch(/NO git mutation was made/);
    expect(h.gitPulls).toEqual([]);
  });

  it("#824: HEAD is UNREADABLE after the merge -> disclosed as undetermined, no writer blamed", async () => {
    // Same fold on the far side of the mutation. The merge HAS run, so this
    // discloses rather than refuses — but an unreadable HEAD is not evidence
    // that another writer touched the tree, and must not be reported as such.
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_B,
      onGitPull: ({ files, revs }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.35");
        delete revs[dir];
        return FF;
      },
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);
    expect(msg).toMatch(/ALREADY RAN/);
    expect(msg).toMatch(/UNREADABLE HEAD \(git resolved no revision/);
    expect(msg).toMatch(/NOT evidence that something else did/);
    expect(msg).not.toMatch(/Another writer/);
    expect(msg).not.toMatch(/may now be INCONSISTENT/);
    expect(h.gitPulls).toEqual([dir]);
  });

  it("#824: unreadable HEAD AND a dirty worktree before the merge -> the DIRTY evidence wins", async () => {
    // The mirror of the case above. An unreadable HEAD leaves the revision
    // comparison undetermined, but porcelain answered — and the cleanliness
    // gate had proved this tree clean, so a dirty status here IS proof it
    // changed. Reporting "not proof that anything changed" while holding that
    // status would be the same defect pointed the other way.
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_B,
      // 0 = cleanliness gate (clean), 1 = the pre-merge CAS (dirty).
      gitStatusSeq: ["", " M web/js/comfyui-mcp-panel.js"],
      onBeforeMerge: ({ revs }) => {
        delete revs[dir];
      },
      onGitPull: () => FF,
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);
    expect(msg).toMatch(/CHANGED between the safety gates/);
    expect(msg).toMatch(/no longer clean/);
    expect(msg).not.toMatch(/NOT proof that anything changed/);
    expect(h.gitPulls).toEqual([]);
  });

  it("#824: unreadable HEAD AND a dirty worktree AFTER the merge -> the DIRTY evidence wins", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_B,
      // 0 = cleanliness gate, 1 = pre-merge CAS, 2 = the post-merge re-read.
      gitStatusSeq: ["", "", " M web/js/comfyui-mcp-panel.js"],
      onGitPull: ({ files, revs }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.35");
        delete revs[dir];
        return FF;
      },
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);
    expect(msg).toMatch(/ALREADY RAN/);
    expect(msg).toMatch(/the worktree is dirty/);
    expect(msg).toMatch(/may now be INCONSISTENT/);
    expect(msg).not.toMatch(/NOT evidence that something else did/);
    expect(h.gitPulls).toEqual([dir]);
  });

  it("#824 P0: the worktree goes dirty between the cleanliness gate and the merge -> REFUSED", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_B,
      // 1st read = the cleanliness gate (clean), 2nd = the pre-merge CAS.
      gitStatusSeq: ["", " M web/js/comfyui-mcp-panel.js"],
      onGitPull: () => FF,
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);
    expect(msg).toMatch(/CHANGED between the safety gates/);
    expect(msg).toMatch(/no longer clean/);
    expect(h.gitPulls).toEqual([]);
  });

  it("#824 P0: a write lands DURING the merge -> the merge is disclosed, never reported as success", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_B,
      // cleanliness gate, pre-merge CAS, then the post-merge re-read.
      gitStatusSeq: ["", "", " M web/js/comfyui-mcp-panel.js"],
      onGitPull: ({ files, revs }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.35");
        revs[dir] = REV_B;
        return FF;
      },
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);
    // The merge DID run — refusing language here would be a lie.
    expect(msg).toMatch(/ALREADY RAN/);
    expect(msg).toMatch(/may now be INCONSISTENT/);
    // The merge ran — refusal language would be a lie about a mutation.
    expect(msg).not.toMatch(/NO git mutation was made/);
    expect(h.gitPulls).toEqual([dir]);
  });

  it("#824 P0: a Manager task appears DURING the merge -> disclosed, never reported as success", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_B,
      liveQueue: [{ pending: 0, inProgress: 0, processing: false }, WORKING],
      onGitPull: ({ files, revs }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.35");
        revs[dir] = REV_B;
        return FF;
      },
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);
    expect(msg).toMatch(/ALREADY RAN/);
    expect(msg).toMatch(/did not hold all the way through/);
    expect(msg).toMatch(/is_processing=true/);
    expect(h.gitPulls).toEqual([dir]);
    expect(h.counters.liveQueueProbes).toBe(2);
  });

  it("#824 P0: the merge leaves a THIRD HEAD on a clean tree -> disclosed, never reported as success", async () => {
    // The dirty-worktree case above cannot reach this guard: here the tree ends
    // CLEAN, so only the HEAD comparison can catch it. A fast-forward pinned to
    // REV_B leaves HEAD at REV_B (or, if it was already there, unmoved) — a
    // third revision means somebody else's commit landed inside the window.
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_B,
      onGitPull: ({ files, revs }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.35");
        revs[dir] = REV_C; // NOT the pinned target, NOT the pre-merge rev
        return FF;
      },
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);
    expect(msg).toMatch(/ALREADY RAN/);
    expect(msg).toMatch(/neither the merged upstream/);
    expect(msg).toMatch(/may now be INCONSISTENT/);
    // The merge ran — refusal language would be a lie about a mutation.
    expect(msg).not.toMatch(/NO git mutation was made/);
    expect(h.gitPulls).toEqual([dir]);
  });

  it("#824 P0: the checkout cannot be re-read AFTER the merge -> disclosed as UNKNOWN, not as success", async () => {
    // The post-merge guard is itself an operation that can fail. Failing to
    // read is "could not determine whether anything else wrote here", which is
    // not "nothing else did" — and the merge has run, so the honest register is
    // disclosure, not a claim that nothing happened.
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_B,
      // 0 = cleanliness gate, 1 = pre-merge CAS, 2 = the post-merge re-read.
      gitStatusThrowsAt: 2,
      onGitPull: ({ files, revs }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.35");
        revs[dir] = REV_B;
        return FF;
      },
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);
    expect(msg).toMatch(/ALREADY RAN/);
    expect(msg).toMatch(/could not be re-read afterwards/);
    expect(msg).toMatch(/is UNKNOWN/);
    expect(msg).not.toMatch(/NO git mutation was made/);
    expect(h.gitPulls).toEqual([dir]);
  });

  it("#824: a FAILED merge does not get to claim the disk is unchanged — it re-reads and says what moved", async () => {
    // "The merge exited non-zero" is a bucket; "nothing changed on disk" is a
    // fact about the disk. The first does not establish the second — and the
    // likeliest cause of the failure (another writer in this checkout) is
    // precisely the case where the second is FALSE.
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_B,
      // 0 = cleanliness gate, 1 = pre-merge CAS, 2 = the post-failure re-read.
      gitStatusSeq: ["", "", " M web/js/comfyui-mcp-panel.js"],
      // onGitPull omitted -> the pinned merge THROWS.
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);
    // The HEADLINE moves with the observation: a tree that moved means the
    // merge may have applied PARTIALLY, so "did NOT apply" is not available.
    expect(msg).toMatch(/could NOT be confirmed/);
    expect(msg).not.toMatch(/did NOT apply/);
    expect(msg).toMatch(/NOT what it was before the attempt/);
    expect(msg).toMatch(/the worktree is dirty/);
    expect(msg).toMatch(/may therefore have applied PARTIALLY/);
    expect(msg).not.toMatch(/nothing changed on disk/);
    // The original merge failure survives into the message either way.
    expect(msg).toMatch(/persona has no working git fallback/);
    expect(h.gitPulls).toEqual([dir]);
  });

  it("#824: a failed merge over an UNREADABLE HEAD is UNKNOWN, not 'the tree is not what it was'", async () => {
    // The third instance of the same fold. Here the re-read SUCCEEDS — status
    // answers, HEAD simply cannot be resolved — so the failed-read catch never
    // fires; without its own branch this lands in the "tree moved" arm and
    // tells the user the directory is no longer in its pre-update state, which
    // nothing established.
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_B,
      onGitPull: ({ revs }) => {
        delete revs[dir];
        throw new Error("error: Your local changes would be overwritten by merge");
      },
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);
    expect(msg).toMatch(/could NOT be confirmed/);
    expect(msg).toMatch(/UNREADABLE HEAD \(git resolved no revision/);
    expect(msg).toMatch(/is UNKNOWN/);
    expect(msg).not.toMatch(/NOT what it was before the attempt/);
    expect(msg).not.toMatch(/applied PARTIALLY/);
    // The original merge failure still survives into the message.
    expect(msg).toMatch(/local changes would be overwritten/);
    expect(h.gitPulls).toEqual([dir]);
  });

  it("#824: a failed merge with an unreadable HEAD AND a dirty tree reports the DIRTY evidence", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_B,
      // 0 = cleanliness gate, 1 = pre-merge CAS, 2 = the post-failure re-read.
      gitStatusSeq: ["", "", " M web/js/comfyui-mcp-panel.js"],
      onGitPull: ({ revs }) => {
        delete revs[dir];
        throw new Error("error: Your local changes would be overwritten by merge");
      },
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);
    expect(msg).toMatch(/could NOT be confirmed/);
    expect(msg).toMatch(/the worktree is dirty/);
    expect(msg).toMatch(/NOT what it was before the attempt/);
    expect(msg).not.toMatch(/is UNKNOWN/);
    expect(h.gitPulls).toEqual([dir]);
  });

  it("#824: a failed merge whose OWN re-read fails is disclosed as UNKNOWN, never as 'did NOT apply'", async () => {
    // The re-read added above is itself two operations that can fail. Both live
    // in one try, so an unreadable HEAD and an unreadable status reach the same
    // handler; this drives it through `git status`. Failing to read is "could
    // not determine whether the merge applied partially", which is not "it did
    // not apply" — and it must not swallow the merge error either.
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_B,
      // 0 = cleanliness gate, 1 = pre-merge CAS, 2 = the post-failure re-read.
      gitStatusThrowsAt: 2,
      // onGitPull omitted -> the pinned merge THROWS.
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);
    expect(msg).toMatch(/could NOT be confirmed/);
    expect(msg).not.toMatch(/did NOT apply/);
    expect(msg).toMatch(/could not be re-read afterwards/);
    expect(msg).toMatch(/is UNKNOWN/);
    // The merge error is what the user needs most; it must not be lost.
    expect(msg).toMatch(/persona has no working git fallback/);
    expect(h.gitPulls).toEqual([dir]);
  });

  it("#824: a FAILED merge that re-reads UNCHANGED still reports the version unchanged (no false alarm)", async () => {
    // The other side of the same guard: observing an untouched tree is exactly
    // what licenses the reassuring wording, so it must still be given. A fix
    // that refused to say anything here would have overshot into alarm.
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_B,
      // onGitPull omitted -> the pinned merge THROWS; the tree stays clean.
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);
    expect(msg).toMatch(/re-read afterwards and is unchanged/);
    expect(msg).toMatch(/installed version is still 0\.11\.32/);
    expect(msg).not.toMatch(/NOT what it was before/);
    // Only an OBSERVED untouched tree earns the flat "did NOT apply" headline.
    expect(msg).toMatch(/did NOT apply/);
    expect(msg).not.toMatch(/could NOT be confirmed/);
  });

  it("#824: 'already at the upstream tip' claims only what git proved, not an untouched directory", async () => {
    // HEAD === the FETCHED upstream proves the TRACKED checkout is current. It
    // does not prove the directory was untouched: porcelain never reports
    // ignored paths, and nothing is observed after the final read.
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_A, // HEAD already IS the upstream tip
      onGitPull: () => "Already up to date.",
    });
    const r = await runPanelAction("update", h.deps);
    expect(r.restartRequired).toBe(false);
    expect(r.message).toMatch(/already at the upstream tip/);
    expect(r.message).toMatch(/fast-forwarded nothing and moved nothing itself/);
    expect(r.message).toMatch(/git does not compare ignored files/);
    // The overclaim this replaced.
    expect(r.message).not.toMatch(/Nothing changed on disk/);
  });

  it("#824: a genuinely quiescent window brackets the merge - probed before AND after", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: IDLE_SNAPSHOT,
      upstreamRev: REV_B,
      onGitPull: ({ files, revs }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.35");
        revs[dir] = REV_B;
        return FF;
      },
    });
    const r = await runPanelAction("update", h.deps);
    expect(r.installedVersion).toBe("0.11.35");
    expect(h.gitPulls).toEqual([dir]);
    // Both halves of the bracket ran: the snapshot alone never authorized it.
    expect(h.counters.liveQueueProbes).toBe(2);
  });

  it("#824: the legacy-3.x entry brackets its merge TOO - a stale-3.x verdict is not an idle checkout", async () => {
    // The #724 warrant is about the Manager's VERDICT (it never enqueued the
    // task). That says nothing about whether some OTHER Manager task is
    // writing to this checkout right now, so the same bracket applies.
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: LEGACY_NOOP,
      upstreamRev: REV_B,
      liveQueue: [BUSY],
      onGitPull: ({ files, revs }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.35");
        revs[dir] = REV_B;
        return FF;
      },
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect(String(err?.message ?? err)).toMatch(/re-probed immediately before the merge/);
    expect(h.gitPulls).toEqual([]);
  });

  it("#824: the Manager-ERROR entry brackets its merge TOO (#771 direct path)", async () => {
    // The Manager threw on its own installed-pack list while the pack is on
    // disk. An erroring Manager is no less likely to have a task in flight.
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      upstreamRev: REV_B,
      updateThrows: "ComfyUI-Manager: 'comfyui-mcp-panel' is not installed locally",
      liveQueue: [WORKING],
      onGitPull: ({ files, revs }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.35");
        revs[dir] = REV_B;
        return FF;
      },
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect(String(err?.message ?? err)).toMatch(/re-probed immediately before the merge/);
    expect(h.gitPulls).toEqual([]);
  });

  it("empty queue with pending work (total 0, pending 1) -> fallback REFUSED: not the proven signature", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: { total_count: 0, done_count: 0, in_progress_count: 0, pending_count: 1, is_processing: false },
      onGitPull: () => "merge output",
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect(String(err?.message ?? err)).toMatch(/did NOT apply|empty-queue signature/);
    expect(h.gitPulls).toEqual([]);
  });

  it("partial signature (missing in_progress/is_processing fields) -> fallback REFUSED: unproven, no merge", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      // Only total/done reported — the required in_progress_count and
      // is_processing fields are ABSENT, so pending work is not disproven.
      updateDetails: { total_count: 0, done_count: 0 },
      onGitPull: () => "merge output",
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect(String(err?.message ?? err)).toMatch(/did NOT apply|empty-queue signature/);
    expect(h.gitPulls).toEqual([]);
  });

  it("at-tip via the fallback: the embedded result message credits the git verification, not the no-op'd Manager", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: LEGACY_NOOP,
      // Merge is a no-op (already current): HEAD stays, upstream === HEAD.
      onGitPull: () => "Already up to date.",
    });
    const r = await runPanelAction("update", h.deps);
    expect(r.restartRequired).toBe(false);
    expect(r.message).toMatch(/already at the upstream tip/);
    // The honest message must reach BOTH surfaces (codex gate).
    expect(r.result.message).toBe(r.message);
    expect(r.result.message).not.toMatch(/^updated$/);
  });

  it("malformed reported pending_count (\"1\") -> fallback REFUSED: reported-but-broken is unproven, no merge", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false, pending_count: "1" },
      onGitPull: () => "merge output",
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect(String(err?.message ?? err)).toMatch(/did NOT apply|empty-queue signature/);
    expect(h.gitPulls).toEqual([]);
  });

  it("null pending_count -> fallback REFUSED: malformed, no merge", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false, pending_count: null },
      onGitPull: () => "merge output",
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect(String(err?.message ?? err)).toMatch(/did NOT apply|empty-queue signature/);
    expect(h.gitPulls).toEqual([]);
  });

  it("legacy no-op + real git checkout + pull advances it → updated via the fallback (verified)", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: LEGACY_NOOP,
      // A pinned `merge --ff-only <sha>` lands EXACTLY that sha, so the upstream
      // the gate resolves must be the rev the pull moves HEAD to.
      upstreamRev: REV_B,
      // No onUpdate — the Manager no-ops. The git fallback does the real work.
      onGitPull: ({ files, revs }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.35");
        revs[dir] = REV_B;
        return "Updating d806619..675ace8\nFast-forward";
      },
    });
    const r = await runPanelAction("update", h.deps);
    // The Manager path was tried first, then the fallback ran on the panel dir.
    expect(h.updates).toEqual([{ id: PANEL_REGISTRY_ID }]);
    expect(h.gitPulls).toEqual([dir]);
    expect(r.action).toBe("update");
    expect(r.previousVersion).toBe("0.11.32");
    expect(r.installedVersion).toBe("0.11.35");
    expect(r.restartRequired).toBe(true);
    expect(r.message).toMatch(/git merge --ff-only/);
    expect(r.message).toMatch(/RESTART ComfyUI/);
  });

  it("fallback moves git-HEAD only (nightly, no version bump) → updated", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: LEGACY_NOOP,
      upstreamRev: REV_B,
      onGitPull: ({ revs }) => {
        revs[dir] = REV_B; // commit advanced, version string unchanged
        return "Updating aaaaaaaa..bbbbbbbb\nFast-forward";
      },
    });
    const r = await runPanelAction("update", h.deps);
    expect(h.gitPulls).toEqual([dir]);
    expect(r.installedVersion).toBe("0.11.32");
    expect(r.restartRequired).toBe(true);
    expect(r.message).toMatch(/Panel updated/);
  });

  it("legacy no-op + git pull FAILS → throws truthfully (names BOTH failures), never claims updated", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: LEGACY_NOOP,
      // No onGitPull → the fallback mock throws (no upstream / network down).
    });
    await expect(runPanelAction("update", h.deps)).rejects.toBeInstanceOf(
      PanelInstallError,
    );
    expect(h.updates).toEqual([{ id: PANEL_REGISTRY_ID }]);
    expect(h.gitPulls).toEqual([dir]);
    await expect(runPanelAction("update", h.deps)).rejects.toThrow(
      /did NOT apply|git fallback.*failed|0\.11\.32/,
    );
  });

  it("worktree root ≠ panel dir (copied/stale gitdir) → fallback REFUSED, no pull attempted", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: LEGACY_NOOP,
      gitRoot: join(CUSTOM_NODES, "some-sibling-repo"), // rev-parse resolves elsewhere
      onGitPull: () => "Updating d806619..675ace8\nFast-forward",
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect(String(err?.message ?? err)).toMatch(/worktree root|DIFFERENT checkout|REFUSED/);
    // The Manager was tried, but the fallback never fired a mutation anywhere.
    expect(h.updates).toEqual([{ id: PANEL_REGISTRY_ID }]);
    expect(h.gitPulls).toEqual([]);
  });

  it("worktree root unprovable (rev-parse fails) → fallback REFUSED, no pull attempted", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: LEGACY_NOOP,
      gitRootError: "fatal: not a git repository",
      onGitPull: () => "Updating d806619..675ace8\nFast-forward",
    });
    await expect(runPanelAction("update", h.deps)).rejects.toBeInstanceOf(
      PanelInstallError,
    );
    expect(h.gitPulls).toEqual([]);
  });

  it("locally-AHEAD checkout (HEAD ≠ upstream): NOT 'at tip', throws unverifiable", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.35") },
      revs: { [dir]: REV_A },
      upstreamRev: REV_B, // user committed locally — upstream is behind
      updateDetails: LEGACY_NOOP,
      onGitPull: () => "Already up to date.",
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect(String(err?.message ?? err)).toMatch(/does not match the tracked upstream|UNPROVABLE|committed local work/);
    expect(String(err?.message ?? err)).not.toMatch(/at the upstream tip/);
  });

  it("no upstream configured: currency UNPROVABLE, never 'at tip'", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.35") },
      revs: { [dir]: REV_A },
      noUpstream: true,
      updateDetails: LEGACY_NOOP,
      onGitPull: () => "Already up to date.",
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect(String(err?.message ?? err)).toMatch(/no upstream configured|fetch.resolve the upstream|UNPROVABLE/);
  });

  it("pull ran clean but post-pull HEAD revision is UNREADABLE → throws unverifiable, never 'at tip'", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: LEGACY_NOOP,
      onGitPull: ({ revs }) => {
        delete revs[dir]; // HEAD unreadable afterward — git metadata lost/corrupt
        return "Updating d806619..675ace8\nFast-forward";
      },
    });
    const err = await runPanelAction("update", h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect(String(err?.message ?? err)).toMatch(/unreadable|UNREADABLE|UNVERIFIABLE/);
    expect(String(err?.message ?? err)).not.toMatch(/already at the upstream tip/);
    // #824: the post-merge bracket now answers this case first. Same verdict —
    // never "at tip" — but it must not upgrade "we could not read HEAD" into an
    // accusation that some other writer touched the tree.
    expect(String(err?.message ?? err)).not.toMatch(/Another writer/);
  });

  it("legacy no-op + pull finds nothing newer → honest 'already at tip' (NOT 'updated', no restart)", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.35") },
      revs: { [dir]: REV_A },
      updateDetails: LEGACY_NOOP,
      // git fetched and found HEAD current — nothing changes on disk.
      onGitPull: () => "Already up to date.",
    });
    const r = await runPanelAction("update", h.deps);
    expect(h.gitPulls).toEqual([dir]);
    expect(r.restartRequired).toBe(false);
    expect(r.message).toMatch(/already at the upstream tip/);
    expect(r.message).not.toMatch(/Panel updated/);
    expect(r.installedVersion).toBe("0.11.35");
  });

  it("legacy no-op + NOT a git checkout (registry zip) → fallback NOT attempted, throws the #639 diagnostic", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      // No revs → no .git → a registry-managed install has no fallback path.
      updateDetails: LEGACY_NOOP,
    });
    await expect(runPanelAction("update", h.deps)).rejects.toBeInstanceOf(
      PanelInstallError,
    );
    await expect(runPanelAction("update", h.deps)).rejects.toThrow(
      /did NOT apply|stale ComfyUI-Manager/,
    );
    expect(h.gitPulls).toEqual([]);
  });

  it("dirty worktree → the fallback is REFUSED before any pull (never mutates a dirty checkout)", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: LEGACY_NOOP,
      // A tracked file the fast-forward would NOT overlap — `git pull
      // --ff-only` alone would silently carry it, so the porcelain gate must
      // refuse first regardless of overlap.
      gitStatus: " M web/js/comfyui-mcp-panel.js",
      onGitPull: ({ files, revs }) => {
        // Must NEVER run: the refusal happens before the pull.
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "9.9.9");
        revs[dir] = REV_B;
        return "Updating aaaaaaaa..bbbbbbbb\nFast-forward";
      },
    });
    await expect(runPanelAction("update", h.deps)).rejects.toBeInstanceOf(
      PanelInstallError,
    );
    await expect(runPanelAction("update", h.deps)).rejects.toThrow(
      /UNCOMMITTED|dirty checkout/i,
    );
    // The pull was never attempted and nothing moved on disk.
    expect(h.gitPulls).toEqual([]);
  });

  it("re-detection resolving a DIFFERENT panel dir → the fallback is REFUSED, never pulled there", async () => {
    const ALT = join(CUSTOM_NODES, "comfyui-agent-panel");
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A }, // the git proof belongs to the ORIGINAL dir
      updateDetails: LEGACY_NOOP,
      onUpdate: ({ files }) => {
        // The canonical checkout vanishes mid-op; re-detection lands on a
        // DIFFERENT panel dir the pre-op proof says nothing about.
        delete files[pyPath];
        files[join(ALT, "pyproject.toml")] = pyproject(PANEL_REGISTRY_ID, "0.11.32");
      },
      onGitPull: () => "Updating aaaaaaaa..bbbbbbbb\nFast-forward", // must never run
    });
    await expect(runPanelAction("update", h.deps)).rejects.toThrow(
      /not the checkout|REFUSED/i,
    );
    expect(h.gitPulls).toEqual([]);
  });

  it("a dir flip appearing AFTER the fallback's pull → verification refuses (never claims the wrong checkout)", async () => {
    const ALT = join(CUSTOM_NODES, "comfyui-agent-panel");
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: LEGACY_NOOP,
      onGitPull: ({ files, revs }) => {
        // The pull ran on the bound dir, but by verification time re-detection
        // resolves a DIFFERENT dir — the before/after comparison would span
        // two repos, so even a moved version must not be claimed.
        revs[dir] = REV_B;
        delete files[pyPath];
        files[join(ALT, "pyproject.toml")] = pyproject(PANEL_REGISTRY_ID, "0.11.35");
        return "Updating aaaaaaaa..bbbbbbbb\nFast-forward";
      },
    });
    await expect(runPanelAction("update", h.deps)).rejects.toThrow(
      /DIFFERENT panel dir|NOT reporting success/i,
    );
    // The pull happened on the BOUND dir; the refusal is at verification.
    expect(h.gitPulls).toEqual([dir]);
  });

  it("a shadow left behind by the fallback's pull STILL fails closed (#641)", async () => {
    const bak = ".comfyui-agent-panel.bak-0.11.28";
    const dirs: string[] = [];
    const h = makeDeps({
      comfyuiPath: COMFY,
      dirs,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: LEGACY_NOOP,
      upstreamRev: REV_B,
      onGitPull: ({ files, revs }) => {
        // The pull advances the checkout but leaves a backup dir under
        // custom_nodes that would shadow the real panel in the browser.
        revs[dir] = REV_B;
        dirs.push(bak);
        files[join(CUSTOM_NODES, bak, "pyproject.toml")] = pyproject(
          PANEL_REGISTRY_ID,
          "0.11.28",
        );
        return "Updating aaaaaaaa..bbbbbbbb\nFast-forward";
      },
    });
    await expect(runPanelAction("update", h.deps)).rejects.toThrow(/shadow/i);
    expect(h.gitPulls).toEqual([dir]);
  });

  it("a WORKING Manager (coherent counts, version moves) never touches the fallback", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
      revs: { [dir]: REV_A },
      updateDetails: { total_count: 1, done_count: 1, is_processing: false },
      onUpdate: ({ files, revs }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.35");
        revs[dir] = REV_B;
      },
    });
    const r = await runPanelAction("update", h.deps);
    expect(r.installedVersion).toBe("0.11.35");
    expect(r.restartRequired).toBe(true);
    expect(h.gitPulls).toEqual([]);
  });
});

describe("runPanelAction shadow detection (#641)", () => {
  const realDir = join(CUSTOM_NODES, "comfyui-mcp-panel");
  const bakName = ".comfyui-agent-panel.bak-0.11.28";
  const bakDir = join(CUSTOM_NODES, bakName);

  it("update: a .bak shadow present → throws shadow diagnostic even if version moved", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      dirs: [bakName],
      files: {
        [join(realDir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.28"),
        [join(bakDir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.28"),
      },
      updateDetails: { total_count: 1, done_count: 1, is_processing: false },
      // Real dir DOES advance on disk — but the shadow can still win in the browser.
      onUpdate: ({ files }) => {
        files[join(realDir, "pyproject.toml")] = pyproject(PANEL_REGISTRY_ID, "0.11.32");
      },
    });
    await expect(runPanelAction("update", h.deps)).rejects.toThrow(/shadow/i);
    await expect(runPanelAction("update", h.deps)).rejects.toThrow(bakName);
  });

  it("#641: update advances the canonical version but a SERVED shadow (content, no pyproject) exists → NOT success", async () => {
    const bak = ".comfyui-agent-panel-0.11.28.bak";
    const h = makeDeps({
      comfyuiPath: COMFY,
      dirs: [bak],
      files: {
        [join(realDir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.28"),
        // Served shadow: web asset present, NO pyproject.
        [join(CUSTOM_NODES, bak, "web", "js", "comfyui-mcp-panel.js")]: "// old panel",
      },
      updateDetails: { total_count: 1, done_count: 1, is_processing: false },
      // The real dir genuinely advances on disk...
      onUpdate: ({ files }) => {
        files[join(realDir, "pyproject.toml")] = pyproject(PANEL_REGISTRY_ID, "0.11.32");
      },
    });
    // ...but the served shadow means the browser may still load the old copy.
    await expect(runPanelAction("update", h.deps)).rejects.toThrow(/shadow/i);
  });

  it("update: shadow removed → success", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [join(realDir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.28") },
      updateDetails: { total_count: 1, done_count: 1, is_processing: false },
      onUpdate: ({ files }) => {
        files[join(realDir, "pyproject.toml")] = pyproject(PANEL_REGISTRY_ID, "0.11.32");
      },
    });
    const r = await runPanelAction("update", h.deps);
    expect(r.installedVersion).toBe("0.11.32");
    expect(r.message).toMatch(/updated/i);
  });

  it("install: a shadow present → throws shadow diagnostic, not success", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      dirs: [bakName],
      files: { [join(bakDir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.28") },
      onInstall: ({ files }) => {
        files[join(realDir, "pyproject.toml")] = pyproject(PANEL_REGISTRY_ID, "0.11.32");
      },
    });
    await expect(runPanelAction("install", h.deps)).rejects.toThrow(/shadow/i);
  });

  it("update: a LONE .bak (no real dir) is not mistaken for canonical → still flagged", async () => {
    // Only the backup exists. detectPanelInstall must NOT resolve it as the
    // install, and the shadow check must still fire.
    const h = makeDeps({
      comfyuiPath: COMFY,
      dirs: [bakName],
      files: { [join(bakDir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.28") },
      updateDetails: { total_count: 1, done_count: 1, is_processing: false },
    });
    await expect(runPanelAction("update", h.deps)).rejects.toThrow(/shadow/i);
  });

  it("update: fails closed when custom_nodes cannot be enumerated (indeterminate)", async () => {
    const h = makeDeps({
      comfyuiPath: COMFY,
      files: { [join(realDir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.28") },
      updateDetails: { total_count: 1, done_count: 1, is_processing: false },
      onUpdate: ({ files }) => {
        files[join(realDir, "pyproject.toml")] = pyproject(PANEL_REGISTRY_ID, "0.11.32");
      },
    });
    // ACL that denies directory enumeration but allows direct path access.
    h.deps.readdir = () => {
      throw new Error("EACCES: permission denied, scandir");
    };
    await expect(runPanelAction("update", h.deps)).rejects.toThrow(
      /cannot be confirmed|inspect custom_nodes/i,
    );
  });
});

describe("findPanelShadows (#641)", () => {
  const realDir = join(CUSTOM_NODES, "comfyui-mcp-panel");

  it("flags a dot-prefixed .bak panel copy (pyproject name match)", () => {
    const bak = ".comfyui-agent-panel.bak-0.11.28";
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: [bak],
      files: {
        [join(CUSTOM_NODES, bak, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.28"),
      },
    });
    const s = findPanelShadows(realDir, deps);
    expect(s.map((x) => x.name)).toContain(bak);
    expect(s[0].version).toBe("0.11.28");
  });

  it("flags a web-only backup by dir name even without a panel pyproject", () => {
    const bak = ".comfyui-mcp-panel.bak";
    const { deps } = makeDeps({ comfyuiPath: COMFY, dirs: [bak] });
    expect(findPanelShadows(realDir, deps).map((x) => x.name)).toContain(bak);
  });

  it("flags an editor '~' backup dir (web-only, no pyproject)", () => {
    const bak = ".comfyui-agent-panel~";
    const { deps } = makeDeps({ comfyuiPath: COMFY, dirs: [bak] });
    expect(findPanelShadows(realDir, deps).map((x) => x.name)).toContain(bak);
  });

  it("#641(a): flags '.comfyui-agent-panel-0.11.28.bak' (marker LAST) with web assets, no pyproject", () => {
    // The .bak marker is at the END of the remainder (rest = "-0.11.28.bak"),
    // and there is no pyproject — both the broadened name heuristic and the
    // CONTENT signal must catch it.
    const bak = ".comfyui-agent-panel-0.11.28.bak";
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: [bak],
      files: {
        // The served web asset — the CONTENT signal.
        [join(CUSTOM_NODES, bak, "web", "js", "comfyui-mcp-panel.js")]: "// panel",
      },
    });
    expect(findPanelShadows(realDir, deps).map((x) => x.name)).toContain(bak);
  });

  it("#641(b): a served copy with UNREADABLE pyproject fails CLOSED (flagged, not omitted)", () => {
    // Name is neither canonical nor backup-shaped, so ONLY the content signal +
    // fail-closed behavior can catch it. pyproject exists but read throws.
    const stray = "panel-restore-dir";
    const pyPath = join(CUSTOM_NODES, stray, "pyproject.toml");
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: [stray],
      files: {
        [join(CUSTOM_NODES, stray, "web", "js", "comfyui-mcp-panel.js")]: "// panel",
        [pyPath]: "corrupt",
      },
    });
    deps.readFile = (p) => {
      if (p === pyPath) throw new Error("EIO: pyproject unreadable");
      return "";
    };
    const s = findPanelShadows(realDir, deps);
    expect(s.map((x) => x.name)).toContain(stray);
    // Identity couldn't be verified → version undefined (a POSSIBLE shadow).
    expect(s.find((x) => x.name === stray)?.version).toBeUndefined();
  });

  it("#641(c): canonical-only (no other served copy) → no shadow", () => {
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: ["comfyui-mcp-panel"],
      files: {
        [join(realDir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.32"),
        [join(realDir, "web", "js", "comfyui-mcp-panel.js")]: "// panel",
      },
    });
    expect(findPanelShadows(realDir, deps)).toEqual([]);
  });

  it("flags a NON-backup-named dir purely by served web content", () => {
    const stray = "my-vendored-panel";
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: [stray],
      files: {
        [join(CUSTOM_NODES, stray, "web", "img", "comfyui-mcp-wordmark.svg")]: "<svg/>",
      },
    });
    expect(findPanelShadows(realDir, deps).map((x) => x.name)).toContain(stray);
  });

  it("FAILS CLOSED when a content probe is INDETERMINATE (probeFile undefined)", () => {
    const stray = "opaque-dir";
    const marker = join(CUSTOM_NODES, stray, "web", "js", "comfyui-mcp-panel.js");
    const { deps } = makeDeps({ comfyuiPath: COMFY, dirs: [stray] });
    // Marker probe can't confirm absence (EACCES) → undefined, not false.
    deps.probeFile = (p) => (p === marker ? undefined : false);
    expect(findPanelShadows(realDir, deps).map((x) => x.name)).toContain(stray);
  });

  it("does NOT treat a DIRECTORY named like the asset as a served copy", () => {
    // A dir 'comfyui-mcp-panel.js' (not a file) must NOT count as a served asset.
    const stray = "unrelated-node";
    const markerAsDir = join(CUSTOM_NODES, stray, "web", "js", "comfyui-mcp-panel.js");
    const { deps } = makeDeps({ comfyuiPath: COMFY, dirs: [stray] });
    deps.probeFile = (p) => (p === markerAsDir ? false : false); // exists but a dir → false
    expect(findPanelShadows(realDir, deps)).toEqual([]);
  });

  it("exempts a backup-NAMED symlink alias that resolves to the canonical dir", () => {
    // ".comfyui-agent-panel.bak" is a junction -> the canonical dir; realpath
    // proves same physical dir → serves the SAME assets → NOT a shadow.
    const alias = ".comfyui-agent-panel.bak";
    const canonical = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const real = "/real/fs/comfyui-mcp-panel";
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: [alias],
      files: {
        [join(canonical, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.32"),
      },
      realPaths: {
        [canonical]: real,
        [join(CUSTOM_NODES, alias)]: real, // alias resolves to canonical
      },
    });
    expect(findPanelShadows(canonical, deps)).toEqual([]);
  });

  it("does NOT block on a regular FILE that merely shares a backup name", () => {
    const bak = ".comfyui-agent-panel.bak-0.11.28";
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: [bak],
      nonDirEntries: [bak], // it's a FILE, not a served extension dir
    });
    expect(findPanelShadows(realDir, deps)).toEqual([]);
  });

  it("FAILS CLOSED when directory classification is INDETERMINATE (stat error)", () => {
    const bak = ".comfyui-agent-panel.bak-0.11.28";
    const bakDir = join(CUSTOM_NODES, bak);
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: [bak],
      files: { [join(bakDir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.28") },
    });
    // Transient stat failure → undefined (can't confirm it's a file) → must NOT skip.
    deps.isDirectory = (p) => (p === bakDir ? undefined : true);
    expect(findPanelShadows(realDir, deps).map((x) => x.name)).toContain(bak);
  });

  it("flags a distinct case-variant serving copy when NO canonical is resolved", () => {
    // canonicalDir undefined + a case-variant dir serving panel content: it must
    // be content-checked (flagged), not exempted by a case-insensitive name.
    const variant = "ComfyUI-MCP-Panel";
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: [variant],
      files: {
        [join(CUSTOM_NODES, variant, "web", "js", "comfyui-mcp-panel.js")]: "// panel",
      },
    });
    expect(findPanelShadows(undefined, deps).map((x) => x.name)).toContain(variant);
  });

  it("still exempts the EXACT canonical name when no canonical is resolved", () => {
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: ["comfyui-mcp-panel"],
      files: {
        [join(realDir, "web", "js", "comfyui-mcp-panel.js")]: "// panel",
      },
    });
    expect(findPanelShadows(undefined, deps)).toEqual([]);
  });

  it("does NOT flag an unrelated custom node", () => {
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: ["some-other-node"],
      files: {
        [join(CUSTOM_NODES, "some-other-node", "pyproject.toml")]: pyproject("other-pack"),
      },
    });
    expect(findPanelShadows(realDir, deps)).toEqual([]);
  });

  it("does NOT false-flag an unrelated panel-adjacent node (comfyui-agent-panel-tools)", () => {
    const tools = "comfyui-agent-panel-tools";
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: [tools],
      files: {
        [join(CUSTOM_NODES, tools, "pyproject.toml")]: pyproject(tools, "1.0.0"),
      },
    });
    expect(findPanelShadows(realDir, deps)).toEqual([]);
  });

  it("does NOT false-flag a HIDDEN unrelated node (.comfyui-agent-panel-tools)", () => {
    const tools = ".comfyui-agent-panel-tools";
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: [tools],
      files: {
        [join(CUSTOM_NODES, tools, "pyproject.toml")]: pyproject(
          "comfyui-agent-panel-tools",
          "1.0.0",
        ),
      },
    });
    expect(findPanelShadows(realDir, deps)).toEqual([]);
  });

  it("does NOT flag the canonical dir itself", () => {
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: ["comfyui-mcp-panel"],
      files: { [join(realDir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
    });
    expect(findPanelShadows(realDir, deps)).toEqual([]);
  });

  it("FAILS CLOSED (flags) a distinct-case dir when realpath is unavailable", () => {
    // Without physical identity we cannot prove "ComfyUI-MCP-Panel" is the same
    // dir as the canonical, so we must NOT case-fold it away — flag it.
    const preserved = "ComfyUI-MCP-Panel";
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: [preserved],
      files: {
        [join(realDir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.32"),
        [join(CUSTOM_NODES, preserved, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.28"),
      },
      // No realPaths → realPath() returns undefined → fail closed.
    });
    expect(findPanelShadows(realDir, deps).map((x) => x.name)).toContain(preserved);
  });

  it("exempts a preserved-case canonical dir by PHYSICAL identity (same realpath)", () => {
    const preserved = "ComfyUI-MCP-Panel";
    const canonical = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const real = "/real/fs/comfyui-mcp-panel";
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: [preserved],
      files: {
        [join(canonical, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.32"),
        [join(CUSTOM_NODES, preserved, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.32"),
      },
      // Both names resolve to the SAME physical dir (case-insensitive volume).
      realPaths: {
        [canonical]: real,
        [join(CUSTOM_NODES, preserved)]: real,
      },
    });
    expect(findPanelShadows(canonical, deps)).toEqual([]);
  });

  it("FLAGS a distinct-case coexisting dir (different realpath, case-sensitive volume)", () => {
    const other = "ComfyUI-MCP-Panel";
    const canonical = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: [other],
      files: {
        [join(canonical, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.32"),
        [join(CUSTOM_NODES, other, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.28"),
      },
      // Distinct physical dirs — must NOT be exempted.
      realPaths: {
        [canonical]: "/real/fs/comfyui-mcp-panel",
        [join(CUSTOM_NODES, other)]: "/real/fs/ComfyUI-MCP-Panel",
      },
    });
    expect(findPanelShadows(canonical, deps).map((x) => x.name)).toContain(other);
  });

  it("throws (indeterminate) when custom_nodes cannot be enumerated", () => {
    const { deps } = makeDeps({ comfyuiPath: COMFY });
    deps.readdir = () => {
      throw new Error("EACCES");
    };
    expect(() => findPanelShadows(realDir, deps)).toThrow(/EACCES/);
  });

  it("returns [] in remote/cloud mode", () => {
    const { deps } = makeDeps({ comfyuiPath: COMFY, local: false });
    expect(findPanelShadows(undefined, deps)).toEqual([]);
  });
});

describe("looksLikePanelBackupName (#641)", () => {
  it("flags dot-prefixed and backup-token panel copies", () => {
    expect(looksLikePanelBackupName(".comfyui-agent-panel.bak-0.11.28")).toBe(true);
    expect(looksLikePanelBackupName(".comfyui-mcp-panel")).toBe(true);
    expect(looksLikePanelBackupName("comfyui-agent-panel.bak")).toBe(true);
    expect(looksLikePanelBackupName("comfyui-mcp-panel-backup")).toBe(true);
    expect(looksLikePanelBackupName("comfyui-agent-panel.old")).toBe(true);
    expect(looksLikePanelBackupName("comfyui-agent-panel-copy")).toBe(true);
    expect(looksLikePanelBackupName(".comfyui-agent-panel~")).toBe(true);
    expect(looksLikePanelBackupName("comfyui-mcp-panel~")).toBe(true);
    // Marker LAST (version between the name and the .bak token).
    expect(looksLikePanelBackupName(".comfyui-agent-panel-0.11.28.bak")).toBe(true);
    expect(looksLikePanelBackupName("comfyui-mcp-panel-2026.old")).toBe(true);
  });

  it("does NOT flag a same-prefixed but non-backup sibling ('-holder' contains 'old')", () => {
    // 'old' appears as a substring of 'holder' but not as a boundary token.
    expect(looksLikePanelBackupName("comfyui-agent-panel-holder")).toBe(false);
    expect(looksLikePanelBackupName(".comfyui-agent-panel-holder")).toBe(false);
  });

  it("does NOT flag a backup of an unrelated SIBLING node", () => {
    // These are backups of "comfyui-agent-panel-tools"/"...-holder", NOT the panel.
    expect(looksLikePanelBackupName("comfyui-agent-panel-tools-old")).toBe(false);
    expect(looksLikePanelBackupName("comfyui-agent-panel-holder-backup")).toBe(false);
    expect(looksLikePanelBackupName(".comfyui-agent-panel-tools~")).toBe(false);
    expect(looksLikePanelBackupName("comfyui-agent-panel-tools.bak")).toBe(false);
  });

  it("ALLOWS descriptive text AFTER the first backup marker", () => {
    expect(looksLikePanelBackupName("comfyui-agent-panel-backup-2026-final")).toBe(true);
    expect(looksLikePanelBackupName(".comfyui-agent-panel~snapshot")).toBe(true);
    expect(looksLikePanelBackupName("comfyui-mcp-panel.bak.final")).toBe(true);
  });

  it("does NOT flag the canonical names or unrelated extensions", () => {
    expect(looksLikePanelBackupName("comfyui-mcp-panel")).toBe(false);
    expect(looksLikePanelBackupName("comfyui-agent-panel")).toBe(false);
    expect(looksLikePanelBackupName("comfyui-agent-panel-tools")).toBe(false);
    // A HIDDEN unrelated panel-adjacent node must NOT be flagged by name alone.
    expect(looksLikePanelBackupName(".comfyui-agent-panel-tools")).toBe(false);
    expect(looksLikePanelBackupName("some-unrelated-node")).toBe(false);
  });

  it("flags a HIDDEN exact-name copy but not the plain canonical name", () => {
    expect(looksLikePanelBackupName(".comfyui-agent-panel")).toBe(true);
    expect(looksLikePanelBackupName(".comfyui-mcp-panel")).toBe(true);
    expect(looksLikePanelBackupName("comfyui-agent-panel")).toBe(false);
  });
});

describe("panel version pin — the mutation choke point", () => {
  const PINNED: PanelPinState = { pinned: true, version: "0.11.3", source: "settings" };

  function pinnedInstall(pin: PanelPinState = PINNED) {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    return makeDeps({
      comfyuiPath: COMFY,
      dirs: ["comfyui-mcp-panel"],
      files: { [join(dir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.3") },
      pin,
    });
  }

  it.each(["install", "update", "reinstall"] as const)(
    "%s refuses while a pin is in force, and queues NOTHING",
    async (action) => {
      const h = pinnedInstall();
      await expect(runPanelAction(action, h.deps)).rejects.toThrow(PanelInstallError);
      await expect(runPanelAction(action, h.deps)).rejects.toThrow(/pinned to 0\.11\.3/i);
      // The guard runs BEFORE the ComfyUI-Manager call, so nothing was queued.
      expect(h.installs).toEqual([]);
      expect(h.updates).toEqual([]);
      expect(h.reinstalls).toEqual([]);
    },
  );

  it("an env pin refusal explains that unpin alone will not clear it", async () => {
    const h = pinnedInstall({ pinned: true, version: "0.11.3", source: "env" });
    await expect(runPanelAction("update", h.deps)).rejects.toThrow(
      /COMFYUI_MCP_PANEL_PIN/,
    );
  });

  it("an INDETERMINATE pin still refuses (unreadable is not unpinned)", async () => {
    const h = pinnedInstall({ pinned: true, source: "settings", indeterminate: true });
    await expect(runPanelAction("update", h.deps)).rejects.toThrow(PanelInstallError);
    expect(h.updates).toEqual([]);
  });

  it("a readPin that THROWS is treated as pinned, not as unpinned", async () => {
    const h = pinnedInstall();
    const deps: PanelInstallerDeps = {
      ...h.deps,
      readPin: () => {
        throw new Error("settings unreadable");
      },
    };
    await expect(runPanelAction("update", deps)).rejects.toThrow(PanelInstallError);
    expect(h.updates).toEqual([]);
  });

  it("the on-load auto-install SKIPS while pinned instead of installing nightly", async () => {
    const { deps, installs } = makeDeps({
      comfyuiPath: COMFY,
      dirs: [],
      pin: PINNED,
    });
    const r = await ensurePanelInstalled({ deps });
    expect(r.action).toBe("skipped");
    expect(r.reason).toMatch(/pin/i);
    expect(installs).toEqual([]);
  });

  it("once the pin is cleared the very same update proceeds and verifies", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const pyPath = join(dir, "pyproject.toml");
    const { deps, updates } = makeDeps({
      comfyuiPath: COMFY,
      dirs: ["comfyui-mcp-panel"],
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.3") },
      // pin omitted → unpinned
      onUpdate: ({ files }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.30");
      },
    });
    const r = await runPanelAction("update", deps);
    expect(updates).toHaveLength(1);
    expect(r.previousVersion).toBe("0.11.3");
    expect(r.installedVersion).toBe("0.11.30");
  });

  it("panelStatus reports the pin and says how to clear it", async () => {
    const h = pinnedInstall();
    const s = await panelStatus(h.deps);
    expect(s.pin).toMatchObject({ pinned: true, version: "0.11.3" });
    expect(s.note).toMatch(/unpin/i);
  });

  it("honours an explicit target version instead of substituting nightly", async () => {
    // A generic call that asked for a specific version is redirected here to get
    // the verified path; substituting `nightly` would do something other than
    // what the caller asked while still reporting success.
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const pyPath = join(dir, "pyproject.toml");
    const { deps, reinstalls } = makeDeps({
      comfyuiPath: COMFY,
      dirs: ["comfyui-mcp-panel"],
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.3") },
      onReinstall: ({ files }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.20");
      },
    });
    const r = await runPanelAction("reinstall", deps, { version: "0.11.20" });
    expect(reinstalls).toEqual([{ id: PANEL_REGISTRY_ID, version: "0.11.20" }]);
    expect(r.installedVersion).toBe("0.11.20");
  });

  it("defaults to the nightly channel when no version is requested", async () => {
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const pyPath = join(dir, "pyproject.toml");
    const { deps, reinstalls } = makeDeps({
      comfyuiPath: COMFY,
      dirs: ["comfyui-mcp-panel"],
      files: { [pyPath]: pyproject(PANEL_REGISTRY_ID, "0.11.3") },
      onReinstall: ({ files }) => {
        files[pyPath] = pyproject(PANEL_REGISTRY_ID, "0.11.31");
      },
    });
    await runPanelAction("reinstall", deps);
    expect(reinstalls).toEqual([{ id: PANEL_REGISTRY_ID, version: PANEL_VERSION }]);
  });

  it("panelStatus flags a FAILED shadow scan structurally, not just in the note", async () => {
    // `shadows: []` from a scan that could not run means "we didn't find any",
    // not "there are none". A consumer branching on shadows.length would read
    // the empty array as an all-clear, so the uncertainty must be a field.
    const dir = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: ["comfyui-mcp-panel"],
      files: { [join(dir, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.3") },
    });
    // Detection uses the fast path (direct pyproject read), so the panel still
    // resolves; only the shadow enumeration fails.
    const failing: PanelInstallerDeps = {
      ...deps,
      readdir: () => {
        throw new Error("EACCES: permission denied, scandir");
      },
    };
    const s = await panelStatus(failing);
    expect(s.installed).toBe(true);
    expect(s.shadows).toEqual([]);
    expect(s.shadowInspectFailed).toBe(true);
    expect(s.note).toMatch(/could not enumerate/i);
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

  it("#641: reports a shadow copy in the note and shadows[] (never throws)", async () => {
    const real = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const bak = ".comfyui-agent-panel.bak-0.11.28";
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      dirs: [bak],
      files: {
        [join(real, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.32"),
        [join(CUSTOM_NODES, bak, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.28"),
      },
    });
    const s = await panelStatus(deps);
    expect(s.installed).toBe(true);
    expect(s.installedVersion).toBe("0.11.32");
    expect(s.shadows.map((x) => x.name)).toContain(bak);
    expect(s.note).toMatch(/shadow/i);
  });

  it("has an empty shadows[] when there is no backup dir", async () => {
    const real = join(CUSTOM_NODES, "comfyui-mcp-panel");
    const { deps } = makeDeps({
      comfyuiPath: COMFY,
      files: { [join(real, "pyproject.toml")]: pyproject(PANEL_REGISTRY_ID, "0.11.32") },
    });
    const s = await panelStatus(deps);
    expect(s.shadows).toEqual([]);
  });
});

describe("classifyPanelUpdate (#639 verification core)", () => {
  const coherent = {
    total_count: 1,
    done_count: 1,
    in_progress_count: 0,
    pending_count: 0,
    is_processing: false,
  };
  // The stale 3.x no-op the issue reported verbatim.
  const noOpCounts = {
    total_count: 0,
    done_count: 2,
    in_progress_count: 0,
    pending_count: 0,
    is_processing: false,
  };

  it("version moved → updated", () => {
    expect(
      classifyPanelUpdate(
        { previousVersion: "0.11.28", installedVersion: "0.11.32" },
        coherent,
      ).outcome,
    ).toBe("updated");
  });

  it("git-HEAD moved (version unchanged) → updated", () => {
    expect(
      classifyPanelUpdate(
        {
          previousVersion: "0.11.32",
          installedVersion: "0.11.32",
          previousRev: "aaaa",
          installedRev: "bbbb",
        },
        coherent,
      ).outcome,
    ).toBe("updated");
  });

  it("version unchanged + no-op counts (total 0 / done 2), no git → no-op", () => {
    expect(
      classifyPanelUpdate(
        { previousVersion: "0.11.28", installedVersion: "0.11.28" },
        noOpCounts,
      ).outcome,
    ).toBe("no-op");
  });

  it("version unchanged + done > total incoherence, no git → no-op", () => {
    expect(
      classifyPanelUpdate(
        { previousVersion: "1.0.0", installedVersion: "1.0.0" },
        { total_count: 1, done_count: 5 },
      ).outcome,
    ).toBe("no-op");
  });

  it("identical git-HEAD + no-op counts → no-op (unchanged HEAD is NOT proof of currency)", () => {
    expect(
      classifyPanelUpdate(
        {
          previousVersion: "0.11.28",
          installedVersion: "0.11.28",
          previousRev: "cccc",
          installedRev: "cccc",
        },
        noOpCounts,
      ).outcome,
    ).toBe("no-op");
  });

  it("identical git-HEAD + coherent counts → unverified (never 'already-current')", () => {
    expect(
      classifyPanelUpdate(
        {
          previousVersion: "0.11.32",
          installedVersion: "0.11.32",
          previousRev: "cccc",
          installedRev: "cccc",
        },
        coherent,
      ).outcome,
    ).toBe("unverified");
  });

  it("version unchanged + coherent counts but NO git identity → unverified (not success)", () => {
    expect(
      classifyPanelUpdate(
        { previousVersion: "0.11.32", installedVersion: "0.11.32" },
        coherent,
      ).outcome,
    ).toBe("unverified");
  });

  it("no post-update identity at all → unverified", () => {
    expect(
      classifyPanelUpdate({ previousVersion: "1.0.0" }, coherent).outcome,
    ).toBe("unverified");
  });

  it("no pre-update baseline → unverified (can't prove a move)", () => {
    expect(
      classifyPanelUpdate({ installedVersion: "1.0.0" }, coherent).outcome,
    ).toBe("unverified");
  });

  it("version unchanged + no queue evidence + no git → unverified (not success)", () => {
    expect(
      classifyPanelUpdate(
        { previousVersion: "1.0.0", installedVersion: "1.0.0" },
        undefined,
      ).outcome,
    ).toBe("unverified");
    expect(
      classifyPanelUpdate(
        { previousVersion: "1.0.0", installedVersion: "1.0.0" },
        "cm-cli text output",
      ).outcome,
    ).toBe("unverified");
  });

  it("looksLikeManagerNoOp flags total 0 and done>total, not coherent work", () => {
    expect(looksLikeManagerNoOp({ total_count: 0, done_count: 2 })).toBe(true);
    expect(looksLikeManagerNoOp({ total_count: 1, done_count: 5 })).toBe(true);
    expect(looksLikeManagerNoOp({ total_count: 1, done_count: 1 })).toBe(false);
    expect(looksLikeManagerNoOp({ total_count: 2, done_count: 2 })).toBe(false);
    expect(looksLikeManagerNoOp(undefined)).toBe(false); // no counts → not a proven no-op
    expect(looksLikeManagerNoOp("cm-cli text")).toBe(false);
  });

  it("isProvenQuiescentQueue requires all three LIVE indicators reported clear (#824)", () => {
    // The #824 signature: historical counters contradict (done > total) but
    // every live indicator is present and clear → provably idle.
    expect(
      isProvenQuiescentQueue({
        total_count: 0,
        done_count: 1,
        pending_count: 0,
        in_progress_count: 0,
        is_processing: false,
      }),
    ).toBe(true);
    // Live work reported → not quiescent.
    expect(
      isProvenQuiescentQueue({ pending_count: 1, in_progress_count: 0, is_processing: false }),
    ).toBe(false);
    expect(
      isProvenQuiescentQueue({ pending_count: 0, in_progress_count: 1, is_processing: false }),
    ).toBe(false);
    expect(
      isProvenQuiescentQueue({ pending_count: 0, in_progress_count: 0, is_processing: true }),
    ).toBe(false);
    // A missing/malformed live field is UNPROVEN, never a default-safe zero.
    expect(isProvenQuiescentQueue({ pending_count: 0, in_progress_count: 0 })).toBe(false);
    expect(isProvenQuiescentQueue({ total_count: 0, done_count: 0 })).toBe(false);
    expect(
      isProvenQuiescentQueue({ pending_count: "0", in_progress_count: 0, is_processing: false }),
    ).toBe(false);
    expect(isProvenQuiescentQueue(undefined)).toBe(false);
    expect(isProvenQuiescentQueue("cm-cli text")).toBe(false);
  });

  it("readQueueCounts ignores non-object details", () => {
    expect(readQueueCounts(undefined)).toEqual({});
    expect(readQueueCounts("string")).toEqual({});
    expect(readQueueCounts({ total_count: 3, done_count: 3 })).toMatchObject({
      total: 3,
      done: 3,
    });
  });
});

describe("resolveGitRevision (real fs)", () => {
  const roots: string[] = [];
  function newRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "panel-git-"));
    roots.push(root);
    mkdirSync(join(root, ".git"), { recursive: true });
    return root;
  }
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  const SHA = "0123456789abcdef0123456789abcdef01234567";

  it("resolves a symbolic HEAD via a loose ref", () => {
    const root = newRepo();
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(root, ".git", "refs", "heads", "main"), `${SHA}\n`);
    expect(resolveGitRevision(root)).toBe(SHA);
  });

  it("resolves a symbolic HEAD via packed-refs when no loose ref exists", () => {
    const root = newRepo();
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/nightly\n");
    writeFileSync(
      join(root, ".git", "packed-refs"),
      `# pack-refs with: peeled fully-peeled sorted\n${SHA} refs/heads/nightly\n`,
    );
    expect(resolveGitRevision(root)).toBe(SHA);
  });

  it("resolves a detached HEAD (inline sha)", () => {
    const root = newRepo();
    writeFileSync(join(root, ".git", "HEAD"), `${SHA}\n`);
    expect(resolveGitRevision(root)).toBe(SHA);
  });

  it("resolves a SHA-256 (64-char) object id", () => {
    const sha256 = "a".repeat(64);
    const root = newRepo();
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(root, ".git", "refs", "heads", "main"), `${sha256}\n`);
    expect(resolveGitRevision(root)).toBe(sha256);
  });

  it("follows a .git FILE pointer (worktree/submodule layout)", () => {
    const root = newRepo();
    // Real git dir lives elsewhere; .git is a file pointing at it.
    const realGit = mkdtempSync(join(tmpdir(), "panel-gitdir-"));
    roots.push(realGit);
    writeFileSync(join(realGit, "HEAD"), `${SHA}\n`);
    // Overwrite .git as a FILE pointer (rm the dir first).
    rmSync(join(root, ".git"), { recursive: true, force: true });
    writeFileSync(join(root, ".git"), `gitdir: ${realGit}\n`);
    expect(resolveGitRevision(root)).toBe(SHA);
  });

  it("resolves a linked worktree ref via commondir (shared refs)", () => {
    const root = newRepo();
    // Per-worktree gitdir holds HEAD + commondir; shared refs live in commondir.
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    const common = mkdtempSync(join(tmpdir(), "panel-common-"));
    roots.push(common);
    writeFileSync(join(root, ".git", "commondir"), `${common}\n`);
    mkdirSync(join(common, "refs", "heads"), { recursive: true });
    writeFileSync(join(common, "refs", "heads", "main"), `${SHA}\n`);
    expect(resolveGitRevision(root)).toBe(SHA);
  });

  it("returns undefined for a non-git dir (never throws)", () => {
    const root = mkdtempSync(join(tmpdir(), "panel-nogit-"));
    roots.push(root);
    expect(resolveGitRevision(root)).toBeUndefined();
  });

  it("returns undefined for a NON-sha loose ref (transient/corrupt), never a fake sha", () => {
    const root = newRepo();
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    // Transient garbage / symbolic content — must NOT be treated as a commit sha.
    writeFileSync(join(root, ".git", "refs", "heads", "main"), "ref: refs/heads/other\n");
    expect(resolveGitRevision(root)).toBeUndefined();
  });

  it("returns undefined for a detached HEAD that isn't a sha", () => {
    const root = newRepo();
    writeFileSync(join(root, ".git", "HEAD"), "updating\n");
    expect(resolveGitRevision(root)).toBeUndefined();
  });

  it("rejects an ABBREVIATED (truncated) hex id — only full 40/64 accepted", () => {
    const root = newRepo();
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(root, ".git", "refs", "heads", "main"), "deadbee\n"); // 7 hex
    expect(resolveGitRevision(root)).toBeUndefined();
  });
});

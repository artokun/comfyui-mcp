import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  checkAndSelfUpdate,
  compareSemver,
  detectInstallMode,
  isNewer,
  runSelfUpdate,
  selfUpdateStatus,
  SelfUpdateError,
  PACKAGE_NAME,
  type SelfUpdateDeps,
} from "../../services/self-update.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  deps: SelfUpdateDeps;
  npmCalls: Array<{ args: string[]; cwd?: string }>;
}

function pkgJson(version: string): string {
  return JSON.stringify({ name: PACKAGE_NAME, version });
}

function makeDeps(opts: {
  packageDir: string;
  currentVersion?: string; // written into <packageDir>/package.json
  latest?: string | undefined; // registry latest; undefined → offline
  symlink?: boolean; // packageDir is a raw symlink
  realpath?: string; // override realpath(packageDir)
  realpathFails?: boolean; // realpath() returns undefined (resolution failed)
  env?: NodeJS.ProcessEnv;
  existing?: string[]; // extra paths that exist (e.g. project package.json)
  npmOk?: boolean; // result of runNpm
  registryThrows?: boolean;
}): Harness {
  const realDir = opts.realpath ?? opts.packageDir;
  const files: Record<string, string> = {};
  if (opts.currentVersion) {
    files[join(realDir, "package.json")] = pkgJson(opts.currentVersion);
    files[join(opts.packageDir, "package.json")] = pkgJson(opts.currentVersion);
  }
  const existing = new Set(opts.existing ?? []);
  const npmCalls: Harness["npmCalls"] = [];

  const deps: SelfUpdateDeps = {
    packageDir: () => opts.packageDir,
    env: () => opts.env ?? {},
    existsSync: (p) => p in files || existing.has(p),
    isSymlink: () => opts.symlink ?? false,
    realpath: () => (opts.realpathFails ? undefined : realDir),
    readFile: (p) => {
      if (p in files) return files[p];
      throw new Error(`ENOENT: ${p}`);
    },
    getLatestVersion: async () => {
      if (opts.registryThrows) throw new Error("network down");
      return opts.latest;
    },
    runNpm: async (args, cwd) => {
      npmCalls.push({ args, cwd });
      return { ok: opts.npmOk ?? true };
    },
  };
  return { deps, npmCalls };
}

// Common install-dir fixtures (POSIX-style; detection normalizes separators).
const GLOBAL_DIR = "/usr/lib/node_modules/comfyui-mcp";
const LOCAL_PROJECT = "/home/me/proj";
const LOCAL_DIR = join(LOCAL_PROJECT, "node_modules", "comfyui-mcp");
const NPX_DIR = "/home/me/.npm/_npx/abc123/node_modules/comfyui-mcp";
const DEV_DIR = "/home/me/code/comfyui-mcp";

// pnpm virtual store: <proj>/node_modules/.pnpm/<pkg>@x/node_modules/<pkg>
const PNPM_PROJECT = "/home/me/pnpmproj";
const PNPM_DIR = join(
  PNPM_PROJECT,
  "node_modules",
  ".pnpm",
  "comfyui-mcp@0.19.1",
  "node_modules",
  "comfyui-mcp",
);
// yarn (un-hoisted nested dep-of-dep): <proj>/node_modules/<other>/node_modules/<pkg>
const YARN_PROJECT = "/home/me/yarnproj";
const YARN_DIR = join(YARN_PROJECT, "node_modules", "some-dep", "node_modules", "comfyui-mcp");

// ---------------------------------------------------------------------------
// semver
// ---------------------------------------------------------------------------

describe("compareSemver / isNewer", () => {
  it("orders core versions", () => {
    expect(compareSemver("1.2.4", "1.2.3")).toBe(1);
    expect(compareSemver("1.3.0", "1.2.9")).toBe(1);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
  });
  it("treats a release as newer than its prerelease", () => {
    expect(compareSemver("1.2.3", "1.2.3-beta.1")).toBe(1);
    expect(compareSemver("1.2.3-beta.2", "1.2.3-beta.1")).toBe(1);
  });
  it("tolerates a leading v and bad input", () => {
    expect(compareSemver("v1.2.4", "1.2.3")).toBe(1);
    expect(compareSemver("garbage", "1.2.3")).toBe(0);
  });
  it("isNewer is strict", () => {
    expect(isNewer("0.19.2", "0.19.1")).toBe(true);
    expect(isNewer("0.19.1", "0.19.1")).toBe(false);
    expect(isNewer("0.19.0", "0.19.1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectInstallMode
// ---------------------------------------------------------------------------

describe("detectInstallMode", () => {
  it("global: under node_modules with no project package.json above", () => {
    const { deps } = makeDeps({ packageDir: GLOBAL_DIR, currentVersion: "0.19.1" });
    const info = detectInstallMode(deps);
    expect(info.mode).toBe("global");
    expect(info.isDevLink).toBe(false);
    expect(info.currentVersion).toBe("0.19.1");
  });

  it("local: under a project's node_modules (project package.json present)", () => {
    const { deps } = makeDeps({
      packageDir: LOCAL_DIR,
      currentVersion: "0.19.1",
      existing: [join(LOCAL_PROJECT, "package.json")],
    });
    const info = detectInstallMode(deps);
    expect(info.mode).toBe("local");
    expect(info.projectRoot).toBe(LOCAL_PROJECT.replace(/\\/g, "/"));
  });

  it("npx: resolved inside an _npx cache dir", () => {
    const { deps } = makeDeps({ packageDir: NPX_DIR, currentVersion: "0.19.1" });
    expect(detectInstallMode(deps).mode).toBe("npx");
  });

  it("linked: not under node_modules → dev checkout", () => {
    const { deps } = makeDeps({ packageDir: DEV_DIR, currentVersion: "0.19.1" });
    const info = detectInstallMode(deps);
    expect(info.mode).toBe("linked");
    expect(info.isDevLink).toBe(true);
  });

  it("linked: npm link symlink resolved by realpath to a checkout", () => {
    // Node resolves the symlink → realpath points at the dev checkout (no node_modules).
    const { deps } = makeDeps({
      packageDir: "/usr/lib/node_modules/comfyui-mcp",
      realpath: DEV_DIR,
      currentVersion: "0.19.1",
    });
    expect(detectInstallMode(deps).mode).toBe("linked");
  });

  it("linked: --preserve-symlinks (dir itself is a symlink) → dev", () => {
    const { deps } = makeDeps({
      packageDir: GLOBAL_DIR,
      symlink: true,
      currentVersion: "0.19.1",
    });
    const info = detectInstallMode(deps);
    expect(info.mode).toBe("linked");
    expect(info.isDevLink).toBe(true);
  });

  it("unknown: packageDir() throws", () => {
    const { deps } = makeDeps({ packageDir: GLOBAL_DIR });
    deps.packageDir = () => {
      throw new Error("no url");
    };
    expect(detectInstallMode(deps).mode).toBe("unknown");
  });

  // --- P1: nested node_modules (pnpm / yarn) must be LOCAL, never global ------

  it("local: pnpm virtual-store nested layout resolves to the project root", () => {
    const { deps } = makeDeps({
      packageDir: PNPM_DIR,
      currentVersion: "0.19.1",
      existing: [join(PNPM_PROJECT, "package.json")],
    });
    const info = detectInstallMode(deps);
    expect(info.mode).toBe("local");
    expect(info.projectRoot).toBe(PNPM_PROJECT.replace(/\\/g, "/"));
  });

  it("local: yarn un-hoisted nested dep resolves to the OUTERMOST project root", () => {
    const { deps } = makeDeps({
      packageDir: YARN_DIR,
      currentVersion: "0.19.1",
      existing: [join(YARN_PROJECT, "package.json")],
    });
    const info = detectInstallMode(deps);
    expect(info.mode).toBe("local");
    expect(info.projectRoot).toBe(YARN_PROJECT.replace(/\\/g, "/"));
  });

  it("unknown (NEVER global): nested node_modules with no identifiable project root", () => {
    // Two node_modules segments, no package.json above either → ambiguous.
    const { deps } = makeDeps({ packageDir: PNPM_DIR, currentVersion: "0.19.1" });
    const info = detectInstallMode(deps);
    expect(info.mode).toBe("unknown");
    expect(info.mode).not.toBe("global");
  });

  // --- P2a: realpath failure must safe-fail to unknown ------------------------

  it("unknown: realpath resolution fails while under node_modules", () => {
    const { deps } = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      realpathFails: true,
    });
    const info = detectInstallMode(deps);
    expect(info.mode).toBe("unknown");
    // version still read from the raw path so status can report it
    expect(info.currentVersion).toBe("0.19.1");
  });

  it("realpath failure still classifies a not-under-node_modules checkout as linked", () => {
    const { deps } = makeDeps({
      packageDir: DEV_DIR,
      currentVersion: "0.19.1",
      realpathFails: true,
    });
    expect(detectInstallMode(deps).mode).toBe("linked");
  });
});

// ---------------------------------------------------------------------------
// checkAndSelfUpdate policy matrix
// ---------------------------------------------------------------------------

describe("checkAndSelfUpdate policy", () => {
  it("dev link → skipped-dev (NEVER runs npm)", async () => {
    const h = makeDeps({ packageDir: DEV_DIR, currentVersion: "0.19.1", latest: "9.9.9" });
    const res = await checkAndSelfUpdate({ deps: h.deps });
    expect(res.action).toBe("skipped-dev");
    expect(h.npmCalls).toEqual([]);
  });

  it("opt-out env → skipped-disabled (no npm)", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "9.9.9",
      env: { COMFYUI_MCP_AUTOUPDATE: "0" },
    });
    const res = await checkAndSelfUpdate({ deps: h.deps });
    expect(res.action).toBe("skipped-disabled");
    expect(h.npmCalls).toEqual([]);
  });

  it("opt-out 'off' also disables", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "9.9.9",
      env: { COMFYUI_MCP_AUTOUPDATE: "off" },
    });
    expect((await checkAndSelfUpdate({ deps: h.deps })).action).toBe("skipped-disabled");
  });

  it("up-to-date → no npm", async () => {
    const h = makeDeps({ packageDir: GLOBAL_DIR, currentVersion: "0.19.1", latest: "0.19.1" });
    const res = await checkAndSelfUpdate({ deps: h.deps });
    expect(res.action).toBe("up-to-date");
    expect(h.npmCalls).toEqual([]);
  });

  it("newer + global → runs `npm i -g comfyui-mcp@latest` and returns updated", async () => {
    const h = makeDeps({ packageDir: GLOBAL_DIR, currentVersion: "0.19.1", latest: "0.20.0" });
    const res = await checkAndSelfUpdate({ deps: h.deps });
    expect(res.action).toBe("updated");
    expect(res.from).toBe("0.19.1");
    expect(res.to).toBe("0.20.0");
    expect(res.note).toMatch(/RECONNECT/i);
    expect(h.npmCalls).toEqual([
      { args: ["i", "-g", `${PACKAGE_NAME}@latest`, "--no-audit", "--no-fund"], cwd: undefined },
    ]);
  });

  it("newer + local → runs `npm i comfyui-mcp@latest` in the project root", async () => {
    const h = makeDeps({
      packageDir: LOCAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      existing: [join(LOCAL_PROJECT, "package.json")],
    });
    const res = await checkAndSelfUpdate({ deps: h.deps });
    expect(res.action).toBe("updated");
    expect(h.npmCalls).toEqual([
      {
        args: ["i", `${PACKAGE_NAME}@latest`, "--no-audit", "--no-fund"],
        cwd: LOCAL_PROJECT.replace(/\\/g, "/"),
      },
    ]);
  });

  it("newer + global but npm fails → unavailable", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      npmOk: false,
    });
    const res = await checkAndSelfUpdate({ deps: h.deps });
    expect(res.action).toBe("unavailable");
    expect(res.to).toBe("0.20.0");
  });

  it("newer + npx → notify (no npm)", async () => {
    const h = makeDeps({ packageDir: NPX_DIR, currentVersion: "0.19.1", latest: "0.20.0" });
    const res = await checkAndSelfUpdate({ deps: h.deps });
    expect(res.action).toBe("notify");
    expect(h.npmCalls).toEqual([]);
  });

  it("newer + unknown (ambiguous nested) → notify, NEVER an npm -g update", async () => {
    const h = makeDeps({ packageDir: PNPM_DIR, currentVersion: "0.19.1", latest: "0.20.0" });
    const res = await checkAndSelfUpdate({ deps: h.deps });
    expect(res.action).toBe("notify");
    expect(res.mode).toBe("unknown");
    expect(h.npmCalls).toEqual([]);
  });

  it("newer + realpath-failure → notify (unknown), NEVER an npm update", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      realpathFails: true,
    });
    const res = await checkAndSelfUpdate({ deps: h.deps });
    expect(res.action).toBe("notify");
    expect(res.mode).toBe("unknown");
    expect(h.npmCalls).toEqual([]);
  });

  it("offline / registry unreachable → unavailable", async () => {
    const h = makeDeps({ packageDir: GLOBAL_DIR, currentVersion: "0.19.1", latest: undefined });
    const res = await checkAndSelfUpdate({ deps: h.deps });
    expect(res.action).toBe("unavailable");
    expect(h.npmCalls).toEqual([]);
  });

  it("never throws even if the registry probe throws", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      registryThrows: true,
    });
    const res = await checkAndSelfUpdate({ deps: h.deps });
    expect(res.action).toBe("unavailable");
  });

  it("never throws if runNpm throws", async () => {
    const h = makeDeps({ packageDir: GLOBAL_DIR, currentVersion: "0.19.1", latest: "0.20.0" });
    h.deps.runNpm = async () => {
      throw new Error("spawn EACCES");
    };
    const res = await checkAndSelfUpdate({ deps: h.deps });
    expect(res.action).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// runSelfUpdate (explicit tool action)
// ---------------------------------------------------------------------------

describe("runSelfUpdate", () => {
  it("REFUSES on a dev link", async () => {
    const h = makeDeps({ packageDir: DEV_DIR, currentVersion: "0.19.1", latest: "9.9.9" });
    await expect(runSelfUpdate(h.deps)).rejects.toBeInstanceOf(SelfUpdateError);
    expect(h.npmCalls).toEqual([]);
  });

  it("ignores the opt-out env (explicit request) and updates global", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      env: { COMFYUI_MCP_AUTOUPDATE: "0" },
    });
    const res = await runSelfUpdate(h.deps);
    expect(res.action).toBe("updated");
    expect(h.npmCalls).toEqual([
      { args: ["i", "-g", `${PACKAGE_NAME}@latest`, "--no-audit", "--no-fund"], cwd: undefined },
    ]);
  });

  it("up-to-date is a no-op", async () => {
    const h = makeDeps({ packageDir: GLOBAL_DIR, currentVersion: "0.20.0", latest: "0.20.0" });
    const res = await runSelfUpdate(h.deps);
    expect(res.action).toBe("up-to-date");
    expect(h.npmCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// selfUpdateStatus (never throws)
// ---------------------------------------------------------------------------

describe("selfUpdateStatus", () => {
  it("reports update availability for a global install", async () => {
    const h = makeDeps({ packageDir: GLOBAL_DIR, currentVersion: "0.19.1", latest: "0.20.0" });
    const s = await selfUpdateStatus(h.deps);
    expect(s.mode).toBe("global");
    expect(s.currentVersion).toBe("0.19.1");
    expect(s.latestVersion).toBe("0.20.0");
    expect(s.updateAvailable).toBe(true);
    expect(s.note).toMatch(/RECONNECT/i);
  });

  it("flags dev-link and never reports it as updatable", async () => {
    const h = makeDeps({ packageDir: DEV_DIR, currentVersion: "0.19.1", latest: "9.9.9" });
    const s = await selfUpdateStatus(h.deps);
    expect(s.isDevLink).toBe(true);
    expect(s.note).toMatch(/dev install/i);
  });

  it("never throws when the registry is unreachable", async () => {
    const h = makeDeps({ packageDir: GLOBAL_DIR, currentVersion: "0.19.1", registryThrows: true });
    const s = await selfUpdateStatus(h.deps);
    expect(s.latestVersion).toBeUndefined();
    expect(s.updateAvailable).toBe(false);
  });
});

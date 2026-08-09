import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  buildDeferredUpdateScript,
  checkAndSelfUpdate,
  compareSemver,
  detectInstallMode,
  isNewer,
  runSelfUpdate,
  selfUpdateStatus,
  SelfUpdateError,
  PACKAGE_NAME,
  defaultDeps,
  type SelfUpdateDeps,
} from "../../services/self-update.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  deps: SelfUpdateDeps;
  npmCalls: Array<{ args: string[]; cwd?: string }>;
  scheduleCalls: Array<{
    mode: "global" | "local";
    projectRoot?: string;
    packageDir: string;
    to: string;
  }>;
}

function pkgJson(version: string): string {
  return JSON.stringify({ name: PACKAGE_NAME, version });
}

function makeDeps(opts: {
  packageDir: string;
  currentVersion?: string; // written into <packageDir>/package.json
  latest?: string | undefined; // registry latest; undefined → UNDETERMINED (#1136)
  unreachable?: string; // #1136: the transport proved the host unreachable
  symlink?: boolean; // packageDir is a raw symlink
  realpath?: string; // override realpath(packageDir)
  realpathFails?: boolean; // realpath() returns undefined (resolution failed)
  env?: NodeJS.ProcessEnv;
  existing?: string[]; // extra paths that exist (e.g. project package.json)
  npmOk?: boolean; // result of runNpm
  npmStderr?: string; // npm failure output (diagnostics must survive, #912)
  npmStdout?: string;
  platform?: string; // injected platform (the deferred path is Windows-only)
  scheduleOk?: boolean; // whether scheduleDeferredUpdate reports a launch
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
  const scheduleCalls: Harness["scheduleCalls"] = [];

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
      // #1136 — the probe is now three-state. A harness that always returned
      // `unreachable` for a missing version would re-create the very fold the
      // change removes, so an absent `latest` means UNDETERMINED here; the
      // unreachable path is exercised explicitly by opts.unreachable.
      if (opts.unreachable) return { unreachable: opts.unreachable };
      if (opts.latest === "") return { undetermined: "the registry response carried no usable version field" };
      return opts.latest === undefined
        ? { undetermined: "test harness supplied no version" }
        : { version: opts.latest };
    },
    runNpm: async (args, cwd) => {
      npmCalls.push({ args, cwd });
      const ok = opts.npmOk ?? true;
      return ok
        ? { ok }
        : { ok, stderr: opts.npmStderr ?? "", stdout: opts.npmStdout ?? "" };
    },
    platform: opts.platform ? () => opts.platform! : undefined,
    scheduleDeferredUpdate: async (o) => {
      scheduleCalls.push({ ...o });
      return opts.scheduleOk ?? true;
    },
  };
  return { deps, npmCalls, scheduleCalls };
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
// #912 / #916-a — npm failure diagnostics + the Windows deferred updater
// ---------------------------------------------------------------------------

const EBUSY_STDERR = [
  "npm error code EBUSY",
  "npm error syscall copyfile",
  "npm error path C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\comfyui-mcp\\node_modules\\@img\\sharp-win32-x64\\lib\\libvips-42.dll",
  "npm error EBUSY: resource busy or locked, copyfile",
].join("\n");

describe("#912 — a failed npm update must carry WHY (never the bare 'failed' note)", () => {
  it("npm's stderr tail lands in the failure note (global)", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      npmOk: false,
      npmStderr: "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/comfyui-mcp",
      platform: "linux",
    });
    const res = await runSelfUpdate(h.deps);
    expect(res.action).toBe("unavailable");
    expect(res.reason).toBe("npm-failed");
    expect(res.note).toContain("staying on 0.19.1");
    expect(res.note).toContain("npm error code E404");
    expect(res.note).toContain("404 Not Found");
  });

  it("the tail comes from stdout when stderr is empty", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      npmOk: false,
      npmStdout: "npm ERR! network timeout at fetch",
      platform: "linux",
    });
    const res = await runSelfUpdate(h.deps);
    expect(res.action).toBe("unavailable");
    expect(res.note).toContain("network timeout at fetch");
  });

  it("only the LAST 8 lines survive", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `npm error line-${i + 1} ${"x".repeat(80)}`);
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      npmOk: false,
      npmStderr: lines.join("\n"),
      platform: "linux",
    });
    const res = await runSelfUpdate(h.deps);
    expect(res.note).toContain("line-30");
    expect(res.note).toContain("line-23");
    expect(res.note).not.toContain("line-22"); // dropped: outside the last 8
  });

  it("a single very long npm line is length-capped", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      npmOk: false,
      npmStderr: `npm error ${"y".repeat(5000)} END-OF-LOG`,
      platform: "linux",
    });
    const res = await runSelfUpdate(h.deps);
    expect(res.note!.length).toBeLessThan(1500);
    expect(res.note).toContain("END-OF-LOG"); // the tail is what survives
  });

  it("the on-load check surfaces the same diagnostics", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      npmOk: false,
      npmStderr: "npm error code EACCES\nnpm error permission denied",
      platform: "linux",
    });
    const res = await checkAndSelfUpdate({ deps: h.deps });
    expect(res.action).toBe("unavailable");
    expect(res.note).toContain("EACCES");
  });
});

describe("#912 — Windows global/local: EBUSY on the orchestrator's OWN sharp DLL", () => {
  it("a locked-files npm failure on win32 schedules the deferred helper and reports 'scheduled'", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      npmOk: false,
      npmStderr: EBUSY_STDERR,
      platform: "win32",
      scheduleOk: true,
    });
    const res = await runSelfUpdate(h.deps);
    expect(res.action).toBe("scheduled");
    expect(res.reason).toBe("locked-by-running-process");
    // The in-process npm was attempted first, then the helper was scheduled…
    expect(h.npmCalls).toHaveLength(1);
    expect(h.scheduleCalls).toHaveLength(1);
    expect(h.scheduleCalls[0].mode).toBe("global");
    expect(h.scheduleCalls[0].packageDir).toBe(GLOBAL_DIR);
    expect(h.scheduleCalls[0].to).toBe("0.20.0");
    // …and the note says what actually happens — never "updated".
    expect(res.note).toMatch(/detached helper was scheduled/);
    expect(res.note).toMatch(/fully STOPPED/);
    expect(res.note).toMatch(/[sS]taying on 0\.19\.1/);
    expect(res.note).toContain("npm i -g comfyui-mcp@latest");
    expect(res.note).not.toMatch(/Updated comfyui-mcp/);
    expect(res.note).toMatch(/self-update\.log/);
  });

  it("a win32 LOCAL install passes the project root to the helper", async () => {
    const h = makeDeps({
      packageDir: LOCAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      existing: [join(LOCAL_PROJECT, "package.json")],
      npmOk: false,
      npmStderr: EBUSY_STDERR,
      platform: "win32",
      scheduleOk: true,
    });
    const res = await runSelfUpdate(h.deps);
    expect(res.action).toBe("scheduled");
    expect(h.scheduleCalls).toHaveLength(1);
    expect(h.scheduleCalls[0].mode).toBe("local");
    expect(h.scheduleCalls[0].projectRoot).toBe(LOCAL_PROJECT.replace(/\\/g, "/"));
    expect(res.note).toContain("npm i comfyui-mcp@latest");
    expect(res.note).toContain(LOCAL_PROJECT.replace(/\\/g, "/"));
  });

  it("the on-load check takes the same deferred path on win32", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      npmOk: false,
      npmStderr: EBUSY_STDERR,
      platform: "win32",
      scheduleOk: true,
    });
    const res = await checkAndSelfUpdate({ deps: h.deps });
    expect(res.action).toBe("scheduled");
    expect(h.scheduleCalls).toHaveLength(1);
  });

  it("when the helper cannot be launched, the note falls back to the manual remedy + npm's own error", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      npmOk: false,
      npmStderr: EBUSY_STDERR,
      platform: "win32",
      scheduleOk: false, // spawn failed — never claim "scheduled"
    });
    const res = await runSelfUpdate(h.deps);
    expect(res.action).toBe("unavailable");
    expect(res.reason).toBe("locked-by-running-process");
    expect(res.note).not.toMatch(/scheduled/);
    expect(res.note).toMatch(/could not be started/);
    expect(res.note).toContain("npm i -g comfyui-mcp@latest");
    expect(res.note).toContain("EBUSY: resource busy or locked");
    expect(res.note).toMatch(/[sS]taying on 0\.19\.1/);
  });

  it("a lock failure on POSIX is reported, never scheduled (the deferred path is Windows-only)", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      npmOk: false,
      npmStderr: EBUSY_STDERR,
      platform: "linux",
      scheduleOk: true,
    });
    const res = await runSelfUpdate(h.deps);
    expect(res.action).toBe("unavailable");
    expect(res.reason).toBe("locked-by-running-process");
    expect(h.scheduleCalls).toEqual([]);
    expect(res.note).toContain("EBUSY: resource busy or locked");
  });

  it("a lock error ANYWHERE in npm's output still classifies as locked (not just the last 8 lines)", async () => {
    // The display tail is the last 8 lines — but the classification must read
    // the FULL capture (codex gate): an EBUSY high in a long log, buried under
    // trailing diagnostics, is still a locked-files failure.
    const longLog = [
      "npm error code EBUSY",
      "npm error EBUSY: resource busy or locked, copyfile",
      ...Array.from({ length: 30 }, (_, i) => `npm error diagnostic line ${i + 1}`),
    ].join("\n");
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      npmOk: false,
      npmStderr: longLog,
      platform: "win32",
      scheduleOk: true,
    });
    const res = await runSelfUpdate(h.deps);
    expect(res.action).toBe("scheduled");
    expect(res.reason).toBe("locked-by-running-process");
    expect(h.scheduleCalls).toHaveLength(1);
  });

  it("a NON-lock npm failure on win32 is NOT scheduled (a 404 won't heal by waiting)", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      npmOk: false,
      npmStderr: "npm error code E404\nnpm error 404 Not Found",
      platform: "win32",
      scheduleOk: true,
    });
    const res = await runSelfUpdate(h.deps);
    expect(res.action).toBe("unavailable");
    expect(res.reason).toBe("npm-failed");
    expect(h.scheduleCalls).toEqual([]);
    expect(res.note).toContain("404 Not Found");
  });

  it("a successful win32 update never touches the helper", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      platform: "win32",
    });
    const res = await runSelfUpdate(h.deps);
    expect(res.action).toBe("updated");
    expect(h.scheduleCalls).toEqual([]);
  });
});

describe("#912 — status says up front that Windows applies via the deferred helper", () => {
  it("win32 global: the update-available note names the deferred post-stop application", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      platform: "win32",
    });
    const s = await selfUpdateStatus(h.deps);
    expect(s.updateAvailable).toBe(true);
    expect(s.note).toMatch(/deferred helper/);
    expect(s.note).toMatch(/fully stopped/i);
  });

  it("non-Windows: no such caveat", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "0.19.1",
      latest: "0.20.0",
      platform: "linux",
    });
    const s = await selfUpdateStatus(h.deps);
    expect(s.note).not.toMatch(/deferred helper/);
  });
});

describe("#912 — the deferred helper script itself", () => {
  const LOG = "C:\\Temp\\comfyui-mcp-self-update.log";

  it("global: probes the sharp DLL lock, runs npm -g, self-deletes", () => {
    const s = buildDeferredUpdateScript(
      { mode: "global", packageDir: GLOBAL_DIR, to: "0.20.0" },
      LOG,
    );
    expect(s).toContain("libvips-42.dll");
    expect(s).toContain("[System.IO.File]::Open($dll, 'Open', 'ReadWrite', 'None')");
    expect(s).toContain(`& npm.cmd i -g ${PACKAGE_NAME}@latest --no-audit --no-fund *>> $log`);
    expect(s).toContain("Remove-Item -LiteralPath $MyInvocation.MyCommand.Path");
    expect(s).toContain(`$log = '${LOG}'`);
    expect(s).toContain("$cwd = ''"); // global: npm -g has no cwd dependence
  });

  it("local: runs npm in the project root, no -g, and the root is re-validated before every attempt", () => {
    const s = buildDeferredUpdateScript(
      { mode: "local", projectRoot: "C:\\proj", packageDir: LOCAL_DIR, to: "0.20.0" },
      LOG,
    );
    expect(s).toContain("$cwd = 'C:\\proj'");
    expect(s).toContain("Set-Location -LiteralPath $cwd -ErrorAction Stop");
    expect(s).toContain(`& npm.cmd i ${PACKAGE_NAME}@latest --no-audit --no-fund *>> $log`);
    expect(s).not.toContain("i -g");
    // A vanished/moved project root aborts the helper WITHOUT running npm in
    // whatever directory it inherited — and the guard sits before the npm line.
    expect(s).toContain("ABORTED without running npm");
    expect(s).toContain("Test-Path -LiteralPath $cwd -PathType Container");
    expect(s.indexOf("Test-Path -LiteralPath $cwd")).toBeLessThan(s.indexOf("& npm.cmd"));
  });

  it("single quotes in paths are escaped (PowerShell literal doubling)", () => {
    const s = buildDeferredUpdateScript(
      { mode: "local", projectRoot: "C:\\it's here", packageDir: LOCAL_DIR, to: "0.20.0" },
      LOG,
    );
    expect(s).toContain("$cwd = 'C:\\it''s here'");
  });

  it("the generated script parses as valid PowerShell (validated on Windows hosts only)", () => {
    if (process.platform !== "win32") return; // no powershell on POSIX CI
    const dir = mkdtempSync(join(tmpdir(), "cmcp-helper-script-"));
    try {
      const file = join(dir, "helper.ps1");
      writeFileSync(
        file,
        buildDeferredUpdateScript(
          { mode: "local", projectRoot: dir, packageDir: LOCAL_DIR, to: "0.20.0" },
          join(dir, "log.txt"),
        ),
      );
      // Parse-only: a syntax error makes [scriptblock]::Create throw (exit ≠ 0).
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$null = [scriptblock]::Create((Get-Content -LiteralPath '${file.replace(/'/g, "''")}' -Raw))`,
        ],
        { stdio: "pipe" },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

// ── #1136: "unreachable" is a claim about the USER'S NETWORK. It must not be
// made on the strength of a registry that answered.
//
// Before this, `getLatestVersion` returned `string | undefined` and four
// conditions collapsed into that `undefined` -- DNS failure, non-2xx, missing
// `version` field, unparseable body -- after which the consumer reported all
// four as "npm registry unreachable (offline or timed out)". A user hitting a
// 429 was told to check their network.
describe("registry probe distinguishes unreachable from undetermined (#1136)", () => {
  it("names the host and says unreachable ONLY when the transport proves it", async () => {
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "1.0.0",
      unreachable:
        "Could not reach registry.npmjs.org — the request could not be resolved (DNS).",
    });
    const res = await runSelfUpdate(h.deps);
    expect(res.action).toBe("unavailable");
    expect(res.note).toContain("registry.npmjs.org");
    expect(res.note).toMatch(/could not be resolved/i);
  });

  it("does NOT say unreachable when the registry ANSWERED but we could not determine a version", async () => {
    // The discriminating case. `latest: undefined` now means undetermined, not
    // unreachable -- a 500/429/garbage body must not be reported as a network
    // problem the user can act on.
    const h = makeDeps({ packageDir: GLOBAL_DIR, currentVersion: "1.0.0" });
    const res = await runSelfUpdate(h.deps);
    expect(res.action).toBe("unavailable");
    expect(res.note).not.toMatch(/unreachable/i);
    expect(res.note).toMatch(/could not determine/i);
  });

  it("says an undetermined check is NOT evidence of being up to date", async () => {
    // The failure this issue is about: a non-answer read as a reassuring answer.
    const h = makeDeps({ packageDir: GLOBAL_DIR, currentVersion: "1.0.0" });
    const res = await runSelfUpdate(h.deps);
    expect(res.note).toMatch(/NOT evidence that you are up to date/i);
    expect(res.action).not.toBe("up-to-date");
  });
});

// The two defects the #1136 review measured in my own fix. Both are cases where
// a NON-answer was rendered as a confident one -- the failure this issue is
// about, reintroduced by the change meant to remove it.
describe("selfUpdateStatus and the empty-version guard (#1136 review)", () => {
  it("action:status must not report a REACHABLE registry as unreachable", () => {
    // status and the update path are the same tool (tools/self-update.ts:20).
    // status kept calling getLatestPublishedVersion, which flattens the probe
    // back to string|undefined, so a 429 read as a network failure -- and
    // status is the read-only action an agent uses while diagnosing exactly
    // the "I can't find anything" scenario #1136 reports.
    const h = makeDeps({ packageDir: GLOBAL_DIR, currentVersion: "1.0.0" });
    return selfUpdateStatus(h.deps).then((res) => {
      expect(res.note).not.toMatch(/registry unreachable/i);
      expect(res.note).toMatch(/could not determine/i);
      expect(res.note).toMatch(/NOT evidence that you are up to date/i);
    });
  });

  it("action:status keeps the composed unreachable message, host name included", async () => {
    // The old branch replaced it with a fixed string, discarding the host --
    // the one thing #1136 asks for.
    const h = makeDeps({
      packageDir: GLOBAL_DIR,
      currentVersion: "1.0.0",
      unreachable: "Could not reach registry.npmjs.org — the request could not be resolved (DNS).",
    });
    const res = await selfUpdateStatus(h.deps);
    expect(res.note).toContain("registry.npmjs.org");
  });

  it('an empty version string is UNDETERMINED, never "up to date"', async () => {
    // Drives the REAL probe, not the harness. The first version of this test
    // configured makeDeps to return `undetermined` for "" -- which tests the
    // consumer and hand-feeds the answer: deleting the trim guard from
    // defaultGetLatestVersion killed ZERO tests. Stub fetch instead, so the
    // guard itself is what stands between {"version":""} and a false
    // "up to date".
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ version: "" }), { status: 200 })),
    );
    try {
      const probe = await defaultDeps.getLatestVersion();
      expect("version" in probe, "an empty version must not count as a version").toBe(false);
      expect(probe).toHaveProperty("undetermined");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a real successful body still yields a version (the guard must not over-fire)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 })),
    );
    try {
      expect(await defaultDeps.getLatestVersion()).toEqual({ version: "9.9.9" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a fetch REJECTION is unreachable — the swap's own thesis, previously unpinned", async () => {
    // S3 from the re-review. All three probe tests stubbed fetch to RESOLVE, so
    // nothing asserted the state this whole change exists to produce: replacing
    // the catch's {unreachable} with {undetermined} killed zero tests.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new TypeError("fetch failed");
        (err as unknown as { cause: unknown }).cause = Object.assign(new Error("ENOTFOUND"), {
          code: "ENOTFOUND",
        });
        throw err;
      }),
    );
    try {
      const probe = await defaultDeps.getLatestVersion();
      expect(probe).toHaveProperty("unreachable");
      expect((probe as { unreachable: string }).unreachable).toContain("registry.npmjs.org");
      expect((probe as { unreachable: string }).unreachable).toMatch(/NOT an empty result/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a non-2xx says the host IS reachable — never 'unreachable'", async () => {
    // The registry ANSWERED. This is the 429/500 case the review measured
    // still reporting a network failure.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    try {
      const probe = await defaultDeps.getLatestVersion();
      expect(probe).not.toHaveProperty("unreachable");
      expect((probe as { undetermined: string }).undetermined).toMatch(/host IS reachable/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

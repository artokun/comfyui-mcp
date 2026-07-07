import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Desktop-recorded install detection (installations.json) — the fix for local
// installs at custom locations (e.g. ~/ComfyUI-Installs/ComfyUI) that the
// common-directory heuristics can never find. homedir() is mocked so the
// detector reads a fabricated "Comfy Desktop" config dir.

const FAKE_HOME = mkdtempSync(join(tmpdir(), "cfg-desktop-home-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => FAKE_HOME };
});

const OLD_ENV = process.env;
const OLD_ARGV = process.argv;

const DESKTOP_DIR = join(FAKE_HOME, "AppData", "Roaming", "Comfy Desktop");

function makeRoot(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.py"), "# fake comfyui entrypoint\n");
  mkdirSync(join(dir, "output"), { recursive: true });
  return dir;
}

function writeInstallations(entries: unknown): void {
  mkdirSync(DESKTOP_DIR, { recursive: true });
  writeFileSync(
    join(DESKTOP_DIR, "installations.json"),
    typeof entries === "string" ? entries : JSON.stringify(entries),
  );
}

describe("Desktop-recorded install detection (installations.json)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...OLD_ENV };
    process.argv = [...OLD_ARGV];
    process.env.COMFYUI_API_KEY = "";
    process.env.COMFYUI_URL = "";
    process.env.COMFYUI_PATH = "";
    process.env.COMFYUI_HOST = "";
    process.env.COMFYUI_PORT = "8188"; // skip port auto-detect
    rmSync(DESKTOP_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    process.env = OLD_ENV;
    process.argv = OLD_ARGV;
  });

  it("finds a custom-location install from installations.json and descends the wrapper", async () => {
    // Layout mirrors a real Desktop standalone install:
    //   <wrapper>/            (logs, outputs — NOT a root)
    //   <wrapper>/ComfyUI/    (main.py — the real root)
    const wrapper = join(FAKE_HOME, "ComfyUI-Installs", "ComfyUI");
    mkdirSync(wrapper, { recursive: true });
    const nested = makeRoot(join(wrapper, "ComfyUI"));
    writeInstallations([
      { id: "r", installPath: "", sourceId: "remote", remoteUrl: "https://x" },
      { id: "l", installPath: wrapper, sourceId: "standalone", lastLaunchedAt: 5 },
    ]);
    const mod = await import("../config.js");
    expect(mod.detectLocalComfyUIPath()).toBe(nested);
  });

  it("prefers the most recently launched install when several are recorded", async () => {
    const older = makeRoot(join(FAKE_HOME, "installs", "old"));
    const newer = makeRoot(join(FAKE_HOME, "installs", "new"));
    writeInstallations([
      { id: "a", installPath: older, lastLaunchedAt: 100 },
      { id: "b", installPath: newer, lastLaunchedAt: 200 },
    ]);
    const mod = await import("../config.js");
    expect(mod.detectLocalComfyUIPath()).toBe(newer);
  });

  it("skips recorded paths that no longer exist on disk", async () => {
    const alive = makeRoot(join(FAKE_HOME, "installs", "alive"));
    writeInstallations([
      { id: "gone", installPath: join(FAKE_HOME, "installs", "deleted"), lastLaunchedAt: 999 },
      { id: "ok", installPath: alive, lastLaunchedAt: 1 },
    ]);
    const mod = await import("../config.js");
    expect(mod.detectLocalComfyUIPath()).toBe(alive);
  });

  it("skips recorded dirs that still exist but are no longer installs (no root markers)", async () => {
    // Uninstalled/moved: the dir remains (logs, leftovers) but has no main.py/
    // output/custom_nodes/models and no nested ComfyUI root.
    const dead = join(FAKE_HOME, "installs", "uninstalled");
    mkdirSync(join(dead, "logs"), { recursive: true });
    const alive = makeRoot(join(FAKE_HOME, "installs", "still-real"));
    writeInstallations([
      { id: "dead", installPath: dead, lastLaunchedAt: 999 },
      { id: "ok", installPath: alive, lastLaunchedAt: 1 },
    ]);
    const mod = await import("../config.js");
    expect(mod.detectLocalComfyUIPath()).toBe(alive);
  });

  it("skips remote entries by sourceId even when they carry a stale local path", async () => {
    const stale = makeRoot(join(FAKE_HOME, "installs", "stale-remote"));
    const local = makeRoot(join(FAKE_HOME, "installs", "local"));
    writeInstallations([
      { id: "r", installPath: stale, sourceId: "remote", lastLaunchedAt: 999 },
      { id: "l", installPath: local, sourceId: "standalone", lastLaunchedAt: 1 },
    ]);
    const mod = await import("../config.js");
    expect(mod.detectLocalComfyUIPath()).toBe(local);
  });

  it("malformed installations.json is ignored without throwing", async () => {
    writeInstallations("{not json[");
    const mod = await import("../config.js");
    expect(mod.detectLocalComfyUIPath()).toBeUndefined();
  });

  it("no Desktop config at all → undefined (heuristics find nothing in a bare home)", async () => {
    const mod = await import("../config.js");
    expect(mod.detectLocalComfyUIPath()).toBeUndefined();
  });

  it("an explicit COMFYUI_PATH env var still outranks Desktop-recorded installs", async () => {
    const envRoot = makeRoot(join(FAKE_HOME, "env-root"));
    const recorded = makeRoot(join(FAKE_HOME, "installs", "recorded"));
    writeInstallations([{ id: "x", installPath: recorded, lastLaunchedAt: 1 }]);
    process.env.COMFYUI_PATH = envRoot;
    const mod = await import("../config.js");
    expect(mod.config.comfyuiPath).toBe(envRoot);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

// isRemoteMode is consulted by resolveEffectiveComfyUIBase (the shared workspace
// resolver extra-paths now delegates to for the standalone root, #648), so the config
// mock must supply it rather than leaving it undefined.
const mockIsRemoteMode = vi.hoisted(() => vi.fn(() => false));
vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined as string | undefined },
  isRemoteMode: mockIsRemoteMode,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
}));

// Everything the live server contributes now comes from ONE /system_stats snapshot, so
// tests drive the real argv parsers rather than stubbing a resolver: server behavior is
// expressed as launch argv, exactly as the running ComfyUI reports it. Default to
// UNREACHABLE so unit tests never touch the network or a real local ComfyUI.
const mockGetSystemStats = vi.hoisted(() =>
  vi.fn(async (): Promise<{ system?: { argv?: string[]; cwd?: string } }> => {
    throw new Error("ComfyUI unreachable (test default)");
  }),
);
vi.mock("../../comfyui/client.js", () => ({ getSystemStats: mockGetSystemStats }));

// Pin the platform so the Desktop app-data path is deterministic across CI OSes:
// the desktop tests drive it via APPDATA (the win32 branch). Without this, Linux
// uses XDG_CONFIG_HOME/~/.config and macOS uses ~/Library, so the temp-dir
// assertions fail on those runners. (homedir/tmpdir stay real.)
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: () => "win32" };
});

import { config } from "../../config.js";
import {
  addExtraPath,
  expandVars,
  getExtraModelRoots,
  listExtraPaths,
  removeExtraPath,
} from "../../services/extra-paths.js";
import { configureWorkspace, resetWorkspaceConfig } from "../../services/workspace-env.js";

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "comfyui-extra-paths-"));
}

/** Can this machine create a file symlink? (Windows needs privileges/Developer Mode.) */
const CAN_SYMLINK = (() => {
  try {
    const dir = mkdtempSync(join(tmpdir(), "comfyui-symlink-probe-"));
    writeFileSync(join(dir, "t"), "t");
    symlinkSync(join(dir, "t"), join(dir, "link"), "file");
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

let dirs: string[] = [];
const oldAppData = process.env.APPDATA;
const oldComfyuiPathEnv = process.env.COMFYUI_PATH;

beforeEach(() => {
  config.comfyuiPath = undefined;
  // process.env.COMFYUI_PATH is the explicit-vs-inferred discriminator: a test that
  // means "the user named this root" sets it to the same path as config.comfyuiPath.
  delete process.env.COMFYUI_PATH;
  dirs = [];
  mockGetSystemStats.mockRejectedValue(new Error("ComfyUI unreachable (test default)"));
  mockIsRemoteMode.mockReturnValue(false);
  // Point the saved-default-workspace store at a path that does not exist, so the
  // default for every test is "no saved default" (never the developer's real one).
  configureWorkspace({ configPath: join(tmpdir(), "comfyui-mcp-no-such-workspace.json") });
});

afterEach(async () => {
  process.env.APPDATA = oldAppData;
  if (oldComfyuiPathEnv === undefined) delete process.env.COMFYUI_PATH;
  else process.env.COMFYUI_PATH = oldComfyuiPathEnv;
  config.comfyuiPath = undefined;
  resetWorkspaceConfig();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Persist a saved default workspace (as workspace action:"set_default" would) and return it. */
async function saveDefaultWorkspace(workspace: string): Promise<void> {
  const dir = await trackTmp();
  const cfgPath = join(dir, "workspace.json");
  await writeFile(cfgPath, JSON.stringify({ defaultWorkspace: workspace }), "utf-8");
  configureWorkspace({ configPath: cfgPath });
}

async function trackTmp(): Promise<string> {
  const dir = await tmpDir();
  dirs.push(dir);
  return dir;
}

describe("extra paths config service", () => {
  it("lists a standalone extra_model_paths.yaml from COMFYUI_PATH", async () => {
    const root = await trackTmp();
    config.comfyuiPath = root;
    await writeFile(
      join(root, "extra_model_paths.yaml"),
      [
        "shared:",
        "  base_path: D:/AI",
        "  is_default: true",
        "  checkpoints: |",
        "    models/checkpoints",
        "    E:/checkpoints",
        "  custom_nodes: C:/ComfyUI/custom_nodes",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await listExtraPaths({ target: "standalone" });

    expect(result.target).toBe("standalone");
    expect(result.exists).toBe(true);
    expect(result.path).toBe(join(root, "extra_model_paths.yaml"));
    expect(result.groups[0]).toMatchObject({
      name: "shared",
      base_path: "D:/AI",
      categories: [
        { category: "checkpoints", paths: ["models/checkpoints", "E:/checkpoints"] },
        { category: "custom_nodes", paths: ["C:/ComfyUI/custom_nodes"] },
      ],
    });
  });

  it("adds paths idempotently and removes exact matches", async () => {
    const root = await trackTmp();
    config.comfyuiPath = root;

    const first = await addExtraPath({
      target: "standalone",
      group: "shared",
      category: "loras",
      path: "D:/Models/loras",
      isDefault: true,
    });
    expect(first.changed).toBe(true);
    expect(first.groups[0].categories[0]).toEqual({
      category: "loras",
      paths: ["D:/Models/loras"],
    });

    const second = await addExtraPath({
      target: "standalone",
      group: "shared",
      category: "loras",
      path: "D:/Models/loras",
    });
    expect(second.changed).toBe(false);

    const raw = await readFile(join(root, "extra_model_paths.yaml"), "utf-8");
    expect(raw).toContain("shared:");
    expect(raw).toContain("is_default: true");
    expect(raw.match(/D:\/Models\/loras/g)).toHaveLength(1);

    const removed = await removeExtraPath({
      target: "standalone",
      group: "shared",
      category: "loras",
      path: "D:/Models/loras",
    });
    expect(removed.changed).toBe(true);
    expect(removed.groups[0].categories).toEqual([]);
  });

  it("uses the Desktop app-data config path when requested explicitly", async () => {
    const appData = await trackTmp();
    process.env.APPDATA = appData;

    const result = await addExtraPath({
      target: "desktop",
      group: "desktop_shared",
      category: "checkpoints",
      path: "E:/SD/checkpoints",
    });

    expect(result.target).toBe("desktop");
    expect(result.path).toBe(join(appData, "ComfyUI", "extra_models_config.yaml"));
    expect(result.exists).toBe(true);
    expect(result.groups[0].categories[0].paths).toEqual(["E:/SD/checkpoints"]);
  });

  it("auto target prefers an existing Desktop config over standalone", async () => {
    const root = await trackTmp();
    const appData = await trackTmp();
    config.comfyuiPath = root;
    process.env.APPDATA = appData;
    const desktopPath = join(appData, "ComfyUI", "extra_models_config.yaml");
    await addExtraPath({
      target: "desktop",
      group: "desktop_shared",
      category: "vae",
      path: "E:/vae",
    });

    const result = await listExtraPaths({ target: "auto" });
    expect(result.target).toBe("desktop");
    expect(result.path).toBe(desktopPath);
  });

  it("lists the live server's --extra-model-paths-config, not the static app-data guess (#345)", async () => {
    const appData = await trackTmp();
    process.env.APPDATA = appData;
    // The server was launched with a Desktop-generated shared config on another
    // path; that is the file it actually reads. Its main.py must resolve to a real
    // file here — that is what proves the server's filesystem is this one.
    const liveRoot = await trackTmp();
    await writeFile(join(liveRoot, "main.py"), "# comfyui\n", "utf-8");
    const serverCfg = join(appData, "Comfy Desktop", "shared_model_paths.yaml");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(appData, "Comfy Desktop"), { recursive: true });
    await writeFile(
      serverCfg,
      "# Generated by Comfy Desktop - do not edit manually\nd_ai:\n  vae: E:/vae\n",
    );
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: ["python", join(liveRoot, "main.py"), "--extra-model-paths-config", serverCfg],
      },
    });

    const result = await listExtraPaths({ target: "auto" });
    expect(result.target).toBe("desktop");
    expect(result.path).toBe(serverCfg);
    // Warns that it is Desktop-generated / diverges from the static guess.
    expect(result.notes.some((n) => /do not edit|auto-generated/i.test(n))).toBe(true);
    expect(result.notes.some((n) => /--extra-model-paths-config/i.test(n))).toBe(true);
  });

  it("rejects unsafe category keys and newline-bearing paths", async () => {
    const root = await trackTmp();
    config.comfyuiPath = root;

    await expect(
      addExtraPath({
        target: "standalone",
        category: "../bad",
        path: "D:/Models",
      }),
    ).rejects.toThrow(/Category/);

    await expect(
      addExtraPath({
        target: "standalone",
        category: "checkpoints",
        path: "D:/Models\nother",
      }),
    ).rejects.toThrow(/newline/);
  });
});

describe("standalone root precedence — saved default workspace (#648)", () => {
  /** Write a one-group extra_model_paths.yaml into `root` and return its path. */
  async function seedConfig(root: string, category: string, dir: string): Promise<string> {
    const path = join(root, "extra_model_paths.yaml");
    await writeFile(path, [`seeded:`, `  ${category}: ${dir}`, ""].join("\n"), "utf-8");
    return path;
  }

  it("uses the saved default workspace when COMFYUI_PATH is unset", async () => {
    const workspace = await trackTmp();
    const cfgPath = await seedConfig(workspace, "checkpoints", "E:/ws/checkpoints");
    await saveDefaultWorkspace(workspace);
    config.comfyuiPath = undefined;

    const result = await listExtraPaths({ target: "standalone" });

    expect(result.path).toBe(cfgPath);
    expect(result.exists).toBe(true);
    expect(result.groups[0].categories).toEqual([
      { category: "checkpoints", paths: ["E:/ws/checkpoints"] },
    ]);
    // The non-default source is stated, never silently assumed.
    expect(result.notes.some((n) => /saved default workspace/i.test(n))).toBe(true);
    // …and the generic "which file" hint is still present on this static path.
    expect(result.notes.some((n) => /extra_model_paths\.yaml in the ComfyUI root/i.test(n))).toBe(
      true,
    );
  });

  it("auto target falls back to the saved default workspace when no Desktop config exists", async () => {
    const workspace = await trackTmp();
    const appData = await trackTmp(); // exists, but has no ComfyUI/extra_models_config.yaml
    process.env.APPDATA = appData;
    const cfgPath = await seedConfig(workspace, "loras", "E:/ws/loras");
    await saveDefaultWorkspace(workspace);
    config.comfyuiPath = undefined;

    const result = await listExtraPaths({ target: "auto" });

    expect(result.target).toBe("standalone");
    expect(result.path).toBe(cfgPath);
  });

  it("COMFYUI_PATH still WINS over a saved default workspace", async () => {
    const envRoot = await trackTmp();
    const workspace = await trackTmp();
    const envCfg = await seedConfig(envRoot, "vae", "E:/env/vae");
    await seedConfig(workspace, "vae", "E:/ws/vae");
    await saveDefaultWorkspace(workspace);
    config.comfyuiPath = envRoot;

    const result = await listExtraPaths({ target: "standalone" });

    expect(result.path).toBe(envCfg);
    expect(result.groups[0].categories).toEqual([{ category: "vae", paths: ["E:/env/vae"] }]);
    // No workspace-source note: the active path is the configured one.
    expect(result.notes.some((n) => /saved default workspace/i.test(n))).toBe(false);
  });

  it("mutations honor the saved default workspace too (add writes into it)", async () => {
    const workspace = await trackTmp();
    await saveDefaultWorkspace(workspace);
    config.comfyuiPath = undefined;

    const added = await addExtraPath({
      target: "standalone",
      group: "shared",
      category: "loras",
      path: "E:/ws/loras",
    });

    expect(added.path).toBe(join(workspace, "extra_model_paths.yaml"));
    expect(added.changed).toBe(true);
    const raw = await readFile(join(workspace, "extra_model_paths.yaml"), "utf-8");
    expect(raw).toContain("E:/ws/loras");
  });

  it("is EXPLICITLY unresolved (throws) when there is neither COMFYUI_PATH nor a saved default", async () => {
    config.comfyuiPath = undefined;
    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(/UNRESOLVED/);
    // …and it never degrades to an authoritative-looking empty list.
    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(
      /not an empty config/i,
    );
  });

  it("refuses a local saved default workspace in REMOTE mode (explicitly unresolved)", async () => {
    const workspace = await trackTmp();
    await seedConfig(workspace, "checkpoints", "E:/ws/checkpoints");
    await saveDefaultWorkspace(workspace);
    config.comfyuiPath = undefined;
    mockIsRemoteMode.mockReturnValue(true);

    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(/UNRESOLVED/);
    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(/REMOTE/);
  });

  it("REFUSES a saved default workspace that no longer exists (no phantom listing)", async () => {
    const gone = join(await trackTmp(), "moved-away", "ComfyUI");
    await saveDefaultWorkspace(gone);
    config.comfyuiPath = undefined;

    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(/UNRESOLVED/);
    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(
      /not an existing directory/i,
    );
  });

  it("REFUSES to materialize a vanished saved workspace on add (wrong-destination write)", async () => {
    const parent = await trackTmp();
    const gone = join(parent, "moved-away", "ComfyUI");
    await saveDefaultWorkspace(gone);
    config.comfyuiPath = undefined;

    await expect(
      addExtraPath({ target: "standalone", category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/UNRESOLVED/);
    // The recursive mkdir in writeConfigFile must never have run.
    expect(existsSync(join(parent, "moved-away"))).toBe(false);
  });

  it("REFUSES a saved default workspace that points at a FILE, not a directory", async () => {
    const dir = await trackTmp();
    const notADir = join(dir, "not-a-workspace.txt");
    await writeFile(notADir, "i am a file\n", "utf-8");
    await saveDefaultWorkspace(notADir);
    config.comfyuiPath = undefined;

    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(
      /not an existing directory/i,
    );
  });

  it("REFUSES remove against a vanished saved workspace too (both mutation paths gated)", async () => {
    const parent = await trackTmp();
    const gone = join(parent, "moved-away", "ComfyUI");
    await saveDefaultWorkspace(gone);
    config.comfyuiPath = undefined;

    await expect(
      removeExtraPath({ target: "standalone", category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/UNRESOLVED/);
    expect(existsSync(join(parent, "moved-away"))).toBe(false);
  });

  it("a nonexistent EXPLICIT COMFYUI_PATH is NOT gated (pre-#648 behavior preserved)", async () => {
    // The stale guard covers INFERRED roots only: an explicit COMFYUI_PATH env var is the
    // user directly naming a root, and it has always reported exists:false, not errored.
    const gone = join(await trackTmp(), "no-such-install");
    config.comfyuiPath = gone;
    process.env.COMFYUI_PATH = gone;

    const result = await listExtraPaths({ target: "standalone" });
    expect(result.path).toBe(join(gone, "extra_model_paths.yaml"));
    expect(result.exists).toBe(false);
    expect(result.groups).toEqual([]);
  });

  it("an AUTO-DETECTED comfyuiPath that vanished IS gated (not an explicit user directive)", async () => {
    // config.comfyuiPath can come from startup auto-detection, which can go stale in a
    // long-lived MCP process exactly like a saved workspace (codex round 3, P1b).
    const gone = join(await trackTmp(), "no-such-install");
    config.comfyuiPath = gone;
    delete process.env.COMFYUI_PATH; // → auto-detected

    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(/UNRESOLVED/);
    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(/INFERRED/);
  });

  it("a DESCENDED COMFYUI_PATH (nested root) that vanished IS gated (codex round 4)", async () => {
    // config.ts's descendToNestedRoot turns a Desktop-installer wrapper named by
    // COMFYUI_PATH into <wrapper>/ComfyUI. That nested root is inferred, not named, and
    // can vanish while the wrapper survives — so it must NOT be recreated by mkdir -p.
    const wrapper = await trackTmp();
    const nested = join(wrapper, "ComfyUI");
    process.env.COMFYUI_PATH = wrapper; // what the user set
    config.comfyuiPath = nested; // what config.ts descended to; now gone

    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(/UNRESOLVED/);
    await expect(
      addExtraPath({ target: "standalone", category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/UNRESOLVED/);
    expect(existsSync(nested)).toBe(false);
  });

  it("an UN-descended COMFYUI_PATH is still explicit even with a trailing separator", async () => {
    // Path comparison is normalized, so `D:\ComfyUI\` and `D:\ComfyUI` are the same root
    // and the explicit (ungated) classification is not lost to cosmetics.
    const gone = join(await trackTmp(), "no-such-install");
    config.comfyuiPath = gone;
    process.env.COMFYUI_PATH = `${gone}${sep}`;

    const result = await listExtraPaths({ target: "standalone" });
    expect(result.exists).toBe(false);
  });

  // Matrix: root SOURCE x on-disk STATE x OPERATION. Each row sets up the source, then
  // asserts every operation, so a regression in any single cell is caught (codex round 5).
  type Source = "explicit-env" | "inferred-detected" | "inferred-descended" | "saved-default";

  /** Point the resolver at `root` as `source`; returns the root. */
  async function useRoot(source: Source, root: string): Promise<void> {
    config.comfyuiPath = undefined;
    delete process.env.COMFYUI_PATH;
    if (source === "explicit-env") {
      config.comfyuiPath = root;
      process.env.COMFYUI_PATH = root;
    } else if (source === "inferred-detected") {
      config.comfyuiPath = root; // no env var → startup auto-detection
    } else if (source === "inferred-descended") {
      config.comfyuiPath = root; // config.ts descended COMFYUI_PATH to a nested root
      process.env.COMFYUI_PATH = join(root, "..");
    } else {
      await saveDefaultWorkspace(root);
    }
  }

  const inferred: Source[] = ["inferred-detected", "inferred-descended", "saved-default"];

  for (const source of inferred) {
    it(`${source}: a VANISHED root is refused by list, add and remove alike`, async () => {
      const parent = await trackTmp();
      const gone = join(parent, "wrapper", "ComfyUI");
      await useRoot(source, gone);

      await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(/UNRESOLVED/);
      await expect(
        addExtraPath({ target: "standalone", category: "loras", path: "E:/x" }),
      ).rejects.toThrow(/UNRESOLVED/);
      await expect(
        removeExtraPath({ target: "standalone", category: "loras", path: "E:/x" }),
      ).rejects.toThrow(/UNRESOLVED/);
      expect(existsSync(join(parent, "wrapper"))).toBe(false);
    });

    it(`${source}: an EXISTING root round-trips list -> add -> remove`, async () => {
      const root = await trackTmp();
      await useRoot(source, root);

      const added = await addExtraPath({
        target: "standalone",
        group: "shared",
        category: "loras",
        path: "E:/x",
      });
      expect(added.changed).toBe(true);
      expect(added.path).toBe(join(root, "extra_model_paths.yaml"));

      const listed = await listExtraPaths({ target: "standalone" });
      expect(listed.groups[0].categories).toEqual([{ category: "loras", paths: ["E:/x"] }]);

      const removed = await removeExtraPath({
        target: "standalone",
        group: "shared",
        category: "loras",
        path: "E:/x",
      });
      expect(removed.changed).toBe(true);
    });
  }

  it("explicit-env: a VANISHED root is NOT refused, and add still creates it (pre-#648)", async () => {
    // The deliberate asymmetry: an explicit COMFYUI_PATH is the user naming a root, so it
    // keeps its pre-#648 create-on-write behavior. Pinned so it cannot drift silently.
    const parent = await trackTmp();
    const gone = join(parent, "wrapper", "ComfyUI");
    await useRoot("explicit-env", gone);

    const listed = await listExtraPaths({ target: "standalone" });
    expect(listed.exists).toBe(false);

    const added = await addExtraPath({ target: "standalone", category: "loras", path: "E:/x" });
    expect(added.changed).toBe(true);
    expect(existsSync(join(gone, "extra_model_paths.yaml"))).toBe(true);
  });

  it("an explicit config_path is honored with no workspace lookup at all", async () => {
    const dir = await trackTmp();
    const explicit = join(dir, "custom.yaml");
    await writeFile(explicit, "grp:\n  unet: E:/explicit/unet\n", "utf-8");
    config.comfyuiPath = undefined; // no COMFYUI_PATH, no saved default → still fine

    const result = await listExtraPaths({ configPath: explicit });
    expect(result.path).toBe(explicit);
    expect(result.groups[0].categories).toEqual([{ category: "unet", paths: ["E:/explicit/unet"] }]);
  });
});

describe("a reachable server with NO --extra-model-paths-config is still authoritative", () => {
  /** Make /system_stats report a server running from `root`/main.py, and put a real
   *  main.py there — resolution now PROVES the live root by resolving that file, so a
   *  root we cannot see is refused rather than fabricated. */
  async function liveAt(root: string): Promise<void> {
    await writeFile(join(root, "main.py"), "# comfyui\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({ system: { argv: ["python", join(root, "main.py")] } });
  }

  it("prefers <live root>/extra_model_paths.yaml over an EXISTING saved workspace", async () => {
    // The wrong-TREE case the existence gate cannot catch: workspace A is real, but the
    // live server runs from B and implicitly reads B/extra_model_paths.yaml.
    const workspaceA = await trackTmp();
    const liveB = await trackTmp();
    await writeFile(
      join(workspaceA, "extra_model_paths.yaml"),
      "stale:\n  checkpoints: E:/from-A\n",
      "utf-8",
    );
    await writeFile(
      join(liveB, "extra_model_paths.yaml"),
      "live:\n  checkpoints: E:/from-B\n",
      "utf-8",
    );
    await saveDefaultWorkspace(workspaceA);
    config.comfyuiPath = undefined;
    await liveAt(liveB);

    const result = await listExtraPaths(); // default auto target

    expect(result.path).toBe(join(liveB, "extra_model_paths.yaml"));
    expect(result.groups[0].categories).toEqual([
      { category: "checkpoints", paths: ["E:/from-B"] },
    ]);
    expect(result.notes.some((n) => /RUNNING ComfyUI's own install root/i.test(n))).toBe(true);
    expect(result.notes.some((n) => n.includes(workspaceA) && /silent no-op/i.test(n))).toBe(true);
  });

  it('list_local_models action:"add_path" WRITES into the live root, not the saved workspace', async () => {
    const workspaceA = await trackTmp();
    const liveB = await trackTmp();
    await saveDefaultWorkspace(workspaceA);
    config.comfyuiPath = undefined;
    await liveAt(liveB);

    const added = await addExtraPath({ group: "shared", category: "loras", path: "E:/loras" });

    expect(added.path).toBe(join(liveB, "extra_model_paths.yaml"));
    expect(existsSync(join(liveB, "extra_model_paths.yaml"))).toBe(true);
    expect(existsSync(join(workspaceA, "extra_model_paths.yaml"))).toBe(false);
  });

  it("also beats a COMFYUI_PATH pointing at a different install", async () => {
    const stale = await trackTmp();
    const liveB = await trackTmp();
    config.comfyuiPath = stale;
    process.env.COMFYUI_PATH = stale;
    await liveAt(liveB);

    const result = await listExtraPaths();
    expect(result.path).toBe(join(liveB, "extra_model_paths.yaml"));
  });

  it("does NOT override an explicit target or config_path", async () => {
    const workspaceA = await trackTmp();
    const liveB = await trackTmp();
    await saveDefaultWorkspace(workspaceA);
    config.comfyuiPath = undefined;
    await liveAt(liveB);

    const pinned = await listExtraPaths({ target: "standalone" });
    expect(pinned.path).toBe(join(workspaceA, "extra_model_paths.yaml"));

    const explicit = join(await trackTmp(), "custom.yaml");
    await writeFile(explicit, "g:\n  vae: E:/v\n", "utf-8");
    const byPath = await listExtraPaths({ configPath: explicit });
    expect(byPath.path).toBe(explicit);
  });

  it("the --extra-model-paths-config launch flag still wins over the implicit root", async () => {
    const liveB = await trackTmp();
    const flagged = join(await trackTmp(), "flagged.yaml");
    await writeFile(flagged, "f:\n  vae: E:/flag\n", "utf-8");
    await writeFile(join(liveB, "main.py"), "# comfyui\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: ["python", join(liveB, "main.py"), "--extra-model-paths-config", flagged],
      },
    });

    const result = await listExtraPaths();
    expect(result.path).toBe(flagged);
  });

  it("a RELATIVE launch flag resolves against the SERVER's cwd, not ours", async () => {
    const serverCwd = await trackTmp();
    const liveB = await trackTmp();
    await writeFile(join(serverCwd, "cfg.yaml"), "s:\n  vae: E:/server\n", "utf-8");
    await writeFile(join(liveB, "main.py"), "# comfyui\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: ["python", join(liveB, "main.py"), "--extra-model-paths-config", "cfg.yaml"],
        cwd: serverCwd,
      },
    });

    const result = await listExtraPaths();
    expect(result.path).toBe(join(serverCwd, "cfg.yaml"));
    expect(result.groups[0].categories).toEqual([{ category: "vae", paths: ["E:/server"] }]);
  });

  it("a RELATIVE launch flag with no reported cwd falls back to the root yaml the server also loads", async () => {
    // /system_stats does not report cwd on current ComfyUI, so `cd /opt/ComfyUI &&
    // python main.py --extra-model-paths-config extra.yaml` is an ordinary launch. The
    // flagged file cannot be located from here — but ComfyUI ALSO always auto-loads
    // <root>/extra_model_paths.yaml, so that one is provably read and is safe to target.
    // What must NOT happen is anchoring "cfg.yaml" to our own COMFYUI_PATH.
    const liveB = await trackTmp();
    const stale = await trackTmp();
    config.comfyuiPath = stale;
    process.env.COMFYUI_PATH = stale;
    await writeFile(join(liveB, "main.py"), "# comfyui\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: ["python", join(liveB, "main.py"), "--extra-model-paths-config", "cfg.yaml"],
      },
    });

    const result = await listExtraPaths();
    expect(result.path).toBe(join(liveB, "extra_model_paths.yaml"));
    expect(result.notes.some((n) => /loads this file from its install root/i.test(n))).toBe(true);
    // The unlocatable flagged file is disclosed, not silently omitted.
    expect(result.notes.some((n) => /cfg\.yaml.*not listed here/s.test(n))).toBe(true);

    const added = await addExtraPath({ category: "loras", path: "E:/loras" });
    expect(added.path).toBe(join(liveB, "extra_model_paths.yaml"));
    // Never resolved against OUR comfyuiPath.
    expect(existsSync(join(stale, "cfg.yaml"))).toBe(false);
    expect(existsSync(join(stale, "extra_model_paths.yaml"))).toBe(false);
  });

  it("refuses to WRITE an ABSOLUTE flag when the server's main.py is not on this filesystem", async () => {
    // A container/WSL server behind a loopback port names files on ITS disk. A same-
    // spelled absolute path here is a different file, so nothing argv-derived may be
    // WRITTEN. The read shows it, unconfirmed — see the sibling test below.
    const hostLookalike = join(await trackTmp(), "extra.yaml");
    await writeFile(hostLookalike, "h:\n  vae: E:/host\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: [
          "python",
          "/not/mounted/here/main.py",
          "--extra-model-paths-config",
          hostLookalike,
        ],
      },
    });

    await expect(addExtraPath({ category: "loras", path: "E:/loras" })).rejects.toThrow(
      /UNRESOLVED.*does not resolve to a file on this filesystem/s,
    );
    expect(await readFile(hostLookalike, "utf-8")).toBe("h:\n  vae: E:/host\n");

    const listed = await listExtraPaths();
    expect(listed.path).toBe(hostLookalike);
    expect(listed.notes.join(" ")).toMatch(/NOT CONFIRMED/);
  });

  it("SHOWS an absolute flag whose locality is unproven, unconfirmed — and still refuses to WRITE it (#764)", async () => {
    // The sibling of the case above: a reachable server whose argv has no main.py entry
    // at all (e.g. `python -m comfyui`, or macOS ComfyUI Desktop 2) cannot be correlated
    // with this filesystem. That is a failure to PROVE the file is the server's — not a
    // finding that it is not. Refusing the read reported the second, and rejected a
    // reachable instance whose config was sitting right there (#764 recurrence on
    // 0.49.4/0.49.5). The read now discloses; only the WRITE fails closed.
    const hostLookalike = join(await trackTmp(), "extra.yaml");
    await writeFile(hostLookalike, "h:\n  vae: E:/host\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: ["python", "-m", "comfyui", "--extra-model-paths-config", hostLookalike],
      },
    });

    const listed = await listExtraPaths();
    // It is the SERVER-NAMED file that is read, not the local heuristic's guess.
    expect(listed.path).toBe(hostLookalike);
    expect(listed.groups.map((g) => g.name)).toContain("h");
    // …and the caption says plainly what was not established. Asserting the reason,
    // not just the state: showing the right file with a confident caption would be a
    // different bug wearing the same passing assertion.
    expect(listed.notes.join(" ")).toMatch(/NOT CONFIRMED/);
    expect(listed.notes.join(" ")).toMatch(/could not prove the server's file tree/i);

    // …and the write path refuses, leaving the lookalike file byte-for-byte intact.
    await expect(
      addExtraPath({ category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/UNRESOLVED.*not proven local/s);
    expect(await readFile(hostLookalike, "utf-8")).toBe("h:\n  vae: E:/host\n");
  });

  it("falls back to the local target when the server names a config that does not exist here", async () => {
    // Same unproven state, but the server's path resolves to nothing on this machine —
    // so there is no file to disclose. Show the local auto target instead, and say the
    // server's config is NOT it rather than implying the two are the same.
    const localRoot = await trackTmp();
    config.comfyuiPath = localRoot;
    process.env.COMFYUI_PATH = localRoot;
    const missing = join(await trackTmp(), "nope", "extra.yaml");
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: ["python", "-m", "comfyui", "--extra-model-paths-config", missing],
      },
    });

    const listed = await listExtraPaths();
    expect(listed.path).not.toBe(missing);
    expect(listed.notes.join(" ")).toMatch(/no file exists at that path on this machine/i);
    expect(listed.notes.join(" ")).toMatch(/NOT confirmed to be a file the live server reads/i);
    // The absence is local and current; it does not establish WHY. Both causes are
    // named and neither is asserted.
    expect(listed.notes.join(" ")).toMatch(/moved or deleted after it started/i);
    expect(listed.notes.join(" ")).toMatch(/cannot tell which/i);
    await expect(
      addExtraPath({ category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/UNRESOLVED/);
  });

  it("REFUSES when the ONLY main.py in argv is a flag VALUE (no self-proven locality)", async () => {
    // A main-less `python -m comfyui …` launch whose --extra-model-paths-config value
    // happens to END in main.py — and that same-spelled file exists here. Accepting the
    // config VALUE as the launch script would let it "prove" the server shares this
    // filesystem, after which the tool would read and write that host file. The script
    // token must be the positional launch argument, never a flag's value (#648 review).
    const hostLookalike = join(await trackTmp(), "main.py");
    await writeFile(hostLookalike, "h:\n  vae: E:/host\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: ["python", "-m", "comfyui", "--extra-model-paths-config", hostLookalike],
      },
    });

    // The flag VALUE must never be promoted to "the launch script", so locality stays
    // unproven: the read is an explicitly unconfirmed disclosure, never an authoritative
    // one, and the WRITE still refuses — the lookalike file is byte-for-byte intact.
    const listed = await listExtraPaths();
    expect(listed.serverResolved).not.toBe(true);
    expect(listed.notes.join(" ")).toMatch(/NOT CONFIRMED/);
    await expect(
      addExtraPath({ category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/UNRESOLVED.*not proven local/s);
    expect(await readFile(hostLookalike, "utf-8")).toBe("h:\n  vae: E:/host\n");
  });

  it("discloses the OTHER configs the server also loads (one file is not all of them)", async () => {
    // ComfyUI aggregates every --extra-model-paths-config plus <root>/extra_model_paths.yaml.
    // The tool returns one file, so the others must be named rather than silently omitted.
    const liveB = await trackTmp();
    const cfgDir = await trackTmp();
    const first = join(cfgDir, "one.yaml");
    const second = join(cfgDir, "two.yaml");
    await writeFile(first, "a:\n  vae: E:/a\n", "utf-8");
    await writeFile(second, "b:\n  vae: E:/b\n", "utf-8");
    await writeFile(join(liveB, "main.py"), "# comfyui\n", "utf-8");
    await writeFile(join(liveB, "extra_model_paths.yaml"), "c:\n  vae: E:/c\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: [
          "python",
          join(liveB, "main.py"),
          "--extra-model-paths-config",
          first,
          "--extra-model-paths-config",
          second,
        ],
      },
    });

    const result = await listExtraPaths();

    expect(result.path).toBe(first);
    const disclosure = result.notes.find((n) => /ONE of several configs/i.test(n));
    expect(disclosure).toBeDefined();
    expect(disclosure).toContain(second);
    expect(disclosure).toContain(join(liveB, "extra_model_paths.yaml"));
  });

  it("resolves LATER relative flags against the server cwd, and never offers a raw one as a path", async () => {
    const serverCwd = await trackTmp();
    const liveB = await trackTmp();
    const first = join(await trackTmp(), "one.yaml");
    await writeFile(first, "a:\n  vae: E:/a\n", "utf-8");
    await writeFile(join(serverCwd, "two.yaml"), "b:\n  vae: E:/b\n", "utf-8");
    await writeFile(join(liveB, "main.py"), "# comfyui\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: [
          "python",
          join(liveB, "main.py"),
          "--extra-model-paths-config",
          first,
          "--extra-model-paths-config",
          "two.yaml",
        ],
        cwd: serverCwd,
      },
    });

    const result = await listExtraPaths();
    const disclosure = result.notes.find((n) => /ONE of several configs/i.test(n));
    // The later relative flag is named by its SERVER-resolved absolute path…
    expect(disclosure).toContain(join(serverCwd, "two.yaml"));
    // …never as the bare "two.yaml" the user could paste into config_path.
    expect(disclosure).not.toMatch(/reads two\.yaml|, two\.yaml/);
  });

  it("flags a later relative config as UNLOCATABLE when the server reports no cwd", async () => {
    const liveB = await trackTmp();
    const first = join(await trackTmp(), "one.yaml");
    await writeFile(first, "a:\n  vae: E:/a\n", "utf-8");
    await writeFile(join(liveB, "main.py"), "# comfyui\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: [
          "python",
          join(liveB, "main.py"),
          "--extra-model-paths-config",
          first,
          "--extra-model-paths-config",
          "two.yaml",
        ],
      },
    });

    const result = await listExtraPaths();
    const unlocatable = result.notes.find((n) => /RELATIVE --extra-model-paths-config value/i.test(n));
    expect(unlocatable).toBeDefined();
    expect(unlocatable).toContain('"two.yaml"');
    expect(unlocatable).toMatch(/not usable as config_path/i);
    // It must NOT appear in the "also reads" list as if it were a real path.
    const disclosure = result.notes.find((n) => /ONE of several configs/i.test(n));
    if (disclosure) expect(disclosure).not.toContain("two.yaml");
  });

  it("REFUSES to WRITE a RELATIVE flag with no main.py either — the read degrades instead", async () => {
    const stale = await trackTmp();
    config.comfyuiPath = stale;
    process.env.COMFYUI_PATH = stale;
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["python", "-m", "comfyui", "--extra-model-paths-config", "cfg.yaml"] },
    });

    // A mutation would anchor "cfg.yaml" to the wrong tree, so it still fails closed and
    // creates nothing.
    await expect(
      addExtraPath({ category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/UNRESOLVED.*RELATIVE/s);
    expect(existsSync(join(stale, "cfg.yaml"))).toBe(false);

    // The read shows the local auto target, naming the flag it could not locate — and
    // still writes nothing.
    const listed = await listExtraPaths();
    expect(listed.serverResolved).not.toBe(true);
    expect(listed.notes.join(" ")).toMatch(/RELATIVE --extra-model-paths-config \("cfg\.yaml"\)/);
    expect(listed.notes.join(" ")).toMatch(/not confirmation that the live server reads it/i);
    expect(existsSync(join(stale, "cfg.yaml"))).toBe(false);
  });

  it("lists the local auto target when a reachable local server omits main.py, but keeps mutations fail-closed (#764)", async () => {
    // Current ComfyUI launchers may report `python -m comfyui` rather than main.py in
    // /system_stats. The active API target is already classified local (otherwise the
    // snapshot would be unreachable), so list_auto must not pretend that means remote.
    // A Desktop config is the exact static fallback a user can successfully select with
    // target:"desktop"; it is useful to display, but not proven to be the live server's
    // config and must never be auto-mutated.
    const appData = await trackTmp();
    process.env.APPDATA = appData;
    const desktop = join(appData, "ComfyUI", "extra_models_config.yaml");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(appData, "ComfyUI"), { recursive: true });
    await writeFile(desktop, "desktop:\n  checkpoints: E:/models\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({ system: { argv: ["python", "-m", "comfyui"] } });

    const listed = await listExtraPaths();
    expect(listed.target).toBe("desktop");
    expect(listed.path).toBe(desktop);
    expect(listed.groups[0].categories).toEqual([{ category: "checkpoints", paths: ["E:/models"] }]);
    expect(listed.notes.some((note) => /local and reachable.*fallback.*not confirmation/is.test(note))).toBe(
      true,
    );
    // The fallback is presentation-only: model lookup/removal must not treat its
    // unproven paths as live roots.
    await expect(getExtraModelRoots()).resolves.toEqual([]);

    await expect(addExtraPath({ category: "loras", path: "E:/loras" })).rejects.toThrow(
      /UNRESOLVED.*does not reveal a main\.py/s,
    );
    expect(await readFile(desktop, "utf-8")).toBe("desktop:\n  checkpoints: E:/models\n");
  });

  it("falls back to the static heuristic only when the server is UNREACHABLE", async () => {
    const workspaceA = await trackTmp();
    process.env.APPDATA = await trackTmp(); // no Desktop config → auto picks standalone
    await saveDefaultWorkspace(workspaceA);
    config.comfyuiPath = undefined;
    mockGetSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await listExtraPaths();
    expect(result.path).toBe(join(workspaceA, "extra_model_paths.yaml"));
  });

  it("refuses to WRITE when the live root cannot be resolved from here (container/WSL/another host)", async () => {
    // Reachable server reporting a root whose main.py we cannot see. Falling back to the
    // saved workspace would be exactly the wrong-tree write this branch exists to stop.
    const workspaceA = await trackTmp();
    await saveDefaultWorkspace(workspaceA);
    config.comfyuiPath = undefined;
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["python", join(await trackTmp(), "not-mounted", "main.py")] },
    });

    await expect(
      addExtraPath({ category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/UNRESOLVED.*does not resolve to a file on this filesystem/s);
    // …and it did NOT quietly write into the saved workspace instead.
    expect(existsSync(join(workspaceA, "extra_model_paths.yaml"))).toBe(false);

    // The read degrades to the saved workspace, plainly labelled as unproven — and
    // still writes nothing.
    const listed = await listExtraPaths();
    expect(listed.path).toBe(join(workspaceA, "extra_model_paths.yaml"));
    expect(listed.serverResolved).not.toBe(true);
    expect(existsSync(join(workspaceA, "extra_model_paths.yaml"))).toBe(false);
  });

  // Real symlinks need privileges/Developer Mode on Windows. Skipped rather than
  // silently returning when unavailable, so it can never read as a vacuous pass;
  // extra-paths-root-guard.test.ts proves the same realpath behavior on every platform
  // by scripting realpathSync.
  it.skipIf(!CAN_SYMLINK)(
    "follows a SYMLINKED main.py to the real install root (ComfyUI uses realpath)",
    async () => {
      // ComfyUI locates the implicit config next to os.path.realpath(__file__), so a
      // launcher dir that symlinks main.py must not receive the write.
      const launcher = await trackTmp();
      const real = await trackTmp();
      await writeFile(join(real, "main.py"), "# comfyui\n", "utf-8");
      symlinkSync(join(real, "main.py"), join(launcher, "main.py"), "file");
      mockGetSystemStats.mockResolvedValue({
        system: { argv: ["python", join(launcher, "main.py")] },
      });
      config.comfyuiPath = undefined;

      const added = await addExtraPath({ category: "loras", path: "E:/loras" });
      expect(added.path).toBe(join(real, "extra_model_paths.yaml"));
      expect(existsSync(join(launcher, "extra_model_paths.yaml"))).toBe(false);
    },
  );

  it("ignores the live root in REMOTE mode (it is a path on the remote host)", async () => {
    const liveB = await trackTmp();
    process.env.APPDATA = await trackTmp(); // no Desktop config to fall into
    await liveAt(liveB);
    mockIsRemoteMode.mockReturnValue(true);
    config.comfyuiPath = undefined;

    // No local root is usable in remote mode → explicit UNRESOLVED, never the remote path.
    await expect(listExtraPaths()).rejects.toThrow(/UNRESOLVED/);
  });
});

describe("#1788 — a PINNED target discloses that the running server reads elsewhere", () => {
  // The report: on ComfyUI Desktop, `list_local_models action:"add_path" target:"desktop"`
  // wrote %APPDATA%/ComfyUI/extra_models_config.yaml and answered "Added … Restart
  // ComfyUI to apply it", while `action:"list_paths"` on the same tool had already named
  // the DIFFERENT file the running server was launched with. The write target is the
  // documented escape hatch and stays where the caller pinned it — what changes is that
  // the answer stops promising an effect the running server will never see.

  /** A reachable server launched from `root`/main.py with the given config flags. */
  async function liveServer(root: string, ...flags: string[]): Promise<void> {
    await writeFile(join(root, "main.py"), "# comfyui\n", "utf-8");
    const argv = ["python", join(root, "main.py")];
    for (const f of flags) argv.push("--extra-model-paths-config", f);
    mockGetSystemStats.mockResolvedValue({ system: { argv } });
  }

  async function liveConfigAt(dir: string, name: string): Promise<string> {
    const cfg = join(dir, name);
    await writeFile(cfg, "live:\n  ipadapter: D:/ComfyUI-Shared/models/ipadapter\n", "utf-8");
    return cfg;
  }

  it('add_path target:"desktop" still writes the pinned file but refuses to promise a restart applies it', async () => {
    const appData = await trackTmp();
    process.env.APPDATA = appData;
    const liveRoot = await trackTmp();
    const serverCfg = await liveConfigAt(liveRoot, "instance-model-paths.yaml");
    await liveServer(liveRoot, serverCfg);

    const added = await addExtraPath({
      target: "desktop",
      category: "ipadapter",
      path: "D:/ComfyUI-Shared/models/ipadapter",
    });

    // The escape hatch is intact: the bytes landed exactly where the caller pinned.
    expect(added.path).toBe(join(appData, "ComfyUI", "extra_models_config.yaml"));
    expect(added.changed).toBe(true);
    expect(existsSync(added.path)).toBe(true);
    // …and the answer says the running server does not read it.
    expect(added.notes.some((n) => /RUNNING ComfyUI does not read this file/.test(n))).toBe(true);
    expect(added.notes.join(" ")).toContain(serverCfg);
    expect(added.message).not.toMatch(/Restart ComfyUI to apply it/);
    expect(added.message).toMatch(/does NOT read/);
    expect(added.message).toContain(serverCfg);
  });

  it('list_paths target:"desktop" carries the same disclosure (the READ was never wrong, only silent)', async () => {
    const appData = await trackTmp();
    process.env.APPDATA = appData;
    const liveRoot = await trackTmp();
    const serverCfg = await liveConfigAt(liveRoot, "instance-model-paths.yaml");
    await liveServer(liveRoot, serverCfg);

    const listed = await listExtraPaths({ target: "desktop" });
    expect(listed.path).toBe(join(appData, "ComfyUI", "extra_models_config.yaml"));
    expect(listed.notes.some((n) => /RUNNING ComfyUI does not read this file/.test(n))).toBe(true);
  });

  it("says NOTHING when the pinned file IS the one the server was launched with", async () => {
    const liveRoot = await trackTmp();
    const serverCfg = await liveConfigAt(liveRoot, "instance-model-paths.yaml");
    await liveServer(liveRoot, serverCfg);

    const added = await addExtraPath({
      configPath: serverCfg,
      category: "loras",
      path: "D:/loras",
    });
    expect(added.notes.some((n) => /does not read this file/.test(n))).toBe(false);
    expect(added.message).toMatch(/Restart ComfyUI to apply it/);
  });

  it("says NOTHING when the pinned file is the SECOND --extra-model-paths-config (not just the first)", async () => {
    // The guard must compare the pinned path against EVERY config the server loads.
    // Comparing only the primary resolution — the first flag — would call a live file
    // inert, which is the same wrong-pair defect one level out.
    const liveRoot = await trackTmp();
    const first = await liveConfigAt(liveRoot, "first.yaml");
    const second = await liveConfigAt(liveRoot, "second.yaml");
    await liveServer(liveRoot, first, second);

    const added = await addExtraPath({ configPath: second, category: "vae", path: "D:/vae" });
    expect(added.notes.some((n) => /does not read this file/.test(n))).toBe(false);
    expect(added.message).toMatch(/Restart ComfyUI to apply it/);
  });

  it("says NOTHING about the implicit <root>/extra_model_paths.yaml that does not exist YET", async () => {
    // Pinning it is how a user CREATES it; the next restart then loads it. Calling that
    // edit inert would be exactly backwards.
    const liveRoot = await trackTmp();
    const serverCfg = await liveConfigAt(liveRoot, "instance-model-paths.yaml");
    await liveServer(liveRoot, serverCfg);
    const implicit = join(liveRoot, "extra_model_paths.yaml");
    expect(existsSync(implicit)).toBe(false);

    const added = await addExtraPath({ configPath: implicit, category: "vae", path: "D:/vae" });
    expect(added.notes.some((n) => /does not read this file/.test(n))).toBe(false);
    expect(added.message).toMatch(/Restart ComfyUI to apply it/);
  });

  it("says NOTHING when a RELATIVE flag leaves the server's config set INCOMPLETE", async () => {
    // The server names a config this process cannot locate, so the pinned file's absence
    // from what we CAN name is not evidence the server does not read it. Unknown stays
    // unknown — never a confident "it does not read this".
    const appData = await trackTmp();
    process.env.APPDATA = appData;
    const liveRoot = await trackTmp();
    await liveServer(liveRoot, "relative-cfg.yaml");

    const added = await addExtraPath({
      target: "desktop",
      category: "ipadapter",
      path: "D:/ipadapter",
    });
    expect(added.notes.some((n) => /does not read this file/.test(n))).toBe(false);
    expect(added.message).toMatch(/Restart ComfyUI to apply it/);
  });

  it("says NOTHING when the server is UNREACHABLE (the pin is all there is)", async () => {
    const appData = await trackTmp();
    process.env.APPDATA = appData;
    mockGetSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));

    const added = await addExtraPath({
      target: "desktop",
      category: "ipadapter",
      path: "D:/ipadapter",
    });
    expect(added.path).toBe(join(appData, "ComfyUI", "extra_models_config.yaml"));
    expect(added.notes.some((n) => /does not read this file/.test(n))).toBe(false);
    expect(added.message).toMatch(/Restart ComfyUI to apply it/);
  });

  it("says NOTHING when the server's tree is not proven to be this machine's", async () => {
    // Reachable, but its main.py does not resolve here (container/WSL/another host). The
    // absolute flag value would name a same-spelled file on ITS disk; nothing is proven.
    const appData = await trackTmp();
    process.env.APPDATA = appData;
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: [
          "python",
          join(await trackTmp(), "not-mounted", "main.py"),
          "--extra-model-paths-config",
          "/srv/comfy/extra.yaml",
        ],
      },
    });

    const added = await addExtraPath({
      target: "desktop",
      category: "ipadapter",
      path: "D:/ipadapter",
    });
    expect(added.notes.some((n) => /does not read this file/.test(n))).toBe(false);
    expect(added.message).toMatch(/Restart ComfyUI to apply it/);
  });

  it("remove_path carries the disclosure too (an inert removal is equally a no-op)", async () => {
    const appData = await trackTmp();
    process.env.APPDATA = appData;
    const liveRoot = await trackTmp();
    const serverCfg = await liveConfigAt(liveRoot, "instance-model-paths.yaml");
    await liveServer(liveRoot, serverCfg);
    await addExtraPath({ target: "desktop", category: "vae", path: "D:/vae" });

    const removed = await removeExtraPath({ target: "desktop", category: "vae", path: "D:/vae" });
    expect(removed.changed).toBe(true);
    expect(removed.message).not.toMatch(/Restart ComfyUI to apply it/);
    expect(removed.message).toMatch(/does NOT read/);
  });
});

describe("expandVars — single-pass %VAR% scanner (no placeholder round-trip)", () => {
  const VAR = "CMCP_EXPAND_TEST_VAR";
  const oldValue = process.env[VAR];

  beforeEach(() => {
    process.env[VAR] = "D:\\real";
  });
  afterEach(() => {
    if (oldValue === undefined) delete process.env[VAR];
    else process.env[VAR] = oldValue;
  });

  const cases: Array<[name: string, input: string, expected: string]> = [
    ["%% is an escaped literal %", "%%", "%"],
    ["%%VAR%% is the literal %VAR% form, not the value", `%%${VAR}%%`, `%${VAR}%`],
    ["a defined %VAR% expands", `%${VAR}%`, "D:\\real"],
    ["an UNDEFINED %VAR% stays literal", "%CMCP_NOT_SET_ANYWHERE%", "%CMCP_NOT_SET_ANYWHERE%"],
    ["a defined %VAR% expands mid-path", `C:\\a\\%${VAR}%\\b`, "C:\\a\\D:\\real\\b"],
    // The old implementation swapped `%%` for the literal token "__CMCP_PCT_9f3a__" and
    // restored it afterwards, so an input CONTAINING that token was silently rewritten
    // to `%` — a wrong-destination corruption. A single pass cannot do that.
    [
      "a path containing the old sentinel token survives byte-identical",
      "D:\\models\\__CMCP_PCT_9f3a__\\loras",
      "D:\\models\\__CMCP_PCT_9f3a__\\loras",
    ],
    [
      "a path made of ONLY the old sentinel token survives byte-identical",
      "__CMCP_PCT_9f3a__",
      "__CMCP_PCT_9f3a__",
    ],
    ["an unterminated trailing % is literal", "D:\\models\\100%", "D:\\models\\100%"],
    ["an odd lone % before text is literal", "%not_a_var", "%not_a_var"],
    ["%%% is %% (escape then a lone literal %)", "%%%", "%%"],
    ["no percent at all is untouched", "D:\\plain\\path", "D:\\plain\\path"],
  ];

  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(expandVars(input)).toBe(expected);
    });
  }

  it("round-trips: expanding an already-escaped value does not re-expand it", () => {
    // %%VAR%% → %VAR% (literal); feeding a value that legitimately contains a `%`
    // never turns into machinery on a later pass because there is no later pass.
    expect(expandVars(`%%${VAR}%%`)).toBe(`%${VAR}%`);
  });

  it("${VAR} and $VAR still expand (unchanged, all platforms)", () => {
    expect(expandVars(`\${${VAR}}`)).toBe("D:\\real");
    expect(expandVars(`$${VAR}`)).toBe("D:\\real");
    expect(expandVars("${CMCP_NOT_SET_ANYWHERE}")).toBe("${CMCP_NOT_SET_ANYWHERE}");
  });
});

/**
 * Every base_path spelling whose RESOLUTION CHANGED when the two-pass sentinel expander
 * was replaced by the single-pass CPython-shaped scanner, pinned so the next rewrite
 * cannot drift. Established by exhaustively comparing old vs new over all strings of
 * length <= 7 over {"%", defined var, undefined var, literal}: 3530 inputs differ, in
 * 192 shapes, and EVERY ONE of them contains a doubled "%%" — a base_path with no "%%"
 * is byte-identical under both.
 *
 * The rule that changed: the old code substituted a sentinel for EVERY "%%" in the
 * string BEFORE any variable token was identified, so a "%%" that was really the closing
 * "%" of one variable plus the opening "%" of the next was mis-consumed and everything
 * after it drifted. The scanner decides positionally — "%%" is an escape only when the
 * scan is AT a token boundary — which is what os.path.expandvars (ntpath) does, i.e.
 * what the ComfyUI process that reads the file does.
 */
describe("expandVars — every %VAR% spelling whose resolution changed (pinned)", () => {
  const A = "CMCP_XP_A";
  const B = "CMCP_XP_B";
  const Z = "CMCP_XP_UNDEFINED";
  const VA = "D:\\models";
  const VB = "E:\\extra";
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [A, B, Z]) saved[k] = process.env[k];
    process.env[A] = VA;
    process.env[B] = VB;
    delete process.env[Z];
  });
  afterEach(() => {
    for (const k of [A, B, Z]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // [spelling, old result (for the record), new result = CPython/ComfyUI]
  const changed: Array<[input: string, old: string, expected: string]> = [
    [`%${A}%%${B}%`, `%${A}%${B}%`, `${VA}${VB}`],
    [`%${A}%%${Z}%`, `%${A}%${Z}%`, `${VA}%${Z}%`],
    [`%${A}%%${A}%`, `%${A}%${A}%`, `${VA}${VA}`],
    [`%${A}%%`, `%${A}%`, `${VA}%`],
    [`%${A}%%%`, `%${A}%%`, `${VA}%`],
    [`%${A}%%%${B}%`, `%${A}%%${B}%`, `${VA}%${B}%`],
    [`%${A}%%%%${B}%`, `%${A}%%${B}%`, `${VA}%${VB}`],
    [`%%%${A}%%`, `%%${A}%`, `%${VA}%`],
    [`%%${A}%${B}%%`, `%${A}%${B}%`, `%${A}${VB}%`],
    // The sentinel collision itself: a path literally containing the old placeholder.
    ["__CMCP_PCT_9f3a__", "%", "__CMCP_PCT_9f3a__"],
  ];

  for (const [input, old, expected] of changed) {
    it(`CHANGED ${JSON.stringify(input)}: was ${JSON.stringify(old)} -> now ${JSON.stringify(expected)}`, () => {
      expect(expandVars(input)).toBe(expected);
      expect(expandVars(input)).not.toBe(old);
    });
  }

  // Spellings the rewrite did NOT change. Pinned so a future "simplification" cannot
  // quietly move them either — these are the forms real configs actually use.
  const unchanged: Array<[input: string, expected: string]> = [
    ["%%", "%"],
    [`%%${A}%%`, `%${A}%`],
    [`%${A}%`, VA],
    [`%${Z}%`, `%${Z}%`],
    [`%${A}`, `%${A}`],
    ["%%%", "%%"],
    // The realistic "escaped percent inside a folder name" case — identical before/after.
    ["D:\\100%%\\models", "D:\\100%\\models"],
    ["D:\\100%\\models", "D:\\100%\\models"],
    ["D:\\plain\\path", "D:\\plain\\path"],
  ];

  for (const [input, expected] of unchanged) {
    it(`UNCHANGED ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(expandVars(input)).toBe(expected);
    });
  }
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, stat as statFile, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// getLiveExtraModelRoots is the FAIL-CLOSED authorization primitive for #633: only a
// reachable, server-authoritative config may authorize an escaping-symlink download.
// It takes the SINGLE live /system_stats snapshot the caller already used (one
// consistent server state) and trusts ONLY: ABSOLUTE --extra-model-paths-config flag
// files + the live install's own extra_model_paths.yaml (its main.py dir) + Desktop's
// extra_models_config.yaml when that snapshot already named a Desktop extra-path
// config. A relative flag value, a stale local workspace config, or an unreachable
// server authorize nothing (codex P0d).

vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined as string | undefined },
  isRemoteMode: () => false,
}));

// Pin win32 so Desktop extra_models_config.yaml is reached via APPDATA, not
// ~/Library or XDG, and tests never read the developer's real extra-path file.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: () => "win32" };
});

import {
  getLaunchStateExtraModelRoots,
  getLiveExtraModelRoots,
} from "../../services/extra-paths.js";
import type { LiveServerSnapshot } from "../../services/output-dir.js";
import {
  markLocalComfyUILaunched,
  resetLocalComfyUILaunchState,
} from "../../services/workspace-env.js";

let dirs: string[] = [];
const originalAppData = process.env.APPDATA;
async function trackTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "comfyui-live-roots-"));
  dirs.push(dir);
  return dir;
}
const reachable = (argv: string[], cwd?: string): LiveServerSnapshot => ({
  reachable: true,
  argv,
  cwd,
});

beforeEach(async () => {
  dirs = [];
  resetLocalComfyUILaunchState(); // default: server NOT MCP-launched → env untrusted
  process.env.APPDATA = await trackTmp();
});
afterEach(async () => {
  resetLocalComfyUILaunchState();
  if (originalAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originalAppData;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("getLiveExtraModelRoots — fail-closed authorization", () => {
  it("returns { authoritative: false, roots: [] } when the server is unreachable", async () => {
    const res = await getLiveExtraModelRoots({ reachable: false });
    expect(res.authoritative).toBe(false);
    expect(res.roots).toEqual([]);
  });

  it("reads an ABSOLUTE --extra-model-paths-config file the server was launched with", async () => {
    const cfgDir = await trackTmp();
    const cfgPath = join(cfgDir, "shared_model_paths.yaml");
    const external = resolve("/Volumes/Render/00_AI/models/unet");
    await writeFile(cfgPath, ["comfyui:", `  unet: ${external}`].join("\n"), "utf-8");

    const res = await getLiveExtraModelRoots(
      reachable(["python", "main.py", "--extra-model-paths-config", cfgPath]),
    );
    expect(res.authoritative).toBe(true);
    expect(res.roots).toContainEqual({ category: "unet", dir: external, group: "comfyui" });
  });

  it("reads a launch-named config for deletion only when its launch state is provable", async () => {
    const cfgDir = await trackTmp();
    const cfgPath = join(cfgDir, "shared_model_paths.yaml");
    const external = resolve("/Volumes/Render/00_AI/models/diffusion_models");
    await writeFile(cfgPath, ["comfyui:", `  diffusion_models: ${external}`].join("\n"), "utf-8");
    const created = await statFile(cfgPath);
    const processStartedAtMs = Math.max(created.mtimeMs, created.ctimeMs) + 1;

    const res = await getLaunchStateExtraModelRoots({
      ...reachable(["python", "main.py", "--extra-model-paths-config", cfgPath]),
      processStartedAtMs,
    });

    expect(res.authoritative).toBe(true);
    expect(res.roots).toContainEqual({
      category: "diffusion_models",
      dir: external,
      group: "comfyui",
    });
  });

  it("rejects a current config changed after launch instead of authorizing its new root", async () => {
    const cfgDir = await trackTmp();
    const cfgPath = join(cfgDir, "shared_model_paths.yaml");
    await writeFile(cfgPath, ["comfyui:", "  diffusion_models: /launch/root"].join("\n"), "utf-8");
    const initial = await statFile(cfgPath);
    const processStartedAtMs = Math.max(initial.mtimeMs, initial.ctimeMs) + 1;
    await writeFile(cfgPath, ["comfyui:", "  diffusion_models: /mutable/root"].join("\n"), "utf-8");
    const changedAt = processStartedAtMs + 2_000;
    await utimes(cfgPath, new Date(changedAt), new Date(changedAt));

    const res = await getLaunchStateExtraModelRoots({
      ...reachable(["python", "main.py", "--extra-model-paths-config", cfgPath]),
      processStartedAtMs,
    });

    expect(res.authoritative).toBe(false);
    expect(res.roots).toEqual([]);
  });

  it("includes Desktop extra_models_config.yaml when argv already named a Desktop extra-path config", async () => {
    const appData = process.env.APPDATA!;
    const desktopDir = join(appData, "Comfy Desktop");
    const sharedCfg = join(desktopDir, "shared_model_paths.yaml");
    const extraCfg = join(appData, "ComfyUI", "extra_models_config.yaml");
    const sharedRoot = resolve("/ComfyUI-Shared/models/diffusion_models");
    const extraRoot = resolve("/user-extra/models/diffusion_models");
    await mkdir(desktopDir, { recursive: true });
    await mkdir(join(appData, "ComfyUI"), { recursive: true });
    await writeFile(sharedCfg, ["desktop:", `  diffusion_models: ${sharedRoot}`].join("\n"), "utf-8");
    await writeFile(extraCfg, ["user_extra:", `  diffusion_models: ${extraRoot}`].join("\n"), "utf-8");
    const created = await statFile(extraCfg);
    const processStartedAtMs = Math.max(created.mtimeMs, created.ctimeMs) + 1;

    const res = await getLaunchStateExtraModelRoots({
      ...reachable(["python", "main.py", "--extra-model-paths-config", sharedCfg]),
      processStartedAtMs,
    });

    expect(res.authoritative).toBe(true);
    expect(res.roots).toContainEqual({
      category: "diffusion_models",
      dir: sharedRoot,
      group: "desktop",
    });
    expect(res.roots).toContainEqual({
      category: "diffusion_models",
      dir: extraRoot,
      group: "user_extra",
    });
  });

  it("does not invent Desktop extra_models_config.yaml from a non-Desktop extra-path flag", async () => {
    const appData = process.env.APPDATA!;
    const extraCfg = join(appData, "ComfyUI", "extra_models_config.yaml");
    const extraRoot = resolve("/user-extra/models/diffusion_models");
    await mkdir(join(appData, "ComfyUI"), { recursive: true });
    await writeFile(extraCfg, ["user_extra:", `  diffusion_models: ${extraRoot}`].join("\n"), "utf-8");
    const cfgDir = await trackTmp();
    const cfgPath = join(cfgDir, "shared_model_paths.yaml");
    const sharedRoot = resolve("/not-desktop/models/diffusion_models");
    await writeFile(cfgPath, ["comfyui:", `  diffusion_models: ${sharedRoot}`].join("\n"), "utf-8");

    const res = await getLiveExtraModelRoots(
      reachable(["python", "main.py", "--extra-model-paths-config", cfgPath]),
    );
    expect(res.roots).toContainEqual({
      category: "diffusion_models",
      dir: sharedRoot,
      group: "comfyui",
    });
    expect(res.roots).not.toContainEqual({
      category: "diffusion_models",
      dir: extraRoot,
      group: "user_extra",
    });
  });

  it("does not authorize Desktop extra_models_config.yaml changed after launch", async () => {
    const appData = process.env.APPDATA!;
    const desktopDir = join(appData, "Comfy Desktop");
    const sharedCfg = join(desktopDir, "shared_model_paths.yaml");
    const extraCfg = join(appData, "ComfyUI", "extra_models_config.yaml");
    const sharedRoot = resolve("/ComfyUI-Shared/models/diffusion_models");
    await mkdir(desktopDir, { recursive: true });
    await mkdir(join(appData, "ComfyUI"), { recursive: true });
    await writeFile(sharedCfg, ["desktop:", `  diffusion_models: ${sharedRoot}`].join("\n"), "utf-8");
    await writeFile(extraCfg, ["user_extra:", "  diffusion_models: /launch/extra"].join("\n"), "utf-8");
    const sharedStat = await statFile(sharedCfg);
    const extraStat = await statFile(extraCfg);
    const processStartedAtMs =
      Math.max(sharedStat.mtimeMs, sharedStat.ctimeMs, extraStat.mtimeMs, extraStat.ctimeMs) + 1;
    await writeFile(extraCfg, ["user_extra:", "  diffusion_models: /mutable/extra"].join("\n"), "utf-8");
    const changedAt = processStartedAtMs + 2_000;
    await utimes(extraCfg, new Date(changedAt), new Date(changedAt));

    const res = await getLaunchStateExtraModelRoots({
      ...reachable(["python", "main.py", "--extra-model-paths-config", sharedCfg]),
      processStartedAtMs,
    });

    expect(res.authoritative).toBe(true);
    expect(res.roots).toContainEqual({
      category: "diffusion_models",
      dir: sharedRoot,
      group: "desktop",
    });
    expect(res.roots.map((r) => r.dir)).not.toContain(resolve("/launch/extra"));
    expect(res.roots.map((r) => r.dir)).not.toContain(resolve("/mutable/extra"));
  });

  it("does not authorize an implicit config beside an OS-observed root", async () => {
    const liveRoot = await trackTmp();
    const cfgPath = join(liveRoot, "extra_model_paths.yaml");
    await writeFile(cfgPath, ["comfyui:", "  diffusion_models: /observed/root"].join("\n"), "utf-8");
    const created = await statFile(cfgPath);

    const res = await getLaunchStateExtraModelRoots({
      ...reachable(["python", "ComfyUI/main.py"]),
      liveRoot,
      liveRootSource: "observed-process",
      processStartedAtMs: Math.max(created.mtimeMs, created.ctimeMs) + 1,
    });

    expect(res.authoritative).toBe(false);
    expect(res.roots).toEqual([]);
  });

  it("SKIPS a RELATIVE --extra-model-paths-config value (can't anchor to the live server → fail closed)", async () => {
    // A relative flag value must not be resolved against the MCP process / stale
    // COMFYUI_PATH and read — that is exactly the stale-config authorization bypass.
    const res = await getLiveExtraModelRoots(
      reachable(["python", "main.py", "--extra-model-paths-config", "paths.yaml"]),
    );
    expect(res.authoritative).toBe(true);
    expect(res.roots).toEqual([]);
  });

  it("reads <live main.py root>/extra_model_paths.yaml (the auto-loaded default)", async () => {
    const liveRoot = await trackTmp();
    const external = resolve("/mnt/models/loras");
    await writeFile(
      join(liveRoot, "extra_model_paths.yaml"),
      ["grp:", `  loras: ${external}`].join("\n"),
      "utf-8",
    );
    const res = await getLiveExtraModelRoots(reachable(["python", join(liveRoot, "main.py")]));
    expect(res.authoritative).toBe(true);
    expect(res.roots).toContainEqual({ category: "loras", dir: external, group: "grp" });
  });

  it("retains the configured group base_path as a generic models root (#2787)", async () => {
    const liveRoot = await trackTmp();
    const extraModels = resolve("/Volumes/Shared/models");
    await writeFile(
      join(liveRoot, "extra_model_paths.yaml"),
      ["shared:", `  base_path: ${extraModels}`, "  poses: poses/"].join("\n"),
      "utf-8",
    );
    const res = await getLiveExtraModelRoots(reachable(["python", join(liveRoot, "main.py")]));
    expect(res.authoritative).toBe(true);
    expect(res.roots).toContainEqual({
      category: "models",
      dir: extraModels,
      group: "shared",
    });
    expect(res.roots).toContainEqual({
      category: "poses",
      dir: resolve(extraModels, "poses"),
      group: "shared",
    });
  });

  it("does not treat a custom_nodes-only group base_path as a models download root (#2787)", async () => {
    const liveRoot = await trackTmp();
    const codeRoot = resolve("/opt/custom-nodes-base");
    await writeFile(
      join(liveRoot, "extra_model_paths.yaml"),
      ["code:", `  base_path: ${codeRoot}`, "  custom_nodes: nodes/"].join("\n"),
      "utf-8",
    );
    const res = await getLiveExtraModelRoots(reachable(["python", join(liveRoot, "main.py")]));
    expect(res.roots).toContainEqual({
      category: "custom_nodes",
      dir: resolve(codeRoot, "nodes"),
      group: "code",
    });
    expect(res.roots).not.toContainEqual({
      category: "models",
      dir: codeRoot,
      group: "code",
    });
  });

  it("resolves a RELATIVE base_path against the config file's OWN dir (like ComfyUI), not the MCP cwd", async () => {
    const liveRoot = await trackTmp();
    await writeFile(
      join(liveRoot, "extra_model_paths.yaml"),
      ["grp:", "  base_path: sub", "  unet: nested"].join("\n"),
      "utf-8",
    );
    const res = await getLiveExtraModelRoots(reachable(["python", join(liveRoot, "main.py")]));
    expect(res.roots).toContainEqual({
      category: "unet",
      dir: resolve(liveRoot, "sub", "nested"),
      group: "grp",
    });
  });

  it("does NOT read a stale config that is neither a launched flag file nor the live root default", async () => {
    const staleDir = await trackTmp();
    await writeFile(
      join(staleDir, "extra_model_paths.yaml"),
      ["grp:", "  unet: /escape/here"].join("\n"),
      "utf-8",
    );
    const liveRoot = await trackTmp(); // live root has NO extra config
    const res = await getLiveExtraModelRoots(reachable(["python", join(liveRoot, "main.py")]));
    expect(res.authoritative).toBe(true);
    expect(res.roots).toEqual([]);
  });

  it("is authoritative-but-empty when the server is reachable with no extra config", async () => {
    const res = await getLiveExtraModelRoots(reachable(["python", "main.py"]));
    expect(res.authoritative).toBe(true);
    expect(res.roots).toEqual([]);
  });

  it("expands a base_path '~' to the home dir (ComfyUI expanduser) → ABSOLUTE, not <cfgDir>/~", async () => {
    const liveRoot = await trackTmp();
    await writeFile(
      join(liveRoot, "extra_model_paths.yaml"),
      ["grp:", '  base_path: "~/models"', "  unet: unet"].join("\n"),
      "utf-8",
    );
    const res = await getLiveExtraModelRoots(reachable(["python", join(liveRoot, "main.py")]));
    expect(res.roots).toContainEqual({
      category: "unet",
      dir: resolve(homedir(), "models", "unet"),
      group: "grp",
    });
  });

  it("expands an env var in base_path ONLY for a local MCP-launched server (env shared)", async () => {
    const liveRoot = await trackTmp();
    const target = resolve("/opt/models-root");
    process.env.CMCP_TEST_MODELS_ROOT = target;
    markLocalComfyUILaunched(); // this MCP launched the local server → env trusted
    try {
      await writeFile(
        join(liveRoot, "extra_model_paths.yaml"),
        ["grp:", '  base_path: "${CMCP_TEST_MODELS_ROOT}"', "  loras: loras"].join("\n"),
        "utf-8",
      );
      const res = await getLiveExtraModelRoots(reachable(["python", join(liveRoot, "main.py")]));
      expect(res.roots).toContainEqual({
        category: "loras",
        dir: resolve(target, "loras"),
        group: "grp",
      });
    } finally {
      delete process.env.CMCP_TEST_MODELS_ROOT;
    }
  });

  it("P1b: does NOT authorize a $VAR base_path when the server env is NOT trusted (not MCP-launched)", async () => {
    const liveRoot = await trackTmp();
    process.env.CMCP_TEST_MODELS_ROOT = resolve("/opt/models-root");
    // NB: markLocalComfyUILaunched() is NOT called → env untrusted → fail closed.
    try {
      await writeFile(
        join(liveRoot, "extra_model_paths.yaml"),
        ["grp:", '  base_path: "${CMCP_TEST_MODELS_ROOT}"', "  loras: loras"].join("\n"),
        "utf-8",
      );
      const res = await getLiveExtraModelRoots(reachable(["python", join(liveRoot, "main.py")]));
      expect(res.authoritative).toBe(true);
      expect(res.roots).toEqual([]); // the whole group is dropped (unresolvable base_path)
    } finally {
      delete process.env.CMCP_TEST_MODELS_ROOT;
    }
  });

  it("P1a: authorizes the SAME literal path ComfyUI registers — expanduser THEN expandvars, base_path ONLY", async () => {
    // base_path: $ROOT with ROOT=~/models. ComfyUI expands base_path expanduser FIRST
    // (no ~ present) THEN expandvars → literal "~/models" (the leading ~ is NOT
    // re-expanded), so it registers <cfgDir>/~/models — NOT <home>/models. Our
    // authorization must match that literal path, not over-expand.
    const liveRoot = await trackTmp();
    process.env.CMCP_TEST_ROOT = "~/models";
    markLocalComfyUILaunched();
    try {
      await writeFile(
        join(liveRoot, "extra_model_paths.yaml"),
        ["grp:", '  base_path: "$CMCP_TEST_ROOT"', "  unet: unet"].join("\n"),
        "utf-8",
      );
      const res = await getLiveExtraModelRoots(reachable(["python", join(liveRoot, "main.py")]));
      const cfgDir = liveRoot;
      // The literal-~ path ComfyUI would register…
      expect(res.roots).toContainEqual({
        category: "unet",
        dir: resolve(cfgDir, "~/models", "unet"),
        group: "grp",
      });
      // …NOT the over-expanded home path (the old vars-then-user bug).
      expect(res.roots).not.toContainEqual({
        category: "unet",
        dir: resolve(homedir(), "models", "unet"),
        group: "grp",
      });
    } finally {
      delete process.env.CMCP_TEST_ROOT;
    }
  });

  it("P1b: treats a $DIGIT-style var as a token (Python \\w+ fidelity) → group dropped when untrusted", async () => {
    // base_path: $9models. Python's expandvars accepts a digit-led name; if we didn't,
    // an untrusted server's config would be mis-treated as a literal local path instead
    // of failing closed. NOT MCP-launched → untrusted → the whole group is dropped.
    const liveRoot = await trackTmp();
    await writeFile(
      join(liveRoot, "extra_model_paths.yaml"),
      ["grp:", '  base_path: "$9models"', "  unet: unet"].join("\n"),
      "utf-8",
    );
    const res = await getLiveExtraModelRoots(reachable(["python", join(liveRoot, "main.py")]));
    expect(res.roots).toEqual([]);
  });

  // Windows drive-relative join: `os.path.join("D:\\base", "\\unet")` → `D:\\unet`
  // (the `\unet` takes its DRIVE from base, not the MCP process's current drive).
  const winIt = process.platform === "win32" ? it : it.skip;
  winIt(
    "joins a drive-relative category entry to base_path's DRIVE (D:\\base + \\unet → D:\\unet)",
    async () => {
      const liveRoot = await trackTmp();
      await writeFile(
        join(liveRoot, "extra_model_paths.yaml"),
        ["grp:", "  base_path: D:\\base", "  unet: \\unet"].join("\n"),
        "utf-8",
      );
      const res = await getLiveExtraModelRoots(reachable(["python", join(liveRoot, "main.py")]));
      // Authorizes D:\unet (base's drive), NOT C:\unet (the MCP process drive).
      expect(res.roots).toContainEqual({ category: "unet", dir: "D:\\unet", group: "grp" });
      expect(res.roots).not.toContainEqual({ category: "unet", dir: resolve("\\unet"), group: "grp" });
    },
  );

  winIt(
    "joins a drive-relative entry to a UNC base_path's SHARE (\\\\srv\\share\\base + \\unet → \\\\srv\\share\\unet)",
    async () => {
      const liveRoot = await trackTmp();
      await writeFile(
        join(liveRoot, "extra_model_paths.yaml"),
        ["grp:", "  base_path: \\\\srv\\share\\base", "  unet: \\unet"].join("\n"),
        "utf-8",
      );
      const res = await getLiveExtraModelRoots(reachable(["python", join(liveRoot, "main.py")]));
      expect(res.roots).toContainEqual({
        category: "unet",
        dir: "\\\\srv\\share\\unet",
        group: "grp",
      });
    },
  );

  winIt(
    "%VAR% expands and %%VAR%% is an escaped literal % (percent-sentinel round-trips)",
    async () => {
      const liveRoot = await trackTmp();
      const target = resolve("D:\\real");
      process.env.CMCP_PCT_VAR = target;
      markLocalComfyUILaunched();
      try {
        await writeFile(
          join(liveRoot, "extra_model_paths.yaml"),
          [
            "expand:",
            '  base_path: "%CMCP_PCT_VAR%"',
            "  unet: unet",
            "escaped:",
            '  base_path: "%%CMCP_PCT_VAR%%"',
            "  vae: vae",
          ].join("\n"),
          "utf-8",
        );
        const res = await getLiveExtraModelRoots(reachable(["python", join(liveRoot, "main.py")]));
        // %VAR% expands to the env value…
        expect(res.roots).toContainEqual({
          category: "unet",
          dir: resolve(target, "unet"),
          group: "expand",
        });
        // …%%VAR%% is an ESCAPED literal `%CMCP_PCT_VAR%` (not the expanded value),
        // proving the percent sentinel round-trips without leaking or over-expanding.
        expect(res.roots).toContainEqual({
          category: "vae",
          dir: resolve(liveRoot, "%CMCP_PCT_VAR%", "vae"),
          group: "escaped",
        });
      } finally {
        delete process.env.CMCP_PCT_VAR;
      }
    },
  );

  it("P1a: does NOT expand a $VAR in a per-category entry (ComfyUI leaves subpaths literal)", async () => {
    const liveRoot = await trackTmp();
    const baseAbs = resolve("/opt/base");
    process.env.CMCP_TEST_SUB = "should-not-expand";
    markLocalComfyUILaunched();
    try {
      await writeFile(
        join(liveRoot, "extra_model_paths.yaml"),
        ["grp:", `  base_path: ${baseAbs}`, '  unet: "$CMCP_TEST_SUB"'].join("\n"),
        "utf-8",
      );
      const res = await getLiveExtraModelRoots(reachable(["python", join(liveRoot, "main.py")]));
      // The category entry stays LITERAL "$CMCP_TEST_SUB", resolved under base.
      expect(res.roots).toContainEqual({
        category: "unet",
        dir: resolve(baseAbs, "$CMCP_TEST_SUB"),
        group: "grp",
      });
    } finally {
      delete process.env.CMCP_TEST_SUB;
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAbsolute, join, resolve } from "node:path";

let remoteMode = false;
vi.mock("../../config.js", () => ({
  config: { comfyuiPath: "/comfy" as string | undefined },
  isRemoteMode: () => remoteMode,
}));

// resolveModelsDir only adopts an argv-derived live root when it EXISTS locally
// (a Docker/forwarded server's container path must NOT be treated as host-local).
// Control existence per test; default true so the live-root paths resolve.
let liveRootExists = true;
vi.mock("node:fs", () => ({
  existsSync: () => liveRootExists,
}));

const getSystemStats = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: (...a: unknown[]) => getSystemStats(...a),
}));

// resolveModelsDir's local fallback (COMFYUI_PATH → default workspace) is resolved
// through the shared helper; back it by the mocked config + a settable default
// workspace so tests can exercise the "no COMFYUI_PATH but a default workspace" path.
// liveRootFromArgv is the REAL implementation (pure argv parsing) so the live-first
// resolution (#490/#463) is exercised end to end, not stubbed away.
let savedDefaultWorkspace: string | undefined;
// #369: the models dir is now resolved through the ONE canonical live-root resolver
// (argv first, then the OS-observed live process). Back it with the REAL argv parsing
// plus a CONTROLLABLE observed-process anchor and base-entrypoint probe, so the
// live-vs-stale selection is exercised end to end without a unit test shelling out to
// the OS process table.
let observedLiveRoot: string | undefined;
let baseHasEntrypoint = false;
/** Per-DIRECTORY entrypoint probe (#813). The flat `baseHasEntrypoint` boolean
 *  cannot express the case the bug is about — `<base>/main.py` existing while
 *  `<base>/ComfyUI/main.py` does not — so tests that need to tell the two
 *  candidate anchors apart install a predicate here. Default keeps every
 *  pre-existing test on the flat boolean. */
let hasEntrypointFor: ((dir: string) => boolean) | undefined;
vi.mock("../../services/workspace-env.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../services/workspace-env.js")
  >("../../services/workspace-env.js");
  return {
    resolveEffectiveComfyUIBase: () => config.comfyuiPath ?? savedDefaultWorkspace,
    liveRootFromArgv: actual.liveRootFromArgv,
    hasComfyUIEntrypoint: (dir: string) =>
      hasEntrypointFor ? hasEntrypointFor(dir) : baseHasEntrypoint,
    resolveLiveServerRoot: (argv?: string[], cwd?: string) => {
      const relDir = actual.liveRelDirFromArgv(argv);
      const fromArgv = actual.liveRootFromArgv(argv, cwd);
      if (fromArgv) return { root: fromArgv, source: "argv", relDir };
      if (observedLiveRoot) {
        return {
          root: observedLiveRoot,
          source: "observed-process",
          relDir,
          observedPython: resolve("/live/python_embeded/python.exe"),
        };
      }
      return { source: "unresolved", relDir };
    },
  };
});

import {
  parseOutputDirFromArgv,
  localOutputDirFallback,
  resolveOutputDir,
  parseInputDirFromArgv,
  localInputDirFallback,
  resolveInputDir,
  parseBaseDirFromArgv,
  parseModelsDirFromArgv,
  parseExtraModelPathsConfigsFromArgv,
  hasUnresolvableRelativeModelDirFlag,
  resolveModelsDir,
  resolveModelsDirWithBases,
  resolveServerExtraModelConfig,
} from "../../services/output-dir.js";
import { config } from "../../config.js";

beforeEach(() => {
  getSystemStats.mockReset();
  (config as { comfyuiPath?: string }).comfyuiPath = "/comfy";
  savedDefaultWorkspace = undefined;
  remoteMode = false;
  liveRootExists = true;
  observedLiveRoot = undefined;
  baseHasEntrypoint = false;
  hasEntrypointFor = undefined;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("parseOutputDirFromArgv", () => {
  it("returns undefined when no relevant flags are present", () => {
    expect(parseOutputDirFromArgv(["python", "main.py", "--listen"])).toBeUndefined();
    expect(parseOutputDirFromArgv([])).toBeUndefined();
    expect(parseOutputDirFromArgv(undefined)).toBeUndefined();
  });

  it("parses --output-directory <value>", () => {
    const abs = resolve("/shared/ComfyUI-Shared/output");
    const got = parseOutputDirFromArgv(["main.py", "--output-directory", abs]);
    expect(got).toBe(abs);
  });

  it("parses --output-directory=<value>", () => {
    const abs = resolve("/shared/out");
    expect(parseOutputDirFromArgv(["main.py", `--output-directory=${abs}`])).toBe(abs);
  });

  it("derives <base>/output from --base-directory", () => {
    const base = resolve("/srv/comfy-base");
    expect(parseOutputDirFromArgv(["main.py", "--base-directory", base])).toBe(
      join(base, "output"),
    );
  });

  it("lets --output-directory win over --base-directory", () => {
    const base = resolve("/srv/base");
    const out = resolve("/srv/explicit-out");
    const got = parseOutputDirFromArgv([
      "main.py",
      "--base-directory",
      base,
      "--output-directory",
      out,
    ]);
    expect(got).toBe(out);
  });
});

describe("localOutputDirFallback", () => {
  it("returns <COMFYUI_PATH>/output", () => {
    expect(localOutputDirFallback()).toBe(resolve("/comfy", "output"));
  });

  it("throws when COMFYUI_PATH is unset", () => {
    (config as { comfyuiPath?: string }).comfyuiPath = undefined;
    expect(() => localOutputDirFallback()).toThrow(/COMFYUI_PATH/);
  });
});

describe("resolveOutputDir", () => {
  it("uses the redirected dir reported by /system_stats argv", async () => {
    const redirected = resolve("/shared/ComfyUI-Shared/output");
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--output-directory", redirected] },
    });
    const got = await resolveOutputDir();
    expect(got).toBe(redirected);
    expect(got).not.toBe(resolve("/comfy", "output"));
    expect(isAbsolute(got)).toBe(true);
  });

  it("falls back to <COMFYUI_PATH>/output when argv has no override", async () => {
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    expect(await resolveOutputDir()).toBe(resolve("/comfy", "output"));
  });

  it("falls back to <COMFYUI_PATH>/output when /system_stats is unreachable", async () => {
    getSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await resolveOutputDir()).toBe(resolve("/comfy", "output"));
  });
});

describe("parseInputDirFromArgv", () => {
  it("returns undefined when no relevant flags are present", () => {
    expect(parseInputDirFromArgv(["python", "main.py", "--listen"])).toBeUndefined();
    expect(parseInputDirFromArgv([])).toBeUndefined();
    expect(parseInputDirFromArgv(undefined)).toBeUndefined();
  });

  it("parses --input-directory <value>", () => {
    const abs = resolve("/shared/ComfyUI-Shared/input");
    const got = parseInputDirFromArgv(["main.py", "--input-directory", abs]);
    expect(got).toBe(abs);
  });

  it("parses --input-directory=<value>", () => {
    const abs = resolve("/shared/in");
    expect(parseInputDirFromArgv(["main.py", `--input-directory=${abs}`])).toBe(abs);
  });

  it("derives <base>/input from --base-directory", () => {
    const base = resolve("/srv/comfy-base");
    expect(parseInputDirFromArgv(["main.py", "--base-directory", base])).toBe(
      join(base, "input"),
    );
  });

  it("lets --input-directory win over --base-directory", () => {
    const base = resolve("/srv/base");
    const inp = resolve("/srv/explicit-in");
    const got = parseInputDirFromArgv([
      "main.py",
      "--base-directory",
      base,
      "--input-directory",
      inp,
    ]);
    expect(got).toBe(inp);
  });
});

describe("localInputDirFallback", () => {
  it("returns <COMFYUI_PATH>/input", () => {
    expect(localInputDirFallback()).toBe(resolve("/comfy", "input"));
  });

  it("throws when COMFYUI_PATH is unset", () => {
    (config as { comfyuiPath?: string }).comfyuiPath = undefined;
    expect(() => localInputDirFallback()).toThrow(/COMFYUI_PATH/);
  });
});

describe("models dir + extra-config argv parsing (#345/#346/#369)", () => {
  it("parseBaseDirFromArgv reads --base-directory", () => {
    const base = resolve("/C/COMFY");
    expect(parseBaseDirFromArgv(["main.py", "--base-directory", base])).toBe(base);
    expect(parseBaseDirFromArgv(["main.py", "--listen"])).toBeUndefined();
  });

  it("parseModelsDirFromArgv derives <base>/models", () => {
    const base = resolve("/C/COMFY");
    expect(parseModelsDirFromArgv(["main.py", "--base-directory", base])).toBe(
      join(base, "models"),
    );
    expect(parseModelsDirFromArgv(["main.py"])).toBeUndefined();
  });

  it("parseModelsDirFromArgv lets --models-directory override <base>/models", () => {
    const base = resolve("/C/COMFY");
    const models = resolve("/D/models");
    expect(
      parseModelsDirFromArgv([
        "main.py",
        "--base-directory",
        base,
        "--models-directory",
        models,
      ]),
    ).toBe(models);
  });

  it("parseExtraModelPathsConfigsFromArgv collects repeated AND multi-value flags (nargs='+', append)", () => {
    const a = resolve("/cfg/shared_model_paths.yaml");
    const b = resolve("/cfg/other.yaml");
    const c = resolve("/cfg/third.yaml");
    // repeated flag + `=value` form
    expect(
      parseExtraModelPathsConfigsFromArgv([
        "main.py",
        "--extra-model-paths-config",
        a,
        `--extra-model-paths-config=${b}`,
      ]),
    ).toEqual([a, b]);
    // multiple values after a single flag, then another option
    expect(
      parseExtraModelPathsConfigsFromArgv([
        "main.py",
        "--extra-model-paths-config",
        a,
        b,
        c,
        "--port",
        "8188",
      ]),
    ).toEqual([a, b, c]);
    expect(parseExtraModelPathsConfigsFromArgv(["main.py"])).toEqual([]);
  });

  it("resolveModelsDir prefers the live server's --base-directory/models over COMFYUI_PATH", async () => {
    const base = resolve("/C/COMFY");
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--base-directory", base] },
    });
    const got = await resolveModelsDir();
    expect(got).toBe(join(base, "models"));
    expect(got).not.toBe(resolve("/comfy", "models"));
  });

  it("resolveModelsDir falls back to <COMFYUI_PATH>/models when unreachable", async () => {
    getSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await resolveModelsDir()).toBe(resolve("/comfy", "models"));
  });

  // -------------------------------------------------------------------------
  // #369 — a RELATIVE argv `main.py` with no server cwd (ComfyUI Desktop and the
  // Windows portable bundle both report exactly this). argv alone cannot resolve
  // the live root, and falling through to COMFYUI_PATH is what wrote 4.88 GB into
  // a second, stale install and then reported it as a success.
  // -------------------------------------------------------------------------
  describe("#369 relative argv main.py with no server cwd", () => {
    const RELATIVE_ARGV = [join("ComfyUI", "main.py"), "--windows-standalone-build"];

    it("the LIVE server wins over a disagreeing COMFYUI_PATH when the OS observes the process", async () => {
      const liveRoot = resolve("/portable2/ComfyUI");
      (config as { comfyuiPath?: string }).comfyuiPath = resolve("/Documents/ComfyUI");
      observedLiveRoot = liveRoot; // process table identified the running ComfyUI
      getSystemStats.mockResolvedValue({ system: { argv: RELATIVE_ARGV } });

      const { modelsDir, source } = await resolveModelsDirWithBases();
      expect(modelsDir).toBe(join(liveRoot, "models"));
      expect(source).toBe("observed-root");
      // The exact stale destination from the reopened report.
      expect(modelsDir).not.toBe(join(resolve("/Documents/ComfyUI"), "models"));
    });

    it("REFUSES when the live root is unpinnable and COMFYUI_PATH is a different install", async () => {
      (config as { comfyuiPath?: string }).comfyuiPath = resolve("/Documents/ComfyUI");
      observedLiveRoot = undefined; // process table told us nothing
      baseHasEntrypoint = false; // <COMFYUI_PATH>/ComfyUI/main.py does not exist
      getSystemStats.mockResolvedValue({ system: { argv: RELATIVE_ARGV } });

      // The refusal must NAME each thing it could not determine, not just fail.
      await expect(resolveModelsDirWithBases()).rejects.toThrow(
        /could not be determined/i,
      );
      const err = await resolveModelsDirWithBases().catch((e: Error) => e);
      const msg = (err as Error).message;
      expect(msg).toMatch(/RELATIVE path/);
      expect(msg).toMatch(/did NOT report a working directory/);
      expect(msg).toMatch(/OS process table/);
      expect(msg).toMatch(/DIFFERENT install/);
      expect(msg).toMatch(/Refusing to write to a guessed directory/);
    });

    it("accepts the configured base only when it CORROBORATES the reported main.py", async () => {
      (config as { comfyuiPath?: string }).comfyuiPath = resolve("/bundle");
      observedLiveRoot = undefined;
      baseHasEntrypoint = true; // <base>/ComfyUI/main.py really exists
      getSystemStats.mockResolvedValue({ system: { argv: RELATIVE_ARGV } });

      const { modelsDir, source } = await resolveModelsDirWithBases();
      expect(modelsDir).toBe(join(resolve("/bundle"), "ComfyUI", "models"));
      expect(source).toBe("base-anchored");
    });

    // ── #813: COMFYUI_PATH already pointing AT the ComfyUI directory ─────────
    //
    // Two base conventions coexist and both are legitimate. Only the OUTER
    // launcher-root reading (`<base>/<relDir>/main.py`, ComfyUI Desktop) was
    // implemented, so a Windows portable install whose COMFYUI_PATH is the inner
    // ComfyUI directory — the value get_environment / list_local_models /
    // resolveEffectiveComfyUIBase all already accept — had every download refused.
    describe("#813 the base IS the ComfyUI directory (Windows portable)", () => {
      it("anchors on the base itself when the base is the very directory the server named", async () => {
        const base = resolve("/D/ComfyUI_windows_portable/ComfyUI");
        (config as { comfyuiPath?: string }).comfyuiPath = base;
        observedLiveRoot = undefined;
        // The portable shape: main.py sits DIRECTLY under the base, and the
        // Desktop-style nesting <base>/ComfyUI/main.py does NOT exist.
        hasEntrypointFor = (dir) => resolve(dir) === base;
        getSystemStats.mockResolvedValue({ system: { argv: RELATIVE_ARGV } });

        const { modelsDir, source, baseDirs } = await resolveModelsDirWithBases();
        // Resolves to <base>/models — NOT the double-nested <base>/ComfyUI/models
        // that never exists, which is what made this refuse.
        expect(modelsDir).toBe(join(base, "models"));
        expect(source).toBe("base-anchored");
        expect(baseDirs).toContain(base);
      });

      it("still prefers the NESTED launcher-root reading when THAT is the one that exists", async () => {
        // ComfyUI Desktop: <base> holds the launcher, the server is one level down.
        // The #813 change must not steal this case.
        const base = resolve("/bundle");
        (config as { comfyuiPath?: string }).comfyuiPath = base;
        observedLiveRoot = undefined;
        hasEntrypointFor = (dir) => resolve(dir) === join(base, "ComfyUI");
        getSystemStats.mockResolvedValue({ system: { argv: RELATIVE_ARGV } });

        const { modelsDir, source } = await resolveModelsDirWithBases();
        expect(modelsDir).toBe(join(base, "ComfyUI", "models"));
        expect(source).toBe("base-anchored");
      });

      it("REFUSES a base that holds main.py but is NOT the directory the server named", async () => {
        // The corroboration is what makes accepting the base safe. A base called
        // "ComfyUI-master" containing a main.py is a DIFFERENT install from the
        // one whose script is "ComfyUI/main.py" — accepting it is exactly the
        // stale-install landing #369 exists to prevent. "Could not determine"
        // must not become a definite "yes".
        const base = resolve("/D/checkouts/ComfyUI-master");
        (config as { comfyuiPath?: string }).comfyuiPath = base;
        observedLiveRoot = undefined;
        hasEntrypointFor = (dir) => resolve(dir) === base; // base HAS main.py
        getSystemStats.mockResolvedValue({ system: { argv: RELATIVE_ARGV } });

        const err = await resolveModelsDirWithBases().catch((e: Error) => e);
        expect((err as Error).message).toMatch(/could not be determined/i);
        // …and the refusal explains BOTH readings it tried, so the reader can fix it.
        expect((err as Error).message).toMatch(/does not contain/);
        expect((err as Error).message).toMatch(/is not itself "ComfyUI" holding "main\.py"/);
      });

      it("REFUSES the base-is-the-install reading when the base does NOT hold main.py", async () => {
        // Name matches, entrypoint absent: no corroboration, so no anchor. This is
        // the mutation guard for dropping the hasComfyUIEntrypoint(base) check.
        const base = resolve("/D/ComfyUI_windows_portable/ComfyUI");
        (config as { comfyuiPath?: string }).comfyuiPath = base;
        observedLiveRoot = undefined;
        hasEntrypointFor = () => false;
        getSystemStats.mockResolvedValue({ system: { argv: RELATIVE_ARGV } });

        await expect(resolveModelsDirWithBases()).rejects.toThrow(/could not be determined/i);
      });

      it("does NOT fold case on macOS — APFS can be case-SENSITIVE, so a case-differing relDir is not corroboration", async () => {
        // `/x/ComfyUI` and `/x/comfyui` are two different installs on a
        // case-sensitive APFS volume. This comparison decides where a
        // multi-gigabyte file gets written, so a wrong "same" is the #369 harm (a
        // model landing in an install the running server never reads, announced as
        // a success). Windows filesystems ARE case-insensitive everywhere, so
        // folding is correct there — and only there.
        //
        // The platform is stubbed rather than the test being skipped off macOS:
        // this rule must be verifiable on every host, or it is only ever checked on
        // the one machine least likely to run the suite.
        const realPlatform = process.platform;
        Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
        try {
          const base = resolve("/D/portable/ComfyUI");
          (config as { comfyuiPath?: string }).comfyuiPath = base;
          observedLiveRoot = undefined;
          hasEntrypointFor = (dir) => resolve(dir) === base;
          getSystemStats.mockResolvedValue({
            system: { argv: [join("comfyui", "main.py"), "--listen"] },
          });

          await expect(resolveModelsDirWithBases()).rejects.toThrow(/could not be determined/i);
        } finally {
          Object.defineProperty(process, "platform", {
            value: realPlatform,
            configurable: true,
          });
        }
      });

      it("corroborates a MULTI-SEGMENT relative script against a base ending in those segments", async () => {
        // `python sub/ComfyUI/main.py` with COMFYUI_PATH=<...>/sub/ComfyUI.
        const base = resolve("/srv/stack/sub/ComfyUI");
        (config as { comfyuiPath?: string }).comfyuiPath = base;
        observedLiveRoot = undefined;
        hasEntrypointFor = (dir) => resolve(dir) === base;
        getSystemStats.mockResolvedValue({
          system: { argv: [join("sub", "ComfyUI", "main.py"), "--listen"] },
        });

        const { modelsDir, source } = await resolveModelsDirWithBases();
        expect(modelsDir).toBe(join(base, "models"));
        expect(source).toBe("base-anchored");
      });
    });

    it("an UNREACHABLE server still falls back to <COMFYUI_PATH>/models (no regression)", async () => {
      (config as { comfyuiPath?: string }).comfyuiPath = resolve("/Documents/ComfyUI");
      getSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));

      const { modelsDir, source } = await resolveModelsDirWithBases();
      expect(modelsDir).toBe(join(resolve("/Documents/ComfyUI"), "models"));
      expect(source).toBe("configured-base");
    });

    it("a reachable server whose argv names NO main.py keeps the old fallback", async () => {
      // `python -m comfyui` — nothing relative was claimed, so there is no live root
      // to contradict COMFYUI_PATH and no reason to start refusing.
      (config as { comfyuiPath?: string }).comfyuiPath = resolve("/comfy");
      getSystemStats.mockResolvedValue({ system: { argv: ["--listen"] } });

      const { modelsDir, source } = await resolveModelsDirWithBases();
      expect(modelsDir).toBe(join(resolve("/comfy"), "models"));
      expect(source).toBe("configured-base");
    });
  });

  it("resolveModelsDir prefers the LIVE server's own main.py root over a stale COMFYUI_PATH when no --base-directory flag (#490)", async () => {
    // Reproduces #490: the connected ComfyUI runs from a different install than
    // the stale COMFYUI_PATH, and was NOT launched with --base-directory. The
    // download must land in the LIVE install (its main.py root), not COMFYUI_PATH.
    const liveRoot = resolve("/home/parn/repositories/wet/ComfyUI");
    (config as { comfyuiPath?: string }).comfyuiPath = resolve("/home/parn/ComfyUI");
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", join(liveRoot, "main.py"), "--listen"] },
    });
    const got = await resolveModelsDir();
    expect(got).toBe(join(liveRoot, "models"));
    expect(got).not.toBe(join(resolve("/home/parn/ComfyUI"), "models"));
  });

  it("resolveModelsDir resolves the live root when COMFYUI_PATH is unset and no default workspace (#463)", async () => {
    (config as { comfyuiPath?: string }).comfyuiPath = undefined;
    savedDefaultWorkspace = undefined;
    const liveRoot = resolve("/opt/live/ComfyUI");
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", join(liveRoot, "main.py")] },
    });
    expect(await resolveModelsDir()).toBe(join(liveRoot, "models"));
  });

  it("resolveModelsDir does NOT adopt an argv live root that isn't present locally (Docker/forwarded server) — falls back to COMFYUI_PATH", async () => {
    // A loopback ComfyUI inside Docker reports a container-side main.py path that
    // does not exist on the host; writing there would create a bogus host dir.
    liveRootExists = false;
    (config as { comfyuiPath?: string }).comfyuiPath = resolve("/host/ComfyUI");
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", "/app/ComfyUI/main.py"] },
    });
    expect(await resolveModelsDir()).toBe(join(resolve("/host/ComfyUI"), "models"));
  });

  it("resolveModelsDir does NOT adopt the live argv root in remote mode (remote path isn't a local dir)", async () => {
    remoteMode = true;
    const liveRoot = resolve("/remote/host/ComfyUI");
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", join(liveRoot, "main.py")] },
    });
    // Remote mode with a local COMFYUI_PATH: never uses the remote main.py path;
    // falls back to the local COMFYUI_PATH/models.
    expect(await resolveModelsDir()).toBe(resolve("/comfy", "models"));
  });

  it("resolveModelsDir falls back to the saved default workspace when COMFYUI_PATH is unset (#415/#416)", async () => {
    (config as { comfyuiPath?: string }).comfyuiPath = undefined;
    savedDefaultWorkspace = resolve("/saved/workspace");
    getSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await resolveModelsDir()).toBe(join(resolve("/saved/workspace"), "models"));
  });

  it("resolveModelsDir throws a clear, actionable error when nothing resolves", async () => {
    (config as { comfyuiPath?: string }).comfyuiPath = undefined;
    savedDefaultWorkspace = undefined;
    getSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(resolveModelsDir()).rejects.toThrow(/workspace \(action:"set_default"\)/);
  });

  it("resolves a RELATIVE --base-directory against the SERVER cwd, not the MCP cwd", () => {
    const srvCwd = resolve("/srv/live");
    expect(parseBaseDirFromArgv(["main.py", "--base-directory", "data"], srvCwd)).toBe(
      join(srvCwd, "data"),
    );
  });

  it("returns undefined for a relative --base-directory when no server cwd is available", () => {
    expect(parseBaseDirFromArgv(["main.py", "--base-directory", "data"])).toBeUndefined();
  });

  it("resolves --models-directory INDEPENDENTLY (os.path.abspath), NOT under --base-directory", () => {
    const srvCwd = resolve("/srv/live");
    const got = parseModelsDirFromArgv(
      ["main.py", "--base-directory", resolve("/srv/base"), "--models-directory", "models2"],
      srvCwd,
    );
    // Relative --models-directory resolves against the server cwd, never joined onto base.
    expect(got).toBe(join(srvCwd, "models2"));
    expect(got).not.toBe(join(resolve("/srv/base"), "models2"));
  });

  it("returns undefined for a relative --models-directory without a server cwd", () => {
    expect(parseModelsDirFromArgv(["main.py", "--models-directory", "models2"])).toBeUndefined();
  });

  it("hasUnresolvableRelativeModelDirFlag: true for a relative flag w/o cwd, false with cwd/absolute/none", () => {
    expect(hasUnresolvableRelativeModelDirFlag(["main.py", "--base-directory", "data"])).toBe(true);
    expect(hasUnresolvableRelativeModelDirFlag(["main.py", "--models-directory", "m"])).toBe(true);
    expect(
      hasUnresolvableRelativeModelDirFlag(["main.py", "--base-directory", "data"], resolve("/srv")),
    ).toBe(false);
    expect(
      hasUnresolvableRelativeModelDirFlag(["main.py", "--base-directory", resolve("/abs")]),
    ).toBe(false);
    expect(hasUnresolvableRelativeModelDirFlag(["main.py"])).toBe(false);
  });

  it("resolveModelsDirWithBases THROWS (does not guess) when a relative flag is unresolvable", async () => {
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--base-directory", "data"] }, // relative, no cwd
    });
    await expect(resolveModelsDirWithBases()).rejects.toThrow(/relative --base-directory/i);
  });

  it("resolveModelsDirWithBases resolves against an absolute server cwd for a relative flag", async () => {
    const srvCwd = resolve("/srv/live");
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--base-directory", "data"], cwd: srvCwd },
    });
    const { modelsDir } = await resolveModelsDirWithBases();
    expect(modelsDir).toBe(join(srvCwd, "data", "models"));
  });

  it("resolveServerExtraModelConfig returns the server's config file, undefined when absent", async () => {
    const cfg = resolve("/cfg/shared_model_paths.yaml");
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--extra-model-paths-config", cfg] },
    });
    expect(await resolveServerExtraModelConfig()).toBe(cfg);

    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    expect(await resolveServerExtraModelConfig()).toBeUndefined();

    getSystemStats.mockRejectedValue(new Error("down"));
    expect(await resolveServerExtraModelConfig()).toBeUndefined();
  });
});

describe("resolveInputDir", () => {
  it("uses the redirected dir reported by /system_stats argv", async () => {
    const redirected = resolve("/shared/ComfyUI-Shared/input");
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--input-directory", redirected] },
    });
    const got = await resolveInputDir();
    expect(got).toBe(redirected);
    expect(got).not.toBe(resolve("/comfy", "input"));
    expect(isAbsolute(got)).toBe(true);
  });

  it("falls back to <COMFYUI_PATH>/input when argv has no override", async () => {
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    expect(await resolveInputDir()).toBe(resolve("/comfy", "input"));
  });

  it("falls back to <COMFYUI_PATH>/input when /system_stats is unreachable", async () => {
    getSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await resolveInputDir()).toBe(resolve("/comfy", "input"));
  });
});

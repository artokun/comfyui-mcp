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
/** Per-PATH existence, for the #851 inventory corroboration: it asks whether each file
 *  the SERVER lists is present under `<base>/models/<category>`, which the flat boolean
 *  cannot express. Default keeps every pre-existing test on the boolean. */
let existsFor: ((p: string) => boolean) | undefined;
/** `<base>/models` stat for the #851 check: a directory, absent, or unreadable. Applies
 *  ONLY to a path ending in `/models`, so the per-ENTRY stats below stay independent. */
let modelsDirStat: "dir" | "file" | "enoent" | "eacces" = "dir";
/** Per-ENTRY stat, for the model files the server lists. Default: a regular file when
 *  `existsFor`/`liveRootExists` says it exists, ENOENT otherwise — so existing tests are
 *  unaffected and the #851 cases can make one entry a directory or unreadable. */
let statFor: ((p: string) => { isDirectory: () => boolean; isFile: () => boolean }) | undefined;
/** Canonicalization, for the #851 physical-containment check. Identity by default. */
let realpathFor: ((p: string) => string) | undefined;
vi.mock("node:fs", () => ({
  realpathSync: (p: string) => (realpathFor ? realpathFor(String(p)) : String(p)),
  existsSync: (p: string) => (existsFor ? existsFor(String(p)) : liveRootExists),
  statSync: (p: string) => {
    const path = String(p);
    if (/[\\/]models$/.test(path)) {
      if (modelsDirStat === "enoent" || modelsDirStat === "eacces") {
        const err = new Error(`stat ${path}`) as NodeJS.ErrnoException;
        err.code = modelsDirStat === "enoent" ? "ENOENT" : "EACCES";
        throw err;
      }
      return { isDirectory: () => modelsDirStat === "dir", isFile: () => modelsDirStat === "file" };
    }
    if (statFor) return statFor(path);
    const there = existsFor ? existsFor(path) : liveRootExists;
    if (!there) {
      const err = new Error(`stat ${path}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return { isDirectory: () => false, isFile: () => true };
  },
}));

const getSystemStats = vi.fn();
/** The server's own model inventory: category → filenames it reports seeing. */
let serverInventory: Record<string, string[]> | undefined;
const defaultFetchApi = async (path: string) => {
  if (!serverInventory) return { ok: false, status: 404, json: async () => ({}) };
  if (path === "/models") {
    return { ok: true, status: 200, json: async () => Object.keys(serverInventory as object) };
  }
  const m = path.match(/^\/models\/(.+)$/);
  const cat = m ? decodeURIComponent(m[1]) : undefined;
  if (cat && serverInventory[cat]) {
    return { ok: true, status: 200, json: async () => serverInventory![cat] };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
const fetchApi = vi.fn(defaultFetchApi);
vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: (...a: unknown[]) => getSystemStats(...a),
  getClient: () => ({ fetchApi: (...a: unknown[]) => fetchApi(...(a as [string])) }),
  // #385 — call sites moved from `client.fetchApi` to `comfyApiFetch`, which
  // returns a 4xx instead of throwing. Routed to the SAME spy so every
  // existing "which route did we ask for" assertion still pins the same thing.
  comfyApiFetch: (...a: unknown[]) => ((...a: unknown[]) => fetchApi(...(a as [string])))(...(a as [string])),
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
    // #1052 — backed by the REAL argv parsing, like the resolvers above, so the
    // live-root rung is exercised end to end rather than stubbed away.
    resolveLiveComfyUIBase: async () => {
      try {
        const stats = await getSystemStats();
        return actual.liveRootFromArgv(stats?.system?.argv, stats?.system?.cwd);
      } catch {
        return undefined;
      }
    },
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
  existsFor = undefined;
  modelsDirStat = "dir";
  statFor = undefined;
  realpathFor = undefined;
  serverInventory = undefined;
  fetchApi.mockClear();
  fetchApi.mockImplementation(defaultFetchApi);
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
      // It names the code-layout check as UNCORROBORATED, not as proof of a different
      // install: #851 is the counterexample — a Docker/data-dir base legitimately has no
      // main.py at all, so "did not corroborate" cannot imply "is another install".
      expect(msg).toMatch(/did NOT corroborate it, which is not the same as establishing it is a different install/);
      expect(msg).not.toMatch(/so it is a DIFFERENT install/);
      // …and it reports the inventory check it also ran.
      expect(msg).toMatch(/asking the running server what models it can SEE/);
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
    // ComfyUI directory — the value install_comfyui (action:"environment") / list_local_models /
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

      it("REFUSES when BOTH readings fit — the evidence does not say which install is running", async () => {
        // base = <...>/ComfyUI holding main.py, AND <base>/ComfyUI/main.py also
        // present. The server's "ComfyUI\main.py" is consistent with EITHER, so
        // picking one is a guess about where multi-gigabyte files land — and
        // guessing wrong is precisely the #369 harm (a model in a stale install,
        // reported as a success).
        const base = resolve("/bundle/ComfyUI");
        (config as { comfyuiPath?: string }).comfyuiPath = base;
        observedLiveRoot = undefined;
        hasEntrypointFor = (dir) =>
          resolve(dir) === base || resolve(dir) === join(base, "ComfyUI");
        getSystemStats.mockResolvedValue({ system: { argv: RELATIVE_ARGV } });

        await expect(resolveModelsDirWithBases()).rejects.toThrow(/could not be determined/i);
      });

      it("keeps the pre-existing relDir '.' behaviour unchanged (deliberately NOT tightened here)", async () => {
        // `python main.py` with no reported cwd gives relDir ".", which corroborates
        // nothing beyond "the configured base is a ComfyUI install" — a reviewer
        // fairly calls that weak evidence for the #369 hazard. It is nonetheless
        // UNCHANGED by #813, and deliberately so: this is the single most common
        // local launch, and refusing it would route those users through the
        // Manager (often not installed) for every download. Tightening it is a
        // separate decision about a pre-existing behaviour, not part of fixing the
        // portable-base anchoring. This test exists so the choice is explicit and
        // any future change to it is a visible one.
        const base = resolve("/home/me/ComfyUI");
        (config as { comfyuiPath?: string }).comfyuiPath = base;
        observedLiveRoot = undefined;
        hasEntrypointFor = (dir) => resolve(dir) === base;
        getSystemStats.mockResolvedValue({ system: { argv: ["main.py", "--listen"] } });

        const { modelsDir, source } = await resolveModelsDirWithBases();
        expect(modelsDir).toBe(join(base, "models"));
        expect(source).toBe("base-anchored");
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

describe("models dir — corroborating a data-dir base by the server's own inventory (#851)", () => {
  // The Docker/data-dir shape from the report: ComfyUI runs in a container as
  // `python3 main.py` (relative argv, no cwd), and COMFYUI_PATH is the HOST bind-mount
  // holding models/ input/ output/ custom_nodes/ — with no main.py anywhere near it,
  // because the code lives inside the container.
  //
  // anchorRelativeEntrypointOnBase cannot rescue this and should not be extended to: it
  // corroborates using the CODE layout, and in this deployment that evidence genuinely
  // does not exist. Adding a third layout branch would just wait for a fourth shape.
  // What DOES exist is the server's own /models listing, which is it telling us what it
  // can see.
  const DATA_DIR = "/home/gradispo/comfyui-data";

  function dockerServer(): void {
    getSystemStats.mockResolvedValue({
      system: { argv: ["python3", "main.py", "--listen", "0.0.0.0", "--port", "8188"] },
    });
    (config as { comfyuiPath?: string }).comfyuiPath = DATA_DIR;
    baseHasEntrypoint = false; // no main.py at or under the host data dir
    hasEntrypointFor = () => false;
  }

  /** Only the files the server lists exist, under `<DATA_DIR>/models/<category>`. */
  function onDisk(files: string[]): void {
    const present = new Set(files.map((f) => resolve(f)));
    existsFor = (p) => present.has(resolve(p));
  }

  it("accepts the data dir when the server's model listing is fully present under it", async () => {
    dockerServer();
    serverInventory = {
      diffusion_models: ["qwen-image-edit.safetensors", "sub/wan22.safetensors"],
    };
    onDisk([
      join(DATA_DIR, "models", "diffusion_models", "qwen-image-edit.safetensors"),
      join(DATA_DIR, "models", "diffusion_models", "sub/wan22.safetensors"),
    ]);

    const res = await resolveModelsDirWithBases({ targetCategory: "diffusion_models" });
    expect(res.modelsDir).toBe(resolve(DATA_DIR, "models"));
    // Reported as corroborated LOCAL CONFIG, not as a path the server named — the
    // distinction downstream writers use.
    expect(res.source).toBe("base-inventory-corroborated");
    expect(res.baseDirs).toContain(resolve(DATA_DIR));
  });

  it("REFUSES a PARTIAL match, but names the multi-root possibility instead of blaming the base", async () => {
    // I had this backwards once. Relaxing to "any overlap corroborates" fixed a
    // real false refusal under extra_model_paths — and opened a worse hole: the
    // listing is FILENAMES ONLY, so a stale clone sharing one name is
    // indistinguishable from a genuine second root, and a single common filename
    // then authorized a multi-gigabyte download into an install the server never
    // reads (codex gate). A refusal here is recoverable; a wrong destination
    // reported as success is #369.
    //
    // So the verdict stays a refusal. What had to change was the REASON: the old
    // message read as "this base is wrong" when a multi-root layout is the likelier
    // explanation, and gave the user nothing to act on.
    dockerServer();
    serverInventory = { diffusion_models: ["present.safetensors", "elsewhere.safetensors"] };
    onDisk([join(DATA_DIR, "models", "diffusion_models", "present.safetensors")]);

    const err = await resolveModelsDirWithBases({ targetCategory: "diffusion_models" }).catch(
      (e: unknown) => e,
    );
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toMatch(/could not be determined/);
    // It credits what WAS found rather than implying nothing was...
    expect(message).toMatch(/1 of them are under/);
    // ...names the layout that would explain it...
    expect(message).toMatch(/extra_model_paths/);
    // ...admits why that cannot be distinguished from a stale copy...
    expect(message).toMatch(/stale copy sharing some filenames/);
    // ...and tells the user what to actually do.
    expect(message).toMatch(/set COMFYUI_PATH to the root that actually holds/);
  });

  it("still REFUSES when NONE of the listed files are here, and says so plainly", async () => {
    // The unambiguous end of the same spectrum: no overlap at all is not a
    // multi-root layout, and the message should not hedge as if it might be.
    dockerServer();
    serverInventory = { diffusion_models: ["a.safetensors", "b.safetensors"] };
    onDisk([]);

    const err = await resolveModelsDirWithBases({ targetCategory: "diffusion_models" }).catch(
      (e: unknown) => e,
    );
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toMatch(/NONE of them are under/);
    expect(message).not.toMatch(/extra_model_paths/);
  });

  it("an UNREADABLE entry decides the wording over a missing one — inconclusive is not absence", async () => {
    // A mixed result was narrated purely as absence because `missing` won the
    // diagnostic branch (codex gate). An entry we could not inspect is not an entry
    // we found to be gone, and the half that is NOT a finding has to set the tone.
    dockerServer();
    serverInventory = { diffusion_models: ["gone.safetensors", "unreadable.safetensors"] };
    onDisk([]);
    // `statFor` is the harness's seam for a probe that neither finds nor fails to
    // find: EACCES is "could not look", not "not there".
    const blocked = resolve(join(DATA_DIR, "models", "diffusion_models", "unreadable.safetensors"));
    statFor = (path: string) => {
      const err = new Error(`stat ${path}`) as NodeJS.ErrnoException;
      err.code = resolve(path) === blocked ? "EACCES" : "ENOENT";
      throw err;
    };

    const err = await resolveModelsDirWithBases({ targetCategory: "diffusion_models" }).catch(
      (e: unknown) => e,
    );
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toMatch(/could not be inspected/);
    expect(message).toMatch(/NOT a finding/);
    expect(message).not.toMatch(/NONE of them are under/);
  });

  it("REFUSES when the target category listing is empty", async () => {
    // Nothing to compare is not a match. An empty listing would otherwise "corroborate"
    // any directory at all — the emptiest possible false positive. This is also the
    // honest cost of scoping to the target category: a first-ever download into a
    // category the server has never listed cannot be corroborated, and says so.
    dockerServer();
    serverInventory = { diffusion_models: [], loras: [] };
    onDisk([]);

    await expect(resolveModelsDirWithBases({ targetCategory: "diffusion_models" })).rejects.toThrow(
      /lists no files under "diffusion_models", so there is nothing there to show/,
    );
  });

  it("does NOT authorize the whole models root from a SIBLING category's match", async () => {
    // A server can read `diffusion_models` from this base via an extra_model_paths entry
    // while reading `loras` from somewhere else entirely. Matching a sibling and then
    // writing the loras file here would put it where the server never looks — and the
    // downstream live-disagreement guard cannot catch it, because an EMPTY local `loras/`
    // has nothing to contradict. That is the first-download case exactly.
    dockerServer();
    serverInventory = {
      diffusion_models: ["qwen-image-edit.safetensors"], // fully present here
      loras: ["somewhere-else.safetensors"], // the server reads these elsewhere
    };
    onDisk([join(DATA_DIR, "models", "diffusion_models", "qwen-image-edit.safetensors")]);

    // The sibling still corroborates its OWN category…
    await expect(
      resolveModelsDirWithBases({ targetCategory: "diffusion_models" }),
    ).resolves.toMatchObject({ source: "base-inventory-corroborated" });
    // …and cannot vouch for the one being written to.
    await expect(resolveModelsDirWithBases({ targetCategory: "loras" })).rejects.toThrow(
      /somewhere-else\.safetensors/,
    );
  });

  it("refuses the rescue outright when the caller named no category", async () => {
    // Corroboration has to be ABOUT something. A call with no category cannot be told
    // which folder to establish, so it gets the refusal rather than a match on whatever
    // category happened to be checked first.
    dockerServer();
    serverInventory = { diffusion_models: ["a.safetensors"] };
    onDisk([join(DATA_DIR, "models", "diffusion_models", "a.safetensors")]);

    await expect(resolveModelsDirWithBases()).rejects.toThrow(
      /did not name the model category it is downloading into/,
    );
  });

  it("does not claim absence when <base>/models cannot be inspected", async () => {
    dockerServer();
    modelsDirStat = "eacces";
    serverInventory = { diffusion_models: ["a.safetensors"] };

    await expect(resolveModelsDirWithBases({ targetCategory: "diffusion_models" })).rejects.toThrow(
      /could not be inspected \(EACCES\), so nothing was established either way/,
    );
  });

  it("says plainly when the base simply has no models directory", async () => {
    dockerServer();
    modelsDirStat = "enoent";
    serverInventory = { diffusion_models: ["a.safetensors"] };

    await expect(resolveModelsDirWithBases({ targetCategory: "diffusion_models" })).rejects.toThrow(/has no "models" directory/);
  });

  it("does not let a listing entry ESCAPE the category dir and corroborate from outside", async () => {
    // The server supplies both the category and the file names. A `..` segment in either
    // would let `join` walk out of <base>/models and "find" a file that says nothing
    // about this base — a false corroboration, and this decides a download destination.
    dockerServer();
    serverInventory = { diffusion_models: ["../../../etc/hosts"] };
    existsFor = () => true; // everything "exists" — containment is what must reject it

    await expect(resolveModelsDirWithBases({ targetCategory: "diffusion_models" })).rejects.toThrow(/escapes/);
  });

  it("accepts an ordinary filename that merely STARTS with two dots", async () => {
    // `relative()` returns "..model.safetensors" for a file sitting right inside the
    // directory, and a bare startsWith("..") called that an escape. The result was a
    // refusal of the exact Docker download this check exists to allow — over-strict is
    // the same defect as over-permissive, pointed the other way.
    dockerServer();
    serverInventory = { diffusion_models: ["..model.safetensors", "sub/..other.gguf"] };
    onDisk([
      join(DATA_DIR, "models", "diffusion_models", "..model.safetensors"),
      join(DATA_DIR, "models", "diffusion_models", "sub/..other.gguf"),
    ]);

    const res = await resolveModelsDirWithBases({ targetCategory: "diffusion_models" });
    expect(res.source).toBe("base-inventory-corroborated");
  });

  it("does not let a SYMLINKED evidence file corroborate a stale base", async () => {
    // Sharing model files between installs by symlinking them is ordinary practice. A
    // stale base whose `<category>/known.safetensors` is a link to the file the server
    // really reads satisfies a lexical check while proving the opposite: the evidence
    // lives elsewhere, and a NEW download written here would never appear to the server.
    // `statSync` follows links, so nothing before this noticed.
    dockerServer();
    serverInventory = { diffusion_models: ["known.safetensors"] };
    const linked = join(DATA_DIR, "models", "diffusion_models", "known.safetensors");
    onDisk([linked]);
    realpathFor = (p) =>
      resolve(p) === resolve(linked) ? resolve("/elsewhere/real/known.safetensors") : String(p);

    await expect(
      resolveModelsDirWithBases({ targetCategory: "diffusion_models" }),
    ).rejects.toThrow(/escapes/);
  });

  it("refuses a category directory linked OUT of the models tree, so the two guards agree", async () => {
    // Writes through such a link really would reach the server — but the download
    // authorizer downstream refuses any destination whose canonical path leaves the
    // models root. Corroborating it here would hand the caller an approval the next
    // layer overrules: two guards contradicting each other, which is worse than either
    // answer alone. This check is deliberately the narrower one, and says why.
    dockerServer();
    serverInventory = { diffusion_models: ["known.safetensors"] };
    const categoryDir = join(DATA_DIR, "models", "diffusion_models");
    const realCategory = resolve("/srv/real/models/diffusion_models");
    onDisk([join(categoryDir, "known.safetensors")]);
    realpathFor = (p) => {
      const r = resolve(p);
      if (r === resolve(categoryDir)) return realCategory;
      if (r === resolve(join(categoryDir, "known.safetensors"))) {
        return join(realCategory, "known.safetensors");
      }
      return String(p);
    };

    await expect(
      resolveModelsDirWithBases({ targetCategory: "diffusion_models" }),
    ).rejects.toThrow(/outside .* a category directory linked out of the models tree/s);
    // The refusal names the remedy that works from here.
    await expect(
      resolveModelsDirWithBases({ targetCategory: "diffusion_models" }),
    ).rejects.toThrow(/Point COMFYUI_PATH at the directory that physically holds the models/);
  });

  it("does not accept a DIRECTORY as one of the server's model files", async () => {
    // `existsSync` is true for a directory, so a folder with a model-like name would
    // have corroborated a base that holds none of the actual files.
    dockerServer();
    serverInventory = { diffusion_models: ["looks-like-a-model.safetensors"] };
    existsFor = () => true;
    statFor = () => ({ isDirectory: () => true, isFile: () => false });

    await expect(resolveModelsDirWithBases({ targetCategory: "diffusion_models" })).rejects.toThrow(/are not regular files/);
  });

  it("does not report an UNREADABLE entry as missing", async () => {
    dockerServer();
    serverInventory = { diffusion_models: ["locked.safetensors"] };
    statFor = () => {
      const err = new Error("EACCES") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    };

    await expect(resolveModelsDirWithBases({ targetCategory: "diffusion_models" })).rejects.toThrow(
      /could not be inspected under .* that is NOT a finding\s+that they are missing/s,
    );
    await expect(resolveModelsDirWithBases({ targetCategory: "diffusion_models" })).rejects.not.toThrow(/are not under/);
  });

  it("distinguishes 'the listing was empty' from 'the listing could not be read'", async () => {
    // Both leave nothing compared, and reporting the second as the first tells the user
    // their server has no models in that category when in fact we never got an answer.
    dockerServer();
    fetchApi.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));

    await expect(resolveModelsDirWithBases({ targetCategory: "diffusion_models" })).rejects.toThrow(
      /listing could not be read, so there was nothing to compare against/,
    );
    await expect(resolveModelsDirWithBases({ targetCategory: "diffusion_models" })).rejects.not.toThrow(
      /lists no files under/,
    );
  });

  it("does not call an uncorroborated base a DIFFERENT install", async () => {
    // The code-layout check failing means it did not corroborate — and #851 is the proof
    // that the inference "therefore it is another install" is invalid, since a data-dir
    // base legitimately has no main.py at all.
    dockerServer();
    serverInventory = { diffusion_models: ["a.safetensors"] };
    onDisk([]); // nothing matches → the full refusal is rendered

    await expect(resolveModelsDirWithBases({ targetCategory: "diffusion_models" })).rejects.toThrow(
      /did NOT corroborate it, which is not the same as establishing it is a different install/,
    );
    await expect(resolveModelsDirWithBases({ targetCategory: "diffusion_models" })).rejects.not.toThrow(
      /so it is a DIFFERENT install/,
    );
  });

  it("treats a listing with a MALFORMED entry as inconclusive, not a match on the rest", async () => {
    // `["known.safetensors", null]`: dropping the null and matching the remainder would
    // approve a download destination while not accounting for everything the server
    // said it sees — a "complete match" that is not complete.
    dockerServer();
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/models") return { ok: true, status: 200, json: async () => ["diffusion_models"] };
      return { ok: true, status: 200, json: async () => ["known.safetensors", null] };
    });
    existsFor = () => true; // the well-formed entry WOULD match

    await expect(resolveModelsDirWithBases({ targetCategory: "diffusion_models" })).rejects.toThrow(
      /are not usable filenames, so what it sees there could not be established/,
    );
  });

  it("asks the server exactly ONE question — the target category's listing", async () => {
    // Scoping to the target category also removed the enumeration entirely: there is no
    // /models sweep and no per-category budget to get wrong, because only one category
    // is ever the question. This sits in front of a download, so the request count is
    // part of the contract, not an incidental.
    dockerServer();
    serverInventory = {
      diffusion_models: ["a.safetensors"],
      loras: ["b.safetensors"],
      vae: ["c.safetensors"],
    };
    onDisk([join(DATA_DIR, "models", "diffusion_models", "a.safetensors")]);

    await resolveModelsDirWithBases({ targetCategory: "diffusion_models" });
    expect(fetchApi.mock.calls.length).toBe(1);
    expect(fetchApi.mock.calls[0][0]).toBe("/models/diffusion_models");
  });

  it("never runs the inventory probe when the destination already resolved", async () => {
    // The corroboration must be a rescue for a refusal, never a second opinion that
    // could redirect a download that already had a live-authoritative answer.
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", "/live/ComfyUI/main.py"] },
    });
    (config as { comfyuiPath?: string }).comfyuiPath = DATA_DIR;
    serverInventory = { diffusion_models: ["a.safetensors"] };

    const res = await resolveModelsDirWithBases({ targetCategory: "diffusion_models" });
    expect(res.source).toBe("live-root");
    expect(fetchApi).not.toHaveBeenCalled();
  });
});

// #1052 — with TWO ComfyUI installs on one machine, refs resolved against the
// wrong one.
//
// A reporter had ComfyUI Desktop installed alongside the git checkout they were
// actually connected to. `train_prepare_dataset` refs
// ({filename, subfolder, type:"output"}) pointing at images that server had just
// produced failed "image not found" against the DESKTOP path, while the files
// sat in the connected server's output dir the whole time.
//
// The argv rung only answers when ComfyUI was launched with an explicit
// --output-directory. Without one, resolution fell straight through to the
// configured/auto-detected install — a different tree from the running one. The
// running server's own argv (main.py + cwd) identifies its root perfectly well,
// which is the live-first move #463 already made for models.
//
// The tool's description promises refs resolve "against the connected ComfyUI's
// output/input dirs", so the contract was right and the resolution was not.
describe("#1052: I/O dirs follow the CONNECTED server, not a second install", () => {
  const CONNECTED = resolve("/home/u/Documents/comfy/ComfyUI");
  const DESKTOP = resolve("/home/u/AppData/Local/Programs/ComfyUI/resources/ComfyUI");

  beforeEach(() => {
    (config as { comfyuiPath?: string }).comfyuiPath = DESKTOP;
    liveRootExists = true;
  });

  /** The connected server, launched WITHOUT an explicit --output/--input-directory. */
  function connectedServerNoExplicitDirs(): void {
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", join(CONNECTED, "main.py")], cwd: CONNECTED },
    });
  }

  it("resolves the OUTPUT dir under the connected install, not the configured one", async () => {
    connectedServerNoExplicitDirs();
    const got = await resolveOutputDir();
    expect(got).toBe(join(CONNECTED, "output"));
    expect(got).not.toBe(resolve(DESKTOP, "output")); // the reported failure
  });

  it("resolves the INPUT dir the same way", async () => {
    connectedServerNoExplicitDirs();
    expect(await resolveInputDir()).toBe(join(CONNECTED, "input"));
  });

  // An EXPLICIT --output-directory is the server telling us outright; it must
  // keep winning over an install root inferred from main.py.
  it("still lets an explicit --output-directory win", async () => {
    const redirected = resolve("/mnt/big/outputs");
    getSystemStats.mockResolvedValue({
      system: {
        argv: ["python", join(CONNECTED, "main.py"), "--output-directory", redirected],
        cwd: CONNECTED,
      },
    });
    expect(await resolveOutputDir()).toBe(redirected);
  });

  // And when nothing about the live server can be read, the configured install
  // is still the right answer — this rung adds a source, it does not remove one.
  it("falls back to the configured install when the server cannot be read", async () => {
    getSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await resolveOutputDir()).toBe(resolve(DESKTOP, "output"));
  });

  it("falls back when the live argv identifies no root", async () => {
    getSystemStats.mockResolvedValue({ system: { argv: ["python"] } });
    expect(await resolveOutputDir()).toBe(resolve(DESKTOP, "output"));
  });
});

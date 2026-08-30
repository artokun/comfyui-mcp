import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../utils/logger.js";
import { basename, isAbsolute, join, resolve } from "node:path";

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
/** What the BASE's own category dir contains (#1371). A contradiction requires this base
 *  to hold files of its own — an EMPTY category dir is an extra_model_paths root that
 *  simply has nothing here yet, which is a working setup and must not be refused. */
let baseCategoryEntries: string[] = [];
/** Names inside a SUBDIRECTORY of the category, for the diffusers-style layout (#1371). */
let baseNestedEntries: string[] = [];
/** Names one level below a nested directory, for the depth-2 diffusers case (#1371). */
let baseDeepEntries: string[] = [];
/** Entries the readdir mock reports as directories rather than files. */
let baseDirEntries = new Set<string>();
/** Entries the readdir mock reports as SYMLINKS — `Dirent.isFile()` is false for those,
 *  which is how counting only isFile() stopped seeing a symlinked model tree (#1371). */
let baseSymlinkEntries = new Set<string>();
/** How many readdirs one resolve did — the P2 bound is a number, so assert on the number. */
let readdirCalls = 0;
/** How many stats one resolve did — the symlink bound is a number too. */
let statCalls = 0;
const direntOf = (name: string) => ({
  name,
  isFile: () => !baseDirEntries.has(name) && !baseSymlinkEntries.has(name),
  isDirectory: () => baseDirEntries.has(name),
  isSymbolicLink: () => baseSymlinkEntries.has(name),
});
vi.mock("node:fs", () => ({
  readdirSync: (p: string) => {
    readdirCalls += 1;
    // Explicit two-level dispatch: the LAST path segment decides. A path ending in a name
    // we declared to be a directory is the nested read; anything else is the category dir.
    const last = basename(String(p));
    // Three levels: category dir → a nested dir → one deeper (the diffusers shape).
    if (last === "transformer") return baseDeepEntries.map(direntOf);
    // A SYMLINKED directory reads through to the nested listing too — readdir follows the
    // link. Dispatching on baseDirEntries alone made the link re-serve the category's own
    // listing, which is not a filesystem that exists.
    const nested = baseDirEntries.has(last) || baseSymlinkEntries.has(last);
    return (nested ? baseNestedEntries : baseCategoryEntries).map(direntOf);
  },
  realpathSync: (p: string) => (realpathFor ? realpathFor(String(p)) : String(p)),
  existsSync: (p: string) => (existsFor ? existsFor(String(p)) : liveRootExists),
  statSync: (p: string) => {
    statCalls += 1;
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

/** statSync is consulted on MANY paths during resolution, not just the one a test cares
 *  about. A blanket stub answers the others wrongly — an `isFile: true` fallback made the
 *  server's listed file look PRESENT, so nothing was missing and the check returned ok
 *  before reaching the branch under test. Override one path; defer the rest to the mock's
 *  own default (present per existsFor, ENOENT otherwise). */
const statExceptFor = (
  match: (p: string) => boolean,
  answer: { isDirectory: () => boolean; isFile: () => boolean } | "enoent",
) => (path: string) => {
  if (match(path)) {
    if (answer !== "enoent") return answer;
    const err = new Error(`stat ${path}`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }
  if (existsFor ? existsFor(path) : liveRootExists) return { isDirectory: () => false, isFile: () => true };
  const err = new Error(`stat ${path}`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  throw err;
};

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
  parseTempDirFromArgv,
  localTempDirFallback,
  resolveTempDir,
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
  baseCategoryEntries = [];
  baseNestedEntries = [];
  baseDeepEntries = [];
  baseDirEntries = new Set();
  baseSymlinkEntries = new Set();
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

  it("resolves a relative --input-directory against the server cwd", () => {
    const serverCwd = resolve("/srv/live-comfyui");
    expect(
      parseInputDirFromArgv(["main.py", "--input-directory", "custom-input"], serverCwd),
    ).toBe(join(serverCwd, "custom-input"));
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

describe("parseTempDirFromArgv", () => {
  it("returns undefined when no relevant flags are present", () => {
    expect(parseTempDirFromArgv(["python", "main.py", "--listen"])).toBeUndefined();
    expect(parseTempDirFromArgv([])).toBeUndefined();
    expect(parseTempDirFromArgv(undefined)).toBeUndefined();
  });

  it("parses --temp-directory <value>", () => {
    const abs = resolve("/shared/ComfyUI-Shared/temp");
    expect(parseTempDirFromArgv(["main.py", "--temp-directory", abs])).toBe(abs);
  });

  it("parses --temp-directory=<value>", () => {
    const abs = resolve("/shared/tmp");
    expect(parseTempDirFromArgv(["main.py", `--temp-directory=${abs}`])).toBe(abs);
  });

  it("resolves a relative --temp-directory against the server cwd", () => {
    const serverCwd = resolve("/srv/live-comfyui");
    expect(
      parseTempDirFromArgv(["main.py", "--temp-directory", "custom-temp"], serverCwd),
    ).toBe(join(serverCwd, "custom-temp"));
  });

  it("derives <base>/temp from --base-directory", () => {
    const base = resolve("/srv/comfy-base");
    expect(parseTempDirFromArgv(["main.py", "--base-directory", base])).toBe(
      join(base, "temp"),
    );
  });

  it("lets --temp-directory win over --base-directory", () => {
    const base = resolve("/srv/base");
    const tmp = resolve("/srv/explicit-temp");
    const got = parseTempDirFromArgv([
      "main.py",
      "--base-directory",
      base,
      "--temp-directory",
      tmp,
    ]);
    expect(got).toBe(tmp);
  });
});

describe("localTempDirFallback", () => {
  it("returns <COMFYUI_PATH>/temp", () => {
    expect(localTempDirFallback()).toBe(resolve("/comfy", "temp"));
  });

  it("throws when COMFYUI_PATH is unset", () => {
    (config as { comfyuiPath?: string }).comfyuiPath = undefined;
    expect(() => localTempDirFallback()).toThrow(/COMFYUI_PATH/);
  });
});

describe("resolveTempDir", () => {
  it("uses the redirected dir reported by /system_stats argv", async () => {
    const redirected = resolve("/shared/ComfyUI-Shared/temp");
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--temp-directory", redirected] },
    });
    const got = await resolveTempDir();
    expect(got).toBe(redirected);
    expect(got).not.toBe(resolve("/comfy", "temp"));
    expect(isAbsolute(got)).toBe(true);
  });

  it("resolves a relative redirected dir against the live server cwd", async () => {
    const serverCwd = resolve("/srv/live-comfyui");
    getSystemStats.mockResolvedValue({
      system: {
        argv: ["python", "main.py", "--temp-directory", "custom-temp"],
        cwd: serverCwd,
      },
    });
    expect(await resolveTempDir()).toBe(join(serverCwd, "custom-temp"));
  });

  it("falls back to <COMFYUI_PATH>/temp when argv has no override", async () => {
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    expect(await resolveTempDir()).toBe(resolve("/comfy", "temp"));
  });

  it("falls back to <COMFYUI_PATH>/temp when /system_stats is unreachable", async () => {
    getSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await resolveTempDir()).toBe(resolve("/comfy", "temp"));
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

  it("resolves a relative redirected dir against the live server cwd", async () => {
    const serverCwd = resolve("/srv/live-comfyui");
    getSystemStats.mockResolvedValue({
      system: {
        argv: ["python", "main.py", "--input-directory", "custom-input"],
        cwd: serverCwd,
      },
    });
    expect(await resolveInputDir()).toBe(join(serverCwd, "custom-input"));
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

  // #2539 — ComfyUI Desktop / Windows portable report a RELATIVE
  // `ComfyUI/main.py` with no cwd and no --output-directory. argv alone cannot
  // resolve the live root, so list_outputs scanned the unrelated COMFYUI_PATH
  // while /view served the live server's files. The OS-observed process is the
  // same rung models already use for this argv shape.
  it("#2539: relative ComfyUI/main.py without cwd uses the OS-observed live root, not COMFYUI_PATH", async () => {
    const liveRoot = resolve("/portable2/ComfyUI");
    observedLiveRoot = liveRoot;
    getSystemStats.mockResolvedValue({
      system: { argv: [join("ComfyUI", "main.py"), "--windows-standalone-build"] },
    });
    const got = await resolveOutputDir();
    expect(got).toBe(join(liveRoot, "output"));
    expect(got).not.toBe(resolve(DESKTOP, "output"));
  });
});

describe("#1371 — a configured base the server demonstrably does not read is refused", () => {
  // The reporter ran TWO local ComfyUIs. Connected to the second, COMFYUI_PATH still
  // pointed at the first, and a model landed in the install the running server never reads
  // — while the tool said "destination came from local configuration rather than the
  // running server; visibility to the connected ComfyUI is unconfirmed". It knew, and wrote
  // anyway.
  //
  // The `else if (base)` fallback took COMFYUI_PATH/models with no corroboration, and it is
  // reached whenever the live root cannot be derived for any reason other than the
  // relative-main.py shape the branch above it handles.

  it("REFUSES when the server lists models for the category and NONE are under the base", async () => {
    config.comfyuiPath = "/stale-install";
    // A live server we cannot pin to a root: argv names no resolvable entrypoint.
    getSystemStats.mockResolvedValue({ system: { argv: ["python"] } });
    // …and it will say what it sees. None of it is in the stale base.
    serverInventory = { vae: ["h3-only.safetensors"] };
    modelsDirStat = "dir";
    existsFor = (p) => p.endsWith("models");
    // The stale base holds its OWN models for this category — a second full install. That
    // is what makes "none of the server's files are here" diagnostic rather than merely
    // uninformative.
    baseCategoryEntries = ["something-else.safetensors"];

    await expect(resolveModelsDirWithBases({ targetCategory: "vae" })).rejects.toThrow(
      /Refusing to download into/,
    );
  });

  it("does NOT refuse a multi-root base holding only METADATA (codex P0)", async () => {
    // "Has files of its own" has to mean MODEL files. Counting any directory entry treats
    // a .gitkeep or a desktop.ini as proof the base is a populated root, so an
    // extra_model_paths root with nothing but housekeeping in this category would be
    // refused — the working install this refinement exists to protect.
    config.comfyuiPath = "/second-root";
    getSystemStats.mockResolvedValue({ system: { argv: ["python"] } });
    serverInventory = { vae: ["lives-in-the-other-root.safetensors"] };
    modelsDirStat = "dir";
    existsFor = (p) => p.endsWith("models");
    baseCategoryEntries = [".gitkeep", "desktop.ini", "Thumbs.db"];

    const { modelsDir } = await resolveModelsDirWithBases({ targetCategory: "vae" });
    expect(modelsDir).toBe(resolve("/second-root", "models"));
  });

  it("a diffusers-style base IS contradicted — a nested model counts (codex P1)", async () => {
    // The first version treated "no model file at the top level" as "not populated", so a
    // stale base whose weights live in per-model folders sailed through and the download
    // went into the wrong install. One level down is enough for the real layout and stops
    // short of walking a models tree that can hold tens of thousands of files.
    config.comfyuiPath = "/stale-diffusers";
    getSystemStats.mockResolvedValue({ system: { argv: ["python"] } });
    serverInventory = { clip_vision: ["lives-elsewhere.safetensors"] };
    modelsDirStat = "dir";
    existsFor = (p) => p.endsWith("models");
    baseCategoryEntries = ["some-model-dir"];
    baseDirEntries = new Set(["some-model-dir"]);
    baseNestedEntries = ["model.safetensors"];

    await expect(
      resolveModelsDirWithBases({ targetCategory: "clip_vision" }),
    ).rejects.toThrow(/Refusing to download into/);
  });

  it("a SYMLINKED model file counts — Dirent.isFile() is false for links (codex P1)", async () => {
    // Sharing one model tree between installs by symlinking is ordinary practice, and this
    // file says so elsewhere. Requiring isFile() alone made a stale base whose models are
    // links read as EMPTY — reintroducing the misplaced write for exactly the users most
    // likely to be running two installs.
    config.comfyuiPath = "/stale-symlinked";
    getSystemStats.mockResolvedValue({ system: { argv: ["python"] } });
    serverInventory = { vae: ["elsewhere.safetensors"] };
    modelsDirStat = "dir";
    existsFor = (p) => p.endsWith("models");
    baseCategoryEntries = ["linked-model.safetensors"];
    baseSymlinkEntries = new Set(["linked-model.safetensors"]);

    await expect(resolveModelsDirWithBases({ targetCategory: "vae" })).rejects.toThrow(
      /Refusing to download into/,
    );
  });

  it("a DEEPER diffusers tree counts too — <repo>/transformer/model.safetensors (codex P1)", async () => {
    // One level down finds nothing in a real HF repo checkout, and "found nothing" was
    // read as "this base is empty", permitting the misplaced write.
    config.comfyuiPath = "/stale-deep";
    getSystemStats.mockResolvedValue({ system: { argv: ["python"] } });
    serverInventory = { clip_vision: ["elsewhere.safetensors"] };
    modelsDirStat = "dir";
    existsFor = (p) => p.endsWith("models");
    baseCategoryEntries = ["repo"];
    baseDirEntries = new Set(["repo", "transformer"]);
    baseNestedEntries = ["transformer"];
    // `transformer` resolves through the same nested list; give it a model at depth 2.
    baseDeepEntries = ["model.safetensors"];

    await expect(
      resolveModelsDirWithBases({ targetCategory: "clip_vision" }),
    ).rejects.toThrow(/Refusing to download into/);
  });

  it("a SYMLINKED model DIRECTORY counts — isDirectory() is false for those too (codex P1)", async () => {
    // The same trap as isFile(), and it caught the same users. `models/checkpoints/SDXL ->
    // /mnt/shared/SDXL` is what sharing one model tree between installs looks like, so the
    // population this gate protects read as empty and the misplaced write went ahead —
    // the symlinked-FILE fix above did nothing for them.
    config.comfyuiPath = "/stale-linked-dir";
    getSystemStats.mockResolvedValue({ system: { argv: ["python"] } });
    serverInventory = { clip_vision: ["elsewhere.safetensors"] };
    modelsDirStat = "dir";
    existsFor = (p) => p.endsWith("models");
    baseCategoryEntries = ["linked-dir"];
    // A link to a directory: isDirectory() FALSE, isSymbolicLink() TRUE — Node's real
    // Dirent semantics, pinned against the live filesystem in output-dir-symlink-fs.test.ts.
    baseSymlinkEntries = new Set(["linked-dir"]);
    baseNestedEntries = ["model.safetensors"];
    // Scoped to the link. statSync is consulted on other paths during resolution, and a
    // blanket stub answers those wrongly — the test then fails for an unrelated reason.
    statFor = statExceptFor((p) => p.endsWith("linked-dir"), {
      isDirectory: () => true,
      isFile: () => false,
    });

    await expect(
      resolveModelsDirWithBases({ targetCategory: "clip_vision" }),
    ).rejects.toThrow(/Refusing to download into/);
  });

  it("a BROKEN link does not abort the scan around it", async () => {
    // statSync on a dangling link throws. Letting it escape does not crash — an outer
    // catch swallows it — which is exactly why this needed a test that can fail: the
    // throw ABORTS the scan, so a base holding a stray broken link AND real models is
    // never contradicted, and the misplaced write proceeds.
    //
    // The link is listed FIRST on purpose. Behind it, a model that must still be found.
    config.comfyuiPath = "/broken-link";
    getSystemStats.mockResolvedValue({ system: { argv: ["python"] } });
    serverInventory = { clip_vision: ["lives-elsewhere.safetensors"] };
    modelsDirStat = "dir";
    existsFor = (p) => p.endsWith("models");
    baseCategoryEntries = ["dangling", "real-model.safetensors"];
    baseSymlinkEntries = new Set(["dangling"]);
    statFor = statExceptFor((p) => p.endsWith("dangling"), "enoent");

    await expect(
      resolveModelsDirWithBases({ targetCategory: "clip_vision" }),
    ).rejects.toThrow(/Refusing to download into/);
  });

  it("the scan is bounded — a huge category does not become thousands of readdirs (codex P2)", async () => {
    // Depth alone bounds nothing: 10k empty subdirectories is 10k synchronous readdirs on
    // the download path. The bound is generous (512) because a real diffusers layout
    // answers from the first directory it reads — it exists for the pathological tree, not
    // the ordinary one.
    config.comfyuiPath = "/huge";
    getSystemStats.mockResolvedValue({ system: { argv: ["python"] } });
    serverInventory = { clip_vision: ["lives-elsewhere.safetensors"] };
    modelsDirStat = "dir";
    existsFor = (p) => p.endsWith("models");
    const many = Array.from({ length: 5000 }, (_, i) => `dir-${i}`);
    baseCategoryEntries = many;
    baseDirEntries = new Set(many);
    baseNestedEntries = [];
    readdirCalls = 0;
    statCalls = 0;

    const { modelsDir } = await resolveModelsDirWithBases({ targetCategory: "clip_vision" });
    expect(modelsDir).toBe(resolve("/huge", "models"));
    // The bound, asserted as a number rather than a vibe. Without it this is 5001.
    expect(readdirCalls).toBeLessThanOrEqual(520);
    // ...and it really did have thousands of chances to exceed it.
    expect(readdirCalls).toBeGreaterThan(100);
  });

  it("SYMLINK entries are bounded too — the stat is itself the work (codex P2)", async () => {
    // Bounding readdirs left this shape exactly as unbounded as before: `.some()` resolves
    // every link with statSync and only THEN lets the recursion decline for want of
    // budget. Thousands of symlinks in one category is the tree the symlink fix newly made
    // reachable, so it is the tree that had to be bounded with it.
    //
    // The links point at FILES, deliberately. A link to a DIRECTORY consumes the readdir
    // budget, so that budget bounds the stats as a side effect and the stat cap could be
    // deleted with every test still green — mutation testing caught exactly that. A link
    // to a file consumes nothing, so this shape is bounded by the stat cap alone.
    config.comfyuiPath = "/huge-links";
    getSystemStats.mockResolvedValue({ system: { argv: ["python"] } });
    serverInventory = { clip_vision: ["lives-elsewhere.safetensors"] };
    modelsDirStat = "dir";
    existsFor = (p) => p.endsWith("models");
    // No model extension, so the entries are not counted as models on their names.
    const many = Array.from({ length: 20000 }, (_, i) => `link-${i}`);
    baseCategoryEntries = many;
    baseSymlinkEntries = new Set(many);
    baseNestedEntries = [];
    statFor = statExceptFor((p) => /link-\d+$/.test(p), {
      isDirectory: () => false,
      isFile: () => true,
    });
    readdirCalls = 0;
    statCalls = 0;

    const { modelsDir } = await resolveModelsDirWithBases({ targetCategory: "clip_vision" });
    expect(modelsDir).toBe(resolve("/huge-links", "models"));
    // The cap is 4096; without it this is 20000.
    expect(statCalls, "every link must not be resolved").toBeLessThanOrEqual(4200);
    expect(statCalls, "...and it really had 20k chances to exceed it").toBeGreaterThan(1000);
    // Nothing recursed, so the readdir budget never applied — the stat cap is the only
    // thing standing between this tree and 20k syscalls.
    expect(readdirCalls).toBeLessThanOrEqual(3);
  });

  it("a TRUNCATED scan is reported, not folded into an empty-base finding (codex P1)", async () => {
    // The dangerous half. A stale base whose only model sits behind the 512th directory
    // looks exactly like an empty one, so the refusal is skipped and the file lands in an
    // install the connected server never reads — the silent misplaced write this entire
    // check exists to stop, reintroduced by its own bound.
    //
    // Refusing on an inconclusive scan is worse (it blocks working installs, which was an
    // earlier P0 here), so the download proceeds — but the user is told the check did not
    // finish, which is the one thing they cannot otherwise know.
    const warn = vi.mocked(logger.warn);
    warn.mockClear();
    config.comfyuiPath = "/truncated";
    getSystemStats.mockResolvedValue({ system: { argv: ["python"] } });
    serverInventory = { clip_vision: ["lives-elsewhere.safetensors"] };
    modelsDirStat = "dir";
    existsFor = (p) => p.endsWith("models");
    const many = Array.from({ length: 5000 }, (_, i) => `dir-${i}`);
    baseCategoryEntries = many;
    baseDirEntries = new Set(many);
    baseNestedEntries = [];

    await resolveModelsDirWithBases({ targetCategory: "clip_vision" });
    const said = warn.mock.calls.map((c) => String(c[0])).join(" ");
    expect(said).toMatch(/did not finish/);
    expect(said).toMatch(/NOT a finding that this/);
  });

  it("...and a scan that COMPLETES says nothing about truncation", async () => {
    // The over-broad direction: warning on every ordinary resolve would train the user to
    // ignore the one that matters.
    const warn = vi.mocked(logger.warn);
    warn.mockClear();
    config.comfyuiPath = "/small";
    getSystemStats.mockResolvedValue({ system: { argv: ["python"] } });
    serverInventory = { clip_vision: ["lives-elsewhere.safetensors"] };
    modelsDirStat = "dir";
    existsFor = (p) => p.endsWith("models");
    baseCategoryEntries = ["a", "b"];
    baseDirEntries = new Set(["a", "b"]);
    baseNestedEntries = [];

    await resolveModelsDirWithBases({ targetCategory: "clip_vision" });
    expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).not.toMatch(/did not finish/);
  });

  it("…but an EMPTY subfolder is still not evidence", async () => {
    // The metadata hole in another costume: a folder that holds nothing says nothing.
    config.comfyuiPath = "/empty-subfolder";
    getSystemStats.mockResolvedValue({ system: { argv: ["python"] } });
    serverInventory = { clip_vision: ["lives-elsewhere.safetensors"] };
    modelsDirStat = "dir";
    existsFor = (p) => p.endsWith("models");
    baseCategoryEntries = ["empty-dir"];
    baseDirEntries = new Set(["empty-dir"]);
    baseNestedEntries = [];

    const { modelsDir } = await resolveModelsDirWithBases({ targetCategory: "clip_vision" });
    expect(modelsDir).toBe(resolve("/empty-subfolder", "models"));
  });

  it("a DIRECTORY named *.safetensors is not a model (codex)", async () => {
    // Counting it would refuse a working base on the strength of a folder name.
    config.comfyuiPath = "/folder-named-like-a-model";
    getSystemStats.mockResolvedValue({ system: { argv: ["python"] } });
    serverInventory = { vae: ["elsewhere.safetensors"] };
    modelsDirStat = "dir";
    existsFor = (p) => p.endsWith("models");
    baseCategoryEntries = ["looks_like.safetensors"];
    baseDirEntries = new Set(["looks_like.safetensors"]);
    baseNestedEntries = [];

    const { modelsDir } = await resolveModelsDirWithBases({ targetCategory: "vae" });
    expect(modelsDir).toBe(resolve("/folder-named-like-a-model", "models"));
  });


  it("does NOT refuse a multi-root base that is simply EMPTY for this category", async () => {
    // THE P0 DIRECTION. An extra_model_paths layout can legitimately have this base as one
    // of the server's roots with nothing in this category yet — indistinguishable from a
    // stale base by filename listing alone. Refusing it would block a working install,
    // which is worse than the wrong-directory write this gate exists to stop.
    config.comfyuiPath = "/second-root";
    getSystemStats.mockResolvedValue({ system: { argv: ["python"] } });
    serverInventory = { vae: ["lives-in-the-other-root.safetensors"] };
    modelsDirStat = "dir";
    existsFor = (p) => p.endsWith("models");
    baseCategoryEntries = [];

    const { modelsDir } = await resolveModelsDirWithBases({ targetCategory: "vae" });
    expect(modelsDir).toBe(resolve("/second-root", "models"));
  });

  it("still writes when the server lists NOTHING — absence of evidence is not evidence", async () => {
    // THE OVER-BROAD DIRECTION, and the reason this gate is contradiction-only. A fresh
    // install has an empty models dir, corroborates nothing, and must still take its FIRST
    // download. Refusing here would break every new setup.
    config.comfyuiPath = "/fresh-install";
    getSystemStats.mockResolvedValue({ system: { argv: ["python"] } });
    serverInventory = { vae: [] };
    modelsDirStat = "dir";
    existsFor = (p) => p.endsWith("models");

    const { modelsDir, source } = await resolveModelsDirWithBases({ targetCategory: "vae" });
    expect(modelsDir).toBe(resolve("/fresh-install", "models"));
    expect(source).toBe("configured-base");
  });

  it("still writes when the server is UNREACHABLE — nothing was established either way", async () => {
    config.comfyuiPath = "/offline-install";
    getSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));
    serverInventory = undefined;

    const { modelsDir } = await resolveModelsDirWithBases({ targetCategory: "vae" });
    expect(modelsDir).toBe(resolve("/offline-install", "models"));
  });

  it("still writes when NO category was named — the check cannot contradict what it never asked", async () => {
    config.comfyuiPath = "/unknown-category";
    getSystemStats.mockResolvedValue({ system: { argv: ["python"] } });
    serverInventory = { vae: ["something.safetensors"] };
    modelsDirStat = "dir";
    existsFor = (p) => p.endsWith("models");

    const { modelsDir } = await resolveModelsDirWithBases();
    expect(modelsDir).toBe(resolve("/unknown-category", "models"));
  });
});

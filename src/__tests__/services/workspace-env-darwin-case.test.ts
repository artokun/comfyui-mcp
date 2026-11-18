// targetsLiveInstall on a CASE-SENSITIVE macOS volume (#2985 review).
//
// The install-identity check authorizes handing the RUNNING server's interpreter out
// for the requested root. On a case-sensitive APFS volume `/work/ComfyUI` and
// `/work/comfyui` are two installs that realpath leaves distinct, so folding case
// there (as the shared `canonicalRoot` does for darwin) would call them one. Neither
// CI's macOS runner (case-insensitive APFS) nor the Windows/Linux runners can host
// that pair, so the platform is reported as darwin and the volume is VIRTUAL: a
// case-sensitive map of files, directories and links under one synthetic root, with
// every other path falling through to the real filesystem.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";

const v = vi.hoisted(() => ({
  platform: undefined as string | undefined,
  root: "",
  files: new Set<string>(),
  dirs: new Set<string>(),
  /** Exact-case link path → target, applied as a path PREFIX (directory links). */
  links: new Map<string, string>(),
}));

function enoent(p: string): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: no such file or directory, '${p}'`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: () => (v.platform ?? actual.platform()) as NodeJS.Platform };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const virtual = (p: unknown): string | undefined => {
    const s = String(p);
    return v.root && (s === v.root || s.startsWith(v.root + "\\") || s.startsWith(v.root + "/"))
      ? s
      : undefined;
  };
  /** Follow directory links by exact-case prefix — the volume is case-SENSITIVE. */
  const follow = (p: string): string => {
    for (const [link, target] of v.links) {
      if (p === link) return target;
      for (const sepc of ["\\", "/"]) {
        if (p.startsWith(link + sepc)) return target + p.slice(link.length);
      }
    }
    return p;
  };
  const stat = (p: string) => {
    const real = follow(p);
    if (v.files.has(real)) return { isFile: () => true, isDirectory: () => false };
    if (v.dirs.has(real)) return { isFile: () => false, isDirectory: () => true };
    throw enoent(p);
  };
  const realpathSync = ((p: unknown, ...rest: unknown[]) => {
    const s = virtual(p);
    if (s === undefined) return (actual.realpathSync as (...a: unknown[]) => unknown)(p, ...rest);
    const real = follow(s);
    if (v.files.has(real) || v.dirs.has(real)) return real;
    throw enoent(s);
  }) as typeof actual.realpathSync;
  realpathSync.native = realpathSync as unknown as typeof actual.realpathSync.native;
  return {
    ...actual,
    realpathSync,
    statSync: ((p: unknown, ...rest: unknown[]) => {
      const s = virtual(p);
      return s === undefined ? (actual.statSync as (...a: unknown[]) => unknown)(p, ...rest) : stat(s);
    }) as typeof actual.statSync,
    lstatSync: ((p: unknown, ...rest: unknown[]) => {
      const s = virtual(p);
      if (s === undefined) return (actual.lstatSync as (...a: unknown[]) => unknown)(p, ...rest);
      if (v.links.has(s)) return { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
      return { ...stat(s), isSymbolicLink: () => false };
    }) as typeof actual.lstatSync,
    existsSync: ((p: unknown) => {
      const s = virtual(p);
      if (s === undefined) return actual.existsSync(p as string);
      const real = follow(s);
      return v.files.has(real) || v.dirs.has(real);
    }) as typeof actual.existsSync,
  };
});

const h = vi.hoisted(() => ({
  mockGetSystemStats: vi.fn(),
  mockLiveInterpreter: vi.fn(() => undefined as unknown),
  execFileResponder: (() => new Error("not configured")) as (
    cmd: string,
    args: string[],
  ) => { stdout?: string } | Error,
}));

vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined, comfyuiCodePath: undefined, resolvedPort: 8188 },
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
  isRemoteMode: () => false,
}));
vi.mock("../../comfyui/client.js", () => ({ getSystemStats: () => h.mockGetSystemStats() }));
vi.mock("../../services/live-interpreter.js", () => ({
  resolveLiveInterpreter: (...args: unknown[]) => h.mockLiveInterpreter(...(args as [])),
  observeLiveServerProcess: (...args: unknown[]) => h.mockLiveInterpreter(...(args as [])),
}));
vi.mock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void,
  ) => {
    const result = h.execFileResponder(cmd, args);
    if (result instanceof Error) cb(result);
    else cb(null, { stdout: result.stdout ?? "", stderr: "" });
  },
}));

const { resolveInstallInterpreter, resetWorkspaceConfig } = await import(
  "../../services/workspace-env.js"
);

const PY = "/Volumes/CaseSensitive/ComfyUI/.venv/bin/python3";

/** A virtual directory holding a main.py (an install root). */
function install(dir: string): string {
  v.dirs.add(dir);
  v.files.add(join(dir, "main.py"));
  return dir;
}

/** The running server is the install at `serverRoot`, and the OS observed its python. */
function serverAt(serverRoot: string): void {
  h.mockGetSystemStats.mockResolvedValue({
    system: {
      argv: [join(serverRoot, "main.py")],
      python_version: "3.12.12",
      pytorch_version: "2.13.0",
    },
  });
  h.mockLiveInterpreter.mockReturnValue({ python: PY, source: "process-table", pid: 777 });
  h.execFileResponder = (_cmd, args) => {
    if (args.includes("--version") || args.some((a) => a.includes("sys.version"))) {
      return { stdout: "Python 3.12.12\n" };
    }
    if (args.includes("pip")) return { stdout: "Name: torch\nVersion: 2.13.0\n" };
    return new Error("nope");
  };
}

let work: string;
beforeEach(() => {
  v.platform = "darwin";
  v.root = resolve("/cmcp-2985-case-sensitive-volume");
  v.files.clear();
  v.dirs.clear();
  v.links.clear();
  work = join(v.root, "work");
  v.dirs.add(v.root);
  v.dirs.add(work);
  resetWorkspaceConfig();
});
afterEach(() => {
  v.platform = undefined;
  v.root = "";
  resetWorkspaceConfig();
});

describe("targetsLiveInstall — darwin, case-sensitive volume", () => {
  it("REFUSES a requested root that differs from the live root only by case", async () => {
    const live = install(join(work, "ComfyUI"));
    const other = install(join(work, "comfyui"));
    serverAt(live);

    const res = await resolveInstallInterpreter(other);
    expect(res.source).toBe("undetermined");
    expect(res.python).toBeUndefined();
    expect(res.reason).toContain("different install");
  });

  it("still accepts the live root itself", async () => {
    const live = install(join(work, "ComfyUI"));
    install(join(work, "comfyui"));
    serverAt(live);

    await expect(resolveInstallInterpreter(live)).resolves.toMatchObject({
      python: PY,
      source: "observed",
    });
  });

  it("still accepts an ALIAS (symlink) of the live root — the realpath'd spelling unifies it", async () => {
    const live = install(join(work, "ComfyUI"));
    const alias = join(v.root, "alias-to-comfy");
    v.links.set(alias, live);
    serverAt(live);

    await expect(resolveInstallInterpreter(alias)).resolves.toMatchObject({
      python: PY,
      source: "observed",
    });
  });

  it("bundle vs nested independent checkout is unchanged under darwin", async () => {
    // A bundle root WITHOUT its own main.py contains the live checkout → same install.
    const bundle = join(work, "Bundle");
    v.dirs.add(bundle);
    const nestedLive = install(join(bundle, "ComfyUI"));
    serverAt(nestedLive);
    await expect(resolveInstallInterpreter(bundle)).resolves.toMatchObject({ source: "observed" });

    // An outer root that IS an install (has main.py) does not own the nested one.
    const outer = install(join(work, "Outer"));
    const nestedIndependent = install(join(outer, "ComfyUI"));
    serverAt(nestedIndependent);
    const refused = await resolveInstallInterpreter(outer);
    expect(refused.source).toBe("undetermined");
    expect(refused.reason).toContain("different install");
  });
});

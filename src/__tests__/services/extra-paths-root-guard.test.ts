/**
 * Point-of-use revalidation of an INFERRED standalone root (#648, coordinator P1-2).
 *
 * Resolution and I/O are separated by awaits, so proving the root exists ONCE during
 * resolution is a TOCTOU check. Two things can happen in that window:
 *   - the root is DELETED  → a read must say UNRESOLVED, not return a phantom EMPTY
 *     config (readConfigFile maps a missing file to {}), and a write must not proceed;
 *   - the root is REPLACED by a different directory at the same pathname → neither read
 *     nor write may proceed, and `createParents: false` alone does not help because the
 *     path exists again.
 *
 * Both are only reachable deterministically by scripting `statSync` for the root, which
 * is what this file does: the real fs is used for everything else, and only the guarded
 * root's stat is driven from a queue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockIsRemoteMode = vi.hoisted(() => vi.fn(() => false));
vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined as string | undefined },
  isRemoteMode: mockIsRemoteMode,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
}));

// The real argv parsers are used — server behavior is expressed as launch argv.

const mockGetSystemStats = vi.hoisted(() =>
  vi.fn(async (): Promise<{ system?: { argv?: string[]; cwd?: string } }> => {
    throw new Error("unreachable");
  }),
);
vi.mock("../../comfyui/client.js", () => ({ getSystemStats: mockGetSystemStats }));

/**
 * Scripted stat results for ONE path. Each entry is either `{dev, ino}` (directory
 * present with that identity — `{dev: 0, ino: 0}` models a volume that reports no usable
 * identity) or null (gone). Entries are consumed in order; `consumed` records how many
 * were taken so a test can prove the guard actually ran the number of times it claims.
 */
type StatStep = { dev: number; ino: number } | null;
const script = vi.hoisted(() => ({
  path: "" as string,
  queue: [] as StatStep[],
  consumed: 0,
  /** Scripted symlink resolution: realpathSync(key) → value. Models a symlinked main.py
   *  on every platform (Windows needs privileges to create a real one). */
  realpath: {} as Record<string, string>,
  /** Per-path QUEUE of realpath answers, consumed before `realpath`. Used to prove the
   *  live root is resolved exactly ONCE (a second answer must never be reached). */
  realpathQueue: {} as Record<string, string[]>,
  /** Per-path errno for realpathSync. Models the lookup FAILING for a reason that says
   *  nothing about whether the file is there (EACCES on a parent dir, ELOOP, a stalled
   *  mount) — as distinct from ENOENT, which really is an absence. */
  realpathError: {} as Record<string, string>,
  /** Per-path errno for statSync, for the same reason: an EACCES must not be
   *  indistinguishable from an ENOENT to the code that reports what it found. */
  statError: {} as Record<string, string>,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: ((p: string, ...rest: unknown[]) => {
      const errno = script.statError[String(p)];
      if (errno) {
        const err = new Error(`${errno}: stat '${p}'`);
        (err as NodeJS.ErrnoException).code = errno;
        throw err;
      }
      if (script.path && String(p) === script.path && script.queue.length > 0) {
        const next = script.queue.shift() as StatStep;
        script.consumed += 1;
        if (next === null) {
          const err = new Error(`ENOENT: no such file or directory, stat '${p}'`);
          (err as NodeJS.ErrnoException).code = "ENOENT";
          throw err;
        }
        return { isDirectory: () => true, dev: next.dev, ino: next.ino } as unknown as ReturnType<
          typeof actual.statSync
        >;
      }
      return (actual.statSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.statSync,
    realpathSync: ((p: string, ...rest: unknown[]) => {
      const errno = script.realpathError[String(p)];
      if (errno) {
        const err = new Error(`${errno}: realpath '${p}'`);
        (err as NodeJS.ErrnoException).code = errno;
        throw err;
      }
      const queued = script.realpathQueue[String(p)];
      if (queued && queued.length > 0) return queued.shift() as string;
      const mapped = script.realpath[String(p)];
      if (mapped !== undefined) return mapped;
      return (actual.realpathSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.realpathSync,
  };
});

/** Shorthand: a present directory with identity `n` (0 → no usable identity). */
const at = (n: number): StatStep => ({ dev: n === 0 ? 0 : 42, ino: n });

import { config } from "../../config.js";
import { addExtraPath, listExtraPaths, removeExtraPath } from "../../services/extra-paths.js";
import { configureWorkspace, resetWorkspaceConfig } from "../../services/workspace-env.js";

let dirs: string[] = [];

async function trackTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "comfyui-root-guard-"));
  dirs.push(dir);
  return dir;
}

/** Persist a saved default workspace and arm the stat script for it. */
async function savedWorkspace(stats: StatStep[]): Promise<string> {
  const workspace = await trackTmp();
  const cfgDir = await trackTmp();
  const cfgPath = join(cfgDir, "workspace.json");
  await writeFile(cfgPath, JSON.stringify({ defaultWorkspace: workspace }), "utf-8");
  configureWorkspace({ configPath: cfgPath });
  script.path = workspace;
  script.queue = [...stats];
  script.consumed = 0;
  return workspace;
}

beforeEach(() => {
  config.comfyuiPath = undefined;
  delete process.env.COMFYUI_PATH;
  mockIsRemoteMode.mockReturnValue(false);
  mockGetSystemStats.mockRejectedValue(new Error("unreachable"));
  dirs = [];
  script.path = "";
  script.queue = [];
  script.consumed = 0;
  script.realpath = {};
  script.realpathQueue = {};
  script.realpathError = {};
  script.statError = {};
});

afterEach(async () => {
  resetWorkspaceConfig();
  script.path = "";
  script.queue = [];
  script.realpath = {};
  script.realpathQueue = {};
  script.realpathError = {};
  script.statError = {};
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("inferred root revalidation at the point of use", () => {
  it("list: a root that DISAPPEARS after the resolution gate is UNRESOLVED, not empty", async () => {
    // stat #1 = the resolution gate (present); stat #2 = the pre-read revalidation (gone).
    await savedWorkspace([at(1), null]);

    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(
      /UNRESOLVED.*no longer an existing directory/s,
    );
    expect(script.consumed).toBe(2); // it really got as far as the pre-read check
  });

  it("list: a root REPLACED by a different directory is UNRESOLVED", async () => {
    // Same pathname, different inode → not the tree this call resolved.
    await savedWorkspace([at(1), at(2)]);

    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(
      /UNRESOLVED.*REPLACED by a different directory/s,
    );
  });

  it("list: a root replaced DURING the read is caught by the POST-read revalidation", async () => {
    // #1 gate, #2 pre-read (fine — the read proceeds), #3 post-read (replaced). Without
    // the post-read check this would return a normal result built from the old tree.
    await savedWorkspace([at(1), at(1), at(2)]);

    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(
      /REPLACED by a different directory/,
    );
    expect(script.consumed).toBe(3);
  });

  it("add: a root REPLACED between the read and the write is refused, and nothing is written", async () => {
    // #1 gate, #2 pre-read, #3 post-read (fine — the add proceeds), #4 pre-write (replaced).
    const workspace = await savedWorkspace([at(1), at(1), at(1), at(2)]);

    await expect(
      addExtraPath({ target: "standalone", category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/REPLACED by a different directory/);
    expect(existsSync(join(workspace, "extra_model_paths.yaml"))).toBe(false);
    expect(script.consumed).toBe(4);
  });

  it("add: a NO-OP add under a root replaced DURING the read surfaces the guard, not stale data", async () => {
    // The path is already present, so nothing is written — but the "already present"
    // answer and the returned groups came from a tree that no longer exists at that
    // pathname. The post-read guard must fire on the no-op path too (#648 review).
    const workspace = await savedWorkspace([at(1), at(1), at(2)]);
    await writeFile(
      join(workspace, "extra_model_paths.yaml"),
      "comfyui_mcp:\n  loras: E:/loras\n",
      "utf-8",
    );

    await expect(
      addExtraPath({ target: "standalone", category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/REPLACED by a different directory/);
    expect(script.consumed).toBe(3); // gate, pre-read, post-read — no write was reached
  });

  it("add: a root that DISAPPEARS between the read and the write is refused", async () => {
    const workspace = await savedWorkspace([at(1), at(1), at(1), null]);

    await expect(
      addExtraPath({ target: "standalone", category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/no longer an existing directory/);
    expect(existsSync(join(workspace, "extra_model_paths.yaml"))).toBe(false);
  });

  it("remove: the same guard applies to the removal write path", async () => {
    const workspace = await savedWorkspace([at(1), at(1), at(1), at(2)]);
    await writeFile(
      join(workspace, "extra_model_paths.yaml"),
      "comfyui_mcp:\n  loras: E:/loras\n",
      "utf-8",
    );

    await expect(
      removeExtraPath({ target: "standalone", category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/REPLACED by a different directory/);
    // The original config is untouched.
    expect(
      await readFile(join(workspace, "extra_model_paths.yaml"), "utf-8"),
    ).toContain("E:/loras");
  });

  it("remove: a NO-OP remove under a root replaced DURING the read surfaces the guard too", async () => {
    // "Was not present" computed from the PRIOR tree's data is equally stale (#648 review).
    const workspace = await savedWorkspace([at(1), at(1), at(2)]);
    await writeFile(
      join(workspace, "extra_model_paths.yaml"),
      "comfyui_mcp:\n  vae: E:/vae\n",
      "utf-8",
    );

    await expect(
      removeExtraPath({ target: "standalone", category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/REPLACED by a different directory/);
    expect(script.consumed).toBe(3); // gate, pre-read, post-read — no write was reached
  });

  it("a stable root passes every revalidation and the operation succeeds", async () => {
    // Exactly four scripted stats — gate, pre-read, post-read, pre-write — all the same
    // inode. Asserting the queue is EXHAUSTED proves the guard ran on every one of them
    // (a missing call would leave an entry behind).
    const workspace = await savedWorkspace([at(7), at(7), at(7), at(7)]);

    const added = await addExtraPath({
      target: "standalone",
      group: "shared",
      category: "loras",
      path: "E:/loras",
    });
    expect(added.changed).toBe(true);
    expect(added.path).toBe(join(workspace, "extra_model_paths.yaml"));
    expect(script.consumed).toBe(4);
    expect(script.queue).toHaveLength(0);
  });

  it("a filesystem reporting dev/ino 0 degrades to an existence check, never a refusal", async () => {
    // Some Windows volumes report no usable directory identity. The guard must then fall
    // back to plain existence rather than refusing everything it cannot fingerprint —
    // and must NOT read 0 !== 0 as a replacement.
    const workspace = await savedWorkspace([at(0), at(0), at(0), at(0)]);

    const added = await addExtraPath({ target: "standalone", category: "vae", path: "E:/vae" });
    expect(added.changed).toBe(true);
    expect(existsSync(join(workspace, "extra_model_paths.yaml"))).toBe(true);
    expect(script.consumed).toBe(4);
  });

  // #1788 — the divergence disclosure compares a PINNED config path against every file
  // the running server loads. That comparison is realpath-collapsed on purpose: here the
  // harmful direction is the false NEGATIVE, i.e. telling a user their edit is inert when
  // it lands in the very file the server reads. Scripted realpathSync so it is proven on
  // every platform (a real file symlink needs privileges on Windows).
  it("pinned config: a realpath ALIAS of the server's own config is not called inert", async () => {
    const liveRoot = await trackTmp();
    await writeFile(join(liveRoot, "main.py"), "# comfyui\n", "utf-8");
    const serverCfg = join(liveRoot, "instance-model-paths.yaml");
    await writeFile(serverCfg, "live:\n  ipadapter: D:/shared/ipadapter\n", "utf-8");
    const aliasDir = await trackTmp();
    const alias = join(aliasDir, "alias.yaml");
    await writeFile(alias, "live:\n  ipadapter: D:/shared/ipadapter\n", "utf-8");
    script.realpath[alias] = serverCfg;
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: ["python", join(liveRoot, "main.py"), "--extra-model-paths-config", serverCfg],
      },
    });

    const added = await addExtraPath({ configPath: alias, category: "vae", path: "D:/vae" });
    expect(added.notes.some((n) => /does not read this file/.test(n))).toBe(false);
    expect(added.message).toMatch(/Restart ComfyUI to apply it/);
  });

  it("pinned config: a path that is NOT an alias of any server config IS called inert", async () => {
    // The control for the test above: without it, a disclosure that never fires at all
    // would pass it just as well.
    const liveRoot = await trackTmp();
    await writeFile(join(liveRoot, "main.py"), "# comfyui\n", "utf-8");
    const serverCfg = join(liveRoot, "instance-model-paths.yaml");
    await writeFile(serverCfg, "live:\n  ipadapter: D:/shared/ipadapter\n", "utf-8");
    const other = join(await trackTmp(), "unrelated.yaml");
    await writeFile(other, "local:\n  vae: D:/vae\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: ["python", join(liveRoot, "main.py"), "--extra-model-paths-config", serverCfg],
      },
    });

    const added = await addExtraPath({ configPath: other, category: "vae", path: "D:/vae2" });
    expect(added.notes.some((n) => /RUNNING ComfyUI does not read this file/.test(n))).toBe(true);
    expect(added.message).not.toMatch(/Restart ComfyUI to apply it/);
    expect(added.message).toContain(serverCfg);
  });

  it("live root: a SYMLINKED main.py resolves to the real install root (platform-independent)", async () => {
    // ComfyUI reads the implicit config next to os.path.realpath(__file__). Scripted
    // realpathSync stands in for a symlink so this runs everywhere, including on a
    // Windows box that cannot create one.
    const launcher = await trackTmp();
    const real = await trackTmp();
    await writeFile(join(real, "main.py"), "# comfyui\n", "utf-8");
    script.realpath[join(launcher, "main.py")] = join(real, "main.py");
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["python", join(launcher, "main.py")] },
    });

    const added = await addExtraPath({ category: "loras", path: "E:/loras" });

    expect(added.path).toBe(join(real, "extra_model_paths.yaml"));
    expect(existsSync(join(real, "extra_model_paths.yaml"))).toBe(true);
    expect(existsSync(join(launcher, "extra_model_paths.yaml"))).toBe(false);
  });

  it("live root: the 'other configs' disclosure names the REAL root, not the launcher", async () => {
    // With a symlinked main.py, ComfyUI loads <real>/extra_model_paths.yaml. The note
    // tells the user to pass these to config_path, so naming the launcher spelling would
    // itself become a wrong-destination write (codex round 10).
    const launcher = await trackTmp();
    const real = await trackTmp();
    const flagged = join(await trackTmp(), "flag.yaml");
    await writeFile(join(real, "main.py"), "# comfyui\n", "utf-8");
    await writeFile(join(real, "extra_model_paths.yaml"), "r:\n  vae: E:/r\n", "utf-8");
    await writeFile(join(launcher, "extra_model_paths.yaml"), "L:\n  vae: E:/L\n", "utf-8");
    await writeFile(flagged, "f:\n  vae: E:/f\n", "utf-8");
    script.realpath[join(launcher, "main.py")] = join(real, "main.py");
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: ["python", join(launcher, "main.py"), "--extra-model-paths-config", flagged],
      },
    });

    const result = await listExtraPaths();

    expect(result.path).toBe(flagged);
    const disclosure = result.notes.find((n) => /ONE of several configs/i.test(n));
    expect(disclosure).toContain(join(real, "extra_model_paths.yaml"));
    expect(disclosure).not.toContain(join(launcher, "extra_model_paths.yaml"));
  });

  it("live root: the argv script is realpath'd EXACTLY ONCE (a retarget cannot switch roots)", async () => {
    // Two realpath answers are queued. The proven root must be the FIRST one, and the
    // second must never be consumed — otherwise a symlink retargeted between two
    // resolutions could select a different root than the one reported and guarded.
    const launcher = await trackTmp();
    const realA = await trackTmp();
    const realB = await trackTmp();
    await writeFile(join(realA, "main.py"), "# comfyui\n", "utf-8");
    await writeFile(join(realB, "main.py"), "# comfyui\n", "utf-8");
    script.realpathQueue[join(launcher, "main.py")] = [
      join(realA, "main.py"),
      join(realB, "main.py"),
    ];
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["python", join(launcher, "main.py")] },
    });

    const added = await addExtraPath({ category: "loras", path: "E:/loras" });

    expect(added.path).toBe(join(realA, "extra_model_paths.yaml"));
    expect(existsSync(join(realB, "extra_model_paths.yaml"))).toBe(false);
    // The second queued answer was never reached.
    expect(script.realpathQueue[join(launcher, "main.py")]).toHaveLength(1);
  });

  it("live root: it is GUARDED too — a replacement mid-call is refused", async () => {
    // The live root is derived from argv, so it gets the same point-of-use guard as any
    // other root this process derived (codex round 6, P1b).
    const live = await trackTmp();
    await writeFile(join(live, "main.py"), "# comfyui\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({ system: { argv: ["python", join(live, "main.py")] } });
    script.path = live;
    script.queue = [at(1), at(1), at(1), at(2)]; // gate, pre-read, post-read, pre-write (replaced)
    script.consumed = 0;

    await expect(addExtraPath({ category: "loras", path: "E:/loras" })).rejects.toThrow(
      /REPLACED by a different directory/,
    );
    expect(existsSync(join(live, "extra_model_paths.yaml"))).toBe(false);
  });

  it("a root whose identity only BECOMES available mid-call is not treated as replaced", async () => {
    // Gate saw no identity (0) but a later stat reports one: nothing proves a change, so
    // the operation must proceed rather than fail on an unprovable mismatch.
    await savedWorkspace([at(0), at(9), at(9), at(9)]);

    const added = await addExtraPath({ target: "standalone", category: "vae", path: "E:/vae" });
    expect(added.changed).toBe(true);
  });
});

describe("locality: 'could not look' is not 'it is not there'", () => {
  // realLiveRoot used to catch EVERY realpathSync failure and return undefined, and the
  // caller narrated that single bucket as one specific cause: "the server is running in
  // a container, WSL, or on another host reached over the network". An EACCES on an
  // intermediate directory — a macOS app bundle, a Windows ACL, a stalled network mount —
  // produces exactly the same undefined while proving nothing about where the server is.
  // The two states send the reader to two different fixes, so they must read differently.

  it("says the lookup FAILED (and does not claim a container) when realpath errors non-ENOENT", async () => {
    // A local target must be configured for the READ assertion below: the display-only
    // fallback lands on the local auto target, and with none configured `standaloneRoot`
    // refuses on its own. Without this the test passed on a developer machine that
    // happens to have a real ComfyUI Desktop config on disk and failed in CI — a test
    // whose outcome depended on the host, which is not a test of this code at all.
    const localRoot = await trackTmp();
    config.comfyuiPath = localRoot;
    process.env.COMFYUI_PATH = localRoot;
    const live = await trackTmp();
    const mainPy = join(live, "main.py");
    await writeFile(mainPy, "# comfyui\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({ system: { argv: ["python", mainPy] } });
    script.realpathError[mainPy] = "EACCES";

    // The WRITE still fails closed — but assert the REASON, not merely that it refused:
    // the old message asserted a cause that was never observed, and a state-only
    // assertion passes on both.
    const err = await addExtraPath({ category: "loras", path: "E:/loras" }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err).toBeDefined();
    expect(err?.message).toMatch(/could not determine whether its launch script/);
    expect(err?.message).toContain("EACCES");
    expect(err?.message).toMatch(/NOT a finding that the path is absent/);
    expect(err?.message).not.toMatch(/is running in a container/);

    // The READ does not refuse at all: it shows the local target and carries the same
    // observation forward as a caption.
    const listed = await listExtraPaths();
    expect(listed.serverResolved).not.toBe(true);
  });

  it("does not assert a container/WSL topology from a bare ENOENT either", async () => {
    // A local server whose main.py was renamed or deleted after startup produces exactly
    // this ENOENT. The old wording stated the topology as fact; the observation is that
    // the path does not resolve here, and the topologies are possibilities.
    const live = await trackTmp();
    const mainPy = join(live, "main.py");
    await writeFile(mainPy, "# comfyui\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({ system: { argv: ["python", mainPy] } });
    script.realpathError[mainPy] = "ENOENT";

    const err = await addExtraPath({ category: "loras", path: "E:/loras" }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/does not resolve to a file on this filesystem/);
    // Offered as a possibility ("it may never have been ours"), never asserted.
    expect(err?.message).toMatch(/it may never have been ours/);
    expect(err?.message).toMatch(/moved or deleted since the server started/);
    expect(err?.message).not.toMatch(/could not determine whether/);
  });

  it("the read-only fallback caption does not claim argv lacked main.py when it had one", async () => {
    // The fallback note hardcoded "its launch argv does not reveal main.py". Argv often
    // DOES reveal one and the lookup failed (EACCES, a stalled mount, a script deleted
    // since startup) — so the caption asserted a cause that had not happened, which is
    // the same defect the surrounding change exists to remove, one layer out.
    const root = await trackTmp();
    config.comfyuiPath = root;
    process.env.COMFYUI_PATH = root;
    const live = await trackTmp();
    const mainPy = join(live, "main.py");
    await writeFile(mainPy, "# comfyui\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({ system: { argv: ["python", mainPy] } });
    script.realpathError[mainPy] = "EACCES";

    const notes = (await listExtraPaths()).notes.join(" ");
    expect(notes).toMatch(/could not determine whether its launch script/);
    expect(notes).toContain("EACCES");
    expect(notes).not.toMatch(/argv does not reveal main\.py/);
    expect(notes).not.toMatch(/does not reveal a main\.py at all/);
  });

  it("an UNREADABLE config is never summarised as an empty one", async () => {
    // readConfigFile used `existsSync`, which answers false for EACCES exactly as it does
    // for ENOENT — so a config we could not look at came back as `{}` and was rendered as
    // "exists: false, no extra paths configured". That is a claim, made from a failed
    // look, in the one place a user would act on it (by adding a path that is already
    // there, or concluding their models are unconfigured).
    const root = await trackTmp();
    config.comfyuiPath = root;
    process.env.COMFYUI_PATH = root;
    const cfg = join(root, "extra_model_paths.yaml");
    await writeFile(cfg, "shared:\n  vae: E:/vae\n", "utf-8");
    script.path = cfg;
    script.queue = [];
    // Make statSync on the config file fail with EACCES rather than ENOENT.
    script.statError = { [cfg]: "EACCES" };

    const err = await listExtraPaths({ target: "standalone" }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/could not be inspected \(EACCES\)/);
    expect(err?.message).toMatch(/NOT a report that the file is missing/);
    expect(err?.message).toMatch(/an empty result would be a claim we have not earned/);
    // …and the file is untouched.
    expect(await readFile(cfg, "utf-8")).toBe("shared:\n  vae: E:/vae\n");
  });

  it("does not report the server-named config as missing when it merely could not be inspected", async () => {
    // The unproven-locality display path asked `existsSync(serverConfig)`, which answers
    // false for EACCES exactly as for ENOENT — and the caption then said "no file exists
    // at that path on this machine … the server's file tree is probably not this one".
    // That is a topology conclusion drawn from a failed stat.
    const root = await trackTmp();
    config.comfyuiPath = root;
    process.env.COMFYUI_PATH = root;
    const serverCfg = join(await trackTmp(), "shared_model_paths.yaml");
    await writeFile(serverCfg, "s:\n  vae: E:/v\n", "utf-8");
    // No main.py in argv → locality unproven; the config stat then fails with EACCES.
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["python", "-m", "comfyui", "--extra-model-paths-config", serverCfg] },
    });
    script.statError = { [serverCfg]: "EACCES" };

    const listed = await listExtraPaths();
    const notes = listed.notes.join(" ");
    expect(notes).toMatch(/could not determine whether a file is there/);
    expect(notes).toContain("EACCES");
    expect(notes).toMatch(/NOT a report that it is missing/);
    // The two wrong conclusions the old code reached must both be absent.
    expect(notes).not.toMatch(/no file exists at that path/);
    expect(notes).not.toMatch(/probably not this one/);
  });

  it("reports exists:true from the READ, not from a second stat that can fail on its own", async () => {
    // `summarize` used to re-stat the path AFTER readConfigFile had already read and
    // parsed it. Any failure of that second lookup — a transient Windows sharing
    // violation while an editor holds the file, a mount hiccup — became `exists: false`
    // about a file we had just finished reading, with its parsed groups sitting right
    // next to the claim.
    const root = await trackTmp();
    config.comfyuiPath = root;
    process.env.COMFYUI_PATH = root;
    const cfg = join(root, "extra_model_paths.yaml");
    await writeFile(cfg, "shared:\n  vae: E:/vae\n", "utf-8");
    // The read succeeds; only a LATER stat of the same path would fail. Scripting the
    // errno after the read is not possible with a plain map, so instead prove the
    // property directly: no stat of the config happens after the read at all.
    let statsOfConfig = 0;
    const originalError = script.statError;
    script.statError = new Proxy({} as Record<string, string>, {
      get: (_t, key) => {
        if (String(key) === cfg) statsOfConfig += 1;
        return undefined;
      },
    });
    try {
      const listed = await listExtraPaths({ target: "standalone" });
      expect(listed.exists).toBe(true);
      expect(listed.groups.map((g) => g.name)).toContain("shared");
      // Exactly one lookup — the one readConfigFile makes. A second would be a second
      // chance to be wrong about a file already read.
      expect(statsOfConfig).toBe(1);
    } finally {
      script.statError = originalError;
    }
  });

  it("does not leave a note asserting a file that vanished before the read", async () => {
    // Selecting the server-named path takes one stat; reading it takes another. If the
    // file is deleted in between, a note that had said "a file that exists on this
    // machine … its entries are reported here" would sit next to `exists: false` and an
    // empty group list — the response contradicting itself, with the prose asserting the
    // more confident half.
    const root = await trackTmp();
    config.comfyuiPath = root;
    process.env.COMFYUI_PATH = root;
    const serverCfg = join(await trackTmp(), "shared_model_paths.yaml");
    await writeFile(serverCfg, "s:\n  vae: E:/v\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["python", "-m", "comfyui", "--extra-model-paths-config", serverCfg] },
    });
    // Present for the selecting stat, gone for every stat after it.
    let seen = 0;
    script.statError = new Proxy({} as Record<string, string>, {
      get: (_t, key) => (String(key) === serverCfg && seen++ > 0 ? "ENOENT" : undefined),
    });

    const listed = await listExtraPaths();
    expect(listed.path).toBe(serverCfg);
    expect(listed.exists).toBe(false);
    expect(listed.groups).toEqual([]);
    const notes = listed.notes.join(" ");
    // The prose must not claim what `exists` just denied.
    expect(notes).not.toMatch(/a file that exists on this machine/i);
    expect(notes).not.toMatch(/entries reported here are read from/i);
    // …and it still says where the path came from, and that it is unconfirmed.
    expect(notes).toMatch(/reports in its own launch argv/);
    expect(notes).toMatch(/NOT CONFIRMED/);
  });

  it("a genuinely absent config is still an ordinary empty result, not a refusal", async () => {
    // The other direction — ENOENT really does mean "no entries", and turning that into a
    // refusal would break the ordinary first-run case.
    const root = await trackTmp();
    config.comfyuiPath = root;
    process.env.COMFYUI_PATH = root;

    const listed = await listExtraPaths({ target: "standalone" });
    expect(listed.exists).toBe(false);
    expect(listed.groups).toEqual([]);
  });
});

import { describe, expect, it, beforeEach, vi, type Mock } from "vitest";

// The pending-operation marker is a REAL file (panel-pin-guard). Point it at a
// temp path at MODULE scope so the suite never touches ~/.comfyui-mcp, and so
// parallel vitest workers get their own file instead of racing on one.
//
// Without this, every call here wrote live pending-op markers into the developer's
// own state, where the orchestrator reads them and warns on every pin write that a
// queued update or deferred restore may be outstanding. Same class as #837 (the
// suite writing to the real .env) and #859 (the real OAuth mirror).
process.env.COMFYUI_MCP_PANEL_PENDING = join(
  tmpdir(),
  `cmcp-pending-update-comfyui-${process.pid}.json`,
);


// --- Mocks --------------------------------------------------------------

// Mutable config the service reads via property access.
// Created with vi.hoisted so it exists before the hoisted vi.mock factory runs.
const mockConfig = vi.hoisted(() => ({
  comfyuiPath: "/fake/ComfyUI" as string | undefined,
  comfyuiCodePath: undefined as string | undefined,
  resolvedPort: 8188,
  comfyuiHost: "127.0.0.1",
  comfyuiSsl: false,
  githubToken: undefined as string | undefined,
}));

vi.mock("../../config.js", () => ({
  config: mockConfig,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
  // node-management (the update-all dialect path, #656) transitively imports
  // this; the mock must provide it or the named import fails at load.
  isLoopbackHost: (host?: string) => host === "127.0.0.1" || host === "localhost",
}));

// node-management pulls in comfy-cli → workspace-env, which calls
// promisify(execFile) at module load; keep the subprocess surface inert.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "{}", stderr: "" })),
}));

vi.mock("node:fs", async (importOriginal) => ({
  // existsSync stays mockable per-test; everything else delegates to the REAL
  // fs because update-all now takes the panel mutation lock (panel-pin-guard),
  // which is a real file — a partial mock left its mkdir/open/write undefined
  // and every update-all failed closed.
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(),
}));

// The panel mutation lock is a FILE (panel-pin-guard). Point it at a temp path
// so the suite never touches ~/.comfyui-mcp, and so parallel vitest workers get
// their own lock instead of serializing on one shared file.
process.env.COMFYUI_MCP_PANEL_LOCK = join(
  tmpdir(),
  `cmcp-lock-updatecomfyui-${process.pid}.lock`,
);

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The requirements install now resolves its interpreter through the shared
// fail-closed live-interpreter resolver (#651) — stub it per-test.
const mockResolveInstallInterpreter = vi.hoisted(() => vi.fn());
const mockResolveCodeRoot = vi.hoisted(() => vi.fn());

vi.mock("../../services/workspace-env.js", () => ({
  resolveInstallInterpreter: mockResolveInstallInterpreter,
  resolveEffectiveComfyUICodeBaseLive: mockResolveCodeRoot,
}));

import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  updateComfyUICore,
  updateAllCustomNodes,
  isStaleRemoteRefLock,
  isDetachedPullFailure,
} from "../../services/update-comfyui.js";
import { resetManagerApiCacheForTests } from "../../services/node-management.js";

const mockedExec = execFileSync as unknown as Mock;
const mockedExists = existsSync as unknown as Mock;

const BASE = "http://127.0.0.1:8188";

interface Call {
  url: string;
  path: string;
  method: string;
  body: unknown;
}

/** Which Manager generation the (single) URL is serving. */
type Persona = "legacy" | "v4" | "v2-batch";

const DRAINED = { total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false };

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * One ComfyUI whose Manager answers the dialect-detection probes according to
 * its persona, so updateAllCustomNodes exercises the SAME detectManagerApi
 * path as the other Manager operations (#656):
 *   "legacy"   = the 3.x custom-node Manager: no /v2/* at all, per-operation
 *                routes under /manager/*.
 *   "v4"       = normal pip Manager: the /v2 surface answers, is_legacy_manager_ui
 *                false, and NO bare /manager/* (an unregistered POST there is
 *                answered 405 by ComfyUI's frontend catchall — the misroute the
 *                old hardcoded-legacy update-all hit).
 *   "v2-batch" = pip Manager in legacy-UI mode: /v2 surface, is_legacy_manager_ui
 *                true.
 */
function stubManager(
  persona: Persona,
  opts: { updateAllStatus?: number; failStart?: "error" } = {},
) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const path = new URL(url).pathname;
    calls.push({ url, path, method, body });

    if (persona === "legacy") {
      if (path === "/manager/queue/status") return jsonResponse(DRAINED);
      if (path === "/manager/version") return new Response("V3.41", { status: 200 });
      if (path === "/manager/queue/update_all" && method === "POST") {
        const status = opts.updateAllStatus ?? 200;
        return new Response(status === 200 ? "" : String(status), { status });
      }
      if (path === "/manager/queue/start") {
        if (opts.failStart === "error") throw new Error("connection reset");
        return new Response("", { status: 200 });
      }
      // The 3.x custom-node Manager registers no /v2/* at all.
      return new Response("404: Not Found", { status: 404 });
    }

    // pip comfyui_manager (v4 lineage): the /v2 surface answers.
    if (path === "/v2/manager/queue/status") return jsonResponse(DRAINED);
    if (path === "/v2/manager/is_legacy_manager_ui") {
      return jsonResponse({ is_legacy_manager_ui: persona === "v2-batch" });
    }
    if (path === "/v2/manager/queue/update_all" && method === "POST") {
      return new Response("", { status: 200 });
    }
    if (path === "/v2/manager/queue/start") {
      if (opts.failStart === "error") throw new Error("connection reset");
      return new Response("", { status: 200 });
    }
    // A v4 host registers NO bare /manager/* route.
    if (path.startsWith("/manager/")) return new Response("405", { status: 405 });
    return new Response("404: Not Found", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const countOf = (calls: Call[], path: string, method = "POST"): number =>
  calls.filter((c) => c.path === path && c.method === method).length;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mockConfig.comfyuiPath = "/fake/ComfyUI";
  mockConfig.comfyuiCodePath = undefined;
  mockResolveCodeRoot.mockImplementation(
    async () => mockConfig.comfyuiCodePath ?? mockConfig.comfyuiPath,
  );
  // Default: the resolver has verified an interpreter; refusal tests override.
  mockResolveInstallInterpreter.mockResolvedValue({
    python: "/fake/ComfyUI/.venv/bin/python",
    source: "launched",
    reason: "test interpreter",
  });
  // The detected dialect is cached across calls — drop it so each test's
  // persona is probed fresh.
  resetManagerApiCacheForTests();
});

// --- updateComfyUICore --------------------------------------------------

describe("updateComfyUICore", () => {
  it("runs `git pull` then pip install when uv is unavailable", () => {
    // existsSync calls: path exists, uv.lock no, uv-receipt no, requirements yes
    mockedExists.mockImplementation((p: string) => {
      if (p === "/fake/ComfyUI") return true;
      if (p.endsWith("requirements.txt")) return true;
      return false; // uv.lock, uv-receipt.toml
    });
    // detectPackageManager probes `uv --version` -> throw to force pip
    mockedExec.mockImplementation((file: string) => {
      if (file === "uv" || file === "uv.exe") throw new Error("uv not found");
      return "ok";
    });

    const result = updateComfyUICore();
    return result.then((r) => {
      expect(r.package_manager).toBe("pip");
      expect(r.updated).toBe(true);
      expect(r.comfyui_path).toBe("/fake/ComfyUI");

      // `git pull` runs in the comfyui path. It is no longer the FIRST git call:
      // #945 brackets the pull with read-only `rev-parse`/`symbolic-ref` probes,
      // because a pull exiting 0 is not evidence that the checkout moved. Find
      // the pull rather than assuming its position.
      const gitCall = mockedExec.mock.calls.find(
        (c) => c[0] === "git" && Array.isArray(c[1]) && c[1][0] === "pull",
      );
      expect(gitCall).toBeDefined();
      expect(gitCall![1]).toEqual(["pull"]);
      expect(gitCall![2].cwd).toBe("/fake/ComfyUI");

      // pip install via python -m pip
      const pipCall = mockedExec.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1].includes("pip") && c[1].includes("-r"),
      );
      expect(pipCall).toBeDefined();
      expect(pipCall![1]).toContain("install");
      expect(pipCall![1]).toContain("requirements.txt");
      expect(pipCall![0]).toMatch(/python/);
    });
  });

  // #945 — the false success, end to end. The pure classifier is covered in
  // update-core-verification.test.ts; these cover the WIRING, which is what
  // actually reached the user: `updated: true` plus a requirements reinstall
  // for a checkout that never moved.
  describe("#945: a pull that moved nothing is not an update", () => {
    /** Scripts the git probes; everything else answers "ok". */
    const scriptGit = (probe: (args: string[]) => string | undefined) => {
      mockedExists.mockImplementation((p: string) => {
        if (p === "/fake/ComfyUI") return true;
        if (p.endsWith("requirements.txt")) return true;
        return false;
      });
      mockedExec.mockImplementation((file: string, args: string[]) => {
        if (file === "uv" || file === "uv.exe") throw new Error("uv not found"); // force pip
        if (file === "git") {
          const out = probe(args);
          if (out === undefined) throw new Error(`git ${args.join(" ")} failed`);
          return out;
        }
        return "ok";
      });
    };
    const pipCallsIn = (m: Mock) =>
      m.mock.calls.filter((c) => Array.isArray(c[1]) && c[1].includes("-r"));

    it("a DETACHED HEAD reports updated:false and skips the requirements reinstall", async () => {
      scriptGit((args) => {
        if (args[0] === "pull") return "Already up to date.";
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "dec5d945";
        if (args[0] === "symbolic-ref") return undefined; // detached
        return undefined; // no upstream either
      });

      const r = await updateComfyUICore();
      expect(r.updated).toBe(false);
      expect(r.message).toMatch(/was NOT updated/);
      expect(r.message).toMatch(/DETACHED/);
      expect(r.revision).toMatchObject({ before: "dec5d945", after: "dec5d945", branch: null });
      // The part that made the lie convincing: it looked like work.
      expect(pipCallsIn(mockedExec)).toHaveLength(0);
      expect(r.message).toMatch(/requirements were NOT reinstalled/);
    });

    it("an upstream that is AHEAD reports updated:false and names both shas", async () => {
      scriptGit((args) => {
        if (args[0] === "pull") return "Already up to date.";
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "dec5d945aaaa";
        if (args[0] === "symbolic-ref") return "master";
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "origin/master";
        if (args[0] === "rev-parse" && args[1] === "origin/master") return "2eb60796bbbb";
        return undefined;
      });

      const r = await updateComfyUICore();
      expect(r.updated).toBe(false);
      expect(r.message).toContain("dec5d945");
      expect(r.message).toContain("2eb60796");
      expect(r.revision?.matches_upstream).toBe(false);
      expect(pipCallsIn(mockedExec)).toHaveLength(0);
    });

    it("a HEAD that MOVED reports updated:true and does reinstall requirements", async () => {
      let pulled = false;
      scriptGit((args) => {
        if (args[0] === "pull") {
          pulled = true;
          return "Updating dec5d94..2eb6079";
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return pulled ? "2eb60796bbbb" : "dec5d945aaaa";
        }
        if (args[0] === "symbolic-ref") return "master";
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "origin/master";
        if (args[0] === "rev-parse" && args[1] === "origin/master") return "2eb60796bbbb";
        return undefined;
      });

      const r = await updateComfyUICore();
      expect(r.updated).toBe(true);
      expect(r.message).toMatch(/dec5d945 → 2eb60796/);
      expect(pipCallsIn(mockedExec).length).toBeGreaterThan(0);
    });

    it("HEAD already AT the upstream tip is a success, and says nothing was pulled", async () => {
      scriptGit((args) => {
        if (args[0] === "pull") return "Already up to date.";
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "2eb60796bbbb";
        if (args[0] === "symbolic-ref") return "master";
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "origin/master";
        if (args[0] === "rev-parse" && args[1] === "origin/master") return "2eb60796bbbb";
        return undefined;
      });

      const r = await updateComfyUICore();
      expect(r.updated).toBe(true);
      expect(r.message).toMatch(/nothing to pull/);
      expect(r.revision?.matches_upstream).toBe(true);
      // This IS a legitimate update call, so the dependency sync still runs.
      expect(pipCallsIn(mockedExec).length).toBeGreaterThan(0);
    });
  });

  it("uses uv when uv.lock is present", async () => {
    mockedExists.mockImplementation((p: string) => {
      if (p === "/fake/ComfyUI") return true;
      if (p.endsWith("uv.lock")) return true;
      if (p.endsWith("requirements.txt")) return true;
      return false;
    });
    mockedExec.mockReturnValue("ok");

    const r = await updateComfyUICore();
    expect(r.package_manager).toBe("uv");
    const uvCall = mockedExec.mock.calls.find((c) => c[0] === "uv");
    expect(uvCall).toBeDefined();
    // uv must be pinned via --python to the interpreter the resolver verified
    // (never an ambient env).
    expect(uvCall![1]).toEqual([
      "pip",
      "install",
      "--python",
      expect.stringMatching(/python/),
      "-r",
      "requirements.txt",
    ]);
    expect(uvCall![2].cwd).toBe("/fake/ComfyUI");
  });

  it("skips dependency install when requirements.txt is absent", async () => {
    mockedExists.mockImplementation((p: string) => p === "/fake/ComfyUI");
    mockedExec.mockImplementation((file: string) => {
      if (file === "uv" || file === "uv.exe") throw new Error("no uv");
      return "ok";
    });

    const r = await updateComfyUICore();
    // Only git pull should have run (no pip/uv install).
    const installCall = mockedExec.mock.calls.find(
      (c) => Array.isArray(c[1]) && c[1].includes("install"),
    );
    expect(installCall).toBeUndefined();
    expect(r.steps.length).toBe(1);
    expect(r.steps[0].command).toContain("git pull");
  });

  it("runs core git and dependency work in the split code root, not the data root", async () => {
    mockConfig.comfyuiPath = "/fake/data";
    mockConfig.comfyuiCodePath = "/fake/code";
    mockedExists.mockImplementation((p: string) => {
      if (p === "/fake/code") return true;
      if (p.endsWith("requirements.txt")) return false;
      return false;
    });
    mockedExec.mockImplementation((file: string) => {
      if (file === "uv" || file === "uv.exe") throw new Error("no uv");
      return "ok";
    });

    const r = await updateComfyUICore();
    expect(r.comfyui_path).toBe("/fake/code");
    const pull = mockedExec.mock.calls.find(
      (c) => c[0] === "git" && Array.isArray(c[1]) && c[1][0] === "pull",
    );
    expect(pull?.[2].cwd).toBe("/fake/code");
  });

  it("throws a clear error when comfyuiPath is undefined (remote mode)", async () => {
    mockConfig.comfyuiPath = undefined;
    await expect(updateComfyUICore()).rejects.toThrow(/no local code checkout/i);
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it("throws when the configured path does not exist", async () => {
    mockConfig.comfyuiPath = "/does/not/exist";
    mockedExists.mockReturnValue(false);
    await expect(updateComfyUICore()).rejects.toThrow(/does not exist/i);
  });

  it("surfaces a failed git pull as an error", async () => {
    mockedExists.mockImplementation((p: string) => p === "/fake/ComfyUI");
    mockedExec.mockImplementation((file: string) => {
      if (file === "git") {
        const err = new Error("exit 1") as Error & { stderr: string };
        err.stderr = "fatal: not a git repository";
        throw err;
      }
      throw new Error("no uv");
    });
    await expect(updateComfyUICore()).rejects.toThrow(/Command failed: git pull/);
  });

  // #2524 — install_comfyui(action:"update") used a bare `git pull`. A checkout
  // pinned at a detached release tag first failed because stale origin/dev
  // conflicted with new origin/dev/* refs, then (after a manual prune) failed
  // again because HEAD was detached. The tool threw PROCESS_CONTROL_ERROR with
  // raw git output instead of recovering or returning a structured action.
  describe("#2524: stale origin refs and detached version-tag checkouts", () => {
    const STALE_REF_LOCK =
      "error: cannot lock ref 'refs/remotes/origin/dev/Combo-RemoteOptions': " +
      "'refs/remotes/origin/dev' exists; cannot create " +
      "'refs/remotes/origin/dev/Combo-RemoteOptions'\n" +
      "error: some local refs could not be updated; try running\n" +
      " 'git remote prune origin' to remove any old, conflicting branches";
    const DETACHED_PULL =
      "You are not currently on a branch.\n" +
      "Please specify which branch you want to merge with.\n" +
      "See git-pull(1) for details.";

    it("classifies the reported ref-lock and detached-pull texts, and no others", () => {
      expect(isStaleRemoteRefLock(STALE_REF_LOCK)).toBe(true);
      expect(
        isStaleRemoteRefLock(
          "cannot lock ref refs/remotes/origin/dev/Combo-RemoteOptions: refs/remotes/origin/dev exists",
        ),
      ).toBe(true);
      expect(
        isStaleRemoteRefLock("fatal: Unable to create '/x/.git/index.lock': File exists."),
      ).toBe(false);
      expect(isStaleRemoteRefLock("fatal: not a git repository")).toBe(false);
      expect(isDetachedPullFailure(DETACHED_PULL)).toBe(true);
      expect(isDetachedPullFailure(STALE_REF_LOCK)).toBe(false);
    });

    const gitFail = (stderr: string): never => {
      const err = new Error("exit 1") as Error & { stderr: string };
      err.stderr = stderr;
      throw err;
    };

    const scriptGit = (probe: (args: string[]) => string | undefined) => {
      mockedExists.mockImplementation((p: string) => {
        if (p === "/fake/ComfyUI") return true;
        if (p.endsWith("requirements.txt")) return true;
        return false;
      });
      mockedExec.mockImplementation((file: string, args: string[]) => {
        if (file === "uv" || file === "uv.exe") throw new Error("uv not found");
        if (file === "git") {
          const out = probe(args);
          if (out === undefined) throw new Error(`git ${args.join(" ")} failed`);
          return out;
        }
        return "ok";
      });
    };

    const gitCalls = (name: string) =>
      mockedExec.mock.calls.filter(
        (c) => c[0] === "git" && Array.isArray(c[1]) && c[1][0] === name,
      );

    it("prunes origin once on a stale origin/dev ref-lock and retries the pull", async () => {
      let pulls = 0;
      scriptGit((args) => {
        if (args[0] === "pull") {
          pulls += 1;
          if (pulls === 1) gitFail(STALE_REF_LOCK);
          return "Updating dec5d94..2eb6079";
        }
        if (args[0] === "remote" && args[1] === "prune") return "Pruning origin";
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return pulls >= 2 ? "2eb60796bbbb" : "dec5d945aaaa";
        }
        if (args[0] === "symbolic-ref") return "master";
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "origin/master";
        if (args[0] === "rev-parse" && args[1] === "origin/master") return "2eb60796bbbb";
        return undefined;
      });

      const r = await updateComfyUICore();
      expect(r.updated).toBe(true);
      expect(gitCalls("pull")).toHaveLength(2);
      expect(gitCalls("remote").map((c) => c[1])).toEqual([["remote", "prune", "origin"]]);
      expect(gitCalls("checkout")).toHaveLength(0);
    });

    it("does not prune-retry a second ref-lock (recovery is once)", async () => {
      scriptGit((args) => {
        if (args[0] === "pull") gitFail(STALE_REF_LOCK);
        if (args[0] === "remote" && args[1] === "prune") return "Pruning origin";
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "dec5d945aaaa";
        if (args[0] === "symbolic-ref") return "master";
        return undefined;
      });

      await expect(updateComfyUICore()).rejects.toThrow(/cannot lock ref/);
      expect(gitCalls("pull")).toHaveLength(2);
      expect(gitCalls("remote")).toHaveLength(1);
    });

    it("attaches a clean detached tag checkout to local master, then recovers a stale ref-lock", async () => {
      // THE reported sequence: detached at v0.16.4, stale origin/dev, local
      // master present. Workaround was prune + checkout master + retry.
      let onMaster = false;
      let pulls = 0;
      scriptGit((args) => {
        if (args[0] === "symbolic-ref") return onMaster ? "master" : undefined;
        if (args[0] === "show-ref" && args.includes("refs/heads/master")) {
          return "dec5d945aaaa refs/heads/master";
        }
        if (args[0] === "status" && args.includes("--porcelain")) return "";
        if (args[0] === "checkout" && args[1] === "master") {
          onMaster = true;
          return "Switched to branch 'master'";
        }
        if (args[0] === "pull") {
          pulls += 1;
          if (pulls === 1) gitFail(STALE_REF_LOCK);
          return "Updating dec5d94..2eb6079";
        }
        if (args[0] === "remote" && args[1] === "prune") return "Pruning origin";
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return pulls >= 2 ? "2eb60796bbbb" : "dec5d945aaaa";
        }
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
          return onMaster ? "origin/master" : undefined;
        }
        if (args[0] === "rev-parse" && args[1] === "origin/master") return "2eb60796bbbb";
        return undefined;
      });

      const r = await updateComfyUICore();
      expect(r.updated).toBe(true);
      expect(r.revision?.branch).toBe("master");
      expect(gitCalls("checkout").map((c) => c[1])).toEqual([["checkout", "master"]]);
      expect(gitCalls("remote")).toHaveLength(1);
      expect(gitCalls("pull")).toHaveLength(2);
      const mutating = mockedExec.mock.calls
        .filter(
          (c) =>
            c[0] === "git" &&
            Array.isArray(c[1]) &&
            (c[1][0] === "checkout" || c[1][0] === "pull" || c[1][0] === "remote"),
        )
        .map((c) => (Array.isArray(c[1]) ? c[1].join(" ") : ""));
      expect(mutating).toEqual([
        "checkout master",
        "pull",
        "remote prune origin",
        "pull",
      ]);
    });

    it("returns a structured DETACHED action instead of PROCESS_CONTROL_ERROR when pull has no branch", async () => {
      scriptGit((args) => {
        if (args[0] === "pull") gitFail(DETACHED_PULL);
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "dec5d945aaaa";
        if (args[0] === "symbolic-ref") return undefined;
        return undefined;
      });

      const r = await updateComfyUICore();
      expect(r.updated).toBe(false);
      expect(r.message).toMatch(/DETACHED/);
      expect(r.message).toMatch(/git checkout master/);
      expect(r.message).not.toMatch(/Command failed: git pull/);
      expect(r.revision?.branch).toBeNull();
      expect(gitCalls("checkout")).toHaveLength(0);
    });

    it("does not switch a dirty detached checkout onto local master", async () => {
      scriptGit((args) => {
        if (args[0] === "symbolic-ref") return undefined;
        if (args[0] === "show-ref" && args.includes("refs/heads/master")) {
          return "dec5d945aaaa refs/heads/master";
        }
        if (args[0] === "status" && args.includes("--porcelain")) {
          return " M main.py";
        }
        if (args[0] === "pull") gitFail(DETACHED_PULL);
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "dec5d945aaaa";
        return undefined;
      });

      const r = await updateComfyUICore();
      expect(r.updated).toBe(false);
      expect(r.message).toMatch(/not clean/);
      expect(r.message).toMatch(/git checkout master/);
      expect(gitCalls("checkout")).toHaveLength(0);
    });

    it("does not treat an index.lock collision as a stale origin ref", async () => {
      scriptGit((args) => {
        if (args[0] === "pull") {
          gitFail("fatal: Unable to create '/fake/ComfyUI/.git/index.lock': File exists.");
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "dec5d945aaaa";
        if (args[0] === "symbolic-ref") return "master";
        return undefined;
      });

      await expect(updateComfyUICore()).rejects.toThrow(/index\.lock/);
      expect(gitCalls("pull")).toHaveLength(1);
      expect(gitCalls("remote")).toHaveLength(0);
    });

    it("after prune, a still-detached pull is a structured refusal not a raw git dump", async () => {
      let pulls = 0;
      scriptGit((args) => {
        if (args[0] === "pull") {
          pulls += 1;
          gitFail(pulls === 1 ? STALE_REF_LOCK : DETACHED_PULL);
        }
        if (args[0] === "remote" && args[1] === "prune") return "Pruning origin";
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "dec5d945aaaa";
        if (args[0] === "symbolic-ref") return undefined;
        return undefined;
      });

      const r = await updateComfyUICore();
      expect(r.updated).toBe(false);
      expect(r.message).toMatch(/DETACHED/);
      expect(r.message).not.toMatch(/Command failed: git pull/);
      expect(gitCalls("pull")).toHaveLength(2);
      expect(gitCalls("remote")).toHaveLength(1);
    });
  });

  it("refuses before git pull when the running server's interpreter cannot be verified (#651)", async () => {
    mockedExists.mockImplementation((p: string) => {
      if (p === "/fake/ComfyUI") return true;
      if (p.endsWith("requirements.txt")) return true;
      return false;
    });
    mockedExec.mockImplementation((file: string) => {
      if (file === "uv" || file === "uv.exe") throw new Error("uv not found");
      return "ok";
    });
    mockResolveInstallInterpreter.mockResolvedValue({
      source: "undetermined",
      reason:
        "Cannot verify the running server's interpreter: no local ComfyUI is reachable. " +
        "Start ComfyUI or connect to it first.",
    });

    await expect(updateComfyUICore()).rejects.toThrow(/Cannot update ComfyUI core/);
    await expect(updateComfyUICore()).rejects.toThrow(/Cannot verify the running server's interpreter/);
    // Fail CLOSED means no mutation at all: git pull never ran.
    expect(mockedExec.mock.calls.find((c) => c[0] === "git")).toBeUndefined();
  });

  it("still runs git pull alone when requirements.txt is absent, even if the interpreter is unverifiable", async () => {
    mockedExists.mockImplementation((p: string) => p === "/fake/ComfyUI");
    mockedExec.mockImplementation((file: string) => {
      if (file === "uv" || file === "uv.exe") throw new Error("no uv");
      return "ok";
    });
    mockResolveInstallInterpreter.mockResolvedValue({
      source: "undetermined",
      reason: "Cannot verify the running server's interpreter.",
    });

    const r = await updateComfyUICore();
    expect(r.steps.length).toBe(1);
    expect(r.steps[0].command).toContain("git pull");
    // No requirements install was due, so the resolver was never consulted.
    expect(mockResolveInstallInterpreter).not.toHaveBeenCalled();
  });
});

// --- updateAllCustomNodes ----------------------------------------------

describe("updateAllCustomNodes", () => {
  it("on a legacy 3.x host: POSTs /manager/queue/update_all then starts the queue", async () => {
    const calls = stubManager("legacy");

    const r = await updateAllCustomNodes();
    expect(r.updated).toBe(false);
    expect(r.endpoint).toBe("/manager/queue/update_all");
    expect(r.queue_started).toBe(true);

    const update = calls.find((c) => c.path === "/manager/queue/update_all");
    expect(update?.method).toBe("POST");
    expect(update?.url).toBe(`${BASE}/manager/queue/update_all`);
    // 3.x reads {mode} from the JSON body; no query string.
    expect(update?.body).toMatchObject({ mode: "remote" });
    expect(typeof (update?.body as { ui_id?: unknown }).ui_id).toBe("string");
    expect(countOf(calls, "/manager/queue/start")).toBe(1);
  });

  // #656: the old implementation hardcoded POST /manager/queue/update_all,
  // which a v4 host answers 405 (ComfyUI's frontend catchall) — the tool must
  // detect the dialect and speak v4 instead.
  it("on a v4 host: detects the dialect and POSTs /v2/manager/queue/update_all (never the legacy route)", async () => {
    const calls = stubManager("v4");

    const r = await updateAllCustomNodes();
    expect(r.updated).toBe(false);
    expect(r.endpoint).toBe("/v2/manager/queue/update_all");
    expect(r.queue_started).toBe(true);

    // The hardcoded-legacy misroute was never attempted.
    expect(countOf(calls, "/manager/queue/update_all")).toBe(0);
    expect(countOf(calls, "/manager/queue/start")).toBe(0);

    // v4 reads UpdateAllQueryParams from the QUERY string, not the body.
    const update = calls.find((c) => c.path === "/v2/manager/queue/update_all");
    expect(update?.method).toBe("POST");
    const u = new URL(update!.url);
    expect(u.searchParams.get("mode")).toBe("remote");
    expect(u.searchParams.get("client_id")).toBe("comfyui-mcp");
    expect(u.searchParams.get("ui_id")).toBeTruthy();
    expect(update?.body).toBeUndefined();

    expect(countOf(calls, "/v2/manager/queue/start")).toBe(1);
  });

  it("on a v2-batch host (pip Manager in legacy-UI mode): also routes at the /v2 update-all route", async () => {
    const calls = stubManager("v2-batch");

    const r = await updateAllCustomNodes();
    expect(r.endpoint).toBe("/v2/manager/queue/update_all");
    expect(countOf(calls, "/manager/queue/update_all")).toBe(0);
    expect(countOf(calls, "/v2/manager/queue/update_all")).toBe(1);
    expect(countOf(calls, "/v2/manager/queue/start")).toBe(1);
  });

  it("throws when Manager rejects update-all — and does NOT re-send the mutation", async () => {
    // A 404 is a route-level rejection: the dialect self-heal re-probes, finds
    // the dialect UNCHANGED (still legacy), and surfaces the original failure
    // instead of retrying — update-all must never execute twice (#656 caution).
    const calls = stubManager("legacy", { updateAllStatus: 404 });
    await expect(updateAllCustomNodes()).rejects.toThrow(/ComfyUI-Manager API 404/);
    expect(countOf(calls, "/manager/queue/update_all")).toBe(1);
    // The queue was never started, so no half-run operation is left behind.
    expect(countOf(calls, "/manager/queue/start")).toBe(0);
  });

  it("refuses before contacting Manager when the out-of-band pin-warning marker cannot persist", async () => {
    // A marker written after queueing can fail, then a later pin would be
    // reported as protective even though update-all can still land. Make its
    // parent a regular file so the preflight record is indeterminate/unwritable.
    const blocker = join(tmpdir(), `cmcp-pending-blocker-${process.pid}-${Date.now()}`);
    writeFileSync(blocker, "not a directory");
    const previous = process.env.COMFYUI_MCP_PANEL_PENDING;
    process.env.COMFYUI_MCP_PANEL_PENDING = join(blocker, "pending.json");
    try {
      const calls = stubManager("legacy");
      await expect(updateAllCustomNodes()).rejects.toThrow(/Could not persist the pending update-all marker/i);
      expect(calls).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.COMFYUI_MCP_PANEL_PENDING;
      else process.env.COMFYUI_MCP_PANEL_PENDING = previous;
      rmSync(blocker, { force: true });
    }
  });

  it("still succeeds (queue_started=false) if starting the queue fails", async () => {
    stubManager("legacy", { failStart: "error" });

    const r = await updateAllCustomNodes();
    expect(r.updated).toBe(false);
    expect(r.queue_started).toBe(false);
    expect(r.message).toMatch(/Could not confirm the queue worker started/);
  });

  it("throws a clear error when ComfyUI-Manager is unreachable", async () => {
    const fn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fn);
    await expect(updateAllCustomNodes()).rejects.toThrow(/queue API is not reachable/);
  });
});

// --- update-all semantics: custom nodes only (never core) ---------------

describe("update-all is custom-nodes-only", () => {
  it("runs no git/pip core-update commands (mirrors comfy-cli `update all`)", async () => {
    stubManager("legacy");
    await updateAllCustomNodes();
    // update-all touches ONLY the ComfyUI-Manager HTTP API — it must never
    // git pull / pip install ComfyUI core.
    expect(mockedExec).not.toHaveBeenCalled();
  });
});

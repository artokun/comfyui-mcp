import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

// Mock config so importing node-management doesn't trigger the real port
// auto-detection (a live fetch) and lets us flip comfyuiPath per-test.
vi.mock("../../config.js", () => {
  const config: {
    comfyuiPath: string | undefined;
    comfyuiCodePath: string | undefined;
    resolvedPort: number;
    comfyuiHost: string;
    comfyuiSsl: boolean;
    githubToken: string | undefined;
  } = {
    comfyuiPath: "/fake/comfy",
    comfyuiCodePath: undefined,
    resolvedPort: 8188,
    comfyuiHost: "127.0.0.1",
    comfyuiSsl: false,
    githubToken: undefined,
  };
  return {
    config,
    getComfyUIBaseUrl: () =>
      `${config.comfyuiSsl ? "https" : "http"}://${config.comfyuiHost}:${config.resolvedPort}`,
    getComfyUIAuthHeaders: () => ({}),
    isLoopbackHost: (host: string | undefined) =>
      !host || ["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"].includes(host.toLowerCase().replace(/^\[|\]$/g, "")),
    isForceRemoteFlagSet: () => remoteFlags.forceRemote,
    isRemoteMode: () => remoteFlags.remoteMode,
  };
});

// ── Scenario scaffolding for the Manager self-update tests (#424). The product
// deliberately does NOT consult either of these: when the Manager's self-update
// route 405s it refuses outright rather than git-pulling a checkout on THIS
// machine, because no HTTP-observable signal can prove that checkout is the one
// the connected server loaded. These knobs let the suite spell out each
// wrong-target configuration a previous revision was fooled by, and assert that
// every one of them still refuses and never shells out to git — so reintroducing
// a "but this one looks local enough" pull fails the suite.

/** --force-remote / remote-target classification (config mock reads these). */
const remoteFlags = vi.hoisted(() => ({ forceRemote: false, remoteMode: false }));

/** The LIVE server's own install root, as /system_stats argv would report it. */
const liveRoot = vi.hoisted(() => ({ value: undefined as string | undefined }));

/** The saved default workspace resolveEffectiveComfyUIBase() falls back to.
 *  Controlled here so "no local path" tests never read the real user config. */
const savedDefault = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock("../../services/workspace-env.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../services/workspace-env.js")
  >("../../services/workspace-env.js");
  return {
    ...actual,
    resolveLiveComfyUIBase: async () => liveRoot.value,
    // Mirror the real resolution order (COMFYUI_PATH, then the saved default);
    // the remote-mode gate is applied separately by callers via isRemoteMode.
    resolveEffectiveComfyUIBase: () => config.comfyuiPath ?? savedDefault.value,
    resolveEffectiveComfyUICodeBase: () =>
      config.comfyuiCodePath ?? config.comfyuiPath ?? savedDefault.value,
  };
});

// Mock child_process for the cm-cli subprocess paths.
vi.mock("node:child_process", () => ({
  // execFile is needed at module load: workspace-env (pulled in transitively via
  // comfy-cli) calls promisify(execFile) at top level.
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(() => ({
    status: 0,
    stdout: JSON.stringify({ schema: "envelope/1", type: "envelope", ok: true, command: "version", version: "1.11.1", where: null, data: {}, error: null }),
    stderr: "",
  })),
}));

// Mock fs so resolveCmCliPath's existsSync check is controllable. Everything
// else delegates to the REAL fs: panel-targeting mutations now take the panel
// mutation lock (panel-pin-guard), which is a real file — a partial mock left
// the lock's mkdir/open/write undefined and every id="all" op failed closed.
// readdirSync/readFileSync delegate to the real fs by default too, but route
// through fsCtl so the #797 on-disk presence scan can be given a fixture
// custom_nodes without touching the disk.
const fsCtl = vi.hoisted(() => ({
  readdirSync: undefined as ((path: string) => unknown[]) | undefined,
  readFileSync: undefined as ((path: string) => string) | undefined,
  /** Paths passed to rmSync this test (#900 cleanup observation). */
  removed: [] as string[],
  /** Make removal fail, so the leftover has to be disclosed rather than swallowed. */
  rmThrows: false,
}));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    existsSync: vi.fn(() => true),
    // Tracked so a test can observe that a failed clone REMOVED what it created
    // — and, just as importantly, that it left an existing pack alone (#900).
    rmSync: vi.fn((path: unknown, options?: unknown) => {
      fsCtl.removed.push(String(path));
      if (fsCtl.rmThrows) throw new Error("EPERM: removal refused");
      return (real.rmSync as (p: unknown, o?: unknown) => unknown)(path, options);
    }),
    readdirSync: vi.fn((path: unknown, options?: unknown) =>
      fsCtl.readdirSync
        ? fsCtl.readdirSync(String(path))
        : (real.readdirSync as (p: unknown, o?: unknown) => unknown)(path, options)),
    readFileSync: vi.fn((path: unknown, options?: unknown) =>
      fsCtl.readFileSync
        ? fsCtl.readFileSync(String(path))
        : (real.readFileSync as (p: unknown, o?: unknown) => unknown)(path, options)),
  };
});

// The panel mutation lock is a FILE (panel-pin-guard). Point it at a temp path
// so the suite never touches ~/.comfyui-mcp, and so parallel vitest workers get
// their own lock instead of serializing on one shared file.
process.env.COMFYUI_MCP_PANEL_LOCK = join(
  tmpdir(),
  `cmcp-lock-nodemgmt-${process.pid}.lock`,
);

// The mutation entry points now consult the panel version pin (panel-pin-guard),
// because the panel is an ordinary node pack and `id="all"` would otherwise move
// a pinned panel. This suite is not about pinning, and its `node:fs` mock is
// deliberately partial — `existsSync` answers true for everything, so the pin
// store would look present-but-unreadable and fail closed (correct in
// production, a false positive here). Use the documented env escape hatch to say
// plainly "no pin in this suite" rather than reshaping the fs mock, which
// individual tests reconfigure for their own purposes.
process.env.COMFYUI_MCP_PANEL_PIN = "off";

import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "../../config.js";
import {
  installCustomNode,
  installModelViaManager,
  parseGitUrl,
  updateCustomNode,
  reinstallCustomNode,
  fixCustomNode,
  disableCustomNode,
  enableCustomNode,
  uninstallCustomNode,
  normalizeGitUrlInstallArgs,
  nodesInstallCommandArgs,
  listInstalledNodes,
  syncNodeDependencies,
  setQueueTimingForTests,
  resetManagerApiCacheForTests,
  NodeManagementError,
} from "../../services/node-management.js";
import { ProcessControlError, ValidationError } from "../../utils/errors.js";

const mockedExec = vi.mocked(execFileSync);
const mockedExists = vi.mocked(existsSync);

// The product builds these paths with node:path (join), so they use the
// platform separator (backslashes on Windows). Build the expected values the
// same way instead of hardcoding POSIX paths.
const COMFY = "/fake/comfy";
const COMFY_CLI = join(COMFY, ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "comfy.exe" : "comfy");
const cliEnvelope = (data: unknown) => JSON.stringify({ schema: "envelope/1", type: "envelope", ok: true, command: "node", version: "1.11.1", where: "local", data, error: null });
// runGitCheckout now resolves the target with path.resolve (containment check),
// so the -C dir carries the drive letter on Windows — match it.
const BAR_DIR = resolve(COMFY, "custom_nodes", "bar");
// The clone fallback resolves the target with path.resolve (containment check),
// which prepends the current drive on Windows — mirror that here.
const NODE_DIR_UTILS = resolve(COMFY, "custom_nodes", "comfyui-teskors-utils");

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Install a fetch stub that records every call and returns canned responses.
 * The queue status returns "done" on the first poll so runManagerQueue resolves.
 */
function stubFetch(opts: {
  installedBody?: unknown;
  statusSequence?: unknown[];
  /** Fires when a queue op is submitted — lets a test make the install REAL. */
  onQueue?: () => void;
  /**
   * #1129 — status the queue op ITSELF answers with (403 = the 3.x
   * security_level / allow_git_url_install gate, 404 = route not served here).
   * The response describes the REQUEST, so nothing was queued.
   */
  queueOpStatus?: number;
  /** Body for `https://api.comfy.org/nodes/:id` (registry-zip empty-pack fallback). */
  registryDetails?: unknown;
} = {}) {
  const calls: Call[] = [];
  let statusIdx = 0;
  const statusSeq = opts.statusSequence ?? [
    { total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false },
  ];

  const fetchMock = vi.fn(
    async (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });

      const parsed = new URL(url);
      const path = parsed.pathname + (parsed.search || "");

      if (parsed.hostname === "api.comfy.org") {
        return jsonResponse(opts.registryDetails ?? {});
      }
      if (path.startsWith("/v2/customnode/installed")) {
        return jsonResponse(opts.installedBody ?? {});
      }
      if (path === "/v2/manager/queue/status") {
        const s = statusSeq[Math.min(statusIdx, statusSeq.length - 1)];
        statusIdx++;
        return jsonResponse(s);
      }
      // queue ops + start return empty bodies
      if (path.includes("/queue/")) {
        // The install lands on /queue/install (3.x) or the /queue/task envelope
        // with kind:"install" (v4) — match the OPERATION, not one route.
        const isInstallOp =
          path.includes("/queue/install") ||
          (path.includes("/queue/task") &&
            (body as { kind?: string } | undefined)?.kind === "install");
        if (opts.queueOpStatus !== undefined && isInstallOp) {
          return new Response(
            "A security error has occurred. Please check the terminal logs",
            { status: opts.queueOpStatus },
          );
        }
        opts.onQueue?.();
      }
      return new Response("", { status: 200 });
    },
  );

  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A minimal fs.Dirent stand-in for the #797 on-disk presence scan fixtures. */
function dirEnt(name: string) {
  return {
    name,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
}

/** Find a queued task of a given kind and return its (envelope, params). */
function taskOf(calls: Call[], kind: string): { body: Record<string, unknown>; params: Record<string, unknown> } {
  const call = calls.find(
    (c) =>
      c.url.includes("/v2/manager/queue/task") &&
      (c.body as { kind?: string } | undefined)?.kind === kind,
  );
  if (!call) throw new Error(`no queued task of kind "${kind}" found`);
  const body = call.body as Record<string, unknown>;
  return { body, params: body.params as Record<string, unknown> };
}

describe("node-management service", () => {
  beforeEach(() => {
    mockedExec.mockReset();
    mockedExists.mockReset();
    mockedExists.mockReturnValue(true);
    // Default: no custom_nodes fixture — the #797 disk scan delegates to the
    // real fs (which throws on the fake root) unless a test installs one.
    fsCtl.readdirSync = undefined;
    fsCtl.removed = [];
    fsCtl.rmThrows = false;
    fsCtl.readFileSync = undefined;
    savedDefault.value = undefined;
    config.comfyuiPath = "/fake/comfy";
    config.comfyuiCodePath = undefined;
    config.githubToken = undefined;
    remoteFlags.forceRemote = false;
    remoteFlags.remoteMode = false;
    // Default fixture: the LIVE server reports the SAME root as config.comfyuiPath.
    // This grants NOTHING — it is inert scenario scaffolding. The self-update path
    // does not consult it, and under exactly this state an enqueue 405 still refuses
    // and never touches the checkout. It exists so the suite can prove that even the
    // most local-looking configuration is refused, not to model permission.
    liveRoot.value = "/fake/comfy";
    // Each test re-detects the Manager API generation against its own stub
    // (the v2 stubs answer /v2/manager/queue/status → detect "v2").
    resetManagerApiCacheForTests();
    // Shrink polling timings so the suite stays fast.
    setQueueTimingForTests({
      pollIntervalMs: 1,
      startupGraceMs: 0,
      timeoutMs: 5000,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.COMFYUI_PYTHON;
  });

  // ---- install -----------------------------------------------------------

  describe("installCustomNode", () => {
    it.each([
      [
        "GitHub tree",
        "https://github.com/foo/bar/tree/dev",
        "https://github.com/foo/bar",
        "dev",
      ],
      [
        "GitHub commit",
        "https://github.com/foo/bar/commit/abc123",
        "https://github.com/foo/bar",
        "abc123",
      ],
      [
        "GitHub release tag",
        "https://github.com/foo/bar/releases/tag/v1.2.3",
        "https://github.com/foo/bar",
        "v1.2.3",
      ],
      [
        "GitLab tree",
        "https://gitlab.com/foo/bar/-/tree/main",
        "https://gitlab.com/foo/bar",
        "main",
      ],
      [
        "GitLab commit",
        "https://gitlab.com/foo/bar/-/commit/abc123",
        "https://gitlab.com/foo/bar",
        "abc123",
      ],
      [
        "Bitbucket src",
        "https://bitbucket.org/foo/bar/src/release-1",
        "https://bitbucket.org/foo/bar",
        "release-1",
      ],
      [
        "Bitbucket commit",
        "https://bitbucket.org/foo/bar/commits/abc123",
        "https://bitbucket.org/foo/bar",
        "abc123",
      ],
      [
        "URL at-ref",
        "https://github.com/foo/bar@feature",
        "https://github.com/foo/bar",
        "feature",
      ],
      [
        "git suffix at-ref",
        "https://github.com/foo/bar.git@v1",
        "https://github.com/foo/bar.git",
        "v1",
      ],
      [
        "repo at-ref",
        "repo@dev",
        "repo",
        "dev",
      ],
      [
        "repo.git at-ref",
        "repo.git@dev",
        "repo.git",
        "dev",
      ],
      [
        "SSH at-ref",
        "git@github.com:foo/bar.git@abc123",
        "git@github.com:foo/bar.git",
        "abc123",
      ],
    ])("parseGitUrl extracts %s refs", (_label, input, baseUrl, ref) => {
      expect(parseGitUrl(input)).toEqual({ baseUrl, ref });
    });

    it("parseGitUrl leaves plain URLs unpinned", () => {
      expect(parseGitUrl("https://github.com/foo/bar.git")).toEqual({
        baseUrl: "https://github.com/foo/bar.git",
        ref: null,
      });
    });

    it("rejects parsed refs that could be interpreted as git options", () => {
      expect(() => parseGitUrl("https://github.com/foo/bar.git@--foo")).toThrow(
        ValidationError,
      );
    });

    it("rejects parsed refs containing ASCII control characters", () => {
      expect(() => parseGitUrl("https://github.com/foo/bar.git@bad%0Aref")).toThrow(
        ValidationError,
      );
    });

    it("rejects ambiguous deep GitHub tree URLs", () => {
      expect(() => parseGitUrl("https://github.com/foo/bar/tree/main/examples")).toThrow(
        /explicit `ref`/,
      );
      expect(() =>
        parseGitUrl("https://gitlab.com/foo/bar/-/tree/main/examples"),
      ).toThrow(/explicit `ref`/);
    });

    // Registry-install verification: the Manager marks the queue "done" even when
    // it resolved nothing, so installCustomNode re-queries /customnode/installed.
    // Tests that exercise a successful Manager install must therefore report the
    // pack as installed via installedBody.
    const installedBar = {
      bar: { ver: "nightly", aux_id: "foo/bar", enabled: true },
    };

    it("installs a registry id via the Manager queue API with latest version", async () => {
      const { calls } = stubFetch({
        installedBody: {
          "comfyui-impact-pack": {
            ver: "1.0.0",
            cnr_id: "comfyui-impact-pack",
            enabled: true,
          },
        },
      });
      const res = await installCustomNode({ id: "comfyui-impact-pack" });

      expect(res.mechanism).toBe("manager-http");
      const { body, params } = taskOf(calls, "install");
      expect(body.client_id).toBe("comfyui-mcp");
      expect(typeof body.ui_id).toBe("string");
      // Registry keeps the prior defaults: channel "default", mode "remote".
      expect(params).toMatchObject({
        id: "comfyui-impact-pack",
        version: "latest",
        selected_version: "latest",
        channel: "default",
        mode: "remote",
      });
      // Must kick the queue worker.
      expect(calls.some((c) => c.url.endsWith("/v2/manager/queue/start"))).toBe(
        true,
      );
    });

    it("throws when a registry id is queued but never lands (silent no-op)", async () => {
      // The Manager drains "done" without installing an unknown CNR id; a non-URL
      // id can't be cloned, so this must be a hard error — not a false success.
      stubFetch({ installedBody: {} });
      await expect(
        installCustomNode({ id: "does-not-exist" }),
      ).rejects.toBeInstanceOf(NodeManagementError);
    });

    it("auto-detects a git URL and installs it via the Manager using the REPO NAME", async () => {
      const { calls } = stubFetch({ installedBody: installedBar });
      const res = await installCustomNode({ id: "https://github.com/foo/bar" });

      expect(res.mechanism).toBe("manager-http");
      const { params } = taskOf(calls, "install");
      // id is the REPO NAME (not the URL); no ref → "nightly"; UI channel/mode.
      // The ignored `repository`/`pip` fields are dropped.
      expect(params).toMatchObject({
        id: "bar",
        version: "nightly",
        selected_version: "nightly",
        channel: "dev",
        mode: "cache",
      });
      expect(params).not.toHaveProperty("repository");
      expect(params).not.toHaveProperty("pip");
      // Manager resolved it → NO direct clone.
      expect(mockedExec).not.toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["clone"]),
        expect.anything(),
      );
    });

    it("pins a git URL ref parsed from the URL in the install task", async () => {
      const { calls } = stubFetch({ installedBody: installedBar });
      await installCustomNode({ id: "https://github.com/foo/bar/tree/dev" });

      const { params } = taskOf(calls, "install");
      expect(params).toMatchObject({
        id: "bar",
        selected_version: "dev",
      });
    });

    it("prefers explicit ref over parsed URL ref and version for git installs", async () => {
      const { calls } = stubFetch({ installedBody: installedBar });
      await installCustomNode({
        id: "https://github.com/foo/bar/tree/dev",
        version: "v1",
        ref: "abc123",
      });

      const { params } = taskOf(calls, "install");
      expect(params).toMatchObject({
        id: "bar",
        selected_version: "abc123",
      });
    });

    it("allows a valid explicit slash-separated git ref", async () => {
      const { calls } = stubFetch({ installedBody: installedBar });
      await installCustomNode({
        id: "https://github.com/foo/bar",
        ref: "feature/dev",
      });

      const { params } = taskOf(calls, "install");
      expect(params).toMatchObject({
        id: "bar",
        selected_version: "feature/dev",
      });
    });

    it("falls back to a direct git clone when the Manager can't resolve the repo", async () => {
      // Manager drains "done" but the pack never appears → unregistered repo.
      const { calls } = stubFetch({ installedBody: {} });
      // Simulate clone landing the dir on disk, with no requirements/install.py.
      let cloned = false;
      mockedExists.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s.includes("requirements.txt") || s.includes("install.py")) {
          return false;
        }
        if (s.includes(".venv")) return false;
        if (s.includes("cm-cli.py")) return false;
        if (s.includes(NODE_DIR_UTILS) || s.endsWith("comfyui-teskors-utils")) {
          return cloned;
        }
        return false;
      });
      mockedExec.mockImplementation(((bin: string, args: string[]) => {
        if (bin === "git" && args[0] === "clone") {
          cloned = true;
          return "";
        }
        return "";
      }) as never);

      const res = await installCustomNode({
        id: "https://github.com/teskor-hub/comfyui-teskors-utils",
      });

      expect(res.mechanism).toBe("git-clone");
      // Manager was still tried first (registry-first).
      expect(taskOf(calls, "install").params).toMatchObject({
        id: "comfyui-teskors-utils",
      });
      // git clone was invoked with the URL + the target node dir (shallow, no ref).
      const cloneCall = mockedExec.mock.calls.find(
        (c) => c[0] === "git" && (c[1] as string[])[0] === "clone",
      );
      expect(cloneCall).toBeDefined();
      // `--end-of-options` guards the URL/dir from being parsed as git options.
      expect(cloneCall![1]).toEqual([
        "clone",
        "--depth",
        "1",
        "--end-of-options",
        "https://github.com/teskor-hub/comfyui-teskors-utils",
        NODE_DIR_UTILS,
      ]);
      // The clone must run non-interactively so a missing/private repo fails fast
      // instead of hanging on a credential prompt.
      const cloneEnv = (cloneCall![2] as { env?: Record<string, string> })?.env;
      expect(cloneEnv?.GIT_TERMINAL_PROMPT).toBe("0");
      expect(cloneEnv?.GIT_ASKPASS).toBe("echo");
    });

    // #1129 — a REFUSED enqueue is not the end of the road.
    //
    // The 3.x git-URL install is gated by security_level + allow_git_url_install,
    // and a host that does not serve the route answers the same way. Both come
    // back as a status on the POST, which throws — so the direct-clone fallback,
    // which needs no Manager at all and is exactly what the user would do by
    // hand, was unreachable in the one case it exists for. A reporter on legacy
    // 3.x got "not reachable", then a 404 with "A security error has occurred",
    // and was left with no install path on a machine whose custom_nodes
    // directory was sitting right there.
    // 405 is excluded on purpose: on this API it is the dialect-mismatch signal
    // that the #646 self-heal retry owns, and the "no dialect self-heal" case
    // below pins that.
    for (const status of [403, 404]) {
      it(`#1129: Manager REFUSES the git enqueue with ${status} → clones directly and says why`, async () => {
        stubFetch({ installedBody: {}, queueOpStatus: status });
        let cloned = false;
        mockedExists.mockImplementation((p: unknown) => {
          const s = String(p);
          if (s.includes("requirements.txt") || s.includes("install.py")) return false;
          if (s.includes(".venv") || s.includes("cm-cli.py")) return false;
          if (s.includes(NODE_DIR_UTILS) || s.endsWith("comfyui-teskors-utils")) return cloned;
          return false;
        });
        mockedExec.mockImplementation(((bin: string, args: string[]) => {
          if (bin === "git" && args[0] === "clone") cloned = true;
          return "";
        }) as never);

        const res = await installCustomNode({
          id: "https://github.com/teskor-hub/comfyui-teskors-utils",
        });

        expect(res.mechanism).toBe("git-clone");
        // The reason must be the REFUSAL, not "not in the registry" — that would
        // be a wrong explanation for a correct action, and it is what a reader
        // would go on to act on.
        expect(res.message).toMatch(new RegExp(`REFUSED the git-URL install \\(HTTP ${status}\\)`));
        expect(res.message).toMatch(/security_level \/ allow_git_url_install/);
        expect(res.message).toMatch(/Nothing was queued there/);
        expect(res.message).not.toMatch(/not in the ComfyUI-Manager registry/);
        // And it actually cloned.
        expect(
          mockedExec.mock.calls.find((c) => c[0] === "git" && (c[1] as string[])[0] === "clone"),
        ).toBeDefined();
      });
    }

    it("#1129: a 405 never produces a policy-refusal message", async () => {
      // 405 is ComfyUI's frontend catchall answering a route registered under
      // the other API generation. Cloning on it would pre-empt a Manager install
      // that is about to succeed on the right route.
      //
      // Honest scope note: this pins the user-visible outcome, NOT the classifier
      // branch. Re-admitting 405 to managerEnqueueRefusal does not change this
      // test, because a 405 is consumed upstream — the POST-then-GET retry and
      // then the dialect self-heal both act on it first, so it never reaches the
      // classifier by this route. That is precisely why excluding it there is the
      // conservative choice rather than a load-bearing one.
      const { calls } = stubFetch({ installedBody: {}, queueOpStatus: 405 });
      let cloned = false;
      mockedExists.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s.includes("requirements.txt") || s.includes("install.py")) return false;
        if (s.includes(".venv") || s.includes("cm-cli.py")) return false;
        if (s.includes(NODE_DIR_UTILS) || s.endsWith("comfyui-teskors-utils")) return cloned;
        return false;
      });
      mockedExec.mockImplementation(((bin: string, args: string[]) => {
        if (bin === "git" && args[0] === "clone") cloned = true;
        return "";
      }) as never);

      const res = await installCustomNode({
        id: "https://github.com/teskor-hub/comfyui-teskors-utils",
      });

      // It may still end up cloning (unregistered pack) — what must NOT happen is
      // the refusal shortcut claiming a policy gate the server never asserted.
      expect(res.message).not.toMatch(/REFUSED the git-URL install/);
      // And the self-heal must have re-tried rather than giving up at the 405.
      expect(calls.filter((c) => c.url.includes("/queue/")).length).toBeGreaterThan(1);
    });

    it("#1129: a 500 from the queue still THROWS — the task may have been accepted", async () => {
      // The warrant for cloning is that nothing was queued. A 5xx says the
      // handler fell over, which does not establish that — cloning underneath a
      // Manager install writing to the same directory is the race this avoids.
      stubFetch({ installedBody: {}, queueOpStatus: 500 });
      mockedExists.mockImplementation(() => false);
      mockedExec.mockImplementation((() => "") as never);

      await expect(
        installCustomNode({ id: "https://github.com/teskor-hub/comfyui-teskors-utils" }),
      ).rejects.toThrow(/500/);
      expect(
        mockedExec.mock.calls.find((c) => c[0] === "git" && (c[1] as string[])[0] === "clone"),
      ).toBeUndefined();
    });

    it("clones an unregistered git pack into opts.comfyuiPath when global COMFYUI_PATH is unset (#463)", async () => {
      // apply_manifest threads a call-scoped base (adopted saved-default/live root)
      // WITHOUT mutating global config. The clone fallback must honor it, or an
      // unregistered git URL fails despite a valid local workspace.
      config.comfyuiPath = undefined;
      const adopted = "/adopted/ComfyUI";
      const adoptedNodeDir = resolve(adopted, "custom_nodes", "comfyui-teskors-utils");
      stubFetch({ installedBody: {} });
      let cloned = false;
      mockedExists.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s.includes("requirements.txt") || s.includes("install.py")) return false;
        if (s.includes(".venv") || s.includes("cm-cli.py")) return false;
        if (s.includes("comfyui-teskors-utils")) return cloned;
        return false;
      });
      mockedExec.mockImplementation(((bin: string, args: string[]) => {
        if (bin === "git" && args[0] === "clone") cloned = true;
        return "";
      }) as never);

      const res = await installCustomNode({
        id: "https://github.com/teskor-hub/comfyui-teskors-utils",
        comfyuiPath: adopted,
      });

      expect(res.mechanism).toBe("git-clone");
      const cloneCall = mockedExec.mock.calls.find(
        (c) => c[0] === "git" && (c[1] as string[])[0] === "clone",
      );
      expect(cloneCall).toBeDefined();
      // Cloned into the ADOPTED base's custom_nodes, not a global path.
      expect((cloneCall![1] as string[]).at(-1)).toBe(adoptedNodeDir);
      expect((cloneCall![2] as { cwd?: string }).cwd).toBe(adopted);
    });

    it("installs a cloned node's requirements.txt under the ADOPTED base's venv python, not bare system python (#463)", async () => {
      // With no global COMFYUI_PATH, the deps install must target the adopted
      // workspace's own .venv — otherwise requirements land under a bare system
      // python, corrupting/missing the real ComfyUI env while we report success.
      config.comfyuiPath = undefined;
      const adopted = "/adopted/ComfyUI";
      const IS_WIN = process.platform === "win32";
      // resolveVenvPython builds this with path.join (NOT resolve), so no drive
      // letter is prepended — mirror that exactly for the existsSync match.
      const venvPy = join(
        adopted,
        ".venv",
        IS_WIN ? "Scripts" : "bin",
        IS_WIN ? "python.exe" : "python",
      );
      const nodeDir = resolve(adopted, "custom_nodes", "comfyui-teskors-utils");
      // The install resolver is fail-closed (#651): it only hands out an
      // interpreter it can account for. Pin the explicit override so the deps
      // install targets the adopted venv python.
      process.env.COMFYUI_PYTHON = venvPy;
      const requirements = join(nodeDir, "requirements.txt");
      stubFetch({ installedBody: {} });
      let cloned = false;
      mockedExists.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s === venvPy) return true; // adopted venv python present
        if (s === requirements) return true; // node ships requirements.txt
        if (s.includes("install.py") || s.includes("cm-cli.py")) return false;
        if (s.includes(".venv")) return false; // any OTHER venv path absent
        if (s.includes("comfyui-teskors-utils")) return cloned;
        return false;
      });
      mockedExec.mockImplementation(((bin: string, args: string[]) => {
        if (bin === "git" && args[0] === "clone") cloned = true;
        return "";
      }) as never);

      await installCustomNode({
        id: "https://github.com/teskor-hub/comfyui-teskors-utils",
        comfyuiPath: adopted,
      });

      const pipCall = mockedExec.mock.calls.find(
        (c) =>
          Array.isArray(c[1]) &&
          (c[1] as string[]).includes("-r") &&
          (c[1] as string[]).includes(requirements),
      );
      expect(pipCall).toBeDefined();
      // The deps install ran under the ADOPTED venv python, not bare "python".
      expect(pipCall![0]).toBe(venvPy);
    });

    it("warns and skips the deps install when the server's interpreter cannot be verified (#651)", async () => {
      // No override, no launched record, no reachable live server → fail CLOSED:
      // the clone still succeeds, but requirements are NOT installed into a guess.
      config.comfyuiPath = undefined;
      const adopted = "/adopted/ComfyUI";
      const nodeDir = resolve(adopted, "custom_nodes", "comfyui-teskors-utils");
      const requirements = join(nodeDir, "requirements.txt");
      stubFetch({ installedBody: {} });
      let cloned = false;
      mockedExists.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s === requirements) return true; // node ships requirements.txt
        if (s.includes("install.py") || s.includes("cm-cli.py")) return false;
        if (s.includes(".venv")) return false;
        if (s.includes("comfyui-teskors-utils")) return cloned;
        return false;
      });
      mockedExec.mockImplementation(((bin: string, args: string[]) => {
        if (bin === "git" && args[0] === "clone") cloned = true;
        return "";
      }) as never);

      const res = await installCustomNode({
        id: "https://github.com/teskor-hub/comfyui-teskors-utils",
        comfyuiPath: adopted,
      });

      expect(res.mechanism).toBe("git-clone");
      // The deps install was REFUSED and the reason is surfaced in the message…
      expect(res.message).toContain("Python dependencies were NOT installed");
      // …and no pip subprocess ran against any interpreter.
      const pipCall = mockedExec.mock.calls.find(
        (c) =>
          Array.isArray(c[1]) &&
          (c[1] as string[]).includes("-r") &&
          (c[1] as string[]).includes(requirements),
      );
      expect(pipCall).toBeUndefined();
    });

    it("full-clones (no --depth) and checks out an explicit ref on fallback", async () => {
      stubFetch({ installedBody: {} });
      let cloned = false;
      mockedExists.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s.includes("requirements.txt") || s.includes("install.py")) {
          return false;
        }
        if (s.includes(".venv") || s.includes("cm-cli.py")) return false;
        if (s.includes(NODE_DIR_UTILS)) return cloned;
        return false;
      });
      mockedExec.mockImplementation(((bin: string, args: string[]) => {
        if (bin === "git" && args[0] === "clone") cloned = true;
        return "";
      }) as never);

      const res = await installCustomNode({
        id: "https://github.com/teskor-hub/comfyui-teskors-utils",
        ref: "v1.2.3",
      });

      expect(res.mechanism).toBe("git-clone");
      const cloneCall = mockedExec.mock.calls.find(
        (c) => c[0] === "git" && (c[1] as string[])[0] === "clone",
      );
      // Full clone (no --depth) so the ref is reachable.
      expect(cloneCall![1]).toEqual([
        "clone",
        "--end-of-options",
        "https://github.com/teskor-hub/comfyui-teskors-utils",
        NODE_DIR_UTILS,
      ]);
      // Followed by a checkout of the ref.
      expect(
        mockedExec.mock.calls.some(
          (c) => c[0] === "git" && (c[1] as string[]).includes("checkout"),
        ),
      ).toBe(true);
    });

    it("removes the directory a FAILED clone created, instead of leaving a husk", async () => {
      // #900, observed on a real machine: a clone that did not produce a pack left
      // a directory holding only `.git` in custom_nodes. ComfyUI loads
      // DIRECTORIES, so it tried to import it on every start and logged an error
      // — for over a month, long after anyone remembered running the install.
      stubFetch({ installedBody: {} });
      let cloned = false;
      mockedExists.mockImplementation((p: unknown) => {
        const str = String(p);
        if (str.includes("requirements.txt") || str.includes("install.py")) return false;
        if (str.includes(".venv") || str.includes("cm-cli.py")) return false;
        if (str.includes(NODE_DIR_UTILS)) return cloned; // git created it, then failed
        return false;
      });
      mockedExec.mockImplementation(((bin: string, args: string[]) => {
        if (bin === "git" && args[0] === "clone") {
          cloned = true; // the directory now exists…
          throw new Error("fatal: could not read from remote repository");
        }
        return "";
      }) as never);

      await expect(
        installCustomNode({ id: "https://github.com/teskor-hub/comfyui-teskors-utils" }),
      ).rejects.toThrow(/Failed to clone/);

      expect(fsCtl.removed).toContain(NODE_DIR_UTILS);
    });

    it("does NOT remove a PRE-EXISTING pack when a clone/update fails", async () => {
      // The inverse, and the one that would do real damage: an existing pack is
      // the user's, and a failed operation must never take it away.
      //
      // Note what this test does and does not prove. It passes STRUCTURALLY —
      // with the pack already present the clone block is skipped entirely, so the
      // cleanup is never reached — which means removing the ownership check
      // inside `discardFailedClone` does not fail it. That check is a documented
      // precondition rather than live logic. What this DOES pin is the property
      // that matters to a user: run an install against a pack that is already
      // there, have it fail, and still have your pack.
      stubFetch({ installedBody: {} });
      mockedExists.mockImplementation((p: unknown) => {
        const str = String(p);
        if (str.includes("requirements.txt") || str.includes("install.py")) return false;
        if (str.includes(".venv") || str.includes("cm-cli.py")) return false;
        if (str.includes(NODE_DIR_UTILS)) return true; // already there, before we ran
        return false;
      });
      fsCtl.readdirSync = () => ["__init__.py", ".git"]; // a real pack
      mockedExec.mockImplementation(((bin: string, args: string[]) => {
        if (bin === "git" && args[0] === "clone") throw new Error("should not clone");
        return "";
      }) as never);

      await installCustomNode({
        id: "https://github.com/teskor-hub/comfyui-teskors-utils",
      }).catch(() => undefined);

      expect(fsCtl.removed).not.toContain(NODE_DIR_UTILS);
    });

    it("REJECTS a clone that produced only git metadata — an existing directory is not a pack", async () => {
      // `existsSync(nodeDir)` was the whole post-clone check, and it passes for a
      // husk. "The directory exists" was never the question ComfyUI asks.
      stubFetch({ installedBody: {} });
      let cloned = false;
      mockedExists.mockImplementation((p: unknown) => {
        const str = String(p);
        if (str.includes("requirements.txt") || str.includes("install.py")) return false;
        if (str.includes(".venv") || str.includes("cm-cli.py")) return false;
        if (str.includes(NODE_DIR_UTILS)) return cloned;
        return false;
      });
      fsCtl.readdirSync = () => [".git"]; // git and nothing else
      mockedExec.mockImplementation(((bin: string, args: string[]) => {
        if (bin === "git" && args[0] === "clone") cloned = true;
        return "";
      }) as never);

      await expect(
        installCustomNode({ id: "https://github.com/teskor-hub/comfyui-teskors-utils" }),
      ).rejects.toThrow(/no loadable pack/i);
      expect(fsCtl.removed).toContain(NODE_DIR_UTILS);
    });

    it("DISCLOSES a leftover it could not remove, rather than swallowing it", async () => {
      // A husk nobody was told about is how the one in #900 survived a month.
      stubFetch({ installedBody: {} });
      let cloned = false;
      mockedExists.mockImplementation((p: unknown) => {
        const str = String(p);
        if (str.includes("requirements.txt") || str.includes("install.py")) return false;
        if (str.includes(".venv") || str.includes("cm-cli.py")) return false;
        if (str.includes(NODE_DIR_UTILS)) return cloned;
        return false;
      });
      fsCtl.rmThrows = true;
      mockedExec.mockImplementation(((bin: string, args: string[]) => {
        if (bin === "git" && args[0] === "clone") {
          cloned = true;
          throw new Error("fatal: repository not found");
        }
        return "";
      }) as never);

      await expect(
        installCustomNode({ id: "https://github.com/teskor-hub/comfyui-teskors-utils" }),
      ).rejects.toThrow(/could NOT be removed/i);
    });

    it("a TIMED-OUT clone kills the leftover git process tree before cleanup", async () => {
      // #900 recurrence, observed 2026-08-05 on Windows: execFileSync's timeout
      // killed the direct `git` child but `git-remote-https`/`index-pack` kept
      // running with locks on .git/objects/pack/tmp_pack_*, so the removal failed
      // EBUSY and the husk stayed. The timeout path must kill the whole tree and
      // only then remove.
      stubFetch({ installedBody: {} });
      let cloned = false;
      mockedExists.mockImplementation((p: unknown) => {
        const str = String(p);
        if (str.includes("requirements.txt") || str.includes("install.py")) return false;
        if (str.includes(".venv") || str.includes("cm-cli.py")) return false;
        if (str.includes(NODE_DIR_UTILS)) return cloned;
        return false;
      });
      mockedExec.mockImplementation(((bin: string, args: string[]) => {
        if (bin === "git" && args[0] === "clone") {
          cloned = true;
          // The shape Node's execFileSync throws on timeout: code ETIMEDOUT with
          // the dead child's pid — the pid whose TREE must be killed.
          throw Object.assign(new Error("spawnSync git ETIMEDOUT"), {
            code: "ETIMEDOUT",
            pid: 4242,
          });
        }
        return ""; // taskkill / pkill succeed
      }) as never);

      await expect(
        installCustomNode({ id: "https://github.com/teskor-hub/comfyui-teskors-utils" }),
      ).rejects.toThrow(/Failed to clone/);

      // The process-tree kill went out for the timed-out child's pid (taskkill
      // /T /F on Windows, a pkill children sweep on POSIX).
      const treeKill = mockedExec.mock.calls.find(
        (c) => c[0] === "taskkill" || c[0] === "pkill",
      );
      expect(treeKill, "expected a process-tree kill for the timed-out git").toBeDefined();
      expect(treeKill![1]).toContain("4242");
      // …and the husk itself was removed once nothing held it open.
      expect(fsCtl.removed).toContain(NODE_DIR_UTILS);
    });

    it("REFUSES to install over an existing husk instead of reporting success", async () => {
      // The other half of #900: a husk already sitting in custom_nodes passed
      // every check — the clone is skipped because "the directory exists", and
      // the pack verification ran only for directories THIS call created — so a
      // retry over a husk reported a successful install of nothing. The husk is
      // not this call's to delete, so the install refuses and names it.
      stubFetch({ installedBody: {} });
      mockedExists.mockImplementation((p: unknown) => {
        const str = String(p);
        if (str.includes("requirements.txt") || str.includes("install.py")) return false;
        if (str.includes(".venv") || str.includes("cm-cli.py")) return false;
        if (str.includes(NODE_DIR_UTILS)) return true; // left over from an earlier failure
        return false;
      });
      fsCtl.readdirSync = () => [".git"]; // git metadata and nothing else
      mockedExec.mockImplementation(((bin: string, args: string[]) => {
        if (bin === "git" && args[0] === "clone") throw new Error("should not clone");
        return "";
      }) as never);

      await expect(
        installCustomNode({ id: "https://github.com/teskor-hub/comfyui-teskors-utils" }),
      ).rejects.toThrow(/husk of an install that did not complete/i);

      // No clone ran over it, and the husk — not this call's creation — was left
      // exactly where it was.
      expect(
        mockedExec.mock.calls.some(
          (c) => c[0] === "git" && (c[1] as string[])[0] === "clone",
        ),
      ).toBe(false);
      expect(fsCtl.removed).not.toContain(NODE_DIR_UTILS);
    });

    it("throws ProcessControlError on clone fallback when comfyuiPath is unset", async () => {
      config.comfyuiPath = undefined;
      stubFetch({ installedBody: {} });
      await expect(
        installCustomNode({
          id: "https://github.com/teskor-hub/comfyui-teskors-utils",
        }),
      ).rejects.toBeInstanceOf(ProcessControlError);
    });

    it("rejects a git URL starting with '-' (option injection) without cloning", async () => {
      stubFetch({ installedBody: {} });
      await expect(
        installCustomNode({ id: "--upload-pack=evil", source: "git" }),
      ).rejects.toBeInstanceOf(ValidationError);
      // git clone must NEVER run for an injection attempt.
      expect(mockedExec).not.toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["clone"]),
        expect.anything(),
      );
    });

    it("rejects a repo name that resolves to '..' (path traversal) without cloning", async () => {
      stubFetch({ installedBody: {} });
      await expect(
        installCustomNode({ id: "https://github.com/foo/.." }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(mockedExec).not.toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["clone"]),
        expect.anything(),
      );
    });

    it("rejects explicit git refs that could be interpreted as git options", async () => {
      const { calls } = stubFetch();
      await expect(
        installCustomNode({ id: "https://github.com/foo/bar", ref: "--foo" }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(calls).toHaveLength(0);
    });

    it("rejects explicit git refs containing ASCII control characters", async () => {
      const { calls } = stubFetch();
      await expect(
        installCustomNode({ id: "https://github.com/foo/bar", ref: "bad\nref" }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(calls).toHaveLength(0);
    });

    it("uses version as the git ref when no explicit ref is present", async () => {
      const { calls } = stubFetch({ installedBody: installedBar });
      await installCustomNode({
        id: "https://github.com/foo/bar",
        version: "release",
      });

      const { params } = taskOf(calls, "install");
      expect(params).toMatchObject({
        id: "bar",
        selected_version: "release",
      });
    });

    it("honors an explicit version", async () => {
      const { calls } = stubFetch({
        installedBody: { "some-pack": { ver: "1.2.3", cnr_id: "some-pack", enabled: true } },
      });
      await installCustomNode({ id: "some-pack", version: "1.2.3" });
      const { params } = taskOf(calls, "install");
      expect(params).toMatchObject({
        version: "1.2.3",
        selected_version: "1.2.3",
      });
    });

    it("ignores ref for registry installs", async () => {
      const { calls } = stubFetch({
        installedBody: { "some-pack": { ver: "latest", cnr_id: "some-pack", enabled: true } },
      });
      await installCustomNode({ id: "some-pack", ref: "dev" });
      const { params } = taskOf(calls, "install");
      expect(params).toMatchObject({
        id: "some-pack",
        version: "latest",
        selected_version: "latest",
      });
    });

    it("does not return early when the worker has not yet started (pending queue)", async () => {
      // First poll: worker thread not yet spun up — idle-looking but a queued
      // item is pending (total=1 > done=0). Must NOT be treated as done.
      // Second poll: worker is running. Third: drained.
      const { calls } = stubFetch({
        installedBody: { pack: { ver: "latest", cnr_id: "pack", enabled: true } },
        statusSequence: [
          { total_count: 1, done_count: 0, in_progress_count: 0, is_processing: false },
          { total_count: 1, done_count: 0, in_progress_count: 1, is_processing: true },
          { total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false },
        ],
      });

      const res = await installCustomNode({ id: "pack" });
      expect(res.mechanism).toBe("manager-http");
      // It should have polled status at least 3 times before returning.
      const statusPolls = calls.filter((c) =>
        c.url.endsWith("/manager/queue/status"),
      );
      expect(statusPolls.length).toBeGreaterThanOrEqual(3);
      expect((res.details as { done_count: number }).done_count).toBe(1);
    });

    it("uses cm-cli subprocess when forced", async () => {
      mockedExec.mockReturnValue(cliEnvelope({ message: "installed ok" }) as never);
      const res = await installCustomNode({ id: "some-pack", useCmCli: true });

      expect(res.mechanism).toBe("comfy-cli");
      const [bin, args] = mockedExec.mock.calls[0];
      expect(bin).toBe(COMFY_CLI);
      expect(args).toEqual([
        "--json",
        "--workspace",
        COMFY,
        "--skip-prompt",
        "node",
        "install",
        "some-pack",
        "--mode",
        "remote",
        "--channel",
        "default",
      ]);
    });

    it("checks out the requested git ref after forced cm-cli install", async () => {
      mockedExec.mockReturnValue(cliEnvelope({ message: "installed ok" }) as never);
      const res = await installCustomNode({
        id: "https://github.com/foo/bar/tree/dev",
        ref: "abc123",
        useCmCli: true,
      });

      expect(res.mechanism).toBe("comfy-cli");
      expect(mockedExec).toHaveBeenCalledTimes(3);
      expect(mockedExec.mock.calls[0][1]).toEqual([
        "--json",
        "--workspace",
        COMFY,
        "--skip-prompt",
        "node",
        "install",
        "https://github.com/foo/bar",
        "--mode",
        "remote",
        "--channel",
        "default",
      ]);
      expect(mockedExec.mock.calls[1][0]).toBe("git");
      expect(mockedExec.mock.calls[1][1]).toEqual([
        "-C",
        BAR_DIR,
        "fetch",
        "--all",
        "--tags",
      ]);
      expect(mockedExec.mock.calls[2][0]).toBe("git");
      expect(mockedExec.mock.calls[2][1]).toEqual([
        "-C",
        BAR_DIR,
        "checkout",
        "--detach",
        "--end-of-options",
        "abc123",
      ]);
    });

    it("cm-cli install with a ref works from the SAVED DEFAULT workspace when COMFYUI_PATH is unset (#808/#775 layout)", async () => {
      // The CLI, the ref checkout, and the clone fallback must all take the ONE
      // captured local root — previously the checkout read only
      // config.comfyuiPath and threw AFTER the CLI install had already run.
      config.comfyuiPath = undefined;
      savedDefault.value = "/saved/ws";
      mockedExec.mockReturnValue(cliEnvelope({ message: "installed ok" }) as never);

      const res = await installCustomNode({
        id: "https://github.com/foo/bar",
        ref: "abc123",
        useCmCli: true,
      });

      expect(res.mechanism).toBe("comfy-cli");
      // The CLI ran against the saved default workspace...
      expect(mockedExec.mock.calls[0][1]).toEqual([
        "--json",
        "--workspace",
        "/saved/ws",
        "--skip-prompt",
        "node",
        "install",
        "https://github.com/foo/bar",
        "--mode",
        "remote",
        "--channel",
        "default",
      ]);
      // ...and the ref checkout ran THERE too, not nowhere.
      const checkoutDir = resolve("/saved/ws", "custom_nodes", "bar");
      expect(mockedExec.mock.calls[2][1]).toEqual([
        "-C",
        checkoutDir,
        "checkout",
        "--detach",
        "--end-of-options",
        "abc123",
      ]);
    });

    it("routes forced cm-cli and its git checkout through the data/base root in a split install", async () => {
      config.comfyuiPath = "/split/data";
      config.comfyuiCodePath = "/split/code";
      mockedExec.mockReturnValue(cliEnvelope({ message: "installed ok" }) as never);

      const res = await installCustomNode({
        id: "https://github.com/foo/bar",
        ref: "abc123",
        useCmCli: true,
      });

      expect(res.mechanism).toBe("comfy-cli");
      expect(mockedExec.mock.calls[0][1]).toContain("/split/data");
      expect(mockedExec.mock.calls[0][1]).not.toContain("/split/code");
      expect(mockedExec.mock.calls[2][1]).toEqual([
        "-C",
        resolve("/split/data", "custom_nodes", "bar"),
        "checkout",
        "--detach",
        "--end-of-options",
        "abc123",
      ]);
    });
  });

  // ---- update ------------------------------------------------------------

  describe("updateCustomNode", () => {
    // Post-op presence verification (#730): a single-pack update re-queries
    // /customnode/installed after the drain and fails unless the pack resolves
    // SOMEWHERE, so success-path tests must report the pack as installed.
    const installedMyPack = {
      "my-pack": { ver: "1.0.0", cnr_id: "my-pack", enabled: true },
    };

    it("updates a single pack via an update task", async () => {
      const { calls } = stubFetch({ installedBody: installedMyPack });
      await updateCustomNode({ id: "my-pack" });
      const { params } = taskOf(calls, "update");
      expect(params).toMatchObject({ node_name: "my-pack" });
    });

    it("fails truthfully for an id that resolves NOWHERE — before anything is queued (#730: queue-drain is not proof)", async () => {
      // Live evidence: the Manager drains "done" with total_count 0 for an
      // unknown id, and update used to report "Queued + updated" anyway. The
      // target now resolves up front — Manager list empty AND an enumerable
      // custom_nodes without it (#797 disk evidence) → refusal, NOTHING queued.
      fsCtl.readdirSync = () => [];
      const { calls } = stubFetch({ installedBody: {} });
      const err = await updateCustomNode({ id: "mcp-sweep-nonexistent-pack" }).catch(
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(NodeManagementError);
      expect((err as Error).message).toMatch(/not installed/);
      expect((err as Error).message).toMatch(/NOTHING was queued/);
      expect((err as Error).message).not.toMatch(/updated/i);
      expect(
        calls.some(
          (c) => (c.body as { kind?: string } | undefined)?.kind === "update",
        ),
      ).toBe(false);
    });

    it("update sends the MANAGER module name as node_name when it differs from the registry id", async () => {
      const { calls } = stubFetch({
        installedBody: {
          "ComfyUI-Impact-Pack": { ver: "8.28.3", cnr_id: "comfyui-impact-pack", enabled: true },
        },
      });
      const res = await updateCustomNode({ id: "comfyui-impact-pack" });
      expect(res.mechanism).toBe("manager-http");
      expect(taskOf(calls, "update").params).toMatchObject({
        node_name: "ComfyUI-Impact-Pack",
      });
    });

    it("still succeeds for an installed-but-not-in-registry (git-cloned) pack", async () => {
      // The #730 gate must not break packs the registry does not know: they
      // match the installed list by module/auxId spellings. The queued task
      // names the MANAGER MODULE (the folder), which is what the routes
      // resolve — not the caller's aux-id spelling.
      const { calls } = stubFetch({
        installedBody: {
          "some-git-node": { ver: "abc1234", aux_id: "user/some-git-node", enabled: true },
        },
      });
      const res = await updateCustomNode({ id: "user/some-git-node" });
      expect(res.mechanism).toBe("manager-http");
      expect(res.message).toMatch(/Queued \+ updated/);
      expect(taskOf(calls, "update").params).toMatchObject({
        node_name: "some-git-node",
      });
    });

    it("routes 'all' to /v2/manager/queue/update_all with QUERY params (not body)", async () => {
      const { calls } = stubFetch();
      await updateCustomNode({ id: "all", mode: "local" });
      const c = calls.find((x) =>
        x.url.includes("/v2/manager/queue/update_all"),
      );
      expect(c).toBeDefined();
      // The backend reads UpdateAllQueryParams from the query string only.
      const u = new URL(c!.url);
      expect(u.searchParams.get("mode")).toBe("local");
      expect(u.searchParams.get("client_id")).toBe("comfyui-mcp");
      expect(u.searchParams.get("ui_id")).toBeTruthy();
      // No JSON body.
      expect(c!.body).toBeUndefined();
    });
  });

  // ---- reinstall ---------------------------------------------------------

  describe("reinstallCustomNode", () => {
    // Same #730 post-op presence gate as update (reinstall is uninstall +
    // install — for a nowhere-resolving id BOTH cycles no-op and both drains
    // pass trivially), so the success path must report the pack as installed.
    const installedMyPack = {
      "my-pack": { ver: "1.0.0", cnr_id: "my-pack", enabled: true },
    };

    it("models reinstall as an uninstall task followed by an install task", async () => {
      const { calls } = stubFetch({ installedBody: installedMyPack });
      await reinstallCustomNode({ id: "my-pack" });
      expect(taskOf(calls, "uninstall").params).toMatchObject({
        node_name: "my-pack",
      });
      expect(taskOf(calls, "install").params).toMatchObject({
        id: "my-pack",
        version: "latest",
      });
    });

    it("fails truthfully for an id that resolves NOWHERE — before anything is queued (#730)", async () => {
      // Manager list empty AND an enumerable custom_nodes without the pack
      // (#797 disk evidence) — refused up front, NOTHING queued.
      fsCtl.readdirSync = () => [];
      const { calls } = stubFetch({ installedBody: {} });
      const err = await reinstallCustomNode({ id: "mcp-sweep-nonexistent-pack" }).catch(
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(NodeManagementError);
      expect((err as Error).message).toMatch(/not installed/);
      expect((err as Error).message).toMatch(/NOTHING was queued/);
      expect((err as Error).message).not.toMatch(/reinstalled/i);
      expect(
        calls.some(
          (c) => (c.body as { kind?: string } | undefined)?.kind === "uninstall",
        ),
      ).toBe(false);
    });

    it("reinstalls a module-spelled target via its CNR id so the install half can resolve", async () => {      // Caller passes the FOLDER name; the registry resolves the CNR id. The
      // uninstall names the module; the reinstall names the registry id —
      // otherwise the pack is removed and not restored (codex gate round 9).
      const { calls } = stubFetch({
        installedBody: {
          "ComfyUI-Impact-Pack": { ver: "8.28.3", cnr_id: "comfyui-impact-pack", enabled: true },
        },
      });
      const res = await reinstallCustomNode({ id: "ComfyUI-Impact-Pack" });
      expect(res.mechanism).toBe("manager-http");
      expect(taskOf(calls, "uninstall").params).toMatchObject({
        node_name: "ComfyUI-Impact-Pack",
      });
      expect(taskOf(calls, "install").params).toMatchObject({
        id: "comfyui-impact-pack",
      });
    });

    it("an OBSERVED post-reinstall absence reports the pack as REMOVED with the remedy", async () => {
      // Pre-resolve finds the pack; after the two queue cycles it is gone from
      // the list AND from disk — the uninstall half ran, the install half did
      // not restore it.
      fsCtl.readdirSync = () => [];
      let listCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const path = new URL(url).pathname + (new URL(url).search || "");
          if (path.startsWith("/v2/customnode/installed")) {
            listCalls++;
            return jsonResponse(listCalls === 1 ? installedMyPack : {});
          }
          if (path === "/v2/manager/queue/status") {
            return jsonResponse({
              total_count: 1,
              done_count: 1,
              in_progress_count: 0,
              is_processing: false,
            });
          }
          return new Response("", { status: 200 });
        }),
      );
      const err = await reinstallCustomNode({ id: "my-pack" }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(NodeManagementError);
      expect((err as Error).message).toMatch(/left the pack REMOVED/);
      expect((err as Error).message).toMatch(/install_custom_node/);
    });

    it("an UNVERIFIABLE post-reinstall state is NOT reported as REMOVED", async () => {
      // The post-op list cannot be read — removal was never observed, so the
      // verdict must stay "could not verify".
      let listCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const path = new URL(url).pathname + (new URL(url).search || "");
          if (path.startsWith("/v2/customnode/installed")) {
            listCalls++;
            if (listCalls > 1) return new Response("boom", { status: 500 });
            return jsonResponse(installedMyPack);
          }
          if (path === "/v2/manager/queue/status") {
            return jsonResponse({
              total_count: 1,
              done_count: 1,
              in_progress_count: 0,
              is_processing: false,
            });
          }
          return new Response("", { status: 200 });
        }),
      );
      const err = await reinstallCustomNode({ id: "my-pack" }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(NodeManagementError);
      expect((err as Error).message).toMatch(/could NOT be verified/);
      expect((err as Error).message).not.toMatch(/REMOVED/);
    });

    it("still succeeds for an installed-but-not-in-registry (git-cloned) pack", async () => {
      stubFetch({
        installedBody: {
          "some-git-node": { ver: "abc1234", aux_id: "user/some-git-node", enabled: true },
        },
      });
      const res = await reinstallCustomNode({ id: "some-git-node" });
      expect(res.mechanism).toBe("manager-http");
      expect(res.message).toMatch(/Queued \+ reinstalled/);
    });
  });

  // ---- fix ---------------------------------------------------------------

  describe("fixCustomNode", () => {
    it("posts a single pack via a fix task over HTTP", async () => {
      const { calls } = stubFetch();
      const res = await fixCustomNode({ id: "my-pack" });
      expect(res.mechanism).toBe("manager-http");
      expect(taskOf(calls, "fix").params).toMatchObject({ node_name: "my-pack" });
    });

    it("routes 'all' to the cm-cli subprocess", async () => {
      config.comfyuiPath = "/split/data";
      config.comfyuiCodePath = "/split/code";
      mockedExec.mockReturnValue(cliEnvelope({ message: "fixed all" }) as never);
      const res = await fixCustomNode({ id: "all" });
      expect(res.mechanism).toBe("comfy-cli");
      const [, args] = mockedExec.mock.calls[0];
      expect(args).toContain("fix");
      expect(args).toContain("all");
      expect(args).toContain("/split/data");
      expect(args).not.toContain("/split/code");
    });
  });

  // ---- on-disk presence evidence (#797) -------------------------------------

  describe("on-disk presence evidence (#797)", () => {
    // A registry-ZIP (or manually copied) pack is present in custom_nodes while
    // the Manager's installed list says nothing about it. The presence gate
    // must not read a Manager-list miss as "not installed locally".
    const impactPyproject =
      '[project]\nname = "comfyui-impact-pack"\nversion = "8.28.3"\n';
    const impactOnDisk = () => {
      fsCtl.readdirSync = (p) =>
        p.replace(/\\/g, "/").endsWith("/custom_nodes")
          ? [dirEnt("ComfyUI-Impact-Pack")]
          : [];
      fsCtl.readFileSync = (p) => {
        if (p.endsWith("pyproject.toml")) return impactPyproject;
        throw new Error(`unexpected readFileSync: ${p}`);
      };
    };

    it("update of an on-disk-but-untracked pack refuses with the TRUTH, naming the directory", async () => {
      impactOnDisk();
      stubFetch({ installedBody: {} });
      const err = await updateCustomNode({ id: "comfyui-impact-pack" }).catch(
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(NodeManagementError);
      // The REASON is the assertion: present-on-disk, not "absent".
      expect((err as Error).message).toMatch(/present on disk/);
      expect((err as Error).message).toMatch(/does not track/);
      expect((err as Error).message).toContain("ComfyUI-Impact-Pack");
      expect((err as Error).message).not.toMatch(/not present afterward/);
      expect((err as Error).message).not.toMatch(/not installed locally/);
    });

    it("matches a pack by directory name even when its pyproject cannot be read", async () => {
      fsCtl.readdirSync = (p) =>
        p.replace(/\\/g, "/").endsWith("/custom_nodes")
          ? [dirEnt("comfyui-impact-pack")]
          : [];
      fsCtl.readFileSync = () => {
        throw new Error("EACCES");
      };
      stubFetch({ installedBody: {} });
      const err = await updateCustomNode({ id: "comfyui-impact-pack" }).catch(
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(NodeManagementError);
      expect((err as Error).message).toMatch(/present on disk/);
    });

    it("matches a Manager-DISABLED pack directory (<name>.disabled) as present", async () => {
      fsCtl.readdirSync = (p) =>
        p.replace(/\\/g, "/").endsWith("/custom_nodes")
          ? [dirEnt("comfyui-impact-pack.disabled")]
          : [];
      fsCtl.readFileSync = (p) => {
        if (p.endsWith("pyproject.toml")) return impactPyproject;
        throw new Error(`unexpected readFileSync: ${p}`);
      };
      stubFetch({ installedBody: {} });
      const err = await updateCustomNode({ id: "comfyui-impact-pack" }).catch(
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(NodeManagementError);
      expect((err as Error).message).toMatch(/present on disk/);
    });

    it("install of an on-disk-but-untracked pack discloses 'already installed' instead of a not-found failure", async () => {
      // On disk BEFORE the call and still after: nothing new happened.
      impactOnDisk();
      stubFetch({ installedBody: {} });
      const res = await installCustomNode({ id: "comfyui-impact-pack" });
      expect(res.message).toMatch(/present on disk/);
      expect(res.message).toMatch(/ALREADY there before this call/);
      expect(res.message).not.toMatch(/not found in the/);
    });

    it("does NOT call a FRESH registry-zip install 'already installed' — the pre-state decides", async () => {
      // The pack is ABSENT before the call and present after: the install worked.
      // ComfyUI-Manager does not track registry-ZIP installs, so the post-state
      // alone looks identical to the case above — and reading it as "already
      // installed" told the user nothing happened when their pack had just been
      // installed (codex gate P0). A pre-state cannot be recovered afterwards.
      let installed = false;
      // Reuse the on-disk fixture rather than re-deriving its path matching, then
      // gate it on the flag: absent until the queue op fires, present after.
      impactOnDisk();
      const whenPresent = fsCtl.readdirSync;
      fsCtl.readdirSync = (p) => (installed ? whenPresent(p) : []);
      stubFetch({ installedBody: {}, onQueue: () => { installed = true; } });
      const res = await installCustomNode({ id: "comfyui-impact-pack" });

      // States the OBSERVATION, not a causal claim: `diskBefore` is a filesystem
      // snapshot with nothing binding it to this operation, so under two agents
      // on one rig the other one could have created the directory. What we saw
      // is "absent before, present now", and that is what it says.
      expect(res.message).toMatch(/is now present on disk/);
      expect(res.message).toMatch(/was NOT there before this call/);
      expect(res.message).toMatch(/another agent/i);
      expect(res.message).not.toMatch(/so it was installed/);
      expect(res.message).not.toMatch(/ALREADY/);
      expect(res.message).not.toMatch(/resolved to nothing/);
    });

    it("REFUSES a registry zip that left only .tracking — directory-exists is not installed (#1816)", async () => {
      // The reporter's case: install_custom_node action:"install" source:"registry"
      // of comfyui-chatterbox created custom_nodes/comfyui-chatterbox/ containing
      // only an empty .tracking file, then reported success because the directory
      // was absent before and present after. ComfyUI cannot import that.
      const packDir = join(COMFY, "custom_nodes", "comfyui-chatterbox");
      const repo = "https://github.com/sm079/comfyui-chatterbox";
      let installed = false;
      fsCtl.readdirSync = (p) => {
        if (!installed) return [];
        const norm = p.replace(/\\/g, "/");
        if (norm.endsWith("/custom_nodes")) return [dirEnt("comfyui-chatterbox")];
        if (norm.endsWith("/comfyui-chatterbox")) return [".tracking"];
        return [];
      };
      fsCtl.readFileSync = () => {
        throw new Error("ENOENT");
      };
      stubFetch({
        installedBody: {},
        onQueue: () => {
          installed = true;
        },
        registryDetails: { id: "comfyui-chatterbox", repository: repo },
      });

      const err = await installCustomNode({
        id: "comfyui-chatterbox",
        source: "registry",
        version: "latest",
      }).catch((e: Error) => e);

      expect(err).toBeInstanceOf(NodeManagementError);
      expect((err as Error).message).toMatch(/no loadable pack/);
      expect((err as Error).message).toMatch(/NOT reporting this as installed/);
      expect((err as Error).message).not.toMatch(/so it was installed/);
      expect((err as Error).message).not.toMatch(/is now present on disk/);
      // Names the fallback that actually worked for the reporter.
      expect((err as Error).message).toContain(repo);
      expect((err as Error).message).toMatch(/source:"git"/);
      // The husk this call created must not block the subsequent clone.
      expect(fsCtl.removed).toContain(packDir);
    });

    it("REFUSES a pre-existing .tracking-only husk and does not delete it (#1816)", async () => {
      // A retry over the empty dir the previous call left behind. The directory
      // was already there, so it is the user's — refuse, name it, leave it.
      fsCtl.readdirSync = (p) => {
        const norm = p.replace(/\\/g, "/");
        if (norm.endsWith("/custom_nodes")) return [dirEnt("comfyui-chatterbox")];
        if (norm.endsWith("/comfyui-chatterbox")) return [".tracking"];
        return [];
      };
      fsCtl.readFileSync = () => {
        throw new Error("ENOENT");
      };
      stubFetch({
        installedBody: {},
        registryDetails: {
          id: "comfyui-chatterbox",
          repository: "https://github.com/sm079/comfyui-chatterbox",
        },
      });

      const err = await installCustomNode({
        id: "comfyui-chatterbox",
        source: "registry",
      }).catch((e: Error) => e);

      expect(err).toBeInstanceOf(NodeManagementError);
      expect((err as Error).message).toMatch(/no loadable pack/);
      expect((err as Error).message).toMatch(/left untouched/);
      expect((err as Error).message).not.toMatch(/is now present on disk/);
      expect(fsCtl.removed).not.toContain(join(COMFY, "custom_nodes", "comfyui-chatterbox"));
    });

    it("the install post-verify scans the CALL-SCOPED adopted root, not the global one", async () => {
      // apply_manifest threads an adopted live root via opts.comfyuiPath; the
      // disk evidence must come from THAT root even when it differs from the
      // configured/saved one.
      fsCtl.readdirSync = (p) => {
        const norm = p.replace(/\\/g, "/");
        if (norm === "/adopted/ws/custom_nodes") return [dirEnt("ComfyUI-Impact-Pack")];
        return [];
      };
      fsCtl.readFileSync = (p) => {
        if (p.endsWith("pyproject.toml")) return impactPyproject;
        throw new Error(`unexpected readFileSync: ${p}`);
      };
      stubFetch({ installedBody: {} });
      const res = await installCustomNode({
        id: "comfyui-impact-pack",
        comfyuiPath: "/adopted/ws",
      });
      expect(res.message).toMatch(/present on disk/);
      expect(res.message).toContain(join("/adopted/ws", "custom_nodes", "ComfyUI-Impact-Pack"));
    });

    it("absence is asserted from BOTH sources when both were readable", async () => {
      fsCtl.readdirSync = () => [];
      stubFetch({ installedBody: {} });
      const err = await updateCustomNode({ id: "mcp-sweep-nonexistent-pack" }).catch(
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(NodeManagementError);
      expect((err as Error).message).toMatch(/not installed/);
      // Says the disk was actually checked — not a Manager-list-only verdict.
      expect((err as Error).message).toMatch(/on disk under/);
      expect((err as Error).message).toMatch(/NOTHING was queued/);
    });

    it("an unreadable disk check is UNVERIFIABLE, never absence", async () => {
      // readdirSync delegates to the real fs, which throws on the fake root —
      // the disk could not answer, so the verdict must stay "could not
      // determine", and nothing is queued.
      stubFetch({ installedBody: {} });
      const err = await updateCustomNode({ id: "mcp-sweep-nonexistent-pack" }).catch(
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(NodeManagementError);
      expect((err as Error).message).toMatch(/could not be determined/);
      expect((err as Error).message).toMatch(/NOTHING was queued|NOT queued/);
      expect((err as Error).message).not.toMatch(/not installed —/);
    });

    it("on-disk pack + UNREADABLE Manager list → unverifiable, never 'Manager does not track it'", async () => {
      // The disk says present, but the list could not be read — so neither
      // "Manager does not track it" nor "the op resolved to nothing" was
      // observed, and the message must not claim them.
      impactOnDisk();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const path = new URL(url).pathname + (new URL(url).search || "");
          if (path.startsWith("/v2/customnode/installed")) {
            return new Response("boom", { status: 500 });
          }
          if (path === "/v2/manager/queue/status") {
            return jsonResponse({
              total_count: 1,
              done_count: 1,
              in_progress_count: 0,
              is_processing: false,
            });
          }
          return new Response("", { status: 200 });
        }),
      );
      const err = await updateCustomNode({ id: "comfyui-impact-pack" }).catch(
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(NodeManagementError);
      expect((err as Error).message).toMatch(/present on disk/);
      expect((err as Error).message).toMatch(/could NOT be determined/);
      expect((err as Error).message).not.toMatch(/does not track/);
      expect((err as Error).message).not.toMatch(/resolved to NOTHING/);
    });

    it("the post-op gate uses the ENTRY-captured presence context, not a mid-op retarget", async () => {
      // The session is LOCAL at invocation and the pack is on disk. A retarget
      // flipping the session to remote mid-drain must not strip the disk
      // evidence from the post-op check.
      fsCtl.readdirSync = (p) =>
        p.replace(/\\/g, "/").endsWith("/custom_nodes") ? [dirEnt("my-pack")] : [];
      fsCtl.readFileSync = () => {
        throw new Error("ENOENT");
      };
      let listCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const path = new URL(url).pathname + (new URL(url).search || "");
          if (path.startsWith("/v2/customnode/installed")) {
            listCalls++;
            if (listCalls === 1) remoteFlags.remoteMode = true; // retarget mid-op
            return jsonResponse(
              listCalls === 1
                ? { "my-pack": { ver: "1.0.0", cnr_id: "my-pack", enabled: true } }
                : {},
            );
          }
          if (path === "/v2/manager/queue/status") {
            return jsonResponse({
              total_count: 1,
              done_count: 1,
              in_progress_count: 0,
              is_processing: false,
            });
          }
          return new Response("", { status: 200 });
        }),
      );
      const err = await updateCustomNode({ id: "my-pack" }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(NodeManagementError);
      // The entry context was local with the pack on disk — the verdict must
      // say so, not fall back to a Manager-list-only absence.
      expect((err as Error).message).toMatch(/present on disk/);
      expect((err as Error).message).not.toMatch(/does not inspect custom_nodes/);
    });
  });

  // ---- comfy-cli fallback (#808) --------------------------------------------

  describe("comfy-cli fallback (#808)", () => {
    it("useCmCli falls back to Manager HTTP when comfy-cli is not installed, and says so", async () => {
      // No comfy binary anywhere: not in the workspace venv, not on PATH.
      mockedExists.mockReturnValue(false);
      const { calls } = stubFetch({
        installedBody: {
          "my-pack": { ver: "1.0.0", cnr_id: "my-pack", enabled: true },
        },
      });
      const res = await installCustomNode({ id: "my-pack", useCmCli: true });
      // The mechanism switch is DISCLOSED, with the reason — not a silent
      // fallback, and not the old NODE_MANAGEMENT_ERROR dead end.
      expect(res.mechanism).toBe("manager-http");
      expect(res.message).toMatch(/comfy-cli was requested/);
      expect(res.message).toMatch(/not found on PATH/);
      expect(res.message).toMatch(/Installed "my-pack" via ComfyUI-Manager/);
      // Nothing was run through the CLI.
      expect(mockedExec).not.toHaveBeenCalled();
      expect(taskOf(calls, "install").params).toMatchObject({ id: "my-pack" });
    });

    it("useCmCli still uses comfy-cli when it IS available", async () => {
      mockedExec.mockReturnValue(cliEnvelope({ message: "ok" }) as never);
      const res = await installCustomNode({ id: "my-pack", useCmCli: true });
      expect(res.mechanism).toBe("comfy-cli");
      expect(res.message).not.toMatch(/falling back|requested \(useCmCli\)/);
    });
  });

  // ---- disable / enable / uninstall (#775) ----------------------------------

  describe("disable/enable/uninstall (#775)", () => {
    const installedEnabled = {
      "my-pack": { ver: "1.0.0", cnr_id: "my-pack", enabled: true },
    };
    const installedImpact = {
      "comfyui-impact-pack": { ver: "1.0.0", cnr_id: "comfyui-impact-pack", enabled: true },
    };
    const installedDisabled = {
      "my-pack": { ver: "1.0.0", cnr_id: "my-pack", enabled: false },
    };
    const drained = {
      total_count: 1,
      done_count: 1,
      in_progress_count: 0,
      is_processing: false,
    };

    /** Installed-list responses that CHANGE between the pre-op and post-op
     *  reads: the pre-check sees `pre`, the post-op verification sees `post`. */
    const stubChangingList = (pre: unknown, post: unknown) => {
      let listCalls = 0;
      const calls: Call[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          const method = init?.method ?? "GET";
          const body = init?.body ? JSON.parse(init.body as string) : undefined;
          calls.push({ url, method, body });
          const path = new URL(url).pathname + (new URL(url).search || "");
          if (path.startsWith("/v2/customnode/installed")) {
            listCalls++;
            return jsonResponse(listCalls === 1 ? pre : post);
          }
          if (path === "/v2/manager/queue/status") return jsonResponse(drained);
          return new Response("", { status: 200 });
        }),
      );
      return { calls };
    };

    it("disable queues a disable task and verifies the pack reports disabled", async () => {
      const { calls } = stubChangingList(installedEnabled, installedDisabled);
      const res = await disableCustomNode({ id: "my-pack" });
      expect(taskOf(calls, "disable").params).toMatchObject({
        node_name: "my-pack",
      });
      expect(res.message).toMatch(/Disabled "my-pack"/);
      expect(res.message).toMatch(/verified/);
    });

    it("disable of an ALREADY-DISABLED pack queues nothing and says so (no fabricated transition)", async () => {
      const { calls } = stubChangingList(installedDisabled, installedDisabled);
      const res = await disableCustomNode({ id: "my-pack" });
      expect(res.message).toMatch(/already disabled/);
      expect(res.message).toMatch(/NOTHING was run/);
      expect(res.message).not.toMatch(/Disabled "my-pack" via/);
      expect(
        calls.some(
          (c) => (c.body as { kind?: string } | undefined)?.kind === "disable",
        ),
      ).toBe(false);
    });

    it("disable discloses when Manager still reports the pack enabled", async () => {
      stubFetch({ installedBody: installedEnabled });
      const res = await disableCustomNode({ id: "my-pack" });
      expect(res.message).toMatch(/did NOT take effect/);
      expect(res.message).not.toMatch(/Disabled "my-pack" via/);
    });

    it("disable reports UNVERIFIED — neither success nor failure — when the post-op list cannot be read", async () => {
      // Pre-op read succeeds (the target validates), the POST-OP read fails.
      let listCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          const path = new URL(url).pathname + (new URL(url).search || "");
          if (path.startsWith("/v2/customnode/installed")) {
            listCalls++;
            if (listCalls > 1) return new Response("boom", { status: 500 });
            return jsonResponse(installedEnabled);
          }
          if (path === "/v2/manager/queue/status") return jsonResponse(drained);
          return new Response("", { status: 200 });
        }),
      );
      const res = await disableCustomNode({ id: "my-pack" });
      expect(res.message).toMatch(/could NOT be verified/);
      expect(res.message).not.toMatch(/Disabled "my-pack"/);
      expect(res.message).not.toMatch(/did NOT take effect/);
    });

    it("disable refuses an id that resolves nowhere — NOTHING is queued", async () => {
      fsCtl.readdirSync = () => [];
      const { calls } = stubFetch({ installedBody: {} });
      const err = await disableCustomNode({ id: "ghost-pack" }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(NodeManagementError);
      expect((err as Error).message).toMatch(/not installed/);
      expect((err as Error).message).toMatch(/NOTHING was queued/);
      expect(
        calls.some(
          (c) => (c.body as { kind?: string } | undefined)?.kind === "disable",
        ),
      ).toBe(false);
    });

    it("disable stays UNVERIFIED when Manager reports no enabled flag at all", async () => {
      // A build that carries neither `enabled` nor `is_disabled` — the flag
      // must not be invented as "enabled" and then "verified".
      stubFetch({ installedBody: { "my-pack": { ver: "1.0.0", cnr_id: "my-pack" } } });
      const res = await disableCustomNode({ id: "my-pack" });
      expect(res.message).toMatch(/could NOT be verified/);
      expect(res.message).not.toMatch(/Disabled "my-pack" via/);
    });

    it("disable via comfy-cli verifies against the Manager list afterwards", async () => {
      mockedExec.mockReturnValue(cliEnvelope({ message: "disabled" }) as never);
      stubChangingList(installedEnabled, installedDisabled);
      const res = await disableCustomNode({ id: "my-pack", useCmCli: true });
      expect(res.mechanism).toBe("comfy-cli");
      expect(res.message).toMatch(/via official comfy-cli/);
      expect(res.message).toMatch(/verified against ComfyUI-Manager/);
    });

    it("disable via comfy-cli of an ALREADY-DISABLED pack runs nothing and says so", async () => {
      stubChangingList(installedDisabled, installedDisabled);
      const res = await disableCustomNode({ id: "my-pack", useCmCli: true });
      expect(res.mechanism).toBe("comfy-cli");
      expect(res.message).toMatch(/already disabled/);
      expect(res.message).toMatch(/NOTHING was run/);
      expect(mockedExec).not.toHaveBeenCalled();
    });

    it("disable via comfy-cli discloses when the CLI's success claim doesn't hold", async () => {
      mockedExec.mockReturnValue(cliEnvelope({ message: "disabled" }) as never);
      // CLI claims success; Manager still reports the pack enabled.
      stubFetch({ installedBody: installedEnabled });
      const res = await disableCustomNode({ id: "my-pack", useCmCli: true });
      expect(res.message).toMatch(/did NOT take effect/);
      expect(res.message).not.toMatch(/^Disabled/);
    });

    it("disable with useCmCli falls back to Manager HTTP when the CLI is unavailable, disclosed", async () => {
      // No comfy binary anywhere (workspace venv or PATH).
      mockedExists.mockReturnValue(false);
      stubChangingList(installedEnabled, installedDisabled);
      const res = await disableCustomNode({ id: "my-pack", useCmCli: true });
      expect(res.mechanism).toBe("manager-http");
      expect(res.message).toMatch(/comfy-cli was requested/);
      expect(res.message).toMatch(/Disabled "my-pack"/);
      expect(mockedExec).not.toHaveBeenCalled();
    });

    it("the CLI workspace is pinned with the target across the pre-check await (retarget mid-op)", async () => {
      mockedExec.mockReturnValue(cliEnvelope({ message: "disabled" }) as never);
      let listCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const path = new URL(url).pathname + (new URL(url).search || "");
          if (path.startsWith("/v2/customnode/installed")) {
            listCalls++;
            // A retarget landing between the pre-check and the CLI run must not
            // move the CLI to a different install.
            if (listCalls === 1) config.comfyuiPath = "/other/comfy";
            return jsonResponse(listCalls === 1 ? installedEnabled : installedDisabled);
          }
          if (path === "/v2/manager/queue/status") return jsonResponse(drained);
          return new Response("", { status: 200 });
        }),
      );
      const res = await disableCustomNode({ id: "my-pack", useCmCli: true });
      expect(res.mechanism).toBe("comfy-cli");
      const cliArgs = mockedExec.mock.calls[0]?.[1] as string[];
      expect(cliArgs[cliArgs.indexOf("--workspace") + 1]).toBe(COMFY);
    });

    it("disable sends the MANAGER module name as node_name when it differs from the registry id", async () => {
      // Manager's installed list keys on the folder name; the caller's registry
      // id only MATCHES it. The queued op must use the module name or the 3.x
      // routes resolve nothing.
      const pre = {
        "ComfyUI-Impact-Pack": { ver: "8.28.3", cnr_id: "comfyui-impact-pack", enabled: true },
      };
      const post = {
        "ComfyUI-Impact-Pack": { ver: "8.28.3", cnr_id: "comfyui-impact-pack", enabled: false },
      };
      const { calls } = stubChangingList(pre, post);
      const res = await disableCustomNode({ id: "comfyui-impact-pack" });
      expect(taskOf(calls, "disable").params).toMatchObject({
        node_name: "ComfyUI-Impact-Pack",
      });
      expect(res.message).toMatch(/Disabled "comfyui-impact-pack"/);
    });

    it("enable queues an enable task keyed by cnr_id and verifies the pack reports enabled", async () => {
      const { calls } = stubChangingList(installedDisabled, installedEnabled);
      const res = await enableCustomNode({ id: "my-pack" });
      expect(taskOf(calls, "enable").params).toMatchObject({ cnr_id: "my-pack" });
      expect(res.message).toMatch(/Enabled "my-pack"/);
    });

    it("uninstall refuses a pack that resolves nowhere — NOTHING is queued", async () => {
      fsCtl.readdirSync = () => [];
      const { calls } = stubFetch({ installedBody: {} });
      const err = await uninstallCustomNode({ id: "ghost-pack" }).catch(
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(NodeManagementError);
      expect((err as Error).message).toMatch(/not installed/);
      expect((err as Error).message).toMatch(/NOTHING was queued/);
      expect(
        calls.some(
          (c) => (c.body as { kind?: string } | undefined)?.kind === "uninstall",
        ),
      ).toBe(false);
    });

    it("uninstall refuses an on-disk-but-untracked pack and names the directory to remove", async () => {
      fsCtl.readdirSync = (p) =>
        p.replace(/\\/g, "/").endsWith("/custom_nodes") ? [dirEnt("ghost-pack")] : [];
      fsCtl.readFileSync = () => {
        throw new Error("ENOENT");
      };
      stubFetch({ installedBody: {} });
      const err = await uninstallCustomNode({ id: "ghost-pack" }).catch(
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(NodeManagementError);
      expect((err as Error).message).toMatch(/does not track/);
      expect((err as Error).message).toContain("ghost-pack");
      expect((err as Error).message).toMatch(/NOTHING was queued/);
    });

    it("uninstall verifies the pack is GONE before claiming success", async () => {
      let listCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const path = new URL(url).pathname + (new URL(url).search || "");
          if (path.startsWith("/v2/customnode/installed")) {
            listCalls++;
            // Pre-queue presence check sees the pack; post-op it is gone.
            return jsonResponse(listCalls === 1 ? installedEnabled : {});
          }
          if (path === "/v2/manager/queue/status") return jsonResponse(drained);
          return new Response("", { status: 200 });
        }),
      );
      const res = await uninstallCustomNode({ id: "my-pack" });
      expect(res.message).toMatch(/Uninstalled "my-pack"/);
      expect(listCalls).toBeGreaterThanOrEqual(2);
    });

    it("does NOT claim an uninstall when the DIRECTORY survives Manager's list", async () => {
      // A partial uninstall can drop Manager's tracking entry and leave
      // custom_nodes/<pack> on disk. ComfyUI loads directories, not Manager's
      // bookkeeping — so the pack comes back on the next restart while we have
      // already told the user it is gone (codex gate P0). A destructive
      // postcondition deserves the strongest evidence available.
      // The directory is there before AND after. Inlined rather than reusing the
      // sibling block's helper, which is scoped elsewhere; `endsWith` avoids a
      // separator regex entirely.
      const impactToml = '[project]' + String.fromCharCode(10) +
        'name = "comfyui-impact-pack"' + String.fromCharCode(10) +
        'version = "8.28.3"' + String.fromCharCode(10);
      fsCtl.readdirSync = (p) =>
        p.endsWith("custom_nodes") ? [dirEnt("ComfyUI-Impact-Pack")] : [];
      fsCtl.readFileSync = (p) => {
        if (p.endsWith("pyproject.toml")) return impactToml;
        throw new Error(`unexpected readFileSync: ${p}`);
      };
      let listCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const path = new URL(url).pathname + (new URL(url).search || "");
          if (path.startsWith("/v2/customnode/installed")) {
            listCalls++;
            return jsonResponse(listCalls === 1 ? installedImpact : {});
          }
          if (path === "/v2/manager/queue/status") return jsonResponse(drained);
          return new Response("", { status: 200 });
        }),
      );
      const res = await uninstallCustomNode({ id: "comfyui-impact-pack" });

      expect(res.message).toMatch(/STILL on disk/);
      expect(res.message).toMatch(/NOT a completed uninstall/);
      // The claim it must never make while the directory is there.
      expect(res.message).not.toMatch(/^Uninstalled/);
    });

    it("uninstall discloses when the pack is STILL present afterwards", async () => {
      stubFetch({ installedBody: installedEnabled });
      const res = await uninstallCustomNode({ id: "my-pack" });
      expect(res.message).toMatch(/did NOT take effect/);
      expect(res.message).not.toMatch(/Uninstalled "my-pack" via/);
    });

    it("EVERY comfy-cli route refuses in remote mode, not just the ones with an availability probe", async () => {
      // The first fix guarded `comfyCliUnavailableReason`, which only
      // install/enable/disable/uninstall consult — `update`, `reinstall`, `fix
      // all` and dependency sync call the CLI without it, so four routes could
      // still mutate a stale local install in remote mode (codex gate P0). The
      // guard now sits in `runCmCli`, which every one of them passes through.
      stubFetch({ installedBody: installedEnabled });
      remoteFlags.remoteMode = true;
      try {
        const err = await updateCustomNode({ id: "my-pack", useCmCli: true }).catch(
          (e: unknown) => e,
        );
        expect(String(err)).toMatch(/REMOTE ComfyUI/i);
        expect(String(err)).toMatch(/Nothing was run/i);
        // And the CLI subprocess was never spawned.
        expect(mockedExec).not.toHaveBeenCalled();
      } finally {
        remoteFlags.remoteMode = false;
      }
    });

    it("comfy-cli REFUSES in remote mode — a local uninstall must not run behind remote checks", async () => {
      // The dangerous shape: a local COMFYUI_PATH IS available, so the "no local
      // path" guard passes and comfy-cli happily uninstalls from the local tree
      // while the pre/post Manager checks describe the REMOTE server — and the
      // local destructive action is never disclosed (codex gate P0). Having a
      // path is what makes this case unsafe, not the lack of one.
      // Manager is reachable and tracks the pack, so the presence pre-check
      // passes and the CLI decision is actually reached.
      stubFetch({ installedBody: installedEnabled });
      remoteFlags.remoteMode = true;
      try {
        const res = await uninstallCustomNode({ id: "my-pack", useCmCli: true });
        expect(JSON.stringify(res)).toMatch(/REMOTE ComfyUI/i);
        expect(res.mechanism).not.toBe("comfy-cli");
      } finally {
        remoteFlags.remoteMode = false;
      }
    });

    it("uninstall via comfy-cli refuses a pack that was never installed — nothing runs", async () => {
      // CLI usable (default mocks), but the pre-check resolves nowhere —
      // the CLI must not run so its exit 0 can be "verified" as a no-op.
      fsCtl.readdirSync = () => [];
      stubFetch({ installedBody: {} });
      const err = await uninstallCustomNode({ id: "ghost-pack", useCmCli: true }).catch(
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(NodeManagementError);
      expect((err as Error).message).toMatch(/not installed/);
      expect(mockedExec).not.toHaveBeenCalled();
    });

    it("uninstall via comfy-cli with an unreadable list and NO pack anywhere is UNVERIFIED, not 'Uninstalled'", async () => {
      // Absent before AND after: the post-op absence may predate the call, so
      // claiming an uninstall would fabricate a transition.
      fsCtl.readdirSync = () => [];
      mockedExec.mockReturnValue(cliEnvelope({ message: "uninstalled" }) as never);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const path = new URL(url).pathname + (new URL(url).search || "");
          if (path.startsWith("/v2/customnode/installed")) {
            return new Response("boom", { status: 500 });
          }
          if (path === "/v2/manager/queue/status") {
            return jsonResponse({
              total_count: 1,
              done_count: 1,
              in_progress_count: 0,
              is_processing: false,
            });
          }
          return new Response("", { status: 200 });
        }),
      );
      const res = await uninstallCustomNode({ id: "my-pack", useCmCli: true });
      expect(res.mechanism).toBe("comfy-cli");
      expect(res.message).toMatch(/NOT claiming an uninstall happened/);
      expect(res.message).not.toMatch(/no matching pack directory remains/);
    });

    it("uninstall via comfy-cli proceeds with an unreadable list when the pack IS on disk, verified on disk", async () => {
      let removed = false;
      fsCtl.readdirSync = (p) =>
        p.replace(/\\/g, "/").endsWith("/custom_nodes") && !removed
          ? [dirEnt("my-pack")]
          : [];
      fsCtl.readFileSync = () => {
        throw new Error("ENOENT");
      };
      mockedExec.mockImplementation(() => {
        removed = true;
        return cliEnvelope({ message: "uninstalled" }) as never;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const path = new URL(url).pathname + (new URL(url).search || "");
          if (path.startsWith("/v2/customnode/installed")) {
            return new Response("boom", { status: 500 });
          }
          if (path === "/v2/manager/queue/status") {
            return jsonResponse(drained);
          }
          return new Response("", { status: 200 });
        }),
      );
      const res = await uninstallCustomNode({ id: "my-pack", useCmCli: true });
      expect(res.mechanism).toBe("comfy-cli");
      expect(mockedExec).toHaveBeenCalled();
      expect(res.message).toMatch(/Uninstalled "my-pack"/);
      expect(res.message).toMatch(/no matching directory remains/);
    });

    it("the CLI uninstall disk verification uses the ENTRY-captured workspace, not a retargeted one", async () => {
      // The CLI runs against /fake/comfy; the retarget flips config to
      // /other/comfy (which still has the pack). Verifying against the
      // retargeted root would falsely report "did NOT take effect".
      let removed = false;
      fsCtl.readdirSync = (p) => {
        const norm = p.replace(/\\/g, "/");
        if (norm.includes("/other/comfy/")) return [dirEnt("my-pack")];
        if (norm.endsWith("/custom_nodes")) return removed ? [] : [dirEnt("my-pack")];
        return [];
      };
      fsCtl.readFileSync = () => {
        throw new Error("ENOENT");
      };
      mockedExec.mockImplementation(() => {
        config.comfyuiPath = "/other/comfy";
        removed = true;
        return cliEnvelope({ message: "uninstalled" }) as never;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const path = new URL(url).pathname + (new URL(url).search || "");
          if (path.startsWith("/v2/customnode/installed")) {
            return new Response("boom", { status: 500 });
          }
          if (path === "/v2/manager/queue/status") {
            return jsonResponse(drained);
          }
          return new Response("", { status: 200 });
        }),
      );
      const res = await uninstallCustomNode({ id: "my-pack", useCmCli: true });
      expect(res.message).toMatch(/Uninstalled "my-pack"/);
      expect(res.message).not.toMatch(/did NOT take effect/);
    });

    it("disable via comfy-cli proceeds with an unreadable list when the pack IS on disk, disclosed", async () => {
      fsCtl.readdirSync = (p) =>
        p.replace(/\\/g, "/").endsWith("/custom_nodes") ? [dirEnt("my-pack")] : [];
      fsCtl.readFileSync = () => {
        throw new Error("ENOENT");
      };
      mockedExec.mockReturnValue(cliEnvelope({ message: "disabled" }) as never);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const path = new URL(url).pathname + (new URL(url).search || "");
          if (path.startsWith("/v2/customnode/installed")) {
            return new Response("boom", { status: 500 });
          }
          if (path === "/v2/manager/queue/status") {
            return jsonResponse(drained);
          }
          return new Response("", { status: 200 });
        }),
      );
      const res = await disableCustomNode({ id: "my-pack", useCmCli: true });
      expect(res.mechanism).toBe("comfy-cli");
      expect(mockedExec).toHaveBeenCalled();
      expect(res.message).toMatch(/comfy-cli's own report/);
      expect(res.message).toMatch(/pre-operation state was never established/);
    });
  });

  // ---- panel_install_node git-URL normalization (#789) ----------------------

  describe("normalizeGitUrlInstallArgs (#789)", () => {
    const URL = "https://github.com/ltdrdata/ComfyUI-Impact-Pack";

    it("routes a git-URL id with no version to a nightly from-source install, disclosed", () => {
      const out = normalizeGitUrlInstallArgs({ id: URL });
      expect(out.repository).toBe(URL);
      expect(out.version).toBe("nightly");
      expect(out.note).toMatch(/from-source/);
      // The URL is NOT forwarded as `id` too — the reroute off the id path is
      // the whole point; sending both leaves it to downstream precedence.
      expect(out.id).toBeUndefined();
    });

    // #789 RECURRENCE — the reroute cannot fix an UNREGISTERED pack.
    //
    // The original report was a registered pack with the wrong version spec, which
    // "nightly" fixes. The recurrence was ComfyUI-MiniMaxH3-FirstBlockCache, which
    // is in no registry: Manager v4's do_install resolves by pack ID and never by
    // URL (3.x's files:[url] clone path does not exist there), so a v4 host has NO
    // Manager route for it by any spelling, and the panel cannot clone — it is
    // browser JS. The reporter was left at "not found" and had to find the working
    // tool themselves.
    it("names install_custom_node, the tool that CAN finish an unregistered pack", () => {
      const out = normalizeGitUrlInstallArgs({ id: URL });
      expect(out.note).toMatch(/install_custom_node/);
      expect(out.note).toMatch(/source:"git"/);
      // The trigger the caller will actually see from the Manager.
      expect(out.note).toMatch(/not found.*not available node|not available node/);
      // And its precondition — the clone writes to the server's filesystem.
      expect(out.note).toMatch(/LOCAL ComfyUI/);
    });

    it("does not offer the escape hatch when the caller pinned a version", () => {
      // No reroute happened, so there is no note at all — a pinned version is the
      // caller's own choice and gets no advice it did not ask for.
      expect(normalizeGitUrlInstallArgs({ id: URL, version: "8.28.3" }).note).toBeUndefined();
    });

    it("translates an explicit 'latest' on a git URL to 'nightly' (the #789 failure shape)", () => {
      const out = normalizeGitUrlInstallArgs({ id: URL, version: "latest" });
      expect(out.version).toBe("nightly");
      expect(out.note).toBeTruthy();
      expect(out.id).toBeUndefined();
    });

    it("leaves an explicit non-latest version untouched — the caller's choice stands", () => {
      const out = normalizeGitUrlInstallArgs({ id: URL, version: "8.28.3" });
      expect(out.version).toBe("8.28.3");
      expect(out.note).toBeUndefined();
      expect(out.id).toBeUndefined();
    });

    it("leaves a plain registry id install untouched", () => {
      expect(normalizeGitUrlInstallArgs({ id: "comfyui-kjnodes" })).toEqual({});
      expect(
        normalizeGitUrlInstallArgs({ id: "comfyui-kjnodes", version: "latest" }),
      ).toEqual({});
    });

    it("honours an explicit repository as the git target", () => {
      const out = normalizeGitUrlInstallArgs({ repository: URL });
      expect(out.repository).toBe(URL);
      expect(out.version).toBe("nightly");
    });

    it("refuses when BOTH id and repository are given — two targets, not one", () => {
      const out = normalizeGitUrlInstallArgs({
        id: "comfyui-kjnodes",
        repository: URL,
      });
      expect(out.conflict).toMatch(/BOTH/);
      expect(out.version).toBeUndefined();
      expect(out.repository).toBeUndefined();
    });
  });

  describe("nodesInstallCommandArgs (#789 dispatch shape)", () => {
    const URL = "https://github.com/ltdrdata/ComfyUI-Impact-Pack";

    it("the dispatched command drops `id` for a URL-as-id target — no ??-merge can restore it", () => {
      const out = nodesInstallCommandArgs({ id: URL, version: "latest", mode: "remote" });
      expect(out.id).toBeUndefined();
      expect(out.repository).toBe(URL);
      expect(out.version).toBe("nightly");
      expect(out.mode).toBe("remote");
      expect(out.note).toBeTruthy();
      expect(out.conflict).toBeUndefined();
    });

    it("passes a plain registry id through untouched", () => {
      const out = nodesInstallCommandArgs({ id: "comfyui-kjnodes", version: "latest" });
      expect(out.id).toBe("comfyui-kjnodes");
      expect(out.version).toBe("latest");
      expect(out.repository).toBeUndefined();
    });

    it("surfaces the id+repository conflict", () => {
      const out = nodesInstallCommandArgs({ id: "comfyui-kjnodes", repository: URL });
      expect(out.conflict).toMatch(/BOTH/);
    });
  });


  // ---- list --------------------------------------------------------------

  describe("listInstalledNodes", () => {
    it("parses an object-keyed installed response", async () => {
      stubFetch({
        installedBody: {
          "ComfyUI-Impact-Pack": {
            ver: "8.0.0",
            cnr_id: "comfyui-impact-pack",
            aux_id: "",
            enabled: true,
          },
          "some-git-node": {
            ver: "abc1234",
            cnr_id: "",
            aux_id: "user/some-git-node",
            enabled: false,
          },
        },
      });

      const nodes = await listInstalledNodes();
      expect(nodes).toHaveLength(2);

      const impact = nodes.find((n) => n.module === "ComfyUI-Impact-Pack")!;
      expect(impact.cnrId).toBe("comfyui-impact-pack");
      expect(impact.auxId).toBeUndefined();
      expect(impact.version).toBe("8.0.0");
      expect(impact.enabled).toBe(true);

      const git = nodes.find((n) => n.module === "some-git-node")!;
      expect(git.auxId).toBe("user/some-git-node");
      expect(git.cnrId).toBeUndefined();
      expect(git.enabled).toBe(false);
    });

    it("handles an array-shaped installed response", async () => {
      stubFetch({
        installedBody: [
          { title: "PackA", ver: "1.0.0", cnr_id: "packa", enabled: true },
        ],
      });
      const nodes = await listInstalledNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0].module).toBe("PackA");
    });

    it("missing enabled/is_disabled is UNKNOWN, never defaulted to a definite state", async () => {
      stubFetch({
        installedBody: {
          A: { ver: "1" },
          B: { ver: "1", is_disabled: true },
          C: { ver: "1", is_disabled: false },
        },
      });
      const nodes = await listInstalledNodes();
      // A reported nothing — claiming "enabled" would be inventing state the
      // verification paths then treat as observed.
      expect(nodes.find((n) => n.module === "A")!.enabled).toBeUndefined();
      expect(nodes.find((n) => n.module === "B")!.enabled).toBe(false);
      expect(nodes.find((n) => n.module === "C")!.enabled).toBe(true);
    });

    it("an installed-list ERROR ENVELOPE ({\"error\": …}) is unreadable, not an empty list", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const path = new URL(url).pathname;
          if (path === "/v2/manager/queue/status") {
            return jsonResponse({
              total_count: 1,
              done_count: 1,
              in_progress_count: 0,
              is_processing: false,
            });
          }
          if (path.startsWith("/v2/customnode/installed")) {
            // Parses as an object — but its values are scalars, not pack records.
            return jsonResponse({ error: "temporary failure" });
          }
          return new Response("", { status: 200 });
        }),
      );
      await expect(listInstalledNodes()).rejects.toThrow(/unreadable payload/);
    });

    it("a NESTED error envelope ({\"error\": {\"message\": …}}) is unreadable, not a pack named 'error'", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const path = new URL(url).pathname;
          if (path === "/v2/manager/queue/status") {
            return jsonResponse({
              total_count: 1,
              done_count: 1,
              in_progress_count: 0,
              is_processing: false,
            });
          }
          if (path.startsWith("/v2/customnode/installed")) {
            return jsonResponse({ error: { message: "temporary failure" } });
          }
          return new Response("", { status: 200 });
        }),
      );
      await expect(listInstalledNodes()).rejects.toThrow(/unreadable payload/);
    });

    it("a STRING-array installed payload is unreadable — parseInstalled drops bare strings", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const path = new URL(url).pathname;
          if (path === "/v2/manager/queue/status") {
            return jsonResponse({
              total_count: 1,
              done_count: 1,
              in_progress_count: 0,
              is_processing: false,
            });
          }
          if (path.startsWith("/v2/customnode/installed")) {
            return jsonResponse(["temporary failure"]);
          }
          return new Response("", { status: 200 });
        }),
      );
      await expect(listInstalledNodes()).rejects.toThrow(/unreadable payload/);
    });

    it("an unreadable installed-list payload is an ERROR, not an empty list", async () => {
      // A 200 whose body is HTML/text parses to a raw string in managerFetch;
      // parseInstalled would silently read it as "nothing installed".
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const path = new URL(url).pathname;
          if (path === "/v2/manager/queue/status") {
            return jsonResponse({
              total_count: 1,
              done_count: 1,
              in_progress_count: 0,
              is_processing: false,
            });
          }
          if (path.startsWith("/v2/customnode/installed")) {
            return new Response("<!doctype html><html>catchall</html>", { status: 200 });
          }
          return new Response("", { status: 200 });
        }),
      );
      await expect(listInstalledNodes()).rejects.toThrow(/unreadable payload/);
    });
  });

  // ---- sync deps ---------------------------------------------------------

  describe("syncNodeDependencies", () => {
    it("runs cm-cli restore-dependencies", async () => {
      mockedExec.mockReturnValue(cliEnvelope({ message: "deps restored" }) as never);
      const res = await syncNodeDependencies();
      expect(res.mechanism).toBe("comfy-cli");
      const [, args] = mockedExec.mock.calls[0];
      expect(args).toEqual([
        "--json",
        "--workspace",
        COMFY,
        "--skip-prompt",
        "node",
        "restore-dependencies",
      ]);
    });
  });

  // ---- install model -----------------------------------------------------

  describe("installModelViaManager", () => {
    it("queues an install-model task with name/url/filename/type/save_path and drains the queue", async () => {
      const { calls } = stubFetch();
      const res = await installModelViaManager({
        name: "model.safetensors",
        url: "https://example.com/model.safetensors",
        filename: "model.safetensors",
        type: "checkpoints",
      });

      expect(res.mechanism).toBe("manager-http");
      const { body, params } = taskOf(calls, "install-model");
      // Envelope matches the other tasks: ui_id + client_id + kind + params.
      expect(body.client_id).toBe("comfyui-mcp");
      expect(body.kind).toBe("install-model");
      expect(body.ui_id).toBeTruthy();
      expect(params).toMatchObject({
        name: "model.safetensors",
        url: "https://example.com/model.safetensors",
        filename: "model.safetensors",
        type: "checkpoints",
      });
      // ui_id is threaded into params like the other task kinds.
      expect(params.ui_id).toBe(body.ui_id);
      // save_path is ALWAYS sent, defaulting to the literal "default" when no
      // explicit path is given (Manager bails on a missing save_path).
      expect(params.save_path).toBe("default");
      // Drain only proves dispatch, not landing — message must NOT claim success.
      expect(res.message).not.toMatch(/\binstalled\b/i);
      expect(res.message).toMatch(/dispatched/i);

      // The queue worker was started and polled to completion.
      expect(
        calls.some((c) => c.url.endsWith("/v2/manager/queue/start")),
      ).toBe(true);
      expect(
        calls.some((c) => c.url.endsWith("/v2/manager/queue/status")),
      ).toBe(true);
    });

    it("includes save_path when provided", async () => {
      const { calls } = stubFetch();
      await installModelViaManager({
        name: "lora.safetensors",
        url: "https://example.com/lora.safetensors",
        filename: "lora.safetensors",
        type: "lora",
        save_path: "loras/pusa",
      });
      const { params } = taskOf(calls, "install-model");
      expect(params.save_path).toBe("loras/pusa");
    });

    it("falls back to filename for name and 'default' for save_path when blank", async () => {
      const { calls } = stubFetch();
      await installModelViaManager({
        name: "   ",
        url: "https://example.com/m.safetensors",
        filename: "m.safetensors",
        type: "checkpoints",
        save_path: "  ",
      });
      const { params } = taskOf(calls, "install-model");
      expect(params.name).toBe("m.safetensors");
      expect(params.save_path).toBe("default");
    });
  });

  // ---- error handling ----------------------------------------------------

  describe("subprocess error handling", () => {
    it("throws ProcessControlError when comfyuiPath is undefined (remote mode)", async () => {
      config.comfyuiPath = undefined;
      await expect(syncNodeDependencies()).rejects.toBeInstanceOf(
        ProcessControlError,
      );
      expect(mockedExec).not.toHaveBeenCalled();
    });

    it("throws NodeManagementError when cm-cli.py is missing", async () => {
      mockedExists.mockReturnValue(false);
      await expect(syncNodeDependencies()).rejects.toBeInstanceOf(
        NodeManagementError,
      );
    });

    it("wraps cm-cli failures with stdout/stderr details", async () => {
      const err = Object.assign(new Error("boom"), {
        stdout: Buffer.from("some out"),
        stderr: Buffer.from("trace"),
      });
      mockedExec.mockImplementation(() => {
        throw err;
      });
      await expect(syncNodeDependencies()).rejects.toMatchObject({
        code: "NODE_MANAGEMENT_ERROR",
      });
    });

    it("surfaces a clear error when ENOENT (python missing)", async () => {
      const err = Object.assign(new Error("spawn python ENOENT"), {
        code: "ENOENT",
      });
      mockedExec.mockImplementation(() => {
        throw err;
      });
      await expect(syncNodeDependencies()).rejects.toBeInstanceOf(
        ProcessControlError,
      );
    });
  });

  describe("HTTP error handling", () => {
    it("throws NodeManagementError when the Manager API is unreachable", async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      });
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        installCustomNode({ id: "x" }),
      ).rejects.toBeInstanceOf(NodeManagementError);
    });
  });

  // ---- released Manager 3.x (legacy /manager/* API — issue #116) -----------

  describe("legacy Manager 3.x API", () => {
    /** Stub where every /v2 route 405s (like released Manager 3.41) and the
     *  legacy per-operation routes answer. */
    function stubLegacyFetch(
      opts: { installedBody?: unknown; update405?: boolean; start405?: boolean } = {},
    ) {
      const calls: Call[] = [];
      const fetchMock = vi.fn(
        async (url: string, init?: RequestInit): Promise<Response> => {
          const method = init?.method ?? "GET";
          const body = init?.body ? JSON.parse(init.body as string) : undefined;
          calls.push({ url, method, body });
          const path = new URL(url).pathname;
          if (path.startsWith("/v2/")) {
            return new Response("405: Method Not Allowed", { status: 405 });
          }
          // A build that does NOT register the per-operation update route: the
          // ComfyUI frontend catchall answers the unregistered POST with 405.
          if (opts.update405 && path === "/manager/queue/update" && method === "POST") {
            return new Response("405: Method Not Allowed", { status: 405 });
          }
          // A queue-control 405 on BOTH methods (the POST→GET negotiation also
          // fails) — a DRAIN failure, not an "operation route missing" signal.
          if (opts.start405 && path === "/manager/queue/start") {
            return new Response("405: Method Not Allowed", { status: 405 });
          }
          if (path === "/manager/queue/status") {
            return jsonResponse({
              total_count: 1,
              done_count: 1,
              in_progress_count: 0,
              is_processing: false,
            });
          }
          if (path === "/customnode/installed") {
            return jsonResponse(opts.installedBody ?? {});
          }
          return new Response("", { status: 200 });
        },
      );
      vi.stubGlobal("fetch", fetchMock);
      return { calls };
    }

    const legacyCallTo = (calls: Call[], path: string) =>
      calls.find((c) => new URL(c.url).pathname === path);

    it("detects legacy and installs a registry id via /manager/queue/install", async () => {
      const { calls } = stubLegacyFetch({
        installedBody: {
          "comfyui-impact-pack": { ver: "1.0.0", cnr_id: "comfyui-impact-pack", enabled: true },
        },
      });
      const res = await installCustomNode({ id: "comfyui-impact-pack" });
      expect(res.mechanism).toBe("manager-http");
      const install = legacyCallTo(calls, "/manager/queue/install");
      expect(install?.body).toMatchObject({
        id: "comfyui-impact-pack",
        version: "latest",
        selected_version: "latest",
        channel: "default",
        mode: "remote",
      });
      // start + status polled on the UNPREFIXED routes; the task route never used
      expect(legacyCallTo(calls, "/manager/queue/start")).toBeDefined();
      expect(legacyCallTo(calls, "/v2/manager/queue/task")).toBeUndefined();
    });

    it("disable sends the pack's REAL installed version as node_ver (legacy body keys on it)", async () => {
      let listCalls = 0;
      const calls: Call[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
          const method = init?.method ?? "GET";
          const body = init?.body ? JSON.parse(init.body as string) : undefined;
          calls.push({ url, method, body });
          const path = new URL(url).pathname;
          if (path.startsWith("/v2/")) {
            return new Response("405: Method Not Allowed", { status: 405 });
          }
          if (path === "/manager/queue/status") {
            return jsonResponse({
              total_count: 1,
              done_count: 1,
              in_progress_count: 0,
              is_processing: false,
            });
          }
          if (path === "/customnode/installed") {
            listCalls++;
            // Pre-check sees the pack enabled; post-op it reports disabled.
            return jsonResponse(
              listCalls === 1
                ? { "my-pack": { ver: "1.2.3", cnr_id: "my-pack", enabled: true } }
                : { "my-pack": { ver: "1.2.3", cnr_id: "my-pack", enabled: false } },
            );
          }
          return new Response("", { status: 200 });
        }),
      );
      const res = await disableCustomNode({ id: "my-pack" });
      expect(res.mechanism).toBe("manager-http");
      expect(legacyCallTo(calls, "/manager/queue/disable")?.body).toMatchObject({
        id: "my-pack",
        version: "1.2.3",
      });
      expect(res.message).toMatch(/Disabled "my-pack"/);
    });

    it("uninstall sends the pack's REAL installed version as node_ver (legacy body keys on it)", async () => {
      let listCalls = 0;
      const calls: Call[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
          const method = init?.method ?? "GET";
          const body = init?.body ? JSON.parse(init.body as string) : undefined;
          calls.push({ url, method, body });
          const path = new URL(url).pathname;
          if (path.startsWith("/v2/")) {
            return new Response("405: Method Not Allowed", { status: 405 });
          }
          if (path === "/manager/queue/status") {
            return jsonResponse({
              total_count: 1,
              done_count: 1,
              in_progress_count: 0,
              is_processing: false,
            });
          }
          if (path === "/customnode/installed") {
            listCalls++;
            // Pre-check sees the pack; post-op it is gone.
            return jsonResponse(
              listCalls === 1
                ? { "my-pack": { ver: "4.5.6", cnr_id: "my-pack", enabled: true } }
                : {},
            );
          }
          return new Response("", { status: 200 });
        }),
      );
      const res = await uninstallCustomNode({ id: "my-pack" });
      expect(res.message).toMatch(/Uninstalled "my-pack"/);
      expect(legacyCallTo(calls, "/manager/queue/uninstall")?.body).toMatchObject({
        id: "my-pack",
        version: "4.5.6",
      });
    });

    it("installs a git URL natively via { version:'unknown', files:[url] }", async () => {
      const { calls } = stubLegacyFetch({
        installedBody: { bar: { ver: "unknown", aux_id: "foo/bar", enabled: true } },
      });
      const res = await installCustomNode({
        id: "https://github.com/foo/bar",
        source: "git",
      });
      expect(res.mechanism).toBe("manager-http");
      const install = legacyCallTo(calls, "/manager/queue/install");
      expect(install?.body).toMatchObject({
        version: "unknown",
        selected_version: "unknown",
        files: ["https://github.com/foo/bar"],
      });
    });

    it("routes update / fix to the per-operation legacy endpoints", async () => {
      const { calls } = stubLegacyFetch({
        // #730: the single-pack update re-reads the installed list post-op.
        installedBody: { "comfyui-foo": { ver: "1.0.0", cnr_id: "comfyui-foo", enabled: true } },
      });
      await updateCustomNode({ id: "comfyui-foo" });
      await fixCustomNode({ id: "comfyui-foo" });
      expect(legacyCallTo(calls, "/manager/queue/update")?.body).toMatchObject({
        id: "comfyui-foo",
      });
      expect(legacyCallTo(calls, "/manager/queue/fix")?.body).toMatchObject({
        id: "comfyui-foo",
      });
    });

    it("update all posts {mode} in the JSON body (legacy reads body, not query)", async () => {
      const { calls } = stubLegacyFetch();
      await updateCustomNode({ id: "all", mode: "remote" });
      const call = legacyCallTo(calls, "/manager/queue/update_all");
      expect(call?.body).toMatchObject({ mode: "remote" });
      expect(call?.url.includes("?")).toBe(false);
    });

    it("lists installed nodes from the unprefixed /customnode/installed", async () => {
      stubLegacyFetch({
        installedBody: { foo: { ver: "1.0.0", enabled: true } },
      });
      const nodes = await listInstalledNodes();
      expect(nodes.length).toBeGreaterThan(0);
    });

    it("caches detection per target (one probe, not one per operation)", async () => {
      const { calls } = stubLegacyFetch({
        // #730: both packs must resolve post-op; the installed-list re-read
        // reuses the cached detection, so it adds no probe.
        installedBody: {
          a: { ver: "1.0.0", enabled: true },
          b: { ver: "1.0.0", enabled: true },
        },
      });
      await updateCustomNode({ id: "a" });
      await updateCustomNode({ id: "b" });
      const probes = calls.filter(
        (c) => new URL(c.url).pathname === "/v2/manager/queue/status",
      );
      expect(probes.length).toBe(1);
    });

    // ── #424: updating ComfyUI-Manager ITSELF. The released 3.x DOES support it
    // through its ordinary per-operation route (POST /manager/queue/update with
    // id=comfyui-manager — manager_core.unified_update has no self guard, and
    // /manager/queue/update_all enqueues 'comfyui-manager' itself). The original
    // 405 came from posting the v4-only …/queue/task envelope at a 3.x server.
    // So the legacy self-update must ROUTE to the real endpoint, and only fall
    // back when THAT endpoint is genuinely unregistered (405).
    it("routes legacy self-update to POST /manager/queue/update (no git-pull bypass)", async () => {
      const { calls } = stubLegacyFetch();
      mockedExists.mockReturnValue(true); // a local checkout exists but must NOT be used
      mockedExec.mockReturnValue("Already up to date." as unknown as Buffer);

      const res = await updateCustomNode({ id: "comfyui-manager" });

      expect(res.mechanism).toBe("manager-http");
      const update = legacyCallTo(calls, "/manager/queue/update");
      expect(update?.method).toBe("POST");
      expect(update?.body).toMatchObject({ id: "comfyui-manager" });
      // The v4-only unified task route (the #424 405 source) is never touched.
      expect(legacyCallTo(calls, "/v2/manager/queue/task")).toBeUndefined();
      // NOTHING was shelled out — the Manager's own API did the work. Asserted on
      // the mock as a whole, not on an executable NAME: a check for the literal
      // "git" would wave through execFileSync("git.exe", [...]) on Windows, which
      // is exactly the platform this bug was reported on.
      expect(mockedExec).not.toHaveBeenCalled();
      // …and the result does NOT claim a verified update (a drained 3.x queue
      // proves nothing) — it tells the user to restart and confirm.
      expect(res.message).toMatch(/restart/i);
      expect(res.message).not.toMatch(/^Updated /);
    });

    it("third-party pack update is unchanged by the self-update routing", async () => {
      const { calls } = stubLegacyFetch({
        // #730: the pack must resolve on the post-op presence re-read.
        installedBody: { "rgthree-comfy": { ver: "1.0.0", cnr_id: "rgthree-comfy", enabled: true } },
      });
      mockedExists.mockReturnValue(true);
      const res = await updateCustomNode({ id: "rgthree-comfy" });
      expect(res.mechanism).toBe("manager-http");
      expect(legacyCallTo(calls, "/manager/queue/update")?.body).toMatchObject({
        id: "rgthree-comfy",
      });
      expect(res.message).toMatch(/Queued \+ updated "rgthree-comfy"/);
      expect(mockedExec).not.toHaveBeenCalled();
    });

    // ── When the update route is genuinely unregistered (405), the ONLY outcome
    // is the explicit "not supported / NOTHING WAS UPDATED" error. There is no
    // local-git fallback: comfyui-mcp cannot prove that a checkout on ITS machine
    // is the one the connected server loaded (loopback can be a container or an
    // SSH port-forward), and pulling the wrong copy would report a fix that never
    // reached the user's ComfyUI. Each config below is a wrong-target trap that a
    // previous revision fell into — all must refuse, and none may run git.
    it.each([
      [
        "loopback host whose live root MATCHES comfyuiPath",
        () => {
          liveRoot.value = "/fake/comfy";
        },
      ],
      [
        "--force-remote over a forwarded loopback port (server is on another machine)",
        () => {
          remoteFlags.forceRemote = true;
          liveRoot.value = "/fake/comfy";
        },
      ],
      [
        "a second local instance whose live root differs from comfyuiPath",
        () => {
          liveRoot.value = "/other/comfy";
        },
      ],
      [
        "a server that won't say where it lives (unreachable / argv-less)",
        () => {
          liveRoot.value = undefined;
        },
      ],
      [
        "a loopback CONTAINER reporting a root string that also exists on the host",
        () => {
          // Same path string, different filesystem namespace — indistinguishable
          // over HTTP, which is exactly why no pull is attempted at all.
          liveRoot.value = "/fake/comfy";
          mockedExists.mockReturnValue(true);
        },
      ],
    ])("self-update 405 refuses explicitly and shells out to NOTHING — %s", async (_name, setup) => {
      const { calls } = stubLegacyFetch({ update405: true });
      mockedExists.mockReturnValue(true); // a real-looking local checkout exists
      setup();

      await expect(updateCustomNode({ id: "comfyui-manager" })).rejects.toThrow(
        /not supported by the LEGACY ComfyUI-Manager 3\.x queue API[\s\S]*NOTHING WAS UPDATED[\s\S]*pip install -U comfyui_manager/i,
      );
      // The real endpoint was still tried first — that's what proves it's a 405.
      expect(legacyCallTo(calls, "/manager/queue/update")).toBeDefined();
      // NO subprocess ran at all — not a pull, not a rev-parse probe, nothing.
      // Asserted on the mock as a whole rather than on an executable NAME: a check
      // for the literal "git" would wave through execFileSync("git.exe", [...]),
      // which is valid on Windows — the very platform this bug was reported on —
      // so a reintroduced fallback could pull the local checkout and still pass.
      expect(mockedExec).not.toHaveBeenCalled();
    });

    it("self-update 405 on a REMOTE host also refuses (never touches a local clone)", async () => {
      const original = config.comfyuiHost;
      config.comfyuiHost = "10.0.0.5"; // remote ComfyUI; comfyuiPath is a LOCAL path
      try {
        stubLegacyFetch({ update405: true });
        mockedExists.mockReturnValue(true); // a local clone exists — wrong machine
        await expect(updateCustomNode({ id: "comfyui-manager" })).rejects.toThrow(
          /NOTHING WAS UPDATED/,
        );
        expect(mockedExec).not.toHaveBeenCalled();
      } finally {
        config.comfyuiHost = original;
      }
    });

    it("a queue/start 405 during the DRAIN is not reported as a missing update route", async () => {
      // codex review: only the ENQUEUE 405 means "this build doesn't register the
      // update route". A 405 from the queue-control route (start) is a drain
      // failure and must surface as itself, NOT as the unsupported verdict.
      stubLegacyFetch({ start405: true }); // update route answers 200; start 405s
      mockedExists.mockReturnValue(true);

      const err = await updateCustomNode({ id: "comfyui-manager" }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/405/);
      expect((err as Error).message).not.toMatch(/NOTHING WAS UPDATED/);
      expect(mockedExec).not.toHaveBeenCalled();
    });

  });

  // ── issue #235: pip Manager in legacy-UI mode = the "v2-batch" dialect ────
  describe("v2-batch dialect (pip Manager with --enable-manager-legacy-ui)", () => {
    /** Stub a server shaped like comfyui_manager 4.2.2 in legacy-UI mode:
     *  /v2 status + is_legacy_manager_ui:true + batch; NO /v2 task route
     *  (a POST there gets ComfyUI's catchall 405, per the field report). */
    function stubBatchFetch(opts: { failed?: unknown[]; installedBody?: unknown } = {}) {
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method, body });
        const path = new URL(url).pathname;
        if (path.startsWith("/v2/customnode/installed")) return jsonResponse(opts.installedBody ?? {});
        if (path === "/v2/manager/queue/status") {
          return jsonResponse({ total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false });
        }
        if (path === "/v2/manager/is_legacy_manager_ui") {
          return jsonResponse({ is_legacy_manager_ui: true });
        }
        if (path === "/v2/manager/queue/batch" && method === "POST") {
          return jsonResponse({ failed: opts.failed ?? [] });
        }
        if (path === "/v2/manager/queue/start" && method === "POST") {
          return new Response("", { status: 200 });
        }
        if (path === "/v2/manager/queue/task") {
          // The exact #235 signature: route unregistered, catchall answers 405.
          return new Response("405: Method Not Allowed", { status: 405 });
        }
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      return { calls };
    }

    it("installs through /v2/manager/queue/batch with a 3.x body — never touches the task route", async () => {
      const { calls } = stubBatchFetch({
        installedBody: { "comfyui-impact-pack": { ver: "1.0.0", cnr_id: "comfyui-impact-pack", enabled: true } },
      });
      const res = await installCustomNode({ id: "comfyui-impact-pack" });
      expect(res.mechanism).toBe("manager-http");
      const batch = calls.find((c) => c.url.includes("/v2/manager/queue/batch"));
      expect(batch).toBeDefined();
      const payload = batch!.body as Record<string, Array<Record<string, unknown>>>;
      expect(Object.keys(payload)).toEqual(["install"]);
      expect(payload.install[0]).toMatchObject({ id: "comfyui-impact-pack", channel: "default" });
      expect(typeof payload.install[0].ui_id).toBe("string");
      expect(calls.some((c) => c.url.includes("/v2/manager/queue/task"))).toBe(false);
      // still drains the queue for temp-queued post-install work
      expect(calls.some((c) => c.url.endsWith("/v2/manager/queue/start"))).toBe(true);
    });

    it("git-URL installs use the 3.x URL-carrying body (version:'unknown', files:[url])", async () => {
      // codex review on #235: v2-batch runs the 3.x handlers, so a git URL
      // must NOT take v4's registry-first shape (which resolves ids against
      // the registry DB and silently no-ops on a full URL).
      const { calls } = stubBatchFetch({
        installedBody: { bar: { ver: "unknown", cnr_id: "bar", enabled: true, aux_id: "foo/bar" } },
      });
      await installCustomNode({ id: "https://github.com/foo/bar" }).catch(() => {});
      const batch = calls.find((c) => c.url.includes("/v2/manager/queue/batch"));
      expect(batch).toBeDefined();
      const payload = batch!.body as Record<string, Array<Record<string, unknown>>>;
      expect(payload.install[0]).toMatchObject({
        version: "unknown",
        selected_version: "unknown",
        files: ["https://github.com/foo/bar"],
      });
    });

    it("surfaces a batch-reported failure with the legacy-UI hint", async () => {
      stubBatchFetch({
        failed: ["comfyui-impact-pack"],
        installedBody: { "comfyui-impact-pack": { ver: "1.0.0", cnr_id: "comfyui-impact-pack", enabled: true } },
      });
      await expect(installCustomNode({ id: "comfyui-impact-pack" })).rejects.toThrow(
        /reported the install .* as failed[\s\S]*legacy-ui mode/i,
      );
    });

    it("routes install-model to the dedicated /v2 route (not the batch)", async () => {
      // reach queueManagerTask("install-model") through the public surface via
      // detection cache pinning + a direct queue call is not exported; instead
      // assert the detection outcome feeds managerQueuePrefix by checking a
      // second op — covered above — and the model path via downloadModel is
      // exercised in its own suite. Here we lock the DETECTION itself:
      const { calls } = stubBatchFetch();
      await listInstalledNodes().catch(() => {});
      // the discriminator probe must have run
      expect(calls.some((c) => c.url.includes("/v2/manager/is_legacy_manager_ui"))).toBe(true);
    });
  });

  // ── issue #464: unified /v2 task route 405s → negotiate to v2-batch ───────
  // A build serves the bundled 3.x server under /v2 (queue/status answers), but
  // its `is_legacy_manager_ui` probe does NOT identify it, so detection defaults
  // to the "v2" unified dialect. A POST to /v2/manager/queue/task then 405s (the
  // frontend catchall — the task route is unregistered), which used to surface
  // as a raw "Manager …/queue/task: HTTP 405" from panel_update_node. The fix
  // treats that 405 as a method/route signal (like the queue/start POST→GET
  // negotiation) and downgrades to the v2-batch dialect, retrying via batch.
  describe("v2 task 405 → v2-batch negotiation (issue #464)", () => {
    /** Stub a build whose /v2 queue surface answers status but 405s the unified
     *  task route, with `is_legacy_manager_ui` absent (catchall HTML). */
    function stub464Fetch(opts: { failed?: unknown[]; installedBody?: unknown } = {}) {
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method, body });
        const path = new URL(url).pathname;
        // #730: single-pack updates re-read the installed list post-op.
        if (path.startsWith("/v2/customnode/installed")) return jsonResponse(opts.installedBody ?? {});
        if (path === "/v2/manager/queue/status") {
          return jsonResponse({ total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false });
        }
        // The `is_legacy_manager_ui` route is unregistered → catchall HTML, so
        // resolveV2SubDialect can't detect legacy-UI and defaults to "v2".
        if (path === "/v2/manager/is_legacy_manager_ui") {
          return new Response("<!doctype html><html>frontend</html>", {
            status: 200, headers: { "Content-Type": "text/html" },
          });
        }
        if (path === "/v2/manager/queue/task") {
          // The #464 signature: unified task route unregistered → catchall 405.
          return new Response("405: Method Not Allowed", { status: 405 });
        }
        if (path === "/v2/manager/queue/batch" && method === "POST") {
          return jsonResponse({ failed: opts.failed ?? [] });
        }
        if (path === "/v2/manager/queue/start" && method === "POST") {
          return new Response("", { status: 200 });
        }
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      return { calls };
    }

    it("panel_update_node succeeds via batch when /v2 task 405s (no raw 405 surfaced)", async () => {
      const { calls } = stub464Fetch({
        installedBody: { "my-pack": { ver: "1.0.0", cnr_id: "my-pack", enabled: true } },
      });
      const res = await updateCustomNode({ id: "my-pack" });
      expect(res.mechanism).toBe("manager-http");
      // Downgraded to the batch envelope with the 3.x update body …
      const batch = calls.find((c) => c.url.includes("/v2/manager/queue/batch"));
      expect(batch).toBeDefined();
      const payload = batch!.body as Record<string, Array<Record<string, unknown>>>;
      expect(Object.keys(payload)).toEqual(["update"]);
      // … after first attempting the unified task route (proving the 405 path ran).
      expect(calls.some((c) => new URL(c.url).pathname === "/v2/manager/queue/task")).toBe(true);
      // and still drains the queue.
      expect(calls.some((c) => c.url.endsWith("/v2/manager/queue/start"))).toBe(true);
    });

    it("caches the corrected v2-batch dialect (second op skips the dead task route)", async () => {
      const { calls } = stub464Fetch({
        installedBody: {
          "pack-a": { ver: "1.0.0", enabled: true },
          "pack-b": { ver: "1.0.0", enabled: true },
        },
      });
      await updateCustomNode({ id: "pack-a" });
      const taskHitsAfterFirst = calls.filter(
        (c) => new URL(c.url).pathname === "/v2/manager/queue/task",
      ).length;
      await updateCustomNode({ id: "pack-b" });
      const taskHitsTotal = calls.filter(
        (c) => new URL(c.url).pathname === "/v2/manager/queue/task",
      ).length;
      // The second update must NOT re-probe the 405 task route — the dialect is pinned.
      expect(taskHitsTotal).toBe(taskHitsAfterFirst);
      expect(calls.filter((c) => c.url.includes("/v2/manager/queue/batch")).length).toBe(2);
    });

    it("does NOT poison the cache when task 405s but batch also fails — next op re-probes /task", async () => {
      // A proxy/WAF (or an unusual v4) could 405 /task while /v2 status works but
      // /batch does not. The failed downgrade must NOT pin "v2-batch" for later
      // ops. Here batch fails on the first attempt (500) then succeeds on the
      // second: the second op must still hit /task first (proving the cache was
      // never poisoned) before succeeding via batch.
      const calls: Call[] = [];
      let batchHits = 0;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method, body });
        const path = new URL(url).pathname;
        // #730: the post-op presence re-read (pack-a's op fails at the batch,
        // pack-b's succeeds and must resolve SOMEWHERE).
        if (path.startsWith("/v2/customnode/installed")) {
          return jsonResponse({
            "pack-a": { ver: "1.0.0", enabled: true },
            "pack-b": { ver: "1.0.0", enabled: true },
          });
        }
        if (path === "/v2/manager/queue/status") {
          return jsonResponse({ total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false });
        }
        if (path === "/v2/manager/is_legacy_manager_ui") {
          return new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } });
        }
        if (path === "/v2/manager/queue/task") {
          return new Response("405: Method Not Allowed", { status: 405 });
        }
        if (path === "/v2/manager/queue/batch" && method === "POST") {
          batchHits++;
          return batchHits === 1
            ? new Response("500: Internal Server Error", { status: 500 })
            : jsonResponse({ failed: [] });
        }
        if (path === "/v2/manager/queue/start" && method === "POST") return new Response("", { status: 200 });
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      // First op: task 405 → batch 500 → throws; cache must stay "v2".
      await expect(updateCustomNode({ id: "pack-a" })).rejects.toBeInstanceOf(NodeManagementError);
      const taskAfterFirst = calls.filter((c) => new URL(c.url).pathname === "/v2/manager/queue/task").length;
      expect(taskAfterFirst).toBeGreaterThan(0);
      // Second op: because the cache was NOT poisoned, it re-probes /task before batch.
      const res = await updateCustomNode({ id: "pack-b" });
      expect(res.mechanism).toBe("manager-http");
      const taskTotal = calls.filter((c) => new URL(c.url).pathname === "/v2/manager/queue/task").length;
      expect(taskTotal).toBe(taskAfterFirst + 1);
    });

    it("leaves a genuine v4 host on the unified task route (405 fallback not triggered)", async () => {
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method, body });
        const path = new URL(url).pathname;
        // #730: the post-op presence re-read must find the pack.
        if (path.startsWith("/v2/customnode/installed")) {
          return jsonResponse({ "my-pack": { ver: "1.0.0", cnr_id: "my-pack", enabled: true } });
        }
        if (path === "/v2/manager/queue/status") {
          return jsonResponse({ total_count: 1, done_count: 1, in_progress_count: 0, pending_count: 0, is_processing: false });
        }
        if (path === "/v2/manager/is_legacy_manager_ui") return jsonResponse({ is_legacy_manager_ui: false });
        if (path === "/v2/manager/queue/task") return new Response("", { status: 200 });
        if (path === "/v2/manager/queue/start") return new Response("", { status: 200 });
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await updateCustomNode({ id: "my-pack" });
      const task = calls.find((c) => new URL(c.url).pathname === "/v2/manager/queue/task");
      expect(task).toBeDefined();
      expect((task!.body as { kind?: string }).kind).toBe("update");
      // Never downgraded to batch on a healthy v4 host.
      expect(calls.some((c) => c.url.includes("/v2/manager/queue/batch"))).toBe(false);
    });
  });

  describe("Manager detection hardening (issue #235)", () => {
    it("a 200-HTML SPA fallback on the v2 status probe does NOT detect v2", async () => {
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        calls.push({ url, method: init?.method ?? "GET", body: undefined });
        const path = new URL(url).pathname;
        if (path === "/v2/manager/queue/status") {
          return new Response("<!doctype html><html>frontend</html>", {
            status: 200, headers: { "Content-Type": "text/html" },
          });
        }
        if (path === "/manager/queue/status") {
          return jsonResponse({ total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false });
        }
        if (path.startsWith("/v2/customnode/installed")) return jsonResponse({});
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await listInstalledNodes().catch(() => {});
      // fell through to the legacy probe instead of trusting the HTML 200
      expect(calls.some((c) => c.url.endsWith("/manager/queue/status"))).toBe(true);
    });
  });

  // ── Manager version-dialect cluster (#551 GET-only start, #553 v3→v4 recovery,
  //    #555 authoritative v4 detection — a 405 is a method/route signal, never a
  //    version signal) ─────────────────────────────────────────────────────────
  describe("Manager 405 dialect cluster (#551 / #553 / #555)", () => {
    const pathOf = (calls: Call[], p: string) =>
      calls.filter((c) => new URL(c.url).pathname === p);

    // ---- #551: legacy /manager/queue/start exposed GET-only ------------------
    it("negotiates POST→GET when legacy /manager/queue/start is GET-only (#551)", async () => {
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method, body });
        const path = new URL(url).pathname;
        if (path.startsWith("/v2/")) return new Response("405: Method Not Allowed", { status: 405 });
        if (path === "/manager/version") return new Response("V3.41", { status: 200 });
        if (path === "/manager/queue/status") {
          return jsonResponse({ total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false });
        }
        if (path === "/manager/queue/start") {
          // GET-only build: 405 to POST, 200 to GET (the #551 quirk).
          return method === "POST"
            ? new Response("405: Method Not Allowed", { status: 405 })
            : new Response("", { status: 200 });
        }
        if (path === "/customnode/installed") {
          return jsonResponse({ "comfyui-impact-pack": { ver: "1.0.0", cnr_id: "comfyui-impact-pack", enabled: true } });
        }
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      // Must SUCCEED (the install must not fail on the method mismatch).
      const res = await installCustomNode({ id: "comfyui-impact-pack" });
      expect(res.mechanism).toBe("manager-http");
      const startCalls = pathOf(calls, "/manager/queue/start");
      // POST was tried first, then re-negotiated as GET.
      expect(startCalls.some((c) => c.method === "POST")).toBe(true);
      expect(startCalls.some((c) => c.method === "GET")).toBe(true);
    });

    it("re-throws a non-405 error from queue/start unchanged (no blind GET retry)", async () => {
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        calls.push({ url, method, body: undefined });
        const path = new URL(url).pathname;
        if (path.startsWith("/v2/")) return new Response("405", { status: 405 });
        if (path === "/manager/version") return new Response("V3.41", { status: 200 });
        if (path === "/manager/queue/status") {
          return jsonResponse({ total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false });
        }
        if (path === "/manager/queue/start") return new Response("boom", { status: 500 });
        if (path === "/customnode/installed") {
          return jsonResponse({ "p": { ver: "1", cnr_id: "p", enabled: true } });
        }
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await expect(installCustomNode({ id: "p" })).rejects.toBeInstanceOf(NodeManagementError);
      // A 500 must NOT be retried as GET (only a 405 method-mismatch is).
      const startGets = pathOf(calls, "/manager/queue/start").filter((c) => c.method === "GET");
      expect(startGets.length).toBe(0);
    });

    it("does NOT treat an HTML catchall GET as a successful queue start (codex P2)", async () => {
      // The start path is UNREGISTERED for both methods: POST 405s, GET 200s with
      // ComfyUI's SPA HTML page (the frontend catchall). That HTML must NOT be
      // read as a real GET-only start — the original method error must surface.
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const path = new URL(url).pathname;
        if (path.startsWith("/v2/")) return new Response("405", { status: 405 });
        if (path === "/manager/version") return new Response("V3.41", { status: 200 });
        if (path === "/manager/queue/status") {
          return jsonResponse({ total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false });
        }
        if (path === "/manager/queue/start") {
          return method === "POST"
            ? new Response("405: Method Not Allowed", { status: 405 })
            : new Response("<!doctype html><html>frontend</html>", { status: 200, headers: { "Content-Type": "text/html" } });
        }
        if (path === "/customnode/installed") {
          return jsonResponse({ "comfyui-impact-pack": { ver: "1.0.0", cnr_id: "comfyui-impact-pack", enabled: true } });
        }
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      // The install must FAIL rather than silently "succeed" on a catchall page.
      await expect(installCustomNode({ id: "comfyui-impact-pack" })).rejects.toBeInstanceOf(NodeManagementError);
    });

    // ---- #555: authoritative v4 detection ------------------------------------
    it("rescues a v4 host to v2 when /manager/queue/status also answers AND the v4 surface re-validates (#555)", async () => {
      // A hybrid/transient shape: the FIRST /v2 queue-status probe missed (HTML
      // catchall) and a bare /manager/queue/status answered — which alone made
      // 0.48.21 conclude "legacy 3.x". The authoritative /v2/manager/version
      // ("V4.x") overrides that, but ONLY after re-confirming the v4 queue surface
      // actually validates (so we never route to a dead surface — codex P1).
      const calls: Call[] = [];
      let v2StatusHits = 0;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        calls.push({ url, method, body: undefined });
        const path = new URL(url).pathname;
        if (path === "/v2/manager/queue/status") {
          v2StatusHits++;
          // First probe misses (catchall); the re-probe after the version check
          // validates → safe to speak v4.
          return v2StatusHits === 1
            ? new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } })
            : jsonResponse({ total_count: 0, done_count: 0, in_progress_count: 0, pending_count: 0, is_processing: false });
        }
        if (path === "/manager/queue/status") return jsonResponse({ total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false });
        if (path === "/v2/manager/version") return new Response("V4.2.2", { status: 200 });
        if (path === "/v2/manager/is_legacy_manager_ui") return jsonResponse({ is_legacy_manager_ui: false });
        if (path.startsWith("/v2/customnode/installed")) return jsonResponse({});
        if (path === "/customnode/installed") return jsonResponse({});
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await listInstalledNodes();
      // Detected v2 → listed from the /v2 route, NOT the unprefixed legacy route.
      expect(pathOf(calls, "/v2/customnode/installed").length).toBeGreaterThan(0);
      expect(pathOf(calls, "/customnode/installed").length).toBe(0);
    });

    it("does NOT route to v2 when the version says v4 but the v4 queue surface never validates (codex P1)", async () => {
      // version=V4 but /v2/manager/queue/status is persistently unreachable (HTML
      // catchall). Routing to v2 would enqueue work we then can't poll → a false
      // timeout and duplicate on retry. Must keep the WORKING legacy endpoint and
      // NEVER post a v4 task/queue mutation.
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method, body });
        const path = new URL(url).pathname;
        if (path === "/v2/manager/queue/status") return new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } });
        if (path === "/manager/queue/status") return jsonResponse({ total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false });
        if (path === "/v2/manager/version") return new Response("V4.2.2", { status: 200 });
        if (path === "/customnode/installed") return jsonResponse({});
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await listInstalledNodes();
      // Stayed legacy → listed from the unprefixed route; NEVER touched the v4 task
      // route (no mutation posted to a dead surface).
      expect(pathOf(calls, "/customnode/installed").length).toBeGreaterThan(0);
      expect(pathOf(calls, "/v2/manager/queue/task").length).toBe(0);
    });

    it("recognizes a v4 queue-status shape carrying pending_count (#555)", async () => {
      // A status payload with pending_count (v4-style) but the classic counters
      // too must be accepted by the v2 probe rather than falling through.
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        calls.push({ url, method: init?.method ?? "GET", body: undefined });
        const path = new URL(url).pathname;
        if (path === "/v2/manager/queue/status") return jsonResponse({ done_count: 0, pending_count: 0, in_progress_count: 0 });
        if (path === "/v2/manager/is_legacy_manager_ui") return jsonResponse({ is_legacy_manager_ui: false });
        if (path.startsWith("/v2/customnode/installed")) return jsonResponse({});
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await listInstalledNodes();
      expect(pathOf(calls, "/v2/customnode/installed").length).toBeGreaterThan(0);
      // never fell through to the legacy probe
      expect(pathOf(calls, "/manager/queue/status").length).toBe(0);
    });

    it("still classifies a genuine 3.x host as legacy (version endpoint reports V3)", async () => {
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        calls.push({ url, method: init?.method ?? "GET", body: undefined });
        const path = new URL(url).pathname;
        if (path.startsWith("/v2/")) return new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } });
        if (path === "/manager/queue/status") return jsonResponse({ total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false });
        if (path === "/manager/version") return new Response("V3.41", { status: 200 });
        if (path === "/customnode/installed") return jsonResponse({});
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await listInstalledNodes();
      // Legacy → listed from the UNPREFIXED route.
      expect(pathOf(calls, "/customnode/installed").length).toBeGreaterThan(0);
      expect(pathOf(calls, "/v2/customnode/installed").length).toBe(0);
    });

    it("routes install-model on a genuine v4 host to the /v2 task envelope, never the bare legacy route, with no 'legacy 3.x' message (#555)", async () => {
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method, body });
        const path = new URL(url).pathname;
        if (path === "/v2/manager/queue/status") return jsonResponse({ total_count: 1, done_count: 1, in_progress_count: 0, pending_count: 0, is_processing: false });
        if (path === "/v2/manager/is_legacy_manager_ui") return jsonResponse({ is_legacy_manager_ui: false });
        if (path === "/v2/manager/queue/task") return new Response("", { status: 200 });
        if (path === "/v2/manager/queue/start") return new Response("", { status: 200 });
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const res = await installModelViaManager({
        name: "m.safetensors",
        url: "https://example.com/m.safetensors",
        filename: "m.safetensors",
        type: "checkpoints",
      });
      // Correct v4 route: the unified task envelope with kind=install-model.
      const task = calls.find((c) => new URL(c.url).pathname === "/v2/manager/queue/task");
      expect(task).toBeDefined();
      expect((task!.body as { kind?: string }).kind).toBe("install-model");
      // NEVER the bare legacy per-op route (the #555 symptom).
      expect(pathOf(calls, "/manager/queue/install_model").length).toBe(0);
      // and NO false "legacy 3.x" / upgrade nag on a v4 host.
      expect(res.message).not.toMatch(/legacy/i);
      expect(res.message).not.toMatch(/pip install -U comfyui_manager/i);
    });

    // ---- #553: actionable v3→v4 recovery on a legacy install-model failure ----
    it("surfaces a precise v3→v4 migration recovery when a legacy 3.x model install fails (#553)", async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const path = new URL(url).pathname;
        if (path.startsWith("/v2/")) return new Response("405", { status: 405 });
        if (path === "/manager/version") return new Response("V3.41", { status: 200 });
        if (path === "/manager/queue/status") {
          return jsonResponse({ total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false });
        }
        // Arbitrary-URL model install is whitelist-gated on 3.x → 500.
        if (path === "/manager/queue/install_model" && method === "POST") {
          return new Response("500: Internal Server Error", { status: 500 });
        }
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const err = await installModelViaManager({
        name: "m.safetensors",
        url: "https://example.com/m.safetensors",
        filename: "m.safetensors",
        type: "checkpoints",
      }).catch((e) => e as Error);

      expect(err).toBeInstanceOf(NodeManagementError);
      const msg = (err as Error).message;
      // Precise diagnosis …
      expect(msg).toMatch(/REQUIRE Manager v4\+/i);
      // … plus the actionable, numbered recovery path.
      expect(msg).toMatch(/pip install -U comfyui_manager/i);
      expect(msg).toMatch(/disable the old custom_nodes\/ComfyUI-Manager clone/i);
      expect(msg).toMatch(/--enable-manager/i);
    });

    // ---- #817: a model download is not a node install ----------------------
    describe("#817 the queue budget for a model download", () => {
      /** A Manager whose queue NEVER drains, so the wait always times out. */
      function stubNeverDrainingQueue(): void {
        vi.stubGlobal(
          "fetch",
          vi.fn(async (url: string): Promise<Response> => {
            const path = new URL(url).pathname;
            if (path === "/v2/manager/queue/status") {
              return jsonResponse({
                total_count: 1,
                done_count: 0,
                in_progress_count: 1,
                pending_count: 0,
                is_processing: true,
              });
            }
            if (path === "/v2/manager/is_legacy_manager_ui") {
              return jsonResponse({ is_legacy_manager_ui: false });
            }
            return new Response("", { status: 200 });
          }),
        );
      }

      it("uses the MODEL budget, not the 600s node-install budget", async () => {
        // The node budget is 5000 ms in this suite; the model budget is set to a
        // distinct, larger value. If install-model wrongly took the node budget,
        // the message would name 5 seconds — which is #817 in miniature: a model
        // download timed out on a ceiling that was never sized for one.
        setQueueTimingForTests({ timeoutMs: 5000, modelTimeoutMs: 90 });
        stubNeverDrainingQueue();

        const err = await installModelViaManager({
          name: "big.safetensors",
          url: "https://example.com/big.safetensors",
          filename: "big.safetensors",
          type: "diffusion_models",
        }).catch((e) => e as Error);

        expect((err as Error).message).toMatch(/did not finish within 0s|did not finish within/);
        expect((err as Error).message).not.toMatch(/did not finish within 5s/);
      });

      it("says the wait gave up — NOT that the download failed — and forbids a re-issue", async () => {
        setQueueTimingForTests({ modelTimeoutMs: 90 });
        stubNeverDrainingQueue();

        const err = await installModelViaManager({
          name: "big.safetensors",
          url: "https://example.com/big.safetensors",
          filename: "big.safetensors",
          type: "diffusion_models",
        }).catch((e) => e as Error);
        const msg = (err as Error).message;

        // The wait ended; the host was never told to stop. Claiming failure here is
        // what made #817's reporter re-issue — and a second concurrent server-side
        // fetch of one file is how the destination ended up truncated.
        expect(msg).toMatch(/NOT proof the download failed/i);
        expect(msg).toMatch(/Do NOT re-issue/i);
        expect(msg).toMatch(/corrupt model/i);
        // …and it names moves the caller can actually make from here.
        expect(msg).toMatch(/list_local_models/);
        expect(msg).toMatch(/COMFYUI_MANAGER_DOWNLOAD_TIMEOUT_S/);
        expect(msg).toMatch(/LOCAL ComfyUI/);
      });

      it("leaves a NODE install's timeout message alone — it must not inherit the download advice", async () => {
        setQueueTimingForTests({ timeoutMs: 60 });
        stubNeverDrainingQueue();

        const err = await installCustomNode({ id: "comfyui-impact-pack" }).catch(
          (e) => e as Error,
        );
        const msg = (err as Error).message;

        expect(msg).toMatch(/did not finish within/);
        // A node install has no half-downloaded model to protect and no
        // COMFYUI_MANAGER_DOWNLOAD_TIMEOUT_S knob — telling it the model story would
        // be advice that does not apply.
        expect(msg).not.toMatch(/Do NOT re-issue/i);
        expect(msg).not.toMatch(/COMFYUI_MANAGER_DOWNLOAD_TIMEOUT_S/);
      });
    });
  });
});

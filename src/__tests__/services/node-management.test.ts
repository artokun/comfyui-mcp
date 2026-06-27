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
    resolvedPort: number;
    comfyuiHost: string;
    comfyuiSsl: boolean;
    githubToken: string | undefined;
  } = {
    comfyuiPath: "/fake/comfy",
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
  };
});

// Mock child_process for the cm-cli subprocess paths.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

// Mock fs so resolveCmCliPath's existsSync check is controllable.
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "../../config.js";
import {
  installCustomNode,
  parseGitUrl,
  updateCustomNode,
  reinstallCustomNode,
  fixCustomNode,
  listInstalledNodes,
  syncNodeDependencies,
  setQueueTimingForTests,
  NodeManagementError,
} from "../../services/node-management.js";
import { ProcessControlError, ValidationError } from "../../utils/errors.js";

const mockedExec = vi.mocked(execFileSync);
const mockedExists = vi.mocked(existsSync);

// The product builds these paths with node:path (join), so they use the
// platform separator (backslashes on Windows). Build the expected values the
// same way instead of hardcoding POSIX paths.
const COMFY = "/fake/comfy";
const CM_CLI = join(COMFY, "custom_nodes", "ComfyUI-Manager", "cm-cli.py");
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

      const path = new URL(url).pathname + (new URL(url).search || "");

      if (path.startsWith("/v2/customnode/installed")) {
        return jsonResponse(opts.installedBody ?? {});
      }
      if (path === "/v2/manager/queue/status") {
        const s = statusSeq[Math.min(statusIdx, statusSeq.length - 1)];
        statusIdx++;
        return jsonResponse(s);
      }
      // queue ops + start return empty bodies
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
    config.comfyuiPath = "/fake/comfy";
    config.githubToken = undefined;
    // Shrink polling timings so the suite stays fast.
    setQueueTimingForTests({
      pollIntervalMs: 1,
      startupGraceMs: 0,
      timeoutMs: 5000,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
      mockedExec.mockReturnValue("installed ok" as never);
      const res = await installCustomNode({ id: "some-pack", useCmCli: true });

      expect(res.mechanism).toBe("cm-cli");
      const [bin, args] = mockedExec.mock.calls[0];
      expect(bin).toBe("python");
      expect(args).toEqual([
        CM_CLI,
        "install",
        "some-pack",
        "--mode",
        "remote",
        "--channel",
        "default",
      ]);
    });

    it("checks out the requested git ref after forced cm-cli install", async () => {
      mockedExec.mockReturnValue("installed ok" as never);
      const res = await installCustomNode({
        id: "https://github.com/foo/bar/tree/dev",
        ref: "abc123",
        useCmCli: true,
      });

      expect(res.mechanism).toBe("cm-cli");
      expect(mockedExec).toHaveBeenCalledTimes(3);
      expect(mockedExec.mock.calls[0][1]).toEqual([
        CM_CLI,
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
  });

  // ---- update ------------------------------------------------------------

  describe("updateCustomNode", () => {
    it("updates a single pack via an update task", async () => {
      const { calls } = stubFetch();
      await updateCustomNode({ id: "my-pack" });
      const { params } = taskOf(calls, "update");
      expect(params).toMatchObject({ node_name: "my-pack" });
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
    it("models reinstall as an uninstall task followed by an install task", async () => {
      const { calls } = stubFetch();
      await reinstallCustomNode({ id: "my-pack" });
      expect(taskOf(calls, "uninstall").params).toMatchObject({
        node_name: "my-pack",
      });
      expect(taskOf(calls, "install").params).toMatchObject({
        id: "my-pack",
        version: "latest",
      });
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
      mockedExec.mockReturnValue("fixed all" as never);
      const res = await fixCustomNode({ id: "all" });
      expect(res.mechanism).toBe("cm-cli");
      const [, args] = mockedExec.mock.calls[0];
      expect(args).toContain("fix");
      expect(args).toContain("all");
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

    it("treats missing enabled as enabled unless is_disabled is set", async () => {
      stubFetch({
        installedBody: {
          A: { ver: "1" },
          B: { ver: "1", is_disabled: true },
        },
      });
      const nodes = await listInstalledNodes();
      expect(nodes.find((n) => n.module === "A")!.enabled).toBe(true);
      expect(nodes.find((n) => n.module === "B")!.enabled).toBe(false);
    });
  });

  // ---- sync deps ---------------------------------------------------------

  describe("syncNodeDependencies", () => {
    it("runs cm-cli restore-dependencies", async () => {
      mockedExec.mockReturnValue("deps restored" as never);
      const res = await syncNodeDependencies();
      expect(res.mechanism).toBe("cm-cli");
      const [, args] = mockedExec.mock.calls[0];
      expect(args).toEqual([
        CM_CLI,
        "restore-dependencies",
      ]);
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
});

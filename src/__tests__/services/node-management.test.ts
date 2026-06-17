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
    getComfyUIApiHost: () => `${config.comfyuiHost}:${config.resolvedPort}`,
    getComfyUIProtocol: () => (config.comfyuiSsl ? "https" : "http"),
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

import { join } from "node:path";
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
const BAR_DIR = join(COMFY, "custom_nodes", "bar");

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

      if (path.startsWith("/customnode/installed")) {
        return jsonResponse(opts.installedBody ?? {});
      }
      if (path === "/manager/queue/status") {
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

    it("installs a registry id via the Manager queue API with latest version", async () => {
      const { calls } = stubFetch();
      const res = await installCustomNode({ id: "comfyui-impact-pack" });

      expect(res.mechanism).toBe("manager-http");
      const installCall = calls.find((c) =>
        c.url.includes("/manager/queue/install"),
      );
      expect(installCall).toBeDefined();
      expect(installCall!.method).toBe("POST");
      expect(installCall!.body).toMatchObject({
        id: "comfyui-impact-pack",
        version: "latest",
        selected_version: "latest",
      });
      // Must kick the queue worker.
      expect(calls.some((c) => c.url.endsWith("/manager/queue/start"))).toBe(
        true,
      );
    });

    it("auto-detects a git URL and sends version:'unknown' with the repo in files", async () => {
      const { calls } = stubFetch();
      await installCustomNode({ id: "https://github.com/foo/bar" });

      const installCall = calls.find((c) =>
        c.url.includes("/manager/queue/install"),
      );
      // version:"unknown" is required — it routes the Manager handler into the
      // git branch (and avoids the bracket-access KeyError on json_data['version']).
      expect(installCall!.body).toMatchObject({
        version: "unknown",
        files: ["https://github.com/foo/bar"],
        pip: [],
      });
    });

    it("pins a git URL ref parsed from the URL in the Manager install body", async () => {
      const { calls } = stubFetch();
      await installCustomNode({ id: "https://github.com/foo/bar/tree/dev" });

      const installCall = calls.find((c) =>
        c.url.includes("/manager/queue/install"),
      );
      expect(installCall!.body).toMatchObject({
        version: "dev",
        files: ["https://github.com/foo/bar"],
        pip: [],
      });
    });

    it("prefers explicit ref over parsed URL ref and version for git installs", async () => {
      const { calls } = stubFetch();
      await installCustomNode({
        id: "https://github.com/foo/bar/tree/dev",
        version: "v1",
        ref: "abc123",
      });

      const installCall = calls.find((c) =>
        c.url.includes("/manager/queue/install"),
      );
      expect(installCall!.body).toMatchObject({
        version: "abc123",
        files: ["https://github.com/foo/bar"],
      });
    });

    it("allows a valid explicit slash-separated git ref", async () => {
      const { calls } = stubFetch();
      await installCustomNode({
        id: "https://github.com/foo/bar",
        ref: "feature/dev",
      });

      const installCall = calls.find((c) =>
        c.url.includes("/manager/queue/install"),
      );
      expect(installCall!.body).toMatchObject({
        version: "feature/dev",
        files: ["https://github.com/foo/bar"],
      });
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
      const { calls } = stubFetch();
      await installCustomNode({
        id: "https://github.com/foo/bar",
        version: "release",
      });

      const installCall = calls.find((c) =>
        c.url.includes("/manager/queue/install"),
      );
      expect(installCall!.body).toMatchObject({
        version: "release",
        files: ["https://github.com/foo/bar"],
      });
    });

    it("honors an explicit version", async () => {
      const { calls } = stubFetch();
      await installCustomNode({ id: "some-pack", version: "1.2.3" });
      const installCall = calls.find((c) =>
        c.url.includes("/manager/queue/install"),
      );
      expect(installCall!.body).toMatchObject({
        version: "1.2.3",
        selected_version: "1.2.3",
      });
    });

    it("ignores ref for registry installs", async () => {
      const { calls } = stubFetch();
      await installCustomNode({ id: "some-pack", ref: "dev" });
      const installCall = calls.find((c) =>
        c.url.includes("/manager/queue/install"),
      );
      expect(installCall!.body).toMatchObject({
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
    it("updates a single pack via /manager/queue/update", async () => {
      const { calls } = stubFetch();
      await updateCustomNode({ id: "my-pack" });
      const c = calls.find((x) => x.url.includes("/manager/queue/update"));
      expect(c!.url).toContain("/manager/queue/update");
      expect(c!.body).toMatchObject({ id: "my-pack", version: "latest" });
    });

    it("routes 'all' to /manager/queue/update_all", async () => {
      const { calls } = stubFetch();
      await updateCustomNode({ id: "all", mode: "local" });
      const c = calls.find((x) => x.url.includes("/manager/queue/update_all"));
      expect(c).toBeDefined();
      expect(c!.body).toMatchObject({ mode: "local" });
    });
  });

  // ---- reinstall ---------------------------------------------------------

  describe("reinstallCustomNode", () => {
    it("posts to /manager/queue/reinstall", async () => {
      const { calls } = stubFetch();
      await reinstallCustomNode({ id: "my-pack" });
      const c = calls.find((x) => x.url.includes("/manager/queue/reinstall"));
      expect(c!.body).toMatchObject({ id: "my-pack", version: "latest" });
    });
  });

  // ---- fix ---------------------------------------------------------------

  describe("fixCustomNode", () => {
    it("posts a single pack to /manager/queue/fix over HTTP", async () => {
      const { calls } = stubFetch();
      const res = await fixCustomNode({ id: "my-pack" });
      expect(res.mechanism).toBe("manager-http");
      const c = calls.find((x) => x.url.includes("/manager/queue/fix"));
      expect(c!.body).toMatchObject({ id: "my-pack" });
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

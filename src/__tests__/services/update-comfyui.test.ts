import { describe, expect, it, beforeEach, vi, type Mock } from "vitest";

// --- Mocks --------------------------------------------------------------

// Mutable config the service reads via property access.
// Created with vi.hoisted so it exists before the hoisted vi.mock factory runs.
const mockConfig = vi.hoisted(() => ({
  comfyuiPath: "/fake/ComfyUI" as string | undefined,
}));

vi.mock("../../config.js", () => ({
  config: mockConfig,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  updateComfyUICore,
  updateAllCustomNodes,
} from "../../services/update-comfyui.js";

const mockedExec = execFileSync as unknown as Mock;
const mockedExists = existsSync as unknown as Mock;

function mockFetchOnce(responses: Array<{ ok: boolean; status: number; body: unknown }>) {
  let i = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.ok,
      status: r.status,
      text: async () =>
        typeof r.body === "string" ? r.body : JSON.stringify(r.body),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mockConfig.comfyuiPath = "/fake/ComfyUI";
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

      // First call is git pull in the comfyui path.
      const gitCall = mockedExec.mock.calls.find((c) => c[0] === "git");
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
    // uv must be pinned to the workspace venv via --python (no venv exists in
    // this mock, so it resolves to the PATH python fallback).
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

  it("throws a clear error when comfyuiPath is undefined (remote mode)", async () => {
    mockConfig.comfyuiPath = undefined;
    await expect(updateComfyUICore()).rejects.toThrow(/no local install path/i);
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
});

// --- updateAllCustomNodes ----------------------------------------------

describe("updateAllCustomNodes", () => {
  it("POSTs update_all then starts the queue", async () => {
    const fetchFn = mockFetchOnce([
      { ok: true, status: 200, body: { result: "queued" } },
      { ok: true, status: 200, body: { started: true } },
    ]);

    const r = await updateAllCustomNodes();
    expect(r.updated).toBe(true);
    expect(r.endpoint).toBe("/manager/queue/update_all");
    expect(r.queue_started).toBe(true);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [updateUrl, updateInit] = fetchFn.mock.calls[0];
    expect(updateUrl).toBe("http://127.0.0.1:8188/manager/queue/update_all");
    expect(updateInit.method).toBe("POST");
    expect(JSON.parse(updateInit.body)).toEqual({ mode: "default" });

    const [startUrl, startInit] = fetchFn.mock.calls[1];
    expect(startUrl).toBe("http://127.0.0.1:8188/manager/queue/start");
    expect(startInit.method).toBe("POST");
  });

  it("throws when Manager returns a non-OK status for update_all", async () => {
    mockFetchOnce([{ ok: false, status: 404, body: "not found" }]);
    await expect(updateAllCustomNodes()).rejects.toThrow(/returned 404/);
  });

  it("still succeeds (queue_started=false) if starting the queue fails", async () => {
    let call = 0;
    const fn = vi.fn(async () => {
      call++;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ result: "queued" }),
        } as unknown as Response;
      }
      throw new Error("connection reset");
    });
    vi.stubGlobal("fetch", fn);

    const r = await updateAllCustomNodes();
    expect(r.updated).toBe(true);
    expect(r.queue_started).toBe(false);
  });

  it("throws a clear error when ComfyUI-Manager is unreachable", async () => {
    const fn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fn);
    await expect(updateAllCustomNodes()).rejects.toThrow(/Failed to reach ComfyUI-Manager/);
  });
});

// --- update_all semantics: custom nodes only (never core) ---------------

describe("update_all is custom-nodes-only", () => {
  it("runs no git/pip core-update commands (mirrors comfy-cli `update all`)", async () => {
    mockFetchOnce([
      { ok: true, status: 200, body: { result: "queued" } },
      { ok: true, status: 200, body: { started: true } },
    ]);
    await updateAllCustomNodes();
    // update_all touches ONLY the ComfyUI-Manager HTTP API — it must never
    // git pull / pip install ComfyUI core.
    expect(mockedExec).not.toHaveBeenCalled();
  });
});

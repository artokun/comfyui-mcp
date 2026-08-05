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
  resolvedPort: 8188,
  comfyuiHost: "127.0.0.1",
  comfyuiSsl: false,
  githubToken: undefined as string | undefined,
}));

vi.mock("../../config.js", () => ({
  config: mockConfig,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
  // node-management (the update_all dialect path, #656) transitively imports
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
  // fs because update_all now takes the panel mutation lock (panel-pin-guard),
  // which is a real file — a partial mock left its mkdir/open/write undefined
  // and every update_all failed closed.
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

vi.mock("../../services/workspace-env.js", () => ({
  resolveInstallInterpreter: mockResolveInstallInterpreter,
}));

import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  updateComfyUICore,
  updateAllCustomNodes,
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
 *                old hardcoded-legacy update_all hit).
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

  it("on a v2-batch host (pip Manager in legacy-UI mode): also routes at the /v2 update_all route", async () => {
    const calls = stubManager("v2-batch");

    const r = await updateAllCustomNodes();
    expect(r.endpoint).toBe("/v2/manager/queue/update_all");
    expect(countOf(calls, "/manager/queue/update_all")).toBe(0);
    expect(countOf(calls, "/v2/manager/queue/update_all")).toBe(1);
    expect(countOf(calls, "/v2/manager/queue/start")).toBe(1);
  });

  it("throws when Manager rejects update_all — and does NOT re-send the mutation", async () => {
    // A 404 is a route-level rejection: the dialect self-heal re-probes, finds
    // the dialect UNCHANGED (still legacy), and surfaces the original failure
    // instead of retrying — update_all must never execute twice (#656 caution).
    const calls = stubManager("legacy", { updateAllStatus: 404 });
    await expect(updateAllCustomNodes()).rejects.toThrow(/ComfyUI-Manager API 404/);
    expect(countOf(calls, "/manager/queue/update_all")).toBe(1);
    // The queue was never started, so no half-run operation is left behind.
    expect(countOf(calls, "/manager/queue/start")).toBe(0);
  });

  it("refuses before contacting Manager when the out-of-band pin-warning marker cannot persist", async () => {
    // A marker written after queueing can fail, then a later pin would be
    // reported as protective even though update_all can still land. Make its
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

// --- update_all semantics: custom nodes only (never core) ---------------

describe("update_all is custom-nodes-only", () => {
  it("runs no git/pip core-update commands (mirrors comfy-cli `update all`)", async () => {
    stubManager("legacy");
    await updateAllCustomNodes();
    // update_all touches ONLY the ComfyUI-Manager HTTP API — it must never
    // git pull / pip install ComfyUI core.
    expect(mockedExec).not.toHaveBeenCalled();
  });
});

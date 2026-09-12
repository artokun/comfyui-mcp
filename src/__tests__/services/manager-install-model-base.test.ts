// #2922 — the legacy Manager UI's whitelist checker reads item['base']
// unconditionally, so a queued install_model task that omits `base` 500s with
// `KeyError: 'base'` before the download is attempted. installModelViaManager
// must therefore preserve a provided `base` hint in the dispatched task params,
// while never sending the key at all when the hint is absent/blank (Manager
// validates keys it receives, so `base: undefined` must not reach it).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Kept mutable to model the runtime target the panel applies. vi.hoisted makes
// it available to the mock factory.
const target = vi.hoisted(() => ({ base: "http://127.0.0.1:8188", generation: 0 }));

vi.mock("../../config.js", () => {
  const config = {
    comfyuiPath: "/fake/comfy",
    resolvedPort: 8188,
    comfyuiHost: "127.0.0.1",
    comfyuiSsl: false,
    githubToken: undefined as string | undefined,
  };
  return {
    config,
    getComfyUIBaseUrl: () => target.base,
    getComfyuiTargetGeneration: () => target.generation,
    getComfyUIAuthHeaders: () => ({}),
    isLoopbackHost: (host?: string) => host === "127.0.0.1" || host === "localhost",
    isRemoteMode: () => false,
  };
});

// node-management pulls in comfy-cli → workspace-env, which calls
// promisify(execFile) at module load; keep the subprocess surface inert.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "{}", stderr: "" })),
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(() => true),
}));

// The panel mutation lock is a FILE (panel-pin-guard). Point it at a temp path
// so the suite never touches ~/.comfyui-mcp.
process.env.COMFYUI_MCP_PANEL_LOCK = join(
  tmpdir(),
  `cmcp-lock-installmodelbase-${process.pid}.lock`,
);
process.env.COMFYUI_MCP_PANEL_PIN = "off";

const {
  installModelViaManager,
  setQueueTimingForTests,
  resetManagerApiCacheForTests,
} = await import("../../services/node-management.js");

const BASE = "http://127.0.0.1:8188";

interface Call {
  url: string;
  path: string;
  method: string;
  body: unknown;
}

const DRAINED = { total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false };

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Minimal v4 Manager: unified task route answers, the queue drains
 * immediately, and history reports no completed task for our ui_id.
 */
function stubV4Manager(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      const parsed = new URL(url);
      calls.push({ url, path: parsed.pathname, method, body });
      if (parsed.pathname === "/v2/manager/queue/status") return jsonResponse(DRAINED);
      if (parsed.pathname === "/v2/manager/queue/start") return new Response("", { status: 200 });
      if (parsed.pathname === "/v2/manager/is_legacy_manager_ui") {
        return jsonResponse({ is_legacy_manager_ui: false });
      }
      if (parsed.pathname === "/v2/manager/queue/task") return jsonResponse({ accepted: true });
      if (parsed.pathname === "/v2/manager/queue/history") return jsonResponse({ history: {} });
      return new Response("", { status: 200 });
    }),
  );
  return calls;
}

function taskParamsOf(calls: Call[]): Record<string, unknown> {
  const enqueue = calls.find((c) => c.path === "/v2/manager/queue/task" && c.method === "POST");
  expect(enqueue).toBeDefined();
  const body = enqueue!.body as { kind: string; params: Record<string, unknown> };
  expect(body.kind).toBe("install-model");
  return body.params;
}

describe("installModelViaManager preserves the Manager model base hint (#2922)", () => {
  beforeEach(() => {
    target.base = BASE;
    target.generation = 0;
    resetManagerApiCacheForTests();
    setQueueTimingForTests({ pollIntervalMs: 1, startupGraceMs: 0, timeoutMs: 5000 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("includes base in the queued install-model task params when provided", async () => {
    const calls = stubV4Manager();

    await installModelViaManager({
      name: "sdxl-model.safetensors",
      url: "https://huggingface.co/foo/sdxl-model.safetensors",
      filename: "sdxl-model.safetensors",
      type: "checkpoints",
      base: "SDXL",
    });

    const params = taskParamsOf(calls);
    expect(params).toMatchObject({ base: "SDXL" });
  });

  it("omits the base key entirely when no hint is provided", async () => {
    const calls = stubV4Manager();

    await installModelViaManager({
      name: "model.safetensors",
      url: "https://huggingface.co/foo/model.safetensors",
      filename: "model.safetensors",
      type: "checkpoints",
    });

    const params = taskParamsOf(calls);
    expect(params).not.toHaveProperty("base");
  });
});

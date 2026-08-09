import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression for #444: after a custom-node install completes, the orchestrator's
// memoized /object_info snapshot must be invalidated so the NEXT validation
// (create_workflow (action:"validate") / get_history (action:"diagnose"))
// recomputes `missing_node_types` against the
// live registry instead of serving the pre-install snapshot that still lists the
// just-installed type as missing. This drives the REAL installCustomNode +
// validateWorkflow code paths (only the network boundaries are stubbed).

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>(
    "../../config.js",
  );
  return {
    ...actual,
    isCloudMode: () => false,
    isRemoteMode: () => false,
    getComfyUIApiHost: () => "127.0.0.1:8188",
    config: { ...actual.config, comfyuiPath: "/fake/comfy", githubToken: undefined },
  };
});

// Stub the SDK client so getObjectInfo()'s only data source (getNodeDefs) is
// controllable and countable, with no network.
const getNodeDefs = vi.fn();
vi.mock("@stable-canvas/comfyui-client", () => ({
  Client: class {
    // #385 — call sites moved to `comfyApiFetch`, which reuses the library's
    // own routing (apiURL/apiHeaders) and its injected `fetch`, so it can read a
    // 4xx instead of having `fetchApi` throw it away. The double routes `fetch`
    // back through its own `fetchApi`, so every existing impl and spy in this
    // file keeps working and keeps asserting the same route.
    apiURL(p: string) {
      return p;
    }
    apiHeaders(init?: { headers?: unknown }) {
      return (init && init.headers) || {};
    }
    async fetch(u: string, init?: unknown) {
      return (this as unknown as { fetchApi: (u: string, i?: unknown) => unknown }).fetchApi(u, init);
    }
    getNodeDefs = getNodeDefs;
    close() {}
  },
}));

// Stub the comfy-cli subprocess so the useCmCli install path returns cleanly
// without spawning anything. The probe exports are stubbed too: installCustomNode
// checks CLI usability before choosing the subprocess path (#808), and this test
// exercises the subprocess path.
vi.mock("../../services/comfy-cli.js", () => ({
  runComfyCliSync: vi.fn(() => ({ stdout: "{}", stderr: "", status: 0 })),
  assertComfyCliOk: vi.fn(() => ({ data: {} })),
  resolveComfyCliExecutable: vi.fn(() => "/fake/comfy/.venv/bin/comfy"),
  getComfyCliVersion: vi.fn(() => "1.11.1"),
  isSupportedComfyCliVersion: vi.fn(() => true),
}));

const { installCustomNode } = await import("../../services/node-management.js");
const { validateWorkflow } = await import("../../services/workflow-validator.js");
const { resetObjectInfoCache } = await import("../../comfyui/client.js");

// A registry WITHOUT the custom node type (pre-install) and one WITH it (post-install).
const REGISTRY_WITHOUT = {
  KSampler: { input: { required: {} }, output: [] },
} as const;
const REGISTRY_WITH = {
  ...REGISTRY_WITHOUT,
  SmartImageCrop: { input: { required: {} }, output: ["IMAGE"] },
} as const;

// Minimal API-format graph that uses the not-yet-installed node type.
const GRAPH = { "1": { class_type: "SmartImageCrop", inputs: {} } } as const;

const missingNodeTypes = (result: Awaited<ReturnType<typeof validateWorkflow>>) =>
  result.issues
    .filter((i) => i.kind === "missing_node_type")
    .map((i) => i.node_type);

describe("#444 install invalidates the object_info cache", () => {
  beforeEach(() => {
    getNodeDefs.mockReset();
    resetObjectInfoCache();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("recomputes missing_node_types after installCustomNode succeeds", async () => {
    // Pre-install: registry lacks the type → it validates as missing (and caches).
    getNodeDefs.mockResolvedValue(REGISTRY_WITHOUT as never);
    const before = await validateWorkflow(GRAPH as never, { health: false });
    expect(missingNodeTypes(before)).toContain("SmartImageCrop");

    // The pack is now installed; the live registry knows the type.
    getNodeDefs.mockResolvedValue(REGISTRY_WITH as never);

    // A cache-serving read would STILL return REGISTRY_WITHOUT here; the install
    // must invalidate the snapshot so the next read refetches.
    await installCustomNode({ id: "comfyui-smart-image-crop", useCmCli: true });

    const after = await validateWorkflow(GRAPH as never, { health: false });
    expect(missingNodeTypes(after)).not.toContain("SmartImageCrop");
    // Proves the refetch actually happened (pre-install fetch + post-install refetch).
    expect(getNodeDefs).toHaveBeenCalledTimes(2);
  });
});

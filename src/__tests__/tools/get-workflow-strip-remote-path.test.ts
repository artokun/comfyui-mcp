// #2782 — get_workflow action:"strip" with an absolute server-side POSIX path
// against a REMOTE Linux ComfyUI ran that path through this MCP host's Win32
// filesystem. `/mydata/workcode/ComfyUI/models/workflows/example.json` became
// `C:\mydata\...` and ENOENT'd. The shipped reader must not call local
// readFile / path.resolve for a remote target, and must fetch a
// models/workflows (or userdata/workflows) tail from the connected server.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  liveWorkspace: vi.fn(),
  isRemoteMode: vi.fn(() => true),
  targetIsOnThisMachine: vi.fn(() => false),
  readFile: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (...args: unknown[]) => mocks.readFile(...args),
  };
});

vi.mock("../../comfyui/client.js", () => ({
  comfyApiFetch: (...args: unknown[]) => mocks.fetchApi(...args),
  getObjectInfo: (...args: unknown[]) => mocks.getObjectInfo(...args),
  backfillObjectInfo: (...args: unknown[]) => mocks.backfillObjectInfo(...args),
}));

vi.mock("../../services/workspace-env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/workspace-env.js")>();
  return {
    ...actual,
    resolveEffectiveComfyUIBaseLive: (...args: unknown[]) => mocks.liveWorkspace(...args),
  };
});

vi.mock("../../services/workflow-slicer.js", () => ({ sliceWorkflow: vi.fn() }));
vi.mock("../../services/graph-query.js", () => ({
  queryApiGraph: vi.fn(),
  LIMIT_CEILING: 200,
  MAX_CHARS_CEILING: 60000,
  MAX_CHARS_FLOOR: 500,
}));
vi.mock("../../services/userdata-library.js", () => ({ listWorkflowLibraryKeys: vi.fn() }));
vi.mock("../../services/workflow-sections.js", () => ({ detectSections: vi.fn() }));
vi.mock("../../services/hierarchical-mermaid.js", () => ({
  generateOverview: vi.fn(),
  generateSectionDetail: vi.fn(),
  listSections: vi.fn(),
  generateSummary: vi.fn(),
}));
vi.mock("../../services/mermaid-converter.js", () => ({ convertToMermaid: vi.fn() }));
vi.mock("../../services/workflow-health.js", () => ({ analyzeGraphHealth: vi.fn() }));
vi.mock("../../services/image-management.js", () => ({ extractWorkflowFromImage: vi.fn() }));
vi.mock("../../tools/prompt-director.js", () => ({ promptDirectorInspectAction: vi.fn() }));
vi.mock("../../tools/workflow-lock.js", () => ({
  lockWorkflowAction: vi.fn(),
  verifyWorkflowLockAction: vi.fn(),
}));
vi.mock("../../config.js", () => ({
  getComfyUIBaseUrl: () => "http://192.168.1.50:8188",
  isRemoteMode: () => mocks.isRemoteMode(),
  targetIsOnThisMachine: () => mocks.targetIsOnThisMachine(),
}));
vi.mock("../../services/frontend-virtual-types.js", () => ({
  frontendVirtualTypesFor: () => new Set<string>(),
}));

import {
  registerWorkflowLibraryTools,
  userdataKeyFromServerPath,
} from "../../tools/workflow-library.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function getHandler(): Handler {
  let handler: Handler | undefined;
  const server = {
    tool: (name: string, _description: string, _shape: unknown, candidate: Handler) => {
      if (name === "get_workflow") handler = candidate;
    },
  };
  registerWorkflowLibraryTools(server as never);
  if (!handler) throw new Error("get_workflow was not registered");
  return handler;
}

const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

const GRAPH = {
  "1": { class_type: "SaveImage", inputs: { filename_prefix: "from-remote" } },
};

const REMOTE_MODELS_WF =
  "/mydata/workcode/ComfyUI/models/workflows/example.json";

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.isRemoteMode.mockReturnValue(true);
  mocks.targetIsOnThisMachine.mockReturnValue(false);
  mocks.liveWorkspace.mockResolvedValue(undefined);
  mocks.getObjectInfo.mockResolvedValue({});
  mocks.backfillObjectInfo.mockImplementation(async (info: unknown) => info);
  mocks.readFile.mockRejectedValue(
    Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\\\mydata\\\\...'"), {
      code: "ENOENT",
    }),
  );
});

describe("userdataKeyFromServerPath", () => {
  it("maps a remote models/workflows path without Win32-resolving it", () => {
    expect(userdataKeyFromServerPath(REMOTE_MODELS_WF)).toBe("workflows/example.json");
  });

  it("maps userdata and dropped-workflows tails", () => {
    expect(
      userdataKeyFromServerPath("/opt/ComfyUI/user/default/workflows/lab/a.json"),
    ).toBe("workflows/lab/a.json");
    expect(userdataKeyFromServerPath("/opt/ComfyUI/user/default/lab/a.json")).toBe(
      "workflows/lab/a.json",
    );
  });

  it("refuses traversal", () => {
    expect(
      userdataKeyFromServerPath("/opt/ComfyUI/models/workflows/../example.json"),
    ).toBeUndefined();
  });
});

describe("#2782 get_workflow strip does not open a remote POSIX path locally", () => {
  it('action:"strip" fetches models/workflows via userdata and never readFile', async () => {
    mocks.fetchApi.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => GRAPH,
    });

    const res = await getHandler()({
      action: "strip",
      path: REMOTE_MODELS_WF,
      format: "raw",
    });

    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0]!.text)).toEqual(GRAPH);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.fetchApi).toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/example.json")}`,
    );
    expect(text(res)).not.toMatch(/C:\\mydata/i);
    expect(text(res)).not.toMatch(/ENOENT/);
  });

  it("a 200 whose body is not a workflow document is refused, not returned", async () => {
    // The userdata endpoint answering 200 with `null` (or an array, or a scalar)
    // used to be handed straight back as a workflow. The failure then surfaced
    // much later as an unreadable graph, naming the wrong thing.
    mocks.fetchApi.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => null,
    });

    const res = await getHandler()({
      action: "strip",
      path: REMOTE_MODELS_WF,
      format: "raw",
    });

    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not a workflow document/i);
    expect(text(res)).toMatch(/Nothing was loaded/i);
  });

  it("refuses an unmapped remote absolute path without a local Win32 ENOENT", async () => {
    const remote = "/mydata/workcode/ComfyUI/custom_nodes/expert.json";
    const res = await getHandler()({ action: "strip", path: remote, format: "raw" });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain(remote);
    expect(text(res)).toMatch(/not on that machine/i);
    expect(text(res)).not.toMatch(/C:\\mydata/i);
    expect(text(res)).not.toMatch(/ENOENT/);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });

  it("does not claim the remote file is missing when userdata 404s", async () => {
    mocks.fetchApi.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({}),
      text: async () => "Not Found",
    });

    const res = await getHandler()({
      action: "strip",
      path: REMOTE_MODELS_WF,
      format: "raw",
    });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain(REMOTE_MODELS_WF);
    expect(text(res)).toContain("example.json");
    expect(text(res)).toContain("(404)");
    expect(text(res)).not.toMatch(/C:\\mydata/i);
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("still reads from disk when the remote-classified target is this machine", async () => {
    mocks.targetIsOnThisMachine.mockReturnValue(true);
    mocks.readFile.mockResolvedValueOnce(JSON.stringify(GRAPH));

    const res = await getHandler()({
      action: "strip",
      path: "C:/wf/expert.json",
      format: "raw",
    });

    expect(res.isError).toBeUndefined();
    expect(mocks.readFile).toHaveBeenCalledWith("C:/wf/expert.json", "utf8");
    expect(mocks.fetchApi).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0]!.text)).toEqual(GRAPH);
  });
});

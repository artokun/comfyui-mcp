// #2506 — get_workflow action:"analyze" (and action:"get") sent every `filename`
// to `/api/userdata/workflows/<filename>`. An absolute path under the live
// ComfyUI workspace (the reporter's `D:\Programas\ComfyUI\data\_downloads\*.json`)
// is not a library key; ComfyUI answers 500 and nothing is read.
//
// The shipped resolver must read that file from disk when it sits inside the
// live workspace, and must NOT treat a path outside that workspace as a disk
// read. Library-relative names still go through userdata.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  liveWorkspace: vi.fn(),
  generateSummary: vi.fn(),
  detectSections: vi.fn(),
}));

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
vi.mock("../../services/workflow-sections.js", () => ({
  detectSections: (...args: unknown[]) => mocks.detectSections(...args),
}));
vi.mock("../../services/hierarchical-mermaid.js", () => ({
  generateOverview: vi.fn(),
  generateSectionDetail: vi.fn(),
  listSections: vi.fn(),
  generateSummary: (...args: unknown[]) => mocks.generateSummary(...args),
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
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  isRemoteMode: () => false,
  // Cloud is a THIRD mode: isRemoteMode() is false there, so workflow-library
  // asks isCloudMode() separately before treating the filesystem as local.
  isCloudMode: () => false,
  targetIsOnThisMachine: () => true,
}));
vi.mock("../../services/frontend-virtual-types.js", () => ({
  frontendVirtualTypesFor: () => new Set<string>(),
}));

import { registerWorkflowLibraryTools } from "../../tools/workflow-library.js";

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
  "1": { class_type: "SaveImage", inputs: { filename_prefix: "from-downloads" } },
};

function userdata500(): void {
  mocks.fetchApi.mockResolvedValue({
    ok: false,
    status: 500,
    statusText: "Internal Server Error",
    json: async () => ({}),
    text: async () => "Internal Server Error",
  });
}

let workspace = "";
let downloadsFile = "";
let outsideDir = "";

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  workspace = mkdtempSync(join(tmpdir(), "cmcp-2506-ws-"));
  outsideDir = mkdtempSync(join(tmpdir(), "cmcp-2506-out-"));
  const downloads = join(workspace, "data", "_downloads");
  mkdirSync(downloads, { recursive: true });
  downloadsFile = join(downloads, "clip.json");
  writeFileSync(downloadsFile, JSON.stringify(GRAPH));
  mocks.liveWorkspace.mockResolvedValue(workspace);
  mocks.getObjectInfo.mockResolvedValue({});
  mocks.backfillObjectInfo.mockImplementation(async (info: unknown) => info);
  mocks.detectSections.mockReturnValue({
    sections: new Map(),
    virtualEdges: [],
    nodeToSection: new Map(),
    getSetNodeIds: new Set(),
  });
  mocks.generateSummary.mockReturnValue("summary of workspace subfolder workflow");
  userdata500();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe("#2506 get_workflow reads a JSON under the live workspace", () => {
  it('action:"analyze" reads an absolute path in data/_downloads instead of userdata 500', async () => {
    const res = await getHandler()({ action: "analyze", filename: downloadsFile, view: "summary" });

    expect(res.isError).toBeUndefined();
    expect(text(res)).not.toMatch(/Could NOT read/);
    expect(text(res)).not.toMatch(/nothing was read/);
    expect(text(res)).toContain("summary of workspace subfolder workflow");
    expect(mocks.generateSummary).toHaveBeenCalled();
    expect(mocks.generateSummary.mock.calls[0]?.[0]).toEqual(GRAPH);
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });

  it('action:"get" returns the disk JSON for the same workspace-subfolder path', async () => {
    const res = await getHandler()({ action: "get", filename: downloadsFile, format: "api" });

    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual(GRAPH);
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });

  it("a library-relative name still uses the userdata library, not a disk guess", async () => {
    mocks.fetchApi.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => GRAPH,
    });
    const res = await getHandler()({ action: "get", filename: "IMAGE/portrait.json", format: "api" });

    expect(res.isError).toBeUndefined();
    expect(mocks.fetchApi).toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/IMAGE/portrait.json")}`,
    );
    expect(JSON.parse(res.content[0].text)).toEqual(GRAPH);
  });

  it("an absolute path OUTSIDE the live workspace is not read from disk", async () => {
    const outsider = join(outsideDir, "secret.json");
    writeFileSync(outsider, JSON.stringify({ "9": { class_type: "ShouldNotLoad", inputs: {} } }));

    const res = await getHandler()({ action: "analyze", filename: outsider, view: "summary" });

    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Could NOT read/);
    expect(text(res)).toMatch(/nothing was read/);
    expect(mocks.generateSummary).not.toHaveBeenCalled();
    expect(mocks.fetchApi).toHaveBeenCalled();
  });

  it("a missing file that IS under the live workspace is a not-found, not a userdata 500", async () => {
    const missing = join(workspace, "data", "_downloads", "gone.json");
    const res = await getHandler()({ action: "analyze", filename: missing, view: "summary" });

    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Workflow not found/);
    expect(text(res)).not.toMatch(/the server answered 500/);
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });
});

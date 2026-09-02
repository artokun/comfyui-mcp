// #2528 — get_workflow action:"strip" ENOENT'd a valid absolute Windows
// workflow path by dropping the `workflows` segment from the live ComfyUI
// userdata tree:
//
//   real:      {workspace}/user/default/workflows/artokun_lab/{emdash}.json
//   attempted: {workspace}/user/default/artokun_lab/{emdash}.json
//
// The filename also contains an em-dash (U+2014). A resolver that mangles it
// to ASCII `-` or `?` misses the same file. The shipped reader must resolve
// under userdata/workflows (never join the library-relative tail onto
// user/default) and must pass the filename through byte-for-byte.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  liveWorkspace: vi.fn(),
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
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
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

/** Em-dash U+2014 — the character in the reporter's filename, not ASCII `-`. */
const EMDASH = "\u2014";
const WORKFLOW_FILE = `FRSS27-2807 ${EMDASH} ProductView Face006 Validated.json`;

const GRAPH = {
  "1": { class_type: "SaveImage", inputs: { filename_prefix: "from-userdata-workflows" } },
};

let workspace = "";
let realFile = "";
let droppedFile = "";

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  workspace = mkdtempSync(join(tmpdir(), "cmcp-2528-ws-"));
  const workflowsDir = join(workspace, "user", "default", "workflows", "artokun_lab");
  mkdirSync(workflowsDir, { recursive: true });
  realFile = join(workflowsDir, WORKFLOW_FILE);
  droppedFile = join(workspace, "user", "default", "artokun_lab", WORKFLOW_FILE);
  writeFileSync(realFile, JSON.stringify(GRAPH));
  mocks.liveWorkspace.mockResolvedValue(workspace);
  mocks.getObjectInfo.mockResolvedValue({});
  mocks.backfillObjectInfo.mockImplementation(async (info: unknown) => info);
  mocks.fetchApi.mockResolvedValue({
    ok: false,
    status: 500,
    statusText: "Internal Server Error",
    json: async () => ({}),
    text: async () => "Internal Server Error",
  });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("#2528 get_workflow strip keeps the userdata workflows segment", () => {
  it('action:"strip" reads the absolute userdata/workflows path (em-dash intact)', async () => {
    const res = await getHandler()({ action: "strip", path: realFile, format: "raw" });

    expect(res.isError).toBeUndefined();
    expect(text(res)).not.toMatch(/ENOENT/);
    expect(text(res)).not.toContain(droppedFile);
    expect(JSON.parse(res.content[0]!.text)).toEqual(GRAPH);
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });

  it("the dropped-workflows reconstruction ENOENT path still finds the file", async () => {
    // The production error opened user/default/artokun_lab/... — that file is
    // NOT created here. A resolver that joins the library-relative tail onto
    // user/default (dropping `workflows`) ENOENTs; restoring the segment must
    // open the real userdata/workflows location, em-dash and all.
    const res = await getHandler()({ action: "strip", path: droppedFile, format: "raw" });

    expect(res.isError).toBeUndefined();
    expect(text(res)).not.toMatch(/ENOENT/);
    expect(text(res)).not.toContain(droppedFile);
    expect(JSON.parse(res.content[0]!.text)).toEqual(GRAPH);
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });

  it('action:"strip" also repairs an absolute `filename` from the same userdata tree', async () => {
    const res = await getHandler()({ action: "strip", filename: droppedFile, format: "raw" });

    expect(res.isError).toBeUndefined();
    expect(text(res)).not.toMatch(/ENOENT/);
    expect(JSON.parse(res.content[0]!.text)).toEqual(GRAPH);
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });

  it("does not find a hyphen-mangled stand-in when only the em-dash file exists", async () => {
    const mangled = join(
      workspace,
      "user",
      "default",
      "workflows",
      "artokun_lab",
      WORKFLOW_FILE.replace(EMDASH, "-"),
    );
    const res = await getHandler()({ action: "strip", path: mangled, format: "raw" });

    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/ENOENT|not found/i);
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });
});

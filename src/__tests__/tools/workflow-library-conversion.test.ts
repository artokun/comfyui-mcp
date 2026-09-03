import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  queryApiGraph: vi.fn(),
}));

vi.mock("../../comfyui/client.js", () => ({
  comfyApiFetch: (...args: unknown[]) => mocks.fetchApi(...args),
  getObjectInfo: (...args: unknown[]) => mocks.getObjectInfo(...args),
  backfillObjectInfo: (...args: unknown[]) => mocks.backfillObjectInfo(...args),
}));

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("../../services/workflow-slicer.js", () => ({ sliceWorkflow: vi.fn() }));
vi.mock("../../services/graph-query.js", () => ({
  queryApiGraph: (...args: unknown[]) => mocks.queryApiGraph(...args),
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
  isRemoteMode: () => false,
  // Cloud is a THIRD mode: isRemoteMode() is false there, so workflow-library
  // asks isCloudMode() separately before treating the filesystem as local.
  isCloudMode: () => false,
  targetIsOnThisMachine: () => true,
}));
vi.mock("../../services/frontend-virtual-types.js", () => ({
  frontendVirtualTypesFor: () =>
    new Set(["Fast Groups Bypasser (rgthree)", "Fast Groups Muter (rgthree)"]),
}));

// Deliberately do not mock workflow-converter.js: these are production-path
// regressions through the real UI→API converter and workflow-library handler.
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

function uiNode(id: number, type: string, mode = 0): Record<string, unknown> {
  return {
    id,
    type,
    mode,
    pos: [id, 0],
    inputs: [],
    outputs: [],
    widgets_values: [],
  };
}

const UUID_COMPONENT = "0f0f0f0f-2125-4b21-8b21-000000000001";

/**
 * A 164-node UI export with a UUID component, bypassed execution branches,
 * frontend-only notes, ordinary legacy link tuples, and a subgraph's legacy
 * object links. Every executable candidate is intentionally absent.
 */
function validLargeEmptyGraph(): Record<string, unknown> {
  const nodes = [uiNode(1, UUID_COMPONENT)];
  for (let id = 2; id <= 164; id++) {
    nodes.push(uiNode(id, id % 2 === 0 ? "KSampler" : "Note", id % 2 === 0 ? 4 : 0));
  }
  (nodes[1].outputs as Array<Record<string, unknown>>)[0] = {
    name: "LATENT",
    type: "LATENT",
    links: [700],
  };
  (nodes[2].inputs as Array<Record<string, unknown>>)[0] = {
    name: "latent",
    type: "LATENT",
    link: 700,
  };

  return {
    nodes,
    links: [[700, 2, 0, 3, 0, "LATENT"]],
    definitions: {
      subgraphs: [
        {
          id: UUID_COMPONENT,
          name: "bypassed UUID component",
          inputNode: { id: -10 },
          outputNode: { id: -20 },
          inputs: [],
          outputs: [],
          nodes: [
            uiNode(1, "KSampler", 4),
            uiNode(2, "Note"),
          ],
          // ComfyUI component definitions use object links, unlike the
          // top-level legacy tuple links.
          links: [
            { id: 1, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: "LATENT" },
          ],
        },
      ],
    },
  };
}

function lostExecutableGraph(): Record<string, unknown> {
  const nodes = [uiNode(1, "missing-uuid-node-1")];
  for (let id = 2; id <= 12; id++) {
    nodes.push(uiNode(id, `missing-uuid-node-${id}`));
  }
  for (let id = 13; id <= 164; id++) {
    nodes.push(uiNode(id, id % 2 === 0 ? "KSampler" : "Note", id % 2 === 0 ? 4 : 0));
  }
  return {
    nodes,
    links: [[900, 1, 0, 3, 0, "LATENT"]],
  };
}

const EXECUTABLE_OBJECT_INFO = {
  SourceNode: { input: { required: {} }, output: ["IMAGE"] },
  SinkNode: { input: { required: { image: ["IMAGE"] } }, output: [] },
};

/** An active UUID component whose legacy object links survive flattening. */
function executableUuidLegacyGraph(): Record<string, unknown> {
  const component = uiNode(5, UUID_COMPONENT);
  component.outputs = [{ name: "IMAGE", type: "IMAGE", links: [800] }];
  const outerSink = uiNode(20, "SinkNode");
  outerSink.inputs = [{ name: "image", type: "IMAGE", link: 800 }];

  const source = uiNode(1, "SourceNode");
  source.outputs = [{ name: "IMAGE", type: "IMAGE", links: [701, 702] }];
  const innerSink = uiNode(2, "SinkNode");
  innerSink.inputs = [{ name: "image", type: "IMAGE", link: 701 }];

  return {
    nodes: [component, outerSink],
    links: [[800, 5, 0, 20, 0, "IMAGE"]],
    definitions: {
      subgraphs: [
        {
          id: UUID_COMPONENT,
          name: "active UUID component",
          inputNode: { id: -10 },
          outputNode: { id: -20 },
          inputs: [],
          outputs: [{ id: "out", name: "IMAGE", type: "IMAGE", linkIds: [702] }],
          nodes: [source, innerSink],
          links: [
            { id: 701, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: "IMAGE" },
            { id: 702, origin_id: 1, origin_slot: 0, target_id: -20, target_slot: 0, type: "IMAGE" },
          ],
        },
      ],
    },
  };
}

function imageLink(node: { inputs: Record<string, unknown> }): unknown {
  const value = node.inputs.image;
  return Array.isArray(value) ? value[0] : undefined;
}

function setLibraryResponse(body: unknown): void {
  mocks.fetchApi.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  });
}

beforeEach(() => {
  mocks.fetchApi.mockReset();
  mocks.getObjectInfo.mockReset();
  mocks.backfillObjectInfo.mockReset();
  mocks.getObjectInfo.mockResolvedValue({});
  mocks.backfillObjectInfo.mockImplementation(async (bulk: unknown) => bulk);
  mocks.queryApiGraph.mockReturnValue({ text: "No executable API nodes" });
});

describe("workflow-library UI→API conversion seam (#2125)", () => {
  it("keeps a valid 164-node UUID/bypassed/frontend-only graph empty and immutable", async () => {
    const source = validLargeEmptyGraph();
    const before = structuredClone(source);
    setLibraryResponse(source);

    const result = await getHandler()({
      action: "get",
      filename: "WAN 2.2 Smooth Workflow v6.0.json",
      format: "api",
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({});
    expect(source).toEqual(before);
    expect((source.nodes as unknown[]).length).toBe(164);
  });

  it("preserves literal empty, bypassed executable, and frontend-only UI graphs", async () => {
    const graphs = [
      { nodes: [], links: [] },
      { nodes: [uiNode(1, "KSampler", 4)], links: [] },
      { nodes: [uiNode(1, "Note")], links: [] },
    ];

    for (const graph of graphs) {
      setLibraryResponse(graph);
      const result = await getHandler()({ action: "get", filename: "empty.json", format: "api" });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({});
    }
  });

  it("accepts panel-proven Fast Groups Bypasser/Muter-only graphs as valid empty UI conversions", async () => {
    const source = {
      nodes: [
        uiNode(1, "Fast Groups Bypasser (rgthree)"),
        uiNode(2, "Fast Groups Muter (rgthree)"),
      ],
      links: [],
    };
    const before = structuredClone(source);
    setLibraryResponse(source);

    const result = await getHandler()({ action: "get", filename: "toggles.json", format: "api" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({});
    expect(source).toEqual(before);
  });

  it("does not let a virtual proof override a node type registered by object_info", async () => {
    const source = {
      nodes: [uiNode(1, "Fast Groups Bypasser (rgthree)"), uiNode(2, "Note")],
      links: [],
    };
    mocks.getObjectInfo.mockResolvedValue({
      "Fast Groups Bypasser (rgthree)": { input: { required: {} }, output: [] },
    });
    setLibraryResponse(source);

    const result = await getHandler()({ action: "get", filename: "registered.json", format: "api" });

    expect(result.isError).toBeUndefined();
    const api = JSON.parse(result.content[0].text) as Record<string, { class_type: string }>;
    expect(Object.values(api)).toEqual([{ class_type: "Fast Groups Bypasser (rgthree)", inputs: {} }]);
  });

  it("preserves active UUID expansion and legacy links through get without mutating the source", async () => {
    const source = executableUuidLegacyGraph();
    const before = structuredClone(source);
    mocks.getObjectInfo.mockResolvedValue(EXECUTABLE_OBJECT_INFO);
    setLibraryResponse(source);

    const result = await getHandler()({ action: "get", filename: "uuid.json", format: "api" });

    expect(result.isError).toBeUndefined();
    const api = JSON.parse(result.content[0].text) as Record<string, {
      class_type: string;
      inputs: Record<string, unknown>;
    }>;
    const sourceEntry = Object.entries(api).find(([, node]) => node.class_type === "SourceNode");
    const innerSink = Object.values(api).filter((node) => node.class_type === "SinkNode");
    expect(sourceEntry).toBeDefined();
    expect(innerSink).toHaveLength(2);
    expect(innerSink.some((node) => imageLink(node) === sourceEntry![0])).toBe(true);
    expect(Object.values(api).some((node) => imageLink(node) === sourceEntry![0])).toBe(true);
    expect(source).toEqual(before);
  });

  it("keeps valid empty conversion semantics across strip, query, and analyze", async () => {
    const source = { nodes: [uiNode(1, "Note")], links: [] };

    const stripped = await getHandler()({ action: "strip", graph: source, format: "api" });
    expect(stripped.isError).toBeUndefined();
    expect(stripped.content.at(-1)?.text).toBe("{}");

    const queried = await getHandler()({ action: "query", graph: source, types: ["Note"] });
    expect(queried.isError).toBeUndefined();
    expect(queried.content[0].text).toContain("No executable API nodes");

    setLibraryResponse(source);
    const analyzed = await getHandler()({ action: "analyze", filename: "note.json", view: "health" });
    expect(analyzed.isError).toBeUndefined();
    expect(analyzed.content[0].text).toContain("no executable API nodes");
  });

  it("refuses genuinely lost executable content and retains converter warnings", async () => {
    const source = lostExecutableGraph();
    setLibraryResponse(source);
    const result = await getHandler()({
      action: "get",
      filename: "lost.json",
      format: "api",
    });

    expect(result.isError).toBe(true);
    const error = JSON.parse(result.content[0].text) as { message: string };
    expect(error.message).toContain("produced no executable API nodes");
    expect(error.message).toContain("Node 1 (missing-uuid-node-1)");
    expect(error.message).toContain("Node 9 (missing-uuid-node-9)");
    expect(error.message).toContain("Conversion diagnostics (12)");
    expect(error.message).toContain('Request format:"ui"');
  });

  it("uses the same refusal and diagnostics for strip, query, and analyze", async () => {
    const source = lostExecutableGraph();
    const expected = "Node 1 (missing-uuid-node-1)";

    const strip = await getHandler()({ action: "strip", graph: source, format: "api" });
    expect(strip.isError).toBe(true);
    expect(strip.content[0].text).toContain(expected);

    const query = await getHandler()({
      action: "query",
      graph: source,
      types: ["missing-uuid-node"],
    });
    expect(query.isError).toBe(true);
    expect(query.content[0].text).toContain(expected);

    setLibraryResponse(source);
    const analyze = await getHandler()({
      action: "analyze",
      filename: "lost.json",
      view: "health",
    });
    expect(analyze.isError).toBe(true);
    expect(analyze.content[0].text).toContain(expected);
  });

  it('leaves format:"ui" as the raw source representation', async () => {
    const source = validLargeEmptyGraph();
    setLibraryResponse(source);
    const result = await getHandler()({
      action: "get",
      filename: "raw.json",
      format: "ui",
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(source);
    expect(result.content).toHaveLength(1);
  });
});

import { describe, expect, it, vi } from "vitest";

// #494: get_workflow(format:"api") must return the workflow JSON as the PRIMARY
// (first) content block, with conversion warnings appended as a separate
// trailing block. Consumers that read the first text result must always receive
// parseable JSON — never Markdown warnings — so passing it straight to
// JSON.parse / list_packs (action:"check_runtime") works even with convert warnings.

const fetchApiMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getClient: () => ({ fetchApi: (...a: unknown[]) => fetchApiMock(...a) }),
  // #385 — call sites moved from `client.fetchApi` to `comfyApiFetch`, which
  // returns a 4xx instead of throwing. Routed to the SAME spy so every
  // existing "which route did we ask for" assertion still pins the same thing.
  comfyApiFetch: (...a: unknown[]) => ((...a: unknown[]) => fetchApiMock(...a))(...(a as [string])),
  getObjectInfo: vi.fn(async () => ({})),
  backfillObjectInfo: vi.fn(async (bulk: unknown) => bulk),
}));

const convertUiToApiMock = vi.fn();
vi.mock("../../services/workflow-converter.js", () => ({
  isUiFormat: () => true,
  isApiFormat: () => false,
  convertUiToApi: (...a: unknown[]) => convertUiToApiMock(...a),
  convertApiToUi: vi.fn(),
  collectNodeTypes: () => [],
}));

// Unused-by-this-test services still imported by the module under test.
vi.mock("../../services/workflow-slicer.js", () => ({ sliceWorkflow: vi.fn() }));
// #809: the query action's schema + description now quote the engine's own clamps, so
// the mock has to carry them — a stub that omits them fails registration outright.
vi.mock("../../services/graph-query.js", () => ({
  queryApiGraph: vi.fn(),
  LIMIT_CEILING: 200,
  MAX_CHARS_CEILING: 60000,
  MAX_CHARS_FLOOR: 500,
}));
vi.mock("../../services/workflow-sections.js", () => ({ detectSections: vi.fn() }));
vi.mock("../../services/hierarchical-mermaid.js", () => ({
  generateOverview: vi.fn(),
  generateSectionDetail: vi.fn(),
  listSections: vi.fn(),
  generateSummary: vi.fn(),
}));
vi.mock("../../services/mermaid-converter.js", () => ({ convertToMermaid: vi.fn() }));
vi.mock("../../services/workflow-health.js", () => ({ analyzeGraphHealth: vi.fn() }));

import { registerWorkflowLibraryTools } from "../../tools/workflow-library.js";

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;
function getHandler(name: string): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => {
      if (n === name) handler = h;
    },
  };
  registerWorkflowLibraryTools(server as never);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

describe('get_workflow (action:"get") — JSON before conversion warnings (#494)', () => {
  it("returns parseable JSON as the FIRST content block even with warnings", async () => {
    const apiWorkflow = { "3": { class_type: "KSampler", inputs: { seed: 1 } } };
    fetchApiMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ nodes: [] }) });
    convertUiToApiMock.mockReturnValue({
      workflow: apiWorkflow,
      warnings: ["Node 7 (Reroute) dropped: no resolvable target"],
    });

    const { content } = await getHandler("get_workflow")({
      action: "get",
      filename: "w.json",
      format: "api",
    });

    // First block MUST be the JSON graph — parsing it must not throw.
    expect(content[0].type).toBe("text");
    expect(() => JSON.parse(content[0].text)).not.toThrow();
    expect(JSON.parse(content[0].text)).toEqual(apiWorkflow);

    // Warnings preserved, but as a SEPARATE trailing block.
    expect(content).toHaveLength(2);
    expect(content[1].text).toContain("Conversion warnings");
    expect(content[1].text).toContain("Reroute");
  });

  it("returns only the JSON block when there are no warnings", async () => {
    const apiWorkflow = { "1": { class_type: "CheckpointLoaderSimple", inputs: {} } };
    fetchApiMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ nodes: [] }) });
    convertUiToApiMock.mockReturnValue({ workflow: apiWorkflow, warnings: [] });

    const { content } = await getHandler("get_workflow")({
      action: "get",
      filename: "w.json",
      format: "api",
    });
    expect(content).toHaveLength(1);
    expect(JSON.parse(content[0].text)).toEqual(apiWorkflow);
  });
});

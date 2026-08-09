import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated `get_workflow` (8 read actions) and `save_workflow` (3
 * write/provenance actions) tools — 0.50.0 slice 14, eleven names into two.
 *
 * The property this file exists to pin, beyond ordinary dispatch: the saved
 * workflow library is hand-authored work that is expensive to recreate, and
 * `save_workflow (action:"save")` OVERWRITES a same-filename file without
 * confirmation. No READ action may reach a write path, and no read action may
 * even be spelled on the writing tool. `get_workflow` is also at the RFC's
 * eight-action cap with zero headroom, which is asserted rather than left as a
 * comment.
 */

const mocks = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  isUiFormat: vi.fn(),
  isApiFormat: vi.fn(),
  convertUiToApi: vi.fn(),
  convertApiToUi: vi.fn(),
  collectNodeTypes: vi.fn(),
  sliceWorkflow: vi.fn(),
  queryApiGraph: vi.fn(),
  listWorkflowLibraryKeys: vi.fn(),
  detectSections: vi.fn(),
  generateOverview: vi.fn(),
  generateSectionDetail: vi.fn(),
  listSections: vi.fn(),
  generateSummary: vi.fn(),
  convertToMermaid: vi.fn(),
  analyzeGraphHealth: vi.fn(),
  extractWorkflowFromImage: vi.fn(),
  promptDirectorInspectAction: vi.fn(),
  lockWorkflowAction: vi.fn(),
  verifyWorkflowLockAction: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ readFile: (...a: unknown[]) => mocks.readFile(...a) }));
vi.mock("../../comfyui/client.js", () => ({
  getClient: () => ({ fetchApi: (...a: unknown[]) => mocks.fetchApi(...a) }),
  // #385 — call sites moved from `client.fetchApi` to `comfyApiFetch`, which
  // returns a 4xx instead of throwing. Routed to the SAME spy so every
  // existing "which route did we ask for" assertion still pins the same thing.
  comfyApiFetch: (...a: unknown[]) => ((...a: unknown[]) => mocks.fetchApi(...a))(...(a as [string])),
  getObjectInfo: (...a: unknown[]) => mocks.getObjectInfo(...a),
  backfillObjectInfo: (...a: unknown[]) => mocks.backfillObjectInfo(...a),
}));
vi.mock("../../services/workflow-converter.js", () => ({
  isUiFormat: (...a: unknown[]) => mocks.isUiFormat(...a),
  isApiFormat: (...a: unknown[]) => mocks.isApiFormat(...a),
  convertUiToApi: (...a: unknown[]) => mocks.convertUiToApi(...a),
  convertApiToUi: (...a: unknown[]) => mocks.convertApiToUi(...a),
  collectNodeTypes: (...a: unknown[]) => mocks.collectNodeTypes(...a),
}));
vi.mock("../../services/workflow-slicer.js", () => ({
  sliceWorkflow: (...a: unknown[]) => mocks.sliceWorkflow(...a),
}));
vi.mock("../../services/graph-query.js", () => ({
  queryApiGraph: (...a: unknown[]) => mocks.queryApiGraph(...a),
  LIMIT_CEILING: 200,
  MAX_CHARS_CEILING: 60000,
  MAX_CHARS_FLOOR: 500,
}));
vi.mock("../../services/userdata-library.js", () => ({
  listWorkflowLibraryKeys: (...a: unknown[]) => mocks.listWorkflowLibraryKeys(...a),
}));
vi.mock("../../services/workflow-sections.js", () => ({
  detectSections: (...a: unknown[]) => mocks.detectSections(...a),
}));
vi.mock("../../services/hierarchical-mermaid.js", () => ({
  generateOverview: (...a: unknown[]) => mocks.generateOverview(...a),
  generateSectionDetail: (...a: unknown[]) => mocks.generateSectionDetail(...a),
  listSections: (...a: unknown[]) => mocks.listSections(...a),
  generateSummary: (...a: unknown[]) => mocks.generateSummary(...a),
}));
vi.mock("../../services/mermaid-converter.js", () => ({
  convertToMermaid: (...a: unknown[]) => mocks.convertToMermaid(...a),
}));
vi.mock("../../services/workflow-health.js", () => ({
  analyzeGraphHealth: (...a: unknown[]) => mocks.analyzeGraphHealth(...a),
}));
vi.mock("../../services/image-management.js", () => ({
  extractWorkflowFromImage: (...a: unknown[]) => mocks.extractWorkflowFromImage(...a),
}));
vi.mock("../../tools/prompt-director.js", () => ({
  promptDirectorInspectAction: (...a: unknown[]) => mocks.promptDirectorInspectAction(...a),
}));
vi.mock("../../tools/workflow-lock.js", () => ({
  lockWorkflowAction: (...a: unknown[]) => mocks.lockWorkflowAction(...a),
  verifyWorkflowLockAction: (...a: unknown[]) => mocks.verifyWorkflowLockAction(...a),
}));

import { registerWorkflowLibraryTools } from "../../tools/workflow-library.js";

type Handler = (args: Record<string, any>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

interface Registered {
  name: string;
  shape: z.ZodRawShape;
  handler: Handler;
}

function registered(): Registered[] {
  const tools: Registered[] = [];
  const server = {
    tool: (name: string, _desc: string, shape: z.ZodRawShape, handler: Handler) => {
      tools.push({ name, shape, handler });
    },
  };
  registerWorkflowLibraryTools(server as never);
  return tools;
}

function tool(name: "get_workflow" | "save_workflow"): Registered {
  const found = registered().find((t) => t.name === name);
  expect(found, `${name} must be registered`).toBeDefined();
  return found!;
}

const get = (): Handler => tool("get_workflow").handler;
const save = (): Handler => tool("save_workflow").handler;

const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

const UI_GRAPH = { nodes: [], links: [] };
const API_GRAPH = { "1": { class_type: "SaveImage", inputs: {} } };

/** The library userdata GET both `get` and `analyze` go through. */
function libraryReturns(body: unknown, ok = true, status = 200): void {
  mocks.fetchApi.mockResolvedValue({ ok, status, statusText: "OK", json: async () => body });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getObjectInfo.mockResolvedValue({});
  mocks.backfillObjectInfo.mockImplementation(async (info: unknown) => info);
  mocks.collectNodeTypes.mockReturnValue([]);
  mocks.isUiFormat.mockReturnValue(false);
  mocks.isApiFormat.mockReturnValue(true);
  mocks.convertUiToApi.mockReturnValue({ workflow: API_GRAPH, warnings: [] });
  mocks.detectSections.mockReturnValue({
    sections: new Map([["Sampling", []]]),
    virtualEdges: [],
    nodeToSection: new Map(),
    getSetNodeIds: new Set(),
  });
  mocks.generateSummary.mockReturnValue("summary text");
});

describe("workflow-library registration", () => {
  it("registers exactly two tools, get_workflow then save_workflow (11→2)", () => {
    expect(registered().map((t) => t.name)).toEqual(["get_workflow", "save_workflow"]);
  });

  it("get_workflow exposes a flat `action` enum with every per-action parameter", () => {
    const json = z.toJSONSchema(z.object(tool("get_workflow").shape), {
      reused: "inline",
      io: "input",
    }) as { properties?: Record<string, { enum?: string[] }>; required?: string[] };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action",
      "depth",
      "downstream_of",
      "fields",
      "filename",
      "format",
      "graph",
      "group_by",
      "groups",
      "ids",
      "image_path",
      "limit",
      "max_chars",
      "node_id",
      "path",
      "section",
      "title",
      "types",
      "upstream_of",
      "view",
      "where",
    ]);
    expect(json.required).toEqual(["action"]);
  });

  // RFC controversy #7: eight is the cap and there is no headroom. A ninth
  // workflow-reading verb forces a SPLIT, and this assertion is where that
  // decision gets made rather than discovered.
  it("get_workflow is AT the eight-action cap — a ninth action forces a split", () => {
    const json = z.toJSONSchema(z.object(tool("get_workflow").shape), {
      reused: "inline",
      io: "input",
    }) as { properties?: Record<string, { enum?: string[] }> };
    const actions = json.properties?.action.enum ?? [];
    expect(actions.sort()).toEqual([
      "analyze",
      "from_image",
      "get",
      "list",
      "prompt_director",
      "query",
      "slice",
      "strip",
    ]);
    expect(actions).toHaveLength(8);
  });

  it("save_workflow exposes only its three write/provenance actions", () => {
    const json = z.toJSONSchema(z.object(tool("save_workflow").shape), {
      reused: "inline",
      io: "input",
    }) as { properties?: Record<string, { enum?: string[] }>; required?: string[] };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action",
      "filename",
      "workflow",
    ]);
    expect(json.properties?.action.enum?.sort()).toEqual(["lock", "save", "verify_lock"]);
    expect(json.required).toEqual(["action"]);
  });

  it("an unknown action on either tool returns a clear error result", async () => {
    const g = await get()({ action: "bogus" });
    expect(g.isError).toBe(true);
    expect(text(g)).toMatch(/unknown get_workflow action/i);
    const s = await save()({ action: "bogus", filename: "a.json" });
    expect(s.isError).toBe(true);
    expect(text(s)).toMatch(/unknown save_workflow action/i);
  });
});

describe("get_workflow actions call the same services with the same arguments", () => {
  it('action:"get" reads the library entry and returns its JSON', async () => {
    libraryReturns(API_GRAPH);
    const res = await get()({ action: "get", filename: "IMAGE/portrait.json", format: "api" });
    expect(mocks.fetchApi).toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/IMAGE/portrait.json")}`,
    );
    expect(JSON.parse(text(res))).toEqual(API_GRAPH);
  });

  it('action:"get" on a UI file converts to API and appends warnings AFTER the JSON (#494)', async () => {
    libraryReturns(UI_GRAPH);
    mocks.isUiFormat.mockReturnValue(true);
    mocks.convertUiToApi.mockReturnValue({ workflow: API_GRAPH, warnings: ["dropped a link"] });
    const res = await get()({ action: "get", filename: "a.json", format: "api" });
    expect(JSON.parse(res.content[0].text)).toEqual(API_GRAPH);
    expect(res.content[1].text).toContain("dropped a link");
  });

  it('action:"list" reports the recursive listing', async () => {
    mocks.listWorkflowLibraryKeys.mockResolvedValueOnce({
      ok: true,
      keys: ["VIDEO/clip.json", "IMAGE/portrait.json"],
      unreadable: 0,
      recursionProven: true,
    });
    const res = await get()({ action: "list" });
    expect(text(res)).toContain("Found 2 workflow(s)");
    expect(text(res)).toContain("IMAGE/portrait.json");
  });

  it('action:"strip" loads from an absolute path and returns summary + stripped graph', async () => {
    mocks.readFile.mockResolvedValueOnce(JSON.stringify(UI_GRAPH));
    mocks.isUiFormat.mockReturnValue(true);
    mocks.convertUiToApi.mockReturnValue({ workflow: API_GRAPH, warnings: [] });
    const res = await get()({ action: "strip", path: "C:/wf/expert.json", format: "api" });
    expect(mocks.readFile).toHaveBeenCalledWith("C:/wf/expert.json", "utf8");
    expect(res.content[0].text).toContain("Stripped to 1 nodes");
    expect(JSON.parse(res.content[1].text)).toEqual(API_GRAPH);
  });

  it('action:"slice" splits a CSV `groups` string and forwards the list to sliceWorkflow', async () => {
    mocks.sliceWorkflow.mockReturnValueOnce({
      workflow: UI_GRAPH,
      stats: { nodes: 4, unbypassed: 2, links: 3, subgraphs: 0, seeds: 1, badLinks: 0, orphanGets: 0 },
    });
    const res = await get()({ action: "slice", graph: UI_GRAPH, groups: "TXT,EXTEND" });
    expect(mocks.sliceWorkflow).toHaveBeenCalledWith(UI_GRAPH, ["TXT", "EXTEND"]);
    expect(res.content[0].text).toContain("Sliced 4 nodes");
  });

  it('action:"from_image" hands the path to the PNG extractor', async () => {
    mocks.extractWorkflowFromImage.mockResolvedValueOnce({ prompt: API_GRAPH, workflow: UI_GRAPH });
    const res = await get()({ action: "from_image", image_path: "C:/out/img.png" });
    expect(mocks.extractWorkflowFromImage).toHaveBeenCalledWith("C:/out/img.png");
    expect(text(res)).toContain("Workflow extracted from C:/out/img.png");
  });

  it('action:"analyze" defaults to the structured summary view', async () => {
    libraryReturns(API_GRAPH);
    const res = await get()({ action: "analyze", filename: "a.json", view: "summary" });
    expect(mocks.generateSummary).toHaveBeenCalled();
    expect(text(res)).toContain("summary text");
  });

  it('action:"analyze" view:"health" runs the health heuristics instead', async () => {
    libraryReturns(API_GRAPH);
    mocks.analyzeGraphHealth.mockReturnValueOnce({ summary: "2 findings", findings: [] });
    const res = await get()({ action: "analyze", filename: "a.json", view: "health" });
    expect(mocks.analyzeGraphHealth).toHaveBeenCalled();
    expect(text(res)).toContain("### Graph health");
  });

  it('action:"query" forwards ONLY the query parameters to the engine', async () => {
    mocks.queryApiGraph.mockReturnValueOnce({ text: "1 KSampler" });
    await get()({
      action: "query",
      graph: API_GRAPH,
      types: ["KSampler"],
      where: ["cfg>7"],
      limit: 10,
      fields: "detail",
    });
    expect(mocks.queryApiGraph).toHaveBeenCalledWith(API_GRAPH, {
      types: ["KSampler"],
      where: ["cfg>7"],
      limit: 10,
      fields: "detail",
    });
  });

  it('action:"prompt_director" passes node_id straight through', async () => {
    mocks.promptDirectorInspectAction.mockResolvedValueOnce({
      content: [{ type: "text", text: "{}" }],
    });
    await get()({ action: "prompt_director", node_id: "42" });
    expect(mocks.promptDirectorInspectAction).toHaveBeenCalledWith("42");
  });
});

describe("save_workflow actions call the same services with the same arguments", () => {
  it('action:"save" POSTs a UI-format graph verbatim', async () => {
    mocks.isUiFormat.mockReturnValue(true);
    mocks.fetchApi.mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" });
    const res = await save()({ action: "save", filename: "new.json", workflow: UI_GRAPH });
    expect(mocks.fetchApi).toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/new.json")}`,
      { method: "POST", body: JSON.stringify(UI_GRAPH) },
    );
    expect(text(res)).toContain('Workflow saved as "new.json"');
  });

  it('action:"save" auto-converts an API-format graph so the canvas can open it', async () => {
    mocks.isUiFormat.mockReturnValue(false);
    mocks.isApiFormat.mockReturnValue(true);
    mocks.convertApiToUi.mockReturnValue({ workflow: UI_GRAPH, warnings: [] });
    mocks.fetchApi.mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" });
    const res = await save()({ action: "save", filename: "n.json", workflow: API_GRAPH });
    expect(mocks.convertApiToUi).toHaveBeenCalled();
    expect(text(res)).toContain("auto-converted to Web UI format");
  });

  it('action:"lock" and action:"verify_lock" delegate to the lock bodies', async () => {
    mocks.lockWorkflowAction.mockResolvedValueOnce({ content: [{ type: "text", text: "locked" }] });
    await save()({ action: "lock", filename: "a.json" });
    expect(mocks.lockWorkflowAction).toHaveBeenCalledWith("a.json");

    mocks.verifyWorkflowLockAction.mockResolvedValueOnce({
      content: [{ type: "text", text: "no drift" }],
    });
    await save()({ action: "verify_lock", filename: "a.json" });
    expect(mocks.verifyWorkflowLockAction).toHaveBeenCalledWith("a.json");
  });
});

/**
 * The blast-radius property. `save` overwrites a hand-authored workflow without
 * confirmation and `lock` writes a second file, so no read may reach either —
 * not through a mis-typed action, not through arguments that look like a save.
 */
describe("no read can reach a write path", () => {
  it("every get_workflow action leaves the userdata POST and the lock bodies untouched", async () => {
    const reads: Array<Record<string, unknown>> = [
      { action: "get", filename: "a.json" },
      { action: "list" },
      { action: "strip", graph: UI_GRAPH },
      { action: "slice", graph: UI_GRAPH, groups: "A" },
      { action: "from_image", image_path: "a.png" },
      { action: "analyze", filename: "a.json" },
      { action: "query", graph: API_GRAPH },
      { action: "prompt_director" },
    ];
    mocks.listWorkflowLibraryKeys.mockResolvedValue({
      ok: true, keys: [], unreadable: 0, recursionProven: false,
    });
    mocks.sliceWorkflow.mockReturnValue({
      workflow: UI_GRAPH,
      stats: { nodes: 0, unbypassed: 0, links: 0, subgraphs: 0, seeds: 0, badLinks: 0, orphanGets: 0 },
    });
    mocks.extractWorkflowFromImage.mockResolvedValue({});
    mocks.queryApiGraph.mockReturnValue({ text: "" });
    mocks.promptDirectorInspectAction.mockResolvedValue({ content: [{ type: "text", text: "" }] });
    libraryReturns(API_GRAPH);

    for (const args of reads) {
      await get()(args);
      // Every userdata call a read makes is a plain GET: no method, no body.
      for (const call of mocks.fetchApi.mock.calls) {
        expect(call[1]?.method, `action:"${args.action}" issued a ${call[1]?.method} request`)
          .toBeUndefined();
      }
    }
    expect(mocks.lockWorkflowAction).not.toHaveBeenCalled();
    expect(mocks.verifyWorkflowLockAction).not.toHaveBeenCalled();
    expect(mocks.convertApiToUi).not.toHaveBeenCalled();
  });

  it("a read action spelled on save_workflow is refused, not silently answered", async () => {
    for (const action of ["get", "list", "analyze", "query", "strip"]) {
      const res = await save()({ action, filename: "a.json" });
      expect(res.isError, `save_workflow action:"${action}"`).toBe(true);
      expect(text(res)).toMatch(/unknown save_workflow action/i);
    }
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });

  it("a write action spelled on get_workflow is refused, not silently answered", async () => {
    for (const action of ["save", "lock", "verify_lock"]) {
      const res = await get()({ action, filename: "a.json", workflow: UI_GRAPH });
      expect(res.isError, `get_workflow action:"${action}"`).toBe(true);
      expect(text(res)).toMatch(/unknown get_workflow action/i);
    }
    expect(mocks.fetchApi).not.toHaveBeenCalled();
    expect(mocks.lockWorkflowAction).not.toHaveBeenCalled();
  });
});

describe("per-action requiredness NAMES the missing field", () => {
  it('get_workflow action:"get"/"analyze" without `filename` say so', async () => {
    for (const action of ["get", "analyze"]) {
      const res = await get()({ action });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain(`action:"${action}" requires \`filename\``);
    }
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });

  it('get_workflow action:"slice" without `groups` names `groups`', async () => {
    const res = await get()({ action: "slice", graph: UI_GRAPH });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"slice" requires `groups`');
    expect(mocks.sliceWorkflow).not.toHaveBeenCalled();
  });

  it('get_workflow action:"from_image" without `image_path` names `image_path`', async () => {
    const res = await get()({ action: "from_image" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"from_image" requires `image_path`');
    expect(mocks.extractWorkflowFromImage).not.toHaveBeenCalled();
  });

  it("the strip/slice/query source rule still demands EXACTLY one of path/filename/graph", async () => {
    for (const action of ["strip", "slice", "query"]) {
      const none = await get()({ action, groups: "A" });
      expect(text(none)).toContain("Provide exactly one of: path, filename, or graph.");
      const both = await get()({ action, path: "a.json", graph: UI_GRAPH, groups: "A" });
      expect(text(both)).toContain("Provide exactly one of: path, filename, or graph.");
    }
  });

  it("save_workflow names `filename` for every action, and `workflow` only for save", async () => {
    for (const action of ["save", "lock", "verify_lock"]) {
      const res = await save()({ action });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain(`action:"${action}" requires \`filename\``);
    }
    const noWorkflow = await save()({ action: "save", filename: "a.json" });
    expect(text(noWorkflow)).toContain('action:"save" requires `workflow`');
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });

  // ABSENCE, not falsiness: `filename: ""` passed z.string() before this
  // consolidation and reached the userdata fetch, which answers with its own
  // not-found. A `!filename` guard would swallow that path.
  it("an explicitly empty `filename` still reaches the userdata fetch", async () => {
    libraryReturns(null, false, 404);
    const res = await get()({ action: "get", filename: "" });
    expect(mocks.fetchApi).toHaveBeenCalledWith(`/api/userdata/${encodeURIComponent("workflows/")}`);
    expect(text(res)).toContain("Workflow not found:  (404)");
  });

  it("an explicitly empty `filename` still reaches the SAVE POST", async () => {
    mocks.isUiFormat.mockReturnValue(true);
    mocks.fetchApi.mockResolvedValueOnce({ ok: false, status: 400, statusText: "Bad Request", text: async () => "" });
    const res = await save()({ action: "save", filename: "", workflow: UI_GRAPH });
    expect(mocks.fetchApi).toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/")}`,
      { method: "POST", body: JSON.stringify(UI_GRAPH) },
    );
    expect(text(res)).toContain("Failed to save workflow: 400");
  });
});

/**
 * `format` was ui|api on one retired tool and api|raw on another. The shared
 * field is their union, so each action must REFUSE the member its own tool never
 * accepted rather than aliasing it onto the nearest neighbour — 'raw' and 'ui'
 * are close, not equal, and answering the wrong one is a wrong ANSWER reported
 * as a success.
 */
describe("the widened `format` enum keeps its two halves apart", () => {
  it('action:"get" refuses format:"raw" and names its two valid values', async () => {
    const res = await get()({ action: "get", filename: "a.json", format: "raw" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"get" does not accept format:"raw"');
    expect(text(res)).toContain('"ui" or "api"');
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });

  it('action:"strip" refuses format:"ui" and names its two valid values', async () => {
    const res = await get()({ action: "strip", graph: UI_GRAPH, format: "ui" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"strip" does not accept format:"ui"');
    expect(text(res)).toContain('"api" or "raw"');
    expect(mocks.convertUiToApi).not.toHaveBeenCalled();
  });

  it("both halves still accept their own values", async () => {
    libraryReturns(API_GRAPH);
    expect((await get()({ action: "get", filename: "a.json", format: "ui" })).isError).toBeUndefined();
    const raw = await get()({ action: "strip", graph: UI_GRAPH, format: "raw" });
    expect(raw.isError).toBeUndefined();
    expect(JSON.parse(text(raw))).toEqual(UI_GRAPH);
  });
});

describe("the nine retired library names", () => {
  const readNames = [
    "list_workflows",
    "strip_workflow",
    "slice_workflow",
    "workflow_from_image",
    "analyze_workflow",
    "query_workflow",
    "prompt_director_inspect",
  ];
  const writeNames = ["lock_workflow", "verify_workflow_lock"];

  it("each retired read name is in DEAD_NAMES pointing at `get_workflow`", () => {
    for (const name of readNames) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.50.0");
      expect(entry!.replacement).toContain("get_workflow");
    }
  });

  it("each retired write name is in DEAD_NAMES pointing at `save_workflow`", () => {
    for (const name of writeNames) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.50.0");
      expect(entry!.replacement).toContain("save_workflow");
    }
  });

  it("no old name is still in the live ledger, and both survivors are", () => {
    for (const name of [...readNames, ...writeNames]) {
      expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    }
    expect(TOOL_NAMES as readonly string[]).toContain("get_workflow");
    expect(TOOL_NAMES as readonly string[]).toContain("save_workflow");
  });
});

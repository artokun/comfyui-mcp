import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock template resolution (skills-access) + enqueue + status/history; keep
// override parsing + modifyWorkflow (set_input) real so we test the actual
// "resolve → apply overrides → enqueue" path end to end.
const resolvePackWorkflowFileMock = vi.fn<(name: string) => string | null>();
const enumeratePacksMock = vi.fn(() => [
  { name: "anima-txt2img", has_workflow: true },
  { name: "anima-img2img", has_workflow: true },
  { name: "krea2-txt2img", has_workflow: true },
]);
vi.mock("../../tools/skills-access.js", () => ({
  resolvePackWorkflowFile: (...a: [string]) => resolvePackWorkflowFileMock(...a),
  enumeratePacks: () => enumeratePacksMock(),
}));

const enqueueWorkflowMock = vi.fn(async () => ({
  prompt_id: "rt-prompt-1",
  queue_remaining: 0,
}));
vi.mock("../../services/workflow-executor.js", () => ({
  enqueueWorkflow: (...a: unknown[]) => enqueueWorkflowMock(...a),
}));

const getJobStatusMock = vi.fn();
vi.mock("../../services/queue-manager.js", () => ({
  getJobStatus: (...a: unknown[]) => getJobStatusMock(...a),
}));

const getHistoryMock = vi.fn();
const getObjectInfoMock = vi.fn(async () => ({}));
vi.mock("../../comfyui/client.js", () => ({
  getHistory: (...a: unknown[]) => getHistoryMock(...a),
  getObjectInfo: () => getObjectInfoMock(),
}));

import { registerRunTemplateTools } from "../../tools/run-template.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function getHandler(): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => {
      if (n === "run_template") handler = h;
    },
  };
  registerRunTemplateTools(server as never);
  if (!handler) throw new Error("run_template not registered");
  return handler;
}

// A minimal API-format template graph on disk (what resolvePackWorkflowFile returns).
const TEMPLATE_GRAPH = {
  "3": {
    class_type: "KSampler",
    inputs: { seed: 1, steps: 20, cfg: 7, model: ["4", 0], positive: ["6", 0] },
  },
  "6": {
    class_type: "CLIPTextEncode",
    // `size` is an ARRAY-valued widget whose first element is NOT a node id —
    // it must be overridable (not misclassified as a graph connection).
    inputs: { text: "default prompt", size: [1024, 1024], clip: ["4", 1] },
  },
};

const dir = mkdtempSync(join(tmpdir(), "run-template-"));
const wfFile = join(dir, "workflow.json");
writeFileSync(wfFile, JSON.stringify(TEMPLATE_GRAPH));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  resolvePackWorkflowFileMock.mockReset().mockReturnValue(wfFile);
  enqueueWorkflowMock.mockClear();
  getJobStatusMock.mockReset();
  getHistoryMock.mockReset();
});

describe("run_template", () => {
  it("applies '<nodeId>.<widget>' overrides so the ENQUEUED workflow reflects them", async () => {
    const handler = getHandler();

    const res = await handler({
      template: "anima-txt2img",
      overrides: { "6.text": "a red fox in snow", "3.steps": 8, "3.cfg": 1.5 },
    });

    expect(res.isError).toBeFalsy();
    expect(enqueueWorkflowMock).toHaveBeenCalledTimes(1);
    const enqueued = enqueueWorkflowMock.mock.calls[0][0] as typeof TEMPLATE_GRAPH;
    expect(enqueued["6"].inputs.text).toBe("a red fox in snow");
    expect(enqueued["3"].inputs.steps).toBe(8);
    expect(enqueued["3"].inputs.cfg).toBe(1.5);
    // untouched slots + wiring survive
    expect(enqueued["3"].inputs.model).toEqual(["4", 0]);
    expect(enqueued["6"].inputs.clip).toEqual(["4", 1]);

    const out = JSON.parse(res.content[0].text);
    expect(out.prompt_id).toBe("rt-prompt-1");
    expect(out.status).toBe("enqueued");
    expect(out.overrides_applied).toEqual(["6.text", "3.steps", "3.cfg"]);
  });

  it("enqueues the template unmodified when no overrides given", async () => {
    const handler = getHandler();
    const res = await handler({ template: "anima-txt2img" });
    expect(res.isError).toBeFalsy();
    const enqueued = enqueueWorkflowMock.mock.calls[0][0] as typeof TEMPLATE_GRAPH;
    expect(enqueued["6"].inputs.text).toBe("default prompt");
  });

  it("errors with near-matches when the template does not resolve", async () => {
    resolvePackWorkflowFileMock.mockReturnValue(null);
    const handler = getHandler();

    const res = await handler({ template: "anima-txt2mg" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/No template named .{0,2}anima-txt2mg/);
    expect(res.content[0].text).toMatch(/anima-txt2img/);
    expect(enqueueWorkflowMock).not.toHaveBeenCalled();
  });

  it("rejects override keys without the nodeId.widget shape", async () => {
    const handler = getHandler();
    const res = await handler({ template: "anima-txt2img", overrides: { steps: 8 } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/<nodeId>\.<widget_name>/);
    expect(enqueueWorkflowMock).not.toHaveBeenCalled();
  });

  it("rejects overrides naming a missing node or widget, listing what exists", async () => {
    const handler = getHandler();

    const badNode = await handler({ template: "anima-txt2img", overrides: { "99.text": "x" } });
    expect(badNode.isError).toBe(true);
    expect(badNode.content[0].text).toMatch(/no node .{0,2}99/);

    const badWidget = await handler({ template: "anima-txt2img", overrides: { "6.nope": "x" } });
    expect(badWidget.isError).toBe(true);
    expect(badWidget.content[0].text).toMatch(/has no input .{0,2}nope/);
    expect(badWidget.content[0].text).toMatch(/text/); // lists available inputs
    expect(enqueueWorkflowMock).not.toHaveBeenCalled();
  });

  it("allows overriding an array-valued widget (not a link — first element isn't a node id)", async () => {
    const handler = getHandler();
    const res = await handler({
      template: "anima-txt2img",
      overrides: { "6.size": [512, 768] },
    });
    expect(res.isError).toBeFalsy();
    const enqueued = enqueueWorkflowMock.mock.calls[0][0] as typeof TEMPLATE_GRAPH;
    expect(enqueued["6"].inputs.size).toEqual([512, 768]);
  });

  it("rejects overrides targeting a graph CONNECTION (link) input", async () => {
    const handler = getHandler();
    // "3.positive" is ["6", 0] and node "6" exists → a real connection.
    const res = await handler({ template: "anima-txt2img", overrides: { "3.positive": "x" } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/CONNECTION/);
    expect(res.content[0].text).toMatch(/seed/); // lists overridable widgets
    expect(enqueueWorkflowMock).not.toHaveBeenCalled();
  });

  it("wait:true polls to completion and returns outputs", async () => {
    getJobStatusMock
      .mockResolvedValueOnce({ running: true, pending: false, done: false })
      .mockResolvedValue({ running: false, pending: false, done: true });
    getHistoryMock.mockResolvedValue({
      "rt-prompt-1": {
        outputs: { "9": { images: [{ filename: "fox.png", type: "output" }] } },
      },
    });
    const handler = getHandler();

    const p = handler({ template: "anima-txt2img", wait: true, timeout_s: 30 });
    // first poll: not done → 1.5s sleep → second poll: done
    await vi.waitFor(async () => {
      const res = await p;
      const out = JSON.parse(res.content[0].text);
      expect(out.status).toBe("completed");
      expect(out.outputs["9"].images[0].filename).toBe("fox.png");
    }, { timeout: 10000 });
  }, 15000);
});

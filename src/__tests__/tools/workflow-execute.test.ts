import { describe, expect, it, beforeEach, vi } from "vitest";

/**
 * `enqueue_workflow` — the five-action enqueue surface (0.50.0 slice 16).
 *
 * The registration layer is the only genuinely NEW code in a consolidation
 * slice, so this file tests the DISPATCHER rather than the services beneath it:
 * schema shape, which service each action reaches with which arguments,
 * per-action missing-field errors that NAME the field, unknown-action
 * rejection, and absence-not-falsiness.
 *
 * The behavioural coverage of the folded tools lives on unchanged in
 * rerun-generation.test.ts, run-workflow-url.test.ts, run-template.test.ts and
 * html-instead-of-json.test.ts, all of which now drive this tool through its
 * actions.
 */

const enqueueWorkflowMock = vi.fn(async () => ({
  prompt_id: "p-1",
  queue_remaining: 0,
}));
const getSystemInfoMock = vi.fn(async () => ({ ok: true }));
vi.mock("../../services/workflow-executor.js", () => ({
  enqueueWorkflow: (...a: unknown[]) => enqueueWorkflowMock(...a),
  getSystemInfo: (...a: unknown[]) => getSystemInfoMock(...a),
}));

const getHistoryMock = vi.fn(async () => ({}));
vi.mock("../../comfyui/client.js", () => ({
  getHistory: (...a: unknown[]) => getHistoryMock(...a),
  getObjectInfo: async () => ({}),
  backfillObjectInfo: async () => ({}),
}));

vi.mock("../../services/generation-tracker.js", () => ({
  getTracker: () => ({
    fileHasher: {},
    logGeneration: () => ({ settingsHash: "x", reuseCount: 0 }),
  }),
}));
vi.mock("../../services/workflow-settings-extractor.js", () => ({
  extractSettings: async () => null,
}));

// The three folded action modules are mocked so this file asserts DISPATCH —
// that the right function is reached with the right arguments — without pulling
// in the URL fetcher, the pack resolver or the template slot extractor.
const runWorkflowUrlMock = vi.fn(async () => ({
  content: [{ type: "text" as const, text: "url-result" }],
}));
vi.mock("../../tools/workflow-url.js", () => ({
  runWorkflowUrlAction: (...a: unknown[]) => runWorkflowUrlMock(...a),
}));
const templateSchemaMock = vi.fn(async () => ({
  content: [{ type: "text" as const, text: "schema-result" }],
}));
vi.mock("../../tools/template-schema.js", () => ({
  templateSchemaAction: (...a: unknown[]) => templateSchemaMock(...a),
}));
const runTemplateMock = vi.fn(async () => ({
  content: [{ type: "text" as const, text: "template-result" }],
}));
vi.mock("../../tools/run-template.js", () => ({
  runTemplateAction: (...a: unknown[]) => runTemplateMock(...a),
}));

import { z } from "zod";
import { registerWorkflowExecuteTools } from "../../tools/workflow-execute.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function capture(): { handler: ToolHandler; schema: Record<string, z.ZodTypeAny> } {
  let handler: ToolHandler | undefined;
  let schema: Record<string, z.ZodTypeAny> | undefined;
  const server = {
    tool: (n: string, _d: string, s: Record<string, z.ZodTypeAny>, h: ToolHandler) => {
      if (n === "enqueue_workflow") {
        handler = h;
        schema = s;
      }
    },
  };
  registerWorkflowExecuteTools(server as never);
  if (!handler || !schema) throw new Error("enqueue_workflow not registered");
  return { handler, schema };
}

const GRAPH = { "1": { class_type: "KSampler", inputs: { seed: 1 } } };

const HISTORY = {
  "src-1": {
    prompt: [1, "src-1", GRAPH, {}, []],
    outputs: {},
    status: { status_str: "success", completed: true, messages: [] },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  enqueueWorkflowMock.mockResolvedValue({ prompt_id: "p-1", queue_remaining: 0 });
  getHistoryMock.mockResolvedValue(HISTORY as never);
});

describe("enqueue_workflow — schema shape", () => {
  it("makes `action` the ONLY required field", () => {
    const { schema } = capture();
    const optional = Object.entries(schema)
      .filter(([name]) => name !== "action")
      .filter(([, s]) => !s.safeParse(undefined).success)
      .map(([name]) => name);
    expect(optional, "these are schema-required besides `action`").toEqual([]);
    expect(schema.action.safeParse(undefined).success).toBe(false);
  });

  it("exposes its parameters (a discriminated union would render zero)", () => {
    const { schema } = capture();
    // The whole reason the shape is a flat enum: z.toJSONSchema of a
    // discriminatedUnion hides every field from the model.
    const json = z.toJSONSchema(z.object(schema), { io: "input", unrepresentable: "any" }) as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(json.properties ?? {})).toEqual(
      expect.arrayContaining([
        "action",
        "workflow",
        "prompt_id",
        "url",
        "run",
        "template",
        "overrides",
        "wait",
        "timeout_s",
        "inputs",
        "disable_random_seed",
      ]),
    );
  });

  it("accepts exactly the five actions and rejects anything else at the zod layer", () => {
    const { schema } = capture();
    for (const a of ["enqueue", "rerun", "run_url", "template_schema", "run_template"]) {
      expect(schema.action.safeParse(a).success, a).toBe(true);
    }
    expect(schema.action.safeParse("run").success).toBe(false);
  });

  it("keeps every VALUE constraint the old tools had", () => {
    const { schema } = capture();
    // the template-run action's timeout_s was .positive()
    expect(schema.timeout_s.safeParse(0).success).toBe(false);
    expect(schema.timeout_s.safeParse(30).success).toBe(true);
    // template was .min(1)
    expect(schema.template.safeParse("").success).toBe(false);
    // run_url's `run` keeps its default
    expect(schema.run.parse(undefined)).toBe(false);
  });
});

describe("enqueue_workflow — per-action dispatch", () => {
  it('action:"enqueue" submits the given graph', async () => {
    const { handler } = capture();
    const res = await handler({ action: "enqueue", workflow: GRAPH, disable_random_seed: true });
    expect(enqueueWorkflowMock).toHaveBeenCalledWith(GRAPH, { disable_random_seed: true });
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      status: "enqueued",
      prompt_id: "p-1",
    });
  });

  it('action:"rerun" reads history and re-enqueues the recorded graph', async () => {
    const { handler } = capture();
    const res = await handler({ action: "rerun", prompt_id: "src-1", inputs: { cfg: 9 } });
    expect(getHistoryMock).toHaveBeenCalledWith("src-1");
    expect(enqueueWorkflowMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res.content[0].text).source_prompt_id).toBe("src-1");
  });

  it('action:"run_url" reaches the URL handler with url/run/inputs and nothing else', async () => {
    const { handler } = capture();
    const res = await handler({
      action: "run_url",
      url: "https://example.com/wf.json",
      run: true,
      inputs: { cfg: 4 },
      // fields belonging to OTHER actions must not leak through
      template: "anima-txt2img",
      workflow: GRAPH,
    });
    expect(runWorkflowUrlMock).toHaveBeenCalledWith({
      url: "https://example.com/wf.json",
      run: true,
      inputs: { cfg: 4 },
    });
    expect(res.content[0].text).toBe("url-result");
  });

  it('action:"template_schema" reaches the schema handler with only `template`', async () => {
    const { handler } = capture();
    const res = await handler({ action: "template_schema", template: "anima-txt2img", wait: true });
    expect(templateSchemaMock).toHaveBeenCalledWith({ template: "anima-txt2img" });
    expect(res.content[0].text).toBe("schema-result");
  });

  it('action:"run_template" forwards the template arguments', async () => {
    const { handler } = capture();
    const res = await handler({
      action: "run_template",
      template: "anima-txt2img",
      overrides: { "6.text": "a fox" },
      wait: true,
      timeout_s: 60,
      disable_random_seed: true,
    });
    expect(runTemplateMock).toHaveBeenCalledWith({
      template: "anima-txt2img",
      overrides: { "6.text": "a fox" },
      wait: true,
      timeout_s: 60,
      disable_random_seed: true,
    });
    expect(res.content[0].text).toBe("template-result");
  });

  it("routes each action to EXACTLY ONE handler — no cross-talk", async () => {
    const { handler } = capture();
    const table: Array<[Record<string, unknown>, ReturnType<typeof vi.fn>]> = [
      [{ action: "run_url", url: "https://e.com/w.json" }, runWorkflowUrlMock],
      [{ action: "template_schema", template: "t" }, templateSchemaMock],
      [{ action: "run_template", template: "t" }, runTemplateMock],
    ];
    for (const [args, expected] of table) {
      vi.clearAllMocks();
      await handler(args);
      for (const m of [runWorkflowUrlMock, templateSchemaMock, runTemplateMock]) {
        expect(m.mock.calls.length, `${String(args.action)} → ${m.getMockName()}`).toBe(
          m === expected ? 1 : 0,
        );
      }
      // and none of the three template/url actions enqueues directly
      expect(enqueueWorkflowMock).not.toHaveBeenCalled();
    }
  });
});

describe("enqueue_workflow — missing-field errors NAME the field", () => {
  it.each([
    ["enqueue", "workflow"],
    ["run_url", "url"],
    ["template_schema", "template"],
    ["run_template", "template"],
  ])('action:"%s" without `%s` says which field is missing', async (action, field) => {
    const { handler } = capture();
    const res = await handler({ action });
    expect(res.isError).toBe(true);
    // errorToToolResult serializes to {error, message} JSON, so read the message
    // rather than substring-matching a payload whose quotes are escaped.
    const { message } = JSON.parse(res.content[0].text) as { message: string };
    expect(message).toContain(`\`${field}\``);
    expect(message).toContain(`action:"${action}"`);
  });

  it('action:"rerun" requires nothing — prompt_id is optional, as it always was', async () => {
    const { handler } = capture();
    const res = await handler({ action: "rerun" });
    expect(res.isError).toBeUndefined();
    expect(getHistoryMock).toHaveBeenCalledWith(undefined);
  });
});

describe("enqueue_workflow — absence, not falsiness", () => {
  it('an EMPTY url still reaches the fetch handler (it answers with its own error)', async () => {
    const { handler } = capture();
    const res = await handler({ action: "run_url", url: "" });
    expect(runWorkflowUrlMock).toHaveBeenCalledWith({
      url: "",
      run: undefined,
      inputs: undefined,
    });
    expect(res.content[0].text).toBe("url-result");
  });

  it("an EMPTY workflow object still reaches the enqueue service", async () => {
    const { handler } = capture();
    // {} is truthy in JS, so this is not the classic falsiness trap — but it IS
    // the "no nodes" case the executor answers for, and the guard must not
    // intercept it.
    await handler({ action: "enqueue", workflow: {} });
    expect(enqueueWorkflowMock).toHaveBeenCalledWith({}, { disable_random_seed: true });
  });

  it('action:"enqueue" never re-randomizes a caller-built graph (#865)', async () => {
    const { handler } = capture();
    // The flag is FORCED, not forwarded: every seed in a graph the caller built
    // is caller-fixed, and replacing one silently destroyed reproducible runs.
    // Passing disable_random_seed:false must not re-enable randomization.
    await handler({ action: "enqueue", workflow: GRAPH, disable_random_seed: false });
    expect(enqueueWorkflowMock).toHaveBeenCalledWith(GRAPH, { disable_random_seed: true });
  });

  it('action:"rerun" DOES forward the flag, and pins overridden inputs (#865)', async () => {
    const { handler } = capture();
    await handler({
      action: "rerun",
      prompt_id: "src-1",
      inputs: { seed: 42 },
      disable_random_seed: false,
    });
    expect(enqueueWorkflowMock).toHaveBeenCalledWith(expect.anything(), {
      disable_random_seed: false,
      preserve_seed_inputs: ["seed"],
    });
  });

  it("run:false is forwarded as false, not dropped as falsy", async () => {
    const { handler } = capture();
    await handler({ action: "run_url", url: "https://e.com/w.json", run: false });
    expect(runWorkflowUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ run: false }),
    );
  });

  it("timeout_s is forwarded verbatim so the service applies its own default", async () => {
    const { handler } = capture();
    await handler({ action: "run_template", template: "t" });
    expect(runTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeout_s: undefined }),
    );
  });
});

describe("enqueue_workflow — unknown action", () => {
  it("rejects an action the enum does not contain, listing the valid ones", async () => {
    const { handler } = capture();
    const res = await handler({ action: "run" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown enqueue_workflow action");
    // Built from the action array, so this asserts the error and the enum agree
    // rather than re-typing the list a third time.
    const { schema } = capture();
    const actions = (schema.action as unknown as { options: string[] }).options;
    expect(res.content[0].text).toContain(actions.join(", "));
    expect(enqueueWorkflowMock).not.toHaveBeenCalled();
  });
});

// 0.50.0 slice 13 moved get_system_stats OUT of this module into its own
// (src/tools/system-stats.ts), where it became a 3-action tool. It is still
// registered immediately AFTER this group in src/tools/index.ts, so tools/list
// order is unchanged — registry-surface.test.ts pins that. What this file must
// now assert is only the module boundary: enqueue_workflow no longer carries it.
describe("get_system_stats no longer belongs to this module (0.50.0 slice 13)", () => {
  it("registerWorkflowExecuteTools does not register it", () => {
    const names: string[] = [];
    const server = { tool: (n: string) => { names.push(n); } };
    registerWorkflowExecuteTools(server as never);
    expect(names).not.toContain("get_system_stats");
    expect(names).toContain("enqueue_workflow");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated `bisect` tool (0.49.0 slice 1): the five bisect_* tools folded
 * into one action-parameterized tool. This test proves the surface consolidation
 * did not change behaviour — every action still dispatches to the same service
 * function the old tool called — and that the flat-enum shape actually EXPOSES the
 * `action` parameter (the discriminated-union trap renders zero params).
 */

// Stub the service layer so we can assert dispatch without touching fs/network.
const svc = {
  bisectStart: vi.fn(async () => ({ state: { status: "running" }, message: "started" })),
  bisectGood: vi.fn(async () => ({ state: { status: "running" }, message: "good" })),
  bisectBad: vi.fn(async () => ({ state: { status: "resolved" }, message: "bad" })),
  bisectReset: vi.fn(async () => ({ state: { status: "idle" }, message: "reset" })),
  bisectStatus: vi.fn(() => ({ state: { status: "idle" }, message: "status" })),
};

vi.mock("../../services/node-bisect.js", () => svc);

type ToolHandler = (args: {
  action: "start" | "good" | "bad" | "reset" | "status";
}) => Promise<{ content: Array<{ type: string; text: string }> }>;

interface Registered {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  handler: ToolHandler;
}

/** Capture what registerNodeBisectTools() registers on a mock McpServer. */
async function register(): Promise<Registered[]> {
  const { registerNodeBisectTools } = await import("../../tools/node-bisect.js");
  const tools: Registered[] = [];
  const server = {
    tool(name: string, description: string, shape: z.ZodRawShape, handler: ToolHandler) {
      tools.push({ name, description, shape, handler });
      return { update() {}, remove() {}, enable() {}, disable() {} };
    },
  } as any;
  registerNodeBisectTools(server);
  return tools;
}

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockClear();
});

afterEach(() => {
  vi.resetModules();
});

describe("bisect tool registration", () => {
  it("registers exactly one tool named `bisect` (5→1)", async () => {
    const tools = await register();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("bisect");
  });

  // The whole reason for the flat-enum shape rule: a z.discriminatedUnion renders
  // as ZERO parameters, hiding `action` from the model. Assert the parameter is
  // actually present and is an enum of the five operations.
  it("exposes a visible `action` enum parameter (not a 0-param union)", async () => {
    const [{ shape }] = await register();
    expect(Object.keys(shape)).toEqual(["action"]);
    const json = z.toJSONSchema(z.object(shape)) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {})).toEqual(["action"]);
    expect(json.properties?.action.enum?.sort()).toEqual(
      ["bad", "good", "reset", "start", "status"],
    );
    expect(json.required).toContain("action");
  });
});

describe("bisect action dispatch", () => {
  const cases: Array<{
    action: "start" | "good" | "bad" | "reset" | "status";
    fn: keyof typeof svc;
  }> = [
    { action: "start", fn: "bisectStart" },
    { action: "good", fn: "bisectGood" },
    { action: "bad", fn: "bisectBad" },
    { action: "reset", fn: "bisectReset" },
    { action: "status", fn: "bisectStatus" },
  ];

  for (const { action, fn } of cases) {
    it(`action:"${action}" calls ${fn}() and returns its JSON`, async () => {
      const [{ handler }] = await register();
      const res = await handler({ action });
      // Exactly the mapped service function ran, and no other.
      expect(svc[fn]).toHaveBeenCalledTimes(1);
      for (const [name, other] of Object.entries(svc)) {
        if (name !== fn) expect(other).not.toHaveBeenCalled();
      }
      // Return shape preserved: a single text block of the service result JSON.
      expect(res.content).toHaveLength(1);
      expect(res.content[0].type).toBe("text");
      expect(JSON.parse(res.content[0].text)).toEqual({
        state: expect.any(Object),
        message: expect.any(String),
      });
    });
  }

  // Runtime requiredness: the enum is the contract, but the handler also guards
  // against an action that somehow slips past the schema, returning a clear error
  // result rather than an undefined dereference.
  it("an unknown action returns a clear error result", async () => {
    const [{ handler }] = await register();
    // Bypass the type to simulate a schema/handler drift.
    const res = await handler({ action: "bogus" as "start" });
    const text = res.content.map((c) => c.text).join(" ");
    expect(text).toMatch(/unknown bisect action/i);
    expect(text).toMatch(/start, good, bad, reset, status/);
    for (const fn of Object.values(svc)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("the five bisect_* names are retired", () => {
  const old = ["bisect_start", "bisect_good", "bisect_bad", "bisect_reset", "bisect_status"];

  it("each old name is in DEAD_NAMES with replacement `bisect`", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.49.0");
      expect(entry!.replacement).toContain("bisect");
    }
  });

  it("no old bisect_* name is still in the live ledger, and `bisect` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("bisect");
  });
});

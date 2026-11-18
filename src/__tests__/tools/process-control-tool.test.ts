import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated `restart_comfyui` tool (0.50.0 slice 7): the three
 * process-lifecycle tools folded into one action-parameterized tool. Proves the
 * consolidation did not change behaviour — every action calls the identical
 * process-control service the old tool called, with the same (empty) arguments
 * and the same content block — and that the flat-enum shape actually EXPOSES its
 * parameter (the discriminated-union trap renders zero params).
 *
 * PLATFORM IS PINNED. src/services/process-control.ts reads `IS_WIN` from
 * node:os at MODULE LOAD, and its POSIX stop path uses process.kill rather than
 * execSync — so a test that lets the platform be inherited asserts different
 * code on every CI runner. The service is fully factory-mocked below, which
 * already keeps it from loading; pinning node:os as well means that stays true
 * if the factory is ever narrowed to a partial mock, and makes this file's
 * result independent of the machine it runs on either way.
 */

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: () => "win32" };
});

const mocks = vi.hoisted(() => ({
  stopComfyUI: vi.fn(),
  startComfyUI: vi.fn(),
  restartComfyUI: vi.fn(),
  describeLifecycleStatus: vi.fn(),
}));

vi.mock("../../services/process-control.js", () => ({
  stopComfyUI: (...args: unknown[]) => mocks.stopComfyUI(...args),
  startComfyUI: (...args: unknown[]) => mocks.startComfyUI(...args),
  restartComfyUI: (...args: unknown[]) => mocks.restartComfyUI(...args),
  describeLifecycleStatus: (...args: unknown[]) => mocks.describeLifecycleStatus(...args),
}));

import { registerProcessControlTools } from "../../tools/process-control.js";

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
  registerProcessControlTools(server as never);
  return tools;
}

/** The whole process-control surface is now ONE tool (0.50.0 slice 7). */
function handler(): Handler {
  const tools = registered();
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("restart_comfyui");
  return tools[0].handler;
}

const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("restart_comfyui registration", () => {
  it("registers exactly one tool named `restart_comfyui` (3→1)", () => {
    const tools = registered();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("restart_comfyui");
  });

  // The whole reason for the flat-enum shape rule: a z.discriminatedUnion renders
  // as ZERO parameters, hiding every input from the model.
  it("exposes a visible flat `action` enum, and `action` is the only field", () => {
    const [{ shape }] = registered();
    // io: "input" — the conversion options the MCP SDK itself uses
    // (sdk/server/zod-json-schema-compat.js, asserted by docs-schema-parity.test.ts),
    // so this is the schema a client is actually given.
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    // All three retired tools took NO parameters, so unlike the other slice-7
    // folds there is nothing else to expose — and nothing to presence-guard.
    expect(Object.keys(json.properties ?? {})).toEqual(["action"]);
    expect(json.properties?.action.enum?.slice().sort()).toEqual(["restart", "start", "status", "stop"]);
    expect(json.required).toEqual(["action"]);
  });

  it("an unknown action returns a clear error result and starts nothing", async () => {
    const res = await handler()({ action: "reboot" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unknown restart_comfyui action/i);
    expect(text(res)).toMatch(/restart, start, stop, status/);
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });

  // A missing `action` is rejected by the zod enum at the SDK boundary, but the
  // handler is also reached directly by the compact-mode router, so it must not
  // silently fall through to a default operation. Stopping ComfyUI because a
  // caller omitted a field would be a destructive surprise.
  it("a missing action does not default to any operation", async () => {
    const res = await handler()({});
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unknown restart_comfyui action/i);
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });
});

describe("restart_comfyui actions call the same services with the same arguments", () => {
  it('action:"restart" returns the restart result JSON', async () => {
    mocks.restartComfyUI.mockResolvedValueOnce({ restarted: true, port: 8188 });
    const res = await handler()({ action: "restart" });
    expect(mocks.restartComfyUI).toHaveBeenCalledWith();
    expect(mocks.startComfyUI).not.toHaveBeenCalled();
    expect(mocks.stopComfyUI).not.toHaveBeenCalled();
    expect(JSON.parse(text(res))).toEqual({ restarted: true, port: 8188 });
  });

  it('action:"start" returns the start result JSON', async () => {
    mocks.startComfyUI.mockResolvedValueOnce({ started: true, url: "http://127.0.0.1:8188" });
    const res = await handler()({ action: "start" });
    expect(mocks.startComfyUI).toHaveBeenCalledWith();
    expect(mocks.restartComfyUI).not.toHaveBeenCalled();
    expect(mocks.stopComfyUI).not.toHaveBeenCalled();
    expect(JSON.parse(text(res))).toEqual({ started: true, url: "http://127.0.0.1:8188" });
  });

  it('action:"stop" returns the stop result JSON', async () => {
    mocks.stopComfyUI.mockResolvedValueOnce({ stopped: true, has_restart_info: true, message: "ok" });
    const res = await handler()({ action: "stop" });
    expect(mocks.stopComfyUI).toHaveBeenCalledWith();
    expect(mocks.startComfyUI).not.toHaveBeenCalled();
    expect(mocks.restartComfyUI).not.toHaveBeenCalled();
    expect(JSON.parse(text(res))).toEqual({
      stopped: true,
      has_restart_info: true,
      message: "ok",
    });
  });

  // #2948: the read-only query dispatches ONLY to the status service — never to a
  // service that stops, starts or restarts anything.
  it('action:"status" returns the read-only lifecycle status and touches no other service', async () => {
    mocks.describeLifecycleStatus.mockResolvedValueOnce({ read_only: true, summary: "s" });
    const res = await handler()({ action: "status" });
    expect(mocks.describeLifecycleStatus).toHaveBeenCalledWith();
    expect(mocks.stopComfyUI).not.toHaveBeenCalled();
    expect(mocks.startComfyUI).not.toHaveBeenCalled();
    expect(mocks.restartComfyUI).not.toHaveBeenCalled();
    expect(JSON.parse(text(res))).toEqual({ read_only: true, summary: "s" });
  });

  // The services throw ProcessControlError for remote/cloud targets and for a
  // refused stop; the tool's only job is to keep surfacing that as isError text.
  it("a service refusal is still reported as an error result, unchanged", async () => {
    mocks.stopComfyUI.mockRejectedValueOnce(
      new Error("operates on the local machine's ComfyUI process"),
    );
    const res = await handler()({ action: "stop" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/local machine's ComfyUI process/);
  });
});

describe("the two process-control names are retired", () => {
  const old = ["start_comfyui", "stop_comfyui"];

  it("each old name is in DEAD_NAMES with a `restart_comfyui` action replacement", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.50.0");
      expect(entry!.replacement).toContain("restart_comfyui");
    }
    expect(DEAD_NAMES.find((d) => d.name === "start_comfyui")!.replacement).toContain('"start"');
    expect(DEAD_NAMES.find((d) => d.name === "stop_comfyui")!.replacement).toContain('"stop"');
  });

  it("no old name is still in the live ledger, and `restart_comfyui` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("restart_comfyui");
  });
});

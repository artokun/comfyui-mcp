import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated `get_system_stats` tool (0.50.0 slice 13): the three
 * server-READ tools folded into one action-parameterized tool. Proves the
 * consolidation did not change behaviour — every action calls the identical
 * service the old tool called, with the same arguments and the same content
 * block — and that the flat-enum shape actually EXPOSES its parameters (the
 * discriminated-union trap renders zero params).
 *
 * The slice originally folded six. Review took the RFC's fallback for
 * `clear_vram`, `report_issue` and `calculate`, which stay standalone; the last
 * test here pins that they are still LIVE, because "we decided not to retire it"
 * has to be enforced somewhere or a later change quietly re-retires them.
 */

const mocks = vi.hoisted(() => ({
  getSystemInfo: vi.fn(),
  getLogs: vi.fn(),
  runHealthCheck: vi.fn(),
}));

vi.mock("../../services/workflow-executor.js", () => ({
  getSystemInfo: (...a: unknown[]) => mocks.getSystemInfo(...a),
  enqueueWorkflow: vi.fn(),
}));
vi.mock("../../comfyui/client.js", () => ({
  getLogs: (...a: unknown[]) => mocks.getLogs(...a),
  getHistory: vi.fn(),
  getSystemStats: vi.fn(),
  getClient: vi.fn(),
}));
vi.mock("../../services/health-check.js", () => ({
  runHealthCheck: (...a: unknown[]) => mocks.runHealthCheck(...a),
}));

import { registerSystemStatsTools } from "../../tools/system-stats.js";

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
  registerSystemStatsTools(server as never);
  return tools;
}

/** The whole server-read surface is now ONE tool (0.50.0 slice 13). */
function handler(): Handler {
  const tools = registered();
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("get_system_stats");
  return tools[0].handler;
}

/** Parse through the real shape first, so a call means what a client's call means. */
function call(args: Record<string, unknown>) {
  const [{ shape }] = registered();
  const parsed = z.object(shape).parse(args) as Record<string, unknown>;
  return handler()(parsed);
}

const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("get_system_stats registration", () => {
  it("registers exactly one tool named `get_system_stats` (3→1)", () => {
    const tools = registered();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("get_system_stats");
  });

  // The whole reason for the flat-enum shape rule: a z.discriminatedUnion renders
  // as ZERO parameters, hiding every input from the model.
  it("exposes a visible flat `action` enum with every per-action parameter", () => {
    const [{ shape }] = registered();
    // io: "input" — the conversion options the MCP SDK itself uses
    // (sdk/server/zod-json-schema-compat.js, asserted by docs-schema-parity.test.ts),
    // so this is the schema a client is actually given.
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action",
      "keyword",
      "max_lines",
      "model_categories",
      "recent_errors",
    ]);
    expect(json.properties?.action.enum?.slice().sort()).toEqual(["health", "logs", "stats"]);
    // Only `action` can be required. Nothing else on this tool is required by
    // ANY action, so there is no presence guard to write — inventing one would
    // be a refusal the retired tools never had.
    expect(json.required).toEqual(["action"]);
  });

  it("an unknown action returns a clear error result naming the live actions", async () => {
    const res = await handler()({ action: "bogus" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unknown get_system_stats action/i);
    expect(text(res)).toContain("Expected one of: stats, logs, health.");
  });

  // That message is BUILT from the action array, so it cannot drift from the
  // enum — asserting it against the enum rather than a second hand-written list
  // is what makes "cannot drift" true rather than merely claimed.
  it("the unknown-action message lists exactly the enum's members, in order", async () => {
    const [{ shape }] = registered();
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
    };
    const res = await handler()({ action: "bogus" });
    expect(text(res)).toContain(
      `Expected one of: ${(json.properties?.action.enum ?? []).join(", ")}.`,
    );
  });
});

describe("get_system_stats actions call the same services with the same arguments", () => {
  it('action:"stats" returns the raw /system_stats JSON', async () => {
    mocks.getSystemInfo.mockResolvedValueOnce({ devices: [{ name: "RTX 4090" }] });
    const res = await call({ action: "stats" });
    expect(mocks.getSystemInfo).toHaveBeenCalledTimes(1);
    expect(JSON.parse(text(res))).toEqual({ devices: [{ name: "RTX 4090" }] });
    expect(mocks.getLogs).not.toHaveBeenCalled();
    expect(mocks.runHealthCheck).not.toHaveBeenCalled();
  });

  // #1223 — the keyword filter and the tail MOVED into getLogs, so they run on
  // the raw log before redaction. Filtering here matched against text the scrub
  // had already rewritten, and answered "No log lines found" for lines that were
  // right there. What this tool still owns is FORWARDING them, and the selection
  // semantics themselves are tested in log-select-order.test.ts.
  it('action:"logs" forwards the keyword and the tail to getLogs', async () => {
    mocks.getLogs.mockResolvedValueOnce([]);
    await call({ action: "logs", keyword: "error", max_lines: 2 });
    expect(mocks.getLogs).toHaveBeenCalledWith({ keyword: "error", maxLines: 2 });
  });

  it('action:"logs" forwards the DEFAULT tail of 100 when max_lines is omitted', async () => {
    // The default has to reach getLogs now — leaving it undefined would return
    // the whole log, which is the #1146 shape (an omitted limit meaning "all").
    mocks.getLogs.mockResolvedValueOnce([]);
    await call({ action: "logs" });
    expect(mocks.getLogs).toHaveBeenCalledWith({ keyword: undefined, maxLines: 100 });
  });

  it('action:"logs" strips ANSI from what comes back', async () => {
    mocks.getLogs.mockResolvedValueOnce(["\x1b[31mERROR one\x1b[0m"]);
    expect(text(await call({ action: "logs" }))).toBe("ERROR one");
  });

  it('action:"logs" reports the keyword back when nothing matched', async () => {
    mocks.getLogs.mockResolvedValueOnce([]);
    const res = await call({ action: "logs", keyword: "traceback" });
    expect(text(res)).toBe('No log lines found matching "traceback".');
  });

  it('action:"health" forwards the two health options under their service names', async () => {
    mocks.runHealthCheck.mockResolvedValueOnce("all good");
    const res = await call({
      action: "health",
      model_categories: ["checkpoints"],
      recent_errors: 5,
    });
    expect(mocks.runHealthCheck).toHaveBeenCalledWith({
      modelCategories: ["checkpoints"],
      recentErrors: 5,
    });
    expect(text(res)).toBe("all good");
  });

  it('action:"health" passes undefined through when the options are omitted', async () => {
    mocks.runHealthCheck.mockResolvedValueOnce("all good");
    await call({ action: "health" });
    expect(mocks.runHealthCheck).toHaveBeenCalledWith({
      modelCategories: undefined,
      recentErrors: undefined,
    });
  });
});

describe("value constraints are unchanged at the zod layer", () => {
  // These are the only refusals this tool has. They must come from zod, exactly
  // where they came from before — not from a handler guard invented by the fold.
  it("rejects an out-of-range max_lines and recent_errors, and accepts the edges", () => {
    const [{ shape }] = registered();
    const s = z.object(shape);
    expect(s.safeParse({ action: "logs", max_lines: 0 }).success).toBe(false);
    expect(s.safeParse({ action: "logs", max_lines: 2001 }).success).toBe(false);
    expect(s.safeParse({ action: "logs", max_lines: 1 }).success).toBe(true);
    expect(s.safeParse({ action: "logs", max_lines: 2000 }).success).toBe(true);
    expect(s.safeParse({ action: "health", recent_errors: -1 }).success).toBe(false);
    expect(s.safeParse({ action: "health", recent_errors: 201 }).success).toBe(false);
    // ZERO is a legal value, not "unset": it means include no error lines.
    expect(s.safeParse({ action: "health", recent_errors: 0 }).success).toBe(true);
  });

  // ABSENCE, not falsiness — the same rule the guarded tools follow, here as a
  // pass-through: recent_errors:0 must reach the service AS 0.
  it("recent_errors:0 reaches the service as 0, not as undefined", async () => {
    mocks.runHealthCheck.mockResolvedValueOnce("all good");
    await call({ action: "health", recent_errors: 0 });
    expect(mocks.runHealthCheck).toHaveBeenCalledWith({
      modelCategories: undefined,
      recentErrors: 0,
    });
  });

  // ...and an explicit max_lines of the schema minimum must not be mistaken for
  // "unset" and replaced by the 100 default.
  it("max_lines:1 reaches getLogs as 1 rather than falling back to the default", async () => {
    mocks.getLogs.mockResolvedValueOnce([]);
    await call({ action: "logs", max_lines: 1 });
    expect(mocks.getLogs).toHaveBeenCalledWith({ keyword: undefined, maxLines: 1 });
  });
});

describe("the two retired stats/diagnostics names", () => {
  const old = ["get_logs", "health_check"];

  it("each old name is in DEAD_NAMES with a `get_system_stats` replacement", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.50.0");
      expect(entry!.replacement).toContain("get_system_stats");
    }
  });

  it("no old name is still in the live ledger, and `get_system_stats` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("get_system_stats");
  });

  // The fallback the owner took, pinned. `clear_vram` is the OOM panic button,
  // `report_issue` files a PUBLIC GitHub issue, and `calculate` is a pure
  // offline utility: all three were judged wrong to bury behind an action on a
  // tool named "get system stats". They stay LIVE and retire nothing, and a
  // later change that folds them anyway has to delete this test to do it.
  it("clear_vram, report_issue and calculate stay standalone and are NOT retired", () => {
    for (const name of ["clear_vram", "report_issue", "calculate"]) {
      expect(TOOL_NAMES as readonly string[]).toContain(name);
      expect(DEAD_NAMES.find((d) => d.name === name)).toBeUndefined();
    }
  });
});

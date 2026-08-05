import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The pending-operation marker is a REAL file (panel-pin-guard). Point it at a
// temp path at MODULE scope so the suite never touches ~/.comfyui-mcp, and so
// parallel vitest workers get their own file instead of racing on one.
//
// Without this, every call here wrote live pending-op markers into the developer's
// own state, where the orchestrator reads them and warns on every pin write that a
// queued update or deferred restore may be outstanding. Same class as #837 (the
// suite writing to the real .env) and #859 (the real OAuth mirror).
process.env.COMFYUI_MCP_PANEL_PENDING = join(
  tmpdir(),
  `cmcp-pending-snapshots-tool-${process.pid}.json`,
);


/**
 * The consolidated `node_snapshot` tool (0.49.0 slice 2): save/restore/list
 * folded into one action-parameterized tool. Proves the consolidation did not
 * change behaviour — every action dispatches to the same service function the old
 * tool called, with the same arguments — and that the flat-enum shape actually
 * EXPOSES its parameters (the discriminated-union trap renders zero params).
 */

const svc = {
  saveNodeSnapshot: vi.fn(async (_name?: string) => ({ ok: true, snapshot: "snap-1" })),
  restoreNodeSnapshot: vi.fn(async (_name: string) => ({ ok: true, restored: "snap-1" })),
  listNodeSnapshots: vi.fn(async () => ({
    snapshots: ["snap-1", "snap-2"] as string[],
    unsupported: false as boolean,
    message: undefined as string | undefined,
  })),
};

vi.mock("../../services/node-snapshots.js", () => svc);

type Args = { action: "list" | "save" | "restore"; name?: string };
type ToolHandler = (
  args: Args,
) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;

interface Registered {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  handler: ToolHandler;
}

async function register(): Promise<Registered[]> {
  const { registerNodeSnapshotsTools } = await import("../../tools/node-snapshots.js");
  const tools: Registered[] = [];
  const server = {
    tool(name: string, description: string, shape: z.ZodRawShape, handler: ToolHandler) {
      tools.push({ name, description, shape, handler });
      return { update() {}, remove() {}, enable() {}, disable() {} };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  registerNodeSnapshotsTools(server);
  return tools;
}

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockClear();
  svc.listNodeSnapshots.mockResolvedValue({
    snapshots: ["snap-1", "snap-2"],
    unsupported: false,
    message: undefined,
  });
});

afterEach(() => {
  vi.resetModules();
});

describe("node_snapshot registration", () => {
  it("registers exactly one tool named `node_snapshot` (3→1)", async () => {
    const tools = await register();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("node_snapshot");
  });

  it("exposes a visible flat `action` enum plus `name` (not a 0-param union)", async () => {
    const [{ shape }] = await register();
    expect(Object.keys(shape).sort()).toEqual(["action", "name"]);
    const json = z.toJSONSchema(z.object(shape)) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual(["action", "name"]);
    expect(json.properties?.action.enum?.sort()).toEqual(["list", "restore", "save"]);
    // Only `action` can be required: `name` is required for restore, optional for
    // save and unused by list, so its presence is enforced in the handler.
    expect(json.required).toEqual(["action"]);
  });
});

describe("node_snapshot action dispatch", () => {
  it('action:"save" forwards an optional name', async () => {
    const [{ handler }] = await register();
    await handler({ action: "save" });
    expect(svc.saveNodeSnapshot).toHaveBeenCalledWith(undefined);
    svc.saveNodeSnapshot.mockClear();
    const res = await handler({ action: "save", name: "my-snap" });
    expect(svc.saveNodeSnapshot).toHaveBeenCalledWith("my-snap");
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true, snapshot: "snap-1" });
    expect(svc.restoreNodeSnapshot).not.toHaveBeenCalled();
    expect(svc.listNodeSnapshots).not.toHaveBeenCalled();
  });

  it('action:"restore" forwards the name and returns the service JSON', async () => {
    const [{ handler }] = await register();
    const res = await handler({ action: "restore", name: "snap-2" });
    expect(svc.restoreNodeSnapshot).toHaveBeenCalledWith("snap-2");
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true, restored: "snap-1" });
    expect(svc.saveNodeSnapshot).not.toHaveBeenCalled();
  });

  it('action:"restore" without a name is a clear error, and calls nothing', async () => {
    const [{ handler }] = await register();
    const res = await handler({ action: "restore" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/requires `name`/);
    for (const fn of Object.values(svc)) expect(fn).not.toHaveBeenCalled();
  });

  // The presence guard must test for ABSENCE, not falsiness. `name: ""` passed
  // z.string() before this consolidation and reached the service, which rejects
  // blank names with its own structured error — a `!name` guard would silently
  // replace that error path with generic text.
  it('action:"restore" with an empty name still reaches the service', async () => {
    const [{ handler }] = await register();
    await handler({ action: "restore", name: "" });
    expect(svc.restoreNodeSnapshot).toHaveBeenCalledWith("");
  });

  // The list branch is the one that does NOT return JSON — it renders prose. That
  // formatting is behaviour a caller reads, so all three shapes are pinned.
  it('action:"list" renders the same text the old tool did', async () => {
    const [{ handler }] = await register();
    const res = await handler({ action: "list" });
    expect(svc.listNodeSnapshots).toHaveBeenCalledTimes(1);
    expect(res.content[0].text).toBe("Available node snapshots (2):\n- snap-1\n- snap-2");

    svc.listNodeSnapshots.mockResolvedValue({
      snapshots: [],
      unsupported: false,
      message: undefined,
    });
    expect((await handler({ action: "list" })).content[0].text).toBe("No node snapshots found.");

    svc.listNodeSnapshots.mockResolvedValue({
      snapshots: [],
      unsupported: true,
      message: "too old",
    });
    expect((await handler({ action: "list" })).content[0].text).toBe("too old");
  });

  it("an unknown action returns a clear error result", async () => {
    const [{ handler }] = await register();
    const res = await handler({ action: "bogus" as "list" });
    const text = res.content.map((c) => c.text).join(" ");
    expect(text).toMatch(/unknown node_snapshot action/i);
    expect(text).toMatch(/list, save, restore/);
    for (const fn of Object.values(svc)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("the three snapshot names are retired", () => {
  const old = ["save_node_snapshot", "restore_node_snapshot", "list_node_snapshots"];

  it("each old name is in DEAD_NAMES with replacement `node_snapshot`", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.49.0");
      expect(entry!.replacement).toContain("node_snapshot");
    }
  });

  it("no old name is still in the live ledger, and `node_snapshot` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("node_snapshot");
  });
});

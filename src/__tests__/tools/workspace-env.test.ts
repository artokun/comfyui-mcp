import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated `workspace` tool (0.49.0 slice 6): the three workspace
 * tools folded into one action-parameterized tool. Proves the consolidation
 * did not change behaviour — every action calls the identical workspace-env
 * service the old tool called, with the same arguments and the same JSON
 * content block — and that the flat-enum shape actually EXPOSES its parameters
 * (the discriminated-union trap renders zero params).
 */

const mocks = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  setDefaultWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  getEnvironment: vi.fn(),
}));

vi.mock("../../services/workspace-env.js", () => ({
  getWorkspace: (...args: unknown[]) => mocks.getWorkspace(...args),
  setDefaultWorkspace: (...args: unknown[]) => mocks.setDefaultWorkspace(...args),
  listWorkspaces: (...args: unknown[]) => mocks.listWorkspaces(...args),
  getEnvironment: (...args: unknown[]) => mocks.getEnvironment(...args),
}));

import { registerWorkspaceEnvTools } from "../../tools/workspace-env.js";

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
  registerWorkspaceEnvTools(server as never);
  return tools;
}

/** The whole workspace surface is now ONE tool (0.49.0 slice 6); the environment read
 *  shares the registration module and is untouched by the consolidation. */
function handler(): Handler {
  const tools = registered();
  expect(tools.map((t) => t.name)).toEqual(["workspace"]);
  return tools[0].handler;
}

const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("workspace registration", () => {
  it("registers exactly one workspace tool (3→1), and nothing else", () => {
    const tools = registered();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("workspace");
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
    expect(Object.keys(json.properties ?? {}).sort()).toEqual(["action", "path"]);
    expect(json.properties?.action.enum?.sort()).toEqual(["get", "list", "set_default"]);
    // Only `action` can be required — `path` is per-action, enforced in the handler.
    expect(json.required).toEqual(["action"]);
  });

  it("an unknown action returns a clear error result", async () => {
    const res = await handler()({ action: "bogus" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unknown workspace action/i);
    expect(text(res)).toMatch(/set_default/);
  });
});

describe("workspace actions call the same services with the same arguments", () => {
  it('action:"get" returns the workspace info JSON', async () => {
    mocks.getWorkspace.mockResolvedValueOnce({
      workspace_path: "/opt/ComfyUI",
      workspace_source: "env",
      api_target: "http://127.0.0.1:8188",
    });
    const res = await handler()({ action: "get" });
    expect(mocks.getWorkspace).toHaveBeenCalledWith();
    expect(JSON.parse(text(res))).toEqual({
      workspace_path: "/opt/ComfyUI",
      workspace_source: "env",
      api_target: "http://127.0.0.1:8188",
    });
  });

  it('action:"set_default" persists the path and returns the result JSON', async () => {
    mocks.setDefaultWorkspace.mockResolvedValueOnce({
      saved: true,
      default_workspace: "/opt/ComfyUI",
      config_path: "/cfg/workspace.json",
      exists: true,
    });
    const res = await handler()({ action: "set_default", path: "/opt/ComfyUI" });
    expect(mocks.setDefaultWorkspace).toHaveBeenCalledWith("/opt/ComfyUI");
    expect(JSON.parse(text(res))).toEqual({
      saved: true,
      default_workspace: "/opt/ComfyUI",
      config_path: "/cfg/workspace.json",
      exists: true,
    });
  });

  it('action:"list" returns the workspace list JSON', async () => {
    mocks.listWorkspaces.mockResolvedValueOnce({
      active_workspace: "/opt/ComfyUI",
      workspaces: [{ path: "/opt/ComfyUI", active: true, is_default: true, looks_valid: true }],
    });
    const res = await handler()({ action: "list" });
    expect(mocks.listWorkspaces).toHaveBeenCalledWith();
    expect(JSON.parse(text(res))).toEqual({
      active_workspace: "/opt/ComfyUI",
      workspaces: [{ path: "/opt/ComfyUI", active: true, is_default: true, looks_valid: true }],
    });
  });
});

describe("per-action presence guards (the flat shape cannot schema-require these)", () => {
  it('action:"set_default" without a path names the missing field and calls nothing', async () => {
    const res = await handler()({ action: "set_default" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"set_default" requires `path`');
    expect(mocks.setDefaultWorkspace).not.toHaveBeenCalled();
  });

  // The guard tests ABSENCE, not falsiness: an empty path still reaches the
  // service, whose own non-empty validation answers — exactly what the old
  // per-tool schema's .min(1) plus the service check did.
  it("an explicitly empty path still reaches the service's own validation", async () => {
    mocks.setDefaultWorkspace.mockRejectedValueOnce(
      new Error("Workspace path must be a non-empty string."),
    );
    const res = await handler()({ action: "set_default", path: "" });
    expect(mocks.setDefaultWorkspace).toHaveBeenCalledWith("");
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Workspace path must be a non-empty string.");
  });
});

describe("the three workspace names are retired", () => {
  const old = ["get_workspace", "set_default_workspace", "list_workspaces"];

  it("each old name is in DEAD_NAMES with replacement `workspace`", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.49.0");
      expect(entry!.replacement).toContain("workspace");
    }
  });

  it("no old name is still in the live ledger, and `workspace` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("workspace");
  });
});

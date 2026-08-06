import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated `install_custom_node` tool (0.50.0 slice 12): nine
 * custom-node LIFECYCLE tools folded into one action-parameterized tool.
 *
 * Registry discovery is deliberately NOT here — search and details live on the
 * surviving `search_custom_nodes` tool (see registry-search.test.ts), because
 * read-only network lookups do not belong behind the same NAME as actions that
 * execute third-party pack code. Proves the consolidation did not change behaviour
 * — every action calls the identical service the old tool called, with the same
 * arguments and the same content block — and that the flat-enum shape actually
 * EXPOSES its parameters (the discriminated-union trap renders zero params).
 *
 * The dispatch table at the bottom is here for the same reason slice 8 pinned
 * its billing actions: a mis-wired branch in THIS family does not produce a
 * wrong answer, it runs the wrong destructive operation on the user's install.
 * "uninstall can never reach installCustomNode" has to be asserted, not assumed.
 */

const mocks = vi.hoisted(() => ({
  installCustomNode: vi.fn(),
  updateCustomNode: vi.fn(),
  reinstallCustomNode: vi.fn(),
  fixCustomNode: vi.fn(),
  disableCustomNode: vi.fn(),
  enableCustomNode: vi.fn(),
  uninstallCustomNode: vi.fn(),
  listInstalledNodes: vi.fn(),
  syncNodeDependencies: vi.fn(),
  runPanelAction: vi.fn(),
  targetsPanelPackExactly: vi.fn(),
  assertPanelNotTargetedUnverifiable: vi.fn(),
  isLocalMode: vi.fn(),
}));

vi.mock("../../services/node-management.js", () => ({
  installCustomNode: (...a: unknown[]) => mocks.installCustomNode(...a),
  updateCustomNode: (...a: unknown[]) => mocks.updateCustomNode(...a),
  reinstallCustomNode: (...a: unknown[]) => mocks.reinstallCustomNode(...a),
  fixCustomNode: (...a: unknown[]) => mocks.fixCustomNode(...a),
  disableCustomNode: (...a: unknown[]) => mocks.disableCustomNode(...a),
  enableCustomNode: (...a: unknown[]) => mocks.enableCustomNode(...a),
  uninstallCustomNode: (...a: unknown[]) => mocks.uninstallCustomNode(...a),
  listInstalledNodes: (...a: unknown[]) => mocks.listInstalledNodes(...a),
  syncNodeDependencies: (...a: unknown[]) => mocks.syncNodeDependencies(...a),
  parseGitUrl: () => ({ ref: undefined }),
}));

vi.mock("../../services/panel-pin-guard.js", () => ({
  targetsPanelPackExactly: (...a: unknown[]) => mocks.targetsPanelPackExactly(...a),
  assertPanelNotTargetedUnverifiable: (...a: unknown[]) =>
    mocks.assertPanelNotTargetedUnverifiable(...a),
}));

vi.mock("../../services/panel-installer.js", () => ({
  runPanelAction: (...a: unknown[]) => mocks.runPanelAction(...a),
}));

// comfy-cli probing would shell out; the tool only uses it to pick a mechanism,
// and `useCmCli` is passed explicitly in every test that cares.
vi.mock("../../services/comfy-cli.js", () => ({
  getComfyCliVersion: () => undefined,
  resolveComfyCliExecutable: () => undefined,
  shouldUseComfyCli: () => false,
}));

vi.mock("../../config.js", () => ({
  isLocalMode: (...a: unknown[]) => mocks.isLocalMode(...a),
}));

import { registerNodeManagementTools } from "../../tools/node-management.js";

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
  registerNodeManagementTools(server as never);
  return tools;
}

function handler(): Handler {
  const tools = registered();
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("install_custom_node");
  return tools[0].handler;
}

const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

/** Every service this tool can reach — used by the mis-dispatch table. */
const MUTATIONS = [
  "installCustomNode",
  "updateCustomNode",
  "reinstallCustomNode",
  "fixCustomNode",
  "disableCustomNode",
  "enableCustomNode",
  "uninstallCustomNode",
] as const;

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.isLocalMode.mockReturnValue(true);
  mocks.targetsPanelPackExactly.mockReturnValue(false);
  for (const name of MUTATIONS) mocks[name].mockResolvedValue({ ok: true });
  mocks.listInstalledNodes.mockResolvedValue([]);
  mocks.syncNodeDependencies.mockResolvedValue({ mechanism: "comfy-cli" });
});

describe("install_custom_node registration", () => {
  it("registers exactly one tool named `install_custom_node` (9→1)", () => {
    const tools = registered();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("install_custom_node");
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
      "channel",
      "id",
      "mode",
      "ref",
      "source",
      "useCmCli",
      "version",
    ]);
    expect(json.properties?.action.enum?.sort()).toEqual([
      "disable",
      "enable",
      "fix",
      "install",
      "list",
      "reinstall",
      "sync_deps",
      "uninstall",
      "update",
    ]);
    // The split, pinned: no registry-discovery action and no `query` may
    // reappear here. Both were folded in by the first cut of this slice and
    // ruled out — read-only lookups behind a name that runs third-party code is
    // exactly what the call_tool whitelist and the ollama loop-breaker cannot
    // reason about, since both key on the NAME.
    expect(json.properties?.action.enum).not.toContain("search");
    expect(json.properties?.action.enum).not.toContain("details");
    expect(Object.keys(json.properties ?? {})).not.toContain("query");
    // Only `action` can be required — the rest are per-action, enforced in the handler.
    expect(json.required).toEqual(["action"]);
  });

  // `mode` carries two different vocabularies (Manager data source for the
  // mutations, list scope for action:"list"); the union is the whole enum, and
  // the handler refuses the wrong half. If a future edit drops one half from the
  // enum, that call stops being expressible at all.
  it("keeps BOTH meanings of `mode` in the enum", () => {
    const [{ shape }] = registered();
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
    };
    expect(json.properties?.mode.enum?.sort()).toEqual([
      "cache",
      "default",
      "imported",
      "local",
      "remote",
    ]);
  });

  it("an unknown action returns a clear error result", async () => {
    const res = await handler()({ action: "bogus" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unknown install_custom_node action/i);
    expect(text(res)).toMatch(/sync_deps/);
  });
});

describe("install_custom_node actions call the same services with the same arguments", () => {
  it('action:"install" threads source/version/ref/mode/channel through', async () => {
    mocks.installCustomNode.mockResolvedValueOnce({ mechanism: "manager-http" });
    const res = await handler()({
      action: "install",
      id: "comfyui-kjnodes",
      source: "registry",
      version: "1.2.3",
      ref: "abc123",
      mode: "cache",
      channel: "dev",
      useCmCli: true,
    });
    expect(mocks.installCustomNode).toHaveBeenCalledWith({
      id: "comfyui-kjnodes",
      source: "registry",
      version: "1.2.3",
      ref: "abc123",
      mode: "cache",
      channel: "dev",
      useCmCli: true,
    });
    expect(JSON.parse(text(res))).toEqual({ mechanism: "manager-http" });
  });

  it('action:"update" and action:"fix" accept id "all"', async () => {
    await handler()({ action: "update", id: "all", useCmCli: false });
    expect(mocks.updateCustomNode).toHaveBeenCalledWith({
      id: "all",
      mode: undefined,
      channel: undefined,
      useCmCli: false,
    });
    await handler()({ action: "fix", id: "all", useCmCli: false });
    expect(mocks.fixCustomNode).toHaveBeenCalledWith({
      id: "all",
      mode: undefined,
      channel: undefined,
      useCmCli: false,
    });
  });

  it('action:"reinstall" passes `version`', async () => {
    await handler()({ action: "reinstall", id: "pack", version: "2.0.0", useCmCli: false });
    expect(mocks.reinstallCustomNode).toHaveBeenCalledWith({
      id: "pack",
      version: "2.0.0",
      mode: undefined,
      channel: undefined,
      useCmCli: false,
    });
  });

  it('the state actions ("uninstall"/"enable"/"disable") pass only id + useCmCli', async () => {
    for (const [action, mock] of [
      ["uninstall", mocks.uninstallCustomNode],
      ["enable", mocks.enableCustomNode],
      ["disable", mocks.disableCustomNode],
    ] as const) {
      await handler()({ action, id: "pack", useCmCli: false });
      expect(mock, `action:"${action}"`).toHaveBeenCalledWith({ id: "pack", useCmCli: false });
    }
  });

  it('action:"list" formats the installed packs and passes its own `mode`', async () => {
    mocks.listInstalledNodes.mockResolvedValueOnce([
      { module: "ComfyUI-Manager", version: "3.1", enabled: true, cnrId: "comfyui-manager" },
    ]);
    const res = await handler()({ action: "list", mode: "imported", useCmCli: true });
    expect(mocks.listInstalledNodes).toHaveBeenCalledWith({ mode: "imported", useCmCli: true });
    // The formatted list, NOT JSON — the retired tool's content block, unchanged.
    expect(text(res)).toContain("1. ComfyUI-Manager [cnr:comfyui-manager]");
    expect(text(res)).toContain("version: 3.1 | enabled");
  });

  it('action:"list" reports an empty install honestly', async () => {
    mocks.listInstalledNodes.mockResolvedValueOnce([]);
    expect(text(await handler()({ action: "list" }))).toBe("No custom nodes installed.");
  });

  it('action:"sync_deps" takes no arguments at all', async () => {
    mocks.syncNodeDependencies.mockResolvedValueOnce({ mechanism: "comfy-cli", message: "done" });
    const res = await handler()({ action: "sync_deps", id: "ignored" });
    expect(mocks.syncNodeDependencies).toHaveBeenCalledWith();
    expect(JSON.parse(text(res)).message).toBe("done");
  });

});

describe("install_custom_node per-action requiredness", () => {
  it.each([
    ["install", /the registry id, git URL, or node-pack name/],
    ["update", /or 'all'/],
    ["reinstall", /to reinstall/],
    ["fix", /to repair/],
    ["uninstall", /to uninstall/],
    ["enable", /to enable/],
    ["disable", /to disable/],
  ])('action:"%s" names the missing `id`', async (action, hint) => {
    const res = await handler()({ action });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain(`install_custom_node action:"${action}" requires \`id\``);
    expect(text(res)).toMatch(hint);
    for (const name of MUTATIONS) expect(mocks[name]).not.toHaveBeenCalled();
  });

  it('action:"list" and action:"sync_deps" require nothing', async () => {
    expect((await handler()({ action: "list" })).isError).toBeUndefined();
    expect((await handler()({ action: "sync_deps" })).isError).toBeUndefined();
  });
});

/**
 * ABSENCE, not falsiness. `id: ""` and `query: ""` passed z.string() before the
 * consolidation and reached the service, which answers with its own
 * resolves-nowhere / not-found error. A `!id` guard would swallow that live
 * answer and substitute the handler's generic missing-field text — a real
 * behaviour regression that reads like a fix.
 */
describe("install_custom_node guards on absence, never falsiness", () => {
  it('id:"" still reaches the service on every id-taking action', async () => {
    for (const [action, mock] of [
      ["install", mocks.installCustomNode],
      ["update", mocks.updateCustomNode],
      ["reinstall", mocks.reinstallCustomNode],
      ["fix", mocks.fixCustomNode],
      ["uninstall", mocks.uninstallCustomNode],
      ["enable", mocks.enableCustomNode],
      ["disable", mocks.disableCustomNode],
    ] as const) {
      const res = await handler()({ action, id: "", useCmCli: false });
      expect(mock, `action:"${action}"`).toHaveBeenCalledWith(
        expect.objectContaining({ id: "" }),
      );
      expect(text(res), `action:"${action}"`).not.toContain("requires `id`");
    }
  });
});

/**
 * `mode` carries two vocabularies. Passing one action the other's value was a
 * zod error BEFORE the fold; after it, the handler must still refuse — and name
 * the values that ARE valid, which the zod error could not.
 */
describe("install_custom_node refuses a `mode` the action cannot honour", () => {
  it("refuses a list-scope mode on the Manager mutations", async () => {
    for (const action of ["install", "update", "reinstall", "fix"]) {
      const res = await handler()({ action, id: "pack", mode: "imported" });
      expect(res.isError, `action:"${action}"`).toBe(true);
      expect(text(res)).toContain(`action:"${action}" does not accept mode:"imported"`);
      expect(text(res)).toContain('"remote", "local", "cache"');
    }
    for (const name of MUTATIONS) expect(mocks[name]).not.toHaveBeenCalled();
  });

  it('refuses a Manager data-source mode on action:"list"', async () => {
    const res = await handler()({ action: "list", mode: "remote" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"list" does not accept mode:"remote"');
    expect(text(res)).toContain('"default", "imported"');
    expect(mocks.listInstalledNodes).not.toHaveBeenCalled();
  });

  // My own gate, round 1 (P1). `mode` was a zod-validated field on every retired
  // tool, so an invalid value was rejected before ANY handler logic — including
  // the panel redirect. Validating AFTER the redirect let mode:"imported" ride
  // into a verified panel mutation that silently ignores it: a rejection turned
  // into an acceptance by a pure surface change.
  it("refuses a wrong-half mode BEFORE redirecting a panel target", async () => {
    mocks.targetsPanelPackExactly.mockReturnValue(true);
    mocks.runPanelAction.mockResolvedValue({ version: "0.11.28" });
    for (const action of ["install", "update", "reinstall"]) {
      const res = await handler()({ action, id: "comfyui-agent-panel", mode: "imported" });
      expect(res.isError, `action:"${action}"`).toBe(true);
      expect(text(res)).toContain(`action:"${action}" does not accept mode:"imported"`);
    }
    // …and the same for the fix action, whose panel handling is a refusal rather
    // than a redirect: the ARGUMENT error must still win, as zod's did.
    mocks.assertPanelNotTargetedUnverifiable.mockImplementation(() => {
      throw new Error("panel pack refused");
    });
    const fixed = await handler()({ action: "fix", id: "comfyui-agent-panel", mode: "default" });
    expect(text(fixed)).toContain('action:"fix" does not accept mode:"default"');
    expect(text(fixed)).not.toContain("panel pack refused");

    expect(mocks.runPanelAction).not.toHaveBeenCalled();
    expect(mocks.assertPanelNotTargetedUnverifiable).not.toHaveBeenCalled();
    for (const name of MUTATIONS) expect(mocks[name]).not.toHaveBeenCalled();
  });

  it("passes a valid mode straight through on both sides", async () => {
    await handler()({ action: "update", id: "pack", mode: "local", useCmCli: false });
    expect(mocks.updateCustomNode).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "local" }),
    );
    await handler()({ action: "list", mode: "default" });
    expect(mocks.listInstalledNodes).toHaveBeenCalledWith({
      mode: "default",
      useCmCli: undefined,
    });
  });
});

describe("install_custom_node keeps the panel and remote-mode guards", () => {
  it("redirects a panel target on install/update/reinstall into the verified path", async () => {
    mocks.targetsPanelPackExactly.mockReturnValue(true);
    mocks.runPanelAction.mockResolvedValue({ version: "0.11.28" });
    for (const action of ["install", "update", "reinstall"] as const) {
      const res = await handler()({ action, id: "comfyui-agent-panel" });
      expect(JSON.parse(text(res)).routedVia).toBe("install_comfyui(action:'panel')");
    }
    expect(mocks.runPanelAction).toHaveBeenCalledTimes(3);
    expect(mocks.installCustomNode).not.toHaveBeenCalled();
    expect(mocks.updateCustomNode).not.toHaveBeenCalled();
    expect(mocks.reinstallCustomNode).not.toHaveBeenCalled();
  });

  it("REFUSES a panel target on fix/uninstall/enable/disable, naming the action", async () => {
    mocks.targetsPanelPackExactly.mockReturnValue(true);
    mocks.assertPanelNotTargetedUnverifiable.mockImplementation(() => {
      throw new Error("panel pack refused");
    });
    for (const action of ["fix", "uninstall", "enable", "disable"] as const) {
      const res = await handler()({ action, id: "comfyui-agent-panel" });
      expect(res.isError, `action:"${action}"`).toBe(true);
      expect(mocks.assertPanelNotTargetedUnverifiable).toHaveBeenCalledWith(
        `install_custom_node action:"${action}"`,
        "comfyui-agent-panel",
      );
    }
    for (const name of MUTATIONS) expect(mocks[name]).not.toHaveBeenCalled();
  });

  it('action:"fix" with id "all" degrades (not errors) against a remote ComfyUI', async () => {
    mocks.isLocalMode.mockReturnValue(false);
    const res = await handler()({ action: "fix", id: "all" });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toContain('action:"fix" with id="all" is not supported against a remote');
    expect(mocks.fixCustomNode).not.toHaveBeenCalled();
    // A SINGLE pack still works remotely — the guard is scoped to "all".
    await handler()({ action: "fix", id: "one-pack", useCmCli: false });
    expect(mocks.fixCustomNode).toHaveBeenCalledWith(
      expect.objectContaining({ id: "one-pack" }),
    );
  });

  it('action:"sync_deps" degrades (not errors) against a remote ComfyUI', async () => {
    mocks.isLocalMode.mockReturnValue(false);
    const res = await handler()({ action: "sync_deps" });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toContain('action:"sync_deps" is not supported against a remote');
    expect(mocks.syncNodeDependencies).not.toHaveBeenCalled();
  });
});

/**
 * The mis-dispatch table. A wrong branch here is not a wrong answer, it is the
 * wrong DESTRUCTIVE operation: "update" reaching uninstallCustomNode removes a
 * pack the user asked to refresh. Pin that each action reaches EXACTLY ONE
 * service and no other.
 */
describe("no action can reach another action's service", () => {
  const table: Array<[string, (typeof MUTATIONS)[number] | null]> = [
    ["install", "installCustomNode"],
    ["update", "updateCustomNode"],
    ["reinstall", "reinstallCustomNode"],
    ["fix", "fixCustomNode"],
    ["uninstall", "uninstallCustomNode"],
    ["enable", "enableCustomNode"],
    ["disable", "disableCustomNode"],
    ["list", null],
    ["sync_deps", null],
  ];

  it.each(table)('action:"%s" reaches only its own service', async (action, expected) => {
    await handler()({ action, id: "pack", useCmCli: false });
    for (const name of MUTATIONS) {
      if (name === expected) {
        expect(mocks[name], `action:"${action}" must reach ${name}`).toHaveBeenCalledTimes(1);
      } else {
        expect(mocks[name], `action:"${action}" must NOT reach ${name}`).not.toHaveBeenCalled();
      }
    }
  });
});

describe("the retired custom-node lifecycle names", () => {
  const old = [
    "update_custom_node",
    "reinstall_custom_node",
    "fix_custom_node",
    "uninstall_custom_node",
    "enable_custom_node",
    "disable_custom_node",
    "list_installed_nodes",
    "sync_node_dependencies",
  ];

  it("each old name is in DEAD_NAMES with an `install_custom_node` replacement", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.50.0");
      expect(entry!.replacement).toContain("install_custom_node");
    }
  });

  it("no old name is still in the live ledger, and `install_custom_node` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("install_custom_node");
  });

  // The registry pair is NOT this tool's business, and the ledger has to agree:
  // a `search_custom_nodes` entry pointing here would send every migrating
  // caller to the wrong tool.
  it("does not claim the registry-discovery names", () => {
    expect(DEAD_NAMES.find((d) => d.name === "search_custom_nodes")).toBeUndefined();
    expect(DEAD_NAMES.find((d) => d.name === "get_node_pack_details")!.replacement).not.toContain(
      "install_custom_node",
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated `install_comfyui` tool (0.50.0 slice 13): the eight
 * install/environment tools folded into one action-parameterized tool. Proves
 * the consolidation did not change behaviour — every action calls the identical
 * service the old tool called, with the same arguments and the same content
 * block — and that the flat-enum shape actually EXPOSES its parameters (the
 * discriminated-union trap renders zero params).
 *
 * The dangerous property this file pins is CROSS-WIRING. One `install_comfyui`
 * call can now clone a new ComfyUI tree, update ComfyUI core, update every
 * installed node pack, move the sidebar panel, or update this npm package. One
 * wrong enum value would mutate the wrong thing, irreversibly, so each action is
 * asserted to reach ITS service AND to leave the other four untouched.
 */

const mocks = vi.hoisted(() => ({
  installComfyUI: vi.fn(),
  updateComfyUICore: vi.fn(),
  updateAllCustomNodes: vi.fn(),
  runPanelAction: vi.fn(),
  panelStatus: vi.fn(),
  repairInterruptedPanelSwap: vi.fn(),
  performPanelSync: vi.fn(),
  evaluatePanelSync: vi.fn(),
  reclaimAbandonedPanelLock: vi.fn(),
  selfUpdateStatus: vi.fn(),
  runSelfUpdate: vi.fn(),
  getEnvironment: vi.fn(),
  configureManager: vi.fn(),
  isRemoteMode: vi.fn(() => false),
}));

vi.mock("../../config.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isRemoteMode: () => mocks.isRemoteMode(),
}));
vi.mock("../../services/install-comfyui.js", () => ({
  installComfyUI: (...a: unknown[]) => mocks.installComfyUI(...a),
}));
vi.mock("../../services/update-comfyui.js", () => ({
  updateComfyUICore: (...a: unknown[]) => mocks.updateComfyUICore(...a),
  updateAllCustomNodes: (...a: unknown[]) => mocks.updateAllCustomNodes(...a),
}));
vi.mock("../../services/panel-installer.js", () => ({
  panelStatus: (...a: unknown[]) => mocks.panelStatus(...a),
  repairInterruptedPanelSwap: (...a: unknown[]) => mocks.repairInterruptedPanelSwap(...a),
  runPanelAction: (...a: unknown[]) => mocks.runPanelAction(...a),
  withPanelOpLock: async (fn: () => unknown) => fn(),
}));
vi.mock("../../services/panel-sync.js", () => ({
  classifyPinWrite: () => "active",
  evaluatePanelSync: (...a: unknown[]) => mocks.evaluatePanelSync(...a),
  performPanelSync: (...a: unknown[]) => mocks.performPanelSync(...a),
  requiredPanelVersion: () => "0.11.0",
}));
vi.mock("../../services/panel-settings.js", () => ({
  clearPanelVersionPin: () => undefined,
  describePanelPin: () => "unpinned",
  getPanelPinState: () => ({ pinned: false }),
  PANEL_PIN_ENV_VAR: "COMFYUI_MCP_PANEL_PIN",
  setPanelVersionPin: (v: string) => ({ version: v }),
}));
vi.mock("../../services/panel-pin-guard.js", () => ({
  activePanelPendingOps: () => [],
  reclaimAbandonedPanelLock: (...a: unknown[]) => mocks.reclaimAbandonedPanelLock(...a),
}));
vi.mock("../../services/panel-pending-cancel.js", () => ({
  cancelPanelPendingOps: async () => [],
}));
vi.mock("../../services/self-update.js", () => ({
  selfUpdateStatus: (...a: unknown[]) => mocks.selfUpdateStatus(...a),
  runSelfUpdate: (...a: unknown[]) => mocks.runSelfUpdate(...a),
}));
vi.mock("../../services/workspace-env.js", () => ({
  getWorkspace: vi.fn(),
  setDefaultWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  getEnvironment: (...a: unknown[]) => mocks.getEnvironment(...a),
}));
vi.mock("../../services/manager-config.js", () => ({
  configureManager: (...a: unknown[]) => mocks.configureManager(...a),
  MANAGER_CONFIG_ACTIONS: [
    "set_preview_method",
    "set_db_mode",
    "set_component_policy",
    "set_update_policy",
    "set_channel",
    "reset_queue",
    "set_network_mode",
    "set_security_level",
  ] as const,
}));
import { registerInstallComfyUITools } from "../../tools/install-comfyui.js";

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
  registerInstallComfyUITools(server as never);
  return tools;
}

/** The whole install/environment surface is now ONE tool (0.50.0 slice 13). */
function handler(): Handler {
  const tools = registered();
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("install_comfyui");
  return tools[0].handler;
}

/**
 * The registered handler receives the args a client sent, NOT the zod-parsed
 * ones, so per-action defaults declared in the schema (`panel_action` and
 * `self_update_action` both default to "status") must be applied for the call to
 * mean what a real client's call means. Parse through the real shape.
 */
function call(args: Record<string, unknown>) {
  const [{ shape }] = registered();
  const parsed = z.object(shape).parse(args) as Record<string, unknown>;
  return handler()(parsed);
}

const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.isRemoteMode.mockReturnValue(false);
});

describe("install_comfyui registration", () => {
  it("registers exactly one tool named `install_comfyui` (8→1)", () => {
    const tools = registered();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("install_comfyui");
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
      "manager_setting",
      "panel_action",
      "reason",
      "self_update_action",
      "skip_manager",
      "target_path",
      "use_uv",
      "value",
      "version",
    ]);
    expect(json.properties?.action.enum?.slice().sort()).toEqual([
      "configure_manager",
      "environment",
      "install",
      "panel",
      "self_update",
      "update",
      "update_all",
    ]);
    // The two sub-selectors keep the retired tools' own enum VALUES verbatim —
    // only the field name had to move, because a flat object cannot host two
    // fields called `action`.
    expect(json.properties?.panel_action.enum?.slice().sort()).toEqual([
      "install",
      "pin",
      "reinstall",
      "status",
      "sync",
      "unlock",
      "unpin",
      "update",
    ]);
    expect(json.properties?.self_update_action.enum?.slice().sort()).toEqual([
      "status",
      "update",
    ]);
    // Only `action` can be required — the rest are per-action, enforced in the
    // handler. (panel_action / self_update_action carry defaults, so they are
    // optional to a client too.)
    expect(json.required).toEqual(["action"]);
  });

  it("an unknown action returns a clear error result", async () => {
    const res = await handler()({ action: "bogus" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unknown install_comfyui action/i);
    expect(text(res)).toMatch(/configure_manager/);
  });
});

describe("install_comfyui actions call the same services with the same arguments", () => {
  it('action:"install" forwards every install option and returns the report JSON', async () => {
    mocks.installComfyUI.mockReturnValueOnce({ installed: true, targetPath: "/opt/ComfyUI" });
    const res = await call({
      action: "install",
      target_path: "/opt/ComfyUI",
      skip_manager: true,
      use_uv: true,
      version: "latest",
    });
    expect(mocks.installComfyUI).toHaveBeenCalledWith({
      targetPath: "/opt/ComfyUI",
      skipManager: true,
      useUv: true,
      version: "latest",
    });
    expect(JSON.parse(text(res))).toEqual({ installed: true, targetPath: "/opt/ComfyUI" });
  });

  it('action:"install" still refuses in remote mode, as the standalone tool did', async () => {
    mocks.isRemoteMode.mockReturnValue(true);
    const res = await call({ action: "install", target_path: "/opt/ComfyUI" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not\s+available when targeting a remote instance/i);
    expect(mocks.installComfyUI).not.toHaveBeenCalled();
  });

  it('action:"update" updates ComfyUI CORE and nothing else', async () => {
    mocks.updateComfyUICore.mockResolvedValueOnce({ updated: true });
    const res = await call({ action: "update" });
    expect(mocks.updateComfyUICore).toHaveBeenCalledTimes(1);
    expect(JSON.parse(text(res))).toEqual({ updated: true });
    // Cross-wiring guard: none of the other four mutations may have run.
    expect(mocks.updateAllCustomNodes).not.toHaveBeenCalled();
    expect(mocks.runPanelAction).not.toHaveBeenCalled();
    expect(mocks.runSelfUpdate).not.toHaveBeenCalled();
    expect(mocks.installComfyUI).not.toHaveBeenCalled();
  });

  it('action:"update_all" updates every CUSTOM NODE and nothing else', async () => {
    mocks.updateAllCustomNodes.mockResolvedValueOnce({ queued: true });
    const res = await call({ action: "update_all" });
    expect(mocks.updateAllCustomNodes).toHaveBeenCalledTimes(1);
    expect(JSON.parse(text(res))).toEqual({ queued: true });
    expect(mocks.updateComfyUICore).not.toHaveBeenCalled();
    expect(mocks.runPanelAction).not.toHaveBeenCalled();
    expect(mocks.runSelfUpdate).not.toHaveBeenCalled();
    expect(mocks.installComfyUI).not.toHaveBeenCalled();
  });

  it('action:"panel" dispatches on panel_action, defaulting to the read-only status', async () => {
    mocks.repairInterruptedPanelSwap.mockResolvedValueOnce("");
    mocks.panelStatus.mockResolvedValueOnce({ installedVersion: "0.11.0", note: "" });
    mocks.evaluatePanelSync.mockReturnValueOnce({ upToDate: true });
    const res = await call({ action: "panel" });
    expect(mocks.panelStatus).toHaveBeenCalledTimes(1);
    // The bare action is the STATUS read, exactly as install_panel's own
    // `.default("status")` made it.
    expect(mocks.runPanelAction).not.toHaveBeenCalled();
    expect(JSON.parse(text(res))).toMatchObject({ installedVersion: "0.11.0" });

    mocks.runPanelAction.mockResolvedValueOnce({ updated: true });
    await call({ action: "panel", panel_action: "update" });
    expect(mocks.runPanelAction).toHaveBeenCalledWith("update");
    // ...and updating the PANEL never updates ComfyUI or this package.
    expect(mocks.updateComfyUICore).not.toHaveBeenCalled();
    expect(mocks.updateAllCustomNodes).not.toHaveBeenCalled();
    expect(mocks.runSelfUpdate).not.toHaveBeenCalled();
  });

  it('action:"panel" + panel_action:"unlock" reaches the lock reclaim, not an install', async () => {
    mocks.reclaimAbandonedPanelLock.mockReturnValueOnce({ reclaimed: false, reason: "alive" });
    const res = await call({ action: "panel", panel_action: "unlock" });
    expect(mocks.reclaimAbandonedPanelLock).toHaveBeenCalledTimes(1);
    expect(mocks.runPanelAction).not.toHaveBeenCalled();
    expect(JSON.parse(text(res))).toMatchObject({ action: "unlock", reclaimed: false });
  });

  it('action:"self_update" mutates THIS package, and defaults to the read-only status', async () => {
    mocks.selfUpdateStatus.mockResolvedValueOnce({ mode: "global", current: "0.49.8" });
    const res = await call({ action: "self_update" });
    expect(mocks.selfUpdateStatus).toHaveBeenCalledTimes(1);
    expect(mocks.runSelfUpdate).not.toHaveBeenCalled();
    expect(JSON.parse(text(res))).toEqual({ mode: "global", current: "0.49.8" });

    mocks.runSelfUpdate.mockResolvedValueOnce({ updated: true });
    await call({ action: "self_update", self_update_action: "update" });
    expect(mocks.runSelfUpdate).toHaveBeenCalledTimes(1);
    // The three OTHER updates stay untouched — this is the cross-wire that would
    // hurt most, because it re-installs the wrong thing on a one-character typo.
    expect(mocks.updateComfyUICore).not.toHaveBeenCalled();
    expect(mocks.updateAllCustomNodes).not.toHaveBeenCalled();
    expect(mocks.runPanelAction).not.toHaveBeenCalled();
    expect(mocks.installComfyUI).not.toHaveBeenCalled();
  });

  it('action:"environment" is the read-only probe and returns its JSON', async () => {
    mocks.getEnvironment.mockResolvedValueOnce({ local: { python_probe_trusted: false } });
    const res = await call({ action: "environment" });
    expect(mocks.getEnvironment).toHaveBeenCalledTimes(1);
    expect(JSON.parse(text(res))).toEqual({ local: { python_probe_trusted: false } });
    expect(mocks.installComfyUI).not.toHaveBeenCalled();
    expect(mocks.updateComfyUICore).not.toHaveBeenCalled();
  });

  it('action:"configure_manager" passes the setting and value straight through', async () => {
    mocks.configureManager.mockResolvedValueOnce({
      message: "Set preview method",
      via: "http",
      state: "taesd",
    });
    const res = await call({
      action: "configure_manager",
      manager_setting: "set_preview_method",
      value: "taesd",
    });
    expect(mocks.configureManager).toHaveBeenCalledWith("set_preview_method", "taesd");
    expect(text(res)).toBe("Set preview method (via http)\nResulting state: taesd");
  });

});

describe("per-action presence guards (the flat shape cannot schema-require these)", () => {
  it('action:"install" without target_path names the missing field and installs nothing', async () => {
    const res = await call({ action: "install" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("`target_path`");
    expect(text(res)).toContain('action:"install"');
    expect(mocks.installComfyUI).not.toHaveBeenCalled();
  });

  it('action:"configure_manager" without manager_setting names the missing field', async () => {
    const res = await call({ action: "configure_manager", value: "taesd" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("`manager_setting`");
    expect(mocks.configureManager).not.toHaveBeenCalled();
  });

  // The guard tests ABSENCE, not falsiness. `target_path` keeps its .min(1), so
  // an empty string fails the VALUE constraint exactly as it did before this
  // consolidation — at the zod layer, not by being swallowed here.
  it("an empty target_path is rejected by the value constraint, not by the guard", () => {
    const [{ shape }] = registered();
    const parsed = z.object(shape).safeParse({ action: "install", target_path: "" });
    expect(parsed.success).toBe(false);
  });

  // ...and a `value` of "" is a legitimate value for configure_manager, so it
  // must still reach the service rather than be read as "missing".
  it('an explicitly empty configure_manager `value` still reaches the service', async () => {
    mocks.configureManager.mockResolvedValueOnce({ message: "ok", via: "http" });
    await call({ action: "configure_manager", manager_setting: "set_channel", value: "" });
    expect(mocks.configureManager).toHaveBeenCalledWith("set_channel", "");
  });

  // `version` is deliberately SHARED between the install and the panel pin —
  // both retired tools called their argument `version`, and `action` says which
  // is meant. Pin the routing so a later split is a visible change.
  it("`version` routes to the install on action:\"install\" and to the pin on the panel path", async () => {
    mocks.installComfyUI.mockReturnValueOnce({ installed: true });
    await call({ action: "install", target_path: "/opt/ComfyUI", version: "0.3.40" });
    expect(mocks.installComfyUI).toHaveBeenCalledWith(
      expect.objectContaining({ version: "0.3.40" }),
    );

    mocks.panelStatus.mockResolvedValueOnce({ installedVersion: "0.11.0", note: "" });
    const res = await call({ action: "panel", panel_action: "pin", version: "0.11.20" });
    expect(JSON.parse(text(res))).toMatchObject({ action: "pin", requestedVersion: "0.11.20" });
    // The pin is not an install.
    expect(mocks.installComfyUI).toHaveBeenCalledTimes(1);
  });

  it('panel_action:"pin" without a version refuses rather than guessing one', async () => {
    const res = await call({ action: "panel", panel_action: "pin" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/needs a `version`/);
  });
});

describe("the seven retired install/environment names", () => {
  const old = [
    "update_comfyui",
    "update_all",
    "install_panel",
    "self_update",
    "get_environment",
    "configure_manager",
  ];

  it("each old name is in DEAD_NAMES with an `install_comfyui` replacement", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.50.0");
      expect(entry!.replacement).toContain("install_comfyui");
    }
  });

  it("no old name is still in the live ledger, and `install_comfyui` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("install_comfyui");
  });
});

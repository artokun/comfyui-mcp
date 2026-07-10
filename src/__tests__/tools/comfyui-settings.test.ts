import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComfyUIError } from "../../utils/errors.js";

const getSettingsMock = vi.fn();
const getSettingMock = vi.fn();
const setSettingMock = vi.fn();

vi.mock("../../comfyui/client.js", () => ({
  getSettings: (...args: unknown[]) => getSettingsMock(...args),
  getSetting: (...args: unknown[]) => getSettingMock(...args),
  setSetting: (...args: unknown[]) => setSettingMock(...args),
}));

import { registerComfyUISettingsTools } from "../../tools/comfyui-settings.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function makeServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  registerComfyUISettingsTools(server as never);
  return handlers;
}

function parse(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  getSettingsMock.mockReset();
  getSettingMock.mockReset();
  setSettingMock.mockReset();
});

describe("comfyui settings tools", () => {
  it("wires both settings tools", () => {
    const handlers = makeServer();
    expect(handlers.has("get_comfyui_settings")).toBe(true);
    expect(handlers.has("set_comfyui_setting")).toBe(true);
  });

  it("lists all settings sorted, applying a case-insensitive filter", async () => {
    const handlers = makeServer();
    getSettingsMock.mockResolvedValueOnce({
      "Comfy.PreviewMethod": "auto",
      "Comfy.Validation.Workflows": true,
      "Comfy.LinkRenderMode": 2,
    });

    const result = await handlers.get("get_comfyui_settings")!({ filter: "preview" });
    expect(getSettingsMock).toHaveBeenCalledTimes(1);
    const payload = parse(result) as { count: number; settings: Record<string, unknown> };
    expect(payload.count).toBe(1);
    expect(payload.settings).toEqual({ "Comfy.PreviewMethod": "auto" });
  });

  it("returns a single setting's raw value", async () => {
    const handlers = makeServer();
    getSettingMock.mockResolvedValueOnce(true);

    const result = await handlers.get("get_comfyui_settings")!({ id: "Comfy.Validation.Workflows" });
    expect(getSettingMock).toHaveBeenCalledWith("Comfy.Validation.Workflows");
    expect(parse(result)).toEqual({ id: "Comfy.Validation.Workflows", value: true });
  });

  it("reports an unset key with a frontend-default note", async () => {
    const handlers = makeServer();
    getSettingMock.mockResolvedValueOnce(undefined);

    const result = await handlers.get("get_comfyui_settings")!({ id: "Comfy.Nope" });
    expect(parse(result)).toEqual({
      id: "Comfy.Nope",
      value: null,
      note: "unset (frontend default applies)",
    });
  });

  it("set returns { id, previous, value } with previous read first", async () => {
    const handlers = makeServer();
    getSettingMock.mockResolvedValueOnce("latent2rgb");
    setSettingMock.mockResolvedValueOnce(undefined);

    const result = await handlers.get("set_comfyui_setting")!({
      id: "Comfy.PreviewMethod",
      value: "taesd",
    });
    expect(getSettingMock).toHaveBeenCalledWith("Comfy.PreviewMethod");
    expect(setSettingMock).toHaveBeenCalledWith("Comfy.PreviewMethod", "taesd");
    expect(parse(result)).toEqual({
      id: "Comfy.PreviewMethod",
      previous: "latent2rgb",
      value: "taesd",
    });
  });

  it("set reports previous as null when the key was unset", async () => {
    const handlers = makeServer();
    getSettingMock.mockResolvedValueOnce(undefined);
    setSettingMock.mockResolvedValueOnce(undefined);

    const result = await handlers.get("set_comfyui_setting")!({
      id: "Comfy.LinkRenderMode",
      value: 2,
    });
    expect(parse(result)).toEqual({ id: "Comfy.LinkRenderMode", previous: null, value: 2 });
  });

  it("surfaces a friendly version-drift error on 404", async () => {
    const handlers = makeServer();
    getSettingsMock.mockRejectedValueOnce(
      new ComfyUIError("This ComfyUI version/config does not expose the user settings API", "SETTINGS_UNSUPPORTED"),
    );

    const result = await handlers.get("get_comfyui_settings")!({});
    expect(result.isError).toBe(true);
    const payload = parse(result) as { error: string; message: string };
    expect(payload.error).toBe("SETTINGS_UNSUPPORTED");
    expect(payload.message).toContain("user settings API");
  });

  it("refuses in cloud mode (CLOUD_UNSUPPORTED)", async () => {
    const handlers = makeServer();
    setSettingMock.mockRejectedValueOnce(
      new ComfyUIError("needs a direct ComfyUI session (settings)", "CLOUD_UNSUPPORTED"),
    );
    getSettingMock.mockRejectedValueOnce(
      new ComfyUIError("needs a direct ComfyUI session (settings)", "CLOUD_UNSUPPORTED"),
    );

    const result = await handlers.get("set_comfyui_setting")!({ id: "Comfy.UseNewMenu", value: "Top" });
    expect(result.isError).toBe(true);
    const payload = parse(result) as { error: string };
    expect(payload.error).toBe("CLOUD_UNSUPPORTED");
  });
});

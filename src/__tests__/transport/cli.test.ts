import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../../transport/cli.js";

const base = ["node", "comfyui-mcp"];

describe("parseCliArgs", () => {
  it("defaults to stdio on 127.0.0.1:9100 with no args/env", () => {
    expect(parseCliArgs(base, {})).toEqual({
      transport: "stdio",
      host: "127.0.0.1",
      port: 9100,
      channels: false,
      panelOrchestrator: false,
    });
  });

  it("--http switches transport", () => {
    expect(parseCliArgs([...base, "--http"], {}).transport).toBe("http");
  });

  it("--transport http switches transport", () => {
    expect(parseCliArgs([...base, "--transport", "http"], {}).transport).toBe("http");
  });

  it("supports --port value and --host value", () => {
    const o = parseCliArgs([...base, "--http", "--host", "0.0.0.0", "--port", "8080"], {});
    expect(o).toEqual({ transport: "http", host: "0.0.0.0", port: 8080, channels: false, panelOrchestrator: false });
  });

  it("supports --flag=value form", () => {
    const o = parseCliArgs([...base, "--transport=http", "--port=3000", "--host=0.0.0.0"], {});
    expect(o).toEqual({ transport: "http", host: "0.0.0.0", port: 3000, channels: false, panelOrchestrator: false });
  });

  it("reads env defaults", () => {
    const o = parseCliArgs(base, { MCP_TRANSPORT: "http", MCP_HOST: "0.0.0.0", MCP_PORT: "5000" });
    expect(o).toEqual({ transport: "http", host: "0.0.0.0", port: 5000, channels: false, panelOrchestrator: false });
  });

  it("--panel-orchestrator enables orchestrator mode; env works too", () => {
    expect(parseCliArgs(base, {}).panelOrchestrator).toBe(false);
    expect(parseCliArgs([...base, "--panel-orchestrator"], {}).panelOrchestrator).toBe(true);
    expect(parseCliArgs(base, { COMFYUI_MCP_PANEL_ORCHESTRATOR: "1" }).panelOrchestrator).toBe(true);
  });

  it("explicit --stdio flag overrides MCP_TRANSPORT=http env", () => {
    expect(parseCliArgs([...base, "--stdio"], { MCP_TRANSPORT: "http" }).transport).toBe("stdio");
  });

  it("explicit flags override env values", () => {
    const o = parseCliArgs([...base, "--port", "7000"], { MCP_PORT: "5000" });
    expect(o.port).toBe(7000);
  });

  it("--channels enables channels mode; env works too; --no-channels overrides env", () => {
    expect(parseCliArgs(base, {}).channels).toBe(false);
    expect(parseCliArgs([...base, "--channels"], {}).channels).toBe(true);
    expect(parseCliArgs(base, { COMFYUI_MCP_CHANNELS: "1" }).channels).toBe(true);
    expect(parseCliArgs([...base, "--no-channels"], { COMFYUI_MCP_CHANNELS: "1" }).channels).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../../transport/cli.js";

const base = ["node", "comfyui-mcp"];

describe("parseCliArgs", () => {
  it("defaults to stdio on 127.0.0.1:9100 with no args/env", () => {
    expect(parseCliArgs(base, {})).toEqual({
      transport: "stdio",
      host: "127.0.0.1",
      port: 9100,
      panelOrchestrator: false,
      token: undefined,
      tunnel: false,
      allowUnauthenticated: false,
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
    expect(o).toEqual({ transport: "http", host: "0.0.0.0", port: 8080, panelOrchestrator: false, token: undefined, tunnel: false, allowUnauthenticated: false });
  });

  it("supports --flag=value form", () => {
    const o = parseCliArgs([...base, "--transport=http", "--port=3000", "--host=0.0.0.0"], {});
    expect(o).toEqual({ transport: "http", host: "0.0.0.0", port: 3000, panelOrchestrator: false, token: undefined, tunnel: false, allowUnauthenticated: false });
  });

  it("reads env defaults", () => {
    const o = parseCliArgs(base, { MCP_TRANSPORT: "http", MCP_HOST: "0.0.0.0", MCP_PORT: "5000" });
    expect(o).toEqual({ transport: "http", host: "0.0.0.0", port: 5000, panelOrchestrator: false, token: undefined, tunnel: false, allowUnauthenticated: false });
  });

  it("reads token from COMFYUI_MCP_HTTP_TOKEN env and --token flag (flag wins)", () => {
    expect(parseCliArgs(base, { COMFYUI_MCP_HTTP_TOKEN: "envtok" }).token).toBe("envtok");
    expect(parseCliArgs([...base, "--token", "flagtok"], { COMFYUI_MCP_HTTP_TOKEN: "envtok" }).token).toBe(
      "flagtok",
    );
    expect(parseCliArgs([...base, "--token=eq"], {}).token).toBe("eq");
  });

  it("--tunnel forces http transport and sets tunnel=true; MCP_TUNNEL env works too", () => {
    const o = parseCliArgs([...base, "--tunnel"], {});
    expect(o.tunnel).toBe(true);
    expect(o.transport).toBe("http");
    const e = parseCliArgs(base, { MCP_TUNNEL: "1" });
    expect(e.tunnel).toBe(true);
    expect(e.transport).toBe("http");
  });

  it("reads the unauthenticated escape hatch from flag and env", () => {
    expect(parseCliArgs(base, {}).allowUnauthenticated).toBe(false);
    expect(
      parseCliArgs([...base, "--allow-unauthenticated-non-loopback"], {}).allowUnauthenticated,
    ).toBe(true);
    expect(parseCliArgs(base, { COMFYUI_MCP_ALLOW_UNAUTH: "1" }).allowUnauthenticated).toBe(true);
  });

  it("--panel-orchestrator enables orchestrator mode; env works too", () => {
    expect(parseCliArgs(base, {}).panelOrchestrator).toBe(false);
    expect(parseCliArgs([...base, "--panel-orchestrator"], {}).panelOrchestrator).toBe(true);
    expect(parseCliArgs(base, { COMFYUI_MCP_PANEL_ORCHESTRATOR: "1" }).panelOrchestrator).toBe(true);
    expect(parseCliArgs([...base, "--panel-orchestrator"], {})).toMatchObject({
      panelOrchestrator: true,
      token: undefined,
      tunnel: false,
    });
  });

  it("explicit --stdio flag overrides MCP_TRANSPORT=http env", () => {
    expect(parseCliArgs([...base, "--stdio"], { MCP_TRANSPORT: "http" }).transport).toBe("stdio");
  });

  it("explicit flags override env values", () => {
    const o = parseCliArgs([...base, "--port", "7000"], { MCP_PORT: "5000" });
    expect(o.port).toBe(7000);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import {
  PanelTemplateRelayError,
  currentPanelTemplateOrigin,
  requestPanelTemplateIndex,
  startPanelTemplateRelayServer,
} from "../../services/panel-template-relay.js";

const SECRET = "a".repeat(64);
const servers: Array<{ close(): Promise<void> }> = [];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  delete process.env.COMFYUI_MCP_RELAY_SECRET;
  delete process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL;
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await server.close();
});

describe("authenticated panel template relay (#2196)", () => {
  it("uses the live panel origin and returns its template index without headless credentials", async () => {
    let authorization = "seen";
    const panel = createServer((req, res) => {
      authorization = String(req.headers.authorization ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ "live-pack": [{ name: "live-template" }] }));
    });
    const panelOrigin = await listen(panel);
    servers.push({ close: () => closeServer(panel) });

    const relay = await startPanelTemplateRelayServer({
      bridge: { canReach: () => true },
      resolvePanelAgent: () => ({ agentKey: "shared::codex", secret: SECRET }),
      resolvePanelTab: () => "tab-1",
      resolvePanelUrl: () => `${panelOrigin}/api/workflow_templates`,
      resolveAllowedPanelOrigin: () => panelOrigin,
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    await expect(requestPanelTemplateIndex()).resolves.toEqual({
      "live-pack": [{ name: "live-template" }],
    });
    expect(authorization).toBe("");
  });

  it("uses a non-loopback panel origin when it exactly matches the current target", async () => {
    const realFetch = globalThis.fetch;
    const panelOrigin = "https://remote.example";
    const remoteCalls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
      remoteCalls.push(url);
      return Promise.resolve(new Response(JSON.stringify({ "remote-pack": [{ name: "remote-template" }] }), { status: 200 }));
    });

    const relay = await startPanelTemplateRelayServer({
      bridge: { canReach: () => true },
      resolvePanelAgent: () => ({ agentKey: "shared::codex", secret: SECRET }),
      resolvePanelTab: () => "tab-1",
      resolvePanelUrl: () => `${panelOrigin}/api/workflow_templates`,
      resolveAllowedPanelOrigin: () => currentPanelTemplateOrigin(panelOrigin, "https://remote.example/comfyapi"),
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    await expect(requestPanelTemplateIndex()).resolves.toEqual({
      "remote-pack": [{ name: "remote-template" }],
    });
    expect(remoteCalls).toEqual([`${panelOrigin}/api/workflow_templates`]);
  });

  it("fails closed when the panel origin does not match the current target", async () => {
    const realFetch = globalThis.fetch;
    const remoteCalls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
      remoteCalls.push(url);
      return Promise.reject(new Error("the rejected origin must not be contacted"));
    });

    const relay = await startPanelTemplateRelayServer({
      bridge: { canReach: () => true },
      resolvePanelAgent: () => ({ agentKey: "shared::codex", secret: SECRET }),
      resolvePanelTab: () => "tab-1",
      resolvePanelUrl: () => "https://evil.example/api/workflow_templates",
      resolveAllowedPanelOrigin: () => currentPanelTemplateOrigin("https://evil.example", "https://current.example/comfyapi"),
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    await expect(requestPanelTemplateIndex()).rejects.toMatchObject<PanelTemplateRelayError>({
      code: "NO_PANEL_ORIGIN",
    });
    expect(remoteCalls).toEqual([]);
  });

  it("refuses a missing panel origin without contacting it", async () => {
    const relay = await startPanelTemplateRelayServer({
      bridge: { canReach: () => true },
      resolvePanelAgent: () => ({ agentKey: "shared::codex", secret: SECRET }),
      resolvePanelTab: () => "tab-1",
      resolvePanelUrl: () => undefined,
      resolveAllowedPanelOrigin: () => undefined,
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    await expect(requestPanelTemplateIndex()).rejects.toMatchObject<PanelTemplateRelayError>({
      code: "NO_PANEL_ORIGIN",
    });
  });

  it("refuses a disconnected panel before resolving or fetching an origin", async () => {
    const relay = await startPanelTemplateRelayServer({
      bridge: { canReach: () => false },
      resolvePanelAgent: () => ({ agentKey: "shared::codex", secret: SECRET }),
      resolvePanelTab: () => "tab-1",
      resolvePanelUrl: () => {
        throw new Error("a disconnected panel has no URL to resolve");
      },
      resolveAllowedPanelOrigin: () => {
        throw new Error("a disconnected panel has no origin to authorize");
      },
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    await expect(requestPanelTemplateIndex()).rejects.toMatchObject<PanelTemplateRelayError>({
      code: "NO_LIVE_PANEL",
    });
  });

  it("refuses a redirect from the panel origin", async () => {
    const panel = createServer((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:1/collect" });
      res.end();
    });
    const panelOrigin = await listen(panel);
    servers.push({ close: () => closeServer(panel) });

    const relay = await startPanelTemplateRelayServer({
      bridge: { canReach: () => true },
      resolvePanelAgent: () => ({ agentKey: "shared::codex", secret: SECRET }),
      resolvePanelTab: () => "tab-1",
      resolvePanelUrl: () => `${panelOrigin}/api/workflow_templates`,
      resolveAllowedPanelOrigin: () => panelOrigin,
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    await expect(requestPanelTemplateIndex()).rejects.toMatchObject<PanelTemplateRelayError>({
      code: "PANEL_FETCH_FAILED",
    });
  });

  it("rejects a successful response whose response.url is a different origin", async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input).startsWith("http://127.0.0.1:")) return realFetch(input, init);
      const response = new Response(JSON.stringify({ "panel-pack": [{ name: "unexpected" }] }), { status: 200 });
      Object.defineProperty(response, "url", {
        value: "https://redirected.example/api/workflow_templates",
      });
      return Promise.resolve(response);
    });

    const relay = await startPanelTemplateRelayServer({
      bridge: { canReach: () => true },
      resolvePanelAgent: () => ({ agentKey: "shared::codex", secret: SECRET }),
      resolvePanelTab: () => "tab-1",
      resolvePanelUrl: () => "https://panel.example/api/workflow_templates",
      resolveAllowedPanelOrigin: () => currentPanelTemplateOrigin("https://panel.example", "https://panel.example/comfyapi"),
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    await expect(requestPanelTemplateIndex()).rejects.toMatchObject<PanelTemplateRelayError>({
      code: "PANEL_FETCH_FAILED",
    });
  });

  it("is disabled when the child has no authenticated relay environment", async () => {
    await expect(requestPanelTemplateIndex()).resolves.toBeUndefined();
  });

  it("only authorizes an origin corroborated by the current target", () => {
    expect(currentPanelTemplateOrigin("https://remote.example:443", "https://remote.example/comfyapi")).toBe("https://remote.example");
    expect(currentPanelTemplateOrigin("http://localhost:8188", "http://127.0.0.1:8188/comfyapi")).toBe("http://localhost:8188");
    expect(currentPanelTemplateOrigin("http://localhost:8189", "http://127.0.0.1:8188/comfyapi")).toBeUndefined();
    expect(currentPanelTemplateOrigin("https://remote.example", "https://other.example/comfyapi")).toBeUndefined();
    expect(currentPanelTemplateOrigin(undefined, "https://remote.example/comfyapi")).toBeUndefined();
    expect(currentPanelTemplateOrigin("https://user:secret@remote.example", "https://remote.example/comfyapi")).toBeUndefined();
  });
});

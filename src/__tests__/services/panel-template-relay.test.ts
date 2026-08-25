import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  PanelTemplateRelayError,
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
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    await expect(requestPanelTemplateIndex()).resolves.toEqual({
      "live-pack": [{ name: "live-template" }],
    });
    expect(authorization).toBe("");
  });

  it("refuses a non-loopback panel origin without contacting it", async () => {
    const relay = await startPanelTemplateRelayServer({
      bridge: { canReach: () => true },
      resolvePanelAgent: () => ({ agentKey: "shared::codex", secret: SECRET }),
      resolvePanelTab: () => "tab-1",
      resolvePanelUrl: () => "https://remote.example/api/workflow_templates",
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    await expect(requestPanelTemplateIndex()).rejects.toMatchObject<PanelTemplateRelayError>({
      code: "NO_PANEL_ORIGIN",
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
});

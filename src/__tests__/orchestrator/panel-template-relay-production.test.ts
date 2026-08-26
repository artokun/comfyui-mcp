import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createPanelTemplateRelayWiring } from "../../orchestrator/index.js";
import { requestPanelTemplateIndex, startPanelTemplateRelayServer } from "../../services/panel-template-relay.js";

const SECRET = "c".repeat(64);
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

describe("orchestrator panel template relay wiring (#2196)", () => {
  it("uses the production auth, scope-tab, URL, and current-target closures end to end", async () => {
    let target = "";
    let generation = 0;
    let observedOrigin = "";
    let panelRequests = 0;
    const panel = createServer((_req, res) => {
      panelRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ "panel-pack": [{ name: "live-template" }] }));
    });
    const panelOrigin = await listen(panel);
    servers.push({ close: () => closeServer(panel) });
    target = `${panelOrigin}/comfyapi`;
    observedOrigin = panelOrigin;

    const bridge = {
      canReach: () => true,
      resolveFailure: () => undefined,
      resolveSharedTabId: (scopeId: string) => {
        expect(scopeId).toBe("orchestrator::codex");
        return "tab-1";
      },
      tabServerOrigin: (tabId: string) => {
        expect(tabId).toBe("tab-1");
        return observedOrigin;
      },
    };
    const wiring = createPanelTemplateRelayWiring({
      bridge,
      currentTarget: () => target,
      currentTargetGeneration: () => generation,
      secrets: new Map([[SECRET, "orchestrator::codex"]]),
    });
    const relay = await startPanelTemplateRelayServer({ bridge, ...wiring });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    await expect(requestPanelTemplateIndex()).resolves.toEqual({
      "panel-pack": [{ name: "live-template" }],
    });
    expect(panelRequests).toBe(1);
    const resolvedTab = wiring.resolvePanelTab("orchestrator::codex");
    expect(resolvedTab).toBe("tab-1");
    expect(wiring.resolvePanelUrl(resolvedTab!, target)).toBe(
      `${panelOrigin}/comfyapi/api/workflow_templates`,
    );

    // A later target event invalidates the stale observed-origin pairing before
    // another child request can fetch from the old panel target.
    target = "http://127.0.0.1:1/other";
    await expect(requestPanelTemplateIndex()).rejects.toMatchObject({ code: "NO_PANEL_ORIGIN" });
    expect(panelRequests).toBe(1);
  });

  it("rejects forged and non-loopback origins through the production wiring", async () => {
    let target = "http://127.0.0.1:8188/comfyapi";
    let observedOrigin = "https://forged.example";
    const bridge = {
      canReach: () => true,
      resolveFailure: () => undefined,
      resolveSharedTabId: () => "tab-1",
      tabServerOrigin: () => observedOrigin,
    };
    const wiring = createPanelTemplateRelayWiring({
      bridge,
      currentTarget: () => target,
      currentTargetGeneration: () => 0,
      secrets: new Map([[SECRET, "orchestrator::codex"]]),
    });

    expect(wiring.resolveAllowedPanelOrigin("tab-1", target)).toBeUndefined();
    expect(wiring.resolvePanelUrl("tab-1", target)).toBeUndefined();

    target = "https://remote.example/comfyapi";
    observedOrigin = "https://remote.example";
    expect(wiring.resolveAllowedPanelOrigin("tab-1", target)).toBeUndefined();
    expect(wiring.resolvePanelUrl("tab-1", target)).toBeUndefined();

    const relay = await startPanelTemplateRelayServer({ bridge, ...wiring });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;
    await expect(requestPanelTemplateIndex()).rejects.toMatchObject({ code: "NO_PANEL_ORIGIN" });
  });

  it("rejects a stale in-flight response after retargeting and still serves the current target", async () => {
    let target = "";
    let generation = 0;
    let observedOrigin = "";
    let panelRequests = 0;
    let firstRequest = true;
    let markPanelRequestStarted!: () => void;
    const panelRequestStarted = new Promise<void>((resolve) => {
      markPanelRequestStarted = resolve;
    });
    let releaseFirstResponse!: () => void;
    const firstResponseReleased = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });
    const panel = createServer((_req, res) => {
      panelRequests += 1;
      if (firstRequest) {
        firstRequest = false;
        markPanelRequestStarted();
        void firstResponseReleased.then(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ "old-panel-pack": [{ name: "stale-template" }] }));
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ "current-panel-pack": [{ name: "current-template" }] }));
    });
    const panelOrigin = await listen(panel);
    servers.push({ close: () => closeServer(panel) });
    target = `${panelOrigin}/comfyapi`;
    observedOrigin = panelOrigin;

    const bridge = {
      canReach: () => true,
      resolveFailure: () => undefined,
      resolveSharedTabId: (scopeId: string) => {
        expect(scopeId).toBe("orchestrator::codex");
        return "tab-1";
      },
      tabServerOrigin: (tabId: string) => {
        expect(tabId).toBe("tab-1");
        return observedOrigin;
      },
    };
    const wiring = createPanelTemplateRelayWiring({
      bridge,
      currentTarget: () => target,
      currentTargetGeneration: () => generation,
      secrets: new Map([[SECRET, "orchestrator::codex"]]),
    });
    const relay = await startPanelTemplateRelayServer({ bridge, ...wiring });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    const staleRequest = requestPanelTemplateIndex();
    await panelRequestStarted;
    target = "http://127.0.0.1:1/other";
    generation += 1;
    target = `${panelOrigin}/comfyapi`;
    generation += 1;
    releaseFirstResponse();

    // The target has returned to A, but the generation proves that the response
    // belongs to the earlier A and must not be served as current data.
    await expect(staleRequest).rejects.toMatchObject({ code: "STALE_TARGET" });
    expect(panelRequests).toBe(1);

    await expect(requestPanelTemplateIndex()).resolves.toEqual({
      "current-panel-pack": [{ name: "current-template" }],
    });
    expect(panelRequests).toBe(2);
  });
});

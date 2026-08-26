import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";

const state = vi.hoisted(() => ({
  baseUrl: "http://127.0.0.1:8188",
  headlessCalls: 0,
}));

vi.mock("../../config.js", () => ({
  getComfyUIBaseUrl: () => state.baseUrl,
  getComfyUIAuthHeaders: () => ({}),
}));

vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: async () => {
    state.headlessCalls += 1;
    throw new Error("the panel-backed path must not use COMFYUI_URL");
  },
}));

vi.mock("../../services/api-nodes.js", () => ({
  checkWorkflowRuntime: vi.fn(),
  extractWorkflowClassTypes: vi.fn(),
}));

vi.mock("../../services/workflow-deps.js", () => ({
  extractWorkflowDependencies: vi.fn(),
  installWorkflowDependencies: vi.fn(),
  defaultWorkflowDepsDeps: () => ({ deps: "test" }),
}));

vi.mock("../../services/skill-cache.js", () => ({
  generateSkillCached: vi.fn(),
}));

vi.mock("../../services/manifest.js", () => ({
  resolvePackManifestFile: vi.fn(),
}));

import { registerSkillsAccessTools } from "../../tools/skills-access.js";
import { createPanelTemplateRelayWiring } from "../../orchestrator/index.js";
import { startPanelTemplateRelayServer } from "../../services/panel-template-relay.js";

const SECRET = "b".repeat(64);
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

function listPacksHandler(): (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> {
  const tools: Array<{ handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> = [];
  registerSkillsAccessTools({
    tool: (_name: string, _description: string, _shape: unknown, handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>) => {
      tools.push({ handler });
    },
  } as never);
  if (tools.length !== 1) throw new Error(`expected one list_packs tool, got ${tools.length}`);
  return tools[0].handler;
}

afterEach(async () => {
  delete process.env.COMFYUI_MCP_RELAY_SECRET;
  delete process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL;
  state.baseUrl = "http://127.0.0.1:8188";
  state.headlessCalls = 0;
  for (const server of servers.splice(0)) await server.close();
  vi.restoreAllMocks();
});

describe("list_packs -> panel template relay production boundary (#2196)", () => {
  it("drives action:list_templates through the real child request and relay before headless fetch", async () => {
    const panel = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ "panel-pack": [{ name: "live-template" }] }));
    });
    const panelOrigin = await listen(panel);
    servers.push({ close: () => closeServer(panel) });

    const relay = await startPanelTemplateRelayServer({
      bridge: { canReach: () => true },
      resolvePanelAgent: () => ({ agentKey: "orchestrator::codex", secret: SECRET }),
      resolvePanelTab: () => "tab-1",
      resolveCurrentTarget: () => ({ url: state.baseUrl, generation: 0 }),
      resolvePanelUrl: () => `${panelOrigin}/api/workflow_templates`,
      resolveAllowedPanelOrigin: () => panelOrigin,
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;
    state.baseUrl = `${panelOrigin}/comfyapi`;

    const result = await listPacksHandler()({ action: "list_templates" });
    const rendered = JSON.parse(result.content.map((block) => block.text).join(" ")) as Record<string, unknown>;
    expect(rendered).toMatchObject({
      source_count: 1,
      template_count: 1,
      templates: { "panel-pack": [{ name: "live-template" }] },
    });
    expect(state.headlessCalls).toBe(0);
  });

  it("returns an honest refusal instead of reading stale target A after a retarget to B", async () => {
    let panelRequests = 0;
    const panel = createServer((_req, res) => {
      panelRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ "target-a-pack": [{ name: "stale-template" }] }));
    });
    const targetAOrigin = await listen(panel);
    servers.push({ close: () => closeServer(panel) });

    // The child still carries A in its configured URL, while the orchestrator
    // has already retargeted the live panel to B. The observed panel origin is
    // therefore mismatched at the relay boundary and must not fall through to
    // the stale child-side URL.
    state.baseUrl = `${targetAOrigin}/comfyapi`;
    let currentTarget = state.baseUrl;
    let generation = 0;
    const bridge = {
      canReach: () => true,
      resolveFailure: () => undefined,
      resolveSharedTabId: () => "tab-1",
      tabServerOrigin: () => targetAOrigin,
    };
    const relay = await startPanelTemplateRelayServer({
      bridge,
      ...createPanelTemplateRelayWiring({
        bridge,
        currentTarget: () => currentTarget,
        currentTargetGeneration: () => generation,
        secrets: new Map([[SECRET, "orchestrator::codex"]]),
      }),
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    currentTarget = "http://127.0.0.1:1/comfyapi";
    generation += 1;

    const result = await listPacksHandler()({ action: "list_templates" });
    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.text).join(" ")).toContain("NO_PANEL_ORIGIN");
    expect(panelRequests).toBe(0);
    expect(state.headlessCalls).toBe(0);
  });
});

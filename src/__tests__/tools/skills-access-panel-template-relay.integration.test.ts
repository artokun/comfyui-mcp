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

function listPacksHandler(): (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> {
  const tools: Array<{ handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> = [];
  registerSkillsAccessTools({
    tool: (_name: string, _description: string, _shape: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) => {
      tools.push({ handler });
    },
  } as never);
  if (tools.length !== 1) throw new Error(`expected one list_packs tool, got ${tools.length}`);
  return tools[0].handler;
}

afterEach(async () => {
  delete process.env.COMFYUI_MCP_RELAY_SECRET;
  delete process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL;
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
});

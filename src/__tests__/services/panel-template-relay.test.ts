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
      resolveCurrentTarget: () => ({ url: panelOrigin, generation: 0 }),
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

  it("refuses a non-loopback panel origin even when it exactly matches the current target", async () => {
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
      resolveCurrentTarget: () => ({ url: "https://remote.example/comfyapi", generation: 0 }),
      resolvePanelUrl: () => `${panelOrigin}/api/workflow_templates`,
      resolveAllowedPanelOrigin: () => currentPanelTemplateOrigin(panelOrigin, "https://remote.example/comfyapi"),
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    await expect(requestPanelTemplateIndex()).rejects.toMatchObject<PanelTemplateRelayError>({
      code: "NO_PANEL_ORIGIN",
    });
    expect(remoteCalls).toEqual([]);
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
      resolveCurrentTarget: () => ({ url: "https://current.example/comfyapi", generation: 0 }),
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
      resolveCurrentTarget: () => ({ url: "https://current.example/comfyapi", generation: 0 }),
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
      resolveCurrentTarget: () => ({ url: "https://panel.example/comfyapi", generation: 0 }),
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
      resolveCurrentTarget: () => ({ url: panelOrigin, generation: 0 }),
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
    let relayEndpoint = "";
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input) === relayEndpoint) return realFetch(input, init);
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
      resolveCurrentTarget: () => ({ url: "http://127.0.0.1:8188/comfyapi", generation: 0 }),
      resolvePanelUrl: () => "http://127.0.0.1:8188/api/workflow_templates",
      resolveAllowedPanelOrigin: () => currentPanelTemplateOrigin("http://127.0.0.1:8188", "http://127.0.0.1:8188/comfyapi"),
    });
    servers.push(relay);
    relayEndpoint = relay.endpointUrl;
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    await expect(requestPanelTemplateIndex()).rejects.toMatchObject<PanelTemplateRelayError>({
      code: "PANEL_FETCH_FAILED",
    });
  });

  it("is disabled when the child has no authenticated relay environment", async () => {
    await expect(requestPanelTemplateIndex()).resolves.toBeUndefined();
  });

  function nativeIndex(index: Record<string, unknown>) {
    const body = JSON.stringify(index);
    return {
      operation: "workflow_templates" as const,
      body,
      contentType: "application/json",
      bytes: Buffer.byteLength(body, "utf8"),
    };
  }

  it("asks the live panel for the template index when the origin is remote (#2196)", async () => {
    const seen: Array<{ cmd: string; operation?: string; tabId?: string }> = [];
    const remoteCalls: string[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
      remoteCalls.push(url);
      return Promise.reject(new Error("the orchestrator must not fetch the remote origin"));
    });

    const relay = await startPanelTemplateRelayServer({
      bridge: {
        canReach: () => true,
        send: async (command, options) => {
          seen.push({ ...command, tabId: options.tabId });
          return nativeIndex({ "remote-pack": [{ name: "from-panel" }] });
        },
      },
      resolvePanelAgent: () => ({ agentKey: "shared::codex", secret: SECRET }),
      resolvePanelTab: () => "tab-1",
      resolveCurrentTarget: () => ({ url: "https://remote.example/comfyapi", generation: 0 }),
      resolvePanelUrl: () => {
        throw new Error("panel-native fetch must not resolve a remote HTTP URL");
      },
      resolveAllowedPanelOrigin: () => {
        throw new Error("panel-native fetch must not authorize a remote HTTP origin");
      },
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    await expect(requestPanelTemplateIndex()).resolves.toEqual({
      "remote-pack": [{ name: "from-panel" }],
    });
    expect(seen).toEqual([{ cmd: "fetch_comfyui_read", operation: "workflow_templates", tabId: "tab-1" }]);
    expect(remoteCalls).toEqual([]);
  });

  it("asks the live panel when localhost and 127.0.0.1 are a mixed pair (#2196)", async () => {
    const seen: string[] = [];
    const relay = await startPanelTemplateRelayServer({
      bridge: {
        canReach: () => true,
        send: async (command) => {
          seen.push(command.operation);
          return nativeIndex({ "mixed-pack": [{ name: "from-browser" }] });
        },
      },
      resolvePanelAgent: () => ({ agentKey: "shared::codex", secret: SECRET }),
      resolvePanelTab: () => "tab-1",
      resolveCurrentTarget: () => ({ url: "http://127.0.0.1:8188/comfyapi", generation: 0 }),
      resolvePanelUrl: () => currentPanelTemplateOrigin("http://localhost:8188", "http://127.0.0.1:8188/comfyapi"),
      resolveAllowedPanelOrigin: () =>
        currentPanelTemplateOrigin("http://localhost:8188", "http://127.0.0.1:8188/comfyapi"),
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    await expect(requestPanelTemplateIndex()).resolves.toEqual({
      "mixed-pack": [{ name: "from-browser" }],
    });
    expect(seen).toEqual(["workflow_templates"]);
  });

  it("rejects a native reply after the ComfyUI target retargets (#2196)", async () => {
    let generation = 0;
    let currentTarget = "https://remote.example/comfyapi";
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const relay = await startPanelTemplateRelayServer({
      bridge: {
        canReach: () => true,
        send: async () => {
          markStarted();
          await held;
          return nativeIndex({ "stale-pack": [{ name: "too-late" }] });
        },
      },
      resolvePanelAgent: () => ({ agentKey: "shared::codex", secret: SECRET }),
      resolvePanelTab: () => "tab-1",
      resolveCurrentTarget: () => ({ url: currentTarget, generation }),
      resolvePanelUrl: () => undefined,
      resolveAllowedPanelOrigin: () => undefined,
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    const pending = requestPanelTemplateIndex();
    await started;
    currentTarget = "https://other.example/comfyapi";
    generation += 1;
    release();
    await expect(pending).rejects.toMatchObject<PanelTemplateRelayError>({ code: "STALE_TARGET" });
  });

  it("falls back to loopback HTTP when the panel does not implement workflow_templates", async () => {
    let panelRequests = 0;
    const panel = createServer((_req, res) => {
      panelRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ "fallback-pack": [{ name: "from-http" }] }));
    });
    const panelOrigin = await listen(panel);
    servers.push({ close: () => closeServer(panel) });

    const relay = await startPanelTemplateRelayServer({
      bridge: {
        canReach: () => true,
        send: async () => {
          throw new Error("fetch_comfyui_read rejected the operation: operation must be one of history, system_stats, logs");
        },
      },
      resolvePanelAgent: () => ({ agentKey: "shared::codex", secret: SECRET }),
      resolvePanelTab: () => "tab-1",
      resolveCurrentTarget: () => ({ url: panelOrigin, generation: 0 }),
      resolvePanelUrl: () => `${panelOrigin}/api/workflow_templates`,
      resolveAllowedPanelOrigin: () => panelOrigin,
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    await expect(requestPanelTemplateIndex()).resolves.toEqual({
      "fallback-pack": [{ name: "from-http" }],
    });
    expect(panelRequests).toBe(1);
  });

  it("only authorizes a loopback origin corroborated by the current target", () => {
    expect(currentPanelTemplateOrigin("https://remote.example:443", "https://remote.example/comfyapi")).toBeUndefined();
    expect(currentPanelTemplateOrigin("http://127.0.0.1:8188", "http://127.0.0.1:8188/comfyapi")).toBe("http://127.0.0.1:8188");
    expect(currentPanelTemplateOrigin("http://[::1]:8188", "http://[::1]:8188/comfyapi")).toBe("http://[::1]:8188");
    // An exact `localhost` pair is authorized (#2382). Refusing it removed the
    // relay for localhost-served users without closing a reachable hazard — see
    // the LOOPBACK_HOSTS comment for the Happy-Eyeballs measurement and for why
    // neither pinning the fetch nor declining to the headless path works here.
    expect(currentPanelTemplateOrigin("http://localhost:8188", "http://localhost:8188/comfyapi")).toBe("http://localhost:8188");
    // Over TLS the name is refused: the address cannot be pinned without
    // breaking verification of a cert issued to it. Literal hosts are fine.
    expect(currentPanelTemplateOrigin("https://localhost:8188", "https://localhost:8188/comfyapi")).toBeUndefined();
    expect(currentPanelTemplateOrigin("https://127.0.0.1:8188", "https://127.0.0.1:8188/comfyapi")).toBe("https://127.0.0.1:8188");
    expect(currentPanelTemplateOrigin("http://localhost:8188", "http://127.0.0.1:8188/comfyapi")).toBeUndefined();
    expect(currentPanelTemplateOrigin("http://[::1]:8188", "http://127.0.0.1:8188/comfyapi")).toBeUndefined();
    expect(currentPanelTemplateOrigin("http://localhost:8188", "http://[::1]:8188/comfyapi")).toBeUndefined();
    expect(currentPanelTemplateOrigin("http://localhost:8189", "http://127.0.0.1:8188/comfyapi")).toBeUndefined();
    expect(currentPanelTemplateOrigin("https://remote.example", "https://other.example/comfyapi")).toBeUndefined();
    expect(currentPanelTemplateOrigin("https://remote.example", "https://remote.example/comfyapi")).toBeUndefined();
    expect(currentPanelTemplateOrigin("https://forged.example", "http://127.0.0.1:8188/comfyapi")).toBeUndefined();
    expect(currentPanelTemplateOrigin(undefined, "https://remote.example/comfyapi")).toBeUndefined();
    expect(currentPanelTemplateOrigin("https://user:secret@remote.example", "https://remote.example/comfyapi")).toBeUndefined();
  });
});

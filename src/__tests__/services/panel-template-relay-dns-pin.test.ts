import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";

// #2382. The relay resolves an ambiguous loopback NAME itself, so this file
// controls what that name resolves to. Before the fetch was pinned, only the
// ORIGIN STRING was checked against the loopback set — a hosts-file entry
// pointing `localhost` off-box would have been fetched with no check at all.
// A dedicated file because every other relay test needs real resolution.
const dnsState = vi.hoisted(() => ({ addresses: [] as Array<{ address: string; family: number }> }));

vi.mock("node:dns", () => ({
  lookup: (
    _hostname: string,
    _options: unknown,
    cb: (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void,
  ) => {
    cb(null, dnsState.addresses);
  },
}));

const { startPanelTemplateRelayServer, requestPanelTemplateIndex } = await import("../../services/panel-template-relay.js");

const SECRET = "c".repeat(64);
const servers: Array<{ close(): Promise<void> }> = [];

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return address.port;
}

afterEach(async () => {
  delete process.env.COMFYUI_MCP_RELAY_SECRET;
  delete process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL;
  for (const server of servers.splice(0)) await server.close();
});

async function driveLocalhostRelay(
  options: { scheme?: string; handler?: (res: import("node:http").ServerResponse) => void } = {},
): Promise<{ readonly panelRequests: number }> {
  let panelRequests = 0;
  const panel = createServer((_req, res) => {
    panelRequests += 1;
    if (options.handler) {
      options.handler(res);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ "panel-pack": [{ name: "served" }] }));
  });
  const port = await listen(panel);
  servers.push({ close: () => new Promise<void>((resolve) => { panel.close(() => resolve()); }) });
  const origin = `${options.scheme ?? "http"}://localhost:${port}`;
  const target = `${origin}/comfyapi`;
  const relay = await startPanelTemplateRelayServer({
    bridge: { canReach: () => true },
    resolvePanelAgent: () => ({ agentKey: "orchestrator::codex", secret: SECRET }),
    resolvePanelTab: () => "tab-1",
    resolveCurrentTarget: () => ({ url: target, generation: 0 }),
    resolvePanelUrl: () => `${origin}/comfyapi/api/workflow_templates`,
    resolveAllowedPanelOrigin: () => origin,
  } as never);
  servers.push(relay);
  process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
  process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;
  // A getter, not a snapshot: the count must be read AFTER the request.
  return { get panelRequests() { return panelRequests; } };
}

describe("panel template relay pins an ambiguous name to loopback literals (#2382)", () => {
  it("refuses an off-loopback https localhost too, not just http", async () => {
    // HTTPS keeps the NAME so a cert issued to `localhost` still verifies, but
    // it must NOT skip the address check on the way: a trusted cert for a
    // `localhost` pointed off-box by a hosts entry would otherwise be fetched
    // and relayed. Keeping the name and validating where it points are separate
    // decisions, and only the first is scheme-dependent.
    dnsState.addresses = [{ address: "203.0.113.7", family: 4 }];
    const state = await driveLocalhostRelay({ scheme: "https" });
    await expect(requestPanelTemplateIndex()).rejects.toMatchObject({ code: "NO_PANEL_ORIGIN" });
    expect(state.panelRequests).toBe(0);
  });


  it("refuses a localhost that resolves off-loopback, without issuing the fetch", async () => {
    dnsState.addresses = [{ address: "203.0.113.7", family: 4 }];
    const state = await driveLocalhostRelay();
    await expect(requestPanelTemplateIndex()).rejects.toMatchObject({ code: "NO_PANEL_ORIGIN" });
    expect(state.panelRequests).toBe(0);
  });

  it("refuses when only ONE of the resolved addresses is off-loopback", async () => {
    // Partial trust is not trust: a name that points anywhere off-box is
    // refused whole, never honoured for its loopback half.
    dnsState.addresses = [
      { address: "127.0.0.1", family: 4 },
      { address: "203.0.113.7", family: 4 },
    ];
    const state = await driveLocalhostRelay();
    await expect(requestPanelTemplateIndex()).rejects.toMatchObject({ code: "NO_PANEL_ORIGIN" });
    expect(state.panelRequests).toBe(0);
  });

  it("serves the index when the name resolves to a single loopback literal", async () => {
    dnsState.addresses = [{ address: "127.0.0.1", family: 4 }];
    const state = await driveLocalhostRelay();
    await expect(requestPanelTemplateIndex()).resolves.toMatchObject({ "panel-pack": [{ name: "served" }] });
    expect(state.panelRequests).toBe(1);
  });
});

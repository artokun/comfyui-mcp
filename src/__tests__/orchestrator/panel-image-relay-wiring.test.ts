import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("../../orchestrator/index.ts", import.meta.url), "utf8");

describe("panel image relay orchestrator wiring (#2149)", () => {
  it("uses the pinned shared-scope resolver, not panelTabOf on shared agent keys", () => {
    expect(SOURCE).toContain("const scopeToRealTab = (tabId: string): string | undefined =>");
    expect(SOURCE).toContain("isScopeAddress(tabId) ? bridge.resolveSharedTabId(tabId) : panelTabOf(tabId)");
    expect(SOURCE).toContain("resolvePanelAgent: panelImageRelayAgentFor");
    expect(SOURCE).toContain("resolvePanelTab: scopeToRealTab");
    expect(SOURCE).toContain("COMFYUI_MCP_RELAY_SECRET: panelImageRelaySecretFor");
    expect(SOURCE).toContain("COMFYUI_MCP_RELAY_URL: panelImageRelayEndpoint");
    expect(SOURCE).not.toContain("processPanelImageRequests({");
  });

  it("wires the list_templates relay into both child spawn lanes and shutdown", () => {
    expect(SOURCE).toContain("startPanelTemplateRelayServer");
    expect(SOURCE).toContain("createPanelTemplateRelayWiring({");
    expect(SOURCE).toContain("currentPanelTemplateOrigin(options.bridge.tabServerOrigin(tabId), options.currentTarget())");
    expect(SOURCE).toContain("...panelTemplateRelayWiring");
    expect(SOURCE).toContain("COMFYUI_MCP_TEMPLATE_RELAY_URL: panelTemplateRelayEndpoint");
    expect(SOURCE).toContain("if (panelTemplateRelayServer) await panelTemplateRelayServer.close()");
  });
});

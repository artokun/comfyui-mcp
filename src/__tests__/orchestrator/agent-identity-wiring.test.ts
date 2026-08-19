// WHICH LLM FILED THE REPORT — the orchestrator half of the channel.
//
// report_issue stamps the reporting model into the issue body, but it can only
// read what the orchestrator published, and it runs in a DIFFERENT PROCESS: the
// comfyui MCP subprocess, which knows nothing about panels, backends or chips.
// Two wires make it work, and either one missing fails silently — reports keep
// filing, just anonymously, which is indistinguishable from "nobody filed any":
//
//   1. the identity file's path reaches the subprocess in its spawn env, on BOTH
//      spawn lanes (the Claude lane's buildMcpServers and the HTTP lane's
//      makeHttpBackendMcpServers);
//   2. the orchestrator republishes the identity at TURN DISPATCH.
//
// Both live inline in the orchestrator's start closure, so — like the other
// index.ts boundary guards (shared-session-invariant.test.ts,
// ask-answer-journal.test.ts) — the wiring is pinned at source level while the
// behaviour underneath is driven by agent-identity.test.ts against the real
// module.
//
// The lane check is not ceremony: this file already carries two written-up
// incidents of a spawn variable forwarded on one lane and not the other
// (COMFYUI_MCP_TOOL_PRESET in panel-secrets.ts, the #547/#884 download stamp),
// and the Claude lane — the DEFAULT backend — is the one that got missed both
// times.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const indexSrc = (): string =>
  readFileSync(new URL("../../orchestrator/index.ts", import.meta.url), "utf8");

/** The source of one inline arrow-function/object block, by its opening line. */
function blockAfter(src: string, opener: string, endMarker: string): string {
  const start = src.indexOf(opener);
  expect(start, `opener not found: ${opener}`).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start);
  expect(end, `end marker not found after ${opener}: ${endMarker}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("agent identity reaches the MCP subprocess (both spawn lanes)", () => {
  it("SOURCE: the HTTP lane (codex/gemini/ollama/…) forwards the identity path", () => {
    const lane = blockAfter(
      indexSrc(),
      "const makeHttpBackendMcpServers = (tabId: string",
      "// Live-graph panel_* tools for THIS tab",
    );
    expect(lane).toContain("...agentIdentityEnv(tabId)");
    // Keyed by the same agent key the lane already self-scopes downloads with —
    // one agent, one identity file, no cross-provider bleed when several
    // backends are live at once (#884).
    expect(lane).toContain("COMFYUI_MCP_TAB: tabId");
  });

  it("SOURCE: the CLAUDE lane forwards it too — the one that gets missed", () => {
    const lane = blockAfter(
      indexSrc(),
      "const buildMcpServers = (agentKey?: string)",
      "const manager = new PanelAgentManager",
    );
    expect(lane).toContain("...agentIdentityEnv(agentKey)");
  });

  it("SOURCE: the path is derived ONCE, from the bridge port and the agent key", () => {
    const src = indexSrc();
    // Port-scoped for the reason SessionStore is: the agent key carries no port,
    // so two ComfyUI instances on one machine would otherwise stamp each other's
    // model onto each other's reports.
    expect(src).toContain("agentIdentityPath(bridgePort, agentKey)");
    // …and no lane builds its own path expression.
    expect(src.match(/agentIdentityPath\(/g)?.length).toBe(2); // the derivation + the publish
  });
});

describe("the identity is republished at TURN DISPATCH", () => {
  it("SOURCE: onTurn publishes on 'working', not on 'done'", () => {
    const handler = blockAfter(indexSrc(), "onTurn: (key, state) => {", "onThinking:");
    // "working" fires at dispatch — before the backend starts the turn, and so
    // before any tool that turn calls. Publishing on "done" would be too late
    // for the report the turn itself files.
    expect(handler).toContain('if (state === "working") republishAgentIdentity(key)');
  });

  it("SOURCE: it reads THE CHIPS — the same expression the panel is sent as `current`", () => {
    const src = indexSrc();
    const publisher = blockAfter(
      src,
      "function republishAgentIdentity(key: string): void {",
      "function pushModels(",
    );
    const chips = "manager.modelOverrideFor(";
    // pushModels sends the panel `modelOverrideFor(key) ?? currentModelFor(backend)`
    // as the chip's `current`. The stamp must name what the picker shows, not a
    // second notion of "the model" that can drift from it.
    expect(publisher).toContain(chips);
    expect(publisher).toContain("currentModelFor(backend)");
    expect(blockAfter(src, "function pushModels(panelTabId: string): void {", "\n  }")).toContain(
      chips,
    );
  });

  it("SOURCE: a failed write is not remembered as published", () => {
    const publisher = blockAfter(
      indexSrc(),
      "function republishAgentIdentity(key: string): void {",
      "function pushModels(",
    );
    // The dedupe cache exists to skip redundant writes, not to latch a failure:
    // caching the fingerprint unconditionally would let one transient EPERM
    // suppress every later publish for that agent, for the life of the process.
    expect(publisher).toContain("if (publishAgentIdentity(");
  });
});

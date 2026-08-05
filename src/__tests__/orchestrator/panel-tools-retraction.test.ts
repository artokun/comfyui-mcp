// The panel system prompt tells every backend it can see and edit the user's open
// canvas through panel_* tools. For the HTTP-lane backends that is true only while
// the loopback panel MCP is bound — when the bind fails, makeHttpBackendMcpServers()
// silently omits the `panel` server and the prompt goes on claiming it anyway. The
// model then improvises against a toolset it does not have, and the user reads that
// as the panel being broken.
//
// This is #804's shape (a capability we cannot deliver, asserted as available) with
// the one difference that makes it fixable rather than merely documentable: we
// OBSERVED the failure. It is our own bind returning an error, not a client-side
// permission block we can never see.

import { describe, expect, it } from "vitest";
import { panelToolsRetraction } from "../../orchestrator/index.js";

describe("panel_* claim is retracted when the loopback panel MCP did not bind", () => {
  it("says nothing at all while the panel tools really are available", () => {
    for (const backend of ["codex", "gemini", "grok", "ollama", "claude", "pi"]) {
      expect(panelToolsRetraction(backend, true)).toBe("");
    }
  });

  it("retracts the canvas claim for an HTTP-lane backend when the bind failed", () => {
    const note = panelToolsRetraction("codex", false);
    expect(note).not.toBe("");
    // States the observation and its consequence...
    expect(note).toMatch(/loopback panel MCP server failed to start/);
    expect(note).toMatch(/no panel_\* tool .* exists in your runtime/);
    // ...tells the model not to narrate doing it anyway, which is the actual
    // failure mode (improvising against absent tools reads as a broken panel)...
    expect(note).toMatch(/never claim to, pretend to, or narrate doing so/);
    // ...and leaves a route that still works, since a remedy has to be reachable
    // from where the caller is standing.
    expect(note).toMatch(/\bget_workflow\b/);
    expect(note).toMatch(/restarting the orchestrator/);
  });

  it("retracts ONLY the canvas surface — the headless comfyui tools are untouched", () => {
    // Over-retracting would be the same defect pointing the other way: the stdio
    // comfyui server is still attached and every one of its tools still works.
    const note = panelToolsRetraction("codex", false);
    expect(note).toMatch(/headless comfyui tools are UNAFFECTED/);
  });

  it("stays silent for pi, whose own override already retracts strictly more", () => {
    // pi has no MCP client at all. A second, narrower retraction stacked on top of
    // PI_CAPABILITY_OVERRIDE would only muddy it.
    expect(panelToolsRetraction("pi", false)).toBe("");
  });

  it("stays silent for claude, which does not use the HTTP panel server at all", () => {
    // Claude drives the canvas through its own in-process panel server, so a failed
    // HTTP bind takes nothing away from it — retracting there would be a false
    // claim in the opposite direction.
    expect(panelToolsRetraction("claude", false)).toBe("");
  });
});

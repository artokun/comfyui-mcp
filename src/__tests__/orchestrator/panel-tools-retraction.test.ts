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
import { OLLAMA_SYSTEM_PROMPT, ollamaPanelRetraction } from "../../orchestrator/ollama-backend.js";

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
    // ...and stops there. "That is ALL this tells you" is the load-bearing clause.
    expect(note).toMatch(/That is ALL this tells you/);
  });

  it("retracts ONLY the canvas surface, without vouching for the headless one", () => {
    // Over-retracting would be the same defect pointing the other way. But so is
    // UNDER-retracting into a fresh claim: the stdio child is a separate connection
    // that can fail on its own, so the note may be emitted with nothing connected.
    // It must therefore neither condemn nor vouch — only point at the real list.
    const note = panelToolsRetraction("codex", false);
    expect(note).toMatch(/SEPARATE connection that succeeds or fails on its own/);
    expect(note).toMatch(/go by the tool list you were actually given/);
    expect(note).not.toMatch(/UNAFFECTED/);
    expect(note).not.toMatch(/still work\b/);
  });

  it("does not promise that a restart brings the canvas tools back", () => {
    // A bind failure whose cause persists — the port simply stays occupied —
    // survives a restart, so "restarting restores them" is unobserved. What IS
    // known is that the tool set is fixed for the session.
    const note = panelToolsRetraction("codex", false);
    expect(note).toMatch(/cannot come back during this session/);
    expect(note).toMatch(/Do not promise a restart will fix it/);
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

// The Ollama-family adapter (ollama / openrouter / lmstudio / llamacpp / custom /
// kimi) deliberately IGNORES deps.systemAppend and uses its own prompt, so the
// orchestrator-side retraction above can never reach it. That prompt opens by
// promising "exactly six tools" and names all three panel_* routers — which are
// registered only when the panel router actually came up.
describe("the Ollama-family prompt retracts its own panel router claim", () => {
  it("promises six tools including the panel routers by default", () => {
    // The claim being corrected — pinned so this fails loudly if the prompt is
    // reworded and the retraction silently stops matching what it retracts.
    expect(OLLAMA_SYSTEM_PROMPT).toContain("You have exactly six tools");
    expect(OLLAMA_SYSTEM_PROMPT).toContain("panel_list_tools / panel_describe_tool / panel_call_tool");
  });

  it("says nothing while the router really is registered", () => {
    expect(ollamaPanelRetraction(true)).toBe("");
  });

  it("names the three tools that do not exist, and states no tool COUNT", () => {
    const note = ollamaPanelRetraction(false);
    expect(note).toMatch(/panel_list_tools, panel_describe_tool and panel_call_tool DO NOT EXIST/);
    // No count: "six" is only right under COMFYUI_MCP_TOOL_MODE=compact, so any
    // arithmetic here would be a second wrong number replacing the first. The model
    // is sent to the list it was actually handed.
    expect(note).not.toMatch(/\b(three|THREE|six|SIX|3|6)\b/);
    expect(note).toMatch(/go by the tool list you were actually handed/);
    expect(note).toMatch(/never claim to have read or edited the user's canvas/);
  });

  it("neither vouches for the headless server nor promises a restart", () => {
    // connectTools() catches a failed headless connection independently and leaves
    // `comfy` null, so this prompt can be emitted with NOTHING connected — and the
    // session's tool set is fixed, so the router cannot return within it. Retracting
    // one false capability claim while attaching two new ones is the same defect.
    const note = ollamaPanelRetraction(false);
    expect(note).toMatch(/That is ALL this tells you/);
    expect(note).toMatch(/separate connection that can succeed or fail on its own/);
    expect(note).toMatch(/cannot come back during this session/);
    expect(note).toMatch(/Do not promise that a restart will fix it/);
    expect(note).not.toMatch(/unaffected/i);
    expect(note).not.toMatch(/You can still do everything/);
  });
});

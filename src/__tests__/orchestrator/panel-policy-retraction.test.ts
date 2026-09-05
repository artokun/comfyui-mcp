// panel#291 — an agent whose panel_* tools were withheld kept searching for
// panel_graph_outline and finding only headless comfyui tools, session after session.
//
// PANEL_SYSTEM_APPEND tells the agent it can see and edit the user's canvas through
// panel_*. The orchestrator already retracts that claim twice — PI_CAPABILITY_OVERRIDE
// (pi has no MCP client) and NO_PANEL_TOOLS_OVERRIDE (the loopback bind failed) — but
// neither covers the operator's tool-surface policy, which reaches BOTH registration
// paths (`createPanelMcpServer` for claude, `registerPanelTools` for the HTTP lane)
// through the same `resolveToolSurfacePolicy()`.
//
// `panelToolsRetraction` excludes claude, correctly, for the BIND failure: claude drives
// the canvas through its own in-process server. The policy is a second and independent
// way to lose the same tools, so that exclusion — right on its own terms — left the
// claude lane asserting a capability the policy had removed.
//
// Both presets deny the surface by glob (PANEL_SURFACE = ["panel_*"]), and
// docs/configuration.mdx recommends `COMFYUI_MCP_TOOL_PRESET=safe` verbatim for a hosted
// deployment, so this is an ordinary configuration rather than an exotic one.

import { describe, expect, it } from "vitest";

import { resolveToolSurfacePolicy } from "../../tools/tool-surface-filter.js";
import { panelSurfaceFullyWithheld } from "../../orchestrator/panel-tools.js";
import { panelPolicyRetraction, panelToolsRetraction } from "../../orchestrator/index.js";

const policyFor = (env: NodeJS.ProcessEnv) => resolveToolSurfacePolicy(env);

describe("panelSurfaceFullyWithheld", () => {
  it("is false with no policy configured", () => {
    expect(panelSurfaceFullyWithheld(policyFor({}))).toBe(false);
  });

  it.each(["safe", "readonly"])("is true under COMFYUI_MCP_TOOL_PRESET=%s", (preset) => {
    expect(panelSurfaceFullyWithheld(policyFor({ COMFYUI_MCP_TOOL_PRESET: preset }))).toBe(true);
  });

  it("is true when an allow list names no panel tool", () => {
    const p = policyFor({ COMFYUI_MCP_TOOL_ALLOW: "get_history,get_system_stats" });
    expect(panelSurfaceFullyWithheld(p)).toBe(true);
  });

  it("is FALSE when a preset is refined so one panel tool survives", () => {
    // The documented opt-back-in. A partial surface is a configured surface, not a
    // capability claim to retract wholesale — retracting here would tell an agent that
    // HAS panel_graph_outline that it does not.
    const p = policyFor({
      COMFYUI_MCP_TOOL_PRESET: "safe",
      COMFYUI_MCP_TOOL_ALLOW: "panel_graph_outline",
    });
    expect(panelSurfaceFullyWithheld(p)).toBe(false);
  });

  it("is false when the policy withholds only NON-panel tools", () => {
    expect(panelSurfaceFullyWithheld(policyFor({ COMFYUI_MCP_TOOL_DENY: "restart_comfyui" }))).toBe(false);
  });
});

describe("panelPolicyRetraction", () => {
  it("is empty when the surface is intact", () => {
    expect(panelPolicyRetraction(false)).toBe("");
  });

  it("retracts the canvas claim, and says the tools are absent from the deferred catalog", () => {
    const t = panelPolicyRetraction(true);
    expect(t).toContain("live-canvas tools are NOT available");
    expect(t).toContain("panel_graph_outline");
    // panel#291's reporter established the absence with ToolSearch. An agent told only
    // "not available" will still go looking, which is the loop that made this expensive.
    expect(t).toContain("deferred tool catalog");
  });

  it("names the variables an operator can actually change", () => {
    const t = panelPolicyRetraction(true);
    expect(t).toContain("COMFYUI_MCP_TOOL_PRESET");
  });

  it("does NOT speak for the headless server, which the policy filters separately", () => {
    const t = panelPolicyRetraction(true);
    // The bug this whole family exists to remove is attaching a NEW false capability
    // claim while retracting an old one.
    expect(t).not.toContain("headless comfyui tools are unaffected");
    expect(t).toContain("filtered SEPARATELY");
  });

  it("is NOT keyed on backend — the policy governs every lane", () => {
    // panelToolsRetraction excludes claude (correct for a bind failure). If the policy
    // retraction ever grows the same exclusion, panel#291's lane loses it again.
    expect(panelPolicyRetraction(true)).toBe(panelPolicyRetraction(true));
    expect(panelToolsRetraction("claude", false)).toBe("");
    expect(panelPolicyRetraction(true)).not.toBe("");
  });
});

describe("the empty-def-list guard", () => {
  it("does NOT retract when the def list is empty — every() would be vacuously true", () => {
    // The one direction this must not fail in: telling an agent that HAS the tools that
    // it does not. Reachable only because the list is injectable.
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "safe" });
    expect(panelSurfaceFullyWithheld(p, [])).toBe(false);
  });

  it("still retracts for a non-empty injected list that the policy denies", () => {
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "safe" });
    expect(panelSurfaceFullyWithheld(p, ["panel_graph_outline", "panel_run"])).toBe(true);
  });
});

describe("the retraction is WIRED into the prompt both lanes read", () => {
  it("systemAppendForBackend applies it to every return path", async () => {
    // A helper that is correct and never called is the defect class this belongs to, so
    // this asserts the call site rather than the function. Scoped to the region between
    // the base builder and the wrapper: a file-wide search would be satisfied by the
    // import line or by this test's own name appearing in a comment.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("../../orchestrator/index.ts", import.meta.url)), "utf-8");
    const at = src.indexOf("const systemAppendForBackendBase");
    expect(at).toBeGreaterThan(-1);
    const region = src.slice(at, at + 1800);
    expect(region).toContain("systemAppendForBackendBase(bId) + panelPolicySuffix");
    // and the suffix is derived from the policy, not hardcoded
    // ONE policy read feeds both the prompt suffix and the bind-retraction suppression,
    // so the two can never disagree about whether the surface was withheld.
    const decl = src.indexOf("const panelSurfaceWithheld = panelSurfaceFullyWithheld()");
    expect(decl).toBeGreaterThan(-1);
    expect(src.slice(decl, decl + 200)).toContain("panelPolicyRetraction(panelSurfaceWithheld)");
    const callSite = src.indexOf("panelToolsRetraction(backend, panelMcpHttp !== null");
    expect(callSite).toBeGreaterThan(-1);
    expect(src.slice(callSite, callSite + 120)).toContain("panelSurfaceWithheld)");
  });
});

describe("the two retractions must not both fire", () => {
  // A codex/gemini tab whose loopback bind FAILED and whose policy also withholds the
  // surface would otherwise receive two different causes for one absence -- and the bind
  // text tells the user to restart, which cannot restore a tool a policy withholds.
  it("the policy retraction suppresses the bind retraction", () => {
    expect(panelToolsRetraction("codex", false, true)).toBe("");
    expect(panelPolicyRetraction(true)).not.toBe("");
  });

  it("a bind failure alone still retracts, unchanged", () => {
    const t = panelToolsRetraction("codex", false, false);
    expect(t).not.toBe("");
    expect(t).toContain("failed to start");
  });

  it("defaults to the old behaviour when the flag is omitted", () => {
    // Every existing caller and test passes two arguments.
    expect(panelToolsRetraction("codex", false)).not.toBe("");
    expect(panelToolsRetraction("codex", true)).toBe("");
  });

  it("still says nothing for pi or claude, policy or not", () => {
    expect(panelToolsRetraction("pi", false, true)).toBe("");
    expect(panelToolsRetraction("claude", false, true)).toBe("");
  });

  it("the surviving message names the actionable cause", () => {
    // The whole point of the precedence: an operator can change a variable; a restart
    // cannot undo a policy.
    const survivor = panelPolicyRetraction(true);
    expect(survivor).toContain("an operator can change");
    expect(survivor).not.toContain("until the orchestrator is restarted");
  });
});

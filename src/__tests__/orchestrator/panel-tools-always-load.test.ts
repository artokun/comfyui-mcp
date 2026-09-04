// panel#291 — the panel's live-canvas tools must reach the turn-1 prompt.
//
// The reported failure (Claude backend, mcp 0.52.186 / panel 0.15.165, 100%
// reproducible): every `panel_*` tool absent from BOTH the directly declared tools
// and the deferred `ToolSearch` catalog, while the spawned `comfyui` stdio server
// works throughout. The two servers differ in exactly one relevant way — `panel` is
// an in-process `createSdkMcpServer`, `comfyui` is a stdio subprocess — and the SDK
// defers in-process tool schemas by default once tool search is enabled:
//
//   CreateSdkMcpServerOptions.alwaysLoad:
//     "When true, all tools from this server are always included in the prompt and
//      never deferred behind tool search. … Default: tools are deferred when tool
//      search is enabled."
//
//   McpStdioServerConfig.alwaysLoad adds why it matters:
//     "…since the tools must be present when the turn-1 prompt is built."
//
// This pins that we ask for that. It is NOT a claim that deferral is the cause —
// deferral would leave the tools findable via ToolSearch, and the report says they
// are not — it removes the variable so the next report distinguishes "deferred and
// unfound" from "never registered".

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../orchestrator/panel-tools.ts", import.meta.url));

describe("panel#291 the in-process panel server opts out of tool-search deferral", () => {
  it("passes alwaysLoad to createSdkMcpServer", () => {
    const src = readFileSync(SRC, "utf8");
    const at = src.indexOf("createSdkMcpServer({");
    expect(at).toBeGreaterThan(-1);
    const call = src.slice(at, src.indexOf("})", at));
    expect(call).toContain("alwaysLoad: true");
  });

  it("names comfyui-panel, so the opt-out lands on the server the report is about", () => {
    // Guards against the assertion above drifting onto some other SDK server if one
    // is ever added to this file: the property and the name must be in one call.
    const src = readFileSync(SRC, "utf8");
    const at = src.indexOf("createSdkMcpServer({");
    const call = src.slice(at, src.indexOf("})", at));
    expect(call).toContain('name: "comfyui-panel"');
  });
});

// Issue #255 (review finding 5) — the orchestrator's onStartFailure wiring had
// no test coverage. The frame construction now lives in start-failure-notice.ts
// (extracted from index.ts's inline handler) so this can pin down:
//   • hint selection via the OpenAI-key provider registry (openAiKeyProvider),
//     with the openrouter / custom / generic fallbacks;
//   • composite-key (`panelTabId::backend`) → panel tab mapping, including the
//     split-on-LAST-separator rule and the bare-key fallback;
//   • the exact frame sequence pushed to the panel: honest say → degraded ack →
//     turn:"done" (NOT "idle" — the panel's turn handler only recognizes
//     working/done, so an idle frame never clears the spinner; issue #257).

import { describe, expect, it } from "vitest";
import {
  backendOfKey,
  buildStartFailureNotice,
  panelTabOfKey,
  startFailureHint,
} from "../../orchestrator/start-failure-notice.js";

describe("composite agent key → panel tab mapping", () => {
  it("splits `panelTabId::backend` on the LAST separator", () => {
    expect(panelTabOfKey("tab-1::moonshot")).toBe("tab-1");
    expect(backendOfKey("tab-1::moonshot", "claude")).toBe("moonshot");
  });

  it("a bare key (no separator) maps to itself + the default backend", () => {
    expect(panelTabOfKey("tab-plain")).toBe("tab-plain");
    expect(backendOfKey("tab-plain", "claude")).toBe("claude");
  });

  it("a tab id that itself contains '::'-free prefixes still splits correctly", () => {
    // Deterministic panel ids look like "wf:abc" / "tmp:abc" — the colon inside
    // the tab half must not confuse the split.
    expect(panelTabOfKey("wf:abc123::glm")).toBe("wf:abc123");
    expect(backendOfKey("wf:abc123::glm", "claude")).toBe("glm");
  });
});

describe("startFailureHint provider selection", () => {
  it("names a registered OpenAI-key provider's slot + primary env key", () => {
    // moonshot / glm / kimi live in the openai-provider-registry.
    expect(startFailureHint("moonshot")).toContain("MOONSHOT_API_KEY");
    expect(startFailureHint("glm")).toContain("GLM_API_KEY");
    expect(startFailureHint("kimi")).toContain("KIMI_API_KEY");
    expect(startFailureHint("moonshot")).toContain("API Keys card");
  });

  it("falls back for openrouter, custom, and unknown backends", () => {
    expect(startFailureHint("openrouter")).toContain("OPENROUTER_API_KEY");
    expect(startFailureHint("custom")).toContain("Custom endpoint");
    expect(startFailureHint("claude")).toBe(
      "Check the provider's credentials/login, then Disconnect → Connect to retry.",
    );
  });
});

describe("buildStartFailureNotice frames", () => {
  it("pushes say → degraded ack → turn:done to the PANEL tab", () => {
    const { panelTab, backend, frames } = buildStartFailureNotice(
      "tab-abc::moonshot",
      "endpoint https://api.moonshot.ai/v1 rejected the key (http 401)",
      "claude",
    );
    expect(panelTab).toBe("tab-abc");
    expect(backend).toBe("moonshot");
    expect(frames).toHaveLength(3);

    const [say, ack, turn] = frames;
    expect(say!.type).toBe("say");
    expect(say!.text).toContain("The moonshot agent could not start");
    expect(say!.text).toContain("rejected the key (http 401)");
    expect(say!.text).toContain("MOONSHOT_API_KEY");

    expect(ack).toEqual({ type: "ack", ok: false, kind: "degraded" });

    // The panel clears its thinking spinner ONLY on turn:"done" — "idle" is a
    // no-op in the panel's handler (issue #257), so this must stay "done".
    expect(turn).toEqual({ type: "turn", state: "done" });
  });

  it("a bare (non-composite) key degrades under the default backend's generic hint", () => {
    const { panelTab, backend, frames } = buildStartFailureNotice("tab-solo", "boom", "claude");
    expect(panelTab).toBe("tab-solo");
    expect(backend).toBe("claude");
    expect(frames[0]!.text).toContain("The claude agent could not start: boom");
  });
});

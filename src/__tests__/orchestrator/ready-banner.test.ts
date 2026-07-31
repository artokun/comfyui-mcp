// #376 — the ready banner must show the ACTUALLY-resolved model, not the pre-init
// default that was sent at hello time. bannerCorrection is the decision the
// SDK-init handler uses to re-send a corrected banner.

import { describe, expect, it } from "vitest";
import { readyBannerText, bannerCorrection } from "../../orchestrator/ready-banner.js";

describe("ready-banner text + correction (#376)", () => {
  it("readyBannerText substitutes the given model label (Claude/default path)", () => {
    const text = readyBannerText("claude", "claude-sonnet-4-5");
    expect(text).toContain("claude-sonnet-4-5");
    expect(text).toMatch(/on your Claude subscription/);
    // Must NOT hardcode the pre-init default.
    expect(text).not.toContain("claude-opus-5");
  });

  it("readyBannerText renders provider-specific phrasing with the label", () => {
    expect(readyBannerText("codex", "gpt-5.5")).toMatch(/gpt-5\.5.*Codex/);
    expect(readyBannerText("custom", "my-model", "http://localhost:8000/v1")).toContain(
      "http://localhost:8000/v1",
    );
  });

  // CORE #376 regression: the banner advertised the pre-init default, but the SDK
  // resolved a DIFFERENT model → a corrected banner must be produced showing the
  // real model. FAIL-BEFORE: nothing re-sent, so the wrong "claude-opus-5" stuck.
  it("bannerCorrection produces a corrected banner when the resolved model differs", () => {
    const corrected = bannerCorrection({
      backend: "claude",
      advertisedLabel: "claude-opus-5",
      resolvedModel: "claude-sonnet-4-5",
    });
    expect(corrected).not.toBeNull();
    expect(corrected!).toContain("claude-sonnet-4-5");
    expect(corrected!).not.toContain("claude-opus-5");
  });

  it("bannerCorrection returns null when the resolved model matches the advertised label (no duplicate)", () => {
    expect(
      bannerCorrection({
        backend: "claude",
        advertisedLabel: "claude-opus-5",
        resolvedModel: "claude-opus-5",
      }),
    ).toBeNull();
  });

  // A resume/reconnect never sent a greeting, so the advertised-label map is empty.
  // bannerCorrection must NOT treat an absent label as a mismatch (no spurious banner
  // on resume) — this is P1-a from the codex gate.
  it("bannerCorrection returns null when no banner was advertised (resume/reconnect)", () => {
    expect(
      bannerCorrection({
        backend: "claude",
        advertisedLabel: undefined,
        resolvedModel: "claude-sonnet-4-5",
      }),
    ).toBeNull();
    expect(
      bannerCorrection({
        backend: "claude",
        advertisedLabel: "",
        resolvedModel: "claude-sonnet-4-5",
      }),
    ).toBeNull();
  });

  it("bannerCorrection returns null when no model was resolved (no init model)", () => {
    expect(
      bannerCorrection({
        backend: "claude",
        advertisedLabel: "claude-opus-5",
        resolvedModel: undefined,
      }),
    ).toBeNull();
    expect(
      bannerCorrection({
        backend: "claude",
        advertisedLabel: "claude-opus-5",
        resolvedModel: "   ",
      }),
    ).toBeNull();
  });
});

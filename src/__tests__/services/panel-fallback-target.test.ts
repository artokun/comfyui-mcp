import { describe, expect, it } from "vitest";
import { provenPanelOriginMatchesConfiguredTarget } from "../../services/panel-fallback-target.js";

describe("provenPanelOriginMatchesConfiguredTarget (#2839)", () => {
  it("requires a unique published origin that matches the configured target", () => {
    expect(
      provenPanelOriginMatchesConfiguredTarget(
        ["https://remote.example"],
        "https://remote.example/comfyapi",
      ),
    ).toBe(true);
    expect(
      provenPanelOriginMatchesConfiguredTarget(
        ["http://127.0.0.1:8188"],
        "http://127.0.0.1:8188/comfyapi",
      ),
    ).toBe(true);
  });

  it("stays unproven for empty, mixed, malformed, or mismatched sets", () => {
    expect(provenPanelOriginMatchesConfiguredTarget([], "https://remote.example/comfyapi")).toBe(false);
    expect(
      provenPanelOriginMatchesConfiguredTarget(
        ["https://remote.example", "https://other.example"],
        "https://remote.example/comfyapi",
      ),
    ).toBe(false);
    expect(
      provenPanelOriginMatchesConfiguredTarget(["not-an-origin"], "https://remote.example/comfyapi"),
    ).toBe(false);
    expect(
      provenPanelOriginMatchesConfiguredTarget(
        ["https://remote.example"],
        "http://127.0.0.1:8188",
      ),
    ).toBe(false);
  });
});

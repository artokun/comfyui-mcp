// panel#851 — `panel_restart_comfyui` timed out on its confirmation card and told the
// caller to "use restart_comfyui to restart the server directly". They did. That tool
// targets COMFYUI_URL, NOT the ComfyUI the panel is running inside, so it failed with
// `No ComfyUI process found on port 8188 to restart` while panel tools had been working
// happily on the live canvas. The advice was given without ever checking which server it
// pointed at.
//
// THE DISCRIMINATOR, and why it is used carefully. `captureRebootHealthBase()` is a
// PROOF, not a comparison: null in remote/cloud mode, and whenever the tab's origin
// cannot be shown to front the local boot instance. So "unproven" is deliberately NOT
// folded into "different" — that would fire the warning on ordinary remote installs
// where the two ARE the same server, trading a wrong recommendation for a wrong alarm.
//
// These drive the real decision function rather than asserting on source text. An
// earlier version of this file asserted the branch's source, and a mutation that
// inverted the logic while leaving both branches present SURVIVED it — which is why the
// decision was extracted into a pure helper.
import { describe, it, expect } from "vitest";
import { restartTimeoutFallbackAdvice } from "../../orchestrator/panel-tools.js";

const advice = (headlessBase: string, panelBase: string | null) =>
  restartTimeoutFallbackAdvice({ headlessBase, panelBase });

describe("#851 restart-timeout fallback advice", () => {
  it("recommends restart_comfyui plainly when the targets PROVABLY match", () => {
    const a = advice("http://127.0.0.1:8188", "http://127.0.0.1:8188");
    expect(a).toContain("or use restart_comfyui to restart the server directly");
    expect(a).not.toContain("Do NOT");
  });

  it("tolerates a trailing-slash difference — same server, not a mismatch", () => {
    expect(advice("http://127.0.0.1:8188", "http://127.0.0.1:8188/")).toContain(
      "or use restart_comfyui to restart the server directly",
    );
  });

  it("REFUSES to recommend it when the targets are proven different, and names both", () => {
    const a = advice("http://127.0.0.1:8188", "http://127.0.0.1:8199");
    expect(a).toContain("Do NOT reach for restart_comfyui");
    expect(a).toContain("http://127.0.0.1:8188");
    expect(a).toContain("http://127.0.0.1:8199");
    expect(a).toContain("different server than the one you have been working on");
    // The reporter's exact harm: it may find nothing at all on the other target.
    expect(a).toContain("may find nothing there at all");
  });

  it("a different PATH on the same host is still a different target", () => {
    // sameHttpBase is path-aware: a basePath mount is a distinct instance.
    expect(advice("http://127.0.0.1:8188/comfy", "http://127.0.0.1:8188")).toContain("Do NOT");
  });

  it("when the origin is UNPROVEN it keeps the advice but NAMES the target", () => {
    // This is the anti-cry-wolf case: captureRebootHealthBase returns null by design on
    // every remote/cloud install, where the two targets are usually the same server.
    const a = advice("https://remote.example:8188", null);
    expect(a).toContain("or use restart_comfyui, which restarts https://remote.example:8188");
    expect(a).toContain("could not confirm which one this panel is running inside");
    expect(a).not.toContain("Do NOT");
  });

  it("never recommends a bare restart without naming a server", () => {
    // The regression this whole issue is: advice that does not say what it will hit.
    for (const a of [
      advice("http://127.0.0.1:8188", "http://127.0.0.1:8188"),
      advice("http://127.0.0.1:8188", "http://127.0.0.1:8199"),
      advice("https://remote.example:8188", null),
    ]) {
      expect(a).toContain("restart_comfyui");
    }
    // Only the provably-same case may omit an explicit origin, because it is the one
    // case where "the server" is unambiguous.
    expect(advice("http://127.0.0.1:8199", null)).toContain("http://127.0.0.1:8199");
    expect(advice("http://a:1", "http://b:2")).toContain("http://b:2");
  });
});

// ---------------------------------------------------------------------------
// #1233 — a CONFIRMED mismatch must not be lost inside the proof's null.
// ---------------------------------------------------------------------------

describe("#1233 confirmed mismatch reaches the strong warning", () => {
  const advise = (headlessBase: string, panelBase: string | null, observedOrigin: string | null) =>
    restartTimeoutFallbackAdvice({ headlessBase, panelBase, observedOrigin });

  it("a SECOND local instance on another port is proven different, not merely unproven", () => {
    // panel#851's own motivating case. captureRebootHealthBase returns null here — it
    // proves sameness with the BOOT base and a :8189 tab is not that — but the observed
    // origin is positive evidence of a mismatch, and it used to be discarded.
    const a = advise("http://127.0.0.1:8188", null, "http://127.0.0.1:8189");
    expect(a).toContain("Do NOT reach for restart_comfyui");
    expect(a).toContain("http://127.0.0.1:8189");
  });

  it("an observed origin that MATCHES does not manufacture a warning", () => {
    // Unproven-but-consistent stays the mild, target-naming advice.
    const a = advise("http://127.0.0.1:8188", null, "http://127.0.0.1:8188");
    expect(a).not.toContain("Do NOT");
    expect(a).toContain("or use restart_comfyui, which restarts http://127.0.0.1:8188");
  });

  it("no observed origin at all is still unproven — absence is not evidence", () => {
    const a = advise("http://127.0.0.1:8188", null, null);
    expect(a).not.toContain("Do NOT");
    expect(a).toContain("could not confirm which one this panel is running inside");
  });

  it("the proof still wins when it is available", () => {
    expect(advise("http://a:1", "http://a:1", "http://zzz:9")).toContain(
      "or use restart_comfyui to restart the server directly",
    );
  });

  it("the warning names the SUCCEED-on-the-wrong-server risk, not only the no-op", () => {
    // The old text said only "may find nothing there at all". In this branch the other
    // target is a LIVE server by construction, so succeeding is the worse outcome.
    const a = advise("http://127.0.0.1:8188", "http://127.0.0.1:8189", null);
    expect(a).toContain("may find nothing there");
    expect(a).toContain("SUCCEED and take down a ComfyUI you did not mean to touch");
  });
});

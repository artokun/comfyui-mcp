import { describe, expect, it } from "vitest";
import {
  formatEnvBlock,
  applyStats,
  buildPanelSystemAppend,
  type EnvCapabilities,
} from "../../services/env-capabilities.js";

describe("formatEnvBlock", () => {
  it("renders the full compact block from a complete caps object", () => {
    const caps: EnvCapabilities = {
      os: "Windows 11",
      gpu: "NVIDIA RTX 4090",
      vramTotalGb: 24,
      ramGb: 64,
      cuda: "13.0",
      torch: "2.10.0",
      python: "3.13",
      comfyui: "0.26.1",
      location: "LOCAL",
      triton: "not-installed",
      sageattention: "not-installed",
      backend: "Codex",
      otherBackendAvailable: true,
    };
    const out = formatEnvBlock(caps);
    expect(out).toContain("ENVIRONMENT (live, this machine):");
    expect(out).toContain("OS Windows 11");
    expect(out).toContain("GPU NVIDIA RTX 4090 (24 GB VRAM)");
    expect(out).toContain("64 GB RAM");
    expect(out).toContain("CUDA 13.0");
    expect(out).toContain("torch 2.10.0");
    expect(out).toContain("python 3.13");
    expect(out).toContain("ComfyUI 0.26.1 (LOCAL)");
    expect(out).toContain("Triton: not installed");
    expect(out).toContain("SageAttention: not installed");
    expect(out).toContain("Backend: Codex; other providers available");
    // The guidance tail (acceleration decision) is always appended.
    expect(out).toContain("default to sdpa + no");
    expect(out).toContain("triton-sageattention skill");
  });

  it("omits unknown fields cleanly (no empty separators / placeholders)", () => {
    const caps: EnvCapabilities = {
      os: "Linux",
      ramGb: 32,
      location: "REMOTE",
      // gpu, cuda, torch, python, comfyui, triton, sageattention all unknown
      backend: "Claude",
      otherBackendAvailable: false,
    };
    const out = formatEnvBlock(caps);
    expect(out).toContain("OS Linux");
    expect(out).toContain("32 GB RAM");
    expect(out).toContain("(REMOTE)");
    expect(out).toContain("Backend: Claude");
    // Other provider not available → no "also available" clause.
    expect(out).not.toContain("also available");
    // Unknown fields are absent entirely. We check the field SEGMENTS (which sit
    // between " · " separators) rather than bare words, since the static guidance
    // tail legitimately mentions e.g. "torch.compile" / "Triton/SageAttention".
    const segments = out
      .replace(/^ENVIRONMENT \(live, this machine\): /, "")
      .split(". ")[0]
      .split(" · ");
    expect(segments.some((s) => s.startsWith("GPU "))).toBe(false);
    expect(segments.some((s) => s.startsWith("CUDA "))).toBe(false);
    expect(segments.some((s) => s.startsWith("torch "))).toBe(false);
    expect(segments.some((s) => s.startsWith("python "))).toBe(false);
    expect(segments.some((s) => s.startsWith("Triton:"))).toBe(false);
    expect(segments.some((s) => s.startsWith("SageAttention:"))).toBe(false);
    // No double separators or trailing junk.
    expect(out).not.toContain("··");
    expect(out).not.toContain(" · .");
  });

  it("treats triton/sageattention 'unknown' as omitted", () => {
    const out = formatEnvBlock({
      os: "Windows 11",
      triton: "unknown",
      sageattention: "unknown",
    });
    // The field labels ("Triton: …" / "SageAttention: …") must be absent — the
    // guidance tail's "Triton/SageAttention" mention is fine.
    expect(out).not.toContain("Triton:");
    expect(out).not.toContain("SageAttention:");
  });

  it("renders ComfyUI location even when the version is unknown", () => {
    const out = formatEnvBlock({ location: "LOCAL" });
    expect(out).toContain("ComfyUI (LOCAL)");
    expect(out).not.toContain("ComfyUI ? ");
  });

  it("returns an empty string when nothing is known", () => {
    expect(formatEnvBlock({})).toBe("");
  });
});

describe("applyStats", () => {
  it("derives torch, CUDA line, GPU and VRAM from a /system_stats payload", () => {
    const caps: EnvCapabilities = {};
    applyStats(caps, {
      system: {
        os: "nt",
        python_version: "3.13.12 (main)",
        comfyui_version: "0.26.1",
        pytorch_version: "2.10.0+cu130",
      },
      devices: [
        {
          name: "cuda:0 NVIDIA GeForce RTX 4090",
          type: "cuda",
          vram_total: 24 * 1024 * 1024 * 1024,
          vram_free: 20 * 1024 * 1024 * 1024,
        },
      ],
    });
    expect(caps.python).toBe("3.13");
    expect(caps.comfyui).toBe("0.26.1");
    expect(caps.torch).toBe("2.10.0");
    expect(caps.cuda).toBe("13.0");
    expect(caps.gpu).toBe("NVIDIA GeForce RTX 4090");
    expect(caps.vramTotalGb).toBe(24);
    expect(caps.vramFreeGb).toBe(20);
    // "nt" normalizes to a friendly OS rather than passing through literally.
    expect(caps.os).not.toBe("nt");
  });

  it("tidies ComfyUI's verbose device name to just the model", () => {
    const caps: EnvCapabilities = {};
    applyStats(caps, {
      devices: [
        {
          name: "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync",
          type: "cuda",
          vram_total: 24 * 1024 ** 3,
        },
      ],
    });
    expect(caps.gpu).toBe("NVIDIA GeForce RTX 4090");
  });

  it("derives the cu128 line correctly", () => {
    const caps: EnvCapabilities = {};
    applyStats(caps, { system: { pytorch_version: "2.9.1+cu128" } });
    expect(caps.cuda).toBe("12.8");
    expect(caps.torch).toBe("2.9.1");
  });

  it("prefers a non-CPU device for GPU fields", () => {
    const caps: EnvCapabilities = {};
    applyStats(caps, {
      devices: [
        { name: "cpu", type: "cpu", vram_total: 0 },
        { name: "NVIDIA RTX 4090", type: "cuda", vram_total: 24 * 1024 ** 3 },
      ],
    });
    expect(caps.gpu).toBe("NVIDIA RTX 4090");
    expect(caps.vramTotalGb).toBe(24);
  });
});

describe("buildPanelSystemAppend", () => {
  const STATIC = "STATIC PROMPT BODY";

  it("prepends the env block above the static prompt", () => {
    const out = buildPanelSystemAppend(STATIC, {
      os: "Windows 11",
      backend: "Claude",
      otherBackendAvailable: true,
    });
    expect(out.startsWith("ENVIRONMENT (live, this machine):")).toBe(true);
    expect(out).toContain(STATIC);
    // env block comes first, static prompt after.
    expect(out.indexOf("ENVIRONMENT")).toBeLessThan(out.indexOf(STATIC));
  });

  it("returns the static prompt unchanged when caps is undefined", () => {
    expect(buildPanelSystemAppend(STATIC, undefined)).toBe(STATIC);
  });

  it("returns the static prompt unchanged when the env block is empty", () => {
    expect(buildPanelSystemAppend(STATIC, {})).toBe(STATIC);
  });
});

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import {
  formatEnvBlock,
  applyStats,
  buildPanelSystemAppend,
  resolveComfyuiPython,
  reconcileProbeState,
  resolveBackends,
  type EnvCapabilities,
} from "../../services/env-capabilities.js";

const IS_WIN = platform() === "win32";

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
      mcpVersion: "0.48.4",
      panelVersion: "0.11.3",
    };
    const out = formatEnvBlock(caps);
    expect(out).toContain("ENVIRONMENT (live, this machine):");
    expect(out).toContain("comfyui-mcp 0.48.4 · panel 0.11.3");
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

  it("renders only the known build version, and omits the segment when neither is set", () => {
    expect(formatEnvBlock({ os: "Linux", mcpVersion: "0.48.4" })).toContain("comfyui-mcp 0.48.4");
    expect(formatEnvBlock({ os: "Linux", mcpVersion: "0.48.4" })).not.toContain("panel ");
    expect(formatEnvBlock({ os: "Linux", panelVersion: "nightly" })).toContain("panel nightly");
    // Neither version → no version segment at all (no stray separators).
    const bare = formatEnvBlock({ os: "Linux" });
    expect(bare).not.toContain("comfyui-mcp ");
    expect(bare).not.toContain("panel ");
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

describe("resolveBackends (#358 — report the ACTUAL backend, never a wrong specific)", () => {
  it("labels non-Claude backends by their real identity, not 'Claude'", () => {
    // The regression: a Grok turn was reported as "Backend: Claude". Every known
    // backend id must map to its own label.
    expect(resolveBackends("grok").backend).toBe("Grok");
    expect(resolveBackends("codex").backend).toBe("Codex");
    expect(resolveBackends("gemini").backend).toBe("Gemini");
    expect(resolveBackends("ollama").backend).toBe("Ollama");
    expect(resolveBackends("copilot").backend).toBe("Copilot");
    expect(resolveBackends("claude").backend).toBe("Claude");
    // Case-insensitive.
    expect(resolveBackends("GROK").backend).toBe("Grok");
  });

  it("degrades an unrecognized id to 'unknown' rather than mislabeling it Claude", () => {
    expect(resolveBackends("some-future-provider").backend).toBe("unknown");
    expect(resolveBackends("").backend).toBe("unknown");
  });

  it("degrades prototype-key ids to 'unknown' (no inherited-property leak)", () => {
    // A plain object index would resolve these to Object.prototype members
    // (a function/object) rather than "unknown".
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(resolveBackends(id).backend).toBe("unknown");
    }
  });

  it("the rendered Backend line reflects the real provider for the turn", () => {
    const grok = resolveBackends("grok");
    const out = formatEnvBlock({ backend: grok.backend, otherBackendAvailable: grok.otherBackendAvailable });
    expect(out).toContain("Backend: Grok");
    expect(out).not.toContain("Backend: Claude");
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

describe("resolveComfyuiPython (#401)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "comfyui-py-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the on-disk venv interpreter as VERIFIED", async () => {
    const venvBin = IS_WIN ? join(dir, ".venv", "Scripts") : join(dir, ".venv", "bin");
    await mkdir(venvBin, { recursive: true });
    const exe = join(venvBin, IS_WIN ? "python.exe" : "python3");
    await writeFile(exe, "", "utf-8");

    const res = resolveComfyuiPython(dir, undefined);
    expect(res.verified).toBe(true);
    expect(res.python).toBe(exe);
    // No argv → this is NOT the live interpreter (just the pinned workspace's venv).
    expect(res.live).toBe(false);
  });

  it("finds the embedded python of a portable install as VERIFIED (not just .venv)", async () => {
    if (!IS_WIN) return; // python_embeded is a Windows-portable layout
    const embedded = join(dir, "python_embeded");
    await mkdir(embedded, { recursive: true });
    const exe = join(embedded, "python.exe");
    await writeFile(exe, "", "utf-8");

    const res = resolveComfyuiPython(dir, undefined);
    expect(res.verified).toBe(true);
    expect(res.python).toBe(exe);
  });

  it("falls back to a bare PATH name as UNVERIFIED when no venv exists", () => {
    // A directory with no interpreter under it — the wrong-python scenario.
    const res = resolveComfyuiPython(dir, undefined);
    expect(res.verified).toBe(false);
    expect(res.live).toBe(false);
    expect(res.python).toBe(IS_WIN ? "python.exe" : "python3");
  });

  it("prefers the LIVE running instance's argv root over a pinned/saved workspace (PR #433 review)", async () => {
    // Both installs exist with a venv on the same Python major.minor, but only the
    // LIVE server (root B, from argv main.py) has the package. If we resolved the
    // pinned/saved root A first, A's negative would survive as a false 'not-installed'
    // AND process-control could relaunch B's main.py with A's python. The live argv
    // root must win.
    const mkVenv = async (root: string): Promise<string> => {
      const bin = IS_WIN ? join(root, ".venv", "Scripts") : join(root, ".venv", "bin");
      await mkdir(bin, { recursive: true });
      const exe = join(bin, IS_WIN ? "python.exe" : "python3");
      await writeFile(exe, "", "utf-8");
      return exe;
    };
    const rootA = join(dir, "A"); // pinned COMFYUI_PATH / saved default
    const rootB = join(dir, "B"); // the LIVE running server
    await mkVenv(rootA);
    const exeB = await mkVenv(rootB);

    const res = resolveComfyuiPython(rootA, [
      IS_WIN ? "python.exe" : "python3",
      join(rootB, "main.py"),
    ]);
    expect(res.verified).toBe(true);
    expect(res.live).toBe(true);
    expect(res.liveRoot).toBe(rootB);
    expect(res.python).toBe(exeB); // B, not A
  });

  it("marks the pinned workspace UNTRUSTED (live:false) when the LIVE root has no on-disk venv", async () => {
    // Live root B (from argv) has no interpreter on disk; only pinned A does. A must
    // NOT be reported as the live interpreter — its negative would be a false report.
    const binA = IS_WIN ? join(dir, "A", ".venv", "Scripts") : join(dir, "A", ".venv", "bin");
    await mkdir(binA, { recursive: true });
    const exeA = join(binA, IS_WIN ? "python.exe" : "python3");
    await writeFile(exeA, "", "utf-8");
    const rootB = join(dir, "B"); // live root, but no venv created under it

    const res = resolveComfyuiPython(join(dir, "A"), [join(rootB, "main.py")]);
    expect(res.python).toBe(exeA); // A is the only interpreter we can probe …
    expect(res.verified).toBe(true);
    expect(res.live).toBe(false); // … but it is NOT the live interpreter
    expect(res.liveRoot).toBe(rootB); // live root was resolvable, just not populated
  });
});

describe("reconcileProbeState (#401 — no false 'not installed')", () => {
  it("keeps 'not-installed' only when the interpreter is LIVE and versions match", () => {
    expect(
      reconcileProbeState("not-installed", {
        live: true,
        runningPython: "3.12",
        probePython: "3.12",
      }),
    ).toBe("not-installed");
  });

  it("degrades 'not-installed' to 'unknown' when the interpreter is NOT the live one", () => {
    expect(
      reconcileProbeState("not-installed", {
        live: false,
        runningPython: "3.12",
        probePython: "3.12",
      }),
    ).toBe("unknown");
  });

  it("degrades 'not-installed' to 'unknown' when probe python DISAGREES with the running instance", () => {
    // The exact issue: running ComfyUI is 3.12, but we probed a 3.11 python.
    expect(
      reconcileProbeState("not-installed", {
        live: true,
        runningPython: "3.12",
        probePython: "3.11",
      }),
    ).toBe("unknown");
  });

  it("passes a positive 'installed' through untouched even from an untrusted interpreter", () => {
    expect(
      reconcileProbeState("installed", { live: false, runningPython: "3.12", probePython: "3.11" }),
    ).toBe("installed");
  });

  it("treats undefined as 'unknown'", () => {
    expect(reconcileProbeState(undefined, { live: true })).toBe("unknown");
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

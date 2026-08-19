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
  readInstalledPanelVersion,
  gatherEnvCapabilities,
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

  it("SAYS 'unknown' for triton/sageattention instead of omitting it (#401)", () => {
    // Omitting "unknown" was the last place the tri-state collapsed into a negative:
    // an omitted Triton line and an absent Triton read identically, and the guidance
    // tail told the agent that absence means "default to sdpa + no torch.compile".
    // Every careful degrade-to-unknown upstream therefore still landed on the agent as
    // the false negative it was avoiding.
    const out = formatEnvBlock({
      os: "Windows 11",
      triton: "unknown",
      sageattention: "unknown",
    });
    expect(out).toContain("Triton: UNKNOWN");
    expect(out).toContain("SageAttention: UNKNOWN");
    // …and it must not be mistakable for a negative on a skim.
    expect(out).not.toMatch(/Triton: not installed/);
    expect(out).toMatch(/NOT a negative/);
    // The guidance must scope the disable-acceleration advice to "not installed" only.
    expect(out).toMatch(/ONLY where this line says "not installed"/);
  });

  it("omits triton/sageattention entirely when the field was never populated", () => {
    // `undefined` (never probed) is a different thing from a probe that ran and could
    // not decide, and must not be dressed up as the latter.
    const out = formatEnvBlock({ os: "Windows 11" });
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

  // ---------------------------------------------------------------------------
  // #846 — the version line described a moment that had passed
  //
  // The ENV line reported comfyui-mcp 0.48.18 while 0.49.5 was installed, because
  // the version was read once when the orchestrator process started and then
  // rendered forever as the current state of the machine. Every bug filed from
  // that session carried the wrong number, and triage chased them against a build
  // nobody was running.
  //
  // Both readings are separately TRUE — this process really is running the old
  // build, and the newer one really is installed. So neither is suppressed: the
  // running build leads (it is what the report is about) and the drift is stated.
  // ---------------------------------------------------------------------------

  it("discloses an installed version that has moved past the RUNNING one (#846)", () => {
    const out = formatEnvBlock({
      os: "Linux",
      mcpVersion: "0.48.18",
      mcpVersionInstalled: "0.49.5",
    });
    // The RUNNING build leads — a report generated from this session is about it.
    expect(out).toContain("comfyui-mcp 0.48.18");
    expect(out).toContain("RUNNING 0.48.18");
    expect(out).toContain("0.49.5 is now installed on disk");
    // A remedy that works from where the caller is.
    expect(out).toContain("restart the orchestrator to load it");
    // The newer number must never be presented as the version in use — that is the
    // mirror-image lie, and it would re-pin bug reports to unexecuted code.
    expect(out).not.toMatch(/comfyui-mcp 0\.49\.5/);
  });

  it("says nothing about drift when the two readings agree (#846)", () => {
    const out = formatEnvBlock({
      os: "Linux",
      mcpVersion: "0.49.6",
      mcpVersionInstalled: "0.49.6",
    });
    expect(out).toContain("comfyui-mcp 0.49.6");
    expect(out).not.toMatch(/RUNNING/);
    expect(out).not.toMatch(/installed on disk/);
  });

  it("says nothing about drift when the installed version could not be read (#846)", () => {
    // An unread version is not evidence that nothing changed — and it is certainly
    // not evidence that something did. Silence is the only honest output.
    const out = formatEnvBlock({ os: "Linux", mcpVersion: "0.49.6" });
    expect(out).toContain("comfyui-mcp 0.49.6");
    expect(out).not.toMatch(/installed on disk/);
    expect(out).not.toMatch(/undefined/);
  });

  it(
    "re-reads the installed version on EVERY gather, and never caches it (#846)",
    async () => {
      // THE ACTUAL ROOT CAUSE, not just its rendering: the reported version was read
      // ONCE at orchestrator startup and reused for the life of the process, so an
      // upgrade that landed afterwards was invisible. Deleting the per-gather read
      // must break THIS test — asserting only the formatting would leave the fix
      // itself uncovered.
      //
      // Runs the real probe set (they are internally timed out and degrade to
      // "unknown"), which is slow but is the point: it exercises the wiring end to
      // end rather than a stub that could not go stale.
      let onDisk: string | undefined = "0.48.18";
      let shouldThrow = false;
      const reads: (string | undefined)[] = [];
      const readInstalledMcpVersion = (): string | undefined => {
        if (shouldThrow) throw new Error("package.json unreadable");
        reads.push(onDisk);
        return onDisk;
      };
      const gather = () =>
        gatherEnvCapabilities({
          mcpVersion: "0.48.18",
          readInstalledMcpVersion,
          statsTimeoutMs: 1,
          tritonTimeoutMs: 1,
        });

      const first = await gather();
      expect(first.mcpVersionInstalled).toBe("0.48.18");
      expect(formatEnvBlock(first)).not.toMatch(/installed on disk/);

      // An in-place upgrade lands while this process keeps running the old build.
      onDisk = "0.49.5";

      const second = await gather();
      expect(reads).toEqual(["0.48.18", "0.49.5"]);
      // The RUNNING version is unchanged — this process did not hot-swap its code.
      expect(second.mcpVersion).toBe("0.48.18");
      // …and the drift is now visible instead of silently reported as current state.
      expect(second.mcpVersionInstalled).toBe("0.49.5");
      expect(formatEnvBlock(second)).toContain("0.49.5 is now installed on disk");

      // A read that THROWS leaves the line silent rather than wrong: the guard is
      // itself an operation that can fail, so it is fenced.
      shouldThrow = true;
      const third = await gather();
      expect(third.mcpVersion).toBe("0.48.18");
      expect(third.mcpVersionInstalled).toBeUndefined();
      expect(formatEnvBlock(third)).not.toMatch(/installed on disk/);
    },
    60_000,
  );

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
    expect(resolveBackends("minimax").backend).toBe("MiniMax");
    expect(resolveBackends("atlascloud").backend).toBe("Atlas Cloud");
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

describe("resolveComfyuiPython — BEST-GUESS selection only (#401)", () => {
  // This resolver decides what to PROBE. It deliberately reports no authority
  // signals any more: which interpreter the server actually runs is answered by
  // live-interpreter.ts (we launched it / the OS says so), never by layout.
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "comfyui-py-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const mkVenvAt = async (root: string): Promise<string> => {
    const bin = IS_WIN ? join(root, ".venv", "Scripts") : join(root, ".venv", "bin");
    await mkdir(bin, { recursive: true });
    const exe = join(bin, IS_WIN ? "python.exe" : "python3");
    await writeFile(exe, "", "utf-8");
    return exe;
  };

  it("returns the on-disk venv interpreter as VERIFIED", async () => {
    const exe = await mkVenvAt(dir);
    const res = resolveComfyuiPython(dir, undefined);
    expect(res.verified).toBe(true);
    expect(res.python).toBe(exe);
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
    const res = resolveComfyuiPython(dir, undefined);
    expect(res.verified).toBe(false);
    expect(res.python).toBe(IS_WIN ? "python.exe" : "python3");
  });

  it("probes the LIVE running instance's argv root ahead of a pinned/saved workspace", async () => {
    const rootA = join(dir, "A"); // pinned COMFYUI_PATH / saved default
    const rootB = join(dir, "B"); // the LIVE running server
    await mkVenvAt(rootA);
    const exeB = await mkVenvAt(rootB);

    const res = resolveComfyuiPython(rootA, [
      IS_WIN ? "python.exe" : "python3",
      join(rootB, "main.py"),
    ]);
    expect(res.python).toBe(exeB); // B, not A
    expect(res.liveRoot).toBe(rootB);
  });

  it("falls back to the pinned workspace when the LIVE root has no on-disk venv", async () => {
    const exeA = await mkVenvAt(join(dir, "A"));
    const rootB = join(dir, "B"); // live root, but no venv created under it
    await mkdir(rootB, { recursive: true });

    const res = resolveComfyuiPython(join(dir, "A"), [join(rootB, "main.py")]);
    expect(res.python).toBe(exeA);
    expect(res.liveRoot).toBe(rootB); // live root resolvable, just not populated
  });

  it("anchors a RELATIVE argv main.py on the configured base and picks the SERVER's venv", async () => {
    // ComfyUI Desktop reports argv[0] = "ComfyUI\main.py" with no cwd. Anchoring is
    // what gets the PROBE onto the server's own venv instead of the bundle
    // launcher's standalone-env — which is what lets a positive capability finding
    // (e.g. Triton IS installed) be made at all.
    const base = join(dir, "Desktop");
    const server = join(base, "ComfyUI");
    await mkdir(server, { recursive: true });
    await writeFile(join(server, "main.py"), "", "utf-8");
    const wrong = await mkVenvAt(base);
    const right = await mkVenvAt(server);

    const res = resolveComfyuiPython(base, [IS_WIN ? "ComfyUI\\main.py" : "ComfyUI/main.py"]);
    expect(res.python).toBe(right);
    expect(res.python).not.toBe(wrong);
    expect(res.liveRoot).toBe(server);
  });

  it("prefers a nested ComfyUI/ server root over the bundle root even without argv", async () => {
    const base = join(dir, "Bundle");
    const server = join(base, "ComfyUI");
    await mkdir(server, { recursive: true });
    await writeFile(join(server, "main.py"), "", "utf-8");
    await mkVenvAt(base);
    const right = await mkVenvAt(server);

    const res = resolveComfyuiPython(base, undefined);
    expect(res.python).toBe(right);
    expect(res.verified).toBe(true);
  });

  it("never lets a nested ComfyUI/ tree outrank a root that is itself the server root", async () => {
    const rootX = join(dir, "X");
    await mkdir(join(rootX, "ComfyUI"), { recursive: true });
    await writeFile(join(rootX, "main.py"), "", "utf-8");
    await writeFile(join(rootX, "ComfyUI", "main.py"), "", "utf-8");
    const exeX = await mkVenvAt(rootX);
    await mkVenvAt(join(rootX, "ComfyUI"));

    const res = resolveComfyuiPython(undefined, [join(rootX, "main.py")]);
    expect(res.python).toBe(exeX);
  });

  it("orders the guess with the server's embedded_python self-report", async () => {
    if (!IS_WIN) return; // python_embeded is a Windows-portable layout
    const bundle = join(dir, "portable");
    const server = join(bundle, "ComfyUI");
    await mkdir(server, { recursive: true });
    await writeFile(join(server, "main.py"), "", "utf-8");
    const venvExe = await mkVenvAt(server);
    const embDir = join(bundle, "python_embeded");
    await mkdir(embDir, { recursive: true });
    const embExe = join(embDir, "python.exe");
    await writeFile(embExe, "", "utf-8");
    const argv = [join(server, "main.py")];

    expect(resolveComfyuiPython(bundle, argv, { embeddedPython: true }).python).toBe(embExe);
    expect(resolveComfyuiPython(bundle, argv, { embeddedPython: false }).python).toBe(venvExe);
  });

  it("refuses to anchor when the relative argv dir has no main.py on disk", async () => {
    const base = join(dir, "Plain");
    await mkdir(join(base, "ComfyUI"), { recursive: true }); // dir exists but NO main.py
    const baseExe = await mkVenvAt(base);

    const res = resolveComfyuiPython(base, [IS_WIN ? "ComfyUI\\main.py" : "ComfyUI/main.py"]);
    expect(res.python).toBe(baseExe);
    expect(res.liveRoot).toBeUndefined();
  });
});

describe("reconcileProbeState (#401 — only an OBSERVED interpreter may say 'not installed')", () => {
  it("keeps 'not-installed' when the interpreter was OBSERVED and versions agree", () => {
    expect(
      reconcileProbeState("not-installed", {
        observed: true,
        runningPython: "3.12",
        probePython: "3.12",
      }),
    ).toBe("not-installed");
  });

  it("degrades 'not-installed' to 'unknown' for a layout GUESS, however plausible", () => {
    // This is the whole bug: a sole .venv under the server's own root, a matching
    // python, a matching torch — all satisfied by an environment that is not the
    // one ComfyUI is running. Without an observation, the negative cannot stand.
    expect(
      reconcileProbeState("not-installed", {
        observed: false,
        runningPython: "3.12",
        probePython: "3.12",
      }),
    ).toBe("unknown");
  });

  it("degrades 'not-installed' when an observed probe DISAGREES with the running instance", () => {
    expect(
      reconcileProbeState("not-installed", {
        observed: true,
        runningPython: "3.12",
        probePython: "3.11",
      }),
    ).toBe("unknown");
  });

  it("passes a positive 'installed' through untouched even from an unobserved interpreter", () => {
    // The asymmetry that makes the fix usable: a package we can SEE installed is
    // really installed, whichever environment we happened to look at.
    expect(
      reconcileProbeState("installed", {
        observed: false,
        runningPython: "3.12",
        probePython: "3.11",
      }),
    ).toBe("installed");
  });

  it("treats undefined as 'unknown'", () => {
    expect(reconcileProbeState(undefined, { observed: true })).toBe("unknown");
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

describe("readInstalledPanelVersion (disk fallback)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cmcp-panelver-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Write a pyproject.toml under a specific custom_nodes subdir.
  async function writePanel(dirName: string, body: string) {
    const d = join(dir, "custom_nodes", dirName);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "pyproject.toml"), body, "utf8");
  }

  it("reads the panel's [project].version (authoritative by [project].name)", async () => {
    await writePanel(
      "comfyui-mcp-panel",
      `[project]\nname = "comfyui-agent-panel"\nversion = "0.11.20"\n`,
    );
    expect(readInstalledPanelVersion(dir)).toBe("0.11.20");
  });

  it("mirrors the shipped parsePyproject reader (single-line description, then version)", async () => {
    // Shape mirrors the real panel pyproject.toml (long single-line description).
    await writePanel(
      "comfyui-mcp-panel",
      `[project]\n` +
        `name = "comfyui-agent-panel"\n` +
        `description = "Autonomous AI agent in the ComfyUI sidebar - drive the canvas, browse CivitAI, generate."\n` +
        `version = "0.11.20"\n` +
        `license = { file = "LICENSE" }\n` +
        `[tool.comfy]\nPublisherId = "artokun"\n`,
    );
    expect(readInstalledPanelVersion(dir)).toBe("0.11.20");
  });

  it("finds the panel under the alternate registry dir name", async () => {
    await writePanel(
      "comfyui-agent-panel",
      `[project]\nname = "comfyui-agent-panel"\nversion = "0.12.0"\n`,
    );
    expect(readInstalledPanelVersion(dir)).toBe("0.12.0");
  });

  it("returns undefined for a non-panel pyproject squatting a known dir (wrong project name)", async () => {
    // Authoritative guard: only [project].name == comfyui-agent-panel is trusted,
    // so a different node at the same dir name never yields a WRONG version.
    await writePanel(
      "comfyui-mcp-panel",
      `[project]\nname = "some-other-node"\nversion = "9.9.9"\n`,
    );
    expect(readInstalledPanelVersion(dir)).toBeUndefined();
  });

  it("returns undefined when the panel pyproject declares no version", async () => {
    await writePanel("comfyui-mcp-panel", `[project]\nname = "comfyui-agent-panel"\n`);
    expect(readInstalledPanelVersion(dir)).toBeUndefined();
  });

  it("returns undefined when the file/dir is missing or comfyuiPath is undefined", () => {
    expect(readInstalledPanelVersion(undefined)).toBeUndefined();
    expect(readInstalledPanelVersion(join(dir, "does-not-exist"))).toBeUndefined();
    // custom_nodes exists but the panel is not installed.
    expect(readInstalledPanelVersion(dir)).toBeUndefined();
  });
});
